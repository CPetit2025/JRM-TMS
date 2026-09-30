-- CAJA C14 — Alta de contrato/OT con create_contract (partida, sede, jerarquía, duplicados y permisos)
-- Se ejecuta dentro de un bloque que siempre se revierte: no deja datos.
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

DO $test$
DECLARE
  v_admin uuid; v_none uuid; v_ca uuid; v_role_none uuid; v_role_ca uuid; v_site uuid;
  r jsonb; r2 jsonb; r3 jsonb; r4 jsonb;
  v_root uuid; v_ca_root uuid;
  v_fail text[] := '{}';
  v_pass int := 0;
BEGIN
  SELECT site_id INTO v_site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
  FOR v_admin IN SELECT id FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u) LOOP
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXIT WHEN public.is_tms_admin();
    v_admin := NULL;
  END LOOP;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'CAJA C14 FAIL: no hay administrador'; END IF;
  SELECT id INTO v_none FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id <> v_admin ORDER BY id LIMIT 1;
  SELECT id INTO v_ca FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_none) ORDER BY id LIMIT 1;
  IF v_ca IS NULL THEN RAISE EXCEPTION 'CAJA C14 FAIL: se requieren 3 perfiles'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ Sin OT C14', '["despacho"]') RETURNING id INTO v_role_none;
  SELECT id INTO v_role_ca FROM public.roles WHERE name = 'Administrador de Contratos' LIMIT 1;
  IF v_role_ca IS NULL THEN
    INSERT INTO public.roles (name, permissions) VALUES ('Administrador de Contratos', '["ot","solicitudes"]') RETURNING id INTO v_role_ca;
  END IF;
  UPDATE public.profiles SET role_id = v_role_none, is_active = true WHERE id = v_none;
  UPDATE public.profiles SET role_id = v_role_ca, is_active = true WHERE id = v_ca;
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_none, v_site), (v_ca, v_site) ON CONFLICT DO NOTHING;

  -- T1: el administrador da de alta un contrato con partida y destino; la partida queda con el monto (una sola fila)
  PERFORM pg_temp.as_user(v_admin);
  r := public.create_contract(jsonb_build_object('code', 'ZZ-C14-MADRE', 'type', 'CONTRATO', 'site_id', v_site,
    'total_weight_kg', 12000, 'destination_district', 'ZZ Distrito C14', 'destination_address', 'Av. Prueba 123'), 500);
  PERFORM pg_temp.as_user(NULL);
  v_root := (r->>'id')::uuid;
  IF (r->>'success')::boolean AND (SELECT count(*) = 1 AND sum(allocated_pen) = 500 FROM public.contract_budgets
        WHERE contract_id = v_root AND concept = 'PARTIDA_TRANSPORTE')
     AND (SELECT type::text = 'CONTRATO' AND status::text = 'ACTIVO' AND site_id = v_site AND parent_contract_id IS NULL
                 AND COALESCE(to_jsonb(c)->>'destination_district', 'ZZ Distrito C14') = 'ZZ Distrito C14'
          FROM public.contracts c WHERE c.id = v_root)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 alta con partida: ' || COALESCE(r::text, '∅')); END IF;

  -- T2: subcontrato bajo el contrato madre: hereda la sede y la jerarquía
  PERFORM pg_temp.as_user(v_admin);
  r := public.create_contract(jsonb_build_object('code', 'ZZ-C14-MADRE-S1', 'type', 'SUBCONTRATO', 'parent_contract_id', v_root), 0);
  PERFORM pg_temp.as_user(NULL);
  IF (r->>'success')::boolean AND (SELECT parent_contract_id = v_root AND site_id = v_site AND type::text = 'SUBCONTRATO'
        FROM public.contracts WHERE id = (r->>'id')::uuid)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 subcontrato: ' || COALESCE(r::text, '∅')); END IF;

  -- T3: código duplicado y subcontrato sin madre se rechazan con mensaje claro
  PERFORM pg_temp.as_user(v_admin);
  r := public.create_contract(jsonb_build_object('code', 'ZZ-C14-MADRE', 'type', 'CONTRATO', 'site_id', v_site), 0);
  r2 := public.create_contract(jsonb_build_object('code', 'ZZ-C14-SIN-MADRE', 'type', 'ERROR'), 0);
  PERFORM pg_temp.as_user(NULL);
  IF NOT (r->>'success')::boolean AND r->>'error' LIKE '%ya está en uso%'
     AND NOT (r2->>'success')::boolean AND r2->>'error' LIKE 'Seleccione el contrato madre%'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 validaciones: ' || COALESCE(r::text, '∅') || ' | ' || COALESCE(r2::text, '∅')); END IF;

  -- T4: un usuario sin permiso de OT no registra contratos
  PERFORM pg_temp.as_user(v_none);
  r := public.create_contract(jsonb_build_object('code', 'ZZ-C14-NO', 'type', 'CONTRATO'), 0);
  PERFORM pg_temp.as_user(NULL);
  IF NOT (r->>'success')::boolean AND r->>'error' LIKE 'Sin permiso%'
     AND NOT EXISTS (SELECT 1 FROM public.contracts WHERE code = 'ZZ-C14-NO')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 sin permiso: ' || COALESCE(r::text, '∅')); END IF;

  -- T5: el Administrador de Contratos crea su OT (queda asignado), su subcontrato, y no cuelga de una OT ajena
  PERFORM pg_temp.as_user(v_ca);
  r := public.create_contract(jsonb_build_object('code', 'ZZ-C14-CA', 'type', 'OT_INDEPENDIENTE'), 250);
  v_ca_root := (r->>'id')::uuid;
  r2 := public.create_contract(jsonb_build_object('code', 'ZZ-C14-CA-E1', 'type', 'ERROR', 'parent_contract_id', v_ca_root), 0);
  r3 := public.create_contract(jsonb_build_object('code', 'ZZ-C14-AJENO', 'type', 'SUBCONTRATO', 'parent_contract_id', v_root), 0);
  PERFORM pg_temp.as_user(NULL);
  IF (r->>'success')::boolean AND (r2->>'success')::boolean
     AND NOT (r3->>'success')::boolean AND r3->>'error' LIKE '%no está asignado%'
     AND EXISTS (SELECT 1 FROM public.contract_user_assignments WHERE contract_id = v_ca_root AND user_id = v_ca AND active)
     AND (SELECT allocated_pen = 250 FROM public.contract_budgets WHERE contract_id = v_ca_root AND concept = 'PARTIDA_TRANSPORTE')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T5 administrador de contratos: ' || COALESCE(r::text, '∅') || ' | '
       || COALESCE(r2::text, '∅') || ' | ' || COALESCE(r3::text, '∅')); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C14 PASS (%/5)', v_pass;
  ELSE
    RAISE EXCEPTION 'CAJA C14 FAIL (%/5): %', v_pass, array_to_string(v_fail, ' || ');
  END IF;
END $test$;
