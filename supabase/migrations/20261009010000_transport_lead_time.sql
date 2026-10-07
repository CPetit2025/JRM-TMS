-- Minimum anticipation from immutable server registration; no retroactive policy changes.
BEGIN;
CREATE TABLE public.transport_lead_time_settings (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 settings jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);
CREATE TABLE public.transport_lead_time_settings_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 previous_settings jsonb NOT NULL,
 next_settings jsonb NOT NULL,
 version integer NOT NULL,
 actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transport_lead_time_audit_actor_idx ON public.transport_lead_time_settings_audit(actor_id);
CREATE INDEX transport_lead_time_updated_by_idx ON public.transport_lead_time_settings(updated_by);
INSERT INTO public.transport_lead_time_settings(settings) VALUES (
 '{"enabled":true,"zones":{"LIMA":{"enabled":true,"hours":24},"PROVINCIA":{"enabled":true,"hours":48},"EXTERIOR":{"enabled":true,"hours":72}}}'::jsonb
);
ALTER TABLE public.transport_lead_time_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transport_lead_time_settings_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_active_account ON public.transport_lead_time_settings AS RESTRICTIVE FOR ALL TO authenticated
 USING((SELECT public.is_active_tms_user())) WITH CHECK((SELECT public.is_active_tms_user()));
CREATE POLICY security_active_account ON public.transport_lead_time_settings_audit AS RESTRICTIVE FOR ALL TO authenticated
 USING((SELECT public.is_active_tms_user())) WITH CHECK((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.transport_lead_time_settings,public.transport_lead_time_settings_audit FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.transport_lead_time_settings,public.transport_lead_time_settings_audit TO service_role;
GRANT SELECT ON public.transport_lead_time_settings_audit TO authenticated;
CREATE POLICY transport_lead_time_audit_read ON public.transport_lead_time_settings_audit FOR SELECT TO authenticated
 USING(public.has_tms_permission('configuracion'));

CREATE OR REPLACE FUNCTION public.get_transport_lead_time_settings() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND is_active) THEN
  RAISE EXCEPTION 'Sin sesión activa';
 END IF;
 SELECT settings||jsonb_build_object('version',version) INTO v FROM public.transport_lead_time_settings WHERE id;
 IF v IS NULL THEN RAISE EXCEPTION 'No existe configuración de anticipación; revise Configuración'; END IF;
 RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.set_transport_lead_time_settings(p_settings jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_zone text; v_old public.transport_lead_time_settings%ROWTYPE; v_next jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT public.has_tms_permission('configuracion') THEN RAISE EXCEPTION 'Sin permiso para configurar plazos'; END IF;
 IF jsonb_typeof(p_settings) IS DISTINCT FROM 'object' OR jsonb_typeof(p_settings->'enabled') IS DISTINCT FROM 'boolean'
 OR jsonb_typeof(p_settings->'zones') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Configuración de plazos inválida'; END IF;
 FOREACH v_zone IN ARRAY ARRAY['LIMA','PROVINCIA','EXTERIOR'] LOOP
  IF jsonb_typeof(p_settings->'zones'->v_zone->'enabled') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(p_settings->'zones'->v_zone->'hours') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Regla inválida para %',v_zone; END IF;
  IF (p_settings->'zones'->v_zone->>'hours')::numeric NOT BETWEEN 1 AND 720
   OR (p_settings->'zones'->v_zone->>'hours')::numeric<>trunc((p_settings->'zones'->v_zone->>'hours')::numeric) THEN
   RAISE EXCEPTION 'El plazo de % debe ser entre 1 y 720 horas completas',v_zone;
  END IF;
 END LOOP;
 -- Only recognized fields are saved; versions and audit identity are controlled by the server.
 v_next:=jsonb_build_object('enabled',(p_settings->>'enabled')::boolean,'zones','{}'::jsonb);
 FOREACH v_zone IN ARRAY ARRAY['LIMA','PROVINCIA','EXTERIOR'] LOOP
  v_next:=jsonb_set(v_next,ARRAY['zones',v_zone],jsonb_build_object('enabled',(p_settings->'zones'->v_zone->>'enabled')::boolean,'hours',(p_settings->'zones'->v_zone->>'hours')::integer));
 END LOOP;
 SELECT * INTO v_old FROM public.transport_lead_time_settings WHERE id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'No existe configuración de anticipación; revise Configuración'; END IF;
 IF v_old.settings IS DISTINCT FROM v_next THEN
  UPDATE public.transport_lead_time_settings SET settings=v_next,version=version+1,updated_at=now(),updated_by=auth.uid() WHERE id;
  INSERT INTO public.transport_lead_time_settings_audit(previous_settings,next_settings,version,actor_id)
  VALUES(v_old.settings,v_next,v_old.version+1,auth.uid());
 END IF;
 RETURN public.get_transport_lead_time_settings();
END $$;
REVOKE ALL ON FUNCTION public.get_transport_lead_time_settings(),public.set_transport_lead_time_settings(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_transport_lead_time_settings(),public.set_transport_lead_time_settings(jsonb) TO authenticated,service_role;

ALTER TABLE public.transport_requests
 ADD COLUMN required_at timestamptz,
 ADD COLUMN delivery_zone text CHECK(delivery_zone IN ('LIMA','PROVINCIA','EXTERIOR')),
 ADD COLUMN lead_time_policy jsonb;
CREATE INDEX transport_requests_required_at_idx ON public.transport_requests(required_at) WHERE required_at IS NOT NULL;
CREATE INDEX transport_requests_created_at_idx ON public.transport_requests(created_at);

CREATE OR REPLACE FUNCTION public.evaluate_transport_lead_time(p_registered_at timestamptz,p_required_at timestamptz,p_zone text,p_policy jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE v_hours integer; v_minimum timestamptz;
BEGIN
 IF p_policy IS NULL THEN RETURN jsonb_build_object('status','UNASSESSED'); END IF;
 IF NOT COALESCE((p_policy->>'enabled')::boolean,false) OR (p_zone IS NOT NULL AND NOT COALESCE((p_policy->'zones'->p_zone->>'enabled')::boolean,false)) THEN
  RETURN jsonb_build_object('status','DISABLED');
 END IF;
 IF p_registered_at IS NULL OR p_required_at IS NULL OR p_zone IS NULL THEN RETURN jsonb_build_object('status','UNASSESSED'); END IF;
 v_hours:=(p_policy->'zones'->p_zone->>'hours')::integer;
 v_minimum:=p_registered_at+make_interval(hours=>v_hours);
 RETURN jsonb_build_object('status',CASE WHEN p_required_at>=v_minimum THEN 'COMPLIANT' ELSE 'INSUFFICIENT' END,'minimum_at',v_minimum,'hours',v_hours);
END $$;
REVOKE ALL ON FUNCTION public.evaluate_transport_lead_time(timestamptz,timestamptz,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.evaluate_transport_lead_time(timestamptz,timestamptz,text,jsonb) TO authenticated,service_role;

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
   NEW.required_at:=(NEW.required_date+(OLD.required_at AT TIME ZONE 'America/Lima')::time) AT TIME ZONE 'America/Lima';
  END IF;
  IF OLD.lead_time_policy IS NULL AND (NEW.required_at IS NOT NULL OR
   (NEW.request_type='DESPACHO' AND COALESCE(NEW.attention_mode,'TRANSPORTE_JRM')<>'RECOJO_CLIENTE'
    AND (OLD.request_type IS DISTINCT FROM 'DESPACHO' OR OLD.attention_mode='RECOJO_CLIENTE'))) THEN
   SELECT settings||jsonb_build_object('version',version,'captured_at',statement_timestamp()) INTO NEW.lead_time_policy
   FROM public.transport_lead_time_settings WHERE id;
   IF NEW.lead_time_policy IS NULL THEN RAISE EXCEPTION 'No existe configuración de anticipación; revise Configuración'; END IF;
  END IF;
 END IF;
 IF NEW.required_at IS NOT NULL AND NEW.required_date IS DISTINCT FROM (NEW.required_at AT TIME ZONE 'America/Lima')::date THEN
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
CREATE TRIGGER zzz_transport_request_lead_time BEFORE INSERT OR UPDATE ON public.transport_requests
 FOR EACH ROW EXECUTE FUNCTION public.transport_request_lead_time_guard();

-- Preserve the installed, permission-checked save implementation rather than replacing it with an obsolete migration.
DO $patch$
DECLARE v_source text; v_before text;
BEGIN
 SELECT pg_get_functiondef('public.save_transport_request(uuid,jsonb,jsonb)'::regprocedure) INTO v_source;
 v_before:=v_source;
 v_source:=replace(v_source,'budget_shortfall, budget_observation, attention_mode)',
  'budget_shortfall, budget_observation, attention_mode, required_at, delivery_zone)');
 v_source:=replace(v_source,'round(v_shortfall, 2) END, v_mode)',
  'round(v_shortfall, 2) END, v_mode, NULLIF(p_payload->>''required_at'','''')::timestamptz, NULLIF(p_payload->>''delivery_zone'',''''))');
 v_source:=replace(v_source,'required_date = v_date, time_window = nullif(p_payload->>''time_window'',''''),',
  'required_date = v_date, required_at = CASE WHEN p_payload ? ''required_at'' THEN NULLIF(p_payload->>''required_at'','''')::timestamptz ELSE required_at END, delivery_zone = CASE WHEN p_payload ? ''delivery_zone'' THEN NULLIF(p_payload->>''delivery_zone'','''') ELSE delivery_zone END, time_window = nullif(p_payload->>''time_window'',''''),');
 IF v_source=v_before OR position('attention_mode, required_at, delivery_zone)' IN v_source)=0
  OR position('NULLIF(p_payload->>''required_at'','''')::timestamptz, NULLIF(p_payload->>''delivery_zone'',''''))' IN v_source)=0
  OR position('required_at = CASE WHEN p_payload ? ''required_at''' IN v_source)=0 THEN
  RAISE EXCEPTION 'La función instalada de solicitudes cambió: revisar antes de aplicar anticipación';
 END IF;
 EXECUTE v_source;
END $patch$;

-- A datetime-aware variant preserves every installed scope/status/release check while updating atomically.
DO $patch$
DECLARE v_source text;
BEGIN
 SELECT pg_get_functiondef('public.set_transport_request_status(uuid,text,date)'::regprocedure) INTO v_source;
 v_source:=replace(v_source,'public.set_transport_request_status(', 'public.set_transport_request_status_at(');
 v_source:=replace(v_source,'p_required_date date DEFAULT NULL::date)',
  'p_required_date date DEFAULT NULL::date, p_required_at timestamptz DEFAULT NULL::timestamptz, p_delivery_zone text DEFAULT NULL::text)');
 v_source:=replace(v_source,'required_date = coalesce(p_required_date, required_date), updated_at = now()',
  'required_date = coalesce(p_required_date, required_date), required_at = coalesce(p_required_at,required_at), delivery_zone = coalesce(p_delivery_zone,delivery_zone), updated_at = now()');
 IF position('p_required_at timestamptz' IN v_source)=0 OR position('required_at = coalesce(p_required_at,required_at)' IN v_source)=0 THEN
  RAISE EXCEPTION 'La función instalada de estados cambió: revisar reprogramación con hora';
 END IF;
 EXECUTE v_source;
END $patch$;
REVOKE ALL ON FUNCTION public.set_transport_request_status_at(uuid,text,date,timestamptz,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.set_transport_request_status_at(uuid,text,date,timestamptz,text) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.reprogramar_solicitud_at(p_request_id uuid,p_required_at timestamptz,p_delivery_zone text,p_causa text,p_detalle text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_previous timestamptz; v_previous_date date; v_causa text:=upper(btrim(COALESCE(p_causa,'')));
BEGIN
 IF auth.uid() IS NULL OR NOT (public.has_tms_permission('despacho-aprobacion') OR public.has_tms_permission('despacho')
  OR (public.is_contract_administrator() AND public.has_assigned_request(p_request_id,true))) THEN
  RAISE EXCEPTION 'Sin permiso para reprogramar solicitudes';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.transport_requests WHERE id=p_request_id AND public.can_access_site(site_id)) THEN
  RAISE EXCEPTION 'Solicitud no disponible';
 END IF;
 IF p_required_at IS NULL OR (p_delivery_zone IS NOT NULL AND p_delivery_zone NOT IN ('LIMA','PROVINCIA','EXTERIOR')) THEN RAISE EXCEPTION 'Indique zona, fecha y hora de atención'; END IF;
 IF v_causa NOT IN ('CLIENTE','ALMACEN_SIN_STOCK','PRODUCCION','SIN_UNIDAD','SIN_CONDUCTOR','VIA_CLIMA','DOCUMENTOS','OTRO') THEN RAISE EXCEPTION 'Indique la causa de la reprogramación'; END IF;
 IF v_causa='OTRO' AND NULLIF(btrim(p_detalle),'') IS NULL THEN RAISE EXCEPTION 'Detalle la causa de la reprogramación'; END IF;
 -- The existing status operation enforces the original role, scope and route-release rules.
 SELECT required_at,required_date INTO v_previous,v_previous_date FROM public.transport_requests WHERE id=p_request_id FOR UPDATE;
 PERFORM public.set_transport_request_status_at(p_request_id,'REPROGRAMADA',(p_required_at AT TIME ZONE 'America/Lima')::date,p_required_at,p_delivery_zone);
 INSERT INTO public.kpi_reprogramaciones(request_id,causa,detalle,fecha_anterior,fecha_nueva,by)
 VALUES(p_request_id,v_causa,NULLIF(btrim(p_detalle),''),v_previous_date,(p_required_at AT TIME ZONE 'America/Lima')::date,auth.uid());
 INSERT INTO public.transport_request_events(request_id,actor_id,action,previous_state,next_state)
 VALUES(p_request_id,auth.uid(),'ATTENTION_TIME_CHANGED',jsonb_build_object('required_at',v_previous),jsonb_build_object('required_at',p_required_at,'delivery_zone',p_delivery_zone));
 RETURN jsonb_build_object('success',true,'required_at',p_required_at,'delivery_zone',p_delivery_zone);
EXCEPTION WHEN OTHERS THEN
 -- This subtransaction rolls back route release and the date change if final anticipation fails.
 RETURN jsonb_build_object('success',false,'error',SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.reprogramar_solicitud_at(uuid,timestamptz,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.reprogramar_solicitud_at(uuid,timestamptz,text,text,text) TO authenticated,service_role;
COMMIT;
