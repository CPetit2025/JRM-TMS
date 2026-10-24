-- CAJA C128 — Rutas: auxiliar (puede ser un conductor disponible) y solicitud automática de horas extras de la ruta
-- en curso fuera del horario (lun–vie 17:30, sáb 13:30, dom/feriado desde la salida): una por ruta, conductor y
-- auxiliar, placa de la ruta, textos «PENDIENTE» que el supervisor completa antes de presentar, aviso al supervisor.
-- Usa un despacho existente con conductor; se revierte.
BEGIN;
SET LOCAL statement_timeout = '60s';
DO $test$
DECLARE v_req uuid; v_app uuid; v_aux uuid; v_rreq uuid := gen_random_uuid(); v_rapp uuid := gen_random_uuid(); v_site uuid := gen_random_uuid();
  v_area uuid := gen_random_uuid(); d record; r jsonb; v_id uuid; v_ver int; v_l jsonb; pass int := 0; fails text[] := '{}'; v_busy record; v_note text := '';
BEGIN
  SELECT p.id INTO v_req FROM public.profiles p JOIN auth.users u ON u.id = p.id ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_app FROM public.profiles p JOIN auth.users u ON u.id = p.id WHERE p.id <> v_req ORDER BY p.id LIMIT 1;
  SELECT x.id, x.driver_id, x.vehicle_plate, dr.profile_id AS driver_profile INTO d
  FROM public.dispatches x JOIN public.drivers dr ON dr.id = x.driver_id
  WHERE x.vehicle_plate IS NOT NULL AND x.vehicle_plate <> 'EXTERNO' AND length((public.hhee_driver_master(dr.id))->>'name') >= 3
    AND NOT EXISTS (SELECT 1 FROM public.hhee_requests h WHERE h.auto_dispatch_id = x.id)
    -- sin horas extras vigentes el 20/10/2026 (un trabajador no se repite en la misma fecha)
    AND NOT EXISTS (SELECT 1 FROM public.hhee_lines l JOIN public.hhee_people hp ON hp.id = l.person_id JOIN public.hhee_requests h ON h.id = l.request_id
                    WHERE hp.driver_id = x.driver_id AND h.work_date = '2026-10-20' AND h.state <> 'CANCELADA' AND h.approval <> 'RECHAZADA')
  ORDER BY x.id LIMIT 1;
  SELECT p.id INTO v_aux FROM public.profiles p WHERE COALESCE(p.is_active, true) AND p.id IS DISTINCT FROM d.driver_profile
    AND length(trim(concat_ws(' ', to_jsonb(p)->>'first_name', to_jsonb(p)->>'last_name'))) >= 3
    AND NOT EXISTS (SELECT 1 FROM public.hhee_lines l JOIN public.hhee_people hp ON hp.id = l.person_id JOIN public.hhee_requests h ON h.id = l.request_id
                    WHERE (hp.profile_id = p.id OR hp.driver_id IN (SELECT dr.id FROM public.drivers dr WHERE dr.profile_id = p.id))
                      AND h.work_date = '2026-10-20' AND h.state <> 'CANCELADA' AND h.approval <> 'RECHAZADA')
    ORDER BY p.id LIMIT 1;
  IF v_req IS NULL OR v_app IS NULL OR d.id IS NULL OR v_aux IS NULL THEN RAISE EXCEPTION 'CAJA C128 FAIL: faltan perfiles o un despacho con conductor'; END IF;
  INSERT INTO public.roles (id, name, permissions) VALUES
    (v_rreq, 'C128-sup-' || left(v_rreq::text, 8), '["hhee-solicitar:write","hhee:read","despacho:write"]');
  INSERT INTO public.roles(id,name,permissions) VALUES(v_rapp,'Jefe de Distribución','["hhee-aprobar:write","hhee-costos:read","hhee-gerencia:read","hhee-config:write","hhee:read"]') ON CONFLICT(name) DO UPDATE SET permissions=excluded.permissions RETURNING id INTO v_rapp;
  INSERT INTO public.sites (id, code, name) VALUES (v_site, 'C128-' || v_site, 'C128 sede');
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_req, v_site), (v_app, v_site) ON CONFLICT DO NOTHING;
  INSERT INTO public.hhee_areas (id, site_id, name, module_enabled) VALUES (v_area, v_site, 'C128 Distribución', true);
  INSERT INTO public.hhee_memberships VALUES (v_req, v_area), (v_app, v_area);
  UPDATE public.profiles SET role_id = v_rreq, is_active = true WHERE id = v_req;
  UPDATE public.profiles SET role_id = v_rapp, is_active = true WHERE id = v_app;
  -- La ficha del conductor queda en el área de prueba (así la solicitud cae en ella); el auxiliar viaja en la ruta
  UPDATE public.hhee_people SET area_id = v_area, active = true WHERE driver_id = d.driver_id;
  IF NOT FOUND THEN
    INSERT INTO public.hhee_people (code, name, area_id, active, daily_hours, monthly_hours, divisor_confirmed, remuneration_concepts, driver_id)
    VALUES ('C128-COND', 'Conductor C128', v_area, true, 8, 240, false, '[]'::jsonb, d.driver_id);
  END IF;
  DELETE FROM public.dispatch_crew WHERE dispatch_id = d.id;
  INSERT INTO public.dispatch_crew (dispatch_id, profile_id, crew_role) VALUES (d.id, v_aux, 'AUXILIAR');

  -- T1: candidatos a auxiliar incluyen conductores (con la ruta que ya tienen) para quien programa
  PERFORM set_config('request.jwt.claim.sub', v_req::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_req, 'role', 'authenticated')::text, true);
  r := public.list_route_assistants(NULL);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(r) x WHERE x->>'kind' = 'CONDUCTOR' AND x->>'profile_id' = d.driver_profile::text)
  THEN pass := pass + 1; ELSE fails := fails || ('T1 candidatos ' || left(r::text, 200)); END IF;

  -- T2: un conductor que conduce otra ruta activa no puede ir de auxiliar (si hay una ruta programada para probarlo)
  SELECT p.id AS disp, b.profile_id INTO v_busy FROM public.dispatches p,
    LATERAL (SELECT dr.profile_id FROM public.dispatches x JOIN public.drivers dr ON dr.id = x.driver_id
             WHERE x.id <> p.id AND x.status IN ('PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO') AND dr.profile_id IS NOT NULL
               AND dr.id IS DISTINCT FROM p.driver_id LIMIT 1) b
  WHERE p.status = 'PROGRAMADO' LIMIT 1;
  IF v_busy.disp IS NULL THEN v_note := ' (T2 sin ruta programada para probar)'; pass := pass + 1;
  ELSIF COALESCE(public.set_dispatch_crew(v_busy.disp, jsonb_build_array(jsonb_build_object('profile_id', v_busy.profile_id, 'crew_role', 'AUXILIAR')))->>'error', '') ~ 'conduce la ruta'
  THEN pass := pass + 1; ELSE fails := fails || 'T2 conductor ocupado aceptado como auxiliar'::text; END IF;

  -- Programación explícita de la prueba; no se usa un horario global implícito.
  PERFORM public.hhee_person_for(d.driver_id,NULL,v_area);
  PERFORM public.hhee_person_for(NULL,v_aux,v_area);
  UPDATE public.dispatches SET departure_time='2026-10-20 08:00:00-05' WHERE id=d.id;
  INSERT INTO public.gp_shift_days(person_id,work_date,shift,reason,updated_by)
  SELECT h.id,day::date,public.gp_checked_shift(CASE WHEN day::date='2026-10-25' THEN '{"kind":"DESCANSO"}'::jsonb
   ELSE jsonb_build_object('kind','TRABAJO','start','08:00','end',CASE WHEN day::date='2026-10-24' THEN '13:30' ELSE '17:30' END,'break_minutes',60) END),'Turno sintético C128',v_req
  FROM public.hhee_people h CROSS JOIN unnest(ARRAY['2026-10-20','2026-10-24','2026-10-25']) day
  WHERE h.area_id=v_area OR h.driver_id=d.driver_id OR h.profile_id=v_aux
  ON CONFLICT(person_id,work_date) DO UPDATE SET shift=excluded.shift;

  -- T3: inicio de las horas extras: lunes a viernes 17:30, sábado 13:30, domingo desde el inicio del día o la salida
  IF public.hhee_route_overtime_start(d.id, '2026-10-20') = '2026-10-20 17:30:00-05'::timestamptz
     AND public.hhee_route_overtime_start(d.id, '2026-10-24') = '2026-10-24 13:30:00-05'::timestamptz
     AND public.hhee_route_overtime_start(d.id, '2026-10-25') >= '2026-10-25 00:00:00-05'::timestamptz
  THEN pass := pass + 1; ELSE fails := fails || 'T3 horario'::text; END IF;

  -- T4: dentro del horario no se genera; a las 19:10 se genera una sola, con conductor (placa de la ruta) y auxiliar
  r := public.hhee_route_request_for(d.id, '2026-10-20 17:00:00-05');
  IF (r->>'created')::boolean THEN fails := fails || 'T4 generada dentro del horario'::text; END IF;
  r := public.hhee_route_request_for(d.id, '2026-10-20 19:10:00-05');
  v_id := (r->>'id')::uuid;
  IF (r->>'created')::boolean AND (r->>'workers')::int = 2
     AND (SELECT count(*) FROM public.hhee_lines WHERE request_id = v_id AND planned_start = '2026-10-20 17:30:00-05' AND planned_end = '2026-10-20 20:00:00-05') = 2
     AND (SELECT (vehicle_plate, plate_source) = (d.vehicle_plate, 'RUTA') FROM public.hhee_lines l JOIN public.hhee_people p ON p.id = l.person_id
          WHERE l.request_id = v_id AND p.driver_id = d.driver_id)
     AND (SELECT (state, area_id, activity LIKE 'PENDIENTE%') = ('BORRADOR', v_area, true) FROM public.hhee_requests WHERE id = v_id)
     AND NOT (public.hhee_route_request_for(d.id, '2026-10-20 19:40:00-05')->>'created')::boolean
     AND EXISTS (SELECT 1 FROM public.hhee_people WHERE profile_id = v_aux OR driver_id = (SELECT id FROM public.drivers WHERE profile_id = v_aux LIMIT 1))
  THEN pass := pass + 1; ELSE fails := fails || ('T4 solicitud de ruta ' || r::text); END IF;

  -- T5: 150 minutos comparten las dos primeras horas al 25 % con las otras solicitudes
  -- anteriores del trabajador ese día. Producción puede tener HHEE previas válidas: no asumir cero.
  IF (WITH expected AS (
    SELECT l.*, LEAST(150, GREATEST(0, 120 - COALESCE((
      SELECT sum(GREATEST(COALESCE(prior.planned_minutes, 0) - COALESCE(prior.plan_minutes_100, 0), 0))
      FROM public.hhee_lines prior JOIN public.hhee_requests h ON h.id = prior.request_id
      WHERE prior.person_id = l.person_id AND h.work_date = current_request.work_date
        AND h.sequence < current_request.sequence AND h.id <> v_id
        AND h.state <> 'CANCELADA' AND h.approval <> 'RECHAZADA' AND NOT prior.rest_day
    ), 0)::int)) AS expected_25
    FROM public.hhee_lines l JOIN public.hhee_requests current_request ON current_request.id = l.request_id
    WHERE l.request_id = v_id
  ) SELECT count(*) = 2 AND bool_and((planned_minutes, plan_minutes_25, plan_minutes_35, plan_minutes_100) = (150, expected_25, 150 - expected_25, 0)) FROM expected)
  THEN pass := pass + 1; ELSE fails := fails || ('T5 reparto ' || COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'person', person_id, 'minutes', planned_minutes, 'm25', plan_minutes_25, 'm35', plan_minutes_35, 'm100', plan_minutes_100))::text FROM public.hhee_lines WHERE request_id = v_id), 'sin líneas')); END IF;

  -- T6: no se presenta con textos «PENDIENTE»; completados, sí; el supervisor tiene el aviso
  IF NOT EXISTS (SELECT 1 FROM public.notifications n JOIN public.hhee_requests h ON h.id = v_id
                 WHERE n.dedupe_key = 'hhee-ruta-' || v_id AND n.target_user = h.created_by AND n.link LIKE '%' || v_id || '%') THEN
    fails := fails || 'T6 sin aviso al supervisor'::text; END IF;
  -- (el supervisor de prueba toma la solicitud para presentarla)
  UPDATE public.hhee_requests SET created_by = v_req WHERE id = v_id;
  v_ver := (SELECT version FROM public.hhee_requests WHERE id = v_id);
  UPDATE public.hhee_lines SET gp_plan=gp_plan||jsonb_build_object('meal_pending',false,'no_meal_reason','Tramo extra corto, refrigerio fuera del tramo') WHERE request_id=v_id AND gp_plan IS NOT NULL;
  r := public.hhee_flow_submit(v_id, v_ver);
  IF NOT (r->>'success')::boolean AND r->>'error' ~ 'Complete la actividad' THEN
    UPDATE public.hhee_requests SET activity = 'Reparto tardío ruta norte', justification = 'Cliente recibió fuera de horario',
      alternatives = 'Reprogramar al día siguiente', expected_result = 'Entregas completas' WHERE id = v_id;
    UPDATE public.hhee_lines SET gp_plan=gp_plan||jsonb_build_object('meal_pending',false,'no_meal_reason','Tramo extra corto, refrigerio fuera del tramo') WHERE request_id=v_id AND gp_plan IS NOT NULL;
  r := public.hhee_flow_submit(v_id, v_ver);
    IF (r->>'success')::boolean THEN pass := pass + 1; ELSE fails := fails || ('T6 presentar ' || r::text); END IF;
  ELSE fails := fails || ('T6 presentada con textos pendientes ' || r::text); END IF;

  -- T7: el proceso cada 10 minutos corre sin errores y no duplica
  r := public.hhee_auto_route_requests('2026-10-20 19:50:00-05');
  IF r ? 'created' AND (SELECT count(*) FROM public.hhee_requests WHERE auto_dispatch_id = d.id AND state <> 'CANCELADA') = 1
  THEN pass := pass + 1; ELSE fails := fails || ('T7 proceso ' || r::text); END IF;

  -- T8: permisos: la generación es interna; los candidatos, para usuarios autenticados
  IF NOT has_function_privilege('authenticated', 'public.hhee_route_request_for(uuid, timestamptz)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.hhee_auto_route_requests(timestamptz)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.hhee_person_for(uuid, uuid, uuid)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.list_route_assistants(uuid)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.list_route_assistants(uuid)', 'EXECUTE')
  THEN pass := pass + 1; ELSE fails := fails || 'T8 permisos'::text; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C128 FAIL (%/8): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C128 PASS (8/8) auxiliar de ruta (conductores incluidos) y solicitud automática de HHEE fuera del horario%', v_note;
END $test$;
ROLLBACK;
