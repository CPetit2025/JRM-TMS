-- C69 Portal público por cliente:
-- T1 el acceso guarda el destinatario y la consulta lo devuelve.
-- T2 un acceso por cliente ve todas sus OT con su familia, también una OT creada después; nunca OT de otro cliente.
-- T3 no se puede autorizar un cliente sin OT en la sede; anon no puede crear accesos.
BEGIN;
DO $test$
DECLARE actor uuid; site uuid; cli uuid; other uuid; ca uuid:=gen_random_uuid(); cs uuid:=gen_random_uuid(); cn uuid:=gen_random_uuid(); cx uuid:=gen_random_uuid();
 ra uuid; rs uuid; rn uuid; rx uuid; payload jsonb; result jsonb; tok uuid; pin text; denied boolean;
 tag text:=substr(replace(gen_random_uuid()::text,'-',''),1,6);
 ruc1 text:='20'||lpad((floor(random()*1e9))::bigint::text,9,'0'); ruc2 text:='20'||lpad((floor(random()*1e9))::bigint::text,9,'0');
BEGIN
 IF has_function_privilege('anon','public.generate_tracking_portal_link(jsonb)','EXECUTE') OR has_function_privilege('anon','public.tracking_portal_scope_ids(uuid[],uuid[])','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C69 FAIL (T3): permisos de creación expuestos';
 END IF;
 SELECT p.id INTO actor FROM public.profiles p JOIN public.roles r ON r.id=p.role_id WHERE r.name='Administrador' AND p.is_active LIMIT 1;
 SELECT id INTO site FROM public.sites LIMIT 1;
 IF actor IS NULL OR site IS NULL THEN RAISE EXCEPTION 'CAJA C69 FAIL: fixture administrador/sede ausente'; END IF;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
 INSERT INTO public.clients(business_name,tax_id,address,contact_name,phone,email,is_active) VALUES('ZZ C69 Cliente '||tag,ruc1,'Av. Prueba 1','Contacto','999','zz@x',true) RETURNING id INTO cli;
 INSERT INTO public.clients(business_name,tax_id,address,contact_name,phone,email,is_active) VALUES('ZZ C69 Otro '||tag,ruc2,'Av. Prueba 2','Contacto','999','zz@x',true) RETURNING id INTO other;
 INSERT INTO public.contracts(id,code,site_id,client_id) VALUES(ca,'ZZ-C69-'||tag,site,cli),(cx,'ZZ-C69X-'||tag,site,other);
 INSERT INTO public.contracts(id,code,site_id,client_id,type,parent_contract_id) VALUES(cs,'ZZ-C69-'||tag||'-S001',site,cli,'SUBCONTRATO',ca);
 INSERT INTO public.transport_requests(request_number,status,site_id,requester_name,department,request_type,cargo_description,pickup_address,pickup_district,delivery_address,delivery_district,required_date,contract_id)
 VALUES('ZZ-C69-A','PENDIENTE',site,'Prueba C69','Logística','RECOJO','Carga','Origen','CHILCA','Destino','LURIN',current_date,ca) RETURNING id INTO ra;
 INSERT INTO public.transport_requests(request_number,status,site_id,requester_name,department,request_type,cargo_description,pickup_address,pickup_district,delivery_address,delivery_district,required_date,contract_id)
 VALUES('ZZ-C69-S','PENDIENTE',site,'Prueba C69','Logística','RECOJO','Carga','Origen','CHILCA','Destino','LURIN',current_date,cs) RETURNING id INTO rs;
 INSERT INTO public.transport_requests(request_number,status,site_id,requester_name,department,request_type,cargo_description,pickup_address,pickup_district,delivery_address,delivery_district,required_date,contract_id)
 VALUES('ZZ-C69-X','PENDIENTE',site,'Prueba C69','Logística','RECOJO','Carga','Origen','CHILCA','Destino','LURIN',current_date,cx) RETURNING id INTO rx;
 payload:=public.generate_tracking_portal_link(jsonb_build_object('site_id',site,'client_ids',jsonb_build_array(cli),'label','  Cliente C69 · Logística  '));
 tok:=(payload->>'token')::uuid; pin:=payload->>'pin';
 -- OT del cliente creada después del acceso
 INSERT INTO public.contracts(id,code,site_id,client_id) VALUES(cn,'ZZ-C69N-'||tag,site,cli);
 INSERT INTO public.transport_requests(request_number,status,site_id,requester_name,department,request_type,cargo_description,pickup_address,pickup_district,delivery_address,delivery_district,required_date,contract_id)
 VALUES('ZZ-C69-N','PENDIENTE',site,'Prueba C69','Logística','RECOJO','Carga','Origen','CHILCA','Destino','LURIN',current_date,cn) RETURNING id INTO rn;
 result:=public.get_public_tracking_portal_info(tok,pin,current_date-1,current_date+1);
 IF result->>'label' IS DISTINCT FROM 'Cliente C69 · Logística'
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(public.list_tracking_portal_links()) l WHERE l->>'token'=tok::text AND l->>'label'='Cliente C69 · Logística' AND l->'client_ids'=jsonb_build_array(cli)) THEN
  RAISE EXCEPTION 'CAJA C69 FAIL (T1): destinatario no guardado o no devuelto';
 END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(result->'requests') x WHERE x->>'id' IN (ra::text,rs::text,rn::text))<>3
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(result->'requests') x WHERE x->>'id'=rx::text) THEN
  RAISE EXCEPTION 'CAJA C69 FAIL (T2): el acceso por cliente no ve exactamente sus OT';
 END IF;
 denied:=false;
 BEGIN PERFORM public.generate_tracking_portal_link(jsonb_build_object('site_id',site,'client_ids',jsonb_build_array(gen_random_uuid()))); EXCEPTION WHEN OTHERS THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'CAJA C69 FAIL (T3): cliente sin OT aceptado'; END IF;
 RAISE EXCEPTION 'CAJA C69 PASS (3/3) portal por cliente: destinatario, OT del cliente con familia y OT futuras';
END $test$;
ROLLBACK;
