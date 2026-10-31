-- C191: detalle del despacho — funciones instaladas, sin acceso anónimo ni directo al contenido interno, y todas las
-- fuentes del historial se leen con el esquema real de producción (ninguna en sources_failed) en paradas recientes.
BEGIN;
DO $$
DECLARE r record; v jsonb; n int := 0;
BEGIN
 IF NOT has_function_privilege('authenticated','public.get_dispatch_detail(uuid,uuid)','EXECUTE')
  OR has_function_privilege('anon','public.get_dispatch_detail(uuid,uuid)','EXECUTE')
  OR has_function_privilege('authenticated','public.dispatch_detail_payload(uuid,uuid,boolean)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C191 FAIL: permisos del detalle del despacho';
 END IF;
 FOR r IN SELECT dr.dispatch_id, dr.transport_request_id FROM public.dispatch_requests dr
   JOIN public.dispatches d ON d.id=dr.dispatch_id ORDER BY d.scheduled_departure DESC NULLS LAST LIMIT 25 LOOP
  v := public.dispatch_detail_payload(r.dispatch_id, r.transport_request_id, true);
  IF jsonb_array_length(v->'sources_failed') > 0 THEN
   RAISE EXCEPTION 'CAJA C191 FAIL: fuentes no legibles en producción: %', v->'sources_failed';
  END IF;
  n := n + 1;
 END LOOP;
 RAISE EXCEPTION 'CAJA C191 PASS: detalle del despacho instalado; % parada(s) recientes leídas sin errores', n;
END $$;
ROLLBACK;
