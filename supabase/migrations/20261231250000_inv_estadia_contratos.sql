-- Estadía por contrato y bodega (tabla principal de /apt/estadia): solo lectura sobre las capas FIFO que siguen en bodega.
-- Una fila por contrato (lote) y bodega del APT (647 · 540 · ST) con su OT, cliente, stock, estadía ponderada y % > 60 días.
-- No cambia tablas ni cálculos existentes: reutiliza inv_layers (las mismas capas de inv_stock_cache e inv_dwell_dim).
-- Reglas de la estadía:
--   * Solo el stock actual (qty - consumed > 0); lo despachado no cuenta.
--   * Promedio ponderado por kg de cada capa (por cantidad si el contrato no tiene peso en esa bodega).
--   * Un traspaso entre bodegas del APT (647 → ST, 540 → 647…) no reinicia la antigüedad: cuenta desde el ingreso de origen.
--   * Saldo inicial inferido, foto de stock o traspaso cuyo origen viene de un saldo inferido: antigüedad no determinada.
--     Para esas capas se usa la fecha conocida como mínimo («al menos N días») y se informa el % no determinado.
CREATE OR REPLACE FUNCTION public.inv_estadia_contratos()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_corte date;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  SELECT data_max INTO v_corte FROM public.inv_state WHERE id = 1;
  RETURN (
    WITH l AS (
      SELECT l.bodega, NULLIF(l.lk, '') AS lote, l.qty - l.consumed AS rem, (l.qty - l.consumed) * l.peso_unit AS kg,
        v_corte - l.fecha AS dias_min,
        v_corte - CASE WHEN l.source IN ('INFERIDA', 'FOTO') THEN NULL
          WHEN l.clase = 'TRASPASO' AND l.root_known < 0.5 THEN NULL
          WHEN l.clase = 'TRASPASO' AND public.apt_almacen(l.root_bodega) IS NOT NULL THEN l.root_fecha
          -- shortcut: un traspaso desde fuera del APT cuenta desde su ingreso al APT; si antes pasó por otra bodega del APT
          -- (fuera → 647 → ST) se pierde ese tramo. Mejorar si inv_layers guarda la capa de la que proviene.
          ELSE l.fecha END AS dias
      FROM public.inv_layers l
      WHERE l.qty - l.consumed > 0.0000001 AND public.apt_almacen(l.bodega) IS NOT NULL),
    w AS (SELECT l.*, CASE WHEN bool_or(kg > 0) OVER (PARTITION BY bodega, lote) THEN COALESCE(kg, 0) ELSE rem END AS w FROM l),
    g AS (
      SELECT bodega, lote, public.inv_ot(lote) AS ot, round(COALESCE(sum(kg), 0), 1) AS kg, round(sum(rem), 3) AS qty,
        bool_and(kg IS NOT NULL) AS kg_conocido,
        round(sum(w * COALESCE(dias, dias_min)) / NULLIF(sum(w), 0), 1) AS estadia,
        round(100 * COALESCE(sum(w) FILTER (WHERE dias IS NULL), 0) / NULLIF(sum(w), 0), 1) AS pct_nd,
        round(100 * COALESCE(sum(w) FILTER (WHERE COALESCE(dias, dias_min) > 60), 0) / NULLIF(sum(w), 0), 1) AS pct_60,
        round(COALESCE(sum(kg) FILTER (WHERE COALESCE(dias, dias_min) > 60), 0), 1) AS kg_60
      FROM w GROUP BY bodega, lote),
    oc AS (SELECT DISTINCT ON (ot) ot, cliente FROM public.inv_ot_clientes() ORDER BY ot),
    sc AS (SELECT lk AS lote, max(cliente) AS cliente FROM public.inv_stock_cache WHERE cliente IS NOT NULL GROUP BY lk)
    SELECT jsonb_build_object('success', true, 'corte', v_corte, 'filas', COALESCE(jsonb_agg(jsonb_build_object(
        'contrato', CASE WHEN g.ot IS NOT NULL THEN g.lote END, 'lote', g.lote, 'ot', g.ot, 'cliente', COALESCE(oc.cliente, sc.cliente),
        'bodega', g.bodega, 'almacen', public.apt_almacen(g.bodega), 'stock_kg', g.kg, 'stock_qty', g.qty, 'kg_conocido', g.kg_conocido,
        'estadia', g.estadia, 'pct_nd', g.pct_nd, 'pct_60', g.pct_60, 'kg_60', g.kg_60)
        ORDER BY g.estadia DESC NULLS LAST, g.kg DESC, g.lote), '[]'::jsonb))
    FROM g LEFT JOIN oc ON oc.ot = g.ot LEFT JOIN sc ON sc.lote = g.lote);
END $function$;

REVOKE ALL ON FUNCTION public.inv_estadia_contratos() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_estadia_contratos() TO authenticated, service_role;
