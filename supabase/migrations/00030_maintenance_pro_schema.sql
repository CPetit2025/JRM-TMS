-- ============================================================
-- 00030: Módulo de Mantenimiento (Nivel Pro)
-- ============================================================

-- 1. Tabla de Planes de Mantenimiento Preventivo
CREATE TABLE IF NOT EXISTS public.maintenance_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vehicle_plate VARCHAR(20) NOT NULL REFERENCES public.vehicles(plate) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    frequency_km INTEGER, -- Cada cuántos km
    frequency_days INTEGER, -- O cada cuántos días
    last_performed_km INTEGER,
    last_performed_date DATE,
    next_due_km INTEGER GENERATED ALWAYS AS (last_performed_km + frequency_km) STORED,
    next_due_date DATE GENERATED ALWAYS AS (last_performed_date + frequency_days * INTERVAL '1 day') STORED,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Tabla de Fallas Reportadas (Correctivo)
CREATE TABLE IF NOT EXISTS public.vehicle_failures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vehicle_plate VARCHAR(20) NOT NULL REFERENCES public.vehicles(plate) ON DELETE CASCADE,
    reporter_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    description TEXT NOT NULL,
    criticality VARCHAR(20) DEFAULT 'MODERADA', -- LEVE, MODERADA, CRITICA
    status VARCHAR(50) DEFAULT 'ABIERTO', -- ABIERTO, EN_REVISION, CON_OT, RESUELTO, DESCARTADO
    report_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    resolved_date TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Órdenes de Trabajo de Mantenimiento
CREATE TABLE IF NOT EXISTS public.maintenance_work_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ot_number VARCHAR(50) UNIQUE NOT NULL,
    vehicle_plate VARCHAR(20) NOT NULL REFERENCES public.vehicles(plate) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL, -- PREVENTIVO, CORRECTIVO
    failure_id UUID REFERENCES public.vehicle_failures(id) ON DELETE SET NULL,
    plan_id UUID REFERENCES public.maintenance_plans(id) ON DELETE SET NULL,
    status VARCHAR(50) DEFAULT 'PENDIENTE', -- PENDIENTE, EN_PROCESO, COMPLETADO, CANCELADO
    assigned_mechanic VARCHAR(100),
    estimated_cost_pen DECIMAL(10,2) DEFAULT 0,
    final_cost_pen DECIMAL(10,2) DEFAULT 0,
    start_date TIMESTAMP WITH TIME ZONE,
    end_date TIMESTAMP WITH TIME ZONE,
    actual_end_date TIMESTAMP WITH TIME ZONE,
    diagnostic TEXT,
    activities_performed TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3.5. Costos de Órdenes de Trabajo (work_order_costs)
CREATE TABLE IF NOT EXISTS public.work_order_costs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_order_id UUID NOT NULL REFERENCES public.maintenance_work_orders(id) ON DELETE CASCADE,
    cost_type VARCHAR(50) NOT NULL, -- REPUESTOS, MANO_DE_OBRA, SERVICIO_EXTERNO, OTROS
    amount DECIMAL(10,2) NOT NULL,
    description TEXT,
    supplier_name VARCHAR(200),
    supplier_ruc VARCHAR(20),
    document_type VARCHAR(50),
    document_number VARCHAR(100),
    evidence_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Vincular OTs de Mantenimiento a Gastos (Expenses)
ALTER TABLE public.expenses
ADD COLUMN IF NOT EXISTS maintenance_ot_id UUID REFERENCES public.maintenance_work_orders(id) ON DELETE CASCADE;

-- 5. Trigger para actualizar el estado del Vehículo (Mantenimiento)
CREATE OR REPLACE FUNCTION public.update_vehicle_status_from_ot()
RETURNS TRIGGER AS $$
BEGIN
    -- Si la OT se pone en proceso, el vehículo entra a MANTENIMIENTO
    IF NEW.status = 'EN_PROCESO' AND OLD.status != 'EN_PROCESO' THEN
        UPDATE public.vehicles
        SET status = 'MANTENIMIENTO'
        WHERE plate = NEW.vehicle_plate;
    
    -- Si la OT se completa o cancela, verificar si hay otras OTs en proceso
    ELSIF (NEW.status = 'COMPLETADO' OR NEW.status = 'CANCELADO') AND OLD.status = 'EN_PROCESO' THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.maintenance_work_orders 
            WHERE vehicle_plate = NEW.vehicle_plate AND status = 'EN_PROCESO' AND id != NEW.id
        ) THEN
            UPDATE public.vehicles
            SET status = 'DISPONIBLE'
            WHERE plate = NEW.vehicle_plate;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_vehicle_status_maintenance ON public.maintenance_work_orders;
CREATE TRIGGER trigger_vehicle_status_maintenance
AFTER UPDATE OF status ON public.maintenance_work_orders
FOR EACH ROW
EXECUTE FUNCTION public.update_vehicle_status_from_ot();

-- 6. Habilitar RLS y Políticas
ALTER TABLE public.maintenance_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_order_costs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable all for authenticated users on maintenance_plans" ON public.maintenance_plans FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Enable all for authenticated users on vehicle_failures" ON public.vehicle_failures FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Enable all for authenticated users on maintenance_work_orders" ON public.maintenance_work_orders FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Enable all for authenticated users on work_order_costs" ON public.work_order_costs FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Refrescar caché del schema
NOTIFY pgrst, 'reload schema';
