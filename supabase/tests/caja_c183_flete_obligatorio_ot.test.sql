-- C183: flete obligatorio para servicios de OT (propio o tercero) — guarda diferida instalada y no expuesta.
BEGIN;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.dispatches'::regclass AND tgname='dispatch_ot_freight_guard' AND tgdeferrable AND tginitdeferred)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.dispatch_requests'::regclass AND tgname='dispatch_request_ot_freight_guard' AND tgdeferrable)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.dispatch_request_freight'::regclass AND tgname='dispatch_request_freight_ot_guard' AND tgdeferrable) THEN
  RAISE EXCEPTION 'CAJA C183 FAIL: falta la guarda de flete obligatorio';
 END IF;
 IF has_function_privilege('authenticated','public.dispatch_ot_freight_check(uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C183 FAIL: función interna expuesta';
 END IF;
 RAISE EXCEPTION 'CAJA C183 PASS: un servicio de OT no se programa sin flete (propio o tercero)';
END $$;
ROLLBACK;
