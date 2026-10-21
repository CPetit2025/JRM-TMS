BEGIN;
DO $$
DECLARE actor uuid; route uuid; result jsonb; failed boolean:=false;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='route_latest_event_notification' AND NOT tgisinternal) THEN RAISE EXCEPTION 'CAJA C132 FAIL: falta disparador de avisos'; END IF;
 IF has_function_privilege('anon','public.get_route_share_details(uuid[])','EXECUTE') OR has_function_privilege('anon','public.schedule_route_resources(jsonb)','EXECUTE') THEN RAISE EXCEPTION 'CAJA C132 FAIL: RPC operativo público'; END IF;
 IF has_table_privilege('anon','public.route_forklifts','SELECT') OR has_table_privilege('authenticated','public.route_forklifts','INSERT') THEN RAISE EXCEPTION 'CAJA C132 FAIL: acceso directo al apoyo'; END IF;
 PERFORM set_config('request.jwt.claim.sub','',true);
 BEGIN PERFORM public.get_route_share_details(ARRAY[gen_random_uuid()]); EXCEPTION WHEN OTHERS THEN failed:=true; END;
 IF NOT failed THEN RAISE EXCEPTION 'CAJA C132 FAIL: comparte sin sesión'; END IF;
 SELECT p.id INTO actor FROM public.profiles p JOIN public.roles r ON r.id=p.role_id WHERE p.is_active AND r.name='Administrador' ORDER BY p.id LIMIT 1;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C132 FAIL: falta administrador para validar'; END IF;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 result:=public.route_forklift_candidates();
 IF jsonb_typeof(result)<>'array' THEN RAISE EXCEPTION 'CAJA C132 FAIL: candidatos inválidos'; END IF;
 SELECT d.id INTO route FROM public.dispatches d WHERE public.delivery_can_read(d.id) ORDER BY d.id LIMIT 1;
 IF route IS NOT NULL THEN
  result:=public.get_route_share_details(ARRAY[route,route]);
  IF jsonb_array_length(result)<>1 OR NOT (result->0 ? 'driver_license') OR NOT (result->0 ? 'auxiliaries') OR NOT (result->0 ? 'forklift') THEN RAISE EXCEPTION 'CAJA C132 FAIL: ficha incompleta o duplicada'; END IF;
  IF result->0 ? 'pin' OR result->0 ? 'freight_cost' THEN RAISE EXCEPTION 'CAJA C132 FAIL: expone datos no operativos'; END IF;
 END IF;
 RAISE EXCEPTION 'CAJA C132 PASS: permisos de apoyo, exportación operativa sin duplicados y avisos instalados';
END $$;
ROLLBACK;
