-- APT · caché de lecturas pesadas: apt_operational_summary (9,3 s) y apt_dashboard (7,3 s) superaban o rozaban el
-- statement_timeout de authenticated (8 s) y la web recibía 500. Ambos resultados dependen solo de los datos APT
-- (cargas aplicadas, recálculo de estadía y flujo, parámetros), no del usuario ni de la hora: se guardan por filtro y
-- versión de datos y se reutilizan hasta que esa versión cambie. Un cron precalienta las vistas iniciales y calcula, con
-- el tiempo de los procesos internos, los filtros que la web no pudo calcular dentro de su límite (apt_read_cache_request).
-- El cálculo original se conserva como *_live (solo service_role); los RPC públicos mantienen nombre, firma y acceso.
BEGIN;
-- La clave indexada es un resumen de tamaño fijo del filtro (listas largas de clientes no superan el límite del índice);
-- params se conserva y se compara en cada lectura.
CREATE TABLE IF NOT EXISTS public.apt_read_cache (
  fn text NOT NULL, key_hash text NOT NULL, params jsonb NOT NULL, version text NOT NULL, result jsonb NOT NULL,
  built_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (fn, key_hash)
);
-- Filtros pedidos por la web cuyo cálculo superó el límite de la petición: el cron los calcula y los guarda.
CREATE TABLE IF NOT EXISTS public.apt_read_cache_requests (
  fn text NOT NULL, key_hash text NOT NULL, params jsonb NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(), attempts integer NOT NULL DEFAULT 0, claimed_at timestamptz,
  PRIMARY KEY (fn, key_hash)
);
-- Solo las funciones SECURITY DEFINER leen y escriben estas tablas.
ALTER TABLE public.apt_read_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.apt_read_cache_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apt_read_cache FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.apt_read_cache_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.apt_read_cache TO service_role;
GRANT ALL ON public.apt_read_cache_requests TO service_role;
DROP POLICY IF EXISTS security_active_account ON public.apt_read_cache;
CREATE POLICY security_active_account ON public.apt_read_cache AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.apt_read_cache_requests;
CREATE POLICY security_active_account ON public.apt_read_cache_requests AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));

-- Cálculo en vivo: mismo código, otro nombre. El de resumen admite una página completa para que la caché guarde todas
-- las filas una sola vez y pagine sin recalcular (el RPC público sigue limitando cada página a 100).
DO $migration$
DECLARE source text; cap constant text := '(p->>''limit'')::integer,25),1),100);';
BEGIN
  IF to_regprocedure('public.apt_dashboard_live(jsonb,text)') IS NULL THEN
    ALTER FUNCTION public.apt_dashboard(jsonb, text) RENAME TO apt_dashboard_live;
  END IF;
  IF to_regprocedure('public.apt_operational_summary_live(jsonb)') IS NULL THEN
    ALTER FUNCTION public.apt_operational_summary(jsonb) RENAME TO apt_operational_summary_live;
  END IF;
  source := pg_get_functiondef('public.apt_operational_summary_live(jsonb)'::regprocedure);
  IF position(cap IN source) > 0 THEN
    EXECUTE replace(source, cap, '(p->>''limit'')::integer,25),1),1000000);');
  ELSIF position('(p->>''limit'')::integer,25),1),1000000);' IN source) = 0 THEN
    RAISE EXCEPTION 'apt_operational_summary no coincide con la definición esperada: revisar antes de migrar';
  END IF;
END $migration$;
REVOKE ALL ON FUNCTION public.apt_dashboard_live(jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apt_operational_summary_live(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_dashboard_live(jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.apt_operational_summary_live(jsonb) TO service_role;

-- Versión de los datos que alimentan ambos cálculos: cambia con cada carga aplicada o descartada, recálculo de
-- estadía o flujo y cambio de parámetros o rangos de antigüedad.
CREATE OR REPLACE FUNCTION public.apt_read_cache_version()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT md5(concat_ws('|',
    (SELECT count(*) || ':' || COALESCE(max(applied_at)::text, '-') FROM public.apt_uploads WHERE status = 'APLICADA'),
    (SELECT string_agg(to_jsonb(s)::text, ',') FROM public.apt_state s),
    (SELECT string_agg(to_jsonb(s)::text, ',') FROM public.apt_flow_state s),
    (SELECT string_agg(to_jsonb(s)::text, ',') FROM public.apt_settings s),
    (SELECT string_agg(to_jsonb(r)::text, ',' ORDER BY r.desde) FROM public.apt_aging_ranges r)));
$$;

-- Clave de caché única para el RPC y para las solicitudes de cálculo: el resumen se guarda sin paginación.
CREATE OR REPLACE FUNCTION public.apt_read_cache_key(p_fn text, p jsonb, p_grain text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE p_fn
    WHEN 'apt_dashboard' THEN jsonb_build_object('p', COALESCE(p, '{}'::jsonb), 'grain', COALESCE(p_grain, 'semana'))
    WHEN 'apt_operational_summary' THEN jsonb_build_object('p', COALESCE(p, '{}'::jsonb) - 'limit' - 'offset')
  END;
$$;

-- Lee o calcula y guarda. Solo se guardan resultados correctos; los errores de validación se devuelven tal cual.
CREATE OR REPLACE FUNCTION public.apt_read_cached(p_fn text, p_params jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_version text := public.apt_read_cache_version(); v_result jsonb;
BEGIN
  SELECT c.result INTO v_result FROM public.apt_read_cache c
  WHERE c.fn = p_fn AND c.key_hash = md5(p_params::text) AND c.params = p_params AND c.version = v_version;
  IF FOUND THEN RETURN v_result; END IF;
  v_result := CASE p_fn
    WHEN 'apt_dashboard' THEN public.apt_dashboard_live(p_params -> 'p', p_params ->> 'grain')
    WHEN 'apt_operational_summary' THEN public.apt_operational_summary_live((p_params -> 'p') || '{"limit":999999,"offset":0}')
  END;
  IF v_result IS NULL THEN RAISE EXCEPTION 'Lectura APT no reconocida: %', p_fn; END IF;
  IF (v_result ->> 'success') = 'true' THEN
    INSERT INTO public.apt_read_cache (fn, key_hash, params, version, result) VALUES (p_fn, md5(p_params::text), p_params, v_version, v_result)
    ON CONFLICT (fn, key_hash) DO UPDATE SET params = EXCLUDED.params, version = EXCLUDED.version, result = EXCLUDED.result, built_at = clock_timestamp();
    DELETE FROM public.apt_read_cache_requests r WHERE r.fn = p_fn AND r.key_hash = md5(p_params::text);
  END IF;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.apt_read_cache_key(text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_read_cache_key(text, jsonb, text) TO service_role;
REVOKE ALL ON FUNCTION public.apt_read_cache_version() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apt_read_cached(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_read_cache_version() TO service_role;
GRANT EXECUTE ON FUNCTION public.apt_read_cached(text, jsonb) TO service_role;

-- RPC públicos: misma firma, mismo control de acceso y misma respuesta.
CREATE OR REPLACE FUNCTION public.apt_dashboard(p jsonb DEFAULT '{}'::jsonb, p_grain text DEFAULT 'semana')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  RETURN public.apt_read_cached('apt_dashboard', public.apt_read_cache_key('apt_dashboard', p, p_grain));
END $$;

CREATE OR REPLACE FUNCTION public.apt_operational_summary(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_full jsonb; v_limit integer; v_offset integer;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  p := COALESCE(p, '{}'::jsonb);
  -- Filtros y paginación inválidos: el cálculo en vivo responde de inmediato con su mensaje de validación.
  IF jsonb_typeof(p) <> 'object' OR COALESCE(p ->> 'limit', '25') !~ '^[0-9]{1,6}$' OR COALESCE(p ->> 'offset', '0') !~ '^[0-9]{1,9}$' THEN
    RETURN public.apt_operational_summary_live(p);
  END IF;
  v_limit := LEAST(GREATEST(COALESCE((p ->> 'limit')::integer, 25), 1), 100);
  v_offset := GREATEST(COALESCE((p ->> 'offset')::integer, 0), 0);
  -- La caché guarda hasta 999 999 filas; una página más allá se calcula en vivo como antes.
  IF v_offset + v_limit > 999999 THEN RETURN public.apt_operational_summary_live(p); END IF;
  v_full := public.apt_read_cached('apt_operational_summary', public.apt_read_cache_key('apt_operational_summary', p));
  IF (v_full ->> 'success') IS DISTINCT FROM 'true' OR jsonb_typeof(v_full -> 'rows') <> 'array' THEN RETURN v_full; END IF;
  RETURN v_full || jsonb_build_object(
    'rows', COALESCE((SELECT jsonb_agg(r.value ORDER BY r.ordinality) FROM jsonb_array_elements(v_full -> 'rows') WITH ORDINALITY r
                      WHERE r.ordinality > v_offset AND r.ordinality <= v_offset + v_limit), '[]'::jsonb),
    'limit', v_limit, 'offset', v_offset);
END $$;
REVOKE ALL ON FUNCTION public.apt_dashboard(jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.apt_operational_summary(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_dashboard(jsonb, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apt_operational_summary(jsonb) TO authenticated, service_role;

-- La web registra aquí un filtro cuyo cálculo superó el límite de su petición (la petición se revierte, esta no).
-- Solo filtros con forma válida y tamaño acotado; el cron los calcula en orden de llegada.
CREATE OR REPLACE FUNCTION public.apt_read_cache_request(p_fn text, p_args jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_key jsonb;
BEGIN
  IF NOT public.is_active_tms_user() OR NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  IF p_fn NOT IN ('apt_dashboard', 'apt_operational_summary') OR jsonb_typeof(p_args) <> 'object'
     OR jsonb_typeof(COALESCE(p_args -> 'p', '{}'::jsonb)) <> 'object' OR length(p_args::text) > 64000
     OR (p_fn = 'apt_dashboard' AND COALESCE(p_args ->> 'p_grain', 'semana') NOT IN ('dia', 'semana', 'mes')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solicitud de cálculo APT inválida');
  END IF;
  v_key := public.apt_read_cache_key(p_fn, p_args -> 'p', p_args ->> 'p_grain');
  INSERT INTO public.apt_read_cache_requests (fn, key_hash, params) VALUES (p_fn, md5(v_key::text), v_key)
  ON CONFLICT (fn, key_hash) DO UPDATE SET requested_at = clock_timestamp();
  -- Acota la cola: conserva las 50 solicitudes más recientes.
  DELETE FROM public.apt_read_cache_requests r WHERE (r.fn, r.key_hash) NOT IN
    (SELECT q.fn, q.key_hash FROM public.apt_read_cache_requests q ORDER BY q.requested_at DESC LIMIT 50);
  RETURN jsonb_build_object('success', true);
END $$;
REVOKE ALL ON FUNCTION public.apt_read_cache_request(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_read_cache_request(text, jsonb) TO authenticated, service_role;

-- Precalentado: las vistas que abren /apt, /apt/operacion, /apt/estadia y Analítica sin filtros, y luego los filtros
-- pedidos por la web. Cada cálculo corre con la identidad de una cuenta APT activa (solo en su transacción) porque
-- el cálculo verifica el acceso.
CREATE OR REPLACE FUNCTION public.apt_read_cache_actor()
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor uuid;
BEGIN
  -- Primero las cuentas cuyo rol declara acceso APT; apt_can_view decide con la regla vigente.
  FOR v_actor IN SELECT p.id FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
      WHERE p.is_active
      ORDER BY (r.name IN ('Administrador', 'Jefe de Distribución') OR COALESCE(r.permissions, '[]'::jsonb)::text ILIKE '%apt%') DESC, p.id LOOP
    PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
    IF public.apt_can_view() THEN RETURN v_actor; END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN NULL;
END $$;

-- Turno de la cola (cron rápido, transacción propia): asigna una solicitud, la de menos intentos y más antigua, solo
-- cuando no hay otra asignada en curso, y le suma el intento antes de calcularla. Así una cancelación del cálculo no deshace el intento y, al
-- tercero, la solicitud se descarta sin bloquear las demás.
CREATE OR REPLACE FUNCTION public.apt_read_cache_claim()
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_claimed integer;
BEGIN
  DELETE FROM public.apt_read_cache_requests r WHERE r.requested_at < now() - interval '1 day'
    OR (r.attempts >= 3 AND r.claimed_at < now() - interval '6 minutes');
  -- Una sola solicitud asignada a la vez: el cálculo la atiende antes de que se asigne otra.
  IF EXISTS (SELECT 1 FROM public.apt_read_cache_requests q WHERE q.claimed_at >= now() - interval '6 minutes') THEN RETURN 0; END IF;
  UPDATE public.apt_read_cache_requests r SET attempts = r.attempts + 1, claimed_at = clock_timestamp()
  WHERE (r.fn, r.key_hash) = (SELECT q.fn, q.key_hash FROM public.apt_read_cache_requests q
    WHERE q.attempts < 3 AND (q.claimed_at IS NULL OR q.claimed_at < now() - interval '6 minutes')
    ORDER BY q.attempts, q.requested_at LIMIT 1 FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  RETURN v_claimed;
END $$;

-- Siguiente cálculo pendiente: vistas iniciales primero; de la cola, la solicitud asignada en curso.
CREATE OR REPLACE FUNCTION public.apt_read_cache_next(p_skip text[] DEFAULT '{}')
RETURNS TABLE (fn text, params jsonb) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_version text := public.apt_read_cache_version();
BEGIN
  DELETE FROM public.apt_read_cache c WHERE c.version <> v_version OR c.built_at < now() - interval '2 days';
  IF NOT EXISTS (SELECT 1 FROM public.apt_state WHERE cutoff IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM public.apt_flow_state WHERE cutoff IS NOT NULL) THEN RETURN; END IF;
  RETURN QUERY SELECT k.fn, k.params FROM (
      SELECT d.fn, d.params, 0 AS ord, NULL::timestamptz AS at FROM (VALUES
        ('apt_operational_summary', '{"p":{}}'::jsonb),
        ('apt_dashboard', '{"p":{},"grain":"semana"}'::jsonb),
        ('apt_dashboard', '{"p":{},"grain":"dia"}'::jsonb)) d(fn, params)
      UNION ALL
      SELECT x.fn, x.params, 1, x.claimed_at FROM (SELECT r.fn, r.params, r.claimed_at FROM public.apt_read_cache_requests r
        WHERE r.claimed_at >= now() - interval '6 minutes' ORDER BY r.claimed_at LIMIT 1) x) k
    WHERE NOT (k.fn || ':' || md5(k.params::text)) = ANY (p_skip)
      AND NOT EXISTS (SELECT 1 FROM public.apt_read_cache c WHERE c.fn = k.fn AND c.key_hash = md5(k.params::text)
                      AND c.params = k.params AND c.version = v_version)
    ORDER BY k.ord, k.at DESC LIMIT 1;
END $$;

-- Calcula y guarda un filtro. Un resultado no válido (validación) se descarta de la cola.
CREATE OR REPLACE FUNCTION public.apt_read_cache_build(p_fn text, p_params jsonb)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ok boolean;
BEGIN
  IF public.apt_read_cache_actor() IS NULL THEN RETURN false; END IF;
  v_ok := (public.apt_read_cached(p_fn, p_params) ->> 'success') = 'true';
  IF NOT v_ok THEN DELETE FROM public.apt_read_cache_requests r WHERE r.fn = p_fn AND r.key_hash = md5(p_params::text); END IF;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_ok;
END $$;

-- Cron de cálculo (statement_timeout de 5 min en el mismo comando): vistas iniciales y la solicitud asignada.
-- Bloqueo de transacción: se libera siempre al terminar o cancelarse.
CREATE OR REPLACE FUNCTION public.apt_read_cache_warm()
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_key record; v_skip text[] := '{}'; v_built integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('apt_read_cache_warm')) THEN RETURN 0; END IF;
  FOR i IN 1..4 LOOP
    SELECT * INTO v_key FROM public.apt_read_cache_next(v_skip);
    EXIT WHEN v_key.fn IS NULL;
    v_skip := v_skip || (v_key.fn || ':' || md5(v_key.params::text));
    IF public.apt_read_cache_build(v_key.fn, v_key.params) THEN v_built := v_built + 1; END IF;
  END LOOP;
  RETURN v_built;
END $$;
REVOKE ALL ON FUNCTION public.apt_read_cache_actor() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apt_read_cache_next(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apt_read_cache_build(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apt_read_cache_warm() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apt_read_cache_claim() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_read_cache_actor() TO service_role;
GRANT EXECUTE ON FUNCTION public.apt_read_cache_next(text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.apt_read_cache_build(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.apt_read_cache_warm() TO service_role;
GRANT EXECUTE ON FUNCTION public.apt_read_cache_claim() TO service_role;
COMMENT ON TABLE public.apt_read_cache IS 'Resultados de apt_dashboard y apt_operational_summary por filtro y versión de datos APT; se invalidan solos al cambiar la versión.';

-- PLATFORM_CRON_BEGIN: pg_cron is provisioned by Supabase; the local PostgreSQL harness tests the job directly.
CREATE EXTENSION IF NOT EXISTS pg_cron;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='apt-cache-lecturas') THEN PERFORM cron.unschedule('apt-cache-lecturas'); END IF;
  IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='apt-cache-turno') THEN PERFORM cron.unschedule('apt-cache-turno'); END IF;
END $$;
SELECT cron.schedule('apt-cache-turno','* * * * *',$job$SELECT public.apt_read_cache_claim()$job$);
SELECT cron.schedule('apt-cache-lecturas','* * * * *',$job$SET statement_timeout='5min'; SELECT public.apt_read_cache_warm();$job$);
-- PLATFORM_CRON_END
NOTIFY pgrst,'reload schema';
COMMIT;
