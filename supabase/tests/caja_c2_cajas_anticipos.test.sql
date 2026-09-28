-- Pruebas CAJA C2 — Cajas, anticipos, cuenta corriente y liquidación del viaje.
-- Termina siempre en error para forzar ROLLBACK: "CAJA C2 PASS (...)" o "CAJA C2 FAIL: ...".
--   npx supabase db query --linked -f supabase/tests/caja_c2_cajas_anticipos.test.sql
BEGIN;

CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

DO $test$
DECLARE
  v_admin  uuid; v_jefe uuid; v_fondos uuid; v_nobody uuid; v_drv_prof uuid;
  v_role_f uuid; v_driver uuid; v_site uuid; v_carrier uuid;
  t1 uuid; t2 uuid; t3 uuid;
  v_box uuid; v_bank uuid;
  a1 uuid; a2 uuid; a3 uuid;
  e1 uuid; e2 uuid; e3 uuid; e4 uuid;
  v_fail text[] := '{}';
  v_pass int := 0;
  r jsonb; v_err text; v_txt text; v_n int; v_num numeric;
BEGIN
  SELECT carrier_id, site_id INTO v_carrier, v_site FROM public.vehicles LIMIT 1;
  FOR v_admin IN SELECT id FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u) LOOP
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXIT WHEN public.is_tms_admin();
    v_admin := NULL;
  END LOOP;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'CAJA C2 FAIL: no hay administrador'; END IF;
  SELECT id INTO v_jefe     FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id <> v_admin ORDER BY id LIMIT 1;
  SELECT id INTO v_fondos   FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_jefe) ORDER BY id LIMIT 1;
  SELECT id INTO v_nobody   FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_jefe, v_fondos) ORDER BY id LIMIT 1;
  SELECT id INTO v_drv_prof FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_jefe, v_fondos, v_nobody) ORDER BY id LIMIT 1;
  IF v_drv_prof IS NULL THEN RAISE EXCEPTION 'CAJA C2 FAIL: se requieren 5 perfiles'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ Tesorería', '["caja-fondos","caja-gastos"]') RETURNING id INTO v_role_f;
  UPDATE public.profiles SET role_id = (SELECT id FROM public.roles WHERE name = 'Jefe de Distribución'), is_active = true WHERE id = v_jefe;
  UPDATE public.profiles SET role_id = v_role_f, is_active = true WHERE id = v_fondos;
  UPDATE public.profiles SET role_id = NULL, is_active = true WHERE id IN (v_nobody, v_drv_prof);
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_jefe, v_site), (v_fondos, v_site) ON CONFLICT DO NOTHING;
  INSERT INTO public.drivers (carrier_id, profile_id, first_name, last_name, document_number, license_number, is_active)
  VALUES (v_carrier, v_drv_prof, 'Conductor', 'C2', 'ZZC2-DOC', 'ZZC2-LIC', true) RETURNING id INTO v_driver;
  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, status, current_odometer) VALUES ('ZZC2A', v_carrier, v_site, 'TRACTO', 'DISPONIBLE', 5000);
  INSERT INTO public.dispatches (dispatch_number, vehicle_plate, driver_id, status, site_id) VALUES ('ZZ-C2-001', 'ZZC2A', v_driver, 'EN_CURSO', v_site) RETURNING id INTO t1;
  -- Producción admite un solo viaje activo por conductor y por unidad (dispatch_one_active_*):
  -- ZZ-C2-002 ya entregado; ZZ-C2-003 se programa en T7, cuando ZZ-C2-001 ya retornó
  INSERT INTO public.dispatches (dispatch_number, vehicle_plate, driver_id, status, site_id) VALUES ('ZZ-C2-002', 'ZZC2A', v_driver, 'ENTREGADO', v_site) RETURNING id INTO t2;

  -- T1: caja chica: apertura, retiro con motivo y sin sobregiro
  PERFORM pg_temp.as_user(v_fondos);
  INSERT INTO public.cash_boxes (code, name, box_type, site_id) VALUES ('ZZ-CCH', 'Caja chica prueba', 'CAJA_CHICA', v_site) RETURNING id INTO v_box;
  INSERT INTO public.cash_boxes (code, name, box_type, site_id, allow_negative) VALUES ('ZZ-BCO', 'Banco prueba', 'BANCO', v_site, true) RETURNING id INTO v_bank;
  r := public.register_cash_movement(v_box, 'APERTURA', 1000, 'EFECTIVO', NULL, 'Fondo inicial');
  v_err := public.register_cash_movement(v_box, 'RETIRO', 50)->>'error';
  v_txt := NULL;
  BEGIN PERFORM public.register_cash_movement(v_box, 'RETIRO', 5000, NULL, NULL, 'Depósito');
  EXCEPTION WHEN raise_exception THEN v_txt := SQLERRM; END;
  PERFORM pg_temp.as_user(NULL);
  IF (r->>'balance')::numeric = 1000 AND v_err LIKE '%motivo%' AND v_txt LIKE 'Saldo insuficiente%' AND public.cash_box_balance(v_box) = 1000
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 caja: ' || r::text || ' ' || COALESCE(v_err, '∅') || ' ' || COALESCE(v_txt, '∅')); END IF;

  -- T2: anticipo solicitado y entregado por el Jefe; egreso en el libro; el conductor lo ve
  PERFORM pg_temp.as_user(v_jefe);
  a1 := (public.request_trip_advance(t1, 500, '{"PEAJE": 200, "ALIMENTACION": 300}')->>'advance_id')::uuid;
  v_err := public.deliver_trip_advance(a1, v_box, '')->>'error';
  r := public.deliver_trip_advance(a1, v_box, 'efectivo', 'Recibo 001');
  PERFORM pg_temp.as_user(v_drv_prof);
  SELECT count(*) INTO v_n FROM public.trip_advances WHERE id = a1;
  PERFORM pg_temp.as_user(NULL);
  IF (r->>'success')::boolean AND v_err LIKE '%forma de entrega%' AND public.cash_box_balance(v_box) = 500 AND v_n = 1
     AND (SELECT status = 'ENTREGADO' AND payment_method = 'EFECTIVO' AND delivered_by = v_jefe AND code LIKE 'ANT-%' FROM public.trip_advances WHERE id = a1)
     AND EXISTS (SELECT 1 FROM public.cash_movements WHERE advance_id = a1 AND movement_type = 'ANTICIPO' AND direction = -1 AND amount = 500)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 anticipo: ' || r::text || ' ' || COALESCE(v_err, '∅')); END IF;

  -- T3: gastos del conductor y vale de caja; el vale se asienta al aprobar y se revierte con la revisión
  PERFORM pg_temp.as_user(v_drv_prof);
  INSERT INTO public.dispatch_expenses (dispatch_id, driver_id, expense_type, amount, receipt_url, created_by) VALUES (t1, v_driver, 'PEAJE', 100, 'd/1.jpg', v_drv_prof) RETURNING id INTO e1;
  INSERT INTO public.dispatch_expenses (dispatch_id, driver_id, expense_type, amount, receipt_url, created_by) VALUES (t1, v_driver, 'ALIMENTACION', 50, 'd/2.jpg', v_drv_prof) RETURNING id INTO e2;
  PERFORM pg_temp.as_user(v_fondos);
  INSERT INTO public.dispatch_expenses (dispatch_id, expense_type, amount, receipt_url, paid_by, cash_box_id, source) VALUES (t1, 'CUADRILLA_ESTIBA', 80, 'caja_receipts/x.jpg', 'CAJA', v_box, 'WEB') RETURNING id INTO e3;
  PERFORM pg_temp.as_user(v_jefe);
  PERFORM public.review_dispatch_expense(e1, 'APROBAR');
  PERFORM public.review_dispatch_expense(e2, 'APROBAR');
  PERFORM public.review_dispatch_expense(e3, 'APROBAR');
  v_num := public.cash_box_balance(v_box);
  PERFORM pg_temp.as_user(v_admin);
  PERFORM public.review_dispatch_expense(e3, 'REVERTIR', 'Monto por revisar');
  PERFORM pg_temp.as_user(NULL);
  IF v_num = 420 AND public.cash_box_balance(v_box) = 500
     AND (SELECT paid_by = 'CONDUCTOR' FROM public.dispatch_expenses WHERE id = e1)
     AND (SELECT paid_by = 'CAJA' AND driver_id = v_driver FROM public.dispatch_expenses WHERE id = e3)
     AND EXISTS (SELECT 1 FROM public.cash_movements WHERE expense_id = e3 AND movement_type = 'REVERSION')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 vale: ' || v_num || ' / ' || public.cash_box_balance(v_box)); END IF;

  -- T4: la liquidación se bloquea con el viaje en curso y con gastos pendientes
  PERFORM pg_temp.as_user(v_jefe);
  r := public.preview_trip_settlement(t1);
  v_err := public.close_trip_settlement(t1, 'DEVOLUCION', v_box, 'EFECTIVO')->>'error';
  PERFORM pg_temp.as_user(NULL);
  IF jsonb_array_length(r->'blocking') = 2 AND v_err LIKE 'No se puede liquidar:%en curso%pendiente%'
     AND (r->>'balance')::numeric = 350 AND (r->>'company_expenses')::numeric = 0
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 bloqueo: ' || r::text || ' ' || COALESCE(v_err, '∅')); END IF;

  -- T5: cierre con devolución: ingreso a caja, anticipo rendido, viaje bloqueado; cuenta del conductor en cero
  UPDATE public.dispatches SET status = 'RETORNO_COMPLETADO', returned_at = now() WHERE id = t1;
  PERFORM pg_temp.as_user(v_jefe);
  PERFORM public.review_dispatch_expense(e3, 'APROBAR');
  v_err := public.close_trip_settlement(t1, 'REEMBOLSO', v_box, 'EFECTIVO')->>'error';
  r := public.close_trip_settlement(t1, 'DEVOLUCION', v_box, 'EFECTIVO', 'Recibo 002');
  v_txt := NULL;
  PERFORM pg_temp.as_user(v_drv_prof);
  BEGIN
    INSERT INTO public.dispatch_expenses (dispatch_id, driver_id, expense_type, amount, receipt_url, created_by) VALUES (t1, v_driver, 'PEAJE', 5, 'd/3.jpg', v_drv_prof);
  EXCEPTION WHEN raise_exception THEN v_txt := SQLERRM; END;
  PERFORM pg_temp.as_user(v_jefe);
  SELECT balance INTO v_num FROM public.vw_driver_cash_account WHERE driver_id = v_driver;
  PERFORM pg_temp.as_user(NULL);
  IF (r->>'balance')::numeric = 350 AND v_err LIKE '%devolución o descuento%' AND v_txt LIKE '%ya fue liquidado%'
     AND public.cash_box_balance(v_box) = 420 + 350
     AND (SELECT status FROM public.trip_advances WHERE id = a1) = 'RENDIDO'
     AND (SELECT status = 'CERRADA' AND company_expenses = 80 AND driver_expenses = 150 FROM public.trip_settlements WHERE dispatch_id = t1)
     AND v_num = 0
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T5 cierre: ' || r::text || ' ' || COALESCE(v_err, '∅') || ' ' || COALESCE(v_txt, '∅') || ' cta=' || COALESCE(v_num::text, '∅') || ' caja=' || public.cash_box_balance(v_box)); END IF;

  -- T6: saldo a favor del conductor ⇒ solo reembolso
  PERFORM pg_temp.as_user(v_jefe);
  a2 := (public.request_trip_advance(t2, 100)->>'advance_id')::uuid;
  PERFORM public.deliver_trip_advance(a2, v_bank, 'TRANSFERENCIA');
  PERFORM pg_temp.as_user(v_drv_prof);
  INSERT INTO public.dispatch_expenses (dispatch_id, driver_id, expense_type, amount, receipt_url, created_by) VALUES (t2, v_driver, 'HOSPEDAJE', 180, 'd/4.jpg', v_drv_prof) RETURNING id INTO e4;
  PERFORM pg_temp.as_user(v_jefe);
  PERFORM public.review_dispatch_expense(e4, 'APROBAR');
  PERFORM pg_temp.as_user(NULL);
  UPDATE public.dispatches SET status = 'RETORNO_COMPLETADO', returned_at = now() - interval '3 days' WHERE id = t2;
  PERFORM pg_temp.as_user(v_jefe);
  v_err := public.close_trip_settlement(t2, 'DEVOLUCION', v_bank, 'EFECTIVO')->>'error';
  PERFORM pg_temp.as_user(v_drv_prof);
  SELECT count(*) INTO v_n FROM public.cash_movements WHERE dispatch_id = t2;  -- el conductor ve su anticipo
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE '%corresponde reembolso%' AND v_n = 1 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T6 reembolso: ' || COALESCE(v_err, '∅') || ' n=' || v_n); END IF;

  -- T7: rendición vencida bloquea un anticipo nuevo; solo el Administrador autoriza con motivo
  INSERT INTO public.dispatches (dispatch_number, vehicle_plate, driver_id, status, site_id) VALUES ('ZZ-C2-003', 'ZZC2A', v_driver, 'PROGRAMADO', v_site) RETURNING id INTO t3;
  PERFORM pg_temp.as_user(v_jefe);
  a3 := (public.request_trip_advance(t3, 200)->>'advance_id')::uuid;
  v_err := public.deliver_trip_advance(a3, v_box, 'EFECTIVO')->>'error';
  PERFORM pg_temp.as_user(v_admin);
  v_txt := public.deliver_trip_advance(a3, v_box, 'EFECTIVO')->>'error';
  r := public.deliver_trip_advance(a3, v_box, 'EFECTIVO', NULL, 'Viaje urgente autorizado por gerencia');
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE '%rendiciones vencidas (ZZ-C2-002)%' AND v_txt LIKE '%motivo%' AND (r->>'success')::boolean
     AND (SELECT override_reason IS NOT NULL FROM public.trip_advances WHERE id = a3)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T7 vencidas: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(v_txt, '∅') || ' | ' || r::text); END IF;

  -- T8: reembolso, reapertura (solo Administrador) y conformidad del conductor
  PERFORM pg_temp.as_user(v_jefe);
  r := public.close_trip_settlement(t2, 'REEMBOLSO', v_bank, 'TRANSFERENCIA');
  v_err := public.reopen_trip_settlement(t2, 'x')->>'error';
  PERFORM pg_temp.as_user(v_admin);
  PERFORM public.reopen_trip_settlement(t2, 'Faltó un peaje');
  v_num := public.cash_box_balance(v_bank);
  PERFORM pg_temp.as_user(v_jefe);
  PERFORM public.close_trip_settlement(t2, 'REEMBOLSO', v_bank, 'TRANSFERENCIA');
  PERFORM pg_temp.as_user(v_drv_prof);
  v_txt := public.acknowledge_trip_settlement(t2)->>'success';
  PERFORM pg_temp.as_user(NULL);
  IF (r->>'balance')::numeric = -80 AND v_err LIKE 'Solo el Administrador%' AND v_num = -100 AND public.cash_box_balance(v_bank) = -180
     AND v_txt = 'true' AND (SELECT status = 'CERRADA' AND driver_ack_by = v_drv_prof AND resolution = 'REEMBOLSO' FROM public.trip_settlements WHERE dispatch_id = t2)
     AND (SELECT count(*) FROM public.cash_movements WHERE dispatch_id = t2 AND movement_type = 'REEMBOLSO') = 2
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T8 reapertura: ' || r::text || ' ' || COALESCE(v_err, '∅') || ' banco=' || v_num || '/' || public.cash_box_balance(v_bank)); END IF;

  -- T9: arqueo con diferencia exige motivo, ajusta el libro y es único por día
  PERFORM pg_temp.as_user(v_fondos);
  v_num := public.cash_box_balance(v_box);
  v_err := public.close_cash_box(v_box, v_num - 10)->>'error';
  r := public.close_cash_box(v_box, v_num - 10, 'Faltante por vuelto');
  v_txt := public.close_cash_box(v_box, v_num - 10, 'otra vez')->>'error';
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE '%diferencia%' AND (r->>'difference')::numeric = -10 AND v_txt LIKE '%ya tiene arqueo%' AND public.cash_box_balance(v_box) = v_num - 10
     AND (SELECT movement_id IS NOT NULL FROM public.cash_box_closures WHERE box_id = v_box)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T9 arqueo: ' || COALESCE(v_err, '∅') || ' ' || r::text || ' ' || COALESCE(v_txt, '∅')); END IF;

  -- T10: el libro es inmutable
  v_err := NULL;
  BEGIN UPDATE public.cash_movements SET amount = 1 WHERE box_id = v_box;
  EXCEPTION WHEN raise_exception THEN v_err := SQLERRM; END;
  IF v_err LIKE '%no se modifican%' THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || text 'T10 inmutable'; END IF;

  -- T11: acceso: sin permisos no ve cajas ni anticipos; el conductor no ve cajas ni gestiona anticipos
  PERFORM pg_temp.as_user(v_nobody);
  SELECT count(*) INTO v_n FROM public.cash_boxes WHERE code LIKE 'ZZ-%';
  v_err := public.request_trip_advance(t3, 10)->>'error';
  PERFORM pg_temp.as_user(v_drv_prof);
  SELECT count(*) + v_n INTO v_n FROM public.cash_boxes WHERE code LIKE 'ZZ-%';
  v_txt := public.close_trip_settlement(t3, 'SIN_SALDO')->>'error';
  PERFORM pg_temp.as_user(v_jefe);
  v_num := (SELECT count(*) FROM public.cash_boxes WHERE code LIKE 'ZZ-%');
  PERFORM pg_temp.as_user(NULL);
  IF v_n = 0 AND v_err LIKE 'Sin permiso%' AND v_txt LIKE 'Sin permiso%' AND v_num = 2
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T11 acceso: n=' || v_n || ' ' || COALESCE(v_err, '∅') || ' ' || COALESCE(v_txt, '∅') || ' jefe=' || v_num); END IF;

  -- T12: combustible desde Caja web pagado con caja: vale, odómetro de la unidad y egreso al aprobar
  PERFORM pg_temp.as_user(v_fondos);
  INSERT INTO public.dispatch_expenses (vehicle_plate, expense_type, amount, receipt_url, fuel_gallons, fuel_odometer, paid_by, cash_box_id, source)
  VALUES ('zzc2a', 'COMBUSTIBLE', 160, 'caja_receipts/f.jpg', 10, 5400, 'CAJA', v_box, 'WEB') RETURNING id INTO e1;
  v_num := public.cash_box_balance(v_box);
  PERFORM pg_temp.as_user(v_jefe);
  PERFORM public.review_dispatch_expense(e1, 'APROBAR', NULL, NULL, true);
  PERFORM pg_temp.as_user(NULL);
  IF (SELECT current_odometer FROM public.vehicles WHERE plate = 'ZZC2A') = 5400
     AND EXISTS (SELECT 1 FROM public.vehicle_odometer_logs WHERE vehicle_plate = 'ZZC2A' AND odometer_value = 5400 AND source_event = 'COMBUSTIBLE')
     AND (SELECT paid_by = 'CAJA' AND dispatch_id IS NULL AND status = 'APROBADO' FROM public.dispatch_expenses WHERE id = e1)
     AND public.cash_box_balance(v_box) = v_num - 160
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T12 combustible web: ' || v_num || ' → ' || public.cash_box_balance(v_box)); END IF;

  -- T13 (C4): el conductor solicita desde la app; una pendiente por viaje; motivo obligatorio;
  --           terceros no; con rendición vencida no; Caja la entrega
  UPDATE public.dispatches SET status = 'EN_CURSO' WHERE id = t3;
  PERFORM pg_temp.as_user(v_drv_prof);
  v_err := public.request_trip_advance_from_app(t3, 50, '')->>'error';
  r := public.request_trip_advance_from_app(t3, 50, 'Peajes de retorno', '{"PEAJE": 50}');  -- ZZ-C2-002 ya se liquidó en T8
  PERFORM pg_temp.as_user(v_nobody);
  v_n := CASE WHEN (public.request_trip_advance_from_app(t3, 10, 'x')->>'error') LIKE 'Solo puede%' THEN 1 ELSE 0 END;
  PERFORM pg_temp.as_user(v_jefe);
  a2 := (SELECT id FROM public.trip_advances WHERE dispatch_id = t3 AND source = 'APP' AND status = 'SOLICITADO');
  PERFORM public.deliver_trip_advance(a2, v_box, 'YAPE_PLIN');
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE '%para qué%' AND v_n = 1 AND (r->>'success')::boolean AND r->>'code' LIKE 'ANT-%'
     AND (SELECT status = 'ENTREGADO' AND reason = 'Peajes de retorno' AND breakdown->>'PEAJE' = '50' FROM public.trip_advances WHERE id = a2)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T13 app: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(r::text, '∅')); END IF;

  -- T14 (C4): una pendiente por viaje; el conductor la retira; con rendición vencida no puede pedir
  PERFORM pg_temp.as_user(v_drv_prof);
  PERFORM public.request_trip_advance_from_app(t3, 30, 'Hospedaje imprevisto');
  v_err := public.request_trip_advance_from_app(t3, 30, 'Otra')->>'error';
  a3 := (SELECT id FROM public.trip_advances WHERE dispatch_id = t3 AND status = 'SOLICITADO');
  r := public.withdraw_trip_advance_request(a3);
  PERFORM pg_temp.as_user(NULL);
  INSERT INTO public.dispatches (dispatch_number, vehicle_plate, driver_id, status, site_id, returned_at)
  VALUES ('ZZ-C2-004', 'ZZC2A', v_driver, 'RETORNO_COMPLETADO', v_site, now() - interval '5 days') RETURNING id INTO t2;
  INSERT INTO public.trip_advances (dispatch_id, driver_id, amount, status, delivered_at) VALUES (t2, v_driver, 20, 'ENTREGADO', now() - interval '6 days');
  PERFORM pg_temp.as_user(v_drv_prof);
  v_txt := public.request_trip_advance_from_app(t3, 30, 'Combustible')->>'error';
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE 'Ya tiene una solicitud pendiente%' AND (r->>'success')::boolean
     AND (SELECT status FROM public.trip_advances WHERE id = a3) = 'ANULADO' AND v_txt LIKE 'Tiene rendiciones vencidas (ZZ-C2-004)%'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T14 app: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(v_txt, '∅')); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C2 PASS (%/14)', v_pass;
  ELSE
    RAISE EXCEPTION 'CAJA C2 FAIL: %', array_to_string(v_fail, ' || ');
  END IF;
END $test$;

ROLLBACK;
