-- CAJA C108 — Portal público: nombre obligatorio antes del código, presencia de quienes lo ven y cierre de las
-- sesiones abiertas sin nombre. Siempre se revierte.
BEGIN;
DO $test$
DECLARE actor uuid; site uuid; payload jsonb; tok uuid; pin text; a jsonb; b jsonb; r jsonb; pass int := 0; fails text[] := '{}';
BEGIN
 SELECT p.id INTO actor FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id WHERE ro.name = 'Administrador' AND p.is_active LIMIT 1;
 SELECT id INTO site FROM public.sites LIMIT 1;
 IF actor IS NULL OR site IS NULL THEN RAISE EXCEPTION 'CAJA C108 FAIL: fixture administrador/sede ausente'; END IF;
 PERFORM set_config('request.jwt.claim.sub', actor::text, true);
 PERFORM set_config('request.jwt.claims', json_build_object('sub', actor, 'role', 'authenticated')::text, true);
 payload := public.generate_tracking_portal_link(jsonb_build_object('site_id', site));
 tok := (payload->>'token')::uuid; pin := payload->>'pin';
 PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
 PERFORM set_config('request.jwt.claim.sub', '', true);

 -- T1: sin nombre (o nombre inválido) no ingresa; con código incorrecto tampoco
 IF (public.tracking_portal_sign_in(tok, pin, '  ')->>'error') LIKE 'Ingrese su nombre%'
    AND (public.tracking_portal_sign_in(tok, pin, '12')->>'error') LIKE 'Ingrese su nombre%'
    AND public.tracking_portal_sign_in(tok, 'ZZZZ', 'Ana Pérez') ? 'error'
 THEN pass := pass + 1; ELSE fails := fails || 'T1 nombre/código'::text; END IF;

 -- T2: dos personas ingresan con nombre y código; cada una ve a ambas en la presencia (la presencia es por sede:
 -- en producción puede haber además personas reales viendo el portal, por eso no se exige un total exacto)
 a := public.tracking_portal_sign_in(tok, pin, '  Ana   Pérez ');
 b := public.tracking_portal_sign_in(tok, lower(pin), 'Luis Rojas');
 r := public.get_public_tracking_portal_view(tok, pin, (a->>'viewer_id')::uuid, current_date, current_date);
 IF a->>'name' = 'Ana Pérez' AND r->>'mode' = 'permanent' AND (r->>'active_count')::int >= 2
    AND r->'viewer'->>'name' = 'Ana Pérez' AND (r->'viewers'->0->>'me')::boolean
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(r->'viewers') x WHERE x->>'name' = 'Luis Rojas' AND NOT (x->>'me')::boolean)
 THEN pass := pass + 1; ELSE fails := fails || ('T2 presencia: ' || COALESCE(r::text, '∅')); END IF;

 -- T3: quien sale o deja de consultar (más de 60 s) ya no aparece; su sesión no sirve para otro enlace
 PERFORM public.tracking_portal_sign_out(tok, (b->>'viewer_id')::uuid);
 r := public.get_public_tracking_portal_view(tok, pin, (a->>'viewer_id')::uuid, current_date, current_date);
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(r->'viewers') x WHERE x->>'name' = 'Ana Pérez' AND (x->>'me')::boolean)
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'viewers') x WHERE x->>'id' = b->>'viewer_id')
    AND (public.get_public_tracking_portal_view(tok, pin, (b->>'viewer_id')::uuid, current_date, current_date)->>'error') LIKE 'Acceso vencido%'
    AND (public.get_public_tracking_portal_view(gen_random_uuid(), pin, (a->>'viewer_id')::uuid, current_date, current_date)->>'error') LIKE 'Acceso vencido%'
 THEN pass := pass + 1; ELSE fails := fails || ('T3 salida: ' || COALESCE(r::text, '∅')); END IF;

 -- T4: un navegador que consulta sin identificarse (sesión abierta anterior) queda fuera
 PERFORM set_config('role', 'anon', true);
 r := public.get_public_tracking_portal_info(tok, pin, current_date, current_date);
 PERFORM set_config('role', 'none', true);
 IF (r->>'error') LIKE 'Acceso vencido%' THEN pass := pass + 1; ELSE fails := fails || ('T4 sesión sin nombre: ' || COALESCE(r::text, '∅')); END IF;

 -- T5: permisos: la tabla no es accesible y las funciones públicas sí
 IF NOT has_table_privilege('anon', 'public.tracking_portal_viewers', 'SELECT')
    AND has_function_privilege('anon', 'public.tracking_portal_sign_in(uuid,text,text)', 'EXECUTE')
    AND has_function_privilege('anon', 'public.get_public_tracking_portal_view(uuid,text,uuid,date,date)', 'EXECUTE')
 THEN pass := pass + 1; ELSE fails := fails || 'T5 permisos'::text; END IF;

 IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C108 FAIL (%/5): %', pass, array_to_string(fails, ' | '); END IF;
 RAISE EXCEPTION 'CAJA C108 PASS (5/5) portal público: nombre antes del código, presencia por enlace, salida y cierre de sesiones sin nombre';
END $test$;
ROLLBACK;
