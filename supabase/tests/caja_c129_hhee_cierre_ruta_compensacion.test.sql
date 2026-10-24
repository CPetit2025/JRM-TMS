-- CAJA C129 — HHEE de rutas: aviso de aprobación al conductor, cierre por geocerca (cierra al SALIR de una base en
-- la que ENTRÓ; si empezó dentro, salir no cierra), cierre del conductor desde el app que cierra también al auxiliar
-- (el auxiliar no cierra), registro del supervisor, ejecutado con reparto legal, pago o compensación y bolsa de horas.
-- Usa un despacho existente con conductor y una geocerca de prueba en el mar; se revierte.
BEGIN;
SET LOCAL statement_timeout = '60s';
DO $test$
DECLARE v_req uuid; v_app uuid; v_aux uuid; v_rreq uuid := gen_random_uuid(); v_rapp uuid := gen_random_uuid(); v_site uuid := gen_random_uuid();
  v_area uuid := gen_random_uuid(); d record; r jsonb; v_id uuid; v_ver int; v_l1 uuid; v_p1 uuid; v_base int; pass int := 0; fails text[] := '{}'; v_note text := '';
BEGIN
  SELECT p.id INTO v_req FROM public.profiles p JOIN auth.users u ON u.id = p.id ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_app FROM public.profiles p JOIN auth.users u ON u.id = p.id WHERE p.id <> v_req ORDER BY p.id LIMIT 1;
  SELECT x.id, x.driver_id, x.vehicle_plate, dr.profile_id AS driver_profile INTO d
  FROM public.dispatches x JOIN public.drivers dr ON dr.id = x.driver_id
  WHERE x.vehicle_plate IS NOT NULL AND x.vehicle_plate <> 'EXTERNO' AND length((public.hhee_driver_master(dr.id))->>'name') >= 3
    AND NOT EXISTS (SELECT 1 FROM public.hhee_requests h WHERE h.auto_dispatch_id = x.id)
    AND dr.profile_id IS DISTINCT FROM v_req AND dr.profile_id IS DISTINCT FROM v_app
  ORDER BY (dr.profile_id IS NULL), x.id LIMIT 1;
  SELECT p.id INTO v_aux FROM public.profiles p WHERE COALESCE(p.is_active, true) AND p.id IS DISTINCT FROM d.driver_profile
    AND p.id NOT IN (v_req, v_app) AND NOT EXISTS (SELECT 1 FROM public.drivers x WHERE x.profile_id = p.id)
    AND length(trim(concat_ws(' ', to_jsonb(p)->>'first_name', to_jsonb(p)->>'last_name'))) >= 3 ORDER BY p.id LIMIT 1;
  IF v_req IS NULL OR v_app IS NULL OR d.id IS NULL OR v_aux IS NULL THEN RAISE EXCEPTION 'CAJA C129 FAIL: faltan perfiles o un despacho con conductor'; END IF;
  INSERT INTO public.roles (id, name, permissions) VALUES
    (v_rreq, 'C129-sup-' || left(v_rreq::text, 8), '["hhee-solicitar:write","hhee:read","despacho:write"]');
  INSERT INTO public.roles(id,name,permissions) VALUES(v_rapp,'Jefe de Distribución','["hhee-aprobar:write","hhee-costos:read","hhee-gerencia:read","hhee-config:write","hhee:read"]') ON CONFLICT(name) DO UPDATE SET permissions=excluded.permissions RETURNING id INTO v_rapp;
  INSERT INTO public.sites (id, code, name) VALUES (v_site, 'C129-' || v_site, 'C129 sede');
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_req, v_site), (v_app, v_site) ON CONFLICT DO NOTHING;
  INSERT INTO public.hhee_areas (id, site_id, name, module_enabled) VALUES (v_area, v_site, 'C129 Distribución', true);
  INSERT INTO public.hhee_memberships VALUES (v_req, v_area), (v_app, v_area);
  UPDATE public.profiles SET role_id = v_rreq, is_active = true WHERE id = v_req;
  UPDATE public.profiles SET role_id = v_rapp, is_active = true WHERE id = v_app;
  -- La ficha del conductor (la existente o una nueva) queda en el área de prueba
  UPDATE public.hhee_people SET area_id = v_area, active = true WHERE driver_id = d.driver_id RETURNING id INTO v_p1;
  IF v_p1 IS NULL THEN
    INSERT INTO public.hhee_people (code, name, area_id, active, daily_hours, monthly_hours, divisor_confirmed, remuneration_concepts, driver_id)
    VALUES ('C129-COND', 'Conductor C129', v_area, true, 8, 240, false, '[]'::jsonb, d.driver_id) RETURNING id INTO v_p1;
  END IF;
  DELETE FROM public.dispatch_crew WHERE dispatch_id = d.id;
  INSERT INTO public.dispatch_crew (dispatch_id, profile_id, crew_role) VALUES (d.id, v_aux, 'AUXILIAR');
  -- Base de prueba (geocerca CEDI) en el mar, lejos de cualquier base real
  IF to_regclass('public.geofences') IS NULL THEN
    EXECUTE 'CREATE TABLE public.geofences (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, color text, type text, description text,
      is_active boolean DEFAULT true, coordinates jsonb, updated_at timestamptz DEFAULT now())';
  END IF;
  EXECUTE $q$INSERT INTO public.geofences (name, color, type, description, is_active, coordinates)
    VALUES ('C129 CEDI prueba', '#3B82F6', 'cedi', 'C129', true, '[[-12.51,-78.51],[-12.51,-78.49],[-12.49,-78.49],[-12.49,-78.51]]'::jsonb)$q$;

  -- Horarios explícitos; el generador ya no inventa el turno global.
  PERFORM set_config('request.jwt.claim.sub', v_app::text, true);
  v_id := public.hhee_person_for(NULL, v_aux, v_area);
  PERFORM public.gp_schedule_save(jsonb_build_object('person_id',v_p1,'from','2025-03-01','mode','FIJO','week',
    (SELECT jsonb_agg(jsonb_build_object('kind','TRABAJO','start','08:00','end','17:30','break_minutes',60)) FROM generate_series(1,7))));
  PERFORM public.gp_schedule_save(jsonb_build_object('person_id',v_id,'from','2025-03-01','mode','FIJO','week',
    (SELECT jsonb_agg(jsonb_build_object('kind','TRABAJO','start','08:00','end','17:30','break_minutes',60)) FROM generate_series(1,7))));
  UPDATE public.dispatches SET departure_time='2025-03-03 08:00:00-05' WHERE id=d.id;

  -- Solicitud automática de la ruta (lunes 03/03/2025, 17:30–20:00), completada, presentada y aprobada
  v_id := (public.hhee_route_request_for(d.id, '2025-03-03 19:10:00-05')->>'id')::uuid;
  IF v_id IS NULL THEN RAISE EXCEPTION 'CAJA C129 FAIL: no se generó la solicitud de la ruta'; END IF;
  UPDATE public.hhee_requests SET created_by = v_req, activity = 'Reparto tardío ruta norte', justification = 'Cliente recibió fuera de horario',
    alternatives = 'Reprogramar al día siguiente', expected_result = 'Entregas completas' WHERE id = v_id;
  SELECT id INTO v_l1 FROM public.hhee_lines WHERE request_id = v_id AND person_id = v_p1;
  PERFORM set_config('request.jwt.claim.sub', v_req::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_req, 'role', 'authenticated')::text, true);
  v_ver := (SELECT version FROM public.hhee_requests WHERE id = v_id);
  r := public.hhee_flow_submit(v_id, v_ver);
  IF NOT (r->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C129 FAIL: presentar %', r; END IF;
  PERFORM set_config('request.jwt.claim.sub', v_app::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_app, 'role', 'authenticated')::text, true);
  v_ver := (SELECT version FROM public.hhee_requests WHERE id = v_id);
  r := public.hhee_flow_decide(jsonb_build_object('id', v_id, 'decision', 'APROBADA', 'reason', 'Necesidad operativa verificada', 'expected_version', v_ver));
  IF NOT (r->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C129 FAIL: aprobar %', r; END IF;

  -- T1: aprobada → aviso al conductor (y al auxiliar con usuario) con enlace a su app
  IF EXISTS (SELECT 1 FROM public.notifications WHERE evento = 'HHEE_APROBADA' AND target_user = v_aux AND link = '/app/hhee')
     AND (d.driver_profile IS NULL OR EXISTS (SELECT 1 FROM public.notifications WHERE evento = 'HHEE_APROBADA' AND target_user = d.driver_profile AND link = '/app/hhee'))
  THEN pass := pass + 1; ELSE fails := fails || 'T1 aviso de aprobación'::text; END IF;

  -- T2: empezó dentro de la base: salir no cierra; vuelve a entrar y al salir cierra (conductor y auxiliar)
  PERFORM public.hhee_geo_point(d.driver_id, -12.50, -78.50, '2025-03-03 18:00:00-05');
  PERFORM public.hhee_geo_point(d.driver_id, -12.60, -78.50, '2025-03-03 18:10:00-05');
  IF (SELECT actual_end FROM public.hhee_lines WHERE id = v_l1) IS NOT NULL THEN fails := fails || 'T2 cerró sin haber entrado'::text; END IF;
  PERFORM public.hhee_geo_point(d.driver_id, -12.50, -78.50, '2025-03-03 19:00:00-05');
  PERFORM public.hhee_geo_point(d.driver_id, -12.50, -78.40, '2025-03-03 19:20:00-05');
  IF (SELECT count(*) FROM public.hhee_lines WHERE request_id = v_id AND actual_end = '2025-03-03 19:20:00-05' AND closed_by = 'GEOCERCA'
        AND (actual_minutes, exec_minutes_25, exec_minutes_35, exec_minutes_100) = (110, 110, 0, 0)) = 2
  THEN pass := pass + 1; ELSE fails := fails || ('T2 geocerca ' || (SELECT jsonb_agg(jsonb_build_object('end', actual_end, 'by', closed_by, 'geo', geo_state, 'in', geo_entered_at)) FROM public.hhee_lines WHERE request_id = v_id)::text); END IF;

  -- T3: el auxiliar no cierra; el conductor cierra desde el app y cierra también al auxiliar
  UPDATE public.hhee_lines SET actual_start = NULL, actual_end = NULL, actual_minutes = NULL, closed_by = NULL, closed_at = NULL, geo_state = NULL, geo_at = NULL,
    geo_entered_at = NULL, exec_minutes_25 = NULL, exec_minutes_35 = NULL, exec_minutes_100 = NULL, exec_cost = NULL WHERE request_id = v_id;
  PERFORM set_config('request.jwt.claim.sub', v_aux::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_aux, 'role', 'authenticated')::text, true);
  r := public.hhee_driver_close(v_id);
  IF (r->>'success')::boolean THEN fails := fails || 'T3 el auxiliar cerró'::text; END IF;
  IF d.driver_profile IS NULL THEN v_note := ' (T3 sin conductor con usuario)'; pass := pass + 1;
  ELSE
    -- (el app cierra hasta 16 h después del inicio: la prueba ubica el inicio hace 2 h)
    UPDATE public.hhee_lines SET planned_start = now() - interval '2 hours' WHERE request_id = v_id;
    PERFORM set_config('request.jwt.claim.sub', d.driver_profile::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', d.driver_profile, 'role', 'authenticated')::text, true);
    r := public.hhee_driver_close(v_id);
    IF (r->>'success')::boolean AND (SELECT count(*) FROM public.hhee_lines WHERE request_id = v_id AND closed_by = 'CONDUCTOR' AND actual_end IS NOT NULL) = 2
       AND NOT (public.hhee_driver_close(v_id)->>'success')::boolean
    THEN pass := pass + 1; ELSE fails := fails || ('T3 cierre del conductor ' || r::text); END IF;
  END IF;

  UPDATE public.hhee_lines SET planned_start = '2025-03-03 17:30:00-05' WHERE request_id = v_id;
  -- T4: el supervisor registra el cierre (con motivo, sin hora futura): 17:30–20:15 = 2 h al 25 % y 45 min al 35 %
  UPDATE public.hhee_lines SET actual_start = NULL, actual_end = NULL, actual_minutes = NULL, closed_by = NULL, closed_at = NULL,
    exec_minutes_25 = NULL, exec_minutes_35 = NULL, exec_minutes_100 = NULL, exec_cost = NULL WHERE request_id = v_id;
  PERFORM set_config('request.jwt.claim.sub', v_req::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_req, 'role', 'authenticated')::text, true);
  IF (public.hhee_flow_close(jsonb_build_object('id', v_id, 'end', '2025-03-03T20:15', 'reason', 'ok'))->>'success')::boolean
     OR (public.hhee_flow_close(jsonb_build_object('id', v_id, 'end', '2099-01-01T20:15', 'reason', 'El app no cerró'))->>'success')::boolean THEN
    fails := fails || 'T4 cierre sin motivo o con hora futura'::text; END IF;
  r := public.hhee_flow_close(jsonb_build_object('id', v_id, 'end', '2025-03-03T20:15', 'reason', 'El app no cerró'));
  IF (r->>'success')::boolean AND (SELECT count(*) FROM public.hhee_lines WHERE request_id = v_id AND closed_by = 'SUPERVISOR'
            AND (actual_minutes, exec_minutes_25, exec_minutes_35) = (165, 120, 45)) = 2
  THEN pass := pass + 1; ELSE fails := fails || 'T4 cierre del supervisor'::text; END IF;

  -- T5: compensación: sin costo en dinero y suma a la bolsa; el descanso no supera la bolsa y se descuenta; anular lo devuelve
  PERFORM set_config('request.jwt.claim.sub', v_req::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_req, 'role', 'authenticated')::text, true);
  IF (public.hhee_line_set_compensation(v_l1, true)->>'success')::boolean THEN fails := fails || 'T5 el solicitante decidió compensación'::text; END IF;
  PERFORM set_config('request.jwt.claim.sub', v_app::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_app, 'role', 'authenticated')::text, true);
  v_base := (public.hhee_comp_balance_of(v_p1)->>'balance')::int;
  r := public.hhee_line_set_compensation(v_l1, true);
  IF NOT (r->>'success')::boolean OR (public.hhee_comp_balance_of(v_p1)->>'balance')::int <> v_base THEN
    fails := fails || 'T5 acreditar antes de validar'::text; END IF;
  PERFORM public.gp_overtime_validate(jsonb_build_object('id',v_id,'version',(SELECT version FROM public.hhee_requests WHERE id=v_id),'reason','Cierre revisado C129'));
  IF (public.hhee_comp_balance_of(v_p1)->>'balance')::int = v_base + 165
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(public.hhee_comp_list(v_p1)->'earned') e WHERE e->>'work_date'='2025-03-03' AND (e->>'minutes')::int=165)
  THEN pass := pass + 1; ELSE fails := fails || 'T5 compensación validada'::text; END IF;
  -- Reserva/aplicación/anulación y saldo insuficiente se cubren en test-gestion-personal.cjs.

  -- T6: detalle y panel muestran lo ejecutado frente a lo autorizado
  r := public.hhee_flow_detail(v_id);
  IF (SELECT bool_and(x ? 'closed_by' AND x ? 'actual_minutes') FROM jsonb_array_elements(r->'lines') x)
     AND (public.hhee_flow_exec_summary(jsonb_build_object('from', '2025-03-03', 'to', '2025-03-03', 'area_id', v_area))->>'executed_minutes')::int = 330
     AND (public.hhee_flow_exec_summary(jsonb_build_object('from', '2025-03-03', 'to', '2025-03-03', 'area_id', v_area))->>'authorized_minutes')::int = 300
  THEN pass := pass + 1; ELSE fails := fails || ('T6 ejecutado ' || public.hhee_flow_exec_summary(jsonb_build_object('from', '2025-03-03', 'to', '2025-03-03', 'area_id', v_area))::text); END IF;

  -- T7: la ficha muestra el saldo de la bolsa
  IF EXISTS (SELECT 1 FROM public.hhee_people p WHERE p.id = v_p1 AND (public.hhee_flow_person_json(p, true)->>'comp_balance')::int = v_base + 165)
  THEN pass := pass + 1; ELSE fails := fails || 'T7 saldo en la ficha'::text; END IF;

  -- T8: permisos: cierre interno y geocerca no expuestos; app y web para usuarios autenticados, no anónimos
  IF NOT has_function_privilege('authenticated', 'public.hhee_close_request_lines(uuid, timestamptz, text, text)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.hhee_geo_point(uuid, numeric, numeric, timestamptz)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.hhee_driver_close(uuid)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.hhee_driver_close(uuid)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.hhee_comp_rest_save(jsonb)', 'EXECUTE')
     AND has_function_privilege('anon', 'public.native_tracking_sync(text, jsonb, jsonb)', 'EXECUTE')
  THEN pass := pass + 1; ELSE fails := fails || 'T8 permisos'::text; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C129 FAIL (%/8): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C129 PASS (8/8) cierre de HHEE de ruta (app y geocerca, cierra al auxiliar), ejecutado y compensación%', v_note;
END $test$;
ROLLBACK;
