-- C176: rediseño del cierre económico (A + B) — umbral de desviación de fila única y solo lectura, notas internas y
-- servicios agregados en el cierre (origen CIERRE) en el historial, funciones internas sin acceso directo.
BEGIN;
DO $$
BEGIN
 IF to_regclass('public.economic_settings') IS NULL OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.economic_settings'::regclass)
  OR (SELECT count(*) FROM public.economic_settings)<>1 THEN
  RAISE EXCEPTION 'CAJA C176 FAIL: umbral de desviación sin fila única o sin RLS';
 END IF;
 IF NOT (public.economic_settings_get() ? 'deviation_pct') OR NOT (public.economic_settings_get() ? 'deviation_pen') THEN
  RAISE EXCEPTION 'CAJA C176 FAIL: umbral de desviación no expuesto';
 END IF;
 IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname='transport_unloading_costs_origin_check')) NOT LIKE '%CIERRE%'
  OR pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname='economic_closure_events_action_check')) NOT LIKE '%NOTA%'
  OR pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname='economic_closure_events_action_check')) NOT LIKE '%AGREGAR%' THEN
  RAISE EXCEPTION 'CAJA C176 FAIL: origen CIERRE o acciones NOTA/AGREGAR no permitidas';
 END IF;
 IF EXISTS(SELECT 1 FROM public.transport_unloading_costs WHERE origin='CIERRE' AND (final_pen IS NULL OR COALESCE(planned_pen,0)<>0 OR length(COALESCE(final_reason,''))<5)) THEN
  RAISE EXCEPTION 'CAJA C176 FAIL: servicio agregado en el cierre sin final, con acordado o sin motivo';
 END IF;
 IF has_table_privilege('authenticated','public.economic_settings','UPDATE') OR has_table_privilege('authenticated','public.economic_settings','SELECT')
  OR has_function_privilege('authenticated','public.economic_route_items(uuid)','EXECUTE')
  OR has_function_privilege('authenticated','public.economic_user_name(uuid)','EXECUTE')
  OR has_function_privilege('anon','public.economic_add_service(uuid,jsonb)','EXECUTE')
  OR has_function_privilege('anon','public.economic_closure_note(uuid,text)','EXECUTE')
  OR NOT has_function_privilege('authenticated','public.economic_add_service(uuid,jsonb)','EXECUTE')
  OR NOT has_function_privilege('authenticated','public.economic_settings_get()','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C176 FAIL: permisos del cierre económico';
 END IF;
 RAISE EXCEPTION 'CAJA C176 PASS: bandeja, umbral de desviación, notas internas y servicios agregados en el cierre protegidos';
END $$;
ROLLBACK;
