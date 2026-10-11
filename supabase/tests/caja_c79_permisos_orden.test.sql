-- CAJA C79 — Roles y permisos en orden: formato único sin cambiar acceso, historial de cambios y roles base protegidos.
-- Bloque que siempre se revierte: no deja datos.
BEGIN;
CREATE FUNCTION pg_temp.c79_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE v_user uuid; v_role uuid; v_err text; n int; r jsonb; v_bare int;
  suffix text := upper(substr(gen_random_uuid()::text, 1, 6));
BEGIN
  -- T1: ningún rol conserva un módulo con niveles sin sufijo
  SELECT count(*) INTO v_bare FROM public.roles ro, jsonb_array_elements_text(CASE WHEN jsonb_typeof(ro.permissions) = 'array' THEN ro.permissions ELSE '[]' END) p
   WHERE p IN ('despacho', 'solicitudes', 'ot', 'clientes', 'monitoreo', 'torre-control', 'documentario', 'caja', 'apt', 'tarifas', 'dashboard');
  IF v_bare > 0 THEN RAISE EXCEPTION 'CAJA C79 FAIL: quedan % permisos sin formato (T1)', v_bare; END IF;

  -- T2: la normalización conserva el acceso (sin sufijo = escritura; escritura prevalece sobre lectura; interruptores intactos)
  r := public.normalize_role_permissions('["despacho","solicitudes:read","solicitudes:write","caja-aprobacion","ia:read:caja","x-desconocido"]');
  IF NOT (r @> '["despacho:write","solicitudes:write","caja-aprobacion","ia:read:caja","x-desconocido"]' AND NOT r ? 'solicitudes:read' AND NOT r ? 'despacho') THEN
    RAISE EXCEPTION 'CAJA C79 FAIL: normalización (T2): %', r; END IF;

  -- T3: el permiso normalizado da el mismo acceso en la base
  SELECT id INTO v_user FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  IF v_user IS NULL THEN RAISE EXCEPTION 'CAJA C79 FAIL: falta un perfil de prueba'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C79 ' || suffix, '["despacho:write","solicitudes:read"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET role_id = v_role, is_active = true WHERE id = v_user;
  PERFORM pg_temp.c79_user(v_user);
  IF NOT public.has_tms_permission('despacho') OR public.has_tms_permission('solicitudes') OR NOT public.has_tms_read_permission('solicitudes') THEN
    PERFORM pg_temp.c79_user(NULL);
    RAISE EXCEPTION 'CAJA C79 FAIL: acceso con formato único (T3)'; END IF;
  PERFORM pg_temp.c79_user(NULL);

  -- T4: el historial registra alta y cambio de permisos
  UPDATE public.roles SET permissions = '["despacho:read"]' WHERE id = v_role;
  SELECT count(*) INTO n FROM public.role_permission_changes WHERE role_id = v_role AND action IN ('ALTA', 'CAMBIO');
  IF n < 2 OR NOT EXISTS (SELECT 1 FROM public.role_permission_changes WHERE role_id = v_role AND action = 'CAMBIO'
     AND old_permissions ? 'despacho:write' AND new_permissions ? 'despacho:read') THEN
    RAISE EXCEPTION 'CAJA C79 FAIL: historial de cambios (T4): %', n; END IF;

  -- T5: un rol base no se renombra ni se elimina (sus permisos sí se editan)
  IF EXISTS (SELECT 1 FROM public.roles WHERE public.is_base_role(name)) THEN
    BEGIN UPDATE public.roles SET name = name || ' X' WHERE id = (SELECT id FROM public.roles WHERE public.is_base_role(name) LIMIT 1); v_err := NULL;
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
    IF v_err IS NULL OR v_err NOT LIKE '%rol base%' THEN RAISE EXCEPTION 'CAJA C79 FAIL: rol base renombrado (T5): %', v_err; END IF;
  END IF;
  DELETE FROM public.roles WHERE id = v_role AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE role_id = v_role);

  -- T6: el historial no es visible para anónimos ni editable por usuarios (solo lo escribe el disparador)
  IF has_table_privilege('anon', 'public.role_permission_changes', 'SELECT')
     OR has_table_privilege('authenticated', 'public.role_permission_changes', 'INSERT')
     OR has_table_privilege('authenticated', 'public.role_permission_changes', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.role_permission_changes', 'TRIGGER')
     OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = 'public.role_permission_changes'::regclass
                    AND p.polname = 'security_active_account' AND NOT p.polpermissive) THEN
    RAISE EXCEPTION 'CAJA C79 FAIL: historial expuesto a anónimos (T6)'; END IF;

  RAISE EXCEPTION 'CAJA C79 PASS (6/6) roles y permisos: formato único, acceso intacto, historial y roles base protegidos';
END $test$;
ROLLBACK;
