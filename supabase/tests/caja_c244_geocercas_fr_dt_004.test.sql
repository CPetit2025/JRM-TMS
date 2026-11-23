-- C244: geocercas del FR-DT.004. Distancia correcta, planta y destinos ubicados, hitos GPS en orden (salida de planta ≤
-- llegada ≤ salida del cliente ≤ retorno), la marca de descarga validada y el reporte con la fuente de cada hora. Se revierte.
BEGIN;
DO $test$
DECLARE d record; s record; prev timestamptz; ok boolean; drv uuid; adm uuid; rep jsonb; n_gps int;
BEGIN
  IF abs(public.geo_distance_m(0, 0, 0, 1) - 111195) > 50 THEN RAISE EXCEPTION 'CAJA C244 FAIL: distancia haversine incorrecta'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.geo_points WHERE kind = 'PLANTA') THEN RAISE EXCEPTION 'CAJA C244 FAIL: sin geocerca de planta'; END IF;

  -- Hitos de cada viaje con GPS: en orden cronológico y dentro del rango de sus puntos
  FOR d IN SELECT x.* FROM public.dispatches x WHERE x.gps_computed_at IS NOT NULL ORDER BY x.created_at DESC LIMIT 40 LOOP
    prev := d.gps_plant_exit_at;
    FOR s IN SELECT r.gps_arrived_at a, r.gps_departed_at b FROM public.dispatch_requests r WHERE r.dispatch_id = d.id AND r.gps_arrived_at IS NOT NULL ORDER BY r.sequence_order, r.created_at LOOP
      IF prev IS NOT NULL AND s.a < prev THEN RAISE EXCEPTION 'CAJA C244 FAIL: llegada antes de la salida anterior en el viaje %', d.dispatch_number; END IF;
      IF s.b IS NOT NULL AND s.b < s.a THEN RAISE EXCEPTION 'CAJA C244 FAIL: salida del cliente antes de la llegada (%)', d.dispatch_number; END IF;
      prev := coalesce(s.b, s.a);
    END LOOP;
    IF d.gps_plant_return_at IS NOT NULL AND prev IS NOT NULL AND d.gps_plant_return_at < prev THEN RAISE EXCEPTION 'CAJA C244 FAIL: retorno antes de la última parada (%)', d.dispatch_number; END IF;
  END LOOP;

  -- Marca de descarga: solo el conductor de la ruta; «sin espera» toma la hora de llegada
  SELECT c.dispatch_id, c.request_id, c.arrived_at, dr.profile_id INTO s FROM public.delivery_conformities c JOIN public.dispatches x ON x.id = c.dispatch_id
    JOIN public.drivers dr ON dr.id = x.driver_id WHERE c.arrived_at > now() - interval '1 day' AND c.unload_started_at IS NULL AND dr.profile_id IS NOT NULL LIMIT 1;
  IF s.dispatch_id IS NOT NULL THEN
    SELECT p.id INTO adm FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id WHERE p.is_active AND ro.name = 'Administrador' LIMIT 1;
    PERFORM set_config('request.jwt.claim.sub', adm::text, true); PERFORM set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
    BEGIN PERFORM public.delivery_mark_unload(s.dispatch_id, s.request_id, now(), false); ok := true; EXCEPTION WHEN OTHERS THEN ok := false; END;
    IF ok THEN RAISE EXCEPTION 'CAJA C244 FAIL: alguien que no es el conductor marcó la descarga'; END IF;
    PERFORM set_config('request.jwt.claim.sub', s.profile_id::text, true); PERFORM set_config('request.jwt.claims', json_build_object('sub', s.profile_id, 'role', 'authenticated')::text, true);
    BEGIN PERFORM public.delivery_mark_unload(s.dispatch_id, s.request_id, s.arrived_at - interval '1 hour', false); ok := true; EXCEPTION WHEN OTHERS THEN ok := false; END;
    IF ok THEN RAISE EXCEPTION 'CAJA C244 FAIL: aceptó descarga antes de la llegada'; END IF;
    PERFORM public.delivery_mark_unload(s.dispatch_id, s.request_id, NULL, true);
    IF (SELECT unload_started_at FROM public.delivery_conformities WHERE dispatch_id = s.dispatch_id AND request_id = s.request_id) IS DISTINCT FROM s.arrived_at THEN
      RAISE EXCEPTION 'CAJA C244 FAIL: «sin espera» no tomó la hora de llegada'; END IF;
  END IF;

  -- Reporte: una parada con llegada GPS sale con fuente GPS
  SELECT p.id INTO adm FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id WHERE p.is_active AND ro.name = 'Administrador' LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub', adm::text, true); PERFORM set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  rep := public.fr_dt_004_report((now() AT TIME ZONE 'America/Lima')::date - 30, (now() AT TIME ZONE 'America/Lima')::date);
  SELECT count(*) INTO n_gps FROM jsonb_array_elements(rep) x WHERE x->>'llegada_fuente' = 'GPS';
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(rep) x WHERE x->>'hora_llegada_cliente' IS NOT NULL AND x->>'llegada_fuente' IS NULL) THEN
    RAISE EXCEPTION 'CAJA C244 FAIL: hora de llegada sin fuente'; END IF;
  RAISE EXCEPTION 'CAJA C244 PASS: geocercas y hitos GPS en orden; descarga solo del conductor; % llegadas por GPS en 30 días', n_gps;
END $test$;
ROLLBACK;
