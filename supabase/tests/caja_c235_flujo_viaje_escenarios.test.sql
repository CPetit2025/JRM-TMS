-- C235: flujo integral de un viaje propio con dos paradas (escenarios §49 de Transporte): odómetro de salida y llegada con
-- foto, espera por carga no preparada, documento faltante y avería en ruta como incidencias, reintentos sin duplicar,
-- entrega parcial (OTIF no completa) y costos pendientes (costo por km sin dato). La anulación de factura de flete está en C233.
-- Usa solicitudes reales enlazadas a un viaje creado dentro de la transacción y siempre se revierte.
BEGIN;
-- Cambio de estado como sesión de usuario de oficina (no el conductor): el preuso del día no es objeto de esta prueba
CREATE FUNCTION pg_temp.c235_set(p uuid, s text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE a text := current_setting('request.jwt.claim.sub', true); b text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000000', true);
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000000","role":"authenticated"}', true);
  UPDATE public.dispatches SET status = s WHERE id = p;
  PERFORM set_config('request.jwt.claim.sub', a, true); PERFORM set_config('request.jwt.claims', b, true);
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.c235_set(uuid, text) TO authenticated;
DO $test$
DECLARE drv record; did uuid; q1 uuid; q2 uuid; ph1 text; ph2 text; i1 uuid := gen_random_uuid(); i2 uuid := gen_random_uuid(); w uuid := gen_random_uuid();
  r jsonb; d record; f record; v_plate text;
BEGIN
  SELECT v.id, v.profile_id INTO drv FROM public.drivers v JOIN public.profiles pr ON pr.id = v.profile_id
  WHERE v.is_active AND pr.is_active AND NOT EXISTS (SELECT 1 FROM public.vehicles ve WHERE ve.assigned_driver_id = v.id)
    AND NOT EXISTS (SELECT 1 FROM public.dispatches x WHERE x.driver_id = v.id
    AND x.status NOT IN ('CIERRE_OPERATIVO','RETORNO_COMPLETADO','CANCELADO','ENTREGADO')) LIMIT 1;
  SELECT t.id INTO q1 FROM public.transport_requests t WHERE t.required_date IS NOT NULL AND upper(coalesce(t.status, '')) = 'ENTREGADA'
    AND NOT EXISTS (SELECT 1 FROM public.delivery_rejections j WHERE j.request_id = t.id) ORDER BY t.created_at DESC LIMIT 1;
  SELECT t.id INTO q2 FROM public.transport_requests t WHERE t.required_date IS NOT NULL AND upper(coalesce(t.status, '')) = 'ENTREGADA' AND t.id <> q1
    AND NOT EXISTS (SELECT 1 FROM public.delivery_rejections j WHERE j.request_id = t.id) ORDER BY t.created_at DESC LIMIT 1;
  IF drv.id IS NULL OR q2 IS NULL THEN RAISE EXCEPTION 'CAJA C235 PASS: sin conductor libre o solicitudes para el flujo (funciones instaladas)'; END IF;
  v_plate := 'C235-TEST';
  INSERT INTO public.dispatches(driver_id, vehicle_plate, status, modalidad, scheduled_departure) VALUES (drv.id, v_plate, 'PROGRAMADO', 'PROPIA', now()) RETURNING id INTO did;
  INSERT INTO public.dispatch_requests(dispatch_id, transport_request_id, sequence_order) VALUES (did, q1, 1), (did, q2, 2);
  ph1 := drv.profile_id || '/c235/salida.jpg'; ph2 := drv.profile_id || '/c235/llegada.jpg';
  INSERT INTO storage.objects(bucket_id, name, owner) VALUES ('driver_evidence', ph1, drv.profile_id), ('driver_evidence', ph2, drv.profile_id);

  PERFORM set_config('request.jwt.claim.sub', drv.profile_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', drv.profile_id, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  PERFORM public.dispatch_record_odometer(did, 'SALIDA', 5000, ph1);
  PERFORM pg_temp.c235_set(did, 'EN RUTA');

  -- Parada 1: espera por carga no preparada, documento faltante (reintento de la misma operación) y salida
  PERFORM set_config('role', 'postgres', true);
  -- Llegadas y guías aprobadas por el Supervisor (la validación de guías tiene sus propias cajas)
  INSERT INTO public.delivery_conformities(dispatch_id, request_id, arrived_at, state) VALUES (did, q1, now() - interval '3 hours', 'VALIDADA'), (did, q2, now() - interval '90 minutes', 'VALIDADA')
  ON CONFLICT (dispatch_id, request_id) DO UPDATE SET arrived_at = EXCLUDED.arrived_at, departed_at = NULL, state = 'VALIDADA';
  PERFORM set_config('role', 'authenticated', true);
  PERFORM public.route_stop_wait(w, did, q1, 'CARGA_NO_PREPARADA', null, now() - interval '170 minutes');
  PERFORM public.route_stop_wait(w, did, q1, null, null, now() - interval '170 minutes', now() - interval '140 minutes');
  PERFORM public.route_incident_report(i1, did, q1, 'FALTA_DOCUMENTOS', 'Cliente sin orden de compra impresa', 'CLIENTE', now() - interval '150 minutes');
  PERFORM public.route_incident_report(i1, did, q1, 'FALTA_DOCUMENTOS', 'Cliente sin orden de compra impresa', 'CLIENTE', now() - interval '150 minutes');
  PERFORM public.delivery_depart_at(did, q1, now() - interval '130 minutes');
  -- Parada 2: avería en ruta y salida reintentada (conserva la primera)
  PERFORM public.route_incident_report(i2, did, q2, 'AVERIA', 'Luz de motor encendida, se continúa con precaución', 'TRANSPORTE_JRM', now() - interval '100 minutes');
  PERFORM public.delivery_depart_at(did, q2, now() - interval '60 minutes');
  r := public.delivery_depart_at(did, q2, now() - interval '30 minutes');
  IF NOT coalesce((r->>'already')::boolean, false) THEN RAISE EXCEPTION 'CAJA C235 FAIL: el reintento de la salida cambió la primera'; END IF;
  IF (SELECT count(*) FROM public.route_incidents WHERE dispatch_id = did) <> 2 OR (SELECT count(*) FROM public.route_stop_waits WHERE dispatch_id = did) <> 1 THEN
    RAISE EXCEPTION 'CAJA C235 FAIL: los reintentos duplicaron incidencias o esperas'; END IF;
  PERFORM set_config('role', 'postgres', true);
  IF (SELECT count(*) FROM public.dispatch_events WHERE dispatch_id = did AND event_type = 'SALIDA_CLIENTE') <> 2 THEN RAISE EXCEPTION 'CAJA C235 FAIL: salidas en el historial del viaje (%)', (SELECT string_agg(event_type, ',') FROM public.dispatch_events WHERE dispatch_id = did); END IF;

  -- Vuelta a base con odómetro (el reintento no cambia la lectura)
  PERFORM set_config('role', 'authenticated', true);
  PERFORM pg_temp.c235_set(did, 'RETORNO');
  PERFORM public.dispatch_record_odometer(did, 'LLEGADA', 5120, ph2);
  r := public.dispatch_record_odometer(did, 'LLEGADA', 5999, ph2);
  IF NOT coalesce((r->>'already')::boolean, false) THEN RAISE EXCEPTION 'CAJA C235 FAIL: el reintento cambió la lectura de llegada'; END IF;
  PERFORM pg_temp.c235_set(did, 'RETORNO_COMPLETADO');
  PERFORM set_config('role', 'postgres', true);
  SELECT * INTO d FROM public.dispatches WHERE id = did;
  IF d.actual_distance_km <> 120 OR d.actual_distance_source <> 'ODOMETRO' THEN RAISE EXCEPTION 'CAJA C235 FAIL: km del viaje % fuente %', d.actual_distance_km, d.actual_distance_source; END IF;

  -- Entrega parcial en la parada 2: llegó a tiempo y con guía validada, pero no completa → no es OTIF
  UPDATE public.delivery_conformities SET state = 'VALIDADA' WHERE dispatch_id = did;
  INSERT INTO public.delivery_rejections(operation_id, dispatch_id, request_id, kind, reason_code, photos, captured_at, missing_lines)
  VALUES (gen_random_uuid(), did, q2, 'PARCIAL', 'OTRO', ARRAY[drv.profile_id || '/c235/rechazo.jpg'], now(), '[{"descripcion":"Perno 3/4","cantidad":4}]');
  SELECT * INTO f FROM public.kpi_eq_filas('D7', public.kpi_eq_hoy() - 1, public.kpi_eq_hoy()) x WHERE x.ref = q2::text;
  IF f.ref IS NULL OR f.num <> 0 OR f.dims->>'rechazo' <> 'PARCIAL' THEN RAISE EXCEPTION 'CAJA C235 FAIL: la entrega parcial contó como OTIF'; END IF;

  -- Costos pendientes: el costo por km del viaje queda sin dato; incidencias por viaje con causa sin confirmar
  INSERT INTO public.dispatch_expenses(dispatch_id, driver_id, expense_type, amount, description, created_by, client_operation_id)
  VALUES (did, drv.id, 'PEAJE', 25, 'Peaje C235', drv.profile_id, gen_random_uuid());
  UPDATE public.dispatches SET returned_at = now() WHERE id = did;
  SELECT * INTO f FROM public.kpi_eq_filas('T8', public.kpi_eq_hoy(), public.kpi_eq_hoy()) x WHERE x.ref = did::text;
  IF f.ref IS NULL OR f.con_dato OR (f.dims->>'gastos_pendientes')::int <> 1 THEN RAISE EXCEPTION 'CAJA C235 FAIL: costos pendientes no dejan el costo por km sin dato'; END IF;
  IF (SELECT count(*) FROM public.kpi_eq_filas('T7', public.kpi_eq_hoy() - 1, public.kpi_eq_hoy()) x WHERE x.dims->>'causa_confirmada' = 'SIN_CONFIRMAR'
      AND x.ref IN (i1::text, i2::text)) <> 2 THEN RAISE EXCEPTION 'CAJA C235 FAIL: incidencias sin confirmar en el indicador'; END IF;
  RAISE EXCEPTION 'CAJA C235 PASS: viaje propio de dos paradas con odómetro, espera por carga, documento faltante, avería, reintentos sin duplicar, entrega parcial fuera de OTIF y costos pendientes sin dato';
END $test$;
ROLLBACK;
