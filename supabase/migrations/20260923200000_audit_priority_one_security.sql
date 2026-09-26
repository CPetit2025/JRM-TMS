BEGIN;

-- 1. Revocar y eliminar políticas inseguras
REVOKE ALL ON public.work_orders FROM anon;
REVOKE ALL ON public.clients FROM anon;
REVOKE ALL ON public.transport_budgets FROM anon;
REVOKE ALL ON public.budget_extensions FROM anon;
REVOKE ALL ON public.work_order_items FROM anon;

DROP POLICY IF EXISTS "Allow all anon on work orders" ON public.work_orders;
DROP POLICY IF EXISTS "Allow all anon on clients" ON public.clients;
DROP POLICY IF EXISTS "Allow all anon on transport_budgets" ON public.transport_budgets;
DROP POLICY IF EXISTS "Allow all anon on budget_extensions" ON public.budget_extensions;
DROP POLICY IF EXISTS "Allow all anon on work_order_items" ON public.work_order_items;

-- 2. Asegurar que transition_vehicle_status verifica la tabla correcta
CREATE OR REPLACE FUNCTION public.transition_vehicle_status(
  p_vehicle_plate text,
  p_new_status    text,
  p_reason        text     DEFAULT NULL,
  p_user_id       uuid     DEFAULT NULL,
  p_metadata      jsonb    DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_current_status  text;
  v_open_mo_count   int := 0;
  v_is_admin        boolean;
  v_is_driver       boolean;
  v_valid_transition boolean := false;
BEGIN
  -- Resolve permissions
  v_is_admin  := has_tms_permission('admin') OR has_tms_permission('mantenimiento') OR has_tms_permission('despacho');
  v_is_driver := EXISTS (SELECT 1 FROM public.drivers WHERE user_id = auth.uid());

  -- Permission guards
  IF p_new_status = 'DISPONIBLE' AND NOT v_is_admin THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient permissions to release vehicle');
  END IF;

  IF p_new_status = 'FUERA_DE_SERVICIO' AND NOT has_tms_permission('admin') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only admins can decommission vehicles');
  END IF;

  IF v_is_driver AND NOT v_is_admin AND p_new_status NOT IN ('BLOQUEADA', 'OBSERVADA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Drivers can only report faults (BLOQUEADA/OBSERVADA)');
  END IF;

  -- Get current status
  SELECT status INTO v_current_status
  FROM public.vehicles
  WHERE plate = p_vehicle_plate;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehicle not found: ' || p_vehicle_plate);
  END IF;

  -- Validate transition matrix
  IF v_current_status = 'DISPONIBLE'    AND p_new_status IN ('ASIGNADA','MANTENIMIENTO','BLOQUEADA','FUERA_DE_SERVICIO','OBSERVADA') THEN v_valid_transition := true;
  ELSIF v_current_status = 'ASIGNADA'   AND p_new_status IN ('EN_RUTA','DISPONIBLE','MANTENIMIENTO','BLOQUEADA') THEN v_valid_transition := true;
  ELSIF v_current_status = 'EN_RUTA'    AND p_new_status IN ('ASIGNADA','DISPONIBLE','MANTENIMIENTO','BLOQUEADA') THEN v_valid_transition := true;
  ELSIF v_current_status = 'OBSERVADA'  AND p_new_status IN ('DISPONIBLE','MANTENIMIENTO','BLOQUEADA','FUERA_DE_SERVICIO') THEN v_valid_transition := true;
  ELSIF v_current_status = 'MANTENIMIENTO' AND p_new_status IN ('DISPONIBLE','OBSERVADA','FUERA_DE_SERVICIO') THEN v_valid_transition := true;
  ELSIF v_current_status = 'BLOQUEADA'  AND p_new_status = 'DISPONIBLE' THEN v_valid_transition := true;
  ELSIF v_current_status = 'FUERA_DE_SERVICIO' AND p_new_status = 'DISPONIBLE' THEN v_valid_transition := true;
  END IF;

  IF NOT v_valid_transition THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Invalid transition: ' || v_current_status || ' -> ' || p_new_status);
  END IF;

  -- Use correct table `maintenance_work_orders` with column `vehicle_plate`
  IF p_new_status = 'DISPONIBLE' THEN
    SELECT count(*) INTO v_open_mo_count
    FROM public.maintenance_work_orders
    WHERE vehicle_plate = p_vehicle_plate
      AND status NOT IN ('COMPLETADO', 'CANCELADO', 'FINALIZADO', 'FINALIZADA');

    IF v_open_mo_count > 0 THEN
      RETURN jsonb_build_object('success', false, 'error',
        'Cannot release vehicle: ' || v_open_mo_count || ' open work order(s) remain');
    END IF;
  END IF;

  -- Execute state change
  UPDATE public.vehicles
  SET status     = p_new_status,
      updated_at = NOW()
  WHERE plate = p_vehicle_plate;

  -- Audit log
  BEGIN
    INSERT INTO public.vehicle_maintenance_history (
      vehicle_plate, previous_status, new_status, reason, created_by, created_at
    ) VALUES (
      p_vehicle_plate, v_current_status, p_new_status,
      COALESCE(p_reason, 'Transición de estado'),
      COALESCE(p_user_id, auth.uid()),
      NOW()
    );
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    NULL; -- Table not yet created in this env; non-fatal
  END;

  RETURN jsonb_build_object(
    'success',         true,
    'previous_status', v_current_status,
    'new_status',      p_new_status,
    'reason',          p_reason
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.transition_vehicle_status(text, text, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transition_vehicle_status(text, text, text, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transition_vehicle_status(text, text, text, uuid, jsonb) TO service_role;

-- 3-arg overload from the original migration
CREATE OR REPLACE FUNCTION public.transition_vehicle_status(
  p_vehicle_plate text,
  p_new_status    text,
  p_reason        text DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public
AS $$
  SELECT public.transition_vehicle_status(p_vehicle_plate, p_new_status, p_reason, auth.uid(), '{}'::jsonb);
$$;

REVOKE ALL ON FUNCTION public.transition_vehicle_status(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transition_vehicle_status(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transition_vehicle_status(text, text, text) TO service_role;

-- 3. Modificar schedule_dispatch para llamar a check_vehicle_eligibility
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
DECLARE v_eligibility jsonb;
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
    
    -- Check eligibility (Fix NULL evaluation vulnerability)
    v_eligibility := public.check_vehicle_eligibility(p_vehicle_plate, 0);
    IF (v_eligibility->>'eligible')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'Vehículo no apto para despacho: %', v_eligibility;
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

COMMIT;
