-- C187: flete pactado obligatorio con tercero (con o sin OT) — guarda diferida vigente y función interna no expuesta.
BEGIN;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.dispatches'::regclass AND tgname='dispatch_ot_freight_guard' AND tgdeferrable AND tginitdeferred)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.dispatch_requests'::regclass AND tgname='dispatch_request_ot_freight_guard' AND tgdeferrable) THEN
  RAISE EXCEPTION 'CAJA C187 FAIL: falta la guarda de flete obligatorio';
 END IF;
 IF position('flete pactado con el proveedor' IN pg_get_functiondef('public.dispatch_ot_freight_check(uuid)'::regprocedure)) = 0 THEN
  RAISE EXCEPTION 'CAJA C187 FAIL: la guarda no exige el flete pactado con tercero';
 END IF;
 IF has_function_privilege('authenticated','public.dispatch_ot_freight_check(uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C187 FAIL: función interna expuesta';
 END IF;
 RAISE EXCEPTION 'CAJA C187 PASS: una ruta con tercero no se programa sin flete pactado';
END $$;
ROLLBACK;
