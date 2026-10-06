-- Real role/storage/function checks; terminal exception deliberately rolls back every fixture.
BEGIN;
DO $test$
DECLARE v_admin uuid; v_site uuid; v_dispatch uuid; v_req uuid; v_path text; r jsonb; fail text[]:='{}'; f record;
BEGIN
 FOR f IN SELECT oid,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
   ('delivery_issue_access_core','delivery_auto_access','delivery_record_cargo','packing_document_invalidated') LOOP
   IF has_function_privilege('anon',f.oid,'EXECUTE') OR has_function_privilege('authenticated',f.oid,'EXECUTE') THEN
     fail:=fail||('Privada expuesta: '||f.proname); END IF;
 END LOOP;
 IF NOT has_function_privilege('authenticated','public.register_signed_packing_list(uuid,uuid,text,text,text,bigint,text,date,boolean)','EXECUTE') OR
    has_function_privilege('anon','public.register_signed_packing_list(uuid,uuid,text,text,text,bigint,text,date,boolean)','EXECUTE') THEN
   fail:=array_append(fail,'Permisos de Packing List'); END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled<>'D' AND tgname IN
   ('delivery_auto_access','packing_document_invalidated','delivery_record_cargo'))<>3 THEN fail:=array_append(fail,'Faltan controles de acceso, firma o recepción'); END IF;
 SELECT site_id INTO v_site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
 FOR v_admin IN SELECT id FROM public.profiles WHERE is_active AND id IN(SELECT id FROM auth.users) LOOP
   PERFORM set_config('request.jwt.claim.sub',v_admin::text,true);
   EXIT WHEN public.is_tms_admin(); v_admin:=NULL;
 END LOOP;
 IF v_admin IS NULL OR v_site IS NULL THEN RAISE EXCEPTION 'CAJA C46 FAIL: falta administrador activo o sede'; END IF;
 PERFORM set_config('request.jwt.claims',json_build_object('sub',v_admin,'role','authenticated')::text,true);
 INSERT INTO public.dispatches(dispatch_number,vehicle_plate,status,site_id,scheduled_departure,docs_required)
 VALUES('ZZ-C46-PACKING','ZZC46','PROGRAMADO',v_site,now(),true) RETURNING id INTO v_dispatch;
 INSERT INTO public.transport_requests(request_number,status,site_id,requester_name,department,request_type,cargo_description,
   pickup_address,pickup_district,delivery_address,delivery_district,required_date)
 VALUES('ZZ-C46-R','ASIGNADA',v_site,'Prueba C46','Logística','DESPACHO','Packing','Planta','CHILCA','Obra','LURIN',current_date) RETURNING id INTO v_req;
 INSERT INTO public.dispatch_requests(dispatch_id,transport_request_id,status,document_type,sequence_order)
 VALUES(v_dispatch,v_req,'PROGRAMADO','GR',1);
 v_path:=v_dispatch::text||'/packing.pdf';
 r:=public.register_signed_packing_list(v_dispatch,NULL,v_path,'packing.pdf','application/pdf',1000,'Auditor C46',(now() AT TIME ZONE 'America/Lima')::date,true);
 IF COALESCE((r->>'success')::boolean,false) THEN fail:=array_append(fail,'Aceptó archivo inexistente'); END IF;
 INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('dispatch_documents',v_path,'{"mimetype":"application/pdf"}');
 r:=public.register_signed_packing_list(v_dispatch,NULL,v_path,'packing.pdf','application/pdf',1000,'Auditor C46',(now() AT TIME ZONE 'America/Lima')::date,false);
 IF COALESCE((r->>'success')::boolean,false) THEN fail:=array_append(fail,'Aceptó firma no confirmada'); END IF;
 r:=public.register_dispatch_document(v_dispatch,v_req,'GUIA_REMISION','PT','C46-1',v_path,'guia.pdf','application/pdf',1000,NULL);
 IF COALESCE((r->>'success')::boolean,false) THEN fail:=array_append(fail,'Asistente sigue cargando la guía'); END IF;
 r:=public.confirm_dispatch_documents(v_dispatch);
 IF COALESCE((r->>'success')::boolean,false) THEN fail:=array_append(fail,'Confirmó sin Packing firmado'); END IF;
 r:=public.register_signed_packing_list(v_dispatch,NULL,v_path,'packing.pdf','application/pdf',1000,'Auditor C46',(now() AT TIME ZONE 'America/Lima')::date,true);
 IF NOT COALESCE((r->>'success')::boolean,false) THEN fail:=fail||('No registró firma: '||r::text); END IF;
 r:=public.confirm_dispatch_documents(v_dispatch);
 IF NOT COALESCE((r->>'success')::boolean,false) THEN fail:=fail||('No confirmó Packing: '||r::text); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.dispatch_documents WHERE dispatch_id=v_dispatch AND auditor_signature_confirmed AND auditor_name='Auditor C46' AND uploaded_by=v_admin) THEN
   fail:=array_append(fail,'Firma/auditor/actor sin trazabilidad'); END IF;
 r:=public.registrar_cargo(v_dispatch,NULL,'solo una nota');
 IF COALESCE((r->>'success')::boolean,false) THEN fail:=array_append(fail,'Nota reemplaza guía'); END IF;
 IF cardinality(fail)>0 THEN RAISE EXCEPTION 'CAJA C46 FAIL: %',array_to_string(fail,' | '); END IF;
 RAISE EXCEPTION 'CAJA C46 PASS: acceso automático privado, firma/auditor/archivo real, confirmación y separación de responsabilidades';
END $test$;
ROLLBACK;
