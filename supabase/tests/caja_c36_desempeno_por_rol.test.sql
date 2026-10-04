-- CAJA C36 — Desempeño por rol (Despacho, Transporte, Documentario y Conductores).
--   T1 roles medidos y KPI con peso; T2 puntaje y salida puntual; T3 historial de estados del despacho (disparador);
--   T4 el cálculo de cada rol corre sin errores con los datos reales (hasta 5 integrantes por rol, mes anterior);
--   T5 reprogramar y anular exigen causa y el cargo exige el permiso de Documentario; T6 informe mensual: lo presenta
--   el integrante con sus días de atraso y lo revisa quien tiene «desempeno»; T7 día 1 recordatorio y luego atraso;
--   T8 sin permiso no hay equipo ni cambio de metas, y quien no es conductor no tiene ficha de conductor.
--   Solo lectura (se revierte).
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

DO $test$
DECLARE
  ids jsonb; v_u1 uuid; v_u2 uuid; r_mem uuid; r_rev uuid; r_nada uuid; m record; k jsonb; a jsonb; r jsonb;
  v_fail text[] := '{}'; v_pass int := 0; v_rep text := ''; n int := 0; v_err text := '';
  v_hoy date := (now() AT TIME ZONE 'America/Lima')::date; v_prev date; v_atraso int; v_plazo int;
BEGIN
  SELECT COALESCE(jsonb_agg(to_jsonb(x.id) ORDER BY x.id), '[]') INTO ids FROM (SELECT id FROM public.profiles WHERE id IN (SELECT u2.id FROM auth.users u2)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 2) x;
  IF jsonb_array_length(ids) < 2 THEN RAISE EXCEPTION 'CAJA C36 FAIL (0/8): se necesitan 2 usuarios de prueba'; END IF;
  v_u1 := (ids ->> 0)::uuid; v_u2 := (ids ->> 1)::uuid;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C36 supervisor de despacho', '["despacho-aprobacion"]') RETURNING id INTO r_mem;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C36 revisor', '["desempeno"]') RETURNING id INTO r_rev;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C36 nada', '["clientes"]') RETURNING id INTO r_nada;
  UPDATE public.profiles SET role_id = r_mem, is_active = true WHERE id = v_u1;
  UPDATE public.profiles SET role_id = r_rev, is_active = true WHERE id = v_u2;

  -- T1
  IF (SELECT count(*) FROM public.kpi_roles) = 4
     AND NOT EXISTS (SELECT 1 FROM public.kpi_roles kr WHERE NOT EXISTS (SELECT 1 FROM public.kpi_parametros p WHERE p.rol = kr.rol AND p.peso > 0))
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T1 roles y parámetros'::text; END IF;

  -- T2
  IF public.kpi_puntaje(90, 90, 'MAYOR') = 100 AND public.kpi_puntaje(45, 90, 'MAYOR') = 50 AND public.kpi_puntaje(0, 0, 'MENOR') = 100
     AND public.kpi_puntaje(1, 0, 'MENOR') = 50 AND public.kpi_puntaje(15, 10, 'MENOR') = 50 AND public.kpi_puntaje(NULL, 10, 'MAYOR') IS NULL
     AND public.kpi_salida_puntual(TIMESTAMPTZ '2026-09-10 08:20-05', TIMESTAMPTZ '2026-09-10 08:00-05')
     AND NOT public.kpi_salida_puntual(TIMESTAMPTZ '2026-09-10 09:00-05', TIMESTAMPTZ '2026-09-10 08:00-05')
     AND public.kpi_salida_puntual(TIMESTAMPTZ '2026-09-10 15:00-05', TIMESTAMPTZ '2026-09-10 00:00-05')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T2 puntaje'::text; END IF;

  -- T3
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_kpi_dispatch_log' AND tgrelid = 'public.dispatches'::regclass) THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || 'T3 historial de despachos'::text; END IF;
  v_rep := 'historial ' || (SELECT count(*) FROM public.kpi_dispatch_log) || ' estados, despachos 90 d: '
        || (SELECT count(*) || ' (con salida ' || count(salida_at) || ', con entrega ' || count(entrega_at) || ')' FROM public.kpi_despachos_v WHERE programado > now() - interval '90 days');

  -- T4
  v_prev := (date_trunc('month', v_hoy) - interval '1 month')::date;
  FOR m IN SELECT kr.rol, x.sujeto, x.nombre, row_number() OVER (PARTITION BY kr.rol ORDER BY x.nombre) AS rn
           FROM public.kpi_roles kr CROSS JOIN LATERAL public.desempeno_miembros(kr.rol) x LOOP
    CONTINUE WHEN m.rn > 5;
    k := public.desempeno_calcular(m.rol, m.sujeto, v_prev);
    n := n + 1;
    IF NOT (k ->> 'success')::boolean OR jsonb_array_length(k -> 'notas') > 0 THEN v_err := v_err || m.rol || ': ' || left((k -> 'notas')::text, 150) || ' '; END IF;
    IF m.rn = 1 THEN v_rep := v_rep || ', ' || m.rol || ' ' || COALESCE(k ->> 'indice', 's/d') || ' (' || COALESCE(k ->> 'cobertura', '0') || '% medido)'; END IF;
  END LOOP;
  IF v_err = '' THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 cálculo: ' || v_err); END IF;
  v_rep := v_rep || ', ' || n || ' fichas';

  -- T5
  v_plazo := public.soporte_param('plazo_informe_dia', 3)::int;
  v_atraso := GREATEST(v_hoy - ((v_prev + interval '1 month')::date + v_plazo - 1), 0);
  PERFORM pg_temp.as_user(v_u1);
  a := public.reprogramar_solicitud(gen_random_uuid(), v_hoy + 1, NULL, NULL);
  r := public.reprogramar_solicitud(gen_random_uuid(), v_hoy + 1, 'OTRO', NULL);
  k := public.anular_documento(gen_random_uuid(), 'X', NULL);
  IF NOT (a ->> 'success')::boolean AND NOT (r ->> 'success')::boolean AND NOT (k ->> 'success')::boolean
     AND NOT (public.registrar_cargo(gen_random_uuid(), 'x.pdf', NULL) ->> 'success')::boolean
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T5 causas'::text; END IF;

  -- T6 (informe del mes anterior presentado hoy, revisado por otro usuario)
  a := public.desempeno_enviar_informe('DESPACHO', v_prev, 'ZZ C36 aprobé y programé las solicitudes del mes', 'Partidas observadas', 'Revisar partidas antes');
  r := public.desempeno_mio(v_prev);
  PERFORM pg_temp.as_user(v_u2);
  k := public.desempeno_revisar_informe((a ->> 'id')::uuid, 'REVISADO', 'Conforme');
  PERFORM pg_temp.as_user(NULL);
  IF (a ->> 'success')::boolean AND (a ->> 'dias_atraso')::int = v_atraso AND (k ->> 'success')::boolean
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'roles') x WHERE x ->> 'rol' = 'DESPACHO')
     AND EXISTS (SELECT 1 FROM public.desempeno_informes WHERE id = (a ->> 'id')::uuid AND estado = 'REVISADO' AND kpis ? 'kpis')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T6 informe: ' || left(a::text, 120) || ' ' || left(k::text, 80)); END IF;

  -- T7 (día 1 a las 09:00 y día 6 de un mes futuro, sin informe del mes anterior)
  PERFORM public.desempeno_alertas((date_trunc('month', v_hoy) + interval '2 months' + interval '9 hours')::timestamp AT TIME ZONE 'America/Lima');
  PERFORM public.desempeno_alertas((date_trunc('month', v_hoy) + interval '2 months' + interval '5 days 9 hours')::timestamp AT TIME ZONE 'America/Lima');
  IF EXISTS (SELECT 1 FROM public.notifications WHERE evento = 'DESEMPENO_INFORME' AND target_user = v_u1
               AND dedupe_key = 'des-inf-' || v_u1 || '-DESPACHO-' || to_char(date_trunc('month', v_hoy) + interval '1 month', 'YYYYMM'))
     AND EXISTS (SELECT 1 FROM public.notifications WHERE evento = 'DESEMPENO_INFORME_ATRASADO' AND target_user = v_u1 AND titulo LIKE '%3 días de atraso%')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T7 recordatorio'::text; END IF;

  -- T8
  UPDATE public.profiles SET role_id = r_nada WHERE id = v_u2;
  PERFORM pg_temp.as_user(v_u2);
  IF NOT (public.desempeno_equipo('DESPACHO', NULL) ->> 'success')::boolean
     AND NOT (public.desempeno_guardar_parametros('[{"rol":"DESPACHO","codigo":"aprob_2h","meta":1,"peso":1}]') ->> 'success')::boolean
     AND NOT (public.conductor_mi_desempeno(NULL) ->> 'success')::boolean
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T8 permisos'::text; END IF;
  PERFORM pg_temp.as_user(NULL);

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C36 PASS (%/8) %', v_pass, v_rep;
  ELSE
    RAISE EXCEPTION 'CAJA C36 FAIL (%/8): % || %', v_pass, array_to_string(v_fail, ' || '), v_rep;
  END IF;
END $test$;
