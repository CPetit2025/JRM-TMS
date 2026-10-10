-- CAJA C76 — Partida de transporte de una OT con set_contract_transport_budget
-- (OT sin partida, actualización, subcontrato → OT raíz, permisos, cartera, reducción bajo lo comprometido)
-- Se ejecuta dentro de un bloque que siempre se revierte: no deja datos.
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;
CREATE FUNCTION pg_temp.own(p_contract uuid) RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE((to_jsonb(b)->>'own_allocated_pen')::numeric, b.allocated_pen)
    FROM public.contract_budgets b WHERE b.contract_id = p_contract AND b.concept = 'PARTIDA_TRANSPORTE';
$$;
-- La tabla de ajustes puede no existir en bases antiguas: se consulta solo si existe
CREATE FUNCTION pg_temp.adjusted(p_contract uuid, p_value numeric, p_reason text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  IF to_regclass('public.contract_budget_adjustments') IS NULL THEN RETURN true; END IF;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.contract_budget_adjustments WHERE contract_id = $1 AND new_value = $2 AND reason LIKE $3)'
    INTO v_ok USING p_contract, p_value, p_reason || '%';
  RETURN v_ok;
END $$;

-- Test-only temporary helpers: public execution defaults are intentionally revoked.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE
  v_admin uuid; v_none uuid; v_ca uuid; v_role_none uuid; v_role_ca uuid; v_site uuid;
  v_ot uuid; v_mother uuid; v_sub uuid; v_ca_ot uuid;
  r jsonb; r2 jsonb; v_err text; v_err2 text;
  v_suffix text := left(replace(gen_random_uuid()::text, '-', ''), 10);
  v_fail text[] := '{}';
  v_pass int := 0;
BEGIN
  SELECT site_id INTO v_site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
  FOR v_admin IN SELECT id FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u) LOOP
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXIT WHEN public.is_tms_admin();
    v_admin := NULL;
  END LOOP;
  IF v_admin IS NULL OR v_site IS NULL THEN RAISE EXCEPTION 'CAJA C76 FAIL: no hay administrador o sede'; END IF;
  SELECT id INTO v_none FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id <> v_admin ORDER BY id LIMIT 1;
  SELECT id INTO v_ca FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_none) ORDER BY id LIMIT 1;
  IF v_ca IS NULL THEN RAISE EXCEPTION 'CAJA C76 FAIL: se requieren 3 perfiles'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C76 sin OT ' || v_suffix, '["despacho","ot:read"]') RETURNING id INTO v_role_none;
  SELECT id INTO v_role_ca FROM public.roles WHERE name = 'Administrador de Contratos' LIMIT 1;
  IF v_role_ca IS NULL THEN
    INSERT INTO public.roles (name, permissions) VALUES ('Administrador de Contratos', '["ot:write","solicitudes"]') RETURNING id INTO v_role_ca;
  END IF;
  UPDATE public.profiles SET role_id = v_role_none, is_active = true WHERE id = v_none;
  UPDATE public.profiles SET role_id = v_role_ca, is_active = true WHERE id = v_ca;
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_none, v_site), (v_ca, v_site) ON CONFLICT DO NOTHING;

  -- T1: OT dada de alta sin partida (caso 16477): no tiene dueño de partida; al asignarla se crea con el monto
  PERFORM pg_temp.as_user(v_admin);
  r := public.create_contract(jsonb_build_object('code', 'ZZ-C76-' || v_suffix, 'type', 'CONTRATO', 'site_id', v_site), 0);
  v_ot := (r->>'id')::uuid;
  PERFORM pg_temp.as_user(NULL);
  DELETE FROM public.contract_budgets WHERE contract_id = v_ot;   -- como en producción: alta sin fila de partida
  PERFORM pg_temp.as_user(v_admin);
  r2 := public.set_contract_transport_budget(v_ot, 2764.10, 'ZZ C76 partida inicial');
  PERFORM pg_temp.as_user(NULL);
  IF (r->>'success')::boolean AND (r2->>'success')::boolean AND (r2->>'changed')::boolean
     AND (SELECT count(*) FROM public.contract_budgets WHERE contract_id = v_ot AND concept = 'PARTIDA_TRANSPORTE') = 1
     AND pg_temp.own(v_ot) = 2764.10 AND public.contract_budget_owner(v_ot) = v_ot
     AND (r2->>'budget_contract_id')::uuid = v_ot
     AND pg_temp.adjusted(v_ot, 2764.10, 'ZZ C76 partida inicial')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 asignar a OT sin partida: ' || COALESCE(r2::text, '∅')); END IF;

  -- T2: actualizar la partida existente (una sola fila) y repetir el mismo monto no cambia nada
  PERFORM pg_temp.as_user(v_admin);
  r := public.set_contract_transport_budget(v_ot, 3000, NULL);
  r2 := public.set_contract_transport_budget(v_ot, 3000, NULL);
  PERFORM pg_temp.as_user(NULL);
  IF (r->>'changed')::boolean AND (r->>'previous_pen')::numeric = 2764.10 AND NOT (r2->>'changed')::boolean
     AND pg_temp.own(v_ot) = 3000
     AND (SELECT count(*) FROM public.contract_budgets WHERE contract_id = v_ot AND concept = 'PARTIDA_TRANSPORTE') = 1
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 actualizar: ' || COALESCE(r::text, '∅') || ' | ' || COALESCE(r2::text, '∅')); END IF;

  -- T3: subcontrato de una madre sin partida: se crea la partida de la OT raíz y el aporte del subcontrato
  PERFORM pg_temp.as_user(v_admin);
  r := public.create_contract(jsonb_build_object('code', 'ZZ-C76M-' || v_suffix, 'type', 'CONTRATO', 'site_id', v_site), 0);
  v_mother := (r->>'id')::uuid;
  r := public.create_contract(jsonb_build_object('code', 'ZZ-C76M-' || v_suffix || '-S01', 'type', 'SUBCONTRATO', 'parent_contract_id', v_mother), 0);
  v_sub := (r->>'id')::uuid;
  PERFORM pg_temp.as_user(NULL);
  DELETE FROM public.contract_budgets WHERE contract_id IN (v_mother, v_sub);
  PERFORM pg_temp.as_user(v_admin);
  r := public.set_contract_transport_budget(v_sub, 500, NULL);
  PERFORM pg_temp.as_user(NULL);
  IF (r->>'success')::boolean AND (r->>'budget_contract_id')::uuid = v_mother
     -- Con la partida por familia (own_allocated_pen) el dueño es la raíz; en bases antiguas, el registro más cercano
     AND (public.contract_budget_owner(v_sub) = v_mother OR NOT EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'contract_budgets' AND column_name = 'own_allocated_pen'))
     AND pg_temp.own(v_sub) = 500 AND pg_temp.own(v_mother) = 0
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 subcontrato → OT raíz: ' || COALESCE(r::text, '∅')); END IF;

  -- T4: sin OT escritura no se modifica; montos negativos se rechazan
  v_err := NULL; v_err2 := NULL;
  PERFORM pg_temp.as_user(v_none);
  BEGIN PERFORM public.set_contract_transport_budget(v_ot, 1, NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
  PERFORM pg_temp.as_user(v_admin);
  BEGIN PERFORM public.set_contract_transport_budget(v_ot, -5, NULL); EXCEPTION WHEN raise_exception THEN v_err2 := SQLERRM; END;
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE 'Sin permiso%' AND v_err2 LIKE 'Indique un monto%' AND pg_temp.own(v_ot) = 3000
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 permisos/monto: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(v_err2, '∅')); END IF;

  -- T5: el Administrador de Contratos fija la partida de su OT, pero no la de una OT ajena
  v_err := NULL;
  PERFORM pg_temp.as_user(v_ca);
  r := public.create_contract(jsonb_build_object('code', 'ZZ-C76CA-' || v_suffix, 'type', 'OT_INDEPENDIENTE', 'site_id', v_site), 0);
  v_ca_ot := (r->>'id')::uuid;
  r2 := public.set_contract_transport_budget(v_ca_ot, 800, NULL);
  BEGIN PERFORM public.set_contract_transport_budget(v_ot, 10, NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
  PERFORM pg_temp.as_user(NULL);
  IF (r2->>'success')::boolean AND pg_temp.own(v_ca_ot) = 800 AND v_err LIKE '%no está asignada%' AND pg_temp.own(v_ot) = 3000
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T5 cartera: ' || COALESCE(r2::text, '∅') || ' | ' || COALESCE(v_err, '∅')); END IF;

  -- T6: no se reduce por debajo de lo ya reservado (el saldo no queda negativo); ampliar sí se permite
  v_err := NULL;
  UPDATE public.contract_budgets SET reserved_pen = 2000 WHERE contract_id = v_ot AND concept = 'PARTIDA_TRANSPORTE';
  PERFORM pg_temp.as_user(v_admin);
  BEGIN PERFORM public.set_contract_transport_budget(v_ot, 1500, NULL); EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
  r := public.set_contract_transport_budget(v_ot, 4000, NULL);
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE 'No se puede reducir%' AND (r->>'changed')::boolean AND pg_temp.own(v_ot) = 4000
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T6 reducción: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(r::text, '∅')); END IF;

  -- T7: la función no es pública (anon/PUBLIC sin EXECUTE; authenticated sí, valida por dentro)
  IF NOT has_function_privilege('anon', 'public.set_contract_transport_budget(uuid,numeric,text)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.set_contract_transport_budget(uuid,numeric,text)', 'EXECUTE')
     AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                      WHERE p.oid = 'public.set_contract_transport_budget(uuid,numeric,text)'::regprocedure AND a.grantee = 0)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T7 permisos de ejecución'::text; END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C76 PASS (%/7) partida de transporte: OT sin partida, actualización, OT raíz, permisos, cartera y reducción', v_pass;
  ELSE
    RAISE EXCEPTION 'CAJA C76 FAIL (%/7): %', v_pass, array_to_string(v_fail, ' || ');
  END IF;
END $test$;
