-- 20260923171000_dispatch_state_machine.sql
-- FASE 3: CICLO DE VIDA DEL VIAJE - Migración de Máquina de Estados de Despachos

BEGIN;

CREATE OR REPLACE FUNCTION public.transition_dispatch_status(
  p_dispatch_id uuid,
  p_new_status text,
  p_reason text DEFAULT NULL,
  p_user_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_dispatch public.dispatches%ROWTYPE;
  v_current_status text;
  v_allowed boolean := false;
BEGIN
  -- Obtener despacho actual
  SELECT * INTO v_dispatch FROM public.dispatches WHERE id = p_dispatch_id FOR UPDATE;
  
  IF v_dispatch.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Despacho inexistente');
  END IF;

  v_current_status := COALESCE(v_dispatch.status, 'PROGRAMADO');

  -- Si es el mismo estado, no hacer nada pero retornar éxito
  IF v_current_status = p_new_status THEN
    RETURN jsonb_build_object('success', true, 'previous_status', v_current_status, 'new_status', p_new_status, 'note', 'El estado ya era ' || p_new_status);
  END IF;

  -- Lógica de matriz de transición
  -- Cualquier estado puede pasar a CANCELADO salvo los terminados
  IF p_new_status = 'CANCELADO' AND v_current_status NOT IN ('LIQUIDADO', 'CERRADO') THEN
    v_allowed := true;
  ELSIF v_current_status = 'PROGRAMADO' THEN
    IF p_new_status IN ('EN_CURSO', 'EN RUTA') THEN v_allowed := true; END IF;
  ELSIF v_current_status IN ('EN_CURSO', 'EN RUTA') THEN
    IF p_new_status IN ('ESPERANDO_AUTORIZACION', 'RETORNO', 'ENTREGADO') THEN v_allowed := true; END IF;
  ELSIF v_current_status = 'ESPERANDO_AUTORIZACION' THEN
    IF p_new_status IN ('RETORNO') THEN v_allowed := true; END IF;
  ELSIF v_current_status = 'RETORNO' THEN
    IF p_new_status IN ('RETORNO_COMPLETADO') THEN v_allowed := true; END IF;
  ELSIF v_current_status IN ('RETORNO_COMPLETADO', 'ENTREGADO') THEN
    IF p_new_status IN ('LIQUIDADO', 'CERRADO') THEN v_allowed := true; END IF;
  ELSIF v_current_status = 'LIQUIDADO' THEN
    IF p_new_status = 'CERRADO' THEN v_allowed := true; END IF;
  END IF;

  IF NOT v_allowed THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transición no permitida de ' || v_current_status || ' a ' || p_new_status);
  END IF;

  -- Actualizar estado del despacho
  UPDATE public.dispatches SET status = p_new_status WHERE id = p_dispatch_id;

  -- Registrar en el historial de eventos
  BEGIN
    INSERT INTO public.dispatch_events(
      dispatch_id, event_type, description, created_by
    ) VALUES (
      p_dispatch_id, 
      'STATUS_CHANGE', 
      'Cambio de estado: ' || v_current_status || ' -> ' || p_new_status || COALESCE('. Razón: ' || p_reason, ''),
      COALESCE(p_user_id::text, auth.uid()::text, 'system')
    );
  EXCEPTION WHEN undefined_table THEN
    -- Ignorar si la tabla de eventos no existe para no romper la transición
  END;

  -- Actualizar estado del vehículo si se libera
  IF p_new_status IN ('CERRADO', 'LIQUIDADO') AND v_dispatch.vehicle_plate IS NOT NULL THEN
    BEGIN
      PERFORM public.transition_vehicle_status(
        v_dispatch.vehicle_plate, 
        'DISPONIBLE', 
        'Despacho finalizado (' || p_new_status || ')', 
        COALESCE(p_user_id, auth.uid()), 
        '{}'::jsonb
      );
    EXCEPTION WHEN undefined_function THEN
      -- Fallback si no existe la firma de 5 argumentos
      BEGIN
        PERFORM public.transition_vehicle_status(
          v_dispatch.vehicle_plate, 
          'DISPONIBLE', 
          'Despacho finalizado (' || p_new_status || ')'
        );
      EXCEPTION WHEN OTHERS THEN
        -- Ignorar fallas secundarias
      END;
    WHEN OTHERS THEN
      -- Ignorar otras fallas para no bloquear el flujo principal
    END;
  END IF;

  RETURN jsonb_build_object('success', true, 'previous_status', v_current_status, 'new_status', p_new_status);
END $$;

REVOKE ALL ON FUNCTION public.transition_dispatch_status(uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transition_dispatch_status(uuid, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transition_dispatch_status(uuid, text, text, uuid) TO service_role;

COMMIT;
