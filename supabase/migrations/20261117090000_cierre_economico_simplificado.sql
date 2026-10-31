-- Cierre económico simplificado: solo se trabaja a mano lo que se sale de lo acordado.
--  · «Conforme» (por ruta o en lote): registra como final lo acordado de lo que falte y cierra.
--  · Lo que queda dentro del umbral (economic_settings) y sin adicionales se aprueba al validarlo; lo que lo supera pasa a
--    «Por aprobar» (Cierre económico). Quien tiene el permiso de Cierre económico corrige y aprueba directamente.
--  · El motivo solo es obligatorio sobre el umbral o con adicionales.
--  · El cierre económico empieza al liberar la unidad: ya no espera la liquidación en Torre de Control.
-- Se mantienen: historial de costos, bloqueo de ítems aprobados, impacto en la partida solo por la diferencia.
BEGIN;
SET LOCAL lock_timeout='60s';

ALTER TABLE public.economic_closure_events DROP CONSTRAINT IF EXISTS economic_closure_events_action_check;
ALTER TABLE public.economic_closure_events ADD CONSTRAINT economic_closure_events_action_check
 CHECK (action IN ('ENVIAR','APROBAR','OBSERVAR','REABRIR','NOTA','AGREGAR','AUTOMATICO','CONFORME'));

-- Desviación sobre el umbral configurable (igual que isDeviation en la app)
CREATE OR REPLACE FUNCTION public.economic_deviation(p_agreed numeric, p_final numeric) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s jsonb := public.economic_settings_get(); v_d numeric;
BEGIN
 IF p_final IS NULL THEN RETURN false; END IF;
 v_d := abs(round(p_final - COALESCE(p_agreed, 0), 2));
 IF v_d < 0.01 THEN RETURN false; END IF;
 IF v_d > (s->>'deviation_pen')::numeric THEN RETURN true; END IF;
 RETURN CASE WHEN COALESCE(p_agreed, 0) > 0 THEN v_d / p_agreed * 100 > (s->>'deviation_pct')::numeric ELSE true END;
END $$;
REVOKE ALL ON FUNCTION public.economic_deviation(numeric,numeric) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.register_dispatch_freight_final(p_dispatch_id uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; s record; e jsonb; v_agreed numeric; v_as_planned boolean; v_base numeric; v_extras numeric; v_final numeric;
 v_reason text; v_rows int; v_sum numeric := 0; v_alloc jsonb := '{}'::jsonb; v_agreed_total numeric; v_left numeric; r record; v_i int := 0; v_share numeric;
BEGIN
 IF NOT (public.has_tms_permission('despacho') OR public.has_tms_permission('contratos-servicios') OR public.has_tms_permission('cierre-economico')) THEN
  RAISE EXCEPTION 'Sin permiso para registrar el flete final';
 END IF;
 SELECT x.id, x.status, x.site_id, x.contract_id, COALESCE(x.freight_cost, 0) AS freight_cost INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id FOR UPDATE;
 IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN RAISE EXCEPTION 'Despacho inexistente'; END IF;
 IF d.status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','CANCELADO') THEN
  RAISE EXCEPTION 'El flete final se registra después de la ejecución del servicio';
 END IF;
 IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'Datos del flete final inválidos'; END IF;
 SELECT * INTO s FROM public.dispatch_freight_stages WHERE dispatch_id = p_dispatch_id FOR UPDATE;
 v_agreed := COALESCE(s.agreed_pen, d.freight_cost);  -- rutas anteriores a esta etapa: el flete vigente
 v_as_planned := COALESCE((p->>'executed_as_planned')::boolean, true);
 v_base := CASE WHEN v_as_planned THEN v_agreed ELSE NULLIF(p->>'base_pen','')::numeric END;
 v_extras := COALESCE(NULLIF(p->>'extras_pen','')::numeric, 0);
 v_reason := NULLIF(btrim(COALESCE(p->>'reason','')),'');
 IF v_base IS NULL OR v_base < 0 OR v_base > 10000000 OR v_base <> round(v_base, 2) THEN
  RAISE EXCEPTION 'Indique el flete ejecutado (dos decimales)';
 END IF;
 IF v_extras < 0 OR v_extras > 10000000 OR v_extras <> round(v_extras, 2) THEN RAISE EXCEPTION 'Adicionales inválidos (dos decimales)'; END IF;
 v_final := v_base + v_extras;
 IF (public.economic_deviation(v_agreed, v_final) OR v_extras > 0) AND (v_reason IS NULL OR length(v_reason) < 5) THEN
  RAISE EXCEPTION 'Justifique la diferencia con el flete acordado (S/ % → S/ %)', v_agreed, v_final;
 END IF;
 IF length(COALESCE(v_reason,'')) > 1000 THEN RAISE EXCEPTION 'Motivo demasiado extenso'; END IF;

 -- Rutas mixtas: el final se imputa por OT sin duplicar (suma exacta)
 SELECT count(*), COALESCE(sum(COALESCE(st.agreed_pen, f.amount_pen)), 0) INTO v_rows, v_agreed_total
 FROM public.dispatch_request_freight f LEFT JOIN public.dispatch_request_freight_stages st ON st.dispatch_id = f.dispatch_id AND st.request_id = f.request_id
 WHERE f.dispatch_id = p_dispatch_id AND f.status <> 'LIBERADO';
 IF v_rows > 0 THEN
  IF jsonb_typeof(p->'allocation') = 'array' AND jsonb_array_length(p->'allocation') > 0 THEN
   FOR e IN SELECT value FROM jsonb_array_elements(p->'allocation') LOOP
    IF NOT EXISTS (SELECT 1 FROM public.dispatch_request_freight WHERE dispatch_id = p_dispatch_id AND request_id = NULLIF(e->>'request_id','')::uuid AND status <> 'LIBERADO') THEN
     RAISE EXCEPTION 'El servicio del reparto no pertenece a esta ruta';
    END IF;
    v_share := NULLIF(e->>'final_pen','')::numeric;
    IF v_share IS NULL OR v_share < 0 OR v_share <> round(v_share, 2) OR v_alloc ? (e->>'request_id') THEN RAISE EXCEPTION 'Reparto del flete final inválido'; END IF;
    v_alloc := v_alloc || jsonb_build_object(e->>'request_id', v_share); v_sum := v_sum + v_share;
   END LOOP;
   IF (SELECT count(*) FROM jsonb_object_keys(v_alloc)) <> v_rows OR v_sum <> v_final THEN
    RAISE EXCEPTION 'El reparto por OT debe cubrir todos los servicios y sumar el flete final (S/ %)', v_final;
   END IF;
  ELSE
   -- Proporcional a lo acordado por OT; el redondeo queda en el último servicio
   v_left := v_final;
   FOR r IN SELECT f.request_id, COALESCE(st.agreed_pen, f.amount_pen) AS agreed FROM public.dispatch_request_freight f
            LEFT JOIN public.dispatch_request_freight_stages st ON st.dispatch_id = f.dispatch_id AND st.request_id = f.request_id
            WHERE f.dispatch_id = p_dispatch_id AND f.status <> 'LIBERADO' ORDER BY f.contract_id, f.request_id LOOP
    v_i := v_i + 1;
    v_share := CASE WHEN v_i = v_rows THEN v_left
                    WHEN v_agreed_total > 0 THEN round(v_final * r.agreed / v_agreed_total, 2) ELSE round(v_final / v_rows, 2) END;
    v_alloc := v_alloc || jsonb_build_object(r.request_id::text, v_share); v_left := v_left - v_share;
   END LOOP;
  END IF;
  INSERT INTO public.dispatch_request_freight_stages(dispatch_id, request_id, agreed_pen, final_pen)
  SELECT f.dispatch_id, f.request_id, f.amount_pen, (v_alloc->>(f.request_id::text))::numeric
  FROM public.dispatch_request_freight f WHERE f.dispatch_id = p_dispatch_id AND f.status <> 'LIBERADO'
  ON CONFLICT (dispatch_id, request_id) DO UPDATE SET final_pen = EXCLUDED.final_pen, updated_at = now();
 END IF;

 INSERT INTO public.dispatch_freight_stages(dispatch_id, agreed_pen, base_pen, extras_pen, final_pen, executed_as_planned, final_reason, final_by, final_at)
 VALUES (p_dispatch_id, v_agreed, v_base, v_extras, v_final, v_as_planned, v_reason, auth.uid(), now())
 ON CONFLICT (dispatch_id) DO UPDATE SET agreed_pen = COALESCE(dispatch_freight_stages.agreed_pen, EXCLUDED.agreed_pen), base_pen = EXCLUDED.base_pen,
  extras_pen = EXCLUDED.extras_pen, final_pen = EXCLUDED.final_pen, executed_as_planned = EXCLUDED.executed_as_planned,
  final_reason = EXCLUDED.final_reason, final_by = EXCLUDED.final_by, final_at = EXCLUDED.final_at, updated_at = now();
 INSERT INTO public.service_cost_events(service_kind, dispatch_id, contract_id, concept, stage, old_amount, new_amount, new_status, detail, reason, created_by)
 VALUES ('FLETE', p_dispatch_id, d.contract_id, 'FLETE', 'FINAL', s.final_pen, v_final, d.status,
  jsonb_build_object('agreed_pen', v_agreed, 'base_pen', v_base, 'extras_pen', v_extras, 'executed_as_planned', v_as_planned, 'allocation', v_alloc),
  v_reason, auth.uid());
 RETURN jsonb_build_object('success', true, 'agreed_pen', v_agreed, 'final_pen', v_final, 'difference_pen', v_final - v_agreed, 'allocation', v_alloc);
EXCEPTION WHEN raise_exception THEN
 RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.register_dispatch_freight_final(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.register_dispatch_freight_final(uuid,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.dispatch_freight_summary(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; s record; v_name text;
BEGIN
 IF NOT (public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('torre-control')
   OR public.has_tms_read_permission('documentario') OR public.has_tms_read_permission('contratos-servicios')) THEN
  RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al flete de la ruta');
 END IF;
 SELECT x.id, x.status, x.site_id, COALESCE(x.freight_cost, 0) AS freight_cost INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
 IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN RETURN jsonb_build_object('success', false, 'error', 'Despacho inexistente'); END IF;
 SELECT * INTO s FROM public.dispatch_freight_stages WHERE dispatch_id = p_dispatch_id;
 SELECT COALESCE(NULLIF(btrim(concat_ws(' ', to_jsonb(pr)->>'first_name', to_jsonb(pr)->>'last_name')), ''), to_jsonb(pr)->>'full_name')
 INTO v_name FROM public.profiles pr WHERE pr.id = s.final_by;
 RETURN jsonb_build_object('success', true, 'status', d.status,
  'referential_pen', (SELECT COALESCE(sum(public.request_referential_freight(t.id)), 0) FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id WHERE dr.dispatch_id = p_dispatch_id),
  'agreed_pen', COALESCE(s.agreed_pen, d.freight_cost), 'agreed_recorded', s.agreed_pen IS NOT NULL, 'current_pen', d.freight_cost,
  'base_pen', s.base_pen, 'extras_pen', s.extras_pen, 'final_pen', s.final_pen, 'executed_as_planned', s.executed_as_planned,
  'final_reason', s.final_reason, 'final_at', s.final_at, 'final_by', v_name,
  'can_register_final', d.status NOT IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','CANCELADO')
    AND (public.has_tms_permission('despacho') OR public.has_tms_permission('contratos-servicios') OR public.has_tms_permission('cierre-economico')),
  'by_request', COALESCE((SELECT jsonb_agg(jsonb_build_object('request_id', f.request_id, 'request_number', t.request_number,
     'contract_code', (SELECT c.code FROM public.contracts c WHERE c.id = f.contract_id), 'referential_pen', public.request_referential_freight(t.id),
     'agreed_pen', COALESCE(st.agreed_pen, f.amount_pen), 'current_pen', f.amount_pen, 'final_pen', st.final_pen, 'status', f.status)
    ORDER BY t.request_number)
   FROM public.dispatch_request_freight f JOIN public.transport_requests t ON t.id = f.request_id
   LEFT JOIN public.dispatch_request_freight_stages st ON st.dispatch_id = f.dispatch_id AND st.request_id = f.request_id
   WHERE f.dispatch_id = p_dispatch_id), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.dispatch_freight_summary(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dispatch_freight_summary(uuid) TO authenticated;

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
  IF v_qty IS NULL OR v_qty < 0 OR v_qty > 10000 OR v_qty <> round(v_qty, 2) THEN
   RAISE EXCEPTION 'Indique la cantidad ejecutada (horas, jornadas, servicios, unidades o toneladas)';
  END IF;
  v_workers := CASE WHEN l.concept = 'ESTIBA' AND COALESCE(l.billing_unit, 'SERVICIO') NOT IN ('UNIDAD','TONELADA')
   THEN COALESCE(NULLIF(p->>'workers','')::int, l.workers, 1) END;
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
 IF (public.economic_deviation(v_reference, v_final) OR v_extras > 0) AND (v_reason IS NULL OR length(v_reason) < 5) THEN
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

CREATE OR REPLACE FUNCTION public.economic_route_state(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; s record; v_pending jsonb := '[]'::jsonb; v_lines jsonb; v_freight_ref numeric; v_freight_agreed numeric; v_has_freight boolean; v_items jsonb;
BEGIN
 SELECT x.id, x.status, COALESCE(x.freight_cost, 0) AS freight_cost INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO s FROM public.dispatch_freight_stages WHERE dispatch_id = p_dispatch_id;
 SELECT COALESCE(sum(COALESCE(public.request_referential_freight(t.id), 0)), 0) INTO v_freight_ref
 FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id WHERE dr.dispatch_id = p_dispatch_id;
 v_freight_agreed := COALESCE(s.agreed_pen, d.freight_cost);
 v_has_freight := v_freight_agreed > 0 OR d.freight_cost > 0 OR s.final_pen IS NOT NULL;
 IF d.status NOT IN ('RETORNO_COMPLETADO','CIERRE_OPERATIVO','LIQUIDADO','CERRADO') THEN
  v_pending := v_pending || jsonb_build_array('La unidad aún no está liberada');
 END IF;
 IF v_has_freight AND s.final_pen IS NULL THEN v_pending := v_pending || jsonb_build_array('Registre el flete final'); END IF;
 SELECT COALESCE(jsonb_agg('Valide el costo final de ' || lower(public.unloading_concept_label(u.concept)) || ' · ' || COALESCE(t.request_number::text, '')
   ORDER BY t.request_number, u.concept), '[]'::jsonb)
 INTO v_lines FROM public.transport_unloading_costs u JOIN public.transport_requests t ON t.id = u.transport_request_id
 WHERE u.dispatch_id = p_dispatch_id AND u.status IN ('PLANIFICADO','CONSUMIDO') AND u.final_validated_at IS NULL;
 v_pending := v_pending || v_lines;
 v_items := public.economic_route_items(p_dispatch_id);
 RETURN jsonb_build_object('status', public.economic_closure_status(p_dispatch_id), 'route_status', d.status, 'pending', v_pending,
  'referential_pen', v_freight_ref + COALESCE((SELECT sum(estimated_pen) FROM public.transport_unloading_costs WHERE dispatch_id = p_dispatch_id AND status <> 'ANULADO'), 0),
  'agreed_pen', v_freight_agreed + COALESCE((SELECT sum(COALESCE(planned_pen, estimated_pen)) FROM public.transport_unloading_costs WHERE dispatch_id = p_dispatch_id AND status <> 'ANULADO'), 0),
  'final_pen', CASE WHEN jsonb_array_length(v_pending) - CASE WHEN d.status NOT IN ('RETORNO_COMPLETADO','CIERRE_OPERATIVO','LIQUIDADO','CERRADO') THEN 1 ELSE 0 END = 0
    THEN COALESCE(s.final_pen, 0) + COALESCE((SELECT sum(final_pen) FROM public.transport_unloading_costs WHERE dispatch_id = p_dispatch_id AND status IN ('PLANIFICADO','CONSUMIDO')), 0) END,
  'extras_pen', COALESCE(s.extras_pen, 0) + COALESCE((SELECT sum(final_extras_pen) FROM public.transport_unloading_costs WHERE dispatch_id = p_dispatch_id AND status IN ('PLANIFICADO','CONSUMIDO')), 0),
  'items_total', jsonb_array_length(v_items),
  'items_approved', (SELECT count(*) FROM jsonb_array_elements(v_items) WHERE value->>'status' = 'APROBADO'));
END $$;
REVOKE ALL ON FUNCTION public.economic_route_state(uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.economic_item_action(p_dispatch_id uuid, p_item text, p_action text, p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; v_from text; v_to text; v_res jsonb; v_reason text := NULLIF(btrim(COALESCE(p_reason,'')),''); v_action text := upper(COALESCE(p_action,''));
BEGIN
 IF v_action = 'ENVIAR' THEN
  IF NOT (public.has_tms_permission('despacho') OR public.has_tms_permission('cierre-economico')) THEN RAISE EXCEPTION 'Sin permiso para enviar costos a revisión'; END IF;
 ELSIF v_action IN ('APROBAR','OBSERVAR','REABRIR') THEN
  IF NOT public.has_tms_permission('cierre-economico') THEN RAISE EXCEPTION 'Solo quien tiene el permiso de Cierre económico aprueba, observa o reabre'; END IF;
 ELSE
  RAISE EXCEPTION 'Acción inválida';
 END IF;
 SELECT x.id, x.site_id, x.status INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id FOR UPDATE;
 IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN RAISE EXCEPTION 'Despacho inexistente'; END IF;
 IF v_action IN ('ENVIAR','APROBAR') AND d.status NOT IN ('RETORNO_COMPLETADO','CIERRE_OPERATIVO','LIQUIDADO','CERRADO') THEN RAISE EXCEPTION 'La unidad aún no está liberada: el cierre económico empieza al liberarla'; END IF;
 IF v_action IN ('OBSERVAR','REABRIR') AND (v_reason IS NULL OR length(v_reason) < 5) THEN RAISE EXCEPTION 'Indique el motivo (mínimo 5 caracteres)'; END IF;
 IF length(COALESCE(v_reason,'')) > 1000 THEN RAISE EXCEPTION 'Motivo demasiado extenso'; END IF;
 INSERT INTO public.economic_closures(dispatch_id) VALUES (p_dispatch_id) ON CONFLICT (dispatch_id) DO NOTHING;
 SELECT status INTO v_from FROM public.economic_closures WHERE dispatch_id = p_dispatch_id FOR UPDATE;
 v_res := public.economic_item_set(p_dispatch_id, p_item, v_action, v_reason);
 v_to := public.economic_route_sync(p_dispatch_id, CASE WHEN v_action = 'REABRIR' THEN 'REABRIR_ITEM' ELSE v_action END, v_reason);
 IF v_action = 'REABRIR' THEN UPDATE public.economic_closures SET reopened_count = reopened_count + 1, observation = v_reason WHERE dispatch_id = p_dispatch_id; END IF;
 INSERT INTO public.economic_closure_events(dispatch_id, action, from_status, to_status, reason, detail, created_by)
 VALUES (p_dispatch_id, v_action, v_from, v_to, v_reason,
  jsonb_build_object('item', jsonb_build_object('key', v_res->>'key', 'label', v_res->>'label', 'from', v_res->>'from', 'to', v_res->>'to'),
   'budget_delta_by_contract', v_res->'budget_delta_by_contract'), auth.uid());
 RETURN jsonb_build_object('success', true, 'status', v_to, 'item_status', v_res->>'to', 'detail', v_res);
EXCEPTION WHEN raise_exception THEN
 RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.economic_item_action(uuid,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.economic_item_action(uuid,text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.economic_auto_close(p_dispatch_id uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; s record; v_from text; v_to text; v_own boolean; v_mixed boolean; v_done text := NULL;
 v_reason text := 'Flete de flota propia confirmado automáticamente al liberar la unidad';
BEGIN
 SELECT x.id, x.status, x.contract_id, COALESCE(x.freight_cost, 0) AS freight_cost,
   COALESCE(to_jsonb(x)->>'modalidad', CASE WHEN NULLIF(to_jsonb(x)->>'carrier_id', '') IS NOT NULL THEN 'TERCERO' ELSE 'PROPIA' END) AS modalidad
 INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
 IF NOT FOUND OR d.status NOT IN ('RETORNO_COMPLETADO','CIERRE_OPERATIVO','LIQUIDADO','CERRADO') THEN RETURN NULL; END IF;
 v_own := d.modalidad <> 'TERCERO';
 v_mixed := EXISTS (SELECT 1 FROM public.dispatch_request_freight WHERE dispatch_id = p_dispatch_id AND status <> 'LIBERADO');

 -- C · flete propio: final = vigente (ya consumido por la partida), aplicado y aprobado
 IF v_own THEN
  SELECT * INTO s FROM public.dispatch_freight_stages WHERE dispatch_id = p_dispatch_id FOR UPDATE;
  IF v_mixed THEN
   INSERT INTO public.dispatch_request_freight_stages(dispatch_id, request_id, agreed_pen, final_pen, final_applied_pen, econ_status, econ_approved_at)
   SELECT f.dispatch_id, f.request_id, f.amount_pen, f.amount_pen, f.amount_pen, 'APROBADO', now()
   FROM public.dispatch_request_freight f WHERE f.dispatch_id = p_dispatch_id AND f.status <> 'LIBERADO'
   ON CONFLICT (dispatch_id, request_id) DO UPDATE SET final_pen = EXCLUDED.final_pen, final_applied_pen = EXCLUDED.final_applied_pen,
     econ_status = 'APROBADO', econ_approved_at = now(), updated_at = now()
   WHERE dispatch_request_freight_stages.final_pen IS NULL AND dispatch_request_freight_stages.econ_status IS NULL;
  END IF;
  IF (d.freight_cost > 0 OR COALESCE(s.agreed_pen, 0) > 0) AND s.final_pen IS NULL THEN
   INSERT INTO public.dispatch_freight_stages(dispatch_id, agreed_pen, base_pen, extras_pen, final_pen, executed_as_planned, final_reason, final_at,
     final_applied_pen, econ_status, econ_approved_at)
   VALUES (p_dispatch_id, d.freight_cost, d.freight_cost, 0, d.freight_cost, true, v_reason, now(), d.freight_cost, 'APROBADO', now())
   ON CONFLICT (dispatch_id) DO UPDATE SET base_pen = EXCLUDED.base_pen, extras_pen = 0, final_pen = EXCLUDED.final_pen, executed_as_planned = true,
     final_reason = EXCLUDED.final_reason, final_at = now(), final_applied_pen = EXCLUDED.final_applied_pen, econ_status = 'APROBADO', econ_approved_at = now(), updated_at = now();
   INSERT INTO public.service_cost_events(service_kind, dispatch_id, contract_id, concept, stage, old_amount, new_amount, new_status, detail, reason, created_by)
   VALUES ('FLETE', p_dispatch_id, d.contract_id, 'FLETE', 'FINAL', NULL, d.freight_cost, d.status,
    jsonb_build_object('automatico', true, 'modalidad', d.modalidad, 'agreed_pen', s.agreed_pen), v_reason, auth.uid());
   v_done := 'FLETE_PROPIO';
  END IF;
 END IF;

 -- B y estado de la ruta: solo se actualiza un cierre que nadie ha trabajado todavía
 INSERT INTO public.economic_closures(dispatch_id) VALUES (p_dispatch_id) ON CONFLICT (dispatch_id) DO NOTHING;
 SELECT status INTO v_from FROM public.economic_closures WHERE dispatch_id = p_dispatch_id FOR UPDATE;
 IF v_from <> 'PENDIENTE' THEN RETURN v_from; END IF;
 v_to := CASE WHEN jsonb_array_length(public.economic_route_items(p_dispatch_id)) = 0 THEN 'NO_APLICA' ELSE public.economic_route_derive(p_dispatch_id) END;
 IF v_to IS DISTINCT FROM v_from THEN
  UPDATE public.economic_closures SET status = v_to, updated_at = now(),
   closed_at = CASE WHEN v_to IN ('CERRADO','NO_APLICA') THEN now() END,
   observation = CASE v_to WHEN 'NO_APLICA' THEN 'Ruta sin costos: no requiere cierre económico' ELSE observation END
  WHERE dispatch_id = p_dispatch_id;
  INSERT INTO public.economic_closure_events(dispatch_id, action, from_status, to_status, reason, detail, created_by)
  VALUES (p_dispatch_id, 'AUTOMATICO', v_from, v_to,
   CASE v_to WHEN 'NO_APLICA' THEN 'Ruta sin costos: no requiere cierre económico' ELSE v_reason END,
   jsonb_build_object('criterio', CASE v_to WHEN 'NO_APLICA' THEN 'SIN_COSTO' ELSE COALESCE(v_done, 'ESTADO') END), auth.uid());
 END IF;
 RETURN v_to;
END $$;
REVOKE ALL ON FUNCTION public.economic_auto_close(uuid) FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS dispatch_economic_auto_close ON public.dispatches;
CREATE TRIGGER dispatch_economic_auto_close AFTER UPDATE OF status ON public.dispatches
 FOR EACH ROW WHEN (NEW.status IN ('RETORNO_COMPLETADO','CIERRE_OPERATIVO','LIQUIDADO','CERRADO') AND OLD.status IS DISTINCT FROM NEW.status)
 EXECUTE FUNCTION public.dispatch_economic_auto_close();

-- Cierra lo validado: dentro del umbral y sin adicionales se aprueba; sobre el umbral pasa a «Por aprobar».
-- Quien tiene el permiso de Cierre económico aprueba también lo que supera el umbral (es quien lo autoriza).
CREATE OR REPLACE FUNCTION public.economic_settle(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i jsonb; v_res jsonb; v_approver boolean := public.has_tms_permission('cierre-economico'); v_freight_extras numeric;
 v_approved jsonb := '[]'::jsonb; v_review jsonb := '[]'::jsonb; v_deltas jsonb := '{}'::jsonb; k text; v_dev boolean;
BEGIN
 SELECT COALESCE(extras_pen, 0) INTO v_freight_extras FROM public.dispatch_freight_stages WHERE dispatch_id = p_dispatch_id;
 FOR i IN SELECT value FROM jsonb_array_elements(public.economic_route_items(p_dispatch_id)) WHERE value->>'status' = 'VALIDADO' LOOP
  v_dev := public.economic_deviation((i->>'agreed_pen')::numeric, (i->>'final_pen')::numeric)
   OR COALESCE((i->>'extras_pen')::numeric, 0) > 0 OR (i->>'kind' = 'FLETE' AND COALESCE(v_freight_extras, 0) > 0);
  IF v_approver OR NOT v_dev THEN
   v_res := public.economic_item_set(p_dispatch_id, i->>'key', 'APROBAR', NULL);
   v_approved := v_approved || jsonb_build_array(v_res->>'label');
   FOR k IN SELECT jsonb_object_keys(v_res->'budget_delta_by_contract') LOOP
    v_deltas := jsonb_set(v_deltas, ARRAY[k], to_jsonb(COALESCE((v_deltas->>k)::numeric, 0) + (v_res->'budget_delta_by_contract'->>k)::numeric));
   END LOOP;
  ELSE
   v_res := public.economic_item_set(p_dispatch_id, i->>'key', 'ENVIAR', NULL);
   v_review := v_review || jsonb_build_array(v_res->>'label');
  END IF;
 END LOOP;
 RETURN jsonb_build_object('approved', v_approved, 'review', v_review, 'budget_delta_by_contract', v_deltas);
END $$;
REVOKE ALL ON FUNCTION public.economic_settle(uuid) FROM PUBLIC,anon,authenticated;

-- «Conforme» (p_conforme = true): registra como final lo acordado de lo que aún no tiene final y cierra.
-- Con p_conforme = false solo cierra lo ya validado (se llama al guardar un costo final en el panel).
CREATE OR REPLACE FUNCTION public.economic_confirm(p_dispatch_id uuid, p_conforme boolean DEFAULT true) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; s record; u record; v_from text; v_to text; v_out jsonb; v_settle jsonb; v_filled jsonb := '[]'::jsonb;
BEGIN
 IF NOT (public.has_tms_permission('despacho') OR public.has_tms_permission('cierre-economico')) THEN RAISE EXCEPTION 'Sin permiso para cerrar costos'; END IF;
 SELECT x.id, x.site_id, x.status, x.dispatch_number, COALESCE(x.freight_cost, 0) AS freight_cost INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id FOR UPDATE;
 IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN RAISE EXCEPTION 'Despacho inexistente'; END IF;
 IF d.status NOT IN ('RETORNO_COMPLETADO','CIERRE_OPERATIVO','LIQUIDADO','CERRADO') THEN RAISE EXCEPTION 'Ruta %: la unidad aún no está liberada', d.dispatch_number; END IF;
 INSERT INTO public.economic_closures(dispatch_id) VALUES (p_dispatch_id) ON CONFLICT (dispatch_id) DO NOTHING;
 SELECT status INTO v_from FROM public.economic_closures WHERE dispatch_id = p_dispatch_id FOR UPDATE;
 IF v_from IN ('CERRADO','NO_APLICA') THEN RETURN jsonb_build_object('success', true, 'status', v_from, 'approved', '[]'::jsonb, 'review', '[]'::jsonb); END IF;
 IF COALESCE(p_conforme, true) THEN
  IF v_from = 'EN_REVISION' THEN RAISE EXCEPTION 'Ruta %: ya está por aprobar', d.dispatch_number; END IF;
  -- Flete: conforme a lo programado
  SELECT * INTO s FROM public.dispatch_freight_stages WHERE dispatch_id = p_dispatch_id;
  IF s.final_pen IS NULL AND (d.freight_cost > 0 OR COALESCE(s.agreed_pen, 0) > 0
     OR EXISTS (SELECT 1 FROM public.dispatch_request_freight WHERE dispatch_id = p_dispatch_id AND status <> 'LIBERADO')) THEN
   v_out := public.register_dispatch_freight_final(p_dispatch_id, jsonb_build_object('executed_as_planned', true, 'extras_pen', 0));
   IF NOT COALESCE((v_out->>'success')::boolean, false) THEN RAISE EXCEPTION 'Ruta %: %', d.dispatch_number, v_out->>'error'; END IF;
   v_filled := v_filled || jsonb_build_array('Transporte');
  END IF;
  -- Servicios: lo acordado (con tarifa: la cantidad acordada; montacarga: las horas liquidadas)
  FOR u IN SELECT * FROM public.transport_unloading_costs WHERE dispatch_id = p_dispatch_id AND status IN ('PLANIFICADO','CONSUMIDO') AND final_validated_at IS NULL LOOP
   v_out := public.validate_service_final(u.id, CASE WHEN u.agreed_rate IS NOT NULL
     THEN jsonb_build_object('executed_qty', CASE WHEN u.concept = 'MONTACARGAS' AND EXISTS (SELECT 1 FROM public.route_forklifts rf WHERE rf.unloading_cost_id = u.id AND rf.final_hours IS NOT NULL) THEN NULL ELSE COALESCE(u.agreed_qty, 1) END,
       'workers', u.workers, 'extras_pen', 0)
     ELSE jsonb_build_object('final_pen', COALESCE(u.planned_pen, u.actual_pen, u.estimated_pen, 0), 'extras_pen', 0) END);
   IF NOT COALESCE((v_out->>'success')::boolean, false) THEN RAISE EXCEPTION 'Ruta %: %', d.dispatch_number, v_out->>'error'; END IF;
   v_filled := v_filled || jsonb_build_array(public.unloading_concept_label(u.concept));
  END LOOP;
 END IF;
 v_settle := public.economic_settle(p_dispatch_id);
 v_to := CASE WHEN jsonb_array_length(public.economic_route_items(p_dispatch_id)) = 0 THEN 'NO_APLICA' ELSE public.economic_route_sync(p_dispatch_id,
  CASE WHEN jsonb_array_length(v_settle->'review') > 0 THEN 'ENVIAR' ELSE 'APROBAR' END, NULL) END;
 IF v_to = 'NO_APLICA' THEN
  UPDATE public.economic_closures SET status = 'NO_APLICA', closed_at = now(), observation = 'Ruta sin costos: no requiere cierre económico', updated_at = now() WHERE dispatch_id = p_dispatch_id;
 END IF;
 IF jsonb_array_length(v_filled) > 0 OR jsonb_array_length(v_settle->'approved') > 0 OR jsonb_array_length(v_settle->'review') > 0 OR v_to IS DISTINCT FROM v_from THEN
  INSERT INTO public.economic_closure_events(dispatch_id, action, from_status, to_status, reason, detail, created_by)
  VALUES (p_dispatch_id, 'CONFORME', v_from, v_to, CASE WHEN COALESCE(p_conforme, true) THEN 'Conforme a lo acordado' END,
   jsonb_build_object('filled', v_filled, 'approved', v_settle->'approved', 'review', v_settle->'review', 'budget_delta_by_contract', v_settle->'budget_delta_by_contract'), auth.uid());
 END IF;
 RETURN jsonb_build_object('success', true, 'status', v_to, 'approved', v_settle->'approved', 'review', v_settle->'review');
EXCEPTION WHEN raise_exception THEN
 RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.economic_confirm(uuid,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.economic_confirm(uuid,boolean) TO authenticated;

-- Rutas con la unidad liberada (aún sin liquidar en Torre) del último año: flete propio y rutas sin costo se cierran solas
DO $backfill$
DECLARE r record;
BEGIN
 FOR r IN SELECT x.id FROM public.dispatches x
          LEFT JOIN public.economic_closures c ON c.dispatch_id = x.id
          WHERE x.status IN ('RETORNO_COMPLETADO','CIERRE_OPERATIVO') AND COALESCE(c.status, 'PENDIENTE') = 'PENDIENTE'
            AND COALESCE(x.scheduled_departure, now()) >= now() - interval '400 days' LOOP
  BEGIN
   PERFORM public.economic_auto_close(r.id);
  EXCEPTION WHEN OTHERS THEN
   RAISE WARNING 'Cierre económico automático de % no aplicado: %', r.id, SQLERRM;
  END;
 END LOOP;
END $backfill$;

NOTIFY pgrst,'reload schema';
COMMIT;
