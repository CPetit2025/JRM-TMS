BEGIN;

-- Update existing 'EN_RUTA' to 'EN_OPERACION'
UPDATE public.vehicles SET status = 'EN_OPERACION' WHERE status = 'EN_RUTA';

-- Drop the old constraint
ALTER TABLE public.vehicles DROP CONSTRAINT IF EXISTS vehicles_status_check;

-- Add the new constraint
ALTER TABLE public.vehicles
ADD CONSTRAINT vehicles_status_check
CHECK (status IN ('DISPONIBLE', 'ASIGNADA', 'EN_OPERACION', 'OBSERVADA', 'MANTENIMIENTO', 'BLOQUEADA', 'FUERA_DE_SERVICIO'));

-- Add new columns
ALTER TABLE public.vehicles
ADD COLUMN IF NOT EXISTS internal_code VARCHAR(50),
ADD COLUMN IF NOT EXISTS serial_number VARCHAR(100),
ADD COLUMN IF NOT EXISTS current_hours NUMERIC(10,2) DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS criticality VARCHAR(20) DEFAULT 'MEDIA' CHECK (criticality IN ('ALTA', 'MEDIA', 'BAJA')),
ADD COLUMN IF NOT EXISTS ownership_status VARCHAR(20) DEFAULT 'PROPIEDAD' CHECK (ownership_status IN ('PROPIEDAD', 'ALQUILER')),
ADD COLUMN IF NOT EXISTS responsible_id UUID REFERENCES public.profiles(id),
ADD COLUMN IF NOT EXISTS current_location VARCHAR(255);

-- Update and add type check
UPDATE public.vehicles
SET type = 'otros'
WHERE lower(type) NOT IN ('camión', 'tracto', 'semirremolque', 'montacargas', 'apilador', 'transpaleta', 'otros');

ALTER TABLE public.vehicles DROP CONSTRAINT IF EXISTS vehicles_type_check;
ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_type_check 
CHECK (lower(type) IN ('camión', 'tracto', 'semirremolque', 'montacargas', 'apilador', 'transpaleta', 'otros'));

-- Create history/audit table vehicle_history_logs
CREATE TABLE IF NOT EXISTS public.vehicle_history_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vehicle_plate VARCHAR(20) NOT NULL REFERENCES public.vehicles(plate) ON DELETE CASCADE,
    changed_by UUID REFERENCES auth.users(id),
    field_changed VARCHAR(50) NOT NULL,
    old_value TEXT,
    new_value TEXT,
    change_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- RLS for vehicle_history_logs
ALTER TABLE public.vehicle_history_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS history_logs_read ON public.vehicle_history_logs;
DROP POLICY IF EXISTS history_logs_write ON public.vehicle_history_logs;
CREATE POLICY history_logs_read ON public.vehicle_history_logs FOR SELECT TO authenticated USING (true);
CREATE POLICY history_logs_write ON public.vehicle_history_logs FOR INSERT TO authenticated WITH CHECK (true);

-- Create RPC or DB View for 360 data
CREATE OR REPLACE FUNCTION public.get_fleet_360_view(p_plate VARCHAR)
RETURNS JSONB AS $func
DECLARE
    v_vehicle JSONB;
BEGIN
    SELECT row_to_json(v)::jsonb INTO v_vehicle
    FROM (
        SELECT 
            v.*,
            (SELECT row_to_json(p) FROM profiles p WHERE p.id = v.responsible_id) as responsible,
            (SELECT json_agg(row_to_json(l)) FROM (SELECT * FROM vehicle_history_logs WHERE vehicle_plate = p_plate ORDER BY created_at DESC LIMIT 10) l) as recent_logs
        FROM vehicles v
        WHERE v.plate = p_plate
    ) v;
    
    RETURN v_vehicle;
END;
$func LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.get_fleet_360_view(varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_fleet_360_view(varchar) TO authenticated;

COMMIT;
