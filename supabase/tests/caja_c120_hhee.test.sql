-- HHEE functional/security regression. Synthetic business records; every change is rolled back.
BEGIN;
SET LOCAL statement_timeout='45s';
DO $test$
DECLARE actor uuid; reviewer uuid; admin_role uuid; request_role uuid:=gen_random_uuid(); chief_role uuid:=gen_random_uuid();
 hr_role uuid:=gen_random_uuid(); manager_role uuid:=gen_random_uuid(); site uuid:=gen_random_uuid(); area uuid:=gen_random_uuid(); outside uuid:=gen_random_uuid();
 person uuid:=gen_random_uuid(); rid uuid:=gen_random_uuid(); other uuid:=gen_random_uuid(); cause uuid; res jsonb; p jsonb; excel jsonb; op uuid;
 lid uuid; seq bigint; v int; before_count int; workdate text:=((now() AT TIME ZONE 'America/Lima')::date-1)::text; a uuid;
BEGIN
 SELECT id INTO admin_role FROM public.roles WHERE name='Administrador' LIMIT 1;
 SELECT p.id INTO actor FROM public.profiles p JOIN auth.users u ON u.id=p.id WHERE p.is_active AND p.role_id=admin_role ORDER BY p.id LIMIT 1;
 SELECT p.id INTO reviewer FROM public.profiles p JOIN auth.users u ON u.id=p.id WHERE p.id<>actor ORDER BY p.id LIMIT 1;
 IF actor IS NULL OR reviewer IS NULL THEN RAISE EXCEPTION 'CAJA C120 FAIL: faltan dos perfiles para probar independencia'; END IF;
 INSERT INTO public.roles(id,name,permissions) VALUES(request_role,'C120-request-'||request_role,'["hhee-solicitar:write"]'),
 (chief_role,'C120-chief-'||chief_role,'["hhee-aprobar:write"]'),(hr_role,'C120-hr-'||hr_role,'["hhee-validar:write"]'),
 (manager_role,'C120-mgr-'||manager_role,'["hhee-gerencia:read","hhee-excepciones:write"]');
 INSERT INTO public.sites(id,code,name) VALUES(site,'C120-'||site,'C120 scope');
 INSERT INTO public.user_site_access(user_id,site_id) VALUES(actor,site),(reviewer,site) ON CONFLICT DO NOTHING;
 INSERT INTO public.hhee_areas(id,site_id,name) VALUES(area,site,'C120 area'),(outside,public.primary_site_id(),'C120 outside '||outside);
 INSERT INTO public.hhee_memberships VALUES(actor,area),(reviewer,area);
 INSERT INTO public.hhee_people(id,code,name,area_id,estimated_hour_cost) VALUES(person,upper('C120-'||person::text),'C120 trabajador',area,10);
 SELECT id INTO cause FROM public.hhee_causes WHERE active LIMIT 1;
 IF has_function_privilege('anon','public.hhee_context()','EXECUTE') OR has_function_privilege('anon','public.hhee_attendance(jsonb,boolean)','EXECUTE')
 OR has_function_privilege('authenticated','public.hhee_needs_exception(uuid)','EXECUTE') OR has_table_privilege('authenticated','public.hhee_lines','SELECT') THEN
  RAISE EXCEPTION 'CAJA C120 FAIL: acceso directo o anónimo'; END IF;
 PERFORM set_config('request.jwt.claim.sub','',true);PERFORM set_config('request.jwt.claims','{}',true);
 IF (public.hhee_read()->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C120 FAIL: sin sesión'; END IF;
 UPDATE public.profiles SET role_id=request_role,is_active=true WHERE id=actor;
 UPDATE public.profiles SET role_id=chief_role,is_active=true WHERE id=reviewer;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
 p:=jsonb_build_object('operation_id',gen_random_uuid(),'action','save_request','id',rid,'area_id',area,'cause_id',cause,
 'work_date',workdate,'activity','C120 trabajo operativo','justification','Necesidad operativa excepcional de prueba',
 'alternatives','Reasignación de personal evaluada','expected_result','Completar trabajo de prueba','reference_type','OC','reference_code','C120-OC',
 'lines',jsonb_build_array(jsonb_build_object('person_id',person,'planned_start',workdate||'T18:00','planned_end',workdate||'T20:00','planned_break',0)));
 res:=public.hhee_mutate(p);
 IF NOT COALESCE((res->>'success')::boolean,false) THEN RAISE EXCEPTION 'CAJA C120 FAIL: crear solicitud %',res; END IF;
 res:=public.hhee_mutate(p);
 IF NOT (res->>'success')::boolean OR (SELECT count(*) FROM public.hhee_lines WHERE request_id=rid)<>1 THEN RAISE EXCEPTION 'CAJA C120 FAIL: reintento duplicó'; END IF;
 res:=public.hhee_mutate(p||jsonb_build_object('activity','Otro contenido'));
 IF (res->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C120 FAIL: reutilizó operación con otros datos'; END IF;
 res:=public.hhee_mutate(p||jsonb_build_object('operation_id',gen_random_uuid(),'id',other,'area_id',outside));
 IF (res->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C120 FAIL: solicitud fuera del área'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(public.hhee_context()->'people') x WHERE x->>'estimated_hour_cost' IS NOT NULL) THEN
  RAISE EXCEPTION 'CAJA C120 FAIL: solicitante ve tarifa'; END IF;
 SELECT id INTO lid FROM public.hhee_lines WHERE request_id=rid;
 res:=public.hhee_mutate(jsonb_build_object('operation_id',gen_random_uuid(),'action','submit','id',rid,'version',1));
 IF NOT (res->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C120 FAIL: presentar %',res; END IF;
 res:=public.hhee_mutate(jsonb_build_object('operation_id',gen_random_uuid(),'action','decide','id',rid,'version',2,'decision','APROBADA','reason','Aprobación operativa de prueba','lines',jsonb_build_array(jsonb_build_object('id',lid,'approved_minutes',120))));
 IF (res->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C120 FAIL: solicitante aprueba'; END IF;
 PERFORM set_config('request.jwt.claim.sub',reviewer::text,true);
 res:=public.hhee_mutate(jsonb_build_object('operation_id',gen_random_uuid(),'action','decide','id',rid,'version',2,'decision','APROBADA','reason','Aprobación operativa de prueba','lines',jsonb_build_array(jsonb_build_object('id',lid,'approved_minutes',120))));
 IF NOT (res->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C120 FAIL: jefe aprueba %',res; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.hhee_audit WHERE request_id=rid AND event='DECIDE' AND private_data#>>'{request,approval}'='PENDIENTE'
 AND private_data#>>'{lines,0,planned_minutes}'='120') THEN RAISE EXCEPTION 'CAJA C120 FAIL: autorización sin imagen previa auditable'; END IF;
 -- HR import can preserve a real execution even with late authorization / missing cost.
 UPDATE public.profiles SET role_id=hr_role WHERE id=reviewer;
 SELECT sequence,version INTO seq,v FROM public.hhee_requests WHERE id=rid;
 excel:=jsonb_build_object('operation_id',gen_random_uuid(),'file_name','C120-HR.xlsx','file_hash',repeat('a',64),
 'rows',jsonb_build_array(jsonb_build_object('request_code','HE-'||lpad(seq::text,6,'0'),'person_code',upper('C120-'||person::text),
 'start',workdate||'T18:00','end',workdate||'T20:00','break_minutes',0,'recognized_minutes',120,'cost',NULL,
 'consent',true,'result','Trabajo de prueba completado','evidence','Acta C120','version',v)));
 res:=public.hhee_attendance(excel,false);
 IF jsonb_array_length(res->'errors')<>0 OR (res->>'applied')::boolean THEN RAISE EXCEPTION 'CAJA C120 FAIL: preview %',res; END IF;
 IF EXISTS(SELECT 1 FROM public.hhee_lines WHERE id=lid AND actual_minutes IS NOT NULL) THEN RAISE EXCEPTION 'CAJA C120 FAIL: preview escribe'; END IF;
 res:=public.hhee_attendance(jsonb_set(excel,'{rows}',(excel->'rows')||(excel->'rows')),true);
 IF (res->>'applied')::boolean OR jsonb_array_length(res->'errors')=0 OR EXISTS(SELECT 1 FROM public.hhee_lines WHERE id=lid AND actual_minutes IS NOT NULL) THEN
  RAISE EXCEPTION 'CAJA C120 FAIL: importación duplicada no atómica %',res; END IF;
 res:=public.hhee_attendance(excel,true);
 IF NOT COALESCE((res->>'applied')::boolean,false) THEN RAISE EXCEPTION 'CAJA C120 FAIL: importar %',res; END IF;
 before_count:=(SELECT count(*) FROM public.hhee_audit WHERE request_id=rid);
 res:=public.hhee_attendance(excel,true);
 IF NOT (res->>'applied')::boolean OR (SELECT count(*) FROM public.hhee_audit WHERE request_id=rid)<>before_count THEN RAISE EXCEPTION 'CAJA C120 FAIL: reintento importación'; END IF;
 SELECT version INTO v FROM public.hhee_requests WHERE id=rid;
 res:=public.hhee_mutate(jsonb_build_object('operation_id',gen_random_uuid(),'action','validate','id',rid,'version',v-1,'reason','Verificado contra asistencia de RRHH','confirmed_cause_id',cause,'assessment','JUSTIFICADA'));
 IF (res->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C120 FAIL: versión obsoleta'; END IF;
 res:=public.hhee_mutate(jsonb_build_object('operation_id',gen_random_uuid(),'action','validate','id',rid,'version',v,'reason','Verificado contra asistencia de RRHH','confirmed_cause_id',cause,'assessment','JUSTIFICADA'));
 IF NOT (res->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C120 FAIL: validar %',res; END IF;
 res:=public.hhee_read(jsonb_build_object('from',workdate,'to',workdate,'area_id',area));
 IF (res#>>'{metrics,validated_minutes}')::int<>120 OR (res#>>'{metrics,pending_cost}')::int<>1
 OR res#>>'{metrics,validated_cost}' IS NOT NULL OR (res#>>'{metrics,prior_requests}')::int<>0 THEN
 RAISE EXCEPTION 'CAJA C120 FAIL: métricas, costo pendiente o aprobación previa %',res->'metrics'; END IF;
 -- Management can see aggregate costs and exception reasons, never individual cost lines.
 UPDATE public.profiles SET role_id=manager_role WHERE id=reviewer;
 res:=public.hhee_detail(rid);
 IF (res#>'{lines,0}') ? 'reported_cost' OR (res#>'{lines,0}') ? 'validated_cost'
 OR (res#>'{lines,0}') ? 'estimated_cost' THEN RAISE EXCEPTION 'CAJA C120 FAIL: costo individual a Gerencia'; END IF;
 IF NOT (res->>'needs_exception')::boolean THEN RAISE EXCEPTION 'CAJA C120 FAIL: aprobación tardía no detectada'; END IF;
 SELECT version INTO v FROM public.hhee_requests WHERE id=rid;
 res:=public.hhee_mutate(jsonb_build_object('operation_id',gen_random_uuid(),'action','exception','id',rid,'version',v,'decision','OBSERVADA','reason','Revisar programación y autorización anticipada'));
 IF NOT (res->>'success')::boolean OR NOT EXISTS(SELECT 1 FROM public.hhee_requests WHERE id=rid AND state='VALIDADA') THEN
  RAISE EXCEPTION 'CAJA C120 FAIL: revisión gerencial elimina ejecución %',res; END IF;
 -- Immutable validated facts, explicit HR reopening and preserved private before-image.
 UPDATE public.profiles SET role_id=hr_role WHERE id=reviewer;
 SELECT version INTO v FROM public.hhee_requests WHERE id=rid;
 excel:=jsonb_set(jsonb_set(excel,'{operation_id}',to_jsonb(gen_random_uuid())),'{rows,0,version}',to_jsonb(v));
 excel:=jsonb_set(excel,'{rows,0,cost}','30'::jsonb);
 res:=public.hhee_attendance(excel,false);
 IF jsonb_array_length(res->'errors')=0 THEN RAISE EXCEPTION 'CAJA C120 FAIL: modifica validada'; END IF;
 res:=public.hhee_mutate(jsonb_build_object('operation_id',gen_random_uuid(),'action','reopen','id',rid,'version',v,'reason','Valorización confirmada posteriormente por RRHH'));
 IF NOT (res->>'success')::boolean OR NOT EXISTS(SELECT 1 FROM public.hhee_audit WHERE request_id=rid AND private_data ? 'lines') THEN
  RAISE EXCEPTION 'CAJA C120 FAIL: reapertura sin conservación %',res; END IF;
 SELECT version INTO v FROM public.hhee_requests WHERE id=rid;
 excel:=jsonb_set(excel,'{rows,0,version}',to_jsonb(v))||jsonb_build_object('correction_reason','Valorización posterior conforme al cierre de RRHH');
 res:=public.hhee_attendance(excel,true);
 IF NOT (res->>'applied')::boolean THEN RAISE EXCEPTION 'CAJA C120 FAIL: corregir tras reapertura %',res; END IF;
 SELECT version INTO v FROM public.hhee_requests WHERE id=rid;
 res:=public.hhee_mutate(jsonb_build_object('operation_id',gen_random_uuid(),'action','validate','id',rid,'version',v,'reason','Costo conciliado y resultado confirmado','confirmed_cause_id',cause,'assessment','MEJORABLE'));
 IF NOT (res->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C120 FAIL: revalidación %',res; END IF;
 res:=public.hhee_read(jsonb_build_object('from',workdate,'to',workdate,'area_id',area));
 IF (res#>>'{metrics,validated_cost}')::numeric<>30 OR (res#>>'{metrics,validated_minutes}')::int<>120 OR (res#>>'{metrics,pending_cost}')::int<>0 THEN
  RAISE EXCEPTION 'CAJA C120 FAIL: costo validado consolidado'; END IF;
 UPDATE public.profiles SET role_id=request_role WHERE id=reviewer;
 IF (public.hhee_detail(rid)#>'{lines,0}') ? 'reported_cost' THEN RAISE EXCEPTION 'CAJA C120 FAIL: sueldo visible a solicitante'; END IF;
 UPDATE public.profiles SET is_active=false WHERE id=reviewer;
 IF (public.hhee_read()->>'success')::boolean OR (public.hhee_context()->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C120 FAIL: cuenta inactiva'; END IF;
 -- All new foreign keys have leading indexes and every table is private with restrictive active-account RLS.
 IF EXISTS(SELECT 1 FROM pg_constraint c WHERE c.contype='f' AND c.conrelid::regclass::text LIKE 'hhee_%'
 AND NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.conrelid AND i.indisvalid AND i.indpred IS NULL AND (i.indkey::smallint[])[0:cardinality(c.conkey)-1] @> c.conkey)) THEN
  RAISE EXCEPTION 'CAJA C120 FAIL: FK sin índice'; END IF;
 RAISE EXCEPTION 'CAJA C120 PASS: alcance, independencia, importación atómica, reintentos, aprobación previa, costo pendiente, validación, privacidad y reapertura';
END $test$;
ROLLBACK;
