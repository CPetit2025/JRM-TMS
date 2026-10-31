-- C182: cierre económico automático (B + C) — flete propio confirmado al cerrar la ruta y rutas sin costo «No aplica».
BEGIN;
DO $$
BEGIN
 IF to_regprocedure('public.economic_auto_close(uuid)') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.dispatches'::regclass AND tgname='dispatch_economic_auto_close' AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'CAJA C182 FAIL: falta el cierre económico automático';
 END IF;
 IF position('''NO_APLICA''' IN pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid='public.economic_closures'::regclass AND conname='economic_closures_status_check')))=0
  OR position('''AUTOMATICO''' IN pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid='public.economic_closure_events'::regclass AND conname='economic_closure_events_action_check')))=0 THEN
  RAISE EXCEPTION 'CAJA C182 FAIL: faltan los estados del cierre automático';
 END IF;
 -- Un flete propio confirmado automáticamente no mueve la partida: lo aplicado es el flete final
 IF EXISTS(SELECT 1 FROM public.dispatch_freight_stages WHERE final_reason LIKE 'Flete de flota propia confirmado%' AND final_applied_pen IS DISTINCT FROM final_pen) THEN
  RAISE EXCEPTION 'CAJA C182 FAIL: flete propio automático con diferencia aplicada';
 END IF;
 IF has_function_privilege('authenticated','public.economic_auto_close(uuid)','EXECUTE')
  OR has_function_privilege('anon','public.economic_auto_close(uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C182 FAIL: cierre automático expuesto a usuarios';
 END IF;
 RAISE EXCEPTION 'CAJA C182 PASS: flete propio automático y rutas sin costo «No aplica» instalados';
END $$;
ROLLBACK;
