-- C202: correcciones de la auditoría de Monitoreo GPS y Registro de Servicios instaladas — flete de ruta mixta como suma
-- de sus OT, ruta ejecutada corregida en Cierre económico, saldo con autorizaciones de Gerencia y novedades de la app
-- restringidas a las del formulario de Monitoreo.
BEGIN;
DO $$
DECLARE d text := pg_get_functiondef('public.update_contract_service_amount(uuid,numeric)'::regprocedure);
BEGIN
 IF position('dispatch_request_freight WHERE dispatch_id = s.dispatch_id' IN d) = 0 OR position('La ruta ya se ejecutó' IN d) = 0
  OR position('budget_authorized_over_cap' IN d) = 0 THEN
  RAISE EXCEPTION 'CAJA C202 FAIL: edición de servicios sin las correcciones de la auditoría';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'register_contract_service' AND p.pronamespace = 'public'::regnamespace
            AND position('balance_pen' IN pg_get_functiondef(p.oid)) > 0 AND position('budget_authorized_over_cap' IN pg_get_functiondef(p.oid)) = 0) THEN
  RAISE EXCEPTION 'CAJA C202 FAIL: cargo manual sin considerar las autorizaciones';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'dispatch_events' AND policyname = 'dispatch_events_client_types'
            AND permissive = 'RESTRICTIVE') THEN
  RAISE EXCEPTION 'CAJA C202 FAIL: la app puede registrar eventos de ruta con efecto';
 END IF;
 IF position('to_jsonb(p)' IN pg_get_functiondef('public.get_driver_connectivity_report(integer)'::regprocedure)) > 0 THEN
  RAISE EXCEPTION 'CAJA C202 FAIL: el diagnóstico de conexión recorre todos los puntos GPS';
 END IF;
 RAISE EXCEPTION 'CAJA C202 PASS: correcciones de la auditoría de Monitoreo y Registro de Servicios instaladas';
END $$;
ROLLBACK;
