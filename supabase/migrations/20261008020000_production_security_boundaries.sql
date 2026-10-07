-- Confirmed against the live catalog: 164 RLS tables, legacy permissive policies,
-- seven owner-executed analytics views, and public evidence/signature buckets.
-- Preserve operational records and historical profiles; no deletes or reassignments.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '45s';

CREATE OR REPLACE FUNCTION public.is_active_tms_user() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND is_active=true);
$$;
REVOKE ALL ON FUNCTION public.is_active_tms_user() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.is_active_tms_user() TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.security_assert_active_session() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF current_setting('role',true) IN ('anon','authenticated') AND NOT public.is_active_tms_user() THEN
   RAISE EXCEPTION 'Sesión operativa no autorizada' USING ERRCODE='42501';
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.security_assert_active_session() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.security_assert_active_session() TO authenticated,service_role;

-- RLS does not restrict TRUNCATE/TRIGGER. Remove unnecessary table-level privileges.
-- Published installer metadata and the two carrier-name columns remain intentionally public.
DO $$ DECLARE t record; a record; BEGIN
 FOR t IN SELECT c.oid,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') LOOP
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon',t.relname);
  FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=t.oid AND attnum>0 AND NOT attisdropped AND attacl IS NOT NULL LOOP
   EXECUTE format('REVOKE SELECT(%I),INSERT(%I),UPDATE(%I),REFERENCES(%I) ON public.%I FROM PUBLIC,anon',a.attname,a.attname,a.attname,a.attname,t.relname);
  END LOOP;
  EXECUTE format('REVOKE TRUNCATE,TRIGGER,REFERENCES ON public.%I FROM authenticated',t.relname);
 END LOOP;
END $$;
GRANT SELECT(id,business_name) ON public.carriers TO anon;
GRANT SELECT ON public.app_versions TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC,anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC,anon;

-- Anonymous RPC access is an explicit allowlist, not a consequence of default grants.
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid,p.oid::regprocedure AS signature,p.prorettype FROM pg_proc p
 JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef LOOP
  EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC,anon',f.signature);
  IF f.prorettype IN ('trigger'::regtype,'event_trigger'::regtype) THEN
   EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated',f.signature);
  END IF;
  EXECUTE format('ALTER FUNCTION %s SET search_path=public,pg_temp',f.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.get_public_tracking_info(uuid,text),
 public.get_public_daily_tracking_info(uuid,text),public.get_public_daily_tracking_locations(uuid,text) TO anon,authenticated;

-- These three sanitized Caja views have explicit module/site predicates and are intentional
-- security barriers. Their callers need a limited projection of staff rows unavailable via profiles.
DO $$ DECLARE v record; BEGIN
 FOR v IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind='v' AND c.relname NOT IN ('vw_caja_people','vw_caja_trips','vw_caja_units') LOOP
  EXECUTE format('ALTER VIEW public.%I SET (security_invoker=true)',v.relname);
 END LOOP;
END $$;

-- Remove historical ALL/true policies on the affected tables. Retain existing restrictive policies.
DO $$ DECLARE p record; BEGIN
 FOR p IN SELECT schemaname,tablename,policyname FROM pg_policies
 WHERE schemaname='public' AND permissive='PERMISSIVE' AND policyname<>'tms_admin_full_access'
 AND tablename IN ('work_order_items','budget_extensions','carriers','cost_centers','products',
 'purchase_orders','purchase_order_lines','maintenance_invoices','operaciones_turnos','operaciones_actividades') LOOP
  EXECUTE format('DROP POLICY %I ON %I.%I',p.policyname,p.schemaname,p.tablename);
 END LOOP;
END $$;
CREATE POLICY carriers_public_names ON public.carriers FOR SELECT TO anon USING(is_active=true);
CREATE POLICY carriers_scoped_read ON public.carriers FOR SELECT TO authenticated USING(
 public.has_tms_read_permission('tarifas') OR public.has_tms_read_permission('mantenimiento-flota')
 OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('planificacion')
 OR public.has_tms_read_permission('monitoreo') OR public.has_tms_read_permission('torre-control')
 OR EXISTS(SELECT 1 FROM public.drivers d WHERE d.profile_id=auth.uid() AND d.carrier_id=carriers.id));
CREATE POLICY carriers_scoped_write ON public.carriers FOR ALL TO authenticated USING(
 public.has_tms_permission('tarifas') OR public.has_tms_permission('mantenimiento-flota')) WITH CHECK(
 public.has_tms_permission('tarifas') OR public.has_tms_permission('mantenimiento-flota'));
CREATE POLICY cost_centers_scoped_read ON public.cost_centers FOR SELECT TO authenticated USING(
 public.has_caja_read_access() OR public.has_tms_read_permission('ot') OR public.has_tms_read_permission('solicitudes')
 OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('maestros-trabajadores'));
CREATE POLICY cost_centers_scoped_write ON public.cost_centers FOR ALL TO authenticated USING(
 public.has_tms_permission('configuracion') OR public.has_tms_permission('caja-tarifario')) WITH CHECK(
 public.has_tms_permission('configuracion') OR public.has_tms_permission('caja-tarifario'));
CREATE POLICY products_scoped_read ON public.products FOR SELECT TO authenticated USING(
 public.has_tms_read_permission('apt') OR public.has_tms_read_permission('apt-carga')
 OR public.has_tms_read_permission('solicitudes') OR public.has_tms_read_permission('despacho'));
CREATE POLICY products_scoped_write ON public.products FOR ALL TO authenticated USING(
 public.has_tms_permission('apt-carga') OR public.has_tms_permission('configuracion')) WITH CHECK(
 public.has_tms_permission('apt-carga') OR public.has_tms_permission('configuracion'));
CREATE POLICY work_order_items_scoped_read ON public.work_order_items FOR SELECT TO authenticated USING(
 public.has_tms_read_permission('ot') AND EXISTS(SELECT 1 FROM public.work_orders w WHERE w.id=work_order_id
 AND (NOT public.is_contract_administrator() OR w.contract_administrator_id=auth.uid())));
CREATE POLICY work_order_items_scoped_write ON public.work_order_items FOR ALL TO authenticated USING(
 public.has_tms_permission('ot') AND EXISTS(SELECT 1 FROM public.work_orders w WHERE w.id=work_order_id
 AND (NOT public.is_contract_administrator() OR w.contract_administrator_id=auth.uid()))) WITH CHECK(
 public.has_tms_permission('ot') AND EXISTS(SELECT 1 FROM public.work_orders w WHERE w.id=work_order_id
 AND (NOT public.is_contract_administrator() OR w.contract_administrator_id=auth.uid())));
CREATE POLICY budget_extensions_scoped_read ON public.budget_extensions FOR SELECT TO authenticated USING(
 public.has_tms_read_permission('ot') AND EXISTS(SELECT 1 FROM public.work_orders w WHERE w.id=work_order_id
 AND (NOT public.is_contract_administrator() OR w.contract_administrator_id=auth.uid())));
CREATE POLICY budget_extensions_request ON public.budget_extensions FOR INSERT TO authenticated WITH CHECK(
 public.has_tms_permission('ot') AND requested_by=auth.uid() AND approved_by IS NULL AND status='PENDIENTE'
 AND EXISTS(SELECT 1 FROM public.work_orders w WHERE w.id=work_order_id
 AND (NOT public.is_contract_administrator() OR w.contract_administrator_id=auth.uid())));
CREATE POLICY purchase_orders_scoped ON public.purchase_orders FOR ALL TO authenticated USING(
 public.has_cmms_permission('ot')) WITH CHECK(public.has_cmms_permission('ot'));
CREATE POLICY purchase_order_lines_scoped ON public.purchase_order_lines FOR ALL TO authenticated USING(
 public.has_cmms_permission('ot') AND EXISTS(SELECT 1 FROM public.purchase_orders p WHERE p.id=purchase_order_id))
 WITH CHECK(public.has_cmms_permission('ot') AND EXISTS(SELECT 1 FROM public.purchase_orders p WHERE p.id=purchase_order_id)
 AND EXISTS(SELECT 1 FROM public.spare_parts s WHERE s.id=spare_part_id AND public.can_access_site(s.site_id)));
CREATE POLICY maintenance_invoices_scoped ON public.maintenance_invoices FOR ALL TO authenticated USING(
 (public.has_cmms_permission('ot') OR public.has_tms_permission('mantenimiento-finanzas')) AND
 (orden_trabajo_id IS NULL OR EXISTS(SELECT 1 FROM public.maintenance_work_orders w WHERE w.id=orden_trabajo_id AND public.can_access_site(w.site_id)))) WITH CHECK(
 (public.has_cmms_permission('ot') OR public.has_tms_permission('mantenimiento-finanzas')) AND
 (orden_trabajo_id IS NULL OR EXISTS(SELECT 1 FROM public.maintenance_work_orders w WHERE w.id=orden_trabajo_id AND public.can_access_site(w.site_id))));
CREATE POLICY operations_shifts_read ON public.operaciones_turnos FOR SELECT TO authenticated USING(
 profile_id=auth.uid() OR public.has_tms_read_permission('operaciones-live') OR public.has_tms_read_permission('operaciones-revision') OR public.has_tms_read_permission('operaciones-kpis') OR public.has_tms_read_permission('tareo') OR public.has_tms_read_permission('maestros-trabajadores'));
CREATE POLICY operations_shifts_write ON public.operaciones_turnos FOR ALL TO authenticated USING(
 profile_id=auth.uid() OR public.has_tms_permission('operaciones-revision') OR public.has_tms_permission('tareo')) WITH CHECK(profile_id=auth.uid() OR public.has_tms_permission('operaciones-revision') OR public.has_tms_permission('tareo'));
CREATE POLICY operations_activities_read ON public.operaciones_actividades FOR SELECT TO authenticated USING(
 EXISTS(SELECT 1 FROM public.operaciones_turnos t WHERE t.id=turno_id));
CREATE POLICY operations_activities_write ON public.operaciones_actividades FOR ALL TO authenticated USING(
 EXISTS(SELECT 1 FROM public.operaciones_turnos t WHERE t.id=turno_id AND (t.profile_id=auth.uid() OR public.has_tms_permission('operaciones-revision') OR public.has_tms_permission('tareo')))) WITH CHECK(
 EXISTS(SELECT 1 FROM public.operaciones_turnos t WHERE t.id=turno_id AND (t.profile_id=auth.uid() OR public.has_tms_permission('operaciones-revision') OR public.has_tms_permission('tareo'))));

-- A deactivated account cannot keep using a cached JWT to access operational tables.
-- profiles remains readable under its existing own/admin policies to explain the login rejection.
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname NOT IN ('profiles','app_versions') LOOP
  EXECUTE format('CREATE POLICY security_active_account ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING((SELECT public.is_active_tms_user())) WITH CHECK((SELECT public.is_active_tms_user()))',t.relname);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.security_maintenance_object_site(p_bucket text,p_name text,p_owner text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT public.is_active_tms_user() AND (
 public.is_tms_admin() OR p_owner=auth.uid()::text
 OR (split_part(p_name,'/',1)='inspecciones' AND EXISTS(
   SELECT 1 FROM public.vehicles v WHERE v.plate=split_part(p_name,'/',2) AND public.can_access_site(v.site_id)))
 OR (p_bucket='evidence' AND split_part(p_name,'/',1)='ot' AND EXISTS(
   SELECT 1 FROM public.maintenance_work_orders w WHERE w.id::text=split_part(p_name,'/',2) AND public.can_access_site(w.site_id)))
 OR (p_bucket='evidence' AND EXISTS(SELECT 1 FROM public.vehicle_documents d JOIN public.vehicles v
   ON v.id=d.vehicle_id OR v.plate=d.vehicle_plate WHERE split_part(d.file_url,'/object/public/evidence/',2)=p_name AND public.can_access_site(v.site_id)))
 OR (p_bucket='evidence' AND EXISTS(SELECT 1 FROM public.driver_documents d JOIN public.vehicles v ON v.assigned_driver_id=d.driver_id
   WHERE split_part(d.file_url,'/object/public/evidence/',2)=p_name AND public.can_access_site(v.site_id)))
 );
$$;
REVOKE ALL ON FUNCTION public.security_maintenance_object_site(text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.security_maintenance_object_site(text,text,text) TO authenticated,service_role;

-- Sensitive uploads no longer have permanent public access. Existing URL references are resolved
-- through /api/files using the viewer's session; no service-role signing and no object removal.
UPDATE storage.buckets SET public=false,file_size_limit=15728640,
 allowed_mime_types=ARRAY['image/jpeg','image/png','image/webp','application/pdf'] WHERE id='evidence';
UPDATE storage.buckets SET public=false,file_size_limit=2097152,
 allowed_mime_types=ARRAY['image/jpeg','image/png','image/webp'] WHERE id='signatures';
DROP POLICY IF EXISTS "Permitir ver a public en evidence" ON storage.objects;
DROP POLICY IF EXISTS "Public Access" ON storage.objects;
DROP POLICY IF EXISTS "Permitir subida a autenticados en evidence" ON storage.objects;
CREATE POLICY maintenance_evidence_read ON storage.objects FOR SELECT TO authenticated USING(
 bucket_id='evidence' AND public.security_maintenance_object_site(bucket_id,name,owner_id) AND
 (public.has_tms_read_permission('mantenimiento-flota') OR public.has_tms_read_permission('mantenimiento-ot')
 OR public.has_tms_read_permission('mantenimiento-vencimientos') OR public.has_tms_read_permission('mantenimiento-fallas')));
CREATE POLICY maintenance_evidence_upload ON storage.objects FOR INSERT TO authenticated WITH CHECK(
 bucket_id='evidence' AND public.is_active_tms_user() AND
 (public.has_tms_permission('mantenimiento-flota') OR public.has_tms_permission('mantenimiento-ot')
 OR public.has_tms_permission('mantenimiento-vencimientos') OR public.has_tms_permission('mantenimiento-fallas')));
CREATE POLICY inspection_signature_read ON storage.objects FOR SELECT TO authenticated USING(
 bucket_id='signatures' AND public.security_maintenance_object_site(bucket_id,name,owner_id) AND
 (public.has_tms_read_permission('usuarios') OR public.has_tms_read_permission('mantenimiento-flota')
 OR public.has_tms_read_permission('mantenimiento-ot')));
CREATE POLICY inspection_signature_upload ON storage.objects FOR INSERT TO authenticated WITH CHECK(
 bucket_id='signatures' AND public.is_active_tms_user() AND
 (public.has_tms_permission('mantenimiento-flota') OR public.has_tms_permission('mantenimiento-ot')));
CREATE POLICY security_storage_active ON storage.objects AS RESTRICTIVE FOR ALL TO authenticated
 USING((SELECT public.is_active_tms_user())) WITH CHECK((SELECT public.is_active_tms_user()));

-- Pure financial helpers honor caller RLS when called directly or from invoker views.
-- Inside an authorized SECURITY DEFINER operation they retain the operation's privileges.
ALTER FUNCTION public.cash_box_balance(uuid) SECURITY INVOKER;
ALTER FUNCTION public.check_expense_duplicate(varchar,varchar,varchar,varchar) SECURITY INVOKER;
ALTER FUNCTION public.caja_driver_overdue_trips(uuid) SECURITY INVOKER;
ALTER FUNCTION public.caja_driver_overdue_advances(uuid) SECURITY INVOKER;
ALTER FUNCTION public.caja_trip_is_settled(uuid) SECURITY INVOKER;
ALTER FUNCTION public.caja_advance_is_settled(uuid) SECURITY INVOKER;
ALTER FUNCTION public.profile_display_name(uuid) SECURITY INVOKER;
ALTER FUNCTION public.spare_part_available(uuid,uuid) SECURITY INVOKER;
REVOKE ALL ON FUNCTION public.evaluate_part_replenishment(uuid) FROM PUBLIC,anon,authenticated;


-- Durable abuse limit for public registration; no passwords or raw network addresses are stored.
CREATE TABLE public.registration_request_limits(
 scope text NOT NULL CHECK(scope IN ('driver','staff')),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 window_start timestamptz NOT NULL,
 attempts integer NOT NULL CHECK(attempts>0),
 PRIMARY KEY(scope,fingerprint)
);
CREATE INDEX registration_limits_retention ON public.registration_request_limits(window_start);
ALTER TABLE public.registration_request_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.registration_request_limits FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.registration_request_limits TO service_role;
CREATE FUNCTION public.reserve_registration_attempt(p_scope text,p_fingerprint text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_start timestamptz:=to_timestamp(floor(extract(epoch FROM now())/900)*900); v_count integer;
BEGIN
 IF p_scope NOT IN ('driver','staff') OR p_fingerprint !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Solicitud inválida'; END IF;
 DELETE FROM public.registration_request_limits WHERE window_start<now()-interval '24 hours';
 INSERT INTO public.registration_request_limits(scope,fingerprint,window_start,attempts) VALUES(p_scope,p_fingerprint,v_start,1)
 ON CONFLICT(scope,fingerprint) DO UPDATE SET window_start=v_start,
 attempts=CASE WHEN registration_request_limits.window_start=v_start THEN registration_request_limits.attempts+1 ELSE 1 END
 RETURNING attempts INTO v_count;
 RETURN v_count<=5;
END $$;
REVOKE ALL ON FUNCTION public.reserve_registration_attempt(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_registration_attempt(text,text) TO service_role;

-- Operators can submit their own hours, but only supervision can validate those hours.
CREATE FUNCTION public.security_guard_shift_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF current_setting('role',true)='authenticated' AND NOT (public.is_tms_admin() OR public.has_tms_permission('operaciones-revision') OR public.has_tms_permission('tareo')) THEN
  IF TG_OP='INSERT' THEN
   IF COALESCE(NEW.supervisor_status,'PENDIENTE')<>'PENDIENTE' OR NEW.supervisor_comments IS NOT NULL THEN
    RAISE EXCEPTION 'Solo el supervisor puede validar el tareo' USING ERRCODE='42501';
   END IF;
  ELSIF (NEW.supervisor_status,NEW.supervisor_comments) IS DISTINCT FROM (OLD.supervisor_status,OLD.supervisor_comments) THEN
   RAISE EXCEPTION 'Solo el supervisor puede validar el tareo' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER security_shift_review BEFORE INSERT OR UPDATE ON public.operaciones_turnos FOR EACH ROW EXECUTE FUNCTION public.security_guard_shift_review();
REVOKE ALL ON FUNCTION public.security_guard_shift_review() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.security_assert_vehicle(p_plate text,p_write boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_site uuid; v_own boolean; v_staff boolean;
BEGIN
 IF current_setting('role',true) NOT IN ('anon','authenticated') THEN RETURN; END IF;
 PERFORM public.security_assert_active_session();
 SELECT site_id INTO v_site FROM public.vehicles WHERE plate=p_plate;
 v_own:=EXISTS(SELECT 1 FROM public.drivers dr WHERE dr.profile_id=auth.uid() AND dr.is_active AND
  (EXISTS(SELECT 1 FROM public.vehicles v WHERE v.plate=p_plate AND v.assigned_driver_id=dr.id)
   OR EXISTS(SELECT 1 FROM public.dispatches d WHERE d.vehicle_plate=p_plate AND d.driver_id=dr.id AND d.status NOT IN ('LIQUIDADO','CERRADO','CANCELADO'))));
 v_staff:=public.can_access_site(v_site) AND CASE WHEN p_write THEN public.can_manage_fleet_status() ELSE
  public.can_manage_fleet_status() OR public.has_tms_read_permission('mantenimiento-flota') OR public.has_tms_read_permission('mantenimiento-ot')
  OR public.has_tms_read_permission('mantenimiento-dashboard') OR public.has_tms_read_permission('mantenimiento-vencimientos')
  OR public.has_tms_read_permission('mantenimiento-fallas') OR public.has_tms_read_permission('mantenimiento-planes')
  OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('planificacion')
  OR public.has_tms_read_permission('monitoreo') OR public.has_tms_read_permission('torre-control') OR public.has_caja_read_access() END;
 IF NOT COALESCE(v_own OR v_staff,false) THEN RAISE EXCEPTION 'Sin acceso a esta unidad' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.security_assert_vehicle(text,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.security_assert_vehicle(text,boolean) TO authenticated,service_role;

CREATE FUNCTION public.security_assert_driver(p_driver uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF current_setting('role',true) NOT IN ('anon','authenticated') THEN RETURN; END IF;
 PERFORM public.security_assert_active_session();
 IF NOT (EXISTS(SELECT 1 FROM public.drivers d WHERE d.id=p_driver AND d.profile_id=auth.uid() AND d.is_active)
  OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('mantenimiento-flota')
  OR public.has_tms_read_permission('mantenimiento-vencimientos') OR public.has_tms_read_permission('monitoreo')
  OR public.has_tms_read_permission('torre-control')) THEN
  RAISE EXCEPTION 'Sin acceso a este conductor' USING ERRCODE='42501';
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.security_assert_driver(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.security_assert_driver(uuid) TO authenticated,service_role;
CREATE OR REPLACE FUNCTION public.check_driver_eligibility(p_driver_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_driver   public.drivers%ROWTYPE;
  v_today    date := (now() AT TIME ZONE 'America/Lima')::date;
  v_lic      date;
  v_med      date;
  v_expired  text[];
  v_active   int;
  v_fines    int;
  v_blocking jsonb := '[]'::jsonb;
  v_obs      jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.security_assert_driver(p_driver_id);
  SELECT * INTO v_driver FROM public.drivers WHERE id = p_driver_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('eligible', false, 'status', 'BLOQUEADO', 'blocking_reasons', jsonb_build_array('Conductor no encontrado'),
                              'observation_reasons', '[]'::jsonb, 'checks', '{}'::jsonb);
  END IF;
  IF NOT COALESCE(v_driver.is_active, true) THEN
    v_blocking := v_blocking || jsonb_build_array('Conductor inactivo');
  END IF;

  SELECT max(expiry_date) INTO v_lic FROM public.driver_documents WHERE driver_id = p_driver_id AND doc_type = 'LICENCIA' AND is_active;
  v_lic := COALESCE(v_lic, v_driver.license_expiration);
  IF v_lic IS NULL OR v_lic < v_today THEN
    v_blocking := v_blocking || jsonb_build_array('Licencia vencida o no registrada');
  ELSIF v_lic <= v_today + 30 THEN
    v_obs := v_obs || jsonb_build_array('Licencia vence el ' || to_char(v_lic, 'DD/MM/YYYY'));
  END IF;

  SELECT array_agg(doc_type) INTO v_expired FROM public.driver_documents
  WHERE driver_id = p_driver_id AND is_active AND doc_type IN ('LICENCIA_ESPECIAL', 'CERTIFICADO_MATPEL', 'SCTR') AND expiry_date < v_today;
  IF v_expired IS NOT NULL THEN
    v_blocking := v_blocking || jsonb_build_array('Documento vencido: ' || array_to_string(v_expired, ', '));
  END IF;

  SELECT max(expiry_date) INTO v_med FROM public.driver_documents WHERE driver_id = p_driver_id AND doc_type = 'EXAMEN_MEDICO' AND is_active;
  IF v_med IS NULL THEN
    v_obs := v_obs || jsonb_build_array('Examen médico no registrado');
  ELSIF v_med < v_today THEN
    v_obs := v_obs || jsonb_build_array('Examen médico vencido');
  END IF;

  SELECT count(*) INTO v_fines FROM public.traffic_fines
  WHERE driver_id = p_driver_id AND responsibility = 'CONDUCTOR' AND status IN ('PENDIENTE', 'VENCIDA');
  IF v_fines > 0 THEN
    v_obs := v_obs || jsonb_build_array(v_fines || ' multa(s) pendiente(s) a cargo del conductor');
  END IF;

  SELECT count(*) INTO v_active FROM public.dispatches
  WHERE driver_id = p_driver_id AND status NOT IN ('LIQUIDADO', 'CERRADO', 'CANCELADO', 'RETORNO_COMPLETADO');
  IF v_active > 0 THEN
    v_blocking := v_blocking || jsonb_build_array('Conductor tiene despacho activo');
  END IF;

  RETURN jsonb_build_object(
    'eligible', jsonb_array_length(v_blocking) = 0,
    'status', CASE WHEN jsonb_array_length(v_blocking) > 0 THEN 'BLOQUEADO'
                   WHEN jsonb_array_length(v_obs) > 0 THEN 'APTO_CON_OBSERVACION' ELSE 'APTO' END,
    'blocking_reasons', v_blocking,
    'observation_reasons', v_obs,
    'checks', jsonb_build_object('driver_active', COALESCE(v_driver.is_active, true),
      'licencia_ok', v_lic IS NOT NULL AND v_lic >= v_today, 'special_docs_ok', v_expired IS NULL,
      'examen_medico_ok', v_med IS NOT NULL AND v_med >= v_today, 'no_active_dispatch', v_active = 0));
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_dispatch_eligibility(p_vehicle_plate text, p_driver_id uuid, p_required_capacity numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_vehicle_result jsonb;
  v_driver_result jsonb;
  v_all_blocking jsonb := '[]'::jsonb;
  v_all_obs jsonb := '[]'::jsonb;
  v_final_status TEXT;
BEGIN
  PERFORM public.security_assert_vehicle(p_vehicle_plate); PERFORM public.security_assert_driver(p_driver_id);
  v_vehicle_result := check_vehicle_eligibility(p_vehicle_plate, p_required_capacity);
  v_driver_result := check_driver_eligibility(p_driver_id);

  v_all_blocking := (v_vehicle_result->'blocking_reasons') || (v_driver_result->'blocking_reasons');
  v_all_obs := (v_vehicle_result->'observation_reasons') || (v_driver_result->'observation_reasons');

  IF jsonb_array_length(v_all_blocking) > 0 THEN v_final_status := 'BLOQUEADO';
  ELSIF jsonb_array_length(v_all_obs) > 0 THEN v_final_status := 'APTO_CON_OBSERVACION';
  ELSE v_final_status := 'APTO';
  END IF;

  RETURN jsonb_build_object(
    'eligible', v_final_status != 'BLOQUEADO',
    'status', v_final_status,
    'vehicle', v_vehicle_result,
    'driver', v_driver_result,
    'blocking_reasons', v_all_blocking,
    'observation_reasons', v_all_obs
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_vehicle_eligibility(p_vehicle_plate text, p_required_capacity numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result   jsonb;
  v_blocking jsonb;
  v_capacity numeric;
BEGIN
  PERFORM public.security_assert_vehicle(p_vehicle_plate);
  v_result   := public.check_asset_eligibility(p_vehicle_plate, 'DISPATCH');
  v_blocking := v_result->'motives';

  IF p_required_capacity IS NOT NULL AND p_required_capacity > 0 THEN
    SELECT COALESCE(weight_capacity, capacity_weight) INTO v_capacity
    FROM public.vehicles WHERE plate = p_vehicle_plate;
    IF v_capacity IS NOT NULL AND v_capacity < p_required_capacity THEN
      v_blocking := v_blocking || jsonb_build_array('Capacidad insuficiente (' || v_capacity || ' < ' || p_required_capacity || ')');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'eligible', jsonb_array_length(v_blocking) = 0,
    'status', CASE
      WHEN jsonb_array_length(v_blocking) > 0 THEN 'BLOQUEADO'
      WHEN jsonb_array_length(v_result->'observations') > 0 THEN 'APTO_CON_OBSERVACION'
      ELSE 'APTO' END,
    'asset_status', CASE WHEN jsonb_array_length(v_blocking) > 0 THEN 'NO_APTO' ELSE v_result->>'status' END,
    'blocking_reasons', v_blocking,
    'observation_reasons', v_result->'observations',
    'reason', (SELECT string_agg(value, '; ') FROM jsonb_array_elements_text(v_blocking)),
    'vehicle_status', v_result->>'vehicle_status',
    'checks', v_result->'checks'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_asset_eligibility(p_plate text, p_context text DEFAULT 'RELEASE'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_vehicle          public.vehicles%ROWTYPE;
  v_motives          jsonb := '[]'::jsonb;
  v_observations     jsonb := '[]'::jsonb;
  v_open_wo          int;
  v_open_faults      int;
  v_active_dispatch  int;
  v_overdue_plans    int;
  v_soat             date;
  v_rt               date;
  v_insurance        date;
  v_expired_other    int;
  v_status           text;
BEGIN
  PERFORM public.security_assert_vehicle(p_plate);
  IF p_context NOT IN ('RELEASE', 'DISPATCH', 'OPERATION') THEN
    RAISE EXCEPTION 'Contexto de elegibilidad inválido: %', p_context;
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE plate = p_plate;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'status', 'NO_APTO', 'eligible', false,
      'motives', jsonb_build_array('Vehículo no encontrado'),
      'observations', '[]'::jsonb, 'checks', '{}'::jsonb);
  END IF;

  -- Bloqueo administrativo
  IF COALESCE(v_vehicle.is_blocked, false) THEN
    v_motives := v_motives || jsonb_build_array(
      'Bloqueo administrativo activo: ' || COALESCE(v_vehicle.block_reason, 'sin motivo registrado'));
  END IF;

  -- Para despachar, la unidad debe estar DISPONIBLE
  IF p_context = 'DISPATCH' AND v_vehicle.status IS DISTINCT FROM 'DISPONIBLE' THEN
    v_motives := v_motives || jsonb_build_array('Unidad no está DISPONIBLE (estado actual: ' || COALESCE(v_vehicle.status, 'N/D') || ')');
  END IF;

  -- OT abierta (una OT solo deja de bloquear al estar CERRADA o CANCELADA)
  SELECT count(*) INTO v_open_wo
  FROM public.maintenance_work_orders
  WHERE vehicle_id = v_vehicle.id
    AND status NOT IN ('CERRADA', 'CANCELADA');
  IF v_open_wo > 0 THEN
    v_motives := v_motives || jsonb_build_array(v_open_wo || ' orden(es) de trabajo abierta(s)');
  END IF;

  -- Falla crítica no resuelta (solicitudes/fallas del backlog)
  SELECT count(*) INTO v_open_faults
  FROM public.maintenance_requests
  WHERE vehicle_plate = p_plate
    AND upper(translate(severity, 'Íí', 'Ii')) = 'CRITICA'
    AND status NOT IN ('CERRADA', 'DESCARTADA', 'CONVERTIDA_OT');
  IF v_open_faults > 0 THEN
    v_motives := v_motives || jsonb_build_array(v_open_faults || ' falla(s) crítica(s) sin resolver');
  END IF;

  -- Preventivo vencido (km, horas o fecha) según la proyección oficial
  SELECT count(*) INTO v_overdue_plans
  FROM public.vw_maintenance_projections
  WHERE vehicle_plate = p_plate AND alert_status = 'VENCIDO';
  IF v_overdue_plans > 0 THEN
    v_motives := v_motives || jsonb_build_array(v_overdue_plans || ' mantenimiento(s) preventivo(s) vencido(s)');
  END IF;

  -- Documentos: el registro en vehicle_documents prevalece sobre los campos del vehículo
  SELECT max(expiration_date) INTO v_soat FROM public.vehicle_documents
  WHERE COALESCE(vehicle_plate, (SELECT plate FROM public.vehicles WHERE id = vehicle_documents.vehicle_id)) = p_plate
    AND document_type = 'SOAT' AND COALESCE(is_active, true);
  v_soat := COALESCE(v_soat, v_vehicle.soat_expiration);

  SELECT max(expiration_date) INTO v_rt FROM public.vehicle_documents
  WHERE COALESCE(vehicle_plate, (SELECT plate FROM public.vehicles WHERE id = vehicle_documents.vehicle_id)) = p_plate
    AND document_type = 'REVISION_TECNICA' AND COALESCE(is_active, true);
  v_rt := COALESCE(v_rt, v_vehicle.technical_review_expiration);

  SELECT max(expiration_date) INTO v_insurance FROM public.vehicle_documents
  WHERE COALESCE(vehicle_plate, (SELECT plate FROM public.vehicles WHERE id = vehicle_documents.vehicle_id)) = p_plate
    AND document_type = 'POLIZA_SEGURO' AND COALESCE(is_active, true);

  -- Equipos no vehiculares (montacargas, apiladores, transpaletas) no requieren SOAT ni RT
  IF v_vehicle.type NOT IN ('MONTACARGAS', 'APILADOR', 'TRANSPALETA') THEN
    IF v_soat IS NULL OR v_soat < CURRENT_DATE THEN
      v_motives := v_motives || jsonb_build_array('SOAT vencido o no registrado');
    ELSIF v_soat <= CURRENT_DATE + 15 THEN
      v_observations := v_observations || jsonb_build_array('SOAT vence el ' || to_char(v_soat, 'DD/MM/YYYY'));
    END IF;

    IF v_rt IS NULL OR v_rt < CURRENT_DATE THEN
      v_motives := v_motives || jsonb_build_array('Revisión técnica vencida o no registrada');
    ELSIF v_rt <= CURRENT_DATE + 15 THEN
      v_observations := v_observations || jsonb_build_array('Revisión técnica vence el ' || to_char(v_rt, 'DD/MM/YYYY'));
    END IF;
  END IF;

  IF v_insurance IS NULL THEN
    v_observations := v_observations || jsonb_build_array('Póliza de seguro no registrada');
  ELSIF v_insurance < CURRENT_DATE THEN
    v_motives := v_motives || jsonb_build_array('Póliza de seguro vencida');
  ELSIF v_insurance <= CURRENT_DATE + 15 THEN
    v_observations := v_observations || jsonb_build_array('Póliza de seguro vence el ' || to_char(v_insurance, 'DD/MM/YYYY'));
  END IF;

  SELECT count(*) INTO v_expired_other FROM public.vehicle_documents
  WHERE COALESCE(vehicle_plate, (SELECT plate FROM public.vehicles WHERE id = vehicle_documents.vehicle_id)) = p_plate
    AND document_type NOT IN ('SOAT', 'REVISION_TECNICA', 'POLIZA_SEGURO')
    AND COALESCE(is_active, true) AND expiration_date < CURRENT_DATE;
  IF v_expired_other > 0 THEN
    v_observations := v_observations || jsonb_build_array(v_expired_other || ' documento(s) adicional(es) vencido(s)');
  END IF;

  -- Lecturas de uso
  IF v_vehicle.type IN ('MONTACARGAS', 'APILADOR', 'TRANSPALETA') THEN
    IF COALESCE(v_vehicle.current_hours, 0) <= 0 THEN
      v_observations := v_observations || jsonb_build_array('Horómetro sin registrar');
    END IF;
  ELSIF COALESCE(v_vehicle.current_odometer, 0) <= 0 THEN
    v_observations := v_observations || jsonb_build_array('Odómetro sin registrar');
  END IF;

  -- Viaje activo (no aplica cuando la transición la origina el propio flujo de despacho)
  IF p_context <> 'OPERATION' THEN
    SELECT count(*) INTO v_active_dispatch
    FROM public.dispatches
    WHERE vehicle_plate = p_plate
      AND status NOT IN ('CERRADO', 'LIQUIDADO', 'CANCELADO', 'RETORNO_COMPLETADO');
    IF v_active_dispatch > 0 THEN
      v_motives := v_motives || jsonb_build_array('Tiene un viaje/despacho activo');
    END IF;
  END IF;

  v_status := CASE
    WHEN jsonb_array_length(v_motives) > 0 THEN 'NO_APTO'
    WHEN jsonb_array_length(v_observations) > 0 THEN 'APTO_CON_OBSERVACION'
    ELSE 'APTO' END;

  RETURN jsonb_build_object(
    'status', v_status,
    'eligible', v_status <> 'NO_APTO',
    'motives', v_motives,
    'observations', v_observations,
    'vehicle_status', v_vehicle.status,
    'checks', jsonb_build_object(
      'no_admin_block', NOT COALESCE(v_vehicle.is_blocked, false),
      'no_open_work_orders', v_open_wo = 0,
      'no_critical_faults', v_open_faults = 0,
      'no_overdue_preventive', v_overdue_plans = 0,
      'soat_ok', v_vehicle.type IN ('MONTACARGAS', 'APILADOR', 'TRANSPALETA') OR (v_soat IS NOT NULL AND v_soat >= CURRENT_DATE),
      'rt_ok', v_vehicle.type IN ('MONTACARGAS', 'APILADOR', 'TRANSPALETA') OR (v_rt IS NOT NULL AND v_rt >= CURRENT_DATE),
      'insurance_ok', v_insurance IS NULL OR v_insurance >= CURRENT_DATE,
      'no_active_dispatch', COALESCE(v_active_dispatch, 0) = 0
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.calculate_trip_budget(p_rate_id uuid, p_vehicle_plate text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r     public.route_allowance_rates%ROWTYPE;
  cfg   public.caja_settings%ROWTYPE;
  v     record;
  km    numeric;
  kmpg  numeric;
  price numeric;
  gal   numeric;
  b     jsonb;
BEGIN
  PERFORM public.security_assert_active_session(); IF current_setting('role',true)='authenticated' AND NOT public.has_caja_read_access() THEN RAISE EXCEPTION 'Sin permiso para cotizar anticipos' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.route_allowance_rates WHERE id = p_rate_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Tarifa no encontrada'); END IF;
  SELECT * INTO cfg FROM public.caja_settings WHERE id;
  SELECT type, expected_km_per_gallon INTO v FROM public.vehicles WHERE plate = upper(trim(p_vehicle_plate));
  km := r.distance_km * CASE WHEN r.round_trip THEN 2 ELSE 1 END;
  kmpg := COALESCE(v.expected_km_per_gallon, cfg.default_km_per_gallon);
  price := COALESCE(r.fuel_price_per_gallon, cfg.fuel_price_per_gallon);
  gal := round(km / kmpg, 2);
  b := jsonb_build_object(
    'COMBUSTIBLE', round(gal * price, 2),
    'PEAJE', COALESCE((r.toll_by_type->>v.type)::numeric, r.toll_amount),
    'ALIMENTACION', round(r.meal_per_day * r.days, 2),
    'HOSPEDAJE', round(r.lodging_per_night * r.nights, 2),
    'OTROS', r.other_amount);
  RETURN jsonb_build_object('success', true, 'breakdown', b,
    'total', (SELECT sum(value::numeric) FROM jsonb_each_text(b)),
    'km', km, 'gallons', gal, 'km_per_gallon', kmpg, 'fuel_price', price, 'rate', r.name, 'days', r.days, 'nights', r.nights);
END $function$;

CREATE OR REPLACE FUNCTION public.transition_vehicle_status(p_vehicle_plate text, p_new_status text, p_reason text, p_user_id uuid, p_metadata jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_current     text;
  v_actor       uuid := COALESCE(auth.uid(), p_user_id);
  v_is_system   boolean := auth.uid() IS NULL;   -- service_role / procesos internos
  v_is_admin    boolean;
  v_is_manager  boolean;
  v_allowed     text[];
  v_eligibility jsonb;
BEGIN
  PERFORM public.security_assert_vehicle(p_vehicle_plate,true);
  v_is_admin   := v_is_system OR public.is_tms_admin();
  v_is_manager := v_is_admin OR public.can_manage_fleet_status();

  IF p_new_status NOT IN ('DISPONIBLE', 'ASIGNADA', 'EN_OPERACION', 'OBSERVADA',
                          'MANTENIMIENTO', 'BLOQUEADA', 'FUERA_DE_SERVICIO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Estado no válido: ' || COALESCE(p_new_status, 'NULL'));
  END IF;

  -- Permisos
  IF NOT v_is_manager AND p_new_status NOT IN ('BLOQUEADA', 'OBSERVADA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso: solo puede reportar la unidad como OBSERVADA o BLOQUEADA');
  END IF;
  IF p_new_status = 'FUERA_DE_SERVICIO' AND NOT v_is_admin THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo un administrador puede dar de baja (FUERA_DE_SERVICIO)');
  END IF;

  SELECT status INTO v_current FROM public.vehicles WHERE plate = p_vehicle_plate FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehículo no encontrado: ' || p_vehicle_plate);
  END IF;

  IF v_current = p_new_status THEN
    RETURN jsonb_build_object('success', true, 'previous_status', v_current, 'new_status', p_new_status, 'unchanged', true);
  END IF;

  v_allowed := CASE v_current
    WHEN 'DISPONIBLE'        THEN ARRAY['ASIGNADA','EN_OPERACION','OBSERVADA','MANTENIMIENTO','BLOQUEADA','FUERA_DE_SERVICIO']
    WHEN 'ASIGNADA'          THEN ARRAY['EN_OPERACION','DISPONIBLE','OBSERVADA','MANTENIMIENTO','BLOQUEADA']
    WHEN 'EN_OPERACION'      THEN ARRAY['DISPONIBLE','ASIGNADA','OBSERVADA','MANTENIMIENTO','BLOQUEADA']
    WHEN 'OBSERVADA'         THEN ARRAY['DISPONIBLE','MANTENIMIENTO','BLOQUEADA','FUERA_DE_SERVICIO']
    WHEN 'MANTENIMIENTO'     THEN ARRAY['DISPONIBLE','OBSERVADA','BLOQUEADA','FUERA_DE_SERVICIO']
    WHEN 'BLOQUEADA'         THEN ARRAY['DISPONIBLE','MANTENIMIENTO','OBSERVADA','FUERA_DE_SERVICIO']
    WHEN 'FUERA_DE_SERVICIO' THEN ARRAY['DISPONIBLE','OBSERVADA','MANTENIMIENTO']
    ELSE ARRAY[]::text[] END;

  IF NOT (p_new_status = ANY (v_allowed)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transición no permitida: ' || v_current || ' → ' || p_new_status);
  END IF;

  -- Compuerta de elegibilidad: liberar o poner en operación exige que no sea NO_APTO
  IF p_new_status IN ('DISPONIBLE', 'ASIGNADA', 'EN_OPERACION') THEN
    v_eligibility := public.check_asset_eligibility(
      p_vehicle_plate,
      CASE WHEN p_new_status = 'DISPONIBLE' THEN 'RELEASE' ELSE 'OPERATION' END);
    IF v_eligibility->>'status' = 'NO_APTO' THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Unidad NO_APTO: ' || (SELECT string_agg(value, '; ') FROM jsonb_array_elements_text(v_eligibility->'motives')),
        'eligibility', v_eligibility);
    END IF;
  END IF;

  UPDATE public.vehicles SET status = p_new_status WHERE plate = p_vehicle_plate;

  INSERT INTO public.vehicle_history_logs (vehicle_plate, changed_by, field_changed, old_value, new_value, change_reason)
  VALUES (p_vehicle_plate, v_actor, 'status', v_current, p_new_status,
          NULLIF(concat_ws(' | ', p_reason,
                 CASE WHEN p_metadata IS NOT NULL AND p_metadata <> '{}'::jsonb THEN p_metadata::text END,
                 CASE WHEN v_eligibility IS NOT NULL THEN 'elegibilidad=' || (v_eligibility->>'status') END), ''));

  RETURN jsonb_build_object('success', true, 'previous_status', v_current, 'new_status', p_new_status,
                            'eligibility', v_eligibility);
END;
$function$;

CREATE OR REPLACE FUNCTION public.transition_dispatch_status(p_dispatch_id uuid, p_new_status text, p_reason text DEFAULT NULL::text, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_dispatch       public.dispatches%ROWTYPE;
  v_current_status text;
  v_allowed        boolean := false;
  v_release        jsonb;
  v_actor          uuid := auth.uid();
  v_is_driver      boolean := false;
  v_staff          boolean := false;
BEGIN
  PERFORM public.security_assert_active_session();
  SELECT * INTO v_dispatch FROM public.dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF v_dispatch.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Despacho inexistente');
  END IF;

  -- Quién puede: personal de Despacho / Monitoreo / Torre de su sede, o el conductor del despacho para
  -- los hitos de su viaje. Sin sesión (procesos del servidor) se permite.
  IF v_actor IS NOT NULL THEN
    v_staff := public.can_operate_dispatch(v_dispatch.site_id);
    v_is_driver := EXISTS (SELECT 1 FROM public.drivers dr WHERE dr.id = v_dispatch.driver_id AND dr.profile_id = v_actor AND dr.is_active=true);
    IF NOT v_staff AND NOT (v_is_driver AND p_new_status IN ('EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO_COMPLETADO')) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para cambiar el estado de este despacho');
    END IF;
    IF p_new_status = 'CANCELADO' AND NOT (public.has_tms_permission('despacho') AND public.can_access_site(v_dispatch.site_id)) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Solo Despacho puede cancelar un despacho');
    END IF;
  END IF;

  v_current_status := COALESCE(v_dispatch.status, 'PROGRAMADO');
  IF v_current_status = p_new_status THEN
    RETURN jsonb_build_object('success', true, 'previous_status', v_current_status, 'new_status', p_new_status,
                              'note', 'El estado ya era ' || p_new_status);
  END IF;

  IF p_new_status = 'CANCELADO' THEN
    -- Solo antes de salir; en ruta el servicio se cierra y la partida se consume
    v_allowed := v_current_status = 'PROGRAMADO';
    IF NOT v_allowed THEN
      RETURN jsonb_build_object('success', false, 'error', 'El despacho ya salió (' || v_current_status
        || '): no se puede cancelar. Ciérrelo al retornar; la partida se consume.');
    END IF;
  ELSIF p_new_status = 'LIQUIDADO' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Use "Cerrar ruta": el cierre consume la partida y marca las solicitudes como entregadas');
  ELSIF v_current_status = 'PROGRAMADO' THEN
    v_allowed := p_new_status IN ('EN_CURSO', 'EN RUTA');
  ELSIF v_current_status IN ('EN_CURSO', 'EN RUTA') THEN
    v_allowed := p_new_status IN ('ESPERANDO_AUTORIZACION', 'RETORNO', 'ENTREGADO');
  ELSIF v_current_status = 'ESPERANDO_AUTORIZACION' THEN
    v_allowed := p_new_status = 'RETORNO';
  ELSIF v_current_status = 'RETORNO' THEN
    v_allowed := p_new_status = 'RETORNO_COMPLETADO';
  ELSIF v_current_status = 'LIQUIDADO' THEN
    v_allowed := p_new_status = 'CERRADO';
  END IF;

  IF NOT v_allowed THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transición no permitida de ' || v_current_status || ' a ' || p_new_status);
  END IF;

  -- "Entregado" solo con todas las paradas confirmadas en el app (foto de entrega)
  IF p_new_status = 'ENTREGADO' AND EXISTS (SELECT 1 FROM public.dispatch_requests
      WHERE dispatch_id = p_dispatch_id AND status <> 'ENTREGADO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Hay paradas sin entrega confirmada: el conductor debe registrarlas en el app');
  END IF;

  UPDATE public.dispatches SET status = p_new_status WHERE id = p_dispatch_id;

  INSERT INTO public.dispatch_events (dispatch_id, event_type, description, created_by)
  VALUES (p_dispatch_id, 'STATUS_CHANGE',
          'Cambio de estado: ' || v_current_status || ' -> ' || p_new_status || COALESCE('. Razón: ' || p_reason, ''),
          COALESCE(v_actor::text, p_user_id::text, 'system'));

  IF p_new_status = 'CANCELADO' THEN
    PERFORM public.dispatch_release_on_cancel(p_dispatch_id, p_reason);
  END IF;

  -- Liberación de la unidad por el motor; si no es elegible queda OBSERVADA
  IF p_new_status IN ('CERRADO', 'CANCELADO') AND v_dispatch.vehicle_plate IS NOT NULL
     AND (SELECT status FROM public.vehicles WHERE plate = v_dispatch.vehicle_plate) IN ('ASIGNADA', 'EN_OPERACION') THEN
    v_release := public.transition_vehicle_status(v_dispatch.vehicle_plate, 'DISPONIBLE',
                   'Despacho finalizado (' || p_new_status || ')', v_actor,
                   jsonb_build_object('dispatch_id', p_dispatch_id));
    IF NOT COALESCE((v_release->>'success')::boolean, false) THEN
      v_release := public.transition_vehicle_status(v_dispatch.vehicle_plate, 'OBSERVADA',
                     'No elegible al cierre del despacho: ' || COALESCE(v_release->>'error', ''),
                     v_actor, jsonb_build_object('dispatch_id', p_dispatch_id));
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'previous_status', v_current_status, 'new_status', p_new_status,
                            'vehicle_transition', v_release);
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_odometer_reading(p_vehicle_plate text, p_odometer_value numeric, p_photo_url text, p_source_event text, p_dispatch_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path=public,pg_temp
AS $function$
DECLARE
    v_driver_id UUID;
    v_current_odometer NUMERIC(10,2);
    v_status TEXT := 'VALIDADO';
    v_user_id UUID;
BEGIN
    PERFORM public.security_assert_vehicle(p_vehicle_plate,true);
    IF p_odometer_value IS NULL OR p_odometer_value<0 OR p_odometer_value>99999999 THEN RAISE EXCEPTION 'Odómetro inválido'; END IF;
    IF p_dispatch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.dispatches d WHERE d.id=p_dispatch_id AND d.vehicle_plate=p_vehicle_plate
      AND (current_setting('role',true) NOT IN ('anon','authenticated') OR public.can_access_site(d.site_id)
        OR EXISTS(SELECT 1 FROM public.drivers dr WHERE dr.id=d.driver_id AND dr.profile_id=auth.uid() AND dr.is_active))) THEN
      RAISE EXCEPTION 'Despacho no asociado a esta unidad' USING ERRCODE='42501';
    END IF;
    v_user_id := auth.uid();
    
    -- Get driver id if called by a driver
    SELECT id INTO v_driver_id FROM public.drivers WHERE profile_id = v_user_id AND is_active=true;

    -- Get current odometer and mileage
    SELECT COALESCE(current_odometer, current_mileage) INTO v_current_odometer
    FROM public.vehicles
    WHERE plate = p_vehicle_plate FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Vehículo no encontrado';
    END IF;

    -- Validation logic
    IF v_current_odometer IS NOT NULL THEN
        IF p_odometer_value < v_current_odometer THEN
            v_status := 'REQUIERE_AUDITORIA';
        ELSIF (p_odometer_value - v_current_odometer) > 2000 THEN
            -- Unlikely to jump more than 2000 km between readings
            v_status := 'REQUIERE_AUDITORIA';
        END IF;
    END IF;

    -- Insert log
    INSERT INTO public.vehicle_odometer_logs(
        vehicle_plate, driver_id, dispatch_id, odometer_value, photo_url, source_event, status, created_by
    ) VALUES (
        p_vehicle_plate, v_driver_id, p_dispatch_id, p_odometer_value, p_photo_url, p_source_event, v_status, v_user_id
    );

    -- Update vehicle if valid
    IF v_status = 'VALIDADO' THEN
        UPDATE public.vehicles
        SET current_odometer = p_odometer_value,
            current_mileage = p_odometer_value
        WHERE plate = p_vehicle_plate;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'status', v_status,
        'recorded_value', p_odometer_value,
        'previous_value', v_current_odometer
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.submit_post_route_checklist(p_dispatch_id uuid, p_vehicle_plate text, p_driver_id uuid, p_odometer numeric, p_liquidation_data jsonb, p_location jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path=public,pg_temp
AS $function$
DECLARE
    v_dispatch record;
    v_lat numeric(10,6) := NULL;
    v_lon numeric(10,6) := NULL;
    v_start_odometer numeric;
    v_transition_result jsonb;
BEGIN
    PERFORM public.security_assert_active_session();
    IF current_setting('role',true) IN ('anon','authenticated') AND NOT EXISTS(
      SELECT 1 FROM public.drivers dr JOIN public.dispatches d ON d.driver_id=dr.id
      WHERE d.id=p_dispatch_id AND dr.id=p_driver_id AND dr.profile_id=auth.uid() AND dr.is_active=true) THEN
      RAISE EXCEPTION 'Solo el conductor asignado puede registrar el post-ruta' USING ERRCODE='42501';
    END IF;
    -- 1. Validar que el despacho existe y pertenece al conductor
    SELECT * INTO v_dispatch
    FROM public.dispatches
    WHERE id = p_dispatch_id FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Despacho no encontrado');
    END IF;

    IF v_dispatch.driver_id IS DISTINCT FROM p_driver_id THEN
        RETURN jsonb_build_object('success', false, 'message', 'Despacho no asignado a este conductor');
    END IF;

    IF v_dispatch.vehicle_plate IS DISTINCT FROM p_vehicle_plate THEN
        RETURN jsonb_build_object('success', false, 'message', 'La placa del vehículo enviada no coincide con la asignada al despacho');
    END IF;

    -- 2. Validar que el estado permite la liquidación/cierre
    IF v_dispatch.status NOT IN ('EN_CURSO', 'EN RUTA', 'RETORNO', 'ENTREGADO', 'RETORNO_COMPLETADO') THEN
        RETURN jsonb_build_object('success', false, 'message', 'Despacho en estado inválido para checklist post-ruta');
    END IF;

    -- 3. Validar Odómetro
    BEGIN
        v_start_odometer := v_dispatch.start_odometer;
    EXCEPTION WHEN OTHERS THEN
        v_start_odometer := 0;
    END;

    IF p_odometer IS NULL OR p_odometer < 0 THEN
        RETURN jsonb_build_object('success', false, 'message', 'Lectura de odómetro inválida. Debe ser un número positivo.');
    END IF;

    IF v_start_odometer IS NOT NULL AND p_odometer < v_start_odometer THEN
        RETURN jsonb_build_object('success', false, 'message', 'El odómetro final no puede ser menor al inicial (' || v_start_odometer || ')');
    END IF;

    -- Extraer coordenadas si el objeto de location es proporcionado
    IF p_location IS NOT NULL THEN
        BEGIN
            v_lat := (p_location->>'lat')::numeric;
            v_lon := (p_location->>'lon')::numeric;
        EXCEPTION WHEN OTHERS THEN
            v_lat := NULL;
            v_lon := NULL;
        END;
    END IF;

    -- 4. Actualizar el despacho con datos de liquidación y finalización
    UPDATE public.dispatches
    SET liquidation_data = p_liquidation_data,
        end_odometer = p_odometer,
        arrival_time = NOW()
    WHERE id = p_dispatch_id;

    -- Opcional: Insertar en driver_checklists para mantener historial (si existe la tabla)
    BEGIN
        INSERT INTO public.driver_checklists (
            dispatch_id, 
            driver_id, 
            vehicle_plate, 
            checklist_data, 
            location_lat, 
            location_lon
        ) VALUES (
            p_dispatch_id, 
            p_driver_id, 
            p_vehicle_plate, 
            jsonb_build_object('type', 'POST_RUTA', 'liquidation', p_liquidation_data, 'end_odometer', p_odometer), 
            v_lat, 
            v_lon
        );
    EXCEPTION WHEN undefined_table THEN
        -- Si la tabla no existe, ignorar, ya actualizamos dispatches.
    END;

    -- 5. Actualizar el odómetro
    -- 5.1 Insertar en vehicle_odometer_logs
    BEGIN
        INSERT INTO public.vehicle_odometer_logs (
            vehicle_plate, 
            driver_id, 
            dispatch_id, 
            odometer_value, 
            source_event, 
            status, 
            notes
        ) VALUES (
            p_vehicle_plate, 
            p_driver_id, 
            p_dispatch_id, 
            p_odometer, 
            'CHECKLIST_POST_RUTA', 
            'VALIDADO', 
            'Actualización automática desde checklist post-ruta'
        );
    EXCEPTION WHEN undefined_table THEN
        -- Ignorar si la tabla no existe
    END;

    -- 5.2 Actualizar vehicles.current_odometer
    BEGIN
        UPDATE public.vehicles
        SET current_odometer = p_odometer
        WHERE plate = p_vehicle_plate;
    EXCEPTION WHEN OTHERS THEN
        -- Ignorar fallas (e.g. si current_odometer no existe en vehicles)
    END;

    -- 6. Ejecutar transición de estado
    BEGIN
        v_transition_result := public.transition_dispatch_status(
            p_dispatch_id, 
            'RETORNO_COMPLETADO', 
            'Finalizado por checklist post-ruta', 
            p_driver_id
        );
        
        -- Si la máquina de estados rechaza la transición, propagamos el error
        IF NOT (v_transition_result->>'success')::boolean THEN
            RAISE EXCEPTION '%', COALESCE(v_transition_result->>'error','Transición rechazada');
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE;
    END;

    -- 7. Retorna éxito
    RETURN jsonb_build_object('success', true, 'message', 'Viaje finalizado');
END $function$;

ALTER FUNCTION public.next_vehicle_internal_code(text) SECURITY INVOKER;
NOTIFY pgrst,'reload schema';
COMMIT;
