-- CAJA C113 — Conectividad del app del conductor: estado del teléfono validado en el aviso de conexión, registro de
-- cortes (no cuenta el cierre de sesión), informe de diagnóstico con permisos y monitor con puntos pendientes.
-- Siempre se revierte.
BEGIN;
DO $test$
DECLARE prof uuid; drv uuid; admin uuid; r jsonb; c jsonb; n int; v_err text; pass int := 0; fails text[] := '{}';
BEGIN
  SELECT p.id INTO prof FROM public.drivers d JOIN public.profiles p ON p.id = d.profile_id
   WHERE d.is_active AND p.is_active ORDER BY d.id LIMIT 1;
  FOR admin IN SELECT p.id FROM public.profiles p JOIN auth.users u ON u.id = p.id WHERE p.is_active LOOP
    PERFORM set_config('request.jwt.claim.sub', admin::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', admin, 'role', 'authenticated')::text, true);
    EXIT WHEN public.is_tms_admin(); admin := NULL;
  END LOOP;
  IF prof IS NULL OR admin IS NULL THEN RAISE EXCEPTION 'CAJA C113 FAIL: falta conductor activo o administrador'; END IF;
  PERFORM set_config('request.jwt.claim.sub', prof::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', prof, 'role', 'authenticated')::text, true);

  -- T1: el aviso con el estado del teléfono guarda solo valores válidos y los puntos pendientes
  r := public.driver_app_heartbeat('checking', NULL, NULL, NULL, NULL, NULL, jsonb_build_object(
    'battery', 0.42, 'charging', false, 'network', '4g', 'visibility', 'hidden', 'platform', 'android', 'native_tracking', true,
    'pending_points', 12, 'oldest_pending_at', now() - interval '5 minutes', 'device', 'Android 13; SM-A145M', 'extra', 'no se guarda'));
  SELECT driver_id, client_info INTO drv, c FROM public.driver_app_presence WHERE profile_id = prof;
  IF (r->>'success')::boolean AND (c->>'battery')::numeric = 0.42 AND c->>'network' = '4g' AND c->>'visibility' = 'hidden'
     AND NOT c ? 'extra' AND (SELECT pending_points FROM public.driver_app_presence WHERE profile_id = prof) = 12
     AND (SELECT oldest_pending_at FROM public.driver_app_presence WHERE profile_id = prof) IS NOT NULL
  THEN pass := pass + 1; ELSE fails := fails || ('T1 estado del teléfono: ' || COALESCE(r::text, '∅') || ' ' || COALESCE(c::text, '∅')); END IF;

  -- T2: valores inválidos no rompen el aviso ni se guardan; el aviso sin estado sigue funcionando
  v_err := NULL;
  BEGIN
    r := public.driver_app_heartbeat('checking', NULL, NULL, NULL, NULL, NULL, '{"battery":"abc","pending_points":"-3","oldest_pending_at":"no-fecha","visibility":"x"}'::jsonb);
    r := public.driver_app_heartbeat('checking', NULL, NULL, NULL, NULL, NULL);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  SELECT client_info INTO c FROM public.driver_app_presence WHERE profile_id = prof;
  IF v_err IS NULL AND (r->>'success')::boolean AND NOT c ? 'battery' AND NOT c ? 'visibility'
     AND (SELECT pending_points FROM public.driver_app_presence WHERE profile_id = prof) IS NULL
  THEN pass := pass + 1; ELSE fails := fails || ('T2 valores inválidos: ' || COALESCE(v_err, COALESCE(c::text, '∅'))); END IF;

  -- T3: volver a reportar después de 10 min registra el corte con el estado previo del teléfono
  SELECT count(*) INTO n FROM public.driver_connectivity_gaps WHERE driver_id = drv;
  UPDATE public.driver_app_presence SET last_seen_at = now() - interval '10 minutes', client_info = '{"battery":0.08}' WHERE driver_id = drv;
  PERFORM public.driver_app_heartbeat('checking', NULL, NULL, NULL, NULL, NULL);
  IF (SELECT count(*) FROM public.driver_connectivity_gaps WHERE driver_id = drv) = n + 1
     AND EXISTS (SELECT 1 FROM public.driver_connectivity_gaps WHERE driver_id = drv AND seconds BETWEEN 590 AND 700 AND (client_info->>'battery')::numeric = 0.08)
  THEN pass := pass + 1; ELSE fails := fails || 'T3 corte no registrado'::text; END IF;

  -- T4: el cierre de sesión no cuenta como corte
  SELECT count(*) INTO n FROM public.driver_connectivity_gaps WHERE driver_id = drv;
  PERFORM public.driver_app_disconnect();
  UPDATE public.driver_app_presence SET last_seen_at = now() - interval '2 hours' WHERE driver_id = drv;
  PERFORM public.driver_app_heartbeat('checking', NULL, NULL, NULL, NULL, NULL);
  IF (SELECT count(*) FROM public.driver_connectivity_gaps WHERE driver_id = drv) = n
  THEN pass := pass + 1; ELSE fails := fails || 'T4 cierre de sesión contado como corte'::text; END IF;

  -- T5: el conductor no ve el informe; el administrador sí
  v_err := NULL;
  BEGIN PERFORM public.get_driver_connectivity_report(7); EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  PERFORM set_config('request.jwt.claim.sub', admin::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', admin, 'role', 'authenticated')::text, true);
  r := public.get_driver_connectivity_report(7);
  IF v_err LIKE 'Sin permiso%' AND (r->>'success')::boolean AND jsonb_typeof(r->'drivers') = 'array'
  THEN pass := pass + 1; ELSE fails := fails || ('T5 informe: ' || COALESCE(v_err, 'sin error') || ' ' || left(COALESCE(r::text, '∅'), 200)); END IF;

  -- T6: el monitor devuelve el estado del teléfono y los puntos pendientes del conductor
  UPDATE public.driver_app_presence SET pending_points = 7, client_info = '{"battery":0.5}' WHERE driver_id = drv;
  r := public.get_driver_gps_monitor();
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(r->'drivers') x WHERE x->>'driver_id' = drv::text AND (x->>'pending_points')::int = 7 AND x->'client'->>'battery' = '0.5')
  THEN pass := pass + 1; ELSE fails := fails || 'T6 monitor sin estado del teléfono'::text; END IF;

  -- T7: privilegios
  IF NOT has_function_privilege('anon', 'public.driver_app_heartbeat(text,numeric,numeric,numeric,numeric,timestamptz,jsonb)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.get_driver_connectivity_report(integer)', 'EXECUTE')
     AND NOT has_table_privilege('authenticated', 'public.driver_connectivity_gaps', 'SELECT')
     AND has_function_privilege('authenticated', 'public.driver_app_heartbeat(text,numeric,numeric,numeric,numeric,timestamptz,jsonb)', 'EXECUTE')
  THEN pass := pass + 1; ELSE fails := fails || 'T7 privilegios'::text; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C113 FAIL (%/7): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C113 PASS (7/7) conectividad del conductor: estado del teléfono, cortes registrados, informe y monitor con pendientes';
END $test$;
ROLLBACK;
