-- ============================================================
-- Inventario: recálculo más rápido (mismos resultados)
-- ============================================================
-- Con Entradas y Salidas de un año (≈200 mil movimientos y 30 mil traspasos) el recálculo superaba el tiempo de la
-- petición web y de la prueba C117. Dos cambios sin alterar las cifras:
-- 1) Lo consumido de cada capa se calcula al crearla (solape de la capa con el tramo [0, salida total) de su clave),
--    en vez de actualizar todas las capas después; es igual a la suma de sus consumos detallados (C117 lo verifica).
-- 2) El origen raíz de los traspasos encadenados solo se recalcula, desde la segunda vuelta, para los traspasos cuyas
--    capas de origen cambiaron en la vuelta anterior (antes se recalculaban los 30 mil en cada vuelta).
-- 3) Capas, consumos y enlaces de traspaso son tablas derivadas que el recálculo vacía y rehace completas: sus llaves
--    foráneas solo agregaban una verificación por fila al insertar (≈ 20 % del tiempo) y un borrado en cascada lento al
--    reemplazar movimientos. Se quitan; entre una carga y su recálculo el modelo ya figura como pendiente.
-- 4) Empates al elegir la clase y bodega de origen (p. ej. orígenes todos desconocidos) se resuelven de forma estable.
BEGIN;
SET LOCAL lock_timeout = '60s';

ALTER TABLE public.inv_allocations DROP CONSTRAINT IF EXISTS inv_allocations_layer_id_fkey,
  DROP CONSTRAINT IF EXISTS inv_allocations_out_id_fkey;
ALTER TABLE public.inv_layers DROP CONSTRAINT IF EXISTS inv_layers_mov_id_fkey;
ALTER TABLE public.inv_transfer_links DROP CONSTRAINT IF EXISTS inv_transfer_links_out_id_fkey,
  DROP CONSTRAINT IF EXISTS inv_transfer_links_in_id_fkey;

CREATE OR REPLACE FUNCTION public.inv_rebuild()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET jit = off AS $$
DECLARE v_snap uuid; v_cut date; v_from date; v_iter integer := 0; v_changed integer; v_t0 timestamptz := clock_timestamp();
  v_stats jsonb; v_tmp text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('inv_rebuild'));
  -- Tablas de trabajo (pueden quedar de un recálculo anterior en la misma transacción)
  FOREACH v_tmp IN ARRAY ARRAY['inv_tr', 'inv_ev', 'inv_pu', 'inv_open', 'inv_otot', 'inv_out', 'inv_comp', 'inv_root', 'inv_chg'] LOOP
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

  -- Salida total por clave: el FIFO consume [0, total) de la clave, así que lo consumido de cada capa es su solape con
  -- ese tramo (igual a la suma de sus consumos detallados) y se guarda al crear la capa, sin una actualización posterior.
  CREATE TEMP TABLE inv_otot ON COMMIT DROP AS
  SELECT bodega, producto, lk, sum(q) AS tot FROM inv_ev WHERE NOT is_in GROUP BY 1, 2, 3;
  CREATE UNIQUE INDEX ON inv_otot (bodega, producto, lk);
  ANALYZE inv_otot;

  -- 4.3 Capas: [foto][inferida][ingresos en orden]
  INSERT INTO public.inv_layers (bodega, producto, lk, lseq, source, fecha, qty, q_start, q_end, peso_unit, root_known, consumed)
  SELECT o.bodega, o.producto, o.lk, 1, 'FOTO', NULL, o.foto, 0, o.foto, COALESCE(o.foto_pu, pu.pu), 0,
    greatest(least(o.foto, COALESCE(t.tot, 0)), 0)
  FROM inv_open o LEFT JOIN inv_pu pu ON pu.producto = o.producto
  LEFT JOIN inv_otot t ON t.bodega = o.bodega AND t.producto = o.producto AND t.lk = o.lk WHERE o.foto > 0;
  INSERT INTO public.inv_layers (bodega, producto, lk, lseq, source, fecha, qty, q_start, q_end, peso_unit, root_known, consumed)
  SELECT o.bodega, o.producto, o.lk, 2, 'INFERIDA', NULL, o.inferida, o.foto, o.foto + o.inferida, pu.pu, 0,
    greatest(least(o.foto + o.inferida, COALESCE(t.tot, 0)) - o.foto, 0)
  FROM inv_open o LEFT JOIN inv_pu pu ON pu.producto = o.producto
  LEFT JOIN inv_otot t ON t.bodega = o.bodega AND t.producto = o.producto AND t.lk = o.lk WHERE o.inferida > 0;
  INSERT INTO public.inv_layers (bodega, producto, lk, lseq, source, mov_id, clase, fecha, qty, q_start, q_end, peso_unit,
    root_fecha, root_known, root_clase, root_bodega, consumed)
  SELECT e.bodega, e.producto, e.lk, 2 + e.rn, 'MOV', e.id, e.clase, e.fecha, e.q,
    COALESCE(o.foto + o.inferida, 0) + e.cin - e.q, COALESCE(o.foto + o.inferida, 0) + e.cin,
    COALESCE(e.peso_unit, pu.pu),
    CASE WHEN e.clase <> 'TRASPASO' THEN e.fecha END, CASE WHEN e.clase <> 'TRASPASO' THEN 1 ELSE 0 END,
    CASE WHEN e.clase <> 'TRASPASO' THEN e.clase END, CASE WHEN e.clase <> 'TRASPASO' THEN e.bodega END,
    greatest(least(COALESCE(o.foto + o.inferida, 0) + e.cin, COALESCE(t.tot, 0)) - (COALESCE(o.foto + o.inferida, 0) + e.cin - e.q), 0)
  FROM (SELECT ev.*, row_number() OVER w AS rn, sum(q) OVER w AS cin FROM inv_ev ev WHERE is_in
        WINDOW w AS (PARTITION BY bodega, producto, lk ORDER BY fecha, id ROWS UNBOUNDED PRECEDING)) e
  LEFT JOIN inv_open o ON o.bodega = e.bodega AND o.producto = e.producto AND o.lk = e.lk
  LEFT JOIN inv_otot t ON t.bodega = e.bodega AND t.producto = e.producto AND t.lk = e.lk
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
  -- Capas que cambiaron en la vuelta anterior: solo se recalculan los traspasos que dependen de ellas
  CREATE TEMP TABLE inv_chg (id bigint PRIMARY KEY) ON COMMIT DROP;
  LOOP
    v_iter := v_iter + 1;
    TRUNCATE inv_root;
    INSERT INTO inv_root (in_id, known, rf, rc, rb)
    SELECT c.in_id,
      round(COALESCE(sum(c.part * src.root_known) / NULLIF(sum(c.part), 0), 0), 6),
      (DATE '2000-01-01' + round(sum(c.part * src.root_known * (src.root_fecha - DATE '2000-01-01')) / NULLIF(sum(c.part * src.root_known), 0))::integer),
      COALESCE((array_agg(src.root_clase ORDER BY c.part * src.root_known DESC NULLS LAST, c.part DESC, src.id))[1], 'TRASPASO'),
      (array_agg(COALESCE(src.root_bodega, src.bodega) ORDER BY c.part * src.root_known DESC NULLS LAST, c.part DESC, src.id))[1]
    FROM inv_comp c JOIN public.inv_layers src ON src.id = c.src_id
    WHERE v_iter = 1 OR c.in_id IN (SELECT d.in_id FROM inv_comp d JOIN inv_chg ch ON ch.id = d.src_id)
    GROUP BY c.in_id;
    ANALYZE inv_root;
    TRUNCATE inv_chg;
    WITH u AS (
      UPDATE public.inv_layers l SET root_known = g.known, root_fecha = g.rf, root_clase = g.rc, root_bodega = g.rb
      FROM inv_root g
      WHERE l.mov_id = g.in_id AND l.source = 'MOV' AND l.clase = 'TRASPASO'
        AND (l.root_known IS DISTINCT FROM g.known OR l.root_fecha IS DISTINCT FROM g.rf
             OR l.root_clase IS DISTINCT FROM g.rc OR l.root_bodega IS DISTINCT FROM g.rb)
      RETURNING l.id)
    INSERT INTO inv_chg SELECT id FROM u;
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    ANALYZE inv_chg;
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
REVOKE ALL ON FUNCTION public.inv_rebuild() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_rebuild() TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
