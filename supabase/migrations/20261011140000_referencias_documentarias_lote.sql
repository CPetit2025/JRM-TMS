-- Torre de Control: números de GR y Nota vinculados por Documentos para varios despachos en una sola consulta.
-- Misma autorización que get_dispatch_document_references, aplicada por despacho: los no autorizados se omiten.
BEGIN;
CREATE FUNCTION public.get_dispatch_document_references_batch(p_dispatches uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND is_active) THEN
  RAISE EXCEPTION 'Sin acceso a los números documentarios';
 END IF;
 IF COALESCE(cardinality(p_dispatches),0)>500 THEN RAISE EXCEPTION 'Consulte hasta 500 despachos a la vez'; END IF;
 RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('dispatch_id',r.dispatch_id,'request_id',r.request_id,'doc_type',r.doc_type,
   'document_number',r.document_number) ORDER BY r.dispatch_id,r.created_at,r.id)
  FROM public.dispatch_document_references r JOIN public.dispatches d ON d.id=r.dispatch_id
  WHERE r.dispatch_id=ANY(p_dispatches) AND (public.delivery_can_read(d.id) OR (public.can_access_site(d.site_id) AND (
   public.has_tms_read_permission('documentario') OR public.has_tms_read_permission('packing-list') OR public.has_tms_read_permission('planificacion'))))),'[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.get_dispatch_document_references_batch(uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_dispatch_document_references_batch(uuid[]) TO authenticated,service_role;
COMMIT;
NOTIFY pgrst,'reload schema';
