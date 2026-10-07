BEGIN;
-- El control de anticipación tiene cobertura C56; este caso aísla el motor económico.
UPDATE public.transport_lead_time_settings SET settings=jsonb_set(settings,'{enabled}','false'::jsonb);
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
 plate text:='ZZ58'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,4)); x text; requests jsonb; service uuid; old_services uuid[]; budget_before jsonb; result_context jsonb;
BEGIN
 SELECT id INTO actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users) AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 1;
 SELECT id INTO other_actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users) AND id<>actor AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 1;
 SELECT carrier_id,site_id INTO carrier,site FROM public.vehicles WHERE carrier_id IS NOT NULL AND site_id IS NOT NULL LIMIT 1;
 IF actor IS NULL OR other_actor IS NULL OR site IS NULL THEN RAISE EXCEPTION 'CAJA C58 FAIL: faltan perfiles o sede de prueba'; END IF;
 INSERT INTO public.roles(name,permissions) VALUES('ZZ C58 supervisor','["despacho","clientes"]') RETURNING id INTO test_role;
 UPDATE public.profiles p SET role_id=test_role,is_active=true WHERE p.id=actor;
 INSERT INTO public.user_site_access(user_id,site_id) VALUES(actor,site) ON CONFLICT DO NOTHING;
 ct:=pg_temp.ins('contracts',jsonb_build_object('code','ZZ-C58-A','type','CONTRATO','status','ACTIVO','site_id',site));
 ct2:=pg_temp.ins('contracts',jsonb_build_object('code','ZZ-C58-B','type','CONTRATO','status','ACTIVO','site_id',site));
 INSERT INTO public.contract_budgets(contract_id,concept,allocated_pen) VALUES(ct,'PARTIDA_TRANSPORTE',1000),(ct2,'PARTIDA_TRANSPORTE',1000) ON CONFLICT(contract_id,concept) DO UPDATE SET allocated_pen=1000;
 IF (SELECT balance_pen FROM public.contract_budgets WHERE contract_id=ct AND concept='PARTIDA_TRANSPORTE')<>800 THEN RAISE EXCEPTION 'CAJA C58 FAIL: 1000 brutos no deja 800'; END IF;
 IF public.transport_operating_budget(0.03)<>0.02 THEN RAISE EXCEPTION 'CAJA C58 FAIL: redondeo de céntimos'; END IF;
 bad:=false;
 BEGIN UPDATE public.contract_budgets SET reserved_pen=801 WHERE contract_id=ct AND concept='PARTIDA_TRANSPORTE'; EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C58 FAIL: permite consumir utilidad'; END IF;
 driver:=pg_temp.ins('drivers',jsonb_build_object('carrier_id',carrier,'profile_id',other_actor,'first_name','ZZ','last_name','C58','document_number','ZZ-C58-D1','license_number','ZZ-C58-L1','is_active',true));
 driver2:=pg_temp.ins('drivers',jsonb_build_object('carrier_id',carrier,'first_name','ZZ','last_name','C58B','document_number','ZZ-C58-D2','license_number','ZZ-C58-L2','is_active',true));
 vehicle:=pg_temp.ins('vehicles',jsonb_build_object('plate',plate,'carrier_id',carrier,'site_id',site,'type','CAMION','status','DISPONIBLE','assigned_driver_id',driver));
 vehicle2:=pg_temp.ins('vehicles',jsonb_build_object('plate',plate||'B','carrier_id',carrier,'site_id',site,'type','CAMION','status','DISPONIBLE'));
 IF (SELECT assigned_driver_id FROM public.vehicles WHERE id=vehicle)<>driver THEN RAISE EXCEPTION 'CAJA C58 FAIL: no guarda conductor'; END IF;
 bad:=false;
 BEGIN UPDATE public.vehicles SET assigned_driver_id=driver WHERE id=vehicle2; EXCEPTION WHEN OTHERS THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C58 FAIL: dos unidades para conductor'; END IF;
 bad:=false;
 BEGIN INSERT INTO public.dispatches(dispatch_number,vehicle_plate,driver_name,status,scheduled_departure,modalidad,tercero_doc) VALUES('ZZ-C58-MIX-IDENTIDAD',plate||'X','ZZ','PROGRAMADO',now(),'TERCERO','zz c58 d1'); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C58 FAIL: documento normalizado permite unidad propia y tercera para el mismo conductor'; END IF;
 bad:=false;
 BEGIN INSERT INTO public.dispatches(dispatch_number,vehicle_plate,driver_name,status,scheduled_departure,modalidad,tercero_doc) VALUES('ZZ-C58-DOC-VACIO',plate||'X','ZZ','PROGRAMADO',now(),'TERCERO','---'); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C58 FAIL: permite documento vacío normalizado'; END IF;
 bad:=false;
 BEGIN INSERT INTO public.dispatches(dispatch_number,vehicle_plate,driver_name,status,scheduled_departure,modalidad,tercero_doc) VALUES('ZZ-C58-UNIDAD-OTRO',plate,'Otro','PROGRAMADO',now(),'TERCERO','OTRO-DOC'); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C58 FAIL: tercero ignora conductor asignado a la unidad'; END IF;
 -- Servicios mixtos y dos OT. Se usa proveedor para verificar también identificación sin app.
 provider:=pg_temp.ins('carriers',jsonb_build_object('type','PROVEEDOR','business_name','ZZ C58 tercero','ruc','20'||lpad((floor(random()*1e9))::bigint::text,9,'0'),'tax_id','20'||lpad((floor(random()*1e9))::bigint::text,9,'0'),'is_active',true));
 req:=pg_temp.ins('transport_requests',jsonb_build_object('request_number','ZZ-C58-R1','request_type','DESPACHO','attention_mode','TRANSPORTE_JRM','status','APROBADA','approved_at',now(),'site_id',site,'contract_id',ct,'requester_name','ZZ','department','Logística','cargo_description','Prueba','pickup_address','Planta','delivery_address','Obra','required_date',current_date+1));
 req2:=pg_temp.ins('transport_requests',jsonb_build_object('request_number','ZZ-C58-R2','request_type','RECOJO','attention_mode','TRANSPORTE_JRM','status','APROBADA','approved_at',now(),'site_id',site,'contract_id',ct2,'requester_name','ZZ','department','Logística','cargo_description','Prueba','pickup_address','Obra','delivery_address','Planta','required_date',current_date+1));
 req3:=pg_temp.ins('transport_requests',jsonb_build_object('request_number','ZZ-C58-R3','request_type','TRASLADO','attention_mode','TRANSPORTE_JRM','status','APROBADA','approved_at',now(),'site_id',site,'contract_id',ct2,'requester_name','ZZ','department','Logística','cargo_description','Prueba','pickup_address','Obra','delivery_address','Otra obra','required_date',current_date+1));
 requests:=jsonb_build_array(jsonb_build_object('id',req,'freight_share_pen',300),jsonb_build_object('id',req2,'freight_share_pen',200),jsonb_build_object('id',req3,'freight_share_pen',100));
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 bad:=false;
 BEGIN PERFORM public.schedule_dispatch_tercero(provider,plate||'T','ZZ','999888777','ZZ58DOC',now(),20,601,ct,requests); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C58 FAIL: distribución no cuadra'; END IF;
 route:=public.schedule_dispatch_tercero(provider,plate||'T','ZZ','999888777','ZZ58DOC',now(),20,600,ct,requests);
 IF (SELECT count(*) FROM public.dispatch_requests WHERE dispatch_id=route)<>3 OR (SELECT contract_id FROM public.dispatches WHERE id=route) IS NOT NULL
   OR (SELECT reserved_pen FROM public.contract_budgets WHERE contract_id=ct)<>300 OR (SELECT reserved_pen FROM public.contract_budgets WHERE contract_id=ct2)<>300 THEN RAISE EXCEPTION 'CAJA C58 FAIL: ruta mixta no reserva por OT'; END IF;

 -- La programación genera compromisos, no servicios realizados ni pagos.
 SELECT array_agg(id) INTO old_services FROM public.contract_services WHERE dispatch_id=route;
 result_context:=public.get_service_registry_context(old_services);
 IF jsonb_array_length(result_context)<>3 OR EXISTS(SELECT 1 FROM jsonb_array_elements(result_context) e WHERE e->>'stage'<>'COMPROMETIDO' OR jsonb_array_length(e->'request_numbers')<>1) THEN RAISE EXCEPTION 'CAJA C58 FAIL: estado/identidad de ruta mixta'; END IF;
 SELECT jsonb_agg(to_jsonb(b) ORDER BY contract_id) INTO budget_before FROM public.contract_budgets b WHERE contract_id IN(ct,ct2);
 -- Simulación de vínculo perdido: se restituye sin descontar de nuevo la reserva.
 UPDATE public.dispatch_request_freight SET service_id=NULL WHERE dispatch_id=route;
 DELETE FROM public.contract_services WHERE id=ANY(old_services);
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(public.get_dispatch_freight_reconciliation_queue()) e WHERE e->>'id'=route::text) THEN RAISE EXCEPTION 'CAJA C58 FAIL: omite ruta de múltiples OT'; END IF;
 r:=public.reconcile_dispatch_freight(route);
 IF (r->>'created')::int<>3 OR (public.reconcile_dispatch_freight(route)->>'created')::int<>0
 OR (SELECT count(*) FROM public.contract_services WHERE dispatch_id=route)<>3
 OR budget_before IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(b) ORDER BY contract_id) FROM public.contract_budgets b WHERE contract_id IN(ct,ct2)) THEN RAISE EXCEPTION 'CAJA C58 FAIL: recuperación duplica registros o cambia presupuesto'; END IF;
 -- Cerrar sin guía validada queda bloqueado por las reglas existentes.
 bad:=false;
 BEGIN UPDATE public.dispatch_requests SET status='ENTREGADO' WHERE dispatch_id=route; EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C58 FAIL: entrega sin conformidad'; END IF;
 INSERT INTO public.delivery_conformities(dispatch_id,request_id,state) VALUES(route,req,'VALIDADA'),(route,req2,'VALIDADA'),(route,req3,'VALIDADA') ON CONFLICT(dispatch_id,request_id) DO UPDATE SET state='VALIDADA';
 UPDATE public.dispatch_requests SET status='ENTREGADO' WHERE dispatch_id=route;
 UPDATE public.dispatches SET docs_required=false,status='ENTREGADO' WHERE id=route;
 PERFORM public.close_dispatch_route(route); PERFORM public.close_dispatch_route(route);
 IF (SELECT consumed_pen FROM public.contract_budgets WHERE contract_id=ct)<>300 OR (SELECT consumed_pen FROM public.contract_budgets WHERE contract_id=ct2)<>300 OR EXISTS(SELECT 1 FROM public.contract_budgets WHERE contract_id IN(ct,ct2) AND reserved_pen<>0) THEN RAISE EXCEPTION 'CAJA C58 FAIL: cierre descuenta dos veces'; END IF;
 SELECT array_agg(id) INTO old_services FROM public.contract_services WHERE dispatch_id=route;
 result_context:=public.get_service_registry_context(old_services);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(result_context) e WHERE e->>'stage'<>'REALIZADO') THEN RAISE EXCEPTION 'CAJA C58 FAIL: cierre con conformidad no realizado'; END IF;
 SELECT jsonb_agg(to_jsonb(b) ORDER BY contract_id) INTO budget_before FROM public.contract_budgets b WHERE contract_id IN(ct,ct2);
 UPDATE public.dispatch_request_freight SET service_id=NULL WHERE dispatch_id=route;
 DELETE FROM public.contract_services WHERE id=ANY(old_services);
 PERFORM public.reconcile_dispatch_freight(route); PERFORM public.reconcile_dispatch_freight(route);
 IF budget_before IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(b) ORDER BY contract_id) FROM public.contract_budgets b WHERE contract_id IN(ct,ct2)) THEN RAISE EXCEPTION 'CAJA C58 FAIL: restauración de cerrado vuelve a consumir'; END IF;
 -- Usuario inactivo no obtiene lectura ni escritura mediante un RPC privilegiado.
 UPDATE public.profiles SET is_active=false WHERE id=actor;
 bad:=false;
 BEGIN PERFORM public.reconcile_dispatch_freight(route); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C58 FAIL: escritura usuario inactivo'; END IF;
 bad:=false;
 BEGIN PERFORM public.get_service_registry_context(old_services); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C58 FAIL: lectura usuario inactivo'; END IF;
 UPDATE public.profiles SET is_active=true WHERE id=actor;
 -- Ruta de una sola OT: recuperación idempotente, luego cancelación libera reserva.
 PERFORM set_config('request.jwt.claim.sub','',true);
 UPDATE public.transport_requests SET status='APROBADA',approved_at=now() WHERE id=req;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 route:=public.schedule_dispatch_tercero(provider,plate||'T','ZZ','999888777','ZZ58DOC',now(),20,100,ct,jsonb_build_array(jsonb_build_object('id',req,'freight_share_pen',100)));
 SELECT id INTO service FROM public.contract_services WHERE dispatch_id=route LIMIT 1;
 UPDATE public.contract_services SET dispatch_id=NULL WHERE id=service;
 bad:=false;
 BEGIN PERFORM public.reconcile_dispatch_freight(route); EXCEPTION WHEN raise_exception THEN bad:=SQLERRM LIKE '%sin vínculo%'; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C58 FAIL: duplica un flete que perdió vínculo de despacho'; END IF;
 UPDATE public.contract_services SET dispatch_id=route WHERE id=service;
 DELETE FROM public.contract_services WHERE dispatch_id=route;
 PERFORM public.reconcile_dispatch_freight(route); PERFORM public.reconcile_dispatch_freight(route);
 IF (SELECT count(*) FROM public.contract_services WHERE dispatch_id=route)<>1 OR (SELECT reserved_pen FROM public.contract_budgets WHERE contract_id=ct)<>100 THEN RAISE EXCEPTION 'CAJA C58 FAIL: flete una OT no idempotente'; END IF;
 r:=public.cancel_dispatch(route,'Prueba de cancelación');
 IF r->>'success'<>'true' OR (SELECT reserved_pen FROM public.contract_budgets WHERE contract_id=ct)<>0 THEN RAISE EXCEPTION 'CAJA C58 FAIL: cancelación no libera'; END IF;
 bad:=false;
 BEGIN PERFORM public.reconcile_dispatch_freight(route); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C58 FAIL: restituye cargo cancelado'; END IF;
 IF has_function_privilege('anon','public.reconcile_dispatch_freight(uuid)','EXECUTE') THEN RAISE EXCEPTION 'CAJA C58 FAIL: RPC público'; END IF;
 RAISE EXCEPTION 'CAJA C58 PASS: registro, conformidad, recuperación atómica y presupuesto sin doble descuento';
END $test$;
ROLLBACK;
