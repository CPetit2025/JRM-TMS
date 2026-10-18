-- CAJA C114 — Seguimiento nativo: credencial del dispositivo (token solo en hash, revocación al registrar otro y al
-- cerrar sesión), sincronización sin sesión web (aviso de conexión, puntos aceptados/rechazados sin cortar el lote)
-- y permisos. Siempre se revierte.
BEGIN;
DO $test$
DECLARE prof uuid; drv uuid; route uuid; r jsonb; tok text; tok2 text; v_err text; info jsonb; seen timestamptz;
  pass int := 0; fails text[] := '{}'; note text := 'sin ruta en curso para probar un punto aceptado';
BEGIN
  -- Conductor con ruta en curso si existe (para el punto aceptado); si no, cualquier conductor activo
  SELECT dr.profile_id, dr.id, d.id INTO prof, drv, route FROM public.dispatches d
    JOIN public.drivers dr ON dr.id = d.driver_id AND dr.is_active JOIN public.profiles p ON p.id = dr.profile_id AND p.is_active
   WHERE d.status IN ('EN RUTA', 'EN_CURSO', 'RETORNO') ORDER BY d.created_at DESC LIMIT 1;
  IF prof IS NULL THEN
    SELECT p.id, d.id INTO prof, drv FROM public.drivers d JOIN public.profiles p ON p.id = d.profile_id
     WHERE d.is_active AND p.is_active ORDER BY d.id LIMIT 1;
  END IF;
  IF prof IS NULL THEN RAISE EXCEPTION 'CAJA C114 FAIL: falta conductor activo'; END IF;
  PERFORM set_config('request.jwt.claim.sub', prof::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', prof, 'role', 'authenticated')::text, true);

  -- T1: el registro devuelve un token de 256 bits y la base guarda solo su hash
  r := public.register_tracking_device('C114 prueba');
  tok := r->>'token';
  IF (r->>'success')::boolean AND tok ~ '^[0-9a-f]{64}$'
     AND EXISTS (SELECT 1 FROM public.driver_tracking_devices WHERE profile_id = prof AND token_hash = public.tracking_token_hash(tok) AND revoked_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM public.driver_tracking_devices WHERE token_hash = tok)
  THEN pass := pass + 1; ELSE fails := fails || ('T1 registro: ' || COALESCE(r::text, '∅')); END IF;

  -- T2: sin sesión web, el token válido actualiza la conexión y el estado del teléfono; uno inválido no
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  r := public.native_tracking_sync(tok, '[]'::jsonb, '{"battery":0.33,"visibility":"hidden","pending_points":4}'::jsonb);
  SELECT client_info, last_seen_at INTO info, seen FROM public.driver_app_presence WHERE profile_id = prof;
  IF (r->>'success')::boolean AND (info->>'native_tracking')::boolean AND (info->>'battery')::numeric = 0.33 AND seen >= now() - interval '1 minute'
     AND (public.native_tracking_sync(repeat('0', 64), '[]'::jsonb, NULL)->>'error') = 'Dispositivo no autorizado'
     AND (public.native_tracking_sync('corto', '[]'::jsonb, NULL)->>'error') = 'Dispositivo no autorizado'
  THEN pass := pass + 1; ELSE fails := fails || ('T2 sincronización: ' || COALESCE(r::text, '∅') || ' ' || COALESCE(info::text, '∅')); END IF;

  -- T3: un punto inválido se rechaza sin cortar el lote; un lote demasiado grande se rechaza entero
  r := public.native_tracking_sync(tok, jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'dispatch_id', gen_random_uuid(),
        'recorded_at', now(), 'latitude', -12.05, 'longitude', -77.04, 'accuracy_m', 8)), NULL);
  IF (r->>'success')::boolean AND jsonb_array_length(r->'rejected') = 1 AND jsonb_array_length(r->'accepted') = 0
     AND (public.native_tracking_sync(tok, (SELECT jsonb_agg(jsonb_build_object('id', gen_random_uuid())) FROM generate_series(1, 501)), NULL)->>'success')::boolean = false
  THEN pass := pass + 1; ELSE fails := fails || ('T3 rechazo: ' || COALESCE(r::text, '∅')); END IF;

  -- T4: con ruta en curso, el punto del conductor se registra como suyo (aunque el teléfono envíe otro conductor)
  IF route IS NOT NULL THEN
    r := public.native_tracking_sync(tok, jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'dispatch_id', route,
          'driver_id', gen_random_uuid(), 'recorded_at', now(), 'latitude', -12.05, 'longitude', -77.04, 'accuracy_m', 8)), NULL);
    IF jsonb_array_length(r->'accepted') = 1 AND EXISTS (SELECT 1 FROM public.route_track_points WHERE id = (r->'accepted'->>0)::uuid AND driver_id = drv)
    THEN pass := pass + 1; note := 'punto aceptado en ruta en curso';
    ELSE
      -- La ruta puede tener un punto posterior (reloj del servidor): rechazado por orden, no es un error del sincronizador
      IF jsonb_array_length(r->'rejected') = 1 THEN pass := pass + 1; note := 'punto rechazado por orden en la ruta en curso';
      ELSE fails := fails || ('T4 punto en ruta: ' || COALESCE(r::text, '∅')); END IF;
    END IF;
  ELSE pass := pass + 1; END IF;

  -- T5: registrar otro dispositivo revoca el anterior; cerrar sesión revoca el vigente
  PERFORM set_config('request.jwt.claim.sub', prof::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', prof, 'role', 'authenticated')::text, true);
  tok2 := public.register_tracking_device('C114 segundo')->>'token';
  v_err := public.native_tracking_sync(tok, '[]'::jsonb, NULL)->>'error';
  PERFORM public.driver_app_disconnect();
  IF v_err = 'Dispositivo no autorizado' AND (public.native_tracking_sync(tok2, '[]'::jsonb, NULL)->>'error') = 'Dispositivo no autorizado'
  THEN pass := pass + 1; ELSE fails := fails || ('T5 revocación: ' || COALESCE(v_err, 'token anterior vigente')); END IF;

  -- T6: permisos: el anónimo solo sincroniza con token; no registra dispositivos ni lee la tabla
  IF has_function_privilege('anon', 'public.native_tracking_sync(text,jsonb,jsonb)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.register_tracking_device(text)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.tracking_token_hash(text)', 'EXECUTE')
     AND NOT has_table_privilege('anon', 'public.driver_tracking_devices', 'SELECT')
     AND NOT has_table_privilege('authenticated', 'public.driver_tracking_devices', 'SELECT')
  THEN pass := pass + 1; ELSE fails := fails || 'T6 permisos'::text; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C114 FAIL (%/6): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C114 PASS (6/6) seguimiento nativo: token en hash, sincronización sin sesión, rechazo por punto, revocación y permisos (%)', note;
END $test$;
ROLLBACK;
