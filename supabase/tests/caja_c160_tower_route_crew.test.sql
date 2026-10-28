BEGIN;
DO $$
BEGIN
 IF to_regprocedure('public.get_tower_route_crew(uuid)') IS NULL THEN RAISE EXCEPTION 'CAJA C160 FAIL: falta consulta operativa de auxiliares'; END IF;
 IF has_function_privilege('anon','public.get_tower_route_crew(uuid)','EXECUTE')
   OR NOT has_function_privilege('authenticated','public.get_tower_route_crew(uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C160 FAIL: permisos de consulta incorrectos';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.get_tower_route_crew(uuid)'::regprocedure
   AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=public, pg_temp']) THEN
  RAISE EXCEPTION 'CAJA C160 FAIL: consulta operativa sin configuración segura';
 END IF;
 RAISE EXCEPTION 'CAJA C160 PASS: consulta operativa de auxiliares instalada con permisos y configuración protegidos';
END $$;
ROLLBACK;
