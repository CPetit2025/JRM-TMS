-- CAJA C39 — Índice de Prioridad de Recambio (IPR) de Eficiencia de Flota.
--   T1 puntaje lineal; T2 falla crítica de seguridad (un foco no cuenta; frenos de S/ 800 sí; CRITICA reportada siempre;
--   ALTA solo en sistemas de seguridad); T3 con permiso el IPR de cada activo va de 0 a 100, trae 11 factores y su categoría
--   respeta los rangos (0–39, 40–59, 60–79, 80–100; menos de 50 % medido = datos insuficientes); T4 sin permiso no hay
--   índice; T5 los pesos cambian el índice (solo antigüedad = puntaje de antigüedad) y un peso fuera de rango se rechaza;
--   T6 la evaluación manual se guarda y aparece en la unidad. Solo lectura (se revierte).
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

DO $test$
DECLARE v_user uuid; r_carga uuid; r_nada uuid; r jsonb; r2 jsonb; a jsonb; x jsonb; v_code text; n int; bad int;
  v_fail text[] := '{}'; v_pass int := 0; v_rep text := '';
BEGIN
  SELECT id INTO v_user FROM public.profiles WHERE id IN (SELECT u2.id FROM auth.users u2)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  IF v_user IS NULL THEN RAISE EXCEPTION 'CAJA C39 FAIL (0/6): se necesita un usuario de prueba'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C39 carga', '["flota-eficiencia-carga"]') RETURNING id INTO r_carga;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C39 nada', '["clientes"]') RETURNING id INTO r_nada;
  UPDATE public.profiles SET is_active = true, role_id = r_carga WHERE id = v_user;

  -- T1
  IF public.fe_lin(0.5, 0, 1) = 50 AND public.fe_lin(2, 0, 1) = 100 AND public.fe_lin(-1, 0, 1) = 0
     AND public.fe_lin(0.90, 0.98, 0.85) BETWEEN 61 AND 62 AND public.fe_lin(NULL, 0, 1) IS NULL
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T1 puntaje lineal'::text; END IF;

  -- T2
  IF NOT public.fe_ev_critica('EXCEL', NULL, 'ELECTRICO', 20, false, 'TRANSPORTE')
     AND public.fe_ev_critica('EXCEL', NULL, 'FRENOS', 800, false, 'TRANSPORTE')
     AND NOT public.fe_ev_critica('EXCEL', NULL, 'MOTOR', 5000, true, 'TRANSPORTE')
     AND public.fe_ev_critica('TMS', 'CRITICA', 'MOTOR', NULL, false, 'TRANSPORTE')
     AND public.fe_ev_critica('TMS', 'ALTA', 'FRENOS', NULL, false, 'TRANSPORTE')
     AND NOT public.fe_ev_critica('TMS', 'ALTA', 'MOTOR', NULL, false, 'TRANSPORTE')
     AND public.fe_ev_critica('EXCEL', NULL, 'HIDRAULICO', 900, false, 'MONTACARGA')
     AND NOT public.fe_ev_critica('EXCEL', NULL, 'HIDRAULICO', 900, false, 'TRANSPORTE')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T2 falla crítica'::text; END IF;

  -- T3
  PERFORM pg_temp.as_user(v_user);
  r := public.fe_ipr('{}'::jsonb);
  PERFORM pg_temp.as_user(NULL);
  IF NOT COALESCE((r ->> 'success')::boolean, false) THEN
    v_fail := v_fail || ('T3 fe_ipr: ' || left(r::text, 200));
  ELSE
    SELECT count(*), count(*) FILTER (WHERE
        jsonb_array_length(q.j -> 'factores') <> 11
        OR (q.j ->> 'ipr') IS NOT NULL AND ((q.j ->> 'ipr')::numeric < 0 OR (q.j ->> 'ipr')::numeric > 100)
        OR q.j ->> 'categoria' <> CASE WHEN q.j ->> 'ipr' IS NULL OR COALESCE((q.j ->> 'cobertura')::numeric, 0) < 50 THEN 'Datos insuficientes'
                                     WHEN (q.j ->> 'ipr')::numeric >= 80 THEN 'Recambio prioritario' WHEN (q.j ->> 'ipr')::numeric >= 60 THEN 'Programar recambio'
                                     WHEN (q.j ->> 'ipr')::numeric >= 40 THEN 'Monitorear' ELSE 'Conservar' END)
    INTO n, bad FROM jsonb_array_elements(r -> 'activos') AS q(j);
    IF bad = 0 AND (SELECT sum(value::numeric) FROM jsonb_each_text(r -> 'pesos')) > 0 THEN v_pass := v_pass + 1;
    ELSE v_fail := v_fail || ('T3 rangos: ' || bad || ' de ' || n); END IF;
    SELECT string_agg(z.c || ' ' || z.k, ', ') INTO v_rep FROM (SELECT q.j ->> 'categoria' AS c, count(*) AS k FROM jsonb_array_elements(r -> 'activos') AS q(j) GROUP BY 1 ORDER BY 1) z;
    v_rep := n || ' activos: ' || COALESCE(v_rep, '') || COALESCE(' | primero ' || (r -> 'activos' -> 0 ->> 'code') || ' ' || (r -> 'activos' -> 0 ->> 'ipr'), '');
  END IF;

  -- T4
  UPDATE public.profiles SET role_id = r_nada WHERE id = v_user;
  PERFORM pg_temp.as_user(v_user);
  IF NOT COALESCE((public.fe_ipr('{}'::jsonb) ->> 'success')::boolean, false)
     AND NOT (public.fe_ipr_guardar('{"antiguedad": 50}'::jsonb, NULL) ->> 'success')::boolean
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T4 permisos'::text; END IF;
  PERFORM pg_temp.as_user(NULL);
  UPDATE public.profiles SET role_id = r_carga WHERE id = v_user;

  -- T5 (solo antigüedad)
  PERFORM pg_temp.as_user(v_user);
  a := public.fe_ipr_guardar('{"mantenimiento":0,"disponibilidad":0,"fallas":0,"antiguedad":100,"kilometraje":0,"consumo":0,"costo_km":0,"productividad":0,"seguridad":0}'::jsonb, NULL);
  r2 := public.fe_ipr('{}'::jsonb);
  x := public.fe_ipr_guardar('{"antiguedad": 150}'::jsonb, NULL);
  PERFORM pg_temp.as_user(NULL);
  SELECT count(*) INTO bad FROM jsonb_array_elements(r2 -> 'activos') y,
    LATERAL (SELECT (f ->> 'puntaje')::numeric AS s FROM jsonb_array_elements(y -> 'factores') f WHERE f ->> 'codigo' = 'antiguedad') e
  WHERE e.s IS NOT NULL AND y ->> 'piso_seguridad' IS NULL AND abs((y ->> 'ipr')::numeric - round(e.s)) > 1;
  IF (a ->> 'success')::boolean AND (r2 -> 'pesos' ->> 'antiguedad')::numeric = 100 AND bad = 0 AND NOT (x ->> 'success')::boolean
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T5 pesos: ' || bad || ' distintos'); END IF;

  -- T6
  v_code := r -> 'activos' -> 0 ->> 'code';
  IF v_code IS NULL THEN v_pass := v_pass + 1;   -- sin activos no hay qué evaluar
  ELSE
    PERFORM pg_temp.as_user(v_user);
    a := public.fe_ipr_guardar(NULL, jsonb_build_object('code', v_code, 'obsolescencia', 70, 'adecuacion', 30, 'nota', 'ZZ C39 repuestos escasos'));
    r2 := public.fe_ipr('{}'::jsonb);
    PERFORM pg_temp.as_user(NULL);
    IF (a ->> 'success')::boolean AND EXISTS (SELECT 1 FROM jsonb_array_elements(r2 -> 'activos') y
          WHERE y ->> 'code' = v_code AND (y -> 'evaluacion' ->> 'obsolescencia')::int = 70 AND y -> 'evaluacion' ->> 'nota' = 'ZZ C39 repuestos escasos')
    THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T6 evaluación manual'::text; END IF;
  END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C39 PASS (%/6) %', v_pass, v_rep;
  ELSE
    RAISE EXCEPTION 'CAJA C39 FAIL (%/6): % || %', v_pass, array_to_string(v_fail, ' || '), v_rep;
  END IF;
END $test$;
