-- CAJA C131 — Armar ruta con más de un auxiliar (de Personal, con o sin usuario): se asigna la lista completa,
-- reemplazarla saca a los que salen (también de la tripulación), máximo 6, y la solicitud automática de horas
-- extras incluye a todos. No modifica despachos; se revierte.
BEGIN;
SET LOCAL statement_timeout = '60s';
DO $test$
DECLARE v_req uuid; v_rreq uuid := gen_random_uuid(); v_site uuid := gen_random_uuid(); v_area uuid := gen_random_uuid();
  d record; prog record; r jsonb; v_a uuid; v_b uuid; v_c uuid; v_prof uuid; v_id uuid; v_many uuid[] := '{}'; i int;
  pass int := 0; fails text[] := '{}'; v_note text := '';
BEGIN
  SELECT p.id INTO v_req FROM public.profiles p JOIN auth.users u ON u.id = p.id ORDER BY p.id LIMIT 1;
  SELECT x.id, x.driver_id INTO d FROM public.dispatches x JOIN public.drivers dr ON dr.id = x.driver_id
  WHERE x.vehicle_plate IS NOT NULL AND x.vehicle_plate <> 'EXTERNO' AND length((public.hhee_driver_master(dr.id))->>'name') >= 3
    AND NOT EXISTS (SELECT 1 FROM public.hhee_requests h WHERE h.auto_dispatch_id = x.id)
  ORDER BY x.id LIMIT 1;
  SELECT x.id, x.driver_id INTO prog FROM public.dispatches x WHERE x.status = 'PROGRAMADO' AND x.driver_id IS NOT NULL ORDER BY x.id LIMIT 1;
  SELECT p.id INTO v_prof FROM public.profiles p WHERE COALESCE(p.is_active, true) AND p.id <> v_req
    AND NOT EXISTS (SELECT 1 FROM public.drivers x WHERE x.profile_id = p.id) ORDER BY p.id LIMIT 1;
  IF v_req IS NULL OR d.id IS NULL OR v_prof IS NULL THEN RAISE EXCEPTION 'CAJA C131 FAIL: faltan perfiles o un despacho con conductor'; END IF;
  INSERT INTO public.roles (id, name, permissions) VALUES (v_rreq, 'C131-sup-' || left(v_rreq::text, 8), '["despacho:write","hhee-solicitar:write","hhee:read"]');
  INSERT INTO public.sites (id, code, name) VALUES (v_site, 'C131-' || v_site, 'C131 sede');
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_req, v_site) ON CONFLICT DO NOTHING;
  INSERT INTO public.hhee_areas (id, site_id, name, module_enabled) VALUES (v_area, v_site, 'C131 Distribución', true);
  INSERT INTO public.hhee_memberships VALUES (v_req, v_area);
  UPDATE public.profiles SET role_id = v_rreq, is_active = true WHERE id = v_req;
  UPDATE public.hhee_people SET area_id = v_area, active = true WHERE driver_id = d.driver_id;
  IF NOT FOUND THEN
    INSERT INTO public.hhee_people (code, name, area_id, active, daily_hours, monthly_hours, divisor_confirmed, remuneration_concepts, driver_id)
    VALUES ('C131-COND', 'Conductor C131', v_area, true, 8, 240, false, '[]'::jsonb, d.driver_id);
  END IF;
  INSERT INTO public.hhee_people (code, name, area_id, active, daily_hours, monthly_hours, divisor_confirmed, remuneration_concepts)
  VALUES ('C131-A', 'Auxiliar A C131', v_area, true, 8, 240, false, '[]'::jsonb) RETURNING id INTO v_a;
  INSERT INTO public.hhee_people (code, name, area_id, active, daily_hours, monthly_hours, divisor_confirmed, remuneration_concepts)
  VALUES ('C131-C', 'Auxiliar C C131', v_area, true, 8, 240, false, '[]'::jsonb) RETURNING id INTO v_c;
  UPDATE public.hhee_people SET profile_id = NULL WHERE profile_id = v_prof;
  INSERT INTO public.hhee_people (code, name, area_id, active, daily_hours, monthly_hours, divisor_confirmed, remuneration_concepts, profile_id)
  VALUES ('C131-B', 'Auxiliar B C131', v_area, true, 8, 240, false, '[]'::jsonb, v_prof) RETURNING id INTO v_b;
  FOR i IN 1..7 LOOP
    INSERT INTO public.hhee_people (code, name, area_id, active, daily_hours, monthly_hours, divisor_confirmed, remuneration_concepts)
    VALUES ('C131-M' || i, 'Muchos ' || i || ' C131', v_area, true, 8, 240, false, '[]'::jsonb) RETURNING id INTO v_id;
    v_many := v_many || v_id;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub', v_req::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_req, 'role', 'authenticated')::text, true);

  IF prog.id IS NULL THEN pass := pass + 3; v_note := ' (T1–T3 sin ruta programada)';
  ELSE
    DELETE FROM public.route_auxiliaries WHERE dispatch_id = prog.id;
    -- T1: dos auxiliares a la vez (uno sin usuario, otro con usuario: también tripulación)
    r := public.set_route_auxiliaries(prog.id, ARRAY[v_a, v_b]);
    IF (r->>'success')::boolean AND (SELECT count(*) FROM public.route_auxiliaries WHERE dispatch_id = prog.id) = 2
       AND EXISTS (SELECT 1 FROM public.dispatch_crew WHERE dispatch_id = prog.id AND profile_id = v_prof AND crew_role = 'AUXILIAR' AND removed_at IS NULL)
    THEN pass := pass + 1; ELSE fails := fails || ('T1 dos auxiliares ' || r::text); END IF;
    -- T2: reemplazar la lista saca al que sale (y de la tripulación) y agrega al nuevo
    r := public.set_route_auxiliaries(prog.id, ARRAY[v_a, v_c]);
    IF (r->>'success')::boolean
       AND (SELECT array_agg(person_id ORDER BY person_id) FROM public.route_auxiliaries WHERE dispatch_id = prog.id) = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[v_a, v_c]) x)
       AND NOT EXISTS (SELECT 1 FROM public.dispatch_crew WHERE dispatch_id = prog.id AND profile_id = v_prof AND removed_at IS NULL)
    THEN pass := pass + 1; ELSE fails := fails || ('T2 reemplazo ' || r::text); END IF;
    -- T3: máximo 6; lista vacía quita a todos
    r := public.set_route_auxiliaries(prog.id, v_many);
    IF NOT (r->>'error') ~ 'Máximo 6' THEN fails := fails || ('T3 máximo ' || r::text); END IF;
    r := public.set_route_auxiliaries(prog.id, '{}'::uuid[]);
    IF (r->>'success')::boolean AND NOT EXISTS (SELECT 1 FROM public.route_auxiliaries WHERE dispatch_id = prog.id)
    THEN pass := pass + 1; ELSE fails := fails || ('T3 vaciar ' || r::text); END IF;
  END IF;

  -- T4: la solicitud automática incluye al conductor y a los dos auxiliares
  DELETE FROM public.route_auxiliaries WHERE dispatch_id = d.id;
  DELETE FROM public.dispatch_crew WHERE dispatch_id = d.id;
  INSERT INTO public.route_auxiliaries (dispatch_id, person_id) VALUES (d.id, v_a), (d.id, v_c);
  -- Horario sintético explícito para conductor y auxiliares; la transacción se revierte.
  UPDATE public.dispatches SET started_at='2025-03-03 08:00:00-05' WHERE id=d.id;
  INSERT INTO public.gp_shift_days(person_id,work_date,shift,reason,updated_by)
  SELECT h.id,'2025-03-03',public.gp_checked_shift('{"kind":"TRABAJO","start":"08:00","end":"17:30","break_minutes":60}'),'Turno sintético C131',v_req
  FROM public.hhee_people h WHERE h.area_id=v_area OR h.driver_id=d.driver_id
  ON CONFLICT(person_id,work_date) DO UPDATE SET shift=excluded.shift;
  r := public.hhee_route_request_for(d.id, '2025-03-03 19:10:00-05');
  v_id := (r->>'id')::uuid;
  IF (r->>'created')::boolean AND (r->>'workers')::int = 3
     AND (SELECT count(*) FROM public.hhee_lines WHERE request_id = v_id AND person_id IN (v_a, v_c)) = 2
  THEN pass := pass + 1; ELSE fails := fails || ('T4 solicitud ' || r::text); END IF;

  -- T5: permisos
  IF has_function_privilege('authenticated', 'public.set_route_auxiliaries(uuid, uuid[])', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.set_route_auxiliaries(uuid, uuid[])', 'EXECUTE')
  THEN pass := pass + 1; ELSE fails := fails || 'T5 permisos'::text; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C131 FAIL (%/5): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C131 PASS (5/5) varios auxiliares por ruta: asignar, reemplazar, máximo 6 y solicitud automática con todos%', v_note;
END $test$;
ROLLBACK;
