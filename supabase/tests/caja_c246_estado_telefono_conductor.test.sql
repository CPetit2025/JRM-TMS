-- CAJA C246 — Estado del teléfono del conductor: el aviso de conexión guarda ubicación precisa, ubicación «todo el
-- tiempo» y notificaciones solo si son booleanos; el anónimo no puede llamarlo. Siempre se revierte.
BEGIN;
DO $test$
DECLARE prof uuid; r jsonb; info jsonb; pass int := 0; fails text[] := '{}';
BEGIN
  SELECT p.id INTO prof FROM public.drivers d JOIN public.profiles p ON p.id = d.profile_id
   WHERE d.is_active AND p.is_active ORDER BY d.id LIMIT 1;
  IF prof IS NULL THEN RAISE EXCEPTION 'CAJA C246 FAIL: falta conductor activo con perfil'; END IF;
  PERFORM set_config('request.jwt.claim.sub', prof::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', prof, 'role', 'authenticated')::text, true);

  -- T1: las tres claves se guardan cuando son booleanas
  r := public.driver_app_heartbeat('active', NULL, NULL, NULL, NULL, NULL,
    '{"location_ok":true,"background_location":false,"notifications_ok":false,"battery_exempt":true}'::jsonb);
  SELECT client_info INTO info FROM public.driver_app_presence WHERE profile_id = prof;
  IF (r->>'success')::boolean AND (info->>'location_ok')::boolean AND NOT (info->>'background_location')::boolean
     AND NOT (info->>'notifications_ok')::boolean AND (info->>'battery_exempt')::boolean
  THEN pass := pass + 1; ELSE fails := fails || ('T1 claves: ' || COALESCE(r::text, '∅') || ' ' || COALESCE(info::text, '∅')); END IF;

  -- T2: un valor que no es booleano se descarta
  PERFORM public.driver_app_heartbeat('active', NULL, NULL, NULL, NULL, NULL, '{"location_ok":"si","notifications_ok":1}'::jsonb);
  SELECT client_info INTO info FROM public.driver_app_presence WHERE profile_id = prof;
  IF NOT info ? 'location_ok' AND NOT info ? 'notifications_ok' THEN pass := pass + 1;
  ELSE fails := fails || ('T2 validación: ' || COALESCE(info::text, '∅')); END IF;

  -- T3: permisos
  IF NOT has_function_privilege('anon', 'public.driver_app_heartbeat(text,numeric,numeric,numeric,numeric,timestamptz,jsonb)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.driver_app_heartbeat(text,numeric,numeric,numeric,numeric,timestamptz,jsonb)', 'EXECUTE')
  THEN pass := pass + 1; ELSE fails := fails || 'T3 permisos'::text; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C246 FAIL (%/3): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C246 PASS (3/3) estado del teléfono del conductor';
END $test$;
ROLLBACK;
