-- Add current_odometer to vehicles if it doesn't exist
ALTER TABLE public.vehicles
ADD COLUMN IF NOT EXISTS current_odometer NUMERIC(10,2) DEFAULT 0.00;

-- Create vehicle_odometer_logs table
CREATE TABLE IF NOT EXISTS public.vehicle_odometer_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vehicle_plate TEXT NOT NULL REFERENCES public.vehicles(plate) ON DELETE CASCADE,
    driver_id UUID REFERENCES public.drivers(id) ON DELETE SET NULL,
    dispatch_id UUID REFERENCES public.dispatches(id) ON DELETE SET NULL,
    odometer_value NUMERIC(10,2) NOT NULL,
    photo_url TEXT,
    source_event TEXT NOT NULL, -- e.g., 'INICIO_RUTA', 'FIN_RUTA', 'COMBUSTIBLE', 'MANTENIMIENTO'
    status TEXT NOT NULL DEFAULT 'VALIDADO', -- 'VALIDADO', 'REQUIERE_AUDITORIA', 'CORREGIDO'
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Index for fast lookups by vehicle
CREATE INDEX IF NOT EXISTS idx_odometer_logs_vehicle ON public.vehicle_odometer_logs(vehicle_plate, created_at DESC);

-- RPC to insert odometer reading with validation
CREATE OR REPLACE FUNCTION public.record_odometer_reading(
    p_vehicle_plate TEXT,
    p_odometer_value NUMERIC(10,2),
    p_photo_url TEXT,
    p_source_event TEXT,
    p_dispatch_id UUID DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_driver_id UUID;
    v_current_odometer NUMERIC(10,2);
    v_status TEXT := 'VALIDADO';
    v_user_id UUID;
BEGIN
    v_user_id := auth.uid();
    
    -- Get driver id if called by a driver
    SELECT id INTO v_driver_id FROM public.drivers WHERE user_id = v_user_id;

    -- Get current odometer and mileage
    SELECT COALESCE(current_odometer, current_mileage) INTO v_current_odometer
    FROM public.vehicles
    WHERE plate = p_vehicle_plate;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Vehículo no encontrado';
    END IF;

    -- Validation logic
    IF v_current_odometer IS NOT NULL THEN
        IF p_odometer_value < v_current_odometer THEN
            v_status := 'REQUIERE_AUDITORIA';
        ELSIF (p_odometer_value - v_current_odometer) > 2000 THEN
            -- Unlikely to jump more than 2000 km between readings
            v_status := 'REQUIERE_AUDITORIA';
        END IF;
    END IF;

    -- Insert log
    INSERT INTO public.vehicle_odometer_logs(
        vehicle_plate, driver_id, dispatch_id, odometer_value, photo_url, source_event, status, created_by
    ) VALUES (
        p_vehicle_plate, v_driver_id, p_dispatch_id, p_odometer_value, p_photo_url, p_source_event, v_status, v_user_id
    );

    -- Update vehicle if valid
    IF v_status = 'VALIDADO' THEN
        UPDATE public.vehicles
        SET current_odometer = p_odometer_value,
            current_mileage = p_odometer_value,
            updated_at = NOW()
        WHERE plate = p_vehicle_plate;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'status', v_status,
        'recorded_value', p_odometer_value,
        'previous_value', v_current_odometer
    );
END;
$$;
