-- C241: Mantenimiento fase 6. La OT de un plan conserva el vencimiento original (no cambia al reprogramar ni al
-- editar el plan); esperas con motivo, inicio y fin, sin superposición; costos por etapa sin IGV en PEN donde la
-- provisión y la factura no se suman. Usa datos reales y siempre se revierte.
BEGIN;
SET LOCAL statement_timeout = '60s';
DO $test$
DECLARE v record; p record; wo uuid; w record; r jsonb; ok boolean; c uuid; d date;
BEGIN
  -- Vencimiento original: OT abiertas de planes con su vencimiento
  IF EXISTS (SELECT 1 FROM public.maintenance_work_orders wo JOIN public.maintenance_plans pl ON pl.id = wo.plan_id
             WHERE wo.status NOT IN ('CERRADA', 'CANCELADA') AND COALESCE(pl.next_due_date::text, pl.next_due_km::text, pl.frequency_hours::text) IS NOT NULL
               AND wo.due_date IS NULL AND wo.due_km IS NULL AND wo.due_hours IS NULL) THEN
    RAISE EXCEPTION 'CAJA C241 FAIL: OT abiertas de planes sin vencimiento original'; END IF;

  SELECT pl.* INTO p FROM public.maintenance_plans pl JOIN public.vehicles x ON x.plate = pl.vehicle_plate
  WHERE pl.is_active AND pl.frequency_days IS NOT NULL AND COALESCE(pl.last_performed_km, 0) <= COALESCE(x.current_odometer, 0)
    AND (pl.frequency_hours IS NULL OR COALESCE(pl.last_performed_hours, 0) <= COALESCE(x.current_hours, 0))
  ORDER BY pl.id LIMIT 1;
  IF p.id IS NOT NULL THEN
    UPDATE public.maintenance_work_orders SET status = 'CANCELADA', cancel_reason = 'C241' WHERE plan_id = p.id AND status NOT IN ('CERRADA', 'CANCELADA');
    wo := public.generate_preventive_wo(p.id);
    SELECT due_date INTO d FROM public.maintenance_work_orders WHERE id = wo;
    IF d IS DISTINCT FROM (SELECT next_due_date FROM public.maintenance_plans WHERE id = p.id) THEN
      RAISE EXCEPTION 'CAJA C241 FAIL: la OT no guardó el vencimiento del plan'; END IF;
    UPDATE public.maintenance_work_orders SET start_date = start_date + 7, due_date = due_date + 30 WHERE id = wo;
    UPDATE public.maintenance_plans SET last_performed_date = last_performed_date - 1 WHERE id = p.id;
    IF (SELECT due_date FROM public.maintenance_work_orders WHERE id = wo) IS DISTINCT FROM d THEN
      RAISE EXCEPTION 'CAJA C241 FAIL: reprogramar o editar el plan cambió el vencimiento original'; END IF;
  END IF;

  -- Esperas
  SELECT * INTO v FROM public.vehicles WHERE is_active ORDER BY plate LIMIT 1;
  INSERT INTO public.maintenance_work_orders (ot_code, vehicle_id, vehicle_plate, description, order_type, status, site_id)
  VALUES ('C241-' || left(gen_random_uuid()::text, 8), v.id, v.plate, 'Prueba C241', 'CORRECTIVA', 'EN_PROCESO', v.site_id) RETURNING id INTO wo;
  r := public.work_order_wait_start(wo, 'OTRO', NULL);
  IF COALESCE((r->>'success')::boolean, true) THEN RAISE EXCEPTION 'CAJA C241 FAIL: motivo de espera libre aceptado'; END IF;
  r := public.work_order_wait_start(wo, 'VERIFICACION', NULL);
  IF COALESCE((r->>'success')::boolean, true) THEN RAISE EXCEPTION 'CAJA C241 FAIL: espera de verificación abierta a mano'; END IF;
  -- La lectura de ejecución y el cumplimiento no se escriben directo desde una sesión (guarda del invocador)
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.work_order_execution_guard()'::regprocedure)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_work_order_execution_guard') THEN
    RAISE EXCEPTION 'CAJA C241 FAIL: la lectura de ejecución se puede sobrescribir desde la pantalla'; END IF;
  r := public.transition_work_order(wo, 'EN_ESPERA', 'sin motivo');
  IF COALESCE((r->>'success')::boolean, true) THEN RAISE EXCEPTION 'CAJA C241 FAIL: espera sin motivo aceptada'; END IF;
  r := public.work_order_wait_start(wo, 'REPUESTO', 'Filtro');
  IF NOT COALESCE((r->>'success')::boolean, false) OR (SELECT status FROM public.maintenance_work_orders WHERE id = wo) <> 'EN_ESPERA' THEN
    RAISE EXCEPTION 'CAJA C241 FAIL: la espera no pasó la OT a EN_ESPERA (%)', r; END IF;
  r := public.work_order_wait_start(wo, 'TALLER', NULL);
  IF COALESCE((r->>'success')::boolean, true) THEN RAISE EXCEPTION 'CAJA C241 FAIL: dos esperas abiertas a la vez'; END IF;
  BEGIN
    INSERT INTO public.maintenance_work_order_waits (work_order_id, reason, started_at, ended_at)
    VALUES (wo, 'TALLER', now() - interval '1 hour', now() + interval '1 hour'); ok := true;
  EXCEPTION WHEN exclusion_violation OR unique_violation THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C241 FAIL: esperas superpuestas aceptadas'; END IF;
  r := public.work_order_wait_end(wo, NULL);
  SELECT * INTO w FROM public.maintenance_work_order_waits WHERE work_order_id = wo;
  IF NOT COALESCE((r->>'success')::boolean, false) OR w.ended_at IS NULL OR w.reason <> 'REPUESTO'
     OR (SELECT status FROM public.maintenance_work_orders WHERE id = wo) <> 'EN_PROCESO' THEN
    RAISE EXCEPTION 'CAJA C241 FAIL: cerrar la espera no reanudó la OT (%)', r; END IF;

  -- Costos por etapa: estimado y cotizado no son costo; la factura reemplaza a la provisión
  INSERT INTO public.work_order_costs (work_order_id, cost_type, amount, estimated_amount, description)
  VALUES (wo, 'SERVICIOS', 0, 100, 'C241') RETURNING id INTO c;
  IF (SELECT stage <> 'ESTIMADO' OR amount <> 0 FROM public.work_order_costs WHERE id = c) THEN RAISE EXCEPTION 'CAJA C241 FAIL: el estimado cuenta como costo'; END IF;
  UPDATE public.work_order_costs SET quoted_amount = 120 WHERE id = c;
  UPDATE public.work_order_costs SET authorized_amount = 110 WHERE id = c;
  IF (SELECT stage <> 'AUTORIZADO' OR amount <> 110 FROM public.work_order_costs WHERE id = c) THEN RAISE EXCEPTION 'CAJA C241 FAIL: la provisión autorizada no es el costo'; END IF;
  UPDATE public.work_order_costs SET invoiced_amount = 105, igv_amount = 18.9 WHERE id = c;
  UPDATE public.work_order_costs SET paid_amount = 105 WHERE id = c;
  IF (SELECT stage <> 'PAGADO' OR amount <> 105 FROM public.work_order_costs WHERE id = c) THEN RAISE EXCEPTION 'CAJA C241 FAIL: provisión y factura sumadas o con IGV'; END IF;
  INSERT INTO public.work_order_costs (work_order_id, cost_type, amount, description) VALUES (wo, 'MANO_OBRA', 50, 'C241');
  IF (SELECT total_cost FROM public.maintenance_work_orders WHERE id = wo) <> 155 THEN
    RAISE EXCEPTION 'CAJA C241 FAIL: total de la OT % (esperado 155)', (SELECT total_cost FROM public.maintenance_work_orders WHERE id = wo); END IF;
  BEGIN
    INSERT INTO public.work_order_costs (work_order_id, cost_type, amount, invoiced_amount, currency) VALUES (wo, 'SERVICIOS', 0, 10, 'USD'); ok := true;
  EXCEPTION WHEN invalid_parameter_value THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C241 FAIL: costo en dólares sin tipo de cambio'; END IF;
  BEGIN
    UPDATE public.work_order_costs SET paid_amount = 500 WHERE id = c; ok := true;
  EXCEPTION WHEN invalid_parameter_value THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C241 FAIL: pagado mayor que facturado'; END IF;

  RAISE EXCEPTION 'CAJA C241 PASS: vencimiento original inmutable; esperas con motivo sin superposición; costos por etapa sin doble conteo';
END $test$;
ROLLBACK;
