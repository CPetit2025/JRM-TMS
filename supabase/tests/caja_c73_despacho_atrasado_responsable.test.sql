BEGIN;
CREATE FUNCTION pg_temp.c73_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM set_config('request.jwt.claim.sub',COALESCE(p_user::text,''),true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true);
 PERFORM set_config('role',CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END,true);
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
DO $test$
DECLARE users uuid[]; admin_user uuid; owner_user uuid; observer uuid; admin_role uuid; desp_role uuid;
 d_owned uuid; d_orphan uuid:=gen_random_uuid(); d_inactive uuid; real_ids uuid[]; owned bigint; orphan bigint; q jsonb; t uuid;
 suffix text:=substr(gen_random_uuid()::text,1,8);
BEGIN
 SELECT array_agg(id) INTO users FROM (SELECT id FROM public.profiles WHERE id IN(SELECT id FROM auth.users)
  AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 3) p;
 IF cardinality(users)<3 THEN RAISE EXCEPTION 'CAJA C73 FAIL: faltan tres perfiles de prueba'; END IF;
 admin_user:=users[1]; owner_user:=users[2]; observer:=users[3];
 SELECT id INTO admin_role FROM public.roles WHERE lower(trim(name)) IN ('administrador','admin') LIMIT 1;
 IF admin_role IS NULL THEN RAISE EXCEPTION 'CAJA C73 FAIL: falta rol administrador'; END IF;
 INSERT INTO public.roles(name,permissions) VALUES('ZZ C73 despacho '||suffix,'["despacho:write","torre-control:read"]') RETURNING id INTO desp_role;
 UPDATE public.profiles SET is_active=true,role_id=CASE id WHEN admin_user THEN admin_role ELSE desp_role END WHERE id=ANY(users);
 UPDATE public.notif_state SET last_refresh=now() WHERE id=1;
 -- En producción kpi_dispatch_log exige un despacho existente: se usan dos despachos reales con registros
 -- fechados en 1900 (quedan como los primeros) y todo se revierte al final; sin despachos se usan ids libres.
 SELECT array_agg(id) INTO real_ids FROM (SELECT id FROM public.dispatches ORDER BY id LIMIT 2) d;
 IF COALESCE(cardinality(real_ids),0)<2 AND EXISTS(SELECT 1 FROM pg_constraint
   WHERE conrelid='public.kpi_dispatch_log'::regclass AND confrelid='public.dispatches'::regclass AND contype='f') THEN
  RAISE EXCEPTION 'CAJA C73 FAIL: se requieren dos despachos existentes para la prueba';
 END IF;
 d_owned:=COALESCE(real_ids[1],gen_random_uuid()); d_inactive:=COALESCE(real_ids[2],gen_random_uuid());
 DELETE FROM public.notif_prefs WHERE user_id=ANY(users);

 -- Quien programó el despacho queda en el historial de estados
 INSERT INTO public.kpi_dispatch_log(id,dispatch_id,estado_nuevo,by,at,origen) OVERRIDING SYSTEM VALUE
 VALUES((SELECT COALESCE(max(id),0)+1 FROM public.kpi_dispatch_log),d_owned,'PROGRAMADO',owner_user,'1900-01-01','SISTEMA');
 INSERT INTO public.notifications(evento,categoria,severidad,titulo,permisos,dedupe_key)
 VALUES('DESPACHO_ATRASADO','DESPACHO','crit','ZZ C73 atrasado '||suffix,ARRAY['despacho','torre-control','solicitudes'],
  'desp-late-'||d_owned||'-c73-'||suffix) RETURNING id,target_user INTO owned,t;
 IF t IS DISTINCT FROM owner_user THEN RAISE EXCEPTION 'CAJA C73 FAIL: el aviso no se asigna al responsable (T1)'; END IF;
 INSERT INTO public.notifications(evento,categoria,severidad,titulo,permisos,dedupe_key)
 VALUES('DESPACHO_ATRASADO','DESPACHO','crit','ZZ C73 sin responsable '||suffix,ARRAY['despacho','torre-control','solicitudes'],
  'desp-late-'||d_orphan||'-c73-'||suffix) RETURNING id,target_user INTO orphan,t;
 IF t IS NOT NULL THEN RAISE EXCEPTION 'CAJA C73 FAIL: responsable inventado (T2)'; END IF;
 -- Quien programó fue desactivado: no se pasa el aviso a quien cambió el estado después
 INSERT INTO public.kpi_dispatch_log(id,dispatch_id,estado_nuevo,by,at,origen) OVERRIDING SYSTEM VALUE
 VALUES((SELECT COALESCE(max(id),0)+1 FROM public.kpi_dispatch_log),d_inactive,'PROGRAMADO',owner_user,'1900-01-01','SISTEMA');
 INSERT INTO public.kpi_dispatch_log(id,dispatch_id,estado_anterior,estado_nuevo,by,at,origen) OVERRIDING SYSTEM VALUE
 VALUES((SELECT COALESCE(max(id),0)+1 FROM public.kpi_dispatch_log),d_inactive,'PROGRAMADO','EN_CURSO',observer,'1900-01-02','SISTEMA');
 UPDATE public.profiles SET is_active=false WHERE id=owner_user;
 IF public.notif_dispatch_owner(d_inactive) IS NOT NULL THEN RAISE EXCEPTION 'CAJA C73 FAIL: se reasigna a quien no programó (T2)'; END IF;
 UPDATE public.profiles SET is_active=true WHERE id=owner_user;
 IF public.notif_dispatch_owner(d_inactive) IS DISTINCT FROM owner_user THEN RAISE EXCEPTION 'CAJA C73 FAIL: primer autor (T2)'; END IF;

 PERFORM pg_temp.c73_user(owner_user);
 q:=public.notif_list(NULL,200);
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'items') x WHERE (x->>'id')::bigint=owned)
  OR NOT EXISTS(SELECT 1 FROM public.notifications WHERE id=owned) THEN
  RAISE EXCEPTION 'CAJA C73 FAIL: el responsable no ve su despacho atrasado (T3)'; END IF;

 PERFORM pg_temp.c73_user(observer);
 q:=public.notif_list(NULL,200);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(q->'items') x WHERE (x->>'id')::bigint=owned)
  OR EXISTS(SELECT 1 FROM public.notifications WHERE id=owned) THEN
  RAISE EXCEPTION 'CAJA C73 FAIL: otro usuario de Despacho ve el atraso ajeno (T4)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'items') x WHERE (x->>'id')::bigint=orphan) THEN
  RAISE EXCEPTION 'CAJA C73 FAIL: sin responsable el atraso queda sin aviso (T5)'; END IF;
 IF (public.notif_mark_read(ARRAY[owned])->>'marcadas')::integer<>0 THEN RAISE EXCEPTION 'CAJA C73 FAIL: marca atraso ajeno (T5)'; END IF;

 PERFORM pg_temp.c73_user(admin_user);
 q:=public.notif_list(NULL,200);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(q->'items') x WHERE (x->>'id')::bigint=owned) THEN
  RAISE EXCEPTION 'CAJA C73 FAIL: el administrador ve el atraso de otro responsable (T6)'; END IF;
 PERFORM pg_temp.c73_user(NULL);
 IF has_function_privilege('authenticated','public.notif_dispatch_owner(uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C73 FAIL: función de responsable expuesta (T7)'; END IF;
 RAISE EXCEPTION 'CAJA C73 PASS (7/7) despacho atrasado solo para su responsable';
END $test$;
ROLLBACK;
