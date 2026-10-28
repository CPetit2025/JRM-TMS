BEGIN;
DO $$
BEGIN
 IF to_regprocedure('public.manual_close_dispatch_operations(uuid,text)') IS NULL THEN
  RAISE EXCEPTION 'CAJA C161 FAIL: falta cierre operativo manual'; END IF;
 IF has_function_privilege('anon','public.manual_close_dispatch_operations(uuid,text)','EXECUTE')
  OR NOT has_function_privilege('authenticated','public.manual_close_dispatch_operations(uuid,text)','EXECUTE')
  OR has_function_privilege('authenticated','public.dispatch_release_own_unit_core(uuid)','EXECUTE')
  OR has_function_privilege('authenticated','public.dispatch_daily_clock_guard()','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C161 FAIL: permisos de cierre incorrectos'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.manual_close_dispatch_operations(uuid,text)'::regprocedure
   AND prosecdef AND proconfig @> ARRAY['search_path=public, pg_temp']) THEN
  RAISE EXCEPTION 'CAJA C161 FAIL: cierre manual sin configuración segura'; END IF;
 RAISE EXCEPTION 'CAJA C161 PASS: cierre operativo manual instalado y funciones internas protegidas';
END $$;
ROLLBACK;
