-- Approved read-only case check, using the same personnel list as the route modal.
BEGIN READ ONLY;
SET LOCAL statement_timeout='8s';
DO $$
DECLARE actor uuid;
BEGIN
 SELECT p.id INTO actor FROM public.profiles p JOIN public.roles r ON r.id=p.role_id
 WHERE p.is_active AND r.name='Administrador' AND EXISTS(SELECT 1 FROM auth.users u WHERE u.id=p.id)
 ORDER BY p.id LIMIT 1;
 IF actor IS NULL THEN RAISE EXCEPTION 'No authorized account for read-only case inspection'; END IF;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
END $$;
SELECT 'case_romero' AS section,COALESCE(jsonb_agg(jsonb_build_object(
 'active',true,'driver_linked',j->>'driver_id' IS NOT NULL,'busy',j->>'busy' IS NOT NULL)),'[]'::jsonb) AS finding
FROM jsonb_array_elements(public.list_route_assistants(NULL)) j WHERE j->>'name' ILIKE '%romero%';
ROLLBACK;
