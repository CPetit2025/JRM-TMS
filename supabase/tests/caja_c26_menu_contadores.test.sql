-- CAJA C26 — Menú: contadores de pendientes. Cada contador respeta el permiso de su pantalla (un rol solo con
-- caja-aprobacion no recibe ningún otro contador; un rol sin permisos no recibe ninguno), los números coinciden con las
-- tablas y sin sesión no se devuelve nada. Solo lectura (se revierte).
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

DO $test$
DECLARE v_user uuid; v_role uuid; r_caja jsonb; r_none jsonb; r_read jsonb; r_anon jsonb; v_exp bigint; v_fail text[] := '{}'; v_pass int := 0;
BEGIN
  SELECT id INTO v_user FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  SELECT count(*) INTO v_exp FROM public.dispatch_expenses WHERE status IN ('PENDIENTE', 'OBSERVADO');

  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C26 caja', '["caja-aprobacion"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET is_active = true, role_id = v_role WHERE id = v_user;
  PERFORM pg_temp.as_user(v_user);
  r_caja := public.menu_pending_counts();
  PERFORM pg_temp.as_user(NULL);

  UPDATE public.roles SET permissions = '["caja-aprobacion:read"]' WHERE id = v_role;
  PERFORM pg_temp.as_user(v_user);
  r_read := public.menu_pending_counts();
  PERFORM pg_temp.as_user(NULL);

  UPDATE public.roles SET permissions = '[]' WHERE id = v_role;
  PERFORM pg_temp.as_user(v_user);
  r_none := public.menu_pending_counts();
  PERFORM pg_temp.as_user(NULL);
  r_anon := public.menu_pending_counts();

  -- T1: con caja-aprobacion solo llega su contador y coincide con la tabla
  IF (r_caja ->> 'success')::boolean
     AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(r_caja -> 'counts') k WHERE k <> '/caja/aprobaciones')
     AND COALESCE((r_caja #>> '{counts,/caja/aprobaciones,n}')::bigint, 0) = v_exp
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 caja: ' || COALESCE(r_caja::text, '∅') || ' esperado ' || v_exp); END IF;

  -- T2: el permiso de solo lectura (":read") también ve el contador, como en el menú
  IF COALESCE((r_read #>> '{counts,/caja/aprobaciones,n}')::bigint, 0) = v_exp
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 lectura: ' || COALESCE(r_read::text, '∅')); END IF;

  -- T3: sin permisos no hay contadores; sin sesión, error
  IF (r_none ->> 'success')::boolean AND r_none -> 'counts' = '{}'::jsonb AND NOT (r_anon ->> 'success')::boolean
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 sin permisos/sesión: ' || COALESCE(r_none::text, '∅') || ' / ' || COALESCE(r_anon::text, '∅')); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C26 PASS (%/3)', v_pass;
  ELSE
    RAISE EXCEPTION 'CAJA C26 FAIL (%/3): %', v_pass, array_to_string(v_fail, ' || ');
  END IF;
END $test$;
