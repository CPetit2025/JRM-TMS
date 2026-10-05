-- CAJA C44: verifica guardas/privilegios instalados en el esquema real.
-- Los casos funcionales (envío, corrección, aprobación, GPS y repetición) corren
-- antes del merge en scripts/test-delivery-conformity.cjs y en C41 en producción.
DO $test$
DECLARE failures text[]:='{}'; f record; protected int; policy_count int;
BEGIN
 FOR f IN SELECT oid,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
  ('delivery_submit_core','delivery_rows_core','delivery_arrive_core','delivery_public_authorize','delivery_public_submit','delivery_portal_login') LOOP
  IF has_function_privilege('anon',f.oid,'EXECUTE') OR has_function_privilege('authenticated',f.oid,'EXECUTE') THEN
   failures:=failures||('Función privada expuesta: '||f.proname); END IF;
 END LOOP;
 IF NOT has_function_privilege('authenticated','public.delivery_review(uuid,uuid,uuid,text,text)','EXECUTE')
  OR has_function_privilege('anon','public.delivery_review(uuid,uuid,uuid,text,text)','EXECUTE') THEN failures:=failures||'Permisos de revisión'; END IF;
 FOR f IN SELECT oid,relname,relrowsecurity FROM pg_class WHERE oid IN
  ('public.delivery_conformities'::regclass,'public.delivery_submissions'::regclass,'public.delivery_reviews'::regclass,'public.delivery_portal_attempts'::regclass) LOOP
  IF NOT f.relrowsecurity OR has_table_privilege('anon',f.oid,'SELECT') OR has_table_privilege('authenticated',f.oid,'INSERT,UPDATE,DELETE') THEN failures:=failures||('Tabla expuesta: '||f.relname); END IF;
 END LOOP;
 SELECT count(*) INTO protected FROM pg_trigger WHERE NOT tgisinternal AND tgenabled<>'D' AND tgname IN
  ('delivery_guard_stop','delivery_guard_dispatch','delivery_guard_request');
 IF protected<>3 THEN failures:=failures||'Faltan guardas de avance'; END IF;
 SELECT count(*) INTO policy_count FROM pg_policy WHERE polrelid='storage.objects'::regclass AND NOT polpermissive AND polname IN
  ('delivery_evidence_no_delete','delivery_evidence_no_overwrite');
 IF policy_count<>2 THEN failures:=failures||'Fotografías sin protección de versiones'; END IF;
 IF pg_get_functiondef('public.delivery_can_review(uuid)'::regprocedure) NOT LIKE '%Supervisor de Transporte%'
  OR pg_get_functiondef('public.delivery_can_review(uuid)'::regprocedure) NOT LIKE '%can_access_site%'
  OR pg_get_functiondef('public.execute_driver_offline_action(uuid,text,jsonb)'::regprocedure) NOT LIKE '%delivery_submit_driver%' THEN failures:=failures||'Rol, sede o acción offline sin instalar'; END IF;
 IF EXISTS(SELECT 1 FROM delivery_submissions s JOIN delivery_conformities c ON c.current_submission_id=s.id
   WHERE c.dispatch_id<>s.dispatch_id OR c.request_id<>s.request_id) THEN failures:=failures||'Versión de otro servicio'; END IF;
 IF cardinality(failures)>0 THEN RAISE EXCEPTION 'CAJA C44 FAIL: %',array_to_string(failures,' | '); END IF;
 RAISE EXCEPTION 'CAJA C44 PASS: permisos privados, supervisor/sede, tres guardas de avance, fotos inmutables y acciones offline instaladas';
END $test$;
