-- Etapa E · Referencial protegido: el flete referencial de una solicitud (transport_requests.service_cost) puede cambiar
-- después de aprobada, por ejemplo al autorizar el flete del tercero en un recojo con OC/OS/RQ. El valor original se
-- conserva en transport_request_referentials (primera modificación posterior a la aprobación) y los reportes lo leen con
-- request_referential_freight(). No se actualiza transport_requests: sus guardas BEFORE UPDATE revalidan filas históricas.
BEGIN;
SET LOCAL lock_timeout='60s';

CREATE TABLE IF NOT EXISTS public.transport_request_referentials (
  request_id    uuid PRIMARY KEY REFERENCES public.transport_requests(id) ON DELETE CASCADE,
  service_cost  numeric(15,2) NOT NULL CHECK (service_cost >= 0),
  replaced_by   numeric(15,2),
  source        text,
  captured_at   timestamptz NOT NULL DEFAULT now(),
  captured_by   uuid
);
ALTER TABLE public.transport_request_referentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.transport_request_referentials;
CREATE POLICY security_active_account ON public.transport_request_referentials AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.transport_request_referentials FROM PUBLIC, anon, authenticated;

-- Recojos ya autorizados: el referencial anterior quedó en transport_request_events (primera cotización del tercero)
INSERT INTO public.transport_request_referentials(request_id, service_cost, replaced_by, source, captured_at, captured_by)
SELECT DISTINCT ON (e.request_id) e.request_id, (e.previous_state->>'service_cost')::numeric, (e.next_state->>'service_cost')::numeric,
  'COTIZACION_TERCERO', e.created_at, e.actor_id
FROM public.transport_request_events e
WHERE e.next_state->>'source' = 'COTIZACION_TERCERO' AND (e.previous_state->>'service_cost') ~ '^[0-9]+([.][0-9]+)?$'
ORDER BY e.request_id, e.created_at
ON CONFLICT (request_id) DO NOTHING;

-- Primera modificación del flete después de aprobar la solicitud: se guarda el valor original (no se pisa después)
CREATE OR REPLACE FUNCTION public.transport_request_referential_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 INSERT INTO public.transport_request_referentials(request_id, service_cost, replaced_by, source, captured_by)
 VALUES (NEW.id, COALESCE(OLD.service_cost, 0), NEW.service_cost, COALESCE(NEW.cost_breakdown->>'source', NEW.cost_source), auth.uid())
 ON CONFLICT (request_id) DO NOTHING;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.transport_request_referential_capture() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS transport_request_referential_capture ON public.transport_requests;
CREATE TRIGGER transport_request_referential_capture AFTER UPDATE OF service_cost ON public.transport_requests
 FOR EACH ROW WHEN (OLD.approved_at IS NOT NULL AND NEW.service_cost IS DISTINCT FROM OLD.service_cost)
 EXECUTE FUNCTION public.transport_request_referential_capture();

-- Flete referencial de una solicitud: el original si se modificó tras aprobarla; si no, el vigente
CREATE OR REPLACE FUNCTION public.request_referential_freight(p_request_id uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT COALESCE((SELECT r.service_cost FROM public.transport_request_referentials r WHERE r.request_id = p_request_id),
  (SELECT COALESCE(t.service_cost, 0) FROM public.transport_requests t WHERE t.id = p_request_id), 0)
$$;
REVOKE ALL ON FUNCTION public.request_referential_freight(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.request_referential_freight(uuid) TO authenticated;

-- Lectores del referencial (mismas funciones de 20261108100000 y 20261110090000, con el referencial protegido)
CREATE OR REPLACE FUNCTION public.dispatch_freight_summary(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; s record; v_name text;
BEGIN
 IF NOT (public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('torre-control')
   OR public.has_tms_read_permission('documentario') OR public.has_tms_read_permission('contratos-servicios')) THEN
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
    AND (public.has_tms_permission('despacho') OR public.has_tms_permission('contratos-servicios')),
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
