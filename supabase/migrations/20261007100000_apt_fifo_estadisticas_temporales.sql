-- El FIFO se reconstruye sobre toda la historia, incluso al cargar pocos días.
-- Las tablas temporales no tienen autovacuum/estadísticas: el planificador estimaba
-- mal las búsquedas por lote/producto y el cruce de tramos acumulados.
-- Modificar únicamente el plan de acceso de la definición instalada, conservando
-- reglas, permisos y cualquier adaptación previa de producción.
BEGIN;
DO $migration$
DECLARE definition text; updated text;
BEGIN
  SELECT pg_get_functiondef('public.apt_rebuild()'::regprocedure) INTO definition;
  IF position('apt_s_rebuild_key_idx' IN definition) > 0 THEN RETURN; END IF;
  IF position('CREATE INDEX ON apt_e (lote, producto);' IN definition) = 0
     OR position('-- Superposición de tramos acumulados' IN definition) = 0 THEN
    RAISE EXCEPTION 'La definición instalada de apt_rebuild no coincide con los puntos de optimización; revisar antes de aplicar';
  END IF;
  updated := replace(definition, 'CREATE INDEX ON apt_e (lote, producto);',
    E'CREATE INDEX ON apt_e (lote, producto);\n  ANALYZE apt_e;');
  updated := replace(updated, '-- Superposición de tramos acumulados',
    E'CREATE INDEX apt_s_rebuild_key_idx ON apt_s (lote, producto);\n  ANALYZE apt_s;\n\n  -- Superposición de tramos acumulados');
  EXECUTE updated;
END $migration$;
COMMIT;
NOTIFY pgrst, 'reload schema';
