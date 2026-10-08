-- Pruebas C67 — Versión de datos APT (caché de lecturas de /apt).
-- T1 sin lectura anónima y con search_path seguro; T2 sin permiso APT no devuelve versión;
-- T3 la versión es estable entre lecturas y cambia al recalcular el modelo (rebuilt_at).
-- Termina en error para forzar ROLLBACK: "CAJA C67 PASS/FAIL".
BEGIN;
DO $test$
DECLARE v_pass int := 0; actor uuid; v_role uuid; a jsonb; b jsonb; c jsonb;
BEGIN
  IF NOT has_function_privilege('anon', 'public.apt_data_version()', 'EXECUTE')
     AND (SELECT array_to_string(proconfig, ',') LIKE '%search_path=public, pg_temp%' FROM pg_proc WHERE oid = 'public.apt_data_version()'::regprocedure)
  THEN v_pass := v_pass + 1; ELSE RAISE EXCEPTION 'CAJA C67 FAIL (T1): permisos o search_path'; END IF;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  IF (public.apt_data_version()->>'success')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'CAJA C67 FAIL (T2): versión sin identidad'; END IF;
  v_pass := v_pass + 1;
  SELECT id INTO actor FROM public.profiles WHERE id IN (SELECT id FROM auth.users)
    AND id NOT IN (SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C67 FAIL: falta perfil para probar'; END IF;
  INSERT INTO public.roles(name, permissions) VALUES ('ZZ C67 APT ' || substr(gen_random_uuid()::text, 1, 8), '["apt:read"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET is_active = true, role_id = v_role WHERE id = actor;
  PERFORM set_config('request.jwt.claim.sub', actor::text, true);
  a := public.apt_data_version(); b := public.apt_data_version();
  UPDATE public.apt_flow_state SET rebuilt_at = clock_timestamp() + interval '1 day' WHERE id = 1;
  c := public.apt_data_version();
  IF (a->>'success')::boolean AND a->>'version' = b->>'version' AND (NOT EXISTS (SELECT 1 FROM public.apt_flow_state) OR c->>'version' <> a->>'version')
  THEN v_pass := v_pass + 1; ELSE RAISE EXCEPTION 'CAJA C67 FAIL (T3): % / % / %', a, b, c; END IF;
  RAISE EXCEPTION 'CAJA C67 PASS (%/3) versión de datos APT %', v_pass, left(a->>'version', 80);
END $test$;
ROLLBACK;
