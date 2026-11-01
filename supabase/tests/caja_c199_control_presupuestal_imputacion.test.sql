-- C199: control presupuestal por OT, etapa 2 — imputación de Caja y combustible instalada: el saldo solo bloquea nuevos
-- compromisos, imputaciones sin duplicados ni montos huérfanos, disparadores y permisos acotados.
BEGIN;
DO $$
DECLARE def text := pg_get_functiondef('public.transport_budget_balance()'::regprocedure);
BEGIN
 IF position('COALESCE(NEW.reserved_pen,0)>COALESCE(OLD.reserved_pen,0)' IN def) = 0 THEN
  RAISE EXCEPTION 'CAJA C199 FAIL: el saldo todavía bloquea gastos ejecutados';
 END IF;
 IF to_regclass('public.cost_allocations') IS NULL OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cost_allocations'::regclass)
  OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.dispatch_expenses'::regclass AND tgname = 'budget_expense_sync' AND NOT tgisinternal)
  OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.dispatches'::regclass AND tgname = 'budget_route_close' AND tginitdeferred) THEN
  RAISE EXCEPTION 'CAJA C199 FAIL: imputación de Caja o cierre de ruta no instalados';
 END IF;
 IF EXISTS (SELECT 1 FROM public.cost_allocations WHERE status = 'APLICADO' AND contract_id IS NOT NULL AND applied_to IS NULL
            AND public.contract_budget_owner(contract_id) IS NOT NULL) THEN
  RAISE EXCEPTION 'CAJA C199 FAIL: imputaciones aplicadas sin partida';
 END IF;
 IF EXISTS (SELECT 1 FROM public.cost_allocations a JOIN public.dispatch_expenses e ON e.id = a.expense_id
            WHERE a.status = 'APLICADO' AND e.status <> 'APROBADO') THEN
  RAISE EXCEPTION 'CAJA C199 FAIL: imputación de un gasto de Caja que ya no está aprobado';
 END IF;
 IF EXISTS (SELECT 1 FROM public.cost_allocations a WHERE a.kind = 'CAJA' AND a.status <> 'ANULADO' AND a.expense_id IS NOT NULL
            GROUP BY a.expense_id HAVING abs(sum(a.amount_pen) - (SELECT COALESCE(e.approved_amount, e.amount, 0) FROM public.dispatch_expenses e WHERE e.id = a.expense_id)) > 0.01) THEN
  RAISE EXCEPTION 'CAJA C199 FAIL: la suma imputada de un gasto no coincide con su monto aprobado';
 END IF;
 IF has_table_privilege('authenticated','public.cost_allocations','SELECT')
  OR has_function_privilege('authenticated','public.budget_allocation_apply(uuid)','EXECUTE')
  OR has_function_privilege('anon','public.budget_route_allocations(uuid)','EXECUTE')
  OR NOT has_function_privilege('authenticated','public.budget_route_allocations(uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C199 FAIL: permisos de la imputación';
 END IF;
 RAISE EXCEPTION 'CAJA C199 PASS: gastos de Caja y combustible imputados a la OT sin duplicados; ejecutar nunca se bloquea';
END $$;
ROLLBACK;
