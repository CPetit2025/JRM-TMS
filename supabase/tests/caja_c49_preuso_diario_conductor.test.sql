BEGIN;
DO $test$
DECLARE admin_id uuid; actor uuid; driver uuid; site uuid; carrier uuid; unit jsonb; other_unit jsonb;
 data jsonb; r jsonb; operation uuid:=gen_random_uuid(); dispatch uuid; bad boolean;
BEGIN
 IF has_function_privilege('anon','public.submit_driver_preuse(uuid,uuid,timestamptz,jsonb)','EXECUTE')
   OR has_function_privilege('authenticated','public.driver_preuse_select_core(uuid,text)','EXECUTE')
   OR has_function_privilege('authenticated','public.get_active_trip_context_before_preuse()','EXECUTE')
   OR has_table_privilege('authenticated','public.driver_preuse_inspections','INSERT')
   OR has_table_privilege('authenticated','public.driver_preuse_inspections','SELECT') THEN RAISE EXCEPTION 'CAJA C49 FAIL: formato privado expuesto'; END IF;
 FOR admin_id IN SELECT id FROM public.profiles WHERE is_active AND id IN(SELECT id FROM auth.users) LOOP
   PERFORM set_config('request.jwt.claim.sub',admin_id::text,true); EXIT WHEN public.is_tms_admin(); admin_id:=NULL;
 END LOOP;
 SELECT id INTO actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users) AND id<>admin_id AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) LIMIT 1;
 SELECT carrier_id,site_id INTO carrier,site FROM public.vehicles WHERE carrier_id IS NOT NULL AND site_id IS NOT NULL LIMIT 1;
 IF admin_id IS NULL OR actor IS NULL OR site IS NULL THEN RAISE EXCEPTION 'CAJA C49 FAIL: faltan administrador, perfil disponible o sede'; END IF;
 UPDATE public.profiles SET is_active=true,role_id=NULL WHERE id=actor;
 INSERT INTO public.user_site_access(user_id,site_id) VALUES(actor,site) ON CONFLICT DO NOTHING;
 INSERT INTO public.drivers(carrier_id,profile_id,first_name,last_name,document_number,license_number,is_active)
 VALUES(carrier,actor,'Conductor','C49','ZZ-C49-DNI','ZZ-C49-LIC',true) RETURNING id INTO driver;
 INSERT INTO public.vehicles(plate,carrier_id,site_id,type,status,current_odometer,soat_expiration,technical_review_expiration)
 VALUES('ZZC49A',carrier,site,'CAMION','DISPONIBLE',1000,current_date+365,current_date+365),('ZZC49B',carrier,site,'CAMION','DISPONIBLE',1000,current_date+365,current_date+365);
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
 r:=public.get_active_trip_context();
 IF r->'trip' IS DISTINCT FROM 'null'::jsonb OR r->'pending'->>'checklist' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'CAJA C49 FAIL: conductor sin ruta no tiene inspección pendiente'; END IF;
 unit:=public.select_driver_preuse_unit('ZZC49A');
 SELECT jsonb_build_object('format_code','FR-DT 007','format_version','01','license','ZZ-C49-LIC',
   'soat_expiration',current_date+365,'technical_review_expiration',current_date+365,'vehicle_operational',true,
   'observation','Prueba diaria C49','inspector_name','Conductor C49','signature','[[{"x":0.1,"y":0.3},{"x":0.2,"y":0.5},{"x":0.4,"y":0.4},{"x":0.7,"y":0.6}]]'::jsonb,
   'answers',jsonb_agg(jsonb_build_object('code',i.code,'response','B','comment',''))) INTO data FROM public.checklist_items i
   JOIN public.checklist_templates t ON t.id=i.template_id WHERE t.code='FR_DT007';
 bad:=false;
 BEGIN PERFORM public.submit_driver_preuse(gen_random_uuid(),(unit->>'revision')::uuid,now(),jsonb_set(data,'{answers}',(data->'answers')-0)); EXCEPTION WHEN OTHERS THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C49 FAIL: aceptó formato incompleto'; END IF;
 bad:=false;
 BEGIN PERFORM public.submit_driver_preuse(gen_random_uuid(),(unit->>'revision')::uuid,now(),data-'format_code'); EXCEPTION WHEN OTHERS THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C49 FAIL: aceptó formato sin código'; END IF;
 bad:=false;
 BEGIN PERFORM public.submit_driver_preuse(gen_random_uuid(),(unit->>'revision')::uuid,now()+interval '1 hour',data); EXCEPTION WHEN OTHERS THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C49 FAIL: aceptó fecha futura'; END IF;
 bad:=false;
 BEGIN PERFORM public.submit_driver_preuse(gen_random_uuid(),gen_random_uuid(),now(),data); EXCEPTION WHEN OTHERS THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C49 FAIL: aceptó revisión ajena'; END IF;
 bad:=false;
 BEGIN PERFORM public.submit_driver_preuse(gen_random_uuid(),(unit->>'revision')::uuid,now(),jsonb_set(data,'{signature}','[]')); EXCEPTION WHEN OTHERS THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C49 FAIL: aceptó inspección sin firma'; END IF;
 r:=public.submit_driver_preuse(operation,(unit->>'revision')::uuid,now(),data);
 IF r->>'success' IS DISTINCT FROM 'true' OR r->>'can_operate' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'CAJA C49 FAIL: no guardó inspección diaria sin ruta: %',r; END IF;
 r:=public.submit_driver_preuse(operation,(unit->>'revision')::uuid,now(),data);
 IF r->>'duplicate' IS DISTINCT FROM 'true' OR (SELECT count(*) FROM public.driver_preuse_inspections WHERE operation_id=operation)<>1 THEN RAISE EXCEPTION 'CAJA C49 FAIL: reintento duplica inspección'; END IF;
 r:=public.get_active_trip_context();
 IF r->'trip' IS DISTINCT FROM 'null'::jsonb OR r->'pending'->>'checklist' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'CAJA C49 FAIL: inspección válida depende de la ruta'; END IF;
 other_unit:=public.select_driver_preuse_unit('ZZC49B');
 IF public.driver_preuse_can_operate(driver,'ZZC49A') THEN RAISE EXCEPTION 'CAJA C49 FAIL: cambio de unidad conserva habilitación anterior'; END IF;
 unit:=public.select_driver_preuse_unit('ZZC49A');
 IF public.driver_preuse_can_operate(driver,'ZZC49A') THEN RAISE EXCEPTION 'CAJA C49 FAIL: A-B-A reutiliza inspección anterior'; END IF;
 r:=public.submit_driver_preuse(gen_random_uuid(),(unit->>'revision')::uuid,now(),data);
 -- Yesterday's otherwise valid inspections do not enable today's operations.
 UPDATE public.driver_preuse_inspections SET operation_date=operation_date-1 WHERE driver_id=driver;
 IF public.driver_preuse_can_operate(driver,'ZZC49A') THEN RAISE EXCEPTION 'CAJA C49 FAIL: inspección de ayer habilita operaciones'; END IF;
 UPDATE public.driver_preuse_inspections SET operation_date=operation_date+1 WHERE driver_id=driver;
 INSERT INTO public.dispatches(dispatch_number,driver_id,vehicle_plate,status,site_id,scheduled_departure,docs_required)
 VALUES('ZZ-C49-RUTA',driver,'ZZC49A','PROGRAMADO',site,now(),false) RETURNING id INTO dispatch;
 IF (SELECT status FROM public.dispatches WHERE id=dispatch)<>'PROGRAMADO' THEN RAISE EXCEPTION 'CAJA C49 FAIL: guardar checklist inició ruta'; END IF;
 PERFORM public.start_dispatch_route(dispatch,-12,-77);
 IF (SELECT status FROM public.dispatches WHERE id=dispatch)<>'EN RUTA' OR (SELECT departure_time FROM public.dispatches WHERE id=dispatch) IS NULL THEN RAISE EXCEPTION 'CAJA C49 FAIL: inicio separado no registra salida'; END IF;
 IF NOT public.driver_preuse_departure_recorded(dispatch) THEN RAISE EXCEPTION 'CAJA C49 FAIL: desempeño no cuenta la inspección vigente a la salida'; END IF;
 -- Un cambio de unidad autorizado por Transporte exige nueva inspección antes de iniciar.
 UPDATE public.dispatches SET status='PROGRAMADO',vehicle_plate='ZZC49B' WHERE id=dispatch;
 bad:=false;
 BEGIN PERFORM public.start_dispatch_route(dispatch,-12,-77); EXCEPTION WHEN OTHERS THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C49 FAIL: inicia nueva unidad sin inspección'; END IF;
 unit:=public.select_driver_preuse_unit('ZZC49B');
 r:=public.submit_driver_preuse(gen_random_uuid(),(unit->>'revision')::uuid,now(),jsonb_set(data,'{vehicle_operational}','false'));
 IF r->>'can_operate' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'CAJA C49 FAIL: vehículo NO operativo habilita ruta'; END IF;
 -- El intento no operativo no habilita ni siquiera el cambio de estado directo.
 bad:=false;
 BEGIN UPDATE public.dispatches SET status='EN_CURSO' WHERE id=dispatch; EXCEPTION WHEN OTHERS THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C49 FAIL: cambio directo de estado omite checklist'; END IF;
 r:=public.submit_driver_preuse(gen_random_uuid(),(unit->>'revision')::uuid,now(),jsonb_set(data,'{soat_expiration}',to_jsonb(((now() AT TIME ZONE 'America/Lima')::date-1)::text)));
 IF r->>'can_operate' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'CAJA C49 FAIL: SOAT declarado vencido habilita ruta'; END IF;
 -- M en frenos conserva el dato original y crea la falla por el motor canónico de inspecciones.
 SELECT jsonb_set(data,'{answers}',jsonb_agg(CASE WHEN a->>'code'='i01' THEN jsonb_set(a,'{response}','"M"') ELSE a END)) INTO data FROM jsonb_array_elements(data->'answers') a;
 r:=public.submit_driver_preuse(gen_random_uuid(),(unit->>'revision')::uuid,now(),data);
 IF r->>'can_operate' IS DISTINCT FROM 'false' OR COALESCE((r->>'critical_failures')::int,0)<1 OR NOT EXISTS(
   SELECT 1 FROM public.driver_preuse_inspections d JOIN public.inspection_results ir ON ir.inspection_id=d.inspection_id
   JOIN public.maintenance_requests m ON m.source_ref_id=ir.id WHERE d.operation_id=(r->>'operation_id')::uuid AND ir.response='M' AND m.severity='CRITICA') THEN
   RAISE EXCEPTION 'CAJA C49 FAIL: falla crítica sin bloqueo o trazabilidad'; END IF;
 r:=public.submit_pre_route_checklist(dispatch,'ZZC49B',driver,1000,'{"frenos":"OK"}'::jsonb,NULL);
 IF r->>'success' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'CAJA C49 FAIL: formato legado habilita ruta'; END IF;
 -- Inspecciones de ayer no habilitan hoy; el registro histórico se conserva.
 UPDATE public.driver_preuse_inspections SET operation_date=operation_date-1 WHERE driver_id=driver;
 IF public.driver_preuse_can_operate(driver,'ZZC49B') THEN RAISE EXCEPTION 'CAJA C49 FAIL: inspección de ayer habilita operaciones'; END IF;
 UPDATE public.driver_preuse_inspections SET operation_date=operation_date+1 WHERE driver_id=driver;
 bad:=false;
 BEGIN PERFORM public.list_driver_preuse((now() AT TIME ZONE 'America/Lima')::date,(now() AT TIME ZONE 'America/Lima')::date,'ZZC49'); EXCEPTION WHEN OTHERS THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C49 FAIL: conductor exporta la flota'; END IF;
 PERFORM set_config('request.jwt.claim.sub',admin_id::text,true);
 r:=public.list_driver_preuse((now() AT TIME ZONE 'America/Lima')::date,(now() AT TIME ZONE 'America/Lima')::date,'ZZC49');
 IF jsonb_array_length(r)<>5 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r) d WHERE d->>'vehicle_plate'='ZZC49A') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r) d WHERE d->>'vehicle_plate'='ZZC49B') THEN RAISE EXCEPTION 'CAJA C49 FAIL: exportación fusiona u omite inspecciones/unidades'; END IF;
 bad:=false;
 BEGIN UPDATE public.checklist_items SET text='Alterado' WHERE template_id IN(SELECT id FROM public.checklist_templates WHERE code='FR_DT007'); EXCEPTION WHEN OTHERS THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C49 FAIL: formato modificable'; END IF;
 RAISE EXCEPTION 'CAJA C49 PASS: 34 ítems fijos, conductor sin ruta, día/unidad/A-B-A, registro e inicio separados, falla crítica, idempotencia, permisos y exportación por inspección';
END $test$;
ROLLBACK;
