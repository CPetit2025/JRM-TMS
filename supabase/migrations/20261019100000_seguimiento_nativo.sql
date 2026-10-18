-- ============================================================
-- Seguimiento nativo del app del conductor (Fase 2)
-- ============================================================
-- El servicio de Android sube los puntos GPS y el aviso de conexión por sí mismo, aunque el app web esté congelado
-- (pantalla apagada, app en segundo plano) o la sesión web haya vencido. Usa una credencial del dispositivo:
--   · register_tracking_device(): el conductor con sesión obtiene un token aleatorio (256 bits) para su teléfono;
--     la base guarda solo su hash SHA-256. Un dispositivo nuevo revoca los anteriores del mismo conductor.
--   · native_tracking_sync(token, puntos, estado): valida el token, el conductor y su perfil activos, y registra los
--     puntos con las mismas reglas que el app (orden, ruta en curso, plazo) actuando como ese conductor. Devuelve los
--     puntos aceptados y rechazados para que el teléfono los quite de su cola. Actualiza el aviso de conexión.
--   · El cierre de sesión (driver_app_disconnect) revoca los dispositivos del conductor.
--   · El estado del teléfono admite además power_save (ahorro de batería) y battery_exempt (exento de optimización).
BEGIN;

CREATE TABLE IF NOT EXISTS public.driver_tracking_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS driver_tracking_devices_driver_idx ON public.driver_tracking_devices(driver_id);
CREATE INDEX IF NOT EXISTS driver_tracking_devices_profile_idx ON public.driver_tracking_devices(profile_id);
ALTER TABLE public.driver_tracking_devices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.driver_tracking_devices;
CREATE POLICY security_active_account ON public.driver_tracking_devices AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.driver_tracking_devices FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.driver_tracking_devices TO service_role;

CREATE OR REPLACE FUNCTION public.tracking_token_hash(p_token text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');
$$;
REVOKE ALL ON FUNCTION public.tracking_token_hash(text) FROM PUBLIC, anon, authenticated;

-- El conductor con sesión registra su teléfono; el token solo se muestra esta vez
CREATE OR REPLACE FUNCTION public.register_tracking_device(p_label text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_driver uuid; v_token text;
BEGIN
  SELECT d.id INTO v_driver FROM public.drivers d JOIN public.profiles p ON p.id = d.profile_id
   WHERE d.profile_id = auth.uid() AND d.is_active AND p.is_active ORDER BY d.id LIMIT 1;
  IF v_driver IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Conductor activo no vinculado'); END IF;
  UPDATE public.driver_tracking_devices SET revoked_at = now() WHERE profile_id = auth.uid() AND revoked_at IS NULL;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  INSERT INTO public.driver_tracking_devices(driver_id, profile_id, token_hash, label)
  VALUES (v_driver, auth.uid(), public.tracking_token_hash(v_token), left(NULLIF(btrim(p_label), ''), 80));
  RETURN jsonb_build_object('success', true, 'token', v_token, 'driver_id', v_driver);
END $$;
REVOKE ALL ON FUNCTION public.register_tracking_device(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_tracking_device(text) TO authenticated;

-- Sincronización del servicio nativo (sin sesión web): el token identifica al conductor
CREATE OR REPLACE FUNCTION public.native_tracking_sync(p_token text, p_points jsonb DEFAULT '[]'::jsonb, p_client jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE dev record; pt jsonb; v_id uuid; accepted jsonb := '[]'::jsonb; rejected jsonb := '[]'::jsonb; last_pt jsonb; v_lat numeric;
BEGIN
  IF p_token IS NULL OR length(p_token) <> 64 THEN RETURN jsonb_build_object('success', false, 'error', 'Dispositivo no autorizado'); END IF;
  SELECT t.id, t.driver_id, t.profile_id INTO dev FROM public.driver_tracking_devices t
    JOIN public.drivers d ON d.id = t.driver_id AND d.is_active AND d.profile_id = t.profile_id
    JOIN public.profiles p ON p.id = t.profile_id AND p.is_active
   WHERE t.token_hash = public.tracking_token_hash(p_token) AND t.revoked_at IS NULL;
  IF dev.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Dispositivo no autorizado'); END IF;
  IF jsonb_typeof(p_points) IS DISTINCT FROM 'array' OR jsonb_array_length(p_points) > 500 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Lote de puntos no válido');
  END IF;
  -- Actúa como el conductor dueño del dispositivo: las reglas de los puntos y del aviso usan auth.uid()
  PERFORM set_config('request.jwt.claim.sub', dev.profile_id::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', dev.profile_id, 'role', 'authenticated')::text, true);
  UPDATE public.driver_tracking_devices SET last_used_at = now() WHERE id = dev.id;

  FOR pt IN SELECT value FROM jsonb_array_elements(p_points) ORDER BY value->>'recorded_at', value->>'id' LOOP
    BEGIN
      v_id := (pt->>'id')::uuid;
      INSERT INTO public.route_track_points(id, dispatch_id, driver_id, recorded_at, latitude, longitude, accuracy_m, speed_mps)
      VALUES (v_id, (pt->>'dispatch_id')::uuid, dev.driver_id, (pt->>'recorded_at')::timestamptz,
        (pt->>'latitude')::numeric, (pt->>'longitude')::numeric, (pt->>'accuracy_m')::numeric,
        CASE WHEN pt->>'speed_mps' IS NOT NULL AND (pt->>'speed_mps')::numeric BETWEEN 0 AND 100 THEN (pt->>'speed_mps')::numeric END);
      accepted := accepted || to_jsonb(v_id::text);
      last_pt := pt;
    EXCEPTION WHEN OTHERS THEN
      -- Rechazo permanente (fuera de orden, ruta cerrada, plazo, datos inválidos): el teléfono lo descarta
      rejected := rejected || to_jsonb(COALESCE(pt->>'id', ''));
    END;
  END LOOP;

  -- Aviso de conexión con el último punto aceptado (si no hay, solo la conexión y el estado del teléfono)
  BEGIN
    v_lat := (last_pt->>'latitude')::numeric;
    PERFORM public.driver_app_heartbeat(
      CASE WHEN COALESCE(p_client->>'gps_state', '') IN ('checking', 'active', 'denied', 'unavailable') THEN p_client->>'gps_state' ELSE 'active' END,
      v_lat, CASE WHEN v_lat IS NOT NULL THEN (last_pt->>'longitude')::numeric END,
      CASE WHEN v_lat IS NOT NULL THEN (last_pt->>'accuracy_m')::numeric END, NULL,
      CASE WHEN v_lat IS NOT NULL THEN (last_pt->>'recorded_at')::timestamptz END,
      COALESCE(p_client, '{}'::jsonb) || jsonb_build_object('native_tracking', true));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN jsonb_build_object('success', true, 'accepted', accepted, 'rejected', rejected);
END $$;
REVOKE ALL ON FUNCTION public.native_tracking_sync(text, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.native_tracking_sync(text, jsonb, jsonb) TO anon, authenticated, service_role;

-- Estado del teléfono: el servicio nativo también informa ahorro de batería y exención de optimización
CREATE OR REPLACE FUNCTION public.driver_app_heartbeat(p_gps_state text, p_lat numeric, p_lon numeric, p_accuracy numeric,
  p_speed_mps numeric, p_recorded_at timestamptz, p_client jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_result jsonb; v_info jsonb; v_pending integer; v_oldest timestamptz;
  num_or_null CONSTANT text := '^-?[0-9]+(\.[0-9]+)?$';
BEGIN
  v_result := public.driver_app_heartbeat(p_gps_state, p_lat, p_lon, p_accuracy, p_speed_mps, p_recorded_at);
  IF NOT COALESCE((v_result->>'success')::boolean, false) OR jsonb_typeof(p_client) IS DISTINCT FROM 'object' THEN RETURN v_result; END IF;
  v_info := jsonb_strip_nulls(jsonb_build_object(
    'battery', CASE WHEN p_client->>'battery' ~ num_or_null THEN
                 CASE WHEN (p_client->>'battery')::numeric BETWEEN 0 AND 1 THEN round((p_client->>'battery')::numeric, 2) END END,
    'charging', CASE WHEN jsonb_typeof(p_client->'charging') = 'boolean' THEN p_client->'charging' END,
    'network', left(NULLIF(btrim(p_client->>'network'), ''), 20),
    'online', CASE WHEN jsonb_typeof(p_client->'online') = 'boolean' THEN p_client->'online' END,
    'visibility', CASE WHEN p_client->>'visibility' IN ('visible', 'hidden') THEN p_client->>'visibility' END,
    'platform', left(NULLIF(btrim(p_client->>'platform'), ''), 20),
    'native_tracking', CASE WHEN jsonb_typeof(p_client->'native_tracking') = 'boolean' THEN p_client->'native_tracking' END,
    'power_save', CASE WHEN jsonb_typeof(p_client->'power_save') = 'boolean' THEN p_client->'power_save' END,
    'battery_exempt', CASE WHEN jsonb_typeof(p_client->'battery_exempt') = 'boolean' THEN p_client->'battery_exempt' END,
    'device', left(NULLIF(btrim(p_client->>'device'), ''), 80),
    'app_version', left(NULLIF(btrim(p_client->>'app_version'), ''), 40),
    'reported_at', now()));
  v_pending := CASE WHEN p_client->>'pending_points' ~ '^[0-9]{1,7}$' THEN (p_client->>'pending_points')::integer END;
  BEGIN v_oldest := (p_client->>'oldest_pending_at')::timestamptz; EXCEPTION WHEN OTHERS THEN v_oldest := NULL; END;
  IF v_oldest IS NOT NULL AND (v_oldest > now() + interval '1 minute' OR v_oldest < now() - interval '30 days') THEN v_oldest := NULL; END IF;
  UPDATE public.driver_app_presence SET client_info = v_info, pending_points = v_pending,
    oldest_pending_at = CASE WHEN COALESCE(v_pending, 0) > 0 THEN v_oldest END
   WHERE profile_id = auth.uid();
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.driver_app_heartbeat(text, numeric, numeric, numeric, numeric, timestamptz, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_app_heartbeat(text, numeric, numeric, numeric, numeric, timestamptz, jsonb) TO authenticated;

-- Cerrar sesión también revoca el seguimiento nativo del teléfono
CREATE OR REPLACE FUNCTION public.driver_app_disconnect() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.driver_app_presence SET disconnected_at = now() WHERE profile_id = auth.uid();
  UPDATE public.driver_tracking_devices SET revoked_at = now() WHERE profile_id = auth.uid() AND revoked_at IS NULL;
END $$;
REVOKE ALL ON FUNCTION public.driver_app_disconnect() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_app_disconnect() TO authenticated;

COMMIT;
