-- C194: evidencias operativas con etapa y estimado de ruta — tablas sin acceso directo, funciones sin acceso anónimo,
-- políticas del bucket instaladas y piezas nuevas del detalle legibles en paradas recientes de producción.
BEGIN;
DO $$
DECLARE r record; v jsonb; n int := 0;
BEGIN
 IF to_regclass('public.dispatch_evidence') IS NULL OR to_regclass('public.dispatch_route_estimates') IS NULL THEN
  RAISE EXCEPTION 'CAJA C194 FAIL: faltan las tablas de evidencias o estimados';
 END IF;
 IF has_table_privilege('authenticated','public.dispatch_evidence','SELECT') OR has_table_privilege('authenticated','public.dispatch_route_estimates','SELECT') THEN
  RAISE EXCEPTION 'CAJA C194 FAIL: las tablas nuevas no deben leerse directamente';
 END IF;
 IF has_function_privilege('anon','public.register_dispatch_evidence(uuid,uuid,text,text,text,text,bigint,text)','EXECUTE')
  OR has_function_privilege('anon','public.void_dispatch_evidence(uuid,text)','EXECUTE')
  OR has_function_privilege('anon','public.save_dispatch_route_estimates(uuid,jsonb)','EXECUTE')
  OR has_function_privilege('authenticated','public.dispatch_detail_extras(uuid,uuid)','EXECUTE')
  OR NOT has_function_privilege('authenticated','public.register_dispatch_evidence(uuid,uuid,text,text,text,text,bigint,text)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C194 FAIL: permisos de las funciones de evidencias y estimados';
 END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND tablename='objects'
     AND policyname IN ('dispatch_evidence_obj_insert','dispatch_evidence_obj_read','dispatch_evidence_obj_cleanup')) <> 3 THEN
  RAISE EXCEPTION 'CAJA C194 FAIL: faltan las políticas del bucket para evidencias';
 END IF;
 FOR r IN SELECT dr.dispatch_id, dr.transport_request_id FROM public.dispatch_requests dr
   JOIN public.dispatches d ON d.id=dr.dispatch_id ORDER BY d.scheduled_departure DESC NULLS LAST LIMIT 25 LOOP
  v := public.dispatch_detail_extras(r.dispatch_id, r.transport_request_id);
  IF jsonb_array_length(v->'sources_failed') > 0 THEN RAISE EXCEPTION 'CAJA C194 FAIL: fuentes no legibles: %', v->'sources_failed'; END IF;
  n := n + 1;
 END LOOP;
 RAISE EXCEPTION 'CAJA C194 PASS: evidencias con etapa y estimados de ruta instalados; % parada(s) leídas', n;
END $$;
ROLLBACK;
