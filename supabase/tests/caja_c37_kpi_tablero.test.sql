-- CAJA C37 — Tablero de KPI (un solo módulo para el Jefe de Distribución y el Administrador) y «Mi avance».
--   T1 cinco roles medidos (incluye Soporte Mecánico), historial y cierre diario; T2 la ficha de Soporte tiene la forma
--   común y no da índice con menos del 40 % del peso; T3 el revisor (solo permiso «desempeno») ve el tablero completo,
--   con Soporte calculado y la evolución de 6 meses; T4 sin permiso no hay tablero ni historial ajeno; T5 «Mi avance»
--   del integrante trae su rol, el mes anterior y la evolución, y quien no está medido no tiene roles; T6 el cierre del
--   mes guarda una foto por integrante; T7 el revisor revisa el informe de Soporte Mecánico desde el tablero; T8 el día 5
--   avisa al revisor que el tablero del mes anterior está listo. Solo lectura (se revierte).
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

-- Test-only temporary helpers: public execution defaults are intentionally revoked.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE
  ids jsonb; v_u1 uuid; v_u2 uuid; r_mem uuid; r_rev uuid; r_nada uuid; r_sop uuid; t jsonb; a jsonb; k jsonb; f jsonb;
  v_fail text[] := '{}'; v_pass int := 0; v_rep text := ''; n int; n2 int;
  v_hoy date := (now() AT TIME ZONE 'America/Lima')::date; v_prev date;
BEGIN
  v_prev := (date_trunc('month', v_hoy) - interval '1 month')::date;
  SELECT COALESCE(jsonb_agg(to_jsonb(x.id) ORDER BY x.id), '[]') INTO ids FROM (SELECT id FROM public.profiles WHERE id IN (SELECT u2.id FROM auth.users u2)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 2) x;
  IF jsonb_array_length(ids) < 2 THEN RAISE EXCEPTION 'CAJA C37 FAIL (0/8): se necesitan 2 usuarios de prueba'; END IF;
  v_u1 := (ids ->> 0)::uuid; v_u2 := (ids ->> 1)::uuid;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C37 supervisor de despacho', '["despacho-aprobacion"]') RETURNING id INTO r_mem;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C37 revisor', '["desempeno"]') RETURNING id INTO r_rev;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C37 nada', '["clientes"]') RETURNING id INTO r_nada;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C37 soporte', '["mantenimiento-soporte","mantenimiento-fallas"]') RETURNING id INTO r_sop;
  UPDATE public.profiles SET role_id = r_mem, is_active = true WHERE id = v_u1;
  UPDATE public.profiles SET role_id = r_rev, is_active = true WHERE id = v_u2;

  -- T1
  IF (SELECT count(*) FROM public.kpi_roles_todos()) = 5 AND EXISTS (SELECT 1 FROM public.kpi_roles_todos() WHERE rol = 'SOPORTE')
     AND to_regclass('public.kpi_historial') IS NOT NULL AND to_regprocedure('public.kpi_historial_job(timestamptz)') IS NOT NULL
     AND position('desempeno_es_revisor' IN pg_get_functiondef('public.soporte_kpis(uuid,date)'::regprocedure)) > 0
     AND position('desempeno_es_revisor' IN pg_get_functiondef('public.soporte_revisar_informe(uuid,text,text)'::regprocedure)) > 0
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T1 roles, historial y permisos de Soporte'::text; END IF;

  -- T2
  f := public.kpi_soporte_ficha(jsonb_build_object('success', true, 'usuario', v_u1, 'periodo', v_prev, 'indice', 20, 'calificacion', 'BAJO',
         'componentes', jsonb_build_object('backlog', 50, 'informe', 0), 'fallas', '{}'::jsonb, 'backlog', jsonb_build_object('abiertas', 2)));
  k := public.kpi_soporte_ficha(jsonb_build_object('success', true, 'usuario', v_u1, 'periodo', v_prev, 'indice', 87, 'calificacion', 'BUENO',
         'componentes', jsonb_build_object('respuesta', 100, 'solucion', 80, 'reincidencia', 100, 'backlog', 50, 'informe', 85), 'fallas', '{}'::jsonb));
  IF f ->> 'indice' IS NULL AND f ->> 'calificacion' = 'SIN_DATOS' AND (f ->> 'cobertura')::numeric = 25
     AND (k ->> 'indice')::numeric = 87 AND (k ->> 'cobertura')::numeric = 100 AND jsonb_array_length(k -> 'kpis') = 7
     AND jsonb_array_length(public.kpi_por_mejorar(k)) = 1
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 ficha de Soporte: ' || left(f::text, 120)); END IF;

  -- T3 (revisor sin permisos de mantenimiento)
  PERFORM pg_temp.as_user(v_u2);
  t := public.kpi_tablero(v_prev);
  PERFORM pg_temp.as_user(NULL);
  IF (t ->> 'success')::boolean AND jsonb_array_length(t -> 'roles') = 5
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t -> 'roles') r WHERE jsonb_array_length(r -> 'tendencia') <> 6)
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t -> 'alertas') x WHERE x ->> 'tipo' = 'ERROR')
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(t -> 'roles') r, jsonb_array_elements(r -> 'miembros') m WHERE r ->> 'rol' = 'DESPACHO' AND m ->> 'user_id' = v_u1::text)
     AND t -> 'general' ? 'indice'
  THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T3 tablero: ' || left(COALESCE((t -> 'alertas')::text, t::text), 200)); END IF;
  v_rep := 'general ' || COALESCE(t -> 'general' ->> 'indice', 's/d') || ', ' ||
    (SELECT string_agg(r ->> 'rol' || ' ' || (r ->> 'n') || ' pers. ' || COALESCE(r ->> 'promedio', 's/d'), ', ') FROM jsonb_array_elements(t -> 'roles') r)
    || ', alertas ' || jsonb_array_length(t -> 'alertas') || ', informes por revisar ' || jsonb_array_length(t -> 'informes');

  -- T4
  UPDATE public.profiles SET role_id = r_nada WHERE id = v_u2;
  PERFORM pg_temp.as_user(v_u2);
  a := public.kpi_tablero(v_prev);
  n := (SELECT count(*) FROM public.kpi_historial WHERE user_id IS DISTINCT FROM v_u2);
  PERFORM pg_temp.as_user(NULL);
  IF NOT (a ->> 'success')::boolean AND n = 0 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 permisos: historial visible ' || n); END IF;

  -- T5
  PERFORM pg_temp.as_user(v_u1); a := public.kpi_mi_avance(NULL);
  PERFORM pg_temp.as_user(v_u2); k := public.kpi_mi_avance(NULL);
  PERFORM pg_temp.as_user(NULL);
  IF (a ->> 'success')::boolean AND EXISTS (SELECT 1 FROM jsonb_array_elements(a -> 'roles') r WHERE r ->> 'rol' = 'DESPACHO'
         AND jsonb_array_length(r -> 'tendencia') = 6 AND r -> 'anterior' ->> 'periodo' = v_prev::text AND r ? 'kpis_total')
     AND (a ->> 'dias_transcurridos')::int = extract(day FROM v_hoy)::int
     AND (k ->> 'success')::boolean AND jsonb_array_length(k -> 'roles') = 0
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T5 mi avance: ' || left(a::text, 160)); END IF;

  -- T6
  n := public.kpi_cerrar_mes(v_prev);
  SELECT count(*) INTO n2 FROM public.kpi_roles_todos() kr CROSS JOIN LATERAL public.kpi_miembros(kr.rol) m;
  IF n = n2 AND EXISTS (SELECT 1 FROM public.kpi_historial WHERE rol = 'DESPACHO' AND sujeto = v_u1 AND periodo = v_prev AND ficha ? 'kpis')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T6 cierre: ' || n || ' de ' || n2); END IF;

  -- T7 (informe de Soporte del mes anterior; lo revisa quien solo tiene «desempeno»)
  UPDATE public.profiles SET role_id = r_sop WHERE id = v_u1;
  UPDATE public.profiles SET role_id = r_rev WHERE id = v_u2;
  DELETE FROM public.soporte_informes WHERE user_id = v_u1 AND periodo = v_prev;
  PERFORM pg_temp.as_user(v_u1);
  a := public.soporte_enviar_informe(v_prev, 'ZZ C37 atendí las fallas del mes y cerré las OT');
  PERFORM pg_temp.as_user(v_u2);
  t := public.kpi_tablero(v_prev);
  k := public.soporte_revisar_informe((a ->> 'id')::uuid, 'REVISADO', 'Conforme');
  PERFORM pg_temp.as_user(NULL);
  IF (a ->> 'success')::boolean AND (k ->> 'success')::boolean
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(t -> 'informes') i WHERE i ->> 'id' = a ->> 'id' AND i ->> 'origen' = 'SOPORTE')
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(t -> 'roles') r, jsonb_array_elements(r -> 'miembros') m WHERE r ->> 'rol' = 'SOPORTE' AND m ->> 'user_id' = v_u1::text AND (m ->> 'success')::boolean)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T7 informe de Soporte: ' || left(a::text, 100) || ' ' || left(k::text, 100)); END IF;

  -- T8 (día 5 de un mes futuro)
  PERFORM public.kpi_historial_job((date_trunc('month', v_hoy) + interval '2 months' + interval '4 days 9 hours')::timestamp AT TIME ZONE 'America/Lima');
  PERFORM pg_temp.as_user(v_u2);
  n := (SELECT count(*) FROM public.notifications WHERE evento = 'KPI_TABLERO_MES'
          AND dedupe_key = 'kpi-tab-' || to_char(date_trunc('month', v_hoy) + interval '1 month', 'YYYYMM') AND public.notif_can_see(permisos, target_user));
  PERFORM pg_temp.as_user(NULL);
  IF n = 1 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T8 aviso del día 5'::text; END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C37 PASS (%/8) %', v_pass, v_rep;
  ELSE
    RAISE EXCEPTION 'CAJA C37 FAIL (%/8): % || %', v_pass, array_to_string(v_fail, ' || '), v_rep;
  END IF;
END $test$;
