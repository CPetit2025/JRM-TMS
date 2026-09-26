-- Migration 20260924145000_fase5_preventive_planning.sql

-- 1. Añadir campos al maintenance_plans
ALTER TABLE public.maintenance_plans
ADD COLUMN IF NOT EXISTS frequency_hours INTEGER,
ADD COLUMN IF NOT EXISTS last_performed_hours INTEGER,
ADD COLUMN IF NOT EXISTS standard_tasks JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS expected_parts JSONB DEFAULT '[]'::jsonb;

-- NOTA: next_due_km y next_due_date están generados. Haremos lo mismo para hours.
-- Pero PostgreSQL no permite ADD COLUMN con GENERATED sin drop.
-- Intentaremos agregarlo si no existe.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'maintenance_plans' AND column_name = 'next_due_hours') THEN
        ALTER TABLE public.maintenance_plans
        ADD COLUMN next_due_hours INTEGER GENERATED ALWAYS AS (last_performed_hours + frequency_hours) STORED;
    END IF;
END $$;

-- 2. Crear vw_maintenance_projections
CREATE OR REPLACE VIEW public.vw_maintenance_projections AS
SELECT 
    p.id AS plan_id,
    p.vehicle_plate,
    p.name AS plan_name,
    p.frequency_km,
    p.frequency_days,
    p.frequency_hours,
    p.last_performed_km,
    p.last_performed_date,
    p.last_performed_hours,
    p.next_due_km,
    p.next_due_date,
    p.next_due_hours,
    v.current_odometer,
    v.current_hours,
    (p.next_due_km - COALESCE(v.current_odometer, 0)) AS km_remaining,
    (p.next_due_date - CURRENT_DATE) AS days_remaining,
    (p.next_due_hours - COALESCE(v.current_hours, 0)) AS hours_remaining,
    CASE 
        WHEN (p.next_due_date <= CURRENT_DATE) OR 
             (p.frequency_km IS NOT NULL AND (p.next_due_km <= v.current_odometer)) OR
             (p.frequency_hours IS NOT NULL AND (p.next_due_hours <= v.current_hours)) 
        THEN 'VENCIDO'
        WHEN (p.next_due_date <= CURRENT_DATE + INTERVAL '15 days') OR 
             (p.frequency_km IS NOT NULL AND (p.next_due_km - v.current_odometer <= 1000)) OR
             (p.frequency_hours IS NOT NULL AND (p.next_due_hours - v.current_hours <= 50)) 
        THEN 'URGENTE'
        WHEN (p.next_due_date <= CURRENT_DATE + INTERVAL '30 days') OR 
             (p.frequency_km IS NOT NULL AND (p.next_due_km - v.current_odometer <= 3000)) OR
             (p.frequency_hours IS NOT NULL AND (p.next_due_hours - v.current_hours <= 150)) 
        THEN 'PRÓXIMO'
        ELSE 'NORMAL'
    END AS alert_status
FROM public.maintenance_plans p
JOIN public.vehicles v ON p.vehicle_plate = v.plate
WHERE p.is_active = true;

-- 3. Crear generate_preventive_wo(p_plan_id)
CREATE OR REPLACE FUNCTION public.generate_preventive_wo(p_plan_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_plan RECORD;
    v_wo_id UUID;
    v_ot_number VARCHAR(50);
BEGIN
    SELECT * INTO v_plan FROM public.maintenance_plans WHERE id = p_plan_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Plan de mantenimiento no encontrado';
    END IF;

    -- Generar OT number único
    v_ot_number := 'OT-' || to_char(CURRENT_TIMESTAMP, 'YYMMDDHH24MI') || '-' || substring(md5(random()::text) from 1 for 4);

    -- Create draft Work Order
    INSERT INTO public.maintenance_work_orders (
        ot_number,
        vehicle_plate, 
        type,
        order_type,
        status, 
        plan_id,
        tasks,
        diagnostic,
        start_date
    ) VALUES (
        v_ot_number,
        v_plan.vehicle_plate, 
        'PREVENTIVO',
        'PREVENTIVA', 
        'BORRADOR', 
        p_plan_id,
        COALESCE(v_plan.standard_tasks, '[]'::jsonb),
        'Orden generada automáticamente basada en plan preventivo: ' || v_plan.name,
        CURRENT_DATE
    ) RETURNING id INTO v_wo_id;

    -- Aquí los expected_parts podrían agregarse a una tabla de repuestos de la OT, si existe,
    -- o podrían incluirse en la descripción/tareas.
    -- Como no hay tabla de items clara en maintenance_work_orders en Phase 4, dejaremos expected_parts
    -- guardado en el plan y la OT tiene tasks.

    RETURN v_wo_id;
END;
$$;

GRANT SELECT ON public.vw_maintenance_projections TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_preventive_wo(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_preventive_wo(UUID) TO service_role;
