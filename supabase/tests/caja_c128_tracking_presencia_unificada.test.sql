-- Presence must unite authorized internal/external viewers without leaking another client or credential.
-- All records are synthetic and every mutation is rolled back by the terminal PASS exception.
BEGIN;
SET LOCAL statement_timeout='60s';
DO $test$
DECLARE
 v_actor uuid;v_other uuid;v_admin uuid;v_role uuid:=gen_random_uuid();v_site uuid:=gen_random_uuid();v_elsewhere uuid:=gen_random_uuid();
 v_scope uuid:=gen_random_uuid();v_other_scope uuid:=gen_random_uuid();v_client_session uuid:=gen_random_uuid();v_other_pin text;v_payload jsonb;v_tok uuid;v_pin text;v_other_tok uuid;v_else_tok uuid;
 v_internal jsonb;v_public jsonb;v_view jsonb;v_again jsonb;v_count int;v_before int;v_internal_id uuid;v_public_id uuid;
BEGIN
 SELECT id INTO v_admin FROM public.roles WHERE name='Administrador' LIMIT 1;
 SELECT p.id INTO v_actor FROM public.profiles p JOIN auth.users u ON u.id=p.id WHERE p.is_active AND p.role_id=v_admin ORDER BY p.id LIMIT 1;
 SELECT p.id INTO v_other FROM public.profiles p JOIN auth.users u ON u.id=p.id WHERE p.id<>v_actor ORDER BY p.id LIMIT 1;
 IF v_actor IS NULL OR v_other IS NULL THEN RAISE EXCEPTION 'CAJA C128 FAIL: faltan actores'; END IF;
 INSERT INTO public.roles(id,name,permissions) VALUES(v_role,'C128-reader-'||v_role,'["seguimiento:read"]');
 UPDATE public.profiles SET role_id=v_role,is_active=true WHERE id=v_other;
 INSERT INTO public.sites(id,code,name) VALUES(v_site,'C128-'||v_site,'C128 sede'),(v_elsewhere,'C128-'||v_elsewhere,'C128 otra sede');
 INSERT INTO public.user_site_access(user_id,site_id) VALUES(v_actor,v_site),(v_other,v_site) ON CONFLICT DO NOTHING;
 PERFORM set_config('request.jwt.claim.sub',v_actor::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_actor,'role','authenticated')::text,true);
 v_payload:=public.generate_tracking_portal_link(jsonb_build_object('site_id',v_site));v_tok:=(v_payload->>'token')::uuid;v_pin:=v_payload->>'pin';
 v_payload:=public.generate_tracking_portal_link(jsonb_build_object('site_id',v_site));v_other_tok:=(v_payload->>'token')::uuid;v_other_pin:=v_payload->>'pin';
 UPDATE public.tracking_portal_links SET client_ids=ARRAY[v_scope] WHERE token=v_tok;
 UPDATE public.tracking_portal_links SET client_ids=ARRAY[v_other_scope] WHERE token=v_other_tok;
 v_payload:=public.generate_tracking_portal_link(jsonb_build_object('site_id',v_elsewhere));v_else_tok:=(v_payload->>'token')::uuid;
 -- A genuine internal opening uses verified account identity, while refresh and another tab reuse the presence episode.
 PERFORM set_config('request.jwt.claim.sub',v_other::text,true);
 v_internal:=public.get_internal_tracking_view(v_site,current_date,current_date);
 IF v_internal ? 'error' THEN RAISE EXCEPTION 'CAJA C128 FAIL: abrir interno %',v_internal; END IF;
 v_internal_id:=(v_internal->>'viewer_id')::uuid;
 v_again:=public.get_internal_tracking_view(v_site,current_date,current_date,v_internal_id);
 IF (v_again->>'viewer_id')::uuid IS DISTINCT FROM v_internal_id THEN RAISE EXCEPTION 'CAJA C128 FAIL: refresh pierde sesión interna'; END IF;
 -- An authenticated reader must never inspect another site.
 IF NOT(public.get_internal_tracking_view(v_elsewhere,current_date,current_date) ? 'error') THEN RAISE EXCEPTION 'CAJA C128 FAIL: usuario lee otra sede'; END IF;
 PERFORM set_config('request.jwt.claim.sub','',true);
 PERFORM set_config('request.jwt.claims','{"role":"anon"}',true);
 SELECT count(*) INTO v_before FROM public.notifications WHERE target_user=v_actor;
 v_public:=public.tracking_portal_sign_in_session(v_tok,v_pin,'C128 Ana Pérez',v_client_session);
 IF v_public ? 'error' THEN RAISE EXCEPTION 'CAJA C128 FAIL: ingreso público %',v_public; END IF;
 v_public_id:=(v_public->>'viewer_id')::uuid;
 v_view:=public.get_public_tracking_portal_view(v_tok,v_pin,v_public_id,current_date,current_date);
 IF v_view ? 'error' OR (v_view->>'active_count')::int IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'CAJA C128 FAIL: públicos e internos no unificados %',v_view; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_view->'viewers') x WHERE COALESCE((x->>'identity_verified')::boolean,false))
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_view->'viewers') x WHERE NOT COALESCE((x->>'identity_verified')::boolean,true)) THEN RAISE EXCEPTION 'CAJA C128 FAIL: no distingue identidad verificada de nombre declarado %',v_view->'viewers'; END IF;
 -- Presence metadata must contain only display fields; a public observer cannot obtain IDs or account contact details.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_view->'viewers') x WHERE x ?| ARRAY['email','user_id','portal_token','token','pin','pin_hash','profile_id'])
 OR jsonb_array_length(COALESCE(v_view->'presence_events','[]'))<>0 THEN RAISE EXCEPTION 'CAJA C128 FAIL: presencia pública filtra datos privados'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_view->'viewers') x WHERE x->>'id' IN(v_public_id::text,v_internal_id::text)) THEN RAISE EXCEPTION 'CAJA C128 FAIL: indicador expone identificador de sesión reutilizable'; END IF;
 SELECT count(*) INTO v_count FROM public.notifications WHERE target_user=v_actor;
 IF v_count IS DISTINCT FROM v_before+1 THEN RAISE EXCEPTION 'CAJA C128 FAIL: ingreso no notifica al responsable o duplica %/%',v_before,v_count; END IF;
 -- Refresh and a second same-name tab are heartbeats, not new entries.
 PERFORM public.get_public_tracking_portal_view(v_tok,v_pin,v_public_id,current_date,current_date);
 PERFORM public.tracking_portal_sign_in_session(v_tok,v_pin,'C128 Ana Pérez',v_client_session);
 IF (SELECT count(*) FROM public.notifications WHERE target_user=v_actor) IS DISTINCT FROM v_count THEN RAISE EXCEPTION 'CAJA C128 FAIL: refresh o pestaña duplican aviso'; END IF;
 v_again:=public.tracking_portal_sign_in_session(v_tok,v_pin,'C128 Ana Pérez',gen_random_uuid());
 IF v_again ? 'error' OR (v_again->>'viewer_id')::uuid=v_public_id THEN RAISE EXCEPTION 'CAJA C128 FAIL: confunde homónimos con la misma sesión'; END IF;
 v_view:=public.get_public_tracking_portal_view(v_tok,v_pin,v_public_id,current_date,current_date);
 IF (SELECT count(*) FROM jsonb_array_elements(v_view->'viewers') x WHERE x->>'name'='C128 Ana Pérez') IS DISTINCT FROM 2::bigint THEN RAISE EXCEPTION 'CAJA C128 FAIL: indicador agrupa dos personas homónimas'; END IF;
 v_count:=v_count+1;
 UPDATE public.tracking_portal_viewers SET last_seen_at=now()-interval '63 seconds' WHERE id=v_public_id;
 PERFORM public.get_public_tracking_portal_view(v_tok,v_pin,v_public_id,current_date,current_date);
 IF (SELECT count(*) FROM public.notifications WHERE target_user=v_actor) IS DISTINCT FROM v_count+1 THEN RAISE EXCEPTION 'CAJA C128 FAIL: regreso tras inactividad no crea una entrada'; END IF;
 v_count:=v_count+1;
 PERFORM public.get_public_tracking_portal_view(v_tok,v_pin,v_public_id,current_date,current_date);
 IF (SELECT count(*) FROM public.notifications WHERE target_user=v_actor) IS DISTINCT FROM v_count THEN RAISE EXCEPTION 'CAJA C128 FAIL: heartbeat duplica nuevo episodio'; END IF;
 -- Different scoped links and sites must not reveal each other's visitor names.
 v_payload:=public.tracking_portal_sign_in(v_other_tok,v_other_pin,'C128 Cliente privado');
 IF v_payload ? 'error' THEN RAISE EXCEPTION 'CAJA C128 FAIL: no permite acceso válido del otro cliente %',v_payload; END IF;
 INSERT INTO public.tracking_portal_viewers(portal_token,name) VALUES(v_else_tok,'C128 Otra sede privada');
 v_view:=public.get_public_tracking_portal_view(v_tok,v_pin,v_public_id,current_date,current_date);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_view->'viewers') x WHERE x->>'name' IN('C128 Cliente privado','C128 Otra sede privada')) THEN RAISE EXCEPTION 'CAJA C128 FAIL: público espía otro alcance'; END IF;
 PERFORM set_config('request.jwt.claim.sub',v_other::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_other,'role','authenticated')::text,true);
 v_internal:=public.get_internal_tracking_view(v_site,current_date,current_date,v_internal_id);
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_internal->'viewers') x WHERE x->>'name'='C128 Ana Pérez')
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_internal->'viewers') x WHERE x->>'name'='C128 Cliente privado')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_internal->'viewers') x WHERE x->>'name'='C128 Otra sede privada') THEN RAISE EXCEPTION 'CAJA C128 FAIL: interno no reúne sede o filtra otra %',v_internal->'viewers'; END IF;
 UPDATE public.tracking_portal_viewers SET last_seen_at=now()-interval '13 hours' WHERE id=v_internal_id;
 v_internal:=public.get_internal_tracking_view(v_site,current_date,current_date,v_internal_id);
 IF v_internal ? 'error' OR (v_internal->>'viewer_id')::uuid IS DISTINCT FROM v_internal_id THEN RAISE EXCEPTION 'CAJA C128 FAIL: sesión interna expirada rompe seguimiento %',v_internal; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_internal->'presence_events') x WHERE COALESCE((x->>'me')::boolean,false)) THEN RAISE EXCEPTION 'CAJA C128 FAIL: regreso interno sin evento'; END IF;
 DELETE FROM public.user_site_access WHERE user_id=v_other AND site_id=v_site;
 IF NOT(public.get_internal_tracking_view(v_site,current_date,current_date,v_internal_id) ? 'error') THEN RAISE EXCEPTION 'CAJA C128 FAIL: permiso revocado conserva acceso interno'; END IF;
 PERFORM set_config('request.jwt.claim.sub','',true);
 PERFORM set_config('request.jwt.claims','{"role":"anon"}',true);
 v_view:=public.get_public_tracking_portal_view(v_tok,v_pin,v_public_id,current_date,current_date);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_view->'viewers') x WHERE COALESCE((x->>'identity_verified')::boolean,false)) THEN RAISE EXCEPTION 'CAJA C128 FAIL: indicador conserva usuario sin sede autorizada'; END IF;
 PERFORM public.tracking_portal_sign_out(v_tok,v_public_id);
 IF NOT(public.get_public_tracking_portal_view(v_tok,v_pin,v_public_id,current_date,current_date) ? 'error')
 OR NOT(public.tracking_portal_sign_in_session(v_tok,v_pin,'C128 Ana Pérez',v_client_session) ? 'error') THEN RAISE EXCEPTION 'CAJA C128 FAIL: caché o nonce revive sesión cerrada'; END IF;
 v_again:=public.tracking_portal_sign_in_session(v_tok,v_pin,'C128 Ana Pérez',gen_random_uuid());
 IF v_again ? 'error' OR (v_again->>'viewer_id')::uuid=v_public_id THEN RAISE EXCEPTION 'CAJA C128 FAIL: no permite nuevo ingreso tras salir'; END IF;
 PERFORM set_config('request.jwt.claim.sub',v_other::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_other,'role','authenticated')::text,true);
 -- Directed entry notifications remain private even for another administrator or role-based observer.
 UPDATE public.profiles SET role_id=v_admin WHERE id=v_other;
 IF public.notif_can_see_event('TRACKING_PORTAL_ENTRY','{}',v_actor) THEN RAISE EXCEPTION 'CAJA C128 FAIL: otro usuario lee aviso dirigido'; END IF;
 PERFORM set_config('request.jwt.claim.sub',v_actor::text,true);
 IF NOT public.notif_can_see_event('TRACKING_PORTAL_ENTRY','{}',v_actor) THEN RAISE EXCEPTION 'CAJA C128 FAIL: responsable no puede leer su aviso'; END IF;
 IF has_table_privilege('anon','public.tracking_portal_viewers','SELECT') OR has_table_privilege('authenticated','public.tracking_portal_viewers','SELECT')
 OR has_table_privilege('authenticated','public.tracking_presence_entries','SELECT') OR has_table_privilege('anon','public.tracking_presence_entries','SELECT')
 OR has_function_privilege('authenticated','public.tracking_presence_payload(uuid)','EXECUTE') OR has_function_privilege('anon','public.tracking_presence_touch(uuid)','EXECUTE')
 OR has_function_privilege('anon','public.get_internal_tracking_view(uuid,date,date,uuid)','EXECUTE') THEN RAISE EXCEPTION 'CAJA C128 FAIL: acceso directo o RPC interna pública'; END IF;
 RAISE EXCEPTION 'CAJA C128 PASS: presencia unificada, ámbitos, sesiones estables y avisos sin duplicados al responsable';
END $test$;
ROLLBACK;
