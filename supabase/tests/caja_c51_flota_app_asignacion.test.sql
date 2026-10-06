BEGIN;
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

-- Inserta solo las columnas que existen (el esquema de producción difiere del repositorio)
CREATE FUNCTION pg_temp.ins(p_table text, p_cols jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  EXECUTE (SELECT format('INSERT INTO public.%I (%s) VALUES (%s) RETURNING id', p_table,
                         string_agg(quote_ident(k.key), ', '), string_agg(quote_nullable(k.value #>> '{}'), ', '))
           FROM jsonb_each(p_cols) k
           WHERE EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema = 'public' AND ic.table_name = p_table AND ic.column_name = k.key))
  INTO v_id;
  RETURN v_id;
END $$;

DO $test$
DECLARE actor uuid; other_actor uuid; site uuid; carrier uuid; driver uuid; driver2 uuid; vehicle uuid; vehicle2 uuid;
 plate text:='ZZ51'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,5)); unit jsonb; next_unit jsonb; r jsonb; data jsonb; bad boolean; operation uuid:=gen_random_uuid();
BEGIN
 SELECT id INTO actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users) AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 1;
 SELECT id INTO other_actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users) AND id<>actor AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 1;
 SELECT carrier_id,site_id INTO carrier,site FROM public.vehicles WHERE carrier_id IS NOT NULL AND site_id IS NOT NULL LIMIT 1;
 IF actor IS NULL OR other_actor IS NULL OR site IS NULL THEN RAISE EXCEPTION 'CAJA C51 FAIL: faltan perfiles o sede'; END IF;
 UPDATE public.profiles SET is_active=true,role_id=NULL WHERE id IN(actor,other_actor);
 INSERT INTO public.user_site_access(user_id,site_id) VALUES(actor,site),(other_actor,site) ON CONFLICT DO NOTHING;
 driver:=pg_temp.ins('drivers',jsonb_build_object('carrier_id',carrier,'profile_id',actor,'first_name','Victor','last_name','Prueba C51','document_number',plate||'D1','license_number',plate||'LIC1','is_active',true));
 driver2:=pg_temp.ins('drivers',jsonb_build_object('carrier_id',carrier,'first_name','Segundo','last_name','Prueba C51','document_number',plate||'D2','license_number',plate||'LIC2','is_active',true));
 vehicle:=pg_temp.ins('vehicles',jsonb_build_object('plate',plate,'carrier_id',carrier,'site_id',site,'type','CAMION','status','DISPONIBLE','assigned_driver_id',driver,'current_odometer',1000,'soat_expiration',current_date+365,'technical_review_expiration',current_date+365));
 vehicle2:=pg_temp.ins('vehicles',jsonb_build_object('plate',plate||'B','carrier_id',carrier,'site_id',site,'type','CAMION','status','DISPONIBLE','current_odometer',1000,'soat_expiration',current_date+365,'technical_review_expiration',current_date+365));
 IF (SELECT vehicle_plate FROM public.driver_preuse_units WHERE driver_id=driver) IS DISTINCT FROM plate THEN RAISE EXCEPTION 'CAJA C51 FAIL: asignación en Flota no llega al app sin ruta'; END IF;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
 r:=public.get_active_trip_context();
 IF r->'trip' IS DISTINCT FROM 'null'::jsonb OR r->'assigned_unit'->>'plate' IS DISTINCT FROM plate THEN RAISE EXCEPTION 'CAJA C51 FAIL: Inicio no recibe unidad sin ruta: %',r; END IF;
 r:=public.get_driver_preuse_context(); unit:=r->'unit';
 IF jsonb_array_length(r->'vehicles')<>1 OR r->'vehicles'->0->>'plate' IS DISTINCT FROM plate THEN RAISE EXCEPTION 'CAJA C51 FAIL: app mezcla unidades pese a asignación'; END IF;
 bad:=false;
 BEGIN PERFORM public.select_driver_preuse_unit(plate||'B'); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C51 FAIL: sustituye unidad asignada desde app'; END IF;
 SELECT jsonb_build_object('format_code','FR-DT 007','format_version','01','license','ZZ C51 LIC','soat_expiration',current_date+365,
 'technical_review_expiration',current_date+365,'vehicle_operational',true,'observation','Prueba C51','inspector_name','Victor C51',
 'signature','[[{"x":0.1,"y":0.3},{"x":0.2,"y":0.5},{"x":0.4,"y":0.4},{"x":0.7,"y":0.6}]]'::jsonb,
 'answers',jsonb_agg(jsonb_build_object('code',i.code,'response','B','comment',''))) INTO data FROM public.checklist_items i JOIN public.checklist_templates t ON t.id=i.template_id WHERE t.code='FR_DT007';
 r:=public.submit_driver_preuse(operation,(unit->>'revision')::uuid,now(),data);
 IF r->>'can_operate' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'CAJA C51 FAIL: inspección correcta no habilita unidad'; END IF;
 -- Guardar otros datos o leer el contexto no invalida la inspección de la misma unidad/día.
 UPDATE public.vehicles SET assigned_driver_id=driver WHERE id=vehicle;
 r:=public.get_driver_preuse_context();
 IF r->'unit'->>'revision' IS DISTINCT FROM unit->>'revision' OR r->>'pending' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'CAJA C51 FAIL: sincronización repetida invalida inspección'; END IF;
 UPDATE public.vehicles SET assigned_driver_id=NULL WHERE id=vehicle;
 UPDATE public.vehicles SET assigned_driver_id=driver WHERE id=vehicle2;
 r:=public.get_driver_preuse_context(); next_unit:=r->'unit';
 IF next_unit->>'vehicle_plate' IS DISTINCT FROM plate||'B' OR next_unit->>'revision'=unit->>'revision' OR r->>'pending' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'CAJA C51 FAIL: cambio A-B reutiliza checklist'; END IF;
 UPDATE public.vehicles SET assigned_driver_id=NULL WHERE id=vehicle2;
 UPDATE public.vehicles SET assigned_driver_id=driver WHERE id=vehicle;
 r:=public.get_driver_preuse_context();
 IF r->>'pending' IS DISTINCT FROM 'true' OR r->'unit'->>'revision'=unit->>'revision' THEN RAISE EXCEPTION 'CAJA C51 FAIL: A-B-A reutiliza checklist'; END IF;
 UPDATE public.vehicles SET assigned_driver_id=driver2 WHERE id=vehicle;
 r:=public.get_driver_preuse_context();
 IF r->'assigned_unit' IS DISTINCT FROM 'null'::jsonb OR r->'unit' IS DISTINCT FROM 'null'::jsonb OR EXISTS(SELECT 1 FROM jsonb_array_elements(r->'vehicles') v WHERE v->>'plate'=plate) THEN RAISE EXCEPTION 'CAJA C51 FAIL: antiguo conductor conserva unidad'; END IF;
 bad:=false;
 BEGIN PERFORM public.select_driver_preuse_unit(plate); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C51 FAIL: conductor selecciona unidad de otro'; END IF;
 -- Cuenta del app vinculada después de la asignación, sin guardar nuevamente el vehículo.
 UPDATE public.drivers SET profile_id=other_actor WHERE id=driver2;
 PERFORM set_config('request.jwt.claim.sub',other_actor::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',other_actor,'role','authenticated')::text,true);
 r:=public.get_active_trip_context();
 IF r->'assigned_unit'->>'plate' IS DISTINCT FROM plate THEN RAISE EXCEPTION 'CAJA C51 FAIL: vinculación tardía requiere reasignar vehículo'; END IF;
 -- Mismo motor utilizado para recuperar asignaciones ya guardadas antes de esta migración.
 DELETE FROM public.driver_preuse_units WHERE driver_id=driver2;
 PERFORM public.fleet_sync_driver_unit(driver2);
 IF (SELECT vehicle_plate FROM public.driver_preuse_units WHERE driver_id=driver2) IS DISTINCT FROM plate THEN RAISE EXCEPTION 'CAJA C51 FAIL: backfill no sincroniza'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.driver_preuse_inspections WHERE operation_id=operation) THEN RAISE EXCEPTION 'CAJA C51 FAIL: cambio de conductor destruye historial'; END IF;
 IF has_function_privilege('authenticated','public.fleet_sync_driver_unit(uuid)','EXECUTE')
 OR has_function_privilege('authenticated','public.get_driver_preuse_context_before_fleet()','EXECUTE')
 OR has_function_privilege('authenticated','public.select_driver_preuse_unit_before_fleet(text)','EXECUTE')
 OR has_function_privilege('anon','public.get_driver_preuse_context()','EXECUTE') THEN RAISE EXCEPTION 'CAJA C51 FAIL: motor privado expuesto'; END IF;
 RAISE EXCEPTION 'CAJA C51 PASS: Flota-app sin ruta, exclusividad, cambios de unidad, cuenta tardía, backfill e historial';
END $test$;
ROLLBACK;
