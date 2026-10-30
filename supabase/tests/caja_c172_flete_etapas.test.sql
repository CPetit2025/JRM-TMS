-- C172: flete con etapas (Etapa 3) — acordado y final por ruta y por OT, ajustes en el historial, instalados y protegidos.
BEGIN;
DO $$
BEGIN
 IF to_regclass('public.dispatch_freight_stages') IS NULL
  OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.dispatch_freight_stages'::regclass)
  OR to_regclass('public.dispatch_request_freight_stages') IS NULL
  OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.dispatch_request_freight_stages'::regclass) THEN
  RAISE EXCEPTION 'CAJA C172 FAIL: faltan las etapas del flete';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.dispatches'::regclass AND tgname='dispatch_freight_stage_insert' AND NOT tgisinternal)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.dispatches'::regclass AND tgname='dispatch_freight_stage_update' AND NOT tgisinternal)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.dispatch_request_freight'::regclass AND tgname='dispatch_request_freight_agreed' AND NOT tgisinternal)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.contract_services'::regclass AND tgname='contract_freight_amount_event' AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'CAJA C172 FAIL: faltan disparadores del flete acordado o de ajustes';
 END IF;
 IF position('''AJUSTE''' IN pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid='public.service_cost_events'::regclass AND conname='service_cost_events_stage_check')))=0 THEN
  RAISE EXCEPTION 'CAJA C172 FAIL: el historial no admite ajustes del flete';
 END IF;
 IF EXISTS(SELECT 1 FROM public.dispatch_request_freight f WHERE NOT EXISTS(SELECT 1 FROM public.dispatch_request_freight_stages s
   WHERE s.dispatch_id=f.dispatch_id AND s.request_id=f.request_id AND s.agreed_pen IS NOT NULL)) THEN
  RAISE EXCEPTION 'CAJA C172 FAIL: reparto por OT sin flete acordado';
 END IF;
 IF EXISTS(SELECT 1 FROM public.dispatch_freight_stages WHERE final_pen IS NOT NULL AND final_pen<>COALESCE(base_pen,0)+extras_pen) THEN
  RAISE EXCEPTION 'CAJA C172 FAIL: flete final distinto de base + adicionales';
 END IF;
 IF has_table_privilege('authenticated','public.dispatch_freight_stages','SELECT')
  OR has_table_privilege('authenticated','public.dispatch_freight_stages','UPDATE')
  OR has_table_privilege('authenticated','public.dispatch_request_freight_stages','SELECT')
  OR has_function_privilege('anon','public.register_dispatch_freight_final(uuid,jsonb)','EXECUTE')
  OR has_function_privilege('anon','public.dispatch_freight_summary(uuid)','EXECUTE')
  OR has_function_privilege('authenticated','public.dispatch_freight_stage_sync()','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C172 FAIL: acceso directo a las etapas del flete o a funciones internas';
 END IF;
 RAISE EXCEPTION 'CAJA C172 PASS: flete acordado, ajustes y final por ruta y por OT protegidos';
END $$;
ROLLBACK;
