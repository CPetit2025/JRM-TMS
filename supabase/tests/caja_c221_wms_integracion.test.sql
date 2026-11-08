-- C221: integración TMS -> WMS. Sin la clave correcta no se lee ni se escribe; el feed solo trae despachos con OT en
-- estado preparable (y el estado actual de las solicitudes que el WMS ya conoce); el reporte de Packing List es
-- idempotente. Usa una solicitud existente (no crea solicitudes). Siempre se revierte.
BEGIN;
DO $test$
DECLARE v_key text := 'caja-c221-' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
 v_feed jsonb; v_req uuid; v_pl uuid := gen_random_uuid(); v_err text; v_denied boolean;
BEGIN
 BEGIN
 IF to_regprocedure('public.wms_feed_solicitudes(text,uuid[])') IS NULL OR to_regclass('public.wms_packing_releases') IS NULL THEN
   RAISE EXCEPTION 'CAJA C221 FAIL: falta la migración de integración WMS'; END IF;
 IF has_table_privilege('anon', 'public.integration_keys', 'SELECT') OR has_table_privilege('authenticated', 'public.integration_keys', 'SELECT')
   OR has_table_privilege('authenticated', 'public.wms_packing_releases', 'INSERT')
   OR has_function_privilege('anon', 'public.integration_key_ok(text,text)', 'EXECUTE') THEN
   RAISE EXCEPTION 'CAJA C221 FAIL: claves o releases expuestos'; END IF;
 UPDATE public.integration_keys SET key_hash = encode(sha256(convert_to(v_key, 'UTF8')), 'hex') WHERE name = 'wms';
 IF NOT FOUND THEN RAISE EXCEPTION 'CAJA C221 FAIL: no existe la clave wms'; END IF;

 v_denied := false;
 BEGIN PERFORM public.wms_feed_solicitudes('clave-incorrecta-clave-incorrecta-123', '{}'); EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
 IF NOT v_denied THEN RAISE EXCEPTION 'CAJA C221 FAIL: el feed acepta una clave incorrecta'; END IF;

 v_feed := public.wms_feed_solicitudes(v_key, '{}');
 IF jsonb_typeof(v_feed) <> 'array' THEN RAISE EXCEPTION 'CAJA C221 FAIL: el feed no devuelve una lista'; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_feed) e
            WHERE e->>'request_type' <> 'DESPACHO' OR e->'contract'->>'id' IS NULL
               OR upper(e->>'status') IN ('CANCELADA', 'RECHAZADA', 'ENTREGADA', 'FINALIZADA')) THEN
   RAISE EXCEPTION 'CAJA C221 FAIL: el feed incluye solicitudes no preparables'; END IF;

 SELECT r.id INTO v_req FROM public.transport_requests r WHERE r.contract_id IS NOT NULL
   AND upper(r.status) IN ('CANCELADA', 'RECHAZADA', 'ENTREGADA') ORDER BY r.created_at DESC LIMIT 1;
 IF v_req IS NOT NULL THEN
   v_feed := public.wms_feed_solicitudes(v_key, ARRAY[v_req]);
   IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_feed) e WHERE (e->>'id')::uuid = v_req) THEN
     RAISE EXCEPTION 'CAJA C221 FAIL: el feed no informa el estado final de una solicitud conocida'; END IF;
 END IF;

 SELECT id INTO v_req FROM public.transport_requests ORDER BY created_at DESC LIMIT 1;
 IF v_req IS NOT NULL THEN
   PERFORM public.wms_report_packing_list(v_key, jsonb_build_object('id', v_pl, 'transport_request_id', v_req,
     'packing_list_number', 'PL-C221', 'version', 1, 'status', 'LIBERADO', 'released_at', now(), 'lpn_count', 2));
   PERFORM public.wms_report_packing_list(v_key, jsonb_build_object('id', v_pl, 'transport_request_id', v_req,
     'packing_list_number', 'PL-C221', 'version', 1, 'status', 'REEMPLAZADO', 'released_at', now()));
   IF (SELECT count(*) FROM public.wms_packing_releases WHERE wms_packing_list_id = v_pl) <> 1
      OR (SELECT status FROM public.wms_packing_releases WHERE wms_packing_list_id = v_pl) <> 'REEMPLAZADO' THEN
     RAISE EXCEPTION 'CAJA C221 FAIL: el reporte duplica o no actualiza el Packing List'; END IF;
   v_denied := false;
   BEGIN PERFORM public.wms_report_packing_list('clave-incorrecta-clave-incorrecta-123', jsonb_build_object('id', gen_random_uuid()));
   EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
   IF NOT v_denied THEN RAISE EXCEPTION 'CAJA C221 FAIL: el reporte acepta una clave incorrecta'; END IF;
 END IF;
 EXCEPTION WHEN OTHERS THEN v_err := replace(SQLERRM, 'CAJA C221 FAIL: ', '');
 END;
 IF v_err IS NOT NULL THEN RAISE EXCEPTION 'CAJA C221 FAIL: %', v_err; END IF;
 RAISE EXCEPTION 'CAJA C221 PASS: feed WMS con clave, solo despachos preparables, estado de solicitudes conocidas y reporte idempotente';
END $test$;
ROLLBACK;
