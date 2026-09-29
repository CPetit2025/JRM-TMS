-- Pruebas C8 — Solicitudes F2: partida observada, reserva al aprobar, levantamiento automático,
-- reprogramación y cancelación de solicitudes asignadas. Termina en error (ROLLBACK): "CAJA C8 PASS/FAIL".
--   npx supabase db query --linked -f supabase/tests/caja_c8_solicitud_partida.test.sql
BEGIN;

CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

-- Ejecuta un cambio de estado y devuelve el error (NULL si pasó)
CREATE FUNCTION pg_temp.try_status(p_id uuid, p_status text, p_date date DEFAULT NULL) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.set_transport_request_status(p_id, p_status, p_date);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN SQLERRM;
END $$;

DO $test$
DECLARE
  v_admin uuid; v_sup uuid; v_contr uuid;
  v_role_s uuid; v_role_c uuid; v_site uuid; v_carrier uuid;
  v_ct uuid; ra uuid; rb uuid; rc uuid; d1 uuid; d2 uuid;
  v_fail text[] := '{}';
  v_pass int := 0;
  v_err text; v_err2 text; v_err3 text;
BEGIN
  SELECT carrier_id, site_id INTO v_carrier, v_site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
  FOR v_admin IN SELECT id FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u) LOOP
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXIT WHEN public.is_tms_admin();
    v_admin := NULL;
  END LOOP;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'CAJA C8 FAIL: no hay administrador'; END IF;
  SELECT id INTO v_sup FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id <> v_admin ORDER BY id LIMIT 1;
  SELECT id INTO v_contr FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_sup) ORDER BY id LIMIT 1;
  IF v_contr IS NULL THEN RAISE EXCEPTION 'CAJA C8 FAIL: se requieren 3 perfiles'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ Sup Despacho C8', '["despacho-aprobacion","solicitudes:read"]') RETURNING id INTO v_role_s;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ Contratos C8', '["solicitudes"]') RETURNING id INTO v_role_c;
  UPDATE public.profiles SET role_id = v_role_s, is_active = true WHERE id = v_sup;
  UPDATE public.profiles SET role_id = v_role_c, is_active = true WHERE id = v_contr;
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_sup, v_site), (v_contr, v_site) ON CONFLICT DO NOTHING;
  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, status, current_odometer) VALUES
    ('ZZC8A', v_carrier, v_site, 'TRACTO', 'DISPONIBLE', 100), ('ZZC8B', v_carrier, v_site, 'TRACTO', 'DISPONIBLE', 100);
  INSERT INTO public.contracts (code, type, status, site_id) VALUES ('ZZ-C8-OT', 'CONTRATO', 'ACTIVO', v_site) RETURNING id INTO v_ct;
  INSERT INTO public.contract_budgets (contract_id, concept, allocated_pen) VALUES (v_ct, 'PARTIDA_TRANSPORTE', 1000);
  INSERT INTO public.transport_requests (request_number, status, site_id, contract_id, service_cost, requester_name, department, request_type, cargo_description, pickup_address, pickup_district, delivery_address, delivery_district, required_date) VALUES
    ('ZZ-C8-RA', 'PENDIENTE DE APROBACIÓN', v_site, v_ct, 400, 'ZZ', 'Logística', 'DESPACHO', 'Carga de prueba', 'Planta', 'Lurín', 'Obra', 'Ate', current_date),
    ('ZZ-C8-RB', 'PENDIENTE DE APROBACIÓN', v_site, v_ct, 800, 'ZZ', 'Logística', 'DESPACHO', 'Carga de prueba', 'Planta', 'Lurín', 'Obra', 'Ate', current_date),
    ('ZZ-C8-RC', 'ASIGNADA', v_site, v_ct, 0, 'ZZ', 'Logística', 'DESPACHO', 'Carga de prueba', 'Planta', 'Lurín', 'Obra', 'Ate', current_date);
  SELECT id INTO ra FROM public.transport_requests WHERE request_number = 'ZZ-C8-RA';
  SELECT id INTO rb FROM public.transport_requests WHERE request_number = 'ZZ-C8-RB';
  SELECT id INTO rc FROM public.transport_requests WHERE request_number = 'ZZ-C8-RC';

  -- T1: aprueba solo el Supervisor de Despacho; aprobar reserva el costo estimado
  PERFORM pg_temp.as_user(v_contr);
  v_err := pg_temp.try_status(ra, 'APROBADA');
  PERFORM pg_temp.as_user(v_sup);
  v_err2 := pg_temp.try_status(ra, 'APROBADA');
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE 'Solo el Supervisor de Despacho%' AND v_err2 IS NULL
     AND (SELECT status = 'APROBADA' AND reserved_pen = 400 AND approved_by = v_sup FROM public.transport_requests WHERE id = ra)
     AND (SELECT reserved_pen = 400 AND balance_pen = 600 FROM public.contract_budgets WHERE contract_id = v_ct)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 aprobar: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(v_err2, '∅')); END IF;

  -- T2: sin saldo la aprobación deja la solicitud OBSERVADA con el faltante; observada no se aprueba
  PERFORM pg_temp.as_user(v_sup);
  v_err := pg_temp.try_status(rb, 'APROBADA');
  v_err2 := pg_temp.try_status(rb, 'APROBADA');
  PERFORM pg_temp.as_user(NULL);
  IF v_err IS NULL AND v_err2 LIKE 'Solicitud observada%'
     AND (SELECT status = 'OBSERVADA' AND budget_shortfall = 200 AND reserved_pen = 0 FROM public.transport_requests WHERE id = rb)
     AND (SELECT reserved_pen = 400 FROM public.contract_budgets WHERE contract_id = v_ct)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 observada: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(v_err2, '∅')); END IF;

  -- T3: ampliar la partida levanta la observación; luego se aprueba y reserva
  UPDATE public.contract_budgets SET allocated_pen = 1200 WHERE contract_id = v_ct;
  PERFORM pg_temp.as_user(v_sup);
  v_err := pg_temp.try_status(rb, 'APROBADA');
  PERFORM pg_temp.as_user(NULL);
  IF v_err IS NULL AND (SELECT status = 'APROBADA' AND reserved_pen = 800 AND budget_observation IS NULL FROM public.transport_requests WHERE id = rb)
     AND (SELECT reserved_pen = 1200 AND balance_pen = 0 FROM public.contract_budgets WHERE contract_id = v_ct)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 levantar: ' || COALESCE(v_err, '∅')); END IF;

  -- T4: reprogramar una aprobada (Supervisor) conserva su reserva; Contratos sin rol de administrador no reprograma
  PERFORM pg_temp.as_user(v_sup);
  v_err := pg_temp.try_status(ra, 'REPROGRAMADA', current_date + 3);
  PERFORM pg_temp.as_user(v_contr);
  v_err2 := pg_temp.try_status(rb, 'REPROGRAMADA', current_date + 3);
  PERFORM pg_temp.as_user(NULL);
  IF v_err IS NULL AND v_err2 LIKE 'Reprograman el Supervisor%'
     AND (SELECT status = 'REPROGRAMADA' AND reserved_pen = 400 AND approved_at IS NOT NULL FROM public.transport_requests WHERE id = ra)
     AND (SELECT reserved_pen = 1200 FROM public.contract_budgets WHERE contract_id = v_ct)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 reprogramar: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(v_err2, '∅')); END IF;

  -- T5: al programarse se libera su reserva; si se cancela estando en un despacho PROGRAMADO sale del despacho
  --     (sin paradas el despacho se cancela y libera su flete)
  UPDATE public.transport_requests SET status = 'ASIGNADA' WHERE id = ra;
  INSERT INTO public.dispatches (dispatch_number, vehicle_plate, status, site_id, contract_id, freight_cost)
  VALUES ('ZZ-C8-D1', 'ZZC8A', 'PROGRAMADO', v_site, v_ct, 300) RETURNING id INTO d1;
  INSERT INTO public.dispatch_requests (dispatch_id, transport_request_id, status) VALUES (d1, ra, 'PROGRAMADO');
  UPDATE public.contract_budgets SET reserved_pen = reserved_pen + 300 WHERE contract_id = v_ct;
  PERFORM pg_temp.as_user(v_contr);
  v_err := pg_temp.try_status(ra, 'CANCELADA');
  PERFORM pg_temp.as_user(NULL);
  IF v_err IS NULL AND (SELECT status = 'CANCELADA' FROM public.transport_requests WHERE id = ra)
     AND (SELECT status = 'CANCELADO' FROM public.dispatches WHERE id = d1)
     AND (SELECT reserved_pen = 800 FROM public.contract_budgets WHERE contract_id = v_ct)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T5 retirar: ' || COALESCE(v_err, '∅') || ' ' ||
       (SELECT reserved_pen::text FROM public.contract_budgets WHERE contract_id = v_ct)); END IF;

  -- T6: con la unidad en ruta no se cancela ni reprograma
  INSERT INTO public.dispatches (dispatch_number, vehicle_plate, status, site_id, contract_id, freight_cost)
  VALUES ('ZZ-C8-D2', 'ZZC8B', 'EN RUTA', v_site, v_ct, 0) RETURNING id INTO d2;
  INSERT INTO public.dispatch_requests (dispatch_id, transport_request_id, status) VALUES (d2, rc, 'PROGRAMADO');
  PERFORM pg_temp.as_user(v_sup);
  v_err := pg_temp.try_status(rc, 'CANCELADA');
  v_err2 := pg_temp.try_status(rc, 'REPROGRAMADA', current_date + 1);
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE 'La unidad ya está en ruta%' AND v_err2 LIKE 'La unidad ya está en ruta%'
     AND (SELECT status = 'ASIGNADA' FROM public.transport_requests WHERE id = rc)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T6 en ruta: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(v_err2, '∅')); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C8 PASS (%/6)', v_pass;
  END IF;
  RAISE EXCEPTION 'CAJA C8 FAIL: %', array_to_string(v_fail, ' || ');
END $test$;

ROLLBACK;
