BEGIN;
-- Only the FR-DT 007 module. Existing inspections and their signed content stay intact.
CREATE FUNCTION public.preuse_plate_key(text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT regexp_replace(upper(COALESCE($1,'')),'[^A-Z0-9]','','g') $$;
CREATE INDEX preuse_daily_lookup ON public.driver_preuse_inspections(driver_id,operation_date,public.preuse_plate_key(vehicle_plate),captured_at DESC,record_sequence DESC);
CREATE FUNCTION public.preuse_search_key(text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT regexp_replace(translate(lower(COALESCE($1,'')),'áéíóúüñ','aeiouun'),'[^a-z0-9]+',' ','g') $$;
CREATE FUNCTION public.preuse_search_matches(p_text text,p_search text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM regexp_split_to_table(trim(public.preuse_search_key(p_search)),' +') token
 WHERE token<>'' AND position(token IN replace(public.preuse_search_key(p_text),' ',''))=0) $$;

CREATE TABLE public.driver_preuse_repeat_authorizations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), driver_id uuid NOT NULL REFERENCES public.drivers(id),
 vehicle_key text NOT NULL,operation_date date NOT NULL,previous_operation uuid NOT NULL REFERENCES public.driver_preuse_inspections(operation_id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 500), authorized_by uuid NOT NULL REFERENCES public.profiles(id),
 authorized_at timestamptz NOT NULL DEFAULT now(), consumed_by uuid UNIQUE REFERENCES public.driver_preuse_inspections(operation_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX preuse_one_pending_repeat ON public.driver_preuse_repeat_authorizations(driver_id,vehicle_key,operation_date) WHERE consumed_by IS NULL;
ALTER TABLE public.driver_preuse_repeat_authorizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_active_account ON public.driver_preuse_repeat_authorizations AS RESTRICTIVE FOR ALL TO authenticated
 USING((SELECT public.is_active_tms_user())) WITH CHECK((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.driver_preuse_repeat_authorizations FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.preuse_can_authorize_repeat() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT public.is_active_tms_user() AND (public.is_tms_admin() OR public.has_cmms_permission('flota') OR public.has_tms_permission('despacho-aprobacion')) $$;

CREATE FUNCTION public.authorize_driver_preuse_repeat(p_operation uuid,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i public.driver_preuse_inspections; latest uuid; granted uuid;
BEGIN
 IF NOT public.preuse_can_authorize_repeat() THEN RAISE EXCEPTION 'No tiene permiso para autorizar reinspecciones'; END IF;
 SELECT * INTO i FROM public.driver_preuse_inspections WHERE operation_id=p_operation;
 IF i.operation_id IS NULL OR NOT public.can_access_site(i.site_id) OR i.operation_date<>(now() AT TIME ZONE 'America/Lima')::date THEN
   RAISE EXCEPTION 'Solo puede autorizar reinspecciones del día y de su sede'; END IF;
 IF length(btrim(COALESCE(p_reason,''))) NOT BETWEEN 10 AND 500 THEN RAISE EXCEPTION 'Indique el motivo (10 a 500 caracteres)'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('driver-preuse:'||i.driver_id::text,0));
 SELECT operation_id INTO latest FROM public.driver_preuse_inspections WHERE driver_id=i.driver_id
 AND public.preuse_plate_key(vehicle_plate)=public.preuse_plate_key(i.vehicle_plate) AND operation_date=i.operation_date
 ORDER BY captured_at DESC,record_sequence DESC LIMIT 1;
 IF latest<>i.operation_id THEN RAISE EXCEPTION 'Existe un registro posterior. Actualice la consulta antes de autorizar'; END IF;
 INSERT INTO public.driver_preuse_repeat_authorizations(driver_id,vehicle_key,operation_date,previous_operation,reason,authorized_by)
 VALUES(i.driver_id,public.preuse_plate_key(i.vehicle_plate),i.operation_date,i.operation_id,btrim(p_reason),auth.uid())
 ON CONFLICT(driver_id,vehicle_key,operation_date) WHERE consumed_by IS NULL DO NOTHING RETURNING id INTO granted;
 IF granted IS NULL THEN RAISE EXCEPTION 'Ya existe una reinspección autorizada pendiente'; END IF;
 RETURN jsonb_build_object('success',true,'authorization_id',granted);
END $$;

CREATE FUNCTION public.preuse_daily_insert_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE grant_id uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('driver-preuse:'||NEW.driver_id::text,0));
 IF EXISTS(SELECT 1 FROM public.driver_preuse_inspections WHERE driver_id=NEW.driver_id
 AND public.preuse_plate_key(vehicle_plate)=public.preuse_plate_key(NEW.vehicle_plate) AND operation_date=NEW.operation_date) THEN
   SELECT id INTO grant_id FROM public.driver_preuse_repeat_authorizations WHERE driver_id=NEW.driver_id
   AND vehicle_key=public.preuse_plate_key(NEW.vehicle_plate) AND operation_date=NEW.operation_date
   AND authorized_at<=NEW.captured_at+interval '30 seconds' AND consumed_by IS NULL FOR UPDATE;
   IF grant_id IS NULL THEN RAISE EXCEPTION 'Ya existe un checklist para este conductor, unidad y día. Solicite autorización para reinspeccionar'; END IF;
   UPDATE public.driver_preuse_repeat_authorizations SET consumed_by=NEW.operation_id WHERE id=grant_id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER preuse_daily_insert_guard BEFORE INSERT ON public.driver_preuse_inspections FOR EACH ROW EXECUTE FUNCTION public.preuse_daily_insert_guard();

-- Preserve validation, immutable formats and technical retry idempotency. A new
-- operation without authorization returns the already registered inspection.
DO $patch$ DECLARE def text; old text:=$old$IF v.id IS NULL THEN RAISE EXCEPTION 'Unidad inexistente'; END IF;$old$;
BEGIN
 def:=pg_get_functiondef('public.submit_driver_preuse(uuid,uuid,timestamptz,jsonb)'::regprocedure);
 IF position(old IN def)=0 THEN RAISE EXCEPTION 'Motor de checklist incompatible'; END IF;
 EXECUTE replace(def,old,old||$new$
 IF NOT EXISTS(SELECT 1 FROM public.driver_preuse_repeat_authorizations WHERE driver_id=dr.id
   AND vehicle_key=public.preuse_plate_key(v.plate) AND operation_date=day
   AND authorized_at<=p_captured_at+interval '30 seconds' AND consumed_by IS NULL) THEN
   SELECT * INTO prior FROM public.driver_preuse_inspections WHERE driver_id=dr.id
   AND public.preuse_plate_key(vehicle_plate)=public.preuse_plate_key(v.plate) AND operation_date=day
   ORDER BY captured_at DESC,record_sequence DESC LIMIT 1;
   IF prior.operation_id IS NOT NULL THEN RETURN jsonb_build_object('success',true,'already_registered',true,
     'operation_id',prior.operation_id,'existing_operation_id',prior.operation_id,
     'can_operate',public.driver_preuse_can_operate(dr.id,v.plate)); END IF;
 END IF;
 $new$);
END $patch$;

-- Returning to a previously inspected unit reuses its latest daily inspection.
-- A pending authorized repeat blocks operation until the new inspection is recorded.
DO $patch$ DECLARE def text; old text:='AND i.unit_revision=u.revision'; BEGIN
 def:=pg_get_functiondef('public.driver_preuse_can_operate(uuid,text)'::regprocedure);
 IF position(old IN def)=0 THEN RAISE EXCEPTION 'Validación de unidad incompatible'; END IF;
 def:=replace(def,old,'AND public.preuse_plate_key(i.vehicle_plate)=public.preuse_plate_key(u.vehicle_plate)');
 def:=replace(def,'BEGIN', $new$BEGIN
 IF EXISTS(SELECT 1 FROM public.driver_preuse_repeat_authorizations WHERE driver_id=p_driver
 AND vehicle_key=public.preuse_plate_key(p_plate) AND operation_date=(now() AT TIME ZONE 'America/Lima')::date AND consumed_by IS NULL) THEN RETURN false; END IF;
 $new$);
 EXECUTE def;
 def:=pg_get_functiondef('public.get_driver_preuse_context_before_fleet()'::regprocedure);
 IF position('i.unit_revision=u.revision' IN def)=0 THEN RAISE EXCEPTION 'Contexto de checklist incompatible'; END IF;
 EXECUTE replace(def,'i.unit_revision=u.revision','public.preuse_plate_key(i.vehicle_plate)=public.preuse_plate_key(u.vehicle_plate)');
 def:=pg_get_functiondef('public.driver_preuse_departure_recorded(uuid)'::regprocedure);
 IF position('AND i.unit_revision=revision' IN def)=0 THEN RAISE EXCEPTION 'Registro de salida incompatible'; END IF;
 EXECUTE replace(def,'AND i.unit_revision=revision','');
END $patch$;

CREATE FUNCTION public.get_driver_preuse_daily_status(p_plate text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE dr uuid; i public.driver_preuse_inspections; permitted boolean;
BEGIN
 SELECT d.id INTO dr FROM public.drivers d JOIN public.profiles p ON p.id=d.profile_id
 WHERE d.profile_id=auth.uid() AND d.is_active AND p.is_active ORDER BY d.id LIMIT 1;
 IF dr IS NULL THEN RAISE EXCEPTION 'No existe un conductor activo asociado a la sesión'; END IF;
 SELECT * INTO i FROM public.driver_preuse_inspections WHERE driver_id=dr
 AND public.preuse_plate_key(vehicle_plate)=public.preuse_plate_key(p_plate) AND operation_date=(now() AT TIME ZONE 'America/Lima')::date
 ORDER BY captured_at DESC,record_sequence DESC LIMIT 1;
 permitted:=EXISTS(SELECT 1 FROM public.driver_preuse_repeat_authorizations WHERE driver_id=dr
 AND vehicle_key=public.preuse_plate_key(p_plate) AND operation_date=(now() AT TIME ZONE 'America/Lima')::date AND consumed_by IS NULL);
 RETURN jsonb_build_object('daily_record',CASE WHEN i.operation_id IS NULL THEN NULL ELSE to_jsonb(i) END,
 'already_registered',i.operation_id IS NOT NULL AND NOT permitted,'repeat_authorized',permitted);
END $$;
ALTER FUNCTION public.get_driver_preuse_context() RENAME TO get_driver_preuse_context_before_daily_guard;
REVOKE ALL ON FUNCTION public.get_driver_preuse_context_before_daily_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.get_driver_preuse_context() RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r jsonb:=public.get_driver_preuse_context_before_daily_guard(); BEGIN
 RETURN r||public.get_driver_preuse_daily_status(COALESCE(r#>>'{unit,vehicle_plate}',r->>'route_plate'));
END $$;
ALTER FUNCTION public.select_driver_preuse_unit(text) RENAME TO select_driver_preuse_unit_before_daily_guard;
REVOKE ALL ON FUNCTION public.select_driver_preuse_unit_before_daily_guard(text) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.select_driver_preuse_unit(p_plate text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r jsonb:=public.select_driver_preuse_unit_before_daily_guard(p_plate); BEGIN RETURN r||public.get_driver_preuse_daily_status(r->>'vehicle_plate'); END $$;

CREATE OR REPLACE FUNCTION public.list_driver_preuse(p_from date,p_to date,p_search text DEFAULT '') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rows jsonb; total bigint;
BEGIN
 IF NOT public.is_active_tms_user() OR NOT(public.is_tms_admin() OR public.has_cmms_read_permission('flota')
 OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('documentario')) THEN RAISE EXCEPTION 'Solo personal autorizado consulta y exporta el formato FR-DT 007'; END IF;
 IF length(COALESCE(p_search,''))>500 THEN RAISE EXCEPTION 'La búsqueda admite hasta 500 caracteres'; END IF;
 IF p_from IS NULL OR p_to IS NULL OR p_to<p_from OR p_to-p_from>366 THEN RAISE EXCEPTION 'Indique un rango de fechas válido (máximo un año)'; END IF;
 SELECT count(*) INTO total FROM public.driver_preuse_inspections i WHERE operation_date BETWEEN p_from AND p_to
 AND (public.is_tms_admin() OR public.can_access_site(site_id))
 AND public.preuse_search_matches(concat_ws(' ',driver_name,vehicle_plate,license,inspector_name,record_sequence),p_search);
 IF total>2000 THEN RAISE EXCEPTION 'El rango reúne más de 2000 formatos; reduce las fechas o filtra conductor/placa'; END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(i)||jsonb_build_object(
 'can_authorize_repeat',public.preuse_can_authorize_repeat() AND public.can_access_site(i.site_id) AND i.operation_date=(now() AT TIME ZONE 'America/Lima')::date
 AND NOT EXISTS(SELECT 1 FROM public.driver_preuse_inspections later WHERE later.driver_id=i.driver_id
 AND public.preuse_plate_key(later.vehicle_plate)=public.preuse_plate_key(i.vehicle_plate) AND later.operation_date=i.operation_date
 AND (later.captured_at,later.record_sequence)>(i.captured_at,i.record_sequence)),
 'repeat_authorized',EXISTS(SELECT 1 FROM public.driver_preuse_repeat_authorizations a WHERE a.driver_id=i.driver_id
 AND a.vehicle_key=public.preuse_plate_key(i.vehicle_plate) AND a.operation_date=i.operation_date AND a.consumed_by IS NULL),
 'reinspection_reason',(SELECT reason FROM public.driver_preuse_repeat_authorizations a WHERE a.consumed_by=i.operation_id),
 'authorized_repeat',EXISTS(SELECT 1 FROM public.driver_preuse_repeat_authorizations a WHERE a.consumed_by=i.operation_id),
 'same_day_records',(SELECT count(*) FROM public.driver_preuse_inspections x WHERE x.driver_id=i.driver_id AND x.operation_date=i.operation_date
 AND public.preuse_plate_key(x.vehicle_plate)=public.preuse_plate_key(i.vehicle_plate))) ORDER BY i.operation_date DESC,i.captured_at DESC,i.record_sequence DESC),'[]'::jsonb)
 INTO rows FROM public.driver_preuse_inspections i WHERE operation_date BETWEEN p_from AND p_to
 AND (public.is_tms_admin() OR public.can_access_site(site_id))
 AND public.preuse_search_matches(concat_ws(' ',driver_name,vehicle_plate,license,inspector_name,record_sequence),p_search);
 RETURN rows;
END $$;
REVOKE ALL ON FUNCTION public.preuse_can_authorize_repeat(),public.preuse_daily_insert_guard() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.authorize_driver_preuse_repeat(uuid,text),public.get_driver_preuse_daily_status(text),public.get_driver_preuse_context(),public.select_driver_preuse_unit(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.authorize_driver_preuse_repeat(uuid,text),public.get_driver_preuse_daily_status(text),public.get_driver_preuse_context(),public.select_driver_preuse_unit(text) TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
