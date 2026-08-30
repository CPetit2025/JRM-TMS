-- ============================================================
-- 00024: Mantenimiento de Flota, Reportes de Fallas y Gastos
-- ============================================================

-- 1. Crear tabla de Centros de Costo
CREATE TABLE IF NOT EXISTS public.cost_centers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  type VARCHAR(50) NOT NULL, -- DISTRIBUCION, MANTENIMIENTO, ADMINISTRATIVO, etc
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Habilitar RLS e insertar default
ALTER TABLE public.cost_centers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all anon on cost_centers" ON cost_centers FOR ALL TO anon USING (true);
CREATE POLICY "Allow all authenticated on cost_centers" ON cost_centers FOR ALL TO authenticated USING (true);

INSERT INTO public.cost_centers (code, name, type, description)
VALUES 
  ('CC-DIST', 'Operación Logística / Distribución', 'DISTRIBUCION', 'Gastos generados en la ruta y operación (peajes, estibas)'),
  ('CC-MANT', 'Mantenimiento de Flota', 'MANTENIMIENTO', 'Gastos de reparación, preventivos y repuestos')
ON CONFLICT (code) DO NOTHING;

-- 2. Crear tabla de Registros de Mantenimiento / Fallas
CREATE TABLE IF NOT EXISTS public.vehicle_maintenance_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_plate VARCHAR(20) NOT NULL, -- Referencia a vehicles.plate
  record_type VARCHAR(50) NOT NULL, -- FALLA_REPORTADA, MANTENIMIENTO_PREVENTIVO, MANTENIMIENTO_CORRECTIVO
  status VARCHAR(50) DEFAULT 'PENDIENTE', -- PENDIENTE, EN_REVISION, EN_MANTENIMIENTO, COMPLETADO, DESCARTADO
  description TEXT NOT NULL,
  diagnosis TEXT,
  reported_by UUID REFERENCES auth.users(id) ON DELETE SET NULL, -- Quién lo reportó (Chofer o Admin)
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.vehicle_maintenance_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all anon on vehicle_maintenance_records" ON vehicle_maintenance_records FOR ALL TO anon USING (true);
CREATE POLICY "Allow all authenticated on vehicle_maintenance_records" ON vehicle_maintenance_records FOR ALL TO authenticated USING (true);

-- 3. Expandir la tabla de Gastos (expenses)
ALTER TABLE public.expenses
ADD COLUMN IF NOT EXISTS cost_center_id UUID REFERENCES public.cost_centers(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS dispatch_id UUID REFERENCES public.dispatches(id) ON DELETE CASCADE,
ADD COLUMN IF NOT EXISTS maintenance_record_id UUID REFERENCES public.vehicle_maintenance_records(id) ON DELETE CASCADE;

-- 4. Trigger para actualizar el estado del Vehículo (Ocultarlo de Despachos)
CREATE OR REPLACE FUNCTION public.update_vehicle_maintenance_status()
RETURNS TRIGGER AS $$
BEGIN
  -- Si el mantenimiento se pone en progreso o preventivo/correctivo se aprueba
  IF NEW.status = 'EN_MANTENIMIENTO' OR NEW.status = 'EN_REVISION' THEN
    UPDATE public.vehicles
    SET status = 'EN_MANTENIMIENTO'
    WHERE plate = NEW.vehicle_plate;
  
  -- Si se completa o descarta, el vehículo vuelve a estar disponible
  ELSIF (NEW.status = 'COMPLETADO' OR NEW.status = 'DESCARTADO') AND (OLD.status = 'EN_MANTENIMIENTO' OR OLD.status = 'EN_REVISION') THEN
    UPDATE public.vehicles
    SET status = 'DISPONIBLE'
    WHERE plate = NEW.vehicle_plate;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_vehicle_status ON public.vehicle_maintenance_records;
CREATE TRIGGER trigger_update_vehicle_status
AFTER INSERT OR UPDATE OF status ON public.vehicle_maintenance_records
FOR EACH ROW
EXECUTE FUNCTION public.update_vehicle_maintenance_status();

-- Refrescar caché del schema
NOTIFY pgrst, 'reload schema';
