-- A production upload requests ONE complete model rebuild, with an independent server budget.
-- C115 covers isolated business scenarios; this test exercises the actual history, unchanged.
-- All derived writes roll back at the terminal PASS/FAIL exception.
BEGIN;
SET LOCAL statement_timeout='110s';
DO $test$
DECLARE result jsonb; expected bigint; started timestamptz := clock_timestamp(); elapsed numeric;
BEGIN
 result := public.inv_rebuild();
 IF NOT COALESCE((result->>'success')::boolean,false) THEN RAISE EXCEPTION 'CAJA C117 FAIL: rebuild %',result; END IF;
 SELECT count(*) INTO expected FROM public.inv_movements WHERE active
   AND fecha >= COALESCE((SELECT model_from FROM public.inv_state WHERE id=1),'-infinity'::date);
 IF (result->>'movimientos')::bigint IS DISTINCT FROM expected THEN
   RAISE EXCEPTION 'CAJA C117 FAIL: history coverage mismatch';
 END IF;
 IF EXISTS(SELECT 1 FROM public.inv_layers l LEFT JOIN
    (SELECT layer_id,sum(qty) q FROM public.inv_allocations GROUP BY layer_id) a ON a.layer_id=l.id
    WHERE l.consumed IS DISTINCT FROM COALESCE(a.q,0)) THEN
   RAISE EXCEPTION 'CAJA C117 FAIL: consumed layer balance differs from detailed FIFO';
 END IF;
 IF EXISTS(SELECT 1 FROM public.inv_movements m LEFT JOIN
    (SELECT out_id,sum(qty) q FROM public.inv_allocations GROUP BY out_id) a ON a.out_id=m.id
    WHERE m.active AND m.cantidad<0
      AND m.fecha >= COALESCE((SELECT model_from FROM public.inv_state WHERE id=1),'-infinity'::date)
      AND abs(m.cantidad) IS DISTINCT FROM COALESCE(a.q,0)) THEN
   RAISE EXCEPTION 'CAJA C117 FAIL: output quantity is not fully allocated';
 END IF;
 elapsed := round(extract(epoch FROM clock_timestamp()-started)::numeric,2);
 RAISE EXCEPTION 'CAJA C117 PASS: real history % movements, % seconds; one rebuild, exact layer balances and conserved output quantities',expected,elapsed;
END $test$;
ROLLBACK;
