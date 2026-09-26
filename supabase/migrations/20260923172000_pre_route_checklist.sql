-- MIGRATION: Pre-route Checklist RPC
-- 20260923172000_pre_route_checklist.sql

BEGIN;

CREATE OR REPLACE FUNCTION public.submit_pre_route_checklist(
    p_dispatch_id uuid,
    p_vehicle_plate text,
    p_driver_id uuid,
    p_odometer numeric,
    p_checklist_data jsonb,
    p_location jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_dispatch record;
    v_lat numeric(10,6) := NULL;
    v_lon numeric(10,6) := NULL;
    v_has_critical_fault boolean := false;
BEGIN
    -- 1. Validar que el despacho existe y pertenece al conductor
    SELECT * INTO v_dispatch
    FROM public.dispatches
    WHERE id = p_dispatch_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Despacho no encontrado');
    END IF;

    IF v_dispatch.driver_id != p_driver_id THEN
        RETURN jsonb_build_object('success', false, 'message', 'Despacho no asignado a este conductor');
    END IF;

    IF v_dispatch.status NOT IN ('PROGRAMADO', 'EN_CURSO') THEN
        RETURN jsonb_build_object('success', false, 'message', 'Despacho en estado inválido para checklist pre-ruta');
    END IF;

    IF v_dispatch.vehicle_plate != p_vehicle_plate THEN
        RETURN jsonb_build_object('success', false, 'message', 'La placa del vehículo enviada no coincide con la asignada al despacho');
    END IF;

    IF p_odometer IS NULL OR p_odometer < 0 THEN
        RETURN jsonb_build_object('success', false, 'message', 'Lectura de odómetro inválida. Debe ser un número positivo.');
    END IF;

    -- Extraer coordenadas si el objeto de location es proporcionado
    IF p_location IS NOT NULL THEN
        BEGIN
            v_lat := (p_location->>'lat')::numeric;
            v_lon := (p_location->>'lon')::numeric;
        EXCEPTION WHEN OTHERS THEN
            v_lat := NULL;
            v_lon := NULL;
        END;
    END IF;

    -- 2. Insertar el checklist en la tabla driver_checklists
    INSERT INTO public.driver_checklists (
        dispatch_id, 
        driver_id, 
        vehicle_plate, 
        checklist_data, 
        location_lat, 
        location_lon
    ) VALUES (
        p_dispatch_id, 
        p_driver_id, 
        p_vehicle_plate, 
        p_checklist_data, 
        v_lat, 
        v_lon
    );

    -- 3. Registrar la lectura del odómetro en vehicle_odometer_logs
    INSERT INTO public.vehicle_odometer_logs (
        vehicle_plate, 
        driver_id, 
        dispatch_id, 
        odometer_value, 
        source_event, 
        status, 
        notes
    ) VALUES (
        p_vehicle_plate, 
        p_driver_id, 
        p_dispatch_id, 
        p_odometer, 
        'CHECKLIST_PRE_RUTA', 
        'VALIDADO', 
        'Actualización automática desde checklist pre-ruta'
    );

    -- Actualizar el odómetro actual del vehículo
    UPDATE public.vehicles
    SET current_odometer = p_odometer
    WHERE plate = p_vehicle_plate;

    -- 4. Actualizar el despacho
    UPDATE public.dispatches
    SET start_odometer = p_odometer,
        departure_time = COALESCE(departure_time, NOW())
    WHERE id = p_dispatch_id;

    -- Transición a EN_CURSO si estaba PROGRAMADO
    IF v_dispatch.status = 'PROGRAMADO' THEN
        BEGIN
            PERFORM public.transition_dispatch_status(
                p_dispatch_id, 
                'EN_CURSO', 
                'Iniciado por checklist pre-ruta', 
                p_driver_id
            );
        EXCEPTION WHEN OTHERS THEN
            -- Fallback por si la función no existe o falla
            UPDATE public.dispatches
            SET status = 'EN_CURSO'
            WHERE id = p_dispatch_id;
        END;
    END IF;

    -- 5. Extraer fallas críticas del checklist (opcional pero recomendado)
    -- Asumimos que checklist_data puede traer un flag "has_critical_fault" o revisamos un nodo específico
    IF p_checklist_data->>'has_critical_fault' = 'true' THEN
        INSERT INTO public.maintenance_requests (
            vehicle_plate, 
            driver_id, 
            dispatch_id, 
            description, 
            severity, 
            status, 
            location_lat, 
            location_lon, 
            odometer_at_report
        ) VALUES (
            p_vehicle_plate, 
            p_driver_id, 
            p_dispatch_id, 
            COALESCE(p_checklist_data->>'fault_description', 'Falla crítica detectada en checklist pre-ruta'), 
            'ALTA', 
            'PENDIENTE', 
            v_lat, 
            v_lon, 
            p_odometer
        );
    END IF;

    -- 6. Retorna éxito
    RETURN jsonb_build_object('success', true, 'message', 'Checklist procesado');
END;
$$;

-- Permisos
REVOKE ALL ON FUNCTION public.submit_pre_route_checklist(uuid, text, uuid, numeric, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_pre_route_checklist(uuid, text, uuid, numeric, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_pre_route_checklist(uuid, text, uuid, numeric, jsonb, jsonb) TO service_role;

COMMIT;
