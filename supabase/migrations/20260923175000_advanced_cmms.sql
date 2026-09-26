-- ============================================================
-- 20260923175000_advanced_cmms.sql
-- FASE 7 - CMMS AVANZADO: Migración SQL (Preventivos + Kardex + OT)
-- ============================================================

-- 1. Gestión de Preventivos
-- Agregar campos a maintenance_plans para mayor precisión
ALTER TABLE public.maintenance_plans 
ADD COLUMN IF NOT EXISTS last_performed_odometer NUMERIC(10,2),
ADD COLUMN IF NOT EXISTS next_due_odometer NUMERIC(10,2) GENERATED ALWAYS AS (last_performed_odometer + frequency_km) STORED;

-- Vista para conocer el estado actual de los preventivos vs el odómetro del vehículo
CREATE OR REPLACE VIEW public.vehicle_maintenance_status AS
SELECT 
    v.plate,
    v.current_odometer,
    mp.id AS plan_id,
    mp.name AS plan_name,
    mp.next_due_km,
    mp.next_due_odometer,
    mp.next_due_date,
    CASE 
        WHEN mp.next_due_odometer IS NOT NULL AND v.current_odometer >= mp.next_due_odometer THEN true
        WHEN mp.next_due_km IS NOT NULL AND v.current_odometer >= mp.next_due_km THEN true
        WHEN mp.next_due_date IS NOT NULL AND CURRENT_DATE >= mp.next_due_date THEN true
        ELSE false
    END as is_due
FROM public.vehicles v
JOIN public.maintenance_plans mp ON mp.vehicle_plate = v.plate
WHERE mp.is_active = true;

-- 2. Kardex de Inventario (Repuestos)
ALTER TABLE public.spare_parts
ADD COLUMN IF NOT EXISTS sku VARCHAR(50) UNIQUE,
ADD COLUMN IF NOT EXISTS unit_price DECIMAL(10,2);

-- Crear tabla explícita para transacciones de inventario solicitada
CREATE TABLE IF NOT EXISTS public.inventory_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    part_id UUID NOT NULL REFERENCES public.spare_parts(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL,
    transaction_type VARCHAR(10) NOT NULL CHECK (transaction_type IN ('IN', 'OUT')),
    reference_id UUID, -- Ej. OT id
    date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Habilitar RLS
ALTER TABLE public.inventory_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable all for authenticated on inventory_transactions" 
ON public.inventory_transactions FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Trigger para actualizar el current_stock en spare_parts basado en inventory_transactions
CREATE OR REPLACE FUNCTION public.update_stock_from_inventory_transaction()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.transaction_type = 'IN' THEN
        UPDATE public.spare_parts
        SET current_stock = current_stock + NEW.quantity
        WHERE id = NEW.part_id;
    ELSIF NEW.transaction_type = 'OUT' THEN
        UPDATE public.spare_parts
        SET current_stock = current_stock - NEW.quantity
        WHERE id = NEW.part_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_inventory_transaction_stock ON public.inventory_transactions;
CREATE TRIGGER trigger_inventory_transaction_stock
AFTER INSERT ON public.inventory_transactions
FOR EACH ROW
EXECUTE FUNCTION public.update_stock_from_inventory_transaction();

-- Eliminar el viejo trigger problemático que no usa la máquina de estados
DROP TRIGGER IF EXISTS trigger_vehicle_status_maintenance ON public.maintenance_work_orders;
-- Eliminamos también la función antigua por limpieza
DROP FUNCTION IF EXISTS public.update_vehicle_status_from_ot();

-- 3. Cierre de Orden de Trabajo (OT) y Liberación de Vehículo
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

    -- b) Para cada repuesto en p_used_parts, inserta en inventory_transactions
    IF p_used_parts IS NOT NULL AND jsonb_array_length(p_used_parts) > 0 THEN
        FOR v_part IN SELECT * FROM jsonb_array_elements(p_used_parts)
        LOOP
            v_part_id := (v_part->>'part_id')::UUID;
            v_qty := (v_part->>'quantity')::INTEGER;
            
            IF v_part_id IS NOT NULL AND v_qty > 0 THEN
                INSERT INTO public.inventory_transactions (part_id, quantity, transaction_type, reference_id, date)
                VALUES (v_part_id, v_qty, 'OUT', p_order_id, NOW());
            END IF;
        END LOOP;
    END IF;

    -- c) Invoca transition_vehicle_status
    -- El vehículo podría tener más de una OT. La función transition_vehicle_status valida 
    -- y si hay más OTs abiertas no permitirá pasarlo a DISPONIBLE. Lo manejamos sin fallar la transacción.
    v_transition_result := public.transition_vehicle_status(
        v_order.vehicle_plate, 
        'DISPONIBLE', 
        'Mantenimiento finalizado por OT: ' || v_order.ot_number
    );

    IF NOT (v_transition_result->>'success')::boolean THEN
        -- Manejar el error de forma segura (ej. cuando hay múltiples OTs abiertas, es correcto que no cambie a DISPONIBLE)
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
