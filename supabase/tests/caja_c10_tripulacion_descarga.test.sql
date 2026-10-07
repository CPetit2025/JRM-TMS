-- Partida bruta: 1250 deja 1000 operativos (80%); se conserva el escenario de saldo de esta regresión.
-- Pruebas C10 — Despacho F4: tripulación del despacho y costos de descarga amarrados a la partida
-- (estimación en la solicitud, planificación con reserva, consumo real por Caja sin duplicar, reversión,
-- factura directa, anulación y liberación al retirar la parada). Termina en error (ROLLBACK): "CAJA C10 PASS/FAIL".
--   npx supabase db query --linked -f supabase/tests/caja_c10_tripulacion_descarga.test.sql
BEGIN;
-- Isolate this legacy scenario from the separately tested mandatory anticipation policy.
-- The change is transaction-local and is rolled back with every fixture.
DO $legacy_policy$ BEGIN
 IF to_regclass('public.transport_lead_time_settings') IS NOT NULL THEN
  EXECUTE 'UPDATE public.transport_lead_time_settings SET settings=jsonb_set(settings,''{enabled}'',''false''::jsonb)';
 END IF;
END $legacy_policy$;

CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

-- Test-only temporary helpers: public execution defaults are intentionally revoked.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE
  v_admin uuid; v_desp uuid; v_contr uuid; v_nobody uuid; v_drv_prof uuid; w1 uuid; w2 uuid;
  v_role_d uuid; v_role_c uuid; v_site uuid; v_carrier uuid; v_driver uuid;
  v_ct uuid; ra uuid; rb uuid; d1 uuid; d2 uuid; e1 uuid; e2 uuid;
  l_mont uuid; l_est uuid; l_grua uuid;
  v_fail text[] := '{}';
  v_pass int := 0;
  r jsonb; v_err text; v_err2 text; v_err3 text; v_n int; v_res numeric; v_con numeric;
BEGIN
  SELECT carrier_id, site_id INTO v_carrier, v_site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
  FOR v_admin IN SELECT id FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u) LOOP
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXIT WHEN public.is_tms_admin();
    v_admin := NULL;
  END LOOP;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'CAJA C10 FAIL: no hay administrador'; END IF;
  SELECT id INTO v_desp FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id <> v_admin ORDER BY id LIMIT 1;
  SELECT id INTO v_contr FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_desp) ORDER BY id LIMIT 1;
  SELECT id INTO v_nobody FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_desp, v_contr) ORDER BY id LIMIT 1;
  SELECT id INTO v_drv_prof FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_desp, v_contr, v_nobody) ORDER BY id LIMIT 1;
  IF v_drv_prof IS NULL THEN RAISE EXCEPTION 'CAJA C10 FAIL: se requieren 5 perfiles'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ Transporte C10', '["despacho"]') RETURNING id INTO v_role_d;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ Contratos C10', '["solicitudes"]') RETURNING id INTO v_role_c;
  UPDATE public.profiles SET role_id = v_role_d, is_active = true WHERE id = v_desp;
  UPDATE public.profiles SET role_id = v_role_c, is_active = true WHERE id = v_contr;
  UPDATE public.profiles SET role_id = NULL, is_active = true WHERE id IN (v_nobody, v_drv_prof);
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_desp, v_site), (v_contr, v_site) ON CONFLICT DO NOTHING;
  -- Trabajadores (perfiles sin cuenta, como los crea el maestro de Trabajadores)
  w1 := gen_random_uuid(); w2 := gen_random_uuid();
  -- (mismas columnas que inserta el maestro; en producción profiles no tiene email)
  INSERT INTO public.profiles (id, first_name, last_name, employee_type, is_active) VALUES
    (w1, 'Ayudante', 'Uno', 'Auxiliar de Transporte', true),
    (w2, 'Estibador', 'Dos', 'Auxiliar de Despacho', true);
  INSERT INTO public.drivers (carrier_id, profile_id, first_name, last_name, document_number, license_number, is_active)
  VALUES (v_carrier, v_drv_prof, 'Conductor', 'C10', 'ZZC10-DOC', 'ZZC10-LIC', true) RETURNING id INTO v_driver;
  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, status, current_odometer) VALUES
    ('ZZC10A', v_carrier, v_site, 'TRACTO', 'DISPONIBLE', 100), ('ZZC10B', v_carrier, v_site, 'TRACTO', 'DISPONIBLE', 100);
  INSERT INTO public.contracts (code, type, status, site_id) VALUES ('ZZ-C10-OT', 'CONTRATO', 'ACTIVO', v_site) RETURNING id INTO v_ct;
  INSERT INTO public.contract_budgets (contract_id, concept, allocated_pen) VALUES (v_ct, 'PARTIDA_TRANSPORTE', 1250);
  INSERT INTO public.transport_requests (request_number, status, site_id, contract_id, service_cost, requester_name, department, request_type, cargo_description, pickup_address, pickup_district, delivery_address, delivery_district, required_date) VALUES
    ('ZZ-C10-RA', 'PENDIENTE DE APROBACIÓN', v_site, v_ct, 300, 'ZZ', 'Logística', 'DESPACHO', 'Carga de prueba', 'Planta', 'Lurín', 'Obra A', 'Ate', current_date),
    ('ZZ-C10-RB', 'APROBADA', v_site, v_ct, 0, 'ZZ', 'Logística', 'DESPACHO', 'Carga de prueba', 'Planta', 'Lurín', 'Obra B', 'Ate', current_date);
  SELECT id INTO ra FROM public.transport_requests WHERE request_number = 'ZZ-C10-RA';
  SELECT id INTO rb FROM public.transport_requests WHERE request_number = 'ZZ-C10-RB';
  UPDATE public.transport_requests SET approved_at = now() WHERE id = rb;

  -- T1: Contratos estima la descarga; flete + descarga sobre el saldo deja la solicitud observada y se levanta al corregir
  PERFORM pg_temp.as_user(v_contr);
  r := public.save_request_unloading_costs(ra, '[{"concept":"MONTACARGAS","estimated_pen":200},{"concept":"ESTIBA","estimated_pen":100}]');
  v_err := (SELECT status FROM public.transport_requests WHERE id = ra);
  r := public.save_request_unloading_costs(ra, '[{"concept":"GRUA","estimated_pen":800}]');
  v_err2 := (SELECT status || ' ' || COALESCE(budget_observation, '') FROM public.transport_requests WHERE id = ra);
  r := public.save_request_unloading_costs(ra, '[{"concept":"MONTACARGAS","estimated_pen":200},{"concept":"ESTIBA","estimated_pen":100}]');
  PERFORM pg_temp.as_user(v_nobody);
  v_err3 := public.save_request_unloading_costs(ra, '[]')->>'error';
  PERFORM pg_temp.as_user(NULL);
  UPDATE public.transport_requests SET status = 'APROBADA' WHERE id = ra;  -- el Supervisor de Despacho aprueba
  IF v_err = 'PENDIENTE DE APROBACIÓN' AND v_err2 LIKE 'OBSERVADA%flete + descarga%' AND (r->>'success')::boolean
     AND v_err3 LIKE 'Sin permiso%'
     AND (SELECT status = 'APROBADA' AND reserved_pen = 600 AND unloading_estimate_pen = 300 FROM public.transport_requests WHERE id = ra)
     AND (SELECT reserved_pen = 600 FROM public.contract_budgets WHERE contract_id = v_ct)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 estimación: ' || concat_ws(' | ', COALESCE(v_err, '∅'), COALESCE(v_err2, '∅'), COALESCE(v_err3, '∅'), COALESCE(r::text, '∅'))
       || ' reserva=' || (SELECT reserved_pen FROM public.contract_budgets WHERE contract_id = v_ct)); END IF;

  -- T2: tripulación: solo Transporte, sin el conductor, un trabajador no va en dos despachos; el conductor la ve
  PERFORM pg_temp.as_user(v_desp);
  d1 := public.schedule_dispatch(v_driver, 'ZZC10A', now() + interval '1 day', 10, 300, v_ct, 'GR',
    jsonb_build_array(jsonb_build_object('id', ra), jsonb_build_object('id', rb)));
  r := public.set_dispatch_crew(d1, jsonb_build_array(jsonb_build_object('profile_id', w1, 'crew_role', 'AYUDANTE'),
                                                     jsonb_build_object('profile_id', w2, 'crew_role', 'ESTIBADOR')));
  v_err := public.set_dispatch_crew(d1, jsonb_build_array(jsonb_build_object('profile_id', v_drv_prof)))->>'error';
  PERFORM pg_temp.as_user(v_nobody);
  v_err2 := public.set_dispatch_crew(d1, '[]')->>'error';
  PERFORM pg_temp.as_user(NULL);
  INSERT INTO public.dispatches (dispatch_number, vehicle_plate, status, site_id, contract_id) VALUES ('ZZ-C10-D2', 'ZZC10B', 'PROGRAMADO', v_site, v_ct) RETURNING id INTO d2;
  PERFORM pg_temp.as_user(v_desp);
  v_err3 := public.set_dispatch_crew(d2, jsonb_build_array(jsonb_build_object('profile_id', w2)))->>'error';
  PERFORM pg_temp.as_user(v_drv_prof);
  SELECT count(*) INTO v_n FROM public.get_dispatch_crew(d1);
  PERFORM pg_temp.as_user(NULL);
  IF (r->>'success')::boolean AND v_err LIKE '%es el conductor del despacho' AND v_err2 LIKE 'Solo el Supervisor de Transporte%'
     AND v_err3 LIKE '%ya está asignado al despacho%' AND v_n = 2
     -- al programar, la reserva de la solicitud (flete + descarga) cede su lugar al flete del despacho
     AND (SELECT reserved_pen = 300 FROM public.contract_budgets WHERE contract_id = v_ct)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 tripulación: ' || concat_ws(' | ', COALESCE(r::text, '∅'), COALESCE(v_err, '∅'), COALESCE(v_err2, '∅'), COALESCE(v_err3, '∅')) || ' n=' || v_n
       || ' reserva=' || (SELECT reserved_pen FROM public.contract_budgets WHERE contract_id = v_ct)); END IF;

  -- T3: Transporte planifica (reserva) sobre lo estimado y agrega una grúa; sin saldo no planifica
  SELECT id INTO l_mont FROM public.transport_unloading_costs WHERE transport_request_id = ra AND concept = 'MONTACARGAS';
  SELECT id INTO l_est FROM public.transport_unloading_costs WHERE transport_request_id = ra AND concept = 'ESTIBA';
  PERFORM pg_temp.as_user(v_desp);
  v_err := public.plan_dispatch_unloading(d1, jsonb_build_array(jsonb_build_object('id', l_mont, 'planned_pen', 5000)))->>'error';
  r := public.plan_dispatch_unloading(d1, jsonb_build_array(
    jsonb_build_object('id', l_mont, 'planned_pen', 250), jsonb_build_object('id', l_est, 'planned_pen', 100),
    jsonb_build_object('request_id', rb, 'concept', 'GRUA', 'description', 'Grúa en obra B', 'planned_pen', 50)));
  PERFORM pg_temp.as_user(NULL);
  SELECT id INTO l_grua FROM public.transport_unloading_costs WHERE transport_request_id = rb AND concept = 'GRUA';
  IF v_err LIKE 'Saldo insuficiente%' AND (r->>'success')::boolean
     AND (SELECT reserved_pen = 700 FROM public.contract_budgets WHERE contract_id = v_ct)
     AND (SELECT count(*) = 3 FROM public.transport_unloading_costs WHERE dispatch_id = d1 AND status = 'PLANIFICADO')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 planificación: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(r::text, '∅')
       || ' reserva=' || (SELECT reserved_pen FROM public.contract_budgets WHERE contract_id = v_ct)); END IF;

  -- T4: Caja aprueba el alquiler de montacargas del viaje → consume una vez (reserva 250 → consumo 230)
  INSERT INTO public.dispatch_expenses (dispatch_id, expense_type, amount, receipt_url) VALUES (d1, 'ALQUILER_EQUIPO', 230, 'u/zz-c10.jpg') RETURNING id INTO e1;
  PERFORM pg_temp.as_user(v_admin);
  r := public.review_dispatch_expense(e1, 'APROBAR', NULL, NULL, true);
  PERFORM pg_temp.as_user(NULL);
  SELECT reserved_pen, consumed_pen INTO v_res, v_con FROM public.contract_budgets WHERE contract_id = v_ct;
  IF (r->>'success')::boolean AND v_res = 450 AND v_con = 230
     AND (SELECT status = 'CONSUMIDO' AND actual_pen = 230 AND expense_id = e1 FROM public.transport_unloading_costs WHERE id = l_mont)
     AND (SELECT count(*) = 1 FROM public.contract_services WHERE dispatch_id = d1 AND service_type = 'MONTACARGA' AND amount_pen = 230)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 Caja: ' || COALESCE(r::text, '∅') || ' ' || v_res || '/' || v_con); END IF;

  -- T5: Caja revierte → se devuelve el consumo y vuelve la reserva; reaprobar no duplica
  PERFORM pg_temp.as_user(v_admin);
  r := public.review_dispatch_expense(e1, 'REVERTIR', 'Monto a corregir');
  SELECT reserved_pen, consumed_pen INTO v_res, v_con FROM public.contract_budgets WHERE contract_id = v_ct;
  v_err := (SELECT status FROM public.transport_unloading_costs WHERE id = l_mont);
  r := public.review_dispatch_expense(e1, 'APROBAR', NULL, NULL, true);
  PERFORM pg_temp.as_user(NULL);
  IF v_res = 700 AND v_con = 0 AND v_err = 'PLANIFICADO'
     AND (SELECT consumed_pen = 230 AND reserved_pen = 450 FROM public.contract_budgets WHERE contract_id = v_ct)
     AND (SELECT count(*) = 1 FROM public.contract_services WHERE dispatch_id = d1 AND service_type = 'MONTACARGA' AND COALESCE(status, '') <> 'ANULADO')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T5 reversión: ' || v_res || '/' || v_con || ' ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(r::text, '∅')); END IF;

  -- T6: estiba sin planificar extra por Caja crea línea no planificada; factura directa de la grúa; anular libera
  INSERT INTO public.dispatch_expenses (dispatch_id, expense_type, amount, receipt_url) VALUES (d1, 'CUADRILLA_ESTIBA', 90, 'u/zz-c10b.jpg') RETURNING id INTO e2;
  PERFORM pg_temp.as_user(v_admin);
  r := public.review_dispatch_expense(e2, 'APROBAR', NULL, NULL, true);  -- consume la estiba planificada (100 → 90)
  PERFORM pg_temp.as_user(v_desp);
  v_err := public.register_unloading_actual(l_grua, 60, 'Grúas del Sur')->>'error';
  PERFORM pg_temp.as_user(NULL);
  SELECT reserved_pen, consumed_pen INTO v_res, v_con FROM public.contract_budgets WHERE contract_id = v_ct;
  IF (r->>'success')::boolean AND v_err IS NULL AND v_res = 300 AND v_con = 380
     AND (SELECT status = 'CONSUMIDO' AND actual_pen = 90 FROM public.transport_unloading_costs WHERE id = l_est)
     AND (SELECT status = 'CONSUMIDO' AND provider_name = 'Grúas del Sur' FROM public.transport_unloading_costs WHERE id = l_grua)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T6 consumo: ' || COALESCE(r::text, '∅') || ' | ' || COALESCE(v_err, '∅') || ' ' || v_res || '/' || v_con); END IF;

  -- T7: la parada que sale del despacho libera su descarga planificada; cancelar libera la tripulación
  PERFORM pg_temp.as_user(v_desp);
  r := public.plan_dispatch_unloading(d2, '[]');
  PERFORM pg_temp.as_user(NULL);
  INSERT INTO public.transport_requests (request_number, status, site_id, contract_id, service_cost, requester_name, department, request_type, cargo_description, pickup_address, pickup_district, delivery_address, delivery_district, required_date)
  VALUES ('ZZ-C10-RC', 'ASIGNADA', v_site, v_ct, 0, 'ZZ', 'Logística', 'DESPACHO', 'Carga de prueba', 'Planta', 'Lurín', 'Obra C', 'Ate', current_date) RETURNING id INTO rb;
  INSERT INTO public.dispatch_requests (dispatch_id, transport_request_id, status) VALUES (d2, rb, 'PROGRAMADO');
  PERFORM pg_temp.as_user(v_desp);
  r := public.plan_dispatch_unloading(d2, jsonb_build_array(jsonb_build_object('request_id', rb, 'concept', 'OTROS', 'planned_pen', 40)));
  v_err := public.set_dispatch_crew(d2, jsonb_build_array(jsonb_build_object('profile_id', w1)))->>'error';  -- w1 sigue en D1
  PERFORM pg_temp.as_user(NULL);
  v_res := (SELECT reserved_pen FROM public.contract_budgets WHERE contract_id = v_ct);
  DELETE FROM public.dispatch_requests WHERE dispatch_id = d2 AND transport_request_id = rb;
  UPDATE public.dispatches SET status = 'CANCELADO' WHERE id = d1;
  IF (r->>'success')::boolean AND v_res = 340 AND v_err LIKE '%ya está asignado%'
     AND (SELECT reserved_pen = 300 FROM public.contract_budgets WHERE contract_id = v_ct)
     AND (SELECT status = 'ANULADO' FROM public.transport_unloading_costs WHERE transport_request_id = rb)
     AND NOT EXISTS (SELECT 1 FROM public.dispatch_crew WHERE dispatch_id = d1 AND removed_at IS NULL)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T7 liberación: ' || COALESCE(r::text, '∅') || ' | ' || COALESCE(v_err, '∅') || ' reserva antes=' || v_res
       || ' después=' || (SELECT reserved_pen FROM public.contract_budgets WHERE contract_id = v_ct)); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C10 PASS (%/7)', v_pass;
  END IF;
  RAISE EXCEPTION 'CAJA C10 FAIL: %', array_to_string(v_fail, ' || ');
END $test$;

ROLLBACK;
