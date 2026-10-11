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
 bad boolean; driver uuid; own1 uuid; own2 uuid; unit jsonb; inspection jsonb; original_code text; original_token text; balance numeric; plate text:='ZZ81'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
BEGIN
 SELECT id INTO actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users) AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 1;
 SELECT id INTO driver_actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users) AND id<>actor AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 1;
 SELECT id INTO client FROM public.clients ORDER BY id LIMIT 1;
 SELECT id INTO supplier FROM public.suppliers ORDER BY id LIMIT 1;
 SELECT carrier_id,site_id INTO carrier,site FROM public.vehicles WHERE carrier_id IS NOT NULL AND site_id IS NOT NULL LIMIT 1;
 IF actor IS NULL OR driver_actor IS NULL OR site IS NULL OR client IS NULL OR supplier IS NULL THEN RAISE EXCEPTION 'CAJA C84 FAIL: faltan perfiles o sede'; END IF;
 SELECT id INTO test_role FROM public.roles WHERE name='Supervisor de Transporte' LIMIT 1;
 IF test_role IS NULL THEN INSERT INTO public.roles(name,permissions) VALUES('Supervisor de Transporte','["despacho","torre-control"]') RETURNING id INTO test_role; END IF;
 UPDATE public.roles SET permissions='["despacho","torre-control"]' WHERE id=test_role;
 UPDATE public.profiles SET role_id=test_role,is_active=true WHERE id=actor;
 INSERT INTO public.user_site_access(user_id,site_id) VALUES(actor,site) ON CONFLICT DO NOTHING;
 ct:=pg_temp.ins('contracts',jsonb_build_object('code','ZZ-C84-A','type','CONTRATO','status','ACTIVO','site_id',site,'client_id',client));
 ct2:=pg_temp.ins('contracts',jsonb_build_object('code','ZZ-C84-B','type','CONTRATO','status','ACTIVO','site_id',site,'client_id',client));
 sub:=pg_temp.ins('contracts',jsonb_build_object('code','ZZ-C84-B-E014','type','ERROR','status','ACTIVO','site_id',site,'client_id',client,'parent_contract_id',ct2));
 INSERT INTO public.contract_budgets(contract_id,concept,allocated_pen) VALUES(ct,'PARTIDA_TRANSPORTE',1000),(ct2,'PARTIDA_TRANSPORTE',1000)
 ON CONFLICT(contract_id,concept) DO UPDATE SET own_allocated_pen=1000;
 IF (SELECT balance_pen FROM public.contract_budgets WHERE contract_id=ct AND concept='PARTIDA_TRANSPORTE') IS DISTINCT FROM 800::numeric
 OR (SELECT balance_pen FROM public.contract_budgets WHERE contract_id=ct2 AND concept='PARTIDA_TRANSPORTE') IS DISTINCT FROM 800::numeric THEN RAISE EXCEPTION 'CAJA C84 FAIL: preparación de partidas'; END IF;

 req:=pg_temp.ins('transport_requests',jsonb_build_object('request_number','ZZ-C84-T','request_type','DESPACHO','attention_mode','TRANSPORTE_JRM','status','APROBADA','approved_at',now(),'site_id',site,'contract_id',ct,'client_id',client,'requester_name','ZZ','department','Logística','cargo_description','Prueba','pickup_address','Planta','delivery_address','Obra','required_date',(now() AT TIME ZONE 'America/Lima')::date));
 provider:=pg_temp.ins('carriers',jsonb_build_object('type','PROVEEDOR','business_name','ZZ C84 tercero '||plate,'ruc','20'||lpad((floor(random()*1e9))::bigint::text,9,'0'),'tax_id','20'||lpad((floor(random()*1e9))::bigint::text,9,'0'),'is_active',true));
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 route:=public.schedule_dispatch_tercero(provider,plate,'Chofer ZZ','999888777',plate||'DOC',now(),20,100,ct,jsonb_build_array(jsonb_build_object('id',req)));
 SELECT access_code,token INTO original_code,original_token FROM public.dispatch_tercero_enlaces WHERE dispatch_id=route AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1;
 -- Deliberately move this isolated fixture into yesterday's operation; never alter real routes.
 UPDATE public.dispatches SET scheduled_departure=now()-interval '1 day',tercero_salida_at=now()-interval '1 day',status='EN_CURSO' WHERE id=route;
 IF (SELECT daily_cutoff_at AT TIME ZONE 'America/Lima' FROM public.dispatches WHERE id=route) IS DISTINCT FROM date_trunc('day',now() AT TIME ZONE 'America/Lima') THEN RAISE EXCEPTION 'CAJA C84 FAIL: el corte no es medianoche de Lima'; END IF;
 IF public.close_daily_dispatch_operations(route)<>1 OR public.close_daily_dispatch_operations(route)<>0 THEN RAISE EXCEPTION 'CAJA C84 FAIL: corte no idempotente'; END IF;
 IF (SELECT status FROM public.dispatches WHERE id=route)<>'CIERRE_OPERATIVO' OR (SELECT status FROM public.dispatch_requests WHERE dispatch_id=route)<>'PROGRAMADO'
 OR (SELECT reserved_pen FROM public.contract_budgets WHERE contract_id=ct AND concept='PARTIDA_TRANSPORTE')<>100
 OR (SELECT consumed_pen FROM public.contract_budgets WHERE contract_id=ct AND concept='PARTIDA_TRANSPORTE')<>0 THEN RAISE EXCEPTION 'CAJA C84 FAIL: corte falsea entrega o consumo'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.dispatch_tercero_enlaces WHERE dispatch_id=route AND token=original_token AND access_code=original_code AND revoked_at IS NULL) THEN RAISE EXCEPTION 'CAJA C84 FAIL: revoca acceso pendiente'; END IF;
 bad:=false; BEGIN PERFORM public.close_dispatch_route(route); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C84 FAIL: cierre financiero sin guía'; END IF;
 context:=public.daily_document_kpi('TRANSPORTE',actor,(now() AT TIME ZONE 'America/Lima')::date-2,(now() AT TIME ZONE 'America/Lima')::date);
 IF COALESCE((context->'values'->>'guias_equipo_pendientes')::int,0)<1 THEN RAISE EXCEPTION 'CAJA C84 FAIL: pierde pendiente KPI'; END IF;
 -- A provider can still present evidence after release; the supervisor remains the validator.
 original_code:='tercero/'||route||'/'||gen_random_uuid()||'.jpg';
 INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('driver_evidence',original_code,'{}');
 result:=public.delivery_public_submit(original_token,req,gen_random_uuid(),ARRAY[original_code],'Cliente','Guía después del corte','GR-C84');
 IF (result->>'success')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'CAJA C84 FAIL: no admite guía tardía del proveedor'; END IF;
 SELECT current_submission_id INTO operation FROM public.delivery_conformities WHERE dispatch_id=route AND request_id=req;
 PERFORM public.delivery_review(route,req,operation,'VALIDADA',NULL);
 PERFORM public.close_dispatch_route(route); PERFORM public.close_dispatch_route(route);
 IF (SELECT consumed_pen FROM public.contract_budgets WHERE contract_id=ct AND concept='PARTIDA_TRANSPORTE')<>100 THEN RAISE EXCEPTION 'CAJA C84 FAIL: consumo duplicado'; END IF;
 -- Own unit/driver: midnight releases both, and the previous route can upload without new GPS.
 driver:=pg_temp.ins('drivers',jsonb_build_object('profile_id',driver_actor,'first_name','Conductor','last_name','ZZ C84','document_number',plate||'D','license_number','Q'||plate,'license_category','AIIIC','license_expiration',current_date+365,'is_active',true));
 own1:=pg_temp.ins('vehicles',jsonb_build_object('plate',plate||'P','type','CAMION','status','EN_OPERACION','is_active',true,'site_id',site,'carrier_id',carrier,'assigned_driver_id',driver,'weight_capacity',1000,'current_odometer',1000,'soat_expiration',current_date+365,'technical_review_expiration',current_date+365));
 own2:=pg_temp.ins('transport_requests',jsonb_build_object('request_number','ZZ-C84-P','request_type','DESPACHO','attention_mode','TRANSPORTE_JRM','status','ASIGNADA','approved_at',now(),'site_id',site,'contract_id',ct,'client_id',client,'requester_name','ZZ','department','Logística','cargo_description','Prueba','pickup_address','Planta','delivery_address','Obra','required_date',(now() AT TIME ZONE 'America/Lima')::date-1));
 route:=pg_temp.ins('dispatches',jsonb_build_object('dispatch_number','ZZ-C84-OWN','vehicle_plate',plate||'P','driver_id',driver,'driver_name','Conductor ZZ C84','status','EN RUTA','modalidad','PROPIA','site_id',site,'scheduled_departure',now()-interval '1 day','departure_time',now()-interval '1 day','docs_required',false,'created_by',actor,'freight_cost',0));
 INSERT INTO public.dispatch_requests(dispatch_id,transport_request_id,sequence_order,status,document_type,leg_actual_km) VALUES(route,own2,1,'PROGRAMADO','GR',12.4);
 INSERT INTO public.delivery_conformities(dispatch_id,request_id) VALUES(route,own2) ON CONFLICT DO NOTHING;
 balance:=public.close_daily_dispatch_operations(route);
 IF balance<>1 OR (SELECT status FROM public.vehicles WHERE id=own1)<>'DISPONIBLE' THEN RAISE EXCEPTION 'CAJA C84 FAIL: no libera unidad propia (cortes %, unidad %, ruta %, corte %)',balance,(SELECT status FROM public.vehicles WHERE id=own1),(SELECT status FROM public.dispatches WHERE id=route),(SELECT daily_cutoff_at FROM public.dispatches WHERE id=route); END IF;
 PERFORM set_config('request.jwt.claim.sub',driver_actor::text,true);
 IF public.get_active_trip_context()->'trip' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'CAJA C84 FAIL: conductor sigue ocupado'; END IF;
 original_code:=driver_actor||'/'||route||'/'||own2||'/'||gen_random_uuid()||'.jpg';
 INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('driver_evidence',original_code,'{}');
 result:=public.delivery_submit_driver(route,own2,ARRAY[original_code],'Cliente','Guía tardía','T001-6591',gen_random_uuid(),now());
 IF (result->>'success')::boolean IS DISTINCT FROM true OR (SELECT leg_actual_km FROM public.dispatch_requests WHERE dispatch_id=route AND transport_request_id=own2) IS DISTINCT FROM 12.4::numeric THEN RAISE EXCEPTION 'CAJA C84 FAIL: guía tardía no conserva GPS'; END IF;
 context:=public.daily_document_kpi('CONDUCTOR',driver,(now() AT TIME ZONE 'America/Lima')::date-2,(now() AT TIME ZONE 'America/Lima')::date);
 IF (context->'values'->>'guias_corte_puntual')::numeric IS DISTINCT FROM 0::numeric OR (context->'values'->>'guias_pendientes')::int IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'CAJA C84 FAIL: KPI confunde presentación tardía con espera de revisión'; END IF;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 -- Reassign the released pair now; closing old documents must never release this new active unit.
 added:=pg_temp.ins('dispatches',jsonb_build_object('dispatch_number','ZZ-C84-NEW','vehicle_plate',plate||'P','driver_id',driver,'driver_name','Conductor ZZ C84','status','PROGRAMADO','modalidad','PROPIA','site_id',site,'scheduled_departure',now(),'docs_required',false,'created_by',actor));
 UPDATE public.vehicles SET status='EN_OPERACION' WHERE id=own1;
 IF public.close_daily_dispatch_operations(added)<>0 THEN RAISE EXCEPTION 'CAJA C84 FAIL: corta ruta del día actual'; END IF;
 SELECT current_submission_id INTO operation FROM public.delivery_conformities WHERE dispatch_id=route AND request_id=own2;
 PERFORM public.delivery_review(route,own2,operation,'VALIDADA',NULL); PERFORM public.close_dispatch_route(route);
 result:=public.transition_dispatch_status(route,'CERRADO',NULL,NULL);
 IF result->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'CAJA C84 FAIL: cierre final rechazado %',result; END IF;
 IF (SELECT status FROM public.vehicles WHERE id=own1)<>'EN_OPERACION' OR (SELECT status FROM public.dispatches WHERE id=added)<>'PROGRAMADO' THEN RAISE EXCEPTION 'CAJA C84 FAIL: cierre viejo libera ruta nueva'; END IF;
 -- Same-day server guard: another day's service cannot be inserted even via direct RPC.
 rejected:=pg_temp.ins('transport_requests',jsonb_build_object('request_number','ZZ-C84-NEXT','request_type','DESPACHO','attention_mode','TRANSPORTE_JRM','status','APROBADA','approved_at',now(),'site_id',site,'contract_id',ct,'client_id',client,'requester_name','ZZ','department','Logística','cargo_description','Prueba','pickup_address','Planta','delivery_address','Obra','required_date',(now() AT TIME ZONE 'America/Lima')::date+1));
 context:=public.active_route_context(added);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(context->'requests') r WHERE r->>'id'=rejected::text) THEN RAISE EXCEPTION 'CAJA C84 FAIL: ofrece otro día'; END IF;
 bad:=false; BEGIN PERFORM public.add_active_route_service(added,rejected,NULL,context->>'revision',gen_random_uuid(),0,0,1,500,now(),'Prueba fecha indebida'); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad OR (SELECT status FROM public.transport_requests WHERE id=rejected)<>'APROBADA' THEN RAISE EXCEPTION 'CAJA C84 FAIL: permite adicional de otro día'; END IF;
 IF has_function_privilege('authenticated','public.close_daily_dispatch_operations(uuid)','EXECUTE') OR has_function_privilege('anon','public.close_daily_dispatch_operations(uuid)','EXECUTE')
 OR has_function_privilege('authenticated','public.active_route_context_before_daily_cutoff(uuid)','EXECUTE') THEN RAISE EXCEPTION 'CAJA C84 FAIL: motor privado expuesto'; END IF;
 IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
  EXECUTE $$SELECT EXISTS(SELECT 1 FROM cron.job WHERE jobname='dispatch-midnight-lima' AND schedule='* * * * *' AND active)$$ INTO bad;
  IF NOT bad THEN RAISE EXCEPTION 'CAJA C84 FAIL: tarea automática no activa'; END IF;
 END IF;
 RAISE EXCEPTION 'CAJA C84 PASS: corte diario Lima, recursos libres, documentación tardía, revisión, consumo idempotente, KPI y adicionales del mismo día';
END $test$;
ROLLBACK;
