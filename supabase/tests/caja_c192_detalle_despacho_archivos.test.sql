-- C192: detalle del despacho · documentos y evidencias — función instalada, sin acceso anónimo ni directo al
-- contenido interno, y todas sus fuentes legibles con el esquema real de producción en paradas recientes.
BEGIN;
DO $$
DECLARE r record; v jsonb; n int := 0;
BEGIN
 IF NOT has_function_privilege('authenticated','public.get_dispatch_detail_files(uuid,uuid)','EXECUTE')
  OR has_function_privilege('anon','public.get_dispatch_detail_files(uuid,uuid)','EXECUTE')
  OR has_function_privilege('authenticated','public.dispatch_detail_files_payload(uuid,uuid,boolean)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C192 FAIL: permisos de documentos y evidencias del detalle';
 END IF;
 FOR r IN SELECT dr.dispatch_id, dr.transport_request_id FROM public.dispatch_requests dr
   JOIN public.dispatches d ON d.id=dr.dispatch_id ORDER BY d.scheduled_departure DESC NULLS LAST LIMIT 25 LOOP
  v := public.dispatch_detail_files_payload(r.dispatch_id, r.transport_request_id, true);
  IF jsonb_array_length(v->'sources_failed') > 0 THEN
   RAISE EXCEPTION 'CAJA C192 FAIL: fuentes no legibles en producción: %', v->'sources_failed';
  END IF;
  n := n + 1;
 END LOOP;
 RAISE EXCEPTION 'CAJA C192 PASS: documentos y evidencias del detalle instalados; % parada(s) recientes leídas sin errores', n;
END $$;
ROLLBACK;
