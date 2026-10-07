-- Partida bruta: 1250 deja 1000 operativos (80%); se conserva el escenario de saldo de esta regresión.
-- Pruebas C7 — Despacho F1: permisos del cambio de estado, cancelación que libera, cierre que consume y
-- servicios de contrato con saldo validado. Termina en error para forzar ROLLBACK: "CAJA C7 PASS/FAIL".
--   npx supabase db query --linked -f supabase/tests/caja_c7_despacho_estados.test.sql
BEGIN;

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
  v_admin uuid; v_desp uuid; v_nobody uuid; v_drv_prof uuid; v_contr uuid;
  v_role_d uuid; v_role_c uuid; v_site uuid; v_carrier uuid; v_driver uuid;
  v_ct uuid; r1 uuid; r2 uuid; r3 uuid; d1 uuid; d2 uuid; s1 uuid; s2 uuid;
  v_fail text[] := '{}';
  v_pass int := 0;
  r jsonb; v_err text; v_err2 text; v_err3 text; v_num numeric; v_n int;
BEGIN
  SELECT carrier_id, site_id INTO v_carrier, v_site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
  FOR v_admin IN SELECT id FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u) LOOP
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXIT WHEN public.is_tms_admin();
    v_admin := NULL;
  END LOOP;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'CAJA C7 FAIL: no hay administrador'; END IF;
  SELECT id INTO v_desp FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id <> v_admin ORDER BY id LIMIT 1;
  SELECT id INTO v_contr FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_desp) ORDER BY id LIMIT 1;
  SELECT id INTO v_nobody FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_desp, v_contr) ORDER BY id LIMIT 1;
  SELECT id INTO v_drv_prof FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_desp, v_contr, v_nobody) ORDER BY id LIMIT 1;
  IF v_drv_prof IS NULL THEN RAISE EXCEPTION 'CAJA C7 FAIL: se requieren 5 perfiles'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ Despacho C7', '["despacho"]') RETURNING id INTO v_role_d;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ Contratos C7', '["contratos-servicios"]') RETURNING id INTO v_role_c;
  UPDATE public.profiles SET role_id = v_role_d, is_active = true WHERE id = v_desp;
  UPDATE public.profiles SET role_id = v_role_c, is_active = true WHERE id = v_contr;
  UPDATE public.profiles SET role_id = NULL, is_active = true WHERE id IN (v_nobody, v_drv_prof);
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_desp, v_site), (v_contr, v_site) ON CONFLICT DO NOTHING;
  INSERT INTO public.drivers (carrier_id, profile_id, first_name, last_name, document_number, license_number, is_active)
  VALUES (v_carrier, v_drv_prof, 'Conductor', 'C7', 'ZZC7-DOC', 'ZZC7-LIC', true) RETURNING id INTO v_driver;
  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, status, current_odometer) VALUES
    ('ZZC7A', v_carrier, v_site, 'TRACTO', 'DISPONIBLE', 100), ('ZZC7B', v_carrier, v_site, 'TRACTO', 'DISPONIBLE', 100);
  INSERT INTO public.contracts (code, type, status, site_id) VALUES ('ZZ-C7-OT', 'CONTRATO', 'ACTIVO', v_site) RETURNING id INTO v_ct;
  INSERT INTO public.contract_budgets (contract_id, concept, allocated_pen) VALUES (v_ct, 'PARTIDA_TRANSPORTE', 1250);
  INSERT INTO public.transport_requests (request_number, status, site_id, contract_id, requester_name, department, request_type, cargo_description, pickup_address, pickup_district, delivery_address, delivery_district, required_date) VALUES
    ('ZZ-C7-R1', 'ASIGNADA', v_site, v_ct, 'ZZ', 'Logística', 'DESPACHO', 'Carga de prueba', 'Planta', 'Lurín', 'Obra', 'Ate', current_date), ('ZZ-C7-R2', 'ASIGNADA', v_site, v_ct, 'ZZ', 'Logística', 'DESPACHO', 'Carga de prueba', 'Planta', 'Lurín', 'Obra', 'Ate', current_date),
    ('ZZ-C7-R3', 'ASIGNADA', v_site, v_ct, 'ZZ', 'Logística', 'DESPACHO', 'Carga de prueba', 'Planta', 'Lurín', 'Obra', 'Ate', current_date);
  SELECT id INTO r1 FROM public.transport_requests WHERE request_number = 'ZZ-C7-R1';
  SELECT id INTO r2 FROM public.transport_requests WHERE request_number = 'ZZ-C7-R2';
  SELECT id INTO r3 FROM public.transport_requests WHERE request_number = 'ZZ-C7-R3';
  -- D1: programado con flete reservado (como lo deja schedule_dispatch); D2: ya salió y retornó
  INSERT INTO public.dispatches (dispatch_number, vehicle_plate, driver_id, status, site_id, contract_id, freight_cost)
  VALUES ('ZZ-C7-D1', 'ZZC7A', v_driver, 'PROGRAMADO', v_site, v_ct, 300) RETURNING id INTO d1;
  INSERT INTO public.dispatches (dispatch_number, vehicle_plate, status, site_id, contract_id, freight_cost)
  VALUES ('ZZ-C7-D2', 'ZZC7B', 'EN RUTA', v_site, v_ct, 200) RETURNING id INTO d2;
  INSERT INTO public.dispatch_requests (dispatch_id, transport_request_id, status) VALUES (d1, r1, 'PROGRAMADO'), (d1, r2, 'PROGRAMADO'), (d2, r3, 'PROGRAMADO');
  UPDATE public.contract_budgets SET reserved_pen = 500 WHERE contract_id = v_ct;
  INSERT INTO public.contract_services (contract_id, service_type, description, amount_pen, dispatch_id) VALUES
    (v_ct, 'FLETE', 'Flete D1', 300, d1), (v_ct, 'FLETE', 'Flete D2', 200, d2);

  -- T1: un tercero y el conductor no cancelan; el conductor sí marca hitos de su viaje
  PERFORM pg_temp.as_user(v_nobody);
  v_err := public.transition_dispatch_status(d1, 'CANCELADO', 'x')->>'error';
  PERFORM pg_temp.as_user(v_drv_prof);
  v_err2 := public.transition_dispatch_status(d1, 'CANCELADO', 'x')->>'error';
  r := public.transition_dispatch_status(d1, 'LIQUIDADO', 'x');
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE 'Sin permiso%' AND v_err2 LIKE 'Sin permiso%' AND r->>'error' LIKE 'Sin permiso%'
     AND (SELECT status = 'PROGRAMADO' FROM public.dispatches WHERE id = d1)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 permisos: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(v_err2, '∅') || ' | ' || COALESCE(r::text, '∅')); END IF;

  -- T2: cancelar un programado libera reserva, anula el FLETE y devuelve las solicitudes a aprobadas
  PERFORM pg_temp.as_user(v_desp);
  v_err := public.cancel_dispatch(d1, '')->>'error';
  r := public.cancel_dispatch(d1, 'Cliente postergó la entrega');
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE 'Indique el motivo%' AND (r->>'success')::boolean
     AND (SELECT status = 'CANCELADO' FROM public.dispatches WHERE id = d1)
     AND (SELECT reserved_pen = 200 AND balance_pen = 800 FROM public.contract_budgets WHERE contract_id = v_ct)
     AND (SELECT status = 'ANULADO' FROM public.contract_services WHERE dispatch_id = d1)
     AND (SELECT count(*) = 2 FROM public.transport_requests WHERE id IN (r1, r2) AND status = 'APROBADA')
     AND NOT EXISTS (SELECT 1 FROM public.dispatch_requests WHERE dispatch_id = d1)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 cancelar: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(r::text, '∅')); END IF;

  -- T3: en ruta no se cancela; LIQUIDADO no se salta por transición; "entregado" exige paradas confirmadas
  PERFORM pg_temp.as_user(v_desp);
  v_err := public.cancel_dispatch(d2, 'Ya no va')->>'error';
  v_err2 := public.transition_dispatch_status(d2, 'LIQUIDADO', 'atajo')->>'error';
  v_err3 := public.transition_dispatch_status(d2, 'ENTREGADO', 'desde monitoreo')->>'error';
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE 'El despacho ya salió%' AND v_err2 LIKE 'Use "Cerrar ruta"%' AND v_err3 LIKE 'Hay paradas sin entrega%'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 atajos: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(v_err2, '∅') || ' | ' || COALESCE(v_err3, '∅')); END IF;

  -- T4: entregado (paradas confirmadas) se cierra y consume la partida
  -- Este caso prueba la partida; las guías ya aprobadas se preparan como fixture.
  INSERT INTO public.delivery_conformities(dispatch_id,request_id,state) SELECT dispatch_id,transport_request_id,'VALIDADA' FROM public.dispatch_requests WHERE dispatch_id=d2 ON CONFLICT(dispatch_id,request_id) DO UPDATE SET state='VALIDADA';
  UPDATE public.dispatch_requests SET status = 'ENTREGADO' WHERE dispatch_id = d2;
  PERFORM pg_temp.as_user(v_desp);
  r := public.transition_dispatch_status(d2, 'ENTREGADO', 'fin de ruta');
  PERFORM public.close_dispatch_route(d2);
  PERFORM pg_temp.as_user(NULL);
  IF (r->>'success')::boolean AND (SELECT status = 'LIQUIDADO' FROM public.dispatches WHERE id = d2)
     AND (SELECT reserved_pen = 0 AND consumed_pen = 200 AND balance_pen = 800 FROM public.contract_budgets WHERE contract_id = v_ct)
     AND (SELECT status = 'ENTREGADA' FROM public.transport_requests WHERE id = r3)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 cierre: ' || COALESCE(r::text, '∅') || ' ' ||
       (SELECT reserved_pen || '/' || consumed_pen FROM public.contract_budgets WHERE contract_id = v_ct)); END IF;

  -- T5: servicios de contrato: sin saldo no se consume; editar un FLETE ya cerrado ajusta el consumido
  -- (los id se leen antes de cambiar de usuario: en producción el RLS oculta la tabla a este rol)
  SELECT id INTO s1 FROM public.contract_services WHERE dispatch_id = d1;
  SELECT id INTO s2 FROM public.contract_services WHERE dispatch_id = d2;
  PERFORM pg_temp.as_user(v_contr);
  v_err := NULL;
  BEGIN PERFORM public.register_contract_service(v_ct, 'MONTACARGA', 'Descarga', 900, current_date);
  EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
  PERFORM public.register_contract_service(v_ct, 'ESTIBA', 'Estiba', 100, current_date);
  PERFORM public.update_contract_service_amount(s2, 250);
  v_err2 := NULL;
  BEGIN PERFORM public.update_contract_service_amount(s1, 10);
  EXCEPTION WHEN raise_exception THEN v_err2 := SQLERRM; END;
  SELECT count(*) INTO v_n FROM public.contract_services WHERE contract_id = v_ct;  -- Contratos ve sus servicios
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE 'Saldo insuficiente%' AND v_err2 LIKE '%anulado%' AND v_n = 3
     AND (SELECT consumed_pen = 350 AND balance_pen = 650 FROM public.contract_budgets WHERE contract_id = v_ct)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T5 servicios: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(v_err2, '∅') || ' visibles=' || v_n || ' ' ||
       (SELECT reserved_pen || '/' || consumed_pen FROM public.contract_budgets WHERE contract_id = v_ct)); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C7 PASS (%/5)', v_pass;
  END IF;
  RAISE EXCEPTION 'CAJA C7 FAIL: %', array_to_string(v_fail, ' || ');
END $test$;

ROLLBACK;
