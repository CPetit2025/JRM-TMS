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

-- Test-only temporary helpers: public execution defaults are intentionally revoked.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE actor uuid; other_actor uuid; site uuid; carrier uuid; provider uuid; test_role uuid; driver uuid; driver2 uuid;
 vehicle uuid; vehicle2 uuid; ct uuid; ct2 uuid; req uuid; req2 uuid; req3 uuid; route uuid; r jsonb; bad boolean;
 plate text:='ZZ50'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,4)); x text; requests jsonb; service uuid;
BEGIN
 SELECT id INTO actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users) AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 1;
 SELECT id INTO other_actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users) AND id<>actor AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 1;
 SELECT carrier_id,site_id INTO carrier,site FROM public.vehicles WHERE carrier_id IS NOT NULL AND site_id IS NOT NULL LIMIT 1;
 IF actor IS NULL OR other_actor IS NULL OR site IS NULL THEN RAISE EXCEPTION 'CAJA C50 FAIL: faltan perfiles o sede de prueba'; END IF;
 INSERT INTO public.roles(name,permissions) VALUES('ZZ C50 supervisor','["despacho","clientes"]') RETURNING id INTO test_role;
 UPDATE public.profiles p SET role_id=test_role,is_active=true WHERE p.id=actor;
 INSERT INTO public.user_site_access(user_id,site_id) VALUES(actor,site) ON CONFLICT DO NOTHING;
 ct:=pg_temp.ins('contracts',jsonb_build_object('code','ZZ-C50-A','type','CONTRATO','status','ACTIVO','site_id',site));
 ct2:=pg_temp.ins('contracts',jsonb_build_object('code','ZZ-C50-B','type','CONTRATO','status','ACTIVO','site_id',site));
 INSERT INTO public.contract_budgets(contract_id,concept,allocated_pen) VALUES(ct,'PARTIDA_TRANSPORTE',1000),(ct2,'PARTIDA_TRANSPORTE',1000) ON CONFLICT(contract_id,concept) DO UPDATE SET allocated_pen=1000;
 IF (SELECT balance_pen FROM public.contract_budgets WHERE contract_id=ct AND concept='PARTIDA_TRANSPORTE')<>800 THEN RAISE EXCEPTION 'CAJA C50 FAIL: 1000 brutos no deja 800'; END IF;
 IF public.transport_operating_budget(0.03)<>0.02 THEN RAISE EXCEPTION 'CAJA C50 FAIL: redondeo de céntimos'; END IF;
 bad:=false;
 BEGIN UPDATE public.contract_budgets SET reserved_pen=801 WHERE contract_id=ct AND concept='PARTIDA_TRANSPORTE'; EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C50 FAIL: permite consumir utilidad'; END IF;
 driver:=pg_temp.ins('drivers',jsonb_build_object('carrier_id',carrier,'profile_id',other_actor,'first_name','ZZ','last_name','C50','document_number','ZZ-C50-D1','license_number','ZZ-C50-L1','is_active',true));
 driver2:=pg_temp.ins('drivers',jsonb_build_object('carrier_id',carrier,'first_name','ZZ','last_name','C50B','document_number','ZZ-C50-D2','license_number','ZZ-C50-L2','is_active',true));
 vehicle:=pg_temp.ins('vehicles',jsonb_build_object('plate',plate,'carrier_id',carrier,'site_id',site,'type','CAMION','status','DISPONIBLE','assigned_driver_id',driver));
 vehicle2:=pg_temp.ins('vehicles',jsonb_build_object('plate',plate||'B','carrier_id',carrier,'site_id',site,'type','CAMION','status','DISPONIBLE'));
 IF (SELECT assigned_driver_id FROM public.vehicles WHERE id=vehicle)<>driver THEN RAISE EXCEPTION 'CAJA C50 FAIL: no guarda conductor'; END IF;
 bad:=false;
 BEGIN UPDATE public.vehicles SET assigned_driver_id=driver WHERE id=vehicle2; EXCEPTION WHEN OTHERS THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C50 FAIL: dos unidades para conductor'; END IF;
 bad:=false;
 BEGIN INSERT INTO public.dispatches(dispatch_number,vehicle_plate,driver_name,status,scheduled_departure,modalidad,tercero_doc) VALUES('ZZ-C50-MIX-IDENTIDAD',plate||'X','ZZ','PROGRAMADO',now(),'TERCERO','zz c50 d1'); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C50 FAIL: documento normalizado permite unidad propia y tercera para el mismo conductor'; END IF;
 bad:=false;
 BEGIN INSERT INTO public.dispatches(dispatch_number,vehicle_plate,driver_name,status,scheduled_departure,modalidad,tercero_doc) VALUES('ZZ-C50-DOC-VACIO',plate||'X','ZZ','PROGRAMADO',now(),'TERCERO','---'); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C50 FAIL: permite documento vacío normalizado'; END IF;
 bad:=false;
 BEGIN INSERT INTO public.dispatches(dispatch_number,vehicle_plate,driver_name,status,scheduled_departure,modalidad,tercero_doc) VALUES('ZZ-C50-UNIDAD-OTRO',plate,'Otro','PROGRAMADO',now(),'TERCERO','OTRO-DOC'); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C50 FAIL: tercero ignora conductor asignado a la unidad'; END IF;
 -- Servicios mixtos y dos OT. Se usa proveedor para verificar también identificación sin app.
 provider:=pg_temp.ins('carriers',jsonb_build_object('type','PROVEEDOR','business_name','ZZ C50 tercero','ruc','20'||lpad((floor(random()*1e9))::bigint::text,9,'0'),'tax_id','20'||lpad((floor(random()*1e9))::bigint::text,9,'0'),'is_active',true));
 req:=pg_temp.ins('transport_requests',jsonb_build_object('request_number','ZZ-C50-R1','request_type','DESPACHO','attention_mode','TRANSPORTE_JRM','status','APROBADA','approved_at',now(),'site_id',site,'contract_id',ct,'requester_name','ZZ','department','Logística','cargo_description','Prueba','pickup_address','Planta','delivery_address','Obra','required_date',current_date+1));
 req2:=pg_temp.ins('transport_requests',jsonb_build_object('request_number','ZZ-C50-R2','request_type','RECOJO','attention_mode','TRANSPORTE_JRM','status','APROBADA','approved_at',now(),'site_id',site,'contract_id',ct2,'requester_name','ZZ','department','Logística','cargo_description','Prueba','pickup_address','Obra','delivery_address','Planta','required_date',current_date+1));
 req3:=pg_temp.ins('transport_requests',jsonb_build_object('request_number','ZZ-C50-R3','request_type','TRASLADO','attention_mode','TRANSPORTE_JRM','status','APROBADA','approved_at',now(),'site_id',site,'contract_id',ct2,'requester_name','ZZ','department','Logística','cargo_description','Prueba','pickup_address','Obra','delivery_address','Otra obra','required_date',current_date+1));
 requests:=jsonb_build_array(jsonb_build_object('id',req,'freight_share_pen',300),jsonb_build_object('id',req2,'freight_share_pen',200),jsonb_build_object('id',req3,'freight_share_pen',100));
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 bad:=false;
 BEGIN PERFORM public.schedule_dispatch_tercero(provider,plate||'T','ZZ','999888777','ZZ50DOC',now(),20,601,ct,requests); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C50 FAIL: distribución no cuadra'; END IF;
 route:=public.schedule_dispatch_tercero(provider,plate||'T','ZZ','999888777','ZZ50DOC',now(),20,600,ct,requests);
 IF (SELECT count(*) FROM public.dispatch_requests WHERE dispatch_id=route)<>3 OR (SELECT contract_id FROM public.dispatches WHERE id=route) IS NOT NULL
   OR (SELECT reserved_pen FROM public.contract_budgets WHERE contract_id=ct)<>300 OR (SELECT reserved_pen FROM public.contract_budgets WHERE contract_id=ct2)<>300 THEN RAISE EXCEPTION 'CAJA C50 FAIL: ruta mixta no reserva por OT'; END IF;
 -- Incluso con otro vehículo, el mismo chofer tercero no tiene otra ruta activa.
 bad:=false;
 BEGIN INSERT INTO public.dispatches(dispatch_number,vehicle_plate,driver_name,status,scheduled_departure,modalidad,tercero_doc) VALUES('ZZ-C50-CONFLICTO',plate||'X','ZZ','PROGRAMADO',now(),'TERCERO','ZZ50DOC'); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C50 FAIL: chofer tercero en dos unidades'; END IF;
 r:=public.plan_dispatch_unloading(route,jsonb_build_array(jsonb_build_object('request_id',req,'concept','ESTIBA','planned_pen',50),jsonb_build_object('request_id',req2,'concept','ESTIBA','planned_pen',70)));
 IF r->>'success'<>'true' OR (SELECT reserved_pen FROM public.contract_budgets WHERE contract_id=ct)<>350 OR (SELECT reserved_pen FROM public.contract_budgets WHERE contract_id=ct2)<>370 THEN RAISE EXCEPTION 'CAJA C50 FAIL: descargas a OT incorrecta: %',r; END IF;
 r:=public.plan_dispatch_unloading(route,'[]');
 IF r->>'success'<>'true' OR (SELECT reserved_pen FROM public.contract_budgets WHERE contract_id=ct)<>300 OR (SELECT reserved_pen FROM public.contract_budgets WHERE contract_id=ct2)<>300 THEN RAISE EXCEPTION 'CAJA C50 FAIL: retiro descargas'; END IF;
 PERFORM public.set_transport_request_status(req3,'REPROGRAMADA',(now() AT TIME ZONE 'America/Lima')::date+2);
 IF (SELECT freight_cost FROM public.dispatches WHERE id=route)<>500 OR (SELECT reserved_pen FROM public.contract_budgets WHERE contract_id=ct2)<>200 THEN RAISE EXCEPTION 'CAJA C50 FAIL: retiro no libera flete'; END IF;
 r:=public.cancel_dispatch(route,'Cambio de fecha y pareja; reconstruir ruta');
 IF r->>'success'<>'true' OR EXISTS(SELECT 1 FROM public.contract_budgets WHERE contract_id IN(ct,ct2) AND reserved_pen<>0) THEN RAISE EXCEPTION 'CAJA C50 FAIL: cancelación no libera ambas OT: %',r; END IF;
 -- Segunda programación: cierre consume solo la participación de cada OT, una sola vez.
 requests:=jsonb_build_array(jsonb_build_object('id',req,'freight_share_pen',300),jsonb_build_object('id',req2,'freight_share_pen',200));
 route:=public.schedule_dispatch_tercero(provider,plate||'T','ZZ','999888777','ZZ50DOC',now(),20,500,ct,requests);
 INSERT INTO public.delivery_conformities(dispatch_id,request_id,state) VALUES(route,req,'VALIDADA'),(route,req2,'VALIDADA') ON CONFLICT(dispatch_id,request_id) DO UPDATE SET state='VALIDADA';
 UPDATE public.dispatch_requests SET status='ENTREGADO' WHERE dispatch_id=route;
 UPDATE public.dispatches SET docs_required=false,status='ENTREGADO' WHERE id=route;
 PERFORM public.close_dispatch_route(route); PERFORM public.close_dispatch_route(route);
 IF EXISTS(SELECT 1 FROM public.contract_budgets WHERE contract_id IN(ct,ct2) AND reserved_pen<>0)
   OR (SELECT consumed_pen FROM public.contract_budgets WHERE contract_id=ct)<>300 OR (SELECT balance_pen FROM public.contract_budgets WHERE contract_id=ct)<>500
   OR (SELECT consumed_pen FROM public.contract_budgets WHERE contract_id=ct2)<>200 OR (SELECT balance_pen FROM public.contract_budgets WHERE contract_id=ct2)<>600 THEN
   RAISE EXCEPTION 'CAJA C50 FAIL: consumo doble o OT incorrecta';
 END IF;
 -- Flota propia: una pareja reúne tres servicios sin crear tres rutas, y no se puede duplicar.
 PERFORM set_config('request.jwt.claim.sub','',true);
 UPDATE public.transport_requests SET status='APROBADA',approved_at=now() WHERE id IN(req,req2,req3);
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 route:=public.schedule_dispatch(driver,plate,now(),30,300,ct,'GR',jsonb_build_array(jsonb_build_object('id',req,'freight_share_pen',100),jsonb_build_object('id',req2,'freight_share_pen',100),jsonb_build_object('id',req3,'freight_share_pen',100)));
 IF (SELECT count(*) FROM public.dispatch_requests WHERE dispatch_id=route)<>3 THEN RAISE EXCEPTION 'CAJA C50 FAIL: pareja propia no admite tres servicios'; END IF;
 bad:=false;
 BEGIN UPDATE public.vehicles SET assigned_driver_id=driver2 WHERE id=vehicle; EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C50 FAIL: cambia conductor con ruta activa'; END IF;
 bad:=false;
 BEGIN UPDATE public.dispatches SET driver_id=driver2 WHERE id=route; EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C50 FAIL: dos conductores para unidad asignada'; END IF;
 r:=public.cancel_dispatch(route,'Sustitución antes de salir');
 IF r->>'success'<>'true' THEN RAISE EXCEPTION 'CAJA C50 FAIL: cancelación propia: %',r; END IF;
 IF has_table_privilege('authenticated','public.dispatch_request_freight','INSERT') OR has_function_privilege('authenticated','public.reserve_mixed_dispatch(uuid,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'CAJA C50 FAIL: motor privado expuesto'; END IF;
 RAISE EXCEPTION 'CAJA C50 PASS: partida 80%%, flota, exclusividad, ruta mixta, descargas por OT, retiro, cancelación y cierre idempotente';
END $test$;
ROLLBACK;
