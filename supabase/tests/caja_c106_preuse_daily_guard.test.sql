BEGIN;
DO $test$
DECLARE admin_id uuid; actor uuid; driver uuid; site uuid; carrier uuid; unit jsonb; other_unit jsonb;
 data jsonb; r jsonb; operation uuid:=gen_random_uuid(); dispatch uuid; bad boolean; daily_guard boolean:=to_regprocedure('public.get_driver_preuse_daily_status(text)') IS NOT NULL; last_operation uuid; first_operation uuid; grant_id uuid; total_before bigint; previous_claims text;
BEGIN
 IF has_function_privilege('anon','public.submit_driver_preuse(uuid,uuid,timestamptz,jsonb)','EXECUTE')
   OR has_function_privilege('authenticated','public.driver_preuse_select_core(uuid,text)','EXECUTE')
   OR has_function_privilege('authenticated','public.get_active_trip_context_before_preuse()','EXECUTE')
   OR has_table_privilege('authenticated','public.driver_preuse_inspections','INSERT')
   OR has_table_privilege('authenticated','public.driver_preuse_inspections','SELECT') THEN RAISE EXCEPTION 'CAJA C106 FAIL: formato privado expuesto'; END IF;
 FOR admin_id IN SELECT id FROM public.profiles WHERE is_active AND id IN(SELECT id FROM auth.users) LOOP
   PERFORM set_config('request.jwt.claim.sub',admin_id::text,true); EXIT WHEN public.is_tms_admin(); admin_id:=NULL;
 END LOOP;
 SELECT id INTO actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users) AND id<>admin_id AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) LIMIT 1;
 SELECT carrier_id,site_id INTO carrier,site FROM public.vehicles WHERE carrier_id IS NOT NULL AND site_id IS NOT NULL LIMIT 1;
 IF admin_id IS NULL OR actor IS NULL OR site IS NULL THEN RAISE EXCEPTION 'CAJA C106 FAIL: faltan administrador, perfil disponible o sede'; END IF;
 UPDATE public.profiles SET is_active=true,role_id=NULL WHERE id=actor;
 INSERT INTO public.user_site_access(user_id,site_id) VALUES(actor,site) ON CONFLICT DO NOTHING;
 INSERT INTO public.drivers(carrier_id,profile_id,first_name,last_name,document_number,license_number,is_active)
 VALUES(carrier,actor,'Géder Miguel','Amaringo Prueba C106','ZZ-C106-DNI','ZZ-C106-LIC',true) RETURNING id INTO driver;
 INSERT INTO public.vehicles(plate,carrier_id,site_id,type,status,current_odometer,soat_expiration,technical_review_expiration)
 VALUES('ZZC106A',carrier,site,'CAMION','DISPONIBLE',1000,current_date+365,current_date+365),('ZZC106B',carrier,site,'CAMION','DISPONIBLE',1000,current_date+365,current_date+365);
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
 r:=public.get_active_trip_context();
 IF r->'trip' IS DISTINCT FROM 'null'::jsonb OR r->'pending'->>'checklist' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'CAJA C106 FAIL: conductor sin ruta no tiene inspección pendiente'; END IF;
 unit:=public.select_driver_preuse_unit('ZZC106A');
 SELECT jsonb_build_object('format_code','FR-DT 007','format_version','01','license','ZZ-C106-LIC',
   'soat_expiration',current_date+365,'technical_review_expiration',current_date+365,'vehicle_operational',true,
   'observation','Prueba diaria C49','inspector_name','Conductor C106','signature','[[{"x":0.1,"y":0.3},{"x":0.2,"y":0.5},{"x":0.4,"y":0.4},{"x":0.7,"y":0.6}]]'::jsonb,
   'answers',jsonb_agg(jsonb_build_object('code',i.code,'response','B','comment',''))) INTO data FROM public.checklist_items i
   JOIN public.checklist_templates t ON t.id=i.template_id WHERE t.code='FR_DT007';

 SELECT count(*) INTO total_before FROM public.driver_preuse_inspections;
 r:=public.submit_driver_preuse(operation,(unit->>'revision')::uuid,now(),data);
 first_operation:=(r->>'operation_id')::uuid;
 r:=public.submit_driver_preuse(gen_random_uuid(),(unit->>'revision')::uuid,now(),data);
 IF r->>'already_registered' IS DISTINCT FROM 'true' OR (r->>'existing_operation_id')::uuid<>first_operation
 OR (SELECT count(*) FROM public.driver_preuse_inspections)<>total_before+1
 OR (SELECT count(*) FROM public.inspections WHERE driver_id=driver)<>1 THEN
   RAISE EXCEPTION 'CAJA C106 FAIL: segundo envío genera otra inspección o encabezado'; END IF;
 r:=public.get_driver_preuse_daily_status('ZZ-C106 A');
 IF r->>'already_registered' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'CAJA C106 FAIL: normalización placa o estado diario'; END IF;
 bad:=false; BEGIN PERFORM public.authorize_driver_preuse_repeat(first_operation,'Intento de autorización por conductor'); EXCEPTION WHEN OTHERS THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C106 FAIL: conductor autoriza reinspección'; END IF;
 PERFORM set_config('request.jwt.claim.sub',admin_id::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',admin_id,'role','authenticated')::text,true);
 bad:=false; BEGIN PERFORM public.authorize_driver_preuse_repeat(first_operation,'corto'); EXCEPTION WHEN OTHERS THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C106 FAIL: autorización sin motivo'; END IF;
 r:=public.authorize_driver_preuse_repeat(first_operation,'Corrección documentada de prueba autorizada');
 grant_id:=(r->>'authorization_id')::uuid;
 bad:=false; BEGIN PERFORM public.authorize_driver_preuse_repeat(first_operation,'Otra autorización simultánea de prueba'); EXCEPTION WHEN OTHERS THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C106 FAIL: dos autorizaciones pendientes'; END IF;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
 IF public.driver_preuse_can_operate(driver,'ZZC106A') THEN RAISE EXCEPTION 'CAJA C106 FAIL: reinspección pendiente permite operar'; END IF;
 r:=public.get_driver_preuse_daily_status('ZZC106A');
 IF r->>'repeat_authorized' IS DISTINCT FROM 'true' OR r->>'already_registered' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'CAJA C106 FAIL: app no recibe autorización'; END IF;
 r:=public.submit_driver_preuse(gen_random_uuid(),(unit->>'revision')::uuid,now(),data);
 last_operation:=(r->>'operation_id')::uuid;
 IF last_operation=first_operation OR (SELECT consumed_by FROM public.driver_preuse_repeat_authorizations WHERE id=grant_id)<>last_operation
 OR (SELECT count(*) FROM public.driver_preuse_inspections)<>total_before+2 THEN RAISE EXCEPTION 'CAJA C106 FAIL: autorización no es de un solo uso'; END IF;
 SET CONSTRAINTS ALL IMMEDIATE;
 r:=public.submit_driver_preuse(gen_random_uuid(),(unit->>'revision')::uuid,now(),data);
 IF r->>'already_registered' IS DISTINCT FROM 'true' OR (SELECT count(*) FROM public.driver_preuse_inspections)<>total_before+2 THEN RAISE EXCEPTION 'CAJA C106 FAIL: reutiliza autorización consumida'; END IF;
 other_unit:=public.select_driver_preuse_unit('ZZC106B');
 IF public.driver_preuse_can_operate(driver,'ZZC106A') THEN RAISE EXCEPTION 'CAJA C106 FAIL: otra unidad conserva habilitación'; END IF;
 unit:=public.select_driver_preuse_unit('ZZC106A');
 IF unit->>'already_registered' IS DISTINCT FROM 'true' OR NOT public.driver_preuse_can_operate(driver,'ZZC106A') THEN RAISE EXCEPTION 'CAJA C106 FAIL: retorno no reutiliza registro vigente'; END IF;
 PERFORM set_config('request.jwt.claim.sub',admin_id::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',admin_id,'role','authenticated')::text,true);
 r:=public.list_driver_preuse((now() AT TIME ZONE 'America/Lima')::date,(now() AT TIME ZONE 'America/Lima')::date,'geder amaringo ZZ-C106A');
 IF jsonb_array_length(r)<>2 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r)e WHERE e->>'authorized_repeat'='true') THEN RAISE EXCEPTION 'CAJA C106 FAIL: búsqueda normalizada o historial autorizado'; END IF;
 IF NOT public.preuse_search_matches('Géder Miguel Amaringo · BDJ-943 · Auditor Álvarez','geder amaringo BDJ943 alvarez') THEN RAISE EXCEPTION 'CAJA C106 FAIL: búsqueda tildes, placa y palabras'; END IF;
 IF public.preuse_search_matches('Geder BDJ943','otro-conductor') THEN RAISE EXCEPTION 'CAJA C106 FAIL: búsqueda devuelve datos ajenos'; END IF;
 IF has_table_privilege('authenticated','public.driver_preuse_repeat_authorizations','INSERT') OR has_function_privilege('anon','public.authorize_driver_preuse_repeat(uuid,text)','EXECUTE') THEN RAISE EXCEPTION 'CAJA C106 FAIL: permisos expuestos'; END IF;
 IF (SELECT count(*) FROM public.driver_preuse_inspections)<>total_before+2 THEN RAISE EXCEPTION 'CAJA C106 FAIL: se alteró historial ajeno'; END IF;
 RAISE EXCEPTION 'CAJA C106 PASS: unicidad diaria, retorno de unidad, autorización de un uso, bloqueo pendiente, búsqueda y permisos';
END $test$;
ROLLBACK;
