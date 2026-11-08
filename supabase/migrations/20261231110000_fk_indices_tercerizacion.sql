-- C55: toda FK de public necesita un índice completo (no parcial) que empiece por sus columnas.
-- Las tablas de tercerización (#490) dejaron FK sin índice o con índice parcial (dispatch_id).
-- Genérico porque producción no coincide con el historial del repo: indexa solo lo que falte.
DO $$
DECLARE r record; v_name text;
BEGIN
 FOR r IN
  SELECT c.conrelid::regclass AS tbl, c.conrelid, c.conkey,
         string_agg(quote_ident(a.attname), ',' ORDER BY k.ord) AS cols,
         string_agg(a.attname, '_' ORDER BY k.ord) AS colnames
  FROM pg_constraint c
  JOIN pg_namespace n ON n.oid = c.connamespace
  CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
  WHERE n.nspname = 'public' AND c.contype = 'f'
    AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indisvalid AND i.indpred IS NULL
                    AND (i.indkey::smallint[])[0:cardinality(c.conkey)-1] @> c.conkey)
  GROUP BY c.oid, c.conrelid, c.conkey
 LOOP
  -- hash: nombres únicos aunque el de la tabla sea largo y se trunque.
  v_name := left((SELECT relname FROM pg_class WHERE oid = r.conrelid) || '_' || r.colnames, 45) || '_' || left(md5(r.tbl::text || r.cols), 8) || '_fk_idx';
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %s (%s)', v_name, r.tbl, r.cols);
 END LOOP;
END $$;
