-- C222: la salida de un despacho APT exige la liberación del WMS. Usa solicitudes existentes (no crea solicitudes ni
-- despachos): estados informados con la clave, foto vieja que no pisa una nueva, falla cerrada sin latido, excepción con
-- motivo, RECOJO/TRASLADO fuera de alcance, triggers de salida presentes y RPC privadas. Siempre se revierte.
BEGIN;
DO $test$
DECLARE v_key text := 'caja-c222-' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
 v_req uuid; v_other uuid; v_admin uuid; g jsonb; r jsonb; v_err text; v_denied boolean; v_msg text;
BEGIN
 BEGIN
 IF to_regprocedure('public.wms_report_request_status(text,jsonb)') IS NULL OR to_regclass('public.request_wms_status') IS NULL
    OR to_regclass('public.request_wms_release_overrides') IS NULL THEN
   RAISE EXCEPTION 'CAJA C222 FAIL: falta la migración de salida liberada por WMS'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'wms_release_gate_cutover') THEN
   RAISE EXCEPTION 'CAJA C222 FAIL: falta el corte del flujo con WMS'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'wms_release_departure_guard' AND tgrelid = 'public.dispatches'::regclass)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'wms_release_request_guard' AND tgrelid = 'public.transport_requests'::regclass) THEN
   RAISE EXCEPTION 'CAJA C222 FAIL: faltan los bloqueos de salida'; END IF;
 IF has_function_privilege('authenticated', 'public.wms_release_gate(uuid)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.wms_release_status(uuid[],uuid)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.wms_release_override(uuid,text)', 'EXECUTE')
    OR has_table_privilege('authenticated', 'public.request_wms_status', 'INSERT')
    OR has_table_privilege('authenticated', 'public.request_wms_release_overrides', 'INSERT') THEN
   RAISE EXCEPTION 'CAJA C222 FAIL: estados o excepciones expuestos'; END IF;
 UPDATE public.integration_keys SET key_hash = encode(sha256(convert_to(v_key, 'UTF8')), 'hex') WHERE name = 'wms';
 IF NOT FOUND THEN RAISE EXCEPTION 'CAJA C222 FAIL: no existe la clave wms'; END IF;

 v_denied := false;
 BEGIN PERFORM public.wms_report_request_status('clave-incorrecta-clave-incorrecta-123', '[]'); EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
 IF NOT v_denied THEN RAISE EXCEPTION 'CAJA C222 FAIL: el informe acepta una clave incorrecta'; END IF;

 SELECT t.id INTO v_req FROM public.transport_requests t
  WHERE public.wms_release_in_scope(t.request_type, t.contract_id, t.pickup_address) ORDER BY t.created_at DESC LIMIT 1;
 IF v_req IS NOT NULL THEN
   DELETE FROM public.request_wms_release_overrides WHERE transport_request_id = v_req;
   DELETE FROM public.request_wms_status WHERE transport_request_id = v_req;
   -- Sin latido: falla cerrada
   UPDATE public.system_settings SET value = (now() - interval '1 hour')::text WHERE key = 'wms_status_last_report';
   g := public.wms_release_gate(v_req);
   IF NOT (g->>'blocked')::boolean OR g->>'state' <> 'SIN_RESPUESTA' THEN
     RAISE EXCEPTION 'CAJA C222 FAIL: sin respuesta del WMS no bloquea (%)', g; END IF;

   PERFORM public.wms_report_request_status(v_key, jsonb_build_array(jsonb_build_object('transport_request_id', v_req,
     'status', 'EN_PICKING', 'task_code', 'WH-C222', 'snapshot_at', now())));
   g := public.wms_release_gate(v_req);
   IF NOT (g->>'blocked')::boolean OR g->>'label' <> 'En picking' THEN RAISE EXCEPTION 'CAJA C222 FAIL: en picking no bloquea (%)', g; END IF;
   v_msg := NULL;
   BEGIN PERFORM public.wms_release_assert(ARRAY[v_req]); EXCEPTION WHEN raise_exception THEN v_msg := SQLERRM; END;
   IF v_msg IS NULL OR v_msg NOT LIKE '%aún no fue liberada por el almacén%no puede salir%' THEN
     RAISE EXCEPTION 'CAJA C222 FAIL: mensaje de bloqueo inesperado: %', v_msg; END IF;

   PERFORM public.wms_report_request_status(v_key, jsonb_build_array(jsonb_build_object('transport_request_id', v_req,
     'status', 'LIBERADO', 'released_at', now(), 'snapshot_at', now() + interval '1 minute')));
   PERFORM public.wms_report_request_status(v_key, jsonb_build_array(jsonb_build_object('transport_request_id', v_req,
     'status', 'EN_AUDITORIA', 'snapshot_at', now() - interval '1 minute')));
   g := public.wms_release_gate(v_req);
   IF (g->>'blocked')::boolean OR g->>'state' <> 'LIBERADO' THEN RAISE EXCEPTION 'CAJA C222 FAIL: liberada no permite salir o una foto vieja la pisó (%)', g; END IF;
   PERFORM public.wms_release_assert(ARRAY[v_req]);

   -- Liberación deshecha y excepción del supervisor
   PERFORM public.wms_report_request_status(v_key, jsonb_build_array(jsonb_build_object('transport_request_id', v_req,
     'status', 'EN_AUDITORIA', 'snapshot_at', now() + interval '2 minutes')));
   IF NOT (public.wms_release_gate(v_req)->>'blocked')::boolean THEN RAISE EXCEPTION 'CAJA C222 FAIL: deshacer la liberación no bloquea'; END IF;
   SELECT p.id INTO v_admin FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id
    WHERE p.is_active AND ro.name = 'Administrador' AND p.id IN (SELECT id FROM auth.users) ORDER BY p.id LIMIT 1;
   IF v_admin IS NOT NULL THEN
     PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
     PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
     r := public.wms_release_override(v_req, 'corto');
     IF (r->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C222 FAIL: excepción sin motivo suficiente'; END IF;
     r := public.wms_release_override(v_req, 'Emergencia de cliente autorizada por el supervisor');
     IF NOT (r->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C222 FAIL: excepción rechazada: %', r->>'error'; END IF;
     g := public.wms_release_gate(v_req);
     IF (g->>'blocked')::boolean OR g->'override'->>'reason' IS NULL THEN RAISE EXCEPTION 'CAJA C222 FAIL: la excepción no habilita la salida'; END IF;
     r := public.wms_release_status(ARRAY[v_req], NULL);
     IF NOT (r->>'success')::boolean OR jsonb_array_length(r->'items') <> 1 THEN RAISE EXCEPTION 'CAJA C222 FAIL: lectura de estado (%)', r; END IF;
   END IF;
 END IF;

 SELECT t.id INTO v_other FROM public.transport_requests t WHERE upper(t.request_type) IN ('RECOJO', 'TRASLADO') ORDER BY t.created_at DESC LIMIT 1;
 IF v_other IS NOT NULL AND (public.wms_release_gate(v_other)->>'required')::boolean THEN
   RAISE EXCEPTION 'CAJA C222 FAIL: RECOJO/TRASLADO exige liberación del WMS'; END IF;
 EXCEPTION WHEN OTHERS THEN v_err := replace(SQLERRM, 'CAJA C222 FAIL: ', '');
 END;
 IF v_err IS NOT NULL THEN RAISE EXCEPTION 'CAJA C222 FAIL: %', v_err; END IF;
 RAISE EXCEPTION 'CAJA C222 PASS: salida APT bloqueada hasta la liberación del WMS, falla cerrada, fotos ordenadas, excepción con motivo, recojo y traslado sin cambio';
END $test$;
ROLLBACK;
