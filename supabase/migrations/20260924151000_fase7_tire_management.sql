-- ============================================================
-- 20260924151000_fase7_tire_management.sql
-- FASE 7: GESTIÓN DE NEUMÁTICOS
-- ============================================================

DO $$ 
BEGIN
    -- Rename columns in tires if they exist
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tires' AND column_name='internal_code') THEN
        ALTER TABLE public.tires RENAME COLUMN internal_code TO codigo_interno;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tires' AND column_name='brand') THEN
        ALTER TABLE public.tires RENAME COLUMN brand TO marca;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tires' AND column_name='model') THEN
        ALTER TABLE public.tires RENAME COLUMN model TO modelo;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tires' AND column_name='size') THEN
        ALTER TABLE public.tires RENAME COLUMN size TO medida;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tires' AND column_name='purchase_price_pen') THEN
        ALTER TABLE public.tires RENAME COLUMN purchase_price_pen TO costo;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tires' AND column_name='status') THEN
        ALTER TABLE public.tires RENAME COLUMN status TO estado;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tires' AND column_name='initial_tread_depth_mm') THEN
        ALTER TABLE public.tires RENAME COLUMN initial_tread_depth_mm TO cocada_original;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tires' AND column_name='current_tread_depth_mm') THEN
        ALTER TABLE public.tires RENAME COLUMN current_tread_depth_mm TO cocada_actual;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tires' AND column_name='current_position') THEN
        ALTER TABLE public.tires RENAME COLUMN current_position TO posicion_actual;
    END IF;

    -- Rename columns in tire_movements if they exist
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tire_movements' AND column_name='action') THEN
        ALTER TABLE public.tire_movements RENAME COLUMN action TO tipo_movimiento;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tire_movements' AND column_name='position') THEN
        ALTER TABLE public.tire_movements RENAME COLUMN position TO posicion;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tire_movements' AND column_name='odometer_at_action') THEN
        ALTER TABLE public.tire_movements RENAME COLUMN odometer_at_action TO current_odometer;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tire_movements' AND column_name='tread_depth_at_action') THEN
        ALTER TABLE public.tire_movements RENAME COLUMN tread_depth_at_action TO cocada;
    END IF;
END $$;

ALTER TABLE public.tires ADD COLUMN IF NOT EXISTS dot VARCHAR(50);
ALTER TABLE public.tires ADD COLUMN IF NOT EXISTS vehiculo_actual_id UUID REFERENCES public.vehicles(id) ON DELETE SET NULL;

-- Ensure constraint for estado
ALTER TABLE public.tires DROP CONSTRAINT IF EXISTS tires_estado_check;
-- Update existing status values
UPDATE public.tires SET estado = 'ALMACÉN' WHERE estado = 'ALMACEN';
UPDATE public.tires SET estado = 'INSTALADO' WHERE estado = 'INSTALADA';
ALTER TABLE public.tires ADD CONSTRAINT tires_estado_check CHECK (estado IN ('ALMACÉN', 'INSTALADO', 'REENCAUCHE', 'BAJA'));

ALTER TABLE public.tire_movements ADD COLUMN IF NOT EXISTS vehicle_id UUID REFERENCES public.vehicles(id) ON DELETE SET NULL;

ALTER TABLE public.tire_movements DROP CONSTRAINT IF EXISTS tire_movements_tipo_movimiento_check;
UPDATE public.tire_movements SET tipo_movimiento = 'INSTALACIÓN' WHERE tipo_movimiento = 'INSTALACION';
UPDATE public.tire_movements SET tipo_movimiento = 'ROTACIÓN' WHERE tipo_movimiento = 'ROTACION';
UPDATE public.tire_movements SET tipo_movimiento = 'MEDICIÓN' WHERE tipo_movimiento = 'INSPECCION';
ALTER TABLE public.tire_movements ADD CONSTRAINT tire_movements_tipo_movimiento_check CHECK (tipo_movimiento IN ('INSTALACIÓN', 'RETIRO', 'ROTACIÓN', 'MEDICIÓN'));

-- ============================================================
-- VIEW: vw_tire_metrics
-- ============================================================
CREATE OR REPLACE VIEW vw_tire_metrics AS
WITH installation_spans AS (
    SELECT 
        m1.tire_id,
        m1.vehicle_id,
        m1.current_odometer AS start_odo,
        MIN(m2.current_odometer) AS end_odo
    FROM tire_movements m1
    LEFT JOIN tire_movements m2 ON m1.tire_id = m2.tire_id 
        AND m1.vehicle_id = m2.vehicle_id 
        AND m2.tipo_movimiento = 'RETIRO' 
        AND m2.created_at >= m1.created_at
    WHERE m1.tipo_movimiento = 'INSTALACIÓN'
    GROUP BY m1.tire_id, m1.vehicle_id, m1.current_odometer
),
tire_distances AS (
    SELECT 
        tire_id,
        SUM(COALESCE(end_odo, start_odo) - start_odo) as total_km
    FROM installation_spans
    GROUP BY tire_id
)
SELECT 
    t.id AS tire_id,
    t.codigo_interno,
    t.marca,
    t.costo,
    t.estado,
    COALESCE(d.total_km, 0) AS total_km,
    CASE 
        WHEN COALESCE(d.total_km, 0) > 0 THEN t.costo / d.total_km 
        ELSE 0 
    END AS cpk
FROM tires t
LEFT JOIN tire_distances d ON t.id = d.tire_id
WHERE t.estado IN ('BAJA', 'REENCAUCHE');

-- ============================================================
-- TRIGGER: Seguridad Límite Cocada
-- ============================================================
CREATE OR REPLACE FUNCTION check_tire_tread_depth()
RETURNS TRIGGER AS $$
DECLARE
    limit_mm NUMERIC := 2.0;
    v_vehicle_id UUID;
    v_tire_code TEXT;
BEGIN
    IF NEW.tipo_movimiento IN ('MEDICIÓN', 'ROTACIÓN', 'INSTALACIÓN') AND NEW.cocada < limit_mm THEN
        -- Obtener vehicle_id
        v_vehicle_id := NEW.vehicle_id;
        IF v_vehicle_id IS NULL THEN
            SELECT vehiculo_actual_id INTO v_vehicle_id FROM public.tires WHERE id = NEW.tire_id;
        END IF;

        IF v_vehicle_id IS NOT NULL THEN
            SELECT codigo_interno INTO v_tire_code FROM public.tires WHERE id = NEW.tire_id;
            
            INSERT INTO public.maintenance_requests (
                vehicle_id,
                reported_by,
                issue_description,
                priority,
                status
            ) VALUES (
                v_vehicle_id,
                NEW.created_by,
                'CRÍTICO: Neumático ' || COALESCE(v_tire_code, 'Desconocido') || ' con cocada actual (' || NEW.cocada || 'mm) por debajo del límite permitido.',
                'CRITICAL',
                'PENDING'
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_check_tire_tread_depth ON public.tire_movements;
CREATE TRIGGER trigger_check_tire_tread_depth
AFTER INSERT OR UPDATE ON public.tire_movements
FOR EACH ROW
EXECUTE FUNCTION check_tire_tread_depth();

-- Actualizar permisos a la vista
GRANT SELECT ON public.vw_tire_metrics TO authenticated;
GRANT SELECT ON public.vw_tire_metrics TO service_role;

NOTIFY pgrst, 'reload schema';
