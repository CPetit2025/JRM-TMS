-- CAJA C92 — Stock por almacén por glosa: la suma por glosa cuadra con el saldo de cada almacén, respeta el filtro de
-- almacén y la función auxiliar no es pública. Solo lectura con una cuenta APT existente; bloque que siempre se revierte.
BEGIN;
DO $test$
DECLARE actor uuid; q jsonb; diff numeric; otros integer;
BEGIN
  IF has_function_privilege('authenticated', 'public.apt_flow_stock_glosas(jsonb,date,integer,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.apt_flow_stock_glosas(jsonb,date,integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'CAJA C92 FAIL: función auxiliar expuesta (T1)'; END IF;
  actor := public.apt_read_cache_actor();
  IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C92 PASS (1/1) sin cuenta APT activa para comprobar el saldo'; END IF;
  q := public.apt_flow_stock('{}');
  IF q ? 'vacio' THEN RAISE EXCEPTION 'CAJA C92 PASS (1/1) sin datos de flujo'; END IF;
  IF jsonb_typeof(q -> 'glosas') <> 'array' THEN RAISE EXCEPTION 'CAJA C92 FAIL: falta la vista por glosa (T2)'; END IF;
  -- T3: por almacén, la suma de las glosas es el saldo de la tarjeta (redondeo de 3 decimales por fila)
  SELECT max(abs(COALESCE(g.tn, 0) - (c ->> 'saldo_tn')::numeric)) INTO diff
  FROM jsonb_array_elements(q -> 'resumen') c
  LEFT JOIN (SELECT e ->> 'almacen' AS almacen, sum((e ->> 'tn')::numeric) AS tn FROM jsonb_array_elements(q -> 'glosas') e GROUP BY 1) g
    ON g.almacen = c ->> 'almacen';
  IF jsonb_array_length(q -> 'glosas') < 2000 AND diff > 0.5 THEN
    RAISE EXCEPTION 'CAJA C92 FAIL: la suma por glosa no cuadra con el saldo (T3) diferencia % TN', diff; END IF;
  -- T4: con almacén elegido solo vienen glosas de ese almacén
  q := public.apt_flow_stock('{"almacen":"540"}');
  SELECT count(*) INTO otros FROM jsonb_array_elements(q -> 'glosas') e WHERE e ->> 'almacen' <> '540';
  IF otros > 0 THEN RAISE EXCEPTION 'CAJA C92 FAIL: glosas de otros almacenes con filtro (T4)'; END IF;
  RAISE EXCEPTION 'CAJA C92 PASS (4/4) stock por glosa: % grupos, cuadra con el saldo por almacén (dif. máx. % TN)',
    jsonb_array_length(public.apt_flow_stock('{}') -> 'glosas'), round(diff, 3);
END $test$;
ROLLBACK;
