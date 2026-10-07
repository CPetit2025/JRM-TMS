BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '2s';
SELECT 'function_sources' AS section,jsonb_build_object('signature',p.oid::regprocedure::text,'definition',left(pg_get_functiondef(p.oid),12000),'truncated',length(pg_get_functiondef(p.oid))>12000) AS finding
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND p.proname < 'm' AND (has_function_privilege('anon',p.oid,'EXECUTE') OR p.proconfig IS NULL OR p.prosrc !~* '(auth.uid|has_tms|is_tms|can_access|can_view|can_write|can_read|puede_operar|can_operate|has_cmms|apt_can|fe_can)' OR p.proname IN ('can_manage_fleet_status','can_operate_dispatch','has_caja_read_access')) AND pg_get_function_result(p.oid) NOT IN ('trigger','event_trigger');
ROLLBACK;
