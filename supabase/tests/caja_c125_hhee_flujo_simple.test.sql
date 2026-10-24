-- CAJA C125 — HHEE simple: ficha de personal con tarifa e historial (alta, duplicados, Excel), solicitud del
-- supervisor con horas al 25/35/100 % y costo aproximado, aprobación independiente con informe versionado,
-- estimación actualizada si cambia la remuneración, observación y nueva aprobación al modificar, panel
-- gerencial y privacidad de la remuneración. Se revierte.
BEGIN;
SET LOCAL statement_timeout = '60s';
DO $test$
DECLARE v_req uuid; v_app uuid; v_rreq uuid := gen_random_uuid(); v_rapp uuid := gen_random_uuid(); v_site uuid := gen_random_uuid();
  v_area uuid := gen_random_uuid(); v_cause uuid; v_p1 uuid; v_p2 uuid; v_id uuid; v_ver int; r jsonb; d jsonb; pass int := 0; fails text[] := '{}';
  -- Día laborable sin feriado (el reparto legal pondría todo al 100 % en feriado)
  v_day text := (SELECT gs::date::text FROM generate_series((now() AT TIME ZONE 'America/Lima')::date, (now() AT TIME ZONE 'America/Lima')::date + 10, interval '1 day') gs
                 WHERE public.hhee_pe_holiday(gs::date) IS NULL ORDER BY gs LIMIT 1);
  v_c1 jsonb := '[{"name":"Básico","amount":2400,"computable":true},{"name":"Movilidad","amount":300,"computable":false}]';
BEGIN
  SELECT p.id INTO v_req FROM public.profiles p JOIN auth.users u ON u.id = p.id ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_app FROM public.profiles p JOIN auth.users u ON u.id = p.id WHERE p.id <> v_req ORDER BY p.id LIMIT 1;
  SELECT id INTO v_cause FROM public.hhee_causes WHERE active ORDER BY name LIMIT 1;
  IF v_req IS NULL OR v_app IS NULL OR v_cause IS NULL THEN RAISE EXCEPTION 'CAJA C125 FAIL: faltan perfiles o causas'; END IF;
  INSERT INTO public.roles (id, name, permissions) VALUES
    (v_rreq, 'C125-sup-' || left(v_rreq::text, 8), '["hhee-solicitar:write","hhee:read"]');
  INSERT INTO public.roles(id,name,permissions) VALUES(v_rapp,'Jefe de Distribución','["hhee-aprobar:write","hhee-costos:read","hhee-gerencia:read","hhee-config:write","hhee:read"]') ON CONFLICT(name) DO UPDATE SET permissions=excluded.permissions RETURNING id INTO v_rapp;
  INSERT INTO public.sites (id, code, name) VALUES (v_site, 'C125-' || v_site, 'C125 sede');
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_req, v_site), (v_app, v_site) ON CONFLICT DO NOTHING;
  INSERT INTO public.hhee_areas (id, site_id, name, module_enabled) VALUES (v_area, v_site, 'C125 Distribución', true);
  INSERT INTO public.hhee_memberships VALUES (v_req, v_area), (v_app, v_area);
  UPDATE public.profiles SET role_id = v_rreq, is_active = true WHERE id = v_req;
  UPDATE public.profiles SET role_id = v_rapp, is_active = true WHERE id = v_app;

  -- T1: alta de personal con tarifa (2.400 computable ÷ 240 h = S/ 10) e historial; duplicados y divisor sin confirmar
  PERFORM set_config('request.jwt.claim.sub', v_app::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_app, 'role', 'authenticated')::text, true);
  r := public.hhee_flow_person_save(jsonb_build_object('code', 'c125-01', 'name', 'C125 Trabajador Uno', 'document_number', '70000125',
    'position', 'Operario', 'area_id', v_area, 'daily_hours', 8, 'monthly_hours', 240, 'divisor_confirmed', true,
    'effective_from', v_day, 'remuneration_concepts', v_c1));
  v_p1 := (r->'person'->>'id')::uuid;
  IF (r->>'success')::boolean AND (r->'person'->>'base_hour_cost')::numeric = 10 AND r->'person'->>'code' = 'C125-01'
     AND (SELECT count(*) FROM public.hhee_people_history WHERE person_id = v_p1) = 1
     AND NOT (public.hhee_flow_person_save(jsonb_build_object('code', 'C125-01', 'name', 'Otro', 'area_id', v_area, 'remuneration_concepts', '[]'::jsonb))->>'success')::boolean
     AND NOT (public.hhee_flow_person_save(jsonb_build_object('code', 'C125-09', 'name', 'Otro nombre', 'document_number', '70000125', 'area_id', v_area, 'remuneration_concepts', '[]'::jsonb))->>'success')::boolean
  THEN pass := pass + 1; ELSE fails := fails || ('T1 alta ' || left(r::text, 300)); END IF;

  -- T2: importación Excel: actualiza por código (2.640 → S/ 11, nuevo historial), crea otro y reporta la fila inválida
  r := public.hhee_flow_people_import(jsonb_build_array(
    jsonb_build_object('code', 'C125-01', 'name', 'C125 Trabajador Uno', 'area_id', v_area, 'monthly_hours', 240, 'divisor_confirmed', true,
      'remuneration_concepts', '[{"name":"Básico","amount":2640,"computable":true}]'::jsonb),
    jsonb_build_object('code', 'C125-02', 'name', 'C125 Trabajador Dos', 'area_id', v_area, 'monthly_hours', 240, 'divisor_confirmed', false,
      'remuneration_concepts', '[{"name":"Básico","amount":3000,"computable":true}]'::jsonb),
    jsonb_build_object('code', '', 'name', 'Sin código', 'area_id', v_area)));
  SELECT id INTO v_p2 FROM public.hhee_people WHERE code = 'C125-02';
  IF (r->>'saved')::int = 2 AND (r->'rows'->2->>'ok')::boolean = false AND (r->'rows'->0->>'updated')::boolean
     AND (SELECT base_hour_cost FROM public.hhee_people WHERE id = v_p1) = 11 AND public.hhee_flow_rate(v_p2) IS NULL
     AND (SELECT count(*) FROM public.hhee_people_history WHERE person_id = v_p1) = 2
  THEN pass := pass + 1; ELSE fails := fails || ('T2 Excel ' || left(r::text, 300)); END IF;

  -- T3: el supervisor solicita (sin ver remuneración); costo 11 × (120×1,25 + 60×1,35) / 60 = 42,35; sin tarifa queda pendiente
  PERFORM set_config('request.jwt.claim.sub', v_req::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_req, 'role', 'authenticated')::text, true);
  d := public.hhee_flow_context();
  r := public.hhee_flow_request_save(jsonb_build_object('area_id', v_area, 'cause_id', v_cause, 'work_date', v_day,
    'activity', 'Despacho urgente C125', 'justification', 'Pedido adicional del cliente para hoy', 'alternatives', 'Reasignar turno',
    'expected_result', 'Despacho completo', 'lines', jsonb_build_array(
      jsonb_build_object('person_id', v_p1, 'start', v_day || 'T18:00', 'end', v_day || 'T21:00', 'break_minutes', 0, 'break_minutes', 0),
      jsonb_build_object('person_id', v_p2, 'start', v_day || 'T18:00', 'end', v_day || 'T19:00', 'break_minutes', 0, 'rest_day', true))));
  v_id := (r->>'id')::uuid; v_ver := (r->>'version')::int;
  IF (d->'caps'->>'request')::boolean AND NOT (d->'caps'->>'remuneration')::boolean
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d->'people') x WHERE x ? 'base_hour_cost' OR x ? 'remuneration_concepts')
     AND (r->>'success')::boolean AND (r->'totals'->>'cost')::numeric = 42.35 AND (r->'totals'->>'pending_cost')::int = 1
     AND (r->'totals'->>'minutes')::int = 240
  THEN pass := pass + 1; ELSE fails := fails || ('T3 solicitud ' || left(r::text, 300)); END IF;

  -- T4: validaciones: descanso mayor al horario, trabajador repetido; el supervisor no decide
  BEGIN
    r := public.hhee_flow_request_save(jsonb_build_object('area_id', v_area, 'cause_id', v_cause, 'work_date', v_day, 'activity', 'Prueba C125',
      'justification', 'Justificación suficiente', 'alternatives', 'Ninguna', 'expected_result', 'Resultado', 'lines', jsonb_build_array(
        jsonb_build_object('person_id', v_p1, 'start', v_day || 'T18:00', 'end', v_day || 'T19:00', 'break_minutes', 90))));
    fails := fails || 'T4 descanso mayor al horario aceptado'::text;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ~ 'supera su horario' THEN pass := pass + 1; ELSE fails := fails || ('T4 ' || SQLERRM); END IF;
  END;
  r := public.hhee_flow_submit(v_id, v_ver); v_ver := (r->>'version')::int;
  IF NOT (r->>'success')::boolean OR (public.hhee_flow_decide(jsonb_build_object('id', v_id, 'decision', 'APROBADA', 'reason', 'Auto aprobación', 'expected_version', v_ver))->>'success')::boolean THEN
    fails := fails || ('T4 presentar / decidir sin permiso ' || r::text); END IF;

  -- T5: cambia la remuneración durante la revisión → se pide confirmar el nuevo costo (12 × 231 / 60 = 46,20); luego se aprueba
  PERFORM set_config('request.jwt.claim.sub', v_app::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_app, 'role', 'authenticated')::text, true);
  PERFORM public.hhee_flow_person_save(jsonb_build_object('id', v_p1, 'code', 'C125-01', 'name', 'C125 Trabajador Uno', 'area_id', v_area,
    'monthly_hours', 240, 'divisor_confirmed', true, 'remuneration_concepts', '[{"name":"Básico","amount":2880,"computable":true}]'::jsonb));
  r := public.hhee_flow_decide(jsonb_build_object('id', v_id, 'decision', 'APROBADA', 'reason', 'Necesidad operativa verificada', 'expected_version', v_ver, 'expected_cost', 42.35));
  d := public.hhee_flow_decide(jsonb_build_object('id', v_id, 'decision', 'APROBADA', 'reason', 'Necesidad operativa verificada', 'expected_version', v_ver, 'expected_cost', 46.20));
  IF (r->>'stale_cost')::boolean AND (r->>'cost')::numeric = 46.20 AND (d->>'success')::boolean AND (d->>'revision')::int = 1
     AND (SELECT snapshot->'totals'->>'cost' FROM public.hhee_authorizations WHERE request_id = v_id AND revision = 1)::numeric = 46.20
     AND (SELECT snapshot::text FROM public.hhee_authorizations WHERE request_id = v_id) !~ 'remuneration_concepts|Básico|base_hour_cost'
     AND (SELECT snapshot->>'requester' FROM public.hhee_authorizations WHERE request_id = v_id) IS NOT NULL
  THEN pass := pass + 1; ELSE fails := fails || ('T5 aprobación ' || left(r::text || d::text, 400)); END IF;

  -- T6: modificar personas u horas tras aprobar exige nueva aprobación; observar y aprobar crea la versión 2
  PERFORM set_config('request.jwt.claim.sub', v_req::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_req, 'role', 'authenticated')::text, true);
  v_ver := (d->>'version')::int;
  r := public.hhee_flow_request_save(jsonb_build_object('id', v_id, 'expected_version', v_ver, 'area_id', v_area, 'cause_id', v_cause, 'work_date', v_day,
    'activity', 'Despacho urgente C125', 'justification', 'Pedido adicional del cliente para hoy', 'alternatives', 'Reasignar turno',
    'expected_result', 'Despacho completo', 'lines', jsonb_build_array(
      jsonb_build_object('person_id', v_p1, 'start', v_day || 'T18:00', 'end', v_day || 'T21:00'))));
  v_ver := (r->>'version')::int;
  v_ver := (public.hhee_flow_submit(v_id, v_ver)->>'version')::int;
  PERFORM set_config('request.jwt.claim.sub', v_app::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_app, 'role', 'authenticated')::text, true);
  d := public.hhee_flow_decide(jsonb_build_object('id', v_id, 'decision', 'OBSERVADA', 'reason', 'Reducir a dos horas', 'expected_version', v_ver));
  IF (r->>'reapproval')::boolean AND (d->>'success')::boolean
     AND (SELECT state || '/' || approval FROM public.hhee_requests WHERE id = v_id) = 'BORRADOR/OBSERVADA' THEN
    PERFORM set_config('request.jwt.claim.sub', v_req::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_req, 'role', 'authenticated')::text, true);
    r := public.hhee_flow_request_save(jsonb_build_object('id', v_id, 'expected_version', (d->>'version')::int, 'area_id', v_area, 'cause_id', v_cause, 'work_date', v_day,
      'activity', 'Despacho urgente C125', 'justification', 'Pedido adicional del cliente para hoy', 'alternatives', 'Reasignar turno',
      'expected_result', 'Despacho completo', 'lines', jsonb_build_array(
        jsonb_build_object('person_id', v_p1, 'start', v_day || 'T18:00', 'end', v_day || 'T20:00'))));
    v_ver := (public.hhee_flow_submit(v_id, (r->>'version')::int)->>'version')::int;
    PERFORM set_config('request.jwt.claim.sub', v_app::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_app, 'role', 'authenticated')::text, true);
    d := public.hhee_flow_decide(jsonb_build_object('id', v_id, 'decision', 'APROBADA', 'reason', 'Corregida según lo observado', 'expected_version', v_ver, 'expected_cost', 30));
    IF (d->>'revision')::int = 2 AND (SELECT count(*) FROM public.hhee_authorizations WHERE request_id = v_id) = 2
    THEN pass := pass + 1; ELSE fails := fails || ('T6 versión 2 ' || d::text); END IF;
  ELSE fails := fails || ('T6 reaprobación ' || left(r::text || d::text, 300)); END IF;

  -- T7: panel gerencial (horas y costo autorizados) y detalle para el supervisor sin montos
  r := public.hhee_flow_dashboard(jsonb_build_object('from', v_day, 'to', v_day, 'area_id', v_area));
  PERFORM set_config('request.jwt.claim.sub', v_req::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_req, 'role', 'authenticated')::text, true);
  d := public.hhee_flow_detail(v_id);
  IF (r->'metrics'->>'hours')::numeric = 2 AND (r->'metrics'->>'hours_25')::numeric = 2 AND (r->'metrics'->>'cost')::numeric = 30
     AND (r->'metrics'->>'approved')::int = 1 AND jsonb_array_length(r->'causes') = 1 AND (r->'people'->0->>'code') = 'C125-01'
     AND (d->>'cost_visible')::boolean = false AND jsonb_array_length(d->'authorizations') = 2
     AND d::text !~ '"cost"' AND jsonb_array_length(d->'events') >= 6
  THEN pass := pass + 1; ELSE fails := fails || ('T7 panel / detalle ' || left(r::text, 300) || ' | ' || left(d::text, 200)); END IF;

  -- T8: permisos: tablas privadas y funciones internas fuera de la web
  IF NOT has_table_privilege('authenticated', 'public.hhee_authorizations', 'SELECT')
     AND NOT has_table_privilege('authenticated', 'public.hhee_people_history', 'SELECT')
     AND NOT has_function_privilege('authenticated', 'public.hhee_flow_snapshot(uuid)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.hhee_flow_decide(jsonb)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.hhee_flow_decide(jsonb)', 'EXECUTE')
     AND NOT (public.hhee_flow_person_history(v_p1)->>'success')::boolean
  THEN pass := pass + 1; ELSE fails := fails || 'T8 permisos'::text; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C125 FAIL (%/8): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C125 PASS (8/8) HHEE simple: personal con tarifa e historial, solicitud por recargos, aprobación versionada, reaprobación, panel y privacidad';
END $test$;
ROLLBACK;
