-- ============================================================
-- 20260923201000_audit_priority_two_business.sql
-- PRIORIDAD 2: Finanzas y Lógica
-- 1. Idempotencia en register_fuel_expense
-- 2. Filtro de tipos de contrato en ensure_transport_budget
-- 3. Inserción de work_order_costs al completar OTs de mantenimiento
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. register_fuel_expense
-- ------------------------------------------------------------
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
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_vehicle_id uuid;
    v_plate text;
    v_current_odometer numeric;
BEGIN
    -- a.0) Validar idempotencia (evitar duplicados con el mismo client_operation_id)
    IF p_client_operation_id IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM public.dispatch_expenses WHERE client_operation_id = p_client_operation_id) THEN
            RAISE NOTICE 'Gasto de combustible ya registrado (idempotency_key: %)', p_client_operation_id;
            RETURN;
        END IF;
    END IF;

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

    -- c) Insertar en dispatch_expenses
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
    );

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
END;
$$;

REVOKE ALL ON FUNCTION public.register_fuel_expense(uuid, uuid, numeric, numeric, numeric, text, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.register_fuel_expense(uuid, uuid, numeric, numeric, numeric, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.register_fuel_expense(uuid, uuid, numeric, numeric, numeric, text, text, uuid) TO service_role;


-- ------------------------------------------------------------
-- 2. ensure_transport_budget
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_transport_budget()
RETURNS TRIGGER AS $$
BEGIN
    -- Automatically create a budget entry for the contract if it doesn't exist
    -- Se omite la creación si es 'SUBCONTRATO' o 'ERROR'
    IF NEW.type::text NOT IN ('SUBCONTRATO', 'ERROR') THEN
        INSERT INTO public.contract_budgets (contract_id, concept, allocated_usd, allocated_pen)
        VALUES (NEW.id, 'PARTIDA_TRANSPORTE', 0, 0)
        ON CONFLICT (contract_id, concept) DO NOTHING;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------
-- 3. complete_maintenance_order
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_maintenance_order(
    p_order_id UUID,
    p_used_parts JSONB, -- Formato esperado: [{"part_id": "uuid", "quantity": 1}]
    p_closing_notes TEXT
)
RETURNS jsonb AS $$
DECLARE
    v_order RECORD;
    v_part JSONB;
    v_part_id UUID;
    v_qty INTEGER;
    v_transition_result JSONB;
    v_current_odometer NUMERIC(10,2);
    v_unit_price DECIMAL(10,2);
    v_part_name TEXT;
BEGIN
    -- Obtener la OT y verificar que existe y no está completada
    SELECT * INTO v_order 
    FROM public.maintenance_work_orders 
    WHERE id = p_order_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Orden de trabajo no encontrada');
    END IF;

    IF v_order.status IN ('COMPLETADO', 'FINALIZADO') THEN
        RETURN jsonb_build_object('success', false, 'error', 'La orden de trabajo ya está completada');
    END IF;

    -- a) Mover la OT a estado COMPLETADO
    UPDATE public.maintenance_work_orders
    SET 
        status = 'COMPLETADO',
        actual_end_date = NOW(),
        diagnostic = COALESCE(diagnostic, '') || CHR(10) || 'Notas de Cierre: ' || COALESCE(p_closing_notes, '')
    WHERE id = p_order_id;

    -- b) Para cada repuesto en p_used_parts, inserta en inventory_transactions y work_order_costs
    IF p_used_parts IS NOT NULL AND jsonb_array_length(p_used_parts) > 0 THEN
        FOR v_part IN SELECT * FROM jsonb_array_elements(p_used_parts)
        LOOP
            v_part_id := (v_part->>'part_id')::UUID;
            v_qty := (v_part->>'quantity')::INTEGER;
            
            IF v_part_id IS NOT NULL AND v_qty > 0 THEN
                -- Descontar del inventario (kardex)
                INSERT INTO public.inventory_transactions (part_id, quantity, transaction_type, reference_id, date)
                VALUES (v_part_id, v_qty, 'OUT', p_order_id, NOW());
                
                -- Conectar repuesto con el TCO (costos de la OT)
                SELECT name, COALESCE(unit_price, 0) INTO v_part_name, v_unit_price
                FROM public.spare_parts
                WHERE id = v_part_id;

                INSERT INTO public.work_order_costs (
                    work_order_id,
                    cost_type,
                    amount,
                    description
                ) VALUES (
                    p_order_id,
                    'REPUESTOS',
                    v_qty * v_unit_price,
                    'Repuesto consumido: ' || v_part_name || ' (Cant: ' || v_qty || ')'
                );
            END IF;
        END LOOP;
    END IF;

    -- c) Invoca transition_vehicle_status
    v_transition_result := public.transition_vehicle_status(
        v_order.vehicle_plate, 
        'DISPONIBLE', 
        'Mantenimiento finalizado por OT: ' || v_order.ot_number
    );

    IF NOT (v_transition_result->>'success')::boolean THEN
        RAISE NOTICE 'El vehículo % no se pudo liberar a DISPONIBLE: %', v_order.vehicle_plate, v_transition_result->>'error';
    END IF;

    -- d) Actualiza las fechas de próximo preventivo si la OT era de tipo preventivo (plan_id no nulo)
    IF v_order.plan_id IS NOT NULL THEN
        -- Obtener el odómetro actual
        SELECT COALESCE(current_odometer, 0) INTO v_current_odometer
        FROM public.vehicles
        WHERE plate = v_order.vehicle_plate;

        UPDATE public.maintenance_plans
        SET 
            last_performed_date = CURRENT_DATE,
            last_performed_km = v_current_odometer,
            last_performed_odometer = v_current_odometer
        WHERE id = v_order.plan_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true, 
        'message', 'Orden de mantenimiento completada exitosamente',
        'vehicle_transition', v_transition_result
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.complete_maintenance_order(UUID, JSONB, TEXT) FROM public;
GRANT EXECUTE ON FUNCTION public.complete_maintenance_order(UUID, JSONB, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_maintenance_order(UUID, JSONB, TEXT) TO service_role;

-- Refrescar cache del schema
NOTIFY pgrst, 'reload schema';

COMMIT;
