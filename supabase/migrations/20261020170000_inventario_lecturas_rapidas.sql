-- ============================================================
-- Inventario: lecturas desde caché (sin esperas ni errores 500)
-- ============================================================
-- Incidente: con Entradas y Salidas de un año (≈200 mil movimientos) las lecturas del módulo superaban el límite de
-- 8 s de la web (Stock ≈4 s en local, 5–9 veces más en producción) y, mientras corría un recálculo, esperaban el
-- bloqueo de las tablas del modelo: todas las pestañas respondían 500.
-- 1) Las vistas iniciales (sin filtros) de Resumen, Estadía, Flujo, Verificación y Catálogos se guardan en
--    inv_read_cache al terminar cada recálculo, y el stock por bodega · producto · lote en inv_stock_cache (con glosa,
--    unidad y cliente). Las lecturas sin filtro y todo Stock disponible salen de ahí: no tocan las tablas del modelo,
--    así que tampoco esperan a un recálculo en curso. Con filtros de fecha se calcula en vivo como antes.
-- 2) El cálculo original se conserva como *_live (solo servidor); los RPC públicos mantienen nombre, firma y acceso.
-- 3) «Recalcular» no espera a otro recálculo en curso (responde pendiente) y el recálculo programado corre con un
--    límite de 5 min y deja la caché al día.
BEGIN;
SET LOCAL lock_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.inv_read_cache (
  k text PRIMARY KEY,
  payload jsonb NOT NULL,
  stamp timestamptz,
  built_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS public.inv_stock_cache (
  bodega text NOT NULL, kind text NOT NULL, producto text NOT NULL, lk text NOT NULL, lote text, ot text,
  qty numeric NOT NULL, kg numeric NOT NULL, kg_conocido boolean NOT NULL, fecha_min date, root_min date,
  inferido numeric, foto numeric, capas integer NOT NULL, glosa text, unidad text, cliente text
);
CREATE INDEX IF NOT EXISTS inv_stock_cache_bodega_idx ON public.inv_stock_cache (bodega);
ALTER TABLE public.inv_read_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inv_stock_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inv_read_cache FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.inv_stock_cache FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.inv_read_cache TO service_role;
GRANT ALL ON public.inv_stock_cache TO service_role;
DROP POLICY IF EXISTS security_active_account ON public.inv_read_cache;
CREATE POLICY security_active_account ON public.inv_read_cache AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.inv_stock_cache;
CREATE POLICY security_active_account ON public.inv_stock_cache AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));

-- Cálculo en vivo: mismo código, otro nombre
DO $migration$
BEGIN
  IF to_regprocedure('public.inv_overview_live(date,date)') IS NULL THEN ALTER FUNCTION public.inv_overview(date, date) RENAME TO inv_overview_live; END IF;
  IF to_regprocedure('public.inv_dwell_live(jsonb)') IS NULL THEN ALTER FUNCTION public.inv_dwell(jsonb) RENAME TO inv_dwell_live; END IF;
  IF to_regprocedure('public.inv_flow_live(jsonb)') IS NULL THEN ALTER FUNCTION public.inv_flow(jsonb) RENAME TO inv_flow_live; END IF;
  IF to_regprocedure('public.inv_verify_live()') IS NULL THEN ALTER FUNCTION public.inv_verify() RENAME TO inv_verify_live; END IF;
  IF to_regprocedure('public.inv_catalogs_live()') IS NULL THEN ALTER FUNCTION public.inv_catalogs() RENAME TO inv_catalogs_live; END IF;
  IF to_regprocedure('public.inv_stock_live(jsonb)') IS NULL THEN ALTER FUNCTION public.inv_stock(jsonb) RENAME TO inv_stock_live; END IF;
  IF to_regprocedure('public.inv_catalog_save_core(jsonb)') IS NULL THEN ALTER FUNCTION public.inv_catalog_save(jsonb) RENAME TO inv_catalog_save_core; END IF;
END $migration$;
REVOKE ALL ON FUNCTION public.inv_overview_live(date, date), public.inv_dwell_live(jsonb), public.inv_flow_live(jsonb),
  public.inv_verify_live(), public.inv_catalogs_live(), public.inv_stock_live(jsonb), public.inv_catalog_save_core(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_overview_live(date, date), public.inv_dwell_live(jsonb), public.inv_flow_live(jsonb),
  public.inv_verify_live(), public.inv_catalogs_live(), public.inv_stock_live(jsonb), public.inv_catalog_save_core(jsonb)
  TO service_role;

-- Arma la caché con la identidad de una cuenta con acceso APT (las funciones en vivo validan el permiso) y la deja
-- marcada con el recálculo del que sale. Las lecturas siguen viendo la caché anterior hasta que esta termine.
CREATE OR REPLACE FUNCTION public.inv_cache_refresh()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_sub text := current_setting('request.jwt.claim.sub', true); v_claims text := current_setting('request.jwt.claims', true);
  v_stamp timestamptz; v_t0 timestamptz := clock_timestamp(); v_k text; v_payload jsonb; v_n integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('inv_cache')) THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'en curso');
  END IF;
  SELECT rebuilt_at INTO v_stamp FROM public.inv_state WHERE id = 1;
  IF public.apt_read_cache_actor() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No hay una cuenta activa con acceso APT para preparar la caché');
  END IF;
  FOREACH v_k IN ARRAY ARRAY['overview', 'dwell', 'flow', 'verify', 'catalogs'] LOOP
    v_payload := CASE v_k
      WHEN 'overview' THEN public.inv_overview_live(NULL, NULL)
      WHEN 'dwell' THEN public.inv_dwell_live('{}'::jsonb)
      WHEN 'flow' THEN public.inv_flow_live('{}'::jsonb)
      WHEN 'verify' THEN public.inv_verify_live()
      ELSE public.inv_catalogs_live() END;
    IF (v_payload->>'success')::boolean THEN
      INSERT INTO public.inv_read_cache (k, payload, stamp, built_at) VALUES (v_k, v_payload, v_stamp, clock_timestamp())
      ON CONFLICT (k) DO UPDATE SET payload = EXCLUDED.payload, stamp = EXCLUDED.stamp, built_at = EXCLUDED.built_at;
      v_n := v_n + 1;
    END IF;
  END LOOP;

  -- Stock por clave con su descripción (último movimiento del producto) y cliente (último con razón social del lote)
  DELETE FROM public.inv_stock_cache;
  INSERT INTO public.inv_stock_cache (bodega, kind, producto, lk, lote, ot, qty, kg, kg_conocido, fecha_min, root_min, inferido,
    foto, capas, glosa, unidad, cliente)
  WITH r AS (SELECT x.*, NULLIF(x.lk, '') AS lote FROM public.inv_stock_rows() x),
  g AS (SELECT DISTINCT ON (producto) producto, glosa, unidad FROM public.inv_movements WHERE active ORDER BY producto, fecha DESC),
  c AS (SELECT DISTINCT ON (lote) lote, razon_social FROM public.inv_movements
        WHERE active AND lote IS NOT NULL AND razon_social IS NOT NULL ORDER BY lote, fecha DESC)
  SELECT r.bodega, r.kind, r.producto, r.lk, r.lote, public.inv_ot(r.lote), r.qty, r.kg, r.kg_conocido, r.fecha_min, r.root_min,
    r.inferido, r.foto, r.capas, g.glosa, g.unidad, c.razon_social
  FROM r LEFT JOIN g ON g.producto = r.producto LEFT JOIN c ON c.lote = r.lote;
  ANALYZE public.inv_stock_cache;
  INSERT INTO public.inv_read_cache (k, payload, stamp, built_at)
  VALUES ('stock', jsonb_build_object('success', true, 'filas', (SELECT count(*) FROM public.inv_stock_cache)), v_stamp, clock_timestamp())
  ON CONFLICT (k) DO UPDATE SET payload = EXCLUDED.payload, stamp = EXCLUDED.stamp, built_at = EXCLUDED.built_at;

  PERFORM set_config('request.jwt.claim.sub', COALESCE(v_sub, ''), true);
  PERFORM set_config('request.jwt.claims', COALESCE(v_claims, ''), true);
  RETURN jsonb_build_object('success', true, 'vistas', v_n + 1, 'segundos', round(extract(epoch FROM clock_timestamp() - v_t0)::numeric, 2));
END $$;
REVOKE ALL ON FUNCTION public.inv_cache_refresh() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_cache_refresh() TO service_role;

-- Vista guardada del último recálculo (NULL si es de uno anterior: entonces se calcula en vivo). Si hay cargas
-- aplicadas pendientes de recalcular, el control «Modelo recalculado» lo indica.
CREATE OR REPLACE FUNCTION public.inv_read_cached(p_k text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.payload || jsonb_build_object('cache', jsonb_build_object('built_at', c.built_at, 'al_dia', NOT s.dirty))
  FROM public.inv_read_cache c CROSS JOIN public.inv_state s
  WHERE c.k = p_k AND s.id = 1 AND c.stamp IS NOT DISTINCT FROM s.rebuilt_at;
$$;
REVOKE ALL ON FUNCTION public.inv_read_cached(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_read_cached(text) TO service_role;

CREATE OR REPLACE FUNCTION public.inv_overview(p_desde date DEFAULT NULL, p_hasta date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  IF p_desde IS NULL AND p_hasta IS NULL THEN
    v := public.inv_read_cached('overview');
    IF v IS NOT NULL THEN
      RETURN jsonb_set(v, '{state,dirty}', to_jsonb((SELECT dirty FROM public.inv_state WHERE id = 1)), true);
    END IF;
  END IF;
  RETURN public.inv_overview_live(p_desde, p_hasta);
END $$;

CREATE OR REPLACE FUNCTION public.inv_dwell(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  IF COALESCE(p->>'desde', '') = '' AND COALESCE(p->>'hasta', '') = ''
     AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(p->'bodegas') = 'array' THEN p->'bodegas' END), 0) = 0 THEN
    v := public.inv_read_cached('dwell');
    IF v IS NOT NULL THEN RETURN v; END IF;
  END IF;
  RETURN public.inv_dwell_live(p);
END $$;

CREATE OR REPLACE FUNCTION public.inv_flow(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  IF COALESCE(p->>'desde', '') = '' AND COALESCE(p->>'hasta', '') = '' THEN
    v := public.inv_read_cached('flow');
    IF v IS NOT NULL THEN RETURN v; END IF;
  END IF;
  RETURN public.inv_flow_live(p);
END $$;

CREATE OR REPLACE FUNCTION public.inv_verify()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v jsonb; v_checks jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  v := public.inv_read_cached('verify');
  IF v IS NULL THEN RETURN public.inv_verify_live(); END IF;
  IF (v->'cache'->>'al_dia')::boolean THEN RETURN v; END IF;
  SELECT jsonb_agg(CASE WHEN x->>'id' = 'al_dia' THEN x || jsonb_build_object('estado', 'AVISO',
      'detalle', 'Hay cargas o cambios pendientes de recalcular: estas cifras son del último recálculo y se actualizan solas en unos minutos.')
    ELSE x END ORDER BY o)
  INTO v_checks FROM jsonb_array_elements(v->'checks') WITH ORDINALITY t(x, o);
  RETURN v || jsonb_build_object('checks', v_checks,
    'ok', (SELECT count(*) FROM jsonb_array_elements(v_checks) x WHERE x->>'estado' = 'OK'));
END $$;

CREATE OR REPLACE FUNCTION public.inv_catalogs()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  -- Los conteos por bodega y tipo cambian al aplicar una carga: con cargas pendientes se cuentan en vivo
  v := public.inv_read_cached('catalogs');
  IF v IS NULL OR NOT (v->'cache'->>'al_dia')::boolean THEN RETURN public.inv_catalogs_live(); END IF;
  RETURN v || jsonb_build_object('can_load', public.apt_can_load());
END $$;

-- Guardar un catálogo actualiza también su vista guardada (con la identidad de quien guarda)
CREATE OR REPLACE FUNCTION public.inv_catalog_save(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r jsonb; v jsonb;
BEGIN
  r := public.inv_catalog_save_core(p);
  IF (r->>'success')::boolean AND EXISTS (SELECT 1 FROM public.inv_read_cache WHERE k = 'catalogs') THEN
    v := public.inv_catalogs_live();
    IF (v->>'success')::boolean THEN
      UPDATE public.inv_read_cache SET payload = v, built_at = clock_timestamp() WHERE k = 'catalogs';
    END IF;
  END IF;
  RETURN r;
END $$;

-- Stock disponible desde la caché del último recálculo (filtros, orden y páginas sobre las filas guardadas)
CREATE OR REPLACE FUNCTION public.inv_stock(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.inv_state; v_q text := NULLIF(btrim(p->>'q'), ''); v_lim integer := least(greatest(COALESCE((p->>'limit')::integer, 100), 1), 2000);
  v_off integer := greatest(COALESCE((p->>'offset')::integer, 0), 0);
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  IF public.inv_read_cached('stock') IS NULL THEN RETURN public.inv_stock_live(p); END IF;
  SELECT * INTO s FROM public.inv_state WHERE id = 1;
  RETURN (
    WITH info AS (
      SELECT c.*, s.data_max - c.fecha_min AS dias_bodega, s.data_max - c.root_min AS dias_origen FROM public.inv_stock_cache c
    ), f AS (
      SELECT * FROM info
      WHERE (NOT (p ? 'bodegas') OR jsonb_array_length(p->'bodegas') = 0 OR bodega IN (SELECT jsonb_array_elements_text(p->'bodegas')))
        AND (NOT (p ? 'kinds') OR jsonb_array_length(p->'kinds') = 0 OR kind IN (SELECT jsonb_array_elements_text(p->'kinds')))
        AND (v_q IS NULL OR producto ILIKE '%' || v_q || '%' OR glosa ILIKE '%' || v_q || '%' OR lk ILIKE '%' || v_q || '%'
             OR cliente ILIKE '%' || v_q || '%')
        AND (COALESCE(p->>'estado', '') = '' OR (p->>'estado' = 'libre' AND ot IS NULL) OR (p->>'estado' = 'comprometido' AND ot IS NOT NULL))
        AND (COALESCE((p->>'min_dias')::integer, 0) = 0 OR COALESCE(dias_origen, dias_bodega, 99999) >= (p->>'min_dias')::integer)
    )
    SELECT jsonb_build_object('success', true, 'corte', s.data_max, 'dirty', s.dirty, 'snapshot_cutoff', s.snapshot_cutoff,
      'total', (SELECT count(*) FROM f),
      'totales', (SELECT jsonb_build_object('kg', round(COALESCE(sum(kg), 0), 1), 'kg_libre', round(COALESCE(sum(kg) FILTER (WHERE ot IS NULL), 0), 1),
          'kg_comprometido', round(COALESCE(sum(kg) FILTER (WHERE ot IS NOT NULL), 0), 1), 'claves', count(*),
          'claves_inferidas', count(*) FILTER (WHERE inferido > 0), 'claves_sin_peso', count(*) FILTER (WHERE NOT kg_conocido)) FROM f),
      'filas', COALESCE((SELECT jsonb_agg(row_to_json(z2)::jsonb - 'ord1' ORDER BY z2.ord1 DESC NULLS LAST, z2.kg DESC)
          FROM (SELECT bodega, kind, producto, glosa, lote, ot, cliente, unidad, round(qty, 3) qty, round(kg, 1) kg, kg_conocido,
                  fecha_min fecha_ingreso, root_min fecha_origen, dias_bodega, dias_origen, round(COALESCE(inferido, 0), 3) inferido,
                  round(COALESCE(foto, 0), 3) foto, capas,
                  CASE p->>'orden' WHEN 'edad' THEN COALESCE(dias_origen, dias_bodega, 99999)::numeric WHEN 'qty' THEN qty ELSE kg END AS ord1
                FROM f ORDER BY ord1 DESC NULLS LAST, kg DESC LIMIT v_lim OFFSET v_off) z2), '[]'::jsonb)));
END $$;

REVOKE ALL ON FUNCTION public.inv_overview(date, date), public.inv_dwell(jsonb), public.inv_flow(jsonb), public.inv_verify(),
  public.inv_catalogs(), public.inv_catalog_save(jsonb), public.inv_stock(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_overview(date, date), public.inv_dwell(jsonb), public.inv_flow(jsonb), public.inv_verify(),
  public.inv_catalogs(), public.inv_catalog_save(jsonb), public.inv_stock(jsonb) TO authenticated, service_role;

-- «Recalcular» desde la web: si ya hay un recálculo en curso no lo espera (el programado deja todo al día)
CREATE OR REPLACE FUNCTION public.inv_rebuild_request()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('inv_rebuild')) THEN
    RETURN jsonb_build_object('success', true, 'pending', true, 'en_curso', true);
  END IF;
  RETURN public.inv_rebuild();
END $$;
REVOKE ALL ON FUNCTION public.inv_rebuild_request() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_rebuild_request() TO service_role;

-- Recálculo programado: recalcula si hay cambios y deja la caché al día (también si quedó de un recálculo anterior)
CREATE OR REPLACE FUNCTION public.inv_rebuild_if_dirty()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_rebuilt boolean := false;
BEGIN
  IF EXISTS (SELECT 1 FROM public.inv_state WHERE id = 1 AND dirty) THEN
    -- Una carga en preparación aplicará más partes y pedirá su propio recálculo: no bloquearla
    IF EXISTS (SELECT 1 FROM public.inv_uploads WHERE status = 'CARGANDO' AND created_at > now() - interval '45 minutes') THEN
      RETURN jsonb_build_object('success', true, 'skipped', 'carga en curso');
    END IF;
    IF NOT pg_try_advisory_xact_lock(hashtext('inv_rebuild')) THEN
      RETURN jsonb_build_object('success', true, 'skipped', 'recálculo en curso');
    END IF;
    PERFORM public.inv_rebuild();
    v_rebuilt := true;
  ELSIF EXISTS (SELECT 1 FROM public.inv_read_cache c, public.inv_state s
                WHERE c.k = 'stock' AND s.id = 1 AND c.stamp IS NOT DISTINCT FROM s.rebuilt_at)
        OR NOT EXISTS (SELECT 1 FROM public.inv_state WHERE id = 1 AND rebuilt_at IS NOT NULL) THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'sin cambios');
  END IF;
  RETURN jsonb_build_object('success', true, 'rebuilt', v_rebuilt, 'cache', public.inv_cache_refresh());
END $$;
REVOKE ALL ON FUNCTION public.inv_rebuild_if_dirty() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_rebuild_if_dirty() TO service_role;

-- PLATFORM_CRON_BEGIN: pg_cron is provisioned by Supabase; the local PostgreSQL harness tests the job directly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN PERFORM cron.unschedule('inventario-recalculo'); EXCEPTION WHEN OTHERS THEN NULL; END;
    PERFORM cron.schedule('inventario-recalculo', '*/2 * * * *',
      $cron$SET statement_timeout = '5min'; SELECT public.inv_rebuild_if_dirty();$cron$);
  END IF;
END $$;
-- PLATFORM_CRON_END

-- Preparar la caché ya, con el modelo vigente (si falla, el recálculo programado la prepara en ≤ 2 min)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.inv_state WHERE id = 1 AND rebuilt_at IS NOT NULL) THEN
    PERFORM public.inv_cache_refresh();
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Caché del inventario pendiente: %', SQLERRM;
END $$;

COMMENT ON TABLE public.inv_read_cache IS 'Vistas iniciales del inventario multi-almacén guardadas tras cada recálculo (inv_cache_refresh).';
COMMENT ON TABLE public.inv_stock_cache IS 'Stock por bodega, producto y lote con descripción y cliente, guardado tras cada recálculo (inv_cache_refresh).';
NOTIFY pgrst, 'reload schema';
COMMIT;
