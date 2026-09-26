-- ============================================================
-- Migration: 20260923203000_forensic_audit_fixes.sql
-- Description: Soluciona problemas de Idempotencia real, RLS Multi-tenant, 
-- bloqueos en CMMS (estado de vehiculos) y prevención de deadlocks en despachos.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. IDEMPOTENCIA REAL EN GASTOS DE COMBUSTIBLE
-- ------------------------------------------------------------
ALTER TABLE public.dispatch_expenses 
ADD COLUMN IF NOT EXISTS client_operation_id uuid;

-- Dropping in case it exists to recreate safely
ALTER TABLE public.dispatch_expenses DROP CONSTRAINT IF EXISTS uq_client_operation_id;
ALTER TABLE public.dispatch_expenses ADD CONSTRAINT uq_client_operation_id UNIQUE (client_operation_id);

-- Actualizar el RPC para usar ON CONFLICT en vez de SELECT previo
DROP FUNCTION IF EXISTS public.register_fuel_expense(uuid, uuid, numeric, numeric, numeric, text, text, uuid);
DROP FUNCTION IF EXISTS public.register_fuel_expense(uuid, uuid, numeric, numeric, numeric, text, text);

CREATE OR REPLACE FUNCTION public.register_fuel_expense(
    p_dispatch_id uuid,
    p_driver_id uuid,
    p_amount numeric,
    p_gallons numeric,
    p_odometer numeric,
    p_receipt_url text,
    p_description text,
    p_client_operation_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_vehicle_id uuid;
    v_plate text;
    v_current_odometer numeric;
    v_expense_id uuid;
    v_inserted_xmax text;
BEGIN
    -- a) Validaciones iniciales
    IF p_gallons <= 0 THEN
        RAISE EXCEPTION 'La cantidad de galones debe ser mayor a 0.';
    END IF;
    
    IF p_odometer < 0 THEN
        RAISE EXCEPTION 'El odómetro no puede ser negativo.';
    END IF;

    -- b) Obtener vehicle_id y plate desde public.dispatches
    SELECT vehicle_id INTO v_vehicle_id
    FROM public.dispatches
    WHERE id = p_dispatch_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Despacho con ID % no encontrado.', p_dispatch_id;
    END IF;

    -- Obtener odómetro actual del vehículo
    SELECT plate, current_odometer INTO v_plate, v_current_odometer
    FROM public.vehicles
    WHERE id = v_vehicle_id;

    -- c) Insertar en dispatch_expenses (UPSERT IDEMPOTENTE)
    INSERT INTO public.dispatch_expenses (
        dispatch_id, 
        driver_id, 
        expense_type, 
        amount, 
        description, 
        receipt_url, 
        fuel_gallons, 
        fuel_odometer,
        client_operation_id
    ) VALUES (
        p_dispatch_id, 
        p_driver_id, 
        'COMBUSTIBLE', 
        p_amount, 
        p_description, 
        p_receipt_url, 
        p_gallons, 
        p_odometer,
        p_client_operation_id
    )
    ON CONFLICT (client_operation_id) 
    DO UPDATE SET updated_at = NOW()
    RETURNING id, xmax::text INTO v_expense_id, v_inserted_xmax;

    -- Si fue una inserción nueva (xmax = '0') entonces registrar odómetro
    IF v_inserted_xmax = '0' THEN
        -- d) Registrar el nuevo odómetro en la fuente de verdad (vehicle_odometer_logs)
        INSERT INTO public.vehicle_odometer_logs (
            vehicle_id, 
            dispatch_id, 
            driver_id, 
            odometer_value, 
            source_event
        ) VALUES (
            v_vehicle_id, 
            p_dispatch_id, 
            p_driver_id, 
            p_odometer, 
            'COMBUSTIBLE'
        );

        -- e) Actualizar vehicles.current_odometer si el nuevo valor es mayor o igual
        IF v_current_odometer IS NULL OR p_odometer >= v_current_odometer THEN
            UPDATE public.vehicles
            SET current_odometer = p_odometer,
                updated_at = now()
            WHERE id = v_vehicle_id;
        END IF;
    END IF;

    RETURN v_expense_id;
END;
$$;

REVOKE ALL ON FUNCTION public.register_fuel_expense(uuid, uuid, numeric, numeric, numeric, text, text, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.register_fuel_expense(uuid, uuid, numeric, numeric, numeric, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.register_fuel_expense(uuid, uuid, numeric, numeric, numeric, text, text, uuid) TO service_role;


-- ------------------------------------------------------------
-- 2. RLS MULTI-TENANT REAL (ELIMINAR POLÍTICAS PELIGROSAS)
-- ------------------------------------------------------------

-- Limpiar transport_budgets
DROP POLICY IF EXISTS "Allow all anon on transport_budgets" ON public.transport_budgets;
DROP POLICY IF EXISTS "Allow all authenticated on transport_budgets" ON public.transport_budgets;

CREATE POLICY "transport_budgets_read_secure" ON public.transport_budgets FOR SELECT TO authenticated
USING (public.has_tms_permission('despacho') OR public.has_tms_permission('clientes') OR public.has_tms_permission('facturacion'));

CREATE POLICY "transport_budgets_write_secure" ON public.transport_budgets FOR ALL TO authenticated
USING (public.has_tms_permission('clientes') OR public.has_tms_permission('facturacion')) 
WITH CHECK (public.has_tms_permission('clientes') OR public.has_tms_permission('facturacion'));


-- Limpiar clients
DROP POLICY IF EXISTS "Allow all anon on clients" ON public.clients;
DROP POLICY IF EXISTS "Allow all authenticated on clients" ON public.clients;
DROP POLICY IF EXISTS "clients_read" ON public.clients;
DROP POLICY IF EXISTS "clients_write" ON public.clients;

CREATE POLICY "clients_read_secure" ON public.clients FOR SELECT TO authenticated
USING (public.has_tms_permission('clientes') OR public.has_tms_permission('despacho') OR public.has_tms_permission('solicitudes'));

CREATE POLICY "clients_write_secure" ON public.clients FOR ALL TO authenticated
USING (public.has_tms_permission('clientes')) 
WITH CHECK (public.has_tms_permission('clientes'));


-- Limpiar vehicle_maintenance_records
DROP POLICY IF EXISTS "Allow all anon on vehicle_maintenance_records" ON public.vehicle_maintenance_records;
DROP POLICY IF EXISTS "Allow all authenticated on vehicle_maintenance_records" ON public.vehicle_maintenance_records;
DROP POLICY IF EXISTS "maintenance_records_own_read" ON public.vehicle_maintenance_records;
DROP POLICY IF EXISTS "maintenance_records_own_insert" ON public.vehicle_maintenance_records;
DROP POLICY IF EXISTS "maintenance_records_staff_update" ON public.vehicle_maintenance_records;

CREATE POLICY "maintenance_records_read_secure" ON public.vehicle_maintenance_records FOR SELECT TO authenticated
USING (public.has_tms_permission('mantenimiento-flota') OR reported_by = auth.uid());

CREATE POLICY "maintenance_records_insert_secure" ON public.vehicle_maintenance_records FOR INSERT TO authenticated
WITH CHECK (public.has_tms_permission('mantenimiento-flota') OR reported_by = auth.uid());

CREATE POLICY "maintenance_records_update_secure" ON public.vehicle_maintenance_records FOR UPDATE TO authenticated
USING (public.has_tms_permission('mantenimiento-flota') OR reported_by = auth.uid())
WITH CHECK (public.has_tms_permission('mantenimiento-flota') OR reported_by = auth.uid());


-- ------------------------------------------------------------
-- 3. BLOQUEO CMMS: transition_vehicle_status
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transition_vehicle_status(
    p_vehicle_plate text, 
    p_new_status text, 
    p_reason text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
    v_current_status text;
    v_valid_transition boolean := false;
    v_open_mo_count int;
    v_eligibility jsonb;
BEGIN
    SELECT status INTO v_current_status
    FROM public.vehicles
    WHERE plate = p_vehicle_plate;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Vehicle not found');
    END IF;

    -- Validate transition
    IF v_current_status = 'DISPONIBLE' AND p_new_status IN ('ASIGNADA', 'MANTENIMIENTO', 'BLOQUEADA', 'FUERA_DE_SERVICIO', 'OBSERVADA') THEN
        v_valid_transition := true;
    ELSIF v_current_status = 'ASIGNADA' AND p_new_status IN ('EN_RUTA', 'DISPONIBLE', 'MANTENIMIENTO', 'BLOQUEADA') THEN
        v_valid_transition := true;
    ELSIF v_current_status = 'EN_RUTA' AND p_new_status IN ('ASIGNADA', 'DISPONIBLE', 'MANTENIMIENTO', 'BLOQUEADA') THEN
        v_valid_transition := true;
    ELSIF v_current_status = 'OBSERVADA' AND p_new_status IN ('DISPONIBLE', 'MANTENIMIENTO', 'BLOQUEADA', 'FUERA_DE_SERVICIO') THEN
        v_valid_transition := true;
    ELSIF v_current_status = 'MANTENIMIENTO' AND p_new_status IN ('DISPONIBLE', 'OBSERVADA', 'FUERA_DE_SERVICIO') THEN
        -- check for open MO
        SELECT count(*) INTO v_open_mo_count
        FROM public.maintenance_orders
        WHERE vehicle_plate = p_vehicle_plate AND status NOT IN ('FINALIZADA', 'COMPLETADO', 'CANCELADO');
        IF v_open_mo_count > 0 AND p_new_status = 'DISPONIBLE' THEN
             RETURN jsonb_build_object('success', false, 'error', 'Cannot transition to DISPONIBLE with open maintenance orders');
        END IF;
        v_valid_transition := true;
    ELSIF v_current_status = 'BLOQUEADA' AND p_new_status = 'DISPONIBLE' THEN
        v_valid_transition := true;
    ELSIF v_current_status = 'FUERA_DE_SERVICIO' AND p_new_status = 'DISPONIBLE' THEN
        v_valid_transition := true;
    END IF;

    IF NOT v_valid_transition THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid transition from ' || v_current_status || ' to ' || p_new_status);
    END IF;

    -- BLOQUEO CMMS: Verificar elegibilidad al pasar a DISPONIBLE
    IF p_new_status = 'DISPONIBLE' THEN
        v_eligibility := public.check_vehicle_eligibility(p_vehicle_plate, 0);
        IF NOT (v_eligibility->>'eligible')::boolean THEN
            -- Throw an error so the transaction is aborted
            RAISE EXCEPTION 'Vehiculo no elegible para DISPONIBLE: %', COALESCE(v_eligibility->>'reason', 'Checks fallidos');
        END IF;
    END IF;

    UPDATE public.vehicles
    SET status = p_new_status
    WHERE plate = p_vehicle_plate;

    -- Attempt to insert history si existe status_history
    BEGIN
        INSERT INTO public.vehicle_status_history (vehicle_plate, previous_status, new_status, reason, changed_by)
        VALUES (p_vehicle_plate, v_current_status, p_new_status, p_reason, auth.uid());
    EXCEPTION WHEN undefined_table THEN
        -- Do nothing if table doesn't exist
    END;

    RETURN jsonb_build_object('success', true, 'new_status', p_new_status);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.transition_vehicle_status(text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.transition_vehicle_status(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transition_vehicle_status(text, text, text) TO service_role;


-- ------------------------------------------------------------
-- 4. PREVENCIÓN DE DEADLOCKS: schedule_dispatch
-- ------------------------------------------------------------
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

  -- 4. PREVENCIÓN DE DEADLOCKS: Bloqueo pre-ordenado de items
  FOR v_request_id IN (
      SELECT (value->>'id')::uuid AS req_id
      FROM jsonb_array_elements(p_requests)
      ORDER BY req_id
  ) LOOP
      PERFORM 1 FROM public.transport_requests
      WHERE id = v_request_id AND status IN ('APROBADA','REPROGRAMADA') FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Solicitud no aprobada, ya asignada o inexistente'; END IF;
  END LOOP;

  -- Bucle de inserción normal
  FOR v_request IN SELECT value FROM jsonb_array_elements(p_requests)
  LOOP
    v_order := v_order + 1;
    v_request_id := (v_request->>'id')::uuid;
    
    -- Verificamos contrato
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
GRANT EXECUTE ON FUNCTION public.schedule_dispatch(uuid,text,timestamptz,numeric,numeric,uuid,text,jsonb) TO service_role;

COMMIT;
