-- ============================================================
-- Conectividad del app del conductor: medición y monitor (Fases 0 y 1)
-- ============================================================
-- 1. El aviso de conexión del app trae el estado del teléfono (batería, red, app visible, puntos por enviar):
--    sobrecarga de driver_app_heartbeat con p_client. Las llamadas sin p_client siguen usando la versión anterior.
-- 2. driver_connectivity_gaps: cada vez que el app vuelve a reportar después de más de 90 s, se guarda el corte
--    (desde, hasta, ruta en curso y estado del teléfono antes del corte).
-- 3. get_driver_connectivity_report(días): por conductor, cortes en ruta, huecos de registro GPS, retraso con que
--    llegan los puntos (subida diferida = app en segundo plano o sin datos) y último estado del teléfono.
-- 4. Monitor GPS: devuelve el estado del teléfono y los puntos pendientes para distinguir «intermitente» de
--    «sin conexión». La función del monitor se modifica sobre la versión instalada.
BEGIN;

ALTER TABLE public.driver_app_presence ADD COLUMN IF NOT EXISTS client_info jsonb;
ALTER TABLE public.driver_app_presence ADD COLUMN IF NOT EXISTS pending_points integer;
ALTER TABLE public.driver_app_presence ADD COLUMN IF NOT EXISTS oldest_pending_at timestamptz;

CREATE TABLE IF NOT EXISTS public.driver_connectivity_gaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  dispatch_id uuid REFERENCES public.dispatches(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  seconds integer NOT NULL CHECK (seconds >= 0),
  client_info jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS driver_connectivity_gaps_driver_idx ON public.driver_connectivity_gaps(driver_id, started_at DESC);
CREATE INDEX IF NOT EXISTS driver_connectivity_gaps_dispatch_idx ON public.driver_connectivity_gaps(dispatch_id);
ALTER TABLE public.driver_connectivity_gaps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.driver_connectivity_gaps;
CREATE POLICY security_active_account ON public.driver_connectivity_gaps AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.driver_connectivity_gaps FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.driver_connectivity_gaps TO service_role;

-- Corte de conexión: el app (o un punto GPS subido) vuelve a reportar después de más de 90 s.
-- No cuenta el cierre de sesión (disconnected_at) ni la primera conexión.
CREATE OR REPLACE FUNCTION public.driver_presence_track_gap() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_dispatch uuid;
BEGIN
  IF OLD.last_seen_at IS NOT NULL AND OLD.disconnected_at IS NULL AND NEW.last_seen_at > OLD.last_seen_at + interval '90 seconds' THEN
    SELECT d.id INTO v_dispatch FROM public.dispatches d
     WHERE d.driver_id = NEW.driver_id AND d.status IN ('EN RUTA', 'EN_CURSO', 'RETORNO') ORDER BY d.created_at DESC LIMIT 1;
    INSERT INTO public.driver_connectivity_gaps(driver_id, dispatch_id, started_at, ended_at, seconds, client_info)
    VALUES (NEW.driver_id, v_dispatch, OLD.last_seen_at, NEW.last_seen_at,
      LEAST(extract(epoch FROM NEW.last_seen_at - OLD.last_seen_at), 2147483647)::integer, OLD.client_info);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.driver_presence_track_gap() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS driver_presence_track_gap ON public.driver_app_presence;
CREATE TRIGGER driver_presence_track_gap BEFORE UPDATE OF last_seen_at ON public.driver_app_presence
  FOR EACH ROW EXECUTE FUNCTION public.driver_presence_track_gap();

-- Aviso de conexión con el estado del teléfono. Valores acotados: nada del cliente se guarda sin validar.
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

-- Informe de conectividad por conductor (Monitoreo / Torre de Control / Administrador)
CREATE OR REPLACE FUNCTION public.get_driver_connectivity_report(p_days integer DEFAULT 7) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_from timestamptz; v_rows jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_tms_user() OR NOT
    (public.is_tms_admin() OR public.has_tms_read_permission('monitoreo') OR public.has_tms_read_permission('torre-control')) THEN
    RAISE EXCEPTION 'Sin permiso para el diagnóstico de conexión';
  END IF;
  v_from := now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 7), 1), 31));
  WITH routes AS (
    SELECT d.id, d.driver_id FROM public.dispatches d
     WHERE d.driver_id IS NOT NULL AND COALESCE(d.scheduled_departure, d.created_at) >= v_from - interval '1 day'
       AND (public.is_tms_admin() OR (d.site_id IS NOT NULL AND public.can_access_site(d.site_id)))
  ), points AS (
    -- Retraso de subida = recepción en el servidor − toma del punto (created_at puede no existir: se lee tolerante)
    SELECT q.driver_id, count(*) AS n, count(*) FILTER (WHERE q.gap_detected) AS gps_gaps,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY q.delay_s) AS delay_p50,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY q.delay_s) AS delay_p90,
           count(*) FILTER (WHERE q.delay_s > 120) AS late
      FROM (SELECT j.driver_id, COALESCE((j.row->>'gap_detected')::boolean, false) AS gap_detected,
                   extract(epoch FROM (j.row->>'created_at')::timestamptz - (j.row->>'recorded_at')::timestamptz) AS delay_s
              FROM (SELECT r.driver_id, to_jsonb(p) AS row FROM routes r JOIN public.route_track_points p ON p.dispatch_id = r.id) j
             WHERE (j.row->>'recorded_at')::timestamptz >= v_from) q
     GROUP BY q.driver_id
  ), gaps AS (
    SELECT g.driver_id, count(*) FILTER (WHERE g.dispatch_id IS NOT NULL) AS route_gaps,
           COALESCE(sum(g.seconds) FILTER (WHERE g.dispatch_id IS NOT NULL), 0) AS route_gap_seconds,
           COALESCE(max(g.seconds) FILTER (WHERE g.dispatch_id IS NOT NULL), 0) AS route_gap_max,
           count(*) AS all_gaps
      FROM public.driver_connectivity_gaps g
     WHERE g.started_at >= v_from AND g.driver_id IN (SELECT driver_id FROM routes)
     GROUP BY g.driver_id
  ), drivers AS (SELECT DISTINCT driver_id FROM routes)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'driver_id', dr.id,
      'driver', COALESCE(NULLIF(btrim(concat_ws(' ', to_jsonb(dr)->>'first_name', to_jsonb(dr)->>'last_name')), ''), 'Conductor'),
      'points', COALESCE(pt.n, 0), 'gps_gaps', COALESCE(pt.gps_gaps, 0),
      'delay_p50_s', round(pt.delay_p50::numeric), 'delay_p90_s', round(pt.delay_p90::numeric),
      'late_pct', CASE WHEN COALESCE(pt.n, 0) > 0 THEN round(100.0 * pt.late / pt.n, 1) END,
      'route_gaps', COALESCE(g.route_gaps, 0), 'route_gap_minutes', round(COALESCE(g.route_gap_seconds, 0) / 60.0, 1),
      'route_gap_max_minutes', round(COALESCE(g.route_gap_max, 0) / 60.0, 1), 'all_gaps', COALESCE(g.all_gaps, 0),
      'last_seen_at', a.last_seen_at, 'client', a.client_info, 'pending_points', a.pending_points)
    ORDER BY COALESCE(g.route_gap_seconds, 0) DESC, COALESCE(pt.late, 0) DESC), '[]'::jsonb)
    INTO v_rows
    FROM drivers x JOIN public.drivers dr ON dr.id = x.driver_id
    LEFT JOIN points pt ON pt.driver_id = dr.id
    LEFT JOIN gaps g ON g.driver_id = dr.id
    LEFT JOIN public.driver_app_presence a ON a.driver_id = dr.id;
  RETURN jsonb_build_object('success', true, 'from', v_from, 'as_of', now(), 'drivers', v_rows);
END $$;
REVOKE ALL ON FUNCTION public.get_driver_connectivity_report(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_driver_connectivity_report(integer) TO authenticated;

-- Monitor GPS: estado del teléfono y puntos pendientes por conductor
DO $mig$
DECLARE v_def text := pg_get_functiondef('public.get_driver_gps_monitor()'::regprocedure);
  a1 constant text := 'a.last_seen_at,a.disconnected_at,a.gps_state,';
  a2 constant text := '''accuracy_m'',accuracy_m,''speed'',speed_kmh) AS row FROM roster';
BEGIN
  IF position('pending_points' IN v_def) > 0 THEN RETURN; END IF;
  IF position(a1 IN v_def) = 0 OR position(a2 IN v_def) = 0 THEN RAISE EXCEPTION 'get_driver_gps_monitor: no se encontraron los puntos de inserción'; END IF;
  v_def := replace(v_def, a1, a1 || 'a.client_info,a.pending_points,a.oldest_pending_at,');
  v_def := replace(v_def, a2, '''client'',client_info,''pending_points'',pending_points,''oldest_pending_at'',oldest_pending_at,' || a2);
  EXECUTE v_def;
END $mig$;
REVOKE ALL ON FUNCTION public.get_driver_gps_monitor() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_driver_gps_monitor() TO authenticated;

COMMIT;
