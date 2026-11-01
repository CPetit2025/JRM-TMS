-- Control presupuestal · reparto por peso completo (D3). Reescrita de 20261126090000 con la misma firma.
-- Peso de cada solicitud de la ruta, en este orden: 1) guías de remisión de la solicitud cruzadas con las salidas del
-- ERP (APT), 2) peso por componente (OT/subcontrato) de la solicitud, 3) peso declarado. Si alguna solicitud queda sin
-- peso, partes iguales. Las solicitudes sin OT reciben su parte, que no se imputa.
BEGIN;
SET LOCAL lock_timeout='60s';

CREATE OR REPLACE FUNCTION public.budget_route_shares(p_dispatch_id uuid)
RETURNS TABLE(request_id uuid, contract_id uuid, share numeric, basis text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_erp boolean := to_regclass('public.dispatch_documents') IS NOT NULL AND to_regclass('public.apt_movements') IS NOT NULL
  AND to_regprocedure('public.apt_guia_key(text)') IS NOT NULL; v_guides jsonb := '{}'::jsonb;
BEGIN
 -- Dinámico: sin las tablas del ERP la función no se resuelve y el reparto sigue con componentes y declarado
 IF v_erp THEN
  EXECUTE $q$SELECT COALESCE(jsonb_object_agg(rid, kg), '{}'::jsonb) FROM (
    SELECT to_jsonb(dd)->>'transport_request_id' AS rid, NULLIF(sum(m.peso_kg), 0) AS kg FROM public.dispatch_documents dd
    JOIN public.apt_movements m ON m.active AND m.valid AND m.kind = 'SALIDA' AND public.apt_guia_key(m.documento) = public.apt_guia_key(dd.document_number)
    WHERE dd.dispatch_id = $1 AND dd.voided_at IS NULL AND dd.doc_type = 'GUIA_REMISION' GROUP BY 1) x WHERE rid IS NOT NULL$q$
  INTO v_guides USING p_dispatch_id;
 END IF;
 RETURN QUERY
 WITH r AS (
  SELECT t.id, t.contract_id,
   COALESCE(
    NULLIF((v_guides->>t.id::text)::numeric, 0),
    (SELECT NULLIF(sum(c.requested_weight_kg), 0) FROM public.transport_request_components c WHERE c.request_id = t.id),
    NULLIF(NULLIF(to_jsonb(t)->>'estimated_weight', '')::numeric, 0)) AS kg
  FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id WHERE dr.dispatch_id = p_dispatch_id),
 m AS (SELECT count(*) AS n, bool_and(COALESCE(kg, 0) > 0) AS weighted, sum(kg) AS total FROM r)
 SELECT r.id, r.contract_id, CASE WHEN m.weighted THEN r.kg / m.total ELSE 1.0 / m.n END, CASE WHEN m.weighted THEN 'PESO' ELSE 'IGUAL' END
 FROM r, m;
END $$;
REVOKE ALL ON FUNCTION public.budget_route_shares(uuid) FROM PUBLIC,anon,authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
