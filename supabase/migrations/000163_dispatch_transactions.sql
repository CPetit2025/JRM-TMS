BEGIN;

ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS gps_coverage_complete boolean;

-- Keep direct writes to operational and financial tables with authorized staff.
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT schemaname, tablename, policyname FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('dispatches','dispatch_requests','transport_requests',
        'vehicles','contract_budgets','contract_services')
      AND roles @> ARRAY['authenticated']::name[]
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
  END LOOP;
END $$;
ALTER TABLE public.dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transport_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY dispatch_read ON public.dispatches FOR SELECT TO authenticated
  USING (public.has_tms_permission('despacho') OR EXISTS (
    SELECT 1 FROM public.drivers d WHERE d.id = driver_id AND d.profile_id = auth.uid()));
CREATE POLICY dispatch_staff_write ON public.dispatches FOR ALL TO authenticated
  USING (public.has_tms_permission('despacho')) WITH CHECK (public.has_tms_permission('despacho'));
CREATE POLICY dispatch_request_read ON public.dispatch_requests FOR SELECT TO authenticated
  USING (public.has_tms_permission('despacho') OR EXISTS (
    SELECT 1 FROM public.dispatches s WHERE s.id = dispatch_id AND s.driver_id IN (
      SELECT id FROM public.drivers WHERE profile_id = auth.uid())));
CREATE POLICY dispatch_request_staff_write ON public.dispatch_requests FOR ALL TO authenticated
  USING (public.has_tms_permission('despacho')) WITH CHECK (public.has_tms_permission('despacho'));
CREATE POLICY transport_request_read ON public.transport_requests FOR SELECT TO authenticated
  USING (public.has_tms_permission('solicitudes') OR public.has_tms_permission('despacho')
    OR EXISTS (SELECT 1 FROM public.dispatch_requests r JOIN public.dispatches s ON s.id = r.dispatch_id
      JOIN public.drivers d ON d.id = s.driver_id
      WHERE r.transport_request_id = transport_requests.id AND d.profile_id = auth.uid()));
CREATE POLICY transport_request_staff_write ON public.transport_requests FOR ALL TO authenticated
  USING (public.has_tms_permission('solicitudes') OR public.has_tms_permission('despacho'))
  WITH CHECK (public.has_tms_permission('solicitudes') OR public.has_tms_permission('despacho'));
CREATE POLICY vehicles_read ON public.vehicles FOR SELECT TO authenticated
  USING (public.has_tms_permission('flota') OR public.has_tms_permission('despacho')
    OR public.has_tms_permission('mantenimiento-flota'));
CREATE POLICY vehicles_staff_write ON public.vehicles FOR ALL TO authenticated
  USING (public.has_tms_permission('flota') OR public.has_tms_permission('mantenimiento-flota'))
  WITH CHECK (public.has_tms_permission('flota') OR public.has_tms_permission('mantenimiento-flota'));
CREATE POLICY contract_budget_read ON public.contract_budgets FOR SELECT TO authenticated
  USING (public.has_tms_permission('dashboard') OR public.has_tms_permission('clientes')
    OR public.has_tms_permission('despacho'));
CREATE POLICY contract_budget_staff_write ON public.contract_budgets FOR ALL TO authenticated
  USING (public.has_tms_permission('clientes') OR public.has_tms_permission('despacho'))
  WITH CHECK (public.has_tms_permission('clientes') OR public.has_tms_permission('despacho'));
CREATE POLICY contract_service_staff ON public.contract_services FOR ALL TO authenticated
  USING (public.has_tms_permission('despacho') OR public.has_tms_permission('clientes'))
  WITH CHECK (public.has_tms_permission('despacho') OR public.has_tms_permission('clientes'));

-- A driver and vehicle cannot be assigned to two live routes concurrently.
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_one_active_driver ON public.dispatches(driver_id)
  WHERE driver_id IS NOT NULL AND status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO');
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_one_active_vehicle ON public.dispatches(vehicle_plate)
  WHERE vehicle_plate IS NOT NULL AND vehicle_plate <> 'EXTERNO'
    AND status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO');

CREATE OR REPLACE FUNCTION public.start_dispatch_route(p_dispatch_id uuid, p_lat numeric, p_lon numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_driver uuid;
BEGIN
  IF p_lat NOT BETWEEN -90 AND 90 OR p_lon NOT BETWEEN -180 AND 180 THEN
    RAISE EXCEPTION 'Coordenadas iniciales inválidas';
  END IF;
  SELECT driver_id INTO v_driver FROM public.dispatches
    WHERE id = p_dispatch_id AND status IN ('PROGRAMADO','EN_CURSO') FOR UPDATE;
  IF v_driver IS NULL OR NOT EXISTS (SELECT 1 FROM public.drivers
    WHERE id = v_driver AND profile_id = auth.uid() AND is_active = true) THEN
    RAISE EXCEPTION 'Ruta no autorizada';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.driver_checklists
    WHERE dispatch_id = p_dispatch_id AND driver_id = v_driver AND is_approved = true) THEN
    RAISE EXCEPTION 'Checklist aprobado requerido';
  END IF;
  UPDATE public.dispatches SET status = 'EN RUTA', start_lat = p_lat, start_lon = p_lon
    WHERE id = p_dispatch_id;
  UPDATE public.dispatch_requests SET status = 'EN_CURSO'
    WHERE dispatch_id = p_dispatch_id AND status = 'PROGRAMADO';
  UPDATE public.transport_requests SET status = 'EN TRANSITO'
    WHERE id IN (SELECT transport_request_id FROM public.dispatch_requests
      WHERE dispatch_id = p_dispatch_id AND status = 'EN_CURSO');
END $$;
REVOKE ALL ON FUNCTION public.start_dispatch_route(uuid,numeric,numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_dispatch_route(uuid,numeric,numeric) TO authenticated;

CREATE OR REPLACE FUNCTION public.request_dispatch_return(p_dispatch_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_driver uuid;
BEGIN
  SELECT driver_id INTO v_driver FROM public.dispatches
    WHERE id = p_dispatch_id AND status = 'EN RUTA' FOR UPDATE;
  IF v_driver IS NULL OR NOT EXISTS (SELECT 1 FROM public.drivers
    WHERE id = v_driver AND profile_id = auth.uid() AND is_active = true) THEN
    RAISE EXCEPTION 'Ruta no autorizada';
  END IF;
  IF EXISTS (SELECT 1 FROM public.dispatch_requests
    WHERE dispatch_id = p_dispatch_id AND status <> 'ENTREGADO') THEN
    RAISE EXCEPTION 'Aún hay paradas pendientes';
  END IF;
  UPDATE public.dispatches SET status = 'ESPERANDO_AUTORIZACION' WHERE id = p_dispatch_id;
END $$;
REVOKE ALL ON FUNCTION public.request_dispatch_return(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_dispatch_return(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.schedule_dispatch(
  p_driver_id uuid, p_vehicle_plate text, p_departure timestamptz,
  p_estimated_km numeric, p_freight_cost numeric, p_contract_id uuid,
  p_document_type text, p_requests jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_dispatch_id uuid;
DECLARE v_driver_name text;
DECLARE v_number text;
DECLARE v_budget public.contract_budgets%ROWTYPE;
DECLARE v_request jsonb;
DECLARE v_request_id uuid;
DECLARE v_order integer := 0;
BEGIN
  IF NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Sin permiso para programar despachos'; END IF;
  IF p_departure IS NULL OR p_document_type NOT IN ('GR','NOTA_SALIDA')
    OR p_requests IS NULL OR jsonb_typeof(p_requests) <> 'array' OR jsonb_array_length(p_requests) = 0
    OR coalesce(p_freight_cost, 0) < 0 THEN
    RAISE EXCEPTION 'Datos de programación incompletos';
  END IF;
  IF p_document_type <> 'NOTA_SALIDA' THEN
    SELECT trim(first_name || ' ' || last_name) INTO v_driver_name FROM public.drivers
    WHERE id = p_driver_id AND is_active = true AND profile_id IS NOT NULL;
    IF v_driver_name IS NULL OR p_vehicle_plate IS NULL OR p_vehicle_plate = '' THEN
      RAISE EXCEPTION 'Conductor o unidad no disponible';
    END IF;
  ELSE
    v_driver_name := 'CLIENTE';
    p_driver_id := NULL;
    p_vehicle_plate := 'EXTERNO';
  END IF;
  IF coalesce(p_freight_cost, 0) > 0 AND p_contract_id IS NOT NULL
    AND p_document_type <> 'NOTA_SALIDA' THEN
    SELECT * INTO v_budget FROM public.contract_budgets
    WHERE contract_id = p_contract_id AND concept = 'PARTIDA_TRANSPORTE' FOR UPDATE;
    IF v_budget.id IS NULL OR v_budget.balance_pen < p_freight_cost THEN
      RAISE EXCEPTION 'Presupuesto de transporte insuficiente';
    END IF;
    UPDATE public.contract_budgets SET reserved_pen = reserved_pen + p_freight_cost,
      updated_at = now() WHERE id = v_budget.id;
  END IF;
  v_number := 'DESP-' || to_char(now(), 'YYYYMMDD') || '-'
    || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  INSERT INTO public.dispatches(dispatch_number, driver_id, driver_name, vehicle_plate,
    scheduled_departure, status, estimated_distance_km, freight_cost, contract_id)
  VALUES(v_number, p_driver_id, v_driver_name, p_vehicle_plate,
    p_departure, 'PROGRAMADO', coalesce(p_estimated_km, 0), coalesce(p_freight_cost, 0), p_contract_id)
  RETURNING id INTO v_dispatch_id;

  FOR v_request IN SELECT value FROM jsonb_array_elements(p_requests)
  LOOP
    v_order := v_order + 1;
    v_request_id := (v_request->>'id')::uuid;
    PERFORM 1 FROM public.transport_requests
      WHERE id = v_request_id AND status IN ('APROBADA','REPROGRAMADA') FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Solicitud no aprobada o ya asignada'; END IF;
    IF p_contract_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.transport_requests
      WHERE id = v_request_id AND contract_id IS DISTINCT FROM p_contract_id) THEN
      RAISE EXCEPTION 'Las solicitudes deben pertenecer al mismo contrato';
    END IF;
    INSERT INTO public.dispatch_requests(dispatch_id, transport_request_id, status,
      document_type, document_number, leg_planned_km, sequence_order)
    VALUES(v_dispatch_id, v_request_id, 'PROGRAMADO', p_document_type,
      nullif(v_request->>'document_number', ''),
      nullif(v_request->>'leg_planned_km', '')::numeric, v_order);
    UPDATE public.transport_requests SET status = 'ASIGNADA' WHERE id = v_request_id;
  END LOOP;

  IF coalesce(p_freight_cost, 0) > 0 AND p_contract_id IS NOT NULL
    AND p_document_type <> 'NOTA_SALIDA' THEN
    INSERT INTO public.contract_services(contract_id, service_type, description,
      amount_pen, service_date, plate, driver_name, category, created_by, dispatch_id)
    VALUES(p_contract_id, 'FLETE', 'Flete del despacho ' || v_number,
      p_freight_cost, p_departure::date, p_vehicle_plate, v_driver_name,
      'Contrato', auth.uid(), v_dispatch_id);
  END IF;
  RETURN v_dispatch_id;
END $$;
REVOKE ALL ON FUNCTION public.schedule_dispatch(uuid,text,timestamptz,numeric,numeric,uuid,text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.schedule_dispatch(uuid,text,timestamptz,numeric,numeric,uuid,text,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.close_dispatch_route(p_dispatch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_dispatch public.dispatches%ROWTYPE;
DECLARE v_coverage boolean;
DECLARE v_mileage numeric;
BEGIN
  IF NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Sin permiso para cerrar despachos'; END IF;
  SELECT * INTO v_dispatch FROM public.dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF v_dispatch.id IS NULL THEN RAISE EXCEPTION 'Despacho inexistente'; END IF;
  IF v_dispatch.status = 'LIQUIDADO' THEN
    RETURN jsonb_build_object('actual_distance_km', v_dispatch.actual_distance_km,
      'gps_complete', v_dispatch.gps_coverage_complete);
  END IF;
  IF v_dispatch.status NOT IN ('EN RUTA','EN_CURSO','RETORNO','ESPERANDO_AUTORIZACION')
    OR EXISTS (SELECT 1 FROM public.dispatch_requests
      WHERE dispatch_id = p_dispatch_id AND status <> 'ENTREGADO') THEN
    RAISE EXCEPTION 'La ruta tiene paradas pendientes';
  END IF;
  SELECT count(*) > 0 AND bool_and(coalesce(leg_gps_complete, false))
    INTO v_coverage FROM public.dispatch_requests WHERE dispatch_id = p_dispatch_id;
  v_coverage := coalesce(v_coverage, false) AND NOT EXISTS (
    SELECT 1 FROM public.route_track_points WHERE dispatch_id = p_dispatch_id AND gap_detected);
  IF coalesce(v_dispatch.freight_cost, 0) > 0 AND v_dispatch.contract_id IS NOT NULL THEN
    UPDATE public.contract_budgets SET reserved_pen = reserved_pen - v_dispatch.freight_cost,
      consumed_pen = consumed_pen + v_dispatch.freight_cost, updated_at = now()
    WHERE contract_id = v_dispatch.contract_id AND concept = 'PARTIDA_TRANSPORTE'
      AND reserved_pen >= v_dispatch.freight_cost;
    IF NOT FOUND THEN RAISE EXCEPTION 'Reserva presupuestal inconsistente'; END IF;
  END IF;
  IF v_coverage AND coalesce(v_dispatch.actual_distance_km, 0) > 0
    AND v_dispatch.vehicle_plate IS NOT NULL AND v_dispatch.vehicle_plate <> 'EXTERNO' THEN
    UPDATE public.vehicles SET current_mileage = coalesce(current_mileage, 0) + v_dispatch.actual_distance_km
    WHERE plate = v_dispatch.vehicle_plate RETURNING current_mileage INTO v_mileage;
    IF v_mileage IS NOT NULL THEN
      INSERT INTO public.vehicle_maintenance_history(vehicle_id, action_type, description, mileage_at_time)
      SELECT id, 'KM_ACTUALIZADO', 'Ruta ' || v_dispatch.dispatch_number
        || ' (GPS: ' || v_dispatch.actual_distance_km || ' km)', v_mileage
      FROM public.vehicles WHERE plate = v_dispatch.vehicle_plate;
    END IF;
  END IF;
  UPDATE public.transport_requests SET status = 'ENTREGADA' WHERE id IN (
    SELECT transport_request_id FROM public.dispatch_requests WHERE dispatch_id = p_dispatch_id);
  UPDATE public.dispatches SET status = 'LIQUIDADO', gps_coverage_complete = v_coverage
    WHERE id = p_dispatch_id;
  RETURN jsonb_build_object('actual_distance_km', v_dispatch.actual_distance_km,
    'gps_complete', v_coverage);
END $$;
REVOKE ALL ON FUNCTION public.close_dispatch_route(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_dispatch_route(uuid) TO authenticated;

-- Obsolete financial RPCs allowed double charging or direct unvalidated changes.
REVOKE ALL ON FUNCTION public.reserve_transport_budget(uuid,numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.liquidate_transport_budget(uuid,numeric,numeric) FROM PUBLIC, anon, authenticated;
DO $$
DECLARE fn record;
BEGIN
  FOR fn IN SELECT oid::regprocedure AS signature FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'register_contract_service'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn.signature);
  END LOOP;
END $$;

COMMIT;
