-- Pruebas FASE 12 — KPI (reconciliación manual de una muestra) y Copiloto.
-- Termina siempre en error para forzar ROLLBACK: "F12 PASS (...)" o "F12 FAIL: ...".
--   npx supabase db query --linked -f supabase/tests/f12_kpis_copiloto.test.sql
--
-- Muestra (junio 2026 = 30 días = 720 h por unidad; 2 unidades ⇒ 1 440 h):
--   A: OT correctiva 10/06 00:00 → 11/06 12:00 (36 h) y OT correctiva solapada 11/06 00:00 → 06:00 (6 h)
--      ⇒ indisponibilidad fusionada A = 36 h (no 42)
--   B: OT preventiva 20/06 00:00 → 12:00 (12 h)
--   Disponibilidad = 100 × (1 − 48 / 1 440) = 96,67 %
--   MTTR (correctivas cerradas) = (36 + 6) / 2 = 21 h
--   Fallas en junio: A = 2 ⇒ MTBF = (1 440 − 48) / 2 = 696 h
--   Preventivo = 1 / (1 + 2) = 33,3 %
--   Costos: A 1 000 + B 500 = 1 500; km: A 3 000 + B 2 000 = 5 000 ⇒ 0,30 S/ por km; mantenimiento por unidad = 750
BEGIN;

DO $test$
DECLARE
  v_admin   uuid;
  v_nobody  uuid := gen_random_uuid();
  v_carrier uuid;
  v_site    uuid;
  v_a       uuid;
  v_b       uuid;
  v_wo1     uuid;
  v_wo2     uuid;
  v_wo3     uuid;
  v_fail    text[] := '{}';
  v_pass    int := 0;
  k         jsonb;
  b         jsonb;
  v_n       int;
BEGIN
  SELECT carrier_id, site_id INTO v_carrier, v_site FROM public.vehicles LIMIT 1;
  FOR v_admin IN SELECT id FROM public.profiles LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXIT WHEN public.is_tms_admin();
    v_admin := NULL;
  END LOOP;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'F12 FAIL: no hay administrador'; END IF;

  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, brand, status, current_odometer, soat_expiration, technical_review_expiration)
  VALUES ('ZZK12A', v_carrier, v_site, 'CAMION', 'TEST', 'DISPONIBLE', 13000, CURRENT_DATE + 365, CURRENT_DATE + 365) RETURNING id INTO v_a;
  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, brand, status, current_odometer, soat_expiration, technical_review_expiration)
  VALUES ('ZZK12B', v_carrier, v_site, 'CAMION', 'TEST', 'BLOQUEADA', 7000, CURRENT_DATE + 365, CURRENT_DATE + 365) RETURNING id INTO v_b;

  -- OT con costos cargados en junio y luego cerradas en junio
  INSERT INTO public.maintenance_work_orders (ot_code, vehicle_id, description, order_type, site_id) VALUES ('ZZ-K1', v_a, 'Caja', 'CORRECTIVA', v_site) RETURNING id INTO v_wo1;
  INSERT INTO public.maintenance_work_orders (ot_code, vehicle_id, description, order_type, site_id) VALUES ('ZZ-K2', v_a, 'Embrague', 'CORRECTIVA', v_site) RETURNING id INTO v_wo2;
  INSERT INTO public.maintenance_work_orders (ot_code, vehicle_id, description, order_type, site_id) VALUES ('ZZ-K3', v_b, 'PM 10k', 'PREVENTIVA', v_site) RETURNING id INTO v_wo3;
  INSERT INTO public.work_order_costs (work_order_id, cost_type, amount, created_at) VALUES
    (v_wo1, 'MANO_OBRA', 700, '2026-06-11 10:00-05'), (v_wo2, 'SERVICIOS', 300, '2026-06-11 10:00-05'), (v_wo3, 'MANO_OBRA', 500, '2026-06-20 10:00-05');
  UPDATE public.maintenance_work_orders SET status = 'CERRADA', downtime_start = '2026-06-10 00:00-05', downtime_end = '2026-06-11 12:00-05', closed_at = '2026-06-11 12:00-05' WHERE id = v_wo1;
  UPDATE public.maintenance_work_orders SET status = 'CERRADA', downtime_start = '2026-06-11 00:00-05', downtime_end = '2026-06-11 06:00-05', closed_at = '2026-06-11 06:00-05' WHERE id = v_wo2;
  UPDATE public.maintenance_work_orders SET status = 'CERRADA', downtime_start = '2026-06-20 00:00-05', downtime_end = '2026-06-20 12:00-05', closed_at = '2026-06-20 12:00-05' WHERE id = v_wo3;
  -- Fallas y lecturas de junio (más una falla en mayo que no cuenta)
  INSERT INTO public.maintenance_requests (vehicle_plate, description, severity, status, reported_at) VALUES
    ('ZZK12A', 'Ruido caja', 'ALTA', 'REPORTADA', '2026-06-05 09:00-05'), ('ZZK12A', 'Fuga aceite', 'MEDIA', 'REPORTADA', '2026-06-25 09:00-05'),
    ('ZZK12A', 'Luz tablero', 'BAJA', 'REPORTADA', '2026-05-20 09:00-05');
  INSERT INTO public.vehicle_odometer_logs (vehicle_plate, odometer_value, source_event, status, created_at) VALUES
    ('ZZK12A', 10000, 'TEST', 'VALIDADO', '2026-06-01 08:00-05'), ('ZZK12A', 13000, 'TEST', 'VALIDADO', '2026-06-30 18:00-05'),
    ('ZZK12B', 5000, 'TEST', 'VALIDADO', '2026-06-02 08:00-05'), ('ZZK12B', 7000, 'TEST', 'VALIDADO', '2026-06-29 18:00-05');

  k := public.get_cmms_kpis('2026-06-01', '2026-06-30', ARRAY['ZZK12A', 'ZZK12B']);

  -- T1: base del periodo
  IF (k->>'units')::int = 2 AND (k->'period'->>'hours')::numeric = 720 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 periodo: ' || (k->'period')::text); END IF;
  -- T2: disponibilidad con intervalos fusionados (48 h, no 54)
  IF (k->>'downtime_hours')::numeric = 48 AND (k->>'availability_pct')::numeric = 96.67 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T2 disponibilidad: ' || (k->>'downtime_hours') || ' / ' || (k->>'availability_pct')); END IF;
  -- T3: MTTR
  IF (k->>'mttr_hours')::numeric = 21 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 MTTR: ' || (k->>'mttr_hours')); END IF;
  -- T4: MTBF
  IF (k->>'failures')::int = 2 AND (k->>'mtbf_hours')::numeric = 696 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 MTBF: ' || (k->>'mtbf_hours')); END IF;
  -- T5: preventivo vs correctivo
  IF (k->>'preventive_work_orders')::int = 1 AND (k->>'corrective_work_orders')::int = 2 AND (k->>'preventive_pct')::numeric = 33.3 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T5 preventivo: ' || (k->>'preventive_pct')); END IF;
  -- T6: costos (total, costo/km, mantenimiento por unidad)
  IF (k->'costs'->>'total')::numeric = 1500 AND (k->'costs'->>'km')::numeric = 5000 AND (k->'costs'->>'cost_per_km')::numeric = 0.3
     AND (k->'costs'->>'maintenance_per_unit')::numeric = 750 AND (k->'costs'->'by_category'->>'MANTENIMIENTO')::numeric = 1500 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T6 costos: ' || (k->'costs')::text); END IF;
  -- T7: detalle por unidad (A: 36 h ⇒ 95 %, MTBF (720−36)/2 = 342 h; B: 12 h ⇒ 98,33 %)
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(k->'per_vehicle') p WHERE p->>'plate' = 'ZZK12A' AND (p->>'downtime_hours')::numeric = 36
             AND (p->>'availability_pct')::numeric = 95 AND (p->>'mtbf_hours')::numeric = 342 AND (p->>'cost_per_km')::numeric = round(1000 / 3000.0, 4))
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(k->'per_vehicle') p WHERE p->>'plate' = 'ZZK12B' AND (p->>'availability_pct')::numeric = 98.33) THEN
    v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T7 por unidad: ' || (k->'per_vehicle')::text); END IF;

  -- T8: fallas recurrentes (A con 3 reportes en 90 días al cierre del periodo)
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(k->'recurrent_failures') r WHERE r->>'vehicle_plate' = 'ZZK12A' AND (r->>'reports_90d')::int = 3) THEN
    v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T8 recurrentes: ' || (k->'recurrent_failures')::text); END IF;

  -- T9: Copiloto: bloqueada con motivos, unidad más costosa, backlog
  b := public.get_cmms_copilot_brief(ARRAY['ZZK12A', 'ZZK12B']);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(b->'blocked_or_unavailable') x WHERE x->>'plate' = 'ZZK12B' AND x->>'status' = 'BLOQUEADA')
     AND b ? 'maintenance_due' AND b ? 'parts_below_minimum' AND b ? 'provider_reworks' AND b ? 'anomalies'
     AND b->>'disclaimer' LIKE '%asistiva%' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T9 copiloto: ' || left(b::text, 300)); END IF;

  -- T10: la zona horaria de la base es Lima (CURRENT_DATE = fecha de negocio)
  IF current_setting('TimeZone') = 'America/Lima' AND CURRENT_DATE = (now() AT TIME ZONE 'America/Lima')::date THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T10 zona horaria: ' || current_setting('TimeZone')); END IF;

  -- T11: KPI y Copiloto respetan RLS (sin permisos no ve unidades ni costos)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_nobody, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_nobody::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  k := public.get_cmms_kpis('2026-06-01', '2026-06-30', ARRAY['ZZK12A', 'ZZK12B']);
  b := public.get_cmms_copilot_brief(ARRAY['ZZK12A', 'ZZK12B']);
  EXECUTE 'RESET ROLE';
  IF COALESCE((k->'costs'->>'total')::numeric, 0) = 0 AND jsonb_array_length(b->'blocked_or_unavailable') = 0 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T11 RLS: ' || (k->'costs')::text); END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION 'F12 FAIL (% ok, % fallas): %', v_pass, array_length(v_fail, 1), array_to_string(v_fail, ' || ');
  END IF;
  RAISE EXCEPTION 'F12 PASS (% pruebas)', v_pass;
END
$test$;

ROLLBACK;
