-- Correcciones de la auditoría de Monitoreo GPS y Registro de Servicios (31/10/2026).
-- 1) update_contract_service_amount (reescrita completa desde 20261120090000):
--    · Ruta mixta: el flete de la ruta vuelve a ser la suma de sus servicios FLETE (20261120090000 había perdido el
--      parche de 20261007200000 y editar el flete de una OT dejaba ese monto como flete de toda la ruta).
--    · Un servicio de una ruta ya ejecutada (entregada, liberada o cerrada) se corrige en Control presupuestal ·
--      Costos por ruta, la única autoridad del costo final; ya no desde Registro de Servicios.
--    · El saldo considera las autorizaciones vigentes de Gerencia (etapa 3), igual que el saldo de la partida.
-- 2) register_contract_service: el mismo criterio de saldo con autorizaciones (parche guardado).
-- 3) dispatch_events: desde la app solo se registran las novedades del formulario de Monitoreo; los eventos con efecto
--    (fin de ruta, cierre operativo manual) los crean las funciones del servidor (no pasan por esta política).
-- 4) get_driver_connectivity_report (reescrita completa desde 20261018100000): filtra los puntos GPS por fecha sin
--    convertir cada fila a JSON (el diagnóstico recorría todos los puntos).
BEGIN;
SET LOCAL lock_timeout='60s';

CREATE OR REPLACE FUNCTION public.update_contract_service_amount(p_service_id uuid, p_new_amount numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s        record;
  b        public.contract_budgets%ROWTYPE;
  v_open   boolean := false;
  v_status text;
  v_delta  numeric;
BEGIN
  IF NOT (public.has_tms_permission('clientes') OR public.has_tms_permission('contratos-servicios')) THEN
    RAISE EXCEPTION 'Sin permiso para editar servicios de contrato';
  END IF;
  IF p_new_amount IS NULL OR p_new_amount < 0 THEN
    RAISE EXCEPTION 'Monto inválido';
  END IF;
  SELECT id, amount_pen, contract_id, service_type, dispatch_id, status,
         COALESCE(budget_contract_id, contract_id) AS owner INTO s
    FROM public.contract_services WHERE id = p_service_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El servicio no existe'; END IF;
  IF COALESCE(s.status, '') = 'ANULADO' THEN RAISE EXCEPTION 'El servicio está anulado'; END IF;
  IF s.dispatch_id IS NOT NULL AND public.economic_closure_status(s.dispatch_id) IN ('EN_REVISION','CIERRE_PARCIAL','CERRADO') THEN
    RAISE EXCEPTION 'El cierre económico de la ruta está en revisión o aprobado: corrija el importe desde Cierre económico (observar o reabrir)';
  END IF;
  IF s.dispatch_id IS NOT NULL THEN
    SELECT status INTO v_status FROM public.dispatches WHERE id = s.dispatch_id;
    IF v_status NOT IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO','CANCELADO') THEN
      RAISE EXCEPTION 'La ruta ya se ejecutó: corrija el costo final en Cierre económico (Control presupuestal · Costos por ruta)';
    END IF;
  END IF;
  IF public.is_contract_administrator() AND NOT public.has_assigned_contract(s.contract_id, true) THEN
    RAISE EXCEPTION 'OT no asignada';
  END IF;
  v_delta := p_new_amount - s.amount_pen;
  SELECT * INTO b FROM public.contract_budgets WHERE contract_id = s.owner AND concept = 'PARTIDA_TRANSPORTE' FOR UPDATE;
  IF v_delta > 0 AND v_delta > COALESCE(b.balance_pen, 0) + public.budget_authorized_over_cap(s.owner) AND NOT public.is_tms_admin() THEN
    RAISE EXCEPTION 'Saldo insuficiente en la partida de transporte: disponible S/ % (incluye lo autorizado por Gerencia)',
      COALESCE(b.balance_pen, 0) + public.budget_authorized_over_cap(s.owner);
  END IF;
  -- El FLETE de un despacho aún abierto está reservado (no consumido): se ajusta la reserva y el flete del despacho
  IF s.service_type = 'FLETE' AND s.dispatch_id IS NOT NULL THEN
    v_open := v_status NOT IN ('LIQUIDADO', 'CERRADO', 'CANCELADO');
  END IF;
  UPDATE public.contract_services SET amount_pen = p_new_amount WHERE id = p_service_id;
  IF COALESCE(v_open, false) THEN
    -- Ruta mixta: el flete de la ruta es la suma de los fletes de sus OT
    UPDATE public.dispatches SET freight_cost = CASE WHEN EXISTS (SELECT 1 FROM public.dispatch_request_freight WHERE dispatch_id = s.dispatch_id)
      THEN (SELECT COALESCE(sum(amount_pen), 0) FROM public.contract_services WHERE dispatch_id = s.dispatch_id AND service_type = 'FLETE' AND COALESCE(status, '') <> 'ANULADO')
      ELSE p_new_amount END
    WHERE id = s.dispatch_id;
    UPDATE public.contract_budgets SET reserved_pen = GREATEST(reserved_pen + v_delta, 0), updated_at = now() WHERE id = b.id;
  ELSE
    UPDATE public.contract_budgets SET consumed_pen = consumed_pen + v_delta, updated_at = now() WHERE id = b.id;
  END IF;
  RETURN true;
END $$;

DO $patch$
DECLARE sig regprocedure; def text;
 o text := 'IF p_amount_pen > COALESCE(b.balance_pen, 0) AND NOT public.is_tms_admin() THEN';
 n text := 'IF p_amount_pen > COALESCE(b.balance_pen, 0) + public.budget_authorized_over_cap(b.contract_id) AND NOT public.is_tms_admin() THEN';
BEGIN
 FOR sig IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.proname = 'register_contract_service' AND p.pronamespace = 'public'::regnamespace LOOP
  def := pg_get_functiondef(sig);
  IF position(n IN def) > 0 OR position(o IN def) = 0 THEN CONTINUE; END IF;
  EXECUTE replace(def, o, n);
 END LOOP;
END $patch$;

-- Novedades desde la app: solo las del formulario de Monitoreo
DROP POLICY IF EXISTS dispatch_events_client_types ON public.dispatch_events;
CREATE POLICY dispatch_events_client_types ON public.dispatch_events AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (event_type IN ('CHECKPOINT','LLEGADA_CLIENTE','SALIDA_CLIENTE','RETRASO','INCIDENCIA'));

CREATE OR REPLACE FUNCTION public.get_driver_connectivity_report(p_days integer DEFAULT 7) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_from timestamptz; v_rows jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_tms_user() OR NOT
    (public.is_tms_admin() OR public.has_tms_read_permission('monitoreo') OR public.has_tms_read_permission('torre-control')) THEN
    RAISE EXCEPTION 'Sin permiso para el diagnóstico de conexión';
  END IF;
  v_from := now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 7), 1), 31));
  WITH routes AS (
    SELECT d.id, d.driver_id FROM public.dispatches d
     WHERE d.driver_id IS NOT NULL AND COALESCE(d.scheduled_departure, d.created_at) >= v_from - interval '1 day'
       AND (public.is_tms_admin() OR (d.site_id IS NOT NULL AND public.can_access_site(d.site_id)))
  ), points AS (
    -- Retraso de subida = recepción en el servidor − toma del punto
    SELECT q.driver_id, count(*) AS n, count(*) FILTER (WHERE q.gap_detected) AS gps_gaps,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY q.delay_s) AS delay_p50,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY q.delay_s) AS delay_p90,
           count(*) FILTER (WHERE q.delay_s > 120) AS late
      FROM (SELECT r.driver_id, COALESCE(p.gap_detected, false) AS gap_detected, extract(epoch FROM p.created_at - p.recorded_at) AS delay_s
              FROM routes r JOIN public.route_track_points p ON p.dispatch_id = r.id
             WHERE p.recorded_at >= v_from) q
     GROUP BY q.driver_id
  ), gaps AS (
    SELECT g.driver_id, count(*) FILTER (WHERE g.dispatch_id IS NOT NULL) AS route_gaps,
           COALESCE(sum(g.seconds) FILTER (WHERE g.dispatch_id IS NOT NULL), 0) AS route_gap_seconds,
           COALESCE(max(g.seconds) FILTER (WHERE g.dispatch_id IS NOT NULL), 0) AS route_gap_max,
           count(*) AS all_gaps
      FROM public.driver_connectivity_gaps g
     WHERE g.started_at >= v_from AND g.driver_id IN (SELECT driver_id FROM routes)
     GROUP BY g.driver_id
  ), drivers AS (SELECT DISTINCT driver_id FROM routes)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'driver_id', dr.id,
      'driver', COALESCE(NULLIF(btrim(concat_ws(' ', to_jsonb(dr)->>'first_name', to_jsonb(dr)->>'last_name')), ''), 'Conductor'),
      'points', COALESCE(pt.n, 0), 'gps_gaps', COALESCE(pt.gps_gaps, 0),
      'delay_p50_s', round(pt.delay_p50::numeric), 'delay_p90_s', round(pt.delay_p90::numeric),
      'late_pct', CASE WHEN COALESCE(pt.n, 0) > 0 THEN round(100.0 * pt.late / pt.n, 1) END,
      'route_gaps', COALESCE(g.route_gaps, 0), 'route_gap_minutes', round(COALESCE(g.route_gap_seconds, 0) / 60.0, 1),
      'route_gap_max_minutes', round(COALESCE(g.route_gap_max, 0) / 60.0, 1), 'all_gaps', COALESCE(g.all_gaps, 0),
      'last_seen_at', a.last_seen_at, 'client', a.client_info, 'pending_points', a.pending_points)
    ORDER BY COALESCE(g.route_gap_seconds, 0) DESC, COALESCE(pt.late, 0) DESC), '[]'::jsonb)
    INTO v_rows
    FROM drivers x JOIN public.drivers dr ON dr.id = x.driver_id
    LEFT JOIN points pt ON pt.driver_id = dr.id
    LEFT JOIN gaps g ON g.driver_id = dr.id
    LEFT JOIN public.driver_app_presence a ON a.driver_id = dr.id;
  RETURN jsonb_build_object('success', true, 'from', v_from, 'as_of', now(), 'drivers', v_rows);
END $$;
REVOKE ALL ON FUNCTION public.get_driver_connectivity_report(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_driver_connectivity_report(integer) TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
