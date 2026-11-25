-- C240: Mantenimiento fase 5. Una sola vía de lecturas con validación (retroceso y salto sin foto quedan en revisión
-- y no mueven la unidad; el reporte de falla ya no valida una lectura menor) y unidades que se desactivan, nunca se
-- borran ni cambian lecturas desde la pantalla. Usa datos reales y siempre se revierte.
BEGIN;
SET LOCAL statement_timeout = '60s';
DO $test$
DECLARE v record; r jsonb; actor uuid; ok boolean; req jsonb; odo numeric;
BEGIN
  IF has_function_privilege('authenticated', 'public.asset_reading_apply(text,numeric,numeric,text,text,uuid,uuid,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'CAJA C240 FAIL: la vía interna de lecturas está expuesta'; END IF;
  IF has_table_privilege('authenticated', 'public.vehicles', 'DELETE') OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
       AND tablename = 'vehicles' AND policyname = 'vehicles_write_site') THEN
    RAISE EXCEPTION 'CAJA C240 FAIL: las unidades aún se pueden borrar desde la pantalla'; END IF;

  SELECT * INTO v FROM public.vehicles WHERE is_active AND status = 'DISPONIBLE' AND NOT EXISTS (SELECT 1 FROM public.dispatches d
    WHERE d.vehicle_plate = vehicles.plate AND d.status NOT IN ('CERRADO', 'LIQUIDADO', 'CANCELADO', 'RETORNO_COMPLETADO', 'ENTREGADO'))
  ORDER BY plate LIMIT 1;
  IF v.id IS NULL THEN RAISE EXCEPTION 'CAJA C240 FAIL: no hay unidad libre para probar'; END IF;
  UPDATE public.vehicles SET current_odometer = 10000, current_hours = 500 WHERE id = v.id;

  -- Retroceso: queda en revisión y no mueve la unidad
  r := public.asset_reading_apply(v.plate, 9000, NULL, 'C240');
  IF r->>'status' <> 'REQUIERE_AUDITORIA' OR (SELECT current_odometer FROM public.vehicles WHERE id = v.id) <> 10000 THEN
    RAISE EXCEPTION 'CAJA C240 FAIL: un retroceso de odómetro se aceptó (%)', r; END IF;
  r := public.asset_reading_apply(v.plate, NULL, 400, 'C240');
  IF r->>'status' <> 'REQUIERE_AUDITORIA' OR (SELECT current_hours FROM public.vehicles WHERE id = v.id) <> 500 THEN
    RAISE EXCEPTION 'CAJA C240 FAIL: el horómetro retrocedió (%)', r; END IF;
  -- Salto atípico: sin foto queda en revisión; con foto se valida
  r := public.asset_reading_apply(v.plate, 12000, NULL, 'C240');
  IF r->>'status' <> 'REQUIERE_AUDITORIA' OR (SELECT current_odometer FROM public.vehicles WHERE id = v.id) <> 10000 THEN
    RAISE EXCEPTION 'CAJA C240 FAIL: salto sin foto aceptado (%)', r; END IF;
  r := public.asset_reading_apply(v.plate, 12000, 510, 'C240', 'c240/tablero.jpg');
  IF r->>'status' <> 'VALIDADO' OR (SELECT current_odometer FROM public.vehicles WHERE id = v.id) <> 12000
     OR (SELECT current_hours FROM public.vehicles WHERE id = v.id) <> 510 THEN
    RAISE EXCEPTION 'CAJA C240 FAIL: salto con foto no se validó (%)', r; END IF;
  IF (SELECT count(*) FROM public.vehicle_odometer_logs WHERE vehicle_plate = v.plate AND source_event = 'C240') <> 4 THEN
    RAISE EXCEPTION 'CAJA C240 FAIL: las lecturas no quedaron en la bitácora única'; END IF;

  -- Reporte de falla con odómetro menor: ya no se registra VALIDADO
  req := public.submit_maintenance_request_v2(v.plate, NULL, NULL, 'C240 prueba de lectura menor ' || gen_random_uuid(), 'BAJA',
                                              11000, NULL, '{}'::jsonb, NULL, true, NULL, NULL);
  IF NOT COALESCE((req->>'success')::boolean, false) OR req->>'reading_status' <> 'REQUIERE_AUDITORIA'
     OR (SELECT current_odometer FROM public.vehicles WHERE id = v.id) <> 12000
     OR EXISTS (SELECT 1 FROM public.vehicle_odometer_logs WHERE vehicle_plate = v.plate AND source_event = 'REPORTE_FALLA'
                AND odometer_value = 11000 AND status = 'VALIDADO') THEN
    RAISE EXCEPTION 'CAJA C240 FAIL: el reporte de falla validó una lectura menor (%)', req; END IF;

  -- Mantenimiento: una lectura menor se rechaza; una válida avanza
  r := public.register_asset_reading(v.plate, 11500, NULL, 'C240', NULL);
  IF COALESCE((r->>'success')::boolean, true) THEN RAISE EXCEPTION 'CAJA C240 FAIL: register_asset_reading aceptó un retroceso'; END IF;
  r := public.register_asset_reading(v.plate, 12100, 515, 'C240', NULL);
  IF r->>'status' <> 'VALIDADO' OR (SELECT current_odometer FROM public.vehicles WHERE id = v.id) <> 12100 THEN
    RAISE EXCEPTION 'CAJA C240 FAIL: lectura válida no aplicada (%)', r; END IF;

  -- Sesión de usuario (Administrador): no edita lecturas ni borra ni desactiva directamente
  SELECT p.id INTO actor FROM public.profiles p JOIN auth.users u ON u.id = p.id
  WHERE NOT EXISTS (SELECT 1 FROM public.drivers d WHERE d.profile_id = p.id) ORDER BY p.id LIMIT 1;
  UPDATE public.profiles SET role_id = (SELECT id FROM public.roles WHERE name = 'Administrador' LIMIT 1), is_active = true WHERE id = actor;
  PERFORM set_config('request.jwt.claim.sub', actor::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', actor, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  BEGIN
    UPDATE public.vehicles SET current_hours = current_hours + 1 WHERE id = v.id; ok := true;
  EXCEPTION WHEN insufficient_privilege THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C240 FAIL: la pantalla sobrescribe el horómetro'; END IF;
  BEGIN
    UPDATE public.vehicles SET is_active = false WHERE id = v.id; ok := true;
  EXCEPTION WHEN insufficient_privilege THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C240 FAIL: la pantalla desactiva sin set_vehicle_active'; END IF;
  BEGIN
    DELETE FROM public.vehicles WHERE id = v.id; ok := true;
  EXCEPTION WHEN insufficient_privilege THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C240 FAIL: la pantalla borra unidades'; END IF;
  -- Datos generales sí se editan
  UPDATE public.vehicles SET current_location = 'C240' WHERE id = v.id;
  -- Desactivar y reactivar por la vía autorizada
  r := public.set_vehicle_active(v.plate, false, 'Prueba C240');
  PERFORM set_config('role', 'postgres', true);
  IF NOT COALESCE((r->>'success')::boolean, false) OR (SELECT is_active OR status <> 'FUERA_DE_SERVICIO' FROM public.vehicles WHERE id = v.id) THEN
    RAISE EXCEPTION 'CAJA C240 FAIL: no se desactivó la unidad (%)', r; END IF;
  IF (SELECT current_location FROM public.vehicles WHERE id = v.id) IS DISTINCT FROM 'C240' THEN
    RAISE EXCEPTION 'CAJA C240 FAIL: la pantalla ya no puede editar datos de la unidad'; END IF;
  r := public.set_vehicle_active(v.plate, true, 'Prueba C240');
  IF (SELECT NOT is_active OR status <> 'OBSERVADA' FROM public.vehicles WHERE id = v.id) THEN
    RAISE EXCEPTION 'CAJA C240 FAIL: reactivar debe dejar la unidad OBSERVADA (%)', r; END IF;

  RAISE EXCEPTION 'CAJA C240 PASS: retroceso y salto sin foto en revisión; falla con lectura menor no validada; sin borrar ni editar lecturas desde la pantalla; baja por desactivación';
END $test$;
ROLLBACK;
