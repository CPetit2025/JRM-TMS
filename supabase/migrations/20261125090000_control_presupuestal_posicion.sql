-- Control presupuestal de transporte por OT · etapa 1 (solo lectura). docs/control-presupuestal/especificacion.md
-- Una sola cifra por OT (familia: OT raíz + subcontratos), la misma que usa el saldo de contract_budgets:
--   consumo = comprometido (reserved_pen) + ejecutado (consumed_pen), sobre lo asignado.
-- Niveles (R1): menor a la alerta NORMAL · alerta–tope ALERTA · tope–100 % BLOQUEO · más de 100 % EXCEDIDO.
-- Cortes configurables solo por la jefatura (economic_settings). No cambia ningún saldo ni bloqueo.
BEGIN;
SET LOCAL lock_timeout='60s';

ALTER TABLE public.economic_settings ADD COLUMN IF NOT EXISTS budget_alert_pct numeric(5,2) NOT NULL DEFAULT 70;
ALTER TABLE public.economic_settings ADD COLUMN IF NOT EXISTS budget_cap_pct numeric(5,2) NOT NULL DEFAULT 80;
DO $c$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='economic_settings_budget_pct_check') THEN
  ALTER TABLE public.economic_settings ADD CONSTRAINT economic_settings_budget_pct_check
   CHECK (budget_alert_pct > 0 AND budget_alert_pct < budget_cap_pct AND budget_cap_pct <= 100);
 END IF;
END $c$;

CREATE OR REPLACE FUNCTION public.economic_settings_get() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s record;
BEGIN
 SELECT deviation_pct, deviation_pen, max_pending_days, budget_alert_pct, budget_cap_pct INTO s FROM public.economic_settings WHERE id;
 RETURN jsonb_build_object('deviation_pct', COALESCE(s.deviation_pct, 10), 'deviation_pen', COALESCE(s.deviation_pen, 100),
  'max_pending_days', COALESCE(s.max_pending_days, 7), 'budget_alert_pct', COALESCE(s.budget_alert_pct, 70),
  'budget_cap_pct', COALESCE(s.budget_cap_pct, 80));
END $$;
REVOKE ALL ON FUNCTION public.economic_settings_get() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.economic_settings_get() TO authenticated;

CREATE OR REPLACE FUNCTION public.budget_level(p_used_pct numeric, p_alert numeric, p_cap numeric) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN p_used_pct IS NULL THEN 'SIN_PARTIDA' WHEN p_used_pct > 100 THEN 'EXCEDIDO' WHEN p_used_pct > p_cap THEN 'BLOQUEO'
  WHEN p_used_pct >= p_alert THEN 'ALERTA' ELSE 'NORMAL' END
$$;

-- Posición de cada OT raíz visible para el usuario (mismo alcance que la cartera de contratos)
CREATE OR REPLACE FUNCTION public.budget_positions() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_admin boolean := public.is_tms_admin(); v_ca boolean := public.is_contract_administrator() AND NOT public.is_tms_admin();
 v_sites uuid[]; s jsonb := public.economic_settings_get(); v_alert numeric; v_cap numeric;
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin sesión activa'); END IF;
 IF NOT (v_admin OR v_ca OR public.has_tms_read_permission('cierre-economico') OR public.has_tms_read_permission('despacho')
   OR public.has_tms_read_permission('contratos-servicios') OR public.has_tms_read_permission('ot') OR public.has_tms_read_permission('caja')) THEN
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
    'operating_pct', p.operating_pct, 'override', p.override)
   ORDER BY CASE WHEN p.allocated > 0 THEN (p.reserved + p.consumed) / p.allocated END DESC NULLS LAST, p.created_at DESC)
  FROM pos p WHERE p.allocated > 0 OR p.reserved + p.consumed > 0), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.budget_positions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.budget_positions() TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
