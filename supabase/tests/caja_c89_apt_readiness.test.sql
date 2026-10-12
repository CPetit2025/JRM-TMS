-- Reversible production verification; no operational record survives the transaction.
BEGIN;
CREATE FUNCTION pg_temp.c89_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM set_config('request.jwt.claim.sub',COALESCE(p_user::text,''),true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true);
 PERFORM set_config('role',CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END,true);
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
DO $test$
DECLARE actor uuid; v_role uuid; lot text:='ZZ-C89-'||substr(gen_random_uuid()::text,1,8); q jsonb; stamp text; count_history integer; v_error text;
BEGIN
 IF has_function_privilege('anon','public.apt_readiness_save(jsonb)','EXECUTE') OR has_function_privilege('anon','public.apt_readiness_list(jsonb)','EXECUTE') THEN RAISE EXCEPTION 'CAJA C89 FAIL: RPC anónima'; END IF;
 IF has_table_privilege('authenticated','public.apt_operational_readiness','UPDATE') OR has_table_privilege('authenticated','public.apt_operational_readiness_history','INSERT') THEN RAISE EXCEPTION 'CAJA C89 FAIL: escritura directa'; END IF;
 SELECT id INTO actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users) AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 1;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C89 FAIL: falta perfil para prueba'; END IF;
 INSERT INTO public.roles(name,permissions) VALUES('ZZ C89 '||substr(gen_random_uuid()::text,1,8),'["apt:read"]') RETURNING id INTO v_role;
 UPDATE public.profiles SET is_active=true,role_id=v_role WHERE id=actor;
 PERFORM pg_temp.c89_user(actor);
 q:=public.apt_readiness_list(jsonb_build_array(jsonb_build_object('almacen','ST','lote',lot)));
 IF (q->>'success')::boolean IS DISTINCT FROM true OR jsonb_array_length(q->'rows')<>0 OR (q->>'can_edit')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'CAJA C89 FAIL: default desconocido/lectura'; END IF;
 q:=public.apt_readiness_save(jsonb_build_object('almacen','ST','lote',lot,'status','NO_EVALUADO'));
 IF (q->>'success')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'CAJA C89 FAIL: lector escribe'; END IF;
 PERFORM pg_temp.c89_user(NULL);
 UPDATE public.roles SET permissions='["apt-carga:write"]' WHERE id=v_role;
 PERFORM pg_temp.c89_user(actor);
 q:=public.apt_readiness_save(jsonb_build_object('almacen','ST','lote',lot,'status','DISPONIBLE'));
 IF (q->>'success')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'CAJA C89 FAIL: disponible sin sustento'; END IF;
 q:=public.apt_readiness_save(jsonb_build_object('almacen','ST','lote',lot,'status','DISPONIBLE','reason','C89 revisión','responsible_name','C89 supervisor','next_action','Verificar servicio'));
 IF (q->>'success')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'CAJA C89 FAIL: alta %',q; END IF;
 stamp:=q#>>'{row,updated_at}';
 q:=public.apt_readiness_save(jsonb_build_object('almacen','ST','lote',lot,'status','NO_EVALUADO'));
 IF (q->>'success')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'CAJA C89 FAIL: sobreescritura sin versión'; END IF;
 q:=public.apt_readiness_save(jsonb_build_object('almacen','ST','lote',lot,'status','BLOQUEADO','reason','C89 pendiente','responsible_name','C89 supervisor','next_action','Resolver restricción','expected_updated_at',stamp));
 IF (q->>'success')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'CAJA C89 FAIL: actualización %',q; END IF;
 PERFORM pg_temp.c89_user(NULL);
 SELECT count(*) INTO count_history FROM public.apt_operational_readiness_history WHERE lote=lot;
 IF count_history<>2 THEN RAISE EXCEPTION 'CAJA C89 FAIL: historial incompleto'; END IF;
 BEGIN UPDATE public.apt_operational_readiness_history SET lote=lot WHERE lote=lot; v_error:=NULL; EXCEPTION WHEN OTHERS THEN v_error:=SQLERRM; END;
 IF v_error IS NULL THEN RAISE EXCEPTION 'CAJA C89 FAIL: historial mutable'; END IF;
 UPDATE public.profiles SET is_active=false WHERE id=actor;
 PERFORM pg_temp.c89_user(actor);
 q:=public.apt_readiness_list('[]');
 IF (q->>'success')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'CAJA C89 FAIL: inactivo lee'; END IF;
 q:=public.apt_readiness_save(jsonb_build_object('almacen','ST','lote',lot,'status','NO_EVALUADO'));
 IF (q->>'success')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'CAJA C89 FAIL: inactivo escribe'; END IF;
 PERFORM pg_temp.c89_user(NULL);
 RAISE EXCEPTION 'CAJA C89 PASS: permisos, estado no evaluado, evidencia explícita, concurrencia, historial inmutable e inactividad';
END $test$;
ROLLBACK;
