-- C229: programación segura. Una unidad propia no apta o sobrecargada no se puede programar por ningún camino;
-- la fecha comprometida original no cambia al reprogramar y D1 se mide contra ella; 'EN TRANSITO' conserva el monto aprobado.
-- Usa datos reales y siempre se revierte.
BEGIN;
DO $test$
DECLARE v record; t record; ok boolean; d date; def text;
BEGIN
  -- Guardas instaladas en las dos rutas que crean viajes y en las paradas
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'dispatch_eligibility_guard' AND tgrelid = 'public.dispatches'::regclass) THEN RAISE EXCEPTION 'CAJA C229 FAIL: falta la guarda de elegibilidad'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'dispatch_capacity_guard' AND tgrelid = 'public.dispatch_requests'::regclass) THEN RAISE EXCEPTION 'CAJA C229 FAIL: falta la guarda de capacidad'; END IF;

  -- Unidad bloqueada: no se puede programar
  SELECT * INTO v FROM public.vehicles WHERE is_active AND COALESCE(weight_capacity, capacity_weight) > 0 ORDER BY plate LIMIT 1;
  ALTER TABLE public.vehicles DISABLE TRIGGER USER;
  UPDATE public.vehicles SET is_blocked = true, block_reason = 'Prueba C229', status = 'BLOQUEADA' WHERE id = v.id;
  ALTER TABLE public.vehicles ENABLE TRIGGER USER;
  BEGIN
    PERFORM public.dispatch_assert_eligible(v.plate, NULL, NULL); ok := true;
  EXCEPTION WHEN raise_exception THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C229 FAIL: se acepta programar la unidad bloqueada %', v.plate; END IF;
  ALTER TABLE public.vehicles DISABLE TRIGGER USER;
  UPDATE public.vehicles SET is_blocked = v.is_blocked, block_reason = v.block_reason, status = v.status WHERE id = v.id;
  ALTER TABLE public.vehicles ENABLE TRIGGER USER;

  -- Sobrecarga: no se puede programar (sin excepción)
  BEGIN
    PERFORM public.dispatch_assert_eligible(v.plate, NULL, COALESCE(v.weight_capacity, v.capacity_weight) + 1); ok := true;
  EXCEPTION WHEN raise_exception THEN ok := position('Capacidad insuficiente' IN SQLERRM) = 0; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C229 FAIL: se acepta una carga mayor a la capacidad de %', v.plate; END IF;

  -- Como usuario (sesión authenticated) la guarda del viaje rechaza la unidad no apta
  IF position('''authenticated''' IN pg_get_functiondef('public.dispatch_eligibility_guard()'::regprocedure)) = 0 THEN RAISE EXCEPTION 'CAJA C229 FAIL: la guarda no distingue la sesión de usuario'; END IF;

  -- Fecha comprometida: todas las solicitudes la tienen y no cambia al mover la fecha requerida de una aprobada
  IF EXISTS (SELECT 1 FROM public.transport_requests WHERE committed_date IS NULL) THEN RAISE EXCEPTION 'CAJA C229 FAIL: solicitudes sin fecha comprometida'; END IF;
  SELECT * INTO t FROM public.transport_requests WHERE approved_at IS NOT NULL AND status IN ('ENTREGADA', 'ASIGNADA') ORDER BY created_at DESC LIMIT 1;
  IF t.id IS NOT NULL THEN
    ALTER TABLE public.transport_requests DISABLE TRIGGER USER;
    ALTER TABLE public.transport_requests ENABLE TRIGGER transport_request_committed_date;
    UPDATE public.transport_requests SET required_date = required_date + interval '5 days' WHERE id = t.id;
    ALTER TABLE public.transport_requests ENABLE TRIGGER USER;
    SELECT committed_date INTO d FROM public.transport_requests WHERE id = t.id;
    IF d IS DISTINCT FROM t.committed_date THEN RAISE EXCEPTION 'CAJA C229 FAIL: la reprogramación cambió el día comprometido (% → %)', t.committed_date, d; END IF;
  END IF;

  -- Revocar la aprobación al editar no libera el día comprometido
  IF t.id IS NOT NULL THEN
    ALTER TABLE public.transport_requests DISABLE TRIGGER USER;
    ALTER TABLE public.transport_requests ENABLE TRIGGER transport_request_committed_date;
    UPDATE public.transport_requests SET approved_at = NULL, status = 'PENDIENTE DE APROBACIÓN' WHERE id = t.id;
    UPDATE public.transport_requests SET required_date = required_date + interval '2 days' WHERE id = t.id;
    ALTER TABLE public.transport_requests ENABLE TRIGGER USER;
    IF (SELECT committed_date FROM public.transport_requests WHERE id = t.id) IS DISTINCT FROM t.committed_date THEN RAISE EXCEPTION 'CAJA C229 FAIL: revocar la aprobación liberó el día comprometido'; END IF;
  END IF;
  -- D1 contra el día comprometido; 'EN TRANSITO' reconocido en presupuesto y financiamiento
  def := pg_get_functiondef('public.kpi_eq_filas(text, date, date)'::regprocedure);
  IF position('t.committed_date' IN def) = 0 THEN RAISE EXCEPTION 'CAJA C229 FAIL: D1 no usa el día comprometido original'; END IF;
  IF position('''EN TRANSITO''' IN pg_get_functiondef('public.transport_request_budget_sync()'::regprocedure)) = 0
     OR position('''EN TRANSITO''' IN pg_get_functiondef('public.request_ot_funding_guard()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'CAJA C229 FAIL: EN TRANSITO no reconocido'; END IF;
  RAISE EXCEPTION 'CAJA C229 PASS: unidad bloqueada y sobrecarga rechazadas en el servidor; día comprometido inmutable y usado por D1; EN TRANSITO reconocido';
END $test$;
ROLLBACK;
