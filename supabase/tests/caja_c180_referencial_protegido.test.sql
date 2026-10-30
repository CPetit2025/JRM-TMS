-- C180: referencial protegido (Etapa E) — el flete referencial original se conserva aparte y los reportes lo leen.
BEGIN;
DO $$
BEGIN
 IF to_regclass('public.transport_request_referentials') IS NULL
  OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.transport_request_referentials'::regclass)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.transport_requests'::regclass AND tgname='transport_request_referential_capture' AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'CAJA C180 FAIL: falta el resguardo del referencial';
 END IF;
 -- Todo recojo cotizado al tercero tiene su referencial original
 IF EXISTS(SELECT 1 FROM public.transport_request_events e WHERE e.next_state->>'source'='COTIZACION_TERCERO'
   AND (e.previous_state->>'service_cost') ~ '^[0-9]+([.][0-9]+)?$'
   AND NOT EXISTS(SELECT 1 FROM public.transport_request_referentials r WHERE r.request_id=e.request_id)) THEN
  RAISE EXCEPTION 'CAJA C180 FAIL: recojo cotizado sin referencial original';
 END IF;
 IF position('request_referential_freight' IN pg_get_functiondef('public.dispatch_freight_summary(uuid)'::regprocedure))=0
  OR position('request_referential_freight' IN pg_get_functiondef('public.service_cost_indicators(date,date)'::regprocedure))=0 THEN
  RAISE EXCEPTION 'CAJA C180 FAIL: los reportes no leen el referencial protegido';
 END IF;
 IF has_table_privilege('authenticated','public.transport_request_referentials','SELECT')
  OR has_function_privilege('anon','public.request_referential_freight(uuid)','EXECUTE')
  OR has_function_privilege('authenticated','public.transport_request_referential_capture()','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C180 FAIL: acceso directo al referencial o a funciones internas';
 END IF;
 RAISE EXCEPTION 'CAJA C180 PASS: referencial original protegido y usado por los reportes';
END $$;
ROLLBACK;
