-- budget_positions (control presupuestal; también lo usa budget_portfolio_period) leía el margen pactado dos veces por OT
-- (transport_operating_pct + transport_margin_override_for), cada una con planificación propia. Ahora una sola vez y solo
-- para las OT con partida o consumo. transport_operating_pct = COALESCE(override.operating_pct, 80). Mismo resultado.
CREATE OR REPLACE FUNCTION public.budget_positions()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  base AS MATERIALIZED (
    SELECT r.*, cl.business_name AS client, COALESCE(b.allocated_pen, 0) AS allocated, COALESCE(t.reserved, 0) AS reserved,
      COALESCE(t.consumed, 0) AS consumed
    FROM r LEFT JOIN tot t ON t.id = r.id LEFT JOIN public.clients cl ON cl.id = r.client_id
    LEFT JOIN public.contract_budgets b ON b.contract_id = r.id AND b.concept = 'PARTIDA_TRANSPORTE'),
  -- Margen pactado una sola vez por OT con partida (antes: transport_operating_pct y el override, dos lecturas por cada OT)
  pos AS (
    SELECT x.*, COALESCE(o.operating_pct, 80) AS operating_pct,
      CASE WHEN o.id IS NOT NULL THEN jsonb_build_object('pct', o.operating_pct, 'scope', o.scope, 'until', o.valid_until, 'reason', to_jsonb(o)->>'reason') END AS override
    FROM (SELECT * FROM base WHERE base.allocated > 0 OR base.reserved + base.consumed > 0) x
    LEFT JOIN LATERAL public.transport_margin_override_for(x.id) o ON true)
  SELECT jsonb_agg(jsonb_build_object('contract_id', p.id, 'code', p.code, 'client', p.client, 'type', p.type, 'status', p.status,
    'allocated_pen', p.allocated, 'reserved_pen', p.reserved, 'consumed_pen', p.consumed, 'used_pen', p.reserved + p.consumed,
    'used_pct', CASE WHEN p.allocated > 0 THEN round((p.reserved + p.consumed) / p.allocated * 100, 1) END,
    'cap_pen', round(p.allocated * v_cap / 100, 2),
    'available_to_cap_pen', round(p.allocated * v_cap / 100 - p.reserved - p.consumed, 2),
    'level', public.budget_level(CASE WHEN p.allocated > 0 THEN round((p.reserved + p.consumed) / p.allocated * 100, 1) END, v_alert, v_cap),
    'operating_pct', p.operating_pct, 'override', p.override, 'authorized_over_cap_pen', public.budget_authorized_over_cap(p.id),
    'pending_authorizations', (SELECT count(*) FROM public.budget_authorizations a WHERE a.contract_id = p.id AND a.status IN ('SOLICITADA','RECOMENDADA')))
   ORDER BY CASE WHEN p.allocated > 0 THEN (p.reserved + p.consumed) / p.allocated END DESC NULLS LAST, p.created_at DESC)
  FROM pos p), '[]'::jsonb));
END $function$;
