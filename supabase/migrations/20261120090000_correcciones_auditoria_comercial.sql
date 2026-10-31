-- Correcciones de la auditoría funcional de Comercial y Operaciones (31/10/2026):
-- F01 · Registro de Servicios no edita el importe de un servicio cuya ruta tiene el cierre económico en revisión, parcial o
--       cerrado: la corrección pasa por Cierre económico (observar o reabrir), la única autoridad del costo aprobado.
--       Reescritura completa de update_contract_service_amount (20260930130000) con esa única condición nueva.
-- F02 · Un cierre operativo manual desde PROGRAMADO (la ruta no salió) ya no confirma ni aprueba el flete propio:
--       el disparador lo omite y economic_auto_close (reescrito completo desde 20261117090000) tampoco lo hace después.
--       La ruta queda pendiente en Cierre económico para decidir su costo. No se modifican datos existentes.
-- F03 · dispatch_freight_summary (reescrito completo) también se lee con el permiso de Cierre económico.
BEGIN;

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
  SELECT id, amount_pen, contract_id, service_type, dispatch_id, status,
         COALESCE(budget_contract_id, contract_id) AS owner INTO s
    FROM public.contract_services WHERE id = p_service_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El servicio no existe'; END IF;
  IF COALESCE(s.status, '') = 'ANULADO' THEN RAISE EXCEPTION 'El servicio está anulado'; END IF;
  IF s.dispatch_id IS NOT NULL AND public.economic_closure_status(s.dispatch_id) IN ('EN_REVISION','CIERRE_PARCIAL','CERRADO') THEN
    RAISE EXCEPTION 'El cierre económico de la ruta está en revisión o aprobado: corrija el importe desde Cierre económico (observar o reabrir)';
  END IF;
  IF public.is_contract_administrator() AND NOT public.has_assigned_contract(s.contract_id, true) THEN
    RAISE EXCEPTION 'OT no asignada';
  END IF;
  v_delta := p_new_amount - s.amount_pen;
  SELECT * INTO b FROM public.contract_budgets WHERE contract_id = s.owner AND concept = 'PARTIDA_TRANSPORTE' FOR UPDATE;
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

CREATE OR REPLACE FUNCTION public.economic_auto_close(p_dispatch_id uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; s record; v_from text; v_to text; v_own boolean; v_mixed boolean; v_done text := NULL; v_not_run boolean;
 v_reason text := 'Flete de flota propia confirmado automáticamente al liberar la unidad';
BEGIN
 SELECT x.id, x.status, x.contract_id, COALESCE(x.freight_cost, 0) AS freight_cost,
   COALESCE(to_jsonb(x)->>'modalidad', CASE WHEN NULLIF(to_jsonb(x)->>'carrier_id', '') IS NOT NULL THEN 'TERCERO' ELSE 'PROPIA' END) AS modalidad
 INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
 IF NOT FOUND OR d.status NOT IN ('RETORNO_COMPLETADO','CIERRE_OPERATIVO','LIQUIDADO','CERRADO') THEN RETURN NULL; END IF;
 v_own := d.modalidad <> 'TERCERO';
 v_mixed := EXISTS (SELECT 1 FROM public.dispatch_request_freight WHERE dispatch_id = p_dispatch_id AND status <> 'LIBERADO');
 -- Cierre operativo manual desde PROGRAMADO = el servicio no salió: no hay ejecución que confirmar; se decide en Cierre económico
 v_not_run := EXISTS (SELECT 1 FROM public.dispatch_events e WHERE e.dispatch_id = p_dispatch_id AND e.event_type = 'CIERRE_OPERATIVO_MANUAL'
   AND to_jsonb(e)->'payload'->>'previous_status' = 'PROGRAMADO');

 -- C · flete propio: final = vigente (ya consumido por la partida), aplicado y aprobado
 IF v_own AND NOT v_not_run THEN
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

CREATE OR REPLACE FUNCTION public.dispatch_economic_auto_close() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 -- Cierre operativo manual de una ruta que no salió: no hay ejecución que confirmar automáticamente
 IF OLD.status = 'PROGRAMADO' THEN RETURN NULL; END IF;
 BEGIN
  PERFORM public.economic_auto_close(NEW.id);
 EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Cierre económico automático de % no aplicado: %', NEW.id, SQLERRM;
 END;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.dispatch_economic_auto_close() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.dispatch_freight_summary(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; s record; v_name text;
BEGIN
 IF NOT (public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('torre-control')
   OR public.has_tms_read_permission('documentario') OR public.has_tms_read_permission('contratos-servicios')
   OR public.has_tms_read_permission('cierre-economico')) THEN
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

COMMIT;
