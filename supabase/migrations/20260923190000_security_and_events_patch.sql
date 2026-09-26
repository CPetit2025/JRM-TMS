-- 1. Seguridad (A7): Eliminar políticas inseguras (anon)
DROP POLICY IF EXISTS "Allow all anon on vehicles" ON public.vehicles;
DROP POLICY IF EXISTS "Allow all anon on carriers" ON public.carriers;
DROP POLICY IF EXISTS "Allow all anon on drivers" ON public.drivers;
DROP POLICY IF EXISTS "Allow all anon on cost_centers" ON public.cost_centers;
DROP POLICY IF EXISTS "Allow all anon on vehicle_maintenance_records" ON public.vehicle_maintenance_records;

-- 2. Performance e Índices (B4): Añadir índices a llaves foráneas operativas
CREATE INDEX IF NOT EXISTS idx_dispatches_driver_id ON public.dispatches(driver_id);
CREATE INDEX IF NOT EXISTS idx_dispatches_vehicle_plate ON public.dispatches(vehicle_plate);
CREATE INDEX IF NOT EXISTS idx_dispatch_events_dispatch_id ON public.dispatch_events(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_requests_dispatch_id ON public.dispatch_requests(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_requests_vehicle_plate ON public.maintenance_requests(vehicle_plate);

-- 3. Trazabilidad de Neumáticos (M1): Crear tabla tire_status_logs
CREATE TABLE IF NOT EXISTS public.tire_status_logs (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    tire_id uuid NOT NULL,
    vehicle_plate_assigned text,
    previous_status text,
    new_status text NOT NULL,
    reason text,
    created_at timestamptz DEFAULT now() NOT NULL,
    created_by uuid REFERENCES auth.users(id)
);

-- Habilitar RLS en tire_status_logs
ALTER TABLE public.tire_status_logs ENABLE ROW LEVEL SECURITY;

-- Política base para lectura autenticada
DROP POLICY IF EXISTS "Enable read access for authenticated users on tire_status_logs" ON public.tire_status_logs;
CREATE POLICY "Enable read access for authenticated users on tire_status_logs" 
    ON public.tire_status_logs FOR SELECT 
    TO authenticated 
    USING (true);

-- Política para escritura autenticada
DROP POLICY IF EXISTS "Enable insert for authenticated users on tire_status_logs" ON public.tire_status_logs;
CREATE POLICY "Enable insert for authenticated users on tire_status_logs" 
    ON public.tire_status_logs FOR INSERT 
    TO authenticated 
    WITH CHECK (true);

-- 4. Proveedores CMMS (M7): Añadir columnas para KPIs de proveedores
ALTER TABLE public.maintenance_providers 
    ADD COLUMN IF NOT EXISTS sla_score numeric(5,2) DEFAULT 100.00,
    ADD COLUMN IF NOT EXISTS total_services_completed integer DEFAULT 0;
