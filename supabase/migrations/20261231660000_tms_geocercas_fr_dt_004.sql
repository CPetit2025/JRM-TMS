-- Geocercas para el FR-DT.004 (decisión del 23-11-2026): las horas de salida de planta, llegada y salida del cliente y
-- retorno a planta se calculan con el GPS del celular; lo manual queda como respaldo y el reporte indica la fuente.
-- Destinos: el sistema los ubica (OpenStreetMap al programar o llegadas precisas de la app) y Despacho los corrige.
-- Radio por defecto 200 m (planta 300 m). La app pide la hora de inicio de descarga para separar espera y descarga.

-- Distancia en metros entre dos coordenadas (haversine)
CREATE OR REPLACE FUNCTION public.geo_distance_m(p_lat1 double precision, p_lon1 double precision, p_lat2 double precision, p_lon2 double precision)
RETURNS double precision LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public, pg_temp AS $$
  SELECT 2 * 6371000 * asin(sqrt(power(sin(radians(p_lat2 - p_lat1) / 2), 2) + cos(radians(p_lat1)) * cos(radians(p_lat2)) * power(sin(radians(p_lon2 - p_lon1) / 2), 2)))
$$;

-- Clave de una dirección para reconocer el mismo destino en distintas solicitudes
CREATE OR REPLACE FUNCTION public.geo_address_key(p_address text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public, pg_temp AS $$
  SELECT nullif(btrim(regexp_replace(lower(translate(coalesce(p_address, ''), 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun')), '[^a-z0-9]+', ' ', 'g')), '')
$$;

CREATE TABLE IF NOT EXISTS public.geo_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('PLANTA', 'DESTINO')),
  address_key text NOT NULL UNIQUE,
  label text NOT NULL,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  radius_m integer NOT NULL DEFAULT 200 CHECK (radius_m BETWEEN 50 AND 3000),
  source text NOT NULL CHECK (source IN ('GPS_PLANTA', 'GEOCODIFICADO', 'APRENDIDO', 'CORREGIDO')),
  samples integer NOT NULL DEFAULT 0,
  updated_by uuid REFERENCES public.profiles(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS geo_points_updated_by_idx ON public.geo_points(updated_by);
ALTER TABLE public.geo_points ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.geo_points FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.geo_points TO authenticated;
DROP POLICY IF EXISTS geo_points_read ON public.geo_points;
CREATE POLICY geo_points_read ON public.geo_points FOR SELECT TO authenticated USING (
  public.is_tms_admin() OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('flota')
  OR public.has_tms_read_permission('monitoreo') OR public.has_tms_read_permission('torre-control'));
DROP POLICY IF EXISTS security_active_account ON public.geo_points;
CREATE POLICY security_active_account ON public.geo_points AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));

-- Planta Chilca: mediana de 6 282 lecturas GPS con la unidad detenida (20-11 a 23-11-2026)
INSERT INTO public.geo_points(kind, address_key, label, lat, lon, radius_m, source)
VALUES ('PLANTA', 'planta chilca', 'Planta Chilca', -12.50028, -76.73183, 300, 'GPS_PLANTA')
ON CONFLICT (address_key) DO NOTHING;

-- Dirección visitada en la parada (recojo: origen; despacho y traslado: destino)
CREATE OR REPLACE FUNCTION public.stop_visit_address(t public.transport_requests)
RETURNS text LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN t.request_type = 'RECOJO' THEN t.pickup_address ELSE t.delivery_address END
$$;

-- Corrección de Despacho: ubicación y radio del destino
CREATE OR REPLACE FUNCTION public.geo_point_save(p_id uuid, p_lat double precision, p_lon double precision, p_radius integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT (public.is_tms_admin() OR public.has_tms_permission('despacho')) THEN RAISE EXCEPTION 'Sin permiso para corregir destinos' USING ERRCODE = '42501'; END IF;
  IF p_lat IS NULL OR p_lon IS NULL OR p_lat NOT BETWEEN -19 AND 0 OR p_lon NOT BETWEEN -82 AND -68 THEN RAISE EXCEPTION 'La ubicación debe estar en Perú (latitud y longitud)'; END IF;
  IF p_radius IS NULL OR p_radius NOT BETWEEN 50 AND 3000 THEN RAISE EXCEPTION 'El radio va de 50 a 3000 m'; END IF;
  UPDATE public.geo_points SET lat = p_lat, lon = p_lon, radius_m = p_radius, source = CASE WHEN kind = 'PLANTA' THEN source ELSE 'CORREGIDO' END,
    updated_by = auth.uid(), updated_at = now() WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Destino no encontrado'; END IF;
  RETURN jsonb_build_object('success', true);
END $$;
REVOKE ALL ON FUNCTION public.geo_point_save(uuid, double precision, double precision, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.geo_point_save(uuid, double precision, double precision, integer) TO authenticated;

-- Aprendizaje: destinos no corregidos toman la mediana de las llegadas precisas (±50 m) de la app (2 o más)
CREATE OR REPLACE FUNCTION public.geo_points_learn()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  WITH a AS (
    SELECT public.geo_address_key(public.stop_visit_address(t)) k, min(public.stop_visit_address(t)) label,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY c.arrival_lat) lat, percentile_cont(0.5) WITHIN GROUP (ORDER BY c.arrival_lon) lon, count(*) n
    FROM public.delivery_conformities c JOIN public.transport_requests t ON t.id = c.request_id
    WHERE c.arrival_lat IS NOT NULL AND c.arrival_lon IS NOT NULL AND c.arrival_accuracy_m <= 50 AND coalesce(c.arrival_source, 'MANUAL') <> 'AUTO_GEOCERCA'
    GROUP BY 1 HAVING count(*) >= 2 AND public.geo_address_key(public.stop_visit_address(t)) IS NOT NULL),
  up AS (
    INSERT INTO public.geo_points(kind, address_key, label, lat, lon, source, samples)
    SELECT 'DESTINO', a.k, left(a.label, 300), a.lat, a.lon, 'APRENDIDO', a.n FROM a
    ON CONFLICT (address_key) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, source = 'APRENDIDO', samples = excluded.samples, updated_at = now()
      WHERE public.geo_points.source IN ('GEOCODIFICADO', 'APRENDIDO') AND public.geo_points.kind = 'DESTINO'
    RETURNING 1)
  SELECT count(*) INTO n FROM up;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.geo_points_learn() FROM PUBLIC, anon, authenticated;

-- Al programar, el punto que calculó OpenStreetMap crea el destino si aún no existe
CREATE OR REPLACE FUNCTION public.geo_points_from_estimate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.transport_requests%ROWTYPE; k text;
BEGIN
  IF NEW.destination IS NULL OR (NEW.destination->>'lat') IS NULL OR (NEW.destination->>'lon') IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO t FROM public.transport_requests WHERE id = NEW.request_id;
  k := public.geo_address_key(public.stop_visit_address(t));
  IF k IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.geo_points(kind, address_key, label, lat, lon, source)
  VALUES ('DESTINO', k, left(public.stop_visit_address(t), 300),
    CASE WHEN t.request_type = 'RECOJO' THEN (NEW.origin->>'lat')::double precision ELSE (NEW.destination->>'lat')::double precision END,
    CASE WHEN t.request_type = 'RECOJO' THEN (NEW.origin->>'lon')::double precision ELSE (NEW.destination->>'lon')::double precision END, 'GEOCODIFICADO')
  ON CONFLICT (address_key) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW; -- la ubicación nunca impide guardar la ruta
END $$;
DROP TRIGGER IF EXISTS geo_points_from_estimate ON public.dispatch_route_estimates;
CREATE TRIGGER geo_points_from_estimate AFTER INSERT OR UPDATE OF destination, origin ON public.dispatch_route_estimates
  FOR EACH ROW EXECUTE FUNCTION public.geo_points_from_estimate();

-- Carga inicial: llegadas precisas primero; luego lo geocodificado al programar
SELECT public.geo_points_learn();
INSERT INTO public.geo_points(kind, address_key, label, lat, lon, source)
SELECT DISTINCT ON (public.geo_address_key(public.stop_visit_address(t))) 'DESTINO', public.geo_address_key(public.stop_visit_address(t)), left(public.stop_visit_address(t), 300),
  CASE WHEN t.request_type = 'RECOJO' THEN (e.origin->>'lat')::double precision ELSE (e.destination->>'lat')::double precision END,
  CASE WHEN t.request_type = 'RECOJO' THEN (e.origin->>'lon')::double precision ELSE (e.destination->>'lon')::double precision END, 'GEOCODIFICADO'
FROM public.dispatch_route_estimates e JOIN public.transport_requests t ON t.id = e.request_id
WHERE public.geo_address_key(public.stop_visit_address(t)) IS NOT NULL
  AND (CASE WHEN t.request_type = 'RECOJO' THEN e.origin->>'lat' ELSE e.destination->>'lat' END) IS NOT NULL
ORDER BY public.geo_address_key(public.stop_visit_address(t)), e.computed_at DESC
ON CONFLICT (address_key) DO NOTHING;

-- Inicio de descarga marcado por el conductor (o «sin espera»): separa espera y descarga
ALTER TABLE public.delivery_conformities ADD COLUMN IF NOT EXISTS unload_started_at timestamptz;
ALTER TABLE public.delivery_conformities ADD COLUMN IF NOT EXISTS unload_source text;
ALTER TABLE public.delivery_conformities ADD COLUMN IF NOT EXISTS unload_recorded_at timestamptz;
DO $m$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'delivery_conformities_unload_source_check') THEN
    ALTER TABLE public.delivery_conformities ADD CONSTRAINT delivery_conformities_unload_source_check CHECK (unload_source IS NULL OR unload_source IN ('CONDUCTOR', 'SIN_ESPERA', 'SUPERVISOR'));
  END IF;
END $m$;

CREATE OR REPLACE FUNCTION public.delivery_mark_unload(p_dispatch uuid, p_request uuid, p_at timestamptz, p_no_wait boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d record; c record; v_at timestamptz;
BEGIN
  PERFORM public.security_assert_active_session();
  SELECT x.id, x.driver_id INTO d FROM public.dispatches x WHERE x.id = p_dispatch;
  IF d.id IS NULL OR NOT EXISTS (SELECT 1 FROM public.drivers dr WHERE dr.id = d.driver_id AND dr.profile_id = auth.uid() AND dr.is_active) THEN
    RAISE EXCEPTION 'Ruta no autorizada'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.dispatch_requests WHERE dispatch_id = p_dispatch AND transport_request_id = p_request) THEN RAISE EXCEPTION 'La parada no pertenece a la ruta'; END IF;
  INSERT INTO public.delivery_conformities(dispatch_id, request_id) VALUES (p_dispatch, p_request) ON CONFLICT DO NOTHING;
  SELECT * INTO c FROM public.delivery_conformities WHERE dispatch_id = p_dispatch AND request_id = p_request FOR UPDATE;
  IF c.unload_started_at IS NOT NULL THEN RETURN jsonb_build_object('success', true, 'unload_started_at', c.unload_started_at, 'duplicate', true); END IF;
  v_at := CASE WHEN coalesce(p_no_wait, false) THEN coalesce(c.arrived_at, p_at) ELSE p_at END;
  IF v_at IS NULL OR v_at > now() + interval '5 minutes' OR v_at < now() - interval '2 days' THEN RAISE EXCEPTION 'Hora de inicio de descarga no válida'; END IF;
  IF c.arrived_at IS NOT NULL AND v_at < c.arrived_at - interval '1 minute' THEN RAISE EXCEPTION 'La descarga no puede empezar antes de la llegada'; END IF;
  UPDATE public.delivery_conformities SET unload_started_at = v_at, unload_source = CASE WHEN coalesce(p_no_wait, false) THEN 'SIN_ESPERA' ELSE 'CONDUCTOR' END,
    unload_recorded_at = now(), updated_at = now() WHERE dispatch_id = p_dispatch AND request_id = p_request;
  RETURN jsonb_build_object('success', true, 'unload_started_at', v_at);
END $$;
REVOKE ALL ON FUNCTION public.delivery_mark_unload(uuid, uuid, timestamptz, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delivery_mark_unload(uuid, uuid, timestamptz, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.delivery_unload_status(p_dispatch uuid, p_request uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('unload_started_at', c.unload_started_at, 'unload_source', c.unload_source, 'arrived_at', c.arrived_at)
  FROM public.delivery_conformities c JOIN public.dispatches d ON d.id = c.dispatch_id
  WHERE c.dispatch_id = p_dispatch AND c.request_id = p_request
    AND (EXISTS (SELECT 1 FROM public.drivers dr WHERE dr.id = d.driver_id AND dr.profile_id = auth.uid()) OR public.is_tms_admin() OR public.has_tms_read_permission('despacho'))
$$;
REVOKE ALL ON FUNCTION public.delivery_unload_status(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delivery_unload_status(uuid, uuid) TO authenticated;

-- Hitos GPS por viaje y parada
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS gps_plant_exit_at timestamptz;
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS gps_plant_return_at timestamptz;
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS gps_computed_at timestamptz;
ALTER TABLE public.dispatch_requests ADD COLUMN IF NOT EXISTS gps_arrived_at timestamptz;
ALTER TABLE public.dispatch_requests ADD COLUMN IF NOT EXISTS gps_departed_at timestamptz;
CREATE INDEX IF NOT EXISTS route_track_points_dispatch_time_idx ON public.route_track_points(dispatch_id, recorded_at);

-- Recorre los puntos GPS del viaje en orden: salida de planta, entrada y salida de cada parada (en su orden) y retorno.
-- Salir exige alejarse 1,2 veces el radio (evita rebotes del GPS en el borde). Sin punto del destino, la parada queda sin hito GPS.
CREATE OR REPLACE FUNCTION public.dispatch_compute_gps_milestones(p_dispatch uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE pl record; s record; g record; cur timestamptz; first_at timestamptz; lim timestamptz; ex timestamptz; arr timestamptz; dep timestamptz; ret timestamptz; n int := 0;
BEGIN
  SELECT min(recorded_at) INTO first_at FROM public.route_track_points WHERE dispatch_id = p_dispatch;
  IF first_at IS NULL THEN RETURN jsonb_build_object('points', 0); END IF;
  -- Solo los puntos del período del viaje: hasta su cierre operativo o 2 días después de empezar
  SELECT least(coalesce(x.operational_closed_at, 'infinity'::timestamptz), first_at + interval '2 days') INTO lim FROM public.dispatches x WHERE x.id = p_dispatch;
  -- Salida de planta: el viaje empieza dentro de alguna planta y se registra el primer punto fuera de ella
  SELECT g2.* INTO pl FROM public.geo_points g2 JOIN public.route_track_points p ON p.dispatch_id = p_dispatch AND p.recorded_at = first_at
  WHERE g2.kind = 'PLANTA' AND public.geo_distance_m(p.latitude, p.longitude, g2.lat, g2.lon) <= g2.radius_m LIMIT 1;
  IF pl.id IS NOT NULL THEN
    SELECT min(p.recorded_at) INTO ex FROM public.route_track_points p WHERE p.dispatch_id = p_dispatch
      AND p.recorded_at <= lim AND public.geo_distance_m(p.latitude, p.longitude, pl.lat, pl.lon) > pl.radius_m * 1.2;
  END IF;
  cur := coalesce(ex, first_at);
  FOR s IN SELECT r.transport_request_id rid, t FROM public.dispatch_requests r JOIN public.transport_requests t ON t.id = r.transport_request_id
           WHERE r.dispatch_id = p_dispatch AND coalesce(r.status, '') NOT IN ('CANCELADO', 'RETIRADO') ORDER BY r.sequence_order, r.created_at LOOP
    arr := NULL; dep := NULL;
    SELECT * INTO g FROM public.geo_points WHERE kind = 'DESTINO' AND address_key = public.geo_address_key(public.stop_visit_address(s.t));
    IF g.id IS NOT NULL THEN
      SELECT min(p.recorded_at) INTO arr FROM public.route_track_points p WHERE p.dispatch_id = p_dispatch AND p.recorded_at >= cur AND p.recorded_at <= lim
        AND public.geo_distance_m(p.latitude, p.longitude, g.lat, g.lon) <= g.radius_m;
      IF arr IS NOT NULL THEN
        SELECT min(p.recorded_at) INTO dep FROM public.route_track_points p WHERE p.dispatch_id = p_dispatch AND p.recorded_at > arr AND p.recorded_at <= lim
          AND public.geo_distance_m(p.latitude, p.longitude, g.lat, g.lon) > g.radius_m * 1.2;
        cur := coalesce(dep, arr); n := n + 1;
      END IF;
    END IF;
    UPDATE public.dispatch_requests SET gps_arrived_at = arr, gps_departed_at = dep WHERE dispatch_id = p_dispatch AND transport_request_id = s.rid;
  END LOOP;
  -- Retorno: primer punto dentro de una planta después de la última parada
  SELECT min(p.recorded_at) INTO ret FROM public.route_track_points p JOIN public.geo_points g2 ON g2.kind = 'PLANTA'
  WHERE p.dispatch_id = p_dispatch AND p.recorded_at > cur AND p.recorded_at <= lim AND (ex IS NOT NULL OR cur > first_at)
    AND public.geo_distance_m(p.latitude, p.longitude, g2.lat, g2.lon) <= g2.radius_m;
  UPDATE public.dispatches SET gps_plant_exit_at = ex, gps_plant_return_at = ret, gps_computed_at = now() WHERE id = p_dispatch;
  RETURN jsonb_build_object('points', 1, 'stops', n, 'exit', ex, 'return', ret);
END $$;
REVOKE ALL ON FUNCTION public.dispatch_compute_gps_milestones(uuid) FROM PUBLIC, anon, authenticated;

-- Recalcula los viajes con puntos GPS nuevos (cada 15 min) y aprende destinos (diario)
CREATE OR REPLACE FUNCTION public.dispatch_gps_milestones_job()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid; n integer := 0;
BEGIN
  FOR d IN SELECT x.id FROM public.dispatches x WHERE x.status <> 'CANCELADO'
           AND EXISTS (SELECT 1 FROM public.route_track_points p WHERE p.dispatch_id = x.id AND p.created_at > coalesce(x.gps_computed_at, '-infinity'::timestamptz))
           AND x.created_at > now() - interval '45 days' LOOP
    PERFORM public.dispatch_compute_gps_milestones(d); n := n + 1;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.dispatch_gps_milestones_job() FROM PUBLIC, anon, authenticated;

DO $m$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('fr-dt-004-gps', 'fr-dt-004-aprender');
    PERFORM cron.schedule('fr-dt-004-gps', '*/15 * * * *', 'SELECT public.dispatch_gps_milestones_job()');
    PERFORM cron.schedule('fr-dt-004-aprender', '40 10 * * *', 'SELECT public.geo_points_learn()');
  END IF;
END $m$;

-- Cálculo inicial de los últimos 45 días
SELECT public.dispatch_gps_milestones_job();

-- Reporte FR-DT.004 con horas por GPS (geocercas) y lo manual como respaldo; cada hora indica su fuente
CREATE OR REPLACE FUNCTION public.fr_dt_004_report(p_from date, p_to date, p_plate text DEFAULT NULL, p_driver text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT (public.is_tms_admin() OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('flota')
     OR public.has_tms_read_permission('monitoreo') OR public.has_tms_read_permission('torre-control')) THEN
    RAISE EXCEPTION 'Sin permiso para el reporte de despacho' USING ERRCODE = '42501'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 92 THEN RAISE EXCEPTION 'Elija un período de hasta 3 meses'; END IF;
  RETURN coalesce((
    WITH s AS (
      SELECT d.id did, d.dispatch_number, d.modalidad, d.status ds, d.site_id,
        upper(btrim(CASE WHEN d.modalidad = 'TERCERO' THEN coalesce(nullif(to_jsonb(d)->>'tercero_placa', ''), d.vehicle_plate) ELSE d.vehicle_plate END)) placa,
        CASE WHEN d.modalidad = 'TERCERO' THEN coalesce(d.tercero_conductor, d.driver_name) ELSE d.driver_name END conductor,
        coalesce(d.gps_plant_exit_at, d.departure_time, d.start_odometer_at, d.tercero_salida_at) salida_viaje, coalesce(d.gps_plant_return_at, d.returned_at, d.end_odometer_at) retorno,
        CASE WHEN d.gps_plant_exit_at IS NOT NULL THEN 'GPS' WHEN coalesce(d.departure_time, d.start_odometer_at, d.tercero_salida_at) IS NOT NULL THEN 'MANUAL' END salida_fuente,
        CASE WHEN d.gps_plant_return_at IS NOT NULL THEN 'GPS' WHEN coalesce(d.returned_at, d.end_odometer_at) IS NOT NULL THEN 'MANUAL' END retorno_fuente,
        d.start_odometer, d.end_odometer, r.sequence_order, r.occupancy_pct, r.occupancy_source, r.stop_odometer, r.document_number doc_parada,
        t.id rid, t.request_number, t.department, t.request_type, t.reference_type, t.purchase_order, t.reference_number, t.estimated_weight,
        t.pickup_customer, t.client_id, t.supplier_id, t.contract_id,
        CASE WHEN t.request_type = 'RECOJO' THEN t.pickup_province ELSE t.delivery_province END provincia,
        CASE WHEN t.request_type = 'RECOJO' THEN t.pickup_district ELSE t.delivery_district END distrito,
        CASE WHEN t.request_type = 'RECOJO' THEN t.pickup_address ELSE t.delivery_address END direccion,
        coalesce(r.gps_arrived_at, c.arrived_at) arrived_at, coalesce(r.gps_departed_at, c.departed_at) departed_at,
        CASE WHEN r.gps_arrived_at IS NOT NULL THEN 'GPS' WHEN coalesce(c.arrived_at, CASE WHEN d.modalidad = 'TERCERO' THEN d.tercero_entrega_at END) IS NOT NULL THEN 'MANUAL' END llegada_fuente,
        CASE WHEN r.gps_departed_at IS NOT NULL THEN 'GPS' WHEN c.departed_at IS NOT NULL THEN 'MANUAL' END salida_cli_fuente,
        c.unload_started_at, c.unload_source,
        (SELECT max(sb.submitted_at) FROM public.delivery_submissions sb WHERE sb.dispatch_id = d.id AND sb.request_id = t.id) guia_at,
        CASE WHEN d.modalidad = 'TERCERO' THEN coalesce(c.arrived_at, d.tercero_entrega_at) ELSE coalesce(r.gps_arrived_at, c.arrived_at) END llegada,
        ((coalesce(d.departure_time, d.start_odometer_at, d.tercero_salida_at, d.scheduled_departure)) AT TIME ZONE 'America/Lima')::date fecha,
        coalesce(d.departure_time, d.start_odometer_at, d.tercero_salida_at, d.scheduled_departure) orden_viaje
      FROM public.dispatches d JOIN public.dispatch_requests r ON r.dispatch_id = d.id JOIN public.transport_requests t ON t.id = r.transport_request_id
      LEFT JOIN public.delivery_conformities c ON c.dispatch_id = d.id AND c.request_id = t.id
      WHERE d.status <> 'CANCELADO' AND coalesce(r.status, '') NOT IN ('CANCELADO', 'RETIRADO') AND public.can_access_site(d.site_id)
        AND ((coalesce(d.departure_time, d.start_odometer_at, d.tercero_salida_at, d.scheduled_departure)) AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to),
    s2 AS (
      -- Orden del viaje en el día de la unidad: el odómetro de jornada solo vale para el primer y el último viaje
      SELECT s1.*, max(s1.viaje_dia) OVER (PARTITION BY s1.placa, s1.fecha) viajes_dia
      FROM (SELECT s.*, dense_rank() OVER (PARTITION BY s.placa, s.fecha ORDER BY s.orden_viaje, s.did) viaje_dia FROM s) s1),
    k AS (
      SELECT s.*,
        -- Km en el cliente: odómetro de la parada; si falta, km inicial + km GPS acumulados hasta la llegada
        CASE WHEN s.stop_odometer > 0 THEN s.stop_odometer
             WHEN s.modalidad = 'PROPIA' AND s.start_odometer > 0 AND s.arrived_at IS NOT NULL THEN
               s.start_odometer + round(nullif((SELECT max(p.cumulative_m) FROM public.route_track_points p WHERE p.dispatch_id = s.did AND p.recorded_at <= s.arrived_at), 0) / 1000.0, 1)
        END km_cliente,
        CASE WHEN s.stop_odometer > 0 THEN 'ODOMETRO' WHEN s.modalidad = 'PROPIA' AND s.start_odometer > 0 AND s.arrived_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM public.route_track_points p WHERE p.dispatch_id = s.did AND p.recorded_at <= s.arrived_at AND p.cumulative_m > 0) THEN 'GPS' END km_cliente_fuente,
        coalesce(nullif(s.start_odometer, 0), (SELECT u.odometer FROM public.unit_odometer_readings u WHERE u.kind = 'INICIO'
          AND upper(replace(u.vehicle_plate, ' ', '')) = upper(replace(s.placa, ' ', '')) AND u.operation_date = s.fecha AND s.viaje_dia = 1 ORDER BY u.captured_at LIMIT 1)) km_inicio_viaje,
        coalesce(nullif(s.end_odometer, 0), (SELECT u.odometer FROM public.unit_odometer_readings u WHERE u.kind = 'CIERRE'
          AND upper(replace(u.vehicle_plate, ' ', '')) = upper(replace(s.placa, ' ', '')) AND u.operation_date = s.fecha AND s.viaje_dia = s.viajes_dia ORDER BY u.captured_at DESC LIMIT 1)) km_fin_viaje,
        -- Espera: de la llegada al inicio de descarga que marcó el conductor; si no, las esperas registradas; si no, sin dato
        CASE WHEN s.unload_started_at IS NOT NULL AND s.arrived_at IS NOT NULL THEN greatest(round(extract(epoch FROM (s.unload_started_at - s.arrived_at)) / 60), 0)
             ELSE (SELECT round(sum(extract(epoch FROM (w.ended_at - w.started_at)) / 60)) FROM public.route_stop_waits w WHERE w.dispatch_id = s.did AND w.request_id = s.rid AND w.ended_at IS NOT NULL) END espera_min,
        CASE WHEN s.unload_started_at IS NOT NULL THEN coalesce(s.unload_source, 'CONDUCTOR')
             WHEN EXISTS (SELECT 1 FROM public.route_stop_waits w WHERE w.dispatch_id = s.did AND w.request_id = s.rid AND w.ended_at IS NOT NULL) THEN 'ESPERAS' END tiempos_base,
        row_number() OVER (PARTITION BY s.did ORDER BY s.sequence_order, s.llegada NULLS LAST, s.rid) n_parada,
        count(*) OVER (PARTITION BY s.did) paradas
      FROM s2 s),
    f AS (
      SELECT k.*,
        row_number() OVER (PARTITION BY k.placa, k.fecha ORDER BY k.salida_viaje NULLS LAST, k.did, k.n_parada) vuelta,
        CASE WHEN k.n_parada = 1 THEN k.salida_viaje ELSE lag(k.departed_at) OVER (PARTITION BY k.did ORDER BY k.n_parada) END hora_salida,
        CASE WHEN k.n_parada = 1 THEN k.salida_fuente ELSE lag(k.salida_cli_fuente) OVER (PARTITION BY k.did ORDER BY k.n_parada) END hora_salida_fuente,
        CASE WHEN k.n_parada = k.paradas THEN k.retorno_fuente ELSE k.salida_cli_fuente END hora_planta_fuente,
        CASE WHEN k.n_parada = 1 THEN k.km_inicio_viaje ELSE lag(k.km_cliente) OVER (PARTITION BY k.did ORDER BY k.n_parada) END km_inicial,
        CASE WHEN k.n_parada = k.paradas THEN k.retorno ELSE k.departed_at END hora_planta,
        CASE WHEN k.n_parada = k.paradas THEN k.km_fin_viaje ELSE k.km_cliente END km_planta
      FROM k)
    SELECT jsonb_agg(jsonb_build_object(
      'area', f.department,
      'fecha', f.fecha,
      'tipo_actividad', CASE WHEN f.request_type = 'DESPACHO' THEN 'DESPACHO DE CONTRATOS'
                             WHEN f.request_type = 'RECOJO' AND f.reference_type = 'OC' THEN 'RECOJO DE ORDENES DE COMPRA'
                             ELSE 'ENVIO O RECOJO DE SERVICIOS' END,
      'guia', coalesce((SELECT sb.guide_number FROM public.delivery_submissions sb WHERE sb.dispatch_id = f.did AND sb.request_id = f.rid ORDER BY sb.submitted_at DESC LIMIT 1), f.doc_parada),
      'ot_oc_os', nullif(concat_ws(' / ', (SELECT ct.code FROM public.contracts ct WHERE ct.id = f.contract_id),
                    CASE WHEN f.reference_type IS NOT NULL AND f.reference_number IS NOT NULL THEN f.reference_type || ' ' || f.reference_number END,
                    CASE WHEN f.purchase_order IS NOT NULL AND f.purchase_order IS DISTINCT FROM f.reference_number THEN 'OC ' || f.purchase_order END), ''),
      'razon_social', coalesce((SELECT cl.business_name FROM public.clients cl WHERE cl.id = f.client_id),
                               (SELECT su.business_name FROM public.suppliers su WHERE su.id = f.supplier_id), nullif(f.pickup_customer, '')),
      'provincia', f.provincia, 'distrito', f.distrito, 'destino', coalesce(upper(f.distrito), f.direccion),
      'vuelta', f.vuelta, 'placa', f.placa,
      'marca', CASE WHEN f.modalidad = 'PROPIA' THEN (SELECT v.brand FROM public.vehicles v WHERE upper(replace(v.plate, ' ', '')) = upper(replace(f.placa, ' ', ''))) END,
      'conductor', f.conductor, 'modalidad', f.modalidad,
      'hora_salida', f.hora_salida, 'hora_llegada_cliente', f.llegada,
      'espera_min', f.espera_min,
      'descarga_min', CASE WHEN f.unload_started_at IS NOT NULL AND f.departed_at IS NOT NULL THEN greatest(round(extract(epoch FROM (f.departed_at - f.unload_started_at)) / 60), 0)
                           WHEN f.tiempos_base = 'ESPERAS' AND f.departed_at IS NOT NULL AND f.arrived_at IS NOT NULL
                             THEN greatest(round(extract(epoch FROM (f.departed_at - f.arrived_at)) / 60) - coalesce(f.espera_min, 0), 0)
                           -- Sin marca: descarga estimada de la llegada al envío de la guía firmada (la espera queda sin dato)
                           WHEN f.arrived_at IS NOT NULL AND f.guia_at > f.arrived_at THEN round(extract(epoch FROM (least(f.guia_at, coalesce(f.departed_at, f.guia_at)) - f.arrived_at)) / 60) END,
      'tiempos_fuente', coalesce(f.tiempos_base, CASE WHEN f.arrived_at IS NOT NULL AND f.guia_at > f.arrived_at THEN 'ESTIMADO' END),
      'en_cliente_min', CASE WHEN f.departed_at IS NOT NULL AND f.arrived_at IS NOT NULL THEN greatest(round(extract(epoch FROM (f.departed_at - f.arrived_at)) / 60), 0) END,
      'llegada_fuente', f.llegada_fuente, 'salida_cliente_fuente', f.salida_cli_fuente, 'hora_salida_fuente', f.hora_salida_fuente, 'hora_planta_fuente', f.hora_planta_fuente,
      'hora_salida_cliente', f.departed_at, 'hora_llegada_planta', f.hora_planta,
      'total_min', CASE WHEN f.hora_planta IS NOT NULL AND f.hora_salida IS NOT NULL THEN round(extract(epoch FROM (f.hora_planta - f.hora_salida)) / 60) END,
      'km_inicial', f.km_inicial, 'km_cliente', f.km_cliente, 'km_cliente_fuente', f.km_cliente_fuente,
      'km_recorridos', CASE WHEN f.km_cliente IS NOT NULL AND f.km_inicial IS NOT NULL THEN f.km_cliente - f.km_inicial END,
      'km_planta', f.km_planta,
      'km_total', CASE WHEN f.km_planta IS NOT NULL AND f.km_inicial IS NOT NULL THEN f.km_planta - f.km_inicial END,
      'ocupacion_pct', f.occupancy_pct, 'ocupacion_fuente', f.occupancy_source,
      'peso_kg', coalesce(nullif(f.estimated_weight, 0), (SELECT nullif(sum(pl.total_weight_kg), 0) FROM public.wms_packing_releases pl WHERE pl.transport_request_id = f.rid AND coalesce(pl.status, '') <> 'REEMPLAZADO')),
      'peso_fuente', CASE WHEN f.estimated_weight > 0 THEN 'SOLICITUD'
                          WHEN EXISTS (SELECT 1 FROM public.wms_packing_releases pl WHERE pl.transport_request_id = f.rid AND pl.total_weight_kg > 0 AND coalesce(pl.status, '') <> 'REEMPLAZADO') THEN 'PACKING_LIST' END,
      'tipo_descarga', coalesce(
        CASE WHEN EXISTS (SELECT 1 FROM public.route_forklifts rf WHERE rf.dispatch_id = f.did AND (rf.transport_request_id IS NULL OR rf.transport_request_id = f.rid)) THEN 'MONTACARGAS' END,
        (SELECT string_agg(DISTINCT CASE WHEN upper(uc.concept) LIKE 'MONTACARG%' THEN 'MONTACARGAS' ELSE upper(uc.concept) END, ' / ')
           FROM public.transport_unloading_costs uc WHERE uc.transport_request_id = f.rid AND coalesce(uc.status, '') <> 'ANULADO'),
        'MANUAL'),
      'viaje', f.dispatch_number, 'solicitud', f.request_number, 'estado_viaje', f.ds)
      ORDER BY f.fecha, f.placa, f.vuelta)
    -- Los filtros se aplican después de numerar vueltas y viajes del día: filtrar no cambia los datos de una fila
    FROM f WHERE (p_plate IS NULL OR upper(replace(coalesce(f.placa, ''), ' ', '')) LIKE '%' || upper(replace(p_plate, ' ', '')) || '%')
      AND (p_driver IS NULL OR coalesce(f.conductor, '') ILIKE '%' || p_driver || '%')), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.fr_dt_004_report(date, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fr_dt_004_report(date, date, text, text) TO authenticated;
