-- C189: correcciones de la auditoría de Comercial y Operaciones (F01, F02, F03) instaladas. Informa además cuántas rutas
-- propias cerradas manualmente sin salir quedaron con el flete confirmado automáticamente antes de la corrección (para revisar).
BEGIN;
DO $$
DECLARE v_prev int;
BEGIN
 IF position('Cierre económico (observar o reabrir)' IN pg_get_functiondef('public.update_contract_service_amount(uuid,numeric)'::regprocedure)) = 0 THEN
  RAISE EXCEPTION 'CAJA C189 FAIL: Registro de Servicios puede editar importes con cierre económico aprobado';
 END IF;
 IF position('CIERRE_OPERATIVO_MANUAL' IN pg_get_functiondef('public.economic_auto_close(uuid)'::regprocedure)) = 0
  OR position('OLD.status = ''PROGRAMADO''' IN pg_get_functiondef('public.dispatch_economic_auto_close()'::regprocedure)) = 0 THEN
  RAISE EXCEPTION 'CAJA C189 FAIL: el cierre manual de una ruta no ejecutada confirma el flete';
 END IF;
 IF position('cierre-economico' IN pg_get_functiondef('public.dispatch_freight_summary(uuid)'::regprocedure)) = 0 THEN
  RAISE EXCEPTION 'CAJA C189 FAIL: Cierre económico no lee el flete';
 END IF;
 SELECT count(DISTINCT s.dispatch_id) INTO v_prev
 FROM public.dispatch_freight_stages s
 JOIN public.dispatch_events e ON e.dispatch_id = s.dispatch_id AND e.event_type = 'CIERRE_OPERATIVO_MANUAL'
  AND to_jsonb(e)->'payload'->>'previous_status' = 'PROGRAMADO'
 WHERE to_jsonb(s)->>'econ_status' = 'APROBADO' AND s.final_reason LIKE 'Flete de flota propia confirmado automáticamente%';
 RAISE EXCEPTION 'CAJA C189 PASS: correcciones F01-F03 instaladas · rutas no ejecutadas con flete propio confirmado antes de la corrección: %', v_prev;
END $$;
ROLLBACK;
