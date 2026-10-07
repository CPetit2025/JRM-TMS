BEGIN;
DO $test$
DECLARE actor uuid; auditor uuid; audit_role uuid; site uuid; foreign_site uuid; d uuid; null_d uuid; foreign_d uuid; q jsonb; denied boolean:=false;
BEGIN
 IF has_function_privilege('anon','public.get_documentary_queue_period(boolean,timestamptz,timestamptz)','EXECUTE') THEN
   RAISE EXCEPTION 'CAJA C59 FAIL: historial anónimo'; END IF;
 FOR actor IN SELECT id FROM public.profiles WHERE is_active AND id IN(SELECT id FROM auth.users) LOOP
   PERFORM set_config('request.jwt.claim.sub',actor::text,true);
   EXIT WHEN public.is_tms_admin(); actor:=NULL;
 END LOOP;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C59 FAIL: falta administrador'; END IF;
 PERFORM set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
 SELECT site_id INTO site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
 INSERT INTO public.dispatches(dispatch_number,vehicle_plate,status,site_id,scheduled_departure,docs_required)
 VALUES('ZZ-C59-HISTORY','ZZ59'||substr(gen_random_uuid()::text,1,6),'CANCELADO',site,now()-interval '60 days',true) RETURNING id INTO d;
 q:=public.get_documentary_queue_period(true,now()-interval '61 days',now()-interval '59 days');
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q) x WHERE x->>'id'=d::text) THEN
   RAISE EXCEPTION 'CAJA C59 FAIL: historial pierde despacho cancelado fuera de siete días'; END IF;
 q:=public.get_documentary_queue_period(true,now()-interval '30 days',now());
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(q) x WHERE x->>'id'=d::text) THEN
   RAISE EXCEPTION 'CAJA C59 FAIL: no respeta período'; END IF;
 q:=public.get_documentary_queue(false);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(q) x WHERE x->>'id'=d::text) THEN
   RAISE EXCEPTION 'CAJA C59 FAIL: altera bandeja previa a salida'; END IF;
 BEGIN
   PERFORM public.get_documentary_queue_period(true,now()-interval '367 days',now());
 EXCEPTION WHEN OTHERS THEN
   IF SQLERRM LIKE '%366 días%' THEN denied:=true; ELSE RAISE; END IF;
 END;
 IF NOT denied THEN RAISE EXCEPTION 'CAJA C59 FAIL: permite rango sin límite'; END IF;
 -- The auditor can consult packing history, but not guide files or unrelated sites.
 SELECT id INTO auditor FROM public.profiles WHERE id IN(SELECT id FROM auth.users) AND id<>actor
   AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 1;
 SELECT id INTO audit_role FROM public.roles WHERE lower(trim(name))='auditor de despacho';
 SELECT id INTO foreign_site FROM public.sites WHERE id<>site LIMIT 1;
 IF foreign_site IS NULL THEN
   INSERT INTO public.sites(code,name) VALUES('ZZ-C59-'||substr(gen_random_uuid()::text,1,8),'ZZ C59 sede de aislamiento') RETURNING id INTO foreign_site;
 END IF;
 IF auditor IS NULL OR audit_role IS NULL OR foreign_site IS NULL THEN RAISE EXCEPTION 'CAJA C59 FAIL: faltan auditor/sede para comprobar aislamiento'; END IF;
 UPDATE public.profiles SET is_active=true,role_id=audit_role WHERE id=auditor;
 DELETE FROM public.user_site_access WHERE user_id=auditor;
 INSERT INTO public.user_site_access(user_id,site_id) VALUES(auditor,site);
 INSERT INTO public.dispatches(dispatch_number,vehicle_plate,status,site_id,scheduled_departure,docs_required)
 VALUES('ZZ-C59-NULL','ZZ59N'||substr(gen_random_uuid()::text,1,6),'PROGRAMADO',NULL,now()-interval '60 days',true) RETURNING id INTO null_d;
 INSERT INTO public.dispatches(dispatch_number,vehicle_plate,status,site_id,scheduled_departure,docs_required)
 VALUES('ZZ-C59-FOREIGN','ZZ59F'||substr(gen_random_uuid()::text,1,6),'PROGRAMADO',foreign_site,now()-interval '60 days',true) RETURNING id INTO foreign_d;
 INSERT INTO public.dispatch_documents(dispatch_id,doc_type,file_path,mime_type)
 VALUES(d,'OTRO',d::text||'/not-for-auditor.pdf','application/pdf'),(d,'PACKING_LIST',d::text||'/packing.pdf','application/pdf');
 PERFORM set_config('request.jwt.claim.sub',auditor::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',auditor,'role','authenticated')::text,true);
 -- Original RPC must no longer expose null-site records either.
 q:=public.get_documentary_queue(true);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(q) x WHERE x->>'id' IN(null_d::text,foreign_d::text)) THEN
   RAISE EXCEPTION 'CAJA C59 FAIL: bandeja original omite aislamiento de sede'; END IF;
 q:=public.get_documentary_queue_period(true,now()-interval '61 days',now()-interval '59 days');
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q) x WHERE x->>'id'=d::text)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(q) x WHERE x->>'id' IN(null_d::text,foreign_d::text))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(q) x CROSS JOIN LATERAL jsonb_array_elements(x->'documents') doc WHERE doc->>'doc_type'<>'PACKING_LIST') THEN
   RAISE EXCEPTION 'CAJA C59 FAIL: auditor no respeta sede/tipo documentario'; END IF;
 denied:=false;
 PERFORM set_config('request.jwt.claim.sub','',true);
 PERFORM set_config('request.jwt.claims','{}',true);
 BEGIN
   PERFORM public.get_documentary_queue_period(true,now()-interval '1 day',now());
 EXCEPTION WHEN OTHERS THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'CAJA C59 FAIL: historial sin identidad'; END IF;
 RAISE EXCEPTION 'CAJA C59 PASS: historial acotado, cancelaciones, rango, compatibilidad y autorización';
END $test$;
ROLLBACK;
