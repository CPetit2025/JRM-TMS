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
DECLARE actor uuid; other_actor uuid; test_role uuid; site uuid; other_site uuid; carrier uuid; req uuid; ct uuid; route uuid; r jsonb;
 plate text:='ZZ52'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,5)); original date:=(now() AT TIME ZONE 'America/Lima')::date+1; next_date date:=(now() AT TIME ZONE 'America/Lima')::date+3; bad boolean;
BEGIN
 SELECT id INTO actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users) AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 1;
 SELECT id INTO other_actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users) AND id<>actor AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 1;
 SELECT site_id INTO site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
 SELECT id INTO other_site FROM public.sites WHERE id<>site LIMIT 1;
 IF actor IS NULL OR other_actor IS NULL OR site IS NULL THEN RAISE EXCEPTION 'CAJA C52 FAIL: faltan perfiles o sede'; END IF;
 INSERT INTO public.roles(name,permissions) VALUES('ZZ C52 supervisor','["despacho","clientes"]') RETURNING id INTO test_role;
 UPDATE public.profiles SET role_id=test_role,is_active=true WHERE id=actor;
 UPDATE public.profiles SET role_id=NULL,is_active=true WHERE id=other_actor;
 INSERT INTO public.user_site_access(user_id,site_id) VALUES(actor,site) ON CONFLICT DO NOTHING;
 ct:=pg_temp.ins('contracts',jsonb_build_object('code','ZZ-C52-OT','type','CONTRATO','status','ACTIVO','site_id',site));
 INSERT INTO public.contract_budgets(contract_id,concept,allocated_pen) VALUES(ct,'PARTIDA_TRANSPORTE',1000) ON CONFLICT(contract_id,concept) DO UPDATE SET allocated_pen=1000;
 carrier:=pg_temp.ins('carriers',jsonb_build_object('type','PROVEEDOR','business_name','ZZ C52 proveedor','ruc','20'||lpad((floor(random()*1e9))::bigint::text,9,'0'),'tax_id','20'||lpad((floor(random()*1e9))::bigint::text,9,'0'),'is_active',true));
 req:=pg_temp.ins('transport_requests',jsonb_build_object('request_number','ZZ-C52-RT','request_type','DESPACHO','attention_mode','TRANSPORTE_JRM','status','APROBADA','approved_at',now(),'site_id',site,'contract_id',ct,'requester_name','ZZ','department','Logística','cargo_description','Prueba','pickup_address','Planta','delivery_address','Obra','required_date',original));
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
 route:=public.schedule_dispatch_tercero(carrier,plate,'C52','999888777',plate||'DOC',now(),20,100,ct,jsonb_build_array(jsonb_build_object('id',req,'freight_share_pen',100)));
 r:=public.cancel_dispatch(route,'Cambio de fecha antes de salir');
 IF r->>'success' IS DISTINCT FROM 'true' OR (SELECT status FROM public.transport_requests WHERE id=req)<>'APROBADA' THEN RAISE EXCEPTION 'CAJA C52 FAIL: cancelación no devuelve solicitud'; END IF;
 r:=public.reprogramar_solicitud(req,next_date,'CLIENTE','Cambio confirmado por cliente');
 IF r->>'success' IS DISTINCT FROM 'true' OR (SELECT required_date FROM public.transport_requests WHERE id=req)<>next_date THEN RAISE EXCEPTION 'CAJA C52 FAIL: fecha no se guarda: %',r; END IF;
 r:=public.get_transport_request_rescheduling(ARRAY[req]);
 IF jsonb_array_length(r)<>1 OR (r->0->>'fecha_nueva')::date<>next_date OR (r->0->>'fecha_anterior')::date<>original THEN RAISE EXCEPTION 'CAJA C52 FAIL: historial incorrecto: %',r; END IF;
 route:=public.schedule_dispatch_tercero(carrier,plate,'C52','999888777',plate||'DOC',now(),20,100,ct,jsonb_build_array(jsonb_build_object('id',req,'freight_share_pen',100)));
 r:=public.cancel_dispatch(route,'Segundo cambio de unidad');
 IF r->>'success' IS DISTINCT FROM 'true' OR (SELECT status FROM public.transport_requests WHERE id=req)<>'APROBADA' OR (SELECT required_date FROM public.transport_requests WHERE id=req)<>next_date THEN RAISE EXCEPTION 'CAJA C52 FAIL: segunda cancelación borra fecha'; END IF;
 r:=public.get_transport_request_rescheduling(ARRAY[req]);
 IF jsonb_array_length(r)<>1 THEN RAISE EXCEPTION 'CAJA C52 FAIL: estado APROBADA pierde rótulo reprogramado'; END IF;
 -- Último cambio y fecha actual de la solicitud deben ser independientes del estado transitorio.
 r:=public.reprogramar_solicitud(req,next_date+1,'SIN_UNIDAD',NULL);
 r:=public.get_transport_request_rescheduling(ARRAY[req]);
 IF jsonb_array_length(r)<>1 OR (r->0->>'fecha_nueva')::date<>next_date+1 THEN RAISE EXCEPTION 'CAJA C52 FAIL: no muestra última reprogramación'; END IF;
 IF r->0 ? 'by' OR r->0 ? 'detalle' THEN RAISE EXCEPTION 'CAJA C52 FAIL: revela datos internos innecesarios'; END IF;
 PERFORM set_config('request.jwt.claim.sub',other_actor::text,true);
 bad:=false;
 BEGIN PERFORM public.get_transport_request_rescheduling(ARRAY[req]); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C52 FAIL: consulta sin permiso'; END IF;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 IF other_site IS NOT NULL THEN
   DELETE FROM public.user_site_access WHERE user_id=actor AND site_id=other_site;
   UPDATE public.transport_requests SET site_id=other_site WHERE id=req;
   IF public.get_transport_request_rescheduling(ARRAY[req])<>'[]'::jsonb THEN RAISE EXCEPTION 'CAJA C52 FAIL: revela solicitudes de otra sede'; END IF;
 END IF;
 IF has_function_privilege('anon','public.get_transport_request_rescheduling(uuid[])','EXECUTE') THEN RAISE EXCEPTION 'CAJA C52 FAIL: historial anónimo'; END IF;
 RAISE EXCEPTION 'CAJA C52 PASS: cancelación, reprogramación, fecha vigente, historial tras APROBADA y permisos/sede';
END $test$;
ROLLBACK;
