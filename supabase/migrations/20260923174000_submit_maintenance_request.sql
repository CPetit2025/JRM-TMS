BEGIN;

-- Eliminamos el trigger anterior (de la fase 1) para delegar la lógica 
-- de transición y manejo de errores a esta nueva función de manera controlada.
DROP TRIGGER IF EXISTS trg_maintenance_request_severity ON public.maintenance_requests;
DROP FUNCTION IF EXISTS public.trigger_maintenance_request_severity();

-- Función para reportar una falla (Maintenance Request)
CREATE OR REPLACE FUNCTION public.submit_maintenance_request(
    p_vehicle_plate TEXT,
    p_driver_id UUID,
    p_dispatch_id UUID,
    p_description TEXT,
    p_severity TEXT,
    p_odometer NUMERIC,
    p_photo_url TEXT DEFAULT NULL,
    p_location JSONB DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_request_id UUID;
    v_current_odometer NUMERIC;
    v_lat NUMERIC(10,6) := NULL;
    v_lon NUMERIC(10,6) := NULL;
    v_transition_error TEXT;
BEGIN
    -- 1. Validar que el odómetro sea >= 0
    IF p_odometer < 0 THEN
        RAISE EXCEPTION 'El odómetro no puede ser negativo';
    END IF;

    -- Extraer latitud y longitud si se proporcionó ubicación
    IF p_location IS NOT NULL THEN
        v_lat := (p_location->>'lat')::NUMERIC;
        v_lon := (p_location->>'lon')::NUMERIC;
    END IF;

    -- 2. Insertar la falla en public.maintenance_requests (con estado PENDIENTE)
    INSERT INTO public.maintenance_requests (
        vehicle_plate,
        driver_id,
        dispatch_id,
        description,
        severity,
        status,
        photo_url,
        location_lat,
        location_lon,
        odometer_at_report
    ) VALUES (
        p_vehicle_plate,
        p_driver_id,
        p_dispatch_id,
        p_description,
        p_severity,
        'PENDIENTE',
        p_photo_url,
        v_lat,
        v_lon,
        p_odometer
    ) RETURNING id INTO v_request_id;

    -- 3. Registrar la lectura del odómetro
    -- Insertar el registro en vehicle_odometer_logs
    INSERT INTO public.vehicle_odometer_logs (
        vehicle_plate,
        driver_id,
        dispatch_id,
        odometer_value,
        photo_url,
        source_event,
        status,
        created_by
    ) VALUES (
        p_vehicle_plate,
        p_driver_id,
        p_dispatch_id,
        p_odometer,
        p_photo_url,
        'REPORTE_FALLA',
        'VALIDADO',
        auth.uid()
    );

    -- Obtener el odómetro actual del vehículo para compararlo
    SELECT COALESCE(current_odometer, 0) INTO v_current_odometer
    FROM public.vehicles
    WHERE plate = p_vehicle_plate;

    -- Actualizar el odómetro del vehículo solo si es mayor o igual al actual
    IF p_odometer >= v_current_odometer THEN
        UPDATE public.vehicles
        SET current_odometer = p_odometer,
            updated_at = NOW()
        WHERE plate = p_vehicle_plate;
    END IF;

    -- 4. REGLA DE NEGOCIO: Máquina de Estados de Vehículo
    IF p_severity = 'CRITICA' THEN
        BEGIN
            -- Ejecutar transición a OBSERVADA
            PERFORM public.transition_vehicle_status(
                p_vehicle_plate, 
                'OBSERVADA', 
                'Falla crítica reportada por conductor en ruta'
            );
        EXCEPTION WHEN OTHERS THEN
            -- Propagar errores o usar EXCEPTION fallback si la máquina de estados rechaza el cambio,
            -- pero el reporte de falla SÍ debe quedar guardado.
            v_transition_error := SQLERRM;
            RAISE WARNING 'No se pudo transicionar el vehículo % a OBSERVADA: %', p_vehicle_plate, v_transition_error;
            
            -- Registrar el fallo de transición en las notas del reporte para que mantenimiento/despacho lo vea.
            UPDATE public.maintenance_requests 
            SET notes = COALESCE(notes, '') || ' | ERROR TRANSICIÓN ESTADO: ' || v_transition_error
            WHERE id = v_request_id;
        END;
    END IF;

    -- 5. Retornar success true
    RETURN jsonb_build_object(
        'success', true, 
        'message', 'Falla reportada correctamente',
        'request_id', v_request_id
    );
END;
$$;

-- Permisos
GRANT EXECUTE ON FUNCTION public.submit_maintenance_request TO authenticated;

COMMIT;
