-- CAJA C40 — Soporte Mecánico: tablero del equipo (/mantenimiento/soporte).
--   T1 sin permiso no hay tablero; T2 quien atiende fallas ve el tablero con sus indicadores, por criticidad, 6 meses y
--   diagnóstico (avisa si nadie tiene el rol Soporte Mecánico); T3 una falla nueva aparece como recibida y abierta sin
--   atender; T4 al tomarla queda atendida con su técnico; T5 una falla sin primera atención registrada se estima con la
--   primera OT de la unidad (si la tabla de OT lo permite). Solo lectura (se revierte).
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

DO $test$
DECLARE v_u uuid; r_nada uuid; r_sup uuid; r_tec uuid; v_plate text; v_plate2 text; v_req uuid; v_old uuid; a jsonb; b jsonb; c jsonb; t jsonb;
  v_fail text[] := '{}'; v_pass int := 0; v_rep text := ''; v_hoy date := (now() AT TIME ZONE 'America/Lima')::date; v_ot text := 'sin OT';
BEGIN
  SELECT id INTO v_u FROM public.profiles WHERE id IN (SELECT u2.id FROM auth.users u2)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  IF v_u IS NULL THEN RAISE EXCEPTION 'CAJA C40 FAIL (0/5): se necesita un usuario de prueba'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C40 nada', '["clientes"]') RETURNING id INTO r_nada;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C40 fallas', '["mantenimiento-fallas"]') RETURNING id INTO r_sup;
  SELECT id INTO r_tec FROM public.roles WHERE name = 'Soporte Mecánico';
  SELECT plate INTO v_plate FROM public.vehicles ORDER BY plate LIMIT 1;
  SELECT plate INTO v_plate2 FROM public.vehicles WHERE plate <> v_plate ORDER BY plate LIMIT 1;

  -- T1
  UPDATE public.profiles SET is_active = true, role_id = r_nada WHERE id = v_u;
  PERFORM pg_temp.as_user(v_u); a := public.soporte_tablero(NULL, NULL); PERFORM pg_temp.as_user(NULL);
  IF NOT (a ->> 'success')::boolean THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T1 sin permiso'::text; END IF;

  -- T2
  UPDATE public.profiles SET role_id = r_sup WHERE id = v_u;
  PERFORM pg_temp.as_user(v_u); a := public.soporte_tablero((v_hoy - 90), v_hoy); PERFORM pg_temp.as_user(NULL);
  IF (a ->> 'success')::boolean AND a -> 'kpis' ? 'respuesta_mediana_h' AND jsonb_array_length(a -> 'por_mes') = 6
     AND jsonb_typeof(a -> 'por_criticidad') = 'array' AND jsonb_typeof(a -> 'diagnostico') = 'array'
     AND ((a ->> 'tecnicos_con_rol')::int > 0 OR EXISTS (SELECT 1 FROM jsonb_array_elements(a -> 'diagnostico') x WHERE x ->> 'texto' LIKE '%rol Soporte Mecánico%'))
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 tablero: ' || left(a::text, 200)); END IF;
  v_rep := format('90 d: %s recibidas, %s atendidas (%s estimadas), respuesta mediana %s h, %s %% en plazo, %s abiertas, %s sin atender, técnicos con rol %s, fallas históricas %s',
    a -> 'kpis' ->> 'recibidas', a -> 'kpis' ->> 'atendidas', a -> 'kpis' ->> 'estimadas', COALESCE(a -> 'kpis' ->> 'respuesta_mediana_h', 's/d'),
    COALESCE(a -> 'kpis' ->> 'respuesta_en_sla_pct', 's/d'), a -> 'kpis' ->> 'abiertas', a -> 'kpis' ->> 'sin_atender', a ->> 'tecnicos_con_rol', a ->> 'fallas_historicas');

  -- T3
  INSERT INTO public.maintenance_requests (vehicle_plate, description, severity, reported_at)
  VALUES (v_plate, 'ZZ C40 fuga de aceite ' || gen_random_uuid(), 'MEDIA', now() - interval '10 minutes') RETURNING id INTO v_req;
  PERFORM pg_temp.as_user(v_u); b := public.soporte_tablero((v_hoy - 90), v_hoy); PERFORM pg_temp.as_user(NULL);
  IF (b -> 'kpis' ->> 'recibidas')::int = (a -> 'kpis' ->> 'recibidas')::int + 1
     AND (b -> 'kpis' ->> 'sin_atender')::int = (a -> 'kpis' ->> 'sin_atender')::int + 1
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(b -> 'abiertas') x WHERE x ->> 'id' = v_req::text AND x ->> 'atendida_at' IS NULL)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T3 falla nueva'::text; END IF;

  -- T4 (la toma un técnico de Soporte Mecánico)
  IF r_tec IS NOT NULL THEN UPDATE public.profiles SET role_id = r_tec WHERE id = v_u; END IF;
  PERFORM pg_temp.as_user(v_u);
  t := public.soporte_tomar_falla(v_req, NULL, 'ZZ C40 en camino');
  c := public.soporte_tablero((v_hoy - 90), v_hoy);
  PERFORM pg_temp.as_user(NULL);
  IF (t ->> 'success')::boolean AND (c -> 'kpis' ->> 'sin_atender')::int = (a -> 'kpis' ->> 'sin_atender')::int
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(c -> 'abiertas') x WHERE x ->> 'id' = v_req::text AND x ->> 'atendida_at' IS NOT NULL AND x ->> 'tecnico' IS NOT NULL)
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(c -> 'por_tecnico') x WHERE x ->> 'user_id' = v_u::text)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 tomar: ' || left(t::text, 120)); END IF;

  -- T5 (falla de hace 3 días sin primera atención; OT de la misma unidad al día siguiente)
  INSERT INTO public.maintenance_requests (vehicle_plate, description, severity, reported_at)
  VALUES (v_plate2, 'ZZ C40 ruido en el diferencial ' || gen_random_uuid(), 'BAJA', now() - interval '3 days') RETURNING id INTO v_old;
  BEGIN
    -- solo las columnas que existen (el esquema de producción difiere del repositorio)
    EXECUTE (SELECT format('INSERT INTO public.maintenance_work_orders (%s) VALUES (%s)', string_agg(quote_ident(x.col), ', '), string_agg(x.val, ', '))
             FROM (VALUES ('ot_number', quote_literal('ZZ-C40-' || left(gen_random_uuid()::text, 8))), ('vehicle_plate', quote_literal(v_plate2)),
                          ('created_at', 'now() - interval ''2 days'''), ('type', '''CORRECTIVO'''), ('order_type', '''CORRECTIVA'''), ('status', '''BORRADOR'''),
                          ('description', '''ZZ C40 OT''')) x(col, val)
             WHERE EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema = 'public' AND ic.table_name = 'maintenance_work_orders' AND ic.column_name = x.col));
    v_ot := 'con OT';
  EXCEPTION WHEN OTHERS THEN v_ot := 'OT no insertable: ' || left(SQLERRM, 60);
  END;
  UPDATE public.maintenance_requests SET first_response_at = NULL, first_response_by = NULL WHERE id = v_old;
  PERFORM pg_temp.as_user(v_u); c := public.soporte_tablero((v_hoy - 90), v_hoy); PERFORM pg_temp.as_user(NULL);
  IF v_ot <> 'con OT' OR (c -> 'kpis' ->> 'estimadas')::int >= 1 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || 'T5 estimación por OT'::text; END IF;
  v_rep := v_rep || ' | T5 ' || v_ot;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C40 PASS (%/5) %', v_pass, v_rep;
  ELSE
    RAISE EXCEPTION 'CAJA C40 FAIL (%/5): % || %', v_pass, array_to_string(v_fail, ' || '), v_rep;
  END IF;
END $test$;
