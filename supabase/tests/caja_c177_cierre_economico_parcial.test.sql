-- C177: cierre económico parcial por ítem (C) — estado por servicio y por flete, bloqueo de ítems aprobados, monto de Caja
-- aparte, rutas cerradas con todos sus ítems aprobados y parciales con al menos uno; funciones internas sin acceso directo.
BEGIN;
DO $$
BEGIN
 IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='transport_unloading_costs'
     AND column_name IN ('econ_status','econ_observation','econ_approved_by','econ_approved_at','caja_pen'))<>5
  OR (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='dispatch_freight_stages' AND column_name LIKE 'econ_%')<>4
  OR (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='dispatch_request_freight_stages' AND column_name LIKE 'econ_%')<>4 THEN
  RAISE EXCEPTION 'CAJA C177 FAIL: faltan columnas del estado por ítem';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.transport_unloading_costs'::regclass AND tgname='transport_unloading_costs_economic_guard' AND NOT tgisinternal)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.dispatch_freight_stages'::regclass AND tgname='dispatch_freight_final_lock' AND NOT tgisinternal)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.dispatch_request_freight_stages'::regclass AND tgname='dispatch_request_freight_final_lock' AND NOT tgisinternal)
  OR pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname='economic_closures_status_check')) NOT LIKE '%CIERRE_PARCIAL%' THEN
  RAISE EXCEPTION 'CAJA C177 FAIL: bloqueo por ítem o estado CIERRE_PARCIAL no instalado';
 END IF;
 IF EXISTS(SELECT 1 FROM public.transport_unloading_costs WHERE econ_status IN ('APROBADO','EN_REVISION') AND final_pen IS NULL)
  OR EXISTS(SELECT 1 FROM public.dispatch_freight_stages WHERE econ_status IN ('APROBADO','EN_REVISION') AND final_pen IS NULL)
  OR EXISTS(SELECT 1 FROM public.dispatch_request_freight_stages WHERE econ_status IN ('APROBADO','EN_REVISION') AND final_pen IS NULL) THEN
  RAISE EXCEPTION 'CAJA C177 FAIL: ítem enviado o aprobado sin costo final';
 END IF;
 IF EXISTS(SELECT 1 FROM public.economic_closures c WHERE c.status='CERRADO' AND EXISTS(
   SELECT 1 FROM jsonb_array_elements(public.economic_route_items(c.dispatch_id)) i WHERE i.value->>'status'<>'APROBADO')) THEN
  RAISE EXCEPTION 'CAJA C177 FAIL: ruta cerrada con ítems sin aprobar';
 END IF;
 IF EXISTS(SELECT 1 FROM public.economic_closures c WHERE c.status='CIERRE_PARCIAL' AND NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(public.economic_route_items(c.dispatch_id)) i WHERE i.value->>'status'='APROBADO')) THEN
  RAISE EXCEPTION 'CAJA C177 FAIL: cierre parcial sin ítems aprobados';
 END IF;
 IF EXISTS(SELECT 1 FROM public.transport_unloading_costs WHERE econ_status='APROBADO' AND contract_id IS NOT NULL AND status='CONSUMIDO' AND actual_pen IS DISTINCT FROM final_pen) THEN
  RAISE EXCEPTION 'CAJA C177 FAIL: servicio aprobado sin imputar su costo final';
 END IF;
 IF EXISTS(SELECT 1 FROM public.transport_unloading_costs WHERE expense_id IS NOT NULL AND caja_pen IS NULL) THEN
  RAISE EXCEPTION 'CAJA C177 FAIL: gasto de Caja sin monto propio';
 END IF;
 IF has_function_privilege('authenticated','public.economic_apply_item(uuid,text)','EXECUTE')
  OR has_function_privilege('authenticated','public.economic_item_set(uuid,text,text,text)','EXECUTE')
  OR has_function_privilege('authenticated','public.economic_route_sync(uuid,text,text)','EXECUTE')
  OR has_function_privilege('authenticated','public.economic_apply_budget(uuid)','EXECUTE')
  OR has_function_privilege('anon','public.economic_item_action(uuid,text,text,text)','EXECUTE')
  OR NOT has_function_privilege('authenticated','public.economic_item_action(uuid,text,text,text)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C177 FAIL: permisos del cierre por ítem';
 END IF;
 RAISE EXCEPTION 'CAJA C177 PASS: cierre parcial por ítem, bloqueo de aprobados, monto de Caja y estados de ruta consistentes';
END $$;
ROLLBACK;
