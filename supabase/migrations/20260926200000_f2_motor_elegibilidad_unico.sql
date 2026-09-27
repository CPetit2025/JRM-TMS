-- 20260926200000_f2_motor_elegibilidad_unico.sql
-- FASE 2 — Motor central y único de disponibilidad/elegibilidad.
--
-- 1. check_asset_eligibility(plate, context): ÚNICA fuente de reglas. Sin EXCEPTION
--    silenciosos: si una tabla/columna falta, la función falla en vez de aprobar.
-- 2. check_vehicle_eligibility / check_dispatch_eligibility: se conservan como
--    adaptadores (mismo contrato JSON que consume Despacho y schedule_dispatch),
--    pero delegan en el motor único.
-- 3. transition_vehicle_status: una sola implementación (5 args) con permisos,
--    máquina de estados vigente (EN_OPERACION) y compuerta de elegibilidad.
--    La firma de 3 args delega en ella.
-- 4. Guard en vehicles: los roles de cliente (authenticated/anon) no pueden
--    modificar status / is_blocked / block_reason directamente. Solo vía RPC.
-- 5. set_vehicle_administrative_block: bloqueo administrativo auditado.

BEGIN;

-- ------------------------------------------------------------
-- 1. Motor único
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.check_asset_eligibility(text);

CREATE OR REPLACE FUNCTION public.check_asset_eligibility(
  p_plate   text,
  p_context text DEFAULT 'RELEASE'   -- RELEASE | DISPATCH | OPERATION
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vehicle          public.vehicles%ROWTYPE;
  v_motives          jsonb := '[]'::jsonb;
  v_observations     jsonb := '[]'::jsonb;
  v_open_wo          int;
  v_open_faults      int;
  v_active_dispatch  int;
  v_overdue_plans    int;
  v_soat             date;
  v_rt               date;
  v_insurance        date;
  v_expired_other    int;
  v_status           text;
BEGIN
  IF p_context NOT IN ('RELEASE', 'DISPATCH', 'OPERATION') THEN
    RAISE EXCEPTION 'Contexto de elegibilidad inválido: %', p_context;
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE plate = p_plate;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'status', 'NO_APTO', 'eligible', false,
      'motives', jsonb_build_array('Vehículo no encontrado'),
      'observations', '[]'::jsonb, 'checks', '{}'::jsonb);
  END IF;

  -- Bloqueo administrativo
  IF COALESCE(v_vehicle.is_blocked, false) THEN
    v_motives := v_motives || jsonb_build_array(
      'Bloqueo administrativo activo: ' || COALESCE(v_vehicle.block_reason, 'sin motivo registrado'));
  END IF;

  -- Para despachar, la unidad debe estar DISPONIBLE
  IF p_context = 'DISPATCH' AND v_vehicle.status IS DISTINCT FROM 'DISPONIBLE' THEN
    v_motives := v_motives || jsonb_build_array('Unidad no está DISPONIBLE (estado actual: ' || COALESCE(v_vehicle.status, 'N/D') || ')');
  END IF;

  -- OT abierta (una OT solo deja de bloquear al estar CERRADA o CANCELADA)
  SELECT count(*) INTO v_open_wo
  FROM public.maintenance_work_orders
  WHERE vehicle_id = v_vehicle.id
    AND status NOT IN ('CERRADA', 'CANCELADA');
  IF v_open_wo > 0 THEN
    v_motives := v_motives || jsonb_build_array(v_open_wo || ' orden(es) de trabajo abierta(s)');
  END IF;

  -- Falla crítica no resuelta (solicitudes/fallas del backlog)
  SELECT count(*) INTO v_open_faults
  FROM public.maintenance_requests
  WHERE vehicle_plate = p_plate
    AND upper(translate(severity, 'Íí', 'Ii')) = 'CRITICA'
    AND status NOT IN ('CERRADA', 'DESCARTADA', 'CONVERTIDA_OT');
  IF v_open_faults > 0 THEN
    v_motives := v_motives || jsonb_build_array(v_open_faults || ' falla(s) crítica(s) sin resolver');
  END IF;

  -- Preventivo vencido (km, horas o fecha) según la proyección oficial
  SELECT count(*) INTO v_overdue_plans
  FROM public.vw_maintenance_projections
  WHERE vehicle_plate = p_plate AND alert_status = 'VENCIDO';
  IF v_overdue_plans > 0 THEN
    v_motives := v_motives || jsonb_build_array(v_overdue_plans || ' mantenimiento(s) preventivo(s) vencido(s)');
  END IF;

  -- Documentos: el registro en vehicle_documents prevalece sobre los campos del vehículo
  SELECT max(expiration_date) INTO v_soat FROM public.vehicle_documents
  WHERE COALESCE(vehicle_plate, (SELECT plate FROM public.vehicles WHERE id = vehicle_documents.vehicle_id)) = p_plate
    AND document_type = 'SOAT' AND COALESCE(is_active, true);
  v_soat := COALESCE(v_soat, v_vehicle.soat_expiration);

  SELECT max(expiration_date) INTO v_rt FROM public.vehicle_documents
  WHERE COALESCE(vehicle_plate, (SELECT plate FROM public.vehicles WHERE id = vehicle_documents.vehicle_id)) = p_plate
    AND document_type = 'REVISION_TECNICA' AND COALESCE(is_active, true);
  v_rt := COALESCE(v_rt, v_vehicle.technical_review_expiration);

  SELECT max(expiration_date) INTO v_insurance FROM public.vehicle_documents
  WHERE COALESCE(vehicle_plate, (SELECT plate FROM public.vehicles WHERE id = vehicle_documents.vehicle_id)) = p_plate
    AND document_type = 'POLIZA_SEGURO' AND COALESCE(is_active, true);

  -- Equipos no vehiculares (montacargas, apiladores, transpaletas) no requieren SOAT ni RT
  IF v_vehicle.type NOT IN ('MONTACARGAS', 'APILADOR', 'TRANSPALETA') THEN
    IF v_soat IS NULL OR v_soat < CURRENT_DATE THEN
      v_motives := v_motives || jsonb_build_array('SOAT vencido o no registrado');
    ELSIF v_soat <= CURRENT_DATE + 15 THEN
      v_observations := v_observations || jsonb_build_array('SOAT vence el ' || to_char(v_soat, 'DD/MM/YYYY'));
    END IF;

    IF v_rt IS NULL OR v_rt < CURRENT_DATE THEN
      v_motives := v_motives || jsonb_build_array('Revisión técnica vencida o no registrada');
    ELSIF v_rt <= CURRENT_DATE + 15 THEN
      v_observations := v_observations || jsonb_build_array('Revisión técnica vence el ' || to_char(v_rt, 'DD/MM/YYYY'));
    END IF;
  END IF;

  IF v_insurance IS NULL THEN
    v_observations := v_observations || jsonb_build_array('Póliza de seguro no registrada');
  ELSIF v_insurance < CURRENT_DATE THEN
    v_motives := v_motives || jsonb_build_array('Póliza de seguro vencida');
  ELSIF v_insurance <= CURRENT_DATE + 15 THEN
    v_observations := v_observations || jsonb_build_array('Póliza de seguro vence el ' || to_char(v_insurance, 'DD/MM/YYYY'));
  END IF;

  SELECT count(*) INTO v_expired_other FROM public.vehicle_documents
  WHERE COALESCE(vehicle_plate, (SELECT plate FROM public.vehicles WHERE id = vehicle_documents.vehicle_id)) = p_plate
    AND document_type NOT IN ('SOAT', 'REVISION_TECNICA', 'POLIZA_SEGURO')
    AND COALESCE(is_active, true) AND expiration_date < CURRENT_DATE;
  IF v_expired_other > 0 THEN
    v_observations := v_observations || jsonb_build_array(v_expired_other || ' documento(s) adicional(es) vencido(s)');
  END IF;

  -- Lecturas de uso
  IF v_vehicle.type IN ('MONTACARGAS', 'APILADOR', 'TRANSPALETA') THEN
    IF COALESCE(v_vehicle.current_hours, 0) <= 0 THEN
      v_observations := v_observations || jsonb_build_array('Horómetro sin registrar');
    END IF;
  ELSIF COALESCE(v_vehicle.current_odometer, 0) <= 0 THEN
    v_observations := v_observations || jsonb_build_array('Odómetro sin registrar');
  END IF;

  -- Viaje activo (no aplica cuando la transición la origina el propio flujo de despacho)
  IF p_context <> 'OPERATION' THEN
    SELECT count(*) INTO v_active_dispatch
    FROM public.dispatches
    WHERE vehicle_plate = p_plate
      AND status NOT IN ('CERRADO', 'LIQUIDADO', 'CANCELADO', 'RETORNO_COMPLETADO');
    IF v_active_dispatch > 0 THEN
      v_motives := v_motives || jsonb_build_array('Tiene un viaje/despacho activo');
    END IF;
  END IF;

  v_status := CASE
    WHEN jsonb_array_length(v_motives) > 0 THEN 'NO_APTO'
    WHEN jsonb_array_length(v_observations) > 0 THEN 'APTO_CON_OBSERVACION'
    ELSE 'APTO' END;

  RETURN jsonb_build_object(
    'status', v_status,
    'eligible', v_status <> 'NO_APTO',
    'motives', v_motives,
    'observations', v_observations,
    'vehicle_status', v_vehicle.status,
    'checks', jsonb_build_object(
      'no_admin_block', NOT COALESCE(v_vehicle.is_blocked, false),
      'no_open_work_orders', v_open_wo = 0,
      'no_critical_faults', v_open_faults = 0,
      'no_overdue_preventive', v_overdue_plans = 0,
      'soat_ok', v_vehicle.type IN ('MONTACARGAS', 'APILADOR', 'TRANSPALETA') OR (v_soat IS NOT NULL AND v_soat >= CURRENT_DATE),
      'rt_ok', v_vehicle.type IN ('MONTACARGAS', 'APILADOR', 'TRANSPALETA') OR (v_rt IS NOT NULL AND v_rt >= CURRENT_DATE),
      'insurance_ok', v_insurance IS NULL OR v_insurance >= CURRENT_DATE,
      'no_active_dispatch', COALESCE(v_active_dispatch, 0) = 0
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.check_asset_eligibility(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_asset_eligibility(text, text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 2. Adaptador para Despacho (contrato JSON existente)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_vehicle_eligibility(
  p_vehicle_plate     text,
  p_required_capacity numeric DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result   jsonb;
  v_blocking jsonb;
  v_capacity numeric;
BEGIN
  v_result   := public.check_asset_eligibility(p_vehicle_plate, 'DISPATCH');
  v_blocking := v_result->'motives';

  IF p_required_capacity IS NOT NULL AND p_required_capacity > 0 THEN
    SELECT COALESCE(weight_capacity, capacity_weight) INTO v_capacity
    FROM public.vehicles WHERE plate = p_vehicle_plate;
    IF v_capacity IS NOT NULL AND v_capacity < p_required_capacity THEN
      v_blocking := v_blocking || jsonb_build_array('Capacidad insuficiente (' || v_capacity || ' < ' || p_required_capacity || ')');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'eligible', jsonb_array_length(v_blocking) = 0,
    'status', CASE
      WHEN jsonb_array_length(v_blocking) > 0 THEN 'BLOQUEADO'
      WHEN jsonb_array_length(v_result->'observations') > 0 THEN 'APTO_CON_OBSERVACION'
      ELSE 'APTO' END,
    'asset_status', CASE WHEN jsonb_array_length(v_blocking) > 0 THEN 'NO_APTO' ELSE v_result->>'status' END,
    'blocking_reasons', v_blocking,
    'observation_reasons', v_result->'observations',
    'reason', (SELECT string_agg(value, '; ') FROM jsonb_array_elements_text(v_blocking)),
    'vehicle_status', v_result->>'vehicle_status',
    'checks', v_result->'checks'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.check_vehicle_eligibility(text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_vehicle_eligibility(text, numeric) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 3. Transición de estado única
-- ------------------------------------------------------------
-- La firma de 5 argumentos NO lleva valores por defecto: con defaults, cualquier
-- llamada de 2-3 argumentos era ambigua frente a la firma de 3 (error 42725).
DROP FUNCTION IF EXISTS public.transition_vehicle_status(text, text, text, uuid, jsonb);

CREATE FUNCTION public.transition_vehicle_status(
  p_vehicle_plate text,
  p_new_status    text,
  p_reason        text,
  p_user_id       uuid,
  p_metadata      jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current     text;
  v_actor       uuid := COALESCE(auth.uid(), p_user_id);
  v_is_system   boolean := auth.uid() IS NULL;   -- service_role / procesos internos
  v_is_admin    boolean;
  v_is_manager  boolean;
  v_allowed     text[];
  v_eligibility jsonb;
BEGIN
  v_is_admin   := v_is_system OR public.has_tms_permission('admin');
  v_is_manager := v_is_admin
                  OR public.has_tms_permission('mantenimiento')
                  OR public.has_tms_permission('despacho');

  IF p_new_status NOT IN ('DISPONIBLE', 'ASIGNADA', 'EN_OPERACION', 'OBSERVADA',
                          'MANTENIMIENTO', 'BLOQUEADA', 'FUERA_DE_SERVICIO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Estado no válido: ' || COALESCE(p_new_status, 'NULL'));
  END IF;

  -- Permisos
  IF NOT v_is_manager AND p_new_status NOT IN ('BLOQUEADA', 'OBSERVADA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso: solo puede reportar la unidad como OBSERVADA o BLOQUEADA');
  END IF;
  IF p_new_status = 'FUERA_DE_SERVICIO' AND NOT v_is_admin THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo un administrador puede dar de baja (FUERA_DE_SERVICIO)');
  END IF;

  SELECT status INTO v_current FROM public.vehicles WHERE plate = p_vehicle_plate FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehículo no encontrado: ' || p_vehicle_plate);
  END IF;

  IF v_current = p_new_status THEN
    RETURN jsonb_build_object('success', true, 'previous_status', v_current, 'new_status', p_new_status, 'unchanged', true);
  END IF;

  v_allowed := CASE v_current
    WHEN 'DISPONIBLE'        THEN ARRAY['ASIGNADA','EN_OPERACION','OBSERVADA','MANTENIMIENTO','BLOQUEADA','FUERA_DE_SERVICIO']
    WHEN 'ASIGNADA'          THEN ARRAY['EN_OPERACION','DISPONIBLE','OBSERVADA','MANTENIMIENTO','BLOQUEADA']
    WHEN 'EN_OPERACION'      THEN ARRAY['DISPONIBLE','ASIGNADA','OBSERVADA','MANTENIMIENTO','BLOQUEADA']
    WHEN 'OBSERVADA'         THEN ARRAY['DISPONIBLE','MANTENIMIENTO','BLOQUEADA','FUERA_DE_SERVICIO']
    WHEN 'MANTENIMIENTO'     THEN ARRAY['DISPONIBLE','OBSERVADA','BLOQUEADA','FUERA_DE_SERVICIO']
    WHEN 'BLOQUEADA'         THEN ARRAY['DISPONIBLE','MANTENIMIENTO','OBSERVADA','FUERA_DE_SERVICIO']
    WHEN 'FUERA_DE_SERVICIO' THEN ARRAY['DISPONIBLE','OBSERVADA','MANTENIMIENTO']
    ELSE ARRAY[]::text[] END;

  IF NOT (p_new_status = ANY (v_allowed)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transición no permitida: ' || v_current || ' → ' || p_new_status);
  END IF;

  -- Compuerta de elegibilidad: liberar o poner en operación exige que no sea NO_APTO
  IF p_new_status IN ('DISPONIBLE', 'ASIGNADA', 'EN_OPERACION') THEN
    v_eligibility := public.check_asset_eligibility(
      p_vehicle_plate,
      CASE WHEN p_new_status = 'DISPONIBLE' THEN 'RELEASE' ELSE 'OPERATION' END);
    IF v_eligibility->>'status' = 'NO_APTO' THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Unidad NO_APTO: ' || (SELECT string_agg(value, '; ') FROM jsonb_array_elements_text(v_eligibility->'motives')),
        'eligibility', v_eligibility);
    END IF;
  END IF;

  UPDATE public.vehicles SET status = p_new_status WHERE plate = p_vehicle_plate;

  INSERT INTO public.vehicle_history_logs (vehicle_plate, changed_by, field_changed, old_value, new_value, change_reason)
  VALUES (p_vehicle_plate, v_actor, 'status', v_current, p_new_status,
          NULLIF(concat_ws(' | ', p_reason,
                 CASE WHEN p_metadata IS NOT NULL AND p_metadata <> '{}'::jsonb THEN p_metadata::text END,
                 CASE WHEN v_eligibility IS NOT NULL THEN 'elegibilidad=' || (v_eligibility->>'status') END), ''));

  RETURN jsonb_build_object('success', true, 'previous_status', v_current, 'new_status', p_new_status,
                            'eligibility', v_eligibility);
END;
$$;

CREATE OR REPLACE FUNCTION public.transition_vehicle_status(
  p_vehicle_plate text,
  p_new_status    text,
  p_reason        text DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.transition_vehicle_status(p_vehicle_plate, p_new_status, p_reason, auth.uid(), '{}'::jsonb);
$$;

REVOKE ALL ON FUNCTION public.transition_vehicle_status(text, text, text, uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.transition_vehicle_status(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transition_vehicle_status(text, text, text, uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.transition_vehicle_status(text, text, text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 4. Bloqueo administrativo auditado
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_vehicle_administrative_block(
  p_vehicle_plate text,
  p_blocked       boolean,
  p_reason        text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vehicle public.vehicles%ROWTYPE;
  v_result  jsonb;
BEGIN
  IF auth.uid() IS NOT NULL
     AND NOT (public.has_tms_permission('admin') OR public.has_tms_permission('mantenimiento')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para bloqueos administrativos');
  END IF;
  IF p_blocked AND NULLIF(trim(p_reason), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'El bloqueo administrativo requiere un motivo');
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE plate = p_vehicle_plate FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehículo no encontrado: ' || p_vehicle_plate);
  END IF;

  UPDATE public.vehicles
  SET is_blocked = p_blocked,
      block_reason = CASE WHEN p_blocked THEN p_reason ELSE NULL END
  WHERE plate = p_vehicle_plate;

  INSERT INTO public.vehicle_history_logs (vehicle_plate, changed_by, field_changed, old_value, new_value, change_reason)
  VALUES (p_vehicle_plate, auth.uid(), 'is_blocked', COALESCE(v_vehicle.is_blocked, false)::text, p_blocked::text, p_reason);

  -- Bloquear también saca la unidad de servicio operativo
  IF p_blocked AND v_vehicle.status NOT IN ('BLOQUEADA', 'FUERA_DE_SERVICIO') THEN
    v_result := public.transition_vehicle_status(p_vehicle_plate, 'BLOQUEADA', 'Bloqueo administrativo: ' || p_reason);
  END IF;

  RETURN jsonb_build_object('success', true, 'is_blocked', p_blocked, 'transition', v_result);
END;
$$;

REVOKE ALL ON FUNCTION public.set_vehicle_administrative_block(text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_vehicle_administrative_block(text, boolean, text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 5. Guard: nadie cambia el estado sin pasar por el motor
--    Las funciones SECURITY DEFINER corren como su dueño, por lo que
--    current_user solo es authenticated/anon en escrituras directas vía API.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_vehicle_status_changes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Toda unidad nueva ingresa OBSERVADA y se libera con transition_vehicle_status
    NEW.status       := 'OBSERVADA';
    NEW.is_blocked   := false;
    NEW.block_reason := NULL;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'El estado del vehículo solo puede cambiarse con transition_vehicle_status()'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.is_blocked IS DISTINCT FROM OLD.is_blocked OR NEW.block_reason IS DISTINCT FROM OLD.block_reason THEN
    RAISE EXCEPTION 'El bloqueo administrativo solo puede cambiarse con set_vehicle_administrative_block()'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_vehicle_status ON public.vehicles;
CREATE TRIGGER trg_guard_vehicle_status
BEFORE INSERT OR UPDATE ON public.vehicles
FOR EACH ROW
EXECUTE FUNCTION public.guard_vehicle_status_changes();

NOTIFY pgrst, 'reload schema';

COMMIT;
