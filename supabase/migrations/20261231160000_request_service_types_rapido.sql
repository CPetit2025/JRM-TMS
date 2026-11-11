-- request_service_types evaluaba los permisos (is_tms_admin, has_tms_read_permission x6, can_access_site) por fila.
-- Ahora se evalúan una vez por llamada y can_access_site una vez por sede distinta (MATERIALIZED). Mismo resultado.
-- CREATE OR REPLACE conserva los GRANT existentes (no se otorga a anon).
CREATE OR REPLACE FUNCTION public.request_service_types(p_requests uuid[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH me AS MATERIALIZED (
    SELECT auth.uid() IS NOT NULL AND cardinality(p_requests) <= 1000 AS ok,
           public.is_tms_admin() AS adm,
           (public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('torre-control')
            OR public.has_tms_read_permission('monitoreo') OR public.has_tms_read_permission('documentario')
            OR public.has_tms_read_permission('packing-list') OR public.has_tms_read_permission('planificacion')
            OR public.can_view_driver_evidence()) AS perm
  ), links AS MATERIALIZED (
    SELECT DISTINCT r.transport_request_id AS id, d.site_id
      FROM me, public.dispatch_requests r JOIN public.dispatches d ON d.id = r.dispatch_id
     WHERE me.ok AND NOT me.adm AND me.perm AND r.transport_request_id = ANY(p_requests)
  ), sites AS MATERIALIZED (
    SELECT site_id FROM (SELECT DISTINCT site_id FROM links) x WHERE public.can_access_site(site_id)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', t.id, 'request_type', t.request_type,
           'attention_mode', to_jsonb(t)->>'attention_mode', 'contract_id', t.contract_id,
           'supplier_name', s.business_name, 'reference_type', t.reference_type, 'reference_number', t.reference_number,
           'purchase_order', t.purchase_order)), '[]'::jsonb)
    FROM me, public.transport_requests t
    LEFT JOIN public.suppliers s ON s.id = t.supplier_id
   WHERE me.ok AND t.id = ANY(p_requests)
     AND (me.adm OR EXISTS (SELECT 1 FROM links l JOIN sites x ON x.site_id IS NOT DISTINCT FROM l.site_id WHERE l.id = t.id))
$function$;
