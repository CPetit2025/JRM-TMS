-- Pruebas FASE 4 — Gestor de Órdenes de Trabajo.
-- Termina siempre en error para forzar ROLLBACK: "F4 PASS (...)" o "F4 FAIL: ...".
--   npx supabase db query --linked -f supabase/tests/f4_ordenes_trabajo.test.sql
BEGIN;

DO $test$
DECLARE
  v_admin   uuid;
  v_nobody  uuid := gen_random_uuid();
  v_carrier uuid;
  v_site    uuid;
  v_veh     uuid;
  v_part    uuid;
  v_wo      uuid;
  v_wo2     uuid;
  v_req     uuid;
  v_disp    uuid;
  v_fail    text[] := '{}';
  v_pass    int := 0;
  r         jsonb;
  v_err     text;
  v_n       int;
  v_num     numeric;
  v_status  text;
  w         record;
BEGIN
  SELECT carrier_id, site_id INTO v_carrier, v_site FROM public.vehicles LIMIT 1;
  FOR v_admin IN SELECT id FROM public.profiles LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXIT WHEN public.is_tms_admin();
    v_admin := NULL;
  END LOOP;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'F4 FAIL: no hay administrador'; END IF;

  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, brand, status, soat_expiration, technical_review_expiration, current_odometer)
  VALUES ('ZZF4A1', v_carrier, v_site, 'CAMION', 'TEST', 'DISPONIBLE', CURRENT_DATE + 365, CURRENT_DATE + 365, 5000)
  RETURNING id INTO v_veh;
  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, brand, status, soat_expiration, technical_review_expiration, current_odometer)
  VALUES ('ZZF4B1', v_carrier, v_site, 'CAMION', 'TEST', 'DISPONIBLE', CURRENT_DATE - 1, CURRENT_DATE + 365, 5000),
         ('ZZF4C1', v_carrier, v_site, 'CAMION', 'TEST', 'EN_OPERACION', CURRENT_DATE - 1, CURRENT_DATE + 365, 5000);
  INSERT INTO public.spare_parts (internal_code, name, site_id, current_stock, average_price_pen, unit_price)
  VALUES ('ZZ-FILTRO', 'Filtro de aceite', v_site, 10, 50, 55) RETURNING id INTO v_part;

  -- T1: alta desde cliente entra BORRADOR aunque pida otro estado
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.maintenance_work_orders (ot_code, vehicle_id, description, status, order_type, priority, site_id)
  VALUES ('ZZ-OT-1', v_veh, 'Cambio de aceite y filtros', 'CERRADA', 'PREVENTIVA', 'NORMAL', v_site) RETURNING id INTO v_wo;
  EXECUTE 'RESET ROLE';
  IF (SELECT status FROM public.maintenance_work_orders WHERE id = v_wo) = 'BORRADOR' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || text 'T1 alta cliente no quedó BORRADOR'; END IF;

  -- T2: transición inválida y cambio directo de estado rechazados
  r := public.transition_work_order(v_wo, 'EN_PROCESO');
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_err := NULL;
  BEGIN
    UPDATE public.maintenance_work_orders SET status = 'APROBADA' WHERE id = v_wo;
  EXCEPTION WHEN insufficient_privilege THEN v_err := SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  IF NOT (r->>'success')::boolean AND v_err IS NOT NULL THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T2 transición inválida/directa: ' || r::text); END IF;

  -- T3: aprobación registra quién y cuándo
  r := public.transition_work_order(v_wo, 'APROBADA');
  IF (r->>'success')::boolean AND EXISTS (SELECT 1 FROM public.maintenance_work_orders WHERE id = v_wo AND approved_by = v_admin AND approved_at IS NOT NULL)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 aprobación: ' || r::text); END IF;

  -- T4: inicio ⇒ unidad en MANTENIMIENTO e inicio de indisponibilidad
  r := public.transition_work_order(v_wo, 'EN_PROCESO');
  IF (r->>'success')::boolean AND (SELECT status FROM public.vehicles WHERE id = v_veh) = 'MANTENIMIENTO'
     AND (SELECT downtime_start FROM public.maintenance_work_orders WHERE id = v_wo) IS NOT NULL THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T4 inicio: ' || r::text); END IF;

  -- T5: costos de mano de obra y servicios (cliente) ⇒ totales derivados
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.work_order_costs (work_order_id, cost_type, amount, description) VALUES (v_wo, 'MANO_OBRA', 100, 'Técnico 2h');
  INSERT INTO public.work_order_costs (work_order_id, cost_type, amount, description) VALUES (v_wo, 'SERVICIOS', 50, 'Lavado de motor');
  -- T6: repuestos directos rechazados
  v_err := NULL;
  BEGIN
    INSERT INTO public.work_order_costs (work_order_id, cost_type, amount) VALUES (v_wo, 'REPUESTOS', 10);
  EXCEPTION WHEN insufficient_privilege THEN v_err := SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  SELECT labor_cost, services_cost, total_cost INTO w FROM public.maintenance_work_orders WHERE id = v_wo;
  IF w.labor_cost = 100 AND w.services_cost = 50 AND w.total_cost = 150 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T5 totales: ' || row_to_json(w)::text); END IF;
  IF v_err IS NOT NULL THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || text 'T6 repuesto directo aceptado'; END IF;

  -- T7: consumo de repuesto: stock, kardex, costo y línea de consumo (una sola vez)
  r := public.consume_work_order_part(v_wo, v_part, 3, 'cambio');
  SELECT count(*) INTO v_n FROM public.inventory_transactions WHERE work_order_reference = v_wo AND type = 'SALIDA' AND quantity = 3;
  IF (r->>'success')::boolean AND (SELECT current_stock FROM public.spare_parts WHERE id = v_part) = 7 AND v_n = 1
     AND (SELECT parts_cost FROM public.maintenance_work_orders WHERE id = v_wo) = 150
     AND (SELECT total_cost FROM public.maintenance_work_orders WHERE id = v_wo) = 300
     AND EXISTS (SELECT 1 FROM public.work_order_spare_parts WHERE work_order_id = v_wo AND quantity = 3) THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T7 consumo: ' || r::text); END IF;

  -- T8: sin stock negativo
  r := public.consume_work_order_part(v_wo, v_part, 100);
  IF NOT (r->>'success')::boolean AND (SELECT current_stock FROM public.spare_parts WHERE id = v_part) = 7 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T8 stock negativo: ' || r::text); END IF;

  -- T9: movimientos inmutables
  v_err := NULL;
  BEGIN
    UPDATE public.inventory_transactions SET quantity = 1 WHERE work_order_reference = v_wo;
  EXCEPTION WHEN insufficient_privilege THEN v_err := SQLERRM;
  END;
  IF v_err IS NOT NULL THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || text 'T9 movimiento editable'; END IF;

  -- T10: cierre exige TERMINADA/VALIDACION; TERMINADA exige actividades
  IF NOT (public.complete_maintenance_order(v_wo, '[]'::jsonb, 'x')->>'success')::boolean
     AND NOT (public.transition_work_order(v_wo, 'TERMINADA')->>'success')::boolean
     AND (public.transition_work_order(v_wo, 'TERMINADA', 'Cambio de aceite y filtro realizado')->>'success')::boolean
     AND (public.transition_work_order(v_wo, 'VALIDACION', 'Prueba de ruta OK')->>'success')::boolean THEN
    v_pass := v_pass + 1;
  ELSE v_fail := v_fail || text 'T10 requisitos de cierre'; END IF;

  -- T11: cierre ⇒ CERRADA, tiempos, liberación por motor (APTO_CON_OBSERVACION libera)
  r := public.complete_maintenance_order(v_wo, jsonb_build_array(jsonb_build_object('part_id', v_part, 'quantity', 1)), 'OK');
  SELECT status, closed_at, downtime_end, downtime_hours, total_cost INTO w FROM public.maintenance_work_orders WHERE id = v_wo;
  IF (r->>'success')::boolean AND w.status = 'CERRADA' AND w.closed_at IS NOT NULL AND w.downtime_end IS NOT NULL
     AND w.downtime_hours >= 0 AND w.total_cost = 350
     AND (SELECT status FROM public.vehicles WHERE id = v_veh) = 'DISPONIBLE' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T11 cierre: ' || r::text || ' ' || row_to_json(w)::text); END IF;

  -- T12: OT cerrada es inmutable (costos y datos)
  v_err := NULL;
  BEGIN
    INSERT INTO public.work_order_costs (work_order_id, cost_type, amount) VALUES (v_wo, 'OTROS', 1);
  EXCEPTION WHEN insufficient_privilege THEN v_err := SQLERRM;
  END;
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    UPDATE public.maintenance_work_orders SET description = 'cambio' WHERE id = v_wo;
    IF v_err IS NOT NULL THEN v_err := v_err || ' / update aceptado'; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  EXECUTE 'RESET ROLE';
  IF v_err IS NOT NULL AND v_err NOT LIKE '%update aceptado' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T12 OT cerrada mutable: ' || COALESCE(v_err, 'costo aceptado')); END IF;

  -- T13: falla crítica ⇒ OT; indisponibilidad desde el reporte; cierre con SOAT vencido NO libera
  INSERT INTO public.maintenance_requests (vehicle_plate, description, severity, status, reported_at)
  VALUES ('ZZF4B1', 'Fuga de aire en frenos', 'CRITICA', 'REPORTADA', now() - interval '5 hours') RETURNING id INTO v_req;
  v_wo2 := public.convert_request_to_wo(v_req, v_admin);
  PERFORM public.transition_work_order(v_wo2, 'APROBADA');
  PERFORM public.transition_work_order(v_wo2, 'EN_PROCESO');
  SELECT downtime_start INTO w FROM public.maintenance_work_orders WHERE id = v_wo2;
  PERFORM public.transition_work_order(v_wo2, 'TERMINADA', 'Cambio de manguera');
  r := public.complete_maintenance_order(v_wo2, '[]'::jsonb, NULL);
  IF w.downtime_start <= now() - interval '4 hours'
     AND (SELECT status FROM public.maintenance_requests WHERE id = v_req) = 'CERRADA'
     AND (SELECT status FROM public.vehicles WHERE plate = 'ZZF4B1') = 'MANTENIMIENTO'
     AND r->'eligibility'->>'status' = 'NO_APTO'
     AND (SELECT downtime_hours FROM public.maintenance_work_orders WHERE id = v_wo2) >= 5 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T13 falla crítica → OT: ' || r::text); END IF;

  -- T14: cancelación exige motivo
  INSERT INTO public.maintenance_work_orders (ot_code, vehicle_id, description, order_type, site_id)
  VALUES ('ZZ-OT-3', v_veh, 'Inspección', 'INSPECCION', v_site) RETURNING id INTO v_wo2;
  IF NOT (public.transition_work_order(v_wo2, 'CANCELADA')->>'success')::boolean
     AND (public.transition_work_order(v_wo2, 'CANCELADA', 'Duplicada')->>'success')::boolean THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || text 'T14 cancelación'; END IF;

  -- T15: cierre de despacho con unidad NO_APTO ⇒ OBSERVADA (antes quedaba EN_OPERACION)
  INSERT INTO public.dispatches (dispatch_number, vehicle_plate, status, site_id)
  VALUES ('ZZ-F4-DSP', 'ZZF4C1', 'ENTREGADO', v_site) RETURNING id INTO v_disp;
  r := public.transition_dispatch_status(v_disp, 'CERRADO', 'fin', v_admin);
  IF (r->>'success')::boolean AND (SELECT status FROM public.vehicles WHERE plate = 'ZZF4C1') = 'OBSERVADA' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T15 cierre despacho: ' || r::text || ' estado=' || (SELECT status FROM public.vehicles WHERE plate = 'ZZF4C1')); END IF;

  -- T16: vista del gestor
  SELECT count(*) INTO v_n FROM public.vw_work_orders WHERE id = v_wo AND vehicle_plate = 'ZZF4A1' AND total_cost = 350 AND downtime_hours IS NOT NULL;
  IF v_n = 1 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || text 'T16 vista'; END IF;

  -- T17: sin permisos: no transiciona, no consume, no ve costos ni kardex, no inserta movimientos
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_nobody, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_nobody::text, true);
  r := public.transition_work_order(v_wo2, 'APROBADA');
  IF NOT (r->>'success')::boolean AND NOT (public.consume_work_order_part(v_wo, v_part, 1)->>'success')::boolean THEN
    EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT (SELECT count(*) FROM public.work_order_costs) + (SELECT count(*) FROM public.inventory_transactions) INTO v_n;
    v_err := NULL;
    BEGIN
      INSERT INTO public.inventory_transactions (spare_part_id, type, quantity) VALUES (v_part, 'INGRESO', 1000);
    EXCEPTION WHEN insufficient_privilege THEN v_err := SQLERRM;
    END;
    EXECUTE 'RESET ROLE';
    IF v_n = 0 AND v_err IS NOT NULL THEN v_pass := v_pass + 1;
    ELSE v_fail := v_fail || ('T17 RLS: ve ' || v_n || ' err=' || COALESCE(v_err, 'ninguno')); END IF;
  ELSE v_fail := v_fail || text 'T17 sin permisos opera OT'; END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION 'F4 FAIL (% ok, % fallas): %', v_pass, array_length(v_fail, 1), array_to_string(v_fail, ' || ');
  END IF;
  RAISE EXCEPTION 'F4 PASS (% pruebas)', v_pass;
END
$test$;

ROLLBACK;
