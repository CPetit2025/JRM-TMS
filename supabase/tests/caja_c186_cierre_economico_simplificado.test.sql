-- C186: cierre económico simplificado (Conforme, aprobación dentro del umbral, sin esperar Torre) instalado y protegido.
BEGIN;
DO $$
BEGIN
 IF to_regprocedure('public.economic_confirm(uuid,boolean)') IS NULL OR to_regprocedure('public.economic_settle(uuid)') IS NULL
  OR to_regprocedure('public.economic_deviation(numeric,numeric)') IS NULL THEN
  RAISE EXCEPTION 'CAJA C186 FAIL: faltan las funciones del cierre simplificado';
 END IF;
 IF has_function_privilege('anon','public.economic_confirm(uuid,boolean)','EXECUTE')
  OR has_function_privilege('authenticated','public.economic_settle(uuid)','EXECUTE')
  OR has_function_privilege('authenticated','public.economic_deviation(numeric,numeric)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C186 FAIL: función interna expuesta';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.dispatches'::regclass AND tgname = 'dispatch_economic_auto_close'
   AND pg_get_triggerdef(oid) LIKE '%RETORNO_COMPLETADO%') THEN
  RAISE EXCEPTION 'CAJA C186 FAIL: el cierre automático aún espera la liquidación en Torre';
 END IF;
 IF public.economic_deviation(1000, 1000) OR NOT public.economic_deviation(1000, 1001 + (public.economic_settings_get()->>'deviation_pen')::numeric) THEN
  RAISE EXCEPTION 'CAJA C186 FAIL: umbral de desviación mal calculado';
 END IF;
 RAISE EXCEPTION 'CAJA C186 PASS: cierre económico simplificado con control sobre el umbral';
END $$;
ROLLBACK;
