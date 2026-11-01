-- C200: control presupuestal por OT, etapa 3 — sobre el tope solo con autorización vigente de Gerencia y nunca más allá
-- del 100 %; autorizaciones con historial solo de inserción y permisos acotados.
BEGIN;
DO $$
BEGIN
 IF position('budget_authorization_covers(NEW.contract_id,-NEW.balance_pen)' IN pg_get_functiondef('public.transport_budget_balance()'::regprocedure)) = 0
  OR position('budget_authorization_covers(v_root,-v_balance)' IN pg_get_functiondef('public.transport_family_refresh()'::regprocedure)) = 0 THEN
  RAISE EXCEPTION 'CAJA C200 FAIL: el saldo no consulta las autorizaciones';
 END IF;
 IF to_regclass('public.budget_authorizations') IS NULL OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.budget_authorizations'::regclass)
  OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.budget_authorization_events'::regclass AND tgname = 'budget_authorization_events_append_only' AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'CAJA C200 FAIL: autorizaciones sin RLS o historial';
 END IF;
 IF EXISTS (SELECT 1 FROM public.budget_authorizations a WHERE a.status = 'AUTORIZADA' AND NOT a.emergency AND a.decided_by IS NULL) THEN
  RAISE EXCEPTION 'CAJA C200 FAIL: autorización vigente sin decisión de Gerencia';
 END IF;
 IF EXISTS (SELECT 1 FROM public.contract_budgets b WHERE b.concept = 'PARTIDA_TRANSPORTE' AND b.allocated_pen > 0
            AND public.budget_authorized_over_cap(b.contract_id) > b.allocated_pen - public.transport_operating_limit(b.allocated_pen, b.contract_id) + 0.01) THEN
  RAISE EXCEPTION 'CAJA C200 FAIL: autorización por encima del 100 %% de la partida';
 END IF;
 IF has_table_privilege('authenticated','public.budget_authorizations','SELECT')
  OR has_function_privilege('authenticated','public.budget_authorization_covers(uuid,numeric)','EXECUTE')
  OR has_function_privilege('anon','public.budget_authorization_request(uuid,numeric,text,text,boolean)','EXECUTE')
  OR NOT has_function_privilege('authenticated','public.budget_authorization_action(uuid,text,text)','EXECUTE')
  OR NOT has_function_privilege('authenticated','public.budget_preview(jsonb)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C200 FAIL: permisos de las autorizaciones';
 END IF;
 RAISE EXCEPTION 'CAJA C200 PASS: sobre el tope solo con autorización de Gerencia, hasta el 100 %% y con historial';
END $$;
ROLLBACK;
