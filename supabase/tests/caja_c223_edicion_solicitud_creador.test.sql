-- C223: un rol que solo crea solicitudes (solicitudes:write) edita/cancela solo las suyas sin despacho ni atención,
-- en la RPC de guardado, en la cancelación y en la escritura directa (RLS). Despacho/OT/Administrador sin cambio.
-- Usa solicitudes existentes: solo cambia el rol del creador dentro de la transacción. Siempre se revierte.
BEGIN;
DO $test$
DECLARE v_role uuid; v_user uuid; v_own uuid; v_other uuid; v_msg text; v_rows int; v_bad int;
BEGIN
 BEGIN
 IF to_regprocedure('public.can_edit_transport_request(uuid)') IS NULL
    OR to_regprocedure('public.save_transport_request_full_before_owner_guard(uuid,jsonb,jsonb,jsonb)') IS NULL
    OR to_regprocedure('public.set_transport_request_status_before_owner_guard(uuid,text,date)') IS NULL THEN
   RAISE EXCEPTION 'CAJA C223 FAIL: falta la migración de edición solo por el creador'; END IF;
 IF has_function_privilege('authenticated', 'public.save_transport_request_full_before_owner_guard(uuid,jsonb,jsonb,jsonb)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.set_transport_request_status_before_owner_guard(uuid,text,date)', 'EXECUTE') THEN
   RAISE EXCEPTION 'CAJA C223 FAIL: las versiones sin control quedan expuestas'; END IF;

 -- Creador de alguna solicitud aún editable (sin despacho activo) y otra solicitud ajena
 SELECT t.created_by, t.id INTO v_user, v_own FROM public.transport_requests t
  JOIN public.profiles p ON p.id = t.created_by
  WHERE t.status IN ('PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'APROBADA', 'OBSERVADA', 'REPROGRAMADA')
    AND NOT EXISTS (SELECT 1 FROM public.dispatch_requests dr JOIN public.dispatches d ON d.id = dr.dispatch_id
                    WHERE dr.transport_request_id = t.id AND COALESCE(d.status, '') <> 'CANCELADO')
  ORDER BY t.created_at DESC LIMIT 1;
 IF v_user IS NULL THEN
   SELECT t.created_by INTO v_user FROM public.transport_requests t JOIN public.profiles p ON p.id = t.created_by LIMIT 1;
 END IF;
 IF v_user IS NULL THEN RAISE EXCEPTION 'CAJA C223 FAIL: no hay solicitudes con creador'; END IF;
 SELECT t.id INTO v_other FROM public.transport_requests t WHERE t.created_by IS DISTINCT FROM v_user
  ORDER BY t.created_at DESC LIMIT 1;

 INSERT INTO public.roles (id, name, permissions) VALUES (gen_random_uuid(), 'Caja C223 ' || gen_random_uuid(), '["solicitudes:write"]'::jsonb)
  RETURNING id INTO v_role;
 UPDATE public.profiles SET role_id = v_role, is_active = true WHERE id = v_user;
 PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
 PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);

 IF v_own IS NOT NULL AND NOT public.can_edit_transport_request(v_own) THEN
   RAISE EXCEPTION 'CAJA C223 FAIL: el creador no puede editar su solicitud sin asignar'; END IF;
 -- La regla completa sobre todas las solicitudes: propia, estado previo a la asignación y sin despacho activo
 SELECT count(*) INTO v_bad FROM public.transport_requests t
  WHERE public.can_edit_transport_request(t.id) IS DISTINCT FROM (t.created_by = v_user
    AND t.status IN ('PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'APROBADA', 'APROBADO', 'OBSERVADA', 'REPROGRAMADA')
    AND NOT EXISTS (SELECT 1 FROM public.dispatch_requests dr JOIN public.dispatches d ON d.id = dr.dispatch_id
                    WHERE dr.transport_request_id = t.id AND COALESCE(d.status, '') <> 'CANCELADO'));
 IF v_bad > 0 THEN RAISE EXCEPTION 'CAJA C223 FAIL: % solicitudes no siguen la regla del creador', v_bad; END IF;

 IF v_other IS NOT NULL THEN
   v_msg := NULL;
   BEGIN PERFORM public.save_transport_request_full(v_other, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb);
   EXCEPTION WHEN insufficient_privilege THEN v_msg := SQLERRM; END;
   IF v_msg IS NULL OR v_msg NOT LIKE 'Solo puede editar sus propias solicitudes%' THEN
     RAISE EXCEPTION 'CAJA C223 FAIL: edita una solicitud ajena (%)', v_msg; END IF;
   v_msg := NULL;
   BEGIN PERFORM public.set_transport_request_status(v_other, 'CANCELADA');
   EXCEPTION WHEN insufficient_privilege THEN v_msg := SQLERRM; END;
   IF v_msg IS NULL OR v_msg NOT LIKE 'Solo puede cancelar sus propias solicitudes%' THEN
     RAISE EXCEPTION 'CAJA C223 FAIL: cancela una solicitud ajena (%)', v_msg; END IF;
   -- Entradas alternativas (si están instaladas)
   IF to_regprocedure('public.save_transport_request_before_owner_guard(uuid,jsonb,jsonb)') IS NOT NULL THEN
     v_msg := NULL;
     BEGIN PERFORM public.save_transport_request(v_other, '{}'::jsonb, '[]'::jsonb);
     EXCEPTION WHEN insufficient_privilege THEN v_msg := SQLERRM; END;
     IF v_msg IS NULL OR v_msg NOT LIKE 'Solo puede editar sus propias%' THEN
       RAISE EXCEPTION 'CAJA C223 FAIL: save_transport_request edita una solicitud ajena (%)', v_msg; END IF;
   END IF;
   IF to_regprocedure('public.save_transport_request_attention_before_owner_guard(uuid,jsonb,jsonb,jsonb)') IS NOT NULL THEN
     v_msg := NULL;
     BEGIN PERFORM public.save_transport_request_attention(v_other, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb);
     EXCEPTION WHEN insufficient_privilege THEN v_msg := SQLERRM; END;
     IF v_msg IS NULL OR v_msg NOT LIKE 'Solo puede editar sus propias%' THEN
       RAISE EXCEPTION 'CAJA C223 FAIL: save_transport_request_attention edita una solicitud ajena (%)', v_msg; END IF;
   END IF;
   IF to_regprocedure('public.set_transport_request_status_at_before_owner_guard(uuid,text,date,timestamptz,text)') IS NOT NULL THEN
     v_msg := NULL;
     BEGIN PERFORM public.set_transport_request_status_at(v_other, 'CANCELADA');
     EXCEPTION WHEN insufficient_privilege THEN v_msg := SQLERRM; END;
     IF v_msg IS NULL OR v_msg NOT LIKE 'Solo puede cancelar sus propias%' THEN
       RAISE EXCEPTION 'CAJA C223 FAIL: set_transport_request_status_at cancela una solicitud ajena (%)', v_msg; END IF;
   END IF;

   EXECUTE 'SET LOCAL ROLE authenticated';
   UPDATE public.transport_requests SET updated_at = updated_at WHERE id = v_other;
   GET DIAGNOSTICS v_rows = ROW_COUNT;
   EXECUTE 'RESET ROLE';
   IF v_rows <> 0 THEN RAISE EXCEPTION 'CAJA C223 FAIL: la API permite escribir una solicitud ajena'; END IF;

   -- Contratos/OT (área comercial) conserva la edición de cualquier solicitud
   UPDATE public.roles SET permissions = '["solicitudes:write", "ot:write"]'::jsonb WHERE id = v_role;
   IF NOT public.can_edit_transport_request(v_other) THEN
     RAISE EXCEPTION 'CAJA C223 FAIL: Contratos/OT perdió la edición'; END IF;
 END IF;

 RAISE EXCEPTION 'CAJA C223 PASS';
 EXCEPTION WHEN OTHERS THEN
   IF SQLERRM LIKE 'CAJA C223 PASS%' OR SQLERRM LIKE 'CAJA C223 FAIL%' THEN RAISE; END IF;
   RAISE EXCEPTION 'CAJA C223 FAIL: %', SQLERRM;
 END;
END $test$;
ROLLBACK;
