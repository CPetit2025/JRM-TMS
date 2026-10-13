-- CAJA C97 — Reglas de liquidación por tipo de servicio: entrega (GR validada o Nota + Packing List), recojo (GR
-- validada; OC/OS/RQ opcionales), punto a punto (todo opcional). Liquidación automática. Siempre se revierte.
BEGIN;
DO $policy$ BEGIN
  IF to_regclass('public.transport_lead_time_settings') IS NOT NULL THEN
    EXECUTE 'UPDATE public.transport_lead_time_settings SET settings=jsonb_set(settings,''{enabled}'',''false''::jsonb)';
  END IF;
END $policy$;
CREATE FUNCTION pg_temp.c97_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;
CREATE FUNCTION pg_temp.c97_ins(p_table text, p_cols jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  EXECUTE (SELECT format('INSERT INTO public.%I (%s) VALUES (%s) RETURNING id', p_table,
                         string_agg(quote_ident(k.key), ', '), string_agg(quote_nullable(k.value #>> '{}'), ', '))
           FROM jsonb_each(p_cols) k
           WHERE EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema = 'public' AND ic.table_name = p_table AND ic.column_name = k.key))
  INTO v_id;
  RETURN v_id;
END $$;
CREATE FUNCTION pg_temp.c97_route(p_plate text, p_site uuid, p_client uuid, p_status text, p_type text DEFAULT 'DESPACHO') RETURNS uuid[] LANGUAGE plpgsql AS $$
DECLARE d uuid; r uuid;
BEGIN
  d := pg_temp.c97_ins('dispatches', jsonb_build_object('id', gen_random_uuid(), 'dispatch_number', 'ZZ-C97-' || p_plate, 'vehicle_plate', p_plate,
    'status', p_status, 'site_id', p_site, 'scheduled_departure', now() - interval '1 day', 'scheduled_date', current_date - 1, 'modalidad', 'PROPIA', 'docs_required', false));
  r := pg_temp.c97_ins('transport_requests', jsonb_build_object('request_number', 'ZZ-C97-' || p_plate, 'request_type', p_type,
    'attention_mode', 'TRANSPORTE_JRM', 'status', 'ASIGNADA', 'site_id', p_site, 'client_id', p_client, 'requester_name', 'ZZ',
    'department', 'Logística', 'cargo_description', 'Prueba C97', 'pickup_address', 'Planta', 'delivery_address', 'Obra',
    'delivery_district', 'LURIN', 'required_date', (now() AT TIME ZONE 'America/Lima')::date - 1));
  INSERT INTO public.dispatch_requests(dispatch_id, transport_request_id, status, document_type, sequence_order) VALUES (d, r, 'PROGRAMADO', 'GR', 1);
  RETURN ARRAY[d, r];
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE site uuid; carrier uuid; client uuid; actor uuid; v_role uuid; ent uuid[]; rec uuid[]; tra uuid[]; c jsonb; r jsonb; bad text;
  suffix text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5));
BEGIN
  SELECT carrier_id, site_id INTO carrier, site FROM public.vehicles WHERE carrier_id IS NOT NULL AND site_id IS NOT NULL LIMIT 1;
  SELECT id INTO client FROM public.clients ORDER BY id LIMIT 1;
  SELECT id INTO actor FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  IF site IS NULL OR client IS NULL OR actor IS NULL THEN RAISE EXCEPTION 'CAJA C97 FAIL: faltan sede, cliente o perfil'; END IF;
  INSERT INTO public.roles(name, permissions) VALUES ('ZZ C97 ' || suffix, '["documentario:read","documentario:write"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET role_id = v_role, is_active = true WHERE id = actor;
  INSERT INTO public.user_site_access(user_id, site_id) VALUES (actor, site) ON CONFLICT DO NOTHING;
  ent := pg_temp.c97_route('ZC97E' || suffix, site, client, 'EN RUTA', 'DESPACHO');
  rec := pg_temp.c97_route('ZC97R' || suffix, site, client, 'EN RUTA', 'RECOJO');
  tra := pg_temp.c97_route('ZC97T' || suffix, site, client, 'EN RUTA', 'TRASLADO');
  UPDATE public.dispatches SET status = 'CIERRE_OPERATIVO' WHERE id IN (ent[1], rec[1], tra[1]);
  INSERT INTO storage.objects(bucket_id, name, metadata) VALUES
    ('dispatch_documents', ent[1] || '/nd.pdf', '{"mimetype":"application/pdf","size":1000}'),
    ('dispatch_documents', ent[1] || '/pl.pdf', '{"mimetype":"application/pdf","size":1000}'),
    ('dispatch_documents', rec[1] || '/nd.pdf', '{"mimetype":"application/pdf","size":1000}'),
    ('dispatch_documents', rec[1] || '/oc.pdf', '{"mimetype":"application/pdf","size":1000}');

  -- T1: entrega sin documentos pide GR o Nota y Packing List; punto a punto no exige nada
  c := public.settlement_checklist(ent[1], ent[2]);
  IF c->>'kind' <> 'ENTREGA' OR (c->>'complete')::boolean OR c->'missing' <> '["GUIA_O_NOTA","PACKING_LIST"]'::jsonb THEN RAISE EXCEPTION 'CAJA C97 FAIL: entrega (T1) %', c; END IF;
  c := public.settlement_checklist(tra[1], tra[2]);
  IF c->>'kind' <> 'TRASLADO' OR NOT (c->>'complete')::boolean THEN RAISE EXCEPTION 'CAJA C97 FAIL: punto a punto (T1) %', c; END IF;
  -- T2: entrega con Nota de Despacho y Packing List queda liquidada automáticamente
  PERFORM pg_temp.c97_user(actor);
  r := public.settlement_upload_document(ent[1], ent[2], 'NOTA', 'nd01-1234', ARRAY[ent[1] || '/nd.pdf']);
  r := public.settlement_upload_document(ent[1], ent[2], 'PACKING', NULL, ARRAY[ent[1] || '/pl.pdf']);
  PERFORM pg_temp.c97_user(NULL);
  c := public.settlement_checklist(ent[1], ent[2]);
  IF NOT (c->>'complete')::boolean THEN RAISE EXCEPTION 'CAJA C97 FAIL: entrega con Nota y Packing List (T2) %', c; END IF;
  -- T3: recojo exige GR; no acepta Nota; acepta OC opcional; con la GR validada queda liquidado
  c := public.settlement_checklist(rec[1], rec[2]);
  IF c->>'kind' <> 'RECOJO' OR c->'missing' <> '["GUIA_REMISION"]'::jsonb THEN RAISE EXCEPTION 'CAJA C97 FAIL: recojo (T3) %', c; END IF;
  PERFORM pg_temp.c97_user(actor);
  bad := NULL;
  BEGIN PERFORM public.settlement_upload_document(rec[1], rec[2], 'NOTA', 'ND01-1', ARRAY[rec[1] || '/nd.pdf']);
  EXCEPTION WHEN raise_exception THEN bad := SQLERRM; END;
  IF bad IS NULL OR bad NOT LIKE '%Guía de Remisión%' THEN RAISE EXCEPTION 'CAJA C97 FAIL: recojo con Nota (T3) %', bad; END IF;
  r := public.settlement_upload_document(rec[1], rec[2], 'OC', ' 57724 ', ARRAY[rec[1] || '/oc.pdf']);
  PERFORM pg_temp.c97_user(NULL);
  c := public.settlement_checklist(rec[1], rec[2]);
  IF c->'references' <> '["OC 57724"]'::jsonb OR (c->>'complete')::boolean THEN RAISE EXCEPTION 'CAJA C97 FAIL: OC opcional (T3) %', c; END IF;
  INSERT INTO public.delivery_conformities(dispatch_id, request_id) VALUES (rec[1], rec[2]) ON CONFLICT DO NOTHING;
  UPDATE public.delivery_conformities SET state = 'VALIDADA' WHERE dispatch_id = rec[1] AND request_id = rec[2];
  IF NOT (public.settlement_checklist(rec[1], rec[2])->>'complete')::boolean THEN RAISE EXCEPTION 'CAJA C97 FAIL: recojo con GR validada (T3)'; END IF;
  -- T4: la lista para la pantalla respeta la autorización y devuelve un estado por servicio
  PERFORM pg_temp.c97_user(actor);
  r := public.get_settlement_checklists(ARRAY[ent[1], rec[1], tra[1]]);
  PERFORM pg_temp.c97_user(NULL);
  IF jsonb_array_length(r) <> 3 OR EXISTS(SELECT 1 FROM jsonb_array_elements(r) e WHERE NOT (e->>'complete')::boolean) THEN RAISE EXCEPTION 'CAJA C97 FAIL: lista por servicio (T4) %', r; END IF;
  -- T5: anónimos no ven la lista y la regla interna no es pública
  IF has_function_privilege('anon', 'public.get_settlement_checklists(uuid[])', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.settlement_checklist(uuid,uuid)', 'EXECUTE') THEN RAISE EXCEPTION 'CAJA C97 FAIL: permisos (T5)'; END IF;
  RAISE EXCEPTION 'CAJA C97 PASS (5/5) liquidación por tipo de servicio: entrega GR/Nota + Packing List, recojo GR con OC/OS/RQ opcionales, punto a punto opcional y liquidación automática';
END $test$;
ROLLBACK;
