-- CAJA C127 — Personal unificado por DNI (Flota / Maestros → ficha de HHEE) y placa de la ruta en las horas extras de
-- conductores (ruta única automática, varias → elegir, sin ruta → placa y motivo). Usa un conductor existente (o una
-- copia temporal) y no depende de que haya rutas en la fecha. Se revierte.
BEGIN;
SET LOCAL statement_timeout = '60s';
DO $test$
DECLARE v_req uuid; v_app uuid; v_rreq uuid := gen_random_uuid(); v_rapp uuid := gen_random_uuid(); v_site uuid := gen_random_uuid();
  v_area uuid := gen_random_uuid(); v_cause uuid; v_drv uuid; v_m jsonb; v_p uuid; v_id uuid; v_ver int; r jsonb; d jsonb; v_routes jsonb; v_n int;
  pass int := 0; fails text[] := '{}'; v_mode text; v_base jsonb; v_disp record;
  v_day text := (SELECT gs::date::text FROM generate_series((now() AT TIME ZONE 'America/Lima')::date, (now() AT TIME ZONE 'America/Lima')::date + 10, interval '1 day') gs
                 WHERE public.hhee_pe_holiday(gs::date) IS NULL ORDER BY gs LIMIT 1);
BEGIN
  SELECT p.id INTO v_req FROM public.profiles p JOIN auth.users u ON u.id = p.id ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_app FROM public.profiles p JOIN auth.users u ON u.id = p.id WHERE p.id <> v_req ORDER BY p.id LIMIT 1;
  SELECT id INTO v_cause FROM public.hhee_causes WHERE active ORDER BY name LIMIT 1;
  IF v_req IS NULL OR v_app IS NULL OR v_cause IS NULL THEN RAISE EXCEPTION 'CAJA C127 FAIL: faltan perfiles o causas'; END IF;
  INSERT INTO public.roles (id, name, permissions) VALUES
    (v_rreq, 'C127-sup-' || left(v_rreq::text, 8), '["hhee-solicitar:write","hhee:read"]'),
    (v_rapp, 'C127-jefe-' || left(v_rapp::text, 8), '["hhee-aprobar:write","hhee-costos:read","hhee-gerencia:read","hhee-config:write","hhee:read"]');
  INSERT INTO public.sites (id, code, name) VALUES (v_site, 'C127-' || v_site, 'C127 sede');
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_req, v_site), (v_app, v_site) ON CONFLICT DO NOTHING;
  INSERT INTO public.hhee_areas (id, site_id, name, module_enabled) VALUES (v_area, v_site, 'C127 Distribución', true);
  INSERT INTO public.hhee_memberships VALUES (v_req, v_area), (v_app, v_area);
  UPDATE public.profiles SET role_id = v_rreq, is_active = true WHERE id = v_req;
  UPDATE public.profiles SET role_id = v_rapp, is_active = true WHERE id = v_app;

  -- Conductor activo con DNI único y sin ficha de HHEE; si no hay, una copia temporal de uno existente
  SELECT d.id INTO v_drv FROM public.drivers d, LATERAL public.hhee_driver_master(d.id) m
  WHERE (m->>'active')::boolean AND length(m->>'doc') BETWEEN 6 AND 20 AND length(m->>'name') BETWEEN 3 AND 160
    AND NOT EXISTS (SELECT 1 FROM public.hhee_people x WHERE x.driver_id = d.id OR public.hhee_norm_doc(x.document_number) = m->>'doc')
    AND (SELECT count(*) FROM public.drivers d2 WHERE public.hhee_norm_doc(COALESCE(to_jsonb(d2)->>'document_number', to_jsonb(d2)->>'document_id')) = m->>'doc') = 1
  ORDER BY d.id LIMIT 1;
  v_mode := 'conductor existente';
  IF v_drv IS NULL THEN
    v_drv := gen_random_uuid(); v_mode := 'copia temporal';
    INSERT INTO public.drivers SELECT * FROM jsonb_populate_record(NULL::public.drivers, (SELECT to_jsonb(d0) FROM public.drivers d0 LIMIT 1)
      || jsonb_build_object('id', v_drv, 'first_name', 'Conductor', 'last_name', 'Prueba C127', 'document_number', '71270127', 'document_id', '71270127',
         'profile_id', NULL, 'pin', NULL, 'is_active', true, 'license_number', 'C127-' || left(v_drv::text, 8)));
  END IF;
  v_m := public.hhee_driver_master(v_drv);
  v_base := jsonb_build_object('area_id', v_area, 'cause_id', v_cause, 'work_date', v_day, 'activity', 'Reparto C127',
    'justification', 'Pedido adicional del cliente', 'alternatives', 'Reasignar turno', 'expected_result', 'Reparto completo');

  -- T1: la ficha con el DNI de un conductor se enlaza sola y toma su nombre y DNI de Flota
  PERFORM set_config('request.jwt.claim.sub', v_app::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_app, 'role', 'authenticated')::text, true);
  r := public.hhee_flow_person_save(jsonb_build_object('code', 'C127-01', 'name', 'Nombre Escrito Distinto', 'document_number', v_m->>'doc',
    'position', 'Conductor', 'area_id', v_area, 'monthly_hours', 240, 'divisor_confirmed', true,
    'remuneration_concepts', '[{"name":"Básico","amount":2400,"computable":true}]'::jsonb));
  v_p := (r->'person'->>'id')::uuid;
  IF (r->>'success')::boolean AND r->'person'->>'driver_id' = v_drv::text AND r->'person'->>'master' = 'FLOTA'
     AND r->'person'->>'name' = v_m->>'name' AND (SELECT document_number FROM public.hhee_people WHERE id = v_p) = v_m->>'doc'
  THEN pass := pass + 1; ELSE fails := fails || ('T1 enlace por DNI ' || left(r::text, 300)); END IF;

  -- T2: corregir el nombre en Flota actualiza la ficha
  UPDATE public.drivers SET first_name = 'Corregido' WHERE id = v_drv;
  IF (SELECT name FROM public.hhee_people WHERE id = v_p) LIKE 'Corregido %'
  THEN pass := pass + 1; ELSE fails := fails || ('T2 Flota → ficha ' || (SELECT name FROM public.hhee_people WHERE id = v_p)); END IF;

  -- T3: diagnóstico, enlace y fichas para conductores sin ficha; solo quien administra el personal
  r := public.hhee_people_unify('{}'::jsonb);
  d := public.hhee_people_unify(jsonb_build_object('action', 'create_drivers', 'area_id', v_area));
  v_n := (SELECT count(*) FROM public.drivers dd, LATERAL public.hhee_driver_master(dd.id) m
          WHERE (m->>'active')::boolean AND length(m->>'doc') BETWEEN 6 AND 20 AND length(m->>'name') BETWEEN 3 AND 160
            AND NOT EXISTS (SELECT 1 FROM public.hhee_people x WHERE x.driver_id = dd.id OR public.hhee_norm_doc(x.document_number) = m->>'doc'));
  IF (r->>'success')::boolean AND (r->'summary'->>'linked_driver')::int >= 1 AND (d->>'success')::boolean AND v_n = 0
     AND (public.hhee_people_unify(jsonb_build_object('action', 'link'))->>'success')::boolean
  THEN pass := pass + 1; ELSE fails := fails || ('T3 unificar ' || left(r::text, 200) || ' | ' || d::text || ' | sin ficha ' || v_n); END IF;

  -- T4: placa según la ruta: sin ruta exige placa y motivo; con una ruta la toma sola; con varias pide elegir
  PERFORM set_config('request.jwt.claim.sub', v_req::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_req, 'role', 'authenticated')::text, true);
  v_routes := public.hhee_driver_routes(v_drv, v_day::date);
  BEGIN
    r := public.hhee_flow_request_save(v_base || jsonb_build_object('lines', jsonb_build_array(
      jsonb_build_object('person_id', v_p, 'start', v_day || 'T18:00', 'end', v_day || 'T20:00'))));
    IF jsonb_array_length(v_routes) = 1 AND (SELECT (vehicle_plate, plate_source) = (v_routes->0->>'plate', 'RUTA') FROM public.hhee_lines WHERE request_id = (r->>'id')::uuid)
    THEN pass := pass + 1; ELSE fails := fails || ('T4 sin placa aceptado con ' || jsonb_array_length(v_routes) || ' rutas'); END IF;
  EXCEPTION WHEN OTHERS THEN
    IF (jsonb_array_length(v_routes) = 0 AND SQLERRM ~ 'no tiene ruta asignada') OR (jsonb_array_length(v_routes) > 1 AND SQLERRM ~ 'elija') THEN pass := pass + 1;
    ELSE fails := fails || ('T4 ' || SQLERRM); END IF;
  END;

  -- T5: placa a mano con motivo; una ruta que no es suya se rechaza; el informe aprobado guarda placa y motivo
  BEGIN
    PERFORM public.hhee_flow_request_save(v_base || jsonb_build_object('lines', jsonb_build_array(
      jsonb_build_object('person_id', v_p, 'start', v_day || 'T18:00', 'end', v_day || 'T20:00', 'dispatch_id', gen_random_uuid()))));
    fails := fails || 'T5 ruta ajena aceptada'::text;
  EXCEPTION WHEN OTHERS THEN IF SQLERRM !~ 'no es suya' THEN fails := fails || ('T5 ' || SQLERRM); END IF;
  END;
  r := public.hhee_flow_request_save(v_base || jsonb_build_object('lines', jsonb_build_array(
    jsonb_build_object('person_id', v_p, 'start', v_day || 'T21:00', 'end', v_day || 'T22:00', 'vehicle_plate', ' abc-127 ', 'plate_reason', 'Apoyo en taller sin ruta'))));
  v_id := (r->>'id')::uuid; v_ver := (public.hhee_flow_submit(v_id, (r->>'version')::int)->>'version')::int;
  PERFORM set_config('request.jwt.claim.sub', v_app::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_app, 'role', 'authenticated')::text, true);
  d := public.hhee_flow_decide(jsonb_build_object('id', v_id, 'decision', 'APROBADA', 'reason', 'Necesidad confirmada', 'expected_version', v_ver));
  d := (SELECT snapshot->'lines'->0 FROM public.hhee_authorizations WHERE request_id = v_id);
  IF d->>'vehicle_plate' = 'ABC-127' AND d->>'plate_source' = 'MANUAL' AND d->>'plate_reason' = 'Apoyo en taller sin ruta' AND d->>'document_number' = v_m->>'doc'
  THEN pass := pass + 1; ELSE fails := fails || ('T5 placa manual ' || COALESCE(d::text, 'sin informe')); END IF;

  -- T6: las rutas de un despacho real se leen por conductor y fecha, y la vista previa las ofrece
  SELECT x.id, x.driver_id, public.fe_jdate(to_jsonb(x), ARRAY['scheduled_departure', 'scheduled_date', 'dispatch_date', 'departure_date', 'departure_time', 'started_at', 'created_at']) AS dia
  INTO v_disp FROM public.dispatches x
  WHERE x.driver_id IS NOT NULL AND x.vehicle_plate IS NOT NULL AND upper(COALESCE(to_jsonb(x)->>'status', '')) NOT IN ('CANCELADO', 'CANCELADA', 'ANULADO', 'ANULADA', 'BORRADOR')
  ORDER BY x.id LIMIT 1;
  r := public.hhee_flow_preview(jsonb_build_object('work_date', v_day, 'lines', jsonb_build_array(
    jsonb_build_object('person_id', v_p, 'start', v_day || 'T18:00', 'end', v_day || 'T19:00'))));
  IF (r->'lines'->0->>'driver')::boolean AND jsonb_typeof(r->'lines'->0->'routes') = 'array'
     AND (v_disp.id IS NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(public.hhee_driver_routes(v_disp.driver_id, v_disp.dia)) e WHERE e->>'id' = v_disp.id::text))
  THEN pass := pass + 1; ELSE fails := fails || ('T6 rutas ' || left(r::text, 200)); END IF;

  -- T7: permisos: el supervisor no administra la unificación; funciones internas fuera de la web
  PERFORM set_config('request.jwt.claim.sub', v_req::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_req, 'role', 'authenticated')::text, true);
  IF NOT (public.hhee_people_unify(jsonb_build_object('action', 'link'))->>'success')::boolean
     AND NOT has_function_privilege('authenticated', 'public.hhee_driver_routes(uuid, date)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.hhee_driver_master(uuid)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.hhee_people_unify(jsonb)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.hhee_people_unify(jsonb)', 'EXECUTE')
  THEN pass := pass + 1; ELSE fails := fails || 'T7 permisos'::text; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C127 FAIL (%/7, %): %', pass, v_mode, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C127 PASS (7/7) personal unificado por DNI (%), Flota manda en nombre y DNI, placa de la ruta (% ruta(s) ese día) o manual con motivo', v_mode, jsonb_array_length(v_routes);
END $test$;
ROLLBACK;
