-- ============================================================
-- Seguimiento nativo: el punto de una ruta ya cerrada vuelve a informarse como rechazado
-- ============================================================
-- 20261021110000 lo informaba como aceptado cuando el conductor tenía horas extras abiertas. En ambos casos el
-- teléfono lo descarta, pero «rechazado» es el contrato del seguimiento (C114). El punto sigue alimentando la
-- geocerca de cierre de las horas extras antes de descartarse.
BEGIN;
SET LOCAL lock_timeout = '60s';

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
      -- Ruta ya cerrada pero con horas extras abiertas: el punto alimenta la geocerca de cierre y se descarta igual
      IF public.hhee_driver_has_open(dev.driver_id) AND (pt->>'latitude') IS NOT NULL THEN
        BEGIN
          PERFORM public.hhee_geo_point(dev.driver_id, (pt->>'latitude')::numeric, (pt->>'longitude')::numeric, (pt->>'recorded_at')::timestamptz);
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
      END IF;
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

NOTIFY pgrst, 'reload schema';
COMMIT;
