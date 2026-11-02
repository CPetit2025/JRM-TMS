-- Control presupuestal 360: agregados de cartera y ahorro, con permisos privados.
DO $$
DECLARE f regprocedure := to_regprocedure('public.budget_portfolio_period(date,date)'); s regprocedure := to_regprocedure('public.consolidation_savings_classified(date,date,uuid,uuid)'); d record;
BEGIN
 IF f IS NULL THEN RAISE EXCEPTION 'CAJA C214 FAIL: falta el agregado del ejecutado por período'; END IF;
 IF s IS NULL THEN RAISE EXCEPTION 'CAJA C214 FAIL: falta la clasificación auditable de ahorro'; END IF;
 IF has_function_privilege('anon', f, 'EXECUTE') OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C214 FAIL: permisos del agregado por período';
 END IF;
 IF has_function_privilege('anon', s, 'EXECUTE') OR NOT has_function_privilege('authenticated', s, 'EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C214 FAIL: permisos de clasificación de ahorro';
 END IF;
 SELECT prosecdef, proconfig INTO d FROM pg_proc WHERE oid = f;
 IF NOT d.prosecdef OR NOT EXISTS (SELECT 1 FROM unnest(d.proconfig) x WHERE x LIKE 'search_path=public, pg_temp%') THEN
  RAISE EXCEPTION 'CAJA C214 FAIL: el RPC requiere SECURITY DEFINER y search_path fijo';
 END IF;
 SELECT prosecdef, proconfig INTO d FROM pg_proc WHERE oid = s;
 IF NOT d.prosecdef OR NOT EXISTS (SELECT 1 FROM unnest(d.proconfig) x WHERE x LIKE 'search_path=public, pg_temp%') THEN
  RAISE EXCEPTION 'CAJA C214 FAIL: el clasificador requiere SECURITY DEFINER y search_path fijo';
 END IF;
 RAISE EXCEPTION 'CAJA C214 PASS: agregados de cartera protegidos, con permisos acotados y sin libro paralelo';
END $$;
