-- ============================================================
-- FASE 10: GESTIÓN DE TALLERES Y PROVEEDORES
-- ============================================================

-- 1. Añadir columnas de SLA a maintenance_providers
ALTER TABLE public.maintenance_providers
ADD COLUMN IF NOT EXISTS sla_rating DECIMAL(5,2) DEFAULT 100.00,
ADD COLUMN IF NOT EXISTS avg_response_time_hours DECIMAL(10,2) DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS provider_status VARCHAR(20) DEFAULT 'ACTIVO'; -- Renombrado para no colisionar con is_active o usarlo para categorizacion (e.g., ACTIVO, SUSPENDIDO)

-- Si la tabla original usaba "rating" podemos seguir usando sla_rating.

-- 2. Añadir provider_id a maintenance_work_orders si no existe
ALTER TABLE public.maintenance_work_orders
ADD COLUMN IF NOT EXISTS provider_id UUID REFERENCES public.maintenance_providers(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS provider_evaluation_score INTEGER,
ADD COLUMN IF NOT EXISTS provider_evaluation_notes TEXT;

-- 3. Crear Trigger para recalcular SLA automáticamente
CREATE OR REPLACE FUNCTION public.trg_recalculate_provider_sla()
RETURNS TRIGGER AS $$
DECLARE
    v_avg_hours NUMERIC;
    v_total_completed INTEGER;
    v_sla_rating NUMERIC;
BEGIN
    -- Ejecutar solo cuando una OT asignada a un proveedor pasa a estado 'CERRADA' o 'TERMINADA'
    IF NEW.provider_id IS NOT NULL AND NEW.status IN ('CERRADA', 'TERMINADA') AND (OLD.status NOT IN ('CERRADA', 'TERMINADA') OR OLD.status IS NULL) THEN
        
        -- Calcular promedios basados en las OT de ese proveedor
        SELECT 
            COUNT(*),
            AVG(EXTRACT(EPOCH FROM (COALESCE(NEW.actual_end_date, NOW()) - COALESCE(start_date, created_at))) / 3600.0)
        INTO 
            v_total_completed,
            v_avg_hours
        FROM public.maintenance_work_orders
        WHERE provider_id = NEW.provider_id
          AND status IN ('CERRADA', 'TERMINADA');

        -- Lógica de calificación SLA (0 a 100).
        -- Ejemplo simple: Si tarda < 24h = 100, < 48h = 90, < 72h = 80, < 120h = 60, mas = 40.
        IF v_avg_hours <= 24 THEN
            v_sla_rating := 100;
        ELSIF v_avg_hours <= 48 THEN
            v_sla_rating := 90;
        ELSIF v_avg_hours <= 72 THEN
            v_sla_rating := 80;
        ELSIF v_avg_hours <= 120 THEN
            v_sla_rating := 60;
        ELSE
            v_sla_rating := 40;
        END IF;

        UPDATE public.maintenance_providers
        SET 
            avg_response_time_hours = ROUND(v_avg_hours::numeric, 2),
            sla_rating = ROUND(v_sla_rating::numeric, 2)
        WHERE id = NEW.provider_id;
        
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_recalculate_provider_sla ON public.maintenance_work_orders;
CREATE TRIGGER trigger_recalculate_provider_sla
AFTER UPDATE ON public.maintenance_work_orders
FOR EACH ROW
EXECUTE FUNCTION public.trg_recalculate_provider_sla();

-- 4. Actualizar complete_maintenance_order para asegurar que setea actual_end_date
CREATE OR REPLACE FUNCTION public.complete_maintenance_order(
    p_order_id UUID,
    p_used_parts JSONB,
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
    v_eligibility jsonb;
BEGIN
    SELECT * INTO v_order 
    FROM public.maintenance_work_orders 
    WHERE id = p_order_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Orden de trabajo no encontrada');
    END IF;

    IF v_order.status IN ('CERRADA', 'TERMINADA') THEN
        RETURN jsonb_build_object('success', false, 'error', 'La orden de trabajo ya esta cerrada o terminada');
    END IF;

    UPDATE public.maintenance_work_orders
    SET 
        status = 'CERRADA',
        actual_end_date = COALESCE(actual_end_date, NOW()),
        diagnosis = COALESCE(diagnosis, '') || CHR(10) || 'Notas de Cierre: ' || COALESCE(p_closing_notes, '')
    WHERE id = p_order_id;

    IF p_used_parts IS NOT NULL AND jsonb_array_length(p_used_parts) > 0 THEN
        FOR v_part IN SELECT * FROM jsonb_array_elements(p_used_parts)
        LOOP
            v_part_id := (v_part->>'part_id')::UUID;
            v_qty := (v_part->>'quantity')::INTEGER;
            
            IF v_part_id IS NOT NULL AND v_qty > 0 THEN
                INSERT INTO public.inventory_transactions (part_id, quantity, transaction_type, reference_id, date)
                VALUES (v_part_id, v_qty, 'OUT', p_order_id, NOW());
                
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

    IF v_order.plan_id IS NOT NULL THEN
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

    v_eligibility := public.check_asset_eligibility(v_order.vehicle_plate);
    IF v_eligibility->>'status' = 'APTO' THEN
        v_transition_result := public.transition_vehicle_status(
            v_order.vehicle_plate, 
            'DISPONIBLE', 
            'Mantenimiento finalizado por OT: ' || COALESCE(v_order.ot_number, '')
        );
        
        IF NOT (v_transition_result->>'success')::boolean THEN
            RETURN jsonb_build_object(
                'success', true, 
                'message', 'Orden de mantenimiento cerrada exitosamente, pero no se pudo liberar vehiculo.',
                'vehicle_transition', v_transition_result
            );
        END IF;
    ELSE
        RETURN jsonb_build_object(
            'success', true, 
            'message', 'Orden cerrada. Vehiculo sigue ' || (v_eligibility->>'status') || ' por otros motivos.',
            'eligibility', v_eligibility
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true, 
        'message', 'Orden de mantenimiento completada exitosamente. Vehiculo liberado.',
        'vehicle_transition', v_transition_result
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.complete_maintenance_order(UUID, JSONB, TEXT) TO authenticated, service_role;
