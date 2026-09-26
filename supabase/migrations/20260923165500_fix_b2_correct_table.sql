BEGIN;

-- ==============================================================================
-- B2 ROUND 3: Corrección definitiva de la tabla y columna de OTs abiertas
-- La tabla real es `maintenance_work_orders` con columna `vehicle_plate` (no vehicle_id)
-- Verificado contra: 00030_maintenance_pro_schema.sql línea 40
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.transition_vehicle_status(
  p_vehicle_plate text,
  p_new_status    text,
  p_reason        text     DEFAULT NULL,
  p_user_id       uuid     DEFAULT NULL,
  p_metadata      jsonb    DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_current_status  text;
  v_open_mo_count   int := 0;
  v_is_admin        boolean;
  v_is_driver       boolean;
  v_valid_transition boolean := false;
BEGIN
  -- Resolve permissions
  v_is_admin  := has_tms_permission('admin') OR has_tms_permission('mantenimiento') OR has_tms_permission('despacho');
  v_is_driver := EXISTS (SELECT 1 FROM public.drivers WHERE user_id = auth.uid());

  -- B1: Permission guards
  IF p_new_status = 'DISPONIBLE' AND NOT v_is_admin THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient permissions to release vehicle');
  END IF;

  IF p_new_status = 'FUERA_DE_SERVICIO' AND NOT has_tms_permission('admin') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only admins can decommission vehicles');
  END IF;

  IF v_is_driver AND NOT v_is_admin AND p_new_status NOT IN ('BLOQUEADA', 'OBSERVADA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Drivers can only report faults (BLOQUEADA/OBSERVADA)');
  END IF;

  -- Get current status
  SELECT status INTO v_current_status
  FROM public.vehicles
  WHERE plate = p_vehicle_plate;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehicle not found: ' || p_vehicle_plate);
  END IF;

  -- Validate transition matrix
  IF v_current_status = 'DISPONIBLE'    AND p_new_status IN ('ASIGNADA','MANTENIMIENTO','BLOQUEADA','FUERA_DE_SERVICIO','OBSERVADA') THEN v_valid_transition := true;
  ELSIF v_current_status = 'ASIGNADA'   AND p_new_status IN ('EN_RUTA','DISPONIBLE','MANTENIMIENTO','BLOQUEADA') THEN v_valid_transition := true;
  ELSIF v_current_status = 'EN_RUTA'    AND p_new_status IN ('ASIGNADA','DISPONIBLE','MANTENIMIENTO','BLOQUEADA') THEN v_valid_transition := true;
  ELSIF v_current_status = 'OBSERVADA'  AND p_new_status IN ('DISPONIBLE','MANTENIMIENTO','BLOQUEADA','FUERA_DE_SERVICIO') THEN v_valid_transition := true;
  ELSIF v_current_status = 'MANTENIMIENTO' AND p_new_status IN ('DISPONIBLE','OBSERVADA','FUERA_DE_SERVICIO') THEN v_valid_transition := true;
  ELSIF v_current_status = 'BLOQUEADA'  AND p_new_status = 'DISPONIBLE' THEN v_valid_transition := true;
  ELSIF v_current_status = 'FUERA_DE_SERVICIO' AND p_new_status = 'DISPONIBLE' THEN v_valid_transition := true;
  END IF;

  IF NOT v_valid_transition THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Invalid transition: ' || v_current_status || ' → ' || p_new_status);
  END IF;

  -- B2 FIXED: Use correct table `maintenance_work_orders` with column `vehicle_plate`
  -- Verified against 00030_maintenance_pro_schema.sql line 40:
  --   vehicle_plate VARCHAR(20) NOT NULL REFERENCES public.vehicles(plate)
  IF p_new_status = 'DISPONIBLE' THEN
    SELECT count(*) INTO v_open_mo_count
    FROM public.maintenance_work_orders
    WHERE vehicle_plate = p_vehicle_plate
      AND status NOT IN ('COMPLETADO', 'CANCELADO', 'FINALIZADO', 'FINALIZADA');

    IF v_open_mo_count > 0 THEN
      RETURN jsonb_build_object('success', false, 'error',
        'Cannot release vehicle: ' || v_open_mo_count || ' open work order(s) remain');
    END IF;
  END IF;

  -- Execute state change
  UPDATE public.vehicles
  SET status     = p_new_status,
      updated_at = NOW()
  WHERE plate = p_vehicle_plate;

  -- Audit log (safe — catches undefined_table gracefully)
  BEGIN
    INSERT INTO public.vehicle_maintenance_history (
      vehicle_plate, previous_status, new_status, reason, created_by, created_at
    ) VALUES (
      p_vehicle_plate, v_current_status, p_new_status,
      COALESCE(p_reason, 'Transición de estado'),
      COALESCE(p_user_id, auth.uid()),
      NOW()
    );
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    NULL; -- Table not yet created in this env; non-fatal
  END;

  RETURN jsonb_build_object(
    'success',         true,
    'previous_status', v_current_status,
    'new_status',      p_new_status,
    'reason',          p_reason
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- Revoke and re-grant to ensure clean permissions
REVOKE ALL ON FUNCTION public.transition_vehicle_status(text, text, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transition_vehicle_status(text, text, text, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transition_vehicle_status(text, text, text, uuid, jsonb) TO service_role;

-- Also handle the 3-arg overload from the original migration (backward compat)
CREATE OR REPLACE FUNCTION public.transition_vehicle_status(
  p_vehicle_plate text,
  p_new_status    text,
  p_reason        text DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public
AS $$
  SELECT public.transition_vehicle_status(p_vehicle_plate, p_new_status, p_reason, auth.uid(), '{}'::jsonb);
$$;

REVOKE ALL ON FUNCTION public.transition_vehicle_status(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transition_vehicle_status(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transition_vehicle_status(text, text, text) TO service_role;

COMMIT;
