BEGIN;
-- Isolate this legacy scenario from the separately tested mandatory anticipation policy.
-- The change is transaction-local and is rolled back with every fixture.
DO $legacy_policy$ BEGIN
 IF to_regclass('public.transport_lead_time_settings') IS NOT NULL THEN
  EXECUTE 'UPDATE public.transport_lead_time_settings SET settings=jsonb_set(settings,''{enabled}'',''false''::jsonb)';
 END IF;
END $legacy_policy$;
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
DECLARE actor uuid; driver_actor uuid; site uuid; carrier uuid; provider uuid; client uuid; supplier uuid; readonly_role uuid; test_role uuid; ct uuid; ct2 uuid; sub uuid;
 req uuid; req2 uuid; added uuid; rejected uuid; route uuid; context jsonb; result jsonb; operation uuid:=gen_random_uuid();
 bad boolean; driver uuid; own1 uuid; own2 uuid; unit jsonb; inspection jsonb; original_code text; original_token text; balance numeric; plate text:='ZZ80'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
BEGIN
 SELECT id INTO actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users) AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 1;
 SELECT id INTO driver_actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users) AND id<>actor AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 1;
 SELECT id INTO client FROM public.clients ORDER BY id LIMIT 1;
 SELECT id INTO supplier FROM public.suppliers ORDER BY id LIMIT 1;
 SELECT carrier_id,site_id INTO carrier,site FROM public.vehicles WHERE carrier_id IS NOT NULL AND site_id IS NOT NULL LIMIT 1;
 IF actor IS NULL OR driver_actor IS NULL OR site IS NULL OR client IS NULL OR supplier IS NULL THEN RAISE EXCEPTION 'CAJA C80 FAIL: faltan perfiles o sede'; END IF;
 SELECT id INTO test_role FROM public.roles WHERE name='Supervisor de Transporte' LIMIT 1;
 IF test_role IS NULL THEN INSERT INTO public.roles(name,permissions) VALUES('Supervisor de Transporte','["despacho","torre-control"]') RETURNING id INTO test_role; END IF;
 UPDATE public.roles SET permissions='["despacho","torre-control"]' WHERE id=test_role;
 UPDATE public.profiles SET role_id=test_role,is_active=true WHERE id=actor;
 INSERT INTO public.user_site_access(user_id,site_id) VALUES(actor,site) ON CONFLICT DO NOTHING;
 ct:=pg_temp.ins('contracts',jsonb_build_object('code','ZZ-C80-A','type','CONTRATO','status','ACTIVO','site_id',site,'client_id',client));
 ct2:=pg_temp.ins('contracts',jsonb_build_object('code','ZZ-C80-B','type','CONTRATO','status','ACTIVO','site_id',site,'client_id',client));
 sub:=pg_temp.ins('contracts',jsonb_build_object('code','ZZ-C80-B-E014','type','ERROR','status','ACTIVO','site_id',site,'client_id',client,'parent_contract_id',ct2));
 INSERT INTO public.contract_budgets(contract_id,concept,allocated_pen) VALUES(ct,'PARTIDA_TRANSPORTE',1000),(ct2,'PARTIDA_TRANSPORTE',1000)
 ON CONFLICT(contract_id,concept) DO UPDATE SET own_allocated_pen=1000;
 IF (SELECT balance_pen FROM public.contract_budgets WHERE contract_id=ct AND concept='PARTIDA_TRANSPORTE') IS DISTINCT FROM 800::numeric
 OR (SELECT balance_pen FROM public.contract_budgets WHERE contract_id=ct2 AND concept='PARTIDA_TRANSPORTE') IS DISTINCT FROM 800::numeric THEN RAISE EXCEPTION 'CAJA C80 FAIL: preparación de partidas'; END IF;
 req:=pg_temp.ins('transport_requests',jsonb_build_object('request_number','ZZ-C80-R1','request_type','DESPACHO','attention_mode','TRANSPORTE_JRM','status','APROBADA','approved_at',now(),'site_id',site,'contract_id',ct,'requester_name','ZZ','department','Logística','cargo_description','Prueba','pickup_address','Planta','delivery_address','Obra','required_date',current_date+2));
 req2:=pg_temp.ins('transport_requests',jsonb_build_object('request_number','ZZ-C80-R2','request_type','RECOJO','attention_mode','TRANSPORTE_JRM','status','APROBADA','approved_at',now(),'site_id',site,'contract_id',ct,'requester_name','ZZ','department','Logística','cargo_description','Prueba','pickup_address','Obra','delivery_address','Planta','required_date',current_date+2));
 added:=pg_temp.ins('transport_requests',jsonb_build_object('request_number','ZZ-C80-R3','request_type','TRASLADO','attention_mode','TRANSPORTE_JRM','status','APROBADA','approved_at',now(),'site_id',site,'contract_id',sub,'requester_name','ZZ','department','Logística','cargo_description','Prueba','pickup_address','Proveedor','delivery_address','Otra obra','required_date',current_date+2,'estimated_weight',100));
 rejected:=pg_temp.ins('transport_requests',jsonb_build_object('request_number','ZZ-C80-R4','request_type','DESPACHO','attention_mode','TRANSPORTE_JRM','status','APROBADA','approved_at',now(),'site_id',site,'contract_id',ct2,'requester_name','ZZ','department','Logística','cargo_description','Prueba','pickup_address','Planta','delivery_address','Obra','required_date',current_date+2));
 UPDATE public.transport_requests SET client_id=client,supplier_id=supplier WHERE id IN(req,req2,added,rejected);
 provider:=pg_temp.ins('carriers',jsonb_build_object('type','PROVEEDOR','business_name','ZZ C80 tercero '||plate,'ruc','20'||lpad((floor(random()*1e9))::bigint::text,9,'0'),'tax_id','20'||lpad((floor(random()*1e9))::bigint::text,9,'0'),'is_active',true));
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 route:=public.schedule_dispatch_tercero(provider,plate,'Chofer ZZ','999888777',plate||'DOC',now(),20,300,ct,jsonb_build_array(jsonb_build_object('id',req),jsonb_build_object('id',req2)));
 SELECT access_code,token INTO original_code,original_token FROM public.dispatch_tercero_enlaces WHERE dispatch_id=route AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1;
 UPDATE public.dispatches SET status='EN_CURSO',tercero_salida_at=now() WHERE id=route;
 context:=public.active_route_context(route);
 IF (context->>'frontier')::int<>1 THEN RAISE EXCEPTION 'CAJA C80 FAIL: tramo iniciado no protegido'; END IF;
 bad:=false;
 BEGIN PERFORM public.add_active_route_service(route,added,req,context->>'revision',operation,150,5,100,500,now()+interval '1 hour','Carga adicional coordinada'); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C80 FAIL: permite insertar antes de tramo actual'; END IF;
 bad:=false;
 BEGIN PERFORM public.add_active_route_service(route,added,req2,context->>'revision',operation,900,5,100,500,now()+interval '1 hour','Carga adicional coordinada'); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad OR (SELECT status FROM public.transport_requests WHERE id=added)<>'APROBADA' THEN RAISE EXCEPTION 'CAJA C80 FAIL: presupuesto o rollback'; END IF;
 bad:=false;
 BEGIN PERFORM public.add_active_route_service(route,added,req2,context->>'revision',operation,150,5,100,50,now()+interval '1 hour','Carga adicional coordinada'); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C80 FAIL: sobrecarga'; END IF;
 bad:=false;
 BEGIN PERFORM public.add_active_route_service(route,added,req2,context->>'revision',operation,150,5,100,500,now()+interval '10 days','Carga adicional coordinada'); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C80 FAIL: fuera de plazo'; END IF;
 bad:=false;
 BEGIN PERFORM public.add_active_route_service(route,added,req2,'desactualizada',operation,150,5,100,500,now()+interval '1 hour','Carga adicional coordinada'); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C80 FAIL: revisión obsoleta'; END IF;
 result:=public.add_active_route_service(route,added,req2,context->>'revision',operation,150,5,100,500,now()+interval '1 hour','Carga adicional coordinada');
 IF (SELECT sequence_order FROM public.dispatch_requests WHERE dispatch_id=route AND transport_request_id=req)<>1
 OR (SELECT sequence_order FROM public.dispatch_requests WHERE dispatch_id=route AND transport_request_id=added)<>2
 OR (SELECT sequence_order FROM public.dispatch_requests WHERE dispatch_id=route AND transport_request_id=req2)<>3 THEN RAISE EXCEPTION 'CAJA C80 FAIL: secuencia incorrecta'; END IF;
 IF (SELECT freight_cost FROM public.dispatches WHERE id=route)<>450 OR (SELECT estimated_distance_km FROM public.dispatches WHERE id=route)<>25
 OR (SELECT contract_id FROM public.dispatches WHERE id=route) IS NOT NULL THEN RAISE EXCEPTION 'CAJA C80 FAIL: ampliación no conserva ruta'; END IF;
 IF (SELECT reserved_pen FROM public.contract_budgets WHERE contract_id=ct AND concept='PARTIDA_TRANSPORTE')<>300
 OR (SELECT reserved_pen FROM public.contract_budgets WHERE contract_id=ct2 AND concept='PARTIDA_TRANSPORTE')<>150 THEN RAISE EXCEPTION 'CAJA C80 FAIL: duplica reserva o no usa madre'; END IF;
 IF (SELECT count(*) FROM public.contract_services WHERE dispatch_id=route AND service_type='FLETE')<>2
 OR NOT EXISTS(SELECT 1 FROM public.contract_services WHERE dispatch_id=route AND contract_id=sub AND budget_contract_id=ct2 AND amount_pen=150) THEN RAISE EXCEPTION 'CAJA C80 FAIL: pierde imputación del error'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.dispatch_tercero_enlaces WHERE dispatch_id=route AND access_code=original_code AND token=original_token AND revoked_at IS NULL) THEN RAISE EXCEPTION 'CAJA C80 FAIL: cambia enlace tercero'; END IF;
 IF public.add_active_route_service(route,added,req2,context->>'revision',operation,150,5,100,500,now()+interval '1 hour','Carga adicional coordinada')<>result THEN RAISE EXCEPTION 'CAJA C80 FAIL: reintento no idempotente'; END IF;
 IF (SELECT count(*) FROM public.dispatch_service_additions WHERE dispatch_id=route)<>1 THEN RAISE EXCEPTION 'CAJA C80 FAIL: duplica operación'; END IF;
 context:=public.active_route_context(route);
 bad:=false;
 BEGIN PERFORM public.add_active_route_service(route,added,NULL,context->>'revision',gen_random_uuid(),150,5,100,500,now()+interval '1 hour','Duplicación indebida'); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C80 FAIL: solicitud duplicada'; END IF;
 -- Complete history stays untouched, and amendments to an already mixed route remain per-OT.
 INSERT INTO public.delivery_conformities(dispatch_id,request_id,state) VALUES(route,req,'VALIDADA') ON CONFLICT(dispatch_id,request_id) DO UPDATE SET state='VALIDADA';
 UPDATE public.dispatch_requests SET status='ENTREGADO' WHERE dispatch_id=route AND transport_request_id=req;
 context:=public.active_route_context(route);
 result:=public.add_active_route_service(route,rejected,NULL,context->>'revision',gen_random_uuid(),50,3,10,500,now()+interval '1 hour','Entrega adicional al final');
 IF (SELECT status FROM public.dispatch_requests WHERE dispatch_id=route AND transport_request_id=req)<>'ENTREGADO' THEN RAISE EXCEPTION 'CAJA C80 FAIL: altera parada terminada'; END IF;
 -- A read-only role cannot mutate or inspect the amendment queue.
 INSERT INTO public.roles(name,permissions) VALUES('Consulta ZZ80','["despacho:read"]') RETURNING id INTO readonly_role;
 UPDATE public.profiles SET role_id=readonly_role WHERE id=actor;
 bad:=false;
 BEGIN PERFORM public.active_route_context(route); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C80 FAIL: permite consulta no supervisora'; END IF;
 UPDATE public.profiles SET role_id=test_role WHERE id=actor;
 INSERT INTO public.delivery_conformities(dispatch_id,request_id,state) SELECT dispatch_id,transport_request_id,'VALIDADA' FROM public.dispatch_requests WHERE dispatch_id=route ON CONFLICT(dispatch_id,request_id) DO UPDATE SET state='VALIDADA';
 UPDATE public.dispatches SET status='RETORNO' WHERE id=route;
 bad:=false;
 BEGIN PERFORM public.active_route_context(route); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C80 FAIL: amplía en retorno'; END IF;
 -- Settle the exact same original and incremental reservations only once.
 INSERT INTO public.delivery_conformities(dispatch_id,request_id,state) SELECT dispatch_id,transport_request_id,'VALIDADA' FROM public.dispatch_requests WHERE dispatch_id=route ON CONFLICT(dispatch_id,request_id) DO UPDATE SET state='VALIDADA';
 UPDATE public.dispatch_requests SET status='ENTREGADO' WHERE dispatch_id=route;
 UPDATE public.dispatches SET docs_required=false,status='ENTREGADO' WHERE id=route;
 PERFORM public.close_dispatch_route(route); PERFORM public.close_dispatch_route(route);
 IF public.add_active_route_service(route,added,req2,'old',operation,150,5,100,500,now()+interval '1 hour','Carga adicional coordinada')->>'success'<>'true' THEN RAISE EXCEPTION 'CAJA C80 FAIL: reintento tras cierre'; END IF;
 IF (SELECT consumed_pen FROM public.contract_budgets WHERE contract_id=ct AND concept='PARTIDA_TRANSPORTE')<>300
 OR (SELECT consumed_pen FROM public.contract_budgets WHERE contract_id=ct2 AND concept='PARTIDA_TRANSPORTE')<>200
 OR EXISTS(SELECT 1 FROM public.dispatch_request_freight WHERE dispatch_id=route AND status='RESERVADO') THEN RAISE EXCEPTION 'CAJA C80 FAIL: liquidación duplicada'; END IF;
 -- Own unit: start through the real daily checklist and driver route APIs.
 driver:=pg_temp.ins('drivers',jsonb_build_object('carrier_id',carrier,'profile_id',driver_actor,'first_name','Conductor','last_name','C80','document_number',plate||'DNI','license_number',plate||'LIC','is_active',true));
 PERFORM pg_temp.ins('vehicles',jsonb_build_object('plate',plate||'P','carrier_id',carrier,'site_id',site,'type','CAMION','status','DISPONIBLE','assigned_driver_id',driver,'weight_capacity',1000,'current_odometer',1000,'soat_expiration',current_date+365,'technical_review_expiration',current_date+365));
 own1:=pg_temp.ins('transport_requests',jsonb_build_object('request_number','ZZ-C80-P1','request_type','DESPACHO','attention_mode','TRANSPORTE_JRM','status','APROBADA','approved_at',now(),'site_id',site,'contract_id',ct,'client_id',client,'requester_name','ZZ','department','Logística','cargo_description','Prueba','pickup_address','Planta','delivery_address','Obra','required_date',current_date+2));
 own2:=pg_temp.ins('transport_requests',jsonb_build_object('request_number','ZZ-C80-P2','request_type','DESPACHO','attention_mode','TRANSPORTE_JRM','status','APROBADA','approved_at',now(),'site_id',site,'contract_id',ct2,'client_id',client,'requester_name','ZZ','department','Logística','cargo_description','Prueba','pickup_address','Planta','delivery_address','Obra','required_date',current_date+2));
 INSERT INTO public.user_site_access(user_id,site_id) VALUES(driver_actor,site) ON CONFLICT DO NOTHING;
 PERFORM set_config('request.jwt.claim.sub',driver_actor::text,true);
 unit:=public.select_driver_preuse_unit(plate||'P');
 SELECT jsonb_build_object('format_code','FR-DT 007','format_version','01','license',plate||'LIC',
   'soat_expiration',current_date+365,'technical_review_expiration',current_date+365,'vehicle_operational',true,
   'observation','Prueba C80','inspector_name','Conductor C80','signature','[[{"x":0.1,"y":0.3},{"x":0.2,"y":0.5},{"x":0.4,"y":0.4},{"x":0.7,"y":0.6}]]'::jsonb,
   'answers',jsonb_agg(jsonb_build_object('code',i.code,'response','B','comment',''))) INTO inspection FROM public.checklist_items i
 JOIN public.checklist_templates tpl ON tpl.id=i.template_id WHERE tpl.code='FR_DT007';
 PERFORM public.submit_driver_preuse(gen_random_uuid(),(unit->>'revision')::uuid,now(),inspection);
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 route:=public.schedule_dispatch(driver,plate||'P',now(),10,100,ct,'GR',jsonb_build_array(jsonb_build_object('id',own1)));
 PERFORM set_config('request.jwt.claim.sub',driver_actor::text,true);
 PERFORM public.start_dispatch_route(route,-12,-77);
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 context:=public.active_route_context(route);
 bad:=false;
 BEGIN PERFORM public.add_active_route_service(route,own2,NULL,context->>'revision',gen_random_uuid(),60,3,10,2000,now()+interval '1 hour','Entrega adicional propia'); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C80 FAIL: capacidad excede unidad'; END IF;
 operation:=gen_random_uuid();
 PERFORM public.add_active_route_service(route,own2,NULL,context->>'revision',operation,60,3,10,500,now()+interval '1 hour','Entrega adicional propia');
 PERFORM set_config('request.jwt.claim.sub',driver_actor::text,true);
 result:=public.get_active_trip_context();
 IF result->'trip'->>'id' IS DISTINCT FROM route::text OR jsonb_array_length(result->'trip'->'stops')<>2
 OR (SELECT driver_id FROM public.dispatches WHERE id=route) IS DISTINCT FROM driver
 OR (SELECT vehicle_plate FROM public.dispatches WHERE id=route) IS DISTINCT FROM plate||'P'
 OR NOT EXISTS(SELECT 1 FROM public.notifications WHERE target_user=driver_actor AND dedupe_key='ruta-servicio:'||operation AND permisos='{}'::text[]) THEN
 RAISE EXCEPTION 'CAJA C80 FAIL: app, conductor/unidad o aviso dirigido'; END IF;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 UPDATE public.profiles SET is_active=false WHERE id=actor;
 bad:=false;
 BEGIN PERFORM public.active_route_context(route); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C80 FAIL: cuenta inactiva'; END IF;
 UPDATE public.profiles SET is_active=true WHERE id=actor;
 DELETE FROM public.user_site_access WHERE user_id=actor AND site_id=site;
 bad:=false;
 BEGIN PERFORM public.active_route_context(route); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C80 FAIL: sede ajena'; END IF;
 INSERT INTO public.user_site_access(user_id,site_id) VALUES(actor,site);
 IF EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.dispatch_service_additions'::regclass AND c.contype='f'
 AND (NOT c.convalidated OR NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.conrelid AND i.indisvalid AND i.indpred IS NULL
 AND (i.indkey::smallint[])[0:cardinality(c.conkey)-1] @> c.conkey))) THEN RAISE EXCEPTION 'CAJA C80 FAIL: índice de relación faltante'; END IF;
 IF has_function_privilege('anon','public.active_route_context(uuid)','EXECUTE')
 OR has_function_privilege('anon','public.add_active_route_service(uuid,uuid,uuid,text,uuid,numeric,numeric,numeric,numeric,timestamptz,text)','EXECUTE')
 OR has_table_privilege('authenticated','public.dispatch_service_additions','INSERT') THEN RAISE EXCEPTION 'CAJA C80 FAIL: acceso público o escritura directa'; END IF;
 RAISE EXCEPTION 'CAJA C80 PASS: active and mixed route amendment, frozen leg, root budget, atomic rollback, deadline/capacity, replay, retained external access and single settlement';
END $test$;
ROLLBACK;
