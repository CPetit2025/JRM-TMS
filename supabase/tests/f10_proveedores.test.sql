-- Pruebas FASE 10 — Proveedores, talleres y garantías.
-- Termina siempre en error para forzar ROLLBACK: "F10 PASS (...)" o "F10 FAIL: ...".
--   npx supabase db query --linked -f supabase/tests/f10_proveedores.test.sql
BEGIN;

DO $test$
DECLARE
  v_admin   uuid;
  v_nobody  uuid := gen_random_uuid();
  v_carrier uuid;
  v_site    uuid;
  v_veh     uuid;
  v_prov    uuid;
  v_prov2   uuid;
  v_wo      uuid;
  v_wo2     uuid;
  v_q1      uuid;
  v_q2      uuid;
  v_q3      uuid;
  v_sw      uuid;
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
  IF v_admin IS NULL THEN RAISE EXCEPTION 'F10 FAIL: no hay administrador'; END IF;

  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, brand, status, soat_expiration, technical_review_expiration, current_odometer)
  VALUES ('ZZF10A', v_carrier, v_site, 'CAMION', 'TEST', 'DISPONIBLE', CURRENT_DATE + 365, CURRENT_DATE + 365, 20000) RETURNING id INTO v_veh;

  -- T1: RUC validado y normalizado; estado sincroniza is_active
  v_err := NULL;
  BEGIN
    INSERT INTO public.maintenance_providers (ruc, business_name) VALUES ('123', 'Mal RUC');
  EXCEPTION WHEN raise_exception THEN v_err := 'ruc';
  END;
  INSERT INTO public.maintenance_providers (ruc, business_name, provider_type, sla_hours, default_warranty_days, default_warranty_km, specialty)
  VALUES ('20-12345678-9', 'Taller ZZ Frenos', 'taller', 24, 30, 5000, 'Frenos') RETURNING id INTO v_prov;
  INSERT INTO public.maintenance_providers (ruc, business_name, status) VALUES ('20999999991', 'Taller ZZ Inactivo', 'SUSPENDIDO') RETURNING id INTO v_prov2;
  SELECT ruc, provider_type, is_active INTO w FROM public.maintenance_providers WHERE id = v_prov;
  IF v_err = 'ruc' AND w.ruc = '20123456789' AND w.provider_type = 'TALLER' AND w.is_active
     AND NOT (SELECT is_active FROM public.maintenance_providers WHERE id = v_prov2) THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T1 proveedor: ' || row_to_json(w)::text); END IF;

  -- T2: tarifario
  INSERT INTO public.provider_rates (provider_id, service_name, unit, price) VALUES (v_prov, 'Cambio de pastillas', 'EJE', 350);
  IF EXISTS (SELECT 1 FROM public.provider_rates WHERE provider_id = v_prov AND price = 350) THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || text 'T2 tarifario'; END IF;

  -- T3: cotizaciones: aprobar una asigna el proveedor y rechaza las demás; vencidas o de proveedor inactivo no se aprueban
  INSERT INTO public.maintenance_work_orders (ot_code, vehicle_id, description, order_type, site_id) VALUES ('ZZ-F10-1', v_veh, 'Cambio de pastillas', 'CORRECTIVA', v_site) RETURNING id INTO v_wo;
  INSERT INTO public.service_quotes (work_order_id, provider_id, amount, valid_until) VALUES (v_wo, v_prov, 700, CURRENT_DATE + 10) RETURNING id INTO v_q1;
  INSERT INTO public.service_quotes (work_order_id, provider_id, amount) VALUES (v_wo, v_prov2, 650) RETURNING id INTO v_q2;
  INSERT INTO public.service_quotes (work_order_id, provider_id, amount, valid_until) VALUES (v_wo, v_prov, 600, (now() AT TIME ZONE 'America/Lima')::date - 2) RETURNING id INTO v_q3;
  v_err := (public.decide_service_quote(v_q2, 'APROBADA')->>'error') || ' | ' || (public.decide_service_quote(v_q3, 'APROBADA')->>'error');
  r := public.decide_service_quote(v_q1, 'APROBADA', 'Mejor plazo');
  IF (r->>'success')::boolean AND v_err LIKE '%no está activo%venció%'
     AND (SELECT provider_id FROM public.maintenance_work_orders WHERE id = v_wo) = v_prov
     AND (SELECT status FROM public.service_quotes WHERE id = v_q2) = 'RECHAZADA'
     AND NOT (public.decide_service_quote(v_q1, 'RECHAZADA')->>'success')::boolean THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T3 cotizaciones: ' || r::text || ' ' || COALESCE(v_err, '')); END IF;

  -- T4: flujo con proveedor: sin garantías aprueba; retrabajo cuenta; cierre crea garantía de servicio
  PERFORM public.transition_work_order(v_wo, 'APROBADA');
  PERFORM public.transition_work_order(v_wo, 'EN_PROCESO');
  PERFORM public.transition_work_order(v_wo, 'TERMINADA', 'Pastillas cambiadas');
  PERFORM public.transition_work_order(v_wo, 'EN_PROCESO', 'Ruido persiste');
  PERFORM public.transition_work_order(v_wo, 'TERMINADA', 'Discos rectificados');
  INSERT INTO public.work_order_costs (work_order_id, cost_type, amount, provider_id) VALUES (v_wo, 'SERVICIOS', 700, v_prov);
  r := public.complete_maintenance_order(v_wo, '[]'::jsonb, 'ok');
  SELECT warranty_decision, rework_count, finished_at INTO w FROM public.maintenance_work_orders WHERE id = v_wo;
  SELECT id INTO v_sw FROM public.service_warranties WHERE work_order_id = v_wo AND km_limit = 5000 AND odometer_at_close = 20000
    AND expires_at = (now() AT TIME ZONE 'America/Lima')::date + 30;
  IF (r->>'success')::boolean AND w.warranty_decision = 'SIN_GARANTIAS' AND w.rework_count = 1 AND w.finished_at IS NOT NULL AND v_sw IS NOT NULL THEN
    v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T4 flujo proveedor: ' || r::text || ' ' || row_to_json(w)::text); END IF;

  -- T5: evaluación única y en rango
  r := public.evaluate_provider_work(v_wo, 4, 'Buen trabajo');
  IF (r->>'success')::boolean AND NOT (public.evaluate_provider_work(v_wo, 5)->>'success')::boolean THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T5 evaluación: ' || r::text); END IF;

  -- T6: regla "¿existe garantía activa?" antes de autorizar el gasto
  INSERT INTO public.maintenance_work_orders (ot_code, vehicle_id, description, order_type, site_id) VALUES ('ZZ-F10-2', v_veh, 'Ruido en frenos', 'CORRECTIVA', v_site) RETURNING id INTO v_wo2;
  v_err := NULL;
  BEGIN
    PERFORM public.transition_work_order(v_wo2, 'APROBADA');
  EXCEPTION WHEN raise_exception THEN v_err := SQLERRM;
  END;
  r := public.review_work_order_warranty(v_wo2, 'RECLAMO_GARANTIA', '');   -- sin sustento
  v_n := CASE WHEN (public.review_work_order_warranty(v_wo2, 'RECLAMO_GARANTIA', 'Mismo ruido a los 5 días', 'SERVICIO', v_sw)->>'success')::boolean THEN 1 ELSE 0 END;
  v_n := v_n + CASE WHEN (public.transition_work_order(v_wo2, 'APROBADA')->>'success')::boolean THEN 1 ELSE 0 END;
  IF v_err LIKE 'GARANTIA_ACTIVA%Taller ZZ Frenos%' AND NOT (r->>'success')::boolean AND v_n = 2
     AND (SELECT status FROM public.service_warranties WHERE id = v_sw) = 'RECLAMADA'
     AND (SELECT warranty_provider_id FROM public.maintenance_work_orders WHERE id = v_wo2) = v_prov THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T6 regla de garantía: ' || COALESCE(v_err, 'sin bloqueo') || ' ' || r::text); END IF;

  -- T7: KPI calculados: SLA, retrabajos, reclamos, calificación, gasto e índice de calidad
  SELECT * INTO w FROM public.vw_provider_performance WHERE provider_id = v_prov;
  IF w.closed_work_orders = 1 AND w.reworks = 1 AND w.warranty_claims = 1 AND w.avg_score = 4 AND w.total_spend = 700
     AND w.sla_compliance_pct = 100 AND w.rework_rate_pct = 200 AND w.quality_index = 64 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T7 KPI: ' || row_to_json(w)::text); END IF;

  -- T8: sin permisos no ve proveedores ni cotizaciones ni decide
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_nobody, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_nobody::text, true);
  r := public.decide_service_quote(v_q3, 'RECHAZADA');
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT (SELECT count(*) FROM public.maintenance_providers) + (SELECT count(*) FROM public.service_quotes) + (SELECT count(*) FROM public.service_warranties) INTO v_n;
  EXECUTE 'RESET ROLE';
  IF v_n = 0 AND NOT (r->>'success')::boolean THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T8 permisos: ve ' || v_n); END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION 'F10 FAIL (% ok, % fallas): %', v_pass, array_length(v_fail, 1), array_to_string(v_fail, ' || ');
  END IF;
  RAISE EXCEPTION 'F10 PASS (% pruebas)', v_pass;
END
$test$;

ROLLBACK;
