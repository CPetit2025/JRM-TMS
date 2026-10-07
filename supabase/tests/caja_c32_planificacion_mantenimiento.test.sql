-- CAJA C32 — Planificación de mantenimiento:
--   T1 planificación con resumen, próximos 90 días, correctivo y calidad de datos; T2 el correctivo detecta sistemas con
--   fallas repetidas y propone inspección; T3 el plan anual sigue respondiendo con la base común; T4 plan anual y
--   planificación coinciden en servicios vencidos; T5 activar planes de una unidad (con permiso); T6 agregar inspección
--   (sin duplicar); T7 sin permiso no hay planificación ni activación; T8 la calidad de datos avisa los planes sin activar.
--   Informe: resumen de 12 meses, vencidos, próximos 30 días y unidades de riesgo alto. Solo lectura (se revierte).
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

-- Test-only temporary helpers: public execution defaults are intentionally revoked.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE v_user uuid; r_p uuid; r_n uuid; r jsonb; a jsonb; v_fail text[] := '{}'; v_pass int := 0; v_plate text; n int; v_rep text; v_cal boolean; v_inact boolean;
BEGIN
  SELECT id INTO v_user FROM public.profiles WHERE id IN (SELECT u2.id FROM auth.users u2)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C32 planes', '["mantenimiento-planes:write"]') RETURNING id INTO r_p;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C32 nada', '["clientes"]') RETURNING id INTO r_n;
  UPDATE public.profiles SET role_id = r_p, is_active = true WHERE id = v_user;

  v_inact := EXISTS (SELECT 1 FROM public.maintenance_plans WHERE NOT is_active AND mant_template_id IS NOT NULL);
  -- T1
  PERFORM pg_temp.as_user(v_user); r := public.mant_planificacion(); PERFORM pg_temp.as_user(NULL);
  IF (r ->> 'success')::boolean AND r ? 'resumen' AND jsonb_array_length(r -> 'proximos') > 0 AND jsonb_array_length(r -> 'correctivo') >= 12
     AND jsonb_typeof(r -> 'calidad') = 'array' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T1 planificación: ' || left(r::text, 200)); END IF;
  v_cal := EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'calidad') q WHERE q ->> 'codigo' = 'planes');
  v_rep := '12m ' || COALESCE(r -> 'resumen' ->> 'total', '?') || ' (' || COALESCE(r -> 'resumen' ->> 'pct_correctivo', '?') || '% corr)'
        || ', vencidos ' || COALESCE(r -> 'resumen' ->> 'vencidos', '?') || ', próximos 30d ' || COALESCE(r -> 'resumen' ->> 'proximos_30', '?')
        || ', riesgo alto: ' || COALESCE((SELECT string_agg(x ->> 'plate', ' ') FROM jsonb_array_elements(r -> 'correctivo') x WHERE x ->> 'nivel' = 'ALTO'), '-')
        || ', calidad: ' || COALESCE((SELECT string_agg(q ->> 'codigo' || '=' || COALESCE(q ->> 'cantidad', '?'), ' ') FROM jsonb_array_elements(r -> 'calidad') q), '-');

  -- T2
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'correctivo') u, jsonb_array_elements(u -> 'sistemas') s
             WHERE (s ->> 'eventos')::int >= 3 AND (s ->> 'inspeccion_dias')::int BETWEEN 30 AND 180 AND s ->> 'recomendacion' LIKE 'Inspección de %')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T2 correctivo'::text; END IF;

  -- T3 y T4
  PERFORM pg_temp.as_user(v_user); a := public.mant_plan_anual(NULL); PERFORM pg_temp.as_user(NULL);
  IF (a ->> 'success')::boolean AND jsonb_array_length(a -> 'totales' -> 'por_mes') = 12 AND (a -> 'totales' ->> 'preventivo')::numeric > 0
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 plan anual: ' || left(a::text, 150)); END IF;
  IF (a -> 'totales' ->> 'vencidos')::int = (r -> 'resumen' ->> 'vencidos')::int THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T4 coherencia: ' || (a -> 'totales' ->> 'vencidos') || ' vs ' || (r -> 'resumen' ->> 'vencidos')); END IF;

  -- T5
  SELECT vehicle_plate INTO v_plate FROM public.maintenance_plans WHERE NOT is_active AND mant_template_id IS NOT NULL ORDER BY vehicle_plate LIMIT 1;
  IF v_plate IS NULL THEN
    v_pass := v_pass + 1;   -- ya estaban todos activos
  ELSE
    SELECT count(*) INTO n FROM public.maintenance_plans WHERE vehicle_plate = v_plate AND NOT is_active AND mant_template_id IS NOT NULL;
    PERFORM pg_temp.as_user(v_user); a := public.mant_activar_planes(v_plate); PERFORM pg_temp.as_user(NULL);
    IF (a ->> 'activados')::int = n AND NOT EXISTS (SELECT 1 FROM public.maintenance_plans WHERE vehicle_plate = v_plate AND NOT is_active AND mant_template_id IS NOT NULL)
    THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T5 activar: ' || a::text); END IF;
  END IF;

  -- T6
  SELECT plate INTO v_plate FROM public.vehicles ORDER BY plate LIMIT 1;
  PERFORM pg_temp.as_user(v_user);
  a := public.mant_agregar_inspeccion(v_plate, 'HIDRAULICO', 60, 'ZZ C32');
  r := public.mant_agregar_inspeccion(v_plate, 'HIDRAULICO', 60, 'ZZ C32');
  PERFORM pg_temp.as_user(NULL);
  IF (a ->> 'success')::boolean AND NOT (r ->> 'success')::boolean
     AND EXISTS (SELECT 1 FROM public.maintenance_plans WHERE vehicle_plate = v_plate AND name = 'Inspección: Hidráulico y mástil' AND is_active AND frequency_days = 60)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T6 inspección: ' || a::text); END IF;

  -- T7
  UPDATE public.profiles SET role_id = r_n WHERE id = v_user;
  PERFORM pg_temp.as_user(v_user); r := public.mant_planificacion(); a := public.mant_activar_planes(NULL); PERFORM pg_temp.as_user(NULL);
  IF NOT (r ->> 'success')::boolean AND NOT (a ->> 'success')::boolean THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T7 sin permiso'::text; END IF;

  -- T8
  IF v_cal = v_inact THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T8 calidad'::text; END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C32 PASS (%/8) %', v_pass, v_rep;
  ELSE
    RAISE EXCEPTION 'CAJA C32 FAIL (%/8): % || %', v_pass, array_to_string(v_fail, ' || '), v_rep;
  END IF;
END $test$;
