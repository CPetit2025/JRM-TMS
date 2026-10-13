-- CAJA C96 — Liquidación pendiente: la oficina completa documentos de un servicio cerrado. GR: número
-- serie-correlativo y luego la guía (entra a conformidad RECIBIDA); Packing List sin correlativo. Siempre se revierte.
BEGIN;
DO $policy$ BEGIN
  IF to_regclass('public.transport_lead_time_settings') IS NOT NULL THEN
    EXECUTE 'UPDATE public.transport_lead_time_settings SET settings=jsonb_set(settings,''{enabled}'',''false''::jsonb)';
  END IF;
END $policy$;
CREATE FUNCTION pg_temp.c96_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;
CREATE FUNCTION pg_temp.c96_ins(p_table text, p_cols jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  EXECUTE (SELECT format('INSERT INTO public.%I (%s) VALUES (%s) RETURNING id', p_table,
                         string_agg(quote_ident(k.key), ', '), string_agg(quote_nullable(k.value #>> '{}'), ', '))
           FROM jsonb_each(p_cols) k
           WHERE EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema = 'public' AND ic.table_name = p_table AND ic.column_name = k.key))
  INTO v_id;
  RETURN v_id;
END $$;
CREATE FUNCTION pg_temp.c96_route(p_plate text, p_site uuid, p_client uuid, p_status text) RETURNS uuid[] LANGUAGE plpgsql AS $$
DECLARE d uuid; r uuid;
BEGIN
  d := pg_temp.c96_ins('dispatches', jsonb_build_object('id', gen_random_uuid(), 'dispatch_number', 'ZZ-C96-' || p_plate, 'vehicle_plate', p_plate,
    'status', p_status, 'site_id', p_site, 'scheduled_departure', now() - interval '1 day', 'scheduled_date', current_date - 1, 'modalidad', 'PROPIA', 'docs_required', false));
  r := pg_temp.c96_ins('transport_requests', jsonb_build_object('request_number', 'ZZ-C96-' || p_plate, 'request_type', 'DESPACHO',
    'attention_mode', 'TRANSPORTE_JRM', 'status', 'ASIGNADA', 'site_id', p_site, 'client_id', p_client, 'requester_name', 'ZZ',
    'department', 'Logística', 'cargo_description', 'Prueba C96', 'pickup_address', 'Planta', 'delivery_address', 'Obra',
    'delivery_district', 'LURIN', 'required_date', (now() AT TIME ZONE 'America/Lima')::date - 1));
  INSERT INTO public.dispatch_requests(dispatch_id, transport_request_id, status, document_type, sequence_order) VALUES (d, r, 'PROGRAMADO', 'GR', 1);
  RETURN ARRAY[d, r];
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE site uuid; carrier uuid; client uuid; actor uuid; v_role uuid; closed uuid[]; open_route uuid[]; r jsonb; bad text; gr text;
  suffix text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5));
BEGIN
  SELECT carrier_id, site_id INTO carrier, site FROM public.vehicles WHERE carrier_id IS NOT NULL AND site_id IS NOT NULL LIMIT 1;
  SELECT id INTO client FROM public.clients ORDER BY id LIMIT 1;
  SELECT id INTO actor FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  IF site IS NULL OR client IS NULL OR actor IS NULL THEN RAISE EXCEPTION 'CAJA C96 FAIL: faltan sede, cliente o perfil'; END IF;
  INSERT INTO public.roles(name, permissions) VALUES ('ZZ C96 ' || suffix, '["documentario:read","documentario:write"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET role_id = v_role, is_active = true WHERE id = actor;
  INSERT INTO public.user_site_access(user_id, site_id) VALUES (actor, site) ON CONFLICT DO NOTHING;
  closed := pg_temp.c96_route('ZC96A' || suffix, site, client, 'EN RUTA');
  UPDATE public.dispatches SET status = 'CIERRE_OPERATIVO' WHERE id = closed[1];
  open_route := pg_temp.c96_route('ZC96B' || suffix, site, client, 'PROGRAMADO');
  gr := 'T9' || right(suffix, 2) || '-' || (floor(random() * 900000) + 100000)::int;
  INSERT INTO storage.objects(bucket_id, name, metadata) VALUES
    ('driver_evidence', actor || '/tercero/' || closed[1] || '/gr.pdf', '{"mimetype":"application/pdf","size":1000}'),
    ('dispatch_documents', closed[1] || '/pl.xlsx', '{"mimetype":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","size":2000}'),
    ('dispatch_documents', open_route[1] || '/pl.pdf', '{"mimetype":"application/pdf","size":2000}');

  PERFORM pg_temp.c96_user(actor);
  -- T1: sin número válido no se acepta la guía
  bad := NULL;
  BEGIN PERFORM public.settlement_upload_document(closed[1], closed[2], 'GUIA', '6591', ARRAY[actor || '/tercero/' || closed[1] || '/gr.pdf']);
  EXCEPTION WHEN raise_exception THEN bad := SQLERRM; END;
  IF bad IS NULL OR bad NOT LIKE '%serie y correlativo%' THEN RAISE EXCEPTION 'CAJA C96 FAIL: guía sin correlativo aceptada (T1) %', bad; END IF;
  -- T2: con número válido entra a conformidad RECIBIDA y el número queda vinculado
  r := public.settlement_upload_document(closed[1], closed[2], 'GUIA', lower(gr), ARRAY[actor || '/tercero/' || closed[1] || '/gr.pdf']);
  PERFORM pg_temp.c96_user(NULL);
  IF (r->>'success') <> 'true' OR NOT EXISTS(SELECT 1 FROM public.delivery_conformities WHERE dispatch_id = closed[1] AND request_id = closed[2] AND state = 'RECIBIDA')
    OR NOT EXISTS(SELECT 1 FROM public.delivery_submissions WHERE dispatch_id = closed[1] AND guide_number = gr)
    OR NOT EXISTS(SELECT 1 FROM public.dispatch_document_references WHERE dispatch_id = closed[1] AND doc_type = 'GUIA_REMISION' AND document_number = gr) THEN
    RAISE EXCEPTION 'CAJA C96 FAIL: guía de liquidación (T2) %', r; END IF;
  PERFORM pg_temp.c96_user(actor);
  -- T3: Packing List sin correlativo se carga directamente
  r := public.settlement_upload_document(closed[1], closed[2], 'PACKING', NULL, ARRAY[closed[1] || '/pl.xlsx'], ARRAY['packing.xlsx']);
  PERFORM pg_temp.c96_user(NULL);
  IF (r->>'success') <> 'true' OR NOT EXISTS(SELECT 1 FROM public.dispatch_documents WHERE dispatch_id = closed[1] AND doc_type = 'PACKING_LIST' AND file_name = 'packing.xlsx') THEN
    RAISE EXCEPTION 'CAJA C96 FAIL: Packing List de liquidación (T3) %', r; END IF;
  PERFORM pg_temp.c96_user(actor);
  -- T4: un servicio que no está en liquidación pendiente no admite esta carga
  bad := NULL;
  BEGIN PERFORM public.settlement_upload_document(open_route[1], open_route[2], 'PACKING', NULL, ARRAY[open_route[1] || '/pl.pdf']);
  EXCEPTION WHEN raise_exception THEN bad := SQLERRM; END;
  IF bad IS NULL OR bad NOT LIKE '%liquidación pendiente%' THEN RAISE EXCEPTION 'CAJA C96 FAIL: carga fuera de liquidación (T4) %', bad; END IF;
  PERFORM pg_temp.c96_user(NULL);
  -- T5: anónimos no pueden ejecutarla
  IF has_function_privilege('anon', 'public.settlement_upload_document(uuid,uuid,text,text,text[],text[],uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'CAJA C96 FAIL: expuesta a anónimos (T5)'; END IF;
  RAISE EXCEPTION 'CAJA C96 PASS (5/5) liquidación pendiente: GR con serie-correlativo a conformidad, Packing List directo, alcance y permisos';
END $test$;
ROLLBACK;
