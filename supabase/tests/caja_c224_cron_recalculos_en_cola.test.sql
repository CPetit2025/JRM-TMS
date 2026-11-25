BEGIN;
DO $$
DECLARE v jsonb;
BEGIN
 IF (SELECT count(*) FROM cron.job WHERE active AND command LIKE '%cron_recalculo_en_cola%'
     AND jobname IN ('inventario-recalculo','apt-modelo-estadia','apt-modelo-flujo','apt-cache-lecturas')) <> 4 THEN
  RAISE EXCEPTION 'CAJA C224 FAIL: los 4 recálculos pesados no pasan por la cola única'; END IF;
 IF has_function_privilege('authenticated','public.cron_recalculo_en_cola(text)','EXECUTE')
 OR has_function_privilege('anon','public.cron_recalculo_en_cola(text)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C224 FAIL: la cola de recálculos es invocable desde la web'; END IF;
 -- El turno usa un solo lock compartido (el choque real necesita dos sesiones; aquí se verifica el código)
 IF pg_get_functiondef('public.cron_recalculo_en_cola(text)'::regprocedure) !~ 'pg_try_advisory_xact_lock\(hashtext\(''cron_recalculo_pesado''\)\)' THEN
  RAISE EXCEPTION 'CAJA C224 FAIL: la cola no usa el turno compartido'; END IF;
 BEGIN v := public.cron_recalculo_en_cola('otro'); RAISE EXCEPTION 'CAJA C224 FAIL: aceptó un recálculo inválido';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'CAJA%' THEN RAISE; END IF; END;
 RAISE EXCEPTION 'CAJA C224 PASS: recálculos pesados en cola única';
END $$;
ROLLBACK;
