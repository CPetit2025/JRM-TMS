-- C232: salida de la parada, esperas sin superposición (hora del evento y de registro separadas) e incidencias en ruta
-- con catálogo; la causa la confirma alguien distinto de quien reporta. Usa una parada real dentro de la transacción y
-- siempre se revierte.
BEGIN;
DO $test$
DECLARE s record; ok boolean; w1 uuid := gen_random_uuid(); w2 uuid := gen_random_uuid(); w3 uuid := gen_random_uuid();
  inc uuid := gen_random_uuid(); r jsonb; m1 uuid; m2 uuid; p record;
BEGIN
  SELECT dr.dispatch_id, dr.transport_request_id AS request_id, v.profile_id AS driver_profile INTO s
  FROM public.dispatch_requests dr JOIN public.dispatches d ON d.id = dr.dispatch_id JOIN public.drivers v ON v.id = d.driver_id
  JOIN public.profiles pr ON pr.id = v.profile_id
  WHERE v.is_active AND pr.is_active AND coalesce(d.modalidad, 'PROPIA') <> 'TERCERO' ORDER BY d.created_at DESC LIMIT 1;
  IF s.dispatch_id IS NULL THEN RAISE EXCEPTION 'CAJA C232 PASS: sin paradas con conductor para probar (funciones instaladas)'; END IF;
  INSERT INTO public.delivery_conformities(dispatch_id, request_id) VALUES (s.dispatch_id, s.request_id) ON CONFLICT DO NOTHING;
  UPDATE public.delivery_conformities SET arrived_at = now() - interval '1 hour', departed_at = NULL, departed_recorded_at = NULL
  WHERE dispatch_id = s.dispatch_id AND request_id = s.request_id;
  DELETE FROM public.route_stop_waits WHERE dispatch_id = s.dispatch_id AND request_id = s.request_id;

  PERFORM set_config('request.jwt.claim.sub', s.driver_profile::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', s.driver_profile, 'role', 'authenticated')::text, true);
  IF NOT public.route_can_operate(s.dispatch_id) THEN RAISE EXCEPTION 'CAJA C232 FAIL: el conductor del viaje no puede operar su parada'; END IF;

  -- Espera 1 cerrada, registrada con la hora del evento del teléfono
  PERFORM public.route_stop_wait(w1, s.dispatch_id, s.request_id, 'COLA_INGRESO', null, now() - interval '50 minutes');
  PERFORM public.route_stop_wait(w1, s.dispatch_id, s.request_id, null, null, now() - interval '50 minutes', now() - interval '40 minutes');
  IF NOT EXISTS (SELECT 1 FROM public.route_stop_waits WHERE id = w1 AND started_at = now() - interval '50 minutes' AND ended_at = now() - interval '40 minutes'
    AND recorded_at = now()) THEN RAISE EXCEPTION 'CAJA C232 FAIL: la espera no guardó hora del evento y de registro por separado'; END IF;
  -- Superposición
  BEGIN PERFORM public.route_stop_wait(w2, s.dispatch_id, s.request_id, 'DOCUMENTOS', null, now() - interval '45 minutes'); ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C232 FAIL: aceptó una espera superpuesta'; END IF;
  BEGIN PERFORM public.route_stop_wait(w2, s.dispatch_id, s.request_id, 'OTRO', '', now() - interval '35 minutes'); ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C232 FAIL: aceptó motivo OTRO sin descripción'; END IF;
  -- Espera abierta impide la salida
  PERFORM public.route_stop_wait(w3, s.dispatch_id, s.request_id, 'CARGA_NO_PREPARADA', null, now() - interval '30 minutes');
  BEGIN PERFORM public.delivery_depart_at(s.dispatch_id, s.request_id, now() - interval '10 minutes'); ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C232 FAIL: registró la salida con una espera abierta'; END IF;
  PERFORM public.route_stop_wait(w3, s.dispatch_id, s.request_id, null, null, null, now() - interval '20 minutes');
  r := public.delivery_depart_at(s.dispatch_id, s.request_id, now() - interval '10 minutes');
  IF NOT EXISTS (SELECT 1 FROM public.delivery_conformities WHERE dispatch_id = s.dispatch_id AND request_id = s.request_id
    AND departed_at = now() - interval '10 minutes' AND departed_recorded_at = now()) THEN RAISE EXCEPTION 'CAJA C232 FAIL: salida sin hora del evento o de registro'; END IF;
  r := public.delivery_depart_at(s.dispatch_id, s.request_id, now());
  IF NOT coalesce((r->>'already')::boolean, false) THEN RAISE EXCEPTION 'CAJA C232 FAIL: una segunda salida cambió la primera'; END IF;
  BEGIN PERFORM public.route_stop_wait(gen_random_uuid(), s.dispatch_id, s.request_id, 'COLA_INGRESO', null, now() - interval '5 minutes'); ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C232 FAIL: aceptó una espera después de la salida'; END IF;
  IF jsonb_array_length(public.route_stop_times(s.dispatch_id, s.request_id)->'waits') <> 2 THEN RAISE EXCEPTION 'CAJA C232 FAIL: tiempos de la parada incompletos'; END IF;

  -- Incidencia con catálogo; repetir la operación no duplica
  BEGIN PERFORM public.route_incident_report(gen_random_uuid(), s.dispatch_id, s.request_id, 'LLANTA', 'Pinchazo en ruta', null, now()); ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C232 FAIL: aceptó un tipo de incidencia fuera del catálogo'; END IF;
  PERFORM public.route_incident_report(inc, s.dispatch_id, s.request_id, 'DANO', 'Caja golpeada al descargar', 'CLIENTE', now() - interval '15 minutes');
  PERFORM public.route_incident_report(inc, s.dispatch_id, s.request_id, 'DANO', 'Caja golpeada al descargar', 'CLIENTE', now() - interval '15 minutes');
  IF (SELECT count(*) FROM public.route_incidents WHERE id = inc) <> 1 OR (SELECT count(*) FROM public.dispatch_events WHERE payload->>'route_incident_id' = inc::text) <> 1 THEN
    RAISE EXCEPTION 'CAJA C232 FAIL: la incidencia se duplicó o no quedó en el historial del viaje'; END IF;
  -- El conductor no gestiona ni confirma la causa
  BEGIN PERFORM public.route_incident_update(inc, 'CERRADA', 'Se repuso', 'Supervisor', 'CLIENTE'); ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  IF ok AND NOT public.route_incident_can_manage(s.dispatch_id) THEN RAISE EXCEPTION 'CAJA C232 FAIL: el conductor gestionó la incidencia'; END IF;
  -- La restricción impide que confirme quien reportó, aunque se escriba directo en la tabla
  BEGIN UPDATE public.route_incidents SET confirmed_by = reported_by, confirmed_cause = 'CLIENTE' WHERE id = inc; ok := true;
  EXCEPTION WHEN check_violation THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C232 FAIL: la tabla aceptó que confirme quien reportó'; END IF;

  -- Dos gestores distintos: si el reportante es gestor, no puede confirmar; otro sí
  FOR p IN SELECT pr.id FROM public.profiles pr WHERE pr.is_active AND pr.id <> s.driver_profile LOOP
    PERFORM set_config('request.jwt.claim.sub', p.id::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', p.id, 'role', 'authenticated')::text, true);
    IF public.route_incident_can_manage(s.dispatch_id) THEN IF m1 IS NULL THEN m1 := p.id; ELSE m2 := p.id; EXIT; END IF; END IF;
  END LOOP;
  IF m2 IS NULL THEN RAISE EXCEPTION 'CAJA C232 PASS: esperas, salida e incidencias con catálogo (sin dos gestores para probar la confirmación)'; END IF;
  UPDATE public.route_incidents SET reported_by = m1 WHERE id = inc;
  PERFORM set_config('request.jwt.claim.sub', m1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', m1, 'role', 'authenticated')::text, true);
  BEGIN PERFORM public.route_incident_update(inc, 'EN_ATENCION', 'Revisando', 'Supervisor', 'CLIENTE'); ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C232 FAIL: quien reportó confirmó la causa'; END IF;
  PERFORM public.route_incident_update(inc, 'EN_ATENCION', 'Revisando con el cliente', 'Supervisor de Transporte', null);
  PERFORM set_config('request.jwt.claim.sub', m2::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', m2, 'role', 'authenticated')::text, true);
  BEGIN PERFORM public.route_incident_update(inc, 'CERRADA', null, 'Supervisor', 'CLIENTE'); ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C232 FAIL: cerró sin acción tomada'; END IF;
  PERFORM public.route_incident_update(inc, 'CERRADA', 'Se repuso la caja con nota de crédito', 'Supervisor de Transporte', 'ALMACEN_JRM');
  IF NOT EXISTS (SELECT 1 FROM public.route_incidents WHERE id = inc AND status = 'CERRADA' AND confirmed_by = m2 AND reported_cause = 'CLIENTE'
    AND confirmed_cause = 'ALMACEN_JRM' AND closed_at IS NOT NULL) THEN RAISE EXCEPTION 'CAJA C232 FAIL: no separó la causa reportada de la confirmada'; END IF;
  RAISE EXCEPTION 'CAJA C232 PASS: salida y esperas sin superposición con hora del evento y de registro; incidencias con catálogo y causa confirmada por otra persona';
END $test$;
ROLLBACK;
