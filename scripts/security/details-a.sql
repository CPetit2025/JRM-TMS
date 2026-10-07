BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '2s';
SELECT 'function_sources' AS section,jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid)) AS finding
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND p.proname < 'm';
ROLLBACK;
