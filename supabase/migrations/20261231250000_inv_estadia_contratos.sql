-- Estadía por contrato y bodega (tabla principal de /apt/estadia): solo lectura sobre las capas FIFO que siguen en bodega.
-- Una fila por contrato (lote) y bodega del APT (647 · 540 · ST) con su OT, cliente, stock, estadía ponderada y % > 60 días.
-- No cambia tablas ni cálculos existentes: reutiliza inv_layers (las mismas capas de inv_stock_cache e inv_dwell_dim),
-- inv_transfer_links e inv_allocations (lo que consumió cada traspaso en su bodega de origen).
-- Reglas de la estadía:
--   * Solo el stock actual (qty - consumed > 0); lo despachado no cuenta.
--   * Promedio ponderado por kg (por cantidad si el contrato no tiene peso en esa bodega).
--   * Un traspaso entre bodegas del APT (647 → ST, 540 → 647…) no reinicia la antigüedad: cada capa que llegó por traspaso
--     se descompone en las capas de origen que consumió (recursivo), cada una con su fecha. Así el % > 60 días usa la edad
--     de cada componente y no la fecha promedio del traspaso. Lo que llegó desde fuera del APT cuenta desde su ingreso al APT.
--   * Componentes de un saldo inicial inferido o de una foto de stock: antigüedad no determinada (fracción exacta en pct_nd);
--     para ellos se usa la fecha conocida como mínimo («al menos N días»).
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
    WITH RECURSIVE l AS (
      SELECT l.id, l.bodega, NULLIF(l.lk, '') AS lote, l.qty - l.consumed AS rem, (l.qty - l.consumed) * l.peso_unit AS kg
      FROM public.inv_layers l
      WHERE l.qty - l.consumed > 0.0000001 AND public.apt_almacen(l.bodega) IS NOT NULL),
    -- Árbol de origen: (capa en bodega, capa de origen, fracción). Solo se sigue dentro del APT y hasta 12 traspasos.
    r (top, cur, frac, depth) AS (
      SELECT id, id, 1::numeric, 0 FROM l
      UNION ALL
      SELECT r.top, a.layer_id, r.frac * a.qty / sa.q * tl.qty / st.q, r.depth + 1
      FROM r JOIN public.inv_layers x ON x.id = r.cur
      JOIN public.inv_transfer_links tl ON tl.in_id = x.mov_id
      CROSS JOIN LATERAL (SELECT sum(t.qty) AS q FROM public.inv_transfer_links t WHERE t.in_id = x.mov_id) st
      CROSS JOIN LATERAL (SELECT sum(b.qty) AS q FROM public.inv_allocations b WHERE b.out_id = tl.out_id) sa
      JOIN public.inv_allocations a ON a.out_id = tl.out_id
      JOIN public.inv_layers s ON s.id = a.layer_id
      WHERE x.source = 'MOV' AND x.clase = 'TRASPASO' AND r.depth < 12 AND public.apt_almacen(s.bodega) IS NOT NULL
        AND st.q > 0 AND sa.q > 0),
    n AS (
      SELECT r.*, x.fecha, x.source, x.clase, x.root_known, x.root_fecha,
        x.source = 'MOV' AND x.clase = 'TRASPASO' AND r.depth < 12
          AND EXISTS (SELECT 1 FROM public.inv_transfer_links t WHERE t.in_id = x.mov_id) AS expandido,
        -- Parte del traspaso que vino de fuera del APT: cuenta desde su ingreso a esta bodega
        (SELECT sum(a.qty / sa.q * tl.qty / st.q) FROM public.inv_transfer_links tl
           CROSS JOIN LATERAL (SELECT sum(t.qty) AS q FROM public.inv_transfer_links t WHERE t.in_id = x.mov_id) st
           CROSS JOIN LATERAL (SELECT sum(b.qty) AS q FROM public.inv_allocations b WHERE b.out_id = tl.out_id) sa
           JOIN public.inv_allocations a ON a.out_id = tl.out_id JOIN public.inv_layers s ON s.id = a.layer_id
         WHERE tl.in_id = x.mov_id AND public.apt_almacen(s.bodega) IS NULL AND st.q > 0 AND sa.q > 0) AS fuera
      FROM r JOIN public.inv_layers x ON x.id = r.cur),
    -- Componentes de edad de cada capa: (fracción, fecha, conocida)
    c AS (
      SELECT top, frac * COALESCE(fuera, 0) AS f, fecha, true AS conocida FROM n WHERE expandido AND fuera > 0
      UNION ALL
      SELECT top, frac * k, CASE WHEN clase = 'TRASPASO' THEN COALESCE(root_fecha, fecha) ELSE fecha END, true
      FROM n, LATERAL (SELECT CASE WHEN source IN ('INFERIDA', 'FOTO') THEN 0 WHEN clase = 'TRASPASO' THEN COALESCE(root_known, 0) ELSE 1 END AS k) z
      WHERE NOT expandido AND k > 0
      UNION ALL
      SELECT top, frac * (1 - k), fecha, false
      FROM n, LATERAL (SELECT CASE WHEN source IN ('INFERIDA', 'FOTO') THEN 0 WHEN clase = 'TRASPASO' THEN COALESCE(root_known, 0) ELSE 1 END AS k) z
      WHERE NOT expandido AND k < 1),
    e AS (
      SELECT top, sum(f) FILTER (WHERE conocida) / NULLIF(sum(f), 0) AS fk,
        sum(f * (v_corte - fecha)) / NULLIF(sum(f), 0) AS dias,
        sum(f) FILTER (WHERE v_corte - fecha > 60) / NULLIF(sum(f), 0) AS f60
      FROM c WHERE f > 0 GROUP BY top),
    w AS (
      SELECT l.*, e.fk, e.dias, e.f60, CASE WHEN bool_or(l.kg > 0) OVER (PARTITION BY l.bodega, l.lote) THEN COALESCE(l.kg, 0) ELSE l.rem END AS w
      FROM l LEFT JOIN e ON e.top = l.id),
    g AS (
      SELECT bodega, lote, public.inv_ot(lote) AS ot, round(COALESCE(sum(kg), 0), 1) AS kg, round(sum(rem), 3) AS qty,
        bool_and(kg IS NOT NULL) AS kg_conocido,
        round(sum(w * dias) / NULLIF(sum(w) FILTER (WHERE dias IS NOT NULL), 0), 1) AS estadia,
        round(100 * (1 - sum(w * COALESCE(fk, 0)) / NULLIF(sum(w), 0)), 1) AS pct_nd,
        round(100 * sum(w * COALESCE(f60, 0)) / NULLIF(sum(w), 0), 1) AS pct_60,
        round(COALESCE(sum(kg * f60), 0), 1) AS kg_60
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
