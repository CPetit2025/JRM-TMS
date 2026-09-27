-- Pruebas FASE 11 — Contratos, alquileres, liquidación y TCO.
-- Termina siempre en error para forzar ROLLBACK: "F11 PASS (...)" o "F11 FAIL: ...".
--   npx supabase db query --linked -f supabase/tests/f11_alquileres_tco.test.sql
BEGIN;

DO $test$
DECLARE
  v_admin   uuid;
  v_nobody  uuid := gen_random_uuid();
  v_carrier uuid;
  v_site    uuid;
  v_veh     uuid;
  v_veh2    uuid;
  v_veh3    uuid;
  v_c1      uuid;
  v_c2      uuid;
  v_c3      uuid;
  v_s1      uuid;
  v_wo      uuid;
  v_tire    uuid;
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
  IF v_admin IS NULL THEN RAISE EXCEPTION 'F11 FAIL: no hay administrador'; END IF;

  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, brand, status, current_odometer, ownership_status)
  VALUES ('ZZF11A', v_carrier, v_site, 'TRACTO', 'TEST', 'DISPONIBLE', 9000, 'PROPIO') RETURNING id INTO v_veh;
  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, brand, status, current_odometer) VALUES ('ZZF11B', v_carrier, v_site, 'CAMION', 'TEST', 'DISPONIBLE', 100) RETURNING id INTO v_veh2;
  INSERT INTO public.vehicles (plate, internal_code, carrier_id, site_id, type, status, current_hours) VALUES ('ZZF11M', 'ZZF11M', v_carrier, v_site, 'MONTACARGAS', 'DISPONIBLE', 90) RETURNING id INTO v_veh3;
  -- Lecturas reales de agosto 2026
  INSERT INTO public.vehicle_odometer_logs (vehicle_plate, odometer_value, source_event, status, created_at) VALUES
    ('ZZF11A', 10000, 'TEST', 'VALIDADO', '2026-08-01 12:00-05'), ('ZZF11A', 11500, 'TEST', 'VALIDADO', '2026-08-10 12:00-05'),
    ('ZZF11A', 14000, 'TEST', 'VALIDADO', '2026-08-31 12:00-05'), ('ZZF11A', 20000, 'TEST', 'VALIDADO', '2026-09-15 12:00-05');
  INSERT INTO public.vehicle_odometer_logs (vehicle_plate, odometer_value, hours_value, source_event, status, created_at) VALUES
    ('ZZF11M', 0, 100, 'TEST', 'VALIDADO', '2026-08-02 08:00-05'), ('ZZF11M', 0, 160, 'TEST', 'VALIDADO', '2026-08-30 18:00-05');
  -- Indisponibilidad por mantenimiento: 10 → 12 de agosto (2 días)
  INSERT INTO public.maintenance_work_orders (ot_code, vehicle_id, description, order_type, site_id, status, downtime_start, downtime_end)
  VALUES ('ZZ-F11-1', v_veh, 'Reparación caja', 'CORRECTIVA', v_site, 'CERRADA', '2026-08-10 00:00-05', '2026-08-12 00:00-05') RETURNING id INTO v_wo;
  INSERT INTO public.work_order_costs (work_order_id, cost_type, amount) SELECT v_wo, 'MANO_OBRA', 800 WHERE false;  -- (OT cerrada: sin costos nuevos)

  -- T1: contrato mensual: código, propiedad ALQUILADO en el maestro; sin traslapes
  INSERT INTO public.vehicle_lease_contracts (vehicle_id, provider_id, contract_type, rate_type, rate_amount, included_km, excess_km_rate, start_date, end_date)
  VALUES (v_veh, v_carrier, 'ALQUILER_SECO', 'mensual', 3100, 3000, 1.5, '2026-07-15', '2026-12-31') RETURNING id INTO v_c1;
  v_err := NULL;
  BEGIN
    INSERT INTO public.vehicle_lease_contracts (vehicle_id, provider_id, contract_type, rate_type, rate_amount, start_date) VALUES (v_veh, v_carrier, 'ALQUILER_SECO', 'DIARIA', 100, '2026-10-01');
  EXCEPTION WHEN raise_exception THEN v_err := 'traslape';
  END;
  IF (SELECT contract_code IS NOT NULL AND site_id = v_site AND monthly_base_fee = 3100 FROM public.vehicle_lease_contracts WHERE id = v_c1)
     AND (SELECT ownership_status FROM public.vehicles WHERE id = v_veh) = 'ALQUILADO' AND v_err = 'traslape' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || text 'T1 contrato'; END IF;

  -- T2: liquidación de agosto con km reales, excesos y descuento por indisponibilidad
  r := public.calculate_lease_settlement(v_c1, '2026-08-01', '2026-08-31');
  IF (r->>'days')::int = 31 AND (r->>'km_used')::numeric = 4000 AND (r->>'base_amount')::numeric = 3100
     AND (r->>'excess_km')::numeric = 1000 AND (r->>'excess_km_amount')::numeric = 1500
     AND (r->>'downtime_days')::numeric = 2 AND (r->>'downtime_discount')::numeric = 200
     AND (r->>'subtotal')::numeric = 4400 AND (r->>'tax')::numeric = 792 AND (r->>'total')::numeric = 5192 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T2 cálculo: ' || r::text); END IF;

  -- T3: registrar exige sustento para penalidades; no duplica el periodo
  v_err := public.create_lease_settlement(v_c1, '2026-08-01', '2026-08-31', 0, 100)->>'error';
  r := public.create_lease_settlement(v_c1, '2026-08-01', '2026-08-31', 0, 100, 0, 0, 'Devolución con daño en carrocería');
  v_s1 := (r->>'settlement_id')::uuid;
  IF v_err LIKE '%Sustente%' AND (r->>'subtotal')::numeric = 4500
     AND (public.create_lease_settlement(v_c1, '2026-08-01', '2026-08-31', 0, 0)->>'error') LIKE '%Ya existe%' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T3 registro: ' || COALESCE(v_err, '') || ' ' || r::text); END IF;

  -- T4: aprobación; aprobada es inmutable y no se edita desde el cliente
  r := public.decide_lease_settlement(v_s1, 'APROBADA', 'Conforme');
  v_err := NULL;
  BEGIN
    UPDATE public.lease_settlements SET total = 1 WHERE id = v_s1;
  EXCEPTION WHEN insufficient_privilege THEN v_err := 'inmutable';
  END;
  IF (r->>'success')::boolean AND v_err = 'inmutable' AND (SELECT status FROM public.lease_settlements WHERE id = v_s1) = 'APROBADA' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T4 aprobación: ' || r::text); END IF;

  -- T5: tarifa diaria con inicio a mitad de mes (solo días de vigencia)
  INSERT INTO public.vehicle_lease_contracts (vehicle_id, provider_id, contract_type, rate_type, rate_amount, start_date)
  VALUES (v_veh2, v_carrier, 'ALQUILER_SECO', 'DIARIA', 120, '2026-08-16') RETURNING id INTO v_c2;
  r := public.calculate_lease_settlement(v_c2, '2026-08-01', '2026-08-31');
  IF (r->>'days')::int = 16 AND (r->>'base_amount')::numeric = 1920 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T5 diaria: ' || r::text); END IF;

  -- T6: tarifa horaria con horómetro real
  INSERT INTO public.vehicle_lease_contracts (vehicle_id, provider_id, contract_type, rate_type, rate_amount, start_date)
  VALUES (v_veh3, v_carrier, 'ALQUILER_SECO', 'HORARIA', 50, '2026-08-01') RETURNING id INTO v_c3;
  r := public.calculate_lease_settlement(v_c3, '2026-08-01', '2026-08-31');
  IF (r->>'hours_used')::numeric = 60 AND (r->>'base_amount')::numeric = 3000 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T6 horaria: ' || r::text); END IF;

  -- T7: renovación encadenada
  r := public.renew_lease_contract(v_c1, '2027-06-30', 3300, 'Renovación 2027');
  SELECT * INTO w FROM public.vehicle_lease_contracts WHERE id = (r->>'contract_id')::uuid;
  IF (r->>'success')::boolean AND w.parent_contract_id = v_c1 AND w.start_date = '2027-01-01' AND w.rate_amount = 3300 AND w.status = 'ACTIVO'
     AND (SELECT status FROM public.vehicle_lease_contracts WHERE id = v_c1) = 'RENOVADO'
     AND (SELECT ownership_status FROM public.vehicles WHERE id = v_veh) = 'ALQUILADO' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T7 renovación: ' || r::text); END IF;

  -- T8: libro de costos ⇒ TCO (alquiler aprobado, neumáticos por km, multa de la empresa)
  INSERT INTO public.tires (codigo_interno, marca, costo, cocada_original) VALUES ('ZZ-NEU-F11', 'X', 1000, 16) RETURNING id INTO v_tire;
  PERFORM public.register_tire_event(v_tire, 'INSTALACION', 'ZZF11A', 'DI', 20000);
  PERFORM public.register_tire_event(v_tire, 'DESMONTAJE', NULL, NULL, 22000);
  INSERT INTO public.traffic_fines (vehicle_id, infraction_date, entity, ticket_number, amount, responsibility)
  VALUES (v_veh, now(), 'SAT', 'ZZ-F11', 300, 'EMPRESA');
  PERFORM public.transition_traffic_fine((SELECT id FROM public.traffic_fines WHERE ticket_number = 'ZZ-F11'), 'PAGADA', NULL, 300, NULL, 'OP-F11');
  SELECT * INTO w FROM public.vehicle_tco_analytics WHERE vehicle_id = v_veh;
  IF w.lease_cost = 4500 AND w.tires_cost = 1000 AND w.compliance_cost = 300 AND w.total_tco = 5800
     AND w.cpk = round(5800 / 22000.0, 4)
     AND (SELECT alquiler FROM public.vw_asset_tco WHERE placa = 'ZZF11A' AND anio = 2026 AND mes = 8) = 4500 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T8 TCO: ' || row_to_json(w)::text); END IF;

  -- T9: sin permisos no consulta, no liquida, no aprueba ni ve contratos
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_nobody, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_nobody::text, true);
  v_n := 0;
  IF NOT (public.calculate_lease_settlement(v_c2, '2026-08-01', '2026-08-31')->>'success')::boolean THEN v_n := v_n + 1; END IF;
  IF NOT (public.create_lease_settlement(v_c2, '2026-08-01', '2026-08-31')->>'success')::boolean THEN v_n := v_n + 1; END IF;
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT v_n * 100 + (SELECT count(*) FROM public.vehicle_lease_contracts) + (SELECT count(*) FROM public.lease_settlements) INTO v_n;
  EXECUTE 'RESET ROLE';
  IF v_n = 200 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T9 permisos: ' || v_n); END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION 'F11 FAIL (% ok, % fallas): %', v_pass, array_length(v_fail, 1), array_to_string(v_fail, ' || ');
  END IF;
  RAISE EXCEPTION 'F11 PASS (% pruebas)', v_pass;
END
$test$;

ROLLBACK;
