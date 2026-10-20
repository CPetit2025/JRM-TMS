-- CAJA C130 — Armar ruta: el auxiliar se elige de Personal (HHEE), aunque no tenga usuario; no puede estar en otra
-- ruta activa ni ser el conductor; con usuario también queda en la tripulación; entra en la solicitud automática
-- de horas extras de la ruta. Usa un despacho existente con conductor; se revierte.
BEGIN;
SET LOCAL statement_timeout = '60s';
DO $test$
DECLARE v_req uuid; v_rreq uuid := gen_random_uuid(); v_site uuid := gen_random_uuid(); v_area uuid := gen_random_uuid();
  d record; prog record; r jsonb; v_note text := ''; v_pcond uuid; v_aux uuid; v_aux2 uuid; v_cond uuid; v_prof uuid; v_id uuid; v_other uuid; pass int := 0; fails text[] := '{}';
BEGIN
  SELECT p.id INTO v_req FROM public.profiles p JOIN auth.users u ON u.id = p.id ORDER BY p.id LIMIT 1;
  SELECT x.id, x.driver_id, x.vehicle_plate INTO d FROM public.dispatches x JOIN public.drivers dr ON dr.id = x.driver_id
  WHERE x.vehicle_plate IS NOT NULL AND x.vehicle_plate <> 'EXTERNO' AND length((public.hhee_driver_master(dr.id))->>'name') >= 3
    AND NOT EXISTS (SELECT 1 FROM public.hhee_requests h WHERE h.auto_dispatch_id = x.id)
  ORDER BY x.id LIMIT 1;
  SELECT p.id INTO v_prof FROM public.profiles p WHERE COALESCE(p.is_active, true) AND p.id <> v_req
    AND NOT EXISTS (SELECT 1 FROM public.drivers x WHERE x.profile_id = p.id) ORDER BY p.id LIMIT 1;
  -- Ruta programada (para asignar el auxiliar) sin modificar despachos; si no hay, esas verificaciones se omiten
  SELECT x.id, x.driver_id INTO prog FROM public.dispatches x WHERE x.status = 'PROGRAMADO' AND x.driver_id IS NOT NULL ORDER BY x.id LIMIT 1;
  IF v_req IS NULL OR d.id IS NULL OR v_prof IS NULL THEN RAISE EXCEPTION 'CAJA C130 FAIL: faltan perfiles o un despacho con conductor'; END IF;
  INSERT INTO public.roles (id, name, permissions) VALUES (v_rreq, 'C130-sup-' || left(v_rreq::text, 8), '["despacho:write","hhee-solicitar:write","hhee:read"]');
  INSERT INTO public.sites (id, code, name) VALUES (v_site, 'C130-' || v_site, 'C130 sede');
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_req, v_site) ON CONFLICT DO NOTHING;
  INSERT INTO public.hhee_areas (id, site_id, name, module_enabled) VALUES (v_area, v_site, 'C130 Distribución', true);
  INSERT INTO public.hhee_memberships VALUES (v_req, v_area);
  UPDATE public.profiles SET role_id = v_rreq, is_active = true WHERE id = v_req;
  UPDATE public.hhee_people SET area_id = v_area, active = true WHERE driver_id = d.driver_id;
  IF NOT FOUND THEN
    INSERT INTO public.hhee_people (code, name, area_id, active, daily_hours, monthly_hours, divisor_confirmed, remuneration_concepts, driver_id)
    VALUES ('C130-COND', 'Conductor C130', v_area, true, 8, 240, false, '[]'::jsonb, d.driver_id);
  END IF;
  SELECT id INTO v_cond FROM public.hhee_people WHERE driver_id = d.driver_id;
  -- Auxiliar de Personal sin usuario, otro con usuario
  INSERT INTO public.hhee_people (code, name, position, area_id, active, daily_hours, monthly_hours, divisor_confirmed, remuneration_concepts)
  VALUES ('C130-AUX', 'Auxiliar Sin Usuario C130', 'Auxiliar de Transporte', v_area, true, 8, 240, false, '[]'::jsonb) RETURNING id INTO v_aux;
  UPDATE public.hhee_people SET profile_id = NULL WHERE profile_id = v_prof;
  INSERT INTO public.hhee_people (code, name, position, area_id, active, daily_hours, monthly_hours, divisor_confirmed, remuneration_concepts, profile_id)
  VALUES ('C130-AUX2', 'Auxiliar Con Usuario C130', 'Ayudante', v_area, true, 8, 240, false, '[]'::jsonb, v_prof) RETURNING id INTO v_aux2;
  DELETE FROM public.route_auxiliaries WHERE dispatch_id IN (d.id, prog.id);
  DELETE FROM public.dispatch_crew WHERE dispatch_id = d.id;
  IF prog.id IS NOT NULL THEN v_pcond := public.hhee_person_for(prog.driver_id, NULL, v_area); END IF;
  PERFORM set_config('request.jwt.claim.sub', v_req::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_req, 'role', 'authenticated')::text, true);

  -- T1: la lista sale de Personal: incluye al auxiliar sin usuario y al conductor (como CONDUCTOR)
  r := public.list_route_assistants(NULL);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(r) x WHERE x->>'person_id' = v_aux::text AND x->>'kind' = 'AUXILIAR' AND x->>'profile_id' IS NULL AND x->>'busy' IS NULL)
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(r) x WHERE x->>'person_id' = v_cond::text AND x->>'kind' = 'CONDUCTOR')
  THEN pass := pass + 1; ELSE fails := fails || 'T1 lista desde Personal'::text; END IF;

  IF prog.id IS NULL THEN pass := pass + 3; v_note := ' (T2–T4 sin ruta programada)';
  ELSE
  -- T2: el conductor de la ruta no puede ir de auxiliar; el auxiliar sin usuario sí
  r := public.set_route_auxiliary(prog.id, v_pcond);
  IF NOT (r->>'error') ~ 'conductor de la ruta' THEN fails := fails || ('T2 conductor como auxiliar ' || r::text); END IF;
  r := public.set_route_auxiliary(prog.id, v_aux);
  IF (r->>'success')::boolean
     AND (SELECT person_id FROM public.route_auxiliaries WHERE dispatch_id = prog.id) = v_aux
  THEN pass := pass + 1; ELSE fails := fails || 'T2 asignar sin usuario'::text; END IF;

  -- T3: ocupado en esta ruta no puede ir a otra ruta programada
  SELECT x.id INTO v_other FROM public.dispatches x WHERE x.status = 'PROGRAMADO' AND x.id <> prog.id ORDER BY x.id LIMIT 1;
  IF v_other IS NULL THEN pass := pass + 1; v_note := v_note || ' (T3 sin segunda ruta programada)';
  ELSE
    IF (public.set_route_auxiliary(v_other, v_aux)->>'error') ~ 'ya está en la ruta'
       AND (SELECT x->>'busy' FROM jsonb_array_elements(public.list_route_assistants(v_other)) x WHERE x->>'person_id' = v_aux::text) IS NOT NULL
    THEN pass := pass + 1; ELSE fails := fails || 'T3 ocupado'::text; END IF;
  END IF;

  -- T4: cambiar a uno con usuario lo agrega a la tripulación; quitarlo lo saca
  r := public.set_route_auxiliary(prog.id, v_aux2);
  IF NOT ((r->>'success')::boolean AND EXISTS (SELECT 1 FROM public.dispatch_crew WHERE dispatch_id = prog.id AND profile_id = v_prof AND crew_role = 'AUXILIAR' AND removed_at IS NULL))
  THEN fails := fails || ('T4 con usuario ' || r::text); END IF;
  r := public.set_route_auxiliary(prog.id, NULL);
  IF (r->>'success')::boolean
     AND NOT EXISTS (SELECT 1 FROM public.dispatch_crew WHERE dispatch_id = prog.id AND profile_id = v_prof AND removed_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM public.route_auxiliaries WHERE dispatch_id = prog.id)
  THEN pass := pass + 1; ELSE fails := fails || 'T4 tripulación'::text; END IF;

  PERFORM public.set_route_auxiliary(prog.id, NULL);
  END IF;

  -- T5: la solicitud automática incluye al auxiliar de Personal sin usuario (y no lo duplica)
  INSERT INTO public.route_auxiliaries (dispatch_id, person_id) VALUES (d.id, v_aux);
  r := public.hhee_route_request_for(d.id, '2025-03-03 19:10:00-05');
  v_id := (r->>'id')::uuid;
  IF (r->>'created')::boolean AND (r->>'workers')::int = 2
     AND EXISTS (SELECT 1 FROM public.hhee_lines WHERE request_id = v_id AND person_id = v_aux)
     AND EXISTS (SELECT 1 FROM public.hhee_lines WHERE request_id = v_id AND person_id = v_cond AND plate_source = 'RUTA')
  THEN pass := pass + 1; ELSE fails := fails || ('T5 solicitud automática ' || r::text); END IF;

  -- T6: permisos
  IF has_function_privilege('authenticated', 'public.set_route_auxiliary(uuid, uuid)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.set_route_auxiliary(uuid, uuid)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.route_person_busy(uuid, uuid)', 'EXECUTE')
  THEN pass := pass + 1; ELSE fails := fails || 'T6 permisos'::text; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C130 FAIL (%/6): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C130 PASS (6/6) auxiliar elegido de Personal (con o sin usuario), ocupación, tripulación y solicitud automática%', v_note;
END $test$;
ROLLBACK;
