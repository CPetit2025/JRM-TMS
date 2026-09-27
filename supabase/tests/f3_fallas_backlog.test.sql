-- Pruebas FASE 3 — Solicitudes, fallas y backlog.
-- Termina siempre en error para forzar ROLLBACK: "F3 PASS (...)" o "F3 FAIL: ...".
--   npx supabase db query --linked -f supabase/tests/f3_fallas_backlog.test.sql
BEGIN;

DO $test$
DECLARE
  v_admin    uuid;
  v_driver   uuid;
  v_nobody   uuid := gen_random_uuid();
  v_carrier  uuid;
  v_site     uuid;
  v_fail     text[] := '{}';
  v_pass     int := 0;
  r          jsonb;
  v_req      uuid;
  v_req2     uuid;
  v_wo       uuid;
  v_wo2      uuid;
  v_tpl      uuid;
  v_item     uuid;
  v_insp     uuid;
  v_status   text;
  v_n        int;
  v_err      text;
  v_prop     uuid;
  v_sup      uuid;
  v_cond     uuid;
BEGIN
  SELECT carrier_id, site_id INTO v_carrier, v_site FROM public.vehicles LIMIT 1;
  FOR v_admin IN SELECT id FROM public.profiles LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXIT WHEN public.is_tms_admin();
    v_admin := NULL;
  END LOOP;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'F3 FAIL: no hay administrador'; END IF;
  SELECT id INTO v_driver FROM public.drivers LIMIT 1;

  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, brand, status, soat_expiration, technical_review_expiration, current_odometer)
  VALUES ('ZZF3A1', v_carrier, v_site, 'CAMION', 'TEST', 'DISPONIBLE', CURRENT_DATE + 365, CURRENT_DATE + 365, 1000),
         ('ZZF3B1', v_carrier, v_site, 'CAMION', 'TEST', 'DISPONIBLE', CURRENT_DATE + 365, CURRENT_DATE + 365, 1000);

  -- T1: reporte desde App normaliza criticidad/estado/origen
  r := public.submit_maintenance_request('zzf3a1', v_driver, NULL, 'Frenos sin respuesta', 'CRÍTICA', 1200, NULL, '{"lat": -12.05, "lon": -77.04}'::jsonb);
  v_req := (r->>'request_id')::uuid;
  SELECT status INTO v_status FROM public.maintenance_requests
  WHERE id = v_req AND severity = 'CRITICA' AND source = 'APP_CONDUCTOR' AND site_id = v_site AND location_lat IS NOT NULL;
  IF (r->>'success')::boolean AND v_status = 'REPORTADA' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T1 reporte App: ' || r::text); END IF;

  -- T2: falla crítica bloquea la unidad a través del motor (queda auditado)
  SELECT status INTO v_status FROM public.vehicles WHERE plate = 'ZZF3A1';
  IF v_status = 'BLOQUEADA' AND EXISTS (SELECT 1 FROM public.vehicle_history_logs WHERE vehicle_plate = 'ZZF3A1' AND new_value = 'BLOQUEADA')
     AND (SELECT current_odometer FROM public.vehicles WHERE plate = 'ZZF3A1') = 1200 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T2 bloqueo crítico: estado=' || v_status); END IF;

  -- T3: el mismo reporte el mismo día no se duplica
  r := public.submit_maintenance_request('ZZF3A1', v_driver, NULL, 'Frenos sin respuesta', 'CRITICA', 1200, NULL, NULL);
  SELECT count(*) INTO v_n FROM public.maintenance_requests WHERE vehicle_plate = 'ZZF3A1';
  IF (r->>'duplicate')::boolean AND (r->>'request_id')::uuid = v_req AND v_n = 1 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T3 duplicado: ' || r::text || ' n=' || v_n); END IF;

  -- T4: ciclo válido y transición inválida
  r := public.transition_maintenance_request(v_req, 'VALIDADA', 'Confirmada por taller');
  IF (r->>'success')::boolean AND NOT (public.transition_maintenance_request(v_req, 'CERRADA')->>'success')::boolean THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T4 ciclo: ' || r::text); END IF;

  -- T5: requisitos por estado (diagnóstico, fecha, motivo de descarte)
  IF NOT (public.transition_maintenance_request(v_req, 'PROGRAMADA')->>'success')::boolean
     AND NOT (public.transition_maintenance_request(v_req, 'DESCARTADA')->>'success')::boolean
     AND (public.transition_maintenance_request(v_req, 'DIAGNOSTICADA', 'Pastillas gastadas')->>'success')::boolean
     AND (public.transition_maintenance_request(v_req, 'PROGRAMADA', NULL, NULL, CURRENT_DATE + 1)->>'success')::boolean THEN
    v_pass := v_pass + 1;
  ELSE v_fail := v_fail || text 'T5 requisitos por estado'; END IF;

  -- T6: backlog muestra la falla con antigüedad, impacto y responsable
  SELECT count(*) INTO v_n FROM public.vw_maintenance_backlog
  WHERE id = v_req AND impact = 'BLOQUEA_ACTIVO' AND age_days = 0 AND priority_score >= 100
    AND responsible_id IS NOT NULL AND diagnosis = 'Pastillas gastadas';
  IF v_n = 1 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || text 'T6 backlog'; END IF;

  -- T7: conversión a OT (idempotente) con trazabilidad
  v_wo := public.convert_request_to_wo(v_req, v_admin);
  SELECT count(*) INTO v_n FROM public.maintenance_work_orders
  WHERE id = v_wo AND source_type = 'FALLA' AND source_id = v_req AND vehicle_plate = 'ZZF3A1'
    AND vehicle_id IS NOT NULL AND status = 'BORRADOR' AND order_type = 'EMERGENCIA';
  IF v_n = 1 AND public.convert_request_to_wo(v_req, v_admin) = v_wo
     AND (SELECT status FROM public.maintenance_requests WHERE id = v_req) = 'CONVERTIDA_OT' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || text 'T7 conversión a OT'; END IF;

  -- T8: OT cancelada ⇒ la solicitud vuelve al backlog; OT cerrada ⇒ solicitud cerrada
  UPDATE public.maintenance_work_orders SET status = 'CANCELADA' WHERE id = v_wo;
  SELECT status INTO v_status FROM public.maintenance_requests WHERE id = v_req;
  v_wo2 := public.convert_request_to_wo(v_req, v_admin);
  UPDATE public.maintenance_work_orders SET status = 'CERRADA' WHERE id = v_wo2;
  IF v_status = 'VALIDADA' AND v_wo2 <> v_wo
     AND (SELECT status FROM public.maintenance_requests WHERE id = v_req AND closed_at IS NOT NULL) = 'CERRADA'
     AND NOT EXISTS (SELECT 1 FROM public.vw_maintenance_backlog WHERE id = v_req) THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T8 sincronía con OT: tras cancelar=' || COALESCE(v_status, 'NULL')); END IF;

  -- T9: cerrar la falla no libera la unidad (la liberación exige el motor)
  SELECT status INTO v_status FROM public.vehicles WHERE plate = 'ZZF3A1';
  IF v_status = 'BLOQUEADA' THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T9 liberación implícita: ' || v_status); END IF;

  -- T10: inspección con respuesta crítica genera UNA solicitud (sin duplicar ni romper la inspección)
  INSERT INTO public.checklist_templates (name, type) VALUES ('F3 test', 'PRE_TRIP') RETURNING id INTO v_tpl;
  INSERT INTO public.checklist_items (template_id, text, is_critical) VALUES (v_tpl, 'Luces de freno', true) RETURNING id INTO v_item;
  INSERT INTO public.inspections (vehicle_plate, template_id) VALUES ('ZZF3B1', v_tpl) RETURNING id INTO v_insp;
  INSERT INTO public.inspection_results (inspection_id, item_id, response) VALUES (v_insp, v_item, 'NO');
  INSERT INTO public.inspection_results (inspection_id, item_id, response) VALUES (v_insp, v_item, 'NO');
  SELECT count(*) INTO v_n FROM public.maintenance_requests WHERE vehicle_plate = 'ZZF3B1' AND source = 'INSPECCION' AND severity = 'CRITICA';
  IF v_n = 1 AND (SELECT status FROM public.vehicles WHERE plate = 'ZZF3B1') = 'BLOQUEADA'
     AND (SELECT global_result FROM public.inspections WHERE id = v_insp) = 'FAILED' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T10 inspección → falla: n=' || v_n); END IF;

  -- T11: Copiloto AI correctivo ⇒ solicitud COPILOTO_AI; preventivo ⇒ OT BORRADOR
  IF public.can_prepare_ai_maintenance() THEN
    INSERT INTO public.ai_action_proposals (user_id, action_type, payload)
    VALUES (v_admin, 'schedule_maintenance', jsonb_build_object('vehicle_plate', 'ZZF3B1', 'type', 'CORRECTIVO',
            'reason', 'Ruido en suspensión', 'scheduled_date', CURRENT_DATE + 2, 'site_id', v_site))
    RETURNING id INTO v_prop;
    r := public.ai_confirm_maintenance(v_prop);
    INSERT INTO public.ai_action_proposals (user_id, action_type, payload)
    VALUES (v_admin, 'schedule_maintenance', jsonb_build_object('vehicle_plate', 'ZZF3B1', 'type', 'PREVENTIVO',
            'reason', 'Cambio de aceite', 'scheduled_date', CURRENT_DATE + 3, 'site_id', v_site))
    RETURNING id INTO v_prop;
    v_wo := (public.ai_confirm_maintenance(v_prop)->>'maintenance_order_id')::uuid;
    IF EXISTS (SELECT 1 FROM public.maintenance_requests WHERE id = (r->>'maintenance_request_id')::uuid AND source = 'COPILOTO_AI')
       AND EXISTS (SELECT 1 FROM public.maintenance_work_orders WHERE id = v_wo AND status = 'BORRADOR') THEN
      v_pass := v_pass + 1;
    ELSE v_fail := v_fail || ('T11 copiloto: ' || r::text); END IF;
  ELSE
    v_fail := v_fail || text 'T11 el administrador no puede preparar mantenimiento AI';
  END IF;

  -- T12: permisos por rol reales (antes has_tms_permission('mantenimiento') no calzaba con ningún rol)
  SELECT p.id INTO v_sup FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id WHERE ro.name = 'Supervisor de Transporte' LIMIT 1;
  SELECT p.id INTO v_cond FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id WHERE ro.name = 'Conductor' LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_sup::text, true);
  IF v_sup IS NOT NULL AND public.can_manage_fleet_status() AND public.has_cmms_permission('fallas') THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_cond, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_cond::text, true);
    IF NOT public.can_manage_fleet_status() AND NOT public.has_cmms_permission('fallas') THEN v_pass := v_pass + 1;
    ELSE v_fail := v_fail || text 'T12 conductor con permisos de gestión'; END IF;
  ELSE v_fail := v_fail || text 'T12 supervisor de transporte sin permisos CMMS'; END IF;

  -- T13: usuario sin permisos no gestiona fallas
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_nobody, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_nobody::text, true);
  SELECT id INTO v_req2 FROM public.maintenance_requests WHERE vehicle_plate = 'ZZF3B1' AND source = 'INSPECCION';
  r := public.transition_maintenance_request(v_req2, 'VALIDADA');
  v_err := NULL;
  BEGIN
    PERFORM public.convert_request_to_wo(v_req2, v_nobody);
  EXCEPTION WHEN insufficient_privilege THEN v_err := SQLERRM;
  END;
  IF NOT (r->>'success')::boolean AND v_err IS NOT NULL THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T13 sin permisos: ' || r::text); END IF;

  -- T14: RLS — un usuario sin permisos no ve solicitudes; cambio directo de estado rechazado
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_n FROM public.maintenance_requests;
  EXECUTE 'RESET ROLE';
  IF v_n = 0 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T14 RLS lectura: ve ' || v_n); END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_err := NULL;
  BEGIN
    UPDATE public.maintenance_requests SET status = 'CERRADA' WHERE id = v_req2;
  EXCEPTION WHEN insufficient_privilege THEN v_err := SQLERRM;
  END;
  BEGIN
    INSERT INTO public.maintenance_requests (vehicle_plate, description, severity, status)
    VALUES ('ZZF3B1', 'Retrovisor roto', 'baja', 'CERRADA') RETURNING id INTO v_req;
  EXCEPTION WHEN insufficient_privilege THEN v_req := NULL;
  END;
  EXECUTE 'RESET ROLE';
  IF v_err IS NOT NULL
     AND (SELECT status FROM public.maintenance_requests WHERE id = v_req2) = 'REPORTADA'
     AND (SELECT status || '/' || severity || '/' || source FROM public.maintenance_requests WHERE id = v_req) = 'REPORTADA/BAJA/SUPERVISOR' THEN
    v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T15 guard cliente: err=' || COALESCE(v_err, 'ninguno')); END IF;

  -- T16: fuente única — vehicle_failures ya no existe; el checklist pre-ruta tiene su columna
  IF to_regclass('public.vehicle_failures') IS NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'dispatches' AND column_name = 'start_odometer') THEN
    v_pass := v_pass + 1;
  ELSE v_fail := v_fail || text 'T16 fuente única / start_odometer'; END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION 'F3 FAIL (% ok, % fallas): %', v_pass, array_length(v_fail, 1), array_to_string(v_fail, ' || ');
  END IF;
  RAISE EXCEPTION 'F3 PASS (% pruebas)', v_pass;
END
$test$;

ROLLBACK;
