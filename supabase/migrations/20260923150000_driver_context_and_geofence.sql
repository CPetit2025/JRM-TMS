BEGIN;

-- The remote driver table predates the license expiration column used by the
-- portal context. Its absence caused the whole conductor context to fail.
ALTER TABLE public.drivers ADD COLUMN IF NOT EXISTS license_expiration date;
UPDATE public.drivers d SET license_expiration = p.license_expiration
FROM public.profiles p WHERE p.id = d.profile_id
  AND d.license_expiration IS NULL AND p.license_expiration IS NOT NULL;

CREATE OR REPLACE FUNCTION public.sync_driver_to_profile()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_role_id uuid; v_email text;
BEGIN
  IF NEW.profile_id IS NULL THEN RETURN NEW; END IF;
  SELECT id INTO v_role_id FROM public.roles WHERE name = 'Conductor';
  SELECT email INTO v_email FROM auth.users WHERE id = NEW.profile_id;
  UPDATE public.profiles p SET first_name = NEW.first_name, last_name = NEW.last_name,
    document_number = NEW.document_number, phone = NEW.phone,
    license_type = NEW.license_category, license_expiration = NEW.license_expiration,
    username = coalesce(nullif(p.username, ''), v_email), employee_type = 'CONDUCTOR',
    role_id = v_role_id, is_active = NEW.is_active, updated_at = now()
  WHERE p.id = NEW.profile_id AND
    (p.first_name,p.last_name,p.document_number,p.phone,p.license_type,p.license_expiration,
     p.employee_type,p.role_id,p.is_active,p.username) IS DISTINCT FROM
    (NEW.first_name,NEW.last_name,NEW.document_number,NEW.phone,NEW.license_category,
     NEW.license_expiration,'CONDUCTOR'::varchar,v_role_id,NEW.is_active,
     coalesce(nullif(p.username, ''), v_email));
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.sync_profile_to_driver()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.drivers d SET first_name = NEW.first_name, last_name = NEW.last_name,
    document_number = NEW.document_number, phone = NEW.phone,
    license_category = coalesce(NEW.license_type, d.license_category),
    license_expiration = NEW.license_expiration,
    is_active = NEW.is_active, updated_at = now()
  WHERE d.profile_id = NEW.id AND
    (d.first_name,d.last_name,d.document_number,d.phone,d.license_category,
     d.license_expiration,d.is_active) IS DISTINCT FROM
    (NEW.first_name,NEW.last_name,NEW.document_number,NEW.phone,
     coalesce(NEW.license_type,d.license_category),NEW.license_expiration,NEW.is_active);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS sync_driver_to_profile ON public.drivers;
CREATE TRIGGER sync_driver_to_profile AFTER INSERT OR UPDATE OF profile_id, first_name,
  last_name, document_number, phone, license_category, license_expiration, is_active
  ON public.drivers FOR EACH ROW EXECUTE FUNCTION public.sync_driver_to_profile();
DROP TRIGGER IF EXISTS sync_profile_to_driver ON public.profiles;
CREATE TRIGGER sync_profile_to_driver AFTER UPDATE OF first_name, last_name, document_number,
  phone, license_type, license_expiration, is_active ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.sync_profile_to_driver();

-- Ray casting against the polygons managed in Configuración > Ubicaciones.
CREATE OR REPLACE FUNCTION public.point_inside_polygon(p_lat double precision,
  p_lon double precision, p_coordinates jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = public, pg_temp AS $$
DECLARE v_inside boolean := false; v_count integer; i integer; j integer;
DECLARE xi double precision; yi double precision; xj double precision; yj double precision;
BEGIN
  v_count := jsonb_array_length(p_coordinates);
  IF v_count < 3 THEN RETURN false; END IF;
  j := v_count - 1;
  FOR i IN 0..v_count - 1 LOOP
    xi := (p_coordinates->i->>0)::double precision;
    yi := (p_coordinates->i->>1)::double precision;
    xj := (p_coordinates->j->>0)::double precision;
    yj := (p_coordinates->j->>1)::double precision;
    IF ((yi > p_lon) <> (yj > p_lon)) AND
       (p_lat < (xj - xi) * (p_lon - yi) / nullif(yj - yi, 0) + xi) THEN
      v_inside := NOT v_inside;
    END IF;
    j := i;
  END LOOP;
  RETURN v_inside;
END $$;

CREATE OR REPLACE FUNCTION public.validate_operational_geofence(p_lat double precision,
  p_lon double precision)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_zone record; v_has_polygons boolean;
BEGIN
  IF p_lat NOT BETWEEN -90 AND 90 OR p_lon NOT BETWEEN -180 AND 180 THEN
    RETURN jsonb_build_object('valid',false,'reason','Coordenadas inválidas');
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.geofences WHERE is_active = true
    AND type IN ('cedi','depot') AND jsonb_array_length(coordinates) >= 3) INTO v_has_polygons;
  IF v_has_polygons THEN
    SELECT id,name,type INTO v_zone FROM public.geofences WHERE is_active = true
      AND type IN ('cedi','depot') AND public.point_inside_polygon(p_lat,p_lon,coordinates)
      LIMIT 1;
    RETURN jsonb_build_object('valid',v_zone.id IS NOT NULL,'zone_id',v_zone.id,
      'zone_name',v_zone.name,'source','geofences',
      'reason',CASE WHEN v_zone.id IS NULL THEN 'Fuera de una geocerca CEDI o depósito autorizada' ELSE NULL END);
  END IF;
  SELECT id,name,'authorized_location' AS type INTO v_zone FROM public.authorized_locations
    WHERE is_active = true AND 6371 * 2 * asin(sqrt(
      power(sin(radians((p_lat - latitude)::double precision) / 2),2) +
      cos(radians(latitude::double precision)) * cos(radians(p_lat)) *
      power(sin(radians((p_lon - longitude)::double precision) / 2),2))) <= radius_km LIMIT 1;
  RETURN jsonb_build_object('valid',v_zone.id IS NOT NULL,'zone_id',v_zone.id,
    'zone_name',v_zone.name,'source','authorized_locations',
    'reason',CASE WHEN v_zone.id IS NULL THEN 'Fuera de una geocerca autorizada' ELSE NULL END);
END $$;
REVOKE ALL ON FUNCTION public.validate_operational_geofence(double precision,double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.validate_operational_geofence(double precision,double precision) TO authenticated;

CREATE OR REPLACE FUNCTION public.validate_driver_checklist()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_validation jsonb;
BEGIN
  IF NEW.location_lat IS NULL OR NEW.location_lon IS NULL THEN RAISE EXCEPTION 'GPS requerido para checklist'; END IF;
  v_validation := public.validate_operational_geofence(NEW.location_lat, NEW.location_lon);
  IF NOT coalesce((v_validation->>'valid')::boolean,false) THEN
    RAISE EXCEPTION '%', coalesce(v_validation->>'reason','Fuera de geocerca autorizada');
  END IF;
  IF NEW.photo_url IS NULL OR NOT EXISTS (SELECT 1 FROM storage.objects o
    WHERE o.bucket_id = 'driver_evidence' AND o.name = NEW.photo_url
      AND (storage.foldername(o.name))[1] = auth.uid()::text) THEN
    RAISE EXCEPTION 'Falta fotografía verificable';
  END IF;
  RETURN NEW;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
