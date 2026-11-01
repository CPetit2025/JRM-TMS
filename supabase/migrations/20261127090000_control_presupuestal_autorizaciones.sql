-- Control presupuestal de transporte por OT · etapa 3: autorizaciones y bloqueo preventivo (docs/control-presupuestal).
-- R3  Comprometer por encima del tope (80 %) exige una autorización vigente de Gerencia de Operaciones; nunca más allá
--     del 100 % de lo asignado (eso es una ampliación de la partida, que hace el área responsable del presupuesto).
-- R4  La autorización no cambia lo asignado, el tope ni el %: solo permite que el comprometido supere el tope hasta su
--     monto, y el sobrecosto sigue visible.
-- F5  Emergencia: queda autorizada de inmediato, provisional, y Gerencia debe ratificarla.
-- Flujo: Supervisor/Programación solicita → Jefe de Distribución recomienda → Gerencia autoriza o rechaza.
-- Toda acción registra usuario, fecha, motivo, monto y evidencia (historial solo de inserción).
BEGIN;
SET LOCAL lock_timeout='60s';

CREATE TABLE IF NOT EXISTS public.budget_authorizations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id      uuid NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
  amount_pen       numeric(15,2) NOT NULL CHECK (amount_pen > 0),
  reason           text NOT NULL CHECK (length(btrim(reason)) >= 10),
  evidence         text,
  emergency        boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'SOLICITADA' CHECK (status IN ('SOLICITADA','RECOMENDADA','AUTORIZADA','RECHAZADA','ANULADA')),
  requested_by     uuid, requested_at timestamptz NOT NULL DEFAULT now(),
  recommended_by   uuid, recommended_at timestamptz, recommendation text,
  decided_by       uuid, decided_at timestamptz, decision_note text,
  regularize_by    timestamptz,
  valid_until      date NOT NULL DEFAULT ((now() AT TIME ZONE 'America/Lima')::date + 30)
);
CREATE INDEX IF NOT EXISTS budget_authorizations_contract_idx ON public.budget_authorizations(contract_id);
ALTER TABLE public.budget_authorizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.budget_authorizations;
CREATE POLICY security_active_account ON public.budget_authorizations AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.budget_authorizations FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.budget_authorization_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authorization_id uuid NOT NULL REFERENCES public.budget_authorizations(id) ON DELETE CASCADE,
  action           text NOT NULL CHECK (action IN ('SOLICITAR','RECOMENDAR','NO_RECOMENDAR','AUTORIZAR','RECHAZAR','RATIFICAR','ANULAR')),
  amount_pen       numeric(15,2),
  note             text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS budget_authorization_events_auth_idx ON public.budget_authorization_events(authorization_id);
ALTER TABLE public.budget_authorization_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.budget_authorization_events;
CREATE POLICY security_active_account ON public.budget_authorization_events AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.budget_authorization_events FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS budget_authorization_events_append_only ON public.budget_authorization_events;
CREATE TRIGGER budget_authorization_events_append_only BEFORE UPDATE OR DELETE ON public.budget_authorization_events
 FOR EACH ROW EXECUTE FUNCTION public.service_cost_events_append_only();

-- Monto vigente autorizado sobre el tope para la familia de la OT, nunca más allá del 100 % de lo asignado
CREATE OR REPLACE FUNCTION public.budget_authorized_over_cap(p_contract uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH root AS (SELECT COALESCE(public.contract_root_id(p_contract), p_contract) AS id),
  b AS (SELECT COALESCE(cb.allocated_pen, 0) AS allocated FROM root LEFT JOIN public.contract_budgets cb ON cb.contract_id = root.id AND cb.concept = 'PARTIDA_TRANSPORTE')
 SELECT LEAST(COALESCE((SELECT sum(a.amount_pen) FROM public.budget_authorizations a, root WHERE a.contract_id = root.id AND a.status = 'AUTORIZADA'
   AND a.valid_until >= (now() AT TIME ZONE 'America/Lima')::date), 0),
  GREATEST((SELECT b.allocated FROM b) - public.transport_operating_limit((SELECT b.allocated FROM b), (SELECT id FROM root)), 0))
$$;
REVOKE ALL ON FUNCTION public.budget_authorized_over_cap(uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.budget_authorization_covers(p_contract uuid, p_overrun numeric) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT COALESCE(p_overrun, 0) <= public.budget_authorized_over_cap(p_contract)
$$;
REVOKE ALL ON FUNCTION public.budget_authorization_covers(uuid,numeric) FROM PUBLIC,anon,authenticated;

-- Saldo de la partida y de la familia: un nuevo compromiso sobre el tope pasa solo si una autorización lo cubre
DO $patch$
DECLARE sig regprocedure := 'public.transport_budget_balance()'::regprocedure; def text;
 o text := 'COALESCE(NEW.reserved_pen,0)>COALESCE(OLD.reserved_pen,0)';
 n text := 'COALESCE(NEW.reserved_pen,0)>COALESCE(OLD.reserved_pen,0) AND NOT public.budget_authorization_covers(NEW.contract_id,-NEW.balance_pen)';
BEGIN
 def := pg_get_functiondef(sig);
 IF position(n IN def) > 0 THEN RETURN; END IF;
 IF position(o IN def) = 0 THEN RAISE EXCEPTION 'Saldo de partida no reconocido: aplicar antes 20261126090000'; END IF;
 EXECUTE replace(def, o, n);
END $patch$;
DO $patch$
DECLARE sig regprocedure := 'public.transport_family_refresh()'::regprocedure; def text;
 o text := 'IF v_balance<0 AND v_increase THEN';
 n text := 'IF v_balance<0 AND v_increase AND NOT public.budget_authorization_covers(v_root,-v_balance) THEN';
BEGIN
 def := pg_get_functiondef(sig);
 IF position(n IN def) > 0 THEN RETURN; END IF;
 IF position(o IN def) = 0 THEN RAISE EXCEPTION 'Verificación de la partida consolidada no reconocida: revisar antes de migrar'; END IF;
 EXECUTE replace(def, o, n);
END $patch$;

-- ------------------------------------------------------------
-- Flujo de la autorización
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.budget_authorization_request(p_contract uuid, p_amount numeric, p_reason text, p_evidence text DEFAULT NULL, p_emergency boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_root uuid; v_alloc numeric; v_max numeric; v_reason text := NULLIF(btrim(COALESCE(p_reason,'')),''); v_id uuid; v_rec boolean;
BEGIN
 IF NOT (public.has_tms_permission('despacho') OR public.has_tms_permission('control-presupuestal-recomendar') OR public.has_tms_permission('control-presupuestal-autorizar')) THEN
  RAISE EXCEPTION 'Sin permiso para solicitar autorizaciones de partida';
 END IF;
 v_root := COALESCE(public.contract_root_id(p_contract), p_contract);
 SELECT allocated_pen INTO v_alloc FROM public.contract_budgets WHERE contract_id = v_root AND concept = 'PARTIDA_TRANSPORTE';
 IF NOT FOUND OR COALESCE(v_alloc, 0) <= 0 THEN RAISE EXCEPTION 'La OT no tiene partida de transporte asignada'; END IF;
 IF v_reason IS NULL OR length(v_reason) < 10 THEN RAISE EXCEPTION 'Explique el motivo de la excepción (mínimo 10 caracteres)'; END IF;
 IF length(v_reason) > 1000 OR length(COALESCE(p_evidence,'')) > 1000 THEN RAISE EXCEPTION 'Motivo o evidencia demasiado extensos'; END IF;
 IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN RAISE EXCEPTION 'Indique el monto a autorizar sobre el tope'; END IF;
 v_max := v_alloc - public.transport_operating_limit(v_alloc, v_root) - public.budget_authorized_over_cap(v_root);
 IF p_amount > v_max THEN
  RAISE EXCEPTION 'Supera el 100 %% de la partida (máximo autorizable S/ %): requiere ampliación presupuestal', round(GREATEST(v_max, 0), 2);
 END IF;
 v_rec := public.has_tms_permission('control-presupuestal-recomendar');
 INSERT INTO public.budget_authorizations(contract_id, amount_pen, reason, evidence, emergency, status, requested_by,
  recommended_by, recommended_at, recommendation, regularize_by)
 VALUES (v_root, p_amount, v_reason, NULLIF(btrim(COALESCE(p_evidence,'')),''), COALESCE(p_emergency, false),
  CASE WHEN COALESCE(p_emergency, false) THEN 'AUTORIZADA' WHEN v_rec THEN 'RECOMENDADA' ELSE 'SOLICITADA' END, auth.uid(),
  CASE WHEN v_rec THEN auth.uid() END, CASE WHEN v_rec THEN now() END, CASE WHEN v_rec THEN 'Solicitada por el Jefe de Distribución' END,
  CASE WHEN COALESCE(p_emergency, false) THEN now() + interval '24 hours' END)
 RETURNING id INTO v_id;
 INSERT INTO public.budget_authorization_events(authorization_id, action, amount_pen, note, created_by)
 VALUES (v_id, 'SOLICITAR', p_amount, CASE WHEN p_emergency THEN 'EMERGENCIA: ' ELSE '' END || v_reason, auth.uid());
 RETURN jsonb_build_object('success', true, 'id', v_id, 'status', CASE WHEN p_emergency THEN 'AUTORIZADA' WHEN v_rec THEN 'RECOMENDADA' ELSE 'SOLICITADA' END);
EXCEPTION WHEN raise_exception THEN
 RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.budget_authorization_request(uuid,numeric,text,text,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.budget_authorization_request(uuid,numeric,text,text,boolean) TO authenticated;

-- p_action: RECOMENDAR / NO_RECOMENDAR (Jefe de Distribución); AUTORIZAR / RECHAZAR / RATIFICAR (Gerencia); ANULAR (Gerencia)
CREATE OR REPLACE FUNCTION public.budget_authorization_action(p_id uuid, p_action text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a record; v_action text := upper(COALESCE(p_action,'')); v_note text := NULLIF(btrim(COALESCE(p_note,'')),''); v_to text;
BEGIN
 SELECT * INTO a FROM public.budget_authorizations WHERE id = p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Autorización inexistente'; END IF;
 IF length(COALESCE(v_note,'')) > 1000 THEN RAISE EXCEPTION 'Nota demasiado extensa'; END IF;
 IF v_action IN ('RECOMENDAR','NO_RECOMENDAR') THEN
  IF NOT public.has_tms_permission('control-presupuestal-recomendar') THEN RAISE EXCEPTION 'Solo el Jefe de Distribución recomienda excepciones'; END IF;
  IF a.status <> 'SOLICITADA' THEN RAISE EXCEPTION 'Solo se recomienda una solicitud pendiente'; END IF;
  IF v_action = 'NO_RECOMENDAR' AND (v_note IS NULL OR length(v_note) < 5) THEN RAISE EXCEPTION 'Indique por qué no se recomienda'; END IF;
  v_to := CASE v_action WHEN 'RECOMENDAR' THEN 'RECOMENDADA' ELSE 'RECHAZADA' END;
  UPDATE public.budget_authorizations SET status = v_to, recommended_by = auth.uid(), recommended_at = now(), recommendation = v_note WHERE id = p_id;
 ELSIF v_action IN ('AUTORIZAR','RECHAZAR','RATIFICAR','ANULAR') THEN
  IF NOT public.has_tms_permission('control-presupuestal-autorizar') THEN RAISE EXCEPTION 'Solo Gerencia de Operaciones autoriza excepciones del tope'; END IF;
  IF v_action = 'AUTORIZAR' AND a.status NOT IN ('SOLICITADA','RECOMENDADA') THEN RAISE EXCEPTION 'La solicitud ya fue resuelta'; END IF;
  IF v_action = 'RATIFICAR' AND NOT (a.emergency AND a.status = 'AUTORIZADA' AND a.decided_at IS NULL) THEN RAISE EXCEPTION 'Solo se ratifica una emergencia pendiente'; END IF;
  IF v_action = 'RECHAZAR' AND NOT (a.status IN ('SOLICITADA','RECOMENDADA') OR (a.emergency AND a.status = 'AUTORIZADA' AND a.decided_at IS NULL)) THEN
   RAISE EXCEPTION 'La solicitud ya fue resuelta';
  END IF;
  IF v_action = 'ANULAR' AND a.status <> 'AUTORIZADA' THEN RAISE EXCEPTION 'Solo se anula una autorización vigente'; END IF;
  IF v_action IN ('RECHAZAR','ANULAR') AND (v_note IS NULL OR length(v_note) < 5) THEN RAISE EXCEPTION 'Indique el motivo'; END IF;
  v_to := CASE v_action WHEN 'RECHAZAR' THEN 'RECHAZADA' WHEN 'ANULAR' THEN 'ANULADA' ELSE 'AUTORIZADA' END;
  -- Rechazar o anular no deshace lo ya comprometido: solo impide nuevos compromisos sobre el tope
  UPDATE public.budget_authorizations SET status = v_to, decided_by = auth.uid(), decided_at = now(), decision_note = v_note WHERE id = p_id;
 ELSE
  RAISE EXCEPTION 'Acción inválida';
 END IF;
 INSERT INTO public.budget_authorization_events(authorization_id, action, amount_pen, note, created_by) VALUES (p_id, v_action, a.amount_pen, v_note, auth.uid());
 RETURN jsonb_build_object('success', true, 'status', v_to);
EXCEPTION WHEN raise_exception THEN
 RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.budget_authorization_action(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.budget_authorization_action(uuid,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.budget_can_read() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT public.is_tms_admin() OR public.has_tms_read_permission('control-presupuestal') OR public.has_tms_read_permission('cierre-economico')
  OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('contratos-servicios') OR public.has_tms_read_permission('ot')
  OR public.has_tms_read_permission('caja') OR public.has_tms_permission('control-presupuestal-recomendar') OR public.has_tms_permission('control-presupuestal-autorizar')
$$;
REVOKE ALL ON FUNCTION public.budget_can_read() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.budget_authorizations_list() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT public.budget_can_read() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al control presupuestal'); END IF;
 RETURN jsonb_build_object('success', true,
  'can_request', public.has_tms_permission('despacho') OR public.has_tms_permission('control-presupuestal-recomendar') OR public.has_tms_permission('control-presupuestal-autorizar'),
  'can_recommend', public.has_tms_permission('control-presupuestal-recomendar'), 'can_authorize', public.has_tms_permission('control-presupuestal-autorizar'),
  'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'contract_id', a.contract_id, 'code', c.code, 'amount_pen', a.amount_pen, 'reason', a.reason,
     'evidence', a.evidence, 'emergency', a.emergency, 'status', a.status, 'requested_at', a.requested_at, 'requested_by', public.economic_user_name(a.requested_by),
     'recommended_by', public.economic_user_name(a.recommended_by), 'recommendation', a.recommendation,
     'decided_by', public.economic_user_name(a.decided_by), 'decided_at', a.decided_at, 'decision_note', a.decision_note,
     'regularize_by', a.regularize_by, 'valid_until', a.valid_until,
     'pending_ratification', a.emergency AND a.status = 'AUTORIZADA' AND a.decided_at IS NULL)
    ORDER BY CASE a.status WHEN 'SOLICITADA' THEN 1 WHEN 'RECOMENDADA' THEN 2 ELSE 3 END, a.requested_at DESC)
   FROM public.budget_authorizations a JOIN public.contracts c ON c.id = a.contract_id
   WHERE (c.site_id IS NULL OR public.can_access_site(c.site_id))
     AND (a.status IN ('SOLICITADA','RECOMENDADA') OR a.requested_at >= now() - interval '120 days')), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.budget_authorizations_list() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.budget_authorizations_list() TO authenticated;

-- Vista previa al programar: consumo actual y proyectado por OT con el compromiso nuevo, y si se puede confirmar
-- p_items = [{ contract_id, amount }]
CREATE OR REPLACE FUNCTION public.budget_preview(p_items jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s jsonb := public.economic_settings_get(); e jsonb; v_root uuid; v_tot record; v_alloc numeric; v_add numeric; v_out jsonb := '[]'::jsonb;
 v_cap numeric; v_auth numeric; v_now numeric; v_after numeric; v_roots jsonb := '{}'::jsonb; k text;
BEGIN
 IF auth.uid() IS NULL OR NOT public.budget_can_read() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al control presupuestal'); END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
  v_root := public.contract_root_id(NULLIF(e->>'contract_id','')::uuid);
  IF v_root IS NULL THEN CONTINUE; END IF;
  v_roots := jsonb_set(v_roots, ARRAY[v_root::text], to_jsonb(COALESCE((v_roots->>v_root::text)::numeric, 0) + COALESCE(NULLIF(e->>'amount','')::numeric, 0)));
 END LOOP;
 FOR k IN SELECT jsonb_object_keys(v_roots) LOOP
  v_root := k::uuid; v_add := (v_roots->>k)::numeric;
  SELECT allocated_pen INTO v_alloc FROM public.contract_budgets WHERE contract_id = v_root AND concept = 'PARTIDA_TRANSPORTE';
  SELECT * INTO v_tot FROM public.transport_family_totals(v_root);
  v_cap := public.transport_operating_limit(COALESCE(v_alloc, 0), v_root); v_auth := public.budget_authorized_over_cap(v_root);
  v_now := v_tot.reserved + v_tot.consumed; v_after := v_now + v_add;
  v_out := v_out || jsonb_build_array(jsonb_build_object('contract_id', v_root, 'code', (SELECT code FROM public.contracts WHERE id = v_root),
   'allocated_pen', v_alloc, 'used_pen', v_now, 'after_pen', v_after, 'add_pen', v_add, 'cap_pen', v_cap, 'authorized_over_cap_pen', v_auth,
   'used_pct', CASE WHEN v_alloc > 0 THEN round(v_now / v_alloc * 100, 1) END,
   'after_pct', CASE WHEN v_alloc > 0 THEN round(v_after / v_alloc * 100, 1) END,
   'level', public.budget_level(CASE WHEN v_alloc > 0 THEN round(v_after / v_alloc * 100, 1) END, (s->>'budget_alert_pct')::numeric, (s->>'budget_cap_pct')::numeric),
   'allowed', v_add <= 0 OR v_after <= v_cap + v_auth,
   'needs_pen', GREATEST(round(v_after - v_cap - v_auth, 2), 0)));
 END LOOP;
 RETURN jsonb_build_object('success', true, 'settings', s, 'rows', v_out);
END $$;
REVOKE ALL ON FUNCTION public.budget_preview(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.budget_preview(jsonb) TO authenticated;

-- Posición por OT (reescrita de 20261125090000): permiso «control-presupuestal» y monto autorizado sobre el tope
CREATE OR REPLACE FUNCTION public.budget_positions() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_admin boolean := public.is_tms_admin(); v_ca boolean := public.is_contract_administrator() AND NOT public.is_tms_admin();
 v_sites uuid[]; s jsonb := public.economic_settings_get(); v_alert numeric; v_cap numeric;
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin sesión activa'); END IF;
 IF NOT (v_admin OR v_ca OR public.budget_can_read()) THEN
  RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al control presupuestal');
 END IF;
 v_alert := (s->>'budget_alert_pct')::numeric; v_cap := (s->>'budget_cap_pct')::numeric;
 v_sites := ARRAY(SELECT x.id FROM public.sites x WHERE public.can_access_site(x.id));
 RETURN jsonb_build_object('success', true, 'settings', s, 'rows', COALESCE((
  WITH RECURSIVE r AS MATERIALIZED (
    SELECT c.id, c.code, c.client_id, c.type, to_jsonb(c)->>'status' AS status, c.created_at FROM public.contracts c
    WHERE c.parent_contract_id IS NULL AND c.type IN ('CONTRATO','OT_INDEPENDIENTE') AND c.site_id = ANY (v_sites)
      AND (NOT v_ca OR public.has_assigned_contract(c.id))),
  fam (root, id) AS (SELECT r.id, r.id FROM r UNION SELECT f.root, c.id FROM public.contracts c JOIN fam f ON c.parent_contract_id = f.id),
  tot AS (SELECT f.root AS id, COALESCE(sum(b.reserved_pen), 0) AS reserved, COALESCE(sum(b.consumed_pen), 0) AS consumed
          FROM fam f JOIN public.contract_budgets b ON b.contract_id = f.id AND b.concept = 'PARTIDA_TRANSPORTE' GROUP BY 1),
  pos AS (
    SELECT r.*, cl.business_name AS client, COALESCE(b.allocated_pen, 0) AS allocated, COALESCE(t.reserved, 0) AS reserved,
      COALESCE(t.consumed, 0) AS consumed, public.transport_operating_pct(r.id) AS operating_pct,
      (SELECT jsonb_build_object('pct', o.operating_pct, 'scope', o.scope, 'until', o.valid_until, 'reason', to_jsonb(o)->>'reason')
       FROM public.transport_margin_override_for(r.id) o WHERE o.id IS NOT NULL) AS override
    FROM r LEFT JOIN tot t ON t.id = r.id LEFT JOIN public.clients cl ON cl.id = r.client_id
    LEFT JOIN public.contract_budgets b ON b.contract_id = r.id AND b.concept = 'PARTIDA_TRANSPORTE')
  SELECT jsonb_agg(jsonb_build_object('contract_id', p.id, 'code', p.code, 'client', p.client, 'type', p.type, 'status', p.status,
    'allocated_pen', p.allocated, 'reserved_pen', p.reserved, 'consumed_pen', p.consumed, 'used_pen', p.reserved + p.consumed,
    'used_pct', CASE WHEN p.allocated > 0 THEN round((p.reserved + p.consumed) / p.allocated * 100, 1) END,
    'cap_pen', round(p.allocated * v_cap / 100, 2),
    'available_to_cap_pen', round(p.allocated * v_cap / 100 - p.reserved - p.consumed, 2),
    'level', public.budget_level(CASE WHEN p.allocated > 0 THEN round((p.reserved + p.consumed) / p.allocated * 100, 1) END, v_alert, v_cap),
    'operating_pct', p.operating_pct, 'override', p.override, 'authorized_over_cap_pen', public.budget_authorized_over_cap(p.id),
    'pending_authorizations', (SELECT count(*) FROM public.budget_authorizations a WHERE a.contract_id = p.id AND a.status IN ('SOLICITADA','RECOMENDADA')))
   ORDER BY CASE WHEN p.allocated > 0 THEN (p.reserved + p.consumed) / p.allocated END DESC NULLS LAST, p.created_at DESC)
  FROM pos p WHERE p.allocated > 0 OR p.reserved + p.consumed > 0), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.budget_positions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.budget_positions() TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
