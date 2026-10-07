-- Pruebas CAJA C1 — Registro y aprobación de gastos.
-- Termina siempre en error para forzar ROLLBACK: "CAJA C1 PASS (...)" o "CAJA C1 FAIL: ...".
--   npx supabase db query --linked -f supabase/tests/caja_c1_aprobacion.test.sql
BEGIN;

-- Actúa como un usuario autenticado (RLS incluida); NULL vuelve al rol de la prueba
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
  v_admin    uuid;
  v_jefe     uuid;
  v_caja     uuid;
  v_nobody   uuid;
  v_drv_prof uuid;
  v_role_c   uuid;
  v_driver   uuid;
  v_site     uuid;
  v_carrier  uuid;
  v_disp     uuid;
  e1 uuid; e2 uuid; e3 uuid; e4 uuid; e5 uuid; e6 uuid; f1 uuid; f2 uuid; f3 uuid;
  v_fail     text[] := '{}';
  v_pass     int := 0;
  r          jsonb;
  v_err      text;
  v_n        int;
  v_num      numeric;
  v_txt      text;
BEGIN
  SELECT carrier_id, site_id INTO v_carrier, v_site FROM public.vehicles LIMIT 1;
  FOR v_admin IN SELECT id FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u) LOOP
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXIT WHEN public.is_tms_admin();
    v_admin := NULL;
  END LOOP;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'CAJA C1 FAIL: no hay administrador'; END IF;

  -- Usuarios de prueba (perfiles existentes con rol reasignado; todo se revierte)
  SELECT id INTO v_jefe     FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id <> v_admin ORDER BY id LIMIT 1;
  SELECT id INTO v_caja     FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_jefe) ORDER BY id LIMIT 1;
  SELECT id INTO v_nobody   FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_jefe, v_caja) ORDER BY id LIMIT 1;
  SELECT id INTO v_drv_prof FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_jefe, v_caja, v_nobody) ORDER BY id LIMIT 1;
  IF v_drv_prof IS NULL THEN RAISE EXCEPTION 'CAJA C1 FAIL: se requieren 5 perfiles'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ Caja Registro', '["caja-gastos"]') RETURNING id INTO v_role_c;
  UPDATE public.profiles SET role_id = (SELECT id FROM public.roles WHERE name = 'Jefe de Distribución'), is_active = true WHERE id = v_jefe;
  UPDATE public.profiles SET role_id = v_role_c, is_active = true WHERE id = v_caja;
  UPDATE public.profiles SET role_id = NULL, is_active = true WHERE id IN (v_nobody, v_drv_prof);
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_jefe, v_site), (v_caja, v_site) ON CONFLICT DO NOTHING;
  INSERT INTO public.drivers (carrier_id, profile_id, first_name, last_name, document_number, license_number, is_active)
  VALUES (v_carrier, v_drv_prof, 'Conductor', 'C1', 'ZZC1-DOC', 'ZZC1-LIC', true) RETURNING id INTO v_driver;
  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, status, current_odometer, fuel_tank_capacity_gal, expected_km_per_gallon)
  VALUES ('ZZC1A', v_carrier, v_site, 'TRACTO', 'DISPONIBLE', 10000, 100, 10);
  INSERT INTO public.dispatches (dispatch_number, vehicle_plate, driver_id, status, site_id)
  VALUES ('ZZ-C1-001', 'ZZC1A', v_driver, 'EN_CURSO', v_site) RETURNING id INTO v_disp;

  -- T1: rol Jefe de Distribución con el permiso de aprobación; RUC con dígito verificador
  IF (SELECT permissions ? 'caja-aprobacion' AND permissions ? 'dashboard' FROM public.roles WHERE name = 'Jefe de Distribución')
     AND public.is_valid_ruc('20100070970') AND NOT public.is_valid_ruc('20100070971') AND NOT public.is_valid_ruc('2010007097')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || text 'T1 rol/RUC'; END IF;

  -- T2: el registrador de caja no fija el estado; se completan placa y sede; historial REGISTRADO
  PERFORM pg_temp.as_user(v_caja);
  INSERT INTO public.dispatch_expenses (dispatch_id, expense_type, amount, receipt_url, status, source, document_type, document_series, document_number, provider_ruc, provider_name)
  VALUES (v_disp, 'peaje', 100, 'u/x.jpg', 'APROBADO', 'WEB', 'factura', 'f001', '00123', '20100070970', 'Peajes SA') RETURNING id INTO e1;
  PERFORM pg_temp.as_user(NULL);
  IF (SELECT status = 'PENDIENTE' AND expense_type = 'PEAJE' AND vehicle_plate = 'ZZC1A' AND site_id = v_site AND original_amount = 100
             AND document_series = 'F001' AND created_by = v_caja AND alerts = '[]'::jsonb FROM public.dispatch_expenses WHERE id = e1)
     AND EXISTS (SELECT 1 FROM public.dispatch_expense_events WHERE expense_id = e1 AND action = 'REGISTRADO')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 registro: ' || (SELECT to_jsonb(e)::text FROM public.dispatch_expenses e WHERE id = e1)); END IF;

  -- T3: registrar no es aprobar (RPC y UPDATE directo)
  PERFORM pg_temp.as_user(v_caja);
  r := public.review_dispatch_expense(e1, 'APROBAR');
  UPDATE public.dispatch_expenses SET status = 'APROBADO', approved_amount = 100, reviewed_by = v_caja WHERE id = e1;
  PERFORM pg_temp.as_user(NULL);
  IF NOT (r->>'success')::boolean AND (SELECT status = 'PENDIENTE' AND approved_amount IS NULL AND reviewed_by IS NULL FROM public.dispatch_expenses WHERE id = e1)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 separación: ' || r::text); END IF;

  -- T4: nadie aprueba lo propio; con alertas exige confirmación
  PERFORM pg_temp.as_user(v_jefe);
  INSERT INTO public.dispatch_expenses (dispatch_id, expense_type, amount, receipt_url) VALUES (v_disp, 'ALIMENTACION', 30, 'u/a.jpg') RETURNING id INTO e2;
  v_err := public.review_dispatch_expense(e2, 'APROBAR')->>'error';
  PERFORM pg_temp.as_user(v_caja);
  INSERT INTO public.dispatch_expenses (dispatch_id, expense_type, amount) VALUES (v_disp, 'HOSPEDAJE', 120) RETURNING id INTO e3;  -- sin foto
  PERFORM pg_temp.as_user(v_jefe);
  v_txt := public.review_dispatch_expense(e3, 'APROBAR')->>'error';
  r := public.review_dispatch_expense(e3, 'APROBAR', NULL, NULL, true);
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE '%registrado por usted%' AND v_txt LIKE '%alertas%' AND (r->>'status') = 'APROBADO'
     AND (SELECT approved_amount = 120 AND reviewed_by = v_jefe FROM public.dispatch_expenses WHERE id = e3)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 propio/alertas: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(v_txt, '∅') || ' | ' || r::text); END IF;

  -- T5: observar exige motivo; la corrección conserva el sustento y vuelve a la bandeja
  PERFORM pg_temp.as_user(v_jefe);
  v_err := public.review_dispatch_expense(e1, 'OBSERVAR')->>'error';
  r := public.review_dispatch_expense(e1, 'OBSERVAR', 'La foto no es legible');
  PERFORM pg_temp.as_user(v_caja);
  UPDATE public.dispatch_expenses SET amount = 95, receipt_url = 'u/x2.jpg' WHERE id = e1;
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE '%motivo%' AND (r->>'status') = 'OBSERVADO'
     AND (SELECT status = 'PENDIENTE' AND amount = 95 AND review_comment = 'La foto no es legible' AND provider_name = 'Peajes SA' FROM public.dispatch_expenses WHERE id = e1)
     AND EXISTS (SELECT 1 FROM public.dispatch_expense_events WHERE expense_id = e1 AND action = 'CORREGIDO')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T5 observación: ' || COALESCE(v_err, '∅') || ' ' || r::text); END IF;

  -- T6: ajuste parcial con motivo; libro de costos con monto aprobado y categoría del catálogo
  PERFORM pg_temp.as_user(v_caja);
  INSERT INTO public.dispatch_expenses (dispatch_id, expense_type, amount, receipt_url) VALUES (v_disp, 'REPUESTOS', 200, 'u/r.jpg') RETURNING id INTO e4;
  INSERT INTO public.dispatch_expenses (dispatch_id, expense_type, amount, receipt_url) VALUES (v_disp, 'LLANTAS_PARCHADO', 40, 'u/l.jpg') RETURNING id INTO e5;
  PERFORM pg_temp.as_user(v_jefe);
  v_err := public.review_dispatch_expense(e1, 'APROBAR', NULL, 80)->>'error';
  r := public.review_dispatch_expense(e1, 'APROBAR', 'Tarifa oficial del peaje', 80);
  PERFORM public.review_dispatch_expense(e4, 'APROBAR');
  PERFORM public.review_dispatch_expense(e5, 'APROBAR');
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE '%motivo del ajuste%' AND (r->>'approved_amount')::numeric = 80
     AND EXISTS (SELECT 1 FROM public.dispatch_expense_events WHERE expense_id = e1 AND action = 'AJUSTADO')
     AND (SELECT amount FROM public.vw_vehicle_cost_ledger WHERE ref_id = e1) = 80
     AND (SELECT category FROM public.vw_vehicle_cost_ledger WHERE ref_id = e1) = 'OPERACION'
     AND (SELECT category FROM public.vw_vehicle_cost_ledger WHERE ref_id = e4) = 'MANTENIMIENTO'
     AND (SELECT category FROM public.vw_vehicle_cost_ledger WHERE ref_id = e5) = 'NEUMATICOS'
     AND (SELECT maintenance_cost = 200 AND tires_cost >= 40 AND operating_cost = 200 FROM public.vehicle_tco_analytics WHERE plate = 'ZZC1A')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T6 ajuste/TCO: ' || COALESCE(v_err, '∅') || ' ' || r::text
       || (SELECT to_jsonb(t)::text FROM public.vehicle_tco_analytics t WHERE plate = 'ZZC1A')); END IF;

  -- T7: comprobante duplicado (ceros a la izquierda incluidos); libre tras rechazar el original
  v_err := NULL;
  PERFORM pg_temp.as_user(v_caja);
  BEGIN
    INSERT INTO public.dispatch_expenses (dispatch_id, expense_type, amount, receipt_url, document_type, document_series, document_number, provider_ruc)
    VALUES (v_disp, 'PEAJE', 10, 'u/d.jpg', 'FACTURA', 'F001', '123', '20100070970');
  EXCEPTION WHEN raise_exception THEN v_err := SQLERRM;
  END;
  INSERT INTO public.dispatch_expenses (dispatch_id, expense_type, amount, receipt_url, document_type, document_series, document_number, provider_ruc)
  VALUES (v_disp, 'PEAJE', 10, 'u/d.jpg', 'FACTURA', 'F001', '999', '20100070970') RETURNING id INTO e6;
  PERFORM pg_temp.as_user(v_jefe);
  PERFORM public.review_dispatch_expense(e6, 'RECHAZAR', 'Comprobante anulado por el proveedor');
  PERFORM pg_temp.as_user(v_caja);
  INSERT INTO public.dispatch_expenses (dispatch_id, expense_type, amount, receipt_url, document_type, document_series, document_number, provider_ruc)
  VALUES (v_disp, 'PEAJE', 10, 'u/d.jpg', 'FACTURA', 'F001', '0999', '20100070970');
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE 'Comprobante duplicado%' AND (SELECT status FROM public.dispatch_expenses WHERE id = e6) = 'RECHAZADO'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T7 duplicado: ' || COALESCE(v_err, '∅')); END IF;

  -- T8: doble aprobación sobre el umbral (Jefe aprueba, Administrador confirma)
  UPDATE public.caja_settings SET double_approval_threshold = 500 WHERE id;
  PERFORM pg_temp.as_user(v_caja);
  INSERT INTO public.dispatch_expenses (dispatch_id, expense_type, amount, receipt_url) VALUES (v_disp, 'ALQUILER_EQUIPO', 600, 'u/m.jpg') RETURNING id INTO e2;
  PERFORM pg_temp.as_user(v_jefe);
  r := public.review_dispatch_expense(e2, 'APROBAR');
  v_err := public.review_dispatch_expense(e2, 'APROBAR')->>'error';
  PERFORM pg_temp.as_user(v_admin);
  v_txt := public.review_dispatch_expense(e2, 'APROBAR')->>'status';
  PERFORM pg_temp.as_user(NULL);
  UPDATE public.caja_settings SET double_approval_threshold = NULL WHERE id;
  IF (r->>'requires_admin')::boolean AND v_err LIKE '%confirmación del Administrador%' AND v_txt = 'APROBADO'
     AND (SELECT first_approved_by = v_jefe AND reviewed_by = v_admin FROM public.dispatch_expenses WHERE id = e2)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T8 doble: ' || r::text || ' ' || COALESCE(v_err, '∅') || ' ' || COALESCE(v_txt, '∅')); END IF;

  -- T9: revertir solo el Administrador, con motivo; lo revisado no se edita ni se borra
  PERFORM pg_temp.as_user(v_jefe);
  v_err := public.review_dispatch_expense(e3, 'REVERTIR', 'x')->>'error';
  PERFORM pg_temp.as_user(v_caja);
  v_txt := NULL;
  BEGIN
    UPDATE public.dispatch_expenses SET amount = 1 WHERE id = e4;  -- aprobado: la política no lo alcanza
    GET DIAGNOSTICS v_n = ROW_COUNT;
  EXCEPTION WHEN raise_exception THEN v_n := -1;
  END;
  BEGIN
    DELETE FROM public.dispatch_expenses WHERE id = e4;
  EXCEPTION WHEN raise_exception THEN v_txt := SQLERRM;
  END;
  PERFORM pg_temp.as_user(v_admin);
  r := public.review_dispatch_expense(e3, 'REVERTIR', 'Hospedaje no correspondía');
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE '%Solo el Administrador%' AND v_n <= 0 AND (SELECT amount FROM public.dispatch_expenses WHERE id = e4) = 200
     AND (r->>'status') = 'PENDIENTE' AND (SELECT status = 'PENDIENTE' AND approved_amount IS NULL FROM public.dispatch_expenses WHERE id = e3)
     AND EXISTS (SELECT 1 FROM public.dispatch_expenses WHERE id = e4)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T9 revertir: ' || COALESCE(v_err, '∅') || ' n=' || v_n || ' ' || r::text); END IF;

  -- T10: combustible por placa (sin viaje) desde caja; odómetro y alertas de rendimiento/retroceso
  PERFORM pg_temp.as_user(v_caja);
  f1 := public.register_fuel_load(500, 40, 10400, NULL, 'zzc1a', NULL, 'u/f1.jpg', NULL, NULL, current_date - 2, '{}'::jsonb, 'WEB');
  f2 := public.register_fuel_load(500, 40, 10800, NULL, 'ZZC1A', NULL, 'u/f2.jpg', NULL, NULL, current_date - 1, '{}'::jsonb, 'WEB');   -- 400 km / 40 gal = 10 km/gal
  f3 := public.register_fuel_load(500, 120, 10700, NULL, 'ZZC1A', NULL, 'u/f3.jpg', NULL, NULL, current_date, '{}'::jsonb, 'WEB');     -- retrocede y supera el tanque
  PERFORM pg_temp.as_user(NULL);
  IF (SELECT dispatch_id IS NULL AND vehicle_plate = 'ZZC1A' AND source = 'WEB' AND alerts = '[]'::jsonb FROM public.dispatch_expenses WHERE id = f2)
     AND (SELECT alerts @> '[{"code":"ODOMETRO_RETROCEDE"}]' AND alerts @> '[{"code":"GALONES_SOBRE_TANQUE"}]' FROM public.dispatch_expenses WHERE id = f3)
     AND (SELECT current_odometer FROM public.vehicles WHERE plate = 'ZZC1A') = 10800
     AND (SELECT count(*) FROM public.vehicle_odometer_logs WHERE vehicle_plate = 'ZZC1A' AND source_event = 'COMBUSTIBLE') = 3
     AND (SELECT status FROM public.vehicle_odometer_logs WHERE vehicle_plate = 'ZZC1A' AND odometer_value = 10700) = 'REQUIERE_AUDITORIA'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T10 combustible: ' || (SELECT alerts::text FROM public.dispatch_expenses WHERE id = f2)
       || (SELECT alerts::text FROM public.dispatch_expenses WHERE id = f3)); END IF;

  -- T11: la app del conductor (firma anterior) registra a su nombre; rendimiento anormal; idempotente
  PERFORM pg_temp.as_user(v_drv_prof);
  f1 := public.register_fuel_expense(v_disp, v_driver, 300, 10, 11100, 'd/f.jpg', 'Gasto - COMBUSTIBLE', '00000000-0000-0000-0000-00000000c1c1');
  v_num := (SELECT count(*) FROM public.dispatch_expenses WHERE client_operation_id = '00000000-0000-0000-0000-00000000c1c1');
  f2 := public.register_fuel_expense(v_disp, v_driver, 300, 10, 11100, 'd/f.jpg', 'Gasto - COMBUSTIBLE', '00000000-0000-0000-0000-00000000c1c1');
  PERFORM pg_temp.as_user(v_nobody);
  v_err := NULL;
  BEGIN
    PERFORM public.register_fuel_load(100, 5, 11200, v_disp);
  EXCEPTION WHEN raise_exception THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.as_user(NULL);
  IF f1 = f2 AND v_num = 1 AND v_err LIKE 'No autorizado%'
     AND (SELECT driver_id = v_driver AND created_by = v_drv_prof AND source = 'APP' AND alerts @> '[{"code":"RENDIMIENTO_ANORMAL"}]'
          FROM public.dispatch_expenses WHERE id = f1)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T11 app: ' || COALESCE(v_err, '∅') || (SELECT alerts::text FROM public.dispatch_expenses WHERE id = f1)); END IF;

  -- T12: aprobación en lote omite los gastos con alertas
  PERFORM pg_temp.as_user(v_caja);
  INSERT INTO public.dispatch_expenses (dispatch_id, expense_type, amount, receipt_url) VALUES (v_disp, 'ESTACIONAMIENTO', 15, 'u/e.jpg') RETURNING id INTO f2;
  PERFORM pg_temp.as_user(v_jefe);
  r := public.approve_dispatch_expenses(ARRAY[f2, f3, e3]);
  PERFORM pg_temp.as_user(NULL);
  IF (r->>'approved')::int = 1 AND jsonb_array_length(r->'skipped') = 2
     AND (SELECT status FROM public.dispatch_expenses WHERE id = f2) = 'APROBADO'
     AND (SELECT status FROM public.dispatch_expenses WHERE id = e3) = 'PENDIENTE'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T12 lote: ' || r::text); END IF;

  -- T13: sin permisos no ve gastos ajenos ni revisa; el conductor solo ve los suyos
  PERFORM pg_temp.as_user(v_nobody);
  SELECT count(*) INTO v_n FROM public.dispatch_expenses WHERE vehicle_plate = 'ZZC1A';
  v_err := public.review_dispatch_expense(e4, 'RECHAZAR', 'x')->>'error';
  PERFORM pg_temp.as_user(v_drv_prof);
  SELECT count(*) FILTER (WHERE dispatch_id IS NULL) * 1000 + count(*) FILTER (WHERE dispatch_id = v_disp) INTO v_num
  FROM public.dispatch_expenses WHERE vehicle_plate = 'ZZC1A';
  PERFORM pg_temp.as_user(NULL);
  IF v_n = 0 AND v_err LIKE 'Solo el Administrador o el Jefe%'
     AND v_num = (SELECT count(*) FROM public.dispatch_expenses WHERE dispatch_id = v_disp)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T13 acceso: ' || v_n || ' ' || COALESCE(v_err, '∅') || ' drv=' || v_num); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C1 PASS (%/13)', v_pass;
  ELSE
    RAISE EXCEPTION 'CAJA C1 FAIL: %', array_to_string(v_fail, ' || ');
  END IF;
END $test$;

ROLLBACK;
