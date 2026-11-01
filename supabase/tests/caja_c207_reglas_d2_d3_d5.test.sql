-- C207: decisiones D2, D3 y D5 instaladas — combustible de km adicionales directo a su OT, reverso de la tarifa propia
-- que sigue al flete final aprobado y pendiente de combustible de Caja en ruta de tercero.
BEGIN;
DO $$
BEGIN
 IF position('km_extra' IN pg_get_functiondef('public.budget_allocate(text,uuid,uuid,uuid,numeric,boolean,jsonb)'::regprocedure)) = 0 THEN
  RAISE EXCEPTION 'CAJA C207 FAIL: el combustible de los km adicionales se reparte por peso (D3)';
 END IF;
 IF position('dispatch_request_freight_stages st WHERE st.dispatch_id = p_dispatch_id' IN pg_get_functiondef('public.budget_route_close(uuid)'::regprocedure)) = 0
    OR (SELECT count(*) FROM pg_trigger WHERE tgname = 'budget_tariff_follow_final') < 2 THEN
  RAISE EXCEPTION 'CAJA C207 FAIL: el ajuste del flete final en ruta propia queda en el ejecutado (D5)';
 END IF;
 IF position('COMBUSTIBLE_EN_TARIFA' IN pg_get_functiondef('public.budget_pending()'::regprocedure)) = 0 THEN
  RAISE EXCEPTION 'CAJA C207 FAIL: combustible de Caja en ruta de tercero sin revisión (D2)';
 END IF;
 RAISE EXCEPTION 'CAJA C207 PASS: km adicionales directos, reverso de tarifa con el flete final y combustible en tarifa a revisar';
END $$;
ROLLBACK;
