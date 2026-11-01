-- C203: circuito económico instalado — movimientos por OT, conciliación y pendientes; el flete por OT se actualiza al
-- editar el servicio. Recorre todas las partidas (sin modificar datos) e informa cuántas OT tienen diferencia histórica.
BEGIN;
DO $$
DECLARE v_diff int; v_rows int;
BEGIN
 IF to_regprocedure('public.budget_movements(uuid,date,date,text,text,integer,integer)') IS NULL OR to_regprocedure('public.budget_pending()') IS NULL
    OR to_regprocedure('public.budget_movement_rows(uuid[])') IS NULL THEN
  RAISE EXCEPTION 'CAJA C203 FAIL: consultas del circuito económico no instaladas';
 END IF;
 IF position('UPDATE public.dispatch_request_freight SET amount_pen' IN pg_get_functiondef('public.update_contract_service_amount(uuid,numeric)'::regprocedure)) = 0 THEN
  RAISE EXCEPTION 'CAJA C203 FAIL: editar el flete no actualiza el renglón por OT';
 END IF;
 SELECT count(*) INTO v_rows FROM public.budget_movement_rows(ARRAY(SELECT contract_id FROM public.contract_budgets WHERE concept = 'PARTIDA_TRANSPORTE'));
 SELECT count(*) INTO v_diff FROM (
  SELECT b.contract_id FROM public.contract_budgets b
  LEFT JOIN (SELECT budget_contract_id, sum(reserved_pen) r, sum(consumed_pen) c
             FROM public.budget_movement_rows(ARRAY(SELECT contract_id FROM public.contract_budgets WHERE concept = 'PARTIDA_TRANSPORTE')) GROUP BY 1) m
    ON m.budget_contract_id = b.contract_id
  WHERE b.concept = 'PARTIDA_TRANSPORTE'
    AND (abs(b.reserved_pen - COALESCE(m.r, 0)) >= 0.01 OR abs(b.consumed_pen - COALESCE(m.c, 0)) >= 0.01)) x;
 RAISE EXCEPTION 'CAJA C203 PASS: circuito económico instalado (% movimientos; % partidas con diferencia histórica a revisar)', v_rows, v_diff;
END $$;
ROLLBACK;
