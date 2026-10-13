-- Liquidación pendiente (Documentos y conformidad): la oficina completa los documentos de un servicio cerrado.
-- 1. GR: primero el número (serie-correlativo); con el número válido se carga la guía firmada (foto o PDF). Entra al
--    mismo circuito que la del app: conformidad RECIBIDA para que el Supervisor de Transporte la valide.
-- 2. Nota de Despacho (recojo por el cliente): número + archivo; queda vinculada al servicio.
-- 3. Packing List: no tiene correlativo; se carga directamente.
-- El app del conductor y el enlace del proveedor no cambian.
UPDATE storage.buckets SET allowed_mime_types=(SELECT array_agg(DISTINCT m) FROM unnest(COALESCE(allowed_mime_types,'{}')||ARRAY['image/jpeg','image/png','image/webp','application/pdf']) m)
WHERE id='driver_evidence';

CREATE OR REPLACE FUNCTION public.settlement_upload_document(p_dispatch uuid,p_request uuid,p_kind text,p_number text,
  p_files text[],p_file_names text[] DEFAULT NULL,p_operation uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d jsonb; v_kind text:=upper(trim(COALESCE(p_kind,''))); v_number text:=NULLIF(upper(trim(COALESCE(p_number,''))),'');
  v_pickup boolean; f text; i int:=0; result jsonb; o record; v_doc jsonb; v_cols text;
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_active_tms_user() OR NOT public.has_tms_permission('documentario') THEN
  RAISE EXCEPTION 'Sin permiso para completar documentos de liquidación'; END IF;
 SELECT to_jsonb(x) INTO d FROM public.dispatches x WHERE x.id=p_dispatch FOR UPDATE;
 IF d IS NULL OR NOT public.can_access_site(NULLIF(d->>'site_id','')::uuid) THEN RAISE EXCEPTION 'Despacho inexistente o sede no autorizada'; END IF;
 IF d->>'status' NOT IN ('CIERRE_OPERATIVO','RETORNO_COMPLETADO','ENTREGADO') THEN
  RAISE EXCEPTION 'Solo se completan documentos de servicios en liquidación pendiente (estado %)',d->>'status'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.dispatch_requests WHERE dispatch_id=p_dispatch AND transport_request_id=p_request) THEN
  RAISE EXCEPTION 'La solicitud no pertenece a este despacho'; END IF;
 IF COALESCE(cardinality(p_files),0) NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'Adjunte de uno a cinco archivos'; END IF;
 v_pickup:=NOT public.delivery_required(p_dispatch,p_request);

 IF v_kind='GUIA' THEN
  IF v_pickup THEN RAISE EXCEPTION 'Este servicio es recojo por el cliente: corresponde Nota de Despacho'; END IF;
  IF v_number IS NULL OR v_number !~ '^[A-Z0-9]{3,4}-[0-9]{1,10}$' THEN
   RAISE EXCEPTION 'Ingrese la guía con serie y correlativo, por ejemplo T001-6591 (sin espacios ni ceros omitidos)'; END IF;
  IF EXISTS(SELECT 1 FROM public.dispatch_documents WHERE doc_type='GUIA_REMISION' AND voided_at IS NULL AND upper(document_number)=v_number)
   OR EXISTS(SELECT 1 FROM public.dispatch_document_references WHERE doc_type='GUIA_REMISION' AND document_number=v_number
     AND (dispatch_id,request_id) IS DISTINCT FROM (p_dispatch,p_request)) THEN
   RAISE EXCEPTION 'La guía % ya está registrada en otro servicio',v_number; END IF;
  -- Mismo circuito que el app: la guía queda RECIBIDA y la valida el Supervisor de Transporte.
  result:=public.delivery_submit_core(p_dispatch,p_request,p_files,NULL,'Cargada por Documentos en liquidación pendiente','WEB',v_number,p_operation,now());
  INSERT INTO public.dispatch_document_references(dispatch_id,request_id,doc_type,document_number,created_by)
  SELECT p_dispatch,p_request,'GUIA_REMISION',v_number,auth.uid()
  WHERE NOT EXISTS(SELECT 1 FROM public.dispatch_document_references WHERE dispatch_id=p_dispatch AND request_id=p_request AND doc_type='GUIA_REMISION' AND document_number=v_number);
  RETURN result||jsonb_build_object('number',v_number);
 END IF;

 IF v_kind NOT IN ('NOTA','PACKING') THEN RAISE EXCEPTION 'Tipo de documento inválido'; END IF;
 IF v_kind='NOTA' THEN
  IF NOT v_pickup THEN RAISE EXCEPTION 'La Nota de Despacho es solo para recojos del cliente; este servicio requiere guía de remisión'; END IF;
  IF v_number IS NULL OR v_number !~ '^[A-Z0-9]{1,8}-[0-9]{1,10}$' THEN
   RAISE EXCEPTION 'Ingrese la Nota de Despacho con serie y correlativo, por ejemplo ND01-1234'; END IF;
 END IF;
 FOREACH f IN ARRAY p_files LOOP
  i:=i+1;
  SELECT o2.name,o2.metadata INTO o FROM storage.objects o2 WHERE o2.bucket_id='dispatch_documents' AND o2.name=f;
  IF o.name IS NULL OR public.dispatch_document_folder(f) IS DISTINCT FROM p_dispatch THEN RAISE EXCEPTION 'Archivo no válido para este despacho'; END IF;
  IF EXISTS(SELECT 1 FROM public.dispatch_documents x WHERE to_jsonb(x)->>'file_path'=f) THEN CONTINUE; END IF;  -- reintento: no duplica
  -- Producción no coincide con el repo: se escriben solo las columnas existentes.
  v_doc:=jsonb_strip_nulls(jsonb_build_object('dispatch_id',p_dispatch,'transport_request_id',p_request,
   'doc_type',CASE v_kind WHEN 'NOTA' THEN 'NOTA_DESPACHO' ELSE 'PACKING_LIST' END,'document_number',CASE WHEN v_kind='NOTA' THEN v_number END,
   'file_path',f,'file_name',left(COALESCE(p_file_names[i],split_part(f,'/',-1)),200),'mime_type',o.metadata->>'mimetype',
   'size_bytes',NULLIF(o.metadata->>'size','')::bigint,'notes','Cargado en liquidación pendiente','uploaded_by',auth.uid()));
  SELECT string_agg(quote_ident(k),',') INTO v_cols FROM jsonb_object_keys(v_doc) k
   WHERE EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='dispatch_documents' AND column_name=k);
  EXECUTE format('INSERT INTO public.dispatch_documents(%s) SELECT %s FROM jsonb_populate_record(NULL::public.dispatch_documents,$1)',v_cols,v_cols) USING v_doc;
 END LOOP;
 IF v_kind='NOTA' THEN
  INSERT INTO public.dispatch_document_references(dispatch_id,request_id,doc_type,document_number,created_by)
  SELECT p_dispatch,p_request,'NOTA_DESPACHO',v_number,auth.uid()
  WHERE NOT EXISTS(SELECT 1 FROM public.dispatch_document_references WHERE dispatch_id=p_dispatch AND request_id=p_request AND doc_type='NOTA_DESPACHO' AND document_number=v_number);
 END IF;
 INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by)
 VALUES(p_dispatch,'DOCUMENTO_LIQUIDACION',CASE v_kind WHEN 'NOTA' THEN 'Nota de Despacho '||v_number ELSE 'Packing List' END||' cargado en liquidación pendiente',auth.uid()::text);
 RETURN jsonb_build_object('success',true,'files',cardinality(p_files),'number',v_number);
END $$;
REVOKE ALL ON FUNCTION public.settlement_upload_document(uuid,uuid,text,text,text[],text[],uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.settlement_upload_document(uuid,uuid,text,text,text[],text[],uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
