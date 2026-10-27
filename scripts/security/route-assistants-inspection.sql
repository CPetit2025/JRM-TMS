-- Approved limited read-only check: three status flags only.
BEGIN READ ONLY;
SET LOCAL statement_timeout='15s';
SELECT 'case_romero' AS section, COALESCE(jsonb_agg(jsonb_build_object(
 'active',p.active,'driver_linked',p.driver_id IS NOT NULL,
 'busy',public.route_person_busy(p.id,NULL) IS NOT NULL)), '[]'::jsonb) AS finding
FROM public.hhee_people p WHERE p.name ILIKE '%romero%';
ROLLBACK;
