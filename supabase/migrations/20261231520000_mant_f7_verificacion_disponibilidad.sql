-- Mantenimiento fase 7 (20-11-2026): verificación y disponibilidad (decisión 3 del diagnóstico).
-- * Soporte Mecánico diagnostica y ejecuta; el Jefe de Distribución (permiso nuevo mantenimiento-liberacion; el
--   Administrador lo tiene por rol) autoriza presupuestos, verifica (VALIDACION) y cierra/libera.
-- * VALIDACION obligatoria: complete_maintenance_order solo cierra una OT en VALIDACION (antes aceptaba TERMINADA y
--   grababa como validador a quien cerraba). Ni la verificación ni el cierre los hace quien ejecutó la OT (mecánico
--   asignado o quien la inició, reanudó o terminó).
-- * Liberación: solo con elegibilidad APTO. «Apto con observación» deja la unidad OBSERVADA hasta que el Jefe la libere;
--   pasar a DISPONIBLE desde MANTENIMIENTO/BLOQUEADA/OBSERVADA/FUERA_DE_SERVICIO requiere ese permiso.
-- * Fin técnico (finished_at) separado del cierre; el cumplimiento preventivo y el plan usan el fin técnico.
-- * get_cmms_kpis: indisponibilidad por intervalos únicos (OT + estados BLOQUEADA/OBSERVADA/MANTENIMIENTO, fusionados),
--   periodo recortado a ahora, unidades activas; MTTR sin esperas; MTBF solo fallas funcionales (la unidad no pudo
--   continuar o severidad crítica); % preventivo = cumplimiento a tiempo contra el vencimiento original.
-- Producción no coincide con las migraciones: las funciones reemplazadas parten de su definición viva.
BEGIN;

-- ------------------------------------------------------------
-- 1. Rol y permiso
-- ------------------------------------------------------------
UPDATE public.roles
SET permissions = (SELECT jsonb_agg(DISTINCT p) FROM jsonb_array_elements(COALESCE(permissions, '[]'::jsonb)
                   || '["mantenimiento-liberacion","mantenimiento-ot:read","mantenimiento-flota:read","mantenimiento-dashboard:read"]'::jsonb) p)
WHERE name = 'Jefe de Distribución';

-- El Jefe de Distribución gestiona el estado de la unidad al liberarla
CREATE OR REPLACE FUNCTION public.can_manage_fleet_status()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT auth.uid() IS NULL
      OR public.is_tms_admin()
      OR public.has_tms_permission('mantenimiento-flota')
      OR public.has_tms_permission('mantenimiento-ot')
      OR public.has_tms_permission('despacho')
      OR public.has_tms_permission('mantenimiento-liberacion');
$$;

-- Quienes ejecutaron la OT: mecánico asignado y quien la inició, reanudó o terminó (no cuenta el rechazo del verificador)
CREATE OR REPLACE FUNCTION public.work_order_executors(p_work_order_id uuid)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(array_agg(DISTINCT x) FILTER (WHERE x IS NOT NULL), '{}'::uuid[]) FROM (
    SELECT mechanic_id AS x FROM public.maintenance_work_orders WHERE id = p_work_order_id
    UNION ALL
    SELECT e.created_by FROM public.maintenance_work_order_events e
    WHERE e.work_order_id = p_work_order_id AND e.evento = 'ESTADO' AND e.estado_nuevo IN ('EN_PROCESO', 'TERMINADA')
      AND e.estado_anterior IS DISTINCT FROM 'VALIDACION'
  ) s;
$$;
REVOKE ALL ON FUNCTION public.work_order_executors(uuid) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 2. Transiciones de la OT
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transition_work_order(p_work_order_id uuid, p_new_status text, p_notes text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_wo       public.maintenance_work_orders%ROWTYPE;
  v_allowed  text[];
  v_vehicle  public.vehicles%ROWTYPE;
  v_start    timestamptz;
  v_vres     jsonb;
  v_verifier boolean := auth.uid() IS NULL OR public.has_tms_permission('mantenimiento-liberacion');
BEGIN
  SELECT * INTO v_wo FROM public.maintenance_work_orders WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT no encontrada');
  END IF;
  IF auth.uid() IS NOT NULL AND NOT (public.has_cmms_permission('ot')
     OR (v_verifier AND (p_new_status = 'VALIDACION' OR (v_wo.status = 'VALIDACION' AND p_new_status = 'EN_PROCESO')))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para gestionar OT');
  END IF;
  IF auth.uid() IS NOT NULL AND NOT public.can_access_site(v_wo.site_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT fuera de su sede');
  END IF;
  IF p_new_status = 'CERRADA' THEN
    RETURN jsonb_build_object('success', false, 'error', 'El cierre se realiza con complete_maintenance_order()');
  END IF;
  IF p_new_status = 'EN_ESPERA' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Registre la espera con su motivo (work_order_wait_start)');
  END IF;

  v_allowed := CASE v_wo.status
    WHEN 'BORRADOR'   THEN ARRAY['APROBADA', 'CANCELADA']
    WHEN 'APROBADA'   THEN ARRAY['PROGRAMADA', 'EN_PROCESO', 'CANCELADA']
    WHEN 'PROGRAMADA' THEN ARRAY['EN_PROCESO', 'CANCELADA']
    WHEN 'EN_PROCESO' THEN ARRAY['TERMINADA']
    WHEN 'EN_ESPERA'  THEN ARRAY['EN_PROCESO', 'CANCELADA']
    WHEN 'TERMINADA'  THEN ARRAY['VALIDACION', 'EN_PROCESO']
    WHEN 'VALIDACION' THEN ARRAY['EN_PROCESO']
    ELSE ARRAY[]::text[] END;

  IF NOT (p_new_status = ANY (v_allowed)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transición no permitida: ' || v_wo.status || ' → ' || COALESCE(p_new_status, 'NULL'));
  END IF;
  IF p_new_status = 'CANCELADA' AND NULLIF(trim(p_notes), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cancelar requiere un motivo');
  END IF;
  IF p_new_status = 'PROGRAMADA' AND v_wo.start_date IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Defina la fecha de inicio antes de programar');
  END IF;
  IF p_new_status = 'TERMINADA' AND NULLIF(trim(COALESCE(p_notes, v_wo.activities_performed)), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Registre las actividades realizadas');
  END IF;
  IF p_new_status = 'VALIDACION' THEN
    IF NOT v_verifier THEN
      RETURN jsonb_build_object('success', false, 'error', 'La verificación la hace el Jefe de Distribución');
    END IF;
    IF auth.uid() = ANY (public.work_order_executors(v_wo.id)) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Quien ejecutó la OT no puede verificarla');
    END IF;
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = v_wo.vehicle_id;

  -- Inicio de trabajos ⇒ la unidad sale de servicio y empieza la indisponibilidad
  IF p_new_status = 'EN_PROCESO' AND v_wo.downtime_start IS NULL THEN
    SELECT min(reported_at) INTO v_start FROM public.maintenance_requests
    WHERE work_order_id = v_wo.id AND severity = 'CRITICA';
    v_start := LEAST(COALESCE(v_start, now()), now());
    IF v_vehicle.status NOT IN ('MANTENIMIENTO', 'FUERA_DE_SERVICIO') THEN
      v_vres := public.transition_vehicle_status(v_vehicle.plate, 'MANTENIMIENTO',
                  'Inicio OT ' || v_wo.ot_code, auth.uid(), jsonb_build_object('work_order_id', v_wo.id));
    END IF;
  END IF;

  -- Esperas: reanudar, terminar, cancelar o verificar cierra la abierta (la de verificación termina al validar)
  PERFORM public.work_order_wait_close(v_wo.id, auth.uid());

  UPDATE public.maintenance_work_orders SET
    status               = p_new_status,
    approved_by          = CASE WHEN p_new_status = 'APROBADA' THEN auth.uid() ELSE approved_by END,
    approved_at          = CASE WHEN p_new_status = 'APROBADA' THEN now() ELSE approved_at END,
    validated_by         = CASE WHEN p_new_status = 'VALIDACION' THEN auth.uid() WHEN p_new_status = 'EN_PROCESO' THEN NULL ELSE validated_by END,
    validated_at         = CASE WHEN p_new_status = 'VALIDACION' THEN now() WHEN p_new_status = 'EN_PROCESO' THEN NULL ELSE validated_at END,
    -- Fin técnico: lo fija TERMINADA (work_order_provider_lifecycle); un retrabajo lo reinicia
    finished_at          = CASE WHEN p_new_status = 'EN_PROCESO' THEN NULL ELSE finished_at END,
    executed_odometer    = CASE WHEN p_new_status = 'TERMINADA' THEN v_vehicle.current_odometer WHEN p_new_status = 'EN_PROCESO' THEN NULL ELSE executed_odometer END,
    executed_hours       = CASE WHEN p_new_status = 'TERMINADA' THEN v_vehicle.current_hours WHEN p_new_status = 'EN_PROCESO' THEN NULL ELSE executed_hours END,
    downtime_start       = COALESCE(downtime_start, v_start),
    downtime_end         = CASE WHEN p_new_status = 'CANCELADA' AND downtime_start IS NOT NULL THEN now() ELSE downtime_end END,
    activities_performed = CASE WHEN p_new_status = 'TERMINADA' THEN COALESCE(NULLIF(trim(p_notes), ''), activities_performed) ELSE activities_performed END,
    cancel_reason        = CASE WHEN p_new_status = 'CANCELADA' THEN p_notes ELSE cancel_reason END,
    notes                = CASE WHEN p_notes IS NOT NULL AND p_new_status NOT IN ('TERMINADA', 'CANCELADA')
                                THEN concat_ws(E'\n', notes, to_char(now() AT TIME ZONE 'America/Lima', 'DD/MM HH24:MI') || ' ' || p_new_status || ': ' || p_notes)
                                ELSE notes END
  WHERE id = p_work_order_id;

  -- Fin técnico ⇒ espera de verificación hasta que el Jefe de Distribución valide
  IF p_new_status = 'TERMINADA' THEN
    INSERT INTO public.maintenance_work_order_waits (work_order_id, reason, notes, created_by)
    VALUES (v_wo.id, 'VERIFICACION', 'Fin técnico: espera la verificación del Jefe de Distribución', auth.uid());
  END IF;

  RETURN jsonb_build_object('success', true, 'previous_status', v_wo.status, 'new_status', p_new_status,
                            'vehicle_transition', v_vres);
END $$;

-- ------------------------------------------------------------
-- 3. Cierre: solo desde VALIDACION, por el Jefe de Distribución y nunca por quien ejecutó
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_maintenance_order(p_order_id uuid, p_used_parts jsonb DEFAULT '[]'::jsonb, p_closing_notes text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_wo          public.maintenance_work_orders%ROWTYPE;
  v_vehicle     public.vehicles%ROWTYPE;
  v_actor       uuid := auth.uid();
  v_exec        uuid[];
  v_part        jsonb;
  v_res         jsonb;
  v_eligibility jsonb;
  v_release     jsonb;
  v_message     text;
  v_end         timestamptz;
  v_odo         numeric;
  v_hours       numeric;
  v_compliance  text;
BEGIN
  IF v_actor IS NOT NULL AND NOT public.has_tms_permission('mantenimiento-liberacion') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el Jefe de Distribución verifica, cierra y libera la OT');
  END IF;

  SELECT * INTO v_wo FROM public.maintenance_work_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Orden de trabajo no encontrada');
  END IF;
  IF v_actor IS NOT NULL AND NOT public.can_access_site(v_wo.site_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT fuera de su sede');
  END IF;
  IF v_wo.status <> 'VALIDACION' THEN
    RETURN jsonb_build_object('success', false, 'error',
      'La OT debe estar verificada (VALIDACION) por el Jefe de Distribución antes de cerrarse (estado actual: ' || v_wo.status || ')');
  END IF;
  IF v_actor IS NOT NULL THEN
    v_exec := public.work_order_executors(v_wo.id);
    IF v_actor = ANY (v_exec) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Quien ejecutó la OT no puede cerrarla ni liberar la unidad');
    END IF;
    IF v_wo.validated_by IS NULL OR v_wo.validated_by = ANY (v_exec) THEN
      RETURN jsonb_build_object('success', false, 'error', 'La verificación debe hacerla una persona distinta de quien ejecutó la OT');
    END IF;
  END IF;

  -- Repuestos declarados al cierre (misma ruta única de stock)
  FOR v_part IN SELECT * FROM jsonb_array_elements(COALESCE(p_used_parts, '[]'::jsonb)) LOOP
    v_res := public.consume_work_order_part(p_order_id, (v_part->>'part_id')::uuid,
                                            (v_part->>'quantity')::numeric, 'Declarado al cierre');
    IF NOT (v_res->>'success')::boolean THEN
      RAISE EXCEPTION 'No se pudo registrar el repuesto %: %', v_part->>'part_id', v_res->>'error';
    END IF;
  END LOOP;
  PERFORM public.work_order_wait_close(v_wo.id, v_actor);

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = v_wo.vehicle_id;
  v_end   := COALESCE(v_wo.finished_at, now());
  v_odo   := COALESCE(v_wo.executed_odometer, v_vehicle.current_odometer);
  v_hours := COALESCE(v_wo.executed_hours, v_vehicle.current_hours);
  -- Cumplimiento contra el vencimiento original (vence lo primero: fecha, km u horas)
  IF v_wo.due_date IS NOT NULL OR v_wo.due_km IS NOT NULL OR v_wo.due_hours IS NOT NULL THEN
    v_compliance := CASE WHEN (v_wo.due_date IS NULL OR (v_end AT TIME ZONE 'America/Lima')::date <= v_wo.due_date)
                           AND (v_wo.due_km IS NULL OR COALESCE(v_odo, 0) <= v_wo.due_km)
                           AND (v_wo.due_hours IS NULL OR COALESCE(v_hours, 0) <= v_wo.due_hours)
                         THEN 'A_TIEMPO' ELSE 'TARDE' END;
  END IF;

  UPDATE public.maintenance_work_orders SET
    status                = 'CERRADA',
    closed_at             = now(),
    closed_by             = v_actor,
    actual_end_date       = COALESCE(actual_end_date, (v_end AT TIME ZONE 'America/Lima')::date),
    downtime_end          = CASE WHEN downtime_start IS NOT NULL THEN now() ELSE downtime_end END,
    executed_odometer     = v_odo,
    executed_hours        = v_hours,
    preventive_compliance = v_compliance,
    notes                 = concat_ws(E'\n', notes, NULLIF('Cierre: ' || COALESCE(p_closing_notes, ''), 'Cierre: '))
  WHERE id = p_order_id;
  -- (trg_sync_requests_with_work_order cierra las fallas de origen)

  -- El plan sigue desde la ejecución real (fin técnico y su lectura), no desde la fecha de cierre
  IF v_wo.plan_id IS NOT NULL THEN
    UPDATE public.maintenance_plans SET
      last_performed_date     = (v_end AT TIME ZONE 'America/Lima')::date,
      last_performed_km       = v_odo,
      last_performed_odometer = v_odo,
      last_performed_hours    = round(v_hours)
    WHERE id = v_wo.plan_id;
  END IF;

  -- Liberación: solo APTO libera; «apto con observación» queda OBSERVADA hasta la liberación del Jefe
  v_eligibility := public.check_asset_eligibility(v_vehicle.plate, 'RELEASE');
  IF v_vehicle.status IN ('MANTENIMIENTO', 'BLOQUEADA', 'OBSERVADA') THEN
    IF v_eligibility->>'status' = 'APTO' THEN
      v_release := public.transition_vehicle_status(v_vehicle.plate, 'DISPONIBLE',
                     'Cierre OT ' || v_wo.ot_code, v_actor, jsonb_build_object('work_order_id', v_wo.id));
      v_message := CASE WHEN COALESCE((v_release->>'success')::boolean, false)
                        THEN 'OT cerrada. Unidad liberada (APTO).'
                        ELSE 'OT cerrada. No se pudo liberar la unidad: ' || (v_release->>'error') END;
    ELSIF v_eligibility->>'status' = 'APTO_CON_OBSERVACION' THEN
      IF v_vehicle.status <> 'OBSERVADA' THEN
        v_release := public.transition_vehicle_status(v_vehicle.plate, 'OBSERVADA',
                       'Cierre OT ' || v_wo.ot_code || ': apto con observación', v_actor, jsonb_build_object('work_order_id', v_wo.id));
      END IF;
      v_message := 'OT cerrada. Unidad apta con observación: queda OBSERVADA hasta que el Jefe de Distribución la libere ('
                   || COALESCE((SELECT string_agg(value, '; ') FROM jsonb_array_elements_text(v_eligibility->'observations')), 'ver elegibilidad') || ').';
    ELSE
      v_message := 'OT cerrada. La unidad sigue NO_APTO: '
                   || COALESCE((SELECT string_agg(value, '; ') FROM jsonb_array_elements_text(v_eligibility->'motives')), '');
    END IF;
  ELSE
    v_message := 'OT cerrada. Estado de la unidad sin cambios (' || v_vehicle.status || ').';
  END IF;

  UPDATE public.maintenance_work_orders
  SET release_result = jsonb_build_object('eligibility', v_eligibility, 'transition', v_release)
  WHERE id = p_order_id;

  RETURN jsonb_build_object('success', true, 'message', v_message, 'preventive_compliance', v_compliance,
                            'eligibility', v_eligibility, 'vehicle_transition', v_release);
END $$;

-- ------------------------------------------------------------
-- 4. Liberación manual y presupuesto: Jefe de Distribución
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transition_vehicle_status(p_vehicle_plate text, p_new_status text, p_reason text, p_user_id uuid, p_metadata jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_current     text;
  v_actor       uuid := COALESCE(auth.uid(), p_user_id);
  v_is_system   boolean := auth.uid() IS NULL;   -- service_role / procesos internos
  v_is_admin    boolean;
  v_is_manager  boolean;
  v_allowed     text[];
  v_eligibility jsonb;
BEGIN
  -- The AFTER INSERT trigger sees its authorized critical report; direct RPCs have depth zero.
  IF pg_trigger_depth()>0 AND p_new_status='BLOQUEADA' AND EXISTS(
    SELECT 1 FROM public.maintenance_requests r JOIN public.vehicles v ON v.plate=r.vehicle_plate
    WHERE r.vehicle_plate=p_vehicle_plate AND r.severity='CRITICA' AND r.status NOT IN ('CERRADA','DESCARTADA')
     AND r.reported_by=auth.uid() AND public.security_can_inspect_equipment(v.id)) THEN
    PERFORM public.security_assert_active_session();
  ELSE
    PERFORM public.security_assert_vehicle(p_vehicle_plate,true);
  END IF;
  v_is_admin   := v_is_system OR public.is_tms_admin();
  v_is_manager := v_is_admin OR public.can_manage_fleet_status();

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

  -- Fase 7: tras una OT o un bloqueo, solo el Jefe de Distribución (o Administración) libera la unidad
  IF p_new_status = 'DISPONIBLE' AND v_current IN ('MANTENIMIENTO', 'BLOQUEADA', 'OBSERVADA', 'FUERA_DE_SERVICIO')
     AND NOT v_is_admin AND NOT public.has_tms_permission('mantenimiento-liberacion') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el Jefe de Distribución verifica y libera una unidad en ' || v_current);
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
$fn$;

CREATE OR REPLACE FUNCTION public.decide_work_order_budget(p_request_id uuid, p_decision text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_request public.maintenance_work_order_budget_requests%ROWTYPE;
  v_order public.maintenance_work_orders%ROWTYPE;
  v_decision text := upper(btrim(p_decision));
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_tms_permission('mantenimiento-liberacion') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el Jefe de Distribución o Administración autorizan presupuestos de OT');
  END IF;
  SELECT * INTO v_request FROM public.maintenance_work_order_budget_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR v_request.status <> 'PENDIENTE' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solicitud de presupuesto inexistente o ya decidida');
  END IF;
  SELECT * INTO v_order FROM public.maintenance_work_orders WHERE id = v_request.work_order_id FOR UPDATE;
  IF auth.uid() IS NOT NULL AND NOT public.can_access_site(v_order.site_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT fuera de su sede');
  END IF;
  IF auth.uid() IS NOT NULL AND NOT public.is_tms_admin() AND v_request.requested_by = auth.uid() THEN
    RETURN jsonb_build_object('success', false, 'error', 'La persona solicitante no puede aprobar su propia solicitud');
  END IF;
  IF v_decision NOT IN ('APROBADA', 'RECHAZADA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Decisión inválida');
  END IF;
  IF v_decision = 'RECHAZADA' AND NULLIF(btrim(p_notes), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'El rechazo requiere sustento');
  END IF;
  IF v_decision = 'APROBADA' AND v_request.budget_amount < COALESCE(v_order.total_cost, 0) THEN
    RETURN jsonb_build_object('success', false, 'error', 'El costo real ya supera el monto solicitado');
  END IF;
  IF v_decision = 'APROBADA' THEN
    UPDATE public.maintenance_work_order_budget_requests SET status = 'SUPERADA'
    WHERE work_order_id = v_order.id AND status = 'APROBADA';
  END IF;
  UPDATE public.maintenance_work_order_budget_requests SET
    status = v_decision, decided_by = auth.uid(), decided_at = now(), decision_notes = NULLIF(btrim(p_notes), '')
  WHERE id = v_request.id;
  INSERT INTO public.maintenance_work_order_events (work_order_id, evento, detalle, metadata, created_by)
  VALUES (v_order.id, 'PRESUPUESTO_' || v_decision,
    'Versión ' || v_request.version || ' · S/ ' || to_char(v_request.budget_amount, 'FM999,999,990.00') || COALESCE(' · ' || NULLIF(btrim(p_notes), ''), ''),
    jsonb_build_object('budget_request_id', v_request.id, 'version', v_request.version, 'amount', v_request.budget_amount), auth.uid());
  RETURN jsonb_build_object('success', true, 'status', v_decision, 'version', v_request.version);
END;
$fn$;

-- ------------------------------------------------------------
-- 5. Indicadores CMMS
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_cmms_kpis(p_start date, p_end date, p_plates text[] DEFAULT NULL::text[])
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_period tstzrange;
  v_hours  numeric;
  v_today  date := (now() AT TIME ZONE 'America/Lima')::date;
  v_result jsonb;
BEGIN
  IF p_end < p_start THEN
    RAISE EXCEPTION 'Periodo inválido';
  END IF;
  -- Solo el tiempo transcurrido: las horas futuras del periodo no son disponibilidad
  v_period := tstzrange((p_start::timestamp AT TIME ZONE 'America/Lima'),
                        GREATEST((p_start::timestamp AT TIME ZONE 'America/Lima'), LEAST(((p_end + 1)::timestamp AT TIME ZONE 'America/Lima'), now())), '[)');
  v_hours := NULLIF(extract(epoch FROM upper(v_period) - lower(v_period)) / 3600.0, 0);

  WITH units AS (
    SELECT v.id, v.plate, v.type, v.status, v.criticality, v.ownership_status
    FROM public.vehicles v
    WHERE v.status <> 'FUERA_DE_SERVICIO' AND COALESCE(v.is_active, true) AND (p_plates IS NULL OR v.plate = ANY (p_plates))
  ),
  -- Estados de la unidad en el tiempo (bitácora de transition_vehicle_status)
  st AS (
    SELECT u.id AS vehicle_id, l.new_value AS status, l.created_at AS s,
           lead(l.created_at) OVER (PARTITION BY l.vehicle_plate ORDER BY l.created_at, l.id) AS e
    FROM units u JOIN public.vehicle_history_logs l ON l.vehicle_plate = u.plate AND l.field_changed = 'status'
  ),
  -- Indisponibilidad: OT con trabajos iniciados + unidad BLOQUEADA/OBSERVADA/MANTENIMIENTO aunque no tenga OT
  ranges AS (
    SELECT wo.vehicle_id, tstzrange(wo.downtime_start, COALESCE(wo.downtime_end, now()), '[)') AS r
    FROM public.maintenance_work_orders wo JOIN units u ON u.id = wo.vehicle_id
    WHERE wo.downtime_start IS NOT NULL AND wo.status <> 'CANCELADA' AND COALESCE(wo.downtime_end, now()) > wo.downtime_start
    UNION ALL
    SELECT vehicle_id, tstzrange(s, COALESCE(e, now()), '[)') FROM st
    WHERE status IN ('BLOQUEADA', 'OBSERVADA', 'MANTENIMIENTO') AND COALESCE(e, now()) > s
    UNION ALL
    -- Unidad hoy fuera de servicio sin bitácora de estado: desde el inicio del periodo
    SELECT u.id, v_period FROM units u
    WHERE u.status IN ('BLOQUEADA', 'OBSERVADA', 'MANTENIMIENTO')
      AND NOT EXISTS (SELECT 1 FROM public.vehicle_history_logs l WHERE l.vehicle_plate = u.plate AND l.field_changed = 'status')
  ),
  dt AS (
    SELECT vehicle_id, range_agg(r) * tstzmultirange(v_period) AS mr FROM ranges WHERE NOT isempty(r) GROUP BY vehicle_id
  ),
  dth AS (
    SELECT dt.vehicle_id, COALESCE(sum(extract(epoch FROM upper(r) - lower(r))) / 3600.0, 0) AS hours
    FROM dt LEFT JOIN LATERAL unnest(dt.mr) r ON true GROUP BY dt.vehicle_id
  ),
  -- Fallas funcionales: la unidad no pudo continuar o la falla es crítica
  fails AS (
    SELECT u.id AS vehicle_id,
           count(r.id) FILTER (WHERE r.can_continue = false OR r.severity = 'CRITICA') AS failures,
           count(r.id) AS reported
    FROM units u JOIN public.maintenance_requests r ON r.vehicle_plate = u.plate
    WHERE r.status <> 'DESCARTADA' AND r.reported_at <@ v_period
    GROUP BY u.id
  ),
  usage AS (
    SELECT u.id AS vehicle_id,
           COALESCE(max(l.odometer_value) - min(l.odometer_value), 0) AS km,
           COALESCE(max(l.hours_value) - min(l.hours_value), 0) AS op_hours
    FROM units u JOIN public.vehicle_odometer_logs l ON l.vehicle_plate = u.plate
    WHERE l.created_at <@ v_period AND l.status = 'VALIDADO' GROUP BY u.id
  ),
  costs AS (
    SELECT l.vehicle_id, sum(l.amount) AS total,
           sum(l.amount) FILTER (WHERE l.category = 'MANTENIMIENTO') AS maintenance
    FROM (SELECT vehicle_id, category, sum(amount) AS amount FROM public.vw_vehicle_cost_ledger
          WHERE cost_date <@ v_period AND vehicle_id IN (SELECT id FROM units) GROUP BY vehicle_id, category) l
    GROUP BY l.vehicle_id
  ),
  per_vehicle AS (
    SELECT u.plate, u.type, u.status, u.ownership_status,
           round(COALESCE(dth.hours, 0), 2) AS downtime_hours,
           round(100 * (1 - COALESCE(dth.hours, 0) / v_hours), 2) AS availability_pct,
           COALESCE(f.failures, 0) AS failures,
           COALESCE(f.reported, 0) AS reported_failures,
           CASE WHEN COALESCE(f.failures, 0) > 0 THEN round((v_hours - COALESCE(dth.hours, 0)) / f.failures, 1) END AS mtbf_hours,
           round(COALESCE(us.km, 0), 2) AS km, round(COALESCE(us.op_hours, 0), 2) AS op_hours,
           round(COALESCE(c.total, 0), 2) AS cost, round(COALESCE(c.maintenance, 0), 2) AS maintenance_cost,
           CASE WHEN COALESCE(us.km, 0) > 0 THEN round(COALESCE(c.total, 0) / us.km, 4) END AS cost_per_km
    FROM units u
    LEFT JOIN dth ON dth.vehicle_id = u.id
    LEFT JOIN fails f ON f.vehicle_id = u.id
    LEFT JOIN usage us ON us.vehicle_id = u.id
    LEFT JOIN costs c ON c.vehicle_id = u.id
  ),
  closed AS (
    SELECT wo.* FROM public.maintenance_work_orders wo JOIN units u ON u.id = wo.vehicle_id
    WHERE wo.status = 'CERRADA' AND wo.closed_at <@ v_period
  ),
  -- MTTR: tiempo técnico activo (inicio de trabajos → fin técnico) sin las esperas
  repair AS (
    SELECT c.id, c.downtime_hours,
           GREATEST(extract(epoch FROM COALESCE(c.finished_at, c.closed_at) - c.downtime_start) / 3600.0
             - COALESCE((SELECT sum(extract(epoch FROM LEAST(COALESCE(w.ended_at, now()), COALESCE(c.finished_at, c.closed_at))
                                                 - GREATEST(w.started_at, c.downtime_start))) / 3600.0
                         FROM public.maintenance_work_order_waits w
                         WHERE w.work_order_id = c.id AND w.started_at < COALESCE(c.finished_at, c.closed_at)
                           AND COALESCE(w.ended_at, now()) > c.downtime_start), 0), 0) AS active_hours
    FROM closed c
    WHERE c.order_type IN ('CORRECTIVA', 'EMERGENCIA') AND c.downtime_start IS NOT NULL
      AND COALESCE(c.finished_at, c.closed_at) > c.downtime_start
  ),
  -- Cumplimiento preventivo: vencimientos del periodo (o cierres sin vencimiento por fecha) con resultado conocido;
  -- una OT abierta con fecha vencida cuenta como tardía
  prev AS (
    SELECT wo.preventive_compliance AS compliance, wo.status
    FROM public.maintenance_work_orders wo JOIN units u ON u.id = wo.vehicle_id
    WHERE wo.order_type = 'PREVENTIVA' AND wo.status <> 'CANCELADA'
      AND ((wo.due_date BETWEEN p_start AND p_end) OR (wo.due_date IS NULL AND wo.status = 'CERRADA' AND wo.closed_at <@ v_period))
      AND (wo.preventive_compliance IS NOT NULL OR (wo.status <> 'CERRADA' AND wo.due_date < v_today))
  ),
  cat AS (
    SELECT l.category, sum(l.amount) AS amount FROM public.vw_vehicle_cost_ledger l
    WHERE l.cost_date <@ v_period AND l.vehicle_id IN (SELECT id FROM units) GROUP BY l.category
  ),
  backlog AS (
    SELECT count(*) AS open_requests, count(*) FILTER (WHERE b.severity = 'CRITICA') AS critical,
           round(avg(b.age_days), 1) AS avg_age_days, max(b.age_days) AS oldest_days
    FROM public.vw_maintenance_backlog b WHERE b.vehicle_plate IN (SELECT plate FROM units)
  ),
  recurrent AS (
    SELECT r.vehicle_plate, count(*) AS reports_90d,
           (SELECT string_agg(DISTINCT left(r2.description, 60), ' | ') FROM public.maintenance_requests r2
            WHERE r2.vehicle_plate = r.vehicle_plate AND r2.reported_at >= upper(v_period) - interval '90 days' AND r2.reported_at < upper(v_period)) AS descriptions
    FROM public.maintenance_requests r
    WHERE r.vehicle_plate IN (SELECT plate FROM units) AND r.status <> 'DESCARTADA'
      AND r.reported_at >= upper(v_period) - interval '90 days' AND r.reported_at < upper(v_period)
    GROUP BY r.vehicle_plate HAVING count(*) >= 3
  ),
  tires AS (
    SELECT round(avg(t.cost_per_km), 4) AS avg_cost_per_km, count(*) FILTER (WHERE t.tread_status IN ('CAMBIAR', 'POR_CAMBIAR')) AS to_change,
           count(*) AS installed
    FROM public.vw_tires t WHERE t.estado = 'INSTALADO' AND t.vehicle_plate IN (SELECT plate FROM units)
  )
  SELECT jsonb_build_object(
    'period', jsonb_build_object('start', p_start, 'end', p_end, 'hours', round(COALESCE(v_hours, 0), 2)),
    'units', (SELECT count(*) FROM units),
    'snapshot', (SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) n FROM units GROUP BY status) s),
    'availability_pct', (SELECT CASE WHEN count(*) > 0 THEN round(100 * (1 - COALESCE(sum(downtime_hours), 0) / (count(*) * v_hours)), 2) END FROM per_vehicle),
    'downtime_hours', (SELECT round(COALESCE(sum(downtime_hours), 0), 2) FROM per_vehicle),
    'failures', (SELECT COALESCE(sum(failures), 0) FROM per_vehicle),
    'reported_failures', (SELECT COALESCE(sum(reported_failures), 0) FROM per_vehicle),
    'mtbf_hours', (SELECT CASE WHEN sum(failures) > 0 THEN round((count(*) * v_hours - sum(downtime_hours)) / sum(failures), 1) END FROM per_vehicle),
    'mttr_hours', (SELECT round(avg(active_hours), 2) FROM repair),
    'mttr_n', (SELECT count(*) FROM repair),
    'restoration_hours', (SELECT round(avg(downtime_hours), 2) FROM repair WHERE downtime_hours > 0),
    'closed_work_orders', (SELECT count(*) FROM closed),
    'preventive_work_orders', (SELECT count(*) FROM closed WHERE order_type = 'PREVENTIVA'),
    'corrective_work_orders', (SELECT count(*) FROM closed WHERE order_type IN ('CORRECTIVA', 'EMERGENCIA')),
    'preventive_pct', (SELECT CASE WHEN count(*) > 0 THEN round(100.0 * count(*) FILTER (WHERE compliance = 'A_TIEMPO') / count(*), 1) END FROM prev),
    'preventive_due', (SELECT count(*) FROM prev),
    'preventive_on_time', (SELECT count(*) FILTER (WHERE compliance = 'A_TIEMPO') FROM prev),
    'preventive_share_pct', (SELECT CASE WHEN count(*) FILTER (WHERE order_type IN ('PREVENTIVA', 'CORRECTIVA', 'EMERGENCIA')) > 0
                         THEN round(100.0 * count(*) FILTER (WHERE order_type = 'PREVENTIVA') / count(*) FILTER (WHERE order_type IN ('PREVENTIVA', 'CORRECTIVA', 'EMERGENCIA')), 1) END FROM closed),
    'open_work_orders', (SELECT count(*) FROM public.maintenance_work_orders wo JOIN units u ON u.id = wo.vehicle_id WHERE wo.status NOT IN ('CERRADA', 'CANCELADA')),
    'backlog', (SELECT to_jsonb(b) FROM backlog b),
    'costs', jsonb_build_object(
       'total', (SELECT round(COALESCE(sum(amount), 0), 2) FROM cat),
       'by_category', COALESCE((SELECT jsonb_object_agg(category, round(amount, 2)) FROM cat), '{}'::jsonb),
       'maintenance_per_unit', (SELECT CASE WHEN count(*) > 0 THEN round(COALESCE(sum(maintenance_cost), 0) / count(*), 2) END FROM per_vehicle),
       'km', (SELECT round(COALESCE(sum(km), 0), 2) FROM per_vehicle),
       'cost_per_km', (SELECT CASE WHEN sum(km) > 0 THEN round(sum(cost) FILTER (WHERE km > 0) / sum(km), 4) END FROM per_vehicle),
       'cost_per_hour', (SELECT CASE WHEN sum(op_hours) > 0 THEN round(sum(cost) FILTER (WHERE op_hours > 0) / sum(op_hours), 4) END FROM per_vehicle)),
    'tires', (SELECT to_jsonb(t) FROM tires t),
    'recurrent_failures', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.reports_90d DESC) FROM recurrent r), '[]'::jsonb),
    'per_vehicle', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.availability_pct, p.cost DESC) FROM per_vehicle p), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
