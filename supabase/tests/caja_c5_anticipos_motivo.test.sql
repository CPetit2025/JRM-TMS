-- Pruebas CAJA C5 — Anticipos por motivo: sin viaje, aprobación, emergencias, rendición y liquidación propia.
-- Termina siempre en error para forzar ROLLBACK: "CAJA C5 PASS (...)" o "CAJA C5 FAIL: ...".
--   npx supabase db query --linked -f supabase/tests/caja_c5_anticipos_motivo.test.sql
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
  v_role_f uuid; v_driver uuid; v_site uuid; v_carrier uuid; t1 uuid;
  v_box uuid;
  a_neu uuid; a_otr uuid; a_mec uuid; a_tra uuid;
  e1 uuid; e2 uuid;
  v_fail text[] := '{}';
  v_pass int := 0;
  r jsonb; v_err text; v_err2 text; v_err3 text; v_txt text; v_n int; v_num numeric;
BEGIN
  SELECT carrier_id, site_id INTO v_carrier, v_site FROM public.vehicles LIMIT 1;
  FOR v_admin IN SELECT id FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u) LOOP
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXIT WHEN public.is_tms_admin();
    v_admin := NULL;
  END LOOP;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'CAJA C5 FAIL: no hay administrador'; END IF;
  SELECT id INTO v_jefe     FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id <> v_admin ORDER BY id LIMIT 1;
  SELECT id INTO v_fondos   FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_jefe) ORDER BY id LIMIT 1;
  SELECT id INTO v_nobody   FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_jefe, v_fondos) ORDER BY id LIMIT 1;
  SELECT id INTO v_drv_prof FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_jefe, v_fondos, v_nobody) ORDER BY id LIMIT 1;
  IF v_drv_prof IS NULL THEN RAISE EXCEPTION 'CAJA C5 FAIL: se requieren 5 perfiles'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ Tesorería C5', '["caja-fondos","caja-gastos"]') RETURNING id INTO v_role_f;
  UPDATE public.profiles SET role_id = (SELECT id FROM public.roles WHERE name = 'Jefe de Distribución'), is_active = true WHERE id = v_jefe;
  UPDATE public.profiles SET role_id = v_role_f, is_active = true WHERE id = v_fondos;
  UPDATE public.profiles SET role_id = NULL, is_active = true WHERE id IN (v_nobody, v_drv_prof);
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_jefe, v_site), (v_fondos, v_site) ON CONFLICT DO NOTHING;
  INSERT INTO public.drivers (carrier_id, profile_id, first_name, last_name, document_number, license_number, is_active)
  VALUES (v_carrier, v_drv_prof, 'Conductor', 'C5', 'ZZC5-DOC', 'ZZC5-LIC', true) RETURNING id INTO v_driver;
  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, status, current_odometer) VALUES
    ('ZZC5A', v_carrier, v_site, 'TRACTO', 'DISPONIBLE', 1000), ('ZZC5B', v_carrier, v_site, 'TRACTO', 'DISPONIBLE', 2000);
  PERFORM pg_temp.as_user(v_fondos);
  INSERT INTO public.cash_boxes (code, name, box_type, site_id) VALUES ('ZZ-C5', 'Caja C5', 'CAJA_CHICA', v_site) RETURNING id INTO v_box;
  PERFORM public.register_cash_movement(v_box, 'APERTURA', 5000, 'EFECTIVO', NULL, 'Fondo inicial');
  PERFORM pg_temp.as_user(NULL);

  -- T1: catálogo sembrado con sus reglas
  IF (SELECT count(*) FROM public.advance_reasons WHERE code IN ('VIATICOS_RUTA', 'NEUMATICO', 'MECANICA_EMERGENCIA', 'TRAMITE_UNIDAD', 'OTROS')) = 5
     AND (SELECT requires_trip AND charge_to = 'VIAJE' FROM public.advance_reasons WHERE code = 'VIATICOS_RUTA')
     AND (SELECT NOT requires_trip AND charge_to = 'UNIDAD' AND is_emergency AND approval_by = 'JEFE' AND evidence_required AND creates_failure
          FROM public.advance_reasons WHERE code = 'NEUMATICO')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || text 'T1 catálogo'; END IF;

  -- T2: neumático sin ruta: evidencia obligatoria y propia; queda cargado a la unidad y pendiente de aprobación
  PERFORM pg_temp.as_user(v_drv_prof);
  v_err  := public.request_advance_from_app('VIATICOS_RUTA', 100, 'Peajes')->>'error';
  v_err2 := public.request_advance_from_app('NEUMATICO', 200, 'Pinchazo en ruta', NULL, 'ZZC5A')->>'error';
  v_err3 := public.request_advance_from_app('NEUMATICO', 200, 'Pinchazo en ruta', NULL, 'ZZC5A', 'otro-usuario/foto.jpg')->>'error';
  r := public.request_advance_from_app('NEUMATICO', 200, 'Pinchazo en ruta', NULL, 'ZZC5A', v_drv_prof::text || '/anticipos/neu.jpg');
  a_neu := (r->>'advance_id')::uuid;
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE '%requiere una ruta%' AND v_err2 LIKE 'Adjunte%' AND v_err3 = 'Evidencia no válida' AND (r->>'success')::boolean
     AND (SELECT dispatch_id IS NULL AND vehicle_plate = 'ZZC5A' AND needs_approval AND status = 'SOLICITADO' AND source = 'APP'
          FROM public.trip_advances WHERE id = a_neu)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 neumático: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(v_err2, '∅') || ' | ' || COALESCE(v_err3, '∅') || ' | ' || COALESCE(r::text, '∅')); END IF;

  -- T3: la falla se reporta a Mantenimiento cuando la función de fallas existe; una pendiente por motivo; "Otros" va al área
  PERFORM pg_temp.as_user(v_drv_prof);
  v_err := public.request_advance_from_app('NEUMATICO', 50, 'Otro', NULL, 'ZZC5A', v_drv_prof::text || '/anticipos/x.jpg')->>'error';
  r := public.request_advance_from_app('OTROS', 80, 'Útiles de limpieza de la cabina');
  a_otr := (r->>'advance_id')::uuid;
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE 'Ya tiene una solicitud pendiente por este motivo%' AND (r->>'success')::boolean
     AND (SELECT vehicle_plate IS NULL AND needs_approval FROM public.trip_advances WHERE id = a_otr)
     AND (SELECT (maintenance_request_id IS NOT NULL) = EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'submit_maintenance_request_v2')
          FROM public.trip_advances WHERE id = a_neu)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 falla/área: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(r::text, '∅')); END IF;

  -- T4: aprobación antes de la entrega; solo caja-aprobacion; el rechazo exige motivo; la entrega fija el plazo
  PERFORM pg_temp.as_user(v_jefe);
  v_err := public.deliver_trip_advance(a_neu, v_box, 'YAPE_PLIN')->>'error';
  PERFORM pg_temp.as_user(v_nobody);
  v_err2 := public.review_advance_request(a_neu, 'APROBAR')->>'error';
  PERFORM pg_temp.as_user(v_jefe);
  v_err3 := public.review_advance_request(a_neu, 'RECHAZAR')->>'error';
  PERFORM public.review_advance_request(a_neu, 'APROBAR', 'Ok, vulcanizadora de la ruta');
  PERFORM public.review_advance_request(a_otr, 'APROBAR');
  r := public.deliver_trip_advance(a_neu, v_box, 'YAPE_PLIN');
  PERFORM public.deliver_trip_advance(a_otr, v_box, 'EFECTIVO');
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE '%requiere la aprobación%' AND v_err2 LIKE 'Solo el Jefe%' AND v_err3 LIKE '%motivo del rechazo%' AND (r->>'success')::boolean
     AND (SELECT status = 'ENTREGADO' AND approved_by = v_jefe AND due_at BETWEEN now() + interval '23 hours' AND now() + interval '25 hours'
          FROM public.trip_advances WHERE id = a_neu)
     AND (SELECT dispatch_id IS NULL AND advance_id = a_neu AND amount = 200 FROM public.cash_movements WHERE id = (r->>'movement_id')::uuid)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 aprobación/entrega: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(v_err2, '∅') || ' | ' || COALESCE(v_err3, '∅') || ' | ' || COALESCE(r::text, '∅')); END IF;

  -- T5: rendición contra el anticipo: solo el conductor o Caja; va a la unidad (TCO) o al área
  PERFORM pg_temp.as_user(v_nobody);
  v_err := public.register_advance_expense(a_neu, 'LLANTAS_PARCHADO', 120, v_nobody::text || '/r.jpg')->>'error';
  PERFORM pg_temp.as_user(v_drv_prof);
  v_err2 := public.register_advance_expense(a_neu, 'LLANTAS_PARCHADO', 120)->>'error';
  e1 := (public.register_advance_expense(a_neu, 'LLANTAS_PARCHADO', 120, v_drv_prof::text || '/anticipos/boleta.jpg')->>'expense_id')::uuid;
  e2 := (public.register_advance_expense(a_otr, 'OTROS', 80, v_drv_prof::text || '/anticipos/b2.jpg')->>'expense_id')::uuid;
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE 'Solo el conductor%' AND v_err2 LIKE 'Adjunte%'
     AND (SELECT dispatch_id IS NULL AND advance_id = a_neu AND vehicle_plate = 'ZZC5A' AND site_id = v_site AND driver_id = v_driver
          AND status = 'PENDIENTE' AND paid_by = 'CONDUCTOR' FROM public.dispatch_expenses WHERE id = e1)
     AND (SELECT vehicle_plate IS NULL AND site_id IS NULL AND advance_id = a_otr FROM public.dispatch_expenses WHERE id = e2)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T5 rendición: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(v_err2, '∅') || ' e1=' || COALESCE(e1::text, '∅')); END IF;

  -- T6: liquidación propia del anticipo: bloquea con pendientes; saldo a devolver; luego no admite gastos
  PERFORM pg_temp.as_user(v_jefe);
  v_err := public.close_advance_settlement(a_neu, 'DEVOLUCION', v_box, 'EFECTIVO')->>'error';
  PERFORM public.review_dispatch_expense(e1, 'APROBAR');
  r := public.preview_advance_settlement(a_neu);
  v_err2 := public.close_advance_settlement(a_neu, 'REEMBOLSO', v_box, 'EFECTIVO')->>'error';
  PERFORM public.close_advance_settlement(a_neu, 'DEVOLUCION', v_box, 'EFECTIVO');
  PERFORM pg_temp.as_user(v_drv_prof);
  v_err3 := public.register_advance_expense(a_neu, 'LLANTAS_PARCHADO', 10, v_drv_prof::text || '/anticipos/tarde.jpg')->>'error';
  v_txt := public.acknowledge_advance_settlement(a_neu)->>'success';
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE '%pendiente(s) de aprobación%' AND (r->>'balance')::numeric = 80 AND r->>'suggested_resolution' = 'DEVOLUCION'
     AND v_err2 LIKE 'El conductor debe S/ 80%' AND v_err3 LIKE '%no está entregado%' AND v_txt = 'true'
     AND (SELECT status = 'RENDIDO' FROM public.trip_advances WHERE id = a_neu)
     AND (SELECT status = 'CERRADA' AND resolution = 'DEVOLUCION' AND balance = 80 AND dispatch_id IS NULL AND driver_ack_at IS NOT NULL
          FROM public.trip_settlements WHERE advance_id = a_neu)
     AND (SELECT amount = 80 AND direction = 1 FROM public.cash_movements WHERE settlement_id = (SELECT id FROM public.trip_settlements WHERE advance_id = a_neu))
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T6 liquidación: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(v_err2, '∅') || ' | ' || COALESCE(v_err3, '∅') || ' | ' || COALESCE(r::text, '∅')); END IF;

  -- T7: rendición vencida: bloquea motivos comunes, pero una emergencia pasa marcada y se entrega aprobada
  UPDATE public.trip_advances SET due_at = now() - interval '1 hour' WHERE id = a_otr;
  PERFORM pg_temp.as_user(v_drv_prof);
  v_err := public.request_advance_from_app('TRAMITE_UNIDAD', 100, 'Revisión técnica', NULL, 'ZZC5A', v_drv_prof::text || '/anticipos/rt.jpg')->>'error';
  r := public.request_advance_from_app('MECANICA_EMERGENCIA', 300, 'Se rompió la faja', NULL, 'ZZC5B', v_drv_prof::text || '/anticipos/faja.jpg');
  a_mec := (r->>'advance_id')::uuid;
  PERFORM pg_temp.as_user(v_jefe);
  a_tra := (public.request_unit_advance(v_driver, 'TRAMITE_UNIDAD', 100, 'Papeleta', 'ZZC5A')->>'advance_id')::uuid;
  PERFORM public.review_advance_request(a_mec, 'APROBAR');
  v_txt := public.deliver_trip_advance(a_mec, v_box, 'YAPE_PLIN')->>'success';
  PERFORM public.review_advance_request(a_tra, 'APROBAR');
  v_err2 := public.deliver_trip_advance(a_tra, v_box, 'EFECTIVO')->>'error';
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE 'Tiene rendiciones vencidas (ANT-%' AND (r->>'success')::boolean AND r->>'overdue' LIKE 'ANT-%'
     AND (SELECT needs_approval AND overdue_flag LIKE 'ANT-%' FROM public.trip_advances WHERE id = a_mec)
     AND v_txt = 'true' AND v_err2 LIKE 'El conductor tiene rendiciones vencidas%'
     AND (SELECT overdue_advances = 1 FROM public.vw_driver_cash_account WHERE driver_id = v_driver)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T7 vencidos: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(v_err2, '∅') || ' | ' || COALESCE(v_txt, '∅') || ' | ' || COALESCE(r::text, '∅')); END IF;

  -- T8: viáticos con ruta siguen como antes (firma C4) y no se mezclan con los anticipos de la unidad
  UPDATE public.trip_advances SET due_at = now() + interval '1 day' WHERE id = a_otr;
  INSERT INTO public.dispatches (dispatch_number, vehicle_plate, driver_id, status, site_id) VALUES ('ZZ-C5-001', 'ZZC5B', v_driver, 'EN_CURSO', v_site) RETURNING id INTO t1;
  PERFORM pg_temp.as_user(v_drv_prof);
  r := public.request_trip_advance_from_app(t1, 150, 'Peajes', '{"PEAJE": 150}');
  v_err := public.request_advance_from_app('VIATICOS_RUTA', 20, 'Más peajes', t1)->>'error';
  PERFORM pg_temp.as_user(v_jefe);
  v_txt := public.deliver_trip_advance((r->>'advance_id')::uuid, v_box, 'EFECTIVO')->>'success';
  v_num := (public.preview_trip_settlement(t1)->>'advances_total')::numeric;
  PERFORM pg_temp.as_user(NULL);
  IF (r->>'success')::boolean AND v_err LIKE 'Ya tiene una solicitud pendiente para este viaje%' AND v_txt = 'true' AND v_num = 150
     AND (SELECT reason_code = 'VIATICOS_RUTA' AND dispatch_id = t1 AND NOT needs_approval FROM public.trip_advances WHERE id = (r->>'advance_id')::uuid)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T8 viaje: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(r::text, '∅') || ' n=' || COALESCE(v_num::text, '∅')); END IF;

  -- T9: visibilidad: Caja ve los anticipos sin viaje; un tercero no; el conductor ve los suyos
  PERFORM pg_temp.as_user(v_fondos);
  SELECT count(*) INTO v_n FROM public.vw_caja_advances WHERE driver_id = v_driver AND dispatch_id IS NULL;
  PERFORM pg_temp.as_user(v_nobody);
  SELECT count(*) INTO v_num FROM public.trip_advances WHERE driver_id = v_driver;
  PERFORM pg_temp.as_user(v_drv_prof);
  v_txt := (SELECT string_agg(reason_label || ':' || COALESCE(settlement_code, '-'), ',' ORDER BY code) FROM public.vw_caja_advances WHERE dispatch_id IS NULL);
  PERFORM pg_temp.as_user(NULL);
  IF v_n = 4 AND v_num = 0 AND v_txt LIKE 'Neumático%LIQ-%'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T9 visibilidad: caja=' || v_n || ' tercero=' || v_num || ' conductor=' || COALESCE(v_txt, '∅')); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C5 PASS (%/9)', v_pass;
  END IF;
  RAISE EXCEPTION 'CAJA C5 FAIL: %', array_to_string(v_fail, ' || ');
END $test$;

ROLLBACK;
