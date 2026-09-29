-- Pruebas C13 — Tarifario de transporte: permisos, prioridad contrato > cliente > general, unidad sugerida por peso,
-- varias paradas, descarga, placa como excepción, tarifas faltantes y desglose guardado en la solicitud.
-- Termina en error para forzar ROLLBACK: "CAJA C13 PASS/FAIL".
--   npx supabase db query --linked -f supabase/tests/caja_c13_tarifario.test.sql
BEGIN;

CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

CREATE FUNCTION pg_temp.try_insert_rate(p_district text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.freight_rates (origin, district, vehicle_type, vehicle_class, rate) VALUES ('Planta Chilca', p_district, 'X', 'ZZ X', 1);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN SQLERRM;
END $$;

DO $test$
DECLARE
  v_tar uuid; v_sol uuid; v_nobody uuid; v_role_t uuid; v_role_s uuid; v_site uuid;
  cl1 uuid; cl2 uuid; k1 uuid; k2 uuid; k3 uuid; rq uuid;
  v_fail text[] := '{}';
  v_pass int := 0;
  q jsonb; q2 jsonb; q3 jsonb; r jsonb; v_err text; v_err2 text; v_err3 text;
BEGIN
  SELECT site_id INTO v_site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
  SELECT id INTO v_tar FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  SELECT id INTO v_sol FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id <> v_tar ORDER BY id LIMIT 1;
  SELECT id INTO v_nobody FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_tar, v_sol) ORDER BY id LIMIT 1;
  IF v_nobody IS NULL THEN RAISE EXCEPTION 'CAJA C13 FAIL: se requieren 3 perfiles'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ Tarifas C13', '["tarifas"]') RETURNING id INTO v_role_t;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ Solicitudes C13', '["solicitudes"]') RETURNING id INTO v_role_s;
  UPDATE public.profiles SET role_id = v_role_t, is_active = true WHERE id = v_tar;
  UPDATE public.profiles SET role_id = v_role_s, is_active = true WHERE id = v_sol;
  UPDATE public.profiles SET role_id = NULL, is_active = true WHERE id = v_nobody;
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_sol, v_site) ON CONFLICT DO NOTHING;
  INSERT INTO public.clients (business_name, tax_id, address, contact_name, phone, email, is_active) VALUES
    ('ZZ C13 Cliente Uno', '20999999922', 'x', 'x', 'x', 'x', true) RETURNING id INTO cl1;
  INSERT INTO public.clients (business_name, tax_id, address, contact_name, phone, email, is_active) VALUES
    ('ZZ C13 Cliente Dos', '20999999914', 'x', 'x', 'x', 'x', true) RETURNING id INTO cl2;
  INSERT INTO public.contracts (code, type, status, site_id, client_id) VALUES ('ZZ-C13-K1', 'CONTRATO', 'ACTIVO', v_site, cl1) RETURNING id INTO k1;
  INSERT INTO public.contracts (code, type, status, site_id, client_id) VALUES ('ZZ-C13-K2', 'CONTRATO', 'ACTIVO', v_site, cl1) RETURNING id INTO k2;
  INSERT INTO public.contracts (code, type, status, site_id, client_id) VALUES ('ZZ-C13-K3', 'CONTRATO', 'ACTIVO', v_site, cl2) RETURNING id INTO k3;
  INSERT INTO public.contract_budgets (contract_id, concept, allocated_pen) VALUES (k2, 'PARTIDA_TRANSPORTE', 5000);

  -- Tarifario de prueba (distritos y unidades ficticias para no chocar con las tarifas reales)
  INSERT INTO public.freight_rates (origin, district, vehicle_type, vehicle_class, capacity_ton, plate_number, scope, client_id, contract_id, concept, rate, client_price) VALUES
    ('Planta Chilca', 'ZZ Distrito Uno', 'Furgón', 'ZZ Furgón 4 t', 4, NULL, 'GENERAL', NULL, NULL, 'FLETE', 500, 650),
    ('Planta Chilca', 'ZZ Distrito Uno', 'Trailer', 'ZZ Trailer 32 t', 32, NULL, 'GENERAL', NULL, NULL, 'FLETE', 1400, NULL),
    ('Planta Chilca', 'ZZ Distrito Dos', 'Furgón', 'ZZ Furgón 4 t', 4, NULL, 'GENERAL', NULL, NULL, 'FLETE', 600, 780),
    ('Planta Chilca', 'ZZ Distrito Dos', 'Trailer', 'ZZ Trailer 32 t', 32, NULL, 'GENERAL', NULL, NULL, 'FLETE', 1600, NULL),
    ('Planta Chilca', 'ZZ Distrito Uno', 'Furgón', 'ZZ Furgón 4 t', 4, NULL, 'CLIENTE', cl1, NULL, 'FLETE', 450, 600),
    ('Planta Chilca', 'ZZ Distrito Uno', 'Furgón', 'ZZ Furgón 4 t', 4, NULL, 'CONTRATO', NULL, k1, 'FLETE', 420, 560),
    ('Planta Chilca', 'ZZ Distrito Uno', 'Furgón', 'ZZ Furgón 4 t', 4, 'ZZC13A', 'GENERAL', NULL, NULL, 'FLETE', 390, NULL),
    ('Planta Chilca', NULL, NULL, NULL, NULL, NULL, 'CLIENTE', cl1, NULL, 'PARADA_ADICIONAL', 80, 100),
    ('Planta Chilca', NULL, NULL, NULL, NULL, NULL, 'CLIENTE', cl1, NULL, 'MONTACARGAS', 250, 300),
    -- vencida: no debe usarse
    ('Planta Chilca', 'ZZ Distrito Uno', 'Furgón', 'ZZ Furgón 4 t', 4, NULL, 'CONTRATO', NULL, k2, 'FLETE', 10, NULL);
  UPDATE public.freight_rates SET valid_from = current_date - 30, valid_to = current_date - 1 WHERE contract_id = k2;

  -- T1: permisos: sin rol no cotiza; Solicitudes cotiza pero no edita el tarifario; Tarifas sí edita; flete exige distrito
  PERFORM pg_temp.as_user(v_nobody);
  v_err := NULL;
  BEGIN PERFORM public.quote_transport(k1, '[{"district":"ZZ Distrito Uno"}]'); EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  PERFORM pg_temp.as_user(v_sol);
  v_err2 := pg_temp.try_insert_rate('ZZ Distrito X');
  PERFORM pg_temp.as_user(v_tar);
  v_err3 := pg_temp.try_insert_rate('ZZ Distrito X');
  r := jsonb_build_object('sinDistrito', pg_temp.try_insert_rate(''));
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE 'Sin permiso%' AND v_err2 IS NOT NULL AND v_err3 IS NULL AND r->>'sinDistrito' LIKE '%necesita el distrito%'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 permisos: ' || concat_ws(' | ', COALESCE(v_err, '∅'), COALESCE(v_err2, '∅'), COALESCE(v_err3, '∅'), r::text)); END IF;

  -- T2: prioridad contrato > cliente > general, unidad sugerida por peso y tarifa vencida ignorada
  PERFORM pg_temp.as_user(v_sol);
  q := public.quote_transport(k1, '[{"district":"ZZ Distrito Uno"}]', 3000);
  q2 := public.quote_transport(k2, '[{"district":"zz distrito uno"}]', 3000);
  q3 := public.quote_transport(k3, '[{"district":"ZZ Distrito Uno"}]', 3000);
  PERFORM pg_temp.as_user(NULL);
  IF q->>'vehicle_class' = 'ZZ Furgón 4 t' AND (q->>'vehicle_class_suggested')::boolean
     AND (q->>'freight_total')::numeric = 420 AND q->'lines'->0->>'scope' = 'CONTRATO'
     AND (q2->>'freight_total')::numeric = 450 AND q2->'lines'->0->>'scope' = 'CLIENTE'
     AND (q3->>'freight_total')::numeric = 500 AND q3->'lines'->0->>'scope' = 'GENERAL' AND (q3->>'client_total')::numeric = 650
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 prioridad: ' || COALESCE(q::text, '∅') || ' || ' || COALESCE(q2::text, '∅') || ' || ' || COALESCE(q3::text, '∅')); END IF;

  -- T3: dos paradas: destino de mayor tarifa + parada adicional + montacargas; con 20 t sube a Trailer
  PERFORM pg_temp.as_user(v_sol);
  q := public.quote_transport(k2, '[{"district":"ZZ Distrito Uno"},{"district":"ZZ Distrito Dos"}]', 3000, NULL, NULL,
    '[{"concept":"MONTACARGAS","quantity":2}]');
  q2 := public.quote_transport(k2, '[{"district":"ZZ Distrito Uno"},{"district":"ZZ Distrito Dos"}]', 20000);
  PERFORM pg_temp.as_user(NULL);
  IF (q->>'freight_total')::numeric = 680 AND q->'lines'->0->>'district' = 'ZZ Distrito Dos'
     AND (q->>'unloading_total')::numeric = 500 AND (q->>'total')::numeric = 1180 AND (q->>'client_total')::numeric = 780 + 100 + 600
     AND q2->>'vehicle_class' = 'ZZ Trailer 32 t' AND (q2->>'freight_total')::numeric = 1680
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 paradas: ' || COALESCE(q::text, '∅') || ' || ' || COALESCE(q2::text, '∅')); END IF;

  -- T4: placa como excepción; destino sin tarifa se informa
  PERFORM pg_temp.as_user(v_sol);
  q := public.quote_transport(k3, '[{"district":"ZZ Distrito Uno"}]', NULL, NULL, 'zzc13a');
  q2 := public.quote_transport(k3, '[{"district":"ZZ Distrito Tres"}]', 3000);
  PERFORM pg_temp.as_user(NULL);
  IF (q->>'freight_total')::numeric = 390 AND q->>'vehicle_class' = 'ZZ Furgón 4 t'
     AND (q2->>'total')::numeric = 0 AND q2->'missing'->>0 LIKE 'Sin tarifa de flete a ZZ Distrito Tres%'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 placa/faltante: ' || COALESCE(q::text, '∅') || ' || ' || COALESCE(q2::text, '∅')); END IF;

  -- T5: costo referencial: el usuario no lo edita ni lo ajusta; el servidor lo calcula con el tarifario (flete + descarga)
  INSERT INTO public.transport_requests (request_number, status, site_id, contract_id, service_cost, requester_name, department, request_type, cargo_description, pickup_address, pickup_district, delivery_address, delivery_district, required_date)
  VALUES ('ZZ-C13-R1', 'PENDIENTE DE APROBACIÓN', v_site, k2, 520, 'ZZ', 'Logística', 'DESPACHO', 'Carga', 'Planta', 'Chilca', 'Obra', 'ZZ Distrito Uno', current_date) RETURNING id INTO rq;
  PERFORM pg_temp.as_user(v_sol);
  UPDATE public.transport_requests SET service_cost = 999 WHERE id = rq;
  v_err := public.set_request_cost_quote(rq, '{}'::jsonb, 'MANUAL', 'Acceso restringido')->>'error';
  PERFORM public.save_request_unloading_costs(rq, '[{"concept":"MONTACARGAS","estimated_pen":999}]');
  r := public.apply_request_tariff(rq);
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE '%referencial%' AND (r->>'success')::boolean
     AND (SELECT service_cost = 450 AND unloading_estimate_pen = 250 AND cost_source = 'TARIFARIO'
                 AND (cost_breakdown->>'freight_total')::numeric = 450 FROM public.transport_requests WHERE id = rq)
     AND (SELECT estimated_pen = 250 FROM public.transport_unloading_costs WHERE transport_request_id = rq AND concept = 'MONTACARGAS')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T5 costo referencial: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(r::text, '∅') || ' costo='
       || (SELECT service_cost FROM public.transport_requests WHERE id = rq)); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C13 PASS (%/5)', v_pass;
  END IF;
  RAISE EXCEPTION 'CAJA C13 FAIL: %', array_to_string(v_fail, ' || ');
END $test$;

ROLLBACK;
