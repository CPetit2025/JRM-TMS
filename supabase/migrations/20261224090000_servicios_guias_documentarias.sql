-- Exponer en el registro de servicios los mismos números de guía visibles en Torre de Control.
-- Las guías siguen siendo propiedad del despacho/parada; no se copian a contract_services.referral_guide.
BEGIN;

CREATE OR REPLACE FUNCTION public.get_service_registry_context(p_services uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT (public.has_tms_read_permission('contratos-servicios') OR public.has_tms_read_permission('clientes')) THEN
  RAISE EXCEPTION 'Sin permiso para consultar servicios';
 END IF;
 IF cardinality(p_services)>200 THEN RAISE EXCEPTION 'Consulte hasta 200 servicios por bloque'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object(
   'service_id',s.id,
   'dispatch_number',d.dispatch_number,
   'request_numbers',COALESCE((SELECT jsonb_agg(t.request_number ORDER BY dr.sequence_order)
     FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id=dr.transport_request_id
     WHERE dr.dispatch_id=d.id AND (f.request_id IS NULL OR t.id=f.request_id)
       AND public.can_access_site(t.site_id) AND (NOT public.is_contract_administrator() OR public.has_assigned_contract(t.contract_id,true))), '[]'::jsonb),
   'guide_numbers',COALESCE((SELECT jsonb_agg(g.document_number ORDER BY g.document_number)
     FROM (
       SELECT DISTINCT btrim(dd.document_number) AS document_number
       FROM public.dispatch_documents dd
       JOIN public.dispatch_requests dr ON dr.dispatch_id=dd.dispatch_id
         AND dr.transport_request_id=dd.transport_request_id
       JOIN public.transport_requests t ON t.id=dr.transport_request_id
       WHERE dd.dispatch_id=d.id AND dd.doc_type='GUIA_REMISION' AND dd.voided_at IS NULL
         AND dd.transport_request_id IS NOT NULL AND NULLIF(btrim(dd.document_number),'') IS NOT NULL
         AND (f.request_id IS NULL OR t.id=f.request_id)
         AND (f.request_id IS NOT NULL OR t.contract_id=s.contract_id)
         AND public.can_access_site(t.site_id)
         AND (NOT public.is_contract_administrator() OR public.has_assigned_contract(t.contract_id,true))
       UNION
       SELECT DISTINCT btrim(ref.document_number) AS document_number
       FROM public.dispatch_document_references ref
       JOIN public.dispatch_requests dr ON dr.dispatch_id=ref.dispatch_id AND dr.transport_request_id=ref.request_id
       JOIN public.transport_requests t ON t.id=dr.transport_request_id
       WHERE ref.dispatch_id=d.id AND ref.doc_type='GUIA_REMISION'
         AND (f.request_id IS NULL OR t.id=f.request_id)
         AND (f.request_id IS NOT NULL OR t.contract_id=s.contract_id)
         AND public.can_access_site(t.site_id)
         AND (NOT public.is_contract_administrator() OR public.has_assigned_contract(t.contract_id,true))
     ) g), '[]'::jsonb),
   'operation_state',d.status,
   'stage',CASE WHEN s.status='ANULADO' OR d.status='CANCELADO' OR f.status='LIBERADO' THEN 'ANULADO'
     WHEN d.id IS NULL THEN 'REGISTRO_MANUAL'
     WHEN d.status IN ('LIQUIDADO','CERRADO') AND NOT EXISTS(SELECT 1 FROM public.dispatch_requests dr
       LEFT JOIN public.delivery_conformities dc ON dc.dispatch_id=dr.dispatch_id AND dc.request_id=dr.transport_request_id
       WHERE dr.dispatch_id=d.id AND (f.request_id IS NULL OR dr.transport_request_id=f.request_id)
       AND (dr.status IS DISTINCT FROM 'ENTREGADO' OR (public.delivery_required(dr.dispatch_id,dr.transport_request_id) AND dc.state IS DISTINCT FROM 'VALIDADA')))
       AND EXISTS(SELECT 1 FROM public.dispatch_requests dr WHERE dr.dispatch_id=d.id) THEN 'REALIZADO'
     ELSE 'COMPROMETIDO' END)), '[]'::jsonb) INTO result
 FROM public.contract_services s JOIN public.contracts c ON c.id=s.contract_id
 LEFT JOIN public.dispatches d ON d.id=s.dispatch_id
 LEFT JOIN public.dispatch_request_freight f ON f.service_id=s.id
 WHERE s.id=ANY(p_services) AND public.can_access_site(c.site_id)
   AND (NOT public.is_contract_administrator() OR public.has_assigned_contract(s.contract_id,true))
   AND (d.id IS NULL OR public.can_access_site(d.site_id));
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.get_service_registry_context(uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_service_registry_context(uuid[]) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
