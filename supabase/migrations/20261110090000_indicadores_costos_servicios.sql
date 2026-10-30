-- Etapa 6 · Indicadores de costos de servicios: referencial → acordado → final por tipo de servicio, proveedor y OT,
-- adicionales, cierres documentario y económico pendientes, e impacto sobre la partida de transporte de cada OT.
-- Solo lectura: no agrega tablas. Cada costo se cuenta una vez (rutas mixtas: el flete por OT de dispatch_request_freight).
BEGIN;

CREATE OR REPLACE FUNCTION public.service_cost_indicators(p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_out jsonb;
BEGIN
 IF NOT public.economic_can_read() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a los indicadores de costos'); END IF;
 IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 366 THEN RETURN jsonb_build_object('success', false, 'error', 'Período inválido (máximo 366 días)'); END IF;

 WITH r AS (
  SELECT d.id, d.status, d.contract_id, COALESCE(d.freight_cost, 0) AS freight_cost,
   COALESCE((SELECT to_jsonb(c)->>'business_name' FROM public.carriers c WHERE c.id = d.carrier_id), 'Flota propia JRM') AS carrier
  FROM public.dispatches d
  WHERE d.status IN ('LIQUIDADO','CERRADO','RETORNO_COMPLETADO','ENTREGADO','CIERRE_OPERATIVO')
    AND (d.site_id IS NULL OR public.can_access_site(d.site_id))
    AND (d.scheduled_departure AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to),
 items AS (
  -- Flete de rutas de una OT
  SELECT r.id AS dispatch_id, 'FLETE'::text AS concept, r.contract_id, r.carrier AS supplier,
   (SELECT COALESCE(sum(COALESCE(t.service_cost, 0)), 0) FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id WHERE dr.dispatch_id = r.id) AS ref,
   COALESCE(s.agreed_pen, r.freight_cost) AS agreed, s.final_pen AS final, s.extras_pen AS extras
  FROM r LEFT JOIN public.dispatch_freight_stages s ON s.dispatch_id = r.id
  WHERE NOT EXISTS (SELECT 1 FROM public.dispatch_request_freight f WHERE f.dispatch_id = r.id)
  UNION ALL
  -- Flete de rutas mixtas, por OT
  SELECT r.id, 'FLETE', f.contract_id, r.carrier, COALESCE(t.service_cost, 0), COALESCE(st.agreed_pen, f.amount_pen), st.final_pen,
   CASE WHEN s.final_pen > 0 AND st.final_pen IS NOT NULL THEN round(COALESCE(s.extras_pen, 0) * st.final_pen / s.final_pen, 2) END
  FROM r JOIN public.dispatch_request_freight f ON f.dispatch_id = r.id AND f.status <> 'LIBERADO'
  JOIN public.transport_requests t ON t.id = f.request_id
  LEFT JOIN public.dispatch_request_freight_stages st ON st.dispatch_id = f.dispatch_id AND st.request_id = f.request_id
  LEFT JOIN public.dispatch_freight_stages s ON s.dispatch_id = r.id
  UNION ALL
  -- Servicios especiales
  SELECT r.id, u.concept, u.contract_id, COALESCE(sp.business_name, NULLIF(btrim(u.provider_name), ''), 'Sin proveedor'),
   COALESCE(u.estimated_pen, 0), COALESCE(u.planned_pen, u.estimated_pen, 0), u.final_pen, u.final_extras_pen
  FROM r JOIN public.transport_unloading_costs u ON u.dispatch_id = r.id AND u.status <> 'ANULADO'
  LEFT JOIN public.suppliers sp ON sp.id = u.supplier_id),
 agg AS (
  SELECT concept, count(*) AS n, sum(ref) AS ref, sum(agreed) AS agreed, count(final) AS n_final,
   sum(agreed) FILTER (WHERE final IS NOT NULL) AS agreed_closed, sum(final) AS final, sum(COALESCE(extras, 0)) AS extras
  FROM items GROUP BY concept)
 SELECT jsonb_build_object('success', true,
  'routes', (SELECT count(*) FROM r),
  'totals', (SELECT jsonb_build_object('items', count(*), 'with_final', count(final), 'referential_pen', COALESCE(sum(ref), 0), 'agreed_pen', COALESCE(sum(agreed), 0),
     'agreed_with_final_pen', COALESCE(sum(agreed) FILTER (WHERE final IS NOT NULL), 0), 'final_pen', COALESCE(sum(final), 0), 'extras_pen', COALESCE(sum(extras), 0))
   FROM items),
  'by_type', COALESCE((SELECT jsonb_agg(jsonb_build_object('concept', concept, 'items', n, 'with_final', n_final, 'referential_pen', ref, 'agreed_pen', agreed,
     'agreed_with_final_pen', COALESCE(agreed_closed, 0), 'final_pen', COALESCE(final, 0), 'extras_pen', extras) ORDER BY agreed DESC) FROM agg), '[]'::jsonb),
  'by_supplier', COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'agreed_pen')::numeric DESC) FROM (
    SELECT jsonb_build_object('supplier', supplier, 'concepts', string_agg(DISTINCT concept, ', '), 'items', count(*), 'with_final', count(final),
     'referential_pen', sum(ref), 'agreed_pen', sum(agreed), 'agreed_with_final_pen', COALESCE(sum(agreed) FILTER (WHERE final IS NOT NULL), 0),
     'final_pen', COALESCE(sum(final), 0), 'extras_pen', sum(COALESCE(extras, 0))) AS x
    FROM items GROUP BY supplier) s), '[]'::jsonb),
  'by_contract', COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'agreed_pen')::numeric DESC) FROM (
    SELECT jsonb_build_object('contract_id', i.contract_id, 'code', COALESCE(c.code, 'Sin OT (OC/OS/RQ)'), 'routes', count(DISTINCT i.dispatch_id), 'items', count(*),
     'with_final', count(i.final), 'referential_pen', sum(i.ref), 'agreed_pen', sum(i.agreed),
     'agreed_with_final_pen', COALESCE(sum(i.agreed) FILTER (WHERE i.final IS NOT NULL), 0), 'final_pen', COALESCE(sum(i.final), 0),
     'extras_pen', sum(COALESCE(i.extras, 0)),
     'budget', (SELECT jsonb_build_object('allocated_pen', b.allocated_pen, 'reserved_pen', b.reserved_pen, 'consumed_pen', b.consumed_pen, 'balance_pen', b.balance_pen)
       FROM public.contract_budgets b WHERE b.contract_id = i.contract_id AND b.concept = 'PARTIDA_TRANSPORTE')) AS x
    FROM items i LEFT JOIN public.contracts c ON c.id = i.contract_id GROUP BY i.contract_id, c.code) s), '[]'::jsonb),
  'pending', jsonb_build_object(
   'routes_open', (SELECT count(*) FROM r WHERE r.status NOT IN ('LIQUIDADO','CERRADO')),
   'economic_pending', (SELECT count(*) FROM r WHERE r.status IN ('LIQUIDADO','CERRADO') AND public.economic_closure_status(r.id) IN ('PENDIENTE','OBSERVADO')),
   'economic_review', (SELECT count(*) FROM r WHERE public.economic_closure_status(r.id) = 'EN_REVISION'),
   'economic_closed', (SELECT count(*) FROM r WHERE public.economic_closure_status(r.id) = 'CERRADO'),
   'documentary_pending_services', (SELECT count(*) FROM public.documentary_closures dc JOIN r ON r.id = dc.dispatch_id WHERE dc.status <> 'COMPLETO'),
   'documentary_complete_economic_pending', (SELECT count(*) FROM r WHERE public.economic_closure_status(r.id) <> 'CERRADO'
     AND EXISTS (SELECT 1 FROM public.documentary_closures dc WHERE dc.dispatch_id = r.id)
     AND NOT EXISTS (SELECT 1 FROM public.documentary_closures dc WHERE dc.dispatch_id = r.id AND dc.status <> 'COMPLETO'))))
 INTO v_out;
 RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.service_cost_indicators(date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.service_cost_indicators(date,date) TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
