BEGIN;

INSERT INTO public.roles(name, description, permissions) VALUES
  ('Conductor', 'Ejecución de viajes propios desde el Portal Operativo',
    '["portal-operativo","viajes:read","checklist:write","gastos:write","fallas:write","ia:read:viaje"]'::jsonb),
  ('Auxiliar Operativo', 'Apoyo en actividades y evidencias asignadas',
    '["portal-operativo","viajes:read","evidencias:write"]'::jsonb),
  ('Operario', 'Jornada, tareo y actividades operativas',
    '["portal-operativo","tareo:write","actividades:write"]'::jsonb),
  ('Supervisor Operativo', 'Supervisión y aprobación de operaciones de sede',
    '["portal-operativo","despacho:read","monitoreo:read","mantenimiento-fallas:read","operaciones-aprobar:write"]'::jsonb)
ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description, permissions = EXCLUDED.permissions;

ALTER TABLE public.dispatch_events
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS latitude numeric(10,7),
  ADD COLUMN IF NOT EXISTS longitude numeric(10,7),
  ADD COLUMN IF NOT EXISTS device jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS idempotency_key uuid;
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_events_idempotency
  ON public.dispatch_events(idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE public.ai_action_proposals
  ADD COLUMN IF NOT EXISTS original_input text,
  ADD COLUMN IF NOT EXISTS confirmed_payload jsonb,
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'ai_chat',
  ADD COLUMN IF NOT EXISTS latitude numeric(10,7),
  ADD COLUMN IF NOT EXISTS longitude numeric(10,7),
  ADD COLUMN IF NOT EXISTS device jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Some early environments recorded migration 00023 without creating this table.
-- Keep this migration self-contained so every linked environment converges.
CREATE TABLE IF NOT EXISTS public.dispatch_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id uuid NOT NULL REFERENCES public.dispatches(id) ON DELETE CASCADE,
  expense_type varchar(50) NOT NULL,
  amount numeric(10,2) NOT NULL DEFAULT 0,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.dispatch_expenses
  ADD COLUMN IF NOT EXISTS driver_id uuid REFERENCES public.drivers(id),
  ADD COLUMN IF NOT EXISTS receipt_url text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'PENDIENTE',
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS latitude numeric(10,7),
  ADD COLUMN IF NOT EXISTS longitude numeric(10,7),
  ADD COLUMN IF NOT EXISTS client_operation_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_expenses_client_operation
  ON public.dispatch_expenses(client_operation_id) WHERE client_operation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.vehicle_maintenance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_plate varchar(20) NOT NULL,
  record_type varchar(50) NOT NULL,
  status varchar(50) DEFAULT 'PENDIENTE',
  description text NOT NULL,
  diagnosis text,
  reported_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.vehicle_maintenance_records
  ADD COLUMN IF NOT EXISTS driver_id uuid REFERENCES public.drivers(id),
  ADD COLUMN IF NOT EXISTS dispatch_id uuid REFERENCES public.dispatches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS failure_category text,
  ADD COLUMN IF NOT EXISTS severity text,
  ADD COLUMN IF NOT EXISTS can_continue boolean,
  ADD COLUMN IF NOT EXISTS latitude numeric(10,7),
  ADD COLUMN IF NOT EXISTS longitude numeric(10,7),
  ADD COLUMN IF NOT EXISTS evidence_paths jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS audio_path text,
  ADD COLUMN IF NOT EXISTS client_operation_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_records_client_operation
  ON public.vehicle_maintenance_records(client_operation_id) WHERE client_operation_id IS NOT NULL;

DROP POLICY IF EXISTS "All access dispatch_expenses" ON public.dispatch_expenses;
ALTER TABLE public.dispatch_expenses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dispatch_expenses FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.dispatch_expenses TO authenticated;
CREATE POLICY dispatch_expenses_own_read ON public.dispatch_expenses FOR SELECT TO authenticated
  USING (created_by = auth.uid() OR EXISTS (SELECT 1 FROM public.drivers d
    WHERE d.id = driver_id AND d.profile_id = auth.uid()) OR
    public.has_tms_read_permission('caja-gastos') OR public.has_tms_read_permission('despacho'));
CREATE POLICY dispatch_expenses_own_insert ON public.dispatch_expenses FOR INSERT TO authenticated
  WITH CHECK ((created_by = auth.uid() AND EXISTS (SELECT 1 FROM public.drivers d
    JOIN public.dispatches s ON s.driver_id = d.id WHERE d.id = driver_id
      AND d.profile_id = auth.uid() AND s.id = dispatch_id)) OR public.has_tms_permission('caja-gastos'));
CREATE POLICY dispatch_expenses_staff_update ON public.dispatch_expenses FOR UPDATE TO authenticated
  USING (public.has_tms_permission('caja-gastos')) WITH CHECK (public.has_tms_permission('caja-gastos'));

DROP POLICY IF EXISTS "Allow all authenticated on vehicle_maintenance_records" ON public.vehicle_maintenance_records;
DROP POLICY IF EXISTS "Allow all anon on vehicle_maintenance_records" ON public.vehicle_maintenance_records;
ALTER TABLE public.vehicle_maintenance_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vehicle_maintenance_records FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.vehicle_maintenance_records TO authenticated;
CREATE POLICY maintenance_records_own_read ON public.vehicle_maintenance_records FOR SELECT TO authenticated
  USING (reported_by = auth.uid() OR EXISTS (SELECT 1 FROM public.drivers d
    WHERE d.id = driver_id AND d.profile_id = auth.uid()) OR
    public.has_tms_read_permission('mantenimiento-fallas') OR public.has_tms_read_permission('mantenimiento-flota'));
CREATE POLICY maintenance_records_own_insert ON public.vehicle_maintenance_records FOR INSERT TO authenticated
  WITH CHECK ((reported_by = auth.uid() AND EXISTS (SELECT 1 FROM public.drivers d
    WHERE d.id = driver_id AND d.profile_id = auth.uid())) OR public.has_tms_permission('mantenimiento-fallas'));
CREATE POLICY maintenance_records_staff_update ON public.vehicle_maintenance_records FOR UPDATE TO authenticated
  USING (public.has_tms_permission('mantenimiento-fallas')) WITH CHECK (public.has_tms_permission('mantenimiento-fallas'));

ALTER TABLE public.app_update_events
  ADD COLUMN IF NOT EXISTS device_id uuid,
  ADD COLUMN IF NOT EXISTS platform text,
  ADD COLUMN IF NOT EXISTS build_number integer,
  ADD COLUMN IF NOT EXISTS device jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.app_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('web', 'android')),
  installed_version text NOT NULL,
  build_number integer,
  device jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, device_id)
);
ALTER TABLE public.app_installations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_installations FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.app_installations TO authenticated;
CREATE POLICY app_installations_own ON public.app_installations FOR ALL TO authenticated
  USING (user_id = auth.uid() OR public.is_tms_admin()) WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.get_active_trip_context()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_driver public.drivers%ROWTYPE; v_dispatch public.dispatches%ROWTYPE;
DECLARE v_profile public.profiles%ROWTYPE; v_requests jsonb; v_contract jsonb;
BEGIN
  SELECT * INTO v_profile FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_profile.id IS NULL THEN RAISE EXCEPTION 'Sesión operativa no autorizada'; END IF;
  SELECT * INTO v_driver FROM public.drivers WHERE profile_id = auth.uid() AND is_active = true LIMIT 1;
  IF v_driver.id IS NULL THEN
    RETURN jsonb_build_object('user', jsonb_build_object('id', v_profile.id,
      'first_name', v_profile.first_name, 'last_name', v_profile.last_name,
      'employee_type', v_profile.employee_type), 'driver', NULL, 'trip', NULL,
      'pending', jsonb_build_object(), 'as_of', now());
  END IF;
  SELECT * INTO v_dispatch FROM public.dispatches WHERE driver_id = v_driver.id
    AND status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO','RETORNO_COMPLETADO')
    ORDER BY created_at DESC LIMIT 1;
  IF v_dispatch.id IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'transport_request_id', dr.transport_request_id, 'sequence_order', dr.sequence_order,
      'status', dr.status, 'document_number', dr.document_number, 'document_type', dr.document_type,
      'leg_actual_km', dr.leg_actual_km, 'leg_gps_complete', dr.leg_gps_complete,
      'request_number', tr.request_number, 'request_type', tr.request_type,
      'pickup_address', tr.pickup_address, 'delivery_address', tr.delivery_address,
      'required_date', tr.required_date) ORDER BY dr.sequence_order), '[]'::jsonb)
    INTO v_requests FROM public.dispatch_requests dr JOIN public.transport_requests tr
      ON tr.id = dr.transport_request_id WHERE dr.dispatch_id = v_dispatch.id;
    SELECT jsonb_build_object('id', c.id, 'code', c.code, 'status', c.status,
      'destination_address', c.destination_address,
      'client', CASE WHEN cl.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', cl.id, 'name', cl.business_name, 'phone', cl.phone) END)
    INTO v_contract FROM public.contracts c LEFT JOIN public.clients cl ON cl.id = c.client_id
      WHERE c.id = v_dispatch.contract_id;
  END IF;
  RETURN jsonb_build_object(
    'user', jsonb_build_object('id', v_profile.id, 'first_name', v_profile.first_name,
      'last_name', v_profile.last_name, 'phone', v_profile.phone, 'employee_type', v_profile.employee_type),
    'driver', jsonb_build_object('id', v_driver.id, 'document_number', v_driver.document_number,
      'first_name', v_driver.first_name, 'last_name', v_driver.last_name, 'phone', v_driver.phone,
      'license_number', v_driver.license_number, 'license_category', v_driver.license_category,
      'license_expiration', v_driver.license_expiration),
    'trip', CASE WHEN v_dispatch.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_dispatch.id, 'dispatch_number', v_dispatch.dispatch_number,
      'vehicle_plate', v_dispatch.vehicle_plate, 'status', v_dispatch.status,
      'scheduled_departure', v_dispatch.scheduled_departure,
      'actual_distance_km', v_dispatch.actual_distance_km, 'last_lat', v_dispatch.last_lat,
      'last_lon', v_dispatch.last_lon, 'last_gps_at', v_dispatch.last_gps_at,
      'contract', v_contract, 'stops', coalesce(v_requests, '[]'::jsonb)) END,
    'pending', CASE WHEN v_dispatch.id IS NULL THEN jsonb_build_object() ELSE jsonb_build_object(
      'checklist', NOT EXISTS (SELECT 1 FROM public.driver_checklists WHERE dispatch_id = v_dispatch.id
        AND driver_id = v_driver.id AND is_approved = true),
      'stops', (SELECT count(*) FROM public.dispatch_requests WHERE dispatch_id = v_dispatch.id AND status <> 'ENTREGADO'),
      'expenses', (SELECT count(*) FROM public.dispatch_expenses WHERE dispatch_id = v_dispatch.id AND status = 'PENDIENTE'),
      'failures', (SELECT count(*) FROM public.vehicle_maintenance_records WHERE dispatch_id = v_dispatch.id
        AND status IN ('PENDIENTE','EN_REVISION','EN_MANTENIMIENTO'))) END, 'as_of', now());
END $$;
REVOKE ALL ON FUNCTION public.get_active_trip_context() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_active_trip_context() TO authenticated;

CREATE TABLE IF NOT EXISTS public.driver_operation_receipts (
  operation_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action_type text NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.driver_operation_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.driver_operation_receipts FROM anon, authenticated;
GRANT SELECT ON public.driver_operation_receipts TO authenticated;
CREATE POLICY driver_operation_receipts_own ON public.driver_operation_receipts FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_tms_admin());

CREATE OR REPLACE FUNCTION public.execute_driver_offline_action(
  p_operation_id uuid, p_action_type text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_result jsonb;
BEGIN
  SELECT result INTO v_result FROM public.driver_operation_receipts
    WHERE operation_id = p_operation_id AND user_id = auth.uid();
  IF v_result IS NOT NULL THEN RETURN v_result; END IF;
  IF p_action_type = 'complete_dispatch_stop' THEN
    v_result := public.complete_dispatch_stop((p_payload->>'dispatch_id')::uuid,
      (p_payload->>'request_id')::uuid, p_payload->>'photo_url');
  ELSIF p_action_type = 'request_dispatch_return' THEN
    PERFORM public.request_dispatch_return((p_payload->>'dispatch_id')::uuid);
    v_result := jsonb_build_object('status', 'ESPERANDO_AUTORIZACION');
  ELSIF p_action_type = 'complete_dispatch_return' THEN
    v_result := public.complete_dispatch_return((p_payload->>'dispatch_id')::uuid);
  ELSE
    RAISE EXCEPTION 'Acción offline no permitida';
  END IF;
  INSERT INTO public.driver_operation_receipts(operation_id, user_id, action_type, result)
    VALUES(p_operation_id, auth.uid(), p_action_type, coalesce(v_result, '{}'::jsonb));
  RETURN coalesce(v_result, '{}'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.execute_driver_offline_action(uuid,text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.execute_driver_offline_action(uuid,text,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.ai_prepare_trip_action(
  p_dispatch_id uuid, p_action text, p_payload jsonb DEFAULT '{}'::jsonb,
  p_original_input text DEFAULT NULL, p_origin text DEFAULT 'ai_chat',
  p_lat numeric DEFAULT NULL, p_lon numeric DEFAULT NULL,
  p_device jsonb DEFAULT '{}'::jsonb, p_idempotency_key uuid DEFAULT gen_random_uuid())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_proposal public.ai_action_proposals; v_driver uuid; v_status text;
DECLARE v_allowed constant text[] := ARRAY['CONFIRM_START','CONFIRM_ARRIVAL','CONFIRM_LOADING',
  'CONFIRM_UNLOADING','REPORT_DELAY','REPORT_INCIDENT','REPORT_FAILURE','REGISTER_EXPENSE',
  'REQUEST_EVIDENCE','CONFIRM_DELIVERY','REQUEST_RETURN','FINISH_TRIP'];
BEGIN
  IF p_action IS NULL OR NOT (upper(p_action) = ANY(v_allowed)) THEN RAISE EXCEPTION 'Acción operativa no permitida'; END IF;
  SELECT d.driver_id, d.status INTO v_driver, v_status FROM public.dispatches d
  JOIN public.drivers r ON r.id = d.driver_id WHERE d.id = p_dispatch_id
    AND r.profile_id = auth.uid() AND r.is_active = true;
  IF v_driver IS NULL THEN RAISE EXCEPTION 'Despacho no asignado o inválido'; END IF;
  IF (p_lat IS NOT NULL AND (p_lat < -90 OR p_lat > 90)) OR
     (p_lon IS NOT NULL AND (p_lon < -180 OR p_lon > 180)) THEN RAISE EXCEPTION 'Ubicación inválida'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(auth.uid()::text || ':' || p_idempotency_key::text));
  SELECT * INTO v_proposal FROM public.ai_action_proposals
    WHERE idempotency_key = p_idempotency_key AND user_id = auth.uid();
  IF v_proposal.id IS NULL THEN
    INSERT INTO public.ai_action_proposals(user_id, action_type, payload, original_input,
      origin, latitude, longitude, device, idempotency_key)
    VALUES (auth.uid(), 'trip_action', jsonb_build_object('dispatch_id', p_dispatch_id,
      'action', upper(p_action), 'trip_status', v_status, 'data', coalesce(p_payload, '{}'::jsonb)),
      left(p_original_input, 1200), CASE WHEN p_origin IN ('manual','ai_voice','ai_chat','automatic_event')
      THEN p_origin ELSE 'ai_chat' END, p_lat, p_lon, coalesce(p_device, '{}'::jsonb), p_idempotency_key)
    RETURNING * INTO v_proposal;
  END IF;
  RETURN jsonb_build_object('id', v_proposal.id, 'action_type', v_proposal.action_type,
    'payload', v_proposal.payload, 'expires_at', v_proposal.expires_at, 'confirmation_required', true);
END $$;
REVOKE ALL ON FUNCTION public.ai_prepare_trip_action(uuid,text,jsonb,text,text,numeric,numeric,jsonb,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_prepare_trip_action(uuid,text,jsonb,text,text,numeric,numeric,jsonb,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.ai_confirm_trip_action(
  p_proposal_id uuid, p_confirmed_payload jsonb DEFAULT NULL,
  p_lat numeric DEFAULT NULL, p_lon numeric DEFAULT NULL,
  p_device jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_proposal public.ai_action_proposals; v_payload jsonb; v_data jsonb;
DECLARE v_dispatch uuid; v_driver uuid; v_plate text; v_action text; v_result jsonb; v_record uuid;
DECLARE v_lat numeric; v_lon numeric; v_device jsonb;
BEGIN
  SELECT * INTO v_proposal FROM public.ai_action_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF v_proposal.id IS NULL OR v_proposal.user_id <> auth.uid() THEN RAISE EXCEPTION 'Propuesta no encontrada'; END IF;
  IF v_proposal.status = 'confirmed' THEN RETURN v_proposal.result_ref; END IF;
  IF v_proposal.status <> 'proposed' OR v_proposal.expires_at <= now() OR v_proposal.action_type <> 'trip_action'
    THEN RAISE EXCEPTION 'Propuesta vencida o cancelada'; END IF;
  v_payload := coalesce(p_confirmed_payload, v_proposal.payload); v_dispatch := (v_payload->>'dispatch_id')::uuid;
  v_action := upper(v_payload->>'action'); v_data := coalesce(v_payload->'data', '{}'::jsonb);
  v_lat := coalesce(p_lat, v_proposal.latitude); v_lon := coalesce(p_lon, v_proposal.longitude);
  v_device := coalesce(nullif(p_device, '{}'::jsonb), v_proposal.device, '{}'::jsonb);
  IF (v_lat IS NOT NULL AND (v_lat < -90 OR v_lat > 90)) OR
     (v_lon IS NOT NULL AND (v_lon < -180 OR v_lon > 180)) THEN RAISE EXCEPTION 'Ubicación inválida'; END IF;
  SELECT d.driver_id, d.vehicle_plate INTO v_driver, v_plate FROM public.dispatches d
  JOIN public.drivers r ON r.id = d.driver_id WHERE d.id = v_dispatch
    AND r.profile_id = auth.uid() AND r.is_active = true FOR UPDATE OF d;
  IF v_driver IS NULL THEN RAISE EXCEPTION 'La asignación del viaje cambió'; END IF;
  IF v_action = 'CONFIRM_START' THEN
    IF v_lat IS NULL OR v_lon IS NULL THEN RAISE EXCEPTION 'Activa la ubicación para iniciar el viaje'; END IF;
    PERFORM public.start_dispatch_route(v_dispatch, v_lat, v_lon);
    v_result := jsonb_build_object('dispatch_id', v_dispatch, 'status', 'EN RUTA');
  ELSIF v_action = 'REQUEST_RETURN' THEN
    PERFORM public.request_dispatch_return(v_dispatch);
    v_result := jsonb_build_object('dispatch_id', v_dispatch, 'status', 'ESPERANDO_AUTORIZACION');
  ELSIF v_action = 'REGISTER_EXPENSE' THEN
    IF coalesce((v_data->>'amount')::numeric, 0) <= 0 THEN RAISE EXCEPTION 'El monto debe ser mayor que cero'; END IF;
    INSERT INTO public.dispatch_expenses(dispatch_id, driver_id, expense_type, amount, description,
      status, created_by, latitude, longitude, client_operation_id)
    VALUES(v_dispatch, v_driver, upper(coalesce(v_data->>'category','OTROS')), (v_data->>'amount')::numeric,
      coalesce(v_data->>'description','Gasto registrado con JRM IA'), 'PENDIENTE', auth.uid(),
      v_lat, v_lon, v_proposal.idempotency_key) RETURNING id INTO v_record;
    v_result := jsonb_build_object('dispatch_id', v_dispatch, 'expense_id', v_record, 'status', 'PENDIENTE');
  ELSIF v_action = 'REPORT_FAILURE' THEN
    INSERT INTO public.vehicle_maintenance_records(vehicle_plate, record_type, status, description,
      reported_by, driver_id, dispatch_id, failure_category, severity, can_continue,
      latitude, longitude, client_operation_id)
    VALUES(v_plate, 'FALLA_REPORTADA', 'PENDIENTE', coalesce(nullif(v_data->>'description',''),'Falla reportada'),
      auth.uid(), v_driver, v_dispatch, upper(coalesce(v_data->>'category','OTRO')),
      upper(coalesce(v_data->>'severity','MEDIA')), CASE WHEN v_data ? 'can_continue'
      THEN (v_data->>'can_continue')::boolean ELSE NULL END, v_lat,
      v_lon, v_proposal.idempotency_key) RETURNING id INTO v_record;
    v_result := jsonb_build_object('dispatch_id', v_dispatch, 'maintenance_record_id', v_record, 'status', 'PENDIENTE');
  ELSE
    INSERT INTO public.dispatch_events(dispatch_id, event_type, description, created_by,
      user_id, origin, payload, latitude, longitude, device, idempotency_key)
    VALUES(v_dispatch, v_action, nullif(v_data->>'description',''), auth.uid()::text,
      auth.uid(), v_proposal.origin, v_data, v_lat, v_lon,
      v_device, v_proposal.idempotency_key);
    v_result := jsonb_build_object('dispatch_id', v_dispatch, 'event', v_action, 'status', 'REGISTRADO');
  END IF;
  UPDATE public.ai_action_proposals SET status = 'confirmed', confirmed_by = auth.uid(),
    confirmed_at = now(), confirmed_payload = v_payload, result_ref = v_result,
    latitude = v_lat, longitude = v_lon, device = v_device WHERE id = v_proposal.id;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.ai_confirm_trip_action(uuid,jsonb,numeric,numeric,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_confirm_trip_action(uuid,jsonb,numeric,numeric,jsonb) TO authenticated;

COMMIT;
