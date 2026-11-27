-- CAJA C247 — Recálculo del inventario tras un reinicio: el cron usa 20 minutos solo con las tablas derivadas vacías
-- (UNLOGGED, se vacían al caer la base) y 5 minutos en lo normal. Solo lectura del catálogo: no recalcula ni borra nada.
DO $test$
DECLARE cmd text; fails text[] := '{}'; esperado text;
BEGIN
  SELECT command INTO cmd FROM cron.job WHERE jobname = 'inventario-recalculo';
  IF cmd IS NULL THEN fails := fails || 'T1 no existe el job inventario-recalculo'::text;
  ELSIF cmd !~ 'inv_recalculo_timeout\(\)' OR cmd !~ 'cron_recalculo_en_cola\(''inventario''\)' THEN fails := fails || ('T1 comando inesperado: ' || cmd); END IF;

  esperado := CASE WHEN EXISTS (SELECT 1 FROM public.inv_layers) THEN '5min' ELSE '20min' END;
  IF public.inv_recalculo_timeout() IS DISTINCT FROM esperado THEN fails := fails || ('T2 límite ' || public.inv_recalculo_timeout() || ', se esperaba ' || esperado); END IF;

  IF has_function_privilege('authenticated', 'public.inv_recalculo_timeout()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.inv_recalculo_timeout()', 'EXECUTE') THEN fails := fails || 'T3 privilegios'::text; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C247 FAIL: %', array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C247 PASS: inventario-recalculo con límite % (20min solo con tablas derivadas vacías)', esperado;
END $test$;
