-- C205: revisión y registro de gastos esperan a una liquidación en curso (sin gastos huérfanos), un gasto de anticipo
-- liquidado no se revisa, la etiqueta de vencidos no se ejecuta directo y las autorizaciones de anulación tienen cuota.
BEGIN;
DO $$
BEGIN
 IF position('El anticipo ya fue liquidado: reabra' IN pg_get_functiondef('public.review_dispatch_expense(uuid,text,text,numeric,boolean)'::regprocedure)) = 0 THEN
  RAISE EXCEPTION 'CAJA C205 FAIL: se revisan gastos de un anticipo liquidado';
 END IF;
 IF position('NEW.advance_id FOR SHARE' IN pg_get_functiondef('public.caja_expense_normalize()'::regprocedure)) = 0 THEN
  RAISE EXCEPTION 'CAJA C205 FAIL: un gasto puede quedar pendiente en una liquidación cerrada';
 END IF;
 IF has_function_privilege('authenticated', 'public.caja_driver_overdue_label(uuid,uuid)', 'EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C205 FAIL: cualquier usuario consulta los vencidos de otro conductor';
 END IF;
 IF position('''authorizer''' IN pg_get_functiondef('public.reserve_registration_attempt(text,text)'::regprocedure)) = 0 THEN
  RAISE EXCEPTION 'CAJA C205 FAIL: la autorización de anulación no tiene límite de intentos';
 END IF;
 RAISE EXCEPTION 'CAJA C205 PASS: liquidaciones sin gastos huérfanos, anticipo liquidado cerrado, vencidos protegidos y cuota de autorizaciones';
END $$;
ROLLBACK;
