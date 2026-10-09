-- CAJA C74 — Administrador de Contratos: permisos (Contratos L/E, Servicios L, Torre L, APT L, sin Dashboard/Reportes)
-- y selección de sus OT como Responsable de OT. Bloque que siempre se revierte: no deja datos.
CREATE FUNCTION pg_temp.c74_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE
  v_admin uuid; v_ca uuid; v_other uuid; v_role_ca uuid; v_role_other uuid; v_site uuid; v_site2 uuid;
  v_perms jsonb; r jsonb; v_root uuid; v_far uuid; n int; v_err text;
  suffix text := upper(substr(gen_random_uuid()::text, 1, 6));
BEGIN
  -- T1: permisos del rol
  SELECT id, permissions INTO v_role_ca, v_perms FROM public.roles WHERE name = 'Administrador de Contratos';
  IF v_role_ca IS NULL THEN RAISE EXCEPTION 'CAJA C74 FAIL: falta el rol Administrador de Contratos'; END IF;
  IF NOT (v_perms ? 'ot:write' AND v_perms ? 'contratos-servicios:read' AND v_perms ? 'torre-control:read' AND v_perms ? 'apt:read')
     OR v_perms ?| ARRAY['dashboard', 'dashboard:read', 'dashboard:write', 'contratos-servicios', 'contratos-servicios:write',
                         'reportes', 'reportes:read', 'reportes:write', 'apt', 'apt:write', 'apt-carga', 'apt-carga:write'] THEN
    RAISE EXCEPTION 'CAJA C74 FAIL: permisos del rol (T1): %', v_perms;
  END IF;

  SELECT site_id INTO v_site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
  IF v_site IS NULL THEN SELECT id INTO v_site FROM public.sites LIMIT 1; END IF;
  SELECT id INTO v_site2 FROM public.sites WHERE id <> v_site LIMIT 1;
  FOR v_admin IN SELECT id FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u) LOOP
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXIT WHEN public.is_tms_admin();
    v_admin := NULL;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  IF v_admin IS NULL OR v_site IS NULL THEN RAISE EXCEPTION 'CAJA C74 FAIL: falta administrador o sede'; END IF;
  SELECT id INTO v_ca FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id <> v_admin ORDER BY id LIMIT 1;
  SELECT id INTO v_other FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_ca) ORDER BY id LIMIT 1;
  IF v_other IS NULL THEN RAISE EXCEPTION 'CAJA C74 FAIL: se requieren 3 perfiles'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C74 sin cartera ' || suffix, '["despacho"]') RETURNING id INTO v_role_other;
  UPDATE public.profiles SET role_id = v_role_ca, is_active = true WHERE id = v_ca;
  UPDATE public.profiles SET role_id = v_role_other, is_active = true WHERE id = v_other;
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_ca, v_site), (v_other, v_site) ON CONFLICT DO NOTHING;
  IF v_site2 IS NOT NULL THEN DELETE FROM public.user_site_access WHERE user_id = v_ca AND site_id = v_site2; END IF;

  PERFORM pg_temp.c74_user(v_admin);
  r := public.create_contract(jsonb_build_object('code', 'ZZ-C74-' || suffix, 'type', 'CONTRATO', 'site_id', v_site), 0);
  v_root := (r->>'id')::uuid;
  IF v_site2 IS NOT NULL THEN
    r := public.create_contract(jsonb_build_object('code', 'ZZ-C74-LEJOS-' || suffix, 'type', 'CONTRATO', 'site_id', v_site2), 0);
    v_far := (r->>'id')::uuid;
  END IF;
  PERFORM pg_temp.c74_user(NULL);
  IF v_root IS NULL THEN RAISE EXCEPTION 'CAJA C74 FAIL: no se pudo crear la OT de prueba: %', r; END IF;

  -- T2: el Administrador de Contratos ve la OT sin responsable de su sede (y no la de otra sede)
  PERFORM pg_temp.c74_user(v_ca);
  IF NOT EXISTS (SELECT 1 FROM public.contract_admin_available_ots() WHERE id = v_root)
     OR (v_far IS NOT NULL AND EXISTS (SELECT 1 FROM public.contract_admin_available_ots() WHERE id = v_far)) THEN
    RAISE EXCEPTION 'CAJA C74 FAIL: lista de OT disponibles (T2)'; END IF;

  -- T3: la asume como Responsable de OT y pasa a su cartera (con escritura)
  r := public.claim_contract_responsibility(ARRAY[v_root] || CASE WHEN v_far IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[v_far] END);
  IF (r->>'asignadas')::int <> 1 OR NOT public.has_assigned_contract(v_root, true)
     OR EXISTS (SELECT 1 FROM public.contract_admin_available_ots() WHERE id = v_root) THEN
    RAISE EXCEPTION 'CAJA C74 FAIL: asumir OT (T3): %', r; END IF;
  IF v_far IS NOT NULL AND ((r->>'omitidas')::int <> 1 OR public.has_assigned_contract(v_far)) THEN
    RAISE EXCEPTION 'CAJA C74 FAIL: asumió una OT de otra sede (T3): %', r; END IF;
  PERFORM pg_temp.c74_user(NULL);

  -- T3b: una OT cerrada no se puede asumir aunque se llame a la función directamente
  PERFORM pg_temp.c74_user(v_admin);
  r := public.create_contract(jsonb_build_object('code', 'ZZ-C74-CERRADA-' || suffix, 'type', 'CONTRATO', 'site_id', v_site), 0);
  PERFORM pg_temp.c74_user(NULL);
  UPDATE public.contracts SET status = 'CERRADO' WHERE id = (r->>'id')::uuid;
  PERFORM pg_temp.c74_user(v_ca);
  r := public.claim_contract_responsibility(ARRAY[(r->>'id')::uuid]);
  IF (r->>'asignadas')::int <> 0 OR (r->>'omitidas')::int <> 1 THEN
    RAISE EXCEPTION 'CAJA C74 FAIL: asumió una OT cerrada (T3): %', r; END IF;
  PERFORM pg_temp.c74_user(NULL);

  -- T4: un usuario sin el rol no puede listar ni asumir OT
  PERFORM pg_temp.c74_user(v_other);
  BEGIN PERFORM public.claim_contract_responsibility(ARRAY[v_root]); v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err IS NULL THEN RAISE EXCEPTION 'CAJA C74 FAIL: otro rol asume OT (T4)'; END IF;
  BEGIN PERFORM public.contract_admin_available_ots(); v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err IS NULL THEN RAISE EXCEPTION 'CAJA C74 FAIL: otro rol lista OT (T4)'; END IF;
  PERFORM pg_temp.c74_user(NULL);

  -- T5: otro Administrador de Contratos no puede quitarle la OT ya tomada
  UPDATE public.profiles SET role_id = v_role_ca WHERE id = v_other;
  PERFORM pg_temp.c74_user(v_other);
  r := public.claim_contract_responsibility(ARRAY[v_root]);
  PERFORM pg_temp.c74_user(NULL);
  SELECT count(*) INTO n FROM public.contract_user_assignments WHERE contract_id = v_root AND role = 'ADMIN_CONTRATO' AND active;
  IF (r->>'asignadas')::int <> 0 OR (r->>'omitidas')::int <> 1 OR n <> 1
     OR NOT EXISTS (SELECT 1 FROM public.contract_user_assignments WHERE contract_id = v_root AND user_id = v_ca AND active) THEN
    RAISE EXCEPTION 'CAJA C74 FAIL: reasignación indebida (T5): %', r; END IF;

  -- T6: anónimo sin acceso a las funciones
  IF has_function_privilege('anon', 'public.claim_contract_responsibility(uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.contract_admin_available_ots()', 'EXECUTE') THEN
    RAISE EXCEPTION 'CAJA C74 FAIL: funciones expuestas a anónimos (T6)'; END IF;

  RAISE EXCEPTION 'CAJA C74 PASS (6/6) Administrador de Contratos: permisos y selección de sus OT como Responsable';
END $test$;
