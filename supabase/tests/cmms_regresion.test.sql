-- Regresión CMMS: plan preventivo → OT → cierre → motor de elegibilidad → vistas.
-- Siempre termina en error para forzar ROLLBACK: "REG PASS" o "REG FAIL: ...".
BEGIN;

DO $test$
DECLARE
  v_admin uuid; v_plate text; v_plan uuid; v_wo uuid; v_req uuid; v_wo2 uuid; r jsonb; w record;
BEGIN
  FOR v_admin IN SELECT id FROM public.profiles LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXIT WHEN public.has_tms_permission('admin');
  END LOOP;

  SELECT plate INTO v_plate FROM public.vehicles ORDER BY plate LIMIT 1;

  -- Plan preventivo → OT borrador con identidad sincronizada
  INSERT INTO public.maintenance_plans(name, activity_description, vehicle_type, vehicle_plate, frequency_km, frequency_days, is_active, last_performed_km, last_performed_date)
  VALUES ('REG', 'regresion', 'CAMION', v_plate, 5000, 90, true, 0, CURRENT_DATE) RETURNING id INTO v_plan;
  v_wo := public.generate_preventive_wo(v_plan);
  SELECT ot_code, ot_number, vehicle_id, vehicle_plate, status INTO w FROM public.maintenance_work_orders WHERE id = v_wo;
  IF w.ot_code IS NULL OR w.ot_code <> w.ot_number OR w.vehicle_id IS NULL OR w.vehicle_plate <> v_plate THEN
    RAISE EXCEPTION 'REG FAIL: OT sin identidad sincronizada %', row_to_json(w);
  END IF;

  -- La OT abierta debe bloquear
  IF public.check_asset_eligibility(v_plate)->>'status' <> 'NO_APTO' THEN
    RAISE EXCEPTION 'REG FAIL: OT abierta no bloquea';
  END IF;

  -- Flujo de OT (F4): aprobar → iniciar → terminar → cerrar
  PERFORM public.transition_work_order(v_wo, 'APROBADA');
  PERFORM public.transition_work_order(v_wo, 'EN_PROCESO');
  PERFORM public.transition_work_order(v_wo, 'TERMINADA', 'regresion');
  r := public.complete_maintenance_order(v_wo, '[]'::jsonb, 'regresion');
  IF NOT COALESCE((r->>'success')::boolean, false) THEN RAISE EXCEPTION 'REG FAIL: cierre OT %', r; END IF;
  IF (SELECT last_performed_date FROM public.maintenance_plans WHERE id = v_plan) IS NULL THEN
    RAISE EXCEPTION 'REG FAIL: el plan no registró la ejecución';
  END IF;

  -- Falla → OT (backlog)
  INSERT INTO public.maintenance_requests (vehicle_plate, description, severity, status)
  VALUES (v_plate, 'regresion backlog', 'MEDIA', 'REPORTADA') RETURNING id INTO v_req;
  v_wo2 := public.convert_request_to_wo(v_req, v_admin);
  IF v_wo2 IS NULL OR (SELECT status FROM public.maintenance_requests WHERE id = v_req) <> 'CONVERTIDA_OT' THEN
    RAISE EXCEPTION 'REG FAIL: conversión falla → OT';
  END IF;

  -- Vistas
  PERFORM * FROM public.vw_maintenance_projections;
  PERFORM * FROM public.vw_asset_tco;
  PERFORM * FROM public.vw_document_alerts;
  PERFORM * FROM public.driver_performance_analytics;

  RAISE EXCEPTION 'REG PASS (cierre: %)', r->>'message';
END
$test$;

ROLLBACK;
