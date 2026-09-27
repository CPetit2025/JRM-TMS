-- Pruebas FASE 1 — Maestro de activos y Flota 360°.
-- Termina siempre en error para forzar ROLLBACK: "F1 PASS (...)" o "F1 FAIL: ...".
--   npx supabase db query --linked -f supabase/tests/f1_activos_flota360.test.sql
BEGIN;

DO $test$
DECLARE
  v_admin   uuid;
  v_nobody  uuid := gen_random_uuid();
  v_carrier uuid;
  v_site    uuid;
  v_veh     uuid;
  v_wo      uuid;
  v_wo2     uuid;
  v_fail    text[] := '{}';
  v_pass    int := 0;
  r         jsonb;
  v_err     text;
  v_n       int;
  w         record;
BEGIN
  SELECT carrier_id, site_id INTO v_carrier, v_site FROM public.vehicles LIMIT 1;
  FOR v_admin IN SELECT id FROM public.profiles LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXIT WHEN public.is_tms_admin();
    v_admin := NULL;
  END LOOP;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'F1 FAIL: no hay administrador'; END IF;

  -- T1: alta desde cliente: identidad normalizada, OBSERVADA, espejo de odómetro y registro de alta
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.vehicles (plate, internal_code, carrier_id, site_id, type, brand, model, year, status, current_odometer, weight_capacity, criticality, ownership_status)
  VALUES (' zzf1a1 ', 'eq-001', v_carrier, v_site, 'CAMION', 'VOLVO', 'FH', 2022, 'DISPONIBLE', 12000.5, 30000, 'ALTA', 'PROPIO')
  RETURNING id INTO v_veh;
  EXECUTE 'RESET ROLE';
  SELECT plate, internal_code, status, current_mileage, capacity_weight INTO w FROM public.vehicles WHERE id = v_veh;
  IF w.plate = 'ZZF1A1' AND w.internal_code = 'EQ-001' AND w.status = 'OBSERVADA' AND w.current_mileage = 12001
     AND w.capacity_weight = 30000
     AND EXISTS (SELECT 1 FROM public.vehicle_history_logs WHERE vehicle_plate = 'ZZF1A1' AND field_changed = 'alta' AND changed_by = v_admin) THEN
    v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T1 alta: ' || row_to_json(w)::text); END IF;

  -- T2: cambios del maestro quedan auditados campo por campo
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE public.vehicles SET criticality = 'MEDIA', current_location = 'Base Lurín', current_odometer = 12500 WHERE id = v_veh;
  EXECUTE 'RESET ROLE';
  SELECT count(*) INTO v_n FROM public.vehicle_history_logs
  WHERE vehicle_plate = 'ZZF1A1' AND changed_by = v_admin
    AND ((field_changed = 'criticality' AND old_value = 'ALTA' AND new_value = 'MEDIA')
      OR (field_changed = 'current_location' AND new_value = 'Base Lurín')
      OR (field_changed = 'current_odometer' AND new_value::numeric = 12500));
  IF v_n = 3 AND (SELECT current_mileage FROM public.vehicles WHERE id = v_veh) = 12500 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T2 auditoría: ' || v_n); END IF;

  -- T3: la identidad (placa) no cambia; T4: odómetro/horómetro no retroceden
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_err := NULL;
  BEGIN
    UPDATE public.vehicles SET plate = 'ZZF1X9' WHERE id = v_veh;
  EXCEPTION WHEN insufficient_privilege THEN v_err := 'placa';
  END;
  BEGIN
    UPDATE public.vehicles SET current_odometer = 100 WHERE id = v_veh;
    v_err := v_err || '/odometro aceptado';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  EXECUTE 'RESET ROLE';
  IF v_err = 'placa' THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3/T4 identidad/lecturas: ' || COALESCE(v_err, 'placa aceptada')); END IF;

  -- T5: código interno único (sin importar mayúsculas)
  v_err := NULL;
  BEGIN
    INSERT INTO public.vehicles (plate, internal_code, carrier_id, site_id, type, status) VALUES ('ZZF1B1', 'EQ-001', v_carrier, v_site, 'CAMION', 'OBSERVADA');
  EXCEPTION WHEN unique_violation THEN v_err := SQLERRM;
  END;
  IF v_err IS NOT NULL THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || text 'T5 código interno duplicado aceptado'; END IF;

  -- T6: equipo no vehicular identificado por código; horómetro no retrocede
  INSERT INTO public.vehicles (plate, internal_code, carrier_id, site_id, type, status, current_hours)
  VALUES ('MC-01', 'MC-01', v_carrier, v_site, 'MONTACARGAS', 'OBSERVADA', 1500);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_err := NULL;
  BEGIN
    UPDATE public.vehicles SET current_hours = 1400 WHERE plate = 'MC-01';
  EXCEPTION WHEN invalid_parameter_value THEN v_err := SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  IF v_err IS NOT NULL THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || text 'T6 horómetro retrocedió'; END IF;

  -- T7: costos por activo (TCO): excluye OT canceladas; CPK sobre odómetro
  INSERT INTO public.maintenance_work_orders (ot_code, vehicle_id, description, order_type, site_id) VALUES ('ZZ-F1-1', v_veh, 'x', 'CORRECTIVA', v_site) RETURNING id INTO v_wo;
  INSERT INTO public.maintenance_work_orders (ot_code, vehicle_id, description, order_type, site_id) VALUES ('ZZ-F1-2', v_veh, 'y', 'CORRECTIVA', v_site) RETURNING id INTO v_wo2;
  INSERT INTO public.work_order_costs (work_order_id, cost_type, amount) VALUES (v_wo, 'MANO_OBRA', 500), (v_wo2, 'MANO_OBRA', 900);
  PERFORM public.transition_work_order(v_wo2, 'CANCELADA', 'duplicada');
  SELECT maintenance_cost, maintenance_cpk INTO w FROM public.vehicle_tco_analytics WHERE vehicle_id = v_veh;
  IF w.maintenance_cost = 500 AND w.maintenance_cpk = round(500 / 12500.0, 4) THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T7 TCO: ' || row_to_json(w)::text); END IF;

  -- T8: un activo con historia no se elimina; uno recién creado sin operación sí
  v_err := NULL;
  BEGIN
    DELETE FROM public.vehicles WHERE id = v_veh;
  EXCEPTION WHEN insufficient_privilege THEN v_err := SQLERRM;
  END;
  DELETE FROM public.vehicles WHERE plate = 'MC-01';
  IF v_err IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.vehicles WHERE plate = 'MC-01') THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || text 'T8 eliminación'; END IF;

  -- T9: ficha 360 consolidada
  INSERT INTO public.maintenance_requests (vehicle_plate, description, severity, status) VALUES ('ZZF1A1', 'Luz de tablero', 'BAJA', 'REPORTADA');
  r := public.get_fleet_360_view('zzf1a1');
  IF r->'vehicle'->>'plate' = 'ZZF1A1' AND r->'eligibility'->>'status' IS NOT NULL
     AND jsonb_array_length(r->'open_requests') = 1 AND jsonb_array_length(r->'work_orders') = 2
     AND jsonb_array_length(r->'history') >= 4 AND (r->'costs'->>'maintenance_cost')::numeric = 500
     AND r ? 'tires' AND r ? 'documents' AND r ? 'inspections' AND r ? 'preventive' AND r ? 'photos' THEN
    v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T9 ficha 360: ' || left(r::text, 300)); END IF;

  -- T10: auditoría solo la escribe el servidor
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_err := NULL;
  BEGIN
    INSERT INTO public.vehicle_history_logs (vehicle_plate, field_changed, new_value) VALUES ('ZZF1A1', 'status', 'DISPONIBLE');
  EXCEPTION WHEN insufficient_privilege THEN v_err := SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  IF v_err IS NOT NULL THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || text 'T10 auditoría falsificable'; END IF;

  -- T11: sin permisos no ve el historial del activo
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_nobody, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_nobody::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_n FROM public.vehicle_history_logs WHERE vehicle_plate = 'ZZF1A1';
  EXECUTE 'RESET ROLE';
  IF v_n = 0 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T11 historial visible sin permiso: ' || v_n); END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION 'F1 FAIL (% ok, % fallas): %', v_pass, array_length(v_fail, 1), array_to_string(v_fail, ' || ');
  END IF;
  RAISE EXCEPTION 'F1 PASS (% pruebas)', v_pass;
END
$test$;

ROLLBACK;
