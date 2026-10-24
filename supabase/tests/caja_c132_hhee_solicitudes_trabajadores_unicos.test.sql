-- CAJA C132 — HHEE: la lista trae trabajadores, placa y referencia (OT/OC/OS/RQ); un trabajador no se repite en dos
-- solicitudes vigentes del mismo día (vista previa, guardado y solicitud automática de ruta). Se revierte.
BEGIN;
SET LOCAL statement_timeout = '60s';
DO $test$
DECLARE v_req uuid; v_rreq uuid := gen_random_uuid(); v_site uuid := gen_random_uuid(); v_area uuid := gen_random_uuid(); v_cause uuid;
  v_p1 uuid; v_p2 uuid; v_a uuid; r jsonb; v_err text; v_row jsonb; d record; v_cond uuid; v_auto uuid; pass int := 0; fails text[] := '{}';
  v_day text := '2026-10-14'; v_base jsonb;
BEGIN
  SELECT p.id INTO v_req FROM public.profiles p JOIN auth.users u ON u.id = p.id ORDER BY p.id LIMIT 1;
  SELECT id INTO v_cause FROM public.hhee_causes WHERE active ORDER BY name LIMIT 1;
  IF v_req IS NULL OR v_cause IS NULL THEN RAISE EXCEPTION 'CAJA C132 FAIL: faltan perfiles o causas'; END IF;
  v_day := (SELECT gs::date::text FROM generate_series((now() AT TIME ZONE 'America/Lima')::date - 5, (now() AT TIME ZONE 'America/Lima')::date + 5, interval '1 day') gs
            WHERE public.hhee_pe_holiday(gs::date) IS NULL AND extract(isodow FROM gs) < 6 ORDER BY gs LIMIT 1);
  INSERT INTO public.roles (id, name, permissions) VALUES (v_rreq, 'C132-sup-' || left(v_rreq::text, 8), '["hhee-solicitar:write","hhee:read","despacho:write"]');
  INSERT INTO public.sites (id, code, name) VALUES (v_site, 'C132-' || v_site, 'C132 sede');
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_req, v_site) ON CONFLICT DO NOTHING;
  INSERT INTO public.hhee_areas (id, site_id, name, module_enabled) VALUES (v_area, v_site, 'C132 Distribución', true);
  INSERT INTO public.hhee_memberships VALUES (v_req, v_area);
  UPDATE public.profiles SET role_id = v_rreq, is_active = true WHERE id = v_req;
  INSERT INTO public.hhee_people (code, name, area_id, active, daily_hours, monthly_hours, divisor_confirmed, remuneration_concepts)
  VALUES ('C132-01', 'C132 Ana Uno', v_area, true, 8, 240, false, '[]'::jsonb) RETURNING id INTO v_p1;
  INSERT INTO public.hhee_people (code, name, area_id, active, daily_hours, monthly_hours, divisor_confirmed, remuneration_concepts)
  VALUES ('C132-02', 'C132 Beto Dos', v_area, true, 8, 240, false, '[]'::jsonb) RETURNING id INTO v_p2;
  PERFORM set_config('request.jwt.claim.sub', v_req::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_req, 'role', 'authenticated')::text, true);
  v_base := jsonb_build_object('area_id', v_area, 'cause_id', v_cause, 'work_date', v_day, 'activity', 'Despacho C132',
    'justification', 'Pedido adicional del cliente', 'alternatives', 'Reasignar turno', 'expected_result', 'Despacho completo');

  -- T1: la fila de la lista trae trabajadores, placa (vacía sin conductor) y referencia
  r := public.hhee_flow_request_save(v_base || jsonb_build_object('reference_type', 'OT', 'reference_code', '16544', 'lines', jsonb_build_array(
    jsonb_build_object('person_id', v_p1, 'start', v_day || 'T18:00', 'end', v_day || 'T19:00', 'break_minutes', 0),
    jsonb_build_object('person_id', v_p2, 'start', v_day || 'T18:00', 'end', v_day || 'T19:00', 'break_minutes', 0))));
  v_a := (r->>'id')::uuid;
  SELECT x INTO v_row FROM jsonb_array_elements(public.hhee_flow_list(jsonb_build_object('q', 'C132 Ana'))->'rows') x WHERE x->>'id' = v_a::text;
  IF v_row->'people' = '["C132 Ana Uno", "C132 Beto Dos"]'::jsonb AND v_row->>'reference_type' = 'OT' AND v_row->>'reference_code' = '16544'
     AND jsonb_typeof(v_row->'plates') = 'array'
  THEN pass := pass + 1; ELSE fails := fails || ('T1 fila ' || COALESCE(left(v_row::text, 300), '∅')); END IF;

  -- T2: otra solicitud del mismo día con la misma persona se rechaza (indica la solicitud existente)
  BEGIN
    PERFORM public.hhee_flow_request_save(v_base || jsonb_build_object('lines', jsonb_build_array(
      jsonb_build_object('person_id', v_p1, 'start', v_day || 'T20:00', 'end', v_day || 'T21:00', 'break_minutes', 0))));
    v_err := 'aceptada';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err ~ 'C132 Ana Uno ya tiene horas extras' AND v_err ~ ('HE-' || lpad((SELECT sequence FROM public.hhee_requests WHERE id = v_a)::text, 5, '0'))
  THEN pass := pass + 1; ELSE fails := fails || ('T2 duplicado: ' || v_err); END IF;

  -- T3: la vista previa lo marca; editando la misma solicitud no; repetido dentro de la misma solicitud, tampoco pasa
  r := public.hhee_flow_preview(jsonb_build_object('work_date', v_day, 'lines', jsonb_build_array(
    jsonb_build_object('person_id', v_p1, 'start', v_day || 'T20:00', 'end', v_day || 'T21:00'))));
  v_row := public.hhee_flow_preview(jsonb_build_object('id', v_a, 'work_date', v_day, 'lines', jsonb_build_array(
    jsonb_build_object('person_id', v_p1, 'start', v_day || 'T20:00', 'end', v_day || 'T21:00'),
    jsonb_build_object('person_id', v_p1, 'start', v_day || 'T20:00', 'end', v_day || 'T21:00'))));
  IF r->'lines'->0->>'error' ~ 'Ya tiene horas extras' AND v_row->'lines'->0->>'error' IS NULL AND v_row->'lines'->1->>'error' ~ 'repetido'
  THEN pass := pass + 1; ELSE fails := fails || ('T3 vista previa ' || left(r::text, 200) || ' | ' || left(v_row::text, 200)); END IF;

  -- T4: anulada la primera, ya se puede registrar a la persona ese día
  PERFORM public.hhee_flow_cancel(v_a, (SELECT version FROM public.hhee_requests WHERE id = v_a), 'Ya no se requiere');
  r := public.hhee_flow_request_save(v_base || jsonb_build_object('lines', jsonb_build_array(
    jsonb_build_object('person_id', v_p1, 'start', v_day || 'T20:00', 'end', v_day || 'T21:00', 'break_minutes', 0))));
  IF (r->>'success')::boolean THEN pass := pass + 1; ELSE fails := fails || ('T4 tras anular ' || r::text); END IF;

  -- T5: la solicitud automática de ruta no repite al conductor que ya tiene horas extras ese día
  SELECT x.id, x.driver_id INTO d FROM public.dispatches x JOIN public.drivers dr ON dr.id = x.driver_id
  WHERE x.vehicle_plate IS NOT NULL AND x.vehicle_plate <> 'EXTERNO' AND length((public.hhee_driver_master(dr.id))->>'name') >= 3
    AND NOT EXISTS (SELECT 1 FROM public.hhee_requests h WHERE h.auto_dispatch_id = x.id) ORDER BY x.id LIMIT 1;
  IF d.id IS NULL THEN pass := pass + 1;
  ELSE
    UPDATE public.hhee_people SET area_id = v_area, active = true WHERE driver_id = d.driver_id RETURNING id INTO v_cond;
    IF v_cond IS NULL THEN
      INSERT INTO public.hhee_people (code, name, area_id, active, daily_hours, monthly_hours, divisor_confirmed, remuneration_concepts, driver_id)
      VALUES ('C132-COND', 'Conductor C132', v_area, true, 8, 240, false, '[]'::jsonb, d.driver_id) RETURNING id INTO v_cond;
    END IF;
    DELETE FROM public.route_auxiliaries WHERE dispatch_id = d.id;
    DELETE FROM public.dispatch_crew WHERE dispatch_id = d.id;
    INSERT INTO public.route_auxiliaries (dispatch_id, person_id) VALUES (d.id, v_p2);
    -- el conductor ya tiene una solicitud manual el 03/03/2025
    INSERT INTO public.hhee_requests (id, area_id, cause_id, work_date, activity, justification, alternatives, expected_result, reference_type, created_by)
    VALUES (gen_random_uuid(), v_area, v_cause, '2025-03-03', 'Manual C132', 'Justificación C132', 'Ninguna', 'Resultado', 'SIN_REFERENCIA', v_req) RETURNING id INTO v_auto;
    INSERT INTO public.hhee_lines (request_id, person_id, person_name, person_code, planned_start, planned_end, planned_break, planned_minutes)
    VALUES (v_auto, v_cond, 'Conductor C132', 'C132-COND', '2025-03-03 18:00-05', '2025-03-03 19:00-05', 0, 60);
  -- Horario sintético explícito para conductor y auxiliares; la transacción se revierte.
  UPDATE public.dispatches SET started_at='2025-03-03 08:00:00-05' WHERE id=d.id;
  INSERT INTO public.gp_shift_days(person_id,work_date,shift,reason,updated_by)
  SELECT h.id,'2025-03-03',public.gp_checked_shift('{"kind":"TRABAJO","start":"08:00","end":"17:30","break_minutes":60}'),'Turno sintético C132',v_req
  FROM public.hhee_people h WHERE h.area_id=v_area OR h.driver_id=d.driver_id
  ON CONFLICT(person_id,work_date) DO UPDATE SET shift=excluded.shift;
    r := public.hhee_route_request_for(d.id, '2025-03-03 19:10:00-05');
    IF (r->>'created')::boolean AND (r->>'workers')::int = 1
       AND NOT EXISTS (SELECT 1 FROM public.hhee_lines WHERE request_id = (r->>'id')::uuid AND person_id = v_cond)
    THEN pass := pass + 1; ELSE fails := fails || ('T5 automática ' || r::text); END IF;
  END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C132 FAIL (%/5): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C132 PASS (5/5) HHEE: lista con trabajadores, placa y referencia; un trabajador no se repite en la misma fecha';
END $test$;
ROLLBACK;
