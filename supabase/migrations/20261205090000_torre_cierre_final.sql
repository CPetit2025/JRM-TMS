-- Torre de Control · cierre final del servicio (docs/control-presupuestal/reingenieria-torre-control.md, Fase 3, D1).
-- Cuatro estados independientes calculados (no se guardan): operativo (ruta cerrada = LIQUIDADO), documentario
-- (documentary_closures), económico (economic_closures: incluye los desvíos de costo del viaje) y Caja (gastos del viaje
-- sin revisar). El cierre final se guarda aparte con su historial: dispatches.status no cambia, porque varias consultas
-- (bandejas, movimientos de la partida, indicadores) tratan LIQUIDADO como estado final de la ruta.
-- D1: el cierre final registra estado y trazabilidad; no bloquea otros procesos. No cierra la OT.
BEGIN;
SET LOCAL lock_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.dispatch_final_closures (
  dispatch_id uuid PRIMARY KEY REFERENCES public.dispatches(id) ON DELETE CASCADE,
  closed_by   uuid,
  closed_at   timestamptz NOT NULL DEFAULT now(),
  exception   boolean NOT NULL DEFAULT false,
  note        text,
  checks      jsonb NOT NULL
);
ALTER TABLE public.dispatch_final_closures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.dispatch_final_closures;
CREATE POLICY security_active_account ON public.dispatch_final_closures AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.dispatch_final_closures FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.dispatch_final_close_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id uuid NOT NULL REFERENCES public.dispatches(id) ON DELETE CASCADE,
  action      text NOT NULL CHECK (action IN ('CERRAR','CERRAR_CON_EXCEPCION','REABRIR')),
  note        text,
  checks      jsonb,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- Regla C55: FK cubierta por un índice no parcial
CREATE INDEX IF NOT EXISTS dispatch_final_close_events_dispatch_idx ON public.dispatch_final_close_events(dispatch_id);
ALTER TABLE public.dispatch_final_close_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.dispatch_final_close_events;
CREATE POLICY security_active_account ON public.dispatch_final_close_events AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.dispatch_final_close_events FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.dispatch_final_close_events_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN RAISE EXCEPTION 'El historial del cierre final no se modifica ni se borra'; END $$;
DROP TRIGGER IF EXISTS dispatch_final_close_events_append_only ON public.dispatch_final_close_events;
CREATE TRIGGER dispatch_final_close_events_append_only BEFORE UPDATE OR DELETE ON public.dispatch_final_close_events
  FOR EACH ROW WHEN (pg_trigger_depth() < 1) EXECUTE FUNCTION public.dispatch_final_close_events_append_only();

-- Estados del viaje (interna, sin permisos)
CREATE OR REPLACE FUNCTION public.dispatch_closure_checks(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT jsonb_build_object(
   'operativo', jsonb_build_object('ok', d.status IN ('LIQUIDADO','CERRADO'), 'status', d.status),
   'documentario', jsonb_build_object('ok', doc.status = 'COMPLETO', 'status', doc.status, 'pending', doc.pending),
   'economico', jsonb_build_object('ok', eco IN ('CERRADO','NO_APLICA'), 'status', eco),
   'caja', jsonb_build_object('ok', caja.n = 0, 'pending', caja.n, 'pending_pen', caja.pen),
   'ready', d.status IN ('LIQUIDADO','CERRADO') AND doc.status = 'COMPLETO' AND eco IN ('CERRADO','NO_APLICA') AND caja.n = 0,
   'final', (SELECT jsonb_build_object('closed_at', f.closed_at, 'closed_by', public.economic_user_name(f.closed_by),
              'exception', f.exception, 'note', f.note) FROM public.dispatch_final_closures f WHERE f.dispatch_id = d.id))
 FROM public.dispatches d
 CROSS JOIN LATERAL (SELECT public.economic_documentary_status(d.id) AS status,
   (SELECT count(*) FROM public.documentary_closures c WHERE c.dispatch_id = d.id AND c.status <> 'COMPLETO') AS pending) doc
 CROSS JOIN LATERAL public.economic_closure_status(d.id) AS eco
 CROSS JOIN LATERAL (SELECT count(*) AS n, COALESCE(sum(e.amount), 0) AS pen FROM public.dispatch_expenses e
   WHERE e.dispatch_id = d.id AND e.status IN ('PENDIENTE','OBSERVADO')) caja
 WHERE d.id = p_dispatch_id
$$;
REVOKE ALL ON FUNCTION public.dispatch_closure_checks(uuid) FROM PUBLIC, anon, authenticated;

-- Lectura para Torre de Control (lista y detalle): estados de hasta 500 viajes y qué puede hacer el usuario
CREATE OR REPLACE FUNCTION public.dispatch_closure_status(p_dispatch_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_admin boolean := public.is_tms_admin();
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin sesión activa'); END IF;
 IF NOT (v_admin OR public.has_tms_read_permission('torre-control') OR public.has_tms_read_permission('despacho')
         OR public.has_tms_read_permission('monitoreo') OR public.budget_can_read()) THEN
  RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a Torre de Control');
 END IF;
 IF COALESCE(cardinality(p_dispatch_ids), 0) > 500 THEN RETURN jsonb_build_object('success', false, 'error', 'Demasiados viajes'); END IF;
 RETURN jsonb_build_object('success', true,
  'can_close', v_admin OR public.has_tms_permission('despacho') OR public.has_tms_permission('cierre-economico'),
  'can_except', v_admin OR public.has_tms_permission('control-presupuestal-recomendar'),
  'rows', COALESCE((SELECT jsonb_object_agg(d.id, public.dispatch_closure_checks(d.id)) FROM public.dispatches d
    WHERE d.id = ANY (p_dispatch_ids) AND (v_admin OR d.site_id IS NULL OR public.can_access_site(d.site_id))), '{}'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.dispatch_closure_status(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatch_closure_status(uuid[]) TO authenticated;

-- Cierre final: todo conforme (Supervisor) o con excepción y motivo (Jefe de Distribución). La ruta debe estar cerrada.
CREATE OR REPLACE FUNCTION public.dispatch_final_close(p_dispatch_id uuid, p_note text DEFAULT NULL, p_exception boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d record; v_checks jsonb; v_admin boolean := public.is_tms_admin(); v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
 v_missing text;
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin sesión activa'); END IF;
 IF COALESCE(p_exception, false) THEN
  IF NOT (v_admin OR public.has_tms_permission('control-presupuestal-recomendar')) THEN
   RETURN jsonb_build_object('success', false, 'error', 'Solo el Jefe de Distribución cierra un servicio con excepción');
  END IF;
  IF v_note IS NULL OR length(v_note) < 10 THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo de la excepción (mínimo 10 caracteres)'); END IF;
 ELSIF NOT (v_admin OR public.has_tms_permission('despacho') OR public.has_tms_permission('cierre-economico')) THEN
  RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para cerrar el servicio');
 END IF;
 SELECT x.id, x.site_id, x.dispatch_number INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id FOR UPDATE;
 IF NOT FOUND OR NOT (v_admin OR d.site_id IS NULL OR public.can_access_site(d.site_id)) THEN
  RETURN jsonb_build_object('success', false, 'error', 'Despacho inexistente');
 END IF;
 IF EXISTS (SELECT 1 FROM public.dispatch_final_closures WHERE dispatch_id = p_dispatch_id) THEN
  RETURN jsonb_build_object('success', false, 'error', 'El servicio ya tiene cierre final');
 END IF;
 v_checks := public.dispatch_closure_checks(p_dispatch_id);
 IF NOT (v_checks->'operativo'->>'ok')::boolean THEN
  RETURN jsonb_build_object('success', false, 'error', 'Primero cierre la ruta (estado actual: ' || (v_checks->'operativo'->>'status') || ')');
 END IF;
 IF NOT (v_checks->>'ready')::boolean AND NOT COALESCE(p_exception, false) THEN
  v_missing := concat_ws(', ',
   CASE WHEN NOT (v_checks->'documentario'->>'ok')::boolean THEN 'liquidación documentaria (' || (v_checks->'documentario'->>'status') || ')' END,
   CASE WHEN NOT (v_checks->'economico'->>'ok')::boolean THEN 'liquidación económica (' || (v_checks->'economico'->>'status') || ')' END,
   CASE WHEN NOT (v_checks->'caja'->>'ok')::boolean THEN (v_checks->'caja'->>'pending') || ' gasto(s) de Caja sin revisar' END);
  RETURN jsonb_build_object('success', false, 'error', 'Falta: ' || v_missing, 'checks', v_checks);
 END IF;
 INSERT INTO public.dispatch_final_closures(dispatch_id, closed_by, exception, note, checks)
 VALUES (p_dispatch_id, auth.uid(), COALESCE(p_exception, false) AND NOT (v_checks->>'ready')::boolean, v_note, v_checks);
 INSERT INTO public.dispatch_final_close_events(dispatch_id, action, note, checks, created_by)
 VALUES (p_dispatch_id, CASE WHEN COALESCE(p_exception, false) AND NOT (v_checks->>'ready')::boolean THEN 'CERRAR_CON_EXCEPCION' ELSE 'CERRAR' END,
   v_note, v_checks, auth.uid());
 RETURN jsonb_build_object('success', true, 'checks', public.dispatch_closure_checks(p_dispatch_id));
END $$;
REVOKE ALL ON FUNCTION public.dispatch_final_close(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatch_final_close(uuid, text, boolean) TO authenticated;

-- Reabrir: Jefe de Distribución con motivo; queda en el historial
CREATE OR REPLACE FUNCTION public.dispatch_final_reopen(p_dispatch_id uuid, p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d record; v_admin boolean := public.is_tms_admin(); v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_active_tms_user() OR NOT (v_admin OR public.has_tms_permission('control-presupuestal-recomendar')) THEN
  RETURN jsonb_build_object('success', false, 'error', 'Solo el Jefe de Distribución reabre un cierre final');
 END IF;
 IF v_note IS NULL OR length(v_note) < 10 THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo de la reapertura (mínimo 10 caracteres)'); END IF;
 SELECT x.id, x.site_id INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id FOR UPDATE;
 IF NOT FOUND OR NOT (v_admin OR d.site_id IS NULL OR public.can_access_site(d.site_id)) THEN
  RETURN jsonb_build_object('success', false, 'error', 'Despacho inexistente');
 END IF;
 DELETE FROM public.dispatch_final_closures WHERE dispatch_id = p_dispatch_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'El servicio no tiene cierre final'); END IF;
 INSERT INTO public.dispatch_final_close_events(dispatch_id, action, note, checks, created_by)
 VALUES (p_dispatch_id, 'REABRIR', v_note, public.dispatch_closure_checks(p_dispatch_id), auth.uid());
 RETURN jsonb_build_object('success', true);
END $$;
REVOKE ALL ON FUNCTION public.dispatch_final_reopen(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatch_final_reopen(uuid, text) TO authenticated;

-- Historial del cierre final de un viaje
CREATE OR REPLACE FUNCTION public.dispatch_final_close_history(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_active_tms_user() OR NOT (public.is_tms_admin() OR public.has_tms_read_permission('torre-control')
    OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('monitoreo') OR public.budget_can_read()) THEN RETURN '[]'::jsonb; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.dispatches d WHERE d.id = p_dispatch_id AND (public.is_tms_admin() OR d.site_id IS NULL OR public.can_access_site(d.site_id))) THEN
  RETURN '[]'::jsonb;
 END IF;
 RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('action', e.action, 'note', e.note, 'by', public.economic_user_name(e.created_by), 'at', e.created_at)
   ORDER BY e.created_at DESC) FROM public.dispatch_final_close_events e WHERE e.dispatch_id = p_dispatch_id), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.dispatch_final_close_history(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatch_final_close_history(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
