-- Pruebas FASE 2 — Motor único de elegibilidad y guard de estados.
-- Se ejecuta dentro de una transacción y SIEMPRE termina en error para garantizar
-- el ROLLBACK: el mensaje final es "F2 PASS (...)" o "F2 FAIL: ...".
--   npx supabase db query --linked -f supabase/tests/f2_motor_elegibilidad.test.sql
BEGIN;

DO $test$
DECLARE
  v_admin    uuid;
  v_nobody   uuid := gen_random_uuid();   -- usuario sin permisos TMS
  v_carrier  uuid;
  v_site     uuid;
  v_fail     text[] := '{}';
  v_pass     int := 0;
  r          jsonb;
  v_status   text;
  v_err      text;
  v_rows     int;
  v_wo       uuid;
  v_ok_docs  date := CURRENT_DATE + 365;

BEGIN
  -- Contexto --------------------------------------------------------------
  SELECT carrier_id, site_id INTO v_carrier, v_site FROM public.vehicles LIMIT 1;

  FOR v_admin IN SELECT id FROM public.profiles LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXIT WHEN public.has_tms_permission('admin');
    v_admin := NULL;
  END LOOP;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'F2 FAIL: no hay un perfil administrador para ejecutar las pruebas';
  END IF;

  -- Datos de prueba (como dueño: el guard no aplica) ------------------------
  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, brand, status, soat_expiration, technical_review_expiration, current_odometer)
  VALUES ('ZZF2A1', v_carrier, v_site, 'CAMION', 'TEST', 'MANTENIMIENTO', v_ok_docs, v_ok_docs, 1000),
         ('ZZF2B1', v_carrier, v_site, 'CAMION', 'TEST', 'MANTENIMIENTO', CURRENT_DATE - 1, v_ok_docs, 1000),
         ('ZZF2C1', v_carrier, v_site, 'MONTACARGAS', 'TEST', 'MANTENIMIENTO', NULL, NULL, 0),
         ('ZZF2D1', v_carrier, v_site, 'CAMION', 'TEST', 'FUERA_DE_SERVICIO', v_ok_docs, v_ok_docs, 1000);

  -- Sesión como administrador ---------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- T1: documentos vigentes, sin OT ni fallas → liberar OK
  r := public.transition_vehicle_status('ZZF2A1', 'DISPONIBLE', 'T1');
  IF (r->>'success')::boolean THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 liberar apto: ' || r::text); END IF;

  -- T2: SOAT vencido → NO_APTO, no libera
  r := public.transition_vehicle_status('ZZF2B1', 'DISPONIBLE', 'T2');
  IF NOT (r->>'success')::boolean AND r->'eligibility'->>'status' = 'NO_APTO' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T2 SOAT vencido: ' || r::text); END IF;

  -- T3 (caso del plan): OT CERRADA + SOAT vencido → NO_APTO
  INSERT INTO public.maintenance_work_orders (ot_code, vehicle_id, description, status)
  SELECT 'OT-F2-T3', id, 'prueba', 'CERRADA' FROM public.vehicles WHERE plate = 'ZZF2B1';
  r := public.check_asset_eligibility('ZZF2B1');
  IF r->>'status' = 'NO_APTO' THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 OT cerrada + SOAT: ' || r::text); END IF;

  -- T4: OT abierta bloquea la liberación aunque los documentos estén vigentes
  UPDATE public.vehicles SET status = 'MANTENIMIENTO' WHERE plate = 'ZZF2A1';
  INSERT INTO public.maintenance_work_orders (ot_code, vehicle_id, description, status)
  SELECT 'OT-F2-T4', id, 'prueba', 'EN_PROCESO' FROM public.vehicles WHERE plate = 'ZZF2A1'
  RETURNING id INTO v_wo;
  r := public.transition_vehicle_status('ZZF2A1', 'DISPONIBLE', 'T4');
  IF NOT (r->>'success')::boolean THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 OT abierta liberó: ' || r::text); END IF;

  -- T5: OT en TERMINADA (sin validar) sigue bloqueando
  UPDATE public.maintenance_work_orders SET status = 'TERMINADA' WHERE id = v_wo;
  r := public.check_asset_eligibility('ZZF2A1');
  IF r->>'status' = 'NO_APTO' THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T5 OT TERMINADA: ' || r::text); END IF;

  -- T6: al cerrar la OT vuelve a ser elegible
  UPDATE public.maintenance_work_orders SET status = 'CERRADA' WHERE id = v_wo;
  r := public.check_asset_eligibility('ZZF2A1');
  IF r->>'status' <> 'NO_APTO' THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T6 OT cerrada: ' || r::text); END IF;

  -- T7: falla crítica abierta bloquea (con y sin tilde)
  INSERT INTO public.maintenance_requests (vehicle_plate, description, severity, status)
  VALUES ('ZZF2A1', 'freno', 'CRÍTICA', 'REPORTADA');
  r := public.check_asset_eligibility('ZZF2A1');
  IF r->>'status' = 'NO_APTO' AND NOT (r->'checks'->>'no_critical_faults')::boolean THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T7 falla crítica: ' || r::text); END IF;
  DELETE FROM public.maintenance_requests WHERE vehicle_plate = 'ZZF2A1';

  -- T8: preventivo vencido bloquea
  INSERT INTO public.maintenance_plans (name, activity_description, vehicle_type, vehicle_plate, frequency_km, frequency_days, is_active, last_performed_km, last_performed_date)
  VALUES ('F2-T8', 'prueba', 'CAMION', 'ZZF2A1', 500, 365, true, 0, CURRENT_DATE);
  r := public.check_asset_eligibility('ZZF2A1');
  IF r->>'status' = 'NO_APTO' AND NOT (r->'checks'->>'no_overdue_preventive')::boolean THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T8 preventivo vencido: ' || r::text); END IF;
  DELETE FROM public.maintenance_plans WHERE name = 'F2-T8';

  -- T9: montacargas no exige SOAT/RT; horómetro vacío es observación
  r := public.check_asset_eligibility('ZZF2C1');
  IF r->>'status' = 'APTO_CON_OBSERVACION' THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T9 montacargas: ' || r::text); END IF;

  -- T10: transición inválida (FUERA_DE_SERVICIO → ASIGNADA)
  r := public.transition_vehicle_status('ZZF2D1', 'ASIGNADA', 'T10');
  IF NOT (r->>'success')::boolean THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T10 transición inválida: ' || r::text); END IF;

  -- T11: despacho sobre unidad no DISPONIBLE → BLOQUEADO
  r := public.check_vehicle_eligibility('ZZF2D1', NULL);
  IF r->>'status' = 'BLOQUEADO' AND NOT (r->>'eligible')::boolean THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T11 despacho no disponible: ' || r::text); END IF;

  -- T12: bloqueo administrativo vía RPC → BLOQUEADA y NO_APTO
  r := public.set_vehicle_administrative_block('ZZF2A1', true, 'Auditoría de prueba');
  SELECT status INTO v_status FROM public.vehicles WHERE plate = 'ZZF2A1';
  IF (r->>'success')::boolean AND v_status = 'BLOQUEADA'
     AND public.check_asset_eligibility('ZZF2A1')->>'status' = 'NO_APTO' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T12 bloqueo admin: ' || r::text || ' estado=' || v_status); END IF;

  -- T13: el cambio queda auditado
  IF EXISTS (SELECT 1 FROM public.vehicle_history_logs WHERE vehicle_plate = 'ZZF2A1' AND field_changed = 'status' AND new_value = 'BLOQUEADA') THEN
    v_pass := v_pass + 1; ELSE v_fail := v_fail || text 'T13 sin registro de auditoría'; END IF;

  -- Sesión sin permisos TMS -----------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_nobody, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_nobody::text, true);

  -- T14: usuario sin permisos no puede liberar
  r := public.transition_vehicle_status('ZZF2D1', 'DISPONIBLE', 'T14');
  IF NOT (r->>'success')::boolean THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T14 liberó sin permiso: ' || r::text); END IF;

  -- T15: usuario sin permisos no puede quitar un bloqueo administrativo
  r := public.set_vehicle_administrative_block('ZZF2A1', false, NULL);
  IF NOT (r->>'success')::boolean THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T15 desbloqueó sin permiso: ' || r::text); END IF;

  -- Ataques directos como rol de cliente -----------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  -- T16: UPDATE directo de status (incluso como admin) es rechazado
  v_err := NULL;
  BEGIN
    UPDATE public.vehicles SET status = 'DISPONIBLE' WHERE plate = 'ZZF2B1';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN insufficient_privilege THEN v_err := SQLERRM;
  END;
  -- T17: UPDATE directo de is_blocked es rechazado
  BEGIN
    UPDATE public.vehicles SET is_blocked = false, block_reason = NULL WHERE plate = 'ZZF2A1';
    IF v_err IS NOT NULL THEN v_err := v_err || ' / T17 sin error'; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- T18: INSERT directo entra forzado como OBSERVADA
  BEGIN
    INSERT INTO public.vehicles (plate, carrier_id, site_id, type, brand, status)
    VALUES ('ZZF2E1', v_carrier, v_site, 'CAMION', 'TEST', 'DISPONIBLE');
  EXCEPTION WHEN insufficient_privilege THEN NULL;  -- RLS puede impedirlo: también es aceptable
  END;
  EXECUTE 'RESET ROLE';

  SELECT status INTO v_status FROM public.vehicles WHERE plate = 'ZZF2B1';
  IF v_status = 'MANTENIMIENTO' AND (v_err IS NOT NULL OR v_rows = 0) THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T16 update directo status → ' || v_status || ' err=' || COALESCE(v_err, 'ninguno')); END IF;

  SELECT status INTO v_status FROM public.vehicles WHERE plate = 'ZZF2A1';
  IF (SELECT is_blocked FROM public.vehicles WHERE plate = 'ZZF2A1') AND v_status = 'BLOQUEADA' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || text 'T17 update directo is_blocked prosperó'; END IF;

  SELECT status INTO v_status FROM public.vehicles WHERE plate = 'ZZF2E1';
  IF v_status IS NULL OR v_status = 'OBSERVADA' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T18 insert directo quedó ' || v_status); END IF;

  -- T19: anon no puede ejecutar las RPC de estado
  IF NOT has_function_privilege('anon', 'public.transition_vehicle_status(text,text,text)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.transition_vehicle_status(text,text,text,uuid,jsonb)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.set_vehicle_administrative_block(text,boolean,text)', 'EXECUTE') THEN
    v_pass := v_pass + 1; ELSE v_fail := v_fail || text 'T19 anon puede ejecutar RPC de estado'; END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION 'F2 FAIL (% ok, % fallas): %', v_pass, array_length(v_fail, 1), array_to_string(v_fail, ' || ');
  END IF;
  RAISE EXCEPTION 'F2 PASS (% pruebas)', v_pass;
END
$test$;

ROLLBACK;
