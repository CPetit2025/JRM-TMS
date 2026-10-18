-- Bound each FIFO layer lookup before joining, refresh intermediate planner statistics,
-- and classify incoming movements at insertion to avoid rewriting the entire uploaded history.
-- FIFO intervals, quantities, weight, consumption and origin formulas are unchanged.
BEGIN;
CREATE OR REPLACE FUNCTION public.inv_upload_rows(p_upload_id uuid, p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET jit = off AS $$
DECLARE v_side text; v_ok integer := 0; v_total integer; v_excl jsonb; v_hash text; v_result jsonb;
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar movimientos de inventario');
  END IF;
  SELECT side INTO v_side FROM public.inv_uploads WHERE id = p_upload_id AND status = 'CARGANDO' FOR UPDATE;
  IF v_side IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'La carga no existe o ya fue cerrada'); END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Envíe un arreglo de filas');
  END IF;
  IF jsonb_array_length(p_rows) > 5000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Envíe como máximo 5000 filas por bloque');
  END IF;
  -- A network retry of a committed chunk must not duplicate rows or counters.
  -- Serialized by the upload row lock; the digest includes original ERP line numbers.
  v_hash := md5(p_rows::text);
  SELECT result INTO v_result FROM public.inv_upload_chunks WHERE upload_id = p_upload_id AND chunk_hash = v_hash;
  IF FOUND THEN RETURN v_result || jsonb_build_object('replayed', true); END IF;
  v_total := jsonb_array_length(p_rows);

  IF to_regclass('pg_temp.inv_tmp_rows') IS NULL THEN
    CREATE TEMP TABLE inv_tmp_rows (n integer, j jsonb, motivo text) ON COMMIT DROP;
  END IF;
  TRUNCATE inv_tmp_rows;
  INSERT INTO inv_tmp_rows (n, j, motivo)
  SELECT COALESCE((r.j->>'__row')::integer, r.ord::integer), r.j,
    CASE
      WHEN public.inv_code(r.j->>'BODEGA') IS NULL THEN 'Sin bodega'
      WHEN NULLIF(btrim(r.j->>'Producto'), '') IS NULL THEN 'Sin producto'
      WHEN v_side <> 'STOCK' AND (r.j->>'Fecha') !~ '^\d{4}-\d{2}-\d{2}$' THEN 'Sin fecha'
      WHEN v_side <> 'STOCK' AND public.inv_code(r.j->>'TIPODOCTO') IS NULL THEN 'Sin tipo de documento'
      WHEN (r.j->>'Cantidad') !~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$' THEN 'Cantidad no numérica'
      WHEN v_side <> 'STOCK' AND (r.j->>'Cantidad')::numeric = 0 THEN 'Cantidad cero'
    END
  FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS r(j, ord);

  IF v_side = 'STOCK' THEN
    INSERT INTO public.inv_stock_snapshots (upload_id, bodega, producto, lote, glosa, unidad, cantidad, peso_kg)
    SELECT p_upload_id, public.inv_code(j->>'BODEGA'), btrim(j->>'Producto'), public.inv_lote(j->>'Lote'),
      NULLIF(btrim(j->>'GLOSA'), ''), public.inv_code(j->>'UNIDAD'), (j->>'Cantidad')::numeric,
      CASE WHEN (j->>'Peso') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN abs((j->>'Peso')::numeric) END
    FROM inv_tmp_rows WHERE motivo IS NULL AND (j->>'Cantidad')::numeric > 0;
    GET DIAGNOSTICS v_ok = ROW_COUNT;
  ELSE
    INSERT INTO public.inv_movements (upload_id, side, clase, linea, tipodocto, bodega, numero, fecha, cod_legal, razon_social,
      producto, glosa, cantidad, unidad, doc_rel, num_rel, fecha_entrega, contrato, ref_tipo, ref_correlativo, ref_numero,
      ref_fecha, lote_raw, lote, ot, comentario, peso_unit, peso_kg, ccosto)
    SELECT p_upload_id, v_side, COALESCE(d.clase, public.inv_guess_class(public.inv_code(j->>'TIPODOCTO'))), n, public.inv_code(j->>'TIPODOCTO'), public.inv_code(j->>'BODEGA'),
      COALESCE(public.apt_id(NULLIF(btrim(j->>'Numero'), '')), 'S/N'), (j->>'Fecha')::date,
      NULLIF(regexp_replace(btrim(COALESCE(j->>'CodLegal', '')), '\.0+$', ''), ''), NULLIF(btrim(j->>'RazonSocial'), ''),
      btrim(j->>'Producto'), NULLIF(btrim(j->>'GLOSA'), ''), q.cant, public.inv_code(j->>'UNIDAD'),
      public.inv_code(j->>'DocRel'), public.inv_lote(j->>'NumRel'),
      CASE WHEN (j->>'FechaEntrega') ~ '^\d{4}-\d{2}-\d{2}$' THEN (j->>'FechaEntrega')::date END,
      public.inv_lote(j->>'Contrato'), public.inv_code(j->>'RefTipoDocto'),
      NULLIF(NULLIF(btrim(j->>'RefCorrelativo'), ''), '0'), NULLIF(NULLIF(btrim(j->>'RefNumero'), ''), '0'),
      -- 22/03/2020 es el valor por defecto del ERP: "sin dato"
      CASE WHEN (j->>'RefFecha') ~ '^\d{4}-\d{2}-\d{2}$' AND (j->>'RefFecha') <> '2020-03-22' THEN (j->>'RefFecha')::date END,
      NULLIF(btrim(j->>'Lote'), ''), l.lote, public.inv_ot(l.lote), NULLIF(btrim(j->>'Comentario'), ''),
      pu.v, CASE WHEN pu.v IS NOT NULL THEN round(abs(q.cant) * pu.v, 6) END, NULLIF(btrim(j->>'CCostoJRM'), '')
    FROM inv_tmp_rows
    LEFT JOIN public.inv_doc_types d ON d.tipodocto = public.inv_code(j->>'TIPODOCTO')
    CROSS JOIN LATERAL (SELECT (j->>'Cantidad')::numeric AS cant) q
    CROSS JOIN LATERAL (SELECT public.inv_lote(j->>'Lote') AS lote) l
    CROSS JOIN LATERAL (SELECT CASE
        WHEN (j->>'PesoUnitario') ~ '^[0-9]+(\.[0-9]+)?$' AND (j->>'PesoUnitario')::numeric > 0 THEN (j->>'PesoUnitario')::numeric
        WHEN (j->>'PesoTotalProduccido') ~ '^-?[0-9]+(\.[0-9]+)?$' AND (j->>'PesoTotalProduccido')::numeric <> 0
          THEN round(abs((j->>'PesoTotalProduccido')::numeric) / abs(q.cant), 6) END AS v) pu
    WHERE motivo IS NULL;
    GET DIAGNOSTICS v_ok = ROW_COUNT;

    INSERT INTO public.inv_doc_types (tipodocto, clase)
    SELECT DISTINCT public.inv_code(j->>'TIPODOCTO'), public.inv_guess_class(public.inv_code(j->>'TIPODOCTO'))
    FROM inv_tmp_rows WHERE motivo IS NULL
    ON CONFLICT (tipodocto) DO NOTHING;
  END IF;

  INSERT INTO public.inv_warehouses (code, name, kind, stage)
  SELECT DISTINCT ON (c) c, left(btrim(j->>'BODEGA'), 120), public.inv_guess_kind(c), public.inv_kind_stage(public.inv_guess_kind(c))
  FROM inv_tmp_rows CROSS JOIN LATERAL (SELECT public.inv_code(j->>'BODEGA') AS c) b
  WHERE motivo IS NULL
  ON CONFLICT (code) DO NOTHING;

  SELECT COALESCE(jsonb_object_agg(motivo, n), '{}'::jsonb) INTO v_excl
  FROM (SELECT motivo, count(*) AS n FROM inv_tmp_rows WHERE motivo IS NOT NULL GROUP BY motivo) x;

  UPDATE public.inv_uploads u SET rows_total = u.rows_total + v_total, rows_valid = u.rows_valid + v_ok,
    excluded = (SELECT COALESCE(jsonb_object_agg(k, COALESCE((u.excluded->>k)::integer, 0) + COALESCE((v_excl->>k)::integer, 0)), '{}'::jsonb)
                FROM (SELECT jsonb_object_keys(u.excluded) AS k UNION SELECT jsonb_object_keys(v_excl)) ks)
  WHERE u.id = p_upload_id;
  v_result := jsonb_build_object('success', true, 'inserted', v_ok, 'excluded', v_excl);
  INSERT INTO public.inv_upload_chunks(upload_id, chunk_hash, result) VALUES(p_upload_id, v_hash, v_result);
  RETURN v_result;
END $$;
CREATE OR REPLACE FUNCTION public.inv_rebuild()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET jit = off AS $$
DECLARE v_snap uuid; v_cut date; v_from date; v_iter integer := 0; v_changed integer; v_t0 timestamptz := clock_timestamp();
  v_stats jsonb; v_tmp text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('inv_rebuild'));
  -- Tablas de trabajo (pueden quedar de un recálculo anterior en la misma transacción)
  FOREACH v_tmp IN ARRAY ARRAY['inv_tr', 'inv_ev', 'inv_pu', 'inv_open', 'inv_out', 'inv_comp', 'inv_root'] LOOP
    IF to_regclass('pg_temp.' || v_tmp) IS NOT NULL THEN EXECUTE format('DROP TABLE pg_temp.%I', v_tmp); END IF;
  END LOOP;

  -- Clase vigente del catálogo (se puede reclasificar un tipo de documento)
  UPDATE public.inv_movements m SET clase = d.clase FROM public.inv_doc_types d
  WHERE d.tipodocto = m.tipodocto AND m.clase IS DISTINCT FROM d.clase;

  ANALYZE public.inv_movements;
  -- Foto de stock vigente: la última aplicada. El modelo arranca el día siguiente al corte.
  SELECT id, cutoff INTO v_snap, v_cut FROM public.inv_uploads
  WHERE side = 'STOCK' AND status = 'APLICADA' ORDER BY cutoff DESC, applied_at DESC LIMIT 1;
  v_from := v_cut + 1;

  TRUNCATE public.inv_allocations, public.inv_transfer_links, public.inv_layers;

  -- 4.1 Traspasos: primero líneas con la misma cantidad (respeta la reasignación de lote línea a línea), luego el resto
  --     en orden de línea, repartiendo cantidades.
  CREATE TEMP TABLE inv_tr ON COMMIT DROP AS
  SELECT m.id, m.tipodocto, m.numero, m.producto, m.linea, abs(m.cantidad) AS q, m.cantidad < 0 AS is_out
  FROM public.inv_movements m
  WHERE m.active AND m.clase = 'TRASPASO' AND (v_from IS NULL OR m.fecha >= v_from);

  ANALYZE inv_tr;
  INSERT INTO public.inv_transfer_links (out_id, in_id, qty)
  SELECT s.id, e.id, s.q
  FROM (SELECT *, row_number() OVER (PARTITION BY tipodocto, numero, producto, q ORDER BY linea, id) AS rk FROM inv_tr WHERE is_out) s
  JOIN (SELECT *, row_number() OVER (PARTITION BY tipodocto, numero, producto, q ORDER BY linea, id) AS rk FROM inv_tr WHERE NOT is_out) e
    USING (tipodocto, numero, producto, q, rk);

  ANALYZE public.inv_transfer_links;
  WITH s AS (
    SELECT t.id, t.tipodocto, t.numero, t.producto, t.q,
      sum(t.q) OVER (PARTITION BY t.tipodocto, t.numero, t.producto ORDER BY t.linea, t.id) AS ce
    FROM inv_tr t WHERE t.is_out AND NOT EXISTS (SELECT 1 FROM public.inv_transfer_links l WHERE l.out_id = t.id)
  ), e AS (
    SELECT t.id, t.tipodocto, t.numero, t.producto, t.q,
      sum(t.q) OVER (PARTITION BY t.tipodocto, t.numero, t.producto ORDER BY t.linea, t.id) AS ce
    FROM inv_tr t WHERE NOT t.is_out AND NOT EXISTS (SELECT 1 FROM public.inv_transfer_links l WHERE l.in_id = t.id)
  )
  INSERT INTO public.inv_transfer_links (out_id, in_id, qty)
  SELECT s.id, e.id, least(s.ce, e.ce) - greatest(s.ce - s.q, e.ce - e.q)
  FROM s JOIN e USING (tipodocto, numero, producto)
  WHERE least(s.ce, e.ce) - greatest(s.ce - s.q, e.ce - e.q) > 0.000001;

  -- 4.2 Eventos del modelo por clave bodega + producto + lote. En un mismo día, ingresos antes que salidas.
  CREATE TEMP TABLE inv_ev ON COMMIT DROP AS
  SELECT m.id, m.bodega, m.producto, COALESCE(m.lote, '') AS lk, m.fecha, abs(m.cantidad) AS q, m.cantidad > 0 AS is_in,
    m.clase, m.peso_unit
  FROM public.inv_movements m
  WHERE m.active AND (v_from IS NULL OR m.fecha >= v_from);
  CREATE INDEX ON inv_ev (bodega, producto, lk);
  ANALYZE inv_ev;

  -- Peso unitario de referencia por producto (para capas sin peso propio)
  CREATE TEMP TABLE inv_pu ON COMMIT DROP AS
  SELECT producto, round(sum(peso_kg) / NULLIF(sum(abs(cantidad)), 0), 6) AS pu
  FROM public.inv_movements WHERE active AND peso_kg > 0 GROUP BY producto;
  CREATE UNIQUE INDEX ON inv_pu (producto);
  ANALYZE inv_pu;

  -- Saldo inicial por clave: la foto (si existe) y lo inferido que aún falte para que el saldo nunca sea negativo
  CREATE TEMP TABLE inv_open ON COMMIT DROP AS
  WITH run AS (
    SELECT bodega, producto, lk, is_in,
      sum(CASE WHEN is_in THEN q ELSE 0 END) OVER w AS cin,
      sum(CASE WHEN is_in THEN 0 ELSE q END) OVER w AS cout
    FROM inv_ev
    WINDOW w AS (PARTITION BY bodega, producto, lk ORDER BY fecha, is_in DESC, id ROWS UNBOUNDED PRECEDING)
  ), need AS (
    SELECT bodega, producto, lk, greatest(max(cout - cin) FILTER (WHERE NOT is_in), 0) AS deficit
    FROM run GROUP BY bodega, producto, lk
  ), snap AS (
    SELECT bodega, producto, COALESCE(lote, '') AS lk, sum(cantidad) AS q, sum(peso_kg) AS kg
    FROM public.inv_stock_snapshots WHERE upload_id = v_snap GROUP BY 1, 2, 3
  )
  SELECT COALESCE(n.bodega, s.bodega) AS bodega, COALESCE(n.producto, s.producto) AS producto, COALESCE(n.lk, s.lk) AS lk,
    COALESCE(s.q, 0) AS foto, greatest(COALESCE(n.deficit, 0) - COALESCE(s.q, 0), 0) AS inferida,
    CASE WHEN s.kg > 0 AND s.q > 0 THEN round(s.kg / s.q, 6) END AS foto_pu
  FROM need n FULL JOIN snap s ON s.bodega = n.bodega AND s.producto = n.producto AND s.lk = n.lk;
  CREATE INDEX ON inv_open (bodega, producto, lk);
  ANALYZE inv_open;

  -- 4.3 Capas: [foto][inferida][ingresos en orden]
  INSERT INTO public.inv_layers (bodega, producto, lk, lseq, source, fecha, qty, q_start, q_end, peso_unit, root_known)
  SELECT o.bodega, o.producto, o.lk, 1, 'FOTO', NULL, o.foto, 0, o.foto, COALESCE(o.foto_pu, pu.pu), 0
  FROM inv_open o LEFT JOIN inv_pu pu ON pu.producto = o.producto WHERE o.foto > 0;
  INSERT INTO public.inv_layers (bodega, producto, lk, lseq, source, fecha, qty, q_start, q_end, peso_unit, root_known)
  SELECT o.bodega, o.producto, o.lk, 2, 'INFERIDA', NULL, o.inferida, o.foto, o.foto + o.inferida, pu.pu, 0
  FROM inv_open o LEFT JOIN inv_pu pu ON pu.producto = o.producto WHERE o.inferida > 0;
  INSERT INTO public.inv_layers (bodega, producto, lk, lseq, source, mov_id, clase, fecha, qty, q_start, q_end, peso_unit,
    root_fecha, root_known, root_clase, root_bodega)
  SELECT e.bodega, e.producto, e.lk, 2 + e.rn, 'MOV', e.id, e.clase, e.fecha, e.q,
    COALESCE(o.foto + o.inferida, 0) + e.cin - e.q, COALESCE(o.foto + o.inferida, 0) + e.cin,
    COALESCE(e.peso_unit, pu.pu),
    CASE WHEN e.clase <> 'TRASPASO' THEN e.fecha END, CASE WHEN e.clase <> 'TRASPASO' THEN 1 ELSE 0 END,
    CASE WHEN e.clase <> 'TRASPASO' THEN e.clase END, CASE WHEN e.clase <> 'TRASPASO' THEN e.bodega END
  FROM (SELECT ev.*, row_number() OVER w AS rn, sum(q) OVER w AS cin FROM inv_ev ev WHERE is_in
        WINDOW w AS (PARTITION BY bodega, producto, lk ORDER BY fecha, id ROWS UNBOUNDED PRECEDING)) e
  LEFT JOIN inv_open o ON o.bodega = e.bodega AND o.producto = e.producto AND o.lk = e.lk
  LEFT JOIN inv_pu pu ON pu.producto = e.producto;

  ANALYZE public.inv_layers;

  -- 4.4 Consumos FIFO: cada salida ocupa [oe - q, oe) en la clave; se cruza con las capas que se solapan.
  CREATE TEMP TABLE inv_out ON COMMIT DROP AS
  SELECT ev.id, ev.bodega, ev.producto, ev.lk, ev.fecha, ev.q,
    sum(ev.q) OVER (PARTITION BY ev.bodega, ev.producto, ev.lk ORDER BY ev.fecha, ev.id ROWS UNBOUNDED PRECEDING) AS oe
  FROM inv_ev ev WHERE NOT ev.is_in;

  ANALYZE inv_out;
  INSERT INTO public.inv_allocations (layer_id, out_id, qty, kg, dias_bodega)
  SELECT l.id, o.id, x.q, CASE WHEN l.peso_unit IS NOT NULL THEN round(x.q * l.peso_unit, 6) END, o.fecha - l.fecha
  FROM inv_out o
  CROSS JOIN LATERAL (SELECT f.lseq FROM public.inv_layers f
                      WHERE f.bodega = o.bodega AND f.producto = o.producto AND f.lk = o.lk AND f.q_end > o.oe - o.q + 0.0000001
                      ORDER BY f.q_end LIMIT 1) a
  CROSS JOIN LATERAL (SELECT f.lseq FROM public.inv_layers f
                      WHERE f.bodega = o.bodega AND f.producto = o.producto AND f.lk = o.lk AND f.q_start < o.oe - 0.0000001
                      ORDER BY f.q_start DESC LIMIT 1) b
  -- Keep the bounded layer lookup dependent on both FIFO endpoints. OFFSET 0 prevents
  -- flattening this lookup into a warehouse/product/lot Cartesian join before filtering.
  CROSS JOIN LATERAL (
    SELECT f.id, f.q_start, f.q_end, f.peso_unit, f.fecha
    FROM public.inv_layers f
    WHERE f.bodega = o.bodega AND f.producto = o.producto AND f.lk = o.lk
      AND f.lseq BETWEEN a.lseq AND b.lseq
    ORDER BY f.lseq
    OFFSET 0
  ) l
  CROSS JOIN LATERAL (SELECT least(l.q_end, o.oe) - greatest(l.q_start, o.oe - o.q) AS q) x
  WHERE x.q > 0.0000001;

  ANALYZE public.inv_allocations;
  UPDATE public.inv_layers l SET consumed = a.q
  FROM (SELECT layer_id, sum(qty) AS q FROM public.inv_allocations GROUP BY layer_id) a WHERE a.layer_id = l.id;

  -- 4.5 Origen raíz de las capas que llegaron por traspaso: lo que consumió su salida emparejada en la bodega de
  --     origen. Se repite para los traspasos encadenados (p. ej. Depósito → Unimar → Flesa).
  ANALYZE public.inv_transfer_links;
  CREATE TEMP TABLE inv_comp ON COMMIT DROP AS
  SELECT tl.in_id, a.layer_id AS src_id, a.qty * tl.qty / NULLIF(s.q, 0) AS part
  FROM public.inv_transfer_links tl
  JOIN (SELECT out_id, sum(qty) AS q FROM public.inv_allocations GROUP BY out_id) s ON s.out_id = tl.out_id
  JOIN public.inv_allocations a ON a.out_id = tl.out_id;
  CREATE INDEX ON inv_comp (src_id);
  ANALYZE inv_comp;
  CREATE TEMP TABLE inv_root (in_id bigint PRIMARY KEY, known numeric, rf date, rc text, rb text) ON COMMIT DROP;
  LOOP
    v_iter := v_iter + 1;
    TRUNCATE inv_root;
    INSERT INTO inv_root (in_id, known, rf, rc, rb)
    SELECT c.in_id,
      round(COALESCE(sum(c.part * src.root_known) / NULLIF(sum(c.part), 0), 0), 6),
      (DATE '2000-01-01' + round(sum(c.part * src.root_known * (src.root_fecha - DATE '2000-01-01')) / NULLIF(sum(c.part * src.root_known), 0))::integer),
      COALESCE((array_agg(src.root_clase ORDER BY c.part * src.root_known DESC NULLS LAST))[1], 'TRASPASO'),
      (array_agg(COALESCE(src.root_bodega, src.bodega) ORDER BY c.part * src.root_known DESC NULLS LAST))[1]
    FROM inv_comp c JOIN public.inv_layers src ON src.id = c.src_id
    GROUP BY c.in_id;
    ANALYZE inv_root;
    UPDATE public.inv_layers l SET root_known = g.known, root_fecha = g.rf, root_clase = g.rc, root_bodega = g.rb
    FROM inv_root g
    WHERE l.mov_id = g.in_id AND l.source = 'MOV' AND l.clase = 'TRASPASO'
      AND (l.root_known IS DISTINCT FROM g.known OR l.root_fecha IS DISTINCT FROM g.rf
           OR l.root_clase IS DISTINCT FROM g.rc OR l.root_bodega IS DISTINCT FROM g.rb);
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    EXIT WHEN v_changed = 0 OR v_iter >= 12;
  END LOOP;

  SELECT jsonb_build_object(
    'movimientos', (SELECT count(*) FROM inv_ev),
    'capas', (SELECT count(*) FROM public.inv_layers),
    'consumos', (SELECT count(*) FROM public.inv_allocations),
    'traspasos_enlazados', (SELECT count(*) FROM public.inv_transfer_links),
    'traspasos_sin_destino', (SELECT count(*) FROM inv_tr t WHERE t.is_out AND NOT EXISTS (SELECT 1 FROM public.inv_transfer_links l WHERE l.out_id = t.id)),
    'traspasos_sin_origen', (SELECT count(*) FROM inv_tr t WHERE NOT t.is_out AND NOT EXISTS (SELECT 1 FROM public.inv_transfer_links l WHERE l.in_id = t.id)),
    'iteraciones_origen', v_iter,
    'segundos', round(extract(epoch FROM clock_timestamp() - v_t0)::numeric, 2)) INTO v_stats;

  UPDATE public.inv_state SET dirty = false, rebuilt_at = now(),
    data_min = (SELECT min(fecha) FROM public.inv_movements WHERE active),
    data_max = (SELECT max(fecha) FROM public.inv_movements WHERE active),
    model_from = v_from, snapshot_upload = v_snap, snapshot_cutoff = v_cut, stats = v_stats
  WHERE id = 1;
  RETURN jsonb_build_object('success', true) || v_stats;
END $$;

-- One-time reconciliation of the existing derived class; the raw ERP fields are unchanged.
UPDATE public.inv_movements m SET clase=d.clase FROM public.inv_doc_types d
WHERE m.tipodocto=d.tipodocto AND m.clase IS DISTINCT FROM d.clase;
COMMIT;
