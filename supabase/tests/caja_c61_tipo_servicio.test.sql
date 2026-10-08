-- Pruebas C61 — Tipo de servicio para Torre de Control y Documentos (request_service_types).
-- T1 función segura (SECURITY DEFINER con search_path fijo) y sin acceso anónimo; T2 sin identidad no devuelve datos;
-- T3 un administrador recibe el tipo real de una solicitud programada; T4 lotes mayores a 1000 se rechazan (vacío).
-- Termina en error para forzar ROLLBACK: "CAJA C61 PASS/FAIL".
--   npx supabase db query --linked -f supabase/tests/caja_c61_tipo_servicio.test.sql
BEGIN;
DO $test$
DECLARE actor uuid; req uuid; q jsonb; v_pass int := 0; v_fail text[] := '{}';
BEGIN
  -- T1
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.request_service_types(uuid[])'::regprocedure AND prosecdef
               AND array_to_string(proconfig, ',') LIKE '%search_path=public, pg_temp%')
     AND NOT has_function_privilege('anon', 'public.request_service_types(uuid[])', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.request_service_types(uuid[])', 'EXECUTE')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T1 función insegura o con acceso anónimo'::text; END IF;

  SELECT r.transport_request_id INTO req FROM public.dispatch_requests r JOIN public.transport_requests t ON t.id = r.transport_request_id LIMIT 1;

  -- T2
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{}', true);
  IF req IS NULL OR public.request_service_types(ARRAY[req]) = '[]'::jsonb
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T2 devuelve datos sin identidad'::text; END IF;

  -- T3
  FOR actor IN SELECT id FROM public.profiles WHERE is_active AND id IN (SELECT id FROM auth.users) LOOP
    PERFORM set_config('request.jwt.claim.sub', actor::text, true);
    EXIT WHEN public.is_tms_admin(); actor := NULL;
  END LOOP;
  -- Sin administrador o sin despachos con solicitudes, T3-T4 no se pueden ejecutar: se informa como FAIL
  IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C61 FAIL (%/4): falta administrador activo para ejecutar T3-T4', v_pass; END IF;
  IF req IS NULL THEN RAISE EXCEPTION 'CAJA C61 FAIL (%/4): no hay solicitudes programadas para ejecutar T3-T4', v_pass; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', actor, 'role', 'authenticated')::text, true);
  BEGIN
    q := public.request_service_types(ARRAY[req]);
    IF jsonb_array_length(q) = 1 AND q->0->>'request_type' = (SELECT request_type FROM public.transport_requests WHERE id = req)
    THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 respuesta ' || q::text); END IF;
  END;

  -- T4
  IF public.request_service_types(array_fill(req, ARRAY[1001])) = '[]'::jsonb
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T4 acepta más de 1000 solicitudes'::text; END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C61 PASS (%/4) tipo de servicio autorizado', v_pass;
  ELSE
    RAISE EXCEPTION 'CAJA C61 FAIL (%/4): %', v_pass, array_to_string(v_fail, ' || ');
  END IF;
END $test$;
