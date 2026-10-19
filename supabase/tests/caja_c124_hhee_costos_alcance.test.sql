-- Distribution isolation, remuneration-based estimates and immutable calculation snapshots.
BEGIN;
SET LOCAL statement_timeout='45s';
DO $test$
DECLARE v_actor uuid; v_reviewer uuid; v_admin uuid; v_role uuid:=gen_random_uuid(); v_site uuid:=gen_random_uuid();
 v_area uuid:=gen_random_uuid(); v_disabled uuid:=gen_random_uuid(); v_person uuid:=gen_random_uuid(); v_cause uuid;
 v_id uuid:=gen_random_uuid(); v_other uuid:=gen_random_uuid(); v_other_seq bigint; v_seq bigint; v_version int; v_data jsonb; v_res jsonb; v_excel jsonb; v_concepts jsonb;
 v_date text:=((now() AT TIME ZONE 'America/Lima')::date-1)::text;
BEGIN
 SELECT id INTO v_admin FROM public.roles WHERE name='Administrador' LIMIT 1;
 SELECT p.id INTO v_actor FROM public.profiles p JOIN auth.users u ON u.id=p.id WHERE p.is_active AND p.role_id=v_admin ORDER BY p.id LIMIT 1;
 SELECT p.id INTO v_reviewer FROM public.profiles p JOIN auth.users u ON u.id=p.id WHERE p.id<>v_actor ORDER BY p.id LIMIT 1;
 IF v_actor IS NULL OR v_reviewer IS NULL THEN RAISE EXCEPTION 'CAJA C124 FAIL: faltan actores'; END IF;
 INSERT INTO public.roles(id,name,permissions) VALUES(v_role,'C124-manager-'||v_role,'["hhee-gerencia:read","hhee-excepciones:write"]');
 INSERT INTO public.sites(id,code,name) VALUES(v_site,'C124-'||v_site,'C124 sede');
 INSERT INTO public.user_site_access(user_id,site_id) VALUES(v_actor,v_site),(v_reviewer,v_site) ON CONFLICT DO NOTHING;
 INSERT INTO public.hhee_areas(id,site_id,name,module_enabled) VALUES(v_area,v_site,'C124 Distribución',true),(v_disabled,v_site,'C124 otra área',false);
 INSERT INTO public.hhee_people(id,code,name,area_id,estimated_hour_cost,profile_id) VALUES(v_person,upper('C124-'||v_person::text),'C124 trabajador',v_area,99,v_actor);
 SELECT id INTO v_cause FROM public.hhee_causes WHERE active LIMIT 1;
 UPDATE public.profiles SET role_id=v_admin,is_active=true WHERE id=v_actor;
 UPDATE public.profiles SET role_id=v_role,is_active=true WHERE id=v_reviewer;
 PERFORM set_config('request.jwt.claim.sub',v_reviewer::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_reviewer,'role','authenticated')::text,true);
 IF (public.hhee_context()->>'success')::boolean OR public.hhee_can(v_area) OR public.hhee_can(v_area,'exception') THEN
  RAISE EXCEPTION 'CAJA C124 FAIL: Gerencia sin vinculación accede por rol'; END IF;
 INSERT INTO public.hhee_memberships VALUES(v_reviewer,v_area),(v_reviewer,v_disabled);
 IF NOT public.hhee_can(v_area) OR public.hhee_can(v_disabled) OR public.hhee_can(v_disabled,'exception') THEN
  RAISE EXCEPTION 'CAJA C124 FAIL: aislamiento de área habilitada'; END IF;
 DELETE FROM public.user_site_access WHERE user_id=v_reviewer AND site_id=v_site;
 IF public.hhee_can(v_area) THEN RAISE EXCEPTION 'CAJA C124 FAIL: vinculación sustituye alcance de sede'; END IF;
 INSERT INTO public.user_site_access VALUES(v_reviewer,v_site);
 PERFORM set_config('request.jwt.claim.sub',v_actor::text,true);
 IF public.hhee_can(v_disabled) THEN RAISE EXCEPTION 'CAJA C124 FAIL: área deshabilitada participa incluso como admin'; END IF;
 IF (SELECT base_hour_cost FROM public.hhee_people WHERE id=v_person) IS NOT NULL THEN RAISE EXCEPTION 'CAJA C124 FAIL: tarifa integral antigua reinterpretada'; END IF;
 v_concepts:='[{"name":"Básico","amount":2400,"computable":true},{"name":"Asignación","amount":240,"computable":true},{"name":"Movilidad","amount":360,"computable":false}]';
 v_res:=public.hhee_mutate(jsonb_build_object('operation_id',gen_random_uuid(),'action','person','code',upper('C124-'||v_person::text),'name','C124 trabajador','area_id',v_area,'monthly_hours',240,'remuneration_concepts',v_concepts));
 IF NOT (v_res->>'success')::boolean OR (SELECT base_hour_cost FROM public.hhee_people WHERE id=v_person)<>11 OR (SELECT profile_id FROM public.hhee_people WHERE id=v_person) IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'CAJA C124 FAIL: base remunerativa %',v_res; END IF;
 v_res:=public.hhee_mutate(jsonb_build_object('operation_id',gen_random_uuid(),'action','person','code',upper('C124-'||v_person::text),'name','C124 trabajador','area_id',v_area,'monthly_hours',0,'remuneration_concepts',v_concepts));
 IF (v_res->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C124 FAIL: divisor cero aceptado'; END IF;
 v_res:=public.hhee_mutate(jsonb_build_object('operation_id',gen_random_uuid(),'action','save_request','id',v_id,'area_id',v_area,'cause_id',v_cause,'work_date',v_date,'activity','C124 despacho programado','justification','Necesidad excepcional de distribución','alternatives','Coordinación de horarios evaluada','expected_result','Completar despacho de prueba','lines',jsonb_build_array(jsonb_build_object('person_id',v_person,'planned_start',v_date||'T18:00','planned_end',v_date||'T21:00','planned_break',0))));
 IF NOT (v_res->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C124 FAIL: solicitud %',v_res; END IF;
 v_res:=public.hhee_mutate(jsonb_build_object('operation_id',gen_random_uuid(),'action','submit','id',v_id,'version',1));
 IF NOT (v_res->>'success')::boolean OR EXISTS(SELECT 1 FROM public.hhee_lines WHERE request_id=v_id AND estimated_cost IS NOT NULL) THEN RAISE EXCEPTION 'CAJA C124 FAIL: costo inventado antes de clasificar'; END IF;
 SELECT sequence,version INTO v_seq,v_version FROM public.hhee_requests WHERE id=v_id;
 v_excel:=jsonb_build_object('operation_id',gen_random_uuid(),'file_name','C124.xlsx','file_hash',repeat('c',64),'rows',jsonb_build_array(jsonb_build_object('request_code','HE-'||lpad(v_seq::text,6,'0'),'person_code',upper('C124-'||v_person::text),'version',v_version,'start',v_date||'T18:00','end',v_date||'T21:00','break_minutes',0,'recognized_minutes',180,'normal_minutes',480,'minutes_25',60,'minutes_35',60,'minutes_100',60,'consent',true,'result','Despacho culminado con conformidad')));
 v_res:=public.hhee_attendance(jsonb_set(v_excel,'{rows,0,minutes_35}','59'),false);
 IF jsonb_array_length(v_res->'errors')<>1 THEN RAISE EXCEPTION 'CAJA C124 FAIL: categorías no cuadran'; END IF;
 v_res:=public.hhee_attendance(jsonb_set(v_excel,'{rows,0,cost}','1'),false);
 IF jsonb_array_length(v_res->'errors')<>1 THEN RAISE EXCEPTION 'CAJA C124 FAIL: reemplaza costo de ficha por importe manual'; END IF;
 v_res:=public.hhee_attendance(jsonb_set(v_excel,'{rows,0,base_hour_cost}','1'),false);
 IF jsonb_array_length(v_res->'errors')<>1 THEN RAISE EXCEPTION 'CAJA C124 FAIL: reemplaza tarifa de ficha desde asistencia'; END IF;
 v_res:=public.hhee_attendance(v_excel,false);
 IF jsonb_array_length(v_res->'errors')<>0 OR (v_res#>>'{rows,0,cost}')::numeric<>50.60 OR (v_res#>>'{rows,0,normal_cost}')::numeric<>88 THEN
  RAISE EXCEPTION 'CAJA C124 FAIL: cálculo aprox con recargos y normal separados %',v_res; END IF;
 v_res:=public.hhee_attendance(v_excel,true);
 IF NOT (v_res->>'applied')::boolean THEN RAISE EXCEPTION 'CAJA C124 FAIL: aplicar %',v_res; END IF;
 -- Ordinary reference hours cannot be counted twice for a person/day across requests.
 v_res:=public.hhee_mutate(jsonb_build_object('operation_id',gen_random_uuid(),'action','save_request','id',v_other,'area_id',v_area,'cause_id',v_cause,'work_date',v_date,'activity','C124 segundo despacho','justification','Necesidad excepcional de distribución','alternatives','Coordinación de horarios evaluada','expected_result','Completar otro despacho de prueba','lines',jsonb_build_array(jsonb_build_object('person_id',v_person,'planned_start',v_date||'T22:00','planned_end',v_date||'T23:00','planned_break',0))));
 IF NOT (v_res->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C124 FAIL: segunda solicitud %',v_res; END IF;
 v_res:=public.hhee_mutate(jsonb_build_object('operation_id',gen_random_uuid(),'action','submit','id',v_other,'version',1));
 SELECT sequence INTO v_other_seq FROM public.hhee_requests WHERE id=v_other;
 v_data:=jsonb_set(v_excel,'{rows,0,request_code}',to_jsonb('HE-'||lpad(v_other_seq::text,6,'0')));
 v_data:=jsonb_set(jsonb_set(v_data,'{rows,0,start}',to_jsonb(v_date||'T22:00')),'{rows,0,end}',to_jsonb(v_date||'T23:00'));
 v_data:=jsonb_set(jsonb_set(jsonb_set(v_data,'{rows,0,recognized_minutes}','60'),'{rows,0,minutes_35}','0'),'{rows,0,minutes_100}','0');
 v_res:=public.hhee_attendance(v_data,false);
 IF jsonb_array_length(v_res->'errors')<>1 OR v_res#>>'{errors,0,error}' NOT LIKE 'Las horas normales%' THEN RAISE EXCEPTION 'CAJA C124 FAIL: duplicó horas normales %',v_res; END IF;
 -- A salary change must not silently rewrite attendance cost or its stored remuneration basis.
 v_res:=public.hhee_mutate(jsonb_build_object('operation_id',gen_random_uuid(),'action','person','code',upper('C124-'||v_person::text),'name','C124 trabajador','area_id',v_area,'monthly_hours',240,'remuneration_concepts',jsonb_set(v_concepts,'{0,amount}','4800')));
 IF NOT (v_res->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C124 FAIL: actualización de ficha %',v_res; END IF;
 SELECT version INTO v_version FROM public.hhee_requests WHERE id=v_id;
 v_excel:=jsonb_set(jsonb_set(v_excel,'{operation_id}',to_jsonb(gen_random_uuid())),'{rows,0,version}',to_jsonb(v_version));
 v_res:=public.hhee_attendance(v_excel,false);
 IF NOT (v_res#>>'{rows,0,duplicate}')::boolean OR (v_res#>>'{rows,0,cost}')::numeric<>50.60
 OR (SELECT rate_basis#>>'{concepts,0,amount}' FROM public.hhee_lines WHERE request_id=v_id)<>'2400' THEN
  RAISE EXCEPTION 'CAJA C124 FAIL: cambio de ficha alteró historia %',v_res; END IF;
 -- Explicit revaluation requires correction justification; validated records still require reopening.
 v_excel:=v_excel||jsonb_build_object('refresh_rates',true);
 v_res:=public.hhee_attendance(v_excel,false);
 IF jsonb_array_length(v_res->'errors')<>1 THEN RAISE EXCEPTION 'CAJA C124 FAIL: revalorización sin motivo'; END IF;
 v_excel:=v_excel||jsonb_build_object('correction_reason','Recalcular expresamente con ficha remunerativa vigente');
 v_res:=public.hhee_attendance(v_excel,true);
 IF NOT (v_res->>'applied')::boolean OR (v_res#>>'{rows,0,cost}')::numeric<>96.60 THEN RAISE EXCEPTION 'CAJA C124 FAIL: revalorización explícita %',v_res; END IF;
 SELECT version INTO v_version FROM public.hhee_requests WHERE id=v_id;
 v_res:=public.hhee_mutate(jsonb_build_object('operation_id',gen_random_uuid(),'action','validate','id',v_id,'version',v_version,'reason','Asistencia y categorías contrastadas','confirmed_cause_id',v_cause,'assessment','JUSTIFICADA'));
 IF NOT (v_res->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C124 FAIL: validar %',v_res; END IF;
 v_res:=public.hhee_read(jsonb_build_object('area_id',v_area,'from',v_date,'to',v_date));
 IF (v_res#>>'{metrics,validated_minutes}')::int<>180 OR (v_res#>>'{metrics,normal_minutes}')::int<>480
 OR (v_res#>>'{metrics,minutes_25}')::int<>60 OR (v_res#>>'{metrics,minutes_35}')::int<>60 OR (v_res#>>'{metrics,minutes_100}')::int<>60
 OR (v_res#>>'{metrics,validated_cost}')::numeric<>96.60 OR (v_res#>>'{metrics,normal_estimated_cost}')::numeric<>168 THEN
  RAISE EXCEPTION 'CAJA C124 FAIL: agregados mezclan jornada normal con HHEE %',v_res->'metrics'; END IF;
 PERFORM set_config('request.jwt.claim.sub',v_reviewer::text,true);
 v_data:=public.hhee_detail(v_id);
 IF (v_data#>'{lines,0}') ?| ARRAY['base_hour_cost','rate_basis','reported_cost','normal_estimated_cost'] THEN RAISE EXCEPTION 'CAJA C124 FAIL: conceptos individuales filtrados a Gerencia'; END IF;
 v_data:=public.hhee_context();
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_data->'people') x WHERE x->>'base_hour_cost' IS NOT NULL OR x->>'remuneration_concepts' IS NOT NULL) THEN
  RAISE EXCEPTION 'CAJA C124 FAIL: tarifa o conceptos a Gerencia'; END IF;
 DELETE FROM public.hhee_memberships WHERE user_id=v_reviewer AND area_id=v_area;
 IF (public.hhee_detail(v_id)->>'success')::boolean OR (public.hhee_read()->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C124 FAIL: revocación sin efecto'; END IF;
 -- A receipt must not leak private HR preview rows after the permission was removed.
 PERFORM set_config('request.jwt.claim.sub',v_actor::text,true);
 UPDATE public.profiles SET role_id=v_role WHERE id=v_actor;
 v_res:=public.hhee_attendance(v_excel,true);
 IF (v_res->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C124 FAIL: recibo idempotente elude revocación RRHH'; END IF;
 RAISE EXCEPTION 'CAJA C124 PASS: aislamiento, conceptos remunerativos privados, recargos, horas normales separadas, cálculo aproximado y snapshots';
END $test$;
ROLLBACK;
