-- ============================================================
-- APT (647 · 540 · ST): contratos / OT, ámbito APT y glosa
-- ============================================================
-- El APT se analiza en sus tres almacenes, con la misma regla del APT anterior (apt_almacen):
--   647 = 647-04 ALM PT · 540 = 540-04 (APT LB y APT.MAT.CONFO) · ST = ST-VENTAS.
-- El modelo FIFO sigue calculándose con todas las bodegas (el origen de cada lote viene de producción, pernería o
-- terceros); las lecturas del módulo filtran a los tres almacenes por defecto ("ambito": "apt").
--
-- Ficha de contrato / OT (inv_contrato): la OT madre y sus lotes (16339, 16339-S001…), con la regla de raíz del APT
-- anterior (apt_ot_raiz). Por cada ID (producto):
--   Ingresado  = entradas a los almacenes APT que no vienen de otro almacén APT con la misma OT (producción,
--                compras, asignación de un lote 540/pernería a la OT por traspaso, retornos).
--   Despachado = salidas DESPACHO VENTAS (guías). Otras salidas = consumos, traspasos fuera del APT, etc.
--   Stock      = saldo FIFO del último recálculo por almacén (647 / 540 / ST), desde la caché de stock.
-- Un traspaso entre dos almacenes APT con la misma OT es un movimiento interno y no se cuenta dos veces.
-- La lista de contratos (inv_contratos) y el resumen APT (inv_apt_resumen) se guardan con la caché de lecturas.
BEGIN;
SET LOCAL lock_timeout = '60s';

-- Peso de una línea: el del ERP o cantidad × peso unitario
CREATE OR REPLACE FUNCTION public.inv_kg(p_peso numeric, p_qty numeric, p_unit numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(NULLIF(p_peso, 0), abs(p_qty) * NULLIF(p_unit, 0), 0);
$$;

-- Movimientos de los almacenes APT con su OT (raíz) y si son internos (traspaso entre almacenes APT, misma OT)
CREATE OR REPLACE FUNCTION public.inv_apt_movs(p_raiz text DEFAULT NULL)
RETURNS TABLE (id bigint, side text, clase text, tipodocto text, almacen text, bodega text, numero text, fecha date,
  producto text, glosa text, unidad text, lote text, raiz text, qty numeric, kg numeric, razon_social text,
  fecha_entrega date, interno boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- Dos consultas separadas: con OT el filtro por prefijo del lote deja pocas filas y el plan es otro
  IF p_raiz IS NULL THEN
    RETURN QUERY
    WITH m AS (
      SELECT m.id, m.side, m.clase, m.tipodocto, public.apt_almacen(m.bodega) AS almacen, m.bodega, m.numero, m.fecha,
        m.producto, m.glosa, m.unidad, m.lote, public.apt_ot_raiz(m.lote) AS raiz, abs(m.cantidad) AS qty,
        public.inv_kg(m.peso_kg, m.cantidad, m.peso_unit) AS kg, m.razon_social, m.fecha_entrega
      FROM public.inv_movements_v m
      WHERE m.active AND public.apt_almacen(m.bodega) IS NOT NULL)
    SELECT m.*, (m.clase = 'TRASPASO' AND EXISTS (
        SELECT 1 FROM public.inv_movements_v c
        WHERE c.active AND c.numero = m.numero AND c.tipodocto = m.tipodocto AND c.producto = m.producto
          AND c.side <> m.side AND c.bodega <> m.bodega AND public.apt_almacen(c.bodega) IS NOT NULL
          AND public.apt_ot_raiz(c.lote) IS NOT DISTINCT FROM m.raiz)) AS interno
    FROM m;
  ELSE
    RETURN QUERY EXECUTE $q$
    WITH m AS (
      SELECT m.id, m.side, m.clase, m.tipodocto, public.apt_almacen(m.bodega) AS almacen, m.bodega, m.numero, m.fecha,
        m.producto, m.glosa, m.unidad, m.lote, public.apt_ot_raiz(m.lote) AS raiz, abs(m.cantidad) AS qty,
        public.inv_kg(m.peso_kg, m.cantidad, m.peso_unit) AS kg, m.razon_social, m.fecha_entrega
      FROM public.inv_movements_v m
      WHERE m.active AND upper(btrim(m.lote)) LIKE $1 || '%' AND public.apt_almacen(m.bodega) IS NOT NULL
        AND public.apt_ot_raiz(m.lote) = $1)
    SELECT m.*, (m.clase = 'TRASPASO' AND EXISTS (
        SELECT 1 FROM public.inv_movements_v c
        WHERE c.active AND c.numero = m.numero AND c.tipodocto = m.tipodocto AND c.producto = m.producto
          AND c.side <> m.side AND c.bodega <> m.bodega AND public.apt_almacen(c.bodega) IS NOT NULL
          AND public.apt_ot_raiz(c.lote) IS NOT DISTINCT FROM m.raiz)) AS interno
    FROM m$q$ USING p_raiz;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.inv_apt_movs(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_apt_movs(text) TO service_role;

-- Cliente de una OT: el de más kg en sus guías; si no hay, el del contrato en el TMS (contracts.code)
CREATE OR REPLACE FUNCTION public.inv_ot_cliente(p_raiz text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(
    (SELECT m.razon_social FROM public.inv_movements_v m
     WHERE m.active AND m.clase = 'DESPACHO' AND m.razon_social IS NOT NULL AND upper(btrim(m.lote)) LIKE p_raiz || '%' AND public.apt_ot_raiz(m.lote) = p_raiz
     GROUP BY m.razon_social ORDER BY sum(public.inv_kg(m.peso_kg, m.cantidad, m.peso_unit)) DESC, count(*) DESC LIMIT 1),
    (SELECT cl.business_name FROM public.contracts c JOIN public.clients cl ON cl.id = c.client_id
     WHERE upper(c.code) = p_raiz OR public.apt_ot_raiz(c.code) = p_raiz ORDER BY (upper(c.code) = p_raiz) DESC LIMIT 1));
$$;
REVOKE ALL ON FUNCTION public.inv_ot_cliente(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_ot_cliente(text) TO service_role;

-- Glosa de una lista de productos (la del movimiento más reciente)
CREATE OR REPLACE FUNCTION public.inv_glosas(p_productos text[])
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_object_agg(p.producto, g.glosa) FILTER (WHERE g.glosa IS NOT NULL), '{}'::jsonb)
  FROM (SELECT DISTINCT unnest(p_productos) AS producto) p
  CROSS JOIN LATERAL (SELECT m.glosa FROM public.inv_movements m
    WHERE m.active AND m.producto = p.producto AND m.glosa IS NOT NULL ORDER BY m.id DESC LIMIT 1) g;
$$;
REVOKE ALL ON FUNCTION public.inv_glosas(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_glosas(text[]) TO service_role;

-- Agrega la glosa a una lista de objetos con "producto"
CREATE OR REPLACE FUNCTION public.inv_con_glosa(p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE g jsonb;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN RETURN p_items; END IF;
  g := public.inv_glosas(ARRAY(SELECT DISTINCT x->>'producto' FROM jsonb_array_elements(p_items) x WHERE x ? 'producto'));
  RETURN (SELECT jsonb_agg(CASE WHEN x ? 'producto' AND NOT (x ? 'glosa') THEN x || jsonb_build_object('glosa', g->>(x->>'producto')) ELSE x END ORDER BY o)
          FROM jsonb_array_elements(p_items) WITH ORDINALITY t(x, o));
END $$;
REVOKE ALL ON FUNCTION public.inv_con_glosa(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_con_glosa(jsonb) TO service_role;

-- Lista de contratos con movimiento en el APT y resumen por almacén (se guardan con la caché de lecturas)
CREATE OR REPLACE FUNCTION public.inv_contratos_refresh(p_stamp timestamptz)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_corte date := (SELECT data_max FROM public.inv_state WHERE id = 1); v_lista jsonb; v_res jsonb;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS inv_tmp_apt ON COMMIT DROP AS SELECT * FROM public.inv_apt_movs(NULL) WITH NO DATA;
  TRUNCATE inv_tmp_apt;
  INSERT INTO inv_tmp_apt SELECT * FROM public.inv_apt_movs(NULL);
  ANALYZE inv_tmp_apt;

  WITH mv AS (
    SELECT raiz,
      sum(qty) FILTER (WHERE side = 'E' AND NOT interno) AS ing_qty, sum(kg) FILTER (WHERE side = 'E' AND NOT interno) AS ing_kg,
      sum(qty) FILTER (WHERE clase = 'DESPACHO') AS desp_qty, sum(kg) FILTER (WHERE clase = 'DESPACHO') AS desp_kg,
      sum(kg) FILTER (WHERE clase = 'DESPACHO' AND fecha_entrega IS NOT NULL AND fecha <= fecha_entrega) AS desp_kg_a_tiempo,
      sum(kg) FILTER (WHERE clase = 'DESPACHO' AND fecha_entrega IS NOT NULL) AS desp_kg_con_fecha,
      count(DISTINCT numero) FILTER (WHERE clase = 'DESPACHO') AS guias, count(DISTINCT producto) AS productos,
      count(DISTINCT lote) AS lotes, min(fecha) FILTER (WHERE side = 'E' AND NOT interno) AS primer_ingreso,
      max(fecha) FILTER (WHERE side = 'E' AND NOT interno) AS ultimo_ingreso,
      max(fecha) FILTER (WHERE side = 'S' AND NOT interno) AS ultima_salida, min(fecha_entrega) AS fecha_entrega,
      (array_agg(razon_social ORDER BY kg DESC) FILTER (WHERE clase = 'DESPACHO' AND razon_social IS NOT NULL))[1] AS cliente_guia
    FROM inv_tmp_apt WHERE raiz IS NOT NULL GROUP BY raiz),
  st AS (
    SELECT public.apt_ot_raiz(lote) AS raiz, sum(qty) AS qty, sum(kg) AS kg,
      sum(kg) FILTER (WHERE public.apt_almacen(bodega) = '647') AS kg_647, sum(kg) FILTER (WHERE public.apt_almacen(bodega) = '540') AS kg_540,
      sum(kg) FILTER (WHERE public.apt_almacen(bodega) = 'ST') AS kg_st, min(fecha_min) AS ingreso_mas_antiguo
    FROM public.inv_stock_cache WHERE public.apt_almacen(bodega) IS NOT NULL AND public.apt_ot_raiz(lote) IS NOT NULL GROUP BY 1),
  tms AS (SELECT DISTINCT ON (upper(c.code)) upper(c.code) AS code, cl.business_name AS cliente
          FROM public.contracts c JOIN public.clients cl ON cl.id = c.client_id WHERE cl.business_name IS NOT NULL ORDER BY upper(c.code))
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'ot', mv.raiz, 'cliente', COALESCE(mv.cliente_guia, tms.cliente), 'productos', mv.productos, 'lotes', mv.lotes,
      'ingresado_kg', round(COALESCE(mv.ing_kg, 0), 1), 'despachado_kg', round(COALESCE(mv.desp_kg, 0), 1),
      'stock_kg', round(COALESCE(st.kg, 0), 1), 'stock_qty', round(COALESCE(st.qty, 0), 3),
      'stock_647_kg', round(COALESCE(st.kg_647, 0), 1), 'stock_540_kg', round(COALESCE(st.kg_540, 0), 1), 'stock_st_kg', round(COALESCE(st.kg_st, 0), 1),
      'avance_pct', CASE WHEN COALESCE(mv.ing_kg, 0) > 0 THEN round(100 * least(COALESCE(mv.desp_kg, 0) / mv.ing_kg, 1), 1) END,
      'a_tiempo_pct', CASE WHEN COALESCE(mv.desp_kg_con_fecha, 0) > 0 THEN round(100 * COALESCE(mv.desp_kg_a_tiempo, 0) / mv.desp_kg_con_fecha, 1) END,
      'guias', mv.guias, 'primer_ingreso', mv.primer_ingreso, 'ultimo_ingreso', mv.ultimo_ingreso, 'ultima_salida', mv.ultima_salida,
      'fecha_entrega', mv.fecha_entrega, 'dias_stock', CASE WHEN COALESCE(st.kg, 0) > 0 THEN v_corte - st.ingreso_mas_antiguo END)
      ORDER BY COALESCE(st.kg, 0) DESC, COALESCE(mv.desp_kg, 0) DESC), '[]'::jsonb)
  INTO v_lista
  FROM mv LEFT JOIN st ON st.raiz = mv.raiz LEFT JOIN tms ON tms.code = mv.raiz;

  WITH sc AS (SELECT public.apt_almacen(bodega) AS almacen, * FROM public.inv_stock_cache WHERE public.apt_almacen(bodega) IS NOT NULL),
  alm AS (SELECT a.almacen, a.o FROM (VALUES ('647', 1), ('540', 2), ('ST', 3)) a(almacen, o)),
  porst AS (SELECT almacen, sum(kg) kg, sum(kg) FILTER (WHERE ot IS NULL) kg_libre, sum(kg) FILTER (WHERE ot IS NOT NULL) kg_comprometido,
              count(*) claves, count(DISTINCT public.apt_ot_raiz(lote)) ots,
              round(sum(kg * (v_corte - fecha_min)) FILTER (WHERE fecha_min IS NOT NULL) / NULLIF(sum(kg) FILTER (WHERE fecha_min IS NOT NULL), 0), 1) AS dias_pond,
              sum(kg) FILTER (WHERE v_corte - fecha_min <= 30) AS kg_0_30, sum(kg) FILTER (WHERE v_corte - fecha_min BETWEEN 31 AND 60) AS kg_31_60,
              sum(kg) FILTER (WHERE v_corte - fecha_min BETWEEN 61 AND 90) AS kg_61_90, sum(kg) FILTER (WHERE v_corte - fecha_min > 90) AS kg_90,
              sum(kg) FILTER (WHERE fecha_min IS NULL) AS kg_sin_fecha
            FROM sc GROUP BY 1),
  pormv AS (SELECT almacen, sum(kg) FILTER (WHERE side = 'E' AND NOT interno) ing_kg, sum(kg) FILTER (WHERE clase = 'DESPACHO') desp_kg,
              sum(kg) FILTER (WHERE side = 'E' AND NOT interno AND fecha > v_corte - 30) ing_kg_30,
              sum(kg) FILTER (WHERE clase = 'DESPACHO' AND fecha > v_corte - 30) desp_kg_30,
              count(DISTINCT numero) FILTER (WHERE clase = 'DESPACHO' AND fecha > v_corte - 30) guias_30
            FROM inv_tmp_apt GROUP BY 1)
  SELECT jsonb_build_object('success', true, 'corte', v_corte,
    'almacenes', COALESCE(jsonb_agg(jsonb_build_object('almacen', alm.almacen,
       'stock_kg', round(COALESCE(porst.kg, 0), 1), 'kg_libre', round(COALESCE(porst.kg_libre, 0), 1),
       'kg_comprometido', round(COALESCE(porst.kg_comprometido, 0), 1), 'claves', COALESCE(porst.claves, 0), 'ots', COALESCE(porst.ots, 0),
       'dias_pond', porst.dias_pond, 'ingresado_kg', round(COALESCE(pormv.ing_kg, 0), 1), 'despachado_kg', round(COALESCE(pormv.desp_kg, 0), 1),
       'ingresado_kg_30', round(COALESCE(pormv.ing_kg_30, 0), 1), 'despachado_kg_30', round(COALESCE(pormv.desp_kg_30, 0), 1),
       'guias_30', COALESCE(pormv.guias_30, 0),
       'antiguedad', jsonb_build_object('0-30', round(COALESCE(porst.kg_0_30, 0), 1), '31-60', round(COALESCE(porst.kg_31_60, 0), 1),
          '61-90', round(COALESCE(porst.kg_61_90, 0), 1), '>90', round(COALESCE(porst.kg_90, 0), 1), 'sin fecha', round(COALESCE(porst.kg_sin_fecha, 0), 1)))
       ORDER BY alm.o), '[]'::jsonb),
    'top_ot', (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (SELECT x FROM jsonb_array_elements(v_lista) x
               WHERE (x->>'stock_kg')::numeric > 0 ORDER BY (x->>'stock_kg')::numeric DESC LIMIT 10) t))
  INTO v_res FROM alm LEFT JOIN porst ON porst.almacen = alm.almacen LEFT JOIN pormv ON pormv.almacen = alm.almacen;

  INSERT INTO public.inv_read_cache (k, payload, stamp, built_at)
  VALUES ('contratos', jsonb_build_object('success', true, 'corte', v_corte, 'contratos', v_lista), p_stamp, clock_timestamp()),
         ('apt_resumen', v_res, p_stamp, clock_timestamp())
  ON CONFLICT (k) DO UPDATE SET payload = EXCLUDED.payload, stamp = EXCLUDED.stamp, built_at = EXCLUDED.built_at;
  RETURN jsonb_array_length(v_lista);
END $$;
REVOKE ALL ON FUNCTION public.inv_contratos_refresh(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_contratos_refresh(timestamptz) TO service_role;

-- La caché de lecturas también prepara contratos, resumen APT y la estadía del APT
DO $migration$
DECLARE src text := pg_get_functiondef('public.inv_cache_refresh()'::regprocedure);
  anchor text := '  PERFORM set_config(''request.jwt.claim.sub'', COALESCE(v_sub, ''''), true);';
BEGIN
  IF position('inv_contratos_refresh' IN src) = 0 THEN
    IF position(anchor IN src) = 0 THEN RAISE EXCEPTION 'inv_cache_refresh no coincide con la definición esperada'; END IF;
    src := replace(src, anchor, '  PERFORM public.inv_contratos_refresh(v_stamp);
  v_payload := public.inv_dwell_live(jsonb_build_object(''bodegas'', (SELECT COALESCE(jsonb_agg(code), ''[]''::jsonb)
    FROM public.inv_warehouses WHERE public.apt_almacen(code) IS NOT NULL)));
  IF (v_payload->>''success'')::boolean THEN
    INSERT INTO public.inv_read_cache (k, payload, stamp, built_at) VALUES (''dwell_apt'', v_payload, v_stamp, clock_timestamp())
    ON CONFLICT (k) DO UPDATE SET payload = EXCLUDED.payload, stamp = EXCLUDED.stamp, built_at = EXCLUDED.built_at;
  END IF;
' || anchor);
    EXECUTE src;
  END IF;
END $migration$;

-- Lecturas públicas -------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.inv_contratos()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  v := public.inv_read_cached('contratos');
  RETURN COALESCE(v, public.inv_preparing());
END $$;

CREATE OR REPLACE FUNCTION public.inv_apt_resumen()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  v := public.inv_read_cached('apt_resumen');
  RETURN COALESCE(v, public.inv_preparing());
END $$;

-- Ficha de una OT en el APT
CREATE OR REPLACE FUNCTION public.inv_contrato(p_q text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_raiz text := public.apt_ot_raiz(p_q); v_corte date := (SELECT data_max FROM public.inv_state WHERE id = 1);
  v_productos jsonb; v_guias jsonb; v_lotes jsonb; v_sosp jsonb; v_res jsonb; v_tms jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  IF v_raiz IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Escriba el número de la OT o contrato (por ejemplo 16339 o 16339-S005)');
  END IF;
  CREATE TEMP TABLE IF NOT EXISTS inv_tmp_ot ON COMMIT DROP AS SELECT * FROM public.inv_apt_movs(NULL) WITH NO DATA;
  TRUNCATE inv_tmp_ot;
  INSERT INTO inv_tmp_ot SELECT * FROM public.inv_apt_movs(v_raiz);
  IF NOT EXISTS (SELECT 1 FROM inv_tmp_ot) THEN
    RETURN jsonb_build_object('success', true, 'encontrado', false, 'ot', v_raiz, 'corte', v_corte);
  END IF;

  WITH mv AS (
    SELECT producto, max(unidad) AS unidad, array_agg(DISTINCT lote ORDER BY lote) AS lotes,
      (array_agg(glosa ORDER BY fecha DESC, id DESC) FILTER (WHERE glosa IS NOT NULL))[1] AS glosa,
      sum(qty) FILTER (WHERE side = 'E' AND NOT interno) AS ingresado, sum(kg) FILTER (WHERE side = 'E' AND NOT interno) AS ingresado_kg,
      sum(qty) FILTER (WHERE side = 'E' AND NOT interno AND clase = 'PRODUCCION') AS producido,
      sum(qty) FILTER (WHERE clase = 'DESPACHO') AS despachado, sum(kg) FILTER (WHERE clase = 'DESPACHO') AS despachado_kg,
      sum(qty) FILTER (WHERE side = 'S' AND NOT interno AND clase <> 'DESPACHO') AS otras_salidas,
      max(fecha) FILTER (WHERE side = 'E' AND NOT interno) AS ultimo_ingreso, max(fecha) FILTER (WHERE side = 'S' AND NOT interno) AS ultima_salida,
      count(DISTINCT numero) FILTER (WHERE clase = 'DESPACHO') AS guias
    FROM inv_tmp_ot GROUP BY producto),
  st AS (
    SELECT producto, sum(qty) FILTER (WHERE public.apt_almacen(bodega) = '647') AS s647, sum(qty) FILTER (WHERE public.apt_almacen(bodega) = '540') AS s540,
      sum(qty) FILTER (WHERE public.apt_almacen(bodega) = 'ST') AS sst, sum(qty) AS stock, sum(kg) AS stock_kg, sum(inferido) AS inferido,
      min(fecha_min) AS ingreso_stock
    FROM public.inv_stock_cache WHERE upper(btrim(lote)) LIKE v_raiz || '%' AND public.apt_almacen(bodega) IS NOT NULL AND public.apt_ot_raiz(lote) = v_raiz GROUP BY producto)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('producto', mv.producto, 'glosa', mv.glosa, 'unidad', mv.unidad, 'lotes', to_jsonb(mv.lotes),
      'ingresado', round(COALESCE(mv.ingresado, 0), 3), 'producido', round(COALESCE(mv.producido, 0), 3),
      'despachado', round(COALESCE(mv.despachado, 0), 3), 'otras_salidas', round(COALESCE(mv.otras_salidas, 0), 3),
      'stock_647', round(COALESCE(st.s647, 0), 3), 'stock_540', round(COALESCE(st.s540, 0), 3), 'stock_st', round(COALESCE(st.sst, 0), 3),
      'stock', round(COALESCE(st.stock, 0), 3), 'stock_kg', round(COALESCE(st.stock_kg, 0), 1), 'inferido', round(COALESCE(st.inferido, 0), 3),
      'ingresado_kg', round(COALESCE(mv.ingresado_kg, 0), 1), 'despachado_kg', round(COALESCE(mv.despachado_kg, 0), 1),
      'diferencia', round(COALESCE(mv.ingresado, 0) - COALESCE(mv.despachado, 0) - COALESCE(mv.otras_salidas, 0) - COALESCE(st.stock, 0), 3),
      'ultimo_ingreso', mv.ultimo_ingreso, 'ultima_salida', mv.ultima_salida, 'guias', mv.guias,
      'dias_apt', CASE WHEN COALESCE(st.stock, 0) > 0 THEN v_corte - st.ingreso_stock END)
      ORDER BY COALESCE(st.stock_kg, 0) DESC, COALESCE(mv.despachado_kg, 0) DESC, mv.producto), '[]'::jsonb)
  INTO v_productos FROM mv LEFT JOIN st ON st.producto = mv.producto;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('lote', lote, 'lineas', n, 'ingresado_kg', round(ing, 1), 'despachado_kg', round(desp, 1)) ORDER BY lote), '[]'::jsonb)
  INTO v_lotes FROM (SELECT lote, count(*) n, COALESCE(sum(kg) FILTER (WHERE side = 'E' AND NOT interno), 0) ing,
                      COALESCE(sum(kg) FILTER (WHERE clase = 'DESPACHO'), 0) desp FROM inv_tmp_ot GROUP BY lote) l;

  SELECT public.apt_flow_tms(ARRAY(SELECT DISTINCT numero FROM inv_tmp_ot WHERE clase = 'DESPACHO')) INTO v_tms;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('numero', numero, 'fecha', fecha, 'almacen', almacen, 'cliente', cliente, 'lineas', lineas,
      'cantidad', round(qty, 3), 'kg', round(kg, 1), 'fecha_entrega', fecha_entrega,
      'a_tiempo', CASE WHEN fecha_entrega IS NOT NULL THEN fecha <= fecha_entrega END, 'tms', v_tms->upper(numero))
      ORDER BY fecha DESC, numero), '[]'::jsonb)
  INTO v_guias FROM (SELECT numero, min(fecha) fecha, min(almacen) almacen, max(razon_social) cliente, count(*) lineas, sum(qty) qty, sum(kg) kg,
                      min(fecha_entrega) fecha_entrega FROM inv_tmp_ot WHERE clase = 'DESPACHO' GROUP BY numero) d;

  -- Lotes de otra raíz con un dígito de diferencia (posible error de digitación); candidatas desde la lista guardada
  WITH c AS MATERIALIZED (
    SELECT x->>'ot' AS raiz FROM jsonb_array_elements(COALESCE(
        (SELECT r.payload->'contratos' FROM public.inv_read_cache r WHERE r.k = 'contratos'), '[]'::jsonb)) x
    WHERE length(x->>'ot') BETWEEN length(v_raiz) - 1 AND length(v_raiz) + 1 AND public.apt_raiz_parecida(x->>'ot', v_raiz)),
  l AS MATERIALIZED (
    SELECT m.bodega, m.lote, count(*) n FROM public.inv_movements_v m
    WHERE m.active AND upper(btrim(m.lote)) LIKE ANY (ARRAY(SELECT raiz || '%' FROM c)) GROUP BY 1, 2)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('ot', raiz, 'lotes', lotes, 'lineas', n) ORDER BY n DESC, raiz), '[]'::jsonb) INTO v_sosp
  FROM (SELECT c.raiz, array_agg(DISTINCT l.lote ORDER BY l.lote) lotes, sum(l.n) n
        FROM l JOIN c ON public.apt_ot_raiz(l.lote) = c.raiz
        WHERE public.apt_almacen(l.bodega) IS NOT NULL GROUP BY 1 ORDER BY 3 DESC LIMIT 20) s;

  SELECT jsonb_build_object('cliente', public.inv_ot_cliente(v_raiz),
      'ingresado_kg', round(COALESCE(sum(kg) FILTER (WHERE side = 'E' AND NOT interno), 0), 1),
      'despachado_kg', round(COALESCE(sum(kg) FILTER (WHERE clase = 'DESPACHO'), 0), 1),
      'otras_salidas_kg', round(COALESCE(sum(kg) FILTER (WHERE side = 'S' AND NOT interno AND clase <> 'DESPACHO'), 0), 1),
      'guias', count(DISTINCT numero) FILTER (WHERE clase = 'DESPACHO'),
      'primer_ingreso', min(fecha) FILTER (WHERE side = 'E' AND NOT interno), 'ultimo_ingreso', max(fecha) FILTER (WHERE side = 'E' AND NOT interno),
      'ultima_salida', max(fecha) FILTER (WHERE side = 'S' AND NOT interno),
      'fecha_entrega_min', min(fecha_entrega), 'fecha_entrega_max', max(fecha_entrega),
      'a_tiempo_pct', round(100 * sum(kg) FILTER (WHERE clase = 'DESPACHO' AND fecha_entrega IS NOT NULL AND fecha <= fecha_entrega)
                      / NULLIF(sum(kg) FILTER (WHERE clase = 'DESPACHO' AND fecha_entrega IS NOT NULL), 0), 1),
      'productos', count(DISTINCT producto), 'lotes', count(DISTINCT lote))
  INTO v_res FROM inv_tmp_ot;
  v_res := v_res || (SELECT jsonb_build_object('stock_kg', round(COALESCE(sum(kg), 0), 1),
      'stock_647_kg', round(COALESCE(sum(kg) FILTER (WHERE public.apt_almacen(bodega) = '647'), 0), 1),
      'stock_540_kg', round(COALESCE(sum(kg) FILTER (WHERE public.apt_almacen(bodega) = '540'), 0), 1),
      'stock_st_kg', round(COALESCE(sum(kg) FILTER (WHERE public.apt_almacen(bodega) = 'ST'), 0), 1))
    FROM public.inv_stock_cache WHERE upper(btrim(lote)) LIKE v_raiz || '%' AND public.apt_almacen(bodega) IS NOT NULL AND public.apt_ot_raiz(lote) = v_raiz);
  v_res := v_res || jsonb_build_object('avance_pct', CASE WHEN (v_res->>'ingresado_kg')::numeric > 0
    THEN round(100 * least((v_res->>'despachado_kg')::numeric / (v_res->>'ingresado_kg')::numeric, 1), 1) END);

  RETURN jsonb_build_object('success', true, 'encontrado', true, 'ot', v_raiz, 'corte', v_corte,
    'stock_al_dia', COALESCE((public.inv_read_cached('stock')->'cache'->>'al_dia')::boolean, false),
    'resumen', v_res, 'productos', v_productos, 'lotes', v_lotes, 'guias', v_guias, 'sospechosos', v_sosp);
END $$;

-- Stock: ámbito APT sobre la caché
DO $migration$
DECLARE src text := pg_get_functiondef('public.inv_stock(jsonb)'::regprocedure);
  anchor text := 'AND (NOT (p ? ''kinds'') OR jsonb_array_length(p->''kinds'') = 0 OR kind IN (SELECT jsonb_array_elements_text(p->''kinds'')))';
BEGIN
  IF position('ambito' IN src) = 0 THEN
    IF position(anchor IN src) = 0 THEN RAISE EXCEPTION 'inv_stock no coincide con la definición esperada'; END IF;
    EXECUTE replace(src, anchor, anchor || '
        AND (COALESCE(p->>''ambito'', '''') <> ''apt'' OR public.apt_almacen(bodega) IS NOT NULL)');
  END IF;
END $migration$;

-- Estadía: ámbito APT (vista guardada propia) y glosa en el stock más antiguo
CREATE OR REPLACE FUNCTION public.inv_dwell(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v jsonb; v_apt boolean := COALESCE(p->>'ambito', '') = 'apt'; v_sin_filtro boolean;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  v_sin_filtro := COALESCE(p->>'desde', '') = '' AND COALESCE(p->>'hasta', '') = ''
     AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(p->'bodegas') = 'array' THEN p->'bodegas' END), 0) = 0;
  IF v_sin_filtro THEN
    v := public.inv_read_cached(CASE WHEN v_apt THEN 'dwell_apt' ELSE 'dwell' END);
    IF v IS NULL AND NOT public.inv_live_allowed() THEN RETURN public.inv_preparing(); END IF;
  END IF;
  IF v IS NULL THEN
    IF v_apt AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(p->'bodegas') = 'array' THEN p->'bodegas' END), 0) = 0 THEN
      p := p || jsonb_build_object('bodegas', (SELECT COALESCE(jsonb_agg(code), '[]'::jsonb) FROM public.inv_warehouses WHERE public.apt_almacen(code) IS NOT NULL));
    END IF;
    v := public.inv_dwell_live(p);
  END IF;
  IF v ? 'mas_antiguos' THEN v := jsonb_set(v, '{mas_antiguos}', public.inv_con_glosa(v->'mas_antiguos')); END IF;
  RETURN v;
END $$;

-- Flujo: glosa en las reasignaciones
CREATE OR REPLACE FUNCTION public.inv_flow(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  IF COALESCE(p->>'desde', '') = '' AND COALESCE(p->>'hasta', '') = '' THEN
    v := public.inv_read_cached('flow');
    IF v IS NULL AND NOT public.inv_live_allowed() THEN RETURN public.inv_preparing(); END IF;
  END IF;
  IF v IS NULL THEN v := public.inv_flow_live(p); END IF;
  IF v ? 'reasignaciones' THEN v := jsonb_set(v, '{reasignaciones}', public.inv_con_glosa(v->'reasignaciones')); END IF;
  RETURN v;
END $$;

REVOKE ALL ON FUNCTION public.inv_contratos(), public.inv_apt_resumen(), public.inv_contrato(text), public.inv_dwell(jsonb),
  public.inv_flow(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_contratos(), public.inv_apt_resumen(), public.inv_contrato(text), public.inv_dwell(jsonb),
  public.inv_flow(jsonb) TO authenticated, service_role;

-- Preparar ya contratos y resumen con el modelo vigente (si falla, el recálculo programado lo hace)
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
