-- ============================================================
-- Inventario: lecturas que nunca sobrecargan la base
-- ============================================================
-- Incidente (19/10, despliegue de #276): la base de producción se saturó y nadie pudo ingresar. Mientras la caché de
-- lecturas no estaba lista (o era de un recálculo anterior), cada pestaña de /apt calculaba en vivo sobre 200 mil
-- movimientos (segundos de CPU por consulta, repetidas por cada usuario y reintento), y las pruebas de inventario que
-- se cortaban por tiempo dejaban transacciones pesadas corriendo.
-- 1) Una vista guardada de un recálculo anterior se sigue mostrando (marcada «pendiente») en lugar de calcular en vivo.
-- 2) Sin vista guardada todavía, las vistas sin filtro responden «se está preparando» al instante; el recálculo
--    programado la prepara. Solo el servidor o las pruebas (inv.live = on) calculan en vivo.
-- 3) Con filtros de fecha se sigue calculando en vivo (límite de 8 s de la web).
BEGIN;

CREATE OR REPLACE FUNCTION public.inv_live_allowed()
RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(current_setting('inv.live', true), '') = 'on';
$$;
CREATE OR REPLACE FUNCTION public.inv_preparing()
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('success', false, 'preparando', true,
    'error', 'Las cifras del inventario se están preparando en el servidor. Vuelva a intentar en unos minutos.');
$$;
REVOKE ALL ON FUNCTION public.inv_live_allowed(), public.inv_preparing() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_live_allowed(), public.inv_preparing() TO authenticated, service_role;

-- Vista guardada más reciente (aunque sea de un recálculo anterior: entonces al_dia = false)
CREATE OR REPLACE FUNCTION public.inv_read_cached(p_k text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.payload || jsonb_build_object('cache', jsonb_build_object('built_at', c.built_at,
    'al_dia', NOT s.dirty AND c.stamp IS NOT DISTINCT FROM s.rebuilt_at))
  FROM public.inv_read_cache c CROSS JOIN public.inv_state s WHERE c.k = p_k AND s.id = 1;
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
  IF p_desde IS NULL AND p_hasta IS NULL AND NOT public.inv_live_allowed() THEN RETURN public.inv_preparing(); END IF;
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
    IF NOT public.inv_live_allowed() THEN RETURN public.inv_preparing(); END IF;
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
    IF NOT public.inv_live_allowed() THEN RETURN public.inv_preparing(); END IF;
  END IF;
  RETURN public.inv_flow_live(p);
END $$;

CREATE OR REPLACE FUNCTION public.inv_verify()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v jsonb; v_checks jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  v := public.inv_read_cached('verify');
  IF v IS NULL THEN
    IF NOT public.inv_live_allowed() THEN RETURN public.inv_preparing(); END IF;
    RETURN public.inv_verify_live();
  END IF;
  IF (v->'cache'->>'al_dia')::boolean THEN RETURN v; END IF;
  SELECT jsonb_agg(CASE WHEN x->>'id' = 'al_dia' THEN x || jsonb_build_object('estado', 'AVISO',
      'detalle', 'Hay cargas o cambios pendientes de recalcular, o se están preparando las cifras: se actualizan solas en unos minutos.')
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
  v := public.inv_read_cached('catalogs');
  IF v IS NULL THEN
    IF NOT public.inv_live_allowed() THEN RETURN public.inv_preparing(); END IF;
    RETURN public.inv_catalogs_live();
  END IF;
  RETURN v || jsonb_build_object('can_load', public.apt_can_load());
END $$;

CREATE OR REPLACE FUNCTION public.inv_stock(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.inv_state; v_q text := NULLIF(btrim(p->>'q'), ''); v_lim integer := least(greatest(COALESCE((p->>'limit')::integer, 100), 1), 2000);
  v_off integer := greatest(COALESCE((p->>'offset')::integer, 0), 0);
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  IF public.inv_read_cached('stock') IS NULL THEN
    IF NOT public.inv_live_allowed() THEN RETURN public.inv_preparing(); END IF;
    RETURN public.inv_stock_live(p);
  END IF;
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
  public.inv_catalogs(), public.inv_stock(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_overview(date, date), public.inv_dwell(jsonb), public.inv_flow(jsonb), public.inv_verify(),
  public.inv_catalogs(), public.inv_stock(jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
