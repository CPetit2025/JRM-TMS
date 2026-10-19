-- ============================================================
-- Estadía por contrato / OT, ID (glosa) y cliente · kardex del contrato
-- ============================================================
-- inv_dwell_dim: la estadía (días en bodega de cada salida, FIFO) y el stock que queda, agrupados por OT, por ID
-- (producto con su glosa) o por cliente, en lugar de por bodega. Filtros: ámbito APT, período, una OT, texto.
-- Sin período ni OT se guarda con la caché de lecturas (las tres vistas del APT).
-- inv_contrato_kardex: los movimientos de una OT en el APT con lo que ingresó, lo que salió y el saldo acumulado
-- (total en kg y por ID en su unidad), más la serie diaria. El traspaso 647 → ST de la misma OT es interno y no
-- cambia el saldo.
BEGIN;
SET LOCAL lock_timeout = '60s';

-- Cliente de cada OT desde la lista de contratos guardada (una lectura por llamada)
CREATE OR REPLACE FUNCTION public.inv_ot_clientes()
RETURNS TABLE (ot text, cliente text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT x->>'ot', x->>'cliente' FROM jsonb_array_elements(COALESCE(
    (SELECT r.payload->'contratos' FROM public.inv_read_cache r WHERE r.k = 'contratos'), '[]'::jsonb)) x
  WHERE x->>'cliente' IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.inv_ot_clientes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_ot_clientes() TO service_role;

CREATE OR REPLACE FUNCTION public.inv_dwell_dim_live(p jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.inv_state; v_from date; v_to date; v_dim text := COALESCE(NULLIF(p->>'dim', ''), 'ot');
  v_apt boolean := COALESCE(p->>'ambito', '') = 'apt'; v_ot text := public.apt_ot_raiz(NULLIF(p->>'ot', ''));
BEGIN
  IF v_dim NOT IN ('ot', 'producto', 'cliente') THEN RETURN jsonb_build_object('success', false, 'error', 'Vista no válida'); END IF;
  SELECT * INTO s FROM public.inv_state WHERE id = 1;
  v_to := COALESCE(NULLIF(p->>'hasta', '')::date, s.data_max); v_from := COALESCE(NULLIF(p->>'desde', '')::date, s.data_min);
  RETURN (
    WITH oc AS MATERIALIZED (SELECT * FROM public.inv_ot_clientes()),
    -- Salidas del período cruzadas con la capa que consumieron (FIFO)
    c AS MATERIALIZED (
      SELECT a.qty, a.kg, a.dias_bodega, m.clase, l.producto, m.glosa, m.unidad,
        public.apt_ot_raiz(COALESCE(NULLIF(l.lk, ''), m.lote)) AS ot,
        CASE WHEN m.clase = 'DESPACHO' THEN m.razon_social END AS cliente_guia,
        CASE WHEN l.root_known >= 0.5 THEN m.fecha - l.root_fecha END AS dias_origen
      FROM public.inv_allocations a JOIN public.inv_movements_v m ON m.id = a.out_id JOIN public.inv_layers l ON l.id = a.layer_id
      WHERE m.fecha BETWEEN v_from AND v_to AND (NOT v_apt OR public.apt_almacen(l.bodega) IS NOT NULL)),
    c2 AS (
      SELECT c.*, COALESCE(c.cliente_guia, oc.cliente) AS cliente FROM c LEFT JOIN oc ON oc.ot = c.ot
      WHERE v_ot IS NULL OR c.ot = v_ot),
    st AS (
      SELECT r.producto, r.glosa, r.unidad, r.qty, r.kg, r.ot, COALESCE(r.cliente, oc.cliente) AS cliente, s.data_max - r.fecha_min AS dias
      FROM public.inv_stock_cache r LEFT JOIN oc ON oc.ot = r.ot
      WHERE (NOT v_apt OR public.apt_almacen(r.bodega) IS NOT NULL) AND (v_ot IS NULL OR r.ot = v_ot)),
    k AS (SELECT CASE v_dim WHEN 'ot' THEN ot WHEN 'producto' THEN producto ELSE cliente END AS key, * FROM c2),
    ks AS (SELECT CASE v_dim WHEN 'ot' THEN ot WHEN 'producto' THEN producto ELSE cliente END AS key, * FROM st),
    sal AS (
      SELECT key, count(*) n, COALESCE(sum(kg), 0) kg, COALESCE(sum(kg) FILTER (WHERE clase = 'DESPACHO'), 0) kg_desp,
        round(avg(dias_bodega), 1) prom, round(sum(kg * dias_bodega) FILTER (WHERE kg > 0 AND dias_bodega IS NOT NULL)
          / NULLIF(sum(kg) FILTER (WHERE kg > 0 AND dias_bodega IS NOT NULL), 0), 1) prom_kg,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY dias_bodega))::numeric, 1) p50,
        round((percentile_cont(0.9) WITHIN GROUP (ORDER BY dias_bodega))::numeric, 1) p90,
        max(dias_bodega) mx, round(avg(dias_origen), 1) prom_o,
        (array_agg(glosa ORDER BY glosa IS NULL) )[1] glosa, max(unidad) unidad,
        (array_agg(cliente ORDER BY cliente IS NULL))[1] cliente, count(DISTINCT ot) ots
      FROM k WHERE key IS NOT NULL GROUP BY key),
    stk AS (
      SELECT key, COALESCE(sum(kg), 0) kg, COALESCE(sum(qty), 0) qty, count(*) claves,
        round(sum(kg * dias) FILTER (WHERE dias IS NOT NULL AND kg > 0) / NULLIF(sum(kg) FILTER (WHERE dias IS NOT NULL AND kg > 0), 0), 1) dias_pond,
        max(dias) dias_max, COALESCE(sum(kg) FILTER (WHERE dias > 60), 0) kg_60,
        (array_agg(glosa ORDER BY glosa IS NULL))[1] glosa, max(unidad) unidad,
        (array_agg(cliente ORDER BY cliente IS NULL))[1] cliente, count(DISTINCT ot) ots
      FROM ks WHERE key IS NOT NULL GROUP BY key),
    j AS (
      SELECT COALESCE(sal.key, stk.key) key, sal.n, sal.kg, sal.kg_desp, sal.prom, sal.prom_kg, sal.p50, sal.p90, sal.mx, sal.prom_o,
        stk.kg skg, stk.qty sqty, stk.claves, stk.dias_pond, stk.dias_max, stk.kg_60,
        COALESCE(stk.glosa, sal.glosa) glosa, COALESCE(stk.unidad, sal.unidad) unidad, COALESCE(sal.cliente, stk.cliente) cliente,
        GREATEST(COALESCE(sal.ots, 0), COALESCE(stk.ots, 0)) ots
      FROM sal FULL JOIN stk ON stk.key = sal.key)
    SELECT jsonb_build_object('success', true, 'dim', v_dim, 'ambito', CASE WHEN v_apt THEN 'apt' ELSE 'todas' END, 'ot', v_ot,
      'desde', v_from, 'hasta', v_to, 'corte', s.data_max, 'total', (SELECT count(*) FROM j),
      'filas', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', key, 'glosa', CASE WHEN v_dim = 'producto' THEN glosa END,
          'unidad', CASE WHEN v_dim = 'producto' THEN unidad END, 'cliente', CASE WHEN v_dim = 'ot' THEN cliente END, 'ots', ots,
          'salidas', COALESCE(n, 0), 'kg_salidas', round(COALESCE(kg, 0), 1), 'kg_despachado', round(COALESCE(kg_desp, 0), 1),
          'prom_dias', prom, 'prom_dias_kg', prom_kg, 'p50', p50, 'p90', p90, 'max', mx, 'prom_origen', prom_o,
          'stock_kg', round(COALESCE(skg, 0), 1), 'stock_qty', round(COALESCE(sqty, 0), 3), 'claves', COALESCE(claves, 0),
          'stock_dias', dias_pond, 'stock_dias_max', dias_max, 'stock_kg_60', round(COALESCE(kg_60, 0), 1))
          ORDER BY COALESCE(skg, 0) DESC, COALESCE(kg, 0) DESC, key)
        FROM (SELECT * FROM j ORDER BY COALESCE(skg, 0) DESC, COALESCE(kg, 0) DESC, key LIMIT 5000) z), '[]'::jsonb)));
END $$;
REVOKE ALL ON FUNCTION public.inv_dwell_dim_live(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_dwell_dim_live(jsonb) TO service_role;

-- Lectura pública: sin período ni OT sale de la caché (APT); el texto filtra las filas ya calculadas y se devuelven
-- las primeras «limit» (300 por defecto) con el total encontrado
CREATE OR REPLACE FUNCTION public.inv_dwell_dim(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v jsonb; v_dim text := COALESCE(NULLIF(p->>'dim', ''), 'ot'); v_q text := upper(btrim(COALESCE(p->>'q', '')));
  v_limit int := LEAST(GREATEST(COALESCE(NULLIF(p->>'limit', '')::int, 300), 1), 5000);
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  IF COALESCE(p->>'ambito', '') = 'apt' AND COALESCE(p->>'desde', '') = '' AND COALESCE(p->>'hasta', '') = '' AND COALESCE(p->>'ot', '') = '' THEN
    v := public.inv_read_cached('dwell_apt_' || v_dim);
  END IF;
  IF v IS NULL THEN v := public.inv_dwell_dim_live(p); END IF;
  IF v ? 'filas' THEN
    SELECT v || jsonb_build_object('total', count(*), 'filas', COALESCE(jsonb_agg(x ORDER BY o) FILTER (WHERE rn <= v_limit), '[]'::jsonb))
    INTO v FROM (SELECT x, o, row_number() OVER (ORDER BY o) rn FROM jsonb_array_elements(v->'filas') WITH ORDINALITY t(x, o)
                 WHERE v_q = '' OR upper(concat_ws(' ', x->>'key', x->>'glosa', x->>'cliente')) LIKE '%' || v_q || '%') f;
  END IF;
  RETURN v;
END $$;

-- La caché guarda las tres vistas del APT tras cada recálculo
DO $migration$
DECLARE src text := pg_get_functiondef('public.inv_cache_refresh()'::regprocedure);
  anchor text := 'PERFORM public.inv_contratos_refresh(v_stamp);';
BEGIN
  IF position('dwell_apt_ot' IN src) = 0 THEN
    IF position(anchor IN src) = 0 THEN RAISE EXCEPTION 'inv_cache_refresh no coincide con la definición esperada'; END IF;
    -- Después de la lista de contratos: la vista por cliente toma de ella el cliente de cada OT
    EXECUTE replace(src, anchor, anchor || $r$
  INSERT INTO public.inv_read_cache (k, payload, stamp, built_at)
    SELECT 'dwell_apt_' || d, public.inv_dwell_dim_live(jsonb_build_object('dim', d, 'ambito', 'apt')), v_stamp, now()
    FROM unnest(ARRAY['ot', 'producto', 'cliente']) d
    ON CONFLICT (k) DO UPDATE SET payload = EXCLUDED.payload, stamp = EXCLUDED.stamp, built_at = EXCLUDED.built_at;$r$);
  END IF;
END $migration$;

-- Kardex de una OT en el APT: ingresos, salidas y saldo acumulado
CREATE OR REPLACE FUNCTION public.inv_contrato_kardex(p_q text, p_producto text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_raiz text := public.apt_ot_raiz(p_q); v_prod text := NULLIF(btrim(p_producto), ''); v_movs jsonb; v_serie jsonb; v_n int;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  IF v_raiz IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Escriba el número de la OT o contrato'); END IF;
  CREATE TEMP TABLE IF NOT EXISTS inv_tmp_kx ON COMMIT DROP AS SELECT * FROM public.inv_apt_movs(NULL) WITH NO DATA;
  TRUNCATE inv_tmp_kx;
  INSERT INTO inv_tmp_kx SELECT * FROM public.inv_apt_movs(v_raiz) WHERE v_prod IS NULL OR producto = v_prod;
  SELECT count(*) INTO v_n FROM inv_tmp_kx;

  WITH m AS (
    SELECT *, CASE WHEN side = 'E' AND NOT interno THEN qty ELSE 0 END AS e_qty, CASE WHEN side = 'S' AND NOT interno THEN qty ELSE 0 END AS s_qty,
      CASE WHEN side = 'E' AND NOT interno THEN kg ELSE 0 END AS e_kg, CASE WHEN side = 'S' AND NOT interno THEN kg ELSE 0 END AS s_kg
    FROM inv_tmp_kx),
  r AS (
    SELECT m.*, sum(e_kg - s_kg) OVER (ORDER BY fecha, side, id) AS saldo_kg,
      sum(e_qty - s_qty) OVER (PARTITION BY producto ORDER BY fecha, side, id) AS saldo_qty
    FROM m)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('fecha', fecha, 'tipo', tipodocto, 'clase', clase, 'numero', numero, 'almacen', almacen,
      'bodega', bodega, 'producto', producto, 'glosa', glosa, 'unidad', unidad, 'lote', lote, 'tercero', razon_social, 'interno', interno,
      'entrada', CASE WHEN side = 'E' THEN round(qty, 3) END, 'salida', CASE WHEN side = 'S' THEN round(qty, 3) END,
      'kg_entrada', CASE WHEN side = 'E' THEN round(kg, 1) END, 'kg_salida', CASE WHEN side = 'S' THEN round(kg, 1) END,
      'saldo_kg', round(saldo_kg, 1), 'saldo_qty', round(saldo_qty, 3)) ORDER BY fecha DESC, side DESC, id DESC), '[]'::jsonb)
  INTO v_movs FROM (SELECT * FROM r ORDER BY fecha DESC, side DESC, id DESC LIMIT 3000) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('fecha', fecha, 'ingreso_kg', round(e, 1), 'salida_kg', round(s, 1), 'saldo_kg', round(saldo, 1)) ORDER BY fecha), '[]'::jsonb)
  INTO v_serie FROM (
    SELECT fecha, e, s, sum(e - s) OVER (ORDER BY fecha) saldo FROM (
      SELECT fecha, COALESCE(sum(kg) FILTER (WHERE side = 'E' AND NOT interno), 0) e, COALESCE(sum(kg) FILTER (WHERE side = 'S' AND NOT interno), 0) s
      FROM inv_tmp_kx GROUP BY fecha) d) z;

  RETURN jsonb_build_object('success', true, 'ot', v_raiz, 'producto', v_prod, 'lineas', v_n, 'truncado', v_n > 3000,
    'corte', (SELECT data_max FROM public.inv_state WHERE id = 1),
    'totales', (SELECT jsonb_build_object(
        'ingreso_kg', round(COALESCE(sum(kg) FILTER (WHERE side = 'E' AND NOT interno), 0), 1),
        'salida_kg', round(COALESCE(sum(kg) FILTER (WHERE side = 'S' AND NOT interno), 0), 1),
        'ingreso_qty', CASE WHEN v_prod IS NOT NULL THEN round(COALESCE(sum(qty) FILTER (WHERE side = 'E' AND NOT interno), 0), 3) END,
        'salida_qty', CASE WHEN v_prod IS NOT NULL THEN round(COALESCE(sum(qty) FILTER (WHERE side = 'S' AND NOT interno), 0), 3) END,
        'internos', count(*) FILTER (WHERE interno)) FROM inv_tmp_kx),
    'serie', v_serie, 'movimientos', v_movs);
END $$;

REVOKE ALL ON FUNCTION public.inv_dwell_dim(jsonb), public.inv_contrato_kardex(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_dwell_dim(jsonb), public.inv_contrato_kardex(text, text) TO authenticated, service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.inv_state WHERE id = 1 AND rebuilt_at IS NOT NULL) THEN
    PERFORM public.inv_cache_refresh();
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Caché del inventario pendiente: %', SQLERRM;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
