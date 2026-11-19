-- C227: modo de salida sin liberación del WMS configurable (BLOQUEAR / ALERTAR) con historial. Usa una solicitud existente
-- en alcance (no crea solicitudes ni despachos): en BLOQUEAR la salida se rechaza; en ALERTAR pasa y queda una alerta (una
-- por solicitud y despacho); el cambio exige permiso y motivo y queda registrado. Siempre se revierte.
BEGIN;
DO $test$
DECLARE v_req uuid; v_sup uuid; v_doc uuid; g jsonb; r jsonb; v_err text; v_msg text; n int;
BEGIN
 BEGIN
 IF to_regclass('public.wms_release_gate_mode_log') IS NULL OR to_regclass('public.wms_release_alerts') IS NULL
    OR to_regprocedure('public.wms_release_set_mode(text,text)') IS NULL THEN RAISE EXCEPTION 'CAJA C227 FAIL: falta la migración del modo de salida'; END IF;
 IF public.wms_release_mode() <> 'BLOQUEAR' AND NOT EXISTS (SELECT 1 FROM public.wms_release_gate_mode_log) THEN
   RAISE EXCEPTION 'CAJA C227 FAIL: el modo por defecto debe ser BLOQUEAR'; END IF;
 IF has_function_privilege('anon', 'public.wms_release_set_mode(text,text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.wms_release_assert(uuid[],uuid)', 'EXECUTE')
    OR has_table_privilege('authenticated', 'public.wms_release_alerts', 'INSERT')
    OR has_table_privilege('authenticated', 'public.wms_release_gate_mode_log', 'INSERT') THEN
   RAISE EXCEPTION 'CAJA C227 FAIL: modo o alertas expuestos'; END IF;

 SELECT p.id INTO v_sup FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id
  WHERE p.is_active AND ro.name IN ('Supervisor de Despacho','Administrador') AND p.id IN (SELECT id FROM auth.users) ORDER BY ro.name DESC, p.id LIMIT 1;
 SELECT p.id INTO v_doc FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id
  WHERE p.is_active AND ro.name = 'Conductor' AND p.id IN (SELECT id FROM auth.users) ORDER BY p.id LIMIT 1;
 SELECT t.id INTO v_req FROM public.transport_requests t
  WHERE public.wms_release_in_scope(t.request_type, t.contract_id, t.pickup_address) ORDER BY t.created_at DESC LIMIT 1;
 IF v_req IS NOT NULL AND v_sup IS NOT NULL THEN
   DELETE FROM public.request_wms_release_overrides WHERE transport_request_id = v_req;
   DELETE FROM public.request_wms_status WHERE transport_request_id = v_req;
   UPDATE public.system_settings SET value = 'BLOQUEAR' WHERE key = 'wms_release_gate_mode';
   g := public.wms_release_gate(v_req);
   IF NOT (g->>'blocked')::boolean OR NOT (g->>'alert')::boolean OR g->>'mode' <> 'BLOQUEAR' THEN RAISE EXCEPTION 'CAJA C227 FAIL: BLOQUEAR no bloquea (%)', g; END IF;
   v_msg := NULL;
   BEGIN PERFORM public.wms_release_assert(ARRAY[v_req]); EXCEPTION WHEN raise_exception THEN v_msg := SQLERRM; END;
   IF v_msg IS NULL OR v_msg NOT LIKE '%no puede salir%' THEN RAISE EXCEPTION 'CAJA C227 FAIL: BLOQUEAR permite la salida'; END IF;

   -- Sin permiso no cambia el modo
   IF v_doc IS NOT NULL THEN
     PERFORM set_config('request.jwt.claim.sub', v_doc::text, true);
     PERFORM set_config('request.jwt.claims', json_build_object('sub', v_doc, 'role', 'authenticated')::text, true);
     r := public.wms_release_set_mode('ALERTAR', 'Prueba sin permiso de cambio');
     IF (r->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C227 FAIL: un conductor cambió el modo'; END IF;
   END IF;
   PERFORM set_config('request.jwt.claim.sub', v_sup::text, true);
   PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
   r := public.wms_release_set_mode('ALERTAR', 'corto');
   IF (r->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C227 FAIL: cambio sin motivo suficiente'; END IF;
   r := public.wms_release_set_mode('ALERTAR', 'Arranque gradual: solo alertar mientras se estabiliza la carga en el WMS');
   IF NOT (r->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C227 FAIL: cambio rechazado: %', r->>'error'; END IF;
   IF NOT EXISTS (SELECT 1 FROM public.wms_release_gate_mode_log WHERE mode = 'ALERTAR' AND previous_mode = 'BLOQUEAR' AND changed_by = v_sup) THEN
     RAISE EXCEPTION 'CAJA C227 FAIL: el cambio no quedó en el historial'; END IF;

   -- ALERTAR: la salida pasa y deja una sola alerta por solicitud y despacho
   g := public.wms_release_gate(v_req);
   IF (g->>'blocked')::boolean OR NOT (g->>'alert')::boolean THEN RAISE EXCEPTION 'CAJA C227 FAIL: ALERTAR sigue bloqueando (%)', g; END IF;
   PERFORM public.wms_release_assert(ARRAY[v_req]);
   PERFORM public.wms_release_assert(ARRAY[v_req]);
   SELECT count(*) INTO n FROM public.wms_release_alerts WHERE transport_request_id = v_req AND dispatch_id IS NULL;
   IF n <> 1 THEN RAISE EXCEPTION 'CAJA C227 FAIL: se esperaba 1 alerta y hay %', n; END IF;
   r := public.wms_release_mode_info();
   IF NOT (r->>'success')::boolean OR r->>'mode' <> 'ALERTAR' OR jsonb_array_length(r->'log') < 1 THEN RAISE EXCEPTION 'CAJA C227 FAIL: lectura del modo (%)', r; END IF;

   -- Liberada: sin alerta ni bloqueo en ningún modo
   INSERT INTO public.request_wms_status(transport_request_id, status, wms_snapshot_at) VALUES (v_req, 'LIBERADO', now());
   g := public.wms_release_gate(v_req);
   IF (g->>'blocked')::boolean OR (g->>'alert')::boolean THEN RAISE EXCEPTION 'CAJA C227 FAIL: liberada marca alerta (%)', g; END IF;
 END IF;
 EXCEPTION WHEN OTHERS THEN v_err := replace(SQLERRM, 'CAJA C227 FAIL: ', '');
 END;
 IF v_err IS NOT NULL THEN RAISE EXCEPTION 'CAJA C227 FAIL: %', v_err; END IF;
 RAISE EXCEPTION 'CAJA C227 PASS: modo BLOQUEAR por defecto, ALERTAR deja pasar con una alerta registrada, cambio con permiso, motivo e historial';
END $test$;
ROLLBACK;
