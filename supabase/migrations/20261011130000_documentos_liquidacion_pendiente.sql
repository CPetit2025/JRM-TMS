-- Documentos de Despacho · «Liquidación pendiente»: la base devuelve solo las rutas con cierre operativo y
-- documentación incompleta (guía sin validar o recojo del cliente sin Nota de Despacho). La fecha efectiva usa
-- created_at cuando no hay salida programada. Misma proyección y autorización que la bandeja por período.
BEGIN;
DO $migration$
DECLARE source text; definition text;
 anchor constant text:='(p_include_departed AND d.scheduled_departure >= p_from AND d.scheduled_departure <= p_until)';
BEGIN
 source:=pg_get_functiondef('public.get_documentary_queue_period(boolean,timestamptz,timestamptz)'::regprocedure);
 IF position(anchor IN source)=0 OR position('can_access_site' IN source)=0 OR position('number_references' IN source)=0 THEN
  RAISE EXCEPTION 'Bandeja documentaria por período no reconocida: revisar antes de migrar';
 END IF;
 definition:=replace(source,'FUNCTION public.get_documentary_queue_period(','FUNCTION public.get_documentary_pending_settlement(');
 definition:=replace(definition,anchor,$pending$(p_include_departed
  AND COALESCE(d.scheduled_departure, d.created_at) >= p_from AND COALESCE(d.scheduled_departure, d.created_at) <= p_until
  AND d.status IN ('CIERRE_OPERATIVO','RETORNO_COMPLETADO','ENTREGADO')
  AND EXISTS (SELECT 1 FROM public.dispatch_requests pdr
   LEFT JOIN public.delivery_conformities pc ON pc.dispatch_id = pdr.dispatch_id AND pc.request_id = pdr.transport_request_id
   WHERE pdr.dispatch_id = d.id AND CASE WHEN public.delivery_required(pdr.dispatch_id, pdr.transport_request_id)
    THEN pc.state IS DISTINCT FROM 'VALIDADA'
    ELSE NOT EXISTS (SELECT 1 FROM public.dispatch_documents pn WHERE pn.dispatch_id = d.id AND pn.transport_request_id = pdr.transport_request_id
           AND pn.doc_type = 'NOTA_DESPACHO' AND pn.voided_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM public.dispatch_document_references pr WHERE pr.dispatch_id = d.id AND pr.request_id = pdr.transport_request_id
           AND pr.doc_type = 'NOTA_DESPACHO') END))$pending$);
 IF position('get_documentary_pending_settlement' IN definition)=0 OR position(anchor IN definition)>0 THEN
  RAISE EXCEPTION 'No se pudo derivar la bandeja de liquidación pendiente';
 END IF;
 EXECUTE definition;
END $migration$;
REVOKE ALL ON FUNCTION public.get_documentary_pending_settlement(boolean,timestamptz,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_documentary_pending_settlement(boolean,timestamptz,timestamptz) TO authenticated,service_role;
COMMENT ON FUNCTION public.get_documentary_pending_settlement(boolean,timestamptz,timestamptz) IS 'Liquidación documentaria pendiente: rutas con cierre operativo y guías sin validar o recojos sin Nota; fecha efectiva con created_at.';
COMMIT;
NOTIFY pgrst,'reload schema';
