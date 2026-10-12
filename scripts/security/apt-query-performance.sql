-- The reader creates/drops session-temporary tables, which PostgreSQL rejects in
-- READ ONLY mode. It performs no permanent-table writes; rollback is mandatory.
BEGIN;
SET LOCAL statement_timeout='45s';
SET LOCAL lock_timeout='2s';
-- Exercise the actual reader with an existing authorized account. Only session-local
-- claims are set; profiles, roles and inventory remain untouched and no identity is published.
DO $$
DECLARE actor uuid;
BEGIN
 SELECT p.id INTO actor FROM public.profiles p JOIN public.roles r ON r.id=p.role_id
 WHERE p.is_active AND p.id IN(SELECT id FROM auth.users)
 AND (r.name='Administrador' OR r.permissions ?| ARRAY['apt','apt:read','apt:write','apt-carga','apt-carga:write'])
 ORDER BY p.id LIMIT 1;
 IF actor IS NULL THEN RAISE EXCEPTION 'No authorized APT account available for read-only performance verification'; END IF;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
END $$;
WITH started AS MATERIALIZED (SELECT clock_timestamp() AS at),
 measured AS MATERIALIZED (SELECT at,public.apt_operational_summary('{"limit":25,"offset":0}') AS result FROM started)
SELECT 'apt_operational_performance' AS section,jsonb_build_object(
 'elapsed_ms',round((extract(epoch FROM clock_timestamp()-at)*1000)::numeric,1),
 'success',result->'success','error',result->'error','total',result->'total',
 'returned_rows',jsonb_array_length(result->'rows'),'meta',result->'meta',
 'kpis',result->'kpis','quality',result->'quality',
 'personal_data_published',false) AS finding FROM measured;

ROLLBACK;
