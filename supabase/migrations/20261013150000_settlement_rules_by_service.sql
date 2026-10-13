-- Liquidación documentaria por tipo de servicio (una sola regla para la bandeja y la pantalla):
--   Entrega (con o sin OT):  Guía de Remisión validada o Nota de Despacho  +  Packing List      (obligatorios)
--   Recojo hacia planta:     Guía de Remisión validada (obligatoria); OC / OS / RQ opcionales
--   Punto a punto:           todo opcional (GR, Nota, Packing List, OC / OS / RQ)
--   Recojo por el cliente:   Nota de Despacho (obligatoria)
-- La liquidación es automática: el servicio sale de «Liquidación pendiente» en cuanto tiene sus obligatorios.
-- La GR cuenta cuando el Supervisor de Transporte la valida (conformidad), como hasta ahora.
CREATE OR REPLACE FUNCTION public.settlement_checklist(p_dispatch uuid,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t jsonb; v_kind text; v_gr text; v_nd boolean; v_pl boolean; v_refs text[]; v_missing text[]:='{}';
BEGIN
 SELECT to_jsonb(r) INTO t FROM public.transport_requests r WHERE r.id=p_request;
 v_kind:=CASE WHEN t->>'attention_mode'='RECOJO_CLIENTE' OR NOT public.delivery_required(p_dispatch,p_request) THEN 'RECOJO_CLIENTE'
   WHEN t->>'request_type'='RECOJO' THEN 'RECOJO' WHEN t->>'request_type'='TRASLADO' THEN 'TRASLADO' ELSE 'ENTREGA' END;
 SELECT c.state INTO v_gr FROM public.delivery_conformities c WHERE c.dispatch_id=p_dispatch AND c.request_id=p_request;
 v_nd:=EXISTS(SELECT 1 FROM public.dispatch_documents n WHERE n.dispatch_id=p_dispatch AND n.transport_request_id=p_request AND n.doc_type='NOTA_DESPACHO' AND n.voided_at IS NULL)
   OR EXISTS(SELECT 1 FROM public.dispatch_document_references n WHERE n.dispatch_id=p_dispatch AND n.request_id=p_request AND n.doc_type='NOTA_DESPACHO');
 v_pl:=EXISTS(SELECT 1 FROM public.dispatch_documents p WHERE p.dispatch_id=p_dispatch AND p.doc_type='PACKING_LIST' AND p.voided_at IS NULL
     AND (p.transport_request_id=p_request OR p.transport_request_id IS NULL))
   OR EXISTS(SELECT 1 FROM public.delivery_submissions s WHERE s.dispatch_id=p_dispatch AND s.request_id=p_request
     AND jsonb_typeof(to_jsonb(s)->'packing_photos')='array' AND jsonb_array_length(to_jsonb(s)->'packing_photos')>0);
 SELECT COALESCE(array_agg(DISTINCT x.document_number ORDER BY x.document_number),'{}') INTO v_refs FROM public.dispatch_documents x
  WHERE x.dispatch_id=p_dispatch AND x.transport_request_id=p_request AND x.doc_type='OTRO' AND x.voided_at IS NULL AND x.document_number ~ '^(OC|OS|RQ) ';
 IF v_kind='ENTREGA' THEN
  IF NOT (v_nd OR COALESCE(v_gr,'') IN ('VALIDADA','HISTORICA')) THEN v_missing:=array_append(v_missing,'GUIA_O_NOTA'); END IF;
  IF NOT v_pl THEN v_missing:=array_append(v_missing,'PACKING_LIST'); END IF;
 ELSIF v_kind='RECOJO' THEN
  IF v_gr IS DISTINCT FROM 'VALIDADA' AND v_gr IS DISTINCT FROM 'HISTORICA' THEN v_missing:=array_append(v_missing,'GUIA_REMISION'); END IF;
 ELSIF v_kind='RECOJO_CLIENTE' THEN
  IF NOT v_nd THEN v_missing:=array_append(v_missing,'NOTA_DESPACHO'); END IF;
 END IF;
 RETURN jsonb_build_object('kind',v_kind,'complete',cardinality(v_missing)=0,'missing',to_jsonb(v_missing),
  'guide_state',COALESCE(v_gr,'PENDIENTE'),'note',v_nd,'packing',v_pl,'references',to_jsonb(v_refs));
END $$;
REVOKE ALL ON FUNCTION public.settlement_checklist(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.settlement_checklist(uuid,uuid) TO service_role;

-- Lista de verificación por servicio para la pantalla (misma autorización que la bandeja documentaria).
CREATE OR REPLACE FUNCTION public.get_settlement_checklists(p_dispatches uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_active_tms_user() OR NOT (public.has_tms_permission('documentario') OR public.has_tms_permission('despacho')) THEN
  RAISE EXCEPTION 'Sin permiso para ver la liquidación documentaria'; END IF;
 IF COALESCE(cardinality(p_dispatches),0)>200 THEN RAISE EXCEPTION 'Consulte hasta 200 despachos por vez'; END IF;
 RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('dispatch_id',dr.dispatch_id,'request_id',dr.transport_request_id)
   ||public.settlement_checklist(dr.dispatch_id,dr.transport_request_id))
  FROM public.dispatch_requests dr JOIN public.dispatches d ON d.id=dr.dispatch_id
  WHERE dr.dispatch_id=ANY(p_dispatches) AND public.can_access_site(d.site_id)),'[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.get_settlement_checklists(uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_settlement_checklists(uuid[]) TO authenticated;

-- La bandeja «Liquidación pendiente» usa la misma regla.
DO $migration$
DECLARE source text; changed text;
BEGIN
 source:=pg_get_functiondef('public.get_documentary_pending_settlement(boolean,timestamptz,timestamptz)'::regprocedure);
 changed:=regexp_replace(source,'AND EXISTS \(SELECT 1 FROM public\.dispatch_requests pdr.*?pr\.doc_type = ''NOTA_DESPACHO''\) END\)\)',
  'AND EXISTS (SELECT 1 FROM public.dispatch_requests pdr WHERE pdr.dispatch_id = d.id
   AND NOT (public.settlement_checklist(pdr.dispatch_id, pdr.transport_request_id)->>''complete'')::boolean))');
 IF changed=source THEN RAISE EXCEPTION 'Bandeja de liquidación pendiente no reconocida'; END IF;
 EXECUTE changed;
END $migration$;

-- Carga en liquidación según el tipo de servicio: GR (no en recojo del cliente), Nota de Despacho (entrega, punto a
-- punto o recojo del cliente), Packing List y referencias OC / OS / RQ (número + archivo).
CREATE OR REPLACE FUNCTION public.settlement_upload_document(p_dispatch uuid,p_request uuid,p_kind text,p_number text,
  p_files text[],p_file_names text[] DEFAULT NULL,p_operation uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d jsonb; v_kind text:=upper(trim(COALESCE(p_kind,''))); v_number text:=NULLIF(upper(regexp_replace(trim(COALESCE(p_number,'')),'\s+','','g')),'');
  v_service text; f text; i int:=0; result jsonb; o record; v_doc jsonb; v_cols text; v_doc_type text; v_doc_number text;
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
 v_service:=public.settlement_checklist(p_dispatch,p_request)->>'kind';

 IF v_kind='GUIA' THEN
  IF v_service='RECOJO_CLIENTE' THEN RAISE EXCEPTION 'Este servicio es recojo por el cliente: corresponde Nota de Despacho'; END IF;
  IF v_number IS NULL OR v_number !~ '^[A-Z0-9]{3,4}-[0-9]{1,10}$' THEN
   RAISE EXCEPTION 'Ingrese la guía con serie y correlativo, por ejemplo T001-6591 (sin espacios ni ceros omitidos)'; END IF;
  IF EXISTS(SELECT 1 FROM public.dispatch_documents WHERE doc_type='GUIA_REMISION' AND voided_at IS NULL AND upper(document_number)=v_number)
   OR EXISTS(SELECT 1 FROM public.dispatch_document_references WHERE doc_type='GUIA_REMISION' AND document_number=v_number
     AND (dispatch_id,request_id) IS DISTINCT FROM (p_dispatch,p_request)) THEN
   RAISE EXCEPTION 'La guía % ya está registrada en otro servicio',v_number; END IF;
  -- Mismo circuito que el app: la guía queda RECIBIDA y la valida el Supervisor de Transporte.
  result:=public.delivery_submit_core(p_dispatch,p_request,p_files,'Según guía firmada (Documentos)','Cargada por Documentos en liquidación pendiente','WEB',v_number,p_operation,now());
  INSERT INTO public.dispatch_document_references(dispatch_id,request_id,doc_type,document_number,created_by)
  SELECT p_dispatch,p_request,'GUIA_REMISION',v_number,auth.uid()
  WHERE NOT EXISTS(SELECT 1 FROM public.dispatch_document_references WHERE dispatch_id=p_dispatch AND request_id=p_request AND doc_type='GUIA_REMISION' AND document_number=v_number);
  RETURN result||jsonb_build_object('number',v_number);
 END IF;

 IF v_kind='NOTA' THEN
  IF v_service='RECOJO' THEN RAISE EXCEPTION 'El recojo hacia planta se liquida con Guía de Remisión'; END IF;
  IF v_number IS NULL OR v_number !~ '^[A-Z0-9]{1,8}-[0-9]{1,10}$' THEN
   RAISE EXCEPTION 'Ingrese la Nota de Despacho con serie y correlativo, por ejemplo ND01-1234'; END IF;
  v_doc_type:='NOTA_DESPACHO'; v_doc_number:=v_number;
 ELSIF v_kind IN ('OC','OS','RQ') THEN
  IF v_number IS NULL OR v_number !~ '^[A-Z0-9][A-Z0-9/-]{0,29}$' THEN RAISE EXCEPTION 'Ingrese el número de la % (letras, números, guion o barra)',v_kind; END IF;
  v_doc_type:='OTRO'; v_doc_number:=v_kind||' '||v_number;
 ELSIF v_kind='PACKING' THEN
  v_doc_type:='PACKING_LIST';
 ELSE RAISE EXCEPTION 'Tipo de documento inválido'; END IF;

 FOREACH f IN ARRAY p_files LOOP
  i:=i+1;
  SELECT o2.name,o2.metadata INTO o FROM storage.objects o2 WHERE o2.bucket_id='dispatch_documents' AND o2.name=f;
  IF o.name IS NULL OR public.dispatch_document_folder(f) IS DISTINCT FROM p_dispatch THEN RAISE EXCEPTION 'Archivo no válido para este despacho'; END IF;
  IF EXISTS(SELECT 1 FROM public.dispatch_documents x WHERE to_jsonb(x)->>'file_path'=f) THEN CONTINUE; END IF;  -- reintento: no duplica
  -- Producción no coincide con el repo: se escriben solo las columnas existentes.
  v_doc:=jsonb_strip_nulls(jsonb_build_object('dispatch_id',p_dispatch,'transport_request_id',p_request,'doc_type',v_doc_type,
   'document_number',v_doc_number,'file_path',f,'file_name',left(COALESCE(p_file_names[i],split_part(f,'/',-1)),200),
   'mime_type',o.metadata->>'mimetype','size_bytes',NULLIF(o.metadata->>'size','')::bigint,'notes','Cargado en liquidación pendiente','uploaded_by',auth.uid()));
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
 VALUES(p_dispatch,'DOCUMENTO_LIQUIDACION',CASE v_kind WHEN 'NOTA' THEN 'Nota de Despacho '||v_number WHEN 'PACKING' THEN 'Packing List' ELSE v_doc_number END||' cargado en liquidación pendiente',auth.uid()::text);
 RETURN jsonb_build_object('success',true,'files',cardinality(p_files),'number',v_doc_number);
END $$;
REVOKE ALL ON FUNCTION public.settlement_upload_document(uuid,uuid,text,text,text[],text[],uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.settlement_upload_document(uuid,uuid,text,text,text[],text[],uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
