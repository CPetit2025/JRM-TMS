-- CAJA C110 — Ingreso de solicitantes: área en el perfil, rol base «Solicitante de Transporte» y aviso en /usuarios de
-- los registros que esperan aprobación. Siempre se revierte.
BEGIN;
DO $test$
DECLARE actor uuid; pending uuid := gen_random_uuid(); r jsonb; before_n int; after_n int; perms jsonb; pass int := 0; fails text[] := '{}';
BEGIN
 SELECT p.id INTO actor FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id WHERE ro.name = 'Administrador' AND p.is_active LIMIT 1;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C110 FAIL: fixture administrador ausente'; END IF;

 -- T1: rol base con solicitudes (escritura) y Torre de Control (lectura), sin administración
 SELECT permissions INTO perms FROM public.roles WHERE lower(btrim(name)) = 'solicitante de transporte';
 IF perms ? 'solicitudes:write' AND perms ? 'torre-control:read' AND NOT perms ? 'usuarios:write' AND NOT perms ? 'ot:write'
 THEN pass := pass + 1; ELSE fails := fails || ('T1 rol base: ' || COALESCE(perms::text, '∅')); END IF;

 -- T2: el perfil guarda el área declarada en el registro
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'area')
 THEN pass := pass + 1; ELSE fails := fails || 'T2 profiles.area'::text; END IF;

 -- T3: un registro público (inactivo, sin rol) aparece en el contador de /usuarios del administrador
 PERFORM set_config('request.jwt.claim.sub', actor::text, true);
 PERFORM set_config('request.jwt.claims', json_build_object('sub', actor, 'role', 'authenticated')::text, true);
 before_n := COALESCE((public.menu_pending_counts()->'counts'->'/usuarios'->>'n')::int, 0);
 -- (en producción profiles no tiene email ni exige cuenta; en un entorno con esas restricciones se completan)
 IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.profiles'::regclass AND contype = 'f' AND confrelid = 'auth.users'::regclass) THEN
   INSERT INTO auth.users (id) VALUES (pending);
 END IF;
 EXECUTE format('INSERT INTO public.profiles (id, first_name, last_name, employee_type, is_active%s) VALUES ($1, %L, %L, %L, false%s)',
   CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'email') THEN ', email' ELSE '' END,
   'Registro', 'Pendiente', 'Administrativo',
   CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'email') THEN ', ' || quote_literal(pending || '@c110.test') ELSE '' END)
 USING pending;
 UPDATE public.profiles SET area = 'Logística', role_id = NULL WHERE id = pending;
 r := public.menu_pending_counts();
 after_n := COALESCE((r->'counts'->'/usuarios'->>'n')::int, 0);
 IF after_n = before_n + 1 AND (r->'counts'->'/usuarios'->>'texto') LIKE '%esperando aprobación'
    AND (SELECT area FROM public.profiles WHERE id = pending) = 'Logística'
 THEN pass := pass + 1; ELSE fails := fails || ('T3 contador: ' || before_n || '→' || after_n || ' ' || COALESCE(r::text, '∅')); END IF;

 -- T4: con rol asignado deja de estar pendiente; quien no administra usuarios no ve el contador
 UPDATE public.profiles SET role_id = (SELECT id FROM public.roles WHERE lower(btrim(name)) = 'solicitante de transporte') WHERE id = pending;
 after_n := COALESCE((public.menu_pending_counts()->'counts'->'/usuarios'->>'n')::int, 0);
 PERFORM set_config('request.jwt.claim.sub', pending::text, true);
 PERFORM set_config('request.jwt.claims', json_build_object('sub', pending, 'role', 'authenticated')::text, true);
 r := public.menu_pending_counts();
 IF after_n = before_n AND NOT COALESCE(r->'counts' ? '/usuarios', false)
 THEN pass := pass + 1; ELSE fails := fails || ('T4 rol/permiso: ' || after_n || ' ' || COALESCE(r::text, '∅')); END IF;

 -- T5: el contador no es accesible sin sesión
 IF NOT has_function_privilege('anon', 'public.menu_pending_counts()', 'EXECUTE')
 THEN pass := pass + 1; ELSE fails := fails || 'T5 permisos'::text; END IF;

 IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C110 FAIL (%/5): %', pass, array_to_string(fails, ' | '); END IF;
 RAISE EXCEPTION 'CAJA C110 PASS (5/5) ingreso de solicitantes: rol base, área del perfil y aviso de registros pendientes';
END $test$;
ROLLBACK;
