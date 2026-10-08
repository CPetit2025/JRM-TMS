-- C68 Portal público (enlace permanente por OT):
-- T1 la OT autorizada incluye sus subcontratos y errores, con tipo, OT madre y referencias; otra OT queda fuera.
-- T2 guías y Packing List: la parada autorizada ve su documento y el de la ruta solo si toda la ruta está autorizada;
--    get_public_tracking_document entrega únicamente archivos autorizados y cuenta los códigos incorrectos.
-- T3 GPS: se comparte la ruta cuyas paradas están todas autorizadas, nunca una ruta mixta.
-- T4 permisos: la función de documentos y la de familia no son ejecutables por anon ni authenticated.
BEGIN;
DO $test$
DECLARE actor uuid; site uuid; cp uuid:=gen_random_uuid(); cs uuid:=gen_random_uuid(); ce uuid:=gen_random_uuid(); cx uuid:=gen_random_uuid();
 rp uuid; rs uuid; re uuid; rx uuid; r1 uuid; r2 uuid; d_own uuid; d_route1 uuid; d_route2 uuid; d_other uuid;
 payload jsonb; result jsonb; tok uuid; pin text; tag text:=substr(replace(gen_random_uuid()::text,'-',''),1,6);
BEGIN
 IF has_function_privilege('anon','public.get_public_tracking_document(uuid,text,text,uuid,uuid,integer)','EXECUTE')
 OR has_function_privilege('authenticated','public.get_public_tracking_document(uuid,text,text,uuid,uuid,integer)','EXECUTE')
 OR has_function_privilege('anon','public.tracking_portal_contract_family(uuid[])','EXECUTE')
 OR NOT has_function_privilege('service_role','public.get_public_tracking_document(uuid,text,text,uuid,uuid,integer)','EXECUTE')
 OR NOT has_function_privilege('anon','public.get_public_tracking_portal_info(uuid,text,date,date)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C68 FAIL (T4): permisos de las funciones del portal';
 END IF;
 SELECT p.id INTO actor FROM public.profiles p JOIN public.roles r ON r.id=p.role_id WHERE r.name='Administrador' AND p.is_active LIMIT 1;
 SELECT id INTO site FROM public.sites LIMIT 1;
 IF actor IS NULL OR site IS NULL THEN RAISE EXCEPTION 'CAJA C68 FAIL: fixture administrador/sede ausente'; END IF;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
 INSERT INTO public.contracts(id,code,site_id) VALUES(cp,'ZZ-C68-'||tag,site),(cx,'ZZ-C68X-'||tag,site);
 INSERT INTO public.contracts(id,code,site_id,type,parent_contract_id) VALUES(cs,'ZZ-C68-'||tag||'-S001',site,'SUBCONTRATO',cp),(ce,'ZZ-C68-'||tag||'-E001',site,'ERROR',cp);
 INSERT INTO public.transport_requests(request_number,status,site_id,requester_name,department,request_type,cargo_description,pickup_address,pickup_district,delivery_address,delivery_district,required_date,contract_id)
 VALUES('ZZ-C68-P','ASIGNADA',site,'Prueba C68','Logística','RECOJO','Carga','Origen','CHILCA','Destino','LURIN',current_date,cp) RETURNING id INTO rp;
 INSERT INTO public.transport_requests(request_number,status,site_id,requester_name,department,request_type,cargo_description,pickup_address,pickup_district,delivery_address,delivery_district,required_date,contract_id)
 VALUES('ZZ-C68-S','ASIGNADA',site,'Prueba C68','Logística','RECOJO','Carga','Origen','CHILCA','Destino','LURIN',current_date,cs) RETURNING id INTO rs;
 INSERT INTO public.transport_requests(request_number,status,site_id,requester_name,department,request_type,cargo_description,pickup_address,pickup_district,delivery_address,delivery_district,required_date,contract_id)
 VALUES('ZZ-C68-E','ASIGNADA',site,'Prueba C68','Logística','RECOJO','Carga','Origen','CHILCA','Destino','LURIN',current_date,ce) RETURNING id INTO re;
 INSERT INTO public.transport_requests(request_number,status,site_id,requester_name,department,request_type,cargo_description,pickup_address,pickup_district,delivery_address,delivery_district,required_date,contract_id)
 VALUES('ZZ-C68-X','ASIGNADA',site,'Prueba C68','Logística','RECOJO','Carga','Origen','CHILCA','Destino','LURIN',current_date,cx) RETURNING id INTO rx;
 -- Ruta 1: solo la familia autorizada (madre + subcontrato). Ruta 2: error autorizado + OT ajena (mixta).
 INSERT INTO public.dispatches(dispatch_number,vehicle_plate,status,site_id,scheduled_departure,last_gps_at,last_lat,last_lon)
 VALUES('ZZ-C68-R1','ZZC68A','PROGRAMADO',site,now(),now(),-12,-77) RETURNING id INTO r1;
 INSERT INTO public.dispatches(dispatch_number,vehicle_plate,status,site_id,scheduled_departure,last_gps_at,last_lat,last_lon)
 VALUES('ZZ-C68-R2','ZZC68B','PROGRAMADO',site,now(),now(),-12,-77) RETURNING id INTO r2;
 INSERT INTO public.dispatch_requests(dispatch_id,transport_request_id,status,sequence_order) VALUES(r1,rp,'ASIGNADA',1),(r1,rs,'ASIGNADA',2),(r2,re,'ASIGNADA',1),(r2,rx,'ASIGNADA',2);
 INSERT INTO public.dispatch_documents(dispatch_id,transport_request_id,doc_type,file_path,file_name) VALUES(r1,rp,'GUIA_REMISION',r1::text||'/c68-guia.pdf','c68-guia.pdf') RETURNING id INTO d_own;
 INSERT INTO public.dispatch_documents(dispatch_id,doc_type,file_path,file_name) VALUES(r1,'PACKING_LIST',r1::text||'/c68-packing.pdf','c68-packing.pdf') RETURNING id INTO d_route1;
 INSERT INTO public.dispatch_documents(dispatch_id,doc_type,file_path,file_name) VALUES(r2,'PACKING_LIST',r2::text||'/c68-packing.pdf','c68-packing.pdf') RETURNING id INTO d_route2;
 INSERT INTO public.dispatch_documents(dispatch_id,transport_request_id,doc_type,file_path,file_name) VALUES(r2,rx,'GUIA_REMISION',r2::text||'/c68-ajena.pdf','c68-ajena.pdf') RETURNING id INTO d_other;
 payload:=public.generate_tracking_portal_link(jsonb_build_object('site_id',site,'contract_ids',jsonb_build_array(cp)));
 tok:=(payload->>'token')::uuid; pin:=payload->>'pin';
 result:=public.get_public_tracking_portal_info(tok,pin,current_date-1,current_date+1);
 payload:=result;
 -- T1 familia
 IF (SELECT count(*) FROM jsonb_array_elements(result->'requests') x WHERE x->>'id' IN (rp::text,rs::text,re::text))<>3
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(result->'requests') x WHERE x->>'id'=rx::text)
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'requests') x WHERE x->>'id'=rs::text AND x->>'ot_type'='SUBCONTRATO' AND x->>'parent_ot'='ZZ-C68-'||tag)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(result->'rows') x WHERE x->>'request_id'=rx::text)
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'rows') x WHERE x->>'request_id'=re::text) THEN
  RAISE EXCEPTION 'CAJA C68 FAIL (T1): la OT autorizada no incluye exactamente su familia';
 END IF;
 -- T2 documentos en la proyección
 IF (SELECT jsonb_array_length(x->'documents') FROM jsonb_array_elements(result->'rows') x WHERE x->>'request_id'=rp::text)<>2
 OR (SELECT jsonb_array_length(x->'documents') FROM jsonb_array_elements(result->'rows') x WHERE x->>'request_id'=rs::text)<>1
 OR (SELECT jsonb_array_length(x->'documents') FROM jsonb_array_elements(result->'rows') x WHERE x->>'request_id'=re::text)<>0 THEN
  RAISE EXCEPTION 'CAJA C68 FAIL (T2): documentos por parada mal proyectados';
 END IF;
 -- T2 entrega de archivos
 IF public.get_public_tracking_document(tok,pin,'DOC',d_own)->>'path' IS DISTINCT FROM r1::text||'/c68-guia.pdf'
 OR public.get_public_tracking_document(tok,pin,'DOC',d_route1)->>'path' IS DISTINCT FROM r1::text||'/c68-packing.pdf'
 OR NOT public.get_public_tracking_document(tok,pin,'DOC',d_route2) ? 'error'
 OR NOT public.get_public_tracking_document(tok,pin,'DOC',d_other) ? 'error'
 OR NOT public.get_public_tracking_document(tok,pin,'FIRMA',r1,rp,1) ? 'error'
 OR NOT public.get_public_tracking_document(tok,pin,'OTRO',d_own) ? 'error' THEN
  RAISE EXCEPTION 'CAJA C68 FAIL (T2): se entrega un archivo no autorizado o se niega uno autorizado';
 END IF;
 result:=public.get_public_tracking_document(tok,'00000000','DOC',d_own);
 IF NOT result ? 'error' OR (SELECT attempts FROM public.tracking_portal_links WHERE token=tok)<>1 THEN
  RAISE EXCEPTION 'CAJA C68 FAIL (T2): código incorrecto no rechazado o no contado';
 END IF;
 -- T3 GPS
 result:=payload;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'locations') x WHERE x->>'dispatch_id'=r1::text)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(result->'locations') x WHERE x->>'dispatch_id'=r2::text) THEN
  RAISE EXCEPTION 'CAJA C68 FAIL (T3): GPS de rutas por OT mal compartido';
 END IF;
 RAISE EXCEPTION 'CAJA C68 PASS (4/4) portal público: familia de OT, guías y Packing List autorizados, GPS por ruta autorizada';
END $test$;
ROLLBACK;
