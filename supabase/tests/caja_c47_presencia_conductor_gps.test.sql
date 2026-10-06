BEGIN;
DO $test$
DECLARE v_user uuid; r jsonb; fail text[]:='{}'; v_driver uuid; v_site uuid;
BEGIN
 IF has_function_privilege('anon','public.get_driver_gps_monitor()','EXECUTE') OR
   has_function_privilege('anon','public.driver_app_heartbeat(text,numeric,numeric,numeric,numeric,timestamptz)','EXECUTE') OR
   has_table_privilege('authenticated','public.driver_app_presence','INSERT') OR
   has_table_privilege('authenticated','public.driver_app_presence','SELECT') OR
   has_function_privilege('authenticated','public.driver_presence_route_point()','EXECUTE') THEN
   fail:=array_append(fail,'GPS/presencia expuesta'); END IF;
 SELECT id INTO v_driver FROM public.drivers WHERE is_active AND profile_id IN(SELECT id FROM public.profiles WHERE is_active) LIMIT 1;
 IF v_driver IS NULL THEN RAISE EXCEPTION 'CAJA C47 FAIL: falta conductor activo'; END IF;
 SELECT profile_id INTO v_user FROM public.drivers WHERE id=v_driver;
 -- Isolate the fixture from live GPS ahead of the server clock; rollback restores the real row.
 DELETE FROM public.driver_app_presence WHERE driver_id=v_driver;
 PERFORM set_config('request.jwt.claim.sub',v_user::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',v_user,'role','authenticated')::text,true);
 r:=public.driver_app_heartbeat('denied');
 IF NOT COALESCE((r->>'success')::boolean,false) OR NOT EXISTS(SELECT 1 FROM public.driver_app_presence WHERE driver_id=v_driver AND gps_state='denied' AND last_seen_at=now()) THEN
   fail:=array_append(fail,'Conductor sin GPS no registra conexión'); END IF;
 r:=public.driver_app_heartbeat('active',-12,-77,15,0,now());
 IF NOT EXISTS(SELECT 1 FROM public.driver_app_presence WHERE driver_id=v_driver AND latitude=-12 AND longitude=-77 AND recorded_at=now()) THEN
   fail:=array_append(fail,'Ubicación no registrada'); END IF;
 r:=public.driver_app_heartbeat('active',-13,-78,15,NULL,now()-interval '5 minutes');
 IF NOT EXISTS(SELECT 1 FROM public.driver_app_presence WHERE driver_id=v_driver AND latitude=-12 AND recorded_at=now()) THEN
   fail:=array_append(fail,'GPS tardío desplaza ubicación reciente'); END IF;
 PERFORM public.driver_app_disconnect();
 IF NOT EXISTS(SELECT 1 FROM public.driver_app_presence WHERE driver_id=v_driver AND disconnected_at IS NOT NULL) THEN
   fail:=array_append(fail,'Cierre de sesión no desconecta'); END IF;
 IF cardinality(fail)>0 THEN RAISE EXCEPTION 'CAJA C47 FAIL: %',array_to_string(fail,' | '); END IF;
 RAISE EXCEPTION 'CAJA C47 PASS: presencia propia, permisos privados, conductor sin GPS, ubicación ordenada y desconexión';
END $test$;
ROLLBACK;
