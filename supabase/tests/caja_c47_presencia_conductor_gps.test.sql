BEGIN;
DO $test$
DECLARE v_user uuid; r jsonb; fail text[]:='{}'; v_driver uuid; v_admin uuid;
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
 FOR v_admin IN SELECT id FROM public.profiles WHERE is_active AND id IN(SELECT id FROM auth.users) LOOP
   PERFORM set_config('request.jwt.claim.sub',v_admin::text,true);
   EXIT WHEN public.is_tms_admin(); v_admin:=NULL;
 END LOOP;
 IF v_admin IS NULL THEN fail:=array_append(fail,'Falta administrador para comprobar monitor');
 ELSE
   PERFORM set_config('request.jwt.claims',json_build_object('sub',v_admin,'role','authenticated')::text,true);
   r:=public.get_driver_gps_monitor();
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'drivers') x WHERE x->>'driver_id'=v_driver::text AND x->>'connected'='false') THEN
     fail:=array_append(fail,'Consulta real del monitor no refleja conductor/desconexión'); END IF;
 END IF;
 IF cardinality(fail)>0 THEN RAISE EXCEPTION 'CAJA C47 FAIL: %',array_to_string(fail,' | '); END IF;
 RAISE EXCEPTION 'CAJA C47 PASS: presencia propia, permisos privados, conductor sin GPS, ubicación ordenada, desconexión y consulta real del monitor';
END $test$;
ROLLBACK;
