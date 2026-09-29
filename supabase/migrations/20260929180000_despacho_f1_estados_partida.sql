-- ============================================================
-- DESPACHO F1 — Seguridad del cambio de estado, cancelación que libera y cierre que consume
-- ============================================================
-- Hallazgos del análisis Demanda → Operación (docs/despacho/01-f1-estados-partida.md):
--  C1  transition_dispatch_status era SECURITY DEFINER sin permiso ni sede: cualquier usuario cambiaba despachos.
--  C2  Cancelar no liberaba la reserva de la partida, ni anulaba el FLETE, ni devolvía las solicitudes.
--  C3  "Entregado" (Monitoreo) no se podía cerrar y pasar a LIQUIDADO por transición saltaba el consumo.
--  C4  Servicios de contrato consumían sin validar saldo; editar un FLETE reservado movía el consumido.
-- Reglas del negocio: solo se cancela un despacho PROGRAMADO (en ruta ya no: la partida se consume al cerrar).
BEGIN;

-- ------------------------------------------------------------
-- 1. Cambio de estado del despacho
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_operate_dispatch(p_site_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (public.has_tms_permission('despacho') OR public.has_tms_permission('monitoreo') OR public.has_tms_permission('torre-control'))
     AND (p_site_id IS NULL OR public.can_access_site(p_site_id));
$$;

-- Libera todo lo que comprometió un despacho programado que se cancela (uso interno)
CREATE OR REPLACE FUNCTION public.dispatch_release_on_cancel(p_dispatch_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d      public.dispatches%ROWTYPE;
  v_reqs text;
BEGIN
  SELECT * INTO d FROM public.dispatches WHERE id = p_dispatch_id;
  -- Reserva del flete en la partida de transporte de la OT
  IF COALESCE(d.freight_cost, 0) > 0 AND d.contract_id IS NOT NULL THEN
    UPDATE public.contract_budgets SET reserved_pen = GREATEST(reserved_pen - d.freight_cost, 0), updated_at = now()
    WHERE contract_id = d.contract_id AND concept = 'PARTIDA_TRANSPORTE';
  END IF;
  -- El servicio FLETE creado al programar deja de contar
  UPDATE public.contract_services SET status = 'ANULADO'
  WHERE dispatch_id = p_dispatch_id AND service_type = 'FLETE' AND COALESCE(status, '') <> 'ANULADO';
  -- Las solicitudes vuelven a estar aprobadas para programarse de nuevo
  SELECT string_agg(COALESCE(tr.request_number::text, tr.id::text), ', ') INTO v_reqs
  FROM public.dispatch_requests dr JOIN public.transport_requests tr ON tr.id = dr.transport_request_id
  WHERE dr.dispatch_id = p_dispatch_id;
  UPDATE public.transport_requests SET status = 'APROBADA'
  WHERE id IN (SELECT transport_request_id FROM public.dispatch_requests WHERE dispatch_id = p_dispatch_id)
    AND status = 'ASIGNADA';
  DELETE FROM public.dispatch_requests WHERE dispatch_id = p_dispatch_id;
  INSERT INTO public.dispatch_events (dispatch_id, event_type, description, created_by)
  VALUES (p_dispatch_id, 'CANCELACION', 'Despacho cancelado: ' || COALESCE(p_reason, 'sin motivo')
    || '. Se liberó la partida y volvieron a aprobadas: ' || COALESCE(v_reqs, 'ninguna'), COALESCE(auth.uid()::text, 'system'));
END $$;

CREATE OR REPLACE FUNCTION public.transition_dispatch_status(
  p_dispatch_id uuid, p_new_status text, p_reason text DEFAULT NULL, p_user_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dispatch       public.dispatches%ROWTYPE;
  v_current_status text;
  v_allowed        boolean := false;
  v_release        jsonb;
  v_actor          uuid := auth.uid();
  v_is_driver      boolean := false;
  v_staff          boolean := false;
BEGIN
  SELECT * INTO v_dispatch FROM public.dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF v_dispatch.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Despacho inexistente');
  END IF;

  -- Quién puede: personal de Despacho / Monitoreo / Torre de su sede, o el conductor del despacho para
  -- los hitos de su viaje. Sin sesión (procesos del servidor) se permite.
  IF v_actor IS NOT NULL THEN
    v_staff := public.can_operate_dispatch(v_dispatch.site_id);
    v_is_driver := EXISTS (SELECT 1 FROM public.drivers dr WHERE dr.id = v_dispatch.driver_id AND dr.profile_id = v_actor);
    IF NOT v_staff AND NOT (v_is_driver AND p_new_status IN ('EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO_COMPLETADO')) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para cambiar el estado de este despacho');
    END IF;
    IF p_new_status = 'CANCELADO' AND NOT (public.has_tms_permission('despacho') AND public.can_access_site(v_dispatch.site_id)) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Solo Despacho puede cancelar un despacho');
    END IF;
  END IF;

  v_current_status := COALESCE(v_dispatch.status, 'PROGRAMADO');
  IF v_current_status = p_new_status THEN
    RETURN jsonb_build_object('success', true, 'previous_status', v_current_status, 'new_status', p_new_status,
                              'note', 'El estado ya era ' || p_new_status);
  END IF;

  IF p_new_status = 'CANCELADO' THEN
    -- Solo antes de salir; en ruta el servicio se cierra y la partida se consume
    v_allowed := v_current_status = 'PROGRAMADO';
    IF NOT v_allowed THEN
      RETURN jsonb_build_object('success', false, 'error', 'El despacho ya salió (' || v_current_status
        || '): no se puede cancelar. Ciérrelo al retornar; la partida se consume.');
    END IF;
  ELSIF p_new_status = 'LIQUIDADO' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Use "Cerrar ruta": el cierre consume la partida y marca las solicitudes como entregadas');
  ELSIF v_current_status = 'PROGRAMADO' THEN
    v_allowed := p_new_status IN ('EN_CURSO', 'EN RUTA');
  ELSIF v_current_status IN ('EN_CURSO', 'EN RUTA') THEN
    v_allowed := p_new_status IN ('ESPERANDO_AUTORIZACION', 'RETORNO', 'ENTREGADO');
  ELSIF v_current_status = 'ESPERANDO_AUTORIZACION' THEN
    v_allowed := p_new_status = 'RETORNO';
  ELSIF v_current_status = 'RETORNO' THEN
    v_allowed := p_new_status = 'RETORNO_COMPLETADO';
  ELSIF v_current_status = 'LIQUIDADO' THEN
    v_allowed := p_new_status = 'CERRADO';
  END IF;

  IF NOT v_allowed THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transición no permitida de ' || v_current_status || ' a ' || p_new_status);
  END IF;

  -- "Entregado" solo con todas las paradas confirmadas en el app (foto de entrega)
  IF p_new_status = 'ENTREGADO' AND EXISTS (SELECT 1 FROM public.dispatch_requests
      WHERE dispatch_id = p_dispatch_id AND status <> 'ENTREGADO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Hay paradas sin entrega confirmada: el conductor debe registrarlas en el app');
  END IF;

  UPDATE public.dispatches SET status = p_new_status WHERE id = p_dispatch_id;

  INSERT INTO public.dispatch_events (dispatch_id, event_type, description, created_by)
  VALUES (p_dispatch_id, 'STATUS_CHANGE',
          'Cambio de estado: ' || v_current_status || ' -> ' || p_new_status || COALESCE('. Razón: ' || p_reason, ''),
          COALESCE(v_actor::text, p_user_id::text, 'system'));

  IF p_new_status = 'CANCELADO' THEN
    PERFORM public.dispatch_release_on_cancel(p_dispatch_id, p_reason);
  END IF;

  -- Liberación de la unidad por el motor; si no es elegible queda OBSERVADA
  IF p_new_status IN ('CERRADO', 'CANCELADO') AND v_dispatch.vehicle_plate IS NOT NULL
     AND (SELECT status FROM public.vehicles WHERE plate = v_dispatch.vehicle_plate) IN ('ASIGNADA', 'EN_OPERACION') THEN
    v_release := public.transition_vehicle_status(v_dispatch.vehicle_plate, 'DISPONIBLE',
                   'Despacho finalizado (' || p_new_status || ')', v_actor,
                   jsonb_build_object('dispatch_id', p_dispatch_id));
    IF NOT COALESCE((v_release->>'success')::boolean, false) THEN
      v_release := public.transition_vehicle_status(v_dispatch.vehicle_plate, 'OBSERVADA',
                     'No elegible al cierre del despacho: ' || COALESCE(v_release->>'error', ''),
                     v_actor, jsonb_build_object('dispatch_id', p_dispatch_id));
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'previous_status', v_current_status, 'new_status', p_new_status,
                            'vehicle_transition', v_release);
END;
$$;

-- Cancelación explícita desde Despacho (motivo obligatorio)
CREATE OR REPLACE FUNCTION public.cancel_dispatch(p_dispatch_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NULLIF(trim(p_reason), '') IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo de la cancelación'); END IF;
  RETURN public.transition_dispatch_status(p_dispatch_id, 'CANCELADO', trim(p_reason));
END $$;

-- ------------------------------------------------------------
-- 2. Cierre de ruta: también desde "Entregado"; siempre consume la partida y libera la unidad
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.close_dispatch_route(p_dispatch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_dispatch public.dispatches%ROWTYPE;
DECLARE v_coverage boolean;
DECLARE v_mileage numeric;
DECLARE v_release jsonb;
BEGIN
  IF NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Sin permiso para cerrar despachos'; END IF;
  SELECT * INTO v_dispatch FROM public.dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF v_dispatch.id IS NULL OR NOT public.can_access_site(v_dispatch.site_id) THEN RAISE EXCEPTION 'Despacho inexistente'; END IF;
  IF v_dispatch.status = 'LIQUIDADO' THEN
    RETURN jsonb_build_object('actual_distance_km', v_dispatch.actual_distance_km,
      'gps_complete', v_dispatch.gps_coverage_complete);
  END IF;
  IF v_dispatch.status NOT IN ('RETORNO_COMPLETADO', 'ENTREGADO')
    OR EXISTS (SELECT 1 FROM public.dispatch_requests
      WHERE dispatch_id = p_dispatch_id AND status <> 'ENTREGADO') THEN
    RAISE EXCEPTION 'Falta confirmar el retorno a base (o la entrega) o hay paradas pendientes';
  END IF;
  SELECT count(*) > 0 AND bool_and(coalesce(leg_gps_complete, false))
    INTO v_coverage FROM public.dispatch_requests WHERE dispatch_id = p_dispatch_id;
  v_coverage := coalesce(v_coverage, false) AND coalesce(v_dispatch.return_gps_complete, false)
    AND NOT EXISTS (SELECT 1 FROM public.route_track_points
      WHERE dispatch_id = p_dispatch_id AND gap_detected);

  IF coalesce(v_dispatch.freight_cost, 0) > 0 AND v_dispatch.contract_id IS NOT NULL THEN
    UPDATE public.contract_budgets SET reserved_pen = GREATEST(reserved_pen - v_dispatch.freight_cost, 0),
      consumed_pen = consumed_pen + v_dispatch.freight_cost, updated_at = now()
    WHERE contract_id = v_dispatch.contract_id AND concept = 'PARTIDA_TRANSPORTE';
    IF NOT FOUND THEN RAISE EXCEPTION 'La OT del despacho no tiene partida de transporte'; END IF;
  END IF;

  IF v_coverage AND coalesce(v_dispatch.actual_distance_km, 0) > 0
    AND v_dispatch.vehicle_plate IS NOT NULL AND v_dispatch.vehicle_plate <> 'EXTERNO' THEN
    -- El GPS solo sirve de contraste; el odómetro real se actualiza por checklist u otros métodos.
    SELECT current_mileage INTO v_mileage FROM public.vehicles WHERE plate = v_dispatch.vehicle_plate;
    IF v_mileage IS NOT NULL THEN
      INSERT INTO public.vehicle_maintenance_history(vehicle_id, action_type, description, mileage_at_time)
      SELECT id, 'GPS_REGISTRADO', 'Ruta ' || v_dispatch.dispatch_number
        || ' (Recorrido GPS: ' || v_dispatch.actual_distance_km || ' km)', v_mileage
      FROM public.vehicles WHERE plate = v_dispatch.vehicle_plate;
    END IF;
  END IF;

  UPDATE public.transport_requests SET status = 'ENTREGADA' WHERE id IN (
    SELECT transport_request_id FROM public.dispatch_requests WHERE dispatch_id = p_dispatch_id);
  UPDATE public.dispatches SET status = 'LIQUIDADO', gps_coverage_complete = v_coverage
    WHERE id = p_dispatch_id;
  INSERT INTO public.dispatch_events (dispatch_id, event_type, description, created_by)
  VALUES (p_dispatch_id, 'STATUS_CHANGE', 'Cierre de ruta: ' || v_dispatch.status || ' -> LIQUIDADO', COALESCE(auth.uid()::text, 'system'));

  IF v_dispatch.vehicle_plate IS NOT NULL
     AND (SELECT status FROM public.vehicles WHERE plate = v_dispatch.vehicle_plate) IN ('ASIGNADA', 'EN_OPERACION') THEN
    v_release := public.transition_vehicle_status(v_dispatch.vehicle_plate, 'DISPONIBLE',
      'Despacho cerrado (LIQUIDADO)', auth.uid(), jsonb_build_object('dispatch_id', p_dispatch_id));
  END IF;
  RETURN jsonb_build_object('actual_distance_km', v_dispatch.actual_distance_km, 'gps_complete', v_coverage);
END $$;

-- ------------------------------------------------------------
-- 3. Servicios de contrato: saldo validado y FLETE reservado coherente
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_contract_service(
  p_contract_id uuid, p_service_type varchar, p_description text,
  p_amount_pen numeric, p_service_date date, p_plate varchar DEFAULT NULL,
  p_driver_name varchar DEFAULT NULL, p_hours numeric DEFAULT NULL,
  p_provider_ruc varchar DEFAULT NULL, p_provider_name varchar DEFAULT NULL,
  p_category varchar DEFAULT 'Contrato', p_referral_guide text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b public.contract_budgets%ROWTYPE;
BEGIN
  IF NOT (public.has_tms_permission('clientes') OR public.has_tms_permission('contratos-servicios')) THEN
    RAISE EXCEPTION 'Sin permiso para registrar servicios de contrato';
  END IF;
  IF p_contract_id IS NULL OR p_service_type IS NULL OR p_amount_pen IS NULL OR p_amount_pen < 0 THEN
    RAISE EXCEPTION 'Datos de servicio inválidos';
  END IF;
  IF public.is_contract_administrator() AND NOT public.has_assigned_contract(p_contract_id,true) THEN
    RAISE EXCEPTION 'OT no asignada';
  END IF;
  SELECT * INTO b FROM public.contract_budgets
    WHERE contract_id = p_contract_id AND concept = 'PARTIDA_TRANSPORTE' FOR UPDATE;
  IF b.id IS NULL THEN RAISE EXCEPTION 'Partida de transporte no encontrada'; END IF;
  -- Sin saldo no se consume (el Administrador puede registrar históricos que exceden, queda visible en negativo)
  IF p_amount_pen > COALESCE(b.balance_pen, 0) AND NOT public.is_tms_admin() THEN
    RAISE EXCEPTION 'Saldo insuficiente en la partida de transporte: disponible S/ %, requerido S/ %. Amplíe la partida.',
      COALESCE(b.balance_pen, 0), p_amount_pen;
  END IF;
  INSERT INTO public.contract_services (
    contract_id, service_type, description, amount_pen, service_date,
    plate, driver_name, hours, provider_ruc, provider_name, category,
    referral_guide, created_by
  ) VALUES (
    p_contract_id, p_service_type, p_description, p_amount_pen,
    coalesce(p_service_date, current_date), p_plate, p_driver_name, p_hours,
    p_provider_ruc, p_provider_name, p_category, p_referral_guide, auth.uid()
  );
  UPDATE public.contract_budgets SET consumed_pen = consumed_pen + p_amount_pen,
    updated_at = now() WHERE id = b.id;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.update_contract_service_amount(p_service_id uuid, p_new_amount numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s        record;
  b        public.contract_budgets%ROWTYPE;
  v_open   boolean := false;
  v_delta  numeric;
BEGIN
  IF NOT (public.has_tms_permission('clientes') OR public.has_tms_permission('contratos-servicios')) THEN
    RAISE EXCEPTION 'Sin permiso para editar servicios de contrato';
  END IF;
  IF p_new_amount IS NULL OR p_new_amount < 0 THEN
    RAISE EXCEPTION 'Monto inválido';
  END IF;
  SELECT id, amount_pen, contract_id, service_type, dispatch_id, status INTO s
    FROM public.contract_services WHERE id = p_service_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El servicio no existe'; END IF;
  IF COALESCE(s.status, '') = 'ANULADO' THEN RAISE EXCEPTION 'El servicio está anulado'; END IF;
  IF public.is_contract_administrator() AND NOT public.has_assigned_contract(s.contract_id,true) THEN
    RAISE EXCEPTION 'OT no asignada';
  END IF;
  v_delta := p_new_amount - s.amount_pen;
  SELECT * INTO b FROM public.contract_budgets WHERE contract_id = s.contract_id AND concept = 'PARTIDA_TRANSPORTE' FOR UPDATE;
  IF v_delta > 0 AND v_delta > COALESCE(b.balance_pen, 0) AND NOT public.is_tms_admin() THEN
    RAISE EXCEPTION 'Saldo insuficiente en la partida de transporte: disponible S/ %', COALESCE(b.balance_pen, 0);
  END IF;
  -- El FLETE de un despacho aún abierto está reservado (no consumido): se ajusta la reserva y el flete del despacho
  IF s.service_type = 'FLETE' AND s.dispatch_id IS NOT NULL THEN
    SELECT status NOT IN ('LIQUIDADO', 'CERRADO', 'CANCELADO') INTO v_open FROM public.dispatches WHERE id = s.dispatch_id;
  END IF;
  UPDATE public.contract_services SET amount_pen = p_new_amount WHERE id = p_service_id;
  IF COALESCE(v_open, false) THEN
    UPDATE public.dispatches SET freight_cost = p_new_amount WHERE id = s.dispatch_id;
    UPDATE public.contract_budgets SET reserved_pen = GREATEST(reserved_pen + v_delta, 0), updated_at = now() WHERE id = b.id;
  ELSE
    UPDATE public.contract_budgets SET consumed_pen = consumed_pen + v_delta, updated_at = now() WHERE id = b.id;
  END IF;
  RETURN true;
END $$;

-- ------------------------------------------------------------
-- 4. Reservas huérfanas: la reserva de cada partida = fletes de sus despachos abiertos
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contract_budget_adjustments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id    uuid NOT NULL,
  contract_id  uuid NOT NULL,
  field        text NOT NULL,
  old_value    numeric(15,2),
  new_value    numeric(15,2),
  reason       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.contract_budget_adjustments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contract_budget_adjustments FROM anon, authenticated;
GRANT SELECT ON public.contract_budget_adjustments TO authenticated;
DROP POLICY IF EXISTS contract_budget_adjustments_read ON public.contract_budget_adjustments;
CREATE POLICY contract_budget_adjustments_read ON public.contract_budget_adjustments FOR SELECT TO authenticated USING (public.is_tms_admin());

WITH expected AS (
  SELECT b.id, b.contract_id, b.reserved_pen AS old_reserved,
         COALESCE((SELECT sum(d.freight_cost) FROM public.dispatches d
                   WHERE d.contract_id = b.contract_id AND COALESCE(d.freight_cost, 0) > 0
                     AND d.vehicle_plate IS DISTINCT FROM 'EXTERNO'
                     AND COALESCE(d.status, 'PROGRAMADO') NOT IN ('LIQUIDADO', 'CERRADO', 'CANCELADO')), 0) AS new_reserved
  FROM public.contract_budgets b WHERE b.concept = 'PARTIDA_TRANSPORTE'
), logged AS (
  INSERT INTO public.contract_budget_adjustments (budget_id, contract_id, field, old_value, new_value, reason)
  SELECT id, contract_id, 'reserved_pen', old_reserved, new_reserved, 'F1: reserva recalculada = fletes de despachos abiertos'
  FROM expected WHERE old_reserved IS DISTINCT FROM new_reserved
  RETURNING budget_id, new_value
)
UPDATE public.contract_budgets b SET reserved_pen = l.new_value, updated_at = now()
FROM logged l WHERE b.id = l.budget_id;

-- FLETE de despachos ya cancelados: dejan de contar
UPDATE public.contract_services s SET status = 'ANULADO'
WHERE s.service_type = 'FLETE' AND s.dispatch_id IS NOT NULL AND COALESCE(s.status, '') <> 'ANULADO'
  AND EXISTS (SELECT 1 FROM public.dispatches d WHERE d.id = s.dispatch_id AND d.status = 'CANCELADO');

-- ------------------------------------------------------------
-- 5. Permisos de ejecución
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.can_operate_dispatch(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dispatch_release_on_cancel(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transition_dispatch_status(uuid, text, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_dispatch(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.close_dispatch_route(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.register_contract_service(uuid,varchar,text,numeric,date,varchar,varchar,numeric,varchar,varchar,varchar,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_contract_service_amount(uuid,numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_operate_dispatch(uuid), public.transition_dispatch_status(uuid, text, text, uuid),
  public.cancel_dispatch(uuid, text), public.close_dispatch_route(uuid),
  public.register_contract_service(uuid,varchar,text,numeric,date,varchar,varchar,numeric,varchar,varchar,varchar,text),
  public.update_contract_service_amount(uuid,numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.dispatch_release_on_cancel(uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
