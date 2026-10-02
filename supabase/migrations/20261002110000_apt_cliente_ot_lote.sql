-- ============================================================
-- APT — Análisis por cliente, OT y lote
-- ============================================================
-- Cada capa recibe el cliente de su lote: el de más TN en las guías de SALIDA del lote; si el lote no tiene guías,
-- el de su OT madre; si tampoco, el cliente de la OT registrada en Contratos del TMS (contracts.code = lote).
-- Nuevas agrupaciones: 'contrato' (OT madre = primer tramo del NumRel) y 'cliente', con primer ingreso, último
-- despacho (cualquier guía de los lotes del grupo) y saldo final. Filtros nuevos: clientes y contratos (exactos);
-- "cliente" (texto) ahora busca el cliente del lote.
BEGIN;

ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS cliente text;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS cliente_fuente text;
CREATE INDEX IF NOT EXISTS apt_layers_cliente_idx ON public.apt_layers (cliente);

CREATE OR REPLACE FUNCTION public.apt_rebuild()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s record; v_min date; v_max date; v_cut date;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('apt_rebuild'));
  SELECT * INTO s FROM public.apt_settings WHERE id = 1;
  SELECT min(fecha), max(fecha) INTO v_min, v_max FROM public.apt_movements WHERE active AND valid;
  v_cut := COALESCE(s.cutoff_date, v_max);

  DELETE FROM public.apt_allocations WHERE true;
  DELETE FROM public.apt_exit_class WHERE true;
  DELETE FROM public.apt_layers WHERE true;
  UPDATE public.apt_state SET cutoff = v_cut, data_min = v_min, data_max = v_max, rebuilt_at = now() WHERE id = 1;
  IF v_cut IS NULL THEN RETURN jsonb_build_object('success', true, 'cutoff', NULL); END IF;

  DROP TABLE IF EXISTS pg_temp.apt_e;
  DROP TABLE IF EXISTS pg_temp.apt_s;
  CREATE TEMP TABLE apt_e ON COMMIT DROP AS
    SELECT id, lote, producto, fecha, peso_kg AS kg,
           sum(peso_kg) OVER w - peso_kg AS c0, sum(peso_kg) OVER w AS c1
    FROM public.apt_movements
    WHERE active AND valid AND kind = 'ENTRADA' AND fecha <= v_cut
    WINDOW w AS (PARTITION BY lote, producto ORDER BY fecha, id ROWS UNBOUNDED PRECEDING);
  CREATE INDEX ON apt_e (lote, producto);

  CREATE TEMP TABLE apt_s ON COMMIT DROP AS
    SELECT m.id, m.lote, m.producto, m.fecha, m.peso_kg AS kg,
           sum(m.peso_kg) OVER w - m.peso_kg AS c0, sum(m.peso_kg) OVER w AS c1
    FROM public.apt_movements m
    WHERE m.active AND m.valid AND m.kind = 'SALIDA' AND m.fecha <= v_cut AND m.lote IS NOT NULL
      AND EXISTS (SELECT 1 FROM apt_e e WHERE e.lote = m.lote AND e.producto = m.producto)
    WINDOW w AS (PARTITION BY m.lote, m.producto ORDER BY m.fecha, m.id ROWS UNBOUNDED PRECEDING);

  -- Superposición de tramos acumulados = kg que cada salida toma de cada capa (FIFO)
  INSERT INTO public.apt_allocations (layer_id, exit_id, kg, fecha_ingreso, fecha_salida, dias)
  SELECT e.id, x.id, LEAST(e.c1, x.c1) - GREATEST(e.c0, x.c0), e.fecha, x.fecha, GREATEST(x.fecha - e.fecha, 0)
  FROM apt_e e JOIN apt_s x ON x.lote = e.lote AND x.producto = e.producto AND x.c0 < e.c1 AND x.c1 > e.c0
  WHERE LEAST(e.c1, x.c1) - GREATEST(e.c0, x.c0) > 0;

  INSERT INTO public.apt_exit_class (exit_id, lote, producto, fecha, kg, kg_asignado, kg_sin_entrada, clase)
  SELECT m.id, m.lote, m.producto, m.fecha, m.peso_kg, COALESCE(a.kg, 0), GREATEST(m.peso_kg - COALESCE(a.kg, 0), 0),
    CASE WHEN m.lote IS NULL THEN 'SIN_NUMREL'
         WHEN k.matched AND m.peso_kg - COALESCE(a.kg, 0) <= 0.001 THEN 'ASIGNADA'
         WHEN k.matched THEN 'EXCEDE_INGRESO'
         WHEN EXISTS (SELECT 1 FROM apt_e e WHERE e.lote = m.lote) THEN 'OTRO_PRODUCTO_DEL_LOTE'
         ELSE 'LOTE_SIN_INGRESO' END
  FROM public.apt_movements m
  LEFT JOIN (SELECT exit_id, sum(kg) AS kg FROM public.apt_allocations GROUP BY exit_id) a ON a.exit_id = m.id
  CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM apt_e e WHERE e.lote = m.lote AND e.producto = m.producto) AS matched) k
  WHERE m.active AND m.valid AND m.kind = 'SALIDA' AND m.fecha <= v_cut;

  INSERT INTO public.apt_layers (movement_id, lote, producto, numrel_op, glosa, familia, ipt, documento, docrel,
    fecha_ingreso, fecha_entrega, cantidad, unidad, kg_in, kg_out, kg_saldo, kg_out_before_in, kg_out_fechado, out_kg_days,
    problema_info, first_out, last_out, dias, dias_saldo, tn_dias, estado, rango, rango_orden)
  SELECT x.id, x.lote, x.producto, x.numrel, x.glosa, x.familia, x.ipt, x.documento, x.docrel, x.fecha, x.fecha_entrega,
    x.cantidad, x.unidad, x.kg_in, x.kg_out, x.kg_saldo, x.before_in, x.kg_out - x.before_in, x.kg_days,
    (x.kg_in <= 0 OR x.before_in > 0.5), x.first_out, x.last_out,
    x.dias, CASE WHEN x.abierta THEN x.dias END,
    CASE WHEN x.abierta THEN x.kg_saldo / 1000.0 * x.dias ELSE 0 END,
    CASE WHEN x.kg_in <= 0 THEN 'Problema de información'
         WHEN x.kg_saldo <= x.kg_in * s.tolerance THEN 'Despachado'
         WHEN x.kg_out > 0 THEN 'Salida parcial'
         WHEN x.dias > s.alert_days THEN 'Sin salida identificada'
         ELSE 'En APT' END,
    r.label, r.desde
  FROM (
    SELECT m.id, m.lote, m.producto, m.numrel, m.glosa, m.familia, m.ipt, m.documento, m.docrel, m.fecha, m.fecha_entrega,
      m.cantidad, m.unidad, m.peso_kg AS kg_in, COALESCE(a.kg, 0) AS kg_out, GREATEST(m.peso_kg - COALESCE(a.kg, 0), 0) AS kg_saldo,
      COALESCE(a.before_in, 0) AS before_in, COALESCE(a.kg_days, 0) AS kg_days, a.first_out, a.last_out,
      (m.peso_kg - COALESCE(a.kg, 0) > 0.0005) AS abierta,
      -- Permanencia: con saldo → corte − ingreso; cerrada → última salida − ingreso
      CASE WHEN m.peso_kg - COALESCE(a.kg, 0) > 0.0005 OR a.last_out IS NULL THEN v_cut - m.fecha
           ELSE GREATEST(a.last_out - m.fecha, 0) END AS dias
    FROM apt_e e JOIN public.apt_movements m ON m.id = e.id
    LEFT JOIN (SELECT layer_id, sum(kg) AS kg, sum(kg * dias) FILTER (WHERE fecha_salida >= fecha_ingreso) AS kg_days,
                      min(fecha_salida) AS first_out, max(fecha_salida) AS last_out,
                      sum(kg) FILTER (WHERE fecha_salida < fecha_ingreso) AS before_in
               FROM public.apt_allocations GROUP BY layer_id) a ON a.layer_id = e.id) x
  LEFT JOIN LATERAL (SELECT r.label, r.desde FROM public.apt_aging_ranges r WHERE r.desde <= x.dias ORDER BY r.desde DESC LIMIT 1) r ON true;

  UPDATE public.apt_layers l SET posible_cruce = true
  WHERE l.kg_saldo > 0.0005 AND EXISTS (
    SELECT 1 FROM public.apt_exit_class c
    WHERE c.producto = l.producto AND c.lote IS DISTINCT FROM l.lote AND c.kg_sin_entrada > 0.5 AND c.fecha >= l.fecha_ingreso
      AND c.clase IN ('OTRO_PRODUCTO_DEL_LOTE', 'LOTE_SIN_INGRESO', 'EXCEDE_INGRESO', 'SIN_NUMREL'));

  -- Cliente de cada lote: el de más TN en las guías de SALIDA del lote; si no tiene guías, el de su OT madre;
  -- si tampoco, el cliente de la OT registrada en Contratos del TMS
  UPDATE public.apt_layers l SET cliente = x.cliente, cliente_fuente = x.fuente
  FROM (
    WITH ex AS (
      SELECT m.lote, m.cliente, sum(m.peso_kg) AS kg, count(*) AS n FROM public.apt_movements m
      WHERE m.active AND m.valid AND m.kind = 'SALIDA' AND m.lote IS NOT NULL AND m.cliente IS NOT NULL AND m.fecha <= v_cut
      GROUP BY m.lote, m.cliente),
    por_lote AS (SELECT DISTINCT ON (lote) lote, cliente FROM ex ORDER BY lote, kg DESC, n DESC, cliente),
    por_ot AS (SELECT DISTINCT ON (ot) ot, cliente FROM (
                 SELECT split_part(lote, '-', 1) AS ot, cliente, sum(kg) AS kg, sum(n) AS n FROM ex GROUP BY 1, 2) z
               ORDER BY ot, kg DESC, n DESC, cliente),
    tms AS (SELECT DISTINCT ON (upper(c.code)) upper(c.code) AS code, cl.business_name AS cliente
            FROM public.contracts c JOIN public.clients cl ON cl.id = c.client_id
            WHERE cl.business_name IS NOT NULL ORDER BY upper(c.code)),
    lotes AS (SELECT DISTINCT lote FROM public.apt_layers)
    SELECT lo.lote,
      COALESCE(pl.cliente, po.cliente, t1.cliente, t2.cliente) AS cliente,
      CASE WHEN pl.cliente IS NOT NULL THEN 'GUIAS_LOTE' WHEN po.cliente IS NOT NULL THEN 'GUIAS_OT'
           WHEN COALESCE(t1.cliente, t2.cliente) IS NOT NULL THEN 'CONTRATO_TMS' END AS fuente
    FROM lotes lo
    LEFT JOIN por_lote pl ON pl.lote = lo.lote
    LEFT JOIN por_ot po ON po.ot = split_part(lo.lote, '-', 1)
    LEFT JOIN tms t1 ON t1.code = lo.lote
    LEFT JOIN tms t2 ON t2.code = split_part(lo.lote, '-', 1)) x
  WHERE x.lote = l.lote;

  RETURN jsonb_build_object('success', true, 'cutoff', v_cut,
    'capas', (SELECT count(*) FROM public.apt_layers), 'asignaciones', (SELECT count(*) FROM public.apt_allocations),
    'advertencia', CASE WHEN v_cut < v_min THEN 'La fecha de corte es anterior a los datos cargados: el modelo queda vacío'
                        WHEN v_cut > v_max THEN 'La fecha de corte es posterior al último movimiento: los días incluyen días sin datos' END);
END $$;

CREATE OR REPLACE FUNCTION public.apt_filtered(p jsonb)
RETURNS SETOF public.apt_layers LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  q jsonb := COALESCE(p, '{}'::jsonb);
  f_lote text := public.apt_like(q, 'lote'); f_lotes text[] := public.apt_arr(q, 'lotes');
  f_contrato text := upper(NULLIF(btrim(q ->> 'contrato'), '')); f_tipos text[] := public.apt_arr(q, 'tipos');
  f_op text := public.apt_like(q, 'numrel_op'); f_prod text := public.apt_like(q, 'producto');
  f_glosa text := public.apt_like(q, 'glosa'); f_ipt text := public.apt_like(q, 'ipt');
  f_fam text[] := public.apt_arr(q, 'familias'); f_est text[] := public.apt_arr(q, 'estados');
  f_rng text[] := public.apt_arr(q, 'rangos'); f_doc text[] := public.apt_arr(q, 'docrels');
  f_id date := public.apt_date(q -> 'ingreso_desde'); f_ih date := public.apt_date(q -> 'ingreso_hasta');
  f_ed date := public.apt_date(q -> 'entrega_desde'); f_eh date := public.apt_date(q -> 'entrega_hasta');
  f_saldo boolean := COALESCE(lower(q ->> 'solo_saldo') IN ('true', '1', 'si'), false);
  f_dmin numeric := public.apt_num(q -> 'dias_min'); f_cli text := public.apt_like(q, 'cliente');
  f_prods text[] := public.apt_arr(q, 'productos'); f_glosas text[] := public.apt_arr(q, 'glosas');
  f_alert text[] := public.apt_arr(q, 'alertas');
  f_clientes text[] := public.apt_arr(q, 'clientes'); f_ots text[] := public.apt_arr(q, 'contratos');
BEGIN
  RETURN QUERY
  SELECT l.* FROM public.apt_layers l
  WHERE (f_lote IS NULL OR l.lote ILIKE f_lote)
    AND (f_lotes IS NULL OR l.lote = ANY (f_lotes))
    AND (f_contrato IS NULL OR split_part(l.lote, '-', 1) = f_contrato)
    AND (f_tipos IS NULL OR public.apt_lote_tipo(l.lote) = ANY (f_tipos))
    AND (f_op IS NULL OR l.numrel_op ILIKE f_op)
    AND (f_prod IS NULL OR l.producto ILIKE f_prod)
    AND (f_glosa IS NULL OR l.glosa ILIKE f_glosa)
    AND (f_ipt IS NULL OR l.ipt ILIKE f_ipt)
    AND (f_fam IS NULL OR COALESCE(l.familia, '(sin glosa)') = ANY (f_fam))
    AND (f_est IS NULL OR l.estado = ANY (f_est))
    AND (f_rng IS NULL OR l.rango = ANY (f_rng))
    AND (f_doc IS NULL OR l.docrel = ANY (f_doc))
    AND (f_id IS NULL OR l.fecha_ingreso >= f_id)
    AND (f_ih IS NULL OR l.fecha_ingreso <= f_ih)
    AND (f_ed IS NULL OR l.fecha_entrega >= f_ed)
    AND (f_eh IS NULL OR l.fecha_entrega <= f_eh)
    AND (NOT f_saldo OR l.kg_saldo > 0.0005)
    AND (f_dmin IS NULL OR COALESCE(l.dias_saldo, l.dias) >= f_dmin)
    AND (f_prods IS NULL OR l.producto = ANY (f_prods))
    AND (f_glosas IS NULL OR COALESCE(l.glosa, l.producto) = ANY (f_glosas))
    AND (f_alert IS NULL OR ('problema_info' = ANY (f_alert) AND l.problema_info) OR ('posible_cruce' = ANY (f_alert) AND l.posible_cruce))
    AND (f_cli IS NULL OR l.cliente ILIKE f_cli)
    AND (f_clientes IS NULL OR COALESCE(l.cliente, '(Sin cliente identificado)') = ANY (f_clientes))
    AND (f_ots IS NULL OR split_part(l.lote, '-', 1) = ANY (f_ots));
END $$;

DROP FUNCTION IF EXISTS public.apt_group(jsonb, text);
CREATE OR REPLACE FUNCTION public.apt_group(p jsonb, p_dim text)
RETURNS TABLE (clave text, etiqueta text, tipo text, capas bigint, lotes bigint, productos bigint, ops bigint, ipts bigint,
  kg_in numeric, kg_out numeric, kg_saldo numeric, primer_ingreso date, ultimo_ingreso date, primera_salida date, ultima_salida date,
  fecha_entrega date, fecha_saldo date, dias integer, dias_max integer, aging_pond numeric, dias_despacho_pond numeric, tn_dias numeric,
  capas_problema bigint, estado text, rango text, rango_orden integer,
  cliente text, contratos bigint, ultimo_despacho date, kg_salidas_lote numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH s AS (SELECT * FROM public.apt_settings WHERE id = 1),
  st AS (SELECT cutoff FROM public.apt_state WHERE id = 1),
  f AS (SELECT l.*, CASE p_dim WHEN 'producto' THEN l.producto WHEN 'glosa' THEN COALESCE(l.glosa, l.producto)
                    WHEN 'familia' THEN COALESCE(l.familia, '(sin glosa)') WHEN 'numrel_op' THEN COALESCE(l.numrel_op, l.lote)
                    WHEN 'ipt' THEN COALESCE(l.ipt, '(sin IPT)') WHEN 'contrato' THEN split_part(l.lote, '-', 1)
                    WHEN 'cliente' THEN COALESCE(l.cliente, '(Sin cliente identificado)') ELSE l.lote END AS k
        FROM public.apt_filtered(p) l),
  g AS (
    SELECT f.k,
      count(*) AS capas, count(DISTINCT f.lote) AS lotes, count(DISTINCT f.producto) AS productos,
      count(DISTINCT f.numrel_op) AS ops, count(DISTINCT f.ipt) AS ipts,
      sum(f.kg_in) AS kg_in, sum(f.kg_out) AS kg_out, sum(f.kg_saldo) AS kg_saldo,
      min(f.fecha_ingreso) AS primer_ingreso, max(f.fecha_ingreso) AS ultimo_ingreso,
      min(f.first_out) AS primera_salida, max(f.last_out) AS ultima_salida, min(f.fecha_entrega) AS fecha_entrega,
      min(f.fecha_ingreso) FILTER (WHERE f.kg_saldo > 0.0005) AS fecha_saldo,
      max(COALESCE(f.dias_saldo, f.dias)) AS dias_max,
      sum(f.kg_saldo * f.dias_saldo) FILTER (WHERE f.kg_saldo > 0.0005) / NULLIF(sum(f.kg_saldo) FILTER (WHERE f.kg_saldo > 0.0005), 0) AS aging_pond,
      sum(f.out_kg_days) / NULLIF(sum(f.kg_out_fechado), 0) AS dias_despacho_pond,
      sum(f.tn_dias) AS tn_dias,
      count(*) FILTER (WHERE f.problema_info) AS capas_problema,
      (array_agg(COALESCE(f.glosa, f.producto) ORDER BY f.kg_in DESC, f.movement_id))[1] AS glosa_principal,
      (array_agg(f.cliente ORDER BY f.kg_in DESC, f.movement_id) FILTER (WHERE f.cliente IS NOT NULL))[1] AS cliente_principal,
      count(DISTINCT split_part(f.lote, '-', 1)) AS contratos
    FROM f GROUP BY f.k),
  -- Todas las guías de los lotes del grupo (incluye productos que no ingresaron por APT)
  sal AS (
    SELECT fl.k, max(c.fecha) AS ultimo_despacho, sum(c.kg) AS kg
    FROM (SELECT DISTINCT k, lote FROM f) fl JOIN public.apt_exit_class c ON c.lote = fl.lote
    GROUP BY fl.k
  )
  SELECT g.k,
    CASE WHEN p_dim IN ('lote', 'numrel_op', 'producto', 'ipt', 'contrato') THEN g.glosa_principal END,
    CASE WHEN p_dim IN ('lote', 'numrel_op', 'contrato') THEN public.apt_lote_tipo(g.k) END,
    g.capas, g.lotes, g.productos, g.ops, g.ipts, g.kg_in, g.kg_out, g.kg_saldo,
    g.primer_ingreso, g.ultimo_ingreso, g.primera_salida, g.ultima_salida, g.fecha_entrega, g.fecha_saldo,
    CASE WHEN g.fecha_saldo IS NOT NULL THEN (SELECT cutoff FROM st) - g.fecha_saldo
         WHEN g.ultima_salida IS NOT NULL THEN GREATEST(g.ultima_salida - g.primer_ingreso, 0) END,
    g.dias_max, round(g.aging_pond, 1), round(g.dias_despacho_pond, 1), round(g.tn_dias, 3), g.capas_problema,
    CASE WHEN g.kg_in <= 0 THEN 'Problema de información'
         WHEN g.kg_saldo <= g.kg_in * (SELECT tolerance FROM s) THEN 'Despachado'
         WHEN g.kg_out > 0 THEN 'Salida parcial'
         WHEN (SELECT cutoff FROM st) - g.fecha_saldo > (SELECT alert_days FROM s) THEN 'Sin salida identificada'
         ELSE 'En APT' END,
    r.label, r.desde,
    CASE WHEN p_dim = 'cliente' THEN NULL ELSE g.cliente_principal END, g.contratos, sal.ultimo_despacho, sal.kg
  FROM g
  LEFT JOIN sal ON sal.k = g.k
  LEFT JOIN LATERAL (SELECT r.label, r.desde FROM public.apt_aging_ranges r
    WHERE r.desde <= COALESCE((SELECT cutoff FROM st) - g.fecha_saldo, GREATEST(g.ultima_salida - g.primer_ingreso, 0), 0)
    ORDER BY r.desde DESC LIMIT 1) r ON true;
$$;

CREATE OR REPLACE FUNCTION public.apt_detail(p jsonb DEFAULT '{}'::jsonb, p_level text DEFAULT 'capa', p_sort text DEFAULT 'tn_dias',
  p_desc boolean DEFAULT true, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_q jsonb := COALESCE(p, '{}'::jsonb); v_rows jsonb; v_total bigint; v_tot jsonb; v_sort text; v_dir text := CASE WHEN p_desc THEN 'DESC' ELSE 'ASC' END;
        v_lim integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 20000); v_off integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  IF p_level = 'capa' THEN
    v_sort := CASE WHEN p_sort IN ('lote', 'numrel_op', 'producto', 'glosa', 'ipt', 'fecha_ingreso', 'fecha_entrega', 'last_out', 'kg_in',
                                   'kg_out', 'kg_saldo', 'dias', 'dias_saldo', 'tn_dias', 'estado', 'rango_orden', 'cantidad', 'cliente')
                   THEN p_sort ELSE 'tn_dias' END;
    EXECUTE format($q$
      SELECT COALESCE(jsonb_agg(r ORDER BY rn), '[]') FROM (
        SELECT row_number() OVER () AS rn, jsonb_build_object(
          'id', movement_id, 'lote', lote, 'tipo', public.apt_lote_tipo(lote), 'numrel_op', numrel_op, 'producto', producto, 'glosa', glosa,
          'familia', familia, 'ipt', ipt, 'cliente', cliente, 'documento', documento, 'fecha_ingreso', fecha_ingreso, 'fecha_entrega', fecha_entrega,
          'primera_salida', first_out, 'ultima_salida', last_out, 'cantidad', cantidad, 'unidad', unidad,
          'kg_in', round(kg_in, 2), 'kg_out', round(kg_out, 2), 'kg_saldo', round(kg_saldo, 2),
          'tn_in', round(kg_in / 1000, 3), 'tn_out', round(kg_out / 1000, 3), 'tn_saldo', round(kg_saldo / 1000, 3),
          'dias', dias, 'dias_saldo', dias_saldo, 'dias_despacho_pond', round(out_kg_days / NULLIF(kg_out_fechado, 0), 1),
          'rango', rango, 'tn_dias', round(tn_dias, 3), 'estado', estado,
          'salida_antes_ingreso', kg_out_before_in > 0.5, 'problema_info', problema_info, 'posible_cruce', posible_cruce) AS r
        FROM (SELECT * FROM public.apt_filtered($1) ORDER BY %I %s NULLS LAST, movement_id LIMIT $2 OFFSET $3) z) y$q$, v_sort, v_dir)
    INTO v_rows USING v_q, v_lim, v_off;
    SELECT count(*), jsonb_build_object('tn_in', round(sum(kg_in) / 1000, 3), 'tn_out', round(sum(kg_out) / 1000, 3),
        'tn_saldo', round(sum(kg_saldo) / 1000, 3), 'tn_dias', round(sum(tn_dias), 1))
      INTO v_total, v_tot FROM public.apt_filtered(v_q);
  ELSIF p_level IN ('lote', 'producto', 'glosa', 'familia', 'numrel_op', 'ipt', 'contrato', 'cliente') THEN
    v_sort := CASE WHEN p_sort IN ('clave', 'etiqueta', 'tipo', 'capas', 'lotes', 'productos', 'ops', 'ipts', 'kg_in', 'kg_out', 'kg_saldo',
                                   'primer_ingreso', 'ultimo_ingreso', 'primera_salida', 'ultima_salida', 'fecha_entrega', 'fecha_saldo',
                                   'dias', 'dias_max', 'aging_pond', 'dias_despacho_pond', 'tn_dias', 'estado', 'rango_orden', 'capas_problema',
                                   'cliente', 'contratos', 'ultimo_despacho')
                   THEN p_sort ELSE 'tn_dias' END;
    EXECUTE format($q$
      SELECT COALESCE(jsonb_agg(r ORDER BY rn), '[]') FROM (
        SELECT row_number() OVER () AS rn, to_jsonb(z) || jsonb_build_object(
          'tn_in', round(z.kg_in / 1000, 3), 'tn_out', round(z.kg_out / 1000, 3), 'tn_saldo', round(z.kg_saldo / 1000, 3),
          'pct_despachado', round(100 * z.kg_out / NULLIF(z.kg_in, 0), 1)) AS r
        FROM (SELECT * FROM public.apt_group($1, %L) ORDER BY %I %s NULLS LAST, clave LIMIT $2 OFFSET $3) z) y$q$, p_level, v_sort, v_dir)
    INTO v_rows USING v_q, v_lim, v_off;
    SELECT count(*), jsonb_build_object('tn_in', round(sum(kg_in) / 1000, 3), 'tn_out', round(sum(kg_out) / 1000, 3),
        'tn_saldo', round(sum(kg_saldo) / 1000, 3), 'tn_dias', round(sum(tn_dias), 1))
      INTO v_total, v_tot FROM public.apt_group(v_q, p_level);
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'Nivel de detalle no válido');
  END IF;
  RETURN jsonb_build_object('success', true, 'level', p_level, 'total', v_total, 'totals', v_tot, 'rows', v_rows);
END $$;

CREATE OR REPLACE FUNCTION public.apt_filter_options()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  RETURN jsonb_build_object('success', true,
    'lotes', (SELECT COALESCE(jsonb_agg(jsonb_build_object('lote', lote, 'tipo', public.apt_lote_tipo(lote), 'tn_saldo', round(kg / 1000, 3)) ORDER BY lote), '[]')
              FROM (SELECT lote, sum(kg_saldo) AS kg FROM public.apt_layers GROUP BY lote) z),
    'contratos', (SELECT COALESCE(jsonb_agg(c ORDER BY c), '[]') FROM (SELECT DISTINCT split_part(lote, '-', 1) AS c FROM public.apt_layers) z),
    'familias', (SELECT COALESCE(jsonb_agg(jsonb_build_object('familia', familia, 'tn_saldo', round(kg / 1000, 3)) ORDER BY kg DESC), '[]')
                 FROM (SELECT COALESCE(familia, '(sin glosa)') AS familia, sum(kg_saldo) AS kg FROM public.apt_layers GROUP BY 1) z),
    'clientes', (SELECT COALESCE(jsonb_agg(jsonb_build_object('cliente', cliente, 'tn_saldo', round(kg / 1000, 3)) ORDER BY kg DESC, cliente), '[]')
                 FROM (SELECT COALESCE(cliente, '(Sin cliente identificado)') AS cliente, sum(kg_saldo) AS kg FROM public.apt_layers GROUP BY 1) z),
    'docrels', (SELECT COALESCE(jsonb_agg(DISTINCT docrel), '[]') FROM public.apt_layers WHERE docrel IS NOT NULL),
    'estados', '["En APT","Salida parcial","Despachado","Sin salida identificada","Problema de información"]'::jsonb,
    'rangos', (SELECT jsonb_agg(label ORDER BY desde) FROM public.apt_aging_ranges),
    'fechas', (SELECT jsonb_build_object('ingreso_min', min(fecha_ingreso), 'ingreso_max', max(fecha_ingreso),
                 'entrega_min', min(fecha_entrega), 'entrega_max', max(fecha_entrega)) FROM public.apt_layers),
    'state', (SELECT to_jsonb(st) - 'id' FROM public.apt_state st WHERE id = 1));
END $$;

REVOKE ALL ON FUNCTION public.apt_group(jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_group(jsonb, text) TO service_role;

-- Asigna el cliente a lo ya cargado
SELECT public.apt_rebuild();

COMMIT;
