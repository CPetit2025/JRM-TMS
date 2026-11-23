-- C243: reporte FR-DT.004. Una fila por parada no anulada del período (conciliado con una consulta escrita aparte), fórmulas
-- del formato, equivalencia del tipo de actividad, fuente del km en el cliente y ocupación validada. Datos reales; se revierte.
BEGIN;
DO $test$
DECLARE adm uuid; rep jsonb; n_fuente int; desde date := (now() AT TIME ZONE 'America/Lima')::date - 30; hasta date := (now() AT TIME ZONE 'America/Lima')::date;
  x jsonb; r record; ok boolean;
BEGIN
  SELECT p.id INTO adm FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id WHERE p.is_active AND ro.name = 'Administrador' ORDER BY p.id LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub', adm::text, true); PERFORM set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  rep := public.fr_dt_004_report(desde, hasta);
  SELECT count(*) INTO n_fuente FROM public.dispatches d JOIN public.dispatch_requests dr ON dr.dispatch_id = d.id
  WHERE d.status <> 'CANCELADO' AND coalesce(dr.status, '') NOT IN ('CANCELADO', 'RETIRADO')
    AND ((coalesce(d.departure_time, d.start_odometer_at, d.tercero_salida_at, d.scheduled_departure)) AT TIME ZONE 'America/Lima')::date BETWEEN desde AND hasta;
  IF jsonb_array_length(rep) <> n_fuente THEN RAISE EXCEPTION 'CAJA C243 FAIL: % filas frente a % paradas de la fuente', jsonb_array_length(rep), n_fuente; END IF;

  FOR x IN SELECT * FROM jsonb_array_elements(rep) LOOP
    IF (x->>'km_cliente') IS NOT NULL AND (x->>'km_inicial') IS NOT NULL AND (x->>'km_recorridos')::numeric <> (x->>'km_cliente')::numeric - (x->>'km_inicial')::numeric THEN
      RAISE EXCEPTION 'CAJA C243 FAIL: km recorridos mal calculados en %', x->>'solicitud'; END IF;
    IF (x->>'km_cliente') IS NOT NULL AND x->>'km_cliente_fuente' NOT IN ('ODOMETRO', 'GPS') THEN RAISE EXCEPTION 'CAJA C243 FAIL: km en el cliente sin fuente (%)', x->>'solicitud'; END IF;
    IF x->>'tipo_actividad' NOT IN ('DESPACHO DE CONTRATOS', 'RECOJO DE ORDENES DE COMPRA', 'ENVIO O RECOJO DE SERVICIOS') THEN RAISE EXCEPTION 'CAJA C243 FAIL: tipo de actividad %', x->>'tipo_actividad'; END IF;
    IF x->>'modalidad' = 'TERCERO' AND (x->>'marca') IS NOT NULL THEN RAISE EXCEPTION 'CAJA C243 FAIL: tercero con marca de flota propia'; END IF;
  END LOOP;

  -- Equivalencia de actividad y km de odómetro contra la solicitud original
  SELECT t.request_number, t.request_type, t.reference_type INTO r FROM public.dispatches d JOIN public.dispatch_requests dr ON dr.dispatch_id = d.id JOIN public.transport_requests t ON t.id = dr.transport_request_id
  WHERE t.request_type = 'RECOJO' AND t.reference_type = 'OC' AND d.status <> 'CANCELADO'
    AND ((coalesce(d.departure_time, d.start_odometer_at, d.tercero_salida_at, d.scheduled_departure)) AT TIME ZONE 'America/Lima')::date BETWEEN desde AND hasta LIMIT 1;
  IF r.request_number IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(rep) y WHERE y->>'solicitud' = r.request_number AND y->>'tipo_actividad' = 'RECOJO DE ORDENES DE COMPRA') THEN
    RAISE EXCEPTION 'CAJA C243 FAIL: recojo con OC % no sale como RECOJO DE ORDENES DE COMPRA', r.request_number; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(rep) y JOIN public.transport_requests t ON t.request_number = y->>'solicitud'
             JOIN public.dispatch_requests dr ON dr.transport_request_id = t.id AND dr.stop_odometer > 0
             WHERE y->>'km_cliente_fuente' IS DISTINCT FROM 'ODOMETRO' AND (SELECT dd.dispatch_number FROM public.dispatches dd WHERE dd.id = dr.dispatch_id)::text = y->>'viaje') THEN
    RAISE EXCEPTION 'CAJA C243 FAIL: con odómetro de parada no se usa el odómetro'; END IF;

  -- Filtrar por placa no cambia los datos de las filas que quedan
  SELECT y->>'placa' p INTO r FROM jsonb_array_elements(rep) y WHERE y->>'placa' IS NOT NULL AND y->>'modalidad' = 'PROPIA' LIMIT 1;
  IF r.p IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(public.fr_dt_004_report(desde, hasta, r.p)) z WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(rep) y WHERE y = z)) THEN
    RAISE EXCEPTION 'CAJA C243 FAIL: el filtro por placa cambió los datos de una fila'; END IF;
  -- Ocupación: fuera de 1–100 se rechaza
  SELECT dispatch_id INTO r FROM public.dispatch_requests LIMIT 1;
  BEGIN PERFORM public.dispatch_set_occupancy(r.dispatch_id, '[{"request_id":"00000000-0000-0000-0000-000000000000","pct":0}]'); ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C243 FAIL: aceptó ocupación 0 %%'; END IF;
  RAISE EXCEPTION 'CAJA C243 PASS: % paradas conciliadas con la fuente; fórmulas, actividad, fuente del km y ocupación validadas', n_fuente;
END $test$;
ROLLBACK;
