-- C233: km del viaje por odómetro con foto (salida y llegada obligatorias en sesiones de usuario), GPS como control con
-- marca de observado, fuente del km registrada; factura de flete de terceros con IGV y moneda aparte. Siempre se revierte.
BEGIN;
-- Cambio de estado como lo hace una RPC de la app (definer, sesión de usuario)
CREATE FUNCTION pg_temp.c233_set(p uuid, s text, km numeric DEFAULT NULL, odo numeric DEFAULT NULL) RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE public.dispatches SET status = coalesce(s, status), actual_distance_km = coalesce(km, actual_distance_km), start_odometer = coalesce(odo, start_odometer) WHERE id = p
$$;
GRANT EXECUTE ON FUNCTION pg_temp.c233_set(uuid, text, numeric, numeric) TO authenticated;
DO $test$
DECLARE drv record; did uuid; ok boolean; msg text; ph1 text; ph2 text; d record; m uuid; t record; r jsonb; p record;
BEGIN
  SELECT v.id, v.profile_id INTO drv FROM public.drivers v JOIN public.profiles pr ON pr.id = v.profile_id
  WHERE v.is_active AND pr.is_active AND NOT EXISTS (SELECT 1 FROM public.dispatches x WHERE x.driver_id = v.id
    AND x.status NOT IN ('CIERRE_OPERATIVO','RETORNO_COMPLETADO','CANCELADO','ENTREGADO')) LIMIT 1;
  IF drv.id IS NULL THEN RAISE EXCEPTION 'CAJA C233 PASS: sin conductor libre para probar (funciones instaladas)'; END IF;
  INSERT INTO public.dispatches(driver_id, vehicle_plate, status, modalidad, scheduled_departure)
  VALUES (drv.id, coalesce((SELECT plate FROM public.vehicles WHERE assigned_driver_id = drv.id LIMIT 1), 'C233-TEST'), 'PROGRAMADO', 'PROPIA', now()) RETURNING id INTO did;
  ph1 := drv.profile_id || '/c233/salida.jpg'; ph2 := drv.profile_id || '/c233/llegada.jpg';
  INSERT INTO storage.objects(bucket_id, name, owner) VALUES ('driver_evidence', ph1, drv.profile_id), ('driver_evidence', ph2, drv.profile_id);

  PERFORM set_config('request.jwt.claim.sub', drv.profile_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', drv.profile_id, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  BEGIN PERFORM pg_temp.c233_set(did, 'EN RUTA'); ok := true; EXCEPTION WHEN OTHERS THEN ok := false; msg := SQLERRM; END;
  IF ok OR msg NOT ILIKE '%odómetro de salida%' THEN RAISE EXCEPTION 'CAJA C233 FAIL: inició la ruta sin odómetro de salida (%)', msg; END IF;
  BEGIN PERFORM public.dispatch_record_odometer(did, 'SALIDA', 1000, drv.profile_id || '/c233/no-existe.jpg'); ok := true; EXCEPTION WHEN OTHERS THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C233 FAIL: aceptó el odómetro sin foto'; END IF;
  PERFORM public.dispatch_record_odometer(did, 'SALIDA', 1000, ph1);
  PERFORM pg_temp.c233_set(did, 'EN RUTA');
  PERFORM pg_temp.c233_set(did, NULL, 80, 900);  -- inicio de ruta con la lectura del preuso + GPS acumulado
  IF (SELECT start_odometer FROM public.dispatches WHERE id = did) <> 1000 THEN RAISE EXCEPTION 'CAJA C233 FAIL: se reemplazó la lectura de salida con foto'; END IF;
  PERFORM pg_temp.c233_set(did, 'RETORNO');
  BEGIN PERFORM pg_temp.c233_set(did, 'RETORNO_COMPLETADO'); ok := true; EXCEPTION WHEN OTHERS THEN ok := false; msg := SQLERRM; END;
  IF ok OR msg NOT ILIKE '%odómetro de llegada%' THEN RAISE EXCEPTION 'CAJA C233 FAIL: confirmó la llegada sin odómetro (%)', msg; END IF;
  BEGIN PERFORM public.dispatch_record_odometer(did, 'LLEGADA', 999, ph2); ok := true; EXCEPTION WHEN OTHERS THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C233 FAIL: aceptó una llegada menor a la salida'; END IF;
  PERFORM public.dispatch_record_odometer(did, 'LLEGADA', 1100, ph2);
  SELECT * INTO d FROM public.dispatches WHERE id = did;
  IF d.actual_distance_km <> 100 OR d.actual_distance_source <> 'ODOMETRO' OR d.gps_distance_km <> 80 OR d.km_check <> 'OBSERVADO' THEN
    RAISE EXCEPTION 'CAJA C233 FAIL: km % fuente % gps % control %', d.actual_distance_km, d.actual_distance_source, d.gps_distance_km, d.km_check; END IF;
  PERFORM pg_temp.c233_set(did, NULL, 95);  -- un punto GPS tardío queda como control
  SELECT * INTO d FROM public.dispatches WHERE id = did;
  IF d.actual_distance_km <> 100 OR d.gps_distance_km <> 95 OR d.km_check <> 'COINCIDE' THEN RAISE EXCEPTION 'CAJA C233 FAIL: el GPS tardío reemplazó el km del odómetro'; END IF;
  PERFORM pg_temp.c233_set(did, 'RETORNO_COMPLETADO');

  -- Factura de flete de tercero: base, IGV y moneda aparte; base en soles con el tipo de cambio
  PERFORM set_config('role', 'postgres', true);
  SELECT x.id, x.site_id INTO t FROM public.dispatches x WHERE x.modalidad = 'TERCERO' ORDER BY x.created_at DESC LIMIT 1;
  IF t.id IS NULL THEN RAISE EXCEPTION 'CAJA C233 PASS: odómetro con foto y GPS de control (sin viajes de terceros para la factura)'; END IF;
  FOR p IN SELECT pr.id FROM public.profiles pr WHERE pr.is_active LOOP
    PERFORM set_config('request.jwt.claim.sub', p.id::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', p.id, 'role', 'authenticated')::text, true);
    IF public.has_tms_permission('despacho') AND public.can_access_site(t.site_id) THEN m := p.id; EXIT; END IF;
  END LOOP;
  IF m IS NULL THEN RAISE EXCEPTION 'CAJA C233 PASS: odómetro con foto y GPS de control (sin usuario de despacho para la factura)'; END IF;
  r := public.dispatch_freight_invoice_save(t.id, '{"provider_ruc":"20999999991","document_series":"F001","document_number":"000123","issue_date":"2026-11-01","currency":"USD","base_amount":100,"igv_amount":18,"exchange_rate":3.75}');
  IF (SELECT base_pen FROM public.dispatch_freight_invoices WHERE id = (r->>'id')::bigint) <> 375
     OR (SELECT total_amount FROM public.dispatch_freight_invoices WHERE id = (r->>'id')::bigint) <> 118 THEN RAISE EXCEPTION 'CAJA C233 FAIL: base en soles o total de la factura'; END IF;
  BEGIN PERFORM public.dispatch_freight_invoice_save(t.id, '{"provider_ruc":"20999999991","document_series":"f001","document_number":"123","issue_date":"2026-11-01","currency":"PEN","base_amount":50,"igv_amount":9}'); ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C233 FAIL: aceptó la misma factura dos veces'; END IF;
  BEGIN PERFORM public.dispatch_freight_invoice_save(t.id, '{"provider_ruc":"20999999991","document_series":"F001","document_number":"9","issue_date":"2026-11-01","currency":"USD","base_amount":50,"igv_amount":9}'); ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C233 FAIL: aceptó dólares sin tipo de cambio'; END IF;
  BEGIN PERFORM public.dispatch_freight_invoice_save(did, '{"provider_ruc":"20999999991","document_series":"F001","document_number":"10","issue_date":"2026-11-01","currency":"PEN","base_amount":50,"igv_amount":9}'); ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C233 FAIL: aceptó factura de flete en un viaje de unidad propia'; END IF;
  RAISE EXCEPTION 'CAJA C233 PASS: odómetro con foto obligatorio al salir y volver, km por odómetro con GPS de control y factura de flete con IGV y moneda aparte';
END $test$;
ROLLBACK;
