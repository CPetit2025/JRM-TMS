BEGIN;

-- Preserve late GPS samples as coverage gaps without moving the latest position backwards.
CREATE OR REPLACE FUNCTION public.record_route_track_point()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE prev public.route_track_points%ROWTYPE;
DECLARE assigned_driver uuid;
DECLARE dispatch_status text;
DECLARE seconds_gap double precision;
DECLARE displacement_m double precision;
BEGIN
  IF EXISTS (SELECT 1 FROM public.route_track_points WHERE id = NEW.id) THEN
    RETURN NULL;
  END IF;
  SELECT driver_id, status INTO assigned_driver, dispatch_status
  FROM public.dispatches WHERE id = NEW.dispatch_id FOR UPDATE;
  IF assigned_driver IS NULL OR assigned_driver <> NEW.driver_id
    OR dispatch_status NOT IN ('EN RUTA', 'EN_CURSO', 'RETORNO') THEN
    RAISE EXCEPTION 'Despacho sin conductor activo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.drivers WHERE id = NEW.driver_id
    AND profile_id = auth.uid() AND is_active = true) THEN
    RAISE EXCEPTION 'Conductor no autorizado';
  END IF;
  IF NEW.recorded_at > now() + interval '30 seconds'
    OR NEW.recorded_at < now() - interval '7 days' THEN
    RAISE EXCEPTION 'Marca de tiempo GPS fuera de rango';
  END IF;
  SELECT * INTO prev FROM public.route_track_points
  WHERE dispatch_id = NEW.dispatch_id ORDER BY recorded_at DESC, created_at DESC LIMIT 1;
  IF FOUND AND NEW.recorded_at <= prev.recorded_at THEN
    NEW.cumulative_m := prev.cumulative_m;
    NEW.gap_detected := true;
    RETURN NEW;
  END IF;
  SELECT coalesce(min(sequence_order), 0) INTO NEW.leg_order
  FROM public.dispatch_requests
  WHERE dispatch_id = NEW.dispatch_id AND status <> 'ENTREGADO';
  NEW.cumulative_m := coalesce(prev.cumulative_m, 0);
  IF prev.id IS NOT NULL THEN
    seconds_gap := extract(epoch FROM (NEW.recorded_at - prev.recorded_at));
    NEW.gap_detected := seconds_gap > 120;
    displacement_m := 6371000 * 2 * asin(sqrt(
      power(sin(radians((NEW.latitude - prev.latitude)::double precision) / 2), 2)
      + cos(radians(prev.latitude::double precision)) * cos(radians(NEW.latitude::double precision))
      * power(sin(radians((NEW.longitude - prev.longitude)::double precision) / 2), 2)
    ));
    IF displacement_m / greatest(seconds_gap, 1) > 55 THEN
      NEW.gap_detected := true;
    ELSIF NOT NEW.gap_detected AND displacement_m >= greatest(3, NEW.accuracy_m, prev.accuracy_m) THEN
      NEW.distance_m := round(displacement_m::numeric, 3);
      NEW.cumulative_m := NEW.cumulative_m + NEW.distance_m;
    END IF;
  END IF;
  UPDATE public.dispatches SET actual_distance_km = round(NEW.cumulative_m / 1000, 3),
    last_lat = NEW.latitude, last_lon = NEW.longitude, last_gps_at = NEW.recorded_at
  WHERE id = NEW.dispatch_id;
  RETURN NEW;
END $$;

COMMIT;
