-- Contratos / OT por producto: stock en unidades por bodega (647 · 540 · ST), además de los kg.
-- Arandelas y tuercas pesan gramos: su stock en kg redondea a «0 kg» y los productos sin peso no salían con
-- «Con stock en el APT». Se agregan stock_647_qty, stock_540_qty y stock_st_qty, y los filtros de estado cuentan
-- también el stock en unidades. Misma fuente (inv_stock_cache) y mismo recálculo; no cambia tablas.
BEGIN;
SET LOCAL lock_timeout = '3min';
-- Esperar a que termine un recálculo en curso: se reemplaza una función que corre dentro de él
SELECT pg_advisory_xact_lock(hashtext('inv_rebuild'));

CREATE OR REPLACE FUNCTION public.inv_contratos_producto_refresh(p_stamp timestamptz)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_corte date := (SELECT data_max FROM public.inv_state WHERE id = 1); v_lista jsonb;
BEGIN
  WITH mv AS (
    SELECT raiz, producto,
      (array_agg(glosa ORDER BY fecha DESC, id DESC) FILTER (WHERE glosa IS NOT NULL))[1] AS glosa,
      (array_agg(unidad ORDER BY fecha DESC, id DESC) FILTER (WHERE unidad IS NOT NULL))[1] AS unidad,
      sum(kg) FILTER (WHERE side = 'E' AND NOT interno) AS ing_kg, sum(kg) FILTER (WHERE clase = 'DESPACHO') AS desp_kg,
      sum(kg) FILTER (WHERE clase = 'DESPACHO' AND fecha_entrega IS NOT NULL AND fecha <= fecha_entrega) AS desp_kg_a_tiempo,
      sum(kg) FILTER (WHERE clase = 'DESPACHO' AND fecha_entrega IS NOT NULL) AS desp_kg_con_fecha,
      count(DISTINCT numero) FILTER (WHERE clase = 'DESPACHO') AS guias, count(DISTINCT lote) AS lotes,
      min(fecha) FILTER (WHERE side = 'E' AND NOT interno) AS primer_ingreso,
      max(fecha) FILTER (WHERE side = 'E' AND NOT interno) AS ultimo_ingreso,
      max(fecha) FILTER (WHERE side = 'S' AND NOT interno) AS ultima_salida, min(fecha_entrega) AS fecha_entrega
    FROM inv_tmp_apt WHERE raiz IS NOT NULL GROUP BY raiz, producto),
  st AS (
    SELECT public.apt_ot_raiz(lote) AS raiz, producto, max(glosa) AS glosa, max(unidad) AS unidad, sum(qty) AS qty, sum(kg) AS kg,
      sum(kg) FILTER (WHERE public.apt_almacen(bodega) = '647') AS kg_647, sum(kg) FILTER (WHERE public.apt_almacen(bodega) = '540') AS kg_540,
      sum(kg) FILTER (WHERE public.apt_almacen(bodega) = 'ST') AS kg_st,
      sum(qty) FILTER (WHERE public.apt_almacen(bodega) = '647') AS qty_647, sum(qty) FILTER (WHERE public.apt_almacen(bodega) = '540') AS qty_540,
      sum(qty) FILTER (WHERE public.apt_almacen(bodega) = 'ST') AS qty_st, min(fecha_min) AS ingreso_mas_antiguo
    FROM public.inv_stock_cache WHERE public.apt_almacen(bodega) IS NOT NULL AND public.apt_ot_raiz(lote) IS NOT NULL GROUP BY 1, 2),
  -- El cliente es el de la OT en la lista de OT (misma regla y mismo recálculo)
  ot AS (SELECT x->>'ot' AS raiz, x->>'cliente' AS cliente
         FROM public.inv_read_cache c, jsonb_array_elements(c.payload->'contratos') x WHERE c.k = 'contratos'),
  -- Solo OT de la lista (con movimientos); el stock de un producto sin movimientos propios entra igual, como en la OT
  f AS (SELECT COALESCE(mv.raiz, st.raiz) AS raiz, COALESCE(mv.producto, st.producto) AS producto, mv.glosa AS g_mv, mv.unidad AS u_mv,
          mv.ing_kg, mv.desp_kg, mv.desp_kg_a_tiempo, mv.desp_kg_con_fecha, mv.guias, mv.lotes, mv.primer_ingreso, mv.ultimo_ingreso,
          mv.ultima_salida, mv.fecha_entrega, st.glosa AS g_st, st.unidad AS u_st, st.qty, st.kg, st.kg_647, st.kg_540, st.kg_st, st.qty_647, st.qty_540, st.qty_st, st.ingreso_mas_antiguo
        FROM mv FULL JOIN st ON st.raiz = mv.raiz AND st.producto = mv.producto)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'ot', f.raiz, 'cliente', ot.cliente, 'producto', f.producto, 'glosa', COALESCE(f.g_mv, f.g_st), 'unidad', COALESCE(f.u_mv, f.u_st),
      'lotes', COALESCE(f.lotes, 0), 'guias', COALESCE(f.guias, 0),
      'ingresado_kg', round(COALESCE(f.ing_kg, 0), 1), 'despachado_kg', round(COALESCE(f.desp_kg, 0), 1),
      'stock_kg', round(COALESCE(f.kg, 0), 1), 'stock_qty', round(COALESCE(f.qty, 0), 3),
      'stock_647_kg', round(COALESCE(f.kg_647, 0), 1), 'stock_540_kg', round(COALESCE(f.kg_540, 0), 1), 'stock_st_kg', round(COALESCE(f.kg_st, 0), 1),
      'stock_647_qty', round(COALESCE(f.qty_647, 0), 3), 'stock_540_qty', round(COALESCE(f.qty_540, 0), 3), 'stock_st_qty', round(COALESCE(f.qty_st, 0), 3),
      'avance_pct', CASE WHEN COALESCE(f.ing_kg, 0) > 0 THEN round(100 * least(COALESCE(f.desp_kg, 0) / f.ing_kg, 1), 1) END,
      'a_tiempo_pct', CASE WHEN COALESCE(f.desp_kg_con_fecha, 0) > 0 THEN round(100 * COALESCE(f.desp_kg_a_tiempo, 0) / f.desp_kg_con_fecha, 1) END,
      'primer_ingreso', f.primer_ingreso, 'ultimo_ingreso', f.ultimo_ingreso, 'ultima_salida', f.ultima_salida,
      'fecha_entrega', f.fecha_entrega, 'dias_stock', CASE WHEN COALESCE(f.kg, 0) > 0 OR COALESCE(f.qty, 0) > 0 THEN v_corte - f.ingreso_mas_antiguo END)
      ORDER BY COALESCE(f.kg, 0) DESC, COALESCE(f.desp_kg, 0) DESC, f.raiz, f.producto), '[]'::jsonb)
  INTO v_lista
  FROM f JOIN ot ON ot.raiz = f.raiz;

  INSERT INTO public.inv_read_cache (k, payload, stamp, built_at)
  VALUES ('contratos_producto', jsonb_build_object('success', true, 'corte', v_corte, 'filas', v_lista), p_stamp, clock_timestamp())
  ON CONFLICT (k) DO UPDATE SET payload = EXCLUDED.payload, stamp = EXCLUDED.stamp, built_at = EXCLUDED.built_at;
  RETURN jsonb_array_length(v_lista);
END $$;
REVOKE ALL ON FUNCTION public.inv_contratos_producto_refresh(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_contratos_producto_refresh(timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.inv_contratos_producto(p_estado text DEFAULT 'stock')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  v := public.inv_read_cached('contratos_producto');
  IF v IS NULL THEN RETURN public.inv_preparing(); END IF;
  RETURN jsonb_set(v, '{filas}', COALESCE((SELECT jsonb_agg(x ORDER BY o) FROM jsonb_array_elements(v->'filas') WITH ORDINALITY t(x, o)
    WHERE CASE COALESCE(p_estado, '')
      WHEN 'stock' THEN (x->>'stock_kg')::numeric > 0 OR COALESCE((x->>'stock_qty')::numeric, 0) > 0
      WHEN 'curso' THEN (x->>'stock_kg')::numeric > 0 OR COALESCE((x->>'stock_qty')::numeric, 0) > 0 OR COALESCE((x->>'avance_pct')::numeric, 0) < 100
      WHEN 'cerradas' THEN (x->>'stock_kg')::numeric <= 0 AND COALESCE((x->>'stock_qty')::numeric, 0) <= 0
      ELSE true END), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.inv_contratos_producto(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_contratos_producto(text) TO authenticated, service_role;

-- El próximo recálculo programado (cada 2 min) prepara la caché con las columnas nuevas
UPDATE public.inv_state SET dirty = true WHERE id = 1;

NOTIFY pgrst, 'reload schema';
COMMIT;
