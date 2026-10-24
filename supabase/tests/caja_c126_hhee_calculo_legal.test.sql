-- CAJA C126 — HHEE: cálculo automático según la legislación peruana (primeras 2 h del día al 25 %, resto al 35 %,
-- día de descanso o feriado al 100 %), acumulado por trabajador y día entre solicitudes, nuevo reparto al aprobar,
-- vista previa, datos del trabajador en el informe e informe consolidado. Se revierte.
BEGIN;
SET LOCAL statement_timeout = '60s';
DO $test$
DECLARE v_req uuid; v_app uuid; v_rreq uuid := gen_random_uuid(); v_rapp uuid := gen_random_uuid(); v_site uuid := gen_random_uuid();
  v_area uuid := gen_random_uuid(); v_cause uuid; v_p1 uuid; v_p2 uuid; v_a uuid; v_b uuid; v_c uuid; v_ver int; r jsonb; d jsonb; pass int := 0; fails text[] := '{}';
  v_day text := (SELECT gs::date::text FROM generate_series((now() AT TIME ZONE 'America/Lima')::date, (now() AT TIME ZONE 'America/Lima')::date + 10, interval '1 day') gs
                 WHERE public.hhee_pe_holiday(gs::date) IS NULL ORDER BY gs LIMIT 1);
  v_day2 text; v_base jsonb; v_dup text;
BEGIN
  v_day2 := (SELECT gs::date::text FROM generate_series(v_day::date + 1, v_day::date + 15, interval '1 day') gs
             WHERE public.hhee_pe_holiday(gs::date) IS NULL AND extract(isodow FROM gs) < 7 ORDER BY gs LIMIT 1);
  SELECT p.id INTO v_req FROM public.profiles p JOIN auth.users u ON u.id = p.id ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_app FROM public.profiles p JOIN auth.users u ON u.id = p.id WHERE p.id <> v_req ORDER BY p.id LIMIT 1;
  SELECT id INTO v_cause FROM public.hhee_causes WHERE active ORDER BY name LIMIT 1;
  IF v_req IS NULL OR v_app IS NULL OR v_cause IS NULL THEN RAISE EXCEPTION 'CAJA C126 FAIL: faltan perfiles o causas'; END IF;
  INSERT INTO public.roles (id, name, permissions) VALUES
    (v_rreq, 'C126-sup-' || left(v_rreq::text, 8), '["hhee-solicitar:write","hhee:read"]');
  INSERT INTO public.roles(id,name,permissions) VALUES(v_rapp,'Jefe de Distribución','["hhee-aprobar:write","hhee-costos:read","hhee-gerencia:read","hhee-config:write","hhee:read"]') ON CONFLICT(name) DO UPDATE SET permissions=excluded.permissions RETURNING id INTO v_rapp;
  INSERT INTO public.sites (id, code, name) VALUES (v_site, 'C126-' || v_site, 'C126 sede');
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_req, v_site), (v_app, v_site) ON CONFLICT DO NOTHING;
  INSERT INTO public.hhee_areas (id, site_id, name, module_enabled) VALUES (v_area, v_site, 'C126 Distribución', true);
  INSERT INTO public.hhee_memberships VALUES (v_req, v_area), (v_app, v_area);
  UPDATE public.profiles SET role_id = v_rreq, is_active = true WHERE id = v_req;
  UPDATE public.profiles SET role_id = v_rapp, is_active = true WHERE id = v_app;
  PERFORM set_config('request.jwt.claim.sub', v_app::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_app, 'role', 'authenticated')::text, true);
  v_p1 := (public.hhee_flow_person_save(jsonb_build_object('code', 'C126-01', 'name', 'C126 Trabajador Uno', 'document_number', '70000126', 'position', 'Operario',
    'area_id', v_area, 'monthly_hours', 240, 'divisor_confirmed', true, 'remuneration_concepts', '[{"name":"Básico","amount":2400,"computable":true}]'::jsonb))->'person'->>'id')::uuid;
  v_p2 := (public.hhee_flow_person_save(jsonb_build_object('code', 'C126-02', 'name', 'C126 Trabajador Dos', 'document_number', '70000226',
    'area_id', v_area, 'monthly_hours', 240, 'divisor_confirmed', true, 'remuneration_concepts', '[{"name":"Básico","amount":2400,"computable":true}]'::jsonb))->'person'->>'id')::uuid;
  v_base := jsonb_build_object('area_id', v_area, 'cause_id', v_cause, 'work_date', v_day, 'activity', 'Despacho C126',
    'justification', 'Pedido adicional del cliente', 'alternatives', 'Reasignar turno', 'expected_result', 'Despacho completo');

  -- T1: feriados nacionales (fijos y Semana Santa según la Pascua) y reparto al 100 % en feriado
  IF public.hhee_pe_holiday('2026-04-02') = 'Jueves Santo' AND public.hhee_pe_holiday('2027-03-26') = 'Viernes Santo'
     AND public.hhee_pe_holiday('2026-07-28') = 'Fiestas Patrias' AND public.hhee_pe_holiday('2026-12-09') IS NOT NULL
     AND public.hhee_pe_holiday('2026-04-05') IS NULL AND public.hhee_pe_holiday('2026-10-21') IS NULL
     AND public.hhee_flow_split(v_p1, '2026-12-25', 180, false, NULL) @> '{"m25":0,"m35":0,"m100":180}'
  THEN pass := pass + 1; ELSE fails := fails || 'T1 feriados'::text; END IF;

  -- T2: el usuario ya no reparte: 18:00–21:30 con 30 min de descanso = 3 h → 2 h al 25 % y 1 h al 35 % (se ignoran minutos enviados)
  PERFORM set_config('request.jwt.claim.sub', v_req::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_req, 'role', 'authenticated')::text, true);
  r := public.hhee_flow_request_save(v_base || jsonb_build_object('lines', jsonb_build_array(
    jsonb_build_object('person_id', v_p1, 'start', v_day || 'T18:00', 'end', v_day || 'T21:30', 'break_minutes', 30, 'minutes_100', 999))));
  v_a := (r->>'id')::uuid;
  IF (r->>'success')::boolean AND (SELECT (plan_minutes_25, plan_minutes_35, plan_minutes_100, planned_minutes) = (120, 60, 0, 180) FROM public.hhee_lines WHERE request_id = v_a)
  THEN pass := pass + 1; ELSE fails := fails || ('T2 reparto ' || left(r::text, 300)); END IF;

  -- T3: el mismo trabajador no puede estar en dos solicitudes del mismo día; el 2 en su descanso → 100 %. Para seguir
  -- verificando el acumulado legal del día (2 h al 25 % por trabajador y día), la línea del trabajador 1 en la segunda
  -- solicitud se inserta como dato anterior a esa regla: ya usó sus 2 h al 25 % → todo al 35 %
  BEGIN
    PERFORM public.hhee_flow_request_save(v_base || jsonb_build_object('lines', jsonb_build_array(
      jsonb_build_object('person_id', v_p1, 'start', v_day || 'T22:00', 'end', v_day || 'T23:59', 'break_minutes', 0))));
    v_dup := 'aceptado';
  EXCEPTION WHEN OTHERS THEN v_dup := SQLERRM;
  END;
  r := public.hhee_flow_request_save(v_base || jsonb_build_object('lines', jsonb_build_array(
    jsonb_build_object('person_id', v_p2, 'start', v_day || 'T08:00', 'end', v_day || 'T12:00', 'break_minutes', 0, 'rest_day', true))));
  v_b := (r->>'id')::uuid; v_ver := (r->>'version')::int;
  INSERT INTO public.hhee_lines (request_id, person_id, person_name, person_code, planned_start, planned_end, planned_break, planned_minutes,
    plan_minutes_25, plan_minutes_35, plan_minutes_100, plan_rate, plan_cost, estimated_cost, rest_day)
  SELECT v_b, v_p1, 'C126 Trabajador Uno', 'C126-01', (v_day || ' 22:00')::timestamp AT TIME ZONE 'America/Lima', (v_day || ' 23:59')::timestamp AT TIME ZONE 'America/Lima', 0, 119,
    (sp->>'m25')::int, (sp->>'m35')::int, (sp->>'m100')::int, public.hhee_flow_rate(v_p1),
    public.hhee_flow_cost(public.hhee_flow_rate(v_p1), (sp->>'m25')::int, (sp->>'m35')::int, (sp->>'m100')::int),
    public.hhee_flow_cost(public.hhee_flow_rate(v_p1), (sp->>'m25')::int, (sp->>'m35')::int, (sp->>'m100')::int), false
  FROM (SELECT public.hhee_flow_split(v_p1, v_day::date, 119, false, v_b) sp) x;
  IF v_dup !~ 'ya tiene horas extras' THEN fails := fails || ('T3 duplicado del día: ' || v_dup); END IF;
  IF (SELECT (plan_minutes_25, plan_minutes_35) = (0, 119) FROM public.hhee_lines WHERE request_id = v_b AND person_id = v_p1)
     AND (SELECT (plan_minutes_100, rest_day) = (240, true) FROM public.hhee_lines WHERE request_id = v_b AND person_id = v_p2)
  THEN pass := pass + 1; ELSE fails := fails || ('T3 acumulado del día ' || left(r::text, 300)); END IF;

  -- T4: vista previa (lo mismo que calculará el servidor) y errores de horario
  -- (el trabajador 1 ya está en otra solicitud de ese día: la vista previa lo marca)
  r := public.hhee_flow_preview(jsonb_build_object('id', v_b, 'work_date', v_day, 'lines', jsonb_build_array(
    jsonb_build_object('person_id', v_p1, 'start', v_day || 'T06:00', 'end', v_day || 'T07:00', 'break_minutes', 0),
    jsonb_build_object('person_id', v_p2, 'start', v_day || 'T06:00', 'end', v_day || 'T07:00', 'break_minutes', 90))));
  IF (r->>'success')::boolean AND r->'lines'->0->>'error' ~ 'Ya tiene horas extras' AND r->'lines'->1->>'error' ~ 'descanso'
  THEN pass := pass + 1; ELSE fails := fails || ('T4 vista previa ' || left(r::text, 300)); END IF;

  -- T5: se anula la primera; al aprobar la segunda se vuelve a repartir: ahora 2 h al 25 % y el costo se recalcula
  PERFORM public.hhee_flow_cancel(v_a, (SELECT version FROM public.hhee_requests WHERE id = v_a), 'Ya no se requiere');
  v_ver := (public.hhee_flow_submit(v_b, v_ver)->>'version')::int;
  PERFORM set_config('request.jwt.claim.sub', v_app::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_app, 'role', 'authenticated')::text, true);
  d := public.hhee_flow_decide(jsonb_build_object('id', v_b, 'decision', 'APROBADA', 'reason', 'Necesidad confirmada', 'expected_version', v_ver));
  IF (d->>'success')::boolean AND (SELECT (plan_minutes_25, plan_minutes_35) = (119, 0) FROM public.hhee_lines WHERE request_id = v_b AND person_id = v_p1)
     AND (SELECT plan_cost FROM public.hhee_lines WHERE request_id = v_b AND person_id = v_p1) = round(10 * 119 * 1.25 / 60, 2)
  THEN pass := pass + 1; ELSE fails := fails || ('T5 nuevo reparto al aprobar ' || left(d::text, 300)); END IF;

  -- T6: el informe guarda los datos del trabajador (documento, cargo, día de descanso) sin remuneración
  d := (SELECT snapshot FROM public.hhee_authorizations WHERE request_id = v_b ORDER BY revision DESC LIMIT 1);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(d->'lines') x WHERE x->>'document_number' = '70000126' AND x->>'position' = 'Operario' AND x->>'minutes_25' = '119')
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(d->'lines') x WHERE x->>'code' = 'C126-02' AND (x->>'rest_day')::boolean)
     AND d ? 'holiday' AND d::text !~ 'remuneration_concepts|base_hour_cost'
  THEN pass := pass + 1; ELSE fails := fails || ('T6 informe ' || left(d::text, 300)); END IF;

  -- T7: informe consolidado: solo aprobadas (la anulada se omite); el supervisor no ve montos, el jefe sí
  PERFORM set_config('request.jwt.claim.sub', v_req::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_req, 'role', 'authenticated')::text, true);
  r := public.hhee_flow_request_save(v_base || jsonb_build_object('work_date', v_day2, 'lines', jsonb_build_array(
    jsonb_build_object('person_id', v_p2, 'start', v_day2 || 'T18:00', 'end', v_day2 || 'T19:00', 'break_minutes', 0))));
  v_c := (r->>'id')::uuid; v_ver := (public.hhee_flow_submit(v_c, (r->>'version')::int)->>'version')::int;
  PERFORM set_config('request.jwt.claim.sub', v_app::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_app, 'role', 'authenticated')::text, true);
  PERFORM public.hhee_flow_decide(jsonb_build_object('id', v_c, 'decision', 'APROBADA', 'reason', 'Necesidad confirmada', 'expected_version', v_ver));
  d := public.hhee_flow_consolidated(ARRAY[v_b, v_c, v_a]);
  PERFORM set_config('request.jwt.claim.sub', v_req::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_req, 'role', 'authenticated')::text, true);
  r := public.hhee_flow_consolidated(ARRAY[v_b, v_c, v_a]);
  IF (d->>'success')::boolean AND jsonb_array_length(d->'items') = 2 AND (d->>'skipped')::int = 1 AND (d->>'cost_visible')::boolean AND d::text ~ '"cost"'
     AND (r->>'success')::boolean AND jsonb_array_length(r->'items') = 2 AND NOT (r->>'cost_visible')::boolean AND r::text !~ '"cost"'
     AND (SELECT (x->'snapshot'->'lines'->0->>'minutes_25')::int FROM jsonb_array_elements(r->'items') x WHERE (x->>'request_id')::uuid = v_c) = 60
     AND NOT (public.hhee_flow_consolidated(ARRAY[v_a])->>'success')::boolean
  THEN pass := pass + 1; ELSE fails := fails || ('T7 consolidado ' || left(d::text, 200) || ' | ' || left(r::text, 200)); END IF;

  -- T8: permisos: el reparto interno no se expone; vista previa y consolidado solo para usuarios autenticados
  IF NOT has_function_privilege('authenticated', 'public.hhee_flow_split(uuid, date, integer, boolean, uuid)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.hhee_flow_resplit(uuid)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.hhee_flow_preview(jsonb)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.hhee_flow_consolidated(uuid[])', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.hhee_flow_consolidated(uuid[])', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.hhee_flow_preview(jsonb)', 'EXECUTE')
  THEN pass := pass + 1; ELSE fails := fails || 'T8 permisos'::text; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C126 FAIL (%/8): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C126 PASS (8/8) HHEE legal: feriados, 2 h al 25 %% y resto al 35 %% por día, descanso/feriado al 100 %%, nuevo reparto al aprobar, vista previa, informe y consolidado';
END $test$;
ROLLBACK;
