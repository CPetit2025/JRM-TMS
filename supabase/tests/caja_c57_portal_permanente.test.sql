BEGIN;
DO $test$
DECLARE started timestamptz; ca uuid:=gen_random_uuid(); cb uuid:=gen_random_uuid(); foreign_site uuid; ra uuid; rb uuid; trip uuid; scoped uuid; scoped_pin text; actor uuid; site uuid; payload jsonb; result jsonb; tok uuid; pin text; denied boolean;
BEGIN
 IF has_table_privilege('anon','public.tracking_portal_links','SELECT') OR has_table_privilege('authenticated','public.tracking_portal_links','SELECT') THEN RAISE EXCEPTION 'CAJA C57 FAIL: tabla de credenciales expuesta'; END IF;
 IF has_function_privilege('anon','public.generate_tracking_portal_link(jsonb)','EXECUTE') OR has_function_privilege('anon','public.manage_tracking_portal_link(uuid,text)','EXECUTE') OR NOT has_function_privilege('anon','public.get_public_tracking_portal_info(uuid,text,date,date)','EXECUTE') THEN RAISE EXCEPTION 'CAJA C57 FAIL: permisos RPC'; END IF;
 SELECT p.id INTO actor FROM public.profiles p JOIN public.roles r ON r.id=p.role_id WHERE r.name='Administrador' AND p.is_active LIMIT 1;
 SELECT id INTO site FROM public.sites LIMIT 1;
 IF actor IS NULL OR site IS NULL THEN RAISE EXCEPTION 'CAJA C57 FAIL: fixture administrador/sede ausente'; END IF;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
 SELECT id INTO foreign_site FROM public.sites WHERE id<>site LIMIT 1;
 INSERT INTO public.contracts(id,code,site_id) VALUES(ca,'ZZ-C57-A',site),(cb,'ZZ-C57-B',site);
 INSERT INTO public.transport_requests(request_number,status,site_id,requester_name,department,request_type,cargo_description,pickup_address,pickup_district,delivery_address,delivery_district,required_date,contract_id)
 VALUES('ZZ-C57-A','ASIGNADA',site,'Prueba C57','Logística','RECOJO','Carga','Origen','CHILCA','Destino','LURIN',current_date,ca) RETURNING id INTO ra;
 INSERT INTO public.transport_requests(request_number,status,site_id,requester_name,department,request_type,cargo_description,pickup_address,pickup_district,delivery_address,delivery_district,required_date,contract_id)
 VALUES('ZZ-C57-B','ASIGNADA',site,'Prueba C57','Logística','RECOJO','Carga','Origen','CHILCA','Destino','LURIN',current_date,cb) RETURNING id INTO rb;
 INSERT INTO public.dispatches(dispatch_number,vehicle_plate,status,site_id,scheduled_departure,last_gps_at,last_lat,last_lon)
 VALUES('ZZ-C57-MIX','ZZC57','PROGRAMADO',site,now(),now(),-12,-77) RETURNING id INTO trip;
 INSERT INTO public.dispatch_requests(dispatch_id,transport_request_id,status,sequence_order) VALUES(trip,ra,'ASIGNADA',1),(trip,rb,'ASIGNADA',2);
 payload:=public.generate_tracking_portal_link(jsonb_build_object('site_id',site,'contract_ids',jsonb_build_array(ca)));
 scoped:=(payload->>'token')::uuid;scoped_pin:=payload->>'pin';
 result:=public.get_public_tracking_portal_info(scoped,scoped_pin,current_date-1,current_date+1);
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'requests') x WHERE x->>'id'=ra::text)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(result->'requests') x WHERE x->>'id'=rb::text)
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'rows') x WHERE x->>'request_id'=ra::text)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(result->'rows') x WHERE x->>'request_id'=rb::text)
 OR jsonb_array_length(result->'locations')<>0 THEN RAISE EXCEPTION 'CAJA C57 FAIL: ruta mixta expone OT no autorizada'; END IF;
 denied:=false;BEGIN PERFORM public.generate_tracking_portal_link(jsonb_build_object('site_id',site,'contract_ids',jsonb_build_array(gen_random_uuid()))); EXCEPTION WHEN OTHERS THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'CAJA C57 FAIL: OT ajena aceptada'; END IF;
 payload:=public.generate_tracking_portal_link(jsonb_build_object('site_id',site));tok:=(payload->>'token')::uuid;pin:=payload->>'pin';
 IF length(pin)<>8 OR EXISTS(SELECT 1 FROM public.tracking_portal_links WHERE token=tok AND pin_hash=pin) THEN RAISE EXCEPTION 'CAJA C57 FAIL: PIN sin hash'; END IF;
 UPDATE public.tracking_portal_links SET created_at=now()-interval '365 days' WHERE token=tok;
 result:=public.get_public_tracking_portal_info(tok,pin,current_date,current_date+30);
 IF result->>'mode' IS DISTINCT FROM 'permanent' OR result ? 'error' THEN RAISE EXCEPTION 'CAJA C57 FAIL: enlace permanente vencido'; END IF;
 result:=public.get_public_tracking_portal_info(tok,'bad',current_date,current_date);
 IF NOT result ? 'error' OR (SELECT attempts FROM public.tracking_portal_links WHERE token=tok)<>1 THEN RAISE EXCEPTION 'CAJA C57 FAIL: intentos inválidos no persistidos'; END IF;
 denied:=false;BEGIN PERFORM public.get_public_tracking_portal_info(tok,pin,current_date,current_date+42); EXCEPTION WHEN OTHERS THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'CAJA C57 FAIL: rango sin límite'; END IF;
 -- A full month with 100 routes must fit the anonymous statement budget.
 WITH added AS (INSERT INTO public.dispatches(dispatch_number,vehicle_plate,status,site_id,scheduled_departure)
 SELECT 'ZZ-C57-PERF-'||g,'ZZC57P'||g,'LIQUIDADO',site,now() FROM generate_series(1,100)g RETURNING id)
 INSERT INTO public.dispatch_requests(dispatch_id,transport_request_id,status,sequence_order) SELECT id,ra,'ENTREGADO',1 FROM added;
 started:=clock_timestamp();result:=public.get_public_tracking_portal_info(tok,pin,current_date-1,current_date+1);
 IF jsonb_array_length(result->'rows')<100 OR clock_timestamp()-started>interval '3 seconds' THEN RAISE EXCEPTION 'CAJA C57 FAIL: consulta de 100 rutas excede presupuesto o pierde filas'; END IF;
 -- Public projections retain operational semantics without private submission IDs.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(result->'rows') actual
 JOIN LATERAL jsonb_array_elements(public.delivery_rows_core((actual->>'dispatch_id')::uuid,true)) expected ON expected->>'request_id'=actual->>'request_id'
 WHERE actual->>'state' IS DISTINCT FROM expected->>'state' OR actual->>'conformity' IS DISTINCT FROM expected->>'conformity'
 OR actual->>'documents_state' IS DISTINCT FROM expected->>'documents_state' OR actual->>'submission_id' IS NOT NULL) THEN
 RAISE EXCEPTION 'CAJA C57 FAIL: proyección pública cambia la semántica o expone UUID del sustento'; END IF;
 result:=public.manage_tracking_portal_link(tok,'ROTATE_PIN');
 IF NOT public.get_public_tracking_portal_info(tok,pin,current_date,current_date) ? 'error' THEN RAISE EXCEPTION 'CAJA C57 FAIL: PIN anterior válido'; END IF;
 pin:=result->>'pin';PERFORM public.manage_tracking_portal_link(tok,'REVOKE');
 IF NOT public.get_public_tracking_portal_info(tok,pin,current_date,current_date) ? 'error' THEN RAISE EXCEPTION 'CAJA C57 FAIL: enlace revocado válido'; END IF;
 PERFORM set_config('request.jwt.claim.sub','',true);PERFORM set_config('request.jwt.claims','{}',true);
 denied:=false;BEGIN PERFORM public.generate_tracking_portal_link(jsonb_build_object('site_id',site)); EXCEPTION WHEN OTHERS THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'CAJA C57 FAIL: emisión anónima'; END IF;
 RAISE EXCEPTION 'CAJA C57 PASS: alcance autorizado, PIN hash, persistencia, límite, rotación y revocación';
END $test$;
ROLLBACK;
