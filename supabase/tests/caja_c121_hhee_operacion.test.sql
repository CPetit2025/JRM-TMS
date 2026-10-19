-- Operational edge cases: overlaps, unapproved work, nonattendance, recurrence and independent action verification.
BEGIN;
SET LOCAL statement_timeout='45s';
DO $test$
DECLARE actor uuid; reviewer uuid; admin_role uuid; site uuid:=gen_random_uuid(); area uuid:=gen_random_uuid(); person uuid:=gen_random_uuid(); cause uuid;
 ids uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()]; rid uuid; lid uuid; seq bigint; v int; i int; result jsonb; excel jsonb; row_data jsonb; aid uuid;
 workdate text:=((now() AT TIME ZONE 'America/Lima')::date-1)::text; person_code text:=upper('C121-'||person::text);
BEGIN
 SELECT id INTO admin_role FROM public.roles WHERE name='Administrador' LIMIT 1;
 SELECT p.id INTO actor FROM public.profiles p JOIN auth.users u ON u.id=p.id WHERE p.is_active AND p.role_id=admin_role ORDER BY p.id LIMIT 1;
 SELECT p.id INTO reviewer FROM public.profiles p JOIN auth.users u ON u.id=p.id WHERE p.id<>actor ORDER BY p.id LIMIT 1;
 IF actor IS NULL OR reviewer IS NULL THEN RAISE EXCEPTION 'CAJA C121 FAIL: faltan actores'; END IF;
 UPDATE public.profiles SET role_id=admin_role,is_active=true WHERE id=reviewer;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
 INSERT INTO public.sites(id,code,name) VALUES(site,'C121-'||site,'C121 sede');
 INSERT INTO public.hhee_areas(id,site_id,name) VALUES(area,site,'C121 área');
 INSERT INTO public.hhee_people(id,code,name,area_id) VALUES(person,person_code,'C121 trabajador',area);
 SELECT id INTO cause FROM public.hhee_causes WHERE active LIMIT 1;
 UPDATE public.hhee_settings SET recurrence_days=28,recurrence_events=2 WHERE id=1;
 FOR i IN 1..3 LOOP
  rid:=ids[i];
  result:=public.hhee_mutate(jsonb_build_object('action','save_request','operation_id',gen_random_uuid(),'id',rid,'area_id',area,'cause_id',cause,
   'work_date',workdate,'activity','C121 trabajo previsto','justification','Necesidad operativa y justificación de prueba','alternatives','Alternativas de coordinación evaluadas','expected_result','Resultado esperado de prueba',
   'lines',jsonb_build_array(jsonb_build_object('person_id',person,'planned_start',workdate||'T18:00','planned_end',workdate||'T20:00','planned_break',0))));
  IF NOT (result->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C121 FAIL: creación %',result; END IF;
  result:=public.hhee_mutate(jsonb_build_object('action','submit','operation_id',gen_random_uuid(),'id',rid,'version',1));
  IF NOT (result->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C121 FAIL: presentación %',result; END IF;
 END LOOP;
 SELECT id INTO lid FROM public.hhee_lines WHERE request_id=ids[1];
 result:=public.hhee_mutate(jsonb_build_object('action','decide','operation_id',gen_random_uuid(),'id',ids[1],'version',2,'decision','APROBADA','reason','Aprobación propia no permitida','lines',jsonb_build_array(jsonb_build_object('id',lid,'approved_minutes',120))));
 IF (result->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C121 FAIL: autoaprobación sin excepción'; END IF;
 PERFORM set_config('request.jwt.claim.sub',reviewer::text,true);
 result:=public.hhee_mutate(jsonb_build_object('action','decide','operation_id',gen_random_uuid(),'id',ids[1],'version',2,'decision','APROBADA','reason','Necesidad autorizada por responsable independiente','lines',jsonb_build_array(jsonb_build_object('id',lid,'approved_minutes',120))));
 IF NOT (result->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C121 FAIL: aprobar primera %',result; END IF;
 -- Fixture timestamp models genuinely prior authorization.
 UPDATE public.hhee_requests SET approved_at=(workdate||'T17:00-05:00')::timestamptz WHERE id=ids[1];
 SELECT id INTO lid FROM public.hhee_lines WHERE request_id=ids[2];
 result:=public.hhee_mutate(jsonb_build_object('action','decide','operation_id',gen_random_uuid(),'id',ids[2],'version',2,'decision','APROBADA','reason','Intento de autorización superpuesta','lines',jsonb_build_array(jsonb_build_object('id',lid,'approved_minutes',120))));
 IF (result->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C121 FAIL: doble aprobación superpuesta'; END IF;
 FOR i IN 1..3 LOOP
  rid:=ids[i];SELECT sequence,version INTO seq,v FROM public.hhee_requests WHERE id=rid;
  row_data:=jsonb_build_object('request_code','HE-'||lpad(seq::text,6,'0'),'person_code',person_code,
   'start',workdate||CASE i WHEN 1 THEN 'T18:00' WHEN 2 THEN 'T22:00' ELSE 'T23:30' END,
   'end',workdate||CASE i WHEN 1 THEN 'T20:00' WHEN 2 THEN 'T23:00' ELSE 'T23:30' END,
   'break_minutes',0,'recognized_minutes',CASE i WHEN 1 THEN 120 WHEN 2 THEN 60 ELSE 0 END,
   'cost',CASE i WHEN 1 THEN 50 WHEN 2 THEN NULL ELSE 0 END,'consent',i<>3,
   'result',CASE WHEN i=3 THEN 'No se requirió trabajo extraordinario' ELSE 'Trabajo operativo completado conforme' END,'version',v);
  excel:=jsonb_build_object('operation_id',gen_random_uuid(),'file_name','C121-RRHH.xlsx','file_hash',repeat('b',64),'rows',jsonb_build_array(row_data));
  IF i=2 THEN
   result:=public.hhee_attendance(jsonb_set(jsonb_set(excel,'{rows,0,start}',to_jsonb(workdate||'T19:00')),'{rows,0,end}',to_jsonb(workdate||'T20:00')),false);
   IF jsonb_array_length(result->'errors')=0 THEN RAISE EXCEPTION 'CAJA C121 FAIL: no detecta ejecución superpuesta'; END IF;
  END IF;
  result:=public.hhee_attendance(excel,true);
  IF NOT COALESCE((result->>'applied')::boolean,false) THEN RAISE EXCEPTION 'CAJA C121 FAIL: importación %: %',i,result; END IF;
  SELECT version INTO v FROM public.hhee_requests WHERE id=rid;
  result:=public.hhee_mutate(jsonb_build_object('action','validate','operation_id',gen_random_uuid(),'id',rid,'version',v,'reason','Asistencia y resultado contrastados con RRHH','confirmed_cause_id',cause,'assessment','JUSTIFICADA'));
  IF NOT (result->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C121 FAIL: validación %: %',i,result; END IF;
 END LOOP;
 result:=public.hhee_read(jsonb_build_object('area_id',area,'from',workdate,'to',workdate));
 IF (result#>>'{metrics,validated_minutes}')::int<>180 OR (result#>>'{metrics,executed_requests}')::int<>2
 OR (result#>>'{metrics,prior_requests}')::int<>1 OR (result#>>'{metrics,pending_exceptions}')::int<>1
 OR (result#>>'{metrics,validated_cost}')::numeric<>50 OR (result#>>'{metrics,pending_cost}')::int<>1
 OR (result#>>'{metrics,recurrent_minutes}')::int<>180 OR (result#>>'{metrics,justified_minutes}')::int<>180 THEN
 RAISE EXCEPTION 'CAJA C121 FAIL: realidad operativa / recurrencia / necesidad %',result->'metrics'; END IF;
 result:=public.hhee_mutate(jsonb_build_object('action','action_save','operation_id',gen_random_uuid(),'area_id',area,'cause_id',cause,'title','Revisar planificación para evitar recurrencia','assigned_to',reviewer,'due_date',workdate));
 IF NOT (result->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C121 FAIL: nueva acción %',result; END IF;
 SELECT id INTO aid FROM public.hhee_actions WHERE area_id=area LIMIT 1;
 result:=public.hhee_mutate(jsonb_build_object('action','action_update','operation_id',gen_random_uuid(),'id',aid,'version',1,'state','REALIZADA','reason','Se coordinó la planificación y capacidad'));
 IF NOT (result->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C121 FAIL: completar acción %',result; END IF;
 result:=public.hhee_mutate(jsonb_build_object('action','action_update','operation_id',gen_random_uuid(),'id',aid,'version',2,'state','VERIFICADA','reason','Verificación propia no debe aceptarse','effective',true));
 IF (result->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C121 FAIL: autoverificación'; END IF;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 result:=public.hhee_mutate(jsonb_build_object('action','action_update','operation_id',gen_random_uuid(),'id',aid,'version',2,'state','VERIFICADA','reason','Se verificó la efectividad de la medida','effective',true));
 IF NOT (result->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C121 FAIL: verificar por otro responsable %',result; END IF;
 RAISE EXCEPTION 'CAJA C121 PASS: intervalos, ejecución sin aprobación, ausencia sin horas ficticias, ratios, recurrencia independiente y acciones verificadas';
END $test$;
ROLLBACK;
