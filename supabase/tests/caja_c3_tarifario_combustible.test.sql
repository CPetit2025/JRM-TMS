-- Pruebas CAJA C3 — Tarifario, presupuesto, reglas, combustible y reportes.
-- Termina siempre en error para forzar ROLLBACK: "CAJA C3 PASS (...)" o "CAJA C3 FAIL: ...".
--   npx supabase db query --linked -f supabase/tests/caja_c3_tarifario_combustible.test.sql
BEGIN;

CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

DO $test$
DECLARE
  v_admin uuid; v_jefe uuid; v_caja uuid; v_drv_prof uuid;
  v_role_c uuid; v_driver uuid; v_site uuid; v_carrier uuid;
  t1 uuid; t2 uuid;
  v_rate uuid; v_rate2 uuid; v_station uuid; v_inv uuid; v_inv2 uuid;
  e1 uuid; e2 uuid; e3 uuid;
  v_fail text[] := '{}';
  v_pass int := 0;
  r jsonb; v_err text; v_n int; v_num numeric;
BEGIN
  SELECT carrier_id, site_id INTO v_carrier, v_site FROM public.vehicles LIMIT 1;
  FOR v_admin IN SELECT id FROM public.profiles LOOP
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXIT WHEN public.is_tms_admin();
    v_admin := NULL;
  END LOOP;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'CAJA C3 FAIL: no hay administrador'; END IF;
  SELECT id INTO v_jefe     FROM public.profiles WHERE id <> v_admin ORDER BY id LIMIT 1;
  SELECT id INTO v_caja     FROM public.profiles WHERE id NOT IN (v_admin, v_jefe) ORDER BY id LIMIT 1;
  SELECT id INTO v_drv_prof FROM public.profiles WHERE id NOT IN (v_admin, v_jefe, v_caja) ORDER BY id LIMIT 1;
  IF v_drv_prof IS NULL THEN RAISE EXCEPTION 'CAJA C3 FAIL: se requieren 4 perfiles'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ Caja C3', '["caja-gastos"]') RETURNING id INTO v_role_c;
  UPDATE public.profiles SET role_id = (SELECT id FROM public.roles WHERE name = 'Jefe de Distribución'), is_active = true WHERE id = v_jefe;
  UPDATE public.profiles SET role_id = v_role_c, is_active = true WHERE id = v_caja;
  UPDATE public.profiles SET role_id = NULL, is_active = true WHERE id = v_drv_prof;
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_jefe, v_site), (v_caja, v_site) ON CONFLICT DO NOTHING;
  INSERT INTO public.drivers (carrier_id, profile_id, first_name, last_name, document_number, license_number, is_active)
  VALUES (v_carrier, v_drv_prof, 'Conductor', 'C3', 'ZZC3-DOC', 'ZZC3-LIC', true) RETURNING id INTO v_driver;
  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, status, current_odometer, expected_km_per_gallon)
  VALUES ('ZZC3A', v_carrier, v_site, 'TRACTO', 'DISPONIBLE', 20000, 10);
  INSERT INTO public.dispatches (dispatch_number, vehicle_plate, driver_id, status, site_id, freight_cost, estimated_km)
  VALUES ('ZZ-C3-001', 'ZZC3A', v_driver, 'EN_CURSO', v_site, 2000, 600) RETURNING id INTO t1;
  INSERT INTO public.dispatches (dispatch_number, vehicle_plate, driver_id, status, site_id)
  VALUES ('ZZ-C3-002', 'ZZC3A', v_driver, 'EN_CURSO', v_site) RETURNING id INTO t2;
  UPDATE public.caja_settings SET fuel_price_per_gallon = 16, budget_tolerance_pct = 10, default_km_per_gallon = 10 WHERE id;

  -- T1: tarifario ⇒ presupuesto (peaje según el tipo de unidad; combustible por km/rendimiento/precio)
  PERFORM pg_temp.as_user(v_admin);
  INSERT INTO public.route_allowance_rates (code, name, origin, destination, distance_km, round_trip, days, nights, toll_amount, toll_by_type, meal_per_day, lodging_per_night, other_amount)
  VALUES ('ZZ-LIM-ICA', 'Lima – Ica', 'Lima', 'Ica', 300, true, 2, 1, 150, '{"TRACTO": 200}', 40, 60, 20) RETURNING id INTO v_rate;
  INSERT INTO public.route_allowance_rates (code, name, distance_km, days, nights, meal_per_day) VALUES ('ZZ-LOCAL', 'Reparto local', 40, 1, 0, 25) RETURNING id INTO v_rate2;
  r := public.calculate_trip_budget(v_rate, 'ZZC3A');
  PERFORM pg_temp.as_user(NULL);
  IF (r->>'km')::numeric = 600 AND (r->'breakdown'->>'COMBUSTIBLE')::numeric = 960 AND (r->'breakdown'->>'PEAJE')::numeric = 200
     AND (r->'breakdown'->>'ALIMENTACION')::numeric = 80 AND (r->'breakdown'->>'HOSPEDAJE')::numeric = 60 AND (r->>'total')::numeric = 1320
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 presupuesto: ' || r::text); END IF;

  -- T2: presupuesto del viaje y alerta cuando el acumulado de la categoría supera presupuesto + tolerancia
  PERFORM pg_temp.as_user(v_jefe);
  v_err := public.set_trip_budget(t1, NULL, '{"PEAJE": -5}')->>'error';
  r := public.set_trip_budget(t1, v_rate);
  PERFORM pg_temp.as_user(v_drv_prof);
  INSERT INTO public.dispatch_expenses (dispatch_id, driver_id, expense_type, amount, receipt_url, created_by) VALUES (t1, v_driver, 'PEAJE', 150, 'd/p1.jpg', v_drv_prof) RETURNING id INTO e1;
  INSERT INTO public.dispatch_expenses (dispatch_id, driver_id, expense_type, amount, receipt_url, created_by) VALUES (t1, v_driver, 'PEAJE', 100, 'd/p2.jpg', v_drv_prof) RETURNING id INTO e2;
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE 'Presupuesto inválido%' AND (r->>'total')::numeric = 1320
     AND (SELECT alerts = '[]'::jsonb FROM public.dispatch_expenses WHERE id = e1)
     AND (SELECT alerts @> '[{"code":"SOBRE_PRESUPUESTO"}]' FROM public.dispatch_expenses WHERE id = e2)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 sobre presupuesto: ' || COALESCE(v_err, '∅') || ' ' || r::text
       || (SELECT alerts::text FROM public.dispatch_expenses WHERE id = e2)); END IF;

  -- T3: hospedaje en viaje sin pernocte
  PERFORM pg_temp.as_user(v_jefe);
  PERFORM public.set_trip_budget(t2, v_rate2);
  PERFORM pg_temp.as_user(v_drv_prof);
  INSERT INTO public.dispatch_expenses (dispatch_id, driver_id, expense_type, amount, receipt_url, created_by) VALUES (t2, v_driver, 'HOSPEDAJE', 60, 'd/h.jpg', v_drv_prof) RETURNING id INTO e3;
  PERFORM pg_temp.as_user(NULL);
  IF (SELECT alerts @> '[{"code":"HOSPEDAJE_SIN_PERNOCTE"}]' AND alerts @> '[{"code":"SOBRE_PRESUPUESTO"}]' FROM public.dispatch_expenses WHERE id = e3)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 hospedaje: ' || (SELECT alerts::text FROM public.dispatch_expenses WHERE id = e3)); END IF;

  -- T4: cargas en grifo con crédito (pagadas por la empresa) y conciliación de la factura
  PERFORM pg_temp.as_user(v_jefe);
  INSERT INTO public.fuel_stations (ruc, name, has_credit) VALUES ('20100070970', 'Grifo ZZ', true) RETURNING id INTO v_station;
  PERFORM pg_temp.as_user(v_caja);
  e1 := public.register_fuel_load(320, 20, 20200, NULL, 'ZZC3A', NULL, 'caja_receipts/a.jpg', NULL, NULL, current_date - 3,
          jsonb_build_object('fuel_station_id', v_station), 'WEB');
  e2 := public.register_fuel_load(208, 13, 20330, NULL, 'ZZC3A', NULL, 'caja_receipts/b.jpg', NULL, NULL, current_date - 1,
          jsonb_build_object('fuel_station_id', v_station), 'WEB');
  UPDATE public.dispatch_expenses SET receipt_url = receipt_url WHERE id = e1;  -- sin efecto en el pagador
  PERFORM pg_temp.as_user(v_jefe);
  INSERT INTO public.fuel_station_invoices (station_id, document_series, document_number, issue_date, period_start, period_end, amount, gallons)
  VALUES (v_station, 'F001', '100', current_date, current_date - 7, current_date, 528, 33) RETURNING id INTO v_inv;
  r := public.reconcile_fuel_invoice(v_inv);
  INSERT INTO public.fuel_station_invoices (station_id, document_series, document_number, issue_date, period_start, period_end, amount)
  VALUES (v_station, 'F001', '101', current_date, current_date - 30, current_date, 900) RETURNING id INTO v_inv2;
  PERFORM public.reconcile_fuel_invoice(v_inv2);
  v_err := public.reconcile_fuel_invoice(v_inv2, true)->>'error';
  PERFORM pg_temp.as_user(v_caja);
  v_n := CASE WHEN (public.reconcile_fuel_invoice(v_inv2)->>'error') LIKE 'Sin permiso%' THEN 1 ELSE 0 END;
  PERFORM pg_temp.as_user(NULL);
  IF (r->>'status') = 'CONCILIADA' AND (r->>'loads_count')::int = 2 AND (r->>'loads_gallons')::numeric = 33
     AND (SELECT provider_ruc = '20100070970' AND provider_name = 'Grifo ZZ' AND paid_by = 'EMPRESA' AND fuel_invoice_id = v_inv FROM public.dispatch_expenses WHERE id = e1)
     AND (SELECT status = 'CON_DIFERENCIAS' AND loads_count = 0 AND difference_amount = 900 FROM public.fuel_station_invoices WHERE id = v_inv2)
     AND v_err LIKE 'Explique la diferencia%' AND v_n = 1
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 conciliación: ' || r::text || ' ' || COALESCE(v_err, '∅') || ' n=' || v_n); END IF;

  -- T5: rendimiento por carga y resumen por unidad
  PERFORM pg_temp.as_user(v_jefe);
  SELECT km_per_gallon, price_per_gallon INTO v_num, r FROM (SELECT km_per_gallon, to_jsonb(price_per_gallon) AS price_per_gallon FROM public.vw_fuel_efficiency WHERE id = e2) x;
  SELECT count(*) INTO v_n FROM public.vw_vehicle_fuel_summary WHERE vehicle_plate = 'ZZC3A' AND loads = 2 AND km = 130 AND km_per_gallon = 10;
  PERFORM pg_temp.as_user(NULL);
  IF v_num = 10 AND r::text::numeric = 16 AND v_n = 1 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T5 rendimiento: ' || COALESCE(v_num::text, '∅') || ' n=' || v_n); END IF;

  -- T6: rentabilidad del viaje (flete + refacturable − gastos aprobados) y presupuesto vs real
  PERFORM pg_temp.as_user(v_caja);
  INSERT INTO public.dispatch_expenses (dispatch_id, expense_type, amount, receipt_url, paid_by, is_billable, source) VALUES (t1, 'CUADRILLA_ESTIBA', 300, 'caja_receipts/c.jpg', 'EMPRESA', true, 'WEB') RETURNING id INTO e3;
  PERFORM pg_temp.as_user(v_jefe);
  PERFORM public.approve_dispatch_expenses(ARRAY(SELECT id FROM public.dispatch_expenses WHERE dispatch_id = t1));
  PERFORM public.review_dispatch_expense(id, 'APROBAR', NULL, NULL, true) FROM public.dispatch_expenses WHERE dispatch_id = t1 AND status = 'PENDIENTE';
  SELECT to_jsonb(p) INTO r FROM public.vw_trip_profitability p WHERE dispatch_id = t1;
  SELECT count(*) INTO v_n FROM public.vw_trip_budget_vs_actual WHERE dispatch_id = t1 AND category = 'PEAJE' AND budget = 200 AND actual = 250;
  PERFORM pg_temp.as_user(NULL);
  IF (r->>'freight')::numeric = 2000 AND (r->>'expenses')::numeric = 550 AND (r->>'tolls')::numeric = 250 AND (r->>'other_ops')::numeric = 300
     AND (r->>'billable')::numeric = 300 AND (r->>'margin')::numeric = 1750 AND (r->>'budget')::numeric = 1320 AND (r->>'cost_per_km')::numeric = 0.917
     AND v_n = 1
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T6 rentabilidad: ' || COALESCE(r::text, '∅') || ' bva=' || v_n); END IF;

  -- T7: tarifario y categorías solo con caja-tarifario (el Jefe no los edita); cuentas contables sembradas
  PERFORM pg_temp.as_user(v_jefe);
  UPDATE public.route_allowance_rates SET meal_per_day = 999 WHERE id = v_rate;
  UPDATE public.expense_categories SET max_amount = 1 WHERE code = 'PEAJE';
  v_err := public.update_caja_settings(100, 48, 10, 25)->>'error';
  PERFORM pg_temp.as_user(NULL);
  IF (SELECT meal_per_day FROM public.route_allowance_rates WHERE id = v_rate) = 40
     AND (SELECT max_amount IS NULL AND account_code = '6311' AND budget_key = 'PEAJE' FROM public.expense_categories WHERE code = 'PEAJE')
     AND v_err LIKE 'Solo el Administrador%'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T7 permisos: ' || COALESCE(v_err, '∅')); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C3 PASS (%/7)', v_pass;
  ELSE
    RAISE EXCEPTION 'CAJA C3 FAIL: %', array_to_string(v_fail, ' || ');
  END IF;
END $test$;

ROLLBACK;
