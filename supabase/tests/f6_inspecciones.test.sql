-- Pruebas FASE 6 — Inspecciones y checklist.
-- Termina siempre en error para forzar ROLLBACK: "F6 PASS (...)" o "F6 FAIL: ...".
--   npx supabase db query --linked -f supabase/tests/f6_inspecciones.test.sql
BEGIN;

DO $test$
DECLARE
  v_admin   uuid;
  v_nobody  uuid := gen_random_uuid();
  v_driver  uuid;
  v_carrier uuid;
  v_site    uuid;
  v_tpl     uuid;
  v_frenos  uuid;
  v_limp    uuid;
  v_disp    uuid;
  v_req     uuid;
  v_wo      uuid;
  v_fail    text[] := '{}';
  v_pass    int := 0;
  r         jsonb;
  v_err     text;
  v_n       int;
  v_ok      jsonb;
BEGIN
  SELECT carrier_id, site_id INTO v_carrier, v_site FROM public.vehicles LIMIT 1;
  FOR v_admin IN SELECT id FROM public.profiles LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXIT WHEN public.is_tms_admin();
    v_admin := NULL;
  END LOOP;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'F6 FAIL: no hay administrador'; END IF;
  SELECT id INTO v_driver FROM public.drivers LIMIT 1;

  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, brand, status, soat_expiration, technical_review_expiration, current_odometer)
  VALUES ('ZZF6A1', v_carrier, v_site, 'CAMION', 'TEST', 'DISPONIBLE', CURRENT_DATE + 365, CURRENT_DATE + 365, 1000),
         ('ZZF6B1', v_carrier, v_site, 'CAMION', 'TEST', 'DISPONIBLE', CURRENT_DATE + 365, CURRENT_DATE + 365, 5000);
  INSERT INTO public.vehicles (plate, internal_code, carrier_id, site_id, type, status, current_hours)
  VALUES ('ZZF6M1', 'ZZF6M1', v_carrier, v_site, 'MONTACARGAS', 'DISPONIBLE', 100);

  INSERT INTO public.checklist_templates (name, type, asset_types, requires_signature)
  VALUES ('Periódica camión', 'PERIODICA', ARRAY['CAMION'], true) RETURNING id INTO v_tpl;
  INSERT INTO public.checklist_items (template_id, text, is_critical, response_type, requires_photo, position)
  VALUES (v_tpl, 'Frenos', true, 'OK_MAL', true, 1) RETURNING id INTO v_frenos;
  INSERT INTO public.checklist_items (template_id, text, is_critical, response_type, position)
  VALUES (v_tpl, 'Limpieza de cabina', false, 'OK_MAL', 2) RETURNING id INTO v_limp;
  v_ok := jsonb_build_array(jsonb_build_object('item_id', v_frenos, 'response', 'OK', 'photo_url', 'https://x/f.jpg'),
                            jsonb_build_object('item_id', v_limp, 'response', 'OK'));

  -- T1: todas las preguntas deben responderse
  r := public.submit_inspection('ZZF6A1', v_tpl, jsonb_build_array(jsonb_build_object('item_id', v_frenos, 'response', 'OK', 'photo_url', 'x')), 1100, NULL, 'sig');
  IF NOT (r->>'success')::boolean AND r->>'error' LIKE '%Limpieza%' THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 faltantes: ' || r::text); END IF;

  -- T2: evidencia obligatoria; T3: firma obligatoria
  r := public.submit_inspection('ZZF6A1', v_tpl, jsonb_build_array(jsonb_build_object('item_id', v_frenos, 'response', 'OK'), jsonb_build_object('item_id', v_limp, 'response', 'OK')), 1100, NULL, 'sig');
  v_err := r->>'error';
  r := public.submit_inspection('ZZF6A1', v_tpl, v_ok, 1100, NULL, NULL);
  IF v_err LIKE '%(foto)%' AND r->>'error' LIKE '%firma%' THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2/T3 foto/firma: ' || COALESCE(v_err, '') || ' ' || r::text); END IF;

  -- T4: plantilla por tipo de activo; T5: lectura menor rechazada
  r := public.submit_inspection('ZZF6M1', v_tpl, v_ok, NULL, 120, 'sig');
  v_err := r->>'error';
  r := public.submit_inspection('ZZF6A1', v_tpl, v_ok, 900, NULL, 'sig');
  IF v_err LIKE '%no aplica a MONTACARGAS%' AND r->>'error' LIKE '%menor%' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T4/T5 tipo/lectura: ' || COALESCE(v_err, '') || ' ' || r::text); END IF;

  -- T6: inspección aprobada registra lectura y firma
  r := public.submit_inspection('ZZF6A1', v_tpl, v_ok, 1100, NULL, 'https://x/firma.png', NULL, 'ok', '{"lat": -12.1, "lon": -77.0}');
  IF (r->>'success')::boolean AND r->>'global_result' = 'PASSED'
     AND (SELECT current_odometer FROM public.vehicles WHERE plate = 'ZZF6A1') = 1100
     AND EXISTS (SELECT 1 FROM public.inspections WHERE id = (r->>'inspection_id')::uuid AND signature_url IS NOT NULL AND inspection_type = 'PERIODICA' AND location_lat IS NOT NULL) THEN
    v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T6 aprobada: ' || r::text); END IF;

  -- T7: falla no crítica ⇒ WARNING, sin falla ni bloqueo
  r := public.submit_inspection('ZZF6A1', v_tpl, jsonb_build_array(jsonb_build_object('item_id', v_frenos, 'response', 'OK', 'photo_url', 'x'),
                                jsonb_build_object('item_id', v_limp, 'response', 'MAL')), 1100, NULL, 'sig');
  IF r->>'global_result' = 'WARNING' AND (r->>'requests_created')::int = 0 AND r->>'vehicle_status' = 'DISPONIBLE' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T7 no crítica: ' || r::text); END IF;

  -- T8: respuesta crítica ⇒ UNA falla CRITICA con evidencia ⇒ unidad BLOQUEADA
  r := public.submit_inspection('ZZF6A1', v_tpl, jsonb_build_array(jsonb_build_object('item_id', v_frenos, 'response', 'MAL', 'observation', 'Pedal esponjoso', 'photo_url', 'https://x/freno.jpg'),
                                jsonb_build_object('item_id', v_limp, 'response', 'OK')), 1150, NULL, 'sig');
  SELECT id INTO v_req FROM public.maintenance_requests WHERE vehicle_plate = 'ZZF6A1' AND source = 'INSPECCION';
  IF r->>'global_result' = 'FAILED' AND (r->>'requests_created')::int = 1 AND r->>'vehicle_status' = 'BLOQUEADA'
     AND EXISTS (SELECT 1 FROM public.maintenance_requests WHERE id = v_req AND severity = 'CRITICA' AND photo_url = 'https://x/freno.jpg' AND odometer_at_report = 1150) THEN
    v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T8 crítica: ' || r::text); END IF;

  -- T9: trazabilidad completa Inspección → Falla → Backlog → OT → cierre → Flota 360
  v_n := (SELECT count(*) FROM public.vw_maintenance_backlog WHERE id = v_req);
  v_wo := public.convert_request_to_wo(v_req, v_admin);
  PERFORM public.transition_work_order(v_wo, 'APROBADA');
  PERFORM public.transition_work_order(v_wo, 'EN_PROCESO');
  PERFORM public.transition_work_order(v_wo, 'TERMINADA', 'Purgado de frenos');
  r := public.complete_maintenance_order(v_wo, '[]'::jsonb, 'ok');
  v_ok := public.get_fleet_360_view('ZZF6A1');
  IF v_n = 1 AND (r->>'success')::boolean
     AND (SELECT status FROM public.maintenance_requests WHERE id = v_req) = 'CERRADA'
     AND (SELECT status FROM public.vehicles WHERE plate = 'ZZF6A1') = 'DISPONIBLE'
     AND jsonb_array_length(v_ok->'inspections') = 3 AND jsonb_array_length(v_ok->'work_orders') = 1
     AND jsonb_array_length(v_ok->'requests_history') = 1 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T9 trazabilidad: ' || r::text); END IF;

  -- Evidencia fotográfica en storage (requisito de validate_driver_checklist) y GPS dentro de geocerca
  INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('driver_evidence', v_admin || '/f6/check.jpg', v_admin);

  -- T10/T11: el formato legado no sustituye FR-DT 007 ni inicia rutas.
  -- El registro diario completo y las fallas críticas de la App se verifican en Caja C49.
  INSERT INTO public.dispatches (dispatch_number, vehicle_plate, driver_id, status, site_id)
  VALUES ('ZZ-F6-1', 'ZZF6B1', v_driver, 'PROGRAMADO', v_site) RETURNING id INTO v_disp;
  r := public.submit_pre_route_checklist(v_disp, 'ZZF6B1', v_driver, 5100,
         jsonb_build_object('llantas', 'OK', 'aceite', 'OK', 'luces', 'OK', 'frenos', 'MAL', 'combustible', 'OK'),
         '{"lat": -11.99, "lon": -77.0}'::jsonb);
  IF NOT (r->>'success')::boolean AND r->>'message' LIKE '%FR-DT 007%'
     AND (SELECT status FROM public.dispatches WHERE id = v_disp) = 'PROGRAMADO'
     AND NOT EXISTS (SELECT 1 FROM public.driver_checklists WHERE dispatch_id = v_disp)
     AND NOT EXISTS (SELECT 1 FROM public.inspections WHERE dispatch_id = v_disp) THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T10 App formato desactualizado: ' || r::text); END IF;
  r := public.submit_pre_route_checklist(v_disp, 'ZZF6B1', v_driver, 5100,
         jsonb_build_object('llantas', 'OK', 'aceite', 'OK', 'luces', 'OK', 'frenos', 'OK', 'combustible', 'OK'),
         '{"lat": -11.99, "lon": -77.0}'::jsonb);
  IF NOT (r->>'success')::boolean AND (SELECT status FROM public.dispatches WHERE id = v_disp) = 'PROGRAMADO'
     AND (SELECT start_odometer FROM public.dispatches WHERE id = v_disp) IS NULL THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T11 formato legado inició ruta: ' || r::text); END IF;

  -- T12: RLS y permisos (sin inserción directa; plantilla del sistema protegida; sin permiso no inspecciona ni ve)
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_err := NULL;
  BEGIN
    INSERT INTO public.inspections (vehicle_plate, template_id, global_result) VALUES ('ZZF6A1', v_tpl, 'PASSED');
  EXCEPTION WHEN insufficient_privilege THEN v_err := 'insert';
  END;
  UPDATE public.checklist_templates SET name = 'x' WHERE code = 'APP_PRE_RUTA';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_nobody, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_nobody::text, true);
  r := public.submit_inspection('ZZF6A1', v_tpl, v_ok, 1300, NULL, 'sig');
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT v_n * 1000 + count(*) INTO v_n FROM public.inspections;
  EXECUTE 'RESET ROLE';
  IF v_err = 'insert' AND v_n = 0 AND NOT (r->>'success')::boolean THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T12 RLS/permisos: err=' || COALESCE(v_err, 'ninguno') || ' n=' || v_n || ' ' || r::text); END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION 'F6 FAIL (% ok, % fallas): %', v_pass, array_length(v_fail, 1), array_to_string(v_fail, ' || ');
  END IF;
  RAISE EXCEPTION 'F6 PASS (% pruebas)', v_pass;
END
$test$;

ROLLBACK;
