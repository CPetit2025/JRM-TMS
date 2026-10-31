-- Detalle del despacho · Documentos y Fotos y evidencias de una parada (despacho × solicitud). Solo lectura.
-- Documentos vigentes de la parada y de la ruta (solo si se pueden ver los documentos del despacho), números
-- vinculados, estado del cierre documentario (sin sincronizar ni cerrar nada), envíos de guía con su revisión y el
-- rechazo en destino. Cada fuente en su bloque: si producción no la tiene, se informa en sources_failed.
BEGIN;

CREATE OR REPLACE FUNCTION public.dispatch_detail_files_payload(p_dispatch uuid, p_request uuid, p_documents boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE failed text[] := '{}'; v_docs jsonb := '[]'; v_refs jsonb := '[]'; v_closure jsonb; v_subs jsonb := '[]'; v_rej jsonb; v_arrival jsonb;
BEGIN
 IF p_documents THEN
  BEGIN
   SELECT COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'doc_type',x.doc_type,'category',to_jsonb(x)->>'category','number',x.document_number,
     'file_path',x.file_path,'file_name',x.file_name,'mime_type',x.mime_type,'size_bytes',x.size_bytes,'uploaded_at',x.uploaded_at,
     'uploaded_by',public.dispatch_detail_actor(x.uploaded_by),'scope',CASE WHEN x.transport_request_id IS NULL THEN 'RUTA' ELSE 'SERVICIO' END)
     ORDER BY x.uploaded_at DESC), '[]') INTO v_docs
   FROM public.dispatch_documents x
   WHERE x.dispatch_id=p_dispatch AND x.voided_at IS NULL AND (x.transport_request_id IS NULL OR x.transport_request_id=p_request);
  EXCEPTION WHEN undefined_table OR undefined_column THEN failed := array_append(failed, 'dispatch_documents');
  END;
 END IF;
 BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('doc_type',r.doc_type,'number',r.document_number,'at',r.created_at,'by',public.dispatch_detail_actor(r.created_by))
    ORDER BY r.created_at), '[]') INTO v_refs
  FROM public.dispatch_document_references r WHERE r.dispatch_id=p_dispatch AND r.request_id=p_request;
 EXCEPTION WHEN undefined_table OR undefined_column THEN failed := array_append(failed, 'dispatch_document_references');
 END;
 BEGIN
  SELECT jsonb_build_object('status',c.status,'source',c.source,'missing',c.missing,'completed_at',c.completed_at,
    'completed_by',public.dispatch_detail_actor(c.completed_by),'reopened_at',c.reopened_at,'updated_at',c.updated_at) INTO v_closure
  FROM public.documentary_closures c WHERE c.dispatch_id=p_dispatch AND c.request_id=p_request;
 EXCEPTION WHEN undefined_table OR undefined_column THEN failed := array_append(failed, 'documentary_closures');
 END;
 BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',s.id,'photos',to_jsonb(s.photos),
    'packing_photos',COALESCE(to_jsonb(s)->'packing_photos','[]'::jsonb),'guide_number',s.guide_number,'received_by',s.received_by,
    'source',s.source,'captured_at',s.captured_at,'submitted_at',s.submitted_at,'submitted_by',public.dispatch_detail_actor(s.submitted_by),
    'review',(SELECT jsonb_build_object('decision',r.decision,'reason',r.reason,'at',r.reviewed_at,'by',public.dispatch_detail_actor(r.reviewed_by))
      FROM public.delivery_reviews r WHERE r.submission_id=s.id))
    ORDER BY s.submitted_at DESC), '[]') INTO v_subs
  FROM public.delivery_submissions s WHERE s.dispatch_id=p_dispatch AND s.request_id=p_request;
  SELECT jsonb_build_object('at',c.arrived_at,'lat',to_jsonb(c)->'arrival_lat','lon',to_jsonb(c)->'arrival_lon') INTO v_arrival
  FROM public.delivery_conformities c WHERE c.dispatch_id=p_dispatch AND c.request_id=p_request AND c.arrived_at IS NOT NULL;
 EXCEPTION WHEN undefined_table OR undefined_column THEN failed := array_append(failed, 'delivery_submissions');
 END;
 BEGIN
  SELECT jsonb_build_object('kind',r.kind,'reason_code',r.reason_code,'note',r.note,'photos',to_jsonb(r.photos),'captured_at',r.captured_at,
    'lat',to_jsonb(r)->'latitude','lon',to_jsonb(r)->'longitude','decision',r.decision) INTO v_rej
  FROM public.delivery_rejections r WHERE r.dispatch_id=p_dispatch AND r.request_id=p_request;
 EXCEPTION WHEN undefined_table OR undefined_column THEN failed := array_append(failed, 'delivery_rejections');
 END;
 RETURN jsonb_build_object('can_view_documents',p_documents,'documents',v_docs,'references',v_refs,'documentary',v_closure,
  'submissions',v_subs,'arrival',v_arrival,'rejection',v_rej,'sources_failed',to_jsonb(failed));
END $$;
REVOKE ALL ON FUNCTION public.dispatch_detail_files_payload(uuid,uuid,boolean) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_dispatch_detail_files(p_dispatch uuid, p_request uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_dispatch IS NULL OR NOT public.delivery_can_read(p_dispatch) THEN RAISE EXCEPTION 'Sin permiso para ver este despacho'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.dispatch_requests r WHERE r.dispatch_id=p_dispatch AND r.transport_request_id=p_request) THEN
  RAISE EXCEPTION 'La solicitud no pertenece a este despacho';
 END IF;
 RETURN public.dispatch_detail_files_payload(p_dispatch, p_request, public.can_view_dispatch_documents(p_dispatch));
END $$;
REVOKE ALL ON FUNCTION public.get_dispatch_detail_files(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dispatch_detail_files(uuid,uuid) TO authenticated;

COMMIT;
