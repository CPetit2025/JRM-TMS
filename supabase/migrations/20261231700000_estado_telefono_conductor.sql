-- Estado del teléfono del conductor: además de lo que ya guarda el aviso de conexión, si el app tiene ubicación
-- precisa, ubicación «todo el tiempo» y notificaciones. El Monitoreo GPS muestra lo que falta para que el teléfono
-- quede listo para la ruta. Mismo cuerpo que en producción (20261019100000) más las tres claves; conserva los permisos.
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
    'location_ok', CASE WHEN jsonb_typeof(p_client->'location_ok') = 'boolean' THEN p_client->'location_ok' END,
    'background_location', CASE WHEN jsonb_typeof(p_client->'background_location') = 'boolean' THEN p_client->'background_location' END,
    'notifications_ok', CASE WHEN jsonb_typeof(p_client->'notifications_ok') = 'boolean' THEN p_client->'notifications_ok' END,
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
