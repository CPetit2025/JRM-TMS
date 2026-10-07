BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '2s';

SELECT 'tables' AS section, jsonb_build_object('table', c.relname, 'rls', c.relrowsecurity, 'force_rls', c.relforcerowsecurity,
 'rows', c.reltuples::bigint, 'bytes', pg_total_relation_size(c.oid),
 'anon', ARRAY(SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name=c.relname AND grantee='anon'),
 'authenticated', ARRAY(SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name=c.relname AND grantee='authenticated'),
 'policies', (SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)) AS finding
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')
UNION ALL
SELECT 'policies' AS section, to_jsonb(p) AS finding FROM pg_policies p WHERE schemaname IN ('public','storage')
UNION ALL
SELECT 'functions' AS section, jsonb_build_object('signature',p.oid::regprocedure::text,'definer',p.prosecdef,'config',p.proconfig,
 'anon',has_function_privilege('anon',p.oid,'EXECUTE'),'authenticated',has_function_privilege('authenticated',p.oid,'EXECUTE'),
 'service',has_function_privilege('service_role',p.oid,'EXECUTE'),'return',pg_get_function_result(p.oid),
 'guard',p.prosrc ~* '(auth.uid|has_tms|is_tms|can_access|can_view|can_write|can_read|puede_operar|can_operate|permission|profile_id)',
 'writes',p.prosrc ~* '\m(insert|update|delete|truncate)\M','hash',md5(p.prosrc)) AS finding
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
UNION ALL
SELECT 'views' AS section,jsonb_build_object('view',c.relname,'options',c.reloptions,'anon',has_table_privilege('anon',c.oid,'SELECT'),
 'authenticated',has_table_privilege('authenticated',c.oid,'SELECT'),'definition',pg_get_viewdef(c.oid,true)) AS finding
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('v','m')
UNION ALL
SELECT 'foreign_keys' AS section,jsonb_build_object('table',c.conrelid::regclass::text,'name',c.conname,'definition',pg_get_constraintdef(c.oid),
 'validated',c.convalidated,'indexed',EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.conrelid AND i.indisvalid AND i.indpred IS NULL
 AND (i.indkey::smallint[])[0:cardinality(c.conkey)-1] @> c.conkey)) AS finding
FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.contype='f'
UNION ALL
SELECT 'unlinked_columns' AS section,jsonb_build_object('table',c.relname,'column',a.attname,'type',format_type(a.atttypid,a.atttypmod),'nullable',NOT a.attnotnull) AS finding
FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND a.attname LIKE '%\_id'
AND NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=c.oid AND k.contype='f' AND a.attnum=ANY(k.conkey))
UNION ALL
SELECT 'indexes' AS section,jsonb_build_object('table',s.relname,'index',s.indexrelname,'scans',s.idx_scan,'valid',i.indisvalid,'definition',pg_get_indexdef(s.indexrelid)) AS finding
FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid=s.indexrelid WHERE s.schemaname='public'
UNION ALL
SELECT 'statistics' AS section,jsonb_build_object('table',relname,'seq_scan',seq_scan,'seq_tup_read',seq_tup_read,'idx_scan',idx_scan,'live',n_live_tup,'dead',n_dead_tup,
 'last_analyze',last_analyze,'last_autoanalyze',last_autoanalyze,'last_autovacuum',last_autovacuum) AS finding FROM pg_stat_user_tables WHERE schemaname='public'
UNION ALL
SELECT 'schemas' AS section,jsonb_build_object('schema',nspname,'anon_create',has_schema_privilege('anon',oid,'CREATE'),
 'authenticated_create',has_schema_privilege('authenticated',oid,'CREATE')) AS finding FROM pg_namespace WHERE nspname='public'
UNION ALL
SELECT 'buckets' AS section,jsonb_build_object('bucket',id,'public',public,'max_bytes',file_size_limit,'mime',allowed_mime_types) AS finding FROM storage.buckets
UNION ALL
SELECT 'columns' AS section,jsonb_build_object('table',table_name,'column',column_name,'type',data_type,'nullable',is_nullable,'default',column_default) AS finding
FROM information_schema.columns WHERE table_schema='public'
UNION ALL
SELECT 'storage_counts' AS section,jsonb_build_object('bucket',bucket_id,'objects',count(*)) AS finding FROM storage.objects GROUP BY bucket_id;
ROLLBACK;
