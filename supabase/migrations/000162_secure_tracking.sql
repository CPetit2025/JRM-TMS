-- Apply before deploying the matching web client. GPS distances come from ordered
-- device fixes; missing coverage is recorded instead of being estimated.
BEGIN;

-- Prototype policies exposed private rows and allowed anonymous writes.
DO $$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (roles @> ARRAY['anon']::name[] OR roles @> ARRAY['public']::name[])
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
  END LOOP;
END $$;

REVOKE ALL ON public.profiles, public.drivers, public.vehicles,
  public.transport_budgets, public.clients, public.budget_extensions,
  public.carriers, public.roles, public.work_orders FROM anon;
GRANT SELECT (id, business_name) ON public.carriers TO anon;
CREATE POLICY carriers_public_names ON public.carriers FOR SELECT TO anon USING (is_active = true);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_orders ENABLE ROW LEVEL SECURITY;

INSERT INTO public.roles (name, description, permissions)
VALUES ('Administrador', 'Administración del sistema', '["usuarios","despacho","monitoreo","flota"]'::jsonb)
ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions;
UPDATE public.profiles
SET role_id = (SELECT id FROM public.roles WHERE name = 'Administrador')
WHERE lower(username) = 'cpetit@jrmsac.com.pe';

CREATE OR REPLACE FUNCTION public.is_tms_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
    WHERE p.id = auth.uid() AND p.is_active = true AND r.name = 'Administrador'
  );
$$;
REVOKE ALL ON FUNCTION public.is_tms_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_tms_admin() TO authenticated;

CREATE OR REPLACE FUNCTION public.has_tms_permission(p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
    WHERE p.id = auth.uid() AND p.is_active = true
      AND (r.name = 'Administrador' OR r.permissions ? p_permission
        OR r.permissions ? (p_permission || ':write'))
  );
$$;
REVOKE ALL ON FUNCTION public.has_tms_permission(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_tms_permission(text) TO authenticated;

DROP POLICY IF EXISTS "Allow all authenticated on profiles" ON public.profiles;
DROP POLICY IF EXISTS "Allow all authenticated on drivers" ON public.drivers;
DROP POLICY IF EXISTS "Allow all authenticated on clients" ON public.clients;
DROP POLICY IF EXISTS "Allow all authenticated on work orders" ON public.work_orders;
CREATE POLICY profiles_read ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.is_tms_admin());
CREATE POLICY profiles_admin_insert ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (public.is_tms_admin());
CREATE POLICY profiles_admin_update ON public.profiles FOR UPDATE TO authenticated
  USING (public.is_tms_admin()) WITH CHECK (public.is_tms_admin());
CREATE POLICY profiles_admin_delete ON public.profiles FOR DELETE TO authenticated
  USING (public.is_tms_admin());

CREATE POLICY drivers_read ON public.drivers FOR SELECT TO authenticated
  USING (profile_id = auth.uid() OR public.has_tms_permission('despacho')
    OR public.has_tms_permission('flota') OR public.has_tms_permission('mantenimiento-flota'));
CREATE POLICY drivers_manage ON public.drivers FOR ALL TO authenticated
  USING (public.has_tms_permission('flota') OR public.has_tms_permission('mantenimiento-flota'))
  WITH CHECK (public.has_tms_permission('flota') OR public.has_tms_permission('mantenimiento-flota'));
CREATE POLICY clients_read ON public.clients FOR SELECT TO authenticated
  USING (public.has_tms_permission('clientes') OR public.has_tms_permission('solicitudes')
    OR public.has_tms_permission('despacho'));
CREATE POLICY clients_write ON public.clients FOR ALL TO authenticated
  USING (public.has_tms_permission('clientes')) WITH CHECK (public.has_tms_permission('clientes'));
CREATE POLICY roles_read ON public.roles FOR SELECT TO authenticated USING (true);
CREATE POLICY roles_admin_write ON public.roles FOR ALL TO authenticated
  USING (public.is_tms_admin()) WITH CHECK (public.is_tms_admin());
CREATE POLICY work_orders_staff ON public.work_orders FOR ALL TO authenticated
  USING (public.has_tms_permission('ot')) WITH CHECK (public.has_tms_permission('ot'));

-- Only dispatch staff may issue tracking credentials. New links use eight digits.
CREATE OR REPLACE FUNCTION public.generate_daily_tracking_link(p_date date)
RETURNS TABLE(token uuid, pin text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_token uuid := gen_random_uuid();
DECLARE v_pin text := lpad(floor(random() * 100000000)::text, 8, '0');
DECLARE v_expires timestamptz := now() + interval '24 hours';
BEGIN
  IF NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Sin permiso para generar enlaces'; END IF;
  INSERT INTO public.daily_tracking_links(planning_date, tracking_token, tracking_pin, expires_at)
  VALUES (p_date, v_token, v_pin, v_expires)
  ON CONFLICT (planning_date) DO UPDATE SET tracking_token = EXCLUDED.tracking_token,
    tracking_pin = EXCLUDED.tracking_pin, expires_at = EXCLUDED.expires_at;
  RETURN QUERY SELECT v_token, v_pin, v_expires;
END $$;
REVOKE ALL ON FUNCTION public.generate_daily_tracking_link(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_daily_tracking_link(date) TO authenticated;

CREATE OR REPLACE FUNCTION public.generate_tracking_link(p_dispatch_id uuid)
RETURNS TABLE(token uuid, pin text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_token uuid := gen_random_uuid();
DECLARE v_pin text := lpad(floor(random() * 100000000)::text, 8, '0');
DECLARE v_expires timestamptz := now() + interval '24 hours';
BEGIN
  IF NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Sin permiso para generar enlaces'; END IF;
  UPDATE public.dispatches SET tracking_token = v_token, tracking_pin = v_pin,
    tracking_expires_at = v_expires WHERE id = p_dispatch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Despacho inexistente'; END IF;
  RETURN QUERY SELECT v_token, v_pin, v_expires;
END $$;
REVOKE ALL ON FUNCTION public.generate_tracking_link(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_tracking_link(uuid) TO authenticated;

-- Remove credentials that were stored in ordinary application rows.
UPDATE public.profiles SET mock_password = NULL WHERE mock_password IS NOT NULL;
UPDATE public.drivers SET pin = NULL WHERE pin IS NOT NULL;

-- The former SECURITY DEFINER RPC allowed anonymous takeover of a driver by DNI.
REVOKE ALL ON FUNCTION public.register_driver(uuid,text,text,text,text,text,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.register_driver(varchar,varchar,varchar,varchar,varchar,varchar,varchar,date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_driver(uuid,text,text,text,text,text,text,uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.register_driver(
  p_auth_user_id uuid, p_dni text, p_first_name text, p_last_name text,
  p_phone text, p_license_number text, p_pin text, p_carrier_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.drivers WHERE document_number = p_dni) THEN
    RAISE EXCEPTION 'El DNI ya está registrado';
  END IF;
  INSERT INTO public.drivers (
    carrier_id, profile_id, document_number, first_name, last_name, phone,
    license_number, license_category, pin, is_active
  ) VALUES (
    p_carrier_id, p_auth_user_id, p_dni, p_first_name, p_last_name,
    NULLIF(p_phone, ''), p_license_number, 'A-I', NULL, false
  ) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS driver_id uuid REFERENCES public.drivers(id);
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS start_lat numeric(10,7);
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS start_lon numeric(10,7);
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS actual_distance_km numeric(12,3) NOT NULL DEFAULT 0;
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS last_lat numeric(10,7);
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS last_lon numeric(10,7);
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS last_gps_at timestamptz;
ALTER TABLE public.dispatch_requests ADD COLUMN IF NOT EXISTS leg_actual_km numeric(12,3);
ALTER TABLE public.dispatch_requests ADD COLUMN IF NOT EXISTS leg_gps_complete boolean;
ALTER TABLE public.dispatch_requests ADD COLUMN IF NOT EXISTS arrival_lat numeric(10,7);
ALTER TABLE public.dispatch_requests ADD COLUMN IF NOT EXISTS arrival_lon numeric(10,7);

-- Backfill only names that uniquely identify one driver.
WITH unique_names AS (
  SELECT min(id::text)::uuid AS id, trim(first_name || ' ' || last_name) AS full_name
  FROM public.drivers GROUP BY trim(first_name || ' ' || last_name) HAVING count(*) = 1
)
UPDATE public.dispatches d SET driver_id = n.id FROM unique_names n
WHERE d.driver_id IS NULL AND d.driver_name = n.full_name;

CREATE TABLE IF NOT EXISTS public.route_track_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id uuid NOT NULL REFERENCES public.dispatches(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL REFERENCES public.drivers(id),
  recorded_at timestamptz NOT NULL,
  latitude numeric(10,7) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(10,7) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_m numeric(8,2) NOT NULL CHECK (accuracy_m BETWEEN 0 AND 30),
  speed_mps numeric(8,2),
  leg_order integer NOT NULL DEFAULT 0,
  distance_m numeric(12,3) NOT NULL DEFAULT 0,
  cumulative_m numeric(14,3) NOT NULL DEFAULT 0,
  gap_detected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS route_track_points_dispatch_time
  ON public.route_track_points(dispatch_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS route_track_points_dispatch_leg
  ON public.route_track_points(dispatch_id, leg_order);
ALTER TABLE public.route_track_points ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.route_track_points TO authenticated;
CREATE POLICY route_track_read ON public.route_track_points FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.drivers d WHERE d.id = driver_id AND d.profile_id = auth.uid())
    OR public.has_tms_permission('monitoreo') OR public.has_tms_permission('despacho'));
CREATE POLICY route_track_insert ON public.route_track_points FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.drivers d JOIN public.dispatches s ON s.driver_id = d.id
    WHERE d.id = driver_id AND d.profile_id = auth.uid() AND d.is_active = true
      AND s.id = dispatch_id AND s.status IN ('EN RUTA', 'EN_CURSO', 'RETORNO')
  ));

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
    RAISE EXCEPTION 'Las muestras GPS deben llegar en orden';
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
CREATE TRIGGER route_track_before_insert BEFORE INSERT ON public.route_track_points
FOR EACH ROW EXECUTE FUNCTION public.record_route_track_point();

CREATE OR REPLACE FUNCTION public.complete_dispatch_stop(p_dispatch_id uuid, p_request_id uuid, p_photo_url text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_driver uuid;
DECLARE v_order integer;
DECLARE v_last public.route_track_points%ROWTYPE;
DECLARE v_km numeric;
DECLARE v_complete boolean;
BEGIN
  SELECT driver_id INTO v_driver FROM public.dispatches
  WHERE id = p_dispatch_id AND status IN ('EN RUTA', 'EN_CURSO') FOR UPDATE;
  IF v_driver IS NULL OR NOT EXISTS (SELECT 1 FROM public.drivers
    WHERE id = v_driver AND profile_id = auth.uid() AND is_active = true) THEN
    RAISE EXCEPTION 'Ruta no autorizada';
  END IF;
  IF p_photo_url IS NULL OR NOT EXISTS (SELECT 1 FROM storage.objects o
    WHERE o.bucket_id = 'driver_evidence' AND o.name = p_photo_url
      AND (storage.foldername(o.name))[1] = auth.uid()::text) THEN
    RAISE EXCEPTION 'Falta fotografía verificable';
  END IF;
  SELECT sequence_order INTO v_order FROM public.dispatch_requests
  WHERE dispatch_id = p_dispatch_id AND transport_request_id = p_request_id AND status <> 'ENTREGADO';
  IF v_order IS NULL OR v_order <> (SELECT min(sequence_order) FROM public.dispatch_requests
    WHERE dispatch_id = p_dispatch_id AND status <> 'ENTREGADO') THEN
    RAISE EXCEPTION 'Punto fuera de secuencia';
  END IF;
  SELECT * INTO v_last FROM public.route_track_points
  WHERE dispatch_id = p_dispatch_id AND leg_order = v_order
  ORDER BY recorded_at DESC LIMIT 1;
  IF v_last.id IS NULL OR v_last.recorded_at < now() - interval '45 seconds' THEN
    RAISE EXCEPTION 'Se requiere una señal GPS reciente';
  END IF;
  SELECT round(coalesce(sum(distance_m), 0) / 1000, 3),
    count(*) >= 2 AND NOT bool_or(gap_detected)
  INTO v_km, v_complete FROM public.route_track_points
  WHERE dispatch_id = p_dispatch_id AND leg_order = v_order;
  UPDATE public.dispatch_requests SET status = 'ENTREGADO', leg_actual_km = v_km,
    leg_gps_complete = v_complete, arrival_lat = v_last.latitude, arrival_lon = v_last.longitude
  WHERE dispatch_id = p_dispatch_id AND transport_request_id = p_request_id;
  UPDATE public.transport_requests SET status = 'ENTREGADA' WHERE id = p_request_id;
  INSERT INTO public.route_stops_log(dispatch_id, transport_request_id, driver_id,
    stop_type, odometer_km, photo_url)
  VALUES (p_dispatch_id, p_request_id, v_driver, 'ENTREGA', v_last.cumulative_m / 1000, p_photo_url);
  RETURN jsonb_build_object('leg_actual_km', v_km, 'leg_gps_complete', v_complete,
    'arrival_lat', v_last.latitude, 'arrival_lon', v_last.longitude);
END $$;
REVOKE ALL ON FUNCTION public.complete_dispatch_stop(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_dispatch_stop(uuid,uuid,text) TO authenticated;

DROP POLICY IF EXISTS "Permitir lectura y escritura a checklist" ON public.driver_checklists;
CREATE POLICY driver_checklist_read ON public.driver_checklists FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.drivers d WHERE d.id = driver_id AND d.profile_id = auth.uid())
    OR public.has_tms_permission('despacho'));
CREATE POLICY driver_checklist_insert ON public.driver_checklists FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.drivers d JOIN public.dispatches s ON s.driver_id = d.id
    WHERE d.id = driver_id AND d.profile_id = auth.uid() AND d.is_active = true
      AND s.id = dispatch_id AND s.status IN ('PROGRAMADO', 'EN_CURSO')));
CREATE OR REPLACE FUNCTION public.validate_driver_checklist()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.location_lat IS NULL OR NEW.location_lon IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM public.authorized_locations l WHERE l.is_active = true
        AND 6371 * 2 * asin(sqrt(
          power(sin(radians((NEW.location_lat - l.latitude)::double precision) / 2), 2)
          + cos(radians(l.latitude::double precision)) * cos(radians(NEW.location_lat::double precision))
          * power(sin(radians((NEW.location_lon - l.longitude)::double precision) / 2), 2)
        )) <= l.radius_km
    ) THEN
    RAISE EXCEPTION 'Fuera de geocerca autorizada';
  END IF;
  IF NEW.photo_url IS NULL OR NOT EXISTS (SELECT 1 FROM storage.objects o
    WHERE o.bucket_id = 'driver_evidence' AND o.name = NEW.photo_url
      AND (storage.foldername(o.name))[1] = auth.uid()::text) THEN
    RAISE EXCEPTION 'Falta fotografía verificable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER driver_checklist_validate BEFORE INSERT ON public.driver_checklists
FOR EACH ROW EXECUTE FUNCTION public.validate_driver_checklist();
DROP POLICY IF EXISTS "Permitir lectura y escritura a route_stops" ON public.route_stops_log;
CREATE POLICY driver_stops_read ON public.route_stops_log FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.drivers d WHERE d.id = driver_id AND d.profile_id = auth.uid())
    OR public.has_tms_permission('despacho'));

-- Validated public links may see only the latest fix for that planning day.
CREATE OR REPLACE FUNCTION public.get_public_daily_tracking_locations(p_token uuid, p_pin text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'dispatch_id', d.id, 'driver_name', d.driver_name, 'vehicle_plate', d.vehicle_plate,
    'lat', d.last_lat, 'lng', d.last_lon, 'last_gps_at', d.last_gps_at,
    'actual_distance_km', d.actual_distance_km
  )), '[]'::jsonb)
  FROM public.daily_tracking_links l JOIN public.dispatches d
    ON d.scheduled_departure::date = l.planning_date
  WHERE l.tracking_token = p_token AND l.tracking_pin = p_pin
    AND l.expires_at > now() AND d.last_gps_at > now() - interval '15 minutes';
$$;
REVOKE ALL ON FUNCTION public.get_public_daily_tracking_locations(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_daily_tracking_locations(uuid,text) TO anon, authenticated;

INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
VALUES ('driver_evidence', 'driver_evidence', false, 10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE SET public = false;
DROP POLICY IF EXISTS driver_evidence_upload ON storage.objects;
DROP POLICY IF EXISTS driver_evidence_read ON storage.objects;
DROP POLICY IF EXISTS driver_evidence_delete ON storage.objects;
CREATE POLICY driver_evidence_upload ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'driver_evidence' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY driver_evidence_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'driver_evidence' AND
    ((storage.foldername(name))[1] = auth.uid()::text OR public.has_tms_permission('despacho')));
CREATE POLICY driver_evidence_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'driver_evidence' AND (storage.foldername(name))[1] = auth.uid()::text);

COMMIT;
