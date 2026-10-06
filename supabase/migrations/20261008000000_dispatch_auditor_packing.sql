-- El auditor registra el Packing List; el proveedor sustenta la recepción en destino.
BEGIN;
INSERT INTO public.roles(id,name,permissions)
SELECT gen_random_uuid(),'Auditor de Despacho','["planificacion:read","packing-list:write"]'::jsonb
WHERE NOT EXISTS(SELECT 1 FROM public.roles WHERE lower(trim(name))='auditor de despacho');
UPDATE public.roles SET permissions='["planificacion:read","packing-list:write"]'::jsonb
WHERE lower(trim(name))='auditor de despacho';

CREATE OR REPLACE FUNCTION public.can_upload_packing_list(p_dispatch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND (public.is_tms_admin() OR public.has_tms_permission('packing-list'))
   AND EXISTS(SELECT 1 FROM public.dispatches d WHERE d.id=p_dispatch AND d.status='PROGRAMADO'
     AND (d.site_id IS NULL OR public.can_access_site(d.site_id)));
$$;
REVOKE ALL ON FUNCTION public.can_upload_packing_list(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.can_upload_packing_list(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.can_read_packing_list(p_dispatch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND public.has_tms_read_permission('packing-list')
   AND EXISTS(SELECT 1 FROM public.dispatches d WHERE d.id=p_dispatch AND (d.site_id IS NULL OR public.can_access_site(d.site_id)));
$$;
CREATE OR REPLACE FUNCTION public.can_upload_dispatch_document(p_dispatch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND public.has_tms_permission('documentario')
   AND EXISTS(SELECT 1 FROM public.dispatches d WHERE d.id=p_dispatch AND (d.site_id IS NULL OR public.can_access_site(d.site_id)));
$$;
CREATE OR REPLACE FUNCTION public.packing_object_unregistered(p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT public.can_upload_packing_list(public.dispatch_document_folder(p_name))
   AND p_name LIKE public.dispatch_document_folder(p_name)::text||'/packing/'||auth.uid()::text||'/%'
   AND NOT EXISTS(SELECT 1 FROM public.dispatch_documents WHERE file_path=p_name);
$$;
REVOKE ALL ON FUNCTION public.can_read_packing_list(uuid), public.can_upload_dispatch_document(uuid), public.packing_object_unregistered(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.can_read_packing_list(uuid), public.can_upload_dispatch_document(uuid), public.packing_object_unregistered(text) TO authenticated;

DROP POLICY IF EXISTS dispatch_documents_obj_insert ON storage.objects;
CREATE POLICY dispatch_documents_obj_insert ON storage.objects FOR INSERT TO authenticated
 WITH CHECK(bucket_id='dispatch_documents' AND (
   public.can_upload_dispatch_document(public.dispatch_document_folder(name))
   OR (public.can_upload_packing_list(public.dispatch_document_folder(name))
       AND name LIKE public.dispatch_document_folder(name)::text||'/packing/'||auth.uid()::text||'/%')));
CREATE POLICY packing_list_obj_read ON storage.objects FOR SELECT TO authenticated
 USING(bucket_id='dispatch_documents'
   AND (public.packing_object_unregistered(name) OR EXISTS(SELECT 1 FROM public.dispatch_documents x
     WHERE x.file_path=name AND x.doc_type='PACKING_LIST' AND x.voided_at IS NULL
       AND public.can_read_packing_list(x.dispatch_id))));
-- Retirar exclusivamente archivos propios que no llegaron a registrarse.
CREATE POLICY packing_list_obj_cleanup ON storage.objects FOR DELETE TO authenticated
 USING(bucket_id='dispatch_documents' AND public.packing_object_unregistered(name));
CREATE POLICY packing_list_audit_read ON public.dispatch_documents FOR SELECT TO authenticated
 USING(doc_type='PACKING_LIST' AND voided_at IS NULL AND public.can_read_packing_list(dispatch_id));

CREATE OR REPLACE FUNCTION public.register_signed_packing_list(p_dispatch_id uuid,p_request_id uuid,p_file_path text,p_file_name text,
 p_mime_type text,p_size_bytes bigint,p_auditor text,p_signed_date date,p_signature_confirmed boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.dispatches%ROWTYPE; v_id uuid;
BEGIN
 IF auth.uid() IS NULL OR NOT (public.is_tms_admin() OR public.has_tms_permission('packing-list')) THEN
   RETURN jsonb_build_object('success',false,'error','Solo el Auditor de Despacho carga el Packing List'); END IF;
 SELECT * INTO d FROM public.dispatches WHERE id=p_dispatch_id FOR UPDATE;
 IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN RETURN jsonb_build_object('success',false,'error','Despacho inexistente'); END IF;
 IF d.status<>'PROGRAMADO' THEN RETURN jsonb_build_object('success',false,'error','El Packing List se registra antes de la salida'); END IF;
 IF NOT COALESCE(p_signature_confirmed,false) OR NULLIF(trim(p_auditor),'') IS NULL OR p_signed_date IS NULL
    OR p_signed_date>(now() AT TIME ZONE 'America/Lima')::date THEN
   RETURN jsonb_build_object('success',false,'error','Indique auditor, fecha y confirme que el archivo contiene su firma'); END IF;
 IF COALESCE(p_mime_type,'') NOT IN ('application/pdf','image/jpeg','image/png','image/webp','application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') OR COALESCE(p_size_bytes,0) NOT BETWEEN 1 AND 15728640 THEN
   RETURN jsonb_build_object('success',false,'error','Adjunte el Packing List en PDF, fotografía o Excel (XLS/XLSX), hasta 15 MB'); END IF;
 IF public.dispatch_document_folder(p_file_path) IS DISTINCT FROM p_dispatch_id OR
    (NOT public.is_tms_admin() AND p_file_path NOT LIKE p_dispatch_id::text||'/packing/'||auth.uid()::text||'/%') OR
    NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='dispatch_documents' AND name=p_file_path) THEN
   RETURN jsonb_build_object('success',false,'error','El archivo no está disponible para este despacho'); END IF;
 IF p_request_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.dispatch_requests WHERE dispatch_id=p_dispatch_id AND transport_request_id=p_request_id) THEN
   RETURN jsonb_build_object('success',false,'error','La solicitud no pertenece a este despacho'); END IF;
 -- Reintentos no crean versiones; el documento reemplazado conserva su historial.
 SELECT id INTO v_id FROM public.dispatch_documents WHERE dispatch_id=p_dispatch_id
   AND transport_request_id IS NOT DISTINCT FROM p_request_id AND doc_type='PACKING_LIST' AND file_path=p_file_path AND voided_at IS NULL;
 IF v_id IS NOT NULL THEN RETURN jsonb_build_object('success',true,'id',v_id,'duplicate',true); END IF;
 UPDATE public.dispatch_documents SET voided_at=now(),voided_by=auth.uid(),void_reason='Reemplazado por nuevo Packing List del auditor'
 WHERE dispatch_id=p_dispatch_id AND transport_request_id IS NOT DISTINCT FROM p_request_id AND doc_type='PACKING_LIST' AND voided_at IS NULL;
 INSERT INTO public.dispatch_documents(dispatch_id,transport_request_id,doc_type,file_path,file_name,mime_type,size_bytes,
   uploaded_by,auditor_name,auditor_signed_date,auditor_signature_confirmed)
 VALUES(p_dispatch_id,p_request_id,'PACKING_LIST',p_file_path,p_file_name,p_mime_type,p_size_bytes,auth.uid(),left(trim(p_auditor),120),p_signed_date,true) RETURNING id INTO v_id;
 INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by)
 VALUES(p_dispatch_id,'DOCUMENTOS','Packing List registrado por el Auditor de Despacho',auth.uid()::text);
 RETURN jsonb_build_object('success',true,'id',v_id);
END $$;
REVOKE ALL ON FUNCTION public.register_signed_packing_list(uuid,uuid,text,text,text,bigint,text,date,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.register_signed_packing_list(uuid,uuid,text,text,text,bigint,text,date,boolean) TO authenticated;

DO $patch$
DECLARE definition text; updated text;
BEGIN
 definition:=pg_get_functiondef('public.get_documentary_queue(boolean)'::regprocedure);
 IF position('public.can_view_driver_evidence())' IN definition)=0 OR position('x.voided_at IS NULL) AS documents' IN definition)=0 THEN
   RAISE EXCEPTION 'Bandeja documentaria incompatible con la extensión del auditor'; END IF;
 updated:=replace(definition,'public.can_view_driver_evidence())',
   'public.can_view_driver_evidence() OR public.has_tms_read_permission(''packing-list'') OR public.has_tms_read_permission(''planificacion''))');
 updated:=replace(updated,'x.voided_at IS NULL) AS documents',
   'x.voided_at IS NULL AND (public.has_tms_read_permission(''documentario'') OR public.can_view_driver_evidence() OR x.doc_type=''PACKING_LIST'')) AS documents');
 updated:=replace(updated,'''delivery'', concat_ws', '''origin'', to_jsonb(t)->>''pickup_address'', ''delivery'', concat_ws');
 EXECUTE updated;
END $patch$;

-- Los hitos operativos del tercero los registra Transporte dentro del sistema.
REVOKE ALL ON FUNCTION public.delivery_public_arrive(text,uuid) FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN IF to_regprocedure('public.tercero_enlace_salida(text)') IS NOT NULL THEN
 REVOKE ALL ON FUNCTION public.tercero_enlace_salida(text) FROM PUBLIC,anon,authenticated,service_role;
END IF; END $$;
COMMIT;
NOTIFY pgrst, 'reload schema';
