-- Cierre económico parcial por ítem (C). Cada servicio especial (transport_unloading_costs) y el flete (por ruta en
-- dispatch_freight_stages; por OT en rutas mixtas, dispatch_request_freight_stages) tiene su propio estado:
--   Por validar → Validado (costo final) → Enviado (EN_REVISION) → Aprobado / Observado.
-- Aprobar un ítem impacta la partida solo con la diferencia de ese ítem frente a lo ya consumido o aplicado (la misma
-- regla de 20261109090000, ahora por ítem) y lo bloquea; reabrir un ítem exige motivo y al volver a aprobar mueve solo su
-- diferencia. Estado de la ruta: CERRADO con todo aprobado, CIERRE_PARCIAL con parte aprobada; no se cierra con pendientes.
-- Las rutas ya cerradas quedan con todos sus ítems aprobados, sin mover la partida. caja_pen conserva lo que consumió
-- Caja, porque al aprobar actual_pen pasa al costo final.
-- No se reescriben validate_service_final ni economic_billable_qty (Etapa D): el bloqueo de ítems es un disparador.
BEGIN;
SET LOCAL lock_timeout='60s';

-- ------------------------------------------------------------
-- 1. Estado económico por ítem y monto de Caja
-- ------------------------------------------------------------
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS econ_status text;
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS econ_observation text;
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS econ_approved_by uuid;
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS econ_approved_at timestamptz;
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS caja_pen numeric(15,2);
ALTER TABLE public.dispatch_freight_stages ADD COLUMN IF NOT EXISTS econ_status text;
ALTER TABLE public.dispatch_freight_stages ADD COLUMN IF NOT EXISTS econ_observation text;
ALTER TABLE public.dispatch_freight_stages ADD COLUMN IF NOT EXISTS econ_approved_by uuid;
ALTER TABLE public.dispatch_freight_stages ADD COLUMN IF NOT EXISTS econ_approved_at timestamptz;
ALTER TABLE public.dispatch_request_freight_stages ADD COLUMN IF NOT EXISTS econ_status text;
ALTER TABLE public.dispatch_request_freight_stages ADD COLUMN IF NOT EXISTS econ_observation text;
ALTER TABLE public.dispatch_request_freight_stages ADD COLUMN IF NOT EXISTS econ_approved_by uuid;
ALTER TABLE public.dispatch_request_freight_stages ADD COLUMN IF NOT EXISTS econ_approved_at timestamptz;
DO $c$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='transport_unloading_costs_econ_status_check') THEN
  ALTER TABLE public.transport_unloading_costs ADD CONSTRAINT transport_unloading_costs_econ_status_check
   CHECK (econ_status IS NULL OR econ_status IN ('EN_REVISION','OBSERVADO','APROBADO'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dispatch_freight_stages_econ_status_check') THEN
  ALTER TABLE public.dispatch_freight_stages ADD CONSTRAINT dispatch_freight_stages_econ_status_check
   CHECK (econ_status IS NULL OR econ_status IN ('EN_REVISION','OBSERVADO','APROBADO'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dispatch_request_freight_stages_econ_status_check') THEN
  ALTER TABLE public.dispatch_request_freight_stages ADD CONSTRAINT dispatch_request_freight_stages_econ_status_check
   CHECK (econ_status IS NULL OR econ_status IN ('EN_REVISION','OBSERVADO','APROBADO'));
 END IF;
END $c$;
ALTER TABLE public.economic_closures DROP CONSTRAINT IF EXISTS economic_closures_status_check;
ALTER TABLE public.economic_closures ADD CONSTRAINT economic_closures_status_check
 CHECK (status IN ('PENDIENTE','EN_REVISION','OBSERVADO','CIERRE_PARCIAL','CERRADO'));

-- ------------------------------------------------------------
-- 2. Datos existentes: rutas cerradas = todos sus ítems aprobados (sin mover la partida); en revisión u observadas,
--    sus ítems con final quedan enviados u observados. Caja: el monto del gasto (actual_pen ya pudo pasar al final).
-- ------------------------------------------------------------
UPDATE public.transport_unloading_costs u SET econ_status = CASE c.status WHEN 'CERRADO' THEN 'APROBADO' ELSE c.status END,
 econ_approved_at = CASE WHEN c.status = 'CERRADO' THEN c.closed_at END, econ_approved_by = CASE WHEN c.status = 'CERRADO' THEN c.closed_by END,
 econ_observation = CASE WHEN c.status = 'OBSERVADO' THEN c.observation END
FROM public.economic_closures c
WHERE c.dispatch_id = u.dispatch_id AND c.status IN ('CERRADO','EN_REVISION','OBSERVADO') AND u.status IN ('PLANIFICADO','CONSUMIDO')
  AND u.final_pen IS NOT NULL AND u.econ_status IS NULL;
UPDATE public.dispatch_freight_stages s SET econ_status = CASE c.status WHEN 'CERRADO' THEN 'APROBADO' ELSE c.status END,
 econ_approved_at = CASE WHEN c.status = 'CERRADO' THEN c.closed_at END, econ_approved_by = CASE WHEN c.status = 'CERRADO' THEN c.closed_by END,
 econ_observation = CASE WHEN c.status = 'OBSERVADO' THEN c.observation END
FROM public.economic_closures c
WHERE c.dispatch_id = s.dispatch_id AND c.status IN ('CERRADO','EN_REVISION','OBSERVADO') AND s.final_pen IS NOT NULL AND s.econ_status IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.dispatch_request_freight f WHERE f.dispatch_id = s.dispatch_id);
UPDATE public.dispatch_request_freight_stages s SET econ_status = CASE c.status WHEN 'CERRADO' THEN 'APROBADO' ELSE c.status END,
 econ_approved_at = CASE WHEN c.status = 'CERRADO' THEN c.closed_at END, econ_approved_by = CASE WHEN c.status = 'CERRADO' THEN c.closed_by END,
 econ_observation = CASE WHEN c.status = 'OBSERVADO' THEN c.observation END
FROM public.economic_closures c
WHERE c.dispatch_id = s.dispatch_id AND c.status IN ('CERRADO','EN_REVISION','OBSERVADO') AND s.final_pen IS NOT NULL AND s.econ_status IS NULL;
UPDATE public.transport_unloading_costs u
SET caja_pen = COALESCE((SELECT NULLIF(to_jsonb(e)->>'amount','')::numeric FROM public.dispatch_expenses e WHERE e.id = u.expense_id), u.actual_pen)
WHERE u.expense_id IS NOT NULL AND u.caja_pen IS NULL;

-- ------------------------------------------------------------
-- 3. Bloqueo por ítem: un servicio enviado o aprobado no cambia su costo final (hay que observarlo o reabrirlo);
--    corregir un ítem observado lo devuelve a «Validado». Caja: lo que consume Caja queda en caja_pen.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transport_unloading_costs_economic_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.expense_id IS NOT NULL AND COALESCE(current_setting('tms.economic_apply', true), '') <> 'on'
    AND (TG_OP = 'INSERT' OR NEW.actual_pen IS DISTINCT FROM OLD.actual_pen OR NEW.expense_id IS DISTINCT FROM OLD.expense_id) THEN
  NEW.caja_pen := NEW.actual_pen;
 END IF;
 IF TG_OP = 'UPDATE' AND (NEW.final_pen IS DISTINCT FROM OLD.final_pen OR NEW.final_executed_qty IS DISTINCT FROM OLD.final_executed_qty
    OR NEW.final_workers IS DISTINCT FROM OLD.final_workers OR NEW.final_billable_qty IS DISTINCT FROM OLD.final_billable_qty
    OR NEW.final_extras_pen IS DISTINCT FROM OLD.final_extras_pen OR NEW.final_reason IS DISTINCT FROM OLD.final_reason) THEN
  IF OLD.econ_status = 'APROBADO' THEN
   RAISE EXCEPTION 'El costo final de % está aprobado en el cierre económico: reabra el ítem para corregirlo', lower(OLD.concept);
  ELSIF OLD.econ_status = 'EN_REVISION' THEN
   RAISE EXCEPTION 'El costo final de % está en revisión: obsérvelo para corregirlo', lower(OLD.concept);
  ELSIF OLD.econ_status = 'OBSERVADO' AND NEW.econ_status IS NOT DISTINCT FROM OLD.econ_status THEN
   NEW.econ_status := NULL;
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.transport_unloading_costs_economic_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS transport_unloading_costs_economic_guard ON public.transport_unloading_costs;
CREATE TRIGGER transport_unloading_costs_economic_guard BEFORE INSERT OR UPDATE ON public.transport_unloading_costs
 FOR EACH ROW EXECUTE FUNCTION public.transport_unloading_costs_economic_guard();

-- Flete de la ruta (sin reparto por OT): el mismo bloqueo por ítem. En rutas mixtas lo controla cada OT.
CREATE OR REPLACE FUNCTION public.dispatch_freight_final_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.final_pen IS DISTINCT FROM OLD.final_pen OR NEW.base_pen IS DISTINCT FROM OLD.base_pen OR NEW.extras_pen IS DISTINCT FROM OLD.extras_pen THEN
  IF OLD.econ_status IN ('EN_REVISION','APROBADO') AND NOT EXISTS (SELECT 1 FROM public.dispatch_request_freight f WHERE f.dispatch_id = NEW.dispatch_id) THEN
   RAISE EXCEPTION 'El flete final está en revisión o aprobado en el cierre económico: obsérvelo o reábralo para corregir';
  ELSIF OLD.econ_status = 'OBSERVADO' AND NEW.econ_status IS NOT DISTINCT FROM OLD.econ_status THEN
   NEW.econ_status := NULL;
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.dispatch_freight_final_lock() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS dispatch_freight_final_lock ON public.dispatch_freight_stages;
CREATE TRIGGER dispatch_freight_final_lock BEFORE UPDATE ON public.dispatch_freight_stages
 FOR EACH ROW EXECUTE FUNCTION public.dispatch_freight_final_lock();

CREATE OR REPLACE FUNCTION public.dispatch_request_freight_final_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.final_pen IS DISTINCT FROM OLD.final_pen THEN
  IF OLD.econ_status IN ('EN_REVISION','APROBADO') THEN
   RAISE EXCEPTION 'El flete final de una OT está en revisión o aprobado en el cierre económico: obsérvelo o reábralo para corregir';
  ELSIF OLD.econ_status = 'OBSERVADO' AND NEW.econ_status IS NOT DISTINCT FROM OLD.econ_status THEN
   NEW.econ_status := NULL;
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.dispatch_request_freight_final_lock() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS dispatch_request_freight_final_lock ON public.dispatch_request_freight_stages;
CREATE TRIGGER dispatch_request_freight_final_lock BEFORE UPDATE ON public.dispatch_request_freight_stages
 FOR EACH ROW EXECUTE FUNCTION public.dispatch_request_freight_final_lock();

-- ------------------------------------------------------------
-- 4. Ítems de la ruta con su estado económico (reescrita de 20261111110000)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.economic_item_status(p_econ text, p_final numeric) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN p_econ IN ('APROBADO','EN_REVISION') THEN p_econ WHEN p_final IS NULL THEN 'POR_VALIDAR'
  WHEN p_econ = 'OBSERVADO' THEN 'OBSERVADO' ELSE 'VALIDADO' END
$$;

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
     'applied_pen', COALESCE(st.final_applied_pen, f.amount_pen), 'observation', st.econ_observation,
     'approved_at', st.econ_approved_at, 'approved_by', public.economic_user_name(st.econ_approved_by),
     'status', public.economic_item_status(st.econ_status, st.final_pen)) ORDER BY t.request_number), '[]'::jsonb)
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
    'applied_pen', COALESCE(s.final_applied_pen, d.freight_cost), 'observation', s.econ_observation,
    'approved_at', s.econ_approved_at, 'approved_by', public.economic_user_name(s.econ_approved_by),
    'status', public.economic_item_status(s.econ_status, s.final_pen)));
  END IF;
 END IF;

 SELECT COALESCE(jsonb_agg(jsonb_build_object('key', 'S:' || u.id, 'kind', 'SERVICIO', 'id', u.id, 'concept', u.concept,
    'request_number', t.request_number, 'contract_id', u.contract_id, 'contract_code', (SELECT c.code FROM public.contracts c WHERE c.id = u.contract_id),
    'origin', u.origin, 'supplier', COALESCE(sp.business_name, u.provider_name),
    'referential_pen', COALESCE(u.estimated_pen, 0), 'agreed_pen', COALESCE(u.planned_pen, u.estimated_pen, 0), 'final_pen', u.final_pen,
    'extras_pen', u.final_extras_pen, 'billing_unit', u.billing_unit, 'executed_qty', u.final_executed_qty, 'billable_qty', u.final_billable_qty,
    'reason', u.final_reason, 'validated_at', u.final_validated_at, 'validated_by', public.economic_user_name(u.final_validated_by),
    'applied_pen', CASE WHEN u.status = 'CONSUMIDO' THEN u.actual_pen END, 'caja_pen', u.caja_pen, 'observation', u.econ_observation,
    'approved_at', u.econ_approved_at, 'approved_by', public.economic_user_name(u.econ_approved_by),
    'status', public.economic_item_status(u.econ_status, CASE WHEN u.final_validated_at IS NOT NULL THEN u.final_pen END))
    ORDER BY t.request_number, u.concept), '[]'::jsonb)
 INTO v_items
 FROM public.transport_unloading_costs u JOIN public.transport_requests t ON t.id = u.transport_request_id
 LEFT JOIN public.suppliers sp ON sp.id = u.supplier_id
 WHERE u.dispatch_id = p_dispatch_id AND u.status IN ('PLANIFICADO','CONSUMIDO');
 RETURN v_freight || v_items;
END $$;
REVOKE ALL ON FUNCTION public.economic_route_items(uuid) FROM PUBLIC,anon,authenticated;

-- Estado de la ruta a partir de sus ítems (sin ítems se conserva el estado registrado)
CREATE OR REPLACE FUNCTION public.economic_route_derive(p_dispatch_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_items jsonb := public.economic_route_items(p_dispatch_id); v_total int; v_approved int; v_review int; v_observed int;
BEGIN
 SELECT count(*), count(*) FILTER (WHERE value->>'status' = 'APROBADO'), count(*) FILTER (WHERE value->>'status' = 'EN_REVISION'),
  count(*) FILTER (WHERE value->>'status' = 'OBSERVADO')
 INTO v_total, v_approved, v_review, v_observed FROM jsonb_array_elements(v_items);
 IF v_total = 0 THEN RETURN public.economic_closure_status(p_dispatch_id); END IF;
 RETURN CASE WHEN v_approved = v_total THEN 'CERRADO' WHEN v_approved > 0 THEN 'CIERRE_PARCIAL' WHEN v_observed > 0 THEN 'OBSERVADO'
  WHEN v_review = v_total THEN 'EN_REVISION' ELSE 'PENDIENTE' END;
END $$;
REVOKE ALL ON FUNCTION public.economic_route_derive(uuid) FROM PUBLIC,anon,authenticated;

-- Estado calculado de la ruta (reescrita): además, el avance por ítem
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
 IF d.status NOT IN ('LIQUIDADO','CERRADO') THEN
  v_pending := v_pending || jsonb_build_array('Cierre la ruta en Torre de Control');
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
  'final_pen', CASE WHEN jsonb_array_length(v_pending) - CASE WHEN d.status NOT IN ('LIQUIDADO','CERRADO') THEN 1 ELSE 0 END = 0
    THEN COALESCE(s.final_pen, 0) + COALESCE((SELECT sum(final_pen) FROM public.transport_unloading_costs WHERE dispatch_id = p_dispatch_id AND status IN ('PLANIFICADO','CONSUMIDO')), 0) END,
  'extras_pen', COALESCE(s.extras_pen, 0) + COALESCE((SELECT sum(final_extras_pen) FROM public.transport_unloading_costs WHERE dispatch_id = p_dispatch_id AND status IN ('PLANIFICADO','CONSUMIDO')), 0),
  'items_total', jsonb_array_length(v_items),
  'items_approved', (SELECT count(*) FROM jsonb_array_elements(v_items) WHERE value->>'status' = 'APROBADO'));
END $$;
REVOKE ALL ON FUNCTION public.economic_route_state(uuid) FROM PUBLIC,anon,authenticated;

-- ------------------------------------------------------------
-- 5. Impacto en la partida por ítem: solo la diferencia entre lo ya consumido (o aplicado) y el costo final del ítem.
--    Servicio planificado sin consumir: se consume el final (libera su reserva). Consumido (Caja o factura): se ajusta.
--    Flete: una OT usa dispatches.freight_cost (consumido al cerrar la ruta); rutas mixtas, el monto de cada OT.
--    Las órdenes de referencia (OC/OS/RQ, sin OT) no tienen partida: solo se registra el final.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.economic_apply_item(p_dispatch_id uuid, p_key text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; s record; l record; f record; v_delta numeric := 0; v_contract uuid; v_rows int; v_service uuid; v_ref uuid;
BEGIN
 SELECT x.id, x.dispatch_number, x.contract_id, COALESCE(x.freight_cost, 0) AS freight_cost INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
 v_ref := NULLIF(substr(COALESCE(p_key,''), 3), '')::uuid;
 PERFORM set_config('tms.cost_reason', 'Cierre económico de la ruta ' || COALESCE(d.dispatch_number::text, ''), true);
 PERFORM set_config('tms.economic_apply', 'on', true);
 IF left(p_key, 2) = 'S:' THEN
  SELECT u.*, sp.business_name AS supplier_name INTO l FROM public.transport_unloading_costs u LEFT JOIN public.suppliers sp ON sp.id = u.supplier_id
  WHERE u.id = v_ref AND u.dispatch_id = p_dispatch_id AND u.status IN ('PLANIFICADO','CONSUMIDO') AND u.final_pen IS NOT NULL FOR UPDATE OF u;
  IF FOUND THEN
   v_contract := l.contract_id;
   IF l.status = 'PLANIFICADO' THEN
    IF l.contract_id IS NULL THEN
     UPDATE public.transport_unloading_costs SET status = 'CONSUMIDO', actual_pen = l.final_pen, consumed_by = auth.uid(), consumed_at = now() WHERE id = l.id;
    ELSE
     PERFORM public.unloading_consume(l.id, l.final_pen, NULL, l.supplier_name);
     v_delta := l.final_pen - COALESCE(l.planned_pen, 0);
    END IF;
   ELSIF l.final_pen IS DISTINCT FROM l.actual_pen THEN
    IF l.contract_id IS NOT NULL THEN
     v_delta := l.final_pen - COALESCE(l.actual_pen, 0);
     UPDATE public.contract_budgets SET consumed_pen = consumed_pen + v_delta, updated_at = now() WHERE contract_id = l.contract_id AND concept = 'PARTIDA_TRANSPORTE';
     UPDATE public.contract_services SET amount_pen = l.final_pen WHERE id = l.contract_service_id;
    END IF;
    UPDATE public.transport_unloading_costs SET caja_pen = CASE WHEN expense_id IS NOT NULL THEN COALESCE(caja_pen, actual_pen) ELSE caja_pen END,
     actual_pen = l.final_pen WHERE id = l.id;
   END IF;
  END IF;
 ELSIF left(p_key, 2) = 'F:' AND EXISTS (SELECT 1 FROM public.dispatch_request_freight WHERE dispatch_id = p_dispatch_id) THEN
  SELECT r.request_id, r.contract_id, r.amount_pen, r.service_id, st.final_pen, st.final_applied_pen INTO f
  FROM public.dispatch_request_freight r JOIN public.dispatch_request_freight_stages st ON st.dispatch_id = r.dispatch_id AND st.request_id = r.request_id
  WHERE r.dispatch_id = p_dispatch_id AND r.request_id = v_ref AND r.status <> 'LIBERADO' AND st.final_pen IS NOT NULL FOR UPDATE OF st;
  IF FOUND THEN
   v_contract := f.contract_id;
   v_delta := f.final_pen - COALESCE(f.final_applied_pen, f.amount_pen);
   IF v_delta <> 0 AND f.contract_id IS NOT NULL THEN
    UPDATE public.contract_budgets SET consumed_pen = consumed_pen + v_delta, updated_at = now() WHERE contract_id = f.contract_id AND concept = 'PARTIDA_TRANSPORTE';
    UPDATE public.contract_services SET amount_pen = f.final_pen WHERE id = f.service_id;
   ELSIF f.contract_id IS NULL THEN
    v_delta := 0;
   END IF;
   UPDATE public.dispatch_request_freight_stages SET final_applied_pen = f.final_pen, updated_at = now() WHERE dispatch_id = p_dispatch_id AND request_id = f.request_id;
  END IF;
 ELSIF left(p_key, 2) = 'F:' THEN
  SELECT * INTO s FROM public.dispatch_freight_stages WHERE dispatch_id = p_dispatch_id AND final_pen IS NOT NULL FOR UPDATE;
  IF FOUND THEN
   v_contract := d.contract_id;
   v_delta := s.final_pen - COALESCE(s.final_applied_pen, d.freight_cost);
   IF v_delta <> 0 AND d.contract_id IS NOT NULL THEN
    UPDATE public.contract_budgets SET consumed_pen = consumed_pen + v_delta, updated_at = now() WHERE contract_id = d.contract_id AND concept = 'PARTIDA_TRANSPORTE';
    SELECT count(*), min(id::text)::uuid INTO v_rows, v_service FROM public.contract_services
    WHERE dispatch_id = p_dispatch_id AND service_type = 'FLETE' AND COALESCE(status, '') <> 'ANULADO';
    IF v_rows = 1 THEN UPDATE public.contract_services SET amount_pen = s.final_pen WHERE id = v_service; END IF;
   ELSIF d.contract_id IS NULL THEN
    v_delta := 0;
   END IF;
   UPDATE public.dispatch_freight_stages SET final_applied_pen = s.final_pen, updated_at = now() WHERE dispatch_id = p_dispatch_id;
  END IF;
 END IF;
 PERFORM set_config('tms.economic_apply', '', true);
 PERFORM set_config('tms.cost_reason', '', true);
 RETURN CASE WHEN v_contract IS NOT NULL AND v_delta <> 0 THEN jsonb_build_object(v_contract::text, v_delta) ELSE '{}'::jsonb END;
END $$;
REVOKE ALL ON FUNCTION public.economic_apply_item(uuid,text) FROM PUBLIC,anon,authenticated;

-- Toda la ruta (compatibilidad): aplica cada ítem con costo final que aún no está aprobado
CREATE OR REPLACE FUNCTION public.economic_apply_budget(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i jsonb; v_part jsonb; v_deltas jsonb := '{}'::jsonb; k text;
BEGIN
 FOR i IN SELECT value FROM jsonb_array_elements(public.economic_route_items(p_dispatch_id)) WHERE value->>'status' NOT IN ('APROBADO','POR_VALIDAR') LOOP
  v_part := public.economic_apply_item(p_dispatch_id, i->>'key');
  FOR k IN SELECT jsonb_object_keys(v_part) LOOP
   v_deltas := jsonb_set(v_deltas, ARRAY[k], to_jsonb(COALESCE((v_deltas->>k)::numeric, 0) + (v_part->>k)::numeric));
  END LOOP;
 END LOOP;
 RETURN v_deltas;
END $$;
REVOKE ALL ON FUNCTION public.economic_apply_budget(uuid) FROM PUBLIC,anon,authenticated;

-- ------------------------------------------------------------
-- 6. Cambio de estado de un ítem (interna, sin permisos): ENVIAR, APROBAR (aplica su diferencia), OBSERVAR, REABRIR
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.economic_item_set(p_dispatch_id uuid, p_key text, p_action text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_item jsonb; v_status text; v_label text; v_delta jsonb := '{}'::jsonb; v_new text; v_ref uuid; v_mixed boolean;
BEGIN
 SELECT value INTO v_item FROM jsonb_array_elements(public.economic_route_items(p_dispatch_id)) WHERE value->>'key' = p_key;
 IF v_item IS NULL THEN RAISE EXCEPTION 'El servicio no pertenece a esta ruta'; END IF;
 v_status := v_item->>'status';
 v_label := COALESCE(CASE WHEN v_item->>'concept' = 'FLETE' THEN 'Transporte' ELSE public.unloading_concept_label(v_item->>'concept') END, v_item->>'concept')
  || COALESCE(' · ' || (v_item->>'request_number'), '');
 IF p_action = 'ENVIAR' THEN
  IF v_status = 'POR_VALIDAR' THEN RAISE EXCEPTION 'Valide el costo final de % antes de enviarlo', v_label; END IF;
  IF v_status IN ('EN_REVISION','APROBADO') THEN RAISE EXCEPTION '% ya fue enviado o aprobado', v_label; END IF;
  v_new := 'EN_REVISION';
 ELSIF p_action = 'APROBAR' THEN
  IF v_status = 'POR_VALIDAR' THEN RAISE EXCEPTION 'Valide el costo final de % antes de aprobarlo', v_label; END IF;
  IF v_status = 'APROBADO' THEN RAISE EXCEPTION '% ya está aprobado', v_label; END IF;
  v_delta := public.economic_apply_item(p_dispatch_id, p_key);
  v_new := 'APROBADO';
 ELSIF p_action = 'OBSERVAR' THEN
  IF v_status = 'APROBADO' THEN RAISE EXCEPTION '% está aprobado: reábralo para observarlo', v_label; END IF;
  IF v_status = 'POR_VALIDAR' THEN RAISE EXCEPTION '% aún no tiene costo final', v_label; END IF;
  v_new := 'OBSERVADO';
 ELSIF p_action = 'REABRIR' THEN
  IF v_status <> 'APROBADO' THEN RAISE EXCEPTION 'Solo se reabre un ítem aprobado'; END IF;
  v_new := NULL;
 ELSE
  RAISE EXCEPTION 'Acción inválida';
 END IF;
 v_ref := NULLIF(substr(p_key, 3), '')::uuid;
 IF left(p_key, 2) = 'S:' THEN
  UPDATE public.transport_unloading_costs SET econ_status = v_new,
   econ_observation = CASE WHEN p_action IN ('OBSERVAR','REABRIR') THEN p_reason ELSE econ_observation END,
   econ_approved_by = CASE WHEN p_action = 'APROBAR' THEN auth.uid() WHEN p_action = 'REABRIR' THEN NULL ELSE econ_approved_by END,
   econ_approved_at = CASE WHEN p_action = 'APROBAR' THEN now() WHEN p_action = 'REABRIR' THEN NULL ELSE econ_approved_at END
  WHERE id = v_ref;
 ELSE
  v_mixed := EXISTS (SELECT 1 FROM public.dispatch_request_freight WHERE dispatch_id = p_dispatch_id);
  IF v_mixed THEN
   UPDATE public.dispatch_request_freight_stages SET econ_status = v_new, updated_at = now(),
    econ_observation = CASE WHEN p_action IN ('OBSERVAR','REABRIR') THEN p_reason ELSE econ_observation END,
    econ_approved_by = CASE WHEN p_action = 'APROBAR' THEN auth.uid() WHEN p_action = 'REABRIR' THEN NULL ELSE econ_approved_by END,
    econ_approved_at = CASE WHEN p_action = 'APROBAR' THEN now() WHEN p_action = 'REABRIR' THEN NULL ELSE econ_approved_at END
   WHERE dispatch_id = p_dispatch_id AND request_id = v_ref;
  ELSE
   UPDATE public.dispatch_freight_stages SET econ_status = v_new, updated_at = now(),
    econ_observation = CASE WHEN p_action IN ('OBSERVAR','REABRIR') THEN p_reason ELSE econ_observation END,
    econ_approved_by = CASE WHEN p_action = 'APROBAR' THEN auth.uid() WHEN p_action = 'REABRIR' THEN NULL ELSE econ_approved_by END,
    econ_approved_at = CASE WHEN p_action = 'APROBAR' THEN now() WHEN p_action = 'REABRIR' THEN NULL ELSE econ_approved_at END
   WHERE dispatch_id = p_dispatch_id;
  END IF;
 END IF;
 RETURN jsonb_build_object('key', p_key, 'label', v_label, 'from', v_status, 'to', COALESCE(v_new, 'VALIDADO'), 'budget_delta_by_contract', v_delta);
END $$;
REVOKE ALL ON FUNCTION public.economic_item_set(uuid,text,text,text) FROM PUBLIC,anon,authenticated;

-- Registra el estado derivado de la ruta tras un cambio de ítems
CREATE OR REPLACE FUNCTION public.economic_route_sync(p_dispatch_id uuid, p_action text, p_reason text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_to text := public.economic_route_derive(p_dispatch_id);
BEGIN
 UPDATE public.economic_closures SET status = v_to, updated_at = now(),
  closed_by = CASE WHEN v_to = 'CERRADO' THEN COALESCE(CASE WHEN status <> 'CERRADO' THEN auth.uid() END, closed_by) ELSE NULL END,
  closed_at = CASE WHEN v_to = 'CERRADO' THEN CASE WHEN status <> 'CERRADO' THEN now() ELSE closed_at END ELSE NULL END,
  submitted_by = CASE WHEN p_action = 'ENVIAR' THEN auth.uid() ELSE submitted_by END,
  submitted_at = CASE WHEN p_action = 'ENVIAR' THEN now() ELSE submitted_at END,
  observation = CASE WHEN p_action IN ('OBSERVAR','REABRIR') THEN p_reason WHEN p_action = 'ENVIAR' THEN NULL ELSE observation END,
  reopened_count = reopened_count + CASE WHEN p_action = 'REABRIR' THEN 1 ELSE 0 END
 WHERE dispatch_id = p_dispatch_id;
 RETURN v_to;
END $$;
REVOKE ALL ON FUNCTION public.economic_route_sync(uuid,text,text) FROM PUBLIC,anon,authenticated;

-- ------------------------------------------------------------
-- 7. Acción sobre un ítem. Enviar: «despacho» o «cierre-economico». Aprobar, observar y reabrir: «cierre-economico».
--    p_item: clave del ítem de economic_route_items ('S:<línea>', 'F:<ruta>' o 'F:<solicitud>' en rutas mixtas).
-- ------------------------------------------------------------
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
 IF v_action IN ('ENVIAR','APROBAR') AND d.status NOT IN ('LIQUIDADO','CERRADO') THEN RAISE EXCEPTION 'Cierre la ruta en Torre de Control antes del cierre económico'; END IF;
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

-- ------------------------------------------------------------
-- 8. Acciones de la ruta completa (reescrita): ENVIAR todo lo validado, APROBAR todo (no se cierra con pendientes),
--    OBSERVAR lo enviado, REABRIR lo aprobado. Cada ítem impacta la partida una sola vez (solo su diferencia).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.economic_closure_action(p_dispatch_id uuid, p_action text, p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; v_from text; v_to text; v_state jsonb; v_reason text := NULLIF(btrim(COALESCE(p_reason,'')),''); v_action text := upper(COALESCE(p_action,''));
 v_detail jsonb := '{}'::jsonb; v_items jsonb; i jsonb; v_res jsonb; v_deltas jsonb := '{}'::jsonb; v_done jsonb := '[]'::jsonb; k text; v_total int;
BEGIN
 SELECT x.id, x.site_id INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id FOR UPDATE;
 IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN RAISE EXCEPTION 'Despacho inexistente'; END IF;
 IF length(COALESCE(v_reason,'')) > 1000 THEN RAISE EXCEPTION 'Motivo demasiado extenso'; END IF;
 INSERT INTO public.economic_closures(dispatch_id) VALUES (p_dispatch_id) ON CONFLICT (dispatch_id) DO NOTHING;
 SELECT status INTO v_from FROM public.economic_closures WHERE dispatch_id = p_dispatch_id FOR UPDATE;
 v_state := public.economic_route_state(p_dispatch_id);
 v_items := public.economic_route_items(p_dispatch_id);
 v_total := jsonb_array_length(v_items);
 IF v_action = 'ENVIAR' THEN
  IF NOT (public.has_tms_permission('despacho') OR public.has_tms_permission('cierre-economico')) THEN RAISE EXCEPTION 'Sin permiso para enviar el cierre económico'; END IF;
  IF v_from NOT IN ('PENDIENTE','OBSERVADO','CIERRE_PARCIAL') THEN RAISE EXCEPTION 'El cierre económico ya está en revisión o cerrado'; END IF;
  IF jsonb_array_length(v_state->'pending') > 0 THEN RAISE EXCEPTION 'Faltan costos por validar: %', (SELECT string_agg(value, '; ') FROM jsonb_array_elements_text(v_state->'pending')); END IF;
  FOR i IN SELECT value FROM jsonb_array_elements(v_items) WHERE value->>'status' IN ('VALIDADO','OBSERVADO') LOOP
   v_res := public.economic_item_set(p_dispatch_id, i->>'key', 'ENVIAR', NULL); v_done := v_done || jsonb_build_array(v_res->>'label');
  END LOOP;
  IF v_total = 0 THEN UPDATE public.economic_closures SET status = 'EN_REVISION' WHERE dispatch_id = p_dispatch_id; END IF;
  v_to := public.economic_route_sync(p_dispatch_id, 'ENVIAR', NULL);
 ELSIF v_action IN ('APROBAR','OBSERVAR','REABRIR') THEN
  IF NOT public.has_tms_permission('cierre-economico') THEN RAISE EXCEPTION 'Solo quien tiene el permiso de Cierre económico aprueba, observa o reabre'; END IF;
  IF v_action = 'APROBAR' THEN
   IF v_from NOT IN ('EN_REVISION','CIERRE_PARCIAL') THEN RAISE EXCEPTION 'Solo se aprueba un cierre enviado a revisión'; END IF;
   IF jsonb_array_length(v_state->'pending') > 0 THEN RAISE EXCEPTION 'Faltan costos por validar: %', (SELECT string_agg(value, '; ') FROM jsonb_array_elements_text(v_state->'pending')); END IF;
   FOR i IN SELECT value FROM jsonb_array_elements(v_items) WHERE value->>'status' <> 'APROBADO' LOOP
    v_res := public.economic_item_set(p_dispatch_id, i->>'key', 'APROBAR', NULL); v_done := v_done || jsonb_build_array(v_res->>'label');
    FOR k IN SELECT jsonb_object_keys(v_res->'budget_delta_by_contract') LOOP
     v_deltas := jsonb_set(v_deltas, ARRAY[k], to_jsonb(COALESCE((v_deltas->>k)::numeric, 0) + (v_res->'budget_delta_by_contract'->>k)::numeric));
    END LOOP;
   END LOOP;
   IF v_total = 0 THEN UPDATE public.economic_closures SET status = 'CERRADO', closed_by = auth.uid(), closed_at = now() WHERE dispatch_id = p_dispatch_id; END IF;
   v_detail := jsonb_build_object('budget_delta_by_contract', v_deltas, 'state', v_state);
  ELSIF v_action = 'OBSERVAR' THEN
   IF v_from NOT IN ('EN_REVISION','CIERRE_PARCIAL') THEN RAISE EXCEPTION 'Solo se observa un cierre enviado a revisión'; END IF;
   IF v_reason IS NULL OR length(v_reason) < 5 THEN RAISE EXCEPTION 'Indique la observación (mínimo 5 caracteres)'; END IF;
   FOR i IN SELECT value FROM jsonb_array_elements(v_items) WHERE value->>'status' = 'EN_REVISION' LOOP
    v_res := public.economic_item_set(p_dispatch_id, i->>'key', 'OBSERVAR', v_reason); v_done := v_done || jsonb_build_array(v_res->>'label');
   END LOOP;
   IF v_total > 0 AND jsonb_array_length(v_done) = 0 THEN RAISE EXCEPTION 'No hay servicios enviados a revisión para observar'; END IF;
   IF v_total = 0 THEN UPDATE public.economic_closures SET status = 'OBSERVADO' WHERE dispatch_id = p_dispatch_id; END IF;
  ELSE
   IF v_from NOT IN ('CERRADO','CIERRE_PARCIAL') THEN RAISE EXCEPTION 'Solo se reabre un cierre económico cerrado'; END IF;
   IF v_reason IS NULL OR length(v_reason) < 5 THEN RAISE EXCEPTION 'Indique el motivo de la reapertura (mínimo 5 caracteres)'; END IF;
   FOR i IN SELECT value FROM jsonb_array_elements(v_items) WHERE value->>'status' = 'APROBADO' LOOP
    v_res := public.economic_item_set(p_dispatch_id, i->>'key', 'REABRIR', v_reason); v_done := v_done || jsonb_build_array(v_res->>'label');
   END LOOP;
   IF v_total = 0 THEN UPDATE public.economic_closures SET status = 'PENDIENTE' WHERE dispatch_id = p_dispatch_id; END IF;
  END IF;
  v_to := public.economic_route_sync(p_dispatch_id, v_action, v_reason);
 ELSE
  RAISE EXCEPTION 'Acción inválida';
 END IF;
 v_detail := v_detail || jsonb_build_object('items', v_done);
 INSERT INTO public.economic_closure_events(dispatch_id, action, from_status, to_status, reason, detail, created_by)
 VALUES (p_dispatch_id, v_action, v_from, v_to, v_reason, v_detail, auth.uid());
 RETURN jsonb_build_object('success', true, 'status', v_to, 'detail', v_detail);
EXCEPTION WHEN raise_exception THEN
 RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.economic_closure_action(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.economic_closure_action(uuid,text,text) TO authenticated;

-- Servicio agregado en el cierre: también con cierre parcial (los ítems aprobados no se tocan)
CREATE OR REPLACE FUNCTION public.economic_add_service(p_dispatch_id uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; t record; v_concept text; v_final numeric; v_reason text; v_supplier uuid; v_supplier_name text; v_description text; v_id uuid; v_status text; v_to text;
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
 v_to := public.economic_route_sync(p_dispatch_id, 'AGREGAR', NULL);
 INSERT INTO public.economic_closure_events(dispatch_id, action, from_status, to_status, reason, detail, created_by)
 VALUES (p_dispatch_id, 'AGREGAR', v_status, v_to, v_reason,
  jsonb_build_object('unloading_cost_id', v_id, 'concept', v_concept, 'final_pen', v_final, 'supplier', v_supplier_name), auth.uid());
 RETURN jsonb_build_object('success', true, 'id', v_id, 'status', v_to);
EXCEPTION WHEN raise_exception THEN
 RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.economic_add_service(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.economic_add_service(uuid,jsonb) TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
