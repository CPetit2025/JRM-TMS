-- CAJA C15 — Regularización de gastos de OT, subcontrato o error: partida, historial y anulación
-- Se ejecuta dentro de un bloque que siempre se revierte: no deja datos.
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

-- Registra un gasto y devuelve el error (NULL si pasó)
CREATE FUNCTION pg_temp.try_register(p_contract uuid, p_type text, p_amount numeric) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.register_contract_service(p_contract, p_type, 'ZZ C15 ' || p_type, p_amount, current_date,
    NULL, NULL, CASE WHEN p_type = 'MONTACARGA' THEN 4 END, NULL, 'ZZ Proveedor C15', 'Contrato', NULL);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN SQLERRM;
END $$;

DO $test$
DECLARE
  v_user uuid; v_role uuid; v_site uuid;
  v_root uuid; v_sub uuid; v_err uuid;
  v_svc uuid; r jsonb; r2 jsonb;
  e1 text; e2 text; e3 text;
  v_fail text[] := '{}';
  v_pass int := 0;
BEGIN
  SELECT site_id INTO v_site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
  SELECT id INTO v_user FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  IF v_user IS NULL THEN RAISE EXCEPTION 'CAJA C15 FAIL: no hay perfiles'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ Servicios C15', '["contratos-servicios","ot"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET role_id = v_role, is_active = true WHERE id = v_user;
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_user, v_site) ON CONFLICT DO NOTHING;

  INSERT INTO public.contracts (code, type, status, site_id) VALUES ('ZZ-C15-OT', 'CONTRATO', 'ACTIVO', v_site) RETURNING id INTO v_root;
  INSERT INTO public.contracts (code, type, status, site_id, parent_contract_id) VALUES ('ZZ-C15-OT-S1', 'SUBCONTRATO', 'ACTIVO', v_site, v_root) RETURNING id INTO v_sub;
  INSERT INTO public.contracts (code, type, status, site_id, parent_contract_id) VALUES ('ZZ-C15-OT-E1', 'ERROR', 'ACTIVO', v_site, v_root) RETURNING id INTO v_err;
  UPDATE public.contract_budgets SET allocated_pen = 1000 WHERE contract_id = v_root AND concept = 'PARTIDA_TRANSPORTE';
  IF NOT FOUND THEN
    INSERT INTO public.contract_budgets (contract_id, concept, allocated_pen) VALUES (v_root, 'PARTIDA_TRANSPORTE', 1000);
  END IF;
  DELETE FROM public.contract_budgets WHERE contract_id IN (v_sub, v_err);

  -- T1: gasto de montacargas en el subcontrato (sin partida propia) descuenta la partida de la OT madre
  PERFORM pg_temp.as_user(v_user);
  e1 := pg_temp.try_register(v_sub, 'MONTACARGA', 300);
  PERFORM pg_temp.as_user(NULL);
  SELECT id INTO v_svc FROM public.contract_services WHERE contract_id = v_sub AND description = 'ZZ C15 MONTACARGA';
  IF e1 IS NULL AND v_svc IS NOT NULL
     AND (SELECT budget_contract_id = v_root AND status = 'REGISTRADO' AND hours = 4 FROM public.contract_services WHERE id = v_svc)
     AND (SELECT consumed_pen = 300 AND balance_pen = 700 FROM public.contract_budgets WHERE contract_id = v_root AND concept = 'PARTIDA_TRANSPORTE')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 subcontrato: ' || COALESCE(e1, '∅')); END IF;

  -- T2: gastos en el error y en la OT madre también descuentan la partida madre
  PERFORM pg_temp.as_user(v_user);
  e1 := pg_temp.try_register(v_err, 'OTROS', 150);
  e2 := pg_temp.try_register(v_root, 'GRUA', 200);
  PERFORM pg_temp.as_user(NULL);
  IF e1 IS NULL AND e2 IS NULL
     AND (SELECT consumed_pen = 650 FROM public.contract_budgets WHERE contract_id = v_root AND concept = 'PARTIDA_TRANSPORTE')
     AND (SELECT count(*) = 3 FROM public.contract_services WHERE contract_id IN (v_root, v_sub, v_err) AND description LIKE 'ZZ C15 %')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 error y OT: ' || COALESCE(e1, '∅') || ' | ' || COALESCE(e2, '∅')); END IF;

  -- T3: sin saldo no se registra (usuario no administrador)
  PERFORM pg_temp.as_user(v_user);
  e3 := pg_temp.try_register(v_sub, 'ESTIBA', 400);
  PERFORM pg_temp.as_user(NULL);
  IF e3 LIKE 'Saldo insuficiente%'
     AND (SELECT consumed_pen = 650 FROM public.contract_budgets WHERE contract_id = v_root AND concept = 'PARTIDA_TRANSPORTE')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 saldo: ' || COALESCE(e3, '∅')); END IF;

  -- T4: anular el gasto devuelve el monto a la partida madre y queda en el historial como ANULADO
  PERFORM pg_temp.as_user(v_user);
  r := public.void_contract_service(v_svc, '');
  r2 := public.void_contract_service(v_svc, 'Duplicado con la factura F001-12');
  PERFORM pg_temp.as_user(NULL);
  IF NOT (r->>'success')::boolean AND (r2->>'success')::boolean
     AND (SELECT status = 'ANULADO' AND void_reason LIKE 'Duplicado%' AND voided_by = v_user FROM public.contract_services WHERE id = v_svc)
     AND (SELECT consumed_pen = 350 FROM public.contract_budgets WHERE contract_id = v_root AND concept = 'PARTIDA_TRANSPORTE')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 anular: ' || COALESCE(r::text, '∅') || ' | ' || COALESCE(r2::text, '∅')); END IF;

  -- T5: no se anula dos veces y la edición del monto ajusta la partida madre
  PERFORM pg_temp.as_user(v_user);
  r := public.void_contract_service(v_svc, 'otra vez');
  PERFORM public.update_contract_service_amount((SELECT id FROM public.contract_services WHERE contract_id = v_err AND description = 'ZZ C15 OTROS'), 100);
  PERFORM pg_temp.as_user(NULL);
  IF NOT (r->>'success')::boolean AND r->>'error' LIKE '%ya está anulado%'
     AND (SELECT consumed_pen = 300 FROM public.contract_budgets WHERE contract_id = v_root AND concept = 'PARTIDA_TRANSPORTE')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T5 doble anulación/edición: ' || COALESCE(r::text, '∅')); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C15 PASS (%/5)', v_pass;
  ELSE
    RAISE EXCEPTION 'CAJA C15 FAIL (%/5): %', v_pass, array_to_string(v_fail, ' || ');
  END IF;
END $test$;
