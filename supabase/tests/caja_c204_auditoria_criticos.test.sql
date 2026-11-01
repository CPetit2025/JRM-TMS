-- C204: un gasto no puede ir a un viaje y a un anticipo a la vez, y la solicitud de anticipo desde la app se atiende una
-- a la vez por conductor. Informa cuántos gastos antiguos tienen ambos destinos (sin modificar datos).
BEGIN;
DO $$
DECLARE v_both int;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_expenses_single_target') THEN
  RAISE EXCEPTION 'CAJA C204 FAIL: un gasto puede ir a un viaje y a un anticipo (pago doble)';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'request_advance_from_app' AND p.pronamespace = 'public'::regnamespace
            AND position('trip_advance_request:' IN pg_get_functiondef(p.oid)) = 0) THEN
  RAISE EXCEPTION 'CAJA C204 FAIL: un doble toque puede crear dos solicitudes de anticipo';
 END IF;
 SELECT count(*) INTO v_both FROM public.dispatch_expenses WHERE dispatch_id IS NOT NULL AND advance_id IS NOT NULL;
 RAISE EXCEPTION 'CAJA C204 PASS: gasto con un solo destino y solicitud de anticipo serializada (% gastos antiguos con ambos destinos)', v_both;
END $$;
ROLLBACK;
