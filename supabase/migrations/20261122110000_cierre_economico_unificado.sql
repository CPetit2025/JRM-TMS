-- Cierre económico como único lugar del costo final:
--  * transport_unloading_costs_final_lock: un servicio con costo final validado en el Cierre económico (o en su flujo de
--    estados) ya no se anula ni recibe otro «costo real» manual desde Torre de Control; se corrige en el Cierre económico.
--    Los gastos de Caja (con expense_id) y la aplicación del propio cierre (tms.economic_apply) siguen funcionando.
--  * economic_queue_key: el mismo estado que muestra la bandeja (Por cerrar, Por aprobar, Cerrada, No aplica).
--  * service_cost_indicators: los pendientes usan esos estados y el mismo alcance que la bandeja (desde que la unidad
--    se libera, no solo con la ruta liquidada), incluido el cierre parcial y «No aplica».
-- No se reescriben register_unloading_actual ni void_unloading_cost (pueden tener parches en producción): el bloqueo
-- está en un disparador nuevo. No hay UPDATE de datos.
BEGIN;
SET LOCAL lock_timeout='60s';

CREATE OR REPLACE FUNCTION public.transport_unloading_costs_final_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE o jsonb := to_jsonb(OLD); n jsonb := to_jsonb(NEW);
BEGIN
 IF COALESCE(current_setting('tms.economic_apply', true), '') = 'on' THEN RETURN NEW; END IF;
 IF o->>'final_pen' IS NULL AND COALESCE(o->>'econ_status', '') IN ('', 'POR_VALIDAR') THEN RETURN NEW; END IF;
 IF NEW.status = 'ANULADO' AND OLD.status IS DISTINCT FROM 'ANULADO' THEN
  RAISE EXCEPTION 'El servicio % tiene costo final en el Cierre económico: corríjalo u obsérvelo allí antes de anularlo', lower(OLD.concept);
 END IF;
 IF NEW.actual_pen IS DISTINCT FROM OLD.actual_pen AND n->>'expense_id' IS NULL THEN
  RAISE EXCEPTION 'El costo de % se registra en el Cierre económico (ya tiene costo final)', lower(OLD.concept);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.transport_unloading_costs_final_lock() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS transport_unloading_costs_final_lock ON public.transport_unloading_costs;
CREATE TRIGGER transport_unloading_costs_final_lock BEFORE UPDATE ON public.transport_unloading_costs
 FOR EACH ROW EXECUTE FUNCTION public.transport_unloading_costs_final_lock();

-- Estado de la bandeja (igual que econKey en src/lib/economic-closure.ts)
CREATE OR REPLACE FUNCTION public.economic_queue_key(p_dispatch_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE st jsonb := public.economic_route_state(p_dispatch_id); it jsonb := COALESCE(public.economic_route_items(p_dispatch_id), '[]'::jsonb);
BEGIN
 IF st->>'status' = 'NO_APLICA' THEN RETURN 'NO_APLICA'; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(it) x WHERE x->>'status' = 'EN_REVISION') THEN RETURN 'POR_APROBAR'; END IF;
 IF jsonb_array_length(it) > 0 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(it) x WHERE x->>'status' IS DISTINCT FROM 'APROBADO') THEN RETURN 'CERRADO'; END IF;
 IF jsonb_array_length(it) = 0 AND st->>'status' = 'CERRADO' THEN RETURN 'CERRADO'; END IF;
 RETURN 'POR_CERRAR';
END $$;
REVOKE ALL ON FUNCTION public.economic_queue_key(uuid) FROM PUBLIC, anon, authenticated;

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
   (SELECT COALESCE(sum(public.request_referential_freight(t.id)), 0) FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id WHERE dr.dispatch_id = r.id) AS ref,
   COALESCE(s.agreed_pen, r.freight_cost) AS agreed, s.final_pen AS final, s.extras_pen AS extras
  FROM r LEFT JOIN public.dispatch_freight_stages s ON s.dispatch_id = r.id
  WHERE NOT EXISTS (SELECT 1 FROM public.dispatch_request_freight f WHERE f.dispatch_id = r.id)
  UNION ALL
  -- Flete de rutas mixtas, por OT
  SELECT r.id, 'FLETE', f.contract_id, r.carrier, public.request_referential_freight(t.id), COALESCE(st.agreed_pen, f.amount_pen), st.final_pen,
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
  -- Mismos estados y alcance que la bandeja del cierre económico (economic_queue_key)
  'pending', (SELECT jsonb_build_object(
   'routes_unreleased', count(*) FILTER (WHERE k.status = 'ENTREGADO'),
   'por_cerrar', count(*) FILTER (WHERE k.key = 'POR_CERRAR'),
   'por_aprobar', count(*) FILTER (WHERE k.key = 'POR_APROBAR'),
   'cerradas', count(*) FILTER (WHERE k.key = 'CERRADO'),
   'no_aplica', count(*) FILTER (WHERE k.key = 'NO_APLICA'),
   'documentary_pending_services', (SELECT count(*) FROM public.documentary_closures dc JOIN r ON r.id = dc.dispatch_id WHERE dc.status <> 'COMPLETO'),
   'documentary_complete_economic_pending', count(*) FILTER (WHERE k.key IN ('POR_CERRAR','POR_APROBAR')
     AND EXISTS (SELECT 1 FROM public.documentary_closures dc WHERE dc.dispatch_id = k.id)
     AND NOT EXISTS (SELECT 1 FROM public.documentary_closures dc WHERE dc.dispatch_id = k.id AND dc.status <> 'COMPLETO')))
   FROM (SELECT r.id, r.status, public.economic_queue_key(r.id) AS key FROM r) k))
 INTO v_out;
 RETURN v_out;
END $$;REVOKE ALL ON FUNCTION public.service_cost_indicators(date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.service_cost_indicators(date,date) TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
