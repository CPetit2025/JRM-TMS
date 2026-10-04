-- CAJA C30 — Plan de mantenimiento, Fase 1:
--   T1 clasificación por sistema; T2 montacargas y elevadores en Flota y vinculados a Eficiencia de Flota;
--   T3 turno con horómetro válido (actualiza la unidad); T4 horómetro menor se rechaza; T5 salto imposible queda
--   POR_VALIDAR sin mover la unidad; T6 ítem crítico en falla crea la falla CRÍTICA en maintenance_requests;
--   T7 historial con plan por permiso (sin permiso: sin acceso); T8 aviso de fallas escucha maintenance_requests.
--   Informe: unidades de transporte del Excel y su vínculo con Flota. Solo lectura (se revierte).
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

DO $test$
DECLARE v_user uuid; r_m uuid; r_n uuid; r jsonb; v_fail text[] := '{}'; v_pass int := 0; v_vid uuid; v_plate text; h0 numeric; h1 numeric;
  n int; v_rep text; v_eq text;
BEGIN
  SELECT id INTO v_user FROM public.profiles WHERE id IN (SELECT u2.id FROM auth.users u2)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C30 mant', '["mantenimiento-flota"]') RETURNING id INTO r_m;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C30 nada', '["clientes"]') RETURNING id INTO r_n;
  UPDATE public.profiles SET role_id = r_n, is_active = true WHERE id = v_user;

  -- T1
  IF public.mant_sistema('CAMBIO DE ACEITE Y FILTRO DE ACEITE, ENGRASE DE MASTIL', NULL) = 'MOTOR'
     AND public.mant_sistema('CAMBIO DE BATERIAS TRUJAN Y REPARACION MOTOR HIDRAULICO', NULL) = 'BATERIAS'
     AND public.mant_sistema('REPARACION CILINDRO HIDRAULICO CAMBIO DE SELLOS', NULL) = 'HIDRAULICO'
     AND public.mant_sistema('DESMONTAJE Y MONTAJE TRANSMISION EMBRAGUE', NULL) = 'TRANSMISION'
     AND public.mant_sistema('LAVADO DE CAMIONETA', NULL) = 'SERVICIOS'
     AND public.mant_sistema('xyz', 'FRENOS / SUSPENSIÓN / DIRECCIÓN') = 'FRENOS' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || 'T1 sistemas'::text; END IF;

  -- T2
  SELECT count(*) INTO n FROM (VALUES ('UN FORKLIFT 3TN NN01'), ('UN FORKLIFT 3TN NN02'), ('UN FORKLIFT 5TN NN03'), ('UN FORKLIFT 5TN NN04'),
      ('CLARK 4TN'), ('CLARK 5TN'), ('HANGZHOU 3.5TN'), ('SCISSOR LIFT N1 MANTALL XE 140'), ('SCISSOR LIFT N2 MANTALL XE 140'),
      ('SCISSOR LIFT N5 MANTALL XE 140'), ('SCISSOR LIFT N6 MANTALL XE 140'), ('APILADOR BT REFLEX')) x(code)
    JOIN public.fe_assets a ON a.code = x.code JOIN public.vehicles v ON v.id = a.vehicle_id
    JOIN public.mant_asset_familia af ON af.vehicle_id = v.id;
  SELECT string_agg(detalle, '; ') INTO v_eq FROM public.mant_setup_log WHERE paso = 'equipo' AND detalle ~ 'error|sin transportista';
  IF n = 12 OR (n = 0 AND NOT EXISTS (SELECT 1 FROM public.fe_assets WHERE clase <> 'TRANSPORTE')) THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T2 equipos en Flota: ' || n || '/12 ' || COALESCE(v_eq, '')); END IF;

  -- Equipo de prueba: un montacargas registrado (o uno temporal si no hay)
  SELECT v.id, v.plate INTO v_vid, v_plate FROM public.vehicles v JOIN public.mant_asset_familia af ON af.vehicle_id = v.id
  WHERE af.familia = 'MONTACARGA_IC' ORDER BY v.plate LIMIT 1;
  IF v_vid IS NULL THEN
    INSERT INTO public.vehicles (plate, carrier_id, type) SELECT 'ZZC30', id, 'MONTACARGAS' FROM public.carriers LIMIT 1 RETURNING id, plate INTO v_vid, v_plate;
    INSERT INTO public.mant_asset_familia (vehicle_id, familia) VALUES (v_vid, 'MONTACARGA_IC');
  END IF;
  EXECUTE 'SELECT COALESCE(current_hours, 0) FROM public.vehicles WHERE id = $1' INTO h0 USING v_vid;

  -- T3
  PERFORM pg_temp.as_user(v_user); r := public.mant_registrar_turno(v_vid, h0 + 5, '[]'::jsonb, 'ZZ C30'); PERFORM pg_temp.as_user(NULL);
  EXECUTE 'SELECT current_hours FROM public.vehicles WHERE id = $1' INTO h1 USING v_vid;
  IF (r ->> 'success')::boolean AND r ->> 'estado_lectura' = 'VALIDADA' AND h1 = h0 + 5 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T3 turno: ' || r::text); END IF;

  -- T4
  PERFORM pg_temp.as_user(v_user); r := public.mant_registrar_turno(v_vid, h0, '[]'::jsonb, NULL); PERFORM pg_temp.as_user(NULL);
  IF NOT (r ->> 'success')::boolean THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T4 horómetro menor'::text; END IF;

  -- T5
  PERFORM pg_temp.as_user(v_user); r := public.mant_registrar_turno(v_vid, h0 + 5000, '[]'::jsonb, NULL); PERFORM pg_temp.as_user(NULL);
  EXECUTE 'SELECT current_hours FROM public.vehicles WHERE id = $1' INTO h1 USING v_vid;
  IF (r ->> 'success')::boolean AND r ->> 'estado_lectura' = 'POR_VALIDAR' AND h1 = h0 + 5 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T5 salto: ' || r::text); END IF;

  -- T6
  PERFORM pg_temp.as_user(v_user);
  r := public.mant_registrar_turno(v_vid, h0 + 6, '[{"id":"frenos","ok":false,"obs":"ZZ C30 freno largo"}]'::jsonb, NULL);
  PERFORM pg_temp.as_user(NULL);
  IF (r ->> 'fallas')::int = 1 AND EXISTS (SELECT 1 FROM public.maintenance_requests WHERE vehicle_plate = v_plate AND description LIKE '%ZZ C30 freno largo%' AND severity = 'CRITICA')
  THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T6 falla: ' || r::text || ' ' || COALESCE((SELECT string_agg(detalle, '; ') FROM public.mant_setup_log WHERE paso = 'turno'), '')); END IF;

  -- T7
  PERFORM pg_temp.as_user(v_user); r := public.mant_historial(v_plate); PERFORM pg_temp.as_user(NULL);
  IF NOT (r ->> 'success')::boolean THEN
    UPDATE public.profiles SET role_id = r_m WHERE id = v_user;
    PERFORM pg_temp.as_user(v_user); r := public.mant_historial(v_plate); PERFORM pg_temp.as_user(NULL);
    IF (r ->> 'success')::boolean AND jsonb_array_length(r -> 'plan') >= 4 AND jsonb_array_length(r -> 'turnos') >= 3 THEN v_pass := v_pass + 1;
    ELSE v_fail := v_fail || ('T7 historial: ' || left(r::text, 200)); END IF;
  ELSE v_fail := v_fail || 'T7 historial sin permiso'::text; END IF;

  -- T8
  IF to_regclass('public.maintenance_requests') IS NULL OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'notif_falla' AND tgrelid = 'public.maintenance_requests'::regclass)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T8 aviso de fallas'::text; END IF;

  -- Informe: transporte del Excel con actividad desde 2025 y su vínculo con Flota
  EXECUTE $q$SELECT string_agg(a.code || '=' || COALESCE(v.plate || '/' || COALESCE(v.type::text, '?') || '/' || COALESCE(af.familia, 'sin familia'), 'NO EN FLOTA'), ', ' ORDER BY a.code)
    FROM public.fe_assets a
    LEFT JOIN public.vehicles v ON v.id = a.vehicle_id OR (a.vehicle_id IS NULL AND public.fe_code(v.plate) = a.code)
    LEFT JOIN public.mant_asset_familia af ON af.vehicle_id = v.id
    WHERE a.clase = 'TRANSPORTE' AND (EXISTS (SELECT 1 FROM public.fe_maint m WHERE m.asset_code = a.code AND m.fecha >= DATE '2025-01-01')
       OR EXISTS (SELECT 1 FROM public.fe_fuel_month f WHERE f.asset_code = a.code AND f.mes >= DATE '2025-01-01'))$q$ INTO v_rep;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C30 PASS (%/8) transporte: %', v_pass, COALESCE(v_rep, '-');
  ELSE
    RAISE EXCEPTION 'CAJA C30 FAIL (%/8): % || transporte: %', v_pass, array_to_string(v_fail, ' || '), COALESCE(v_rep, '-');
  END IF;
END $test$;
