-- Roles, archivos y RPC reales; la excepción final revierte todos los datos de prueba.
BEGIN;
CREATE FUNCTION pg_temp.c53_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM set_config('request.jwt.claim.sub',COALESCE(p_user::text,''),true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true);
 PERFORM set_config('role',CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END,true);
END $$;
CREATE FUNCTION pg_temp.c53_ins(p_table text,p_cols jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
 EXECUTE (SELECT format('INSERT INTO public.%I (%s) VALUES (%s) RETURNING id',p_table,
   string_agg(quote_ident(k.key),','),string_agg(quote_nullable(k.value #>> '{}'),',')) FROM jsonb_each(p_cols) k
   WHERE EXISTS(SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name=p_table AND c.column_name=k.key)) INTO v_id;
 RETURN v_id;
END $$;
DO $test$
DECLARE actor uuid; assistant uuid; audit_role uuid; doc_role uuid; site uuid; foreign_site uuid; d uuid; other_d uuid; req uuid;
 path text; pending_path text; doc_id uuid; r jsonb; q jsonb; mime text; ext text; denied boolean; removed integer; n integer:=0;
BEGIN
 SELECT id INTO audit_role FROM public.roles WHERE lower(trim(name))='auditor de despacho';
 IF audit_role IS NULL OR (SELECT permissions FROM public.roles WHERE id=audit_role) IS DISTINCT FROM '["planificacion:read","packing-list:write"]'::jsonb THEN
   RAISE EXCEPTION 'CAJA C53 FAIL: perfil del auditor no limitado'; END IF;
 SELECT id INTO actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users)
   AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 1;
 SELECT id INTO assistant FROM public.profiles WHERE id IN(SELECT id FROM auth.users) AND id<>actor
   AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 1;
 SELECT site_id INTO site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
 IF actor IS NULL OR assistant IS NULL OR site IS NULL THEN RAISE EXCEPTION 'CAJA C53 FAIL: faltan perfiles o sede'; END IF;
 SELECT id INTO foreign_site FROM public.sites WHERE id<>site LIMIT 1;
 IF foreign_site IS NULL THEN foreign_site:=pg_temp.c53_ins('sites',jsonb_build_object('id',gen_random_uuid(),'code','ZZ-C53','name','Prueba C53')); END IF;
 INSERT INTO public.roles(id,name,permissions) VALUES(gen_random_uuid(),'ZZ C53 documentario','["documentario"]') RETURNING id INTO doc_role;
 UPDATE public.profiles SET role_id=audit_role,is_active=true WHERE id=actor;
 UPDATE public.profiles SET role_id=doc_role,is_active=true WHERE id=assistant;
 DELETE FROM public.user_site_access WHERE user_id=actor;
 INSERT INTO public.user_site_access(user_id,site_id) VALUES(actor,site),(assistant,site) ON CONFLICT DO NOTHING;
 d:=pg_temp.c53_ins('dispatches',jsonb_build_object('dispatch_number','ZZ-C53','vehicle_plate','ZZ53'||substr(gen_random_uuid()::text,1,6),'status','PROGRAMADO','site_id',site,'scheduled_departure',now(),'docs_required',true));
 other_d:=pg_temp.c53_ins('dispatches',jsonb_build_object('dispatch_number','ZZ-C53-OTRA','vehicle_plate','ZZ53'||substr(gen_random_uuid()::text,1,6),'status','PROGRAMADO','site_id',foreign_site,'scheduled_departure',now(),'docs_required',true));
 req:=pg_temp.c53_ins('transport_requests',jsonb_build_object('request_number','ZZ-C53-RT','status','ASIGNADA','site_id',site,'requester_name','Prueba','department','Logística','request_type','DESPACHO','cargo_description','Packing','pickup_address','Planta C53','pickup_district','CHILCA','delivery_address','Obra','delivery_district','LURIN','required_date',current_date));
 INSERT INTO public.dispatch_requests(dispatch_id,transport_request_id,status,document_type,sequence_order) VALUES(d,req,'PROGRAMADO','GR',1);
 -- Otro tipo documentario en la misma carpeta no debe ser visible al auditor.
 INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('dispatch_documents',d::text||'/otro.pdf','{"mimetype":"application/pdf"}');
 INSERT INTO public.dispatch_documents(dispatch_id,doc_type,file_path,mime_type) VALUES(d,'OTRO',d::text||'/otro.pdf','application/pdf');
 PERFORM pg_temp.c53_user(actor);
 IF NOT public.can_upload_packing_list(d) OR public.can_upload_packing_list(other_d) OR public.has_tms_permission('despacho')
    OR public.has_tms_permission('documentario') OR public.has_tms_read_permission('caja') THEN RAISE EXCEPTION 'CAJA C53 FAIL: permisos o aislamiento de sede'; END IF;
 FOREACH mime IN ARRAY ARRAY['application/pdf','image/jpeg','image/png','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] LOOP
   n:=n+1; ext:=CASE mime WHEN 'application/pdf' THEN 'pdf' WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/png' THEN 'png' WHEN 'application/vnd.ms-excel' THEN 'xls' ELSE 'xlsx' END;
   path:=d::text||'/packing/'||actor::text||'/'||gen_random_uuid()::text||'.'||ext;
   INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('dispatch_documents',path,jsonb_build_object('mimetype',mime,'size',1000));
   -- El archivo propio pendiente se puede consultar y retirar si falla su registro.
   IF NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='dispatch_documents' AND name=path) OR NOT public.packing_object_unregistered(path) THEN RAISE EXCEPTION 'CAJA C53 FAIL: lectura del archivo propio pendiente'; END IF;
   r:=public.register_signed_packing_list(d,NULL,path,'packing.'||ext,mime,1000,'Auditor C53',(now() AT TIME ZONE 'America/Lima')::date,true);
   IF r->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'CAJA C53 FAIL: formato %: %',mime,r; END IF;
   doc_id:=(r->>'id')::uuid;
   IF NOT EXISTS(SELECT 1 FROM public.dispatch_documents WHERE id=doc_id AND uploaded_by=actor AND auditor_signature_confirmed)
     OR public.packing_object_unregistered(path) THEN RAISE EXCEPTION 'CAJA C53 FAIL: trazabilidad o limpieza de archivo registrado'; END IF;
   r:=public.register_signed_packing_list(d,NULL,path,'packing.'||ext,mime,1000,'Auditor C53',(now() AT TIME ZONE 'America/Lima')::date,true);
   IF r->>'duplicate' IS DISTINCT FROM 'true' OR r->>'id'<>doc_id::text THEN RAISE EXCEPTION 'CAJA C53 FAIL: reintento duplica la versión'; END IF;
 END LOOP;
 DELETE FROM storage.objects WHERE bucket_id='dispatch_documents' AND name=path;
 GET DIAGNOSTICS removed=ROW_COUNT;
 IF removed<>0 THEN RAISE EXCEPTION 'CAJA C53 FAIL: eliminó un archivo registrado'; END IF;
 pending_path:=d::text||'/packing/'||actor::text||'/sin-registro.pdf';
 INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('dispatch_documents',pending_path,'{}');
 DELETE FROM storage.objects WHERE bucket_id='dispatch_documents' AND name=pending_path;
 GET DIAGNOSTICS removed=ROW_COUNT;
 IF removed<>1 THEN RAISE EXCEPTION 'CAJA C53 FAIL: no retiró el archivo propio sin registro'; END IF;
 IF (SELECT count(*) FROM public.dispatch_documents WHERE dispatch_id=d)<>1 OR
    EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='dispatch_documents' AND name=d::text||'/otro.pdf') THEN RAISE EXCEPTION 'CAJA C53 FAIL: auditor consulta otros documentos o versiones anuladas'; END IF;
 r:=public.register_signed_packing_list(d,NULL,path,'packing.xlsx',mime,1000,'Auditor C53',current_date,false);
 IF r->>'success'='true' THEN RAISE EXCEPTION 'CAJA C53 FAIL: aceptó firma sin confirmar'; END IF;
 r:=public.register_signed_packing_list(d,NULL,path,'packing.xlsx','application/x-test-invalid',1000,'Auditor C53',current_date,true);
 IF r->>'success'='true' THEN RAISE EXCEPTION 'CAJA C53 FAIL: aceptó formato no válido'; END IF;
 r:=public.register_signed_packing_list(d,NULL,path,'packing.xlsx',mime,15728641,'Auditor C53',current_date,true);
 IF r->>'success'='true' THEN RAISE EXCEPTION 'CAJA C53 FAIL: archivo supera límite'; END IF;
 r:=public.register_signed_packing_list(d,NULL,d::text||'/otro.pdf','otro.pdf','application/pdf',1000,'Auditor C53',(now() AT TIME ZONE 'America/Lima')::date,true);
 IF r->>'success'='true' THEN RAISE EXCEPTION 'CAJA C53 FAIL: convirtió un archivo ajeno en Packing List'; END IF;
 denied:=false;
 BEGIN INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('dispatch_documents',other_d::text||'/packing/'||actor::text||'/ajeno.pdf','{}');
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'CAJA C53 FAIL: Storage admite otra sede'; END IF;
 r:=public.register_dispatch_document(d,req,'NOTA_DESPACHO',NULL,'ND53',path,'x.pdf','application/pdf',1000,NULL);
 IF r->>'success'='true' THEN RAISE EXCEPTION 'CAJA C53 FAIL: auditor registra otro documento'; END IF;
 r:=public.confirm_dispatch_documents(d);
 IF r->>'success'='true' THEN RAISE EXCEPTION 'CAJA C53 FAIL: auditor confirma salida'; END IF;
 SELECT value INTO q FROM jsonb_array_elements(public.get_documentary_queue(false)) WHERE value->>'id'=d::text;
 IF q IS NULL OR jsonb_array_length(q->'documents')<>1 OR q->'stops'->0->>'request_number'<>'ZZ-C53-RT' OR q->'stops'->0->>'origin'<>'Planta C53' THEN
   RAISE EXCEPTION 'CAJA C53 FAIL: planificación incompleta o documentos ajenos'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(public.get_documentary_queue(false)) WHERE value->>'id'=other_d::text) THEN RAISE EXCEPTION 'CAJA C53 FAIL: planificación de otra sede'; END IF;
 PERFORM pg_temp.c53_user(assistant);
 r:=public.register_signed_packing_list(d,NULL,path,'packing.xlsx',mime,1000,'Auditor C53',current_date,true);
 IF r->>'success'='true' THEN RAISE EXCEPTION 'CAJA C53 FAIL: asistente sigue cargando Packing List'; END IF;
 r:=public.confirm_dispatch_documents(d);
 IF r->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'CAJA C53 FAIL: asistente no confirma documentos: %',r; END IF;
 PERFORM pg_temp.c53_user(actor);
 path:=d::text||'/packing/'||actor::text||'/reemplazo.xlsx';
 INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('dispatch_documents',path,jsonb_build_object('mimetype',mime));
 r:=public.register_signed_packing_list(d,NULL,path,'reemplazo.xlsx',mime,1000,'Auditor C53',(now() AT TIME ZONE 'America/Lima')::date,true);
 IF r->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'CAJA C53 FAIL: reemplazo confirmado: %',r; END IF;
 n:=n+1;
 SELECT value INTO q FROM jsonb_array_elements(public.get_documentary_queue(false)) WHERE value->>'id'=d::text;
 IF q->>'doc_status' IS DISTINCT FROM 'REEMISION' OR q->>'docs_ready_at' IS NOT NULL THEN RAISE EXCEPTION 'CAJA C53 FAIL: reemplazo conserva la autorización de salida'; END IF;
 PERFORM pg_temp.c53_user(assistant);
 r:=public.confirm_dispatch_documents(d);
 IF r->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'CAJA C53 FAIL: reconfirmación después del reemplazo'; END IF;
 PERFORM pg_temp.c53_user(NULL);
 IF (SELECT count(*) FROM public.dispatch_documents WHERE dispatch_id=d AND doc_type='PACKING_LIST')<>n OR
    (SELECT count(*) FROM public.dispatch_documents WHERE dispatch_id=d AND doc_type='PACKING_LIST' AND voided_at IS NOT NULL)<>n-1 THEN RAISE EXCEPTION 'CAJA C53 FAIL: historial de reemplazos'; END IF;
 IF has_function_privilege('service_role','public.delivery_public_arrive(text,uuid)','EXECUTE') OR
    has_function_privilege('anon','public.register_signed_packing_list(uuid,uuid,text,text,text,bigint,text,date,boolean)','EXECUTE') OR
    (to_regprocedure('public.tercero_enlace_salida(text)') IS NOT NULL AND has_function_privilege('service_role','public.tercero_enlace_salida(text)','EXECUTE')) THEN
   RAISE EXCEPTION 'CAJA C53 FAIL: puntos de entrada restringidos expuestos'; END IF;
 RAISE EXCEPTION 'CAJA C53 PASS: perfil limitado, Storage real por sede, PDF/foto/Excel, firma, idempotencia e historial; auditor carga, asistente confirma y proveedor solo guía';
END $test$;
ROLLBACK;
