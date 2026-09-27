-- Pruebas FASE 5 — Planificación preventiva.
-- Termina siempre en error para forzar ROLLBACK: "F5 PASS (...)" o "F5 FAIL: ...".
--   npx supabase db query --linked -f supabase/tests/f5_preventivos.test.sql
BEGIN;

DO $test$
DECLARE
  v_admin   uuid;
  v_nobody  uuid := gen_random_uuid();
  v_carrier uuid;
  v_site    uuid;
  v_plan    uuid;
  v_plan_d  uuid;
  v_plan_h  uuid;
  v_plan_c  uuid;
  v_wo      uuid;
  v_fail    text[] := '{}';
  v_pass    int := 0;
  r         jsonb;
  v_err     text;
  v_n       int;
  p         record;
  v_today   date := (now() AT TIME ZONE 'America/Lima')::date;
BEGIN
  SELECT carrier_id, site_id INTO v_carrier, v_site FROM public.vehicles LIMIT 1;
  FOR v_admin IN SELECT id FROM public.profiles LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXIT WHEN public.is_tms_admin();
    v_admin := NULL;
  END LOOP;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'F5 FAIL: no hay administrador'; END IF;

  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, brand, status, soat_expiration, technical_review_expiration, current_odometer)
  VALUES ('ZZF5A1', v_carrier, v_site, 'CAMION', 'TEST', 'DISPONIBLE', v_today + 365, v_today + 365, 10000),
         ('ZZF5B1', v_carrier, v_site, 'CAMION', 'TEST', 'DISPONIBLE', v_today + 365, v_today + 365, 20000),
         ('ZZF5C1', v_carrier, v_site, 'CAMION', 'TEST', 'DISPONIBLE', v_today + 365, v_today + 365, 10000);
  INSERT INTO public.vehicles (plate, internal_code, carrier_id, site_id, type, status, current_hours)
  VALUES ('ZZMC5', 'ZZMC5', v_carrier, v_site, 'MONTACARGAS', 'DISPONIBLE', 1240);
  -- Historia de lecturas: 100 km/día en los últimos 10 días
  INSERT INTO public.vehicle_odometer_logs (vehicle_plate, odometer_value, source_event, status, created_at)
  VALUES ('ZZF5A1', 9000, 'TEST', 'VALIDADO', now() - interval '10 days'), ('ZZF5A1', 10000, 'TEST', 'VALIDADO', now());

  -- T1: plan por km: línea base = lectura real; vencimiento derivado
  INSERT INTO public.maintenance_plans (name, vehicle_plate, frequency_km, standard_tasks, is_active)
  VALUES ('Aceite motor', 'zzf5a1', 5000, '[{"description":"Cambiar aceite"},{"description":"Cambiar filtro"}]', true)
  RETURNING id INTO v_plan;
  SELECT * INTO p FROM public.maintenance_plans WHERE id = v_plan;
  IF p.last_performed_km = 10000 AND p.next_due_km = 15000 AND p.next_due_date IS NULL AND p.last_performed_date = v_today
     AND p.vehicle_type = 'CAMION' AND p.site_id = v_site AND p.activity_description = 'Aceite motor' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T1 plan km: ' || row_to_json(p)::text); END IF;

  -- T2: validaciones (última ejecución mayor al odómetro real; sin frecuencias)
  v_err := NULL;
  BEGIN
    INSERT INTO public.maintenance_plans (name, vehicle_plate, frequency_km, last_performed_km, is_active) VALUES ('x', 'ZZF5A1', 1000, 99999, true);
  EXCEPTION WHEN raise_exception THEN v_err := 'km';
  END;
  BEGIN
    INSERT INTO public.maintenance_plans (name, vehicle_plate, is_active) VALUES ('y', 'ZZF5A1', true);
    v_err := v_err || '/sin frecuencia aceptado';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF v_err = 'km' THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 validaciones: ' || COALESCE(v_err, 'km aceptado')); END IF;

  -- T3: proyección por tasa de uso (≈100 km/día ⇒ ~50 días ⇒ horizonte 60, NORMAL)
  SELECT * INTO p FROM public.vw_maintenance_projections WHERE plan_id = v_plan;
  IF p.km_remaining = 5000 AND p.avg_daily_km BETWEEN 99 AND 101 AND p.projected_days BETWEEN 49 AND 51
     AND p.projection_bucket = '60' AND p.alert_status = 'NORMAL' AND p.due_driver = 'KILOMETRAJE' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T3 proyección: ' || row_to_json(p)::text); END IF;

  -- T4: lecturas autorizadas mueven la alerta PRÓXIMO → URGENTE → VENCIDO (umbrales de km, unidad sin
  --     historial de uso) y el motor bloquea la unidad con preventivo vencido
  INSERT INTO public.maintenance_plans (name, vehicle_plate, frequency_km, is_active)
  VALUES ('Aceite C1', 'ZZF5C1', 5000, true) RETURNING id INTO v_plan_c;
  r := public.register_asset_reading('ZZF5C1', 13900, NULL, 'MANTENIMIENTO', 'lectura');
  SELECT alert_status INTO p FROM public.vw_maintenance_projections WHERE plan_id = v_plan_c;
  v_err := p.alert_status;
  PERFORM public.register_asset_reading('ZZF5C1', 14600);
  SELECT alert_status INTO p FROM public.vw_maintenance_projections WHERE plan_id = v_plan_c;
  v_err := v_err || '/' || p.alert_status;
  PERFORM public.register_asset_reading('ZZF5C1', 15100);
  SELECT alert_status INTO p FROM public.vw_maintenance_projections WHERE plan_id = v_plan_c;
  v_err := v_err || '/' || p.alert_status;
  PERFORM public.register_asset_reading('ZZF5A1', 15100);
  IF (r->>'success')::boolean AND v_err = 'PRÓXIMO/URGENTE/VENCIDO'
     AND NOT (public.check_asset_eligibility('ZZF5C1')->'checks'->>'no_overdue_preventive')::boolean
     AND (SELECT alert_status FROM public.vw_maintenance_projections WHERE plan_id = v_plan) = 'VENCIDO' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T4 alertas: ' || v_err || ' ' || r::text); END IF;

  -- T5: una lectura no puede retroceder
  r := public.register_asset_reading('ZZF5A1', 100);
  IF NOT (r->>'success')::boolean AND (SELECT current_odometer FROM public.vehicles WHERE plate = 'ZZF5A1') = 15100 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T5 lectura hacia atrás: ' || r::text); END IF;

  -- T6: plan combinado km + fecha vence por lo primero que ocurra (fecha)
  INSERT INTO public.maintenance_plans (name, vehicle_plate, frequency_km, frequency_days, last_performed_date, is_active)
  VALUES ('Revisión frenos', 'ZZF5B1', 100000, 30, v_today - 35, true) RETURNING id INTO v_plan_d;
  SELECT * INTO p FROM public.vw_maintenance_projections WHERE plan_id = v_plan_d;
  IF p.alert_status = 'VENCIDO' AND p.due_driver = 'FECHA' AND p.days_remaining = -5 AND p.km_remaining = 100000 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T6 combinado: ' || row_to_json(p)::text); END IF;

  -- T7: plan por horómetro (montacargas)
  INSERT INTO public.maintenance_plans (name, vehicle_plate, frequency_hours, last_performed_hours, is_active)
  VALUES ('Servicio 250 h', 'ZZMC5', 250, 1000, true) RETURNING id INTO v_plan_h;
  SELECT * INTO p FROM public.vw_maintenance_projections WHERE plan_id = v_plan_h;
  IF p.next_due_hours = 1250 AND p.hours_remaining = 10 AND p.alert_status = 'URGENTE' AND p.due_driver = 'HOROMETRO' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T7 horómetro: ' || row_to_json(p)::text); END IF;

  -- T8: generación de OT idempotente, con tareas estándar y prioridad por alerta
  v_wo := public.generate_preventive_wo(v_plan);
  SELECT * INTO p FROM public.maintenance_work_orders WHERE id = v_wo;
  IF public.generate_preventive_wo(v_plan) = v_wo AND p.order_type = 'PREVENTIVA' AND p.source_type = 'PLAN'
     AND p.priority = 'ALTA' AND jsonb_array_length(p.tasks) = 2 AND p.tasks->0->>'text' = 'Cambiar aceite'
     AND (SELECT open_work_order_id FROM public.vw_maintenance_projections WHERE plan_id = v_plan) = v_wo THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T8 generación: ' || row_to_json(p)::text); END IF;

  -- T9: programador en BD: genera para URGENTE/VENCIDO sin OT abierta; segunda corrida no duplica; queda bitácora
  r := public.run_preventive_scheduler('TEST');
  SELECT count(*) INTO v_n FROM public.maintenance_work_orders WHERE plan_id IN (v_plan_d, v_plan_h, v_plan_c) AND status = 'BORRADOR';
  v_err := public.run_preventive_scheduler('TEST')->>'generated';
  IF (r->>'generated')::int >= 3 AND v_n = 3 AND v_err = '0'
     AND (SELECT count(*) FROM public.preventive_scheduler_runs WHERE triggered_by = 'TEST') = 2 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T9 programador: ' || r::text || ' 2da=' || COALESCE(v_err, '?') || ' n=' || v_n); END IF;

  -- T10: cerrar la OT preventiva reinicia el plan desde la lectura real
  PERFORM public.transition_work_order(v_wo, 'APROBADA');
  PERFORM public.transition_work_order(v_wo, 'EN_PROCESO');
  PERFORM public.transition_work_order(v_wo, 'TERMINADA', 'Aceite y filtro cambiados');
  r := public.complete_maintenance_order(v_wo, '[]'::jsonb, 'ok');
  SELECT * INTO p FROM public.vw_maintenance_projections WHERE plan_id = v_plan;
  IF (r->>'success')::boolean AND p.last_performed_km = 15100 AND p.next_due_km = 20100 AND p.alert_status <> 'VENCIDO'
     AND p.open_work_order_id IS NULL AND p.last_performed_date = v_today THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T10 reinicio del plan: ' || r::text || ' ' || row_to_json(p)::text); END IF;

  -- T11: el programador está agendado en pg_cron
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cmms-preventive-scheduler' AND schedule = '0 11 * * *') THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || text 'T11 cron no agendado'; END IF;

  -- T12: sin permisos no registra lecturas, no genera OT ni corre el programador
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_nobody, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_nobody::text, true);
  r := public.register_asset_reading('ZZF5A1', 99999);
  v_err := NULL;
  BEGIN
    PERFORM public.generate_preventive_wo(v_plan);
  EXCEPTION WHEN insufficient_privilege THEN v_err := 'gen';
  END;
  BEGIN
    PERFORM public.run_preventive_scheduler('X');
  EXCEPTION WHEN insufficient_privilege THEN v_err := v_err || '/run';
  END;
  IF NOT (r->>'success')::boolean AND v_err = 'gen/run' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T12 permisos: ' || r::text || ' ' || COALESCE(v_err, '')); END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION 'F5 FAIL (% ok, % fallas): %', v_pass, array_length(v_fail, 1), array_to_string(v_fail, ' || ');
  END IF;
  RAISE EXCEPTION 'F5 PASS (% pruebas)', v_pass;
END
$test$;

ROLLBACK;
