-- C230: ningún viaje cerrado deja solicitudes sin resolver. Las pendientes entran a la bandeja, solo el Supervisor de
-- Transporte las resuelve con motivo y la resolución cambia la solicitud. Usa datos reales y siempre se revierte.
BEGIN;
DO $test$
DECLARE n_bandeja int; n_fuente int; sup uuid; otro uuid; v record; ok boolean; st text;
BEGIN
  -- La bandeja contiene exactamente las solicitudes no resueltas de viajes cerrados (consulta escrita aparte)
  SELECT count(*) INTO n_fuente FROM public.dispatch_requests r JOIN public.dispatches d ON d.id = r.dispatch_id JOIN public.transport_requests t ON t.id = r.transport_request_id
  WHERE d.status = 'CIERRE_OPERATIVO' AND upper(coalesce(t.status, '')) NOT IN ('ENTREGADA', 'CANCELADA', 'RECHAZADA', 'REPROGRAMADA');
  SELECT count(*) INTO n_bandeja FROM public.transport_request_reviews WHERE status = 'PENDIENTE';
  IF n_fuente <> n_bandeja THEN RAISE EXCEPTION 'CAJA C230 FAIL: % pendientes en la fuente frente a % en la bandeja', n_fuente, n_bandeja; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'dispatch_close_enqueue_reviews') THEN RAISE EXCEPTION 'CAJA C230 FAIL: el cierre no pasa pendientes a la bandeja'; END IF;

  SELECT * INTO v FROM public.transport_request_reviews WHERE status = 'PENDIENTE' ORDER BY id LIMIT 1;
  IF v.id IS NULL THEN RAISE EXCEPTION 'CAJA C230 PASS: sin pendientes; bandeja conciliada con la fuente'; END IF;
  SELECT p.id INTO sup FROM public.profiles p JOIN public.roles r ON r.id = p.role_id WHERE p.is_active AND r.name = 'Supervisor de Transporte' ORDER BY p.id LIMIT 1;
  SELECT p.id INTO otro FROM public.profiles p JOIN public.roles r ON r.id = p.role_id WHERE p.is_active AND r.name = 'Conductor' ORDER BY p.id LIMIT 1;

  -- Otro rol no resuelve
  PERFORM set_config('request.jwt.claim.sub', otro::text, true); PERFORM set_config('request.jwt.claims', json_build_object('sub', otro, 'role', 'authenticated')::text, true);
  BEGIN PERFORM public.transport_request_review_resolve(v.id, 'ENTREGADA', 'Entregado según llamada al cliente'); ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C230 FAIL: un conductor resolvió la revisión'; END IF;

  -- El Supervisor de Transporte: sin motivo no; con motivo la solicitud queda entregada
  PERFORM set_config('request.jwt.claim.sub', sup::text, true); PERFORM set_config('request.jwt.claims', json_build_object('sub', sup, 'role', 'authenticated')::text, true);
  BEGIN PERFORM public.transport_request_review_resolve(v.id, 'ENTREGADA', 'ok'); ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C230 FAIL: se resolvió sin motivo'; END IF;
  -- Sin guía validada no se da por entregada (ninguna de las pendientes la tiene)
  BEGIN PERFORM public.transport_request_review_resolve(v.id, 'ENTREGADA', 'Entregado según llamada al cliente'); ok := true;
  EXCEPTION WHEN OTHERS THEN ok := position('valide primero la guía' IN SQLERRM) = 0; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C230 FAIL: se dio por entregada sin guía validada'; END IF;
  PERFORM public.transport_request_review_resolve(v.id, 'ANULADA', 'El cliente ya no requiere el servicio');
  SELECT status INTO st FROM public.transport_requests WHERE id = v.request_id;
  IF st <> 'CANCELADA' THEN RAISE EXCEPTION 'CAJA C230 FAIL: anular dejó la solicitud en %', st; END IF;
  IF (SELECT status FROM public.transport_request_reviews WHERE id = v.id) <> 'RESUELTA' THEN RAISE EXCEPTION 'CAJA C230 FAIL: la revisión no quedó resuelta'; END IF;
  BEGIN PERFORM public.transport_request_review_resolve(v.id, 'ANULADA', 'Intento de resolver dos veces'); ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C230 FAIL: se resolvió dos veces'; END IF;

  -- Reprogramar otra pendiente: vuelve a programarse y el día comprometido original no cambia
  SELECT * INTO v FROM public.transport_request_reviews WHERE status = 'PENDIENTE' ORDER BY id LIMIT 1;
  IF v.id IS NOT NULL THEN
    PERFORM public.transport_request_review_resolve(v.id, 'REPROGRAMADA', 'Cliente sin personal para recibir', (date_trunc('day', now() AT TIME ZONE 'America/Lima') + interval '3 days 20 hours') AT TIME ZONE 'America/Lima', 'CLIENTE');
    IF (SELECT status FROM public.transport_requests WHERE id = v.request_id) <> 'REPROGRAMADA' THEN RAISE EXCEPTION 'CAJA C230 FAIL: reprogramar no cambió el estado'; END IF;
  END IF;
  RAISE EXCEPTION 'CAJA C230 PASS: % pendientes conciliados con la fuente; solo el Supervisor de Transporte resuelve, con motivo y una sola vez', n_bandeja;
END $test$;
ROLLBACK;
