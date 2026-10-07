-- Live-schema regression. No irreversible actions; terminal PASS exception rolls the entire transaction back.
BEGIN;
SET LOCAL statement_timeout='30s';
DO $$
DECLARE t record; actor uuid; test_role uuid:=gen_random_uuid(); other_route uuid; other_driver uuid; target_plate text;
 before_route jsonb; before_vehicle jsonb; quota_result boolean; fingerprint text:=md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text);
BEGIN
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity) THEN
  RAISE EXCEPTION 'CAJA C55 FAIL: tabla pública sin RLS';
 END IF;
 FOR t IN SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') LOOP
  IF has_table_privilege('anon',t.oid,'TRUNCATE') OR has_table_privilege('authenticated',t.oid,'TRUNCATE')
   OR has_table_privilege('anon',t.oid,'TRIGGER') OR has_table_privilege('authenticated',t.oid,'TRIGGER') THEN
   RAISE EXCEPTION 'CAJA C55 FAIL: permiso peligroso en %',t.relname;
  END IF;
  IF t.relname<>'app_versions' AND has_table_privilege('anon',t.oid,'SELECT') THEN RAISE EXCEPTION 'CAJA C55 FAIL: lectura anónima en %',t.relname; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind='v' AND has_table_privilege('authenticated',c.oid,'SELECT')
 AND NOT COALESCE(c.reloptions @> ARRAY['security_invoker=true'],false)
 AND NOT(c.relname IN ('vw_caja_people','vw_caja_trips','vw_caja_units') AND pg_get_viewdef(c.oid) LIKE '%has_caja_read_access()%')) THEN
  RAISE EXCEPTION 'CAJA C55 FAIL: vista omite RLS sin barrera explícita';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef
 AND has_function_privilege('anon',p.oid,'EXECUTE') AND p.proname NOT IN ('get_public_tracking_info','get_public_daily_tracking_info','get_public_daily_tracking_locations')) THEN
  RAISE EXCEPTION 'CAJA C55 FAIL: RPC privilegiado expuesto a anónimos';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef
 AND NOT COALESCE(array_to_string(p.proconfig,',') LIKE '%search_path=public, pg_temp%',false)) THEN
  RAISE EXCEPTION 'CAJA C55 FAIL: search_path privilegiado inseguro';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')
 AND c.relname NOT IN ('profiles','app_versions','registration_request_limits')
 AND NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='security_active_account' AND NOT p.polpermissive)) THEN
  RAISE EXCEPTION 'CAJA C55 FAIL: cuenta inactiva sin barrera restrictiva';
 END IF;
 IF EXISTS(SELECT 1 FROM storage.buckets WHERE id IN ('evidence','signatures','driver_evidence','dispatch_documents','caja_receipts') AND public) THEN
  RAISE EXCEPTION 'CAJA C55 FAIL: evidencias públicas';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.contype='f'
 AND (NOT c.convalidated OR NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.conrelid AND i.indisvalid AND i.indpred IS NULL
 AND (i.indkey::smallint[])[0:cardinality(c.conkey)-1] @> c.conkey))) THEN
  RAISE EXCEPTION 'CAJA C55 FAIL: FK sin validar o sin cobertura de índice';
 END IF;
 SELECT p.id INTO actor FROM public.profiles p JOIN auth.users u ON u.id=p.id
 WHERE NOT EXISTS(SELECT 1 FROM public.drivers d WHERE d.profile_id=p.id) ORDER BY p.id LIMIT 1;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C55 FAIL: no hay actor de prueba sin vínculo de conductor'; END IF;
 INSERT INTO public.roles(id,name,permissions) VALUES(test_role,'C55-'||test_role::text,'[]'::jsonb);
 UPDATE public.profiles SET role_id=test_role,is_active=true WHERE id=actor;
 SELECT d.id,d.driver_id,d.vehicle_plate,to_jsonb(d) INTO other_route,other_driver,target_plate,before_route
 FROM public.dispatches d WHERE d.driver_id IS NOT NULL AND d.vehicle_plate IS NOT NULL ORDER BY d.id LIMIT 1;
 IF other_route IS NOT NULL THEN SELECT to_jsonb(v) INTO before_vehicle FROM public.vehicles v WHERE v.plate=target_plate; END IF;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
 PERFORM set_config('role','authenticated',true);
 IF EXISTS(SELECT 1 FROM public.carriers) OR EXISTS(SELECT 1 FROM public.products) THEN
  RAISE EXCEPTION 'CAJA C55 FAIL: usuario sin módulos ve maestros operativos';
 END IF;
 BEGIN
  INSERT INTO public.carriers(id,business_name) VALUES(gen_random_uuid(),'C55-denegado');
  RAISE EXCEPTION 'CAJA C55 FAIL: usuario sin módulos escribe transportistas';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM public.reserve_registration_attempt('staff',fingerprint);
  RAISE EXCEPTION 'CAJA C55 FAIL: usuario modifica cuota del registro';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 IF other_route IS NOT NULL THEN
  BEGIN
   PERFORM public.submit_post_route_checklist(other_route,target_plate,other_driver,1000,'{}'::jsonb);
   RAISE EXCEPTION 'CAJA C55 FAIL: usuario suplanta post-ruta de otro conductor';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
   PERFORM public.record_odometer_reading(target_plate,1000,NULL,'C55',other_route);
   RAISE EXCEPTION 'CAJA C55 FAIL: usuario modifica odómetro ajeno';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 END IF;
 PERFORM set_config('role','postgres',true);
 IF other_route IS NOT NULL AND (SELECT to_jsonb(d) FROM public.dispatches d WHERE d.id=other_route) IS DISTINCT FROM before_route THEN
  RAISE EXCEPTION 'CAJA C55 FAIL: intento denegado modificó despacho';
 END IF;
 IF before_vehicle IS NOT NULL AND (SELECT to_jsonb(v) FROM public.vehicles v WHERE v.plate=target_plate) IS DISTINCT FROM before_vehicle THEN
  RAISE EXCEPTION 'CAJA C55 FAIL: intento denegado modificó unidad';
 END IF;
 -- Even an administrator's cached JWT is blocked after deactivation.
 UPDATE public.profiles SET role_id=(SELECT id FROM public.roles WHERE name='Administrador' LIMIT 1),is_active=false WHERE id=actor;
 PERFORM set_config('role','authenticated',true);
 IF EXISTS(SELECT 1 FROM public.products) OR EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id IN ('evidence','signatures')) THEN
  RAISE EXCEPTION 'CAJA C55 FAIL: administrador inactivo conserva acceso';
 END IF;
 PERFORM set_config('role','service_role',true);
 FOR n IN 1..6 LOOP
  quota_result:=public.reserve_registration_attempt('staff',fingerprint);
  IF quota_result IS DISTINCT FROM (n<=5) THEN RAISE EXCEPTION 'CAJA C55 FAIL: cuota durable incorrecta'; END IF;
 END LOOP;
 PERFORM set_config('role','postgres',true);
 RAISE EXCEPTION 'CAJA C55 PASS';
END $$;
ROLLBACK;
