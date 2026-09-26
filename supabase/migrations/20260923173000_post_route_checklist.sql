-- MIGRATION: Post-route Checklist RPC
-- 20260923173000_post_route_checklist.sql

BEGIN;

-- Añadir columnas si no existen (para asegurar que podemos guardar la información)
ALTER TABLE public.dispatches 
ADD COLUMN IF NOT EXISTS end_odometer NUMERIC(10,2),
ADD COLUMN IF NOT EXISTS arrival_time TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS liquidation_data JSONB;

CREATE OR REPLACE FUNCTION public.submit_post_route_checklist(
    p_dispatch_id uuid,
    p_vehicle_plate text,
    p_driver_id uuid,
    p_odometer numeric,
    p_liquidation_data jsonb,
    p_location jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_dispatch record;
    v_lat numeric(10,6) := NULL;
    v_lon numeric(10,6) := NULL;
    v_start_odometer numeric;
    v_transition_result jsonb;
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

    IF v_dispatch.vehicle_plate != p_vehicle_plate THEN
        RETURN jsonb_build_object('success', false, 'message', 'La placa del vehículo enviada no coincide con la asignada al despacho');
    END IF;

    -- 2. Validar que el estado permite la liquidación/cierre
    IF v_dispatch.status NOT IN ('EN_CURSO', 'EN RUTA', 'RETORNO', 'ENTREGADO', 'RETORNO_COMPLETADO') THEN
        RETURN jsonb_build_object('success', false, 'message', 'Despacho en estado inválido para checklist post-ruta');
    END IF;

    -- 3. Validar Odómetro
    BEGIN
        v_start_odometer := v_dispatch.start_odometer;
    EXCEPTION WHEN OTHERS THEN
        v_start_odometer := 0;
    END;

    IF p_odometer IS NULL OR p_odometer < 0 THEN
        RETURN jsonb_build_object('success', false, 'message', 'Lectura de odómetro inválida. Debe ser un número positivo.');
    END IF;

    IF v_start_odometer IS NOT NULL AND p_odometer < v_start_odometer THEN
        RETURN jsonb_build_object('success', false, 'message', 'El odómetro final no puede ser menor al inicial (' || v_start_odometer || ')');
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

    -- 4. Actualizar el despacho con datos de liquidación y finalización
    UPDATE public.dispatches
    SET liquidation_data = p_liquidation_data,
        end_odometer = p_odometer,
        arrival_time = NOW()
    WHERE id = p_dispatch_id;

    -- Opcional: Insertar en driver_checklists para mantener historial (si existe la tabla)
    BEGIN
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
            jsonb_build_object('type', 'POST_RUTA', 'liquidation', p_liquidation_data, 'end_odometer', p_odometer), 
            v_lat, 
            v_lon
        );
    EXCEPTION WHEN undefined_table THEN
        -- Si la tabla no existe, ignorar, ya actualizamos dispatches.
    END;

    -- 5. Actualizar el odómetro
    -- 5.1 Insertar en vehicle_odometer_logs
    BEGIN
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
            'CHECKLIST_POST_RUTA', 
            'VALIDADO', 
            'Actualización automática desde checklist post-ruta'
        );
    EXCEPTION WHEN undefined_table THEN
        -- Ignorar si la tabla no existe
    END;

    -- 5.2 Actualizar vehicles.current_odometer
    BEGIN
        UPDATE public.vehicles
        SET current_odometer = p_odometer
        WHERE plate = p_vehicle_plate;
    EXCEPTION WHEN OTHERS THEN
        -- Ignorar fallas (e.g. si current_odometer no existe en vehicles)
    END;

    -- 6. Ejecutar transición de estado
    BEGIN
        v_transition_result := public.transition_dispatch_status(
            p_dispatch_id, 
            'RETORNO_COMPLETADO', 
            'Finalizado por checklist post-ruta', 
            p_driver_id
        );
        
        -- Si la máquina de estados rechaza la transición, propagamos el error
        IF NOT (v_transition_result->>'success')::boolean THEN
            RETURN v_transition_result;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'message', 'Error en transición de estado: ' || SQLERRM);
    END;

    -- 7. Retorna éxito
    RETURN jsonb_build_object('success', true, 'message', 'Viaje finalizado');
END $$;

REVOKE ALL ON FUNCTION public.submit_post_route_checklist(uuid, text, uuid, numeric, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_post_route_checklist(uuid, text, uuid, numeric, jsonb, jsonb) TO authenticated;

COMMIT;
