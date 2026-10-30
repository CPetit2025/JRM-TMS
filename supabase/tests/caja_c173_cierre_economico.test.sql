-- C173: cierre económico (Etapa 4) — costo final validado por servicio, estados por ruta, historial solo de inserción e
-- impacto en la partida solo por diferencia, instalados y protegidos.
BEGIN;
DO $$
BEGIN
 IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='transport_unloading_costs'
     AND column_name IN ('final_executed_qty','final_workers','final_billable_qty','final_extras_pen','final_pen','final_reason','final_validated_by','final_validated_at'))<>8
  OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='dispatch_freight_stages' AND column_name='final_applied_pen')
  OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='dispatch_request_freight_stages' AND column_name='final_applied_pen') THEN
  RAISE EXCEPTION 'CAJA C173 FAIL: faltan columnas del costo final';
 END IF;
 IF to_regclass('public.economic_closures') IS NULL OR to_regclass('public.economic_closure_events') IS NULL
  OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.economic_closures'::regclass)
  OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.economic_closure_events'::regclass)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.economic_closure_events'::regclass AND tgname='economic_closure_events_append_only' AND NOT tgisinternal)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.dispatch_freight_stages'::regclass AND tgname='dispatch_freight_final_lock' AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'CAJA C173 FAIL: estados del cierre económico sin RLS, historial o bloqueo';
 END IF;
 IF public.economic_billable_qty('HORA',2.25,30,3)<>3 OR public.economic_billable_qty('HORA',3.2,30,null)<>3.5
  OR public.economic_billable_qty('HORA',1.1,null,null)<>2 OR public.economic_billable_qty('HORA',0,30,3)<>0 THEN
  RAISE EXCEPTION 'CAJA C173 FAIL: reglas de fracción y mínimo facturable';
 END IF;
 IF EXISTS(SELECT 1 FROM public.economic_closures c WHERE c.status='CERRADO' AND EXISTS(
   SELECT 1 FROM public.transport_unloading_costs u WHERE u.dispatch_id=c.dispatch_id AND u.status IN ('PLANIFICADO','CONSUMIDO') AND u.final_validated_at IS NULL)) THEN
  RAISE EXCEPTION 'CAJA C173 FAIL: ruta con cierre económico y costos sin validar';
 END IF;
 IF has_table_privilege('authenticated','public.economic_closures','SELECT') OR has_table_privilege('authenticated','public.economic_closure_events','INSERT')
  OR has_function_privilege('authenticated','public.economic_apply_budget(uuid)','EXECUTE')
  OR has_function_privilege('authenticated','public.economic_route_state(uuid)','EXECUTE')
  OR has_function_privilege('anon','public.economic_closure_action(uuid,text,text)','EXECUTE')
  OR has_function_privilege('anon','public.validate_service_final(uuid,jsonb)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C173 FAIL: acceso directo al cierre económico o a funciones internas';
 END IF;
 RAISE EXCEPTION 'CAJA C173 PASS: costo final por servicio, estados, historial e impacto en la partida protegidos';
END $$;
ROLLBACK;
