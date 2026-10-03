-- ============================================================
-- APT — Kardex de trazabilidad (647 · 540 · ST VENTAS)
-- ============================================================
-- Libro de movimientos en orden cronológico con saldo acumulado, tal como los registra el ERP (sin FIFO):
-- ingreso de producción, traspaso recibido / enviado (con almacén y lote de la contraparte), guía al cliente, consumo
-- interno y devolución. El stock previo inferido por el flujo (lo que existía antes del primer día cargado) entra como
-- primera fila "Stock previo", así el saldo no arranca en negativo.
-- p (filtros): desde, hasta, lote (contiene) o lote_exacto, ot (OT madre), clientes[], producto, glosa, documento,
--   almacenes[] (647, 540, ST), tipos[] (INICIAL, PRODUCCION, TRASPASO_ENT, TRASPASO_SAL, DESPACHO, CONSUMO, DEVOLUCION).
-- p_nivel: clave del saldo acumulado — lote_producto (kardex por SKU de cada lote), producto, lote, total.
-- p_por_almacen: el saldo se lleva por almacén (true) o consolidado de los tres (false; un traspaso entre ellos suma 0).
BEGIN;

CREATE OR REPLACE FUNCTION public.apt_kardex(p jsonb DEFAULT '{}'::jsonb, p_nivel text DEFAULT 'lote_producto',
  p_por_almacen boolean DEFAULT true, p_limit integer DEFAULT 500, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_desde date; v_hasta date; v_rows jsonb; v_res jsonb; v_alm jsonb; v_tipos jsonb; v_total bigint; v_min date; v_max date;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  IF p_nivel NOT IN ('lote_producto', 'producto', 'lote', 'total') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Nivel de saldo no válido');
  END IF;
  p := COALESCE(p, '{}'::jsonb);
  p_limit := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 20000);
  p_offset := GREATEST(COALESCE(p_offset, 0), 0);
  SELECT min(fecha), max(fecha) INTO v_min, v_max FROM public.apt_movements WHERE active AND valid;
  v_desde := COALESCE(public.apt_date(p -> 'desde'), v_min);
  v_hasta := COALESCE(public.apt_date(p -> 'hasta'), v_max);

  DROP TABLE IF EXISTS pg_temp.k_mov;
  CREATE TEMP TABLE k_mov ON COMMIT DROP AS
  WITH cli AS (SELECT lote, max(cliente) AS cliente FROM public.apt_flow_layers WHERE cliente IS NOT NULL GROUP BY 1),
  base AS (
    SELECT m.id, m.fecha,
      CASE m.kind WHEN 'ENTRADA' THEN 'PRODUCCION' WHEN 'SALIDA' THEN 'DESPACHO' ELSE m.kind END AS tipo,
      COALESCE(m.almacen, '647') AS almacen, m.documento, m.tipodocto, m.lote, m.producto, m.glosa, m.unidad,
      CASE WHEN m.kind IN ('ENTRADA', 'TRASPASO_ENT', 'DEVOLUCION') THEN 1 ELSE -1 END AS signo,
      m.cantidad, m.peso_kg AS kg, m.numrel, m.docrel,
      COALESCE(CASE WHEN m.kind = 'SALIDA' THEN m.cliente END, c.cliente) AS cliente,
      CASE m.kind WHEN 'TRASPASO_SAL' THEN COALESCE(x.almacen_destino, 'Otro almacén') WHEN 'TRASPASO_ENT' THEN COALESCE(l.almacen_origen, 'Otro almacén') END AS contraparte,
      CASE m.kind WHEN 'TRASPASO_SAL' THEN NULLIF(x.lote_destino, m.lote) WHEN 'TRASPASO_ENT' THEN NULLIF(l.lote_origen, m.lote) END AS lote_rel,
      CASE WHEN m.kind IN ('ENTRADA', 'TRASPASO_ENT', 'DEVOLUCION') THEN 0 ELSE 1 END AS o
    FROM public.apt_movements m
    LEFT JOIN public.apt_flow_exits x ON m.kind = 'TRASPASO_SAL' AND x.id = m.id
    LEFT JOIN public.apt_flow_layers l ON m.kind = 'TRASPASO_ENT' AND l.id = m.id
    LEFT JOIN cli c ON c.lote = m.lote
    WHERE m.active AND m.valid AND m.lote IS NOT NULL AND (m.almacen IS NOT NULL OR m.kind = 'ENTRADA')
    UNION ALL
    -- Stock previo inferido por el flujo: primera fila de cada lote y producto en su almacén
    SELECT -l.id, NULL::date, 'INICIAL', l.almacen, NULL, 'STOCK PREVIO INFERIDO', l.lote, l.producto, l.glosa, NULL,
      1, NULL::numeric, l.kg_in, NULL, NULL, l.cliente, NULL, NULL, -1
    FROM public.apt_flow_layers l WHERE l.tipo = 'INICIAL')
  SELECT * FROM base b
  WHERE (NULLIF(btrim(p ->> 'lote_exacto'), '') IS NULL OR b.lote = upper(btrim(p ->> 'lote_exacto')))
    AND (NULLIF(btrim(p ->> 'lote'), '') IS NULL OR b.lote ILIKE '%' || btrim(p ->> 'lote') || '%' OR b.lote_rel ILIKE '%' || btrim(p ->> 'lote') || '%')
    AND (NULLIF(btrim(p ->> 'ot'), '') IS NULL OR split_part(b.lote, '-', 1) = upper(btrim(p ->> 'ot')))
    AND (NULLIF(btrim(p ->> 'producto'), '') IS NULL OR b.producto ILIKE '%' || btrim(p ->> 'producto') || '%')
    AND (NULLIF(btrim(p ->> 'glosa'), '') IS NULL OR b.glosa ILIKE '%' || btrim(p ->> 'glosa') || '%')
    AND (NULLIF(btrim(p ->> 'documento'), '') IS NULL OR b.documento ILIKE '%' || btrim(p ->> 'documento') || '%')
    AND (jsonb_typeof(p -> 'clientes') IS DISTINCT FROM 'array' OR jsonb_array_length(p -> 'clientes') = 0
         OR COALESCE(b.cliente, '(Sin cliente identificado)') IN (SELECT jsonb_array_elements_text(p -> 'clientes')))
    AND (jsonb_typeof(p -> 'almacenes') IS DISTINCT FROM 'array' OR jsonb_array_length(p -> 'almacenes') = 0
         OR b.almacen IN (SELECT jsonb_array_elements_text(p -> 'almacenes')))
    AND (jsonb_typeof(p -> 'tipos') IS DISTINCT FROM 'array' OR jsonb_array_length(p -> 'tipos') = 0
         OR b.tipo IN (SELECT jsonb_array_elements_text(p -> 'tipos')));

  -- Saldo acumulado por la clave elegida (las filas anteriores al periodo forman el saldo inicial)
  DROP TABLE IF EXISTS pg_temp.k_run;
  CREATE TEMP TABLE k_run ON COMMIT DROP AS
  SELECT k.*, z.clave,
    sum(k.signo * k.kg) OVER w AS saldo_kg,
    CASE WHEN p_nivel IN ('lote_producto', 'producto') THEN sum(k.signo * COALESCE(k.cantidad, 0)) OVER w END AS saldo_cant,
    row_number() OVER (ORDER BY z.clave, k.fecha NULLS FIRST, k.o, k.id) AS rn
  FROM k_mov k
  CROSS JOIN LATERAL (SELECT concat_ws(' · ', CASE WHEN p_por_almacen THEN k.almacen END,
      CASE p_nivel WHEN 'lote_producto' THEN k.lote || ' | ' || k.producto WHEN 'producto' THEN k.producto WHEN 'lote' THEN k.lote ELSE 'Total' END) AS clave) z
  WINDOW w AS (PARTITION BY z.clave ORDER BY k.fecha NULLS FIRST, k.o, k.id ROWS UNBOUNDED PRECEDING);
  CREATE INDEX ON k_run (rn);

  SELECT count(*) INTO v_total FROM k_run WHERE fecha BETWEEN v_desde AND v_hasta;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', r.id, 'clave', r.clave, 'fecha', r.fecha, 'tipo', r.tipo, 'documento', r.documento,
           'tipodocto', r.tipodocto, 'almacen', r.almacen, 'contraparte', r.contraparte, 'lote', r.lote, 'lote_rel', r.lote_rel,
           'producto', r.producto, 'glosa', r.glosa, 'cliente', r.cliente, 'numrel', r.numrel, 'docrel', r.docrel, 'unidad', r.unidad,
           'cant_in', CASE WHEN r.signo > 0 THEN r.cantidad END, 'cant_out', CASE WHEN r.signo < 0 THEN r.cantidad END,
           'kg_in', CASE WHEN r.signo > 0 THEN round(r.kg, 3) END, 'kg_out', CASE WHEN r.signo < 0 THEN round(r.kg, 3) END,
           'saldo_kg', round(r.saldo_kg, 3), 'saldo_cant', r.saldo_cant,
           'saldo_kg_antes', round(r.saldo_kg - r.signo * r.kg, 3)) ORDER BY r.rn), '[]')
  INTO v_rows
  FROM (SELECT * FROM k_run WHERE fecha BETWEEN v_desde AND v_hasta ORDER BY rn OFFSET p_offset LIMIT p_limit) r;

  -- Resumen del periodo: saldo inicial (incluye stock previo y movimientos anteriores), entradas, salidas y saldo final
  SELECT jsonb_build_object(
    'claves', (SELECT count(DISTINCT clave) FROM k_run WHERE fecha BETWEEN v_desde AND v_hasta),
    'movimientos', v_total,
    'guias', (SELECT count(DISTINCT documento) FROM k_run WHERE tipo = 'DESPACHO' AND fecha BETWEEN v_desde AND v_hasta),
    'lotes', (SELECT count(DISTINCT lote) FROM k_run WHERE fecha BETWEEN v_desde AND v_hasta),
    'saldo_inicial_tn', round(COALESCE((SELECT sum(signo * kg) FROM k_run WHERE fecha IS NULL OR fecha < v_desde), 0) / 1000.0, 3),
    'entradas_tn', round(COALESCE((SELECT sum(kg) FROM k_run WHERE signo > 0 AND fecha BETWEEN v_desde AND v_hasta), 0) / 1000.0, 3),
    'salidas_tn', round(COALESCE((SELECT sum(kg) FROM k_run WHERE signo < 0 AND fecha BETWEEN v_desde AND v_hasta), 0) / 1000.0, 3),
    'saldo_final_tn', round(COALESCE((SELECT sum(signo * kg) FROM k_run WHERE fecha IS NULL OR fecha <= v_hasta), 0) / 1000.0, 3),
    'claves_negativas', (SELECT count(*) FROM (SELECT clave FROM k_run WHERE fecha IS NULL OR fecha <= v_hasta GROUP BY clave
                                              HAVING sum(signo * kg) < -0.5) z))
  INTO v_res;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('almacen', almacen, 'inicial_tn', round(ini / 1000.0, 3), 'entradas_tn', round(ent / 1000.0, 3),
           'salidas_tn', round(sal / 1000.0, 3), 'saldo_tn', round((ini + ent - sal) / 1000.0, 3))
           ORDER BY CASE almacen WHEN '647' THEN 1 WHEN '540' THEN 2 ELSE 3 END), '[]')
  INTO v_alm
  FROM (SELECT almacen, COALESCE(sum(signo * kg) FILTER (WHERE fecha IS NULL OR fecha < v_desde), 0) AS ini,
               COALESCE(sum(kg) FILTER (WHERE signo > 0 AND fecha BETWEEN v_desde AND v_hasta), 0) AS ent,
               COALESCE(sum(kg) FILTER (WHERE signo < 0 AND fecha BETWEEN v_desde AND v_hasta), 0) AS sal
        FROM k_run GROUP BY almacen) z;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('tipo', tipo, 'filas', n, 'tn', round(kg / 1000.0, 3)) ORDER BY kg DESC), '[]')
  INTO v_tipos
  FROM (SELECT tipo, count(*) AS n, sum(kg) AS kg FROM k_run WHERE fecha BETWEEN v_desde AND v_hasta GROUP BY 1) z;

  RETURN jsonb_build_object('success', true, 'desde', v_desde, 'hasta', v_hasta, 'data_min', v_min, 'data_max', v_max,
    'nivel', p_nivel, 'por_almacen', p_por_almacen, 'total', v_total, 'offset', p_offset, 'limit', p_limit,
    'resumen', v_res, 'almacenes', v_alm, 'tipos', v_tipos, 'filas', v_rows);
END $$;

REVOKE ALL ON FUNCTION public.apt_kardex(jsonb, text, boolean, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_kardex(jsonb, text, boolean, integer, integer) TO authenticated, service_role;

COMMIT;
