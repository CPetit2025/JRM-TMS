-- dispatch_documents_missing: storage.objects.name se compara con COLLATE "C" para usar el índice (bucket_id, name COLLATE "C");
-- sin eso se filtraba todo el bucket por cada documento. La igualdad es la misma. CREATE OR REPLACE conserva GRANT.
CREATE OR REPLACE FUNCTION public.dispatch_documents_missing(p_dispatch_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s record; v_general boolean; v_packing text; v_notes text;
BEGIN
 SELECT EXISTS(SELECT 1 FROM public.dispatch_documents x WHERE x.dispatch_id=p_dispatch_id AND x.transport_request_id IS NULL
   AND x.doc_type='PACKING_LIST' AND x.voided_at IS NULL AND x.auditor_signature_confirmed
   AND NULLIF(trim(x.auditor_name),'') IS NOT NULL AND x.auditor_signed_date IS NOT NULL
   AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='dispatch_documents' AND o.name COLLATE "C"=x.file_path)) INTO v_general;
 FOR s IN SELECT r.transport_request_id,COALESCE(t.request_number,r.transport_request_id::text) AS number
   FROM public.dispatch_requests r LEFT JOIN public.transport_requests t ON t.id=r.transport_request_id
   WHERE r.dispatch_id=p_dispatch_id ORDER BY r.sequence_order NULLS LAST,t.request_number LOOP
   IF NOT v_general AND NOT EXISTS(SELECT 1 FROM public.dispatch_documents x WHERE x.dispatch_id=p_dispatch_id AND x.transport_request_id=s.transport_request_id
     AND x.doc_type='PACKING_LIST' AND x.voided_at IS NULL AND x.auditor_signature_confirmed
     AND NULLIF(trim(x.auditor_name),'') IS NOT NULL AND x.auditor_signed_date IS NOT NULL
     AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='dispatch_documents' AND o.name COLLATE "C"=x.file_path)) THEN
     v_packing:=concat_ws(', ',v_packing,s.number);
   END IF;
   IF NOT public.delivery_required(p_dispatch_id,s.transport_request_id) AND NOT EXISTS(SELECT 1 FROM public.dispatch_document_references refs WHERE refs.dispatch_id=p_dispatch_id AND refs.request_id=s.transport_request_id AND refs.doc_type='NOTA_DESPACHO') AND NOT EXISTS(
     SELECT 1 FROM public.dispatch_documents x WHERE x.dispatch_id=p_dispatch_id AND x.transport_request_id=s.transport_request_id
       AND x.doc_type='NOTA_DESPACHO' AND x.voided_at IS NULL
       AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='dispatch_documents' AND o.name COLLATE "C"=x.file_path)) THEN
     v_notes:=concat_ws(', ',v_notes,s.number);
   END IF;
 END LOOP;
 RETURN NULLIF(concat_ws('; ',CASE WHEN v_packing IS NOT NULL THEN 'Packing List firmado por el auditor: '||v_packing END,
   CASE WHEN v_notes IS NOT NULL THEN 'Nota de Despacho: '||v_notes END),'');
END $function$;
