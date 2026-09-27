-- Pruebas FASE 9 — Cumplimiento vehicular.
-- Termina siempre en error para forzar ROLLBACK: "F9 PASS (...)" o "F9 FAIL: ...".
--   npx supabase db query --linked -f supabase/tests/f9_cumplimiento.test.sql
BEGIN;

DO $test$
DECLARE
  v_admin   uuid;
  v_nobody  uuid := gen_random_uuid();
  v_carrier uuid;
  v_site    uuid;
  v_veh     uuid;
  v_veh2    uuid;
  v_drv     uuid;
  v_drv2    uuid;
  v_disp    uuid;
  v_fine    uuid;
  v_fine2   uuid;
  v_inc     uuid;
  v_today   date := (now() AT TIME ZONE 'America/Lima')::date;
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
  IF v_admin IS NULL THEN RAISE EXCEPTION 'F9 FAIL: no hay administrador'; END IF;

  INSERT INTO public.drivers (carrier_id, first_name, last_name, document_number, license_number, is_active)
  VALUES (v_carrier, 'Juan', 'Prueba', 'ZZ90000001', 'Q-ZZ1', true) RETURNING id INTO v_drv;
  INSERT INTO public.drivers (carrier_id, first_name, last_name, document_number, license_number, is_active)
  VALUES (v_carrier, 'Pedro', 'Inactivo', 'ZZ90000002', 'Q-ZZ2', false) RETURNING id INTO v_drv2;

  -- T1: el SOAT/RT del alta se convierte en documento; el espejo en el vehículo es de solo lectura
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, brand, soat_expiration, technical_review_expiration, current_odometer)
  VALUES ('ZZF9A1', v_carrier, v_site, 'CAMION', 'TEST', v_today + 10, v_today + 200, 1000) RETURNING id INTO v_veh;
  v_err := NULL;
  BEGIN
    UPDATE public.vehicles SET soat_expiration = v_today + 999 WHERE id = v_veh;
  EXCEPTION WHEN insufficient_privilege THEN v_err := SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  SELECT count(*) INTO v_n FROM public.vehicle_documents WHERE vehicle_id = v_veh AND is_active;
  IF v_n = 2 AND v_err LIKE '%Documentos%' THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 documentos del alta: ' || v_n || ' ' || COALESCE(v_err, 'update aceptado')); END IF;

  -- T2: SOAT por vencer ⇒ alerta POR_VENCER y observación del motor
  IF (SELECT status FROM public.vw_document_alerts WHERE vehicle_id = v_veh AND document_type = 'SOAT') = 'POR_VENCER'
     AND public.check_asset_eligibility('ZZF9A1')->>'status' IN ('APTO_CON_OBSERVACION') THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T2 por vencer: ' || (public.check_asset_eligibility('ZZF9A1'))::text); END IF;

  -- T3: renovación desactiva el anterior y actualiza el espejo
  INSERT INTO public.vehicle_documents (vehicle_id, document_type, document_number, issue_date, expiration_date, issuer)
  VALUES (v_veh, 'SOAT', 'SOAT-2027', v_today, v_today + 365, 'RIMAC');
  IF (SELECT count(*) FROM public.vehicle_documents WHERE vehicle_id = v_veh AND document_type = 'SOAT' AND is_active) = 1
     AND (SELECT soat_expiration FROM public.vehicles WHERE id = v_veh) = v_today + 365
     AND (SELECT status FROM public.vw_document_alerts WHERE vehicle_id = v_veh AND document_type = 'SOAT') = 'VIGENTE' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || text 'T3 renovación'; END IF;

  -- T4: documento vencido ⇒ NO_APTO (fecha crítica alimenta el motor)
  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, brand, status, current_odometer) VALUES ('ZZF9B1', v_carrier, v_site, 'CAMION', 'TEST', 'MANTENIMIENTO', 1000) RETURNING id INTO v_veh2;
  INSERT INTO public.vehicle_documents (vehicle_id, document_type, expiration_date) VALUES (v_veh2, 'SOAT', v_today + 100), (v_veh2, 'REVISION_TECNICA', v_today - 1);
  r := public.check_asset_eligibility('ZZF9B1');
  IF r->>'status' = 'NO_APTO' AND r::text LIKE '%Revisión técnica vencida%'
     AND NOT (public.transition_vehicle_status('ZZF9B1', 'DISPONIBLE', 'prueba')->>'success')::boolean THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T4 documento vencido: ' || r::text); END IF;

  -- T5: conductor: inactivo bloquea; licencia registrada sincroniza; licencia especial vencida bloquea
  INSERT INTO public.driver_documents (driver_id, doc_type, doc_number, category, expiry_date) VALUES (v_drv, 'LICENCIA', 'Q-NEW', 'A-IIIc', v_today + 400);
  r := public.check_driver_eligibility(v_drv);
  v_err := public.check_driver_eligibility(v_drv2)->>'status';
  INSERT INTO public.driver_documents (driver_id, doc_type, expiry_date) VALUES (v_drv, 'CERTIFICADO_MATPEL', v_today - 1);
  IF r->>'status' = 'APTO_CON_OBSERVACION' AND r::text LIKE '%Examen médico no registrado%' AND v_err = 'BLOQUEADO'
     AND (SELECT license_expiration || '/' || license_number FROM public.drivers WHERE id = v_drv) = (v_today + 400) || '/Q-NEW'
     AND public.check_driver_eligibility(v_drv)->>'status' = 'BLOQUEADO' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T5 conductor: ' || r::text); END IF;
  UPDATE public.driver_documents SET is_active = false WHERE driver_id = v_drv AND doc_type = 'CERTIFICADO_MATPEL';

  -- T6: multa: infiere viaje y conductor; papeleta única por entidad; vencida al registrarse fuera de plazo
  INSERT INTO public.dispatches (dispatch_number, vehicle_plate, driver_id, status, site_id, departure_time)
  VALUES ('ZZ-F9-1', 'ZZF9A1', v_drv, 'EN_CURSO', v_site, now() - interval '5 hours') RETURNING id INTO v_disp;
  INSERT INTO public.traffic_fines (vehicle_id, infraction_date, infraction_code, entity, ticket_number, amount, due_date, fine_type)
  VALUES (v_veh, now() - interval '2 hours', 'G-58', 'sat lima', 'pap-001', 480, v_today + 15, 'PAPELETA') RETURNING id INTO v_fine;
  INSERT INTO public.traffic_fines (vehicle_id, infraction_date, entity, ticket_number, amount, due_date, responsibility)
  VALUES (v_veh, now() - interval '40 days', 'SUTRAN', 'ACTA-9', 1200, v_today - 5, 'EMPRESA') RETURNING id INTO v_fine2;
  v_err := NULL;
  BEGIN
    INSERT INTO public.traffic_fines (vehicle_id, infraction_date, entity, ticket_number, amount) VALUES (v_veh, now(), 'SAT LIMA', 'PAP-001', 10);
  EXCEPTION WHEN unique_violation THEN v_err := 'dup';
  END;
  SELECT dispatch_id, driver_id, entity, ticket_number, status INTO w FROM public.traffic_fines WHERE id = v_fine;
  IF w.dispatch_id = v_disp AND w.driver_id = v_drv AND w.entity = 'SAT LIMA' AND w.status = 'PENDIENTE' AND v_err = 'dup'
     AND (SELECT status FROM public.traffic_fines WHERE id = v_fine2) = 'VENCIDA' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T6 multa: ' || row_to_json(w)::text || ' ' || COALESCE(v_err, '')); END IF;

  -- T7: estados de la multa con requisitos; sin cambio directo
  v_err := (public.transition_traffic_fine(v_fine, 'PAGADA', NULL, 480, NULL, 'OP-1')->>'error');     -- sin responsabilidad
  r := public.transition_traffic_fine(v_fine, 'APELACION', NULL);                                        -- sin sustento
  IF v_err LIKE '%responsabilidad%' AND NOT (r->>'success')::boolean
     AND (public.transition_traffic_fine(v_fine, 'APELACION', 'Descargo presentado')->>'success')::boolean
     AND (public.transition_traffic_fine(v_fine, 'PAGADA', 'Apelación denegada', 480, v_today, 'OP-778', 'CONDUCTOR')->>'success')::boolean
     AND NOT (public.transition_traffic_fine(v_fine, 'PENDIENTE')->>'success')::boolean THEN
    EXECUTE 'SET LOCAL ROLE authenticated';
    v_err := NULL;
    BEGIN
      UPDATE public.traffic_fines SET status = 'ANULADA' WHERE id = v_fine2;
    EXCEPTION WHEN insufficient_privilege THEN v_err := 'guard';
    END;
    EXECUTE 'RESET ROLE';
    IF v_err = 'guard' THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || text 'T7 cambio directo de estado aceptado'; END IF;
  ELSE v_fail := v_fail || ('T7 estados: ' || COALESCE(v_err, '') || ' ' || r::text); END IF;

  -- T8: vencimiento diario automático y costos de cumplimiento por activo
  INSERT INTO public.traffic_fines (vehicle_id, infraction_date, entity, ticket_number, amount, due_date)
  VALUES (v_veh, now(), 'MUNI', 'X-1', 100, v_today + 1);
  UPDATE public.traffic_fines SET due_date = v_today - 1 WHERE ticket_number = 'X-1';
  v_n := public.expire_traffic_fines();
  PERFORM public.transition_traffic_fine(v_fine2, 'PAGADA', NULL, 1200, v_today, 'OP-2');
  SELECT * INTO w FROM public.vw_compliance_costs WHERE vehicle_id = v_veh;
  IF v_n >= 1 AND (SELECT status FROM public.traffic_fines WHERE ticket_number = 'X-1') = 'VENCIDA'
     AND w.fines_company_cost = 1200 AND w.fines_driver_charged = 480 AND w.fines_outstanding = 100 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T8 costos/vencimiento: ' || row_to_json(w)::text || ' n=' || v_n); END IF;

  -- T9: multa pendiente del conductor ⇒ observación en su elegibilidad
  INSERT INTO public.traffic_fines (vehicle_id, driver_id, infraction_date, entity, ticket_number, amount, responsibility)
  VALUES (v_veh, v_drv, now(), 'SAT LIMA', 'PAP-002', 200, 'CONDUCTOR');
  IF public.check_driver_eligibility(v_drv)::text LIKE '%multa(s) pendiente(s)%' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || text 'T9 multa en elegibilidad del conductor'; END IF;

  -- T10: siniestro con daño ⇒ falla CRITICA ⇒ unidad bloqueada; cierre exige costo y responsabilidad
  INSERT INTO public.vehicle_incidents (incident_type, severity, vehicle_id, occurred_at, description, vehicle_damage, estimated_cost, insurance_coverage)
  VALUES ('ACCIDENTE', 'CRITICA', v_veh, now() - interval '1 hour', 'Choque lateral en Panamericana Sur', true, 8000, 5000) RETURNING id INTO v_inc;
  v_err := NULL;
  BEGIN
    UPDATE public.vehicle_incidents SET status = 'CERRADO' WHERE id = v_inc;
  EXCEPTION WHEN raise_exception THEN v_err := 'cierre';
  END;
  UPDATE public.vehicle_incidents SET status = 'CERRADO', final_cost = 9000, responsibility = 'TERCERO' WHERE id = v_inc;
  SELECT * INTO w FROM public.vehicle_incidents WHERE id = v_inc;
  IF w.maintenance_request_id IS NOT NULL AND w.dispatch_id = v_disp AND w.driver_id = v_drv AND v_err = 'cierre' AND w.closed_at IS NOT NULL
     AND (SELECT severity FROM public.maintenance_requests WHERE id = w.maintenance_request_id) = 'CRITICA'
     AND (SELECT status FROM public.vehicles WHERE id = v_veh) = 'BLOQUEADA'
     AND (SELECT incidents_net_cost FROM public.vw_compliance_costs WHERE vehicle_id = v_veh) = 0 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T10 siniestro: ' || row_to_json(w)::text); END IF;

  -- T11: alertas unificadas
  SELECT count(DISTINCT alert_type) INTO v_n FROM public.vw_compliance_alerts WHERE subject IN ('ZZF9A1', 'ZZF9B1', 'Juan Prueba');
  IF v_n >= 2 AND EXISTS (SELECT 1 FROM public.vw_compliance_alerts WHERE alert_type = 'DOCUMENTO_VEHICULO' AND subject = 'ZZF9B1' AND level = 'VENCIDO') THEN
    v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T11 alertas: ' || v_n); END IF;

  -- T12: pg_cron agenda el vencimiento de multas
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cmms-expire-traffic-fines') THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || text 'T12 cron de multas'; END IF;

  -- T13: sin permisos no ve documentos, multas ni siniestros, ni registra multas
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_nobody, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_nobody::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT (SELECT count(*) FROM public.vehicle_documents) + (SELECT count(*) FROM public.traffic_fines) + (SELECT count(*) FROM public.vehicle_incidents)
       + (SELECT count(*) FROM public.driver_documents) INTO v_n;
  v_err := NULL;
  BEGIN
    INSERT INTO public.traffic_fines (vehicle_id, infraction_date, entity, ticket_number, amount) VALUES (v_veh, now(), 'X', 'Y', 1);
  EXCEPTION WHEN insufficient_privilege THEN v_err := 'rls';
  END;
  EXECUTE 'RESET ROLE';
  IF v_n = 0 AND v_err = 'rls' AND NOT (public.transition_traffic_fine(v_fine2, 'ANULADA', 'x')->>'success')::boolean THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T13 permisos: ve ' || v_n || ' ' || COALESCE(v_err, 'insert aceptado')); END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION 'F9 FAIL (% ok, % fallas): %', v_pass, array_length(v_fail, 1), array_to_string(v_fail, ' || ');
  END IF;
  RAISE EXCEPTION 'F9 PASS (% pruebas)', v_pass;
END
$test$;

ROLLBACK;
