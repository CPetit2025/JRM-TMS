BEGIN;
DO $test$
DECLARE actor uuid; prior_sub text; prior_claims text; result jsonb; expected uuid;
BEGIN
 IF (SELECT provolatile FROM pg_proc WHERE oid='public.get_active_trip_context()'::regprocedure)<>'v' THEN
   RAISE EXCEPTION 'CAJA C100 FAIL: PostgREST abriría una transacción de solo lectura para la ruta'; END IF;
 IF has_function_privilege('anon','public.get_active_trip_context()','EXECUTE')
 OR NOT has_function_privilege('authenticated','public.get_active_trip_context()','EXECUTE') THEN
   RAISE EXCEPTION 'CAJA C100 FAIL: permisos de la consulta de ruta'; END IF;
 -- Validate the real assigned driver when available, with all synchronization
 -- contained in this deliberately rolled-back transaction. No personal data is emitted.
 SELECT dr.profile_id INTO actor FROM public.dispatches d
 JOIN public.drivers dr ON dr.id=d.driver_id JOIN public.profiles p ON p.id=dr.profile_id
 JOIN auth.users u ON u.id=p.id WHERE d.dispatch_number='10026' AND dr.is_active AND p.is_active;
 IF actor IS NULL THEN
   SELECT dr.profile_id INTO actor FROM public.drivers dr JOIN public.profiles p ON p.id=dr.profile_id
   JOIN auth.users u ON u.id=p.id WHERE dr.is_active AND p.is_active ORDER BY dr.id LIMIT 1;
 END IF;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C100 FAIL: falta conductor activo para validar la consulta'; END IF;
 prior_sub:=current_setting('request.jwt.claim.sub',true); prior_claims:=current_setting('request.jwt.claims',true);
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
 SELECT d.id INTO expected FROM public.dispatches d JOIN public.drivers dr ON dr.id=d.driver_id
 WHERE dr.profile_id=actor AND dr.is_active
 AND d.status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO','RETORNO_COMPLETADO','ENTREGADO')
 ORDER BY d.created_at DESC LIMIT 1;
 result:=public.get_active_trip_context();
 IF result#>>'{user,id}' IS DISTINCT FROM actor::text
 OR result#>>'{trip,id}' IS DISTINCT FROM expected::text THEN
   RAISE EXCEPTION 'CAJA C100 FAIL: consulta no devuelve el viaje del conductor autenticado'; END IF;
 PERFORM set_config('request.jwt.claim.sub',COALESCE(prior_sub,''),true);
 PERFORM set_config('request.jwt.claims',COALESCE(prior_claims,''),true);
 RAISE EXCEPTION 'CAJA C100 PASS: ruta visible, modo PostgREST y permisos correctos; sincronización revertida';
END $test$;
ROLLBACK;
