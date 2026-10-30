-- CAJA C99 — «Dar por liquidado» manual: solo Administrador, Jefe de Distribución, Supervisor de Transporte y Despacho;
-- exige motivo, saca el servicio de la liquidación pendiente, conserva lo que faltaba y se puede revertir. Siempre se revierte.
BEGIN;
DO $policy$ BEGIN
  IF to_regclass('public.transport_lead_time_settings') IS NOT NULL THEN
    EXECUTE 'UPDATE public.transport_lead_time_settings SET settings=jsonb_set(settings,''{enabled}'',''false''::jsonb)';
  END IF;
END $policy$;
CREATE FUNCTION pg_temp.c99_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;
CREATE FUNCTION pg_temp.c99_ins(p_table text, p_cols jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  EXECUTE (SELECT format('INSERT INTO public.%I (%s) VALUES (%s) RETURNING id', p_table,
                         string_agg(quote_ident(k.key), ', '), string_agg(quote_nullable(k.value #>> '{}'), ', '))
           FROM jsonb_each(p_cols) k
           WHERE EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema = 'public' AND ic.table_name = p_table AND ic.column_name = k.key))
  INTO v_id;
  RETURN v_id;
END $$;
CREATE FUNCTION pg_temp.c99_route(p_plate text, p_site uuid, p_client uuid, p_status text, p_type text DEFAULT 'DESPACHO') RETURNS uuid[] LANGUAGE plpgsql AS $$
DECLARE d uuid; r uuid;
BEGIN
  d := pg_temp.c99_ins('dispatches', jsonb_build_object('id', gen_random_uuid(), 'dispatch_number', 'ZZ-C99-' || p_plate, 'vehicle_plate', p_plate,
    'status', p_status, 'site_id', p_site, 'scheduled_departure', now() - interval '1 day', 'scheduled_date', current_date - 1, 'modalidad', 'PROPIA', 'docs_required', false));
  r := pg_temp.c99_ins('transport_requests', jsonb_build_object('request_number', 'ZZ-C99-' || p_plate, 'request_type', p_type,
    'attention_mode', 'TRANSPORTE_JRM',
    -- Recojo y punto a punto sin OT: producción no admite insertarlos ya programados (request_ot_funding_guard)
    'status', CASE WHEN p_type = 'DESPACHO' THEN 'ASIGNADA' ELSE 'PENDIENTE' END,
    'reference_type', CASE WHEN p_type <> 'DESPACHO' THEN 'OC' END, 'reference_number', CASE WHEN p_type <> 'DESPACHO' THEN 'C99-' || p_plate END, 'site_id', p_site, 'client_id', p_client, 'requester_name', 'ZZ',
    'department', 'Logística', 'cargo_description', 'Prueba C99', 'pickup_address', 'Planta', 'delivery_address', 'Obra',
    'delivery_district', 'LURIN', 'required_date', (now() AT TIME ZONE 'America/Lima')::date - 1));
  INSERT INTO public.dispatch_requests(dispatch_id, transport_request_id, status, document_type, sequence_order) VALUES (d, r, 'PROGRAMADO', 'GR', 1);
  RETURN ARRAY[d, r];
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE site uuid; client uuid; actor uuid; doc_role uuid; boss_role uuid; ent uuid[]; prog uuid[]; c jsonb; bad text;
  suffix text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5));
BEGIN
  SELECT site_id INTO site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
  SELECT id INTO client FROM public.clients ORDER BY id LIMIT 1;
  SELECT id INTO actor FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  IF site IS NULL OR client IS NULL OR actor IS NULL THEN RAISE EXCEPTION 'CAJA C99 FAIL: faltan sede, cliente o perfil'; END IF;
  INSERT INTO public.roles(name, permissions) VALUES ('ZZ C99 doc ' || suffix, '["documentario:read","documentario:write"]') RETURNING id INTO doc_role;
  INSERT INTO public.roles(name, permissions) VALUES ('ZZ C99 Supervisor de Despacho ' || suffix, '["despacho:read","despacho:write"]') RETURNING id INTO boss_role;
  UPDATE public.profiles SET role_id = doc_role, is_active = true WHERE id = actor;
  INSERT INTO public.user_site_access(user_id, site_id) VALUES (actor, site) ON CONFLICT DO NOTHING;
  ent := pg_temp.c99_route('ZC99E' || suffix, site, client, 'EN RUTA', 'DESPACHO');
  UPDATE public.dispatches SET status = 'CIERRE_OPERATIVO' WHERE id = ent[1];

  -- T1: un rol documentario sin cargo de supervisión no puede dar por liquidado
  PERFORM pg_temp.c99_user(actor);
  bad := NULL;
  BEGIN PERFORM public.settlement_mark_settled(ent[1], ent[2], 'Cliente confirmó recepción por correo');
  EXCEPTION WHEN raise_exception THEN bad := SQLERRM; END;
  IF bad IS NULL OR bad NOT LIKE 'Solo el Administrador%' THEN RAISE EXCEPTION 'CAJA C99 FAIL: rol sin permiso (T1) %', bad; END IF;
  -- T2: Despacho exige motivo y luego liquida; lo que faltaba queda registrado
  PERFORM pg_temp.c99_user(NULL);
  UPDATE public.profiles SET role_id = boss_role WHERE id = actor;
  PERFORM pg_temp.c99_user(actor);
  bad := NULL;
  BEGIN PERFORM public.settlement_mark_settled(ent[1], ent[2], 'corto');
  EXCEPTION WHEN raise_exception THEN bad := SQLERRM; END;
  IF bad IS NULL OR bad NOT LIKE 'Indique el motivo%' THEN RAISE EXCEPTION 'CAJA C99 FAIL: motivo (T2) %', bad; END IF;
  c := public.settlement_mark_settled(ent[1], ent[2], 'Cliente confirmó recepción por correo');
  PERFORM pg_temp.c99_user(NULL);
  IF NOT (c->>'complete')::boolean OR c->'manual'->'missing' <> '["GUIA_O_NOTA","PACKING_LIST"]'::jsonb THEN RAISE EXCEPTION 'CAJA C99 FAIL: liquidación manual (T2) %', c; END IF;
  IF NOT (public.settlement_checklist(ent[1], ent[2])->>'complete')::boolean THEN RAISE EXCEPTION 'CAJA C99 FAIL: lista de verificación (T2)'; END IF;
  -- T3: se puede revertir y vuelve a la regla automática
  PERFORM pg_temp.c99_user(actor);
  c := public.settlement_undo_manual(ent[1], ent[2], 'La guía física no llegó al cierre');
  PERFORM pg_temp.c99_user(NULL);
  IF (c->>'complete')::boolean OR c ? 'manual' THEN RAISE EXCEPTION 'CAJA C99 FAIL: reversión (T3) %', c; END IF;
  -- El cierre manual deshecho queda en el historial del cierre documentario con su motivo
  IF NOT EXISTS (SELECT 1 FROM public.documentary_closure_events e WHERE e.dispatch_id = ent[1] AND e.request_id = ent[2]
      AND e.action = 'DESHACER_MANUAL' AND e.reason = 'La guía física no llegó al cierre'
      AND e.details->'cierre_manual'->>'reason' = 'Cliente confirmó recepción por correo') THEN
    RAISE EXCEPTION 'CAJA C99 FAIL: historial de la reversión (T3)'; END IF;
  -- T4: una ruta programada no se liquida y los anónimos no tienen acceso
  -- (ruta propia aún programada: producción no deja volver una ruta cerrada a PROGRAMADO)
  prog := pg_temp.c99_route('ZC99P' || suffix, site, client, 'PROGRAMADO', 'DESPACHO');
  PERFORM pg_temp.c99_user(actor);
  bad := NULL;
  BEGIN PERFORM public.settlement_mark_settled(prog[1], prog[2], 'Cliente confirmó recepción por correo');
  EXCEPTION WHEN raise_exception THEN bad := SQLERRM; END;
  PERFORM pg_temp.c99_user(NULL);
  IF bad IS NULL OR bad NOT LIKE '%ya salió%' THEN RAISE EXCEPTION 'CAJA C99 FAIL: ruta programada (T4) %', bad; END IF;
  IF has_function_privilege('anon', 'public.settlement_mark_settled(uuid,uuid,text)', 'EXECUTE')
    OR has_table_privilege('authenticated', 'public.settlement_manual_closures', 'SELECT') THEN RAISE EXCEPTION 'CAJA C99 FAIL: permisos (T4)'; END IF;
  RAISE EXCEPTION 'CAJA C99 PASS (4/4) dar por liquidado: solo roles autorizados, con motivo, auditado y reversible';
END $test$;
ROLLBACK;
