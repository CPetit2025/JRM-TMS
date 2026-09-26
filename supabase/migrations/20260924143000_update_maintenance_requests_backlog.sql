BEGIN;

-- 1. Añadir columnas requeridas si faltan en maintenance_requests
ALTER TABLE public.maintenance_requests
ADD COLUMN IF NOT EXISTS horometer NUMERIC(10,2),
ADD COLUMN IF NOT EXISTS evidence JSONB,
ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES public.profiles(id);

-- Corregir la referencia de work_order_id si estaba apuntando a una tabla incorrecta o renombrarla lógicamente
-- Si el constraint existía apuntando a maintenance_orders (posible typo de migraciones pasadas)
ALTER TABLE public.maintenance_requests
DROP CONSTRAINT IF EXISTS maintenance_requests_work_order_id_fkey;

-- Agregamos la referencia a maintenance_work_orders
ALTER TABLE public.maintenance_requests
ADD CONSTRAINT maintenance_requests_work_order_id_fkey 
FOREIGN KEY (work_order_id) REFERENCES public.maintenance_work_orders(id) ON DELETE SET NULL;

-- 2. Actualizar estados y criticidades a valores válidos para las restricciones que vamos a añadir
UPDATE public.maintenance_requests 
SET status = 'REPORTADA' 
WHERE status NOT IN ('REPORTADA', 'VALIDADA', 'DIAGNOSTICADA', 'PROGRAMADA', 'CONVERTIDA_OT', 'CERRADA', 'DESCARTADA');

UPDATE public.maintenance_requests
SET severity = 'MEDIA'
WHERE severity NOT IN ('CRÍTICA', 'ALTA', 'MEDIA', 'BAJA');

-- 3. Restricciones de estado y criticidad
ALTER TABLE public.maintenance_requests DROP CONSTRAINT IF EXISTS chk_maintenance_requests_status;
ALTER TABLE public.maintenance_requests ADD CONSTRAINT chk_maintenance_requests_status 
CHECK (status IN ('REPORTADA', 'VALIDADA', 'DIAGNOSTICADA', 'PROGRAMADA', 'CONVERTIDA_OT', 'CERRADA', 'DESCARTADA'));

ALTER TABLE public.maintenance_requests DROP CONSTRAINT IF EXISTS chk_maintenance_requests_severity;
ALTER TABLE public.maintenance_requests ADD CONSTRAINT chk_maintenance_requests_severity 
CHECK (severity IN ('CRÍTICA', 'ALTA', 'MEDIA', 'BAJA'));

-- 4. Evitar reportes duplicados de la misma falla el mismo día (vehículo, descripción y fecha)
CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_requests_daily_falla 
ON public.maintenance_requests (
    vehicle_plate, 
    md5(description), 
    DATE(reported_at)
);

-- 5. RPC para convertir a OT devolviendo un Draft
CREATE OR REPLACE FUNCTION public.convert_request_to_wo(p_request_id UUID, p_user_id UUID)
RETURNS UUID AS $$
DECLARE
    v_request RECORD;
    v_order_id UUID;
    v_ot_number VARCHAR;
BEGIN
    SELECT * INTO v_request FROM public.maintenance_requests WHERE id = p_request_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Solicitud no encontrada';
    END IF;

    IF v_request.status = 'CONVERTIDA_OT' THEN
        RAISE EXCEPTION 'Esta solicitud ya fue convertida a OT';
    END IF;

    -- Generar ot_number básico usando timestamp
    v_ot_number := 'OT-' || extract(epoch from now())::int::text;

    -- Insertar en maintenance_work_orders
    INSERT INTO public.maintenance_work_orders (
        ot_number,
        vehicle_plate,
        type,
        status,
        diagnostic
    ) VALUES (
        v_ot_number,
        v_request.vehicle_plate,
        'CORRECTIVO',
        'BORRADOR', 
        v_request.description
    ) RETURNING id INTO v_order_id;

    -- Actualizar solicitud a CONVERTIDA_OT
    UPDATE public.maintenance_requests 
    SET status = 'CONVERTIDA_OT', work_order_id = v_order_id, updated_at = NOW()
    WHERE id = p_request_id;

    RETURN v_order_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grants para el RPC
REVOKE ALL ON FUNCTION public.convert_request_to_wo(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.convert_request_to_wo(UUID, UUID) TO authenticated;

-- 6. RLS Policies
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'Mantenimiento edita todas requests' AND tablename = 'maintenance_requests'
    ) THEN
        CREATE POLICY "Mantenimiento edita todas requests" 
        ON public.maintenance_requests FOR UPDATE
        TO authenticated 
        USING (has_tms_permission('mantenimiento'));
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'Mantenimiento inserta todas requests' AND tablename = 'maintenance_requests'
    ) THEN
        CREATE POLICY "Mantenimiento inserta todas requests" 
        ON public.maintenance_requests FOR INSERT
        TO authenticated 
        WITH CHECK (has_tms_permission('mantenimiento'));
    END IF;
END $$;

COMMIT;
