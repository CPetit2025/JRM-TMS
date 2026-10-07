-- Production stores required_date as timestamptz; historical fixtures also use date.
-- Preserve its calendar-date meaning explicitly in both schemas, without changing column types.
BEGIN;
CREATE OR REPLACE FUNCTION public.transport_request_lead_time_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_settings jsonb; v_hours integer; v_enabled boolean; v_minimum timestamptz; v_relevant boolean;
BEGIN
 IF TG_OP='INSERT' THEN
  -- The browser, imports through authenticated APIs and direct table writes cannot backdate registration.
  NEW.created_at:=statement_timestamp();
  SELECT settings||jsonb_build_object('version',version,'captured_at',statement_timestamp()) INTO NEW.lead_time_policy
  FROM public.transport_lead_time_settings WHERE id;
  IF NEW.lead_time_policy IS NULL THEN RAISE EXCEPTION 'No existe configuración de anticipación; revise Configuración'; END IF;
 ELSE
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'La hora de registro original no se puede modificar'; END IF;
  IF NEW.lead_time_policy IS DISTINCT FROM OLD.lead_time_policy THEN RAISE EXCEPTION 'La política registrada no se puede modificar'; END IF;
  IF OLD.required_at IS NOT NULL AND NEW.required_at IS NULL THEN RAISE EXCEPTION 'La hora de atención registrada no se puede eliminar'; END IF;
  -- Date-only legacy rescheduling preserves the previously registered Lima clock time.
  IF NEW.required_date IS DISTINCT FROM OLD.required_date AND NEW.required_at IS NOT DISTINCT FROM OLD.required_at AND OLD.required_at IS NOT NULL THEN
   NEW.required_at:=(NEW.required_date::date+(OLD.required_at AT TIME ZONE 'America/Lima')::time) AT TIME ZONE 'America/Lima';
  END IF;
  IF OLD.lead_time_policy IS NULL AND (NEW.required_at IS NOT NULL OR
   (NEW.request_type='DESPACHO' AND COALESCE(NEW.attention_mode,'TRANSPORTE_JRM')<>'RECOJO_CLIENTE'
    AND (OLD.request_type IS DISTINCT FROM 'DESPACHO' OR OLD.attention_mode='RECOJO_CLIENTE'))) THEN
   SELECT settings||jsonb_build_object('version',version,'captured_at',statement_timestamp()) INTO NEW.lead_time_policy
   FROM public.transport_lead_time_settings WHERE id;
   IF NEW.lead_time_policy IS NULL THEN RAISE EXCEPTION 'No existe configuración de anticipación; revise Configuración'; END IF;
  END IF;
 END IF;
 IF NEW.required_at IS NOT NULL AND NEW.required_date::date IS DISTINCT FROM (NEW.required_at AT TIME ZONE 'America/Lima')::date THEN
  RAISE EXCEPTION 'La fecha y hora de atención deben corresponder a la misma fecha de Lima';
 END IF;
 v_relevant:=NEW.request_type='DESPACHO' AND COALESCE(NEW.attention_mode,'TRANSPORTE_JRM')<>'RECOJO_CLIENTE';
 IF NOT v_relevant THEN RETURN NEW; END IF;
 v_settings:=NEW.lead_time_policy;
 v_enabled:=COALESCE((v_settings->>'enabled')::boolean,false);
 IF NEW.delivery_zone IS NOT NULL THEN v_enabled:=v_enabled AND COALESCE((v_settings->'zones'->NEW.delivery_zone->>'enabled')::boolean,false); END IF;
 -- Old date-only requests remain explicitly unassessed until an exact hour is supplied.
 IF TG_OP='UPDATE' AND OLD.required_at IS NULL AND NEW.required_at IS NULL AND OLD.lead_time_policy IS NULL
  AND OLD.request_type='DESPACHO' AND COALESCE(OLD.attention_mode,'TRANSPORTE_JRM')<>'RECOJO_CLIENTE' THEN RETURN NEW; END IF;
 IF NOT v_enabled THEN RETURN NEW; END IF;
 IF NEW.required_at IS NULL OR NEW.delivery_zone IS NULL THEN
  RAISE EXCEPTION 'Indique zona, fecha y hora de entrega para validar la anticipación mínima';
 END IF;
 v_hours:=(v_settings->'zones'->NEW.delivery_zone->>'hours')::integer;
 v_minimum:=NEW.created_at+make_interval(hours=>v_hours);
 IF NEW.required_at<v_minimum THEN
  RAISE EXCEPTION 'La entrega requiere al menos % horas de anticipación. Seleccione una fecha y hora desde el % (hora de Lima).',
   v_hours,to_char((date_trunc('minute',v_minimum)+CASE WHEN v_minimum=date_trunc('minute',v_minimum) THEN interval '0' ELSE interval '1 minute' END) AT TIME ZONE 'America/Lima','DD/MM/YYYY HH24:MI');
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.transport_request_lead_time_guard() FROM PUBLIC,anon,authenticated;
COMMIT;
