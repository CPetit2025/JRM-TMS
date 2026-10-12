BEGIN;
CREATE FUNCTION pg_temp.c90_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM set_config('request.jwt.claim.sub',COALESCE(p_user::text,''),true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true);
 PERFORM set_config('role',CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END,true);
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
DO $test$
DECLARE actor uuid; r uuid; q jsonb; observation jsonb; c date; built timestamptz; after_built timestamptz;
DECLARE lot text:='ZZ-C90-'||substr(gen_random_uuid()::text,1,8); saved uuid;
BEGIN
 IF has_function_privilege('anon','public.apt_stock_reconciliation(jsonb)','EXECUTE')
 OR has_function_privilege('anon','public.apt_stock_observation_save(jsonb)','EXECUTE') THEN RAISE EXCEPTION 'CAJA C90 FAIL: RPC anónima'; END IF;
 IF has_table_privilege('authenticated','public.apt_stock_observations','INSERT') THEN RAISE EXCEPTION 'CAJA C90 FAIL: captura directa'; END IF;
 q:=public.apt_stock_reconciliation('{}');
 IF (q->>'success')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'CAJA C90 FAIL: sin identidad'; END IF;
 SELECT id INTO actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users)
 AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 1;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C90 FAIL: falta perfil de prueba'; END IF;
 INSERT INTO public.roles(name,permissions) VALUES('ZZ C90 '||substr(gen_random_uuid()::text,1,8),'["apt:read","apt-carga:write"]') RETURNING id INTO r;
 UPDATE public.profiles SET is_active=true,role_id=r WHERE id=actor;
 SELECT cutoff,rebuilt_at INTO c,built FROM public.apt_flow_state WHERE id=1;
 PERFORM pg_temp.c90_user(actor);
 observation:=jsonb_build_object('cutoff',COALESCE(c,(now() AT TIME ZONE 'America/Lima')::date),'almacen','647','lote',lot,'producto','ZZ-C90-P',
 'peso_kg',1,'source','ERP','reference','Prueba con reversión C90');
 q:=public.apt_stock_observation_save(observation);
 IF (q->>'success')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'CAJA C90 FAIL: captura autorizada %',q; END IF;
 saved:=(q->>'id')::uuid;
 q:=public.apt_stock_reconciliation(jsonb_build_object('cutoff',observation->>'cutoff','lote',lot));
 IF (q->>'success')::boolean IS DISTINCT FROM true OR q->>'total'<>'1' OR (q->>'certifies_full_inventory')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'CAJA C90 FAIL: alcance de conciliación'; END IF;
 IF (public.apt_stock_observation_save(observation||'{"peso_kg":-1}'::jsonb)->>'success')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'CAJA C90 FAIL: peso negativo'; END IF;
 IF (public.apt_stock_observation_save(observation||'{"reference":""}'::jsonb)->>'success')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'CAJA C90 FAIL: evidencia vacía'; END IF;
 PERFORM pg_temp.c90_user(NULL);
 IF NOT EXISTS(SELECT 1 FROM public.apt_stock_observations WHERE id=saved AND created_by=actor) THEN RAISE EXCEPTION 'CAJA C90 FAIL: responsable de captura'; END IF;
 SELECT rebuilt_at INTO after_built FROM public.apt_flow_state WHERE id=1;
 IF after_built IS DISTINCT FROM built THEN RAISE EXCEPTION 'CAJA C90 FAIL: captura reconstruyó modelo'; END IF;
 UPDATE public.profiles SET is_active=false WHERE id=actor;
 PERFORM pg_temp.c90_user(actor);
 IF (public.apt_stock_reconciliation('{}')->>'success')::boolean IS DISTINCT FROM false
 OR (public.apt_stock_observation_save(observation)->>'success')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'CAJA C90 FAIL: cuenta desactivada'; END IF;
 RAISE EXCEPTION 'CAJA C90 PASS: captura ERP separada, referencia/peso, permisos/cuenta activa, modelo sin modificar';
END $test$;
ROLLBACK;
