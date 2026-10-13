-- Targeted operational diagnosis. No names, contact details, tokens or evidence URLs.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout='20s';
WITH target AS (SELECT * FROM public.dispatches WHERE dispatch_number='__DISPATCH__')
SELECT 'dispatch_assignment' AS section,jsonb_build_object(
 'found',EXISTS(SELECT 1 FROM target),'number','__DISPATCH__','now_lima',now() AT TIME ZONE 'America/Lima',
 'dispatch',(SELECT jsonb_build_object('id',d.id,'status',d.status,'scheduled_departure',d.scheduled_departure,
 'created_at',d.created_at,'operating_day',to_jsonb(d)->>'operating_day','operational_closed_at',to_jsonb(d)->>'operational_closed_at',
 'modalidad',to_jsonb(d)->>'modalidad','driver_assigned',d.driver_id IS NOT NULL,
 'driver_exists',dr.id IS NOT NULL,'driver_active',dr.is_active,'profile_linked',dr.profile_id IS NOT NULL,
 'profile_exists',p.id IS NOT NULL,'profile_active',p.is_active,
 'auth_account_exists',EXISTS(SELECT 1 FROM auth.users u WHERE u.id=p.id),
 'active_driver_links',(SELECT count(*) FROM public.drivers other WHERE other.profile_id=dr.profile_id AND other.is_active),
 'stops',(SELECT count(*) FROM public.dispatch_requests r WHERE r.dispatch_id=d.id),
 'fleet_assignment_matches',(SELECT count(*) FROM public.vehicles v WHERE v.plate=d.vehicle_plate AND v.assigned_driver_id=d.driver_id),
 'app_candidate',(SELECT jsonb_build_object('number',other.dispatch_number,'status',other.status,'scheduled_departure',other.scheduled_departure)
 FROM public.dispatches other WHERE other.driver_id=dr.id
 AND other.status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO','RETORNO_COMPLETADO')
 ORDER BY other.created_at DESC LIMIT 1)) FROM target d LEFT JOIN public.drivers dr ON dr.id=d.driver_id
 LEFT JOIN public.profiles p ON p.id=dr.profile_id)) AS detail
UNION ALL
SELECT 'driver_routes',COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
 SELECT d.dispatch_number,d.status,d.scheduled_departure,d.created_at,
 to_jsonb(d)->>'operational_closed_at' AS operational_closed_at
 FROM public.dispatches d WHERE d.driver_id IN(SELECT driver_id FROM target)
 ORDER BY d.created_at DESC LIMIT 12)r),'[]'::jsonb)
UNION ALL
SELECT 'app_rpc',jsonb_build_object('name',p.oid::regprocedure::text,'volatility',p.provolatile,'body',p.prosrc)
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN ('get_active_trip_context','get_active_trip_context_before_stop_info',
 'get_active_trip_context_before_preuse','get_driver_preuse_context','get_driver_preuse_context_before_fleet');
-- Reproduce the transaction mode PostgREST uses for STABLE RPCs. This cannot
-- change operational records: the transaction is explicitly READ ONLY.
SELECT set_config('request.jwt.claim.sub',dr.profile_id::text,true) AS simulated_session
 FROM public.dispatches d JOIN public.drivers dr ON dr.id=d.driver_id
 WHERE d.dispatch_number='__DISPATCH__';
SELECT 'app_read_only_probe' AS section,jsonb_build_object('number',
 public.get_active_trip_context()#>>'{trip,dispatch_number}') AS detail;
COMMIT;
