-- C197: integridad operativa (Operaciones, fase 2) — auxiliares de las rutas programadas en sintonía con la tripulación
-- y «Finalizar ruta» de Monitoreo como una sola operación con permisos acotados.
BEGIN;
DO $$
DECLARE v_missing int; v_stale int;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.dispatch_crew'::regclass AND tgname = 'dispatch_crew_route_auxiliaries_sync' AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'CAJA C197 FAIL: falta la sincronización de auxiliares con la tripulación';
 END IF;
 SELECT count(*) INTO v_missing FROM public.dispatch_crew c JOIN public.dispatches d ON d.id = c.dispatch_id JOIN public.hhee_people hp ON hp.profile_id = c.profile_id
 WHERE d.status = 'PROGRAMADO' AND c.removed_at IS NULL AND c.crew_role = 'AUXILIAR' AND hp.active
   AND NOT EXISTS (SELECT 1 FROM public.route_auxiliaries a JOIN public.hhee_people h2 ON h2.id = a.person_id WHERE a.dispatch_id = c.dispatch_id AND h2.profile_id = c.profile_id);
 SELECT count(*) INTO v_stale FROM public.route_auxiliaries a JOIN public.dispatches d ON d.id = a.dispatch_id JOIN public.hhee_people hp ON hp.id = a.person_id
 WHERE d.status = 'PROGRAMADO' AND hp.profile_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.dispatch_crew c WHERE c.dispatch_id = a.dispatch_id AND c.profile_id = hp.profile_id AND c.removed_at IS NULL AND c.crew_role = 'AUXILIAR');
 IF v_missing > 0 OR v_stale > 0 THEN
  RAISE EXCEPTION 'CAJA C197 FAIL: % auxiliares sin registrar en Personal y % retirados que siguen en la ruta', v_missing, v_stale;
 END IF;
 IF has_function_privilege('anon','public.finish_route_supervised(uuid,text)','EXECUTE')
  OR NOT has_function_privilege('authenticated','public.finish_route_supervised(uuid,text)','EXECUTE')
  OR has_function_privilege('authenticated','public.dispatch_crew_route_auxiliaries_sync()','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C197 FAIL: permisos de Finalizar ruta o de la sincronización';
 END IF;
 RAISE EXCEPTION 'CAJA C197 PASS: auxiliares en sintonía con la tripulación y Finalizar ruta atómico';
END $$;
ROLLBACK;
