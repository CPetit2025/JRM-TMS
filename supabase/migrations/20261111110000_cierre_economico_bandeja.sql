-- Rediseño del cierre económico (A + B): bandeja con indicadores, estados documentario y económico por separado,
-- proveedor, variación, pendientes, responsable y última actualización; detalle en panel lateral con servicios por ítem
-- (incluido el flete), historial unificado, observaciones internas (no cambian el estado) y alerta de desviación con un
-- umbral configurable (economic_settings). Se puede agregar un servicio durante el cierre (origen CIERRE): acordado 0,
-- motivo obligatorio y sin reserva de partida hasta aprobarlo.
-- Referencial del flete: el original de la solicitud vía public.request_referential_freight (Etapa E; si no se capturó, service_cost).
BEGIN;
SET LOCAL lock_timeout='60s';

-- ------------------------------------------------------------
-- 1. Umbral de desviación (fila única, solo lectura para la interfaz)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.economic_settings (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),
  deviation_pct  numeric(6,2) NOT NULL DEFAULT 10 CHECK (deviation_pct >= 0),
  deviation_pen  numeric(15,2) NOT NULL DEFAULT 100 CHECK (deviation_pen >= 0),
  updated_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.economic_settings(id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.economic_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.economic_settings;
CREATE POLICY security_active_account ON public.economic_settings AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.economic_settings FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.economic_settings_get() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s record;
BEGIN
 SELECT deviation_pct, deviation_pen INTO s FROM public.economic_settings WHERE id;
 RETURN jsonb_build_object('deviation_pct', COALESCE(s.deviation_pct, 10), 'deviation_pen', COALESCE(s.deviation_pen, 100));
END $$;
REVOKE ALL ON FUNCTION public.economic_settings_get() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.economic_settings_get() TO authenticated;

-- ------------------------------------------------------------
-- 2. Historial: notas internas (no cambian el estado) y servicios agregados en el cierre
-- ------------------------------------------------------------
ALTER TABLE public.economic_closure_events DROP CONSTRAINT IF EXISTS economic_closure_events_action_check;
ALTER TABLE public.economic_closure_events ADD CONSTRAINT economic_closure_events_action_check
 CHECK (action IN ('ENVIAR','APROBAR','OBSERVAR','REABRIR','NOTA','AGREGAR'));

-- Origen CIERRE: servicio ejecutado que no se programó y se agrega al validar costos
ALTER TABLE public.transport_unloading_costs DROP CONSTRAINT IF EXISTS transport_unloading_costs_origin_check;
ALTER TABLE public.transport_unloading_costs ADD CONSTRAINT transport_unloading_costs_origin_check
 CHECK (origin IN ('SOLICITUD','PROGRAMACION','CAJA','CIERRE'));

CREATE OR REPLACE FUNCTION public.economic_user_name(p_user uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v text;
BEGIN
 IF p_user IS NULL THEN RETURN NULL; END IF;
 SELECT COALESCE(NULLIF(btrim(concat_ws(' ', to_jsonb(pr)->>'first_name', to_jsonb(pr)->>'last_name')), ''), to_jsonb(pr)->>'full_name')
 INTO v FROM public.profiles pr WHERE pr.id = p_user;
 RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.economic_user_name(uuid) FROM PUBLIC,anon,authenticated;

-- ------------------------------------------------------------
-- 3. Ítems económicos de una ruta: cada servicio especial y el flete (por ruta, o por OT en rutas mixtas)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.economic_route_items(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; s record; v_items jsonb; v_freight jsonb := '[]'::jsonb; v_carrier text; v_agreed numeric;
BEGIN
 SELECT x.id, COALESCE(x.freight_cost, 0) AS freight_cost, to_jsonb(x)->>'modalidad' AS modalidad, NULLIF(to_jsonb(x)->>'carrier_id','')::uuid AS carrier_id
 INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
 IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;
 SELECT * INTO s FROM public.dispatch_freight_stages WHERE dispatch_id = p_dispatch_id;
 IF d.modalidad = 'TERCERO' AND d.carrier_id IS NOT NULL THEN
  SELECT to_jsonb(c)->>'business_name' INTO v_carrier FROM public.carriers c WHERE c.id = d.carrier_id;
 END IF;
 v_carrier := COALESCE(v_carrier, CASE WHEN d.modalidad = 'TERCERO' THEN 'Transportista tercero' ELSE 'JRM (flota propia)' END);

 IF EXISTS (SELECT 1 FROM public.dispatch_request_freight WHERE dispatch_id = p_dispatch_id) THEN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('key', 'F:' || f.request_id, 'kind', 'FLETE', 'id', f.request_id, 'concept', 'FLETE',
     'request_number', t.request_number, 'contract_id', f.contract_id, 'contract_code', (SELECT c.code FROM public.contracts c WHERE c.id = f.contract_id),
     'origin', 'PROGRAMACION', 'supplier', v_carrier,
     'referential_pen', COALESCE(public.request_referential_freight(t.id), 0),
     'agreed_pen', COALESCE(st.agreed_pen, f.amount_pen), 'final_pen', st.final_pen, 'extras_pen', NULL,
     'billing_unit', NULL, 'executed_qty', NULL, 'billable_qty', NULL, 'reason', s.final_reason,
     'validated_at', CASE WHEN st.final_pen IS NOT NULL THEN s.final_at END,
     'validated_by', CASE WHEN st.final_pen IS NOT NULL THEN public.economic_user_name(s.final_by) END,
     'status', CASE WHEN st.final_pen IS NULL THEN 'POR_VALIDAR' ELSE 'VALIDADO' END) ORDER BY t.request_number), '[]'::jsonb)
  INTO v_freight
  FROM public.dispatch_request_freight f JOIN public.transport_requests t ON t.id = f.request_id
  LEFT JOIN public.dispatch_request_freight_stages st ON st.dispatch_id = f.dispatch_id AND st.request_id = f.request_id
  WHERE f.dispatch_id = p_dispatch_id AND f.status <> 'LIBERADO';
 ELSE
  v_agreed := COALESCE(s.agreed_pen, d.freight_cost);
  IF v_agreed > 0 OR d.freight_cost > 0 OR s.final_pen IS NOT NULL THEN
   v_freight := jsonb_build_array(jsonb_build_object('key', 'F:' || p_dispatch_id, 'kind', 'FLETE', 'id', NULL, 'concept', 'FLETE',
    'request_number', (SELECT string_agg(t.request_number::text, ', ' ORDER BY t.request_number) FROM public.dispatch_requests dr
       JOIN public.transport_requests t ON t.id = dr.transport_request_id WHERE dr.dispatch_id = p_dispatch_id),
    'contract_id', (SELECT x.contract_id FROM public.dispatches x WHERE x.id = p_dispatch_id),
    'contract_code', (SELECT c.code FROM public.dispatches x JOIN public.contracts c ON c.id = x.contract_id WHERE x.id = p_dispatch_id),
    'origin', 'PROGRAMACION', 'supplier', v_carrier,
    'referential_pen', (SELECT COALESCE(sum(COALESCE(public.request_referential_freight(t.id), 0)), 0)
       FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id WHERE dr.dispatch_id = p_dispatch_id),
    'agreed_pen', v_agreed, 'final_pen', s.final_pen, 'extras_pen', s.extras_pen,
    'billing_unit', NULL, 'executed_qty', NULL, 'billable_qty', NULL, 'reason', s.final_reason,
    'validated_at', s.final_at, 'validated_by', public.economic_user_name(s.final_by),
    'status', CASE WHEN s.final_pen IS NULL THEN 'POR_VALIDAR' ELSE 'VALIDADO' END));
  END IF;
 END IF;

 SELECT COALESCE(jsonb_agg(jsonb_build_object('key', 'S:' || u.id, 'kind', 'SERVICIO', 'id', u.id, 'concept', u.concept,
    'request_number', t.request_number, 'contract_id', u.contract_id, 'contract_code', (SELECT c.code FROM public.contracts c WHERE c.id = u.contract_id),
    'origin', u.origin, 'supplier', COALESCE(sp.business_name, u.provider_name),
    'referential_pen', COALESCE(u.estimated_pen, 0), 'agreed_pen', COALESCE(u.planned_pen, u.estimated_pen, 0), 'final_pen', u.final_pen,
    'extras_pen', u.final_extras_pen, 'billing_unit', u.billing_unit, 'executed_qty', u.final_executed_qty, 'billable_qty', u.final_billable_qty,
    'reason', u.final_reason, 'validated_at', u.final_validated_at, 'validated_by', public.economic_user_name(u.final_validated_by),
    'status', CASE WHEN u.final_validated_at IS NULL THEN 'POR_VALIDAR' ELSE 'VALIDADO' END) ORDER BY t.request_number, u.concept), '[]'::jsonb)
 INTO v_items
 FROM public.transport_unloading_costs u JOIN public.transport_requests t ON t.id = u.transport_request_id
 LEFT JOIN public.suppliers sp ON sp.id = u.supplier_id
 WHERE u.dispatch_id = p_dispatch_id AND u.status IN ('PLANIFICADO','CONSUMIDO');
 RETURN v_freight || v_items;
END $$;
REVOKE ALL ON FUNCTION public.economic_route_items(uuid) FROM PUBLIC,anon,authenticated;

-- Estado documentario de la ruta (cierre documentario por servicio): OBSERVADO si alguno lo está, COMPLETO si todos lo están
CREATE OR REPLACE FUNCTION public.economic_documentary_status(p_dispatch_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_total int; v_complete int; v_observed int;
BEGIN
 SELECT count(*), count(*) FILTER (WHERE status = 'COMPLETO'), count(*) FILTER (WHERE status = 'OBSERVADO')
 INTO v_total, v_complete, v_observed FROM public.documentary_closures WHERE dispatch_id = p_dispatch_id;
 RETURN CASE WHEN v_observed > 0 THEN 'OBSERVADO' WHEN v_total > 0 AND v_complete = v_total THEN 'COMPLETO' ELSE 'PENDIENTE' END;
END $$;
REVOKE ALL ON FUNCTION public.economic_documentary_status(uuid) FROM PUBLIC,anon,authenticated;

-- Último movimiento del cierre: acción del cierre o validación de un costo final
CREATE OR REPLACE FUNCTION public.economic_last_activity(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_at timestamptz; v_by uuid;
BEGIN
 SELECT a.at, a.by INTO v_at, v_by FROM (
  SELECT e.created_at AS at, e.created_by AS by FROM public.economic_closure_events e WHERE e.dispatch_id = p_dispatch_id
  UNION ALL SELECT u.final_validated_at, u.final_validated_by FROM public.transport_unloading_costs u
   WHERE u.dispatch_id = p_dispatch_id AND u.final_validated_at IS NOT NULL AND u.status IN ('PLANIFICADO','CONSUMIDO')
  UNION ALL SELECT s.final_at, s.final_by FROM public.dispatch_freight_stages s WHERE s.dispatch_id = p_dispatch_id AND s.final_at IS NOT NULL
 ) a ORDER BY a.at DESC NULLS LAST LIMIT 1;
 RETURN jsonb_build_object('at', v_at, 'by', public.economic_user_name(v_by));
END $$;
REVOKE ALL ON FUNCTION public.economic_last_activity(uuid) FROM PUBLIC,anon,authenticated;

-- ------------------------------------------------------------
-- 4. Estado calculado de la ruta (igual que en 20261109090000, con el referencial original del flete)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.economic_route_state(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; s record; v_pending jsonb := '[]'::jsonb; v_lines jsonb; v_freight_ref numeric; v_freight_agreed numeric; v_has_freight boolean;
BEGIN
 SELECT x.id, x.status, COALESCE(x.freight_cost, 0) AS freight_cost INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO s FROM public.dispatch_freight_stages WHERE dispatch_id = p_dispatch_id;
 SELECT COALESCE(sum(COALESCE(public.request_referential_freight(t.id), 0)), 0) INTO v_freight_ref
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

-- ------------------------------------------------------------
-- 5. Bandeja: además del estado, ítems, estado documentario, responsable y última actualización
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.economic_closure_queue(p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT public.economic_can_read() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al cierre económico'); END IF;
 IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 366 THEN RETURN jsonb_build_object('success', false, 'error', 'Período inválido (máximo 366 días)'); END IF;
 RETURN jsonb_build_object('success', true,
  'can_validate', public.has_tms_permission('despacho') OR public.has_tms_permission('cierre-economico'),
  'can_approve', public.has_tms_permission('cierre-economico'),
  'settings', public.economic_settings_get(),
  'routes', COALESCE((SELECT jsonb_agg(jsonb_build_object('dispatch_id', x.id, 'dispatch_number', x.dispatch_number, 'status', x.status,
     'departure', x.scheduled_departure, 'plate', x.vehicle_plate,
     'contracts', (SELECT string_agg(DISTINCT c.code, ', ') FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id
        JOIN public.contracts c ON c.id = t.contract_id WHERE dr.dispatch_id = x.id),
     'requests', (SELECT string_agg(t.request_number::text, ', ' ORDER BY t.request_number) FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id WHERE dr.dispatch_id = x.id),
     'state', public.economic_route_state(x.id), 'items', public.economic_route_items(x.id),
     'doc_status', public.economic_documentary_status(x.id), 'last', public.economic_last_activity(x.id))
     ORDER BY x.scheduled_departure DESC, x.id)
   FROM public.dispatches x
   WHERE x.status IN ('LIQUIDADO','CERRADO','RETORNO_COMPLETADO','ENTREGADO','CIERRE_OPERATIVO')
     AND (x.site_id IS NULL OR public.can_access_site(x.site_id))
     AND (x.scheduled_departure AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.economic_closure_queue(date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.economic_closure_queue(date,date) TO authenticated;

-- ------------------------------------------------------------
-- 6. Detalle para el panel lateral: cabecera, ítems, estado documentario por servicio, historial unificado y notas
-- ------------------------------------------------------------
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
  'settings', public.economic_settings_get(),
  'contracts', (SELECT string_agg(DISTINCT c.code, ', ') FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id
     JOIN public.contracts c ON c.id = t.contract_id WHERE dr.dispatch_id = p_dispatch_id),
  'requests', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'request_number', t.request_number,
     'contract_code', (SELECT c.code FROM public.contracts c WHERE c.id = t.contract_id),
     'doc_status', (SELECT dc.status FROM public.documentary_closures dc WHERE dc.dispatch_id = p_dispatch_id AND dc.request_id = t.id LIMIT 1))
    ORDER BY t.request_number)
   FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id WHERE dr.dispatch_id = p_dispatch_id), '[]'::jsonb),
  'doc_status', public.economic_documentary_status(p_dispatch_id),
  'last', public.economic_last_activity(p_dispatch_id),
  'items', public.economic_route_items(p_dispatch_id),
  'services', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'request_number', t.request_number, 'concept', u.concept, 'description', u.description,
     'status', u.status, 'origin', u.origin, 'supplier', s.business_name, 'billing_unit', u.billing_unit, 'agreed_rate', u.agreed_rate, 'agreed_qty', u.agreed_qty,
     'workers', u.workers, 'min_billable_qty', u.min_billable_qty, 'fraction_minutes', u.fraction_minutes,
     'estimated_pen', u.estimated_pen, 'planned_pen', u.planned_pen, 'actual_pen', u.actual_pen, 'expense_id', u.expense_id,
     'forklift_hours', (SELECT final_hours FROM public.route_forklifts f WHERE f.unloading_cost_id = u.id),
     'final_executed_qty', u.final_executed_qty, 'final_workers', u.final_workers, 'final_billable_qty', u.final_billable_qty,
     'final_extras_pen', u.final_extras_pen, 'final_pen', u.final_pen, 'final_reason', u.final_reason, 'final_validated_at', u.final_validated_at,
     'final_validated_by', public.economic_user_name(u.final_validated_by))
    ORDER BY t.request_number, u.concept)
   FROM public.transport_unloading_costs u JOIN public.transport_requests t ON t.id = u.transport_request_id
   LEFT JOIN public.suppliers s ON s.id = u.supplier_id
   WHERE u.dispatch_id = p_dispatch_id AND u.status <> 'ANULADO'), '[]'::jsonb),
  'voided', COALESCE((SELECT jsonb_agg(jsonb_build_object('concept', u.concept, 'request_number', t.request_number, 'reason', u.void_reason))
   FROM public.transport_unloading_costs u JOIN public.transport_requests t ON t.id = u.transport_request_id
   WHERE u.dispatch_id = p_dispatch_id AND u.status = 'ANULADO'), '[]'::jsonb),
  'events', COALESCE((SELECT jsonb_agg(jsonb_build_object('action', e.action, 'from_status', e.from_status, 'to_status', e.to_status, 'reason', e.reason,
     'detail', e.detail, 'created_at', e.created_at, 'user', public.economic_user_name(e.created_by)) ORDER BY e.created_at DESC)
   FROM public.economic_closure_events e WHERE e.dispatch_id = p_dispatch_id AND e.action <> 'NOTA'), '[]'::jsonb),
  'notes', COALESCE((SELECT jsonb_agg(jsonb_build_object('note', e.reason, 'created_at', e.created_at, 'user', public.economic_user_name(e.created_by))
    ORDER BY e.created_at DESC)
   FROM public.economic_closure_events e WHERE e.dispatch_id = p_dispatch_id AND e.action = 'NOTA'), '[]'::jsonb),
  -- Historial unificado: cambios de costo (referencial, acordado, ajuste, final, estado) y acciones del cierre
  'history', COALESCE((SELECT jsonb_agg(q.h ORDER BY q.at DESC) FROM (
    SELECT c.created_at AS at, jsonb_build_object('source', 'COSTO', 'stage', c.stage, 'concept', c.concept, 'old_amount', c.old_amount, 'new_amount', c.new_amount,
      'old_status', c.old_status, 'new_status', c.new_status, 'reason', c.reason, 'created_at', c.created_at, 'user', public.economic_user_name(c.created_by),
      'request_number', (SELECT t.request_number FROM public.transport_requests t WHERE t.id = c.transport_request_id)) AS h
    FROM public.service_cost_events c WHERE c.dispatch_id = p_dispatch_id
    UNION ALL
    SELECT e.created_at, jsonb_build_object('source', 'CIERRE', 'action', e.action, 'from_status', e.from_status, 'to_status', e.to_status, 'reason', e.reason,
      'detail', e.detail, 'created_at', e.created_at, 'user', public.economic_user_name(e.created_by))
    FROM public.economic_closure_events e WHERE e.dispatch_id = p_dispatch_id
    ORDER BY 1 DESC LIMIT 300) q), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.economic_closure_detail(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.economic_closure_detail(uuid) TO authenticated;

-- ------------------------------------------------------------
-- 7. Observación interna: queda en el historial y no cambia el estado
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.economic_closure_note(p_dispatch_id uuid, p_note text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; v_note text := NULLIF(btrim(COALESCE(p_note,'')),''); v_status text;
BEGIN
 IF NOT (public.has_tms_permission('despacho') OR public.has_tms_permission('cierre-economico')) THEN RAISE EXCEPTION 'Sin permiso para registrar observaciones del cierre'; END IF;
 SELECT x.id, x.site_id INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
 IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN RAISE EXCEPTION 'Despacho inexistente'; END IF;
 IF v_note IS NULL OR length(v_note) < 3 THEN RAISE EXCEPTION 'Escriba la observación (mínimo 3 caracteres)'; END IF;
 IF length(v_note) > 1000 THEN RAISE EXCEPTION 'Observación demasiado extensa (máximo 1000 caracteres)'; END IF;
 v_status := public.economic_closure_status(p_dispatch_id);
 INSERT INTO public.economic_closure_events(dispatch_id, action, from_status, to_status, reason, created_by)
 VALUES (p_dispatch_id, 'NOTA', v_status, v_status, v_note, auth.uid());
 RETURN jsonb_build_object('success', true);
EXCEPTION WHEN raise_exception THEN
 RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.economic_closure_note(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.economic_closure_note(uuid,text) TO authenticated;

-- ------------------------------------------------------------
-- 8. Servicio agregado en el cierre (origen CIERRE): ejecutado sin programarse. Acordado 0 (toda la diferencia es
--    desviación), costo final validado al registrarlo, motivo obligatorio y sin reserva: la partida se mueve al aprobar.
--    p = { transport_request_id, concept, description?, supplier_id?, final_pen, reason }
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.economic_add_service(p_dispatch_id uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; t record; v_concept text; v_final numeric; v_reason text; v_supplier uuid; v_supplier_name text; v_description text; v_id uuid; v_status text;
BEGIN
 IF NOT (public.has_tms_permission('despacho') OR public.has_tms_permission('cierre-economico')) THEN RAISE EXCEPTION 'Sin permiso para agregar servicios en el cierre'; END IF;
 SELECT x.id, x.status, x.site_id INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id FOR UPDATE;
 IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN RAISE EXCEPTION 'Despacho inexistente'; END IF;
 IF d.status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','CANCELADO') THEN RAISE EXCEPTION 'Los servicios del cierre se agregan después de la ejecución'; END IF;
 v_status := public.economic_closure_status(p_dispatch_id);
 IF v_status IN ('EN_REVISION','CERRADO') THEN RAISE EXCEPTION 'El cierre económico de la ruta está en revisión o cerrado: obsérvelo o reábralo para agregar servicios'; END IF;
 IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'Datos inválidos'; END IF;
 SELECT tr.id, tr.contract_id INTO t FROM public.transport_requests tr
 WHERE tr.id = NULLIF(p->>'transport_request_id','')::uuid
   AND EXISTS (SELECT 1 FROM public.dispatch_requests dr WHERE dr.dispatch_id = p_dispatch_id AND dr.transport_request_id = tr.id);
 IF NOT FOUND THEN RAISE EXCEPTION 'Elija una solicitud de la ruta'; END IF;
 v_concept := upper(COALESCE(p->>'concept',''));
 IF v_concept NOT IN ('MONTACARGAS','GRUA','ESTIBA','OTROS') THEN RAISE EXCEPTION 'Tipo de servicio inválido'; END IF;
 v_final := NULLIF(p->>'final_pen','')::numeric;
 IF v_final IS NULL OR v_final <= 0 OR v_final > 10000000 OR v_final <> round(v_final, 2) THEN RAISE EXCEPTION 'Indique el costo final del servicio (mayor a 0, dos decimales)'; END IF;
 v_reason := NULLIF(btrim(COALESCE(p->>'reason','')),'');
 IF v_reason IS NULL OR length(v_reason) < 5 THEN RAISE EXCEPTION 'Indique por qué se agrega el servicio en el cierre (mínimo 5 caracteres)'; END IF;
 IF length(v_reason) > 1000 THEN RAISE EXCEPTION 'Motivo demasiado extenso'; END IF;
 v_description := NULLIF(btrim(COALESCE(p->>'description','')),'');
 IF length(COALESCE(v_description,'')) > 300 THEN RAISE EXCEPTION 'Descripción demasiado extensa'; END IF;
 v_supplier := NULLIF(p->>'supplier_id','')::uuid;
 IF v_supplier IS NOT NULL THEN
  SELECT business_name INTO v_supplier_name FROM public.suppliers WHERE id = v_supplier;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proveedor inexistente'; END IF;
 END IF;

 PERFORM set_config('tms.cost_reason', v_reason, true);
 INSERT INTO public.transport_unloading_costs(transport_request_id, dispatch_id, contract_id, concept, description, estimated_pen, planned_pen, status, origin,
  supplier_id, provider_name, created_by, planned_by, planned_at,
  final_extras_pen, final_pen, final_reason, final_validated_by, final_validated_at)
 VALUES (t.id, p_dispatch_id, t.contract_id, v_concept, COALESCE(v_description, 'Agregado en el cierre económico'), 0, 0, 'PLANIFICADO', 'CIERRE',
  v_supplier, v_supplier_name, auth.uid(), auth.uid(), now(),
  0, v_final, v_reason, auth.uid(), now())
 RETURNING id INTO v_id;
 PERFORM set_config('tms.cost_reason', '', true);
 INSERT INTO public.service_cost_events(unloading_cost_id, transport_request_id, dispatch_id, contract_id, concept, stage, old_amount, new_amount, old_status, new_status, detail, reason, created_by)
 VALUES (v_id, t.id, p_dispatch_id, t.contract_id, v_concept, 'FINAL', NULL, v_final, 'PLANIFICADO', 'PLANIFICADO',
  jsonb_build_object('validated', true, 'origin', 'CIERRE', 'reference_pen', 0, 'base_pen', v_final, 'extras_pen', 0), v_reason, auth.uid());
 INSERT INTO public.economic_closures(dispatch_id) VALUES (p_dispatch_id) ON CONFLICT (dispatch_id) DO NOTHING;
 INSERT INTO public.economic_closure_events(dispatch_id, action, from_status, to_status, reason, detail, created_by)
 VALUES (p_dispatch_id, 'AGREGAR', v_status, v_status, v_reason,
  jsonb_build_object('unloading_cost_id', v_id, 'concept', v_concept, 'final_pen', v_final, 'supplier', v_supplier_name), auth.uid());
 RETURN jsonb_build_object('success', true, 'id', v_id);
EXCEPTION WHEN raise_exception THEN
 RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.economic_add_service(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.economic_add_service(uuid,jsonb) TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
