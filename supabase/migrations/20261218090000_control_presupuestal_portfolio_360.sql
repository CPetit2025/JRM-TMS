-- Control presupuestal 360: agregado del ejecutado con movimiento en un período.
-- El comprometido no se historiza; el RPC lo deja fuera del corte y la interfaz lo etiqueta como vigente.
-- Reutiliza las posiciones y movimientos existentes: no crea otro libro ni modifica saldos.
BEGIN;
SET LOCAL lock_timeout = '60s';

CREATE OR REPLACE FUNCTION public.budget_portfolio_period(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_position jsonb; v_out jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_active_tms_user() THEN
  RETURN jsonb_build_object('success', false, 'error', 'Sin sesión activa');
 END IF;
 IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 366 THEN
  RETURN jsonb_build_object('success', false, 'error', 'Período inválido (máximo 366 días)');
 END IF;

 -- budget_positions es la puerta de acceso común: aplica permisos, sede y asignación de OT.
 v_position := public.budget_positions();
 IF COALESCE((v_position->>'success')::boolean, false) IS NOT TRUE THEN RETURN v_position; END IF;

 WITH RECURSIVE roots AS MATERIALIZED (
   SELECT (x->>'contract_id')::uuid AS root, x->>'code' AS code
   FROM jsonb_array_elements(COALESCE(v_position->'rows', '[]'::jsonb)) x
 ),
 family(root, id) AS (
   SELECT root, root FROM roots
   UNION
   SELECT f.root, c.id FROM public.contracts c JOIN family f ON c.parent_contract_id = f.id
 ),
 budgets AS MATERIALIZED (
   SELECT DISTINCT f.root, b.contract_id
   FROM family f JOIN public.contract_budgets b ON b.contract_id = f.id AND b.concept = 'PARTIDA_TRANSPORTE'
 ),
 movements AS MATERIALIZED (
   SELECT b.root, m.id, m.moved_on, m.consumed_pen
   FROM public.budget_movement_rows(ARRAY(SELECT DISTINCT contract_id FROM budgets)) m
   JOIN budgets b ON b.contract_id = m.budget_contract_id
   WHERE m.moved_on BETWEEN p_from AND p_to AND m.consumed_pen <> 0
 ),
 totals AS (
   SELECT root, round(sum(consumed_pen), 2) AS executed_pen, count(*)::integer AS movement_count
   FROM movements GROUP BY root
 )
 SELECT jsonb_build_object(
   'success', true, 'from', p_from, 'to', p_to, 'as_of', now(),
   'rows', COALESCE(jsonb_agg(jsonb_build_object('contract_id', r.root, 'code', r.code,
      'executed_pen', COALESCE(t.executed_pen, 0), 'movement_count', COALESCE(t.movement_count, 0)) ORDER BY r.code), '[]'::jsonb),
   'executed_total_pen', COALESCE(round(sum(COALESCE(t.executed_pen, 0)), 2), 0)
 ) INTO v_out
 FROM roots r LEFT JOIN totals t ON t.root = r.root;

 RETURN v_out;
END $$;

REVOKE ALL ON FUNCTION public.budget_portfolio_period(date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.budget_portfolio_period(date,date) TO authenticated;

-- Clasifica el ahorro calculado sin alterar la función compartida ni sus consumidores actuales.
-- VALIDADO: ruta cerrada con datos de ejecución suficientes y, para terceros, costo final aplicado.
-- ESTIMADO: el costo depende de km/horas estimados o aún no se aplicó el costo final del tercero.
CREATE OR REPLACE FUNCTION public.consolidation_savings_classified(p_from date DEFAULT NULL, p_to date DEFAULT NULL,
  p_contract uuid DEFAULT NULL, p_dispatch uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_base jsonb; v_out jsonb;
BEGIN
 v_base := public.consolidation_savings(p_from, p_to, p_contract, p_dispatch);
 IF COALESCE((v_base->>'success')::boolean, false) IS NOT TRUE THEN RETURN v_base; END IF;

 WITH raw AS MATERIALIZED (
   SELECT x AS item, NULLIF(x->>'dispatch_id', '')::uuid AS dispatch_id
   FROM jsonb_array_elements(COALESCE(v_base->'rows', '[]'::jsonb)) x
 ),
 classified AS (
   SELECT r.item || jsonb_build_object('valuation_status', CASE
     WHEN COALESCE((r.item->>'principal')::boolean, false) THEN 'NO_APLICA'
     WHEN r.item->>'state' <> 'VALORIZADO' THEN 'PENDIENTE'
     WHEN d.modalidad = 'TERCERO' AND d.closed AND d.freight_final_applied THEN 'VALIDADO'
     WHEN d.modalidad = 'TERCERO' THEN 'ESTIMADO'
     WHEN d.closed AND d.actual_distance_km > 0 AND d.departure_time IS NOT NULL AND d.returned_at IS NOT NULL
       AND COALESCE((r.item->>'km_estimated')::boolean, true) = false THEN 'VALIDADO'
     ELSE 'ESTIMADO' END) AS item
   FROM raw r
   LEFT JOIN LATERAL (
     SELECT x.modalidad, x.status IN ('LIQUIDADO','CERRADO') AS closed, x.actual_distance_km, x.departure_time, x.returned_at,
       CASE WHEN EXISTS (SELECT 1 FROM public.dispatch_request_freight f WHERE f.dispatch_id = x.id AND f.status <> 'LIBERADO')
         THEN NOT EXISTS (SELECT 1 FROM public.dispatch_request_freight f
           LEFT JOIN public.dispatch_request_freight_stages st ON st.dispatch_id = f.dispatch_id AND st.request_id = f.request_id
           WHERE f.dispatch_id = x.id AND f.status <> 'LIBERADO' AND st.final_applied_pen IS NULL)
         ELSE EXISTS (SELECT 1 FROM public.dispatch_freight_stages st WHERE st.dispatch_id = x.id AND st.final_applied_pen IS NOT NULL)
       END AS freight_final_applied
     FROM public.dispatches x WHERE x.id = r.dispatch_id
   ) d ON true
 ), totals AS (
   SELECT COALESCE(sum((item->>'saving_pen')::numeric) FILTER (WHERE item->>'valuation_status' = 'VALIDADO'), 0) AS validated,
     COALESCE(sum((item->>'saving_pen')::numeric) FILTER (WHERE item->>'valuation_status' = 'ESTIMADO'), 0) AS estimated,
     count(*) FILTER (WHERE item->>'valuation_status' = 'VALIDADO')::integer AS validated_count,
     count(*) FILTER (WHERE item->>'valuation_status' = 'ESTIMADO')::integer AS estimated_count
   FROM classified WHERE item ? 'saving_pen'
 )
 SELECT v_base || jsonb_build_object(
   'calculated_saving_total', COALESCE((v_base->>'saving_total')::numeric, 0),
   'validated_saving_total', t.validated, 'estimated_saving_total', t.estimated,
   'validated_services', t.validated_count, 'estimated_services', t.estimated_count,
   'rows', COALESCE((SELECT jsonb_agg(c.item ORDER BY (c.item->>'date') DESC, c.item->>'dispatch_number', c.item->>'principal' DESC)
                     FROM classified c), '[]'::jsonb)
 ) INTO v_out FROM totals t;
 RETURN v_out;
END $$;

REVOKE ALL ON FUNCTION public.consolidation_savings_classified(date,date,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consolidation_savings_classified(date,date,uuid,uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
