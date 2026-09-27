-- Pruebas FASE 8 — Neumáticos.
-- Termina siempre en error para forzar ROLLBACK: "F8 PASS (...)" o "F8 FAIL: ...".
--   npx supabase db query --linked -f supabase/tests/f8_neumaticos.test.sql
BEGIN;

DO $test$
DECLARE
  v_admin   uuid;
  v_nobody  uuid := gen_random_uuid();
  v_carrier uuid;
  v_site    uuid;
  v_a       uuid;
  v_b       uuid;
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
  IF v_admin IS NULL THEN RAISE EXCEPTION 'F8 FAIL: no hay administrador'; END IF;

  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, brand, status, soat_expiration, technical_review_expiration, current_odometer)
  VALUES ('ZZF8A1', v_carrier, v_site, 'TRACTO', 'TEST', 'DISPONIBLE', CURRENT_DATE + 365, CURRENT_DATE + 365, 100000);

  -- T1: alta desde cliente entra al almacén y registra la COMPRA
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.tires (codigo_interno, marca, modelo, medida, costo, cocada_original, estado, purchase_date)
  VALUES (' zz-neu-001 ', 'MICHELIN', 'X MULTI', '295/80R22.5', 1000, 16, 'INSTALADO', CURRENT_DATE) RETURNING id INTO v_a;
  INSERT INTO public.tires (codigo_interno, marca, medida, costo, cocada_original) VALUES ('ZZ-NEU-002', 'BRIDGESTONE', '295/80R22.5', 800, 16) RETURNING id INTO v_b;
  EXECUTE 'RESET ROLE';
  SELECT codigo_interno, estado, cocada_actual INTO w FROM public.tires WHERE id = v_a;
  IF w.codigo_interno = 'ZZ-NEU-001' AND w.estado = 'ALMACEN' AND w.cocada_actual = 16
     AND EXISTS (SELECT 1 FROM public.tire_movements WHERE tire_id = v_a AND tipo_movimiento = 'COMPRA' AND cost = 1000) THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T1 alta: ' || row_to_json(w)::text); END IF;

  -- T2: instalación con posición única por unidad
  r := public.register_tire_event(v_a, 'INSTALACION', 'ZZF8A1', 'di', NULL, 16);
  v_err := public.register_tire_event(v_b, 'INSTALACION', 'ZZF8A1', 'DI')->>'error';
  SELECT estado, current_vehicle_plate, posicion_actual, installed_odometer INTO w FROM public.tires WHERE id = v_a;
  IF (r->>'success')::boolean AND w.estado = 'INSTALADO' AND w.current_vehicle_plate = 'ZZF8A1' AND w.posicion_actual = 'DI'
     AND w.installed_odometer = 100000 AND v_err LIKE '%ocupada%' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T2 instalación: ' || r::text || ' ' || COALESCE(v_err, '')); END IF;

  -- T3: estado/posición y movimientos no se alteran directamente
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_err := NULL;
  BEGIN
    UPDATE public.tires SET posicion_actual = 'TI' WHERE id = v_a;
  EXCEPTION WHEN insufficient_privilege THEN v_err := 'upd';
  END;
  BEGIN
    INSERT INTO public.tire_movements (tire_id, tipo_movimiento) VALUES (v_a, 'MEDICION');
  EXCEPTION WHEN insufficient_privilege THEN v_err := v_err || '/ins';
  END;
  EXECUTE 'RESET ROLE';
  IF v_err = 'upd/ins' THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 guard: ' || COALESCE(v_err, 'ninguno')); END IF;

  -- T4: rotación acumula km por odómetro real
  r := public.register_tire_event(v_a, 'ROTACION', NULL, 'DD', 105000, 14);
  SELECT total_km_travelled, installed_odometer, posicion_actual INTO w FROM public.tires WHERE id = v_a;
  IF (r->>'km_accumulated')::numeric = 5000 AND w.total_km_travelled = 5000 AND w.installed_odometer = 105000 AND w.posicion_actual = 'DD'
     AND EXISTS (SELECT 1 FROM public.tire_movements WHERE tire_id = v_a AND tipo_movimiento = 'ROTACION' AND position_from = 'DI' AND posicion = 'DD')
     AND (SELECT current_odometer FROM public.vehicles WHERE plate = 'ZZF8A1') = 105000 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T4 rotación: ' || r::text || ' ' || row_to_json(w)::text); END IF;

  -- T5: medición bajo el mínimo ⇒ falla en el backlog y estado CAMBIAR
  r := public.register_tire_event(v_a, 'MEDICION', NULL, NULL, NULL, 1.5);
  IF (r->>'tread_alert')::boolean AND (SELECT tread_status FROM public.vw_tires WHERE id = v_a) = 'CAMBIAR'
     AND EXISTS (SELECT 1 FROM public.maintenance_requests WHERE vehicle_plate = 'ZZF8A1' AND description LIKE 'Neumático ZZ-NEU-001%' AND severity = 'ALTA') THEN
    v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T5 medición: ' || r::text); END IF;

  -- T6: desmontaje suma los km desde la rotación
  r := public.register_tire_event(v_a, 'DESMONTAJE', NULL, NULL, 108000);
  SELECT estado, total_km_travelled, current_vehicle_plate INTO w FROM public.tires WHERE id = v_a;
  IF (r->>'km_accumulated')::numeric = 3000 AND w.estado = 'ALMACEN' AND w.total_km_travelled = 8000 AND w.current_vehicle_plate IS NULL THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T6 desmontaje: ' || r::text || ' ' || row_to_json(w)::text); END IF;

  -- T7: reencauche con costo ⇒ costo total y costo/km
  PERFORM public.register_tire_event(v_a, 'ENVIO_REENCAUCHE');
  v_err := (SELECT estado FROM public.tires WHERE id = v_a);
  r := public.register_tire_event(v_a, 'RETORNO_REENCAUCHE', NULL, NULL, NULL, 14, 300, 'Reencauche nivel 1');
  SELECT * INTO w FROM public.vw_tires WHERE id = v_a;
  IF v_err = 'REENCAUCHE' AND (r->>'success')::boolean AND w.estado = 'ALMACEN' AND w.retread_count = 1 AND w.cost_total = 1300
     AND w.cost_per_km = 0.1625 AND w.cocada_actual = 14 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T7 reencauche: ' || r::text || ' ' || row_to_json(w)::text); END IF;

  -- T8: máximo de reencauches
  UPDATE public.tires SET max_retreads = 1 WHERE id = v_a;
  r := public.register_tire_event(v_a, 'ENVIO_REENCAUCHE');
  IF NOT (r->>'success')::boolean AND r->>'error' LIKE '%máximo%' THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T8 máximo reencauches: ' || r::text); END IF;

  -- T9: baja exige motivo y cierra el ciclo
  v_err := public.register_tire_event(v_a, 'BAJA')->>'error';
  r := public.register_tire_event(v_a, 'BAJA', NULL, NULL, NULL, NULL, NULL, 'Desgaste irregular');
  IF v_err LIKE '%motivo%' AND (r->>'success')::boolean AND (SELECT estado FROM public.tires WHERE id = v_a) = 'BAJA'
     AND NOT (public.register_tire_event(v_a, 'INSTALACION', 'ZZF8A1', 'TI')->>'success')::boolean THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T9 baja: ' || r::text); END IF;

  -- T10: km en curso de un neumático instalado; lectura menor rechazada
  PERFORM public.register_tire_event(v_b, 'INSTALACION', 'ZZF8A1', 'DI', 108000, 16);
  PERFORM public.register_asset_reading('ZZF8A1', 110000);
  v_err := public.register_tire_event(v_b, 'MEDICION', NULL, NULL, 90000, 15)->>'error';
  IF (SELECT km_total FROM public.vw_tires WHERE id = v_b) = 2000 AND v_err LIKE '%menor%' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T10 km en curso: ' || COALESCE(v_err, '')); END IF;

  -- T11: historial completo desde la compra hasta la baja
  SELECT count(*) INTO v_n FROM public.vw_tire_history WHERE tire_id = v_a;
  IF v_n = 8 AND (SELECT string_agg(tipo_movimiento, ',' ORDER BY created_at, tipo_movimiento) FROM public.vw_tire_history WHERE tire_id = v_a) LIKE 'COMPRA,%' THEN
    v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T11 historial: ' || v_n); END IF;

  -- T12: Flota 360 muestra los neumáticos montados
  r := public.get_fleet_360_view('ZZF8A1');
  IF jsonb_array_length(r->'tires') = 1 AND r->'tires'->0->>'posicion_actual' = 'DI' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T12 Flota 360: ' || (r->'tires')::text); END IF;

  -- T13: sin permisos no registra eventos ni ve neumáticos
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_nobody, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_nobody::text, true);
  r := public.register_tire_event(v_b, 'DESMONTAJE');
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_n FROM public.tires;
  EXECUTE 'RESET ROLE';
  IF NOT (r->>'success')::boolean AND v_n = 0 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T13 permisos: ' || r::text || ' ve ' || v_n); END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION 'F8 FAIL (% ok, % fallas): %', v_pass, array_length(v_fail, 1), array_to_string(v_fail, ' || ');
  END IF;
  RAISE EXCEPTION 'F8 PASS (% pruebas)', v_pass;
END
$test$;

ROLLBACK;
