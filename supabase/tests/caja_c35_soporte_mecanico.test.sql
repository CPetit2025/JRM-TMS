-- CAJA C35 — Soporte Mecánico: rol, aviso de fallas, capacidad de respuesta, KPI e informe mensual.
--   T1 rol Soporte Mecánico con su permiso y los de fallas y OT; T2 el Jefe de Distribución (permisos de despacho)
--   reporta una falla con reportar_falla, que avisa a Soporte Mecánico, indica quién la reportó y queda en el historial; T3 el técnico la toma: primera atención,
--   responsable e historial; T4 sus KPI del mes cuentan la falla con su tiempo de respuesta, índice y detalle;
--   T5 una falla crítica sin atención fuera del SLA avisa; T6 el día 1 recuerda el informe y, pasado el plazo, avisa el
--   atraso; T7 el técnico presenta el informe del mes anterior con los días de atraso y el supervisor lo revisa (no el
--   propio técnico); T8 sin permiso no hay KPI de otros, ni informe, ni equipo. Solo lectura (se revierte).
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

DO $test$
DECLARE
  v_tec uuid; v_sup uuid; v_jefe uuid; r_tec uuid; r_sup uuid; r_jefe uuid; r_nada uuid;
  v_plate text; v_plate2 text; v_req uuid; v_req2 uuid; r jsonb; a jsonb; n int; v_fail text[] := '{}'; v_pass int := 0; v_rep text;
  v_hoy date := (now() AT TIME ZONE 'America/Lima')::date; v_prev date; v_plazo int; v_atraso int;
BEGIN
  SELECT COALESCE(jsonb_agg(to_jsonb(x.id) ORDER BY x.id), '[]') INTO r FROM (SELECT id FROM public.profiles WHERE id IN (SELECT u2.id FROM auth.users u2)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 2) x;
  IF jsonb_array_length(r) < 2 THEN RAISE EXCEPTION 'CAJA C35 FAIL (0/8): se necesitan 2 usuarios de prueba'; END IF;
  -- El mismo usuario reporta como Jefe de Distribución (T2) y luego revisa como supervisor (T7)
  v_tec := (r ->> 0)::uuid; v_sup := (r ->> 1)::uuid; v_jefe := v_sup;
  SELECT id INTO r_tec FROM public.roles WHERE name = 'Soporte Mecánico';
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C35 supervisor', '["mantenimiento-dashboard","mantenimiento-fallas"]') RETURNING id INTO r_sup;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C35 jefe', '["despacho","caja-aprobacion"]') RETURNING id INTO r_jefe;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C35 nada', '["clientes"]') RETURNING id INTO r_nada;
  UPDATE public.profiles SET role_id = r_tec, is_active = true WHERE id = v_tec;
  UPDATE public.profiles SET role_id = r_jefe, is_active = true WHERE id = v_jefe;
  -- Unidades sin fallas abiertas (las críticas bloquean la unidad; todo se revierte)
  SELECT plate INTO v_plate FROM public.vehicles ORDER BY plate LIMIT 1;
  SELECT plate INTO v_plate2 FROM public.vehicles WHERE plate <> v_plate ORDER BY plate LIMIT 1;

  -- T1
  IF r_tec IS NOT NULL AND (SELECT permissions ? 'mantenimiento-soporte' AND permissions ? 'mantenimiento-fallas' AND permissions ? 'mantenimiento-ot'
                            FROM public.roles WHERE id = r_tec) THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T1 rol'::text; END IF;

  -- T2 (reporte del Jefe de Distribución desde la web)
  PERFORM pg_temp.as_user(v_jefe);
  a := public.reportar_falla(v_plate, 'ZZ C35 ruido en el embrague ' || gen_random_uuid(), 'ALTA', NULL);
  PERFORM pg_temp.as_user(NULL);
  v_req := (a ->> 'id')::uuid;
  IF v_req IS NULL THEN RAISE EXCEPTION 'CAJA C35 FAIL (%/8): T2 el Jefe de Distribución no pudo reportar: %', v_pass, a::text; END IF;
  SELECT titulo || ' | ' || cuerpo INTO v_rep FROM public.notifications WHERE dedupe_key = 'fal-' || v_req AND 'mantenimiento-soporte' = ANY (permisos);
  IF v_rep LIKE '%' || v_plate || '%' AND v_rep LIKE '%ZZ C35 jefe%'
     AND EXISTS (SELECT 1 FROM public.maintenance_request_events WHERE request_id = v_req AND evento = 'REPORTADA' AND by = v_jefe)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 aviso: ' || COALESCE(v_rep, 'sin aviso')); END IF;

  UPDATE public.profiles SET role_id = r_sup WHERE id = v_sup;

  -- T3 (el técnico la ve en su campana y la toma)
  PERFORM pg_temp.as_user(v_tec);
  n := (SELECT count(*) FROM public.notifications WHERE dedupe_key = 'fal-' || v_req AND public.notif_can_see(permisos, target_user));
  a := public.soporte_tomar_falla(v_req, NULL, 'En camino');
  PERFORM pg_temp.as_user(NULL);
  IF n = 1 AND (a ->> 'success')::boolean AND EXISTS (SELECT 1 FROM public.maintenance_requests WHERE id = v_req AND assigned_to = v_tec AND first_response_by = v_tec AND first_response_at IS NOT NULL)
     AND EXISTS (SELECT 1 FROM public.maintenance_request_events WHERE request_id = v_req AND evento = 'TOMADA' AND by = v_tec)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 tomar: visible=' || n || ' ' || a::text); END IF;

  -- T4
  PERFORM pg_temp.as_user(v_tec); r := public.soporte_kpis(NULL, v_hoy); PERFORM pg_temp.as_user(NULL);
  IF (r ->> 'success')::boolean AND (r -> 'fallas' ->> 'atendidas')::int >= 1 AND (r -> 'fallas' ->> 'respuesta_en_sla_pct') IS NOT NULL
     AND r ->> 'indice' IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'detalle') d WHERE d ->> 'id' = v_req::text AND (d ->> 'respuesta_ok')::boolean)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 kpis: ' || left(r::text, 200)); END IF;

  -- T5 (crítica reportada hace 2 h, nadie la atendió: plazo 1 h)
  INSERT INTO public.maintenance_requests (vehicle_plate, description, severity, reported_at) VALUES (v_plate2, 'ZZ C35 frenos ' || gen_random_uuid(), 'CRITICA', now() - interval '2 hours')
  RETURNING id INTO v_req2;
  PERFORM public.soporte_alertas();
  IF EXISTS (SELECT 1 FROM public.notifications WHERE dedupe_key = 'fal-sla-' || v_req2 AND evento = 'FALLA_SIN_ATENCION') AND NOT EXISTS (SELECT 1 FROM public.notifications WHERE dedupe_key = 'fal-sla-' || v_req)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T5 sin atención'::text; END IF;

  -- T6 (día 1 a las 09:00 y día 6 de un mes futuro, sin informe del mes anterior)
  PERFORM public.soporte_alertas((date_trunc('month', v_hoy) + interval '2 months' + interval '9 hours')::timestamp AT TIME ZONE 'America/Lima');
  PERFORM public.soporte_alertas((date_trunc('month', v_hoy) + interval '2 months' + interval '5 days 9 hours')::timestamp AT TIME ZONE 'America/Lima');
  IF EXISTS (SELECT 1 FROM public.notifications WHERE evento = 'SOPORTE_INFORME' AND target_user = v_tec AND dedupe_key = 'sop-inf-' || v_tec || '-' || to_char(date_trunc('month', v_hoy) + interval '1 month', 'YYYYMM'))
     AND EXISTS (SELECT 1 FROM public.notifications WHERE evento = 'SOPORTE_INFORME_ATRASADO' AND target_user = v_tec AND titulo LIKE '%3 días de atraso%')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T6 recordatorio informe'::text; END IF;

  -- T7 (informe del mes anterior presentado hoy)
  v_prev := (date_trunc('month', v_hoy) - interval '1 month')::date;
  v_plazo := public.soporte_param('plazo_informe_dia', 3)::int;
  v_atraso := GREATEST(v_hoy - ((v_prev + interval '1 month')::date + v_plazo - 1), 0);
  DELETE FROM public.soporte_informes WHERE user_id = v_tec AND periodo = v_prev;
  PERFORM pg_temp.as_user(v_tec);
  a := public.soporte_enviar_informe(v_prev, 'ZZ C35 atendí las fallas del mes y cerré las OT', 'Falta repuesto de frenos', 'Stock mínimo de pastillas');
  r := public.soporte_revisar_informe((a ->> 'id')::uuid, 'REVISADO', 'propio');
  PERFORM pg_temp.as_user(v_sup);
  a := a || jsonb_build_object('rev', public.soporte_revisar_informe((a ->> 'id')::uuid, 'REVISADO', 'Conforme'), 'equipo', public.soporte_equipo(v_prev) ->> 'success');
  PERFORM pg_temp.as_user(NULL);
  IF (a ->> 'success')::boolean AND (a ->> 'dias_atraso')::int = v_atraso AND NOT (r ->> 'success')::boolean
     AND (a -> 'rev' ->> 'success')::boolean AND (a ->> 'equipo')::boolean
     AND EXISTS (SELECT 1 FROM public.soporte_informes WHERE id = (a ->> 'id')::uuid AND estado = 'REVISADO' AND kpis ? 'indice')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T7 informe: ' || left(a::text, 200)); END IF;

  -- T8
  UPDATE public.profiles SET role_id = r_nada WHERE id = v_jefe;
  PERFORM pg_temp.as_user(v_tec); r := public.soporte_kpis(v_sup, v_hoy); a := public.soporte_equipo(NULL); PERFORM pg_temp.as_user(NULL);
  PERFORM pg_temp.as_user(v_jefe);
  IF NOT (r ->> 'success')::boolean AND NOT (a ->> 'success')::boolean AND NOT (public.soporte_kpis(NULL, v_hoy) ->> 'success')::boolean
     AND NOT (public.soporte_enviar_informe(v_prev, 'ZZ C35 no corresponde a este rol') ->> 'success')::boolean
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T8 permisos'::text; END IF;
  PERFORM pg_temp.as_user(NULL);

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C35 PASS (%/8) aviso: %', v_pass, v_rep;
  ELSE
    RAISE EXCEPTION 'CAJA C35 FAIL (%/8): % || aviso: %', v_pass, array_to_string(v_fail, ' || '), v_rep;
  END IF;
END $test$;
