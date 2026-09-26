BEGIN;

CREATE OR REPLACE FUNCTION public.transition_vehicle_status(
    p_vehicle_plate text, 
    p_new_status text, 
    p_reason text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
    v_current_status text;
    v_valid_transition boolean := false;
    v_open_mo_count int;
BEGIN
    SELECT status INTO v_current_status
    FROM public.vehicles
    WHERE plate = p_vehicle_plate;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Vehicle not found');
    END IF;

    -- Validate transition
    IF v_current_status = 'DISPONIBLE' AND p_new_status IN ('ASIGNADA', 'MANTENIMIENTO', 'BLOQUEADA', 'FUERA_DE_SERVICIO', 'OBSERVADA') THEN
        v_valid_transition := true;
    ELSIF v_current_status = 'ASIGNADA' AND p_new_status IN ('EN_RUTA', 'DISPONIBLE', 'MANTENIMIENTO', 'BLOQUEADA') THEN
        v_valid_transition := true;
    ELSIF v_current_status = 'EN_RUTA' AND p_new_status IN ('ASIGNADA', 'DISPONIBLE', 'MANTENIMIENTO', 'BLOQUEADA') THEN
        v_valid_transition := true;
    ELSIF v_current_status = 'OBSERVADA' AND p_new_status IN ('DISPONIBLE', 'MANTENIMIENTO', 'BLOQUEADA', 'FUERA_DE_SERVICIO') THEN
        v_valid_transition := true;
    ELSIF v_current_status = 'MANTENIMIENTO' AND p_new_status IN ('DISPONIBLE', 'OBSERVADA', 'FUERA_DE_SERVICIO') THEN
        -- check for open MO
        SELECT count(*) INTO v_open_mo_count
        FROM public.maintenance_orders
        WHERE vehicle_plate = p_vehicle_plate AND status NOT IN ('FINALIZADA', 'COMPLETADO', 'CANCELADO');
        IF v_open_mo_count > 0 AND p_new_status = 'DISPONIBLE' THEN
             RETURN jsonb_build_object('success', false, 'error', 'Cannot transition to DISPONIBLE with open maintenance orders');
        END IF;
        v_valid_transition := true;
    ELSIF v_current_status = 'BLOQUEADA' AND p_new_status = 'DISPONIBLE' THEN
        v_valid_transition := true;
    ELSIF v_current_status = 'FUERA_DE_SERVICIO' AND p_new_status = 'DISPONIBLE' THEN
        v_valid_transition := true;
    END IF;

    IF NOT v_valid_transition THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid transition from ' || v_current_status || ' to ' || p_new_status);
    END IF;

    UPDATE public.vehicles
    SET status = p_new_status
    WHERE plate = p_vehicle_plate;

    -- Attempt to insert history if table exists
    BEGIN
        INSERT INTO public.vehicle_maintenance_history (
            vehicle_plate, previous_status, new_status, reason, created_by, created_at
        ) VALUES (
            p_vehicle_plate, v_current_status, p_new_status, p_reason, auth.uid(), now()
        );
    EXCEPTION WHEN undefined_table THEN
        -- Ignore if table doesn't exist yet
    END;

    RETURN jsonb_build_object(
        'success', true, 
        'previous_status', v_current_status, 
        'new_status', p_new_status, 
        'reason', p_reason
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.transition_vehicle_status(text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.transition_vehicle_status(text, text, text) TO authenticated;

COMMIT;
