-- C242: Mantenimiento fase 7. VALIDACION obligatoria y hecha por el Jefe de Distribución (permiso
-- mantenimiento-liberacion), nunca por quien ejecutó; liberación solo con APTO; indisponibilidad que incluye unidades
-- bloqueadas sin OT; MTTR sin esperas. Usa datos reales y siempre se revierte.
BEGIN;
SET LOCAL statement_timeout = '60s';
DO $test$
DECLARE v record; b record; wo uuid; r jsonb; k jsonb; exec_user uuid; ver_user uuid; r_exec uuid := gen_random_uuid(); r_ver uuid := gen_random_uuid();
  t date := (now() AT TIME ZONE 'America/Lima')::date;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.roles WHERE name = 'Jefe de Distribución' AND permissions ? 'mantenimiento-liberacion') THEN
    RAISE EXCEPTION 'CAJA C242 FAIL: el Jefe de Distribución no tiene el permiso de liberación'; END IF;
  IF position('= ''APTO'' THEN' IN pg_get_functiondef('public.complete_maintenance_order(uuid,jsonb,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'CAJA C242 FAIL: el cierre libera sin exigir APTO'; END IF;

  -- Usuarios de prueba: uno ejecuta (OT + liberación, para probar que igual no puede verificar) y otro verifica
  SELECT p.id INTO exec_user FROM public.profiles p JOIN auth.users u ON u.id = p.id
  WHERE NOT EXISTS (SELECT 1 FROM public.drivers d WHERE d.profile_id = p.id) ORDER BY p.id LIMIT 1;
  SELECT p.id INTO ver_user FROM public.profiles p JOIN auth.users u ON u.id = p.id
  WHERE NOT EXISTS (SELECT 1 FROM public.drivers d WHERE d.profile_id = p.id) AND p.id <> exec_user ORDER BY p.id LIMIT 1;
  INSERT INTO public.roles (id, name, permissions) VALUES
    (r_exec, 'C242-e-' || r_exec, '["mantenimiento-ot:write","mantenimiento-liberacion"]'::jsonb),
    (r_ver, 'C242-v-' || r_ver, '["mantenimiento-liberacion","mantenimiento-ot:read"]'::jsonb);
  UPDATE public.profiles SET role_id = r_exec, is_active = true WHERE id = exec_user;
  UPDATE public.profiles SET role_id = r_ver, is_active = true WHERE id = ver_user;

  SELECT * INTO v FROM public.vehicles WHERE is_active AND status = 'DISPONIBLE' ORDER BY plate DESC LIMIT 1;
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (exec_user, v.site_id), (ver_user, v.site_id) ON CONFLICT DO NOTHING;
  INSERT INTO public.maintenance_work_orders (ot_code, vehicle_id, vehicle_plate, description, order_type, status, site_id)
  VALUES ('C242-' || left(gen_random_uuid()::text, 8), v.id, v.plate, 'Prueba C242', 'CORRECTIVA', 'APROBADA', v.site_id) RETURNING id INTO wo;

  -- Ejecuta: inicia y termina (fin técnico) → espera de verificación
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', exec_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', exec_user::text, true);
  PERFORM set_config('role', 'authenticated', true);
  r := public.transition_work_order(wo, 'EN_PROCESO', NULL);
  IF NOT COALESCE((r->>'success')::boolean, false) THEN RAISE EXCEPTION 'CAJA C242 FAIL: no inicia la OT (%)', r; END IF;
  r := public.transition_work_order(wo, 'TERMINADA', 'Cambio de pieza');
  IF NOT COALESCE((r->>'success')::boolean, false) THEN RAISE EXCEPTION 'CAJA C242 FAIL: no termina la OT (%)', r; END IF;
  r := public.transition_work_order(wo, 'VALIDACION', NULL);
  IF COALESCE((r->>'success')::boolean, true) THEN RAISE EXCEPTION 'CAJA C242 FAIL: quien ejecutó verificó su OT'; END IF;
  -- Escritura directa de la lectura de ejecución: se ignora
  UPDATE public.maintenance_work_orders SET executed_odometer = -1, preventive_compliance = 'A_TIEMPO' WHERE id = wo;
  IF (SELECT executed_odometer = -1 OR preventive_compliance IS NOT NULL FROM public.maintenance_work_orders WHERE id = wo) THEN
    RAISE EXCEPTION 'CAJA C242 FAIL: la pantalla sobrescribe la lectura de ejecución o el cumplimiento'; END IF;
  r := public.complete_maintenance_order(wo, '[]'::jsonb, NULL);
  IF COALESCE((r->>'success')::boolean, true) THEN RAISE EXCEPTION 'CAJA C242 FAIL: se cerró sin VALIDACION'; END IF;

  -- Verifica el Jefe de Distribución (otra persona)
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', ver_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', ver_user::text, true);
  PERFORM set_config('role', 'authenticated', true);
  r := public.transition_work_order(wo, 'VALIDACION', 'Verificada en patio');
  IF NOT COALESCE((r->>'success')::boolean, false) THEN RAISE EXCEPTION 'CAJA C242 FAIL: el Jefe no pudo verificar (%)', r; END IF;
  r := public.complete_maintenance_order(wo, '[]'::jsonb, 'Cierre C242');
  PERFORM set_config('role', 'postgres', true);
  IF NOT COALESCE((r->>'success')::boolean, false) THEN RAISE EXCEPTION 'CAJA C242 FAIL: el Jefe no pudo cerrar (%)', r; END IF;
  IF (SELECT status <> 'CERRADA' OR validated_by IS DISTINCT FROM ver_user OR closed_by IS DISTINCT FROM ver_user OR finished_at IS NULL
      FROM public.maintenance_work_orders WHERE id = wo) THEN
    RAISE EXCEPTION 'CAJA C242 FAIL: validador, cierre o fin técnico incorrectos'; END IF;
  IF EXISTS (SELECT 1 FROM public.maintenance_work_order_waits WHERE work_order_id = wo AND ended_at IS NULL)
     OR NOT EXISTS (SELECT 1 FROM public.maintenance_work_order_waits WHERE work_order_id = wo AND reason = 'VERIFICACION') THEN
    RAISE EXCEPTION 'CAJA C242 FAIL: la espera de verificación no se registró o quedó abierta'; END IF;

  -- Soporte (solo OT) no libera una unidad en mantenimiento
  UPDATE public.roles SET permissions = '["mantenimiento-ot:write"]'::jsonb WHERE id = r_exec;
  SELECT * INTO b FROM public.vehicles WHERE is_active AND id <> v.id AND status = 'DISPONIBLE' ORDER BY plate LIMIT 1;
  ALTER TABLE public.vehicles DISABLE TRIGGER USER;
  UPDATE public.vehicles SET status = 'OBSERVADA' WHERE id = b.id;
  ALTER TABLE public.vehicles ENABLE TRIGGER USER;
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (exec_user, b.site_id) ON CONFLICT DO NOTHING;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', exec_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', exec_user::text, true);
  PERFORM set_config('role', 'authenticated', true);
  r := public.transition_vehicle_status(b.plate, 'DISPONIBLE', 'C242', NULL, NULL);
  PERFORM set_config('role', 'postgres', true);
  IF COALESCE((r->>'success')::boolean, true) THEN RAISE EXCEPTION 'CAJA C242 FAIL: Soporte Mecánico liberó la unidad'; END IF;

  -- Disponibilidad: unidad BLOQUEADA hace 10 h sin OT cuenta como indisponible
  UPDATE public.vehicles SET status = 'BLOQUEADA' WHERE id = b.id;
  DELETE FROM public.vehicle_history_logs WHERE vehicle_plate = b.plate AND field_changed = 'status' AND created_at > now() - interval '10 hours';
  INSERT INTO public.vehicle_history_logs (vehicle_plate, field_changed, old_value, new_value, change_reason, created_at)
  VALUES (b.plate, 'status', 'DISPONIBLE', 'BLOQUEADA', 'C242', now() - interval '10 hours');
  k := public.get_cmms_kpis(t - 1, t, ARRAY[b.plate]);
  IF (k->>'downtime_hours')::numeric < 9.9 OR (k->>'availability_pct')::numeric > 100 THEN
    RAISE EXCEPTION 'CAJA C242 FAIL: la unidad bloqueada sin OT no resta disponibilidad (%)', k->>'downtime_hours'; END IF;
  k := public.get_cmms_kpis(t - 30, t, NULL);
  IF NOT (k ? 'mttr_n' AND k ? 'preventive_due' AND k ? 'restoration_hours') THEN RAISE EXCEPTION 'CAJA C242 FAIL: indicadores incompletos'; END IF;

  RAISE EXCEPTION 'CAJA C242 PASS: VALIDACION obligatoria por el Jefe de Distribución y nunca por quien ejecutó; solo el Jefe libera; bloqueos sin OT restan disponibilidad';
END $test$;
ROLLBACK;
