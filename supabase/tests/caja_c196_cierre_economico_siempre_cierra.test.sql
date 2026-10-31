-- C196: el cierre económico siempre puede cerrarse — ninguna ruta liberada queda «No aplica» con costos ni «Cerrada» con
-- ítems sin aprobar (un costo nuevo la devuelve a la bandeja), con los disparadores diferidos y permisos instalados.
BEGIN;
DO $$
DECLARE v_na int; v_closed int;
BEGIN
 IF (SELECT count(*) FROM pg_trigger WHERE tgname = 'economic_route_resync' AND NOT tgisinternal AND tgdeferrable AND tginitdeferred
     AND tgrelid IN ('public.transport_unloading_costs'::regclass, 'public.dispatch_freight_stages'::regclass, 'public.dispatch_request_freight_stages'::regclass)) <> 3 THEN
  RAISE EXCEPTION 'CAJA C196 FAIL: falta la reapertura diferida por costo nuevo';
 END IF;
 SELECT count(*) INTO v_na FROM public.economic_closures c JOIN public.dispatches d ON d.id = c.dispatch_id
 WHERE c.status = 'NO_APLICA' AND d.status IN ('RETORNO_COMPLETADO','CIERRE_OPERATIVO','LIQUIDADO','CERRADO')
   AND jsonb_array_length(public.economic_route_items(c.dispatch_id)) > 0;
 SELECT count(*) INTO v_closed FROM public.economic_closures c JOIN public.dispatches d ON d.id = c.dispatch_id
 WHERE c.status = 'CERRADO' AND d.status IN ('RETORNO_COMPLETADO','CIERRE_OPERATIVO','LIQUIDADO','CERRADO')
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(public.economic_route_items(c.dispatch_id)) i WHERE i->>'status' <> 'APROBADO');
 IF v_na > 0 OR v_closed > 0 THEN
  RAISE EXCEPTION 'CAJA C196 FAIL: % rutas «No aplica» con costos y % «Cerradas» con ítems sin aprobar', v_na, v_closed;
 END IF;
 IF NOT (public.economic_settings_get() ? 'max_pending_days')
  OR has_function_privilege('authenticated','public.economic_route_resync(uuid)','EXECUTE')
  OR has_function_privilege('anon','public.economic_add_service(uuid,jsonb)','EXECUTE')
  OR NOT has_function_privilege('authenticated','public.economic_add_service(uuid,jsonb)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C196 FAIL: umbral de días o permisos del cierre';
 END IF;
 RAISE EXCEPTION 'CAJA C196 PASS: ninguna ruta liberada queda fuera del cierre económico con costos sin aprobar';
END $$;
ROLLBACK;
