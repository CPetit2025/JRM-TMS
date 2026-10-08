BEGIN;
CREATE FUNCTION pg_temp.c64_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM set_config('request.jwt.claim.sub',COALESCE(p_user::text,''),true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true);
 PERFORM set_config('role',CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END,true);
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
DO $test$
DECLARE users uuid[]; actor uuid; owner_user uuid; observer uuid; admin_role uuid; owner_role uuid; observer_role uuid;
 personal bigint[]:='{}'; own_admin bigint; shared bigint; hybrid bigint; unassigned bigint; event text; nid bigint; q jsonb; n integer;
 suffix text:=substr(gen_random_uuid()::text,1,8);
BEGIN
 SELECT array_agg(id) INTO users FROM (SELECT id FROM public.profiles WHERE id IN(SELECT id FROM auth.users)
  AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 3) p;
 IF cardinality(users)<3 THEN RAISE EXCEPTION 'CAJA C64 FAIL: faltan tres perfiles de prueba'; END IF;
 actor:=users[1]; owner_user:=users[2]; observer:=users[3];
 SELECT id INTO admin_role FROM public.roles WHERE lower(trim(name)) IN ('administrador','admin') LIMIT 1;
 IF admin_role IS NULL THEN RAISE EXCEPTION 'CAJA C64 FAIL: falta rol administrador'; END IF;
 INSERT INTO public.roles(name,permissions) VALUES('ZZ C64 responsable '||suffix,'[]') RETURNING id INTO owner_role;
 INSERT INTO public.roles(name,permissions) VALUES('ZZ C64 supervisor '||suffix,'["desempeno","mantenimiento-dashboard","despacho"]') RETURNING id INTO observer_role;
 UPDATE public.profiles SET is_active=true,role_id=CASE id WHEN actor THEN admin_role WHEN owner_user THEN owner_role ELSE observer_role END
 WHERE id=ANY(users);
 UPDATE public.notif_state SET last_refresh=now() WHERE id=1;
 DELETE FROM public.notif_prefs WHERE user_id=ANY(users);
 FOREACH event IN ARRAY ARRAY['DESEMPENO_INFORME','DESEMPENO_INFORME_ATRASADO','DESEMPENO_INFORME_REVISADO',
  'CONDUCTOR_DESEMPENO','SOPORTE_INFORME','SOPORTE_INFORME_ATRASADO','SOPORTE_INFORME_REVISADO','FALLA_ASIGNADA'] LOOP
  INSERT INTO public.notifications(evento,categoria,severidad,titulo,permisos,target_user)
  VALUES(event,'CUMPLIMIENTO','crit','ZZ C64 personal '||suffix,ARRAY['desempeno','mantenimiento-dashboard'],owner_user) RETURNING id INTO nid;
  personal:=array_append(personal,nid);
 END LOOP;
 INSERT INTO public.notifications(evento,categoria,severidad,titulo,permisos,target_user)
 VALUES('DESEMPENO_INFORME_ATRASADO','CUMPLIMIENTO','crit','ZZ C64 propio admin '||suffix,ARRAY['desempeno'],actor) RETURNING id INTO own_admin;
 INSERT INTO public.notifications(evento,categoria,severidad,titulo,permisos,target_user)
 VALUES('DESPACHO_PROGRAMADO','DESPACHO','info','ZZ C64 equipo '||suffix,ARRAY['despacho'],NULL) RETURNING id INTO shared;
 INSERT INTO public.notifications(evento,categoria,severidad,titulo,permisos,target_user)
 VALUES('SOLICITUD_APROBADA','TRANSPORTE','info','ZZ C64 híbrido '||suffix,ARRAY['despacho'],owner_user) RETURNING id INTO hybrid;
 INSERT INTO public.notifications(evento,categoria,severidad,titulo,permisos,target_user)
 VALUES('DESEMPENO_INFORME_ATRASADO','CUMPLIMIENTO','crit','ZZ C64 sin destinatario '||suffix,ARRAY['desempeno'],NULL) RETURNING id INTO unassigned;

 PERFORM pg_temp.c64_user(actor);
 SELECT count(*) INTO n FROM public.notifications WHERE id=ANY(personal);
 IF n<>0 THEN RAISE EXCEPTION 'CAJA C64 FAIL: administrador consulta avisos personales ajenos por RLS'; END IF;
 q:=public.notif_list(NULL,200);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(q->'items') x WHERE (x->>'id')::bigint=ANY(personal) OR (x->>'id')::bigint=unassigned)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'items') x WHERE (x->>'id')::bigint=own_admin)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'items') x WHERE (x->>'id')::bigint=shared) THEN
  RAISE EXCEPTION 'CAJA C64 FAIL: feed administrador no respeta responsabilidad/operación'; END IF;
 q:=public.notif_mark_read(personal);
 IF (q->>'marcadas')::integer<>0 THEN RAISE EXCEPTION 'CAJA C64 FAIL: administrador marca informes ajenos'; END IF;

 PERFORM pg_temp.c64_user(observer);
 SELECT count(*) INTO n FROM public.notifications WHERE id=ANY(personal) OR id=unassigned;
 IF n<>0 THEN RAISE EXCEPTION 'CAJA C64 FAIL: permiso supervisor abre informes ajenos'; END IF;
 q:=public.notif_list(NULL,200);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(q->'items') x WHERE (x->>'id')::bigint=ANY(personal) OR (x->>'id')::bigint=own_admin OR (x->>'id')::bigint=unassigned)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'items') x WHERE (x->>'id')::bigint=shared)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'items') x WHERE (x->>'id')::bigint=hybrid) THEN
  RAISE EXCEPTION 'CAJA C64 FAIL: supervisor mezcla informes personales o pierde avisos de equipo'; END IF;

 PERFORM pg_temp.c64_user(owner_user);
 SELECT count(*) INTO n FROM public.notifications WHERE id=ANY(personal);
 IF n<>cardinality(personal) THEN RAISE EXCEPTION 'CAJA C64 FAIL: responsable no recibe sus avisos sin permiso supervisor'; END IF;
 q:=public.notif_list(NULL,200);
 SELECT count(*) INTO n FROM jsonb_array_elements(q->'items') x WHERE (x->>'id')::bigint=ANY(personal) AND (x->>'para_mi')::boolean;
 IF n<>cardinality(personal) OR EXISTS(SELECT 1 FROM jsonb_array_elements(q->'items') x WHERE (x->>'id')::bigint=own_admin OR (x->>'id')::bigint=shared) THEN
  RAISE EXCEPTION 'CAJA C64 FAIL: feed/para_mi del responsable'; END IF;
 q:=public.notif_mark_read(personal);
 IF (q->>'marcadas')::integer<>cardinality(personal) THEN RAISE EXCEPTION 'CAJA C64 FAIL: responsable no puede marcar sus avisos'; END IF;
 q:=public.notif_list(NULL,200);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(q->'items') x WHERE (x->>'id')::bigint=ANY(personal) AND NOT (x->>'leida')::boolean) THEN
  RAISE EXCEPTION 'CAJA C64 FAIL: estado de lectura'; END IF;
 PERFORM pg_temp.c64_user(NULL);
 UPDATE public.profiles SET is_active=false WHERE id=owner_user;
 PERFORM pg_temp.c64_user(owner_user);
 IF EXISTS(SELECT 1 FROM public.notifications WHERE id=ANY(personal)) OR jsonb_array_length(public.notif_list(NULL,200)->'items')<>0 THEN
  RAISE EXCEPTION 'CAJA C64 FAIL: cuenta inactiva recibe notificaciones'; END IF;
 PERFORM pg_temp.c64_user(NULL);
 PERFORM set_config('role','authenticated',true);
 IF EXISTS(SELECT 1 FROM public.notifications) OR jsonb_array_length(COALESCE(public.notif_list(NULL,200)->'items','[]'::jsonb))<>0 THEN
  RAISE EXCEPTION 'CAJA C64 FAIL: notificaciones sin identidad'; END IF;
 IF has_function_privilege('anon','public.notif_can_see_event(text,text[],uuid)','EXECUTE') THEN RAISE EXCEPTION 'CAJA C64 FAIL: helper anónimo'; END IF;
 RAISE EXCEPTION 'CAJA C64 PASS: responsable exclusivo, administrador/supervisor, RLS, feed, lectura, avisos operativos y cuentas inactivas';
END $test$;
ROLLBACK;
