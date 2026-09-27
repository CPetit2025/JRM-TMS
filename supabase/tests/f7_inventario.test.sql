-- Pruebas FASE 7 — Repuestos e inventario.
-- Termina siempre en error para forzar ROLLBACK: "F7 PASS (...)" o "F7 FAIL: ...".
--   npx supabase db query --linked -f supabase/tests/f7_inventario.test.sql
BEGIN;

DO $test$
DECLARE
  v_admin   uuid;
  v_nobody  uuid := gen_random_uuid();
  v_carrier uuid;
  v_site    uuid;
  v_veh     uuid;
  v_part    uuid;
  v_part2   uuid;
  v_wo1     uuid;
  v_wo2     uuid;
  v_wo3     uuid;
  v_plan    uuid;
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
  IF v_admin IS NULL THEN RAISE EXCEPTION 'F7 FAIL: no hay administrador'; END IF;

  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, brand, status, soat_expiration, technical_review_expiration, current_odometer)
  VALUES ('ZZF7A1', v_carrier, v_site, 'CAMION', 'TEST', 'DISPONIBLE', CURRENT_DATE + 365, CURRENT_DATE + 365, 50000) RETURNING id INTO v_veh;
  INSERT INTO public.maintenance_work_orders (ot_code, vehicle_id, description, order_type, site_id) VALUES ('ZZ-F7-1', v_veh, 'a', 'CORRECTIVA', v_site) RETURNING id INTO v_wo1;
  INSERT INTO public.maintenance_work_orders (ot_code, vehicle_id, description, order_type, site_id) VALUES ('ZZ-F7-2', v_veh, 'b', 'CORRECTIVA', v_site) RETURNING id INTO v_wo2;
  PERFORM public.transition_work_order(v_wo1, 'APROBADA');
  PERFORM public.transition_work_order(v_wo2, 'APROBADA');

  -- T1: alta de catálogo desde cliente: stock/costo arrancan en cero y no se editan directamente
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.spare_parts (internal_code, name, site_id, current_stock, average_price_pen, minimum_stock, maximum_stock, unit, warranty_months, warranty_km, warranty_conditions)
  VALUES (' zz-flt-01 ', 'Filtro de aire', v_site, 100, 999, 5, 20, 'UNIDAD', 6, 10000, 'Defecto de fabricación') RETURNING id INTO v_part;
  v_err := NULL;
  BEGIN
    UPDATE public.spare_parts SET current_stock = 50 WHERE id = v_part;
  EXCEPTION WHEN insufficient_privilege THEN v_err := SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  SELECT internal_code, current_stock, average_price_pen INTO w FROM public.spare_parts WHERE id = v_part;
  IF w.internal_code = 'ZZ-FLT-01' AND w.current_stock = 0 AND w.average_price_pen = 0 AND v_err IS NOT NULL THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T1 catálogo: ' || row_to_json(w)::text || ' ' || COALESCE(v_err, 'update aceptado')); END IF;

  -- T2: ingresos con costo promedio ponderado y saldo en el kardex
  PERFORM public.register_inventory_movement(v_part, 'INGRESO', 10, 50, 'F001-1', NULL, NULL);
  r := public.register_inventory_movement(v_part, 'INGRESO', 10, 80, 'F001-2', NULL, NULL);
  SELECT current_stock, average_price_pen, unit_price INTO w FROM public.spare_parts WHERE id = v_part;
  IF w.current_stock = 20 AND w.average_price_pen = 65 AND w.unit_price = 80 AND (r->>'balance_after')::numeric = 20 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T2 costo promedio: ' || row_to_json(w)::text); END IF;

  -- T3: validaciones (ingreso sin costo, ajuste sin motivo, salida fuera de OT)
  IF NOT (public.register_inventory_movement(v_part, 'INGRESO', 1, NULL)->>'success')::boolean
     AND NOT (public.register_inventory_movement(v_part, 'AJUSTE', -1, NULL, NULL, NULL, NULL)->>'success')::boolean
     AND NOT (public.register_inventory_movement(v_part, 'SALIDA', 1)->>'success')::boolean THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || text 'T3 validaciones de movimiento'; END IF;

  -- T4: ajuste con motivo mueve stock sin alterar el costo promedio
  r := public.register_inventory_movement(v_part, 'AJUSTE', -2, NULL, NULL, NULL, 'Conteo físico');
  SELECT current_stock, average_price_pen INTO w FROM public.spare_parts WHERE id = v_part;
  IF (r->>'success')::boolean AND w.current_stock = 18 AND w.average_price_pen = 65 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T4 ajuste: ' || r::text); END IF;

  -- T5: reservas: lo reservado por otra OT no se consume
  r := public.reserve_work_order_part(v_wo1, v_part, 15);
  v_err := (public.consume_work_order_part(v_wo2, v_part, 5)->>'success') || '/' || (public.consume_work_order_part(v_wo2, v_part, 3)->>'success');
  IF (r->>'success')::boolean AND (r->>'available_after')::numeric = 3 AND v_err = 'false/true'
     AND (SELECT current_stock FROM public.spare_parts WHERE id = v_part) = 15 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T5 reservas: ' || r::text || ' consumos=' || COALESCE(v_err, '')); END IF;

  -- T6: consumo de la OT con reserva descuenta su reserva y costea a promedio
  r := public.consume_work_order_part(v_wo1, v_part, 10);
  SELECT quantity, consumed, status INTO w FROM public.spare_part_reservations WHERE work_order_id = v_wo1 AND spare_part_id = v_part;
  IF (r->>'success')::boolean AND (r->>'amount')::numeric = 650 AND w.consumed = 10 AND w.status = 'ACTIVA'
     AND (SELECT parts_cost FROM public.maintenance_work_orders WHERE id = v_wo1) = 650 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T6 consumo con reserva: ' || r::text || ' ' || row_to_json(w)::text); END IF;

  -- T7: disponible bajo el mínimo ⇒ UNA solicitud de reposición; se generó al reservar (disponible 3 ⇒ 20 − 3)
  SELECT * INTO w FROM public.vw_spare_parts_stock WHERE id = v_part;
  SELECT count(*) INTO v_n FROM public.spare_part_replenishment_requests WHERE spare_part_id = v_part AND status = 'PENDIENTE';
  IF w.current_stock = 5 AND w.reserved = 5 AND w.available = 0 AND w.stock_status = 'SIN_STOCK' AND v_n = 1
     AND w.replenishment_quantity = 17 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T7 reposición: ' || row_to_json(w)::text || ' n=' || v_n); END IF;

  -- T8: cerrar/cancelar la OT libera la reserva; el ingreso atiende la reposición
  PERFORM public.transition_work_order(v_wo1, 'CANCELADA', 'prueba');
  PERFORM public.register_inventory_movement(v_part, 'INGRESO', 20, 65, 'F001-3');
  SELECT * INTO w FROM public.vw_spare_parts_stock WHERE id = v_part;
  IF (SELECT status FROM public.spare_part_reservations WHERE work_order_id = v_wo1 AND spare_part_id = v_part) = 'LIBERADA'
     AND w.reserved = 0 AND w.available = 25 AND w.stock_status = 'SOBRE_MAXIMO' AND w.open_replenishment_id IS NULL
     AND EXISTS (SELECT 1 FROM public.spare_part_replenishment_requests WHERE spare_part_id = v_part AND status = 'ATENDIDA') THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T8 liberación/atención: ' || row_to_json(w)::text); END IF;

  -- T9: garantía del repuesto instalado (fecha y km)
  SELECT * INTO w FROM public.vw_part_warranties WHERE work_order_id = v_wo2 AND spare_part_id = v_part;
  IF w.warranty_status = 'VIGENTE' AND w.km_limit = 10000 AND w.odometer_at_install = 50000
     AND w.expires_at = ((now() AT TIME ZONE 'America/Lima')::date + interval '6 months')::date AND w.conditions = 'Defecto de fabricación' THEN
    PERFORM public.register_asset_reading('ZZF7A1', 60001);
    IF (SELECT warranty_status FROM public.vw_part_warranties WHERE work_order_id = v_wo2 AND spare_part_id = v_part) = 'VENCIDA' THEN v_pass := v_pass + 1;
    ELSE v_fail := v_fail || text 'T9 garantía no vence por km'; END IF;
  ELSE v_fail := v_fail || ('T9 garantía: ' || row_to_json(w)::text); END IF;

  -- T10: kardex con saldo y trazabilidad; consumo por activo
  SELECT count(*) INTO v_n FROM public.vw_inventory_kardex WHERE spare_part_id = v_part;
  IF v_n = 6 AND (SELECT balance_after FROM public.vw_inventory_kardex WHERE spare_part_id = v_part ORDER BY created_at DESC, balance_after LIMIT 1) IS NOT NULL
     AND (SELECT sum(quantity) FROM public.vw_parts_consumption WHERE vehicle_plate = 'ZZF7A1' AND internal_code = 'ZZ-FLT-01') = 13 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T10 kardex: movimientos=' || v_n); END IF;

  -- T11: preventivo reserva sus repuestos previstos; faltantes quedan anotados
  INSERT INTO public.spare_parts (internal_code, name, site_id) VALUES ('ZZ-ACE-01', 'Aceite 15W40', v_site) RETURNING id INTO v_part2;
  INSERT INTO public.maintenance_plans (name, vehicle_plate, frequency_km, is_active, expected_parts)
  VALUES ('PM F7', 'ZZF7A1', 1000, true, jsonb_build_array(jsonb_build_object('part_id', v_part, 'quantity', 2), jsonb_build_object('part_id', v_part2, 'quantity', 4)))
  RETURNING id INTO v_plan;
  v_wo3 := public.generate_preventive_wo(v_plan);
  IF (SELECT quantity FROM public.spare_part_reservations WHERE work_order_id = v_wo3 AND spare_part_id = v_part AND status = 'ACTIVA') = 2
     AND (SELECT notes FROM public.maintenance_work_orders WHERE id = v_wo3) LIKE '%ZZ-ACE-01%' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || text 'T11 reservas del preventivo'; END IF;

  -- T12: sin stock negativo por ninguna vía
  v_err := NULL;
  BEGIN
    INSERT INTO public.inventory_transactions (spare_part_id, type, quantity) VALUES (v_part2, 'SALIDA', 1);
  EXCEPTION WHEN raise_exception THEN v_err := SQLERRM;
  END;
  IF v_err LIKE 'Stock insuficiente%' AND NOT (public.consume_work_order_part(v_wo2, v_part, 1000)->>'success')::boolean THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T12 stock negativo: ' || COALESCE(v_err, 'aceptado')); END IF;

  -- T13: Copiloto — alertas de inventario desde la fuente real
  r := public.ai_get_inventory_alerts(ARRAY[v_site]);
  IF (r->>'partsInScope')::int >= 2 AND (r->>'belowMinimumCount')::int >= 0 AND r ? 'stockValue' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T13 IA inventario: ' || left(r::text, 200)); END IF;

  -- T14: sin permisos no mueve inventario, no reserva ni ve el kardex
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_nobody, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_nobody::text, true);
  IF NOT (public.register_inventory_movement(v_part, 'INGRESO', 5, 10)->>'success')::boolean
     AND NOT (public.reserve_work_order_part(v_wo2, v_part, 1)->>'success')::boolean THEN
    EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT count(*) INTO v_n FROM public.vw_inventory_kardex;
    EXECUTE 'RESET ROLE';
    IF v_n = 0 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T14 kardex visible: ' || v_n); END IF;
  ELSE v_fail := v_fail || text 'T14 sin permisos operó inventario'; END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION 'F7 FAIL (% ok, % fallas): %', v_pass, array_length(v_fail, 1), array_to_string(v_fail, ' || ');
  END IF;
  RAISE EXCEPTION 'F7 PASS (% pruebas)', v_pass;
END
$test$;

ROLLBACK;
