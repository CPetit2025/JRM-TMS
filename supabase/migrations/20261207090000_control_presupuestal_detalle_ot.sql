-- Control presupuestal · detalle financiero por OT y ampliaciones (reingeniería, Fase 4; D4 aprobada el 01/11/2026).
-- · budget_ot_detail: posición, viajes (planificado, comprometido, ejecutado, diferencia, guías, cierre), conceptos,
--   evolución del ejecutado, ampliaciones e historial. Sale de budget_movement_rows (sin otro libro), así que suma lo
--   mismo que Movimientos y que la partida.
-- · Ampliación (D4): el Jefe de Distribución la solicita con motivo y evidencia; Gerencia la aprueba o rechaza (no la
--   propia). Al aprobarse suma al aporte propio de la OT raíz (own_allocated_pen; el disparador de saldo recalcula la
--   familia) y queda en contract_budget_adjustments. Distinta de la autorización sobre el tope, que no cambia la partida.
BEGIN;
SET LOCAL lock_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.budget_extensions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id   uuid NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
  amount_pen    numeric(15,2) NOT NULL CHECK (amount_pen > 0),
  reason        text NOT NULL CHECK (length(btrim(reason)) >= 10),
  evidence      text,
  status        text NOT NULL DEFAULT 'SOLICITADA' CHECK (status IN ('SOLICITADA','APROBADA','RECHAZADA')),
  requested_by  uuid, requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid, decided_at timestamptz, decision_note text
);
-- Regla C55: FK cubierta por un índice no parcial
CREATE INDEX IF NOT EXISTS budget_extensions_contract_idx ON public.budget_extensions(contract_id);
ALTER TABLE public.budget_extensions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.budget_extensions;
CREATE POLICY security_active_account ON public.budget_extensions AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.budget_extensions FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.budget_extension_request(p_contract_id uuid, p_amount numeric, p_reason text, p_evidence text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_root uuid := public.contract_root_id(p_contract_id); v_id uuid;
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_active_tms_user()
    OR NOT (public.is_tms_admin() OR public.has_tms_permission('control-presupuestal-recomendar')) THEN
  RETURN jsonb_build_object('success', false, 'error', 'Solo el Jefe de Distribución solicita una ampliación de partida');
 END IF;
 IF public.budget_family(v_root) IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'OT no disponible'); END IF;
 IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN RETURN jsonb_build_object('success', false, 'error', 'Indique un monto mayor a 0 con dos decimales'); END IF;
 IF length(btrim(COALESCE(p_reason, ''))) < 10 THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo (mínimo 10 caracteres)'); END IF;
 IF NOT EXISTS (SELECT 1 FROM public.contract_budgets WHERE contract_id = v_root AND concept = 'PARTIDA_TRANSPORTE') THEN
  RETURN jsonb_build_object('success', false, 'error', 'La OT no tiene partida de transporte: regístrela en Contratos');
 END IF;
 IF EXISTS (SELECT 1 FROM public.budget_extensions WHERE contract_id = v_root AND status = 'SOLICITADA') THEN
  RETURN jsonb_build_object('success', false, 'error', 'La OT ya tiene una ampliación pendiente de Gerencia');
 END IF;
 INSERT INTO public.budget_extensions(contract_id, amount_pen, reason, evidence, requested_by)
 VALUES (v_root, p_amount, btrim(p_reason), NULLIF(btrim(COALESCE(p_evidence, '')), ''), auth.uid()) RETURNING id INTO v_id;
 RETURN jsonb_build_object('success', true, 'id', v_id);
END $$;
REVOKE ALL ON FUNCTION public.budget_extension_request(uuid, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.budget_extension_request(uuid, numeric, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.budget_extension_action(p_id uuid, p_action text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e public.budget_extensions%ROWTYPE; b public.contract_budgets%ROWTYPE; v_action text := upper(COALESCE(p_action, ''));
 v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_active_tms_user()
    OR NOT (public.is_tms_admin() OR public.has_tms_permission('control-presupuestal-autorizar')) THEN
  RETURN jsonb_build_object('success', false, 'error', 'Solo Gerencia de Operaciones decide una ampliación de partida');
 END IF;
 IF v_action NOT IN ('APROBAR','RECHAZAR') THEN RETURN jsonb_build_object('success', false, 'error', 'Acción inválida'); END IF;
 SELECT * INTO e FROM public.budget_extensions WHERE id = p_id FOR UPDATE;
 IF NOT FOUND OR public.budget_family(e.contract_id) IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Ampliación no disponible'); END IF;
 IF e.status <> 'SOLICITADA' THEN RETURN jsonb_build_object('success', false, 'error', 'La ampliación ya fue decidida'); END IF;
 IF e.requested_by = auth.uid() AND NOT public.is_tms_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'No puede decidir una ampliación que usted solicitó'); END IF;
 IF v_action = 'RECHAZAR' AND (v_note IS NULL OR length(v_note) < 5) THEN RETURN jsonb_build_object('success', false, 'error', 'Indique por qué se rechaza'); END IF;
 IF v_action = 'APROBAR' THEN
  -- Bloquea la fila raíz (como toda reserva de la familia) y suma al aporte propio
  SELECT * INTO b FROM public.contract_budgets WHERE contract_id = e.contract_id AND concept = 'PARTIDA_TRANSPORTE' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'La OT no tiene partida de transporte'); END IF;
  UPDATE public.contract_budgets SET own_allocated_pen = COALESCE(own_allocated_pen, 0) + e.amount_pen, updated_at = now() WHERE id = b.id;
  INSERT INTO public.contract_budget_adjustments(budget_id, contract_id, field, old_value, new_value, reason)
  VALUES (b.id, e.contract_id, 'own_allocated_pen', COALESCE(b.own_allocated_pen, 0), COALESCE(b.own_allocated_pen, 0) + e.amount_pen,
   'Ampliación aprobada por Gerencia: ' || e.reason);
 END IF;
 UPDATE public.budget_extensions SET status = CASE v_action WHEN 'APROBAR' THEN 'APROBADA' ELSE 'RECHAZADA' END,
  decided_by = auth.uid(), decided_at = now(), decision_note = v_note WHERE id = p_id;
 RETURN jsonb_build_object('success', true);
END $$;
REVOKE ALL ON FUNCTION public.budget_extension_action(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.budget_extension_action(uuid, text, text) TO authenticated;

-- Detalle financiero de una OT (la raíz de su familia)
CREATE OR REPLACE FUNCTION public.budget_ot_detail(p_contract_id uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_root uuid := public.contract_root_id(p_contract_id); v_family uuid[]; v_budgets uuid[]; s jsonb := public.economic_settings_get();
 v_cap numeric; v_alert numeric; v_out jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin sesión activa'); END IF;
 IF NOT (public.is_tms_admin() OR public.is_contract_administrator() OR public.budget_can_read()) THEN
  RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al control presupuestal');
 END IF;
 IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
  RETURN jsonb_build_object('success', false, 'error', 'La fecha inicial es posterior a la fecha de corte');
 END IF;
 v_family := public.budget_family(p_contract_id);
 IF v_family IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'OT no disponible'); END IF;
 v_budgets := ARRAY(SELECT b.contract_id FROM public.contract_budgets b WHERE b.contract_id = ANY (v_family) AND b.concept = 'PARTIDA_TRANSPORTE');
 v_cap := (s->>'budget_cap_pct')::numeric; v_alert := (s->>'budget_alert_pct')::numeric;

 WITH m AS MATERIALIZED (
   SELECT x.* FROM public.budget_movement_rows(v_family) x WHERE x.budget_contract_id = ANY (v_budgets)),
 p AS (SELECT COALESCE(max(b.allocated_pen) FILTER (WHERE b.contract_id = v_root), 0) AS allocated,
        COALESCE(max(b.own_allocated_pen) FILTER (WHERE b.contract_id = v_root), 0) AS own,
        COALESCE(sum(b.reserved_pen), 0) AS reserved, COALESCE(sum(b.consumed_pen), 0) AS consumed
       FROM public.contract_budgets b WHERE b.contract_id = ANY (v_budgets) AND b.concept = 'PARTIDA_TRANSPORTE'),
 tr AS (
   SELECT m.dispatch_id, min(m.moved_on) AS day, sum(m.reserved_pen) AS reserved, sum(m.consumed_pen) AS consumed,
     bool_or(m.estimated AND m.consumed_pen <> 0) AS has_estimate
   FROM m WHERE m.dispatch_id IS NOT NULL
     AND (p_from IS NULL OR m.moved_on >= p_from) AND (p_to IS NULL OR m.moved_on <= p_to)
   GROUP BY m.dispatch_id),
 cat AS (
   SELECT CASE
     WHEN m.source IN ('FLETE','TARIFA_PROPIA') THEN 'Flete'
     WHEN m.source = 'COMBUSTIBLE_ESTIMADO' OR m.concept ILIKE '%combustible%' THEN 'Combustible'
     WHEN m.concept ILIKE '%peaje%' THEN 'Peajes'
     WHEN m.concept ILIKE ANY (ARRAY['%viatico%','%viático%','%alimentacion%','%alimentación%','%hospedaje%']) THEN 'Viáticos'
     WHEN m.concept ILIKE '%estacionamiento%' THEN 'Estacionamiento'
     WHEN m.source = 'DESCARGA' AND m.concept ILIKE 'grua%' THEN 'Grúa'
     WHEN m.source = 'DESCARGA' AND m.concept ILIKE 'montacargas%' THEN 'Montacargas'
     WHEN m.source = 'DESCARGA' AND m.concept ILIKE 'estiba%' THEN 'Estiba'
     WHEN m.source = 'DESCARGA' THEN 'Descarga especial'
     WHEN m.source = 'SOLICITUD' THEN 'Reserva de solicitud'
     ELSE 'Otros gastos' END AS category, m.*
   FROM m WHERE (p_from IS NULL OR m.moved_on >= p_from) AND (p_to IS NULL OR m.moved_on <= p_to))
 SELECT jsonb_build_object('success', true, 'as_of', now(), 'settings', s,
  'contract', (SELECT jsonb_build_object('id', c.id, 'code', c.code, 'client', cl.business_name, 'status', to_jsonb(c)->>'status')
               FROM public.contracts c LEFT JOIN public.clients cl ON cl.id = c.client_id WHERE c.id = v_root),
  'position', (SELECT jsonb_build_object('allocated_pen', p.allocated, 'own_allocated_pen', p.own,
     'extensions_pen', COALESCE((SELECT sum(e.amount_pen) FROM public.budget_extensions e WHERE e.contract_id = v_root AND e.status = 'APROBADA'), 0),
     'reserved_pen', p.reserved, 'consumed_pen', p.consumed, 'used_pen', p.reserved + p.consumed,
     'used_pct', CASE WHEN p.allocated > 0 THEN round((p.reserved + p.consumed) / p.allocated * 100, 1) END,
     'cap_pen', round(p.allocated * v_cap / 100, 2), 'protected_pen', round(p.allocated * (100 - v_cap) / 100, 2),
     'authorized_over_cap_pen', public.budget_authorized_over_cap(v_root),
     'available_to_cap_pen', round(p.allocated * v_cap / 100 - p.reserved - p.consumed, 2) + public.budget_authorized_over_cap(v_root),
     'level', public.budget_level(CASE WHEN p.allocated > 0 THEN round((p.reserved + p.consumed) / p.allocated * 100, 1) END, v_alert, v_cap)) FROM p),
  -- Viajes (los 300 más recientes del período)
  'trips', COALESCE((SELECT jsonb_agg(jsonb_build_object('dispatch_id', d.id, 'number', d.dispatch_number, 'date', tr.day, 'status', d.status,
     'modalidad', to_jsonb(d)->>'modalidad', 'plate', d.vehicle_plate,
     'carrier', (SELECT ca.business_name FROM public.carriers ca WHERE ca.id = NULLIF(to_jsonb(d)->>'carrier_id', '')::uuid),
     'origin', (SELECT t.pickup_address FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id
                WHERE dr.dispatch_id = d.id ORDER BY dr.sequence_order NULLS LAST, t.id LIMIT 1),
     'destination', (SELECT t.delivery_address FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id
                     WHERE dr.dispatch_id = d.id ORDER BY dr.sequence_order DESC NULLS LAST, t.id LIMIT 1),
     'guides', (SELECT string_agg(DISTINCT dd.document_number, ', ') FROM public.dispatch_documents dd
                WHERE dd.dispatch_id = d.id AND dd.doc_type = 'GUIA_REMISION' AND dd.voided_at IS NULL),
     'planned_pen', COALESCE((SELECT sum(r.amount_pen) FROM public.dispatch_request_freight r WHERE r.dispatch_id = d.id AND r.contract_id = ANY (v_budgets)), 0)
       + CASE WHEN d.contract_id = ANY (v_budgets) AND NOT EXISTS (SELECT 1 FROM public.dispatch_request_freight r WHERE r.dispatch_id = d.id) THEN COALESCE(d.freight_cost, 0) ELSE 0 END
       + COALESCE((SELECT sum(COALESCE(l.planned_pen, l.estimated_pen, 0)) FROM public.transport_unloading_costs l
                   WHERE l.dispatch_id = d.id AND l.contract_id = ANY (v_budgets) AND l.status <> 'ANULADO'), 0),
     'reserved_pen', tr.reserved, 'consumed_pen', tr.consumed, 'has_estimate', tr.has_estimate,
     'closure', (SELECT jsonb_build_object('ready', (x->>'ready')::boolean, 'final', x->'final' IS NOT NULL AND x->'final' <> 'null'::jsonb,
                   'documentario', x->'documentario'->>'status', 'economico', x->'economico'->>'status')
                 FROM (SELECT public.dispatch_closure_checks(d.id) AS x) q))
    ORDER BY tr.day DESC NULLS LAST, d.dispatch_number DESC)
    FROM (SELECT * FROM tr ORDER BY day DESC NULLS LAST LIMIT 300) tr JOIN public.dispatches d ON d.id = tr.dispatch_id), '[]'::jsonb),
  'trips_total', (SELECT count(*) FROM tr),
  -- Por concepto: comprometido, ejecutado (y cuánto de él es estimado)
  'concepts', COALESCE((SELECT jsonb_agg(jsonb_build_object('concept', g.concept, 'reserved_pen', g.r, 'consumed_pen', g.c, 'estimated_pen', g.e, 'count', g.n) ORDER BY g.c + g.r DESC)
    FROM (SELECT category AS concept, sum(reserved_pen) r, sum(consumed_pen) c, sum(consumed_pen) FILTER (WHERE estimated) e, count(*) n FROM cat GROUP BY category) g
    WHERE g.r <> 0 OR g.c <> 0), '[]'::jsonb),
  -- Evolución del ejecutado por mes (acumulado). El comprometido no tiene historia por fecha.
  'series', COALESCE((SELECT jsonb_agg(jsonb_build_object('month', z.month, 'consumed_pen', z.c, 'cumulative_pen', z.cum) ORDER BY z.month)
    FROM (SELECT month, c, sum(c) OVER (ORDER BY month) AS cum FROM (SELECT to_char(date_trunc('month', moved_on), 'YYYY-MM') AS month, sum(consumed_pen) AS c
          FROM m WHERE moved_on IS NOT NULL AND consumed_pen <> 0 GROUP BY 1) y) z), '[]'::jsonb),
  'extensions', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'amount_pen', e.amount_pen, 'reason', e.reason, 'evidence', e.evidence, 'status', e.status,
     'requested_by', public.economic_user_name(e.requested_by), 'requested_at', e.requested_at, 'decided_by', public.economic_user_name(e.decided_by),
     'decided_at', e.decided_at, 'decision_note', e.decision_note) ORDER BY e.requested_at DESC)
    FROM public.budget_extensions e WHERE e.contract_id = v_root), '[]'::jsonb),
  'can_request_extension', public.is_tms_admin() OR public.has_tms_permission('control-presupuestal-recomendar'),
  'can_decide_extension', public.is_tms_admin() OR public.has_tms_permission('control-presupuestal-autorizar'),
  -- Historial de la OT: partida, ampliaciones, autorizaciones, desvíos y cierres finales de sus viajes (últimos 300)
  'timeline', COALESCE((SELECT jsonb_agg(t.h ORDER BY t.h->>'at' DESC) FROM (SELECT u.h FROM (
    SELECT jsonb_build_object('at', a.created_at, 'kind', 'PARTIDA', 'title', 'Partida: ' || a.field, 'detail', a.reason,
      'old', a.old_value, 'new', a.new_value, 'by', NULL) AS h
     FROM public.contract_budget_adjustments a WHERE a.contract_id = ANY (v_budgets)
    UNION ALL SELECT jsonb_build_object('at', e.requested_at, 'kind', 'AMPLIACION', 'title', 'Ampliación solicitada: S/ ' || e.amount_pen, 'detail', e.reason,
      'by', public.economic_user_name(e.requested_by)) FROM public.budget_extensions e WHERE e.contract_id = v_root
    UNION ALL SELECT jsonb_build_object('at', e.decided_at, 'kind', 'AMPLIACION', 'title', 'Ampliación ' || lower(e.status), 'detail', e.decision_note,
      'by', public.economic_user_name(e.decided_by)) FROM public.budget_extensions e WHERE e.contract_id = v_root AND e.decided_at IS NOT NULL
    UNION ALL SELECT jsonb_build_object('at', ev.created_at, 'kind', 'AUTORIZACION', 'title', 'Autorización: ' || lower(ev.action) || COALESCE(' · S/ ' || ev.amount_pen, ''),
      'detail', ev.note, 'by', public.economic_user_name(ev.created_by))
     FROM public.budget_authorization_events ev JOIN public.budget_authorizations au ON au.id = ev.authorization_id WHERE au.contract_id = ANY (v_family)
    UNION ALL SELECT jsonb_build_object('at', ev.created_at, 'kind', 'DESVIO', 'title', 'Desvío: ' || lower(ev.action) || COALESCE(' · S/ ' || ev.amount_pen, ''),
      'detail', ev.note, 'by', public.economic_user_name(ev.created_by))
     FROM public.budget_deviation_events ev JOIN public.budget_deviation_reviews r ON r.key = ev.key WHERE r.contract_id = ANY (v_family)
    UNION ALL SELECT jsonb_build_object('at', ev.created_at, 'kind', 'CIERRE', 'title', 'Servicio ' || d.dispatch_number || ': ' || lower(replace(ev.action, '_', ' ')),
      'detail', ev.note, 'by', public.economic_user_name(ev.created_by))
     FROM public.dispatch_final_close_events ev JOIN public.dispatches d ON d.id = ev.dispatch_id
     WHERE ev.dispatch_id IN (SELECT dispatch_id FROM m WHERE dispatch_id IS NOT NULL)
    ) u(h) ORDER BY u.h->>'at' DESC LIMIT 300) t), '[]'::jsonb))
 INTO v_out;
 RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.budget_ot_detail(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.budget_ot_detail(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
