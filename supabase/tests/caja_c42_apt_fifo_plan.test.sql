-- Rollback convention used by the production SQL harness.
DO $test$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('public.apt_rebuild()'::regprocedure) INTO definition;
  IF position('ANALYZE apt_e;' IN definition) > 0
     AND position('ANALYZE apt_s;' IN definition) > 0
     AND position('apt_s_rebuild_key_idx' IN definition) > 0 THEN
    RAISE EXCEPTION 'CAJA C42 PASS (1/1): estadisticas e indice del FIFO temporal instalados';
  END IF;
  RAISE EXCEPTION 'CAJA C42 FAIL: optimizacion del FIFO temporal no instalada';
END $test$;
