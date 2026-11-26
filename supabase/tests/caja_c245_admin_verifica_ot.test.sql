-- C245: el Administrador verifica y cierra una OT aunque la haya ejecutado; otro rol con el permiso de liberación
-- que ejecutó la OT sigue sin poder verificarla. Usa datos reales y siempre se revierte.
BEGIN;
SET LOCAL statement_timeout = '60s';
DO $test$
DECLARE v record; wo uuid; wo2 uuid; r jsonb; adm uuid; ex uuid; r_adm uuid; r_ex uuid := gen_random_uuid();
BEGIN
  SELECT id INTO r_adm FROM public.roles WHERE name = 'Administrador';
  SELECT p.id INTO adm FROM public.profiles p JOIN auth.users u ON u.id = p.id
  WHERE NOT EXISTS (SELECT 1 FROM public.drivers d WHERE d.profile_id = p.id) ORDER BY p.id LIMIT 1;
  SELECT p.id INTO ex FROM public.profiles p JOIN auth.users u ON u.id = p.id
  WHERE NOT EXISTS (SELECT 1 FROM public.drivers d WHERE d.profile_id = p.id) AND p.id <> adm ORDER BY p.id LIMIT 1;
  INSERT INTO public.roles (id, name, permissions) VALUES (r_ex, 'C245-e-' || r_ex, '["mantenimiento-ot:write","mantenimiento-liberacion"]'::jsonb);
  UPDATE public.profiles SET role_id = r_adm, is_active = true WHERE id = adm;
  UPDATE public.profiles SET role_id = r_ex, is_active = true WHERE id = ex;

  SELECT * INTO v FROM public.vehicles WHERE is_active AND status = 'DISPONIBLE' ORDER BY plate LIMIT 1;
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (adm, v.site_id), (ex, v.site_id) ON CONFLICT DO NOTHING;
  INSERT INTO public.maintenance_work_orders (ot_code, vehicle_id, vehicle_plate, description, order_type, status, site_id)
  VALUES ('C245-' || left(gen_random_uuid()::text, 8), v.id, v.plate, 'Prueba C245', 'CORRECTIVA', 'APROBADA', v.site_id) RETURNING id INTO wo;

  -- Administrador: ejecuta, verifica y cierra su propia OT
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', adm, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', adm::text, true);
  PERFORM set_config('role', 'authenticated', true);
  r := public.transition_work_order(wo, 'EN_PROCESO', NULL);
  IF NOT COALESCE((r->>'success')::boolean, false) THEN RAISE EXCEPTION 'CAJA C245 FAIL: el Administrador no inicia la OT (%)', r; END IF;
  r := public.transition_work_order(wo, 'TERMINADA', 'Trabajo de prueba');
  IF NOT COALESCE((r->>'success')::boolean, false) THEN RAISE EXCEPTION 'CAJA C245 FAIL: el Administrador no termina la OT (%)', r; END IF;
  r := public.transition_work_order(wo, 'VALIDACION', NULL);
  IF NOT COALESCE((r->>'success')::boolean, false) THEN RAISE EXCEPTION 'CAJA C245 FAIL: el Administrador no verifica su OT (%)', r; END IF;
  r := public.complete_maintenance_order(wo, '[]'::jsonb, NULL);
  IF NOT COALESCE((r->>'success')::boolean, false) THEN RAISE EXCEPTION 'CAJA C245 FAIL: el Administrador no cierra su OT (%)', r; END IF;
  PERFORM set_config('role', 'postgres', true);
  IF (SELECT status FROM public.maintenance_work_orders WHERE id = wo) <> 'CERRADA' THEN RAISE EXCEPTION 'CAJA C245 FAIL: la OT no quedó CERRADA'; END IF;

  -- Otro rol con el permiso que ejecutó: sigue sin poder verificar
  INSERT INTO public.maintenance_work_orders (ot_code, vehicle_id, vehicle_plate, description, order_type, status, site_id)
  VALUES ('C245-' || left(gen_random_uuid()::text, 8), v.id, v.plate, 'Prueba C245 b', 'CORRECTIVA', 'APROBADA', v.site_id) RETURNING id INTO wo2;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', ex, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', ex::text, true);
  PERFORM set_config('role', 'authenticated', true);
  r := public.transition_work_order(wo2, 'EN_PROCESO', NULL);
  IF NOT COALESCE((r->>'success')::boolean, false) THEN RAISE EXCEPTION 'CAJA C245 FAIL: no inicia la OT b (%)', r; END IF;
  r := public.transition_work_order(wo2, 'TERMINADA', 'Trabajo de prueba');
  IF NOT COALESCE((r->>'success')::boolean, false) THEN RAISE EXCEPTION 'CAJA C245 FAIL: no termina la OT b (%)', r; END IF;
  r := public.transition_work_order(wo2, 'VALIDACION', NULL);
  PERFORM set_config('role', 'postgres', true);
  IF COALESCE((r->>'success')::boolean, true) THEN RAISE EXCEPTION 'CAJA C245 FAIL: un no administrador verificó su propia OT'; END IF;

  RAISE EXCEPTION 'CAJA C245 PASS: el Administrador verifica y cierra aunque haya ejecutado; los demás roles mantienen la segregación';
END $test$;
ROLLBACK;
