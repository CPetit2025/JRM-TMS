-- Etapa 4 · Cierre económico por ruta, independiente del cierre documentario (Etapa 5).
-- 1) Se valida el costo final de cada servicio especial (cantidades, horas o jornadas ejecutadas con mínimo y fracción,
--    adicionales justificados) y el flete final (Etapa 3).
-- 2) Programación envía a revisión; quien tiene el permiso «cierre-economico» aprueba u observa (con motivo).
-- 3) Al aprobar, la partida de cada OT pasa de lo consumido al cierre de la ruta al costo final (solo la diferencia,
--    también al reabrir y volver a cerrar). Estados: PENDIENTE, EN_REVISION, OBSERVADO, CERRADO; historial solo de inserción.
-- No se cierra con costos pendientes; la ruta debe estar cerrada en Torre de Control (LIQUIDADO/CERRADO).
BEGIN;
SET LOCAL lock_timeout='60s';

-- ------------------------------------------------------------
-- 1. Costo final validado por servicio especial (no reemplaza actual_pen hasta aprobar el cierre)
-- ------------------------------------------------------------
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS final_executed_qty numeric(10,2);
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS final_workers integer;
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS final_billable_qty numeric(10,2);
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS final_extras_pen numeric(15,2);
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS final_pen numeric(15,2);
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS final_reason text;
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS final_validated_by uuid;
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS final_validated_at timestamptz;
DO $c$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='transport_unloading_costs_final_check') THEN
  ALTER TABLE public.transport_unloading_costs ADD CONSTRAINT transport_unloading_costs_final_check CHECK (
   (final_pen IS NULL OR final_pen >= 0) AND (final_extras_pen IS NULL OR final_extras_pen >= 0)
   AND (final_executed_qty IS NULL OR final_executed_qty >= 0) AND (final_workers IS NULL OR final_workers BETWEEN 1 AND 200));
 END IF;
END $c$;

-- Lo ya aplicado a la partida por el cierre (para que reabrir y volver a cerrar mueva solo la diferencia)
ALTER TABLE public.dispatch_freight_stages ADD COLUMN IF NOT EXISTS final_applied_pen numeric(15,2);
ALTER TABLE public.dispatch_request_freight_stages ADD COLUMN IF NOT EXISTS final_applied_pen numeric(15,2);

-- ------------------------------------------------------------
-- 2. Estado económico por ruta e historial
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.economic_closures (
  dispatch_id     uuid PRIMARY KEY REFERENCES public.dispatches(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'PENDIENTE' CHECK (status IN ('PENDIENTE','EN_REVISION','OBSERVADO','CERRADO')),
  observation     text,
  submitted_by    uuid,
  submitted_at    timestamptz,
  closed_by       uuid,
  closed_at       timestamptz,
  reopened_count  integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.economic_closures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.economic_closures;
CREATE POLICY security_active_account ON public.economic_closures AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.economic_closures FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.economic_closure_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id  uuid NOT NULL,
  action       text NOT NULL CHECK (action IN ('ENVIAR','APROBAR','OBSERVAR','REABRIR')),
  from_status  text,
  to_status    text NOT NULL,
  reason       text,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS economic_closure_events_dispatch_idx ON public.economic_closure_events(dispatch_id, created_at);
ALTER TABLE public.economic_closure_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.economic_closure_events;
CREATE POLICY security_active_account ON public.economic_closure_events AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.economic_closure_events FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS economic_closure_events_append_only ON public.economic_closure_events;
CREATE TRIGGER economic_closure_events_append_only BEFORE UPDATE OR DELETE ON public.economic_closure_events
 FOR EACH ROW EXECUTE FUNCTION public.service_cost_events_append_only();

CREATE OR REPLACE FUNCTION public.economic_closure_status(p_dispatch_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT COALESCE((SELECT status FROM public.economic_closures WHERE dispatch_id = p_dispatch_id), 'PENDIENTE')
$$;
REVOKE ALL ON FUNCTION public.economic_closure_status(uuid) FROM PUBLIC,anon,authenticated;

-- En revisión o cerrado no se corrige el flete final (hay que observar o reabrir)
CREATE OR REPLACE FUNCTION public.dispatch_freight_final_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF (NEW.final_pen IS DISTINCT FROM OLD.final_pen OR NEW.base_pen IS DISTINCT FROM OLD.base_pen OR NEW.extras_pen IS DISTINCT FROM OLD.extras_pen)
    AND public.economic_closure_status(NEW.dispatch_id) IN ('EN_REVISION','CERRADO') THEN
  RAISE EXCEPTION 'El cierre económico de la ruta está en revisión o cerrado: obsérvelo o reábralo para corregir';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.dispatch_freight_final_lock() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS dispatch_freight_final_lock ON public.dispatch_freight_stages;
CREATE TRIGGER dispatch_freight_final_lock BEFORE UPDATE ON public.dispatch_freight_stages
 FOR EACH ROW EXECUTE FUNCTION public.dispatch_freight_final_lock();

-- ------------------------------------------------------------
-- 3. Reglas de cobro: cantidad facturable
--    HORA: se redondea hacia arriba a la fracción (15, 30 o 60 min; sin fracción, a la hora completa) y luego el mínimo.
--    JORNADA: el mínimo. SERVICIO: la cantidad. Sin ejecución (0) no se factura mínimo.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.economic_billable_qty(p_unit text, p_qty numeric, p_fraction integer, p_min numeric) RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN COALESCE(p_qty, 0) <= 0 THEN 0
  WHEN p_unit = 'HORA' THEN round(greatest(ceil(p_qty * 60 / COALESCE(p_fraction, 60)) * COALESCE(p_fraction, 60) / 60.0, COALESCE(p_min, 0)), 2)
  WHEN p_unit = 'JORNADA' THEN round(greatest(p_qty, COALESCE(p_min, 0)), 2)
  ELSE round(p_qty, 2) END
$$;

-- p = { executed_qty, workers?, extras_pen?, reason?, final_pen? (servicio sin acuerdo de tarifa) }
CREATE OR REPLACE FUNCTION public.validate_service_final(p_line_id uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE l record; d record; v_qty numeric; v_workers int; v_extras numeric; v_reason text; v_billable numeric; v_base numeric; v_final numeric;
 v_reference numeric; v_hours numeric;
BEGIN
 IF NOT (public.has_tms_permission('despacho') OR public.has_tms_permission('cierre-economico')) THEN RAISE EXCEPTION 'Sin permiso para validar costos finales'; END IF;
 SELECT * INTO l FROM public.transport_unloading_costs WHERE id = p_line_id FOR UPDATE;
 IF NOT FOUND OR l.dispatch_id IS NULL OR l.status NOT IN ('PLANIFICADO','CONSUMIDO') THEN RAISE EXCEPTION 'Servicio no disponible para validar'; END IF;
 SELECT x.id, x.status, x.site_id INTO d FROM public.dispatches x WHERE x.id = l.dispatch_id;
 IF d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id) THEN RAISE EXCEPTION 'Despacho inexistente'; END IF;
 IF d.status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','CANCELADO') THEN RAISE EXCEPTION 'El costo final se valida después de la ejecución'; END IF;
 IF public.economic_closure_status(d.id) IN ('EN_REVISION','CERRADO') THEN
  RAISE EXCEPTION 'El cierre económico de la ruta está en revisión o cerrado: obsérvelo o reábralo para corregir';
 END IF;
 IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'Datos inválidos'; END IF;
 v_extras := COALESCE(NULLIF(p->>'extras_pen','')::numeric, 0);
 v_reason := NULLIF(btrim(COALESCE(p->>'reason','')),'');
 IF v_extras < 0 OR v_extras > 10000000 OR v_extras <> round(v_extras, 2) THEN RAISE EXCEPTION 'Adicionales inválidos (dos decimales)'; END IF;
 IF length(COALESCE(v_reason,'')) > 1000 THEN RAISE EXCEPTION 'Motivo demasiado extenso'; END IF;

 IF l.agreed_rate IS NOT NULL THEN
  v_qty := NULLIF(p->>'executed_qty','')::numeric;
  IF v_qty IS NULL AND l.concept = 'MONTACARGAS' THEN  -- horas liquidadas del montacarga vinculado
   SELECT final_hours INTO v_hours FROM public.route_forklifts WHERE unloading_cost_id = l.id;
   v_qty := v_hours;
  END IF;
  IF v_qty IS NULL OR v_qty < 0 OR v_qty > 10000 OR v_qty <> round(v_qty, 2) THEN RAISE EXCEPTION 'Indique la cantidad ejecutada (horas, jornadas o servicios)'; END IF;
  v_workers := CASE WHEN l.concept = 'ESTIBA' THEN COALESCE(NULLIF(p->>'workers','')::int, l.workers, 1) END;
  IF v_workers IS NOT NULL AND (v_workers < 1 OR v_workers > 200) THEN RAISE EXCEPTION 'Cantidad de trabajadores inválida'; END IF;
  v_billable := public.economic_billable_qty(l.billing_unit, v_qty, l.fraction_minutes, l.min_billable_qty);
  v_base := round(l.agreed_rate * v_billable * COALESCE(v_workers, 1), 2);
 ELSE
  v_base := NULLIF(p->>'final_pen','')::numeric;
  IF v_base IS NULL OR v_base < 0 OR v_base > 10000000 OR v_base <> round(v_base, 2) THEN RAISE EXCEPTION 'Indique el costo final del servicio (sin tarifa acordada)'; END IF;
  v_qty := NULLIF(p->>'executed_qty','')::numeric;
 END IF;
 v_final := v_base + v_extras;
 v_reference := COALESCE(l.planned_pen, l.actual_pen, l.estimated_pen, 0);
 IF (v_final <> v_reference OR v_extras > 0) AND (v_reason IS NULL OR length(v_reason) < 5) THEN
  RAISE EXCEPTION 'Justifique la diferencia con el costo acordado de % (S/ % → S/ %)', lower(l.concept), v_reference, v_final;
 END IF;
 UPDATE public.transport_unloading_costs SET final_executed_qty = v_qty, final_workers = v_workers, final_billable_qty = v_billable,
  final_extras_pen = v_extras, final_pen = v_final, final_reason = v_reason, final_validated_by = auth.uid(), final_validated_at = now()
 WHERE id = p_line_id;
 INSERT INTO public.service_cost_events(unloading_cost_id, transport_request_id, dispatch_id, contract_id, concept, stage, old_amount, new_amount, old_status, new_status, detail, reason, created_by)
 VALUES (l.id, l.transport_request_id, l.dispatch_id, l.contract_id, l.concept, 'FINAL', l.final_pen, v_final, l.status, l.status,
  jsonb_build_object('validated', true, 'reference_pen', v_reference, 'executed_qty', v_qty, 'billable_qty', v_billable, 'workers', v_workers,
   'base_pen', v_base, 'extras_pen', v_extras), v_reason, auth.uid());
 RETURN jsonb_build_object('success', true, 'final_pen', v_final, 'base_pen', v_base, 'billable_qty', v_billable, 'reference_pen', v_reference,
  'difference_pen', v_final - v_reference);
EXCEPTION WHEN raise_exception THEN
 RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.validate_service_final(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.validate_service_final(uuid,jsonb) TO authenticated;

-- ------------------------------------------------------------
-- 4. Estado económico calculado de una ruta: montos por etapa y pendientes que impiden cerrar
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.economic_route_state(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; s record; v_pending jsonb := '[]'::jsonb; v_lines jsonb; v_freight_ref numeric; v_freight_agreed numeric; v_has_freight boolean;
BEGIN
 SELECT x.id, x.status, COALESCE(x.freight_cost, 0) AS freight_cost INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO s FROM public.dispatch_freight_stages WHERE dispatch_id = p_dispatch_id;
 SELECT COALESCE(sum(COALESCE(t.service_cost, 0)), 0) INTO v_freight_ref
 FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id WHERE dr.dispatch_id = p_dispatch_id;
 v_freight_agreed := COALESCE(s.agreed_pen, d.freight_cost);
 v_has_freight := v_freight_agreed > 0 OR d.freight_cost > 0 OR s.final_pen IS NOT NULL;
 IF d.status NOT IN ('LIQUIDADO','CERRADO') THEN
  v_pending := v_pending || jsonb_build_array('Cierre la ruta en Torre de Control');
 END IF;
 IF v_has_freight AND s.final_pen IS NULL THEN v_pending := v_pending || jsonb_build_array('Registre el flete final'); END IF;
 SELECT COALESCE(jsonb_agg('Valide el costo final de ' || lower(public.unloading_concept_label(u.concept)) || ' · ' || COALESCE(t.request_number::text, '')
   ORDER BY t.request_number, u.concept), '[]'::jsonb)
 INTO v_lines FROM public.transport_unloading_costs u JOIN public.transport_requests t ON t.id = u.transport_request_id
 WHERE u.dispatch_id = p_dispatch_id AND u.status IN ('PLANIFICADO','CONSUMIDO') AND u.final_validated_at IS NULL;
 v_pending := v_pending || v_lines;
 RETURN jsonb_build_object('status', public.economic_closure_status(p_dispatch_id), 'route_status', d.status, 'pending', v_pending,
  'referential_pen', v_freight_ref + COALESCE((SELECT sum(estimated_pen) FROM public.transport_unloading_costs WHERE dispatch_id = p_dispatch_id AND status <> 'ANULADO'), 0),
  'agreed_pen', v_freight_agreed + COALESCE((SELECT sum(COALESCE(planned_pen, estimated_pen)) FROM public.transport_unloading_costs WHERE dispatch_id = p_dispatch_id AND status <> 'ANULADO'), 0),
  'final_pen', CASE WHEN jsonb_array_length(v_pending) - CASE WHEN d.status NOT IN ('LIQUIDADO','CERRADO') THEN 1 ELSE 0 END = 0
    THEN COALESCE(s.final_pen, 0) + COALESCE((SELECT sum(final_pen) FROM public.transport_unloading_costs WHERE dispatch_id = p_dispatch_id AND status IN ('PLANIFICADO','CONSUMIDO')), 0) END,
  'extras_pen', COALESCE(s.extras_pen, 0) + COALESCE((SELECT sum(final_extras_pen) FROM public.transport_unloading_costs WHERE dispatch_id = p_dispatch_id AND status IN ('PLANIFICADO','CONSUMIDO')), 0));
END $$;
REVOKE ALL ON FUNCTION public.economic_route_state(uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.economic_can_read() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT public.has_tms_read_permission('cierre-economico') OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('documentario')
  OR public.has_tms_read_permission('torre-control') OR public.has_tms_read_permission('contratos-servicios')
$$;
REVOKE ALL ON FUNCTION public.economic_can_read() FROM PUBLIC,anon,authenticated;

-- Bandeja: rutas ejecutadas del período con su estado económico (máximo 366 días)
CREATE OR REPLACE FUNCTION public.economic_closure_queue(p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT public.economic_can_read() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al cierre económico'); END IF;
 IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 366 THEN RETURN jsonb_build_object('success', false, 'error', 'Período inválido (máximo 366 días)'); END IF;
 RETURN jsonb_build_object('success', true,
  'can_validate', public.has_tms_permission('despacho') OR public.has_tms_permission('cierre-economico'),
  'can_approve', public.has_tms_permission('cierre-economico'),
  'routes', COALESCE((SELECT jsonb_agg(jsonb_build_object('dispatch_id', x.id, 'dispatch_number', x.dispatch_number, 'status', x.status,
     'departure', x.scheduled_departure, 'plate', x.vehicle_plate,
     'contracts', (SELECT string_agg(DISTINCT c.code, ', ') FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id
        JOIN public.contracts c ON c.id = t.contract_id WHERE dr.dispatch_id = x.id),
     'requests', (SELECT string_agg(t.request_number::text, ', ' ORDER BY t.request_number) FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id WHERE dr.dispatch_id = x.id),
     'state', public.economic_route_state(x.id)) ORDER BY x.scheduled_departure DESC, x.id)
   FROM public.dispatches x
   WHERE x.status IN ('LIQUIDADO','CERRADO','RETORNO_COMPLETADO','ENTREGADO','CIERRE_OPERATIVO')
     AND (x.site_id IS NULL OR public.can_access_site(x.site_id))
     AND (x.scheduled_departure AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.economic_closure_queue(date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.economic_closure_queue(date,date) TO authenticated;

-- Detalle: servicios con su acuerdo y lo ejecutado, flete por etapas e historial del cierre
CREATE OR REPLACE FUNCTION public.economic_closure_detail(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record;
BEGIN
 IF NOT public.economic_can_read() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al cierre económico'); END IF;
 SELECT x.id, x.dispatch_number, x.status, x.site_id, x.scheduled_departure, x.vehicle_plate INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
 IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN RETURN jsonb_build_object('success', false, 'error', 'Despacho inexistente'); END IF;
 RETURN jsonb_build_object('success', true, 'dispatch_number', d.dispatch_number, 'route_status', d.status, 'departure', d.scheduled_departure,
  'plate', d.vehicle_plate, 'state', public.economic_route_state(p_dispatch_id),
  'observation', (SELECT observation FROM public.economic_closures WHERE dispatch_id = p_dispatch_id),
  'can_validate', public.has_tms_permission('despacho') OR public.has_tms_permission('cierre-economico'),
  'can_approve', public.has_tms_permission('cierre-economico'),
  'freight', public.dispatch_freight_summary(p_dispatch_id),
  'services', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'request_number', t.request_number, 'concept', u.concept, 'description', u.description,
     'status', u.status, 'origin', u.origin, 'supplier', s.business_name, 'billing_unit', u.billing_unit, 'agreed_rate', u.agreed_rate, 'agreed_qty', u.agreed_qty,
     'workers', u.workers, 'min_billable_qty', u.min_billable_qty, 'fraction_minutes', u.fraction_minutes,
     'estimated_pen', u.estimated_pen, 'planned_pen', u.planned_pen, 'actual_pen', u.actual_pen, 'expense_id', u.expense_id,
     'forklift_hours', (SELECT final_hours FROM public.route_forklifts f WHERE f.unloading_cost_id = u.id),
     'final_executed_qty', u.final_executed_qty, 'final_workers', u.final_workers, 'final_billable_qty', u.final_billable_qty,
     'final_extras_pen', u.final_extras_pen, 'final_pen', u.final_pen, 'final_reason', u.final_reason, 'final_validated_at', u.final_validated_at)
    ORDER BY t.request_number, u.concept)
   FROM public.transport_unloading_costs u JOIN public.transport_requests t ON t.id = u.transport_request_id
   LEFT JOIN public.suppliers s ON s.id = u.supplier_id
   WHERE u.dispatch_id = p_dispatch_id AND u.status <> 'ANULADO'), '[]'::jsonb),
  'voided', COALESCE((SELECT jsonb_agg(jsonb_build_object('concept', u.concept, 'request_number', t.request_number, 'reason', u.void_reason))
   FROM public.transport_unloading_costs u JOIN public.transport_requests t ON t.id = u.transport_request_id
   WHERE u.dispatch_id = p_dispatch_id AND u.status = 'ANULADO'), '[]'::jsonb),
  'events', COALESCE((SELECT jsonb_agg(jsonb_build_object('action', e.action, 'from_status', e.from_status, 'to_status', e.to_status, 'reason', e.reason,
     'detail', e.detail, 'created_at', e.created_at,
     'user', (SELECT COALESCE(NULLIF(btrim(concat_ws(' ', to_jsonb(pr)->>'first_name', to_jsonb(pr)->>'last_name')), ''), to_jsonb(pr)->>'full_name')
       FROM public.profiles pr WHERE pr.id = e.created_by)) ORDER BY e.created_at DESC)
   FROM public.economic_closure_events e WHERE e.dispatch_id = p_dispatch_id), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.economic_closure_detail(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.economic_closure_detail(uuid) TO authenticated;

-- ------------------------------------------------------------
-- 5. Impacto en la partida al aprobar: solo la diferencia entre lo ya consumido (o aplicado) y el costo final.
--    Servicio planificado sin consumir: se consume el final (libera su reserva). Consumido (Caja o factura): se ajusta.
--    Flete: una OT usa dispatches.freight_cost (consumido al cerrar la ruta); rutas mixtas, el monto de cada OT.
--    Las órdenes de referencia (OC/OS/RQ, sin OT) no tienen partida: solo se registra el final.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.economic_apply_budget(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; s record; l record; f record; v_delta numeric; v_applied numeric; v_deltas jsonb := '{}'::jsonb; v_rows int; v_service uuid;
BEGIN
 SELECT x.id, x.dispatch_number, x.contract_id, COALESCE(x.freight_cost, 0) AS freight_cost INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
 PERFORM set_config('tms.cost_reason', 'Cierre económico de la ruta ' || COALESCE(d.dispatch_number::text, ''), true);
 -- Servicios especiales
 FOR l IN SELECT u.*, sp.business_name AS supplier_name FROM public.transport_unloading_costs u LEFT JOIN public.suppliers sp ON sp.id = u.supplier_id
          WHERE u.dispatch_id = p_dispatch_id AND u.status IN ('PLANIFICADO','CONSUMIDO') AND u.final_pen IS NOT NULL ORDER BY u.contract_id, u.id FOR UPDATE OF u LOOP
  IF l.status = 'PLANIFICADO' THEN
   IF l.contract_id IS NULL THEN
    UPDATE public.transport_unloading_costs SET status = 'CONSUMIDO', actual_pen = l.final_pen, consumed_by = auth.uid(), consumed_at = now() WHERE id = l.id;
   ELSE
    PERFORM public.unloading_consume(l.id, l.final_pen, NULL, l.supplier_name);
    v_deltas := jsonb_set(v_deltas, ARRAY[l.contract_id::text], to_jsonb(COALESCE((v_deltas->>(l.contract_id::text))::numeric, 0) + l.final_pen - COALESCE(l.planned_pen, 0)));
   END IF;
  ELSIF l.final_pen IS DISTINCT FROM l.actual_pen THEN
   v_delta := l.final_pen - COALESCE(l.actual_pen, 0);
   IF l.contract_id IS NOT NULL THEN
    UPDATE public.contract_budgets SET consumed_pen = consumed_pen + v_delta, updated_at = now() WHERE contract_id = l.contract_id AND concept = 'PARTIDA_TRANSPORTE';
    UPDATE public.contract_services SET amount_pen = l.final_pen WHERE id = l.contract_service_id;
    v_deltas := jsonb_set(v_deltas, ARRAY[l.contract_id::text], to_jsonb(COALESCE((v_deltas->>(l.contract_id::text))::numeric, 0) + v_delta));
   END IF;
   UPDATE public.transport_unloading_costs SET actual_pen = l.final_pen WHERE id = l.id;
  END IF;
 END LOOP;
 -- Flete
 SELECT * INTO s FROM public.dispatch_freight_stages WHERE dispatch_id = p_dispatch_id FOR UPDATE;
 IF EXISTS (SELECT 1 FROM public.dispatch_request_freight WHERE dispatch_id = p_dispatch_id) THEN
  FOR f IN SELECT r.request_id, r.contract_id, r.amount_pen, r.service_id, st.final_pen, st.final_applied_pen
           FROM public.dispatch_request_freight r JOIN public.dispatch_request_freight_stages st ON st.dispatch_id = r.dispatch_id AND st.request_id = r.request_id
           WHERE r.dispatch_id = p_dispatch_id AND r.status <> 'LIBERADO' AND st.final_pen IS NOT NULL ORDER BY r.contract_id, r.request_id LOOP
   v_applied := COALESCE(f.final_applied_pen, f.amount_pen);
   v_delta := f.final_pen - v_applied;
   IF v_delta <> 0 AND f.contract_id IS NOT NULL THEN
    UPDATE public.contract_budgets SET consumed_pen = consumed_pen + v_delta, updated_at = now() WHERE contract_id = f.contract_id AND concept = 'PARTIDA_TRANSPORTE';
    UPDATE public.contract_services SET amount_pen = f.final_pen WHERE id = f.service_id;
    v_deltas := jsonb_set(v_deltas, ARRAY[f.contract_id::text], to_jsonb(COALESCE((v_deltas->>(f.contract_id::text))::numeric, 0) + v_delta));
   END IF;
   UPDATE public.dispatch_request_freight_stages SET final_applied_pen = f.final_pen, updated_at = now() WHERE dispatch_id = p_dispatch_id AND request_id = f.request_id;
  END LOOP;
 ELSIF s.final_pen IS NOT NULL THEN
  v_applied := COALESCE(s.final_applied_pen, d.freight_cost);
  v_delta := s.final_pen - v_applied;
  IF v_delta <> 0 AND d.contract_id IS NOT NULL THEN
   UPDATE public.contract_budgets SET consumed_pen = consumed_pen + v_delta, updated_at = now() WHERE contract_id = d.contract_id AND concept = 'PARTIDA_TRANSPORTE';
   SELECT count(*), min(id::text)::uuid INTO v_rows, v_service FROM public.contract_services
   WHERE dispatch_id = p_dispatch_id AND service_type = 'FLETE' AND COALESCE(status, '') <> 'ANULADO';
   IF v_rows = 1 THEN UPDATE public.contract_services SET amount_pen = s.final_pen WHERE id = v_service; END IF;
   v_deltas := jsonb_set(v_deltas, ARRAY[d.contract_id::text], to_jsonb(COALESCE((v_deltas->>(d.contract_id::text))::numeric, 0) + v_delta));
  END IF;
  UPDATE public.dispatch_freight_stages SET final_applied_pen = s.final_pen, updated_at = now() WHERE dispatch_id = p_dispatch_id;
 END IF;
 PERFORM set_config('tms.cost_reason', '', true);
 RETURN v_deltas;
END $$;
REVOKE ALL ON FUNCTION public.economic_apply_budget(uuid) FROM PUBLIC,anon,authenticated;

-- ------------------------------------------------------------
-- 6. Acciones: ENVIAR (a revisión), APROBAR (cierra e impacta la partida), OBSERVAR, REABRIR
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.economic_closure_action(p_dispatch_id uuid, p_action text, p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; v_from text; v_to text; v_state jsonb; v_reason text := NULLIF(btrim(COALESCE(p_reason,'')),''); v_action text := upper(COALESCE(p_action,''));
 v_detail jsonb := '{}'::jsonb;
BEGIN
 SELECT x.id, x.site_id INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id FOR UPDATE;
 IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN RAISE EXCEPTION 'Despacho inexistente'; END IF;
 IF length(COALESCE(v_reason,'')) > 1000 THEN RAISE EXCEPTION 'Motivo demasiado extenso'; END IF;
 INSERT INTO public.economic_closures(dispatch_id) VALUES (p_dispatch_id) ON CONFLICT (dispatch_id) DO NOTHING;
 SELECT status INTO v_from FROM public.economic_closures WHERE dispatch_id = p_dispatch_id FOR UPDATE;
 v_state := public.economic_route_state(p_dispatch_id);
 IF v_action = 'ENVIAR' THEN
  IF NOT (public.has_tms_permission('despacho') OR public.has_tms_permission('cierre-economico')) THEN RAISE EXCEPTION 'Sin permiso para enviar el cierre económico'; END IF;
  IF v_from NOT IN ('PENDIENTE','OBSERVADO') THEN RAISE EXCEPTION 'El cierre económico ya está en revisión o cerrado'; END IF;
  IF jsonb_array_length(v_state->'pending') > 0 THEN RAISE EXCEPTION 'Faltan costos por validar: %', (SELECT string_agg(value, '; ') FROM jsonb_array_elements_text(v_state->'pending')); END IF;
  v_to := 'EN_REVISION';
  UPDATE public.economic_closures SET status = v_to, submitted_by = auth.uid(), submitted_at = now(), observation = NULL, updated_at = now() WHERE dispatch_id = p_dispatch_id;
 ELSIF v_action IN ('APROBAR','OBSERVAR','REABRIR') THEN
  IF NOT public.has_tms_permission('cierre-economico') THEN RAISE EXCEPTION 'Solo quien tiene el permiso de Cierre económico aprueba, observa o reabre'; END IF;
  IF v_action = 'APROBAR' THEN
   IF v_from <> 'EN_REVISION' THEN RAISE EXCEPTION 'Solo se aprueba un cierre enviado a revisión'; END IF;
   IF jsonb_array_length(v_state->'pending') > 0 THEN RAISE EXCEPTION 'Faltan costos por validar: %', (SELECT string_agg(value, '; ') FROM jsonb_array_elements_text(v_state->'pending')); END IF;
   v_to := 'CERRADO';
   v_detail := jsonb_build_object('budget_delta_by_contract', public.economic_apply_budget(p_dispatch_id), 'state', v_state);
   UPDATE public.economic_closures SET status = v_to, closed_by = auth.uid(), closed_at = now(), updated_at = now() WHERE dispatch_id = p_dispatch_id;
  ELSIF v_action = 'OBSERVAR' THEN
   IF v_from <> 'EN_REVISION' THEN RAISE EXCEPTION 'Solo se observa un cierre enviado a revisión'; END IF;
   IF v_reason IS NULL OR length(v_reason) < 5 THEN RAISE EXCEPTION 'Indique la observación (mínimo 5 caracteres)'; END IF;
   v_to := 'OBSERVADO';
   UPDATE public.economic_closures SET status = v_to, observation = v_reason, updated_at = now() WHERE dispatch_id = p_dispatch_id;
  ELSE
   IF v_from <> 'CERRADO' THEN RAISE EXCEPTION 'Solo se reabre un cierre económico cerrado'; END IF;
   IF v_reason IS NULL OR length(v_reason) < 5 THEN RAISE EXCEPTION 'Indique el motivo de la reapertura (mínimo 5 caracteres)'; END IF;
   v_to := 'PENDIENTE';
   UPDATE public.economic_closures SET status = v_to, closed_by = NULL, closed_at = NULL, observation = v_reason, reopened_count = reopened_count + 1, updated_at = now()
   WHERE dispatch_id = p_dispatch_id;
  END IF;
 ELSE
  RAISE EXCEPTION 'Acción inválida';
 END IF;
 INSERT INTO public.economic_closure_events(dispatch_id, action, from_status, to_status, reason, detail, created_by)
 VALUES (p_dispatch_id, v_action, v_from, v_to, v_reason, v_detail, auth.uid());
 RETURN jsonb_build_object('success', true, 'status', v_to, 'detail', v_detail);
EXCEPTION WHEN raise_exception THEN
 RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.economic_closure_action(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.economic_closure_action(uuid,text,text) TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
