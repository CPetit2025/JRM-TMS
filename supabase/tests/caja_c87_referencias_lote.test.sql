-- CAJA C87 — Documentos «Liquidación pendiente»: la base devuelve solo rutas con cierre operativo y guías sin
-- validar, también sin salida programada (fecha efectiva created_at). Bloque que siempre se revierte.
BEGIN;
DO $policy$ BEGIN
  IF to_regclass('public.transport_lead_time_settings') IS NOT NULL THEN
    EXECUTE 'UPDATE public.transport_lead_time_settings SET settings=jsonb_set(settings,''{enabled}'',''false''::jsonb)';
  END IF;
END $policy$;
CREATE FUNCTION pg_temp.c87_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;
CREATE FUNCTION pg_temp.c87_ins(p_table text, p_cols jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  EXECUTE (SELECT format('INSERT INTO public.%I (%s) VALUES (%s) RETURNING id', p_table,
                         string_agg(quote_ident(k.key), ', '), string_agg(quote_nullable(k.value #>> '{}'), ', '))
           FROM jsonb_each(p_cols) k
           WHERE EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema = 'public' AND ic.table_name = p_table AND ic.column_name = k.key))
  INTO v_id;
  RETURN v_id;
END $$;
CREATE FUNCTION pg_temp.c87_route(p_plate text, p_site uuid, p_client uuid, p_at timestamptz, p_status text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE d uuid; r uuid;
BEGIN
  d := pg_temp.c87_ins('dispatches', jsonb_build_object('id', gen_random_uuid(), 'dispatch_number', 'ZZ-C87-' || p_plate, 'vehicle_plate', p_plate,
    'status', p_status, 'site_id', p_site, 'scheduled_departure', p_at, 'modalidad', 'PROPIA', 'docs_required', false));
  r := pg_temp.c87_ins('transport_requests', jsonb_build_object('request_number', 'ZZ-C87-' || p_plate, 'request_type', 'DESPACHO',
    'attention_mode', 'TRANSPORTE_JRM', 'status', 'ASIGNADA', 'site_id', p_site, 'client_id', p_client, 'requester_name', 'ZZ',
    'department', 'Logística', 'cargo_description', 'Prueba C87', 'pickup_address', 'Planta', 'delivery_address', 'Obra',
    'delivery_district', 'LURIN', 'required_date', (COALESCE(p_at, now()) AT TIME ZONE 'America/Lima')::date));
  INSERT INTO public.dispatch_requests(dispatch_id, transport_request_id, status, document_type, sequence_order) VALUES (d, r, 'PROGRAMADO', 'GR', 1);
  RETURN d;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE site uuid; foreign_site uuid; carrier uuid; client uuid; actor uuid; v_role uuid; own uuid; other uuid; req uuid; other_req uuid; r jsonb; v_err text;
  suffix text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5));
BEGIN
  SELECT carrier_id, site_id INTO carrier, site FROM public.vehicles WHERE carrier_id IS NOT NULL AND site_id IS NOT NULL LIMIT 1;
  SELECT id INTO client FROM public.clients ORDER BY id LIMIT 1;
  SELECT id INTO actor FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  IF site IS NULL OR client IS NULL OR actor IS NULL THEN RAISE EXCEPTION 'CAJA C87 FAIL: faltan sede, cliente o perfil'; END IF;
  SELECT id INTO foreign_site FROM public.sites WHERE id <> site LIMIT 1;
  IF foreign_site IS NULL THEN foreign_site := pg_temp.c87_ins('sites', jsonb_build_object('id', gen_random_uuid(), 'code', 'ZZ-C87', 'name', 'Prueba C87')); END IF;
  INSERT INTO public.roles(name, permissions) VALUES ('ZZ C87 ' || suffix, '["documentario:read"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET role_id = v_role, is_active = true WHERE id = actor;
  DELETE FROM public.user_site_access WHERE user_id = actor;
  INSERT INTO public.user_site_access(user_id, site_id) VALUES (actor, site);
  PERFORM pg_temp.c87_ins('vehicles', jsonb_build_object('plate', 'ZC87A' || suffix, 'carrier_id', carrier, 'site_id', site, 'type', 'CAMION', 'status', 'DISPONIBLE'));
  PERFORM pg_temp.c87_ins('vehicles', jsonb_build_object('plate', 'ZC87B' || suffix, 'carrier_id', carrier, 'site_id', foreign_site, 'type', 'CAMION', 'status', 'DISPONIBLE'));
  own := pg_temp.c87_route('ZC87A' || suffix, site, client, now(), 'PROGRAMADO');
  other := pg_temp.c87_route('ZC87B' || suffix, foreign_site, client, now(), 'PROGRAMADO');
  SELECT transport_request_id INTO req FROM public.dispatch_requests WHERE dispatch_id = own;
  SELECT transport_request_id INTO other_req FROM public.dispatch_requests WHERE dispatch_id = other;
  INSERT INTO public.dispatch_document_references(dispatch_id, request_id, doc_type, document_number, created_by) VALUES
    (own, req, 'GUIA_REMISION', 'T087-' || (100000 + floor(random() * 800000))::int, actor),
    (own, req, 'GUIA_REMISION', 'T087-' || (900000 + floor(random() * 90000))::int, actor),
    (other, other_req, 'NOTA_DESPACHO', 'ND87-' || (100000 + floor(random() * 800000))::int, actor);

  -- T1: una sola consulta devuelve los números de los despachos autorizados y omite los de otra sede
  PERFORM pg_temp.c87_user(actor);
  r := public.get_dispatch_document_references_batch(ARRAY[own, other]);
  PERFORM pg_temp.c87_user(NULL);
  IF (SELECT count(*) FROM jsonb_array_elements(r) x WHERE x->>'dispatch_id' = own::text AND x->>'request_id' = req::text AND x->>'doc_type' = 'GUIA_REMISION') <> 2
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(r) x WHERE x->>'dispatch_id' = other::text) THEN
    RAISE EXCEPTION 'CAJA C87 FAIL: números por lote o aislamiento de sede (T1): %', r; END IF;

  -- T2: límite de despachos por consulta
  PERFORM pg_temp.c87_user(actor);
  BEGIN PERFORM public.get_dispatch_document_references_batch(array_fill(own, ARRAY[501])); v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  PERFORM pg_temp.c87_user(NULL);
  IF v_err IS NULL THEN RAISE EXCEPTION 'CAJA C87 FAIL: sin límite de despachos (T2)'; END IF;

  -- T3: no expuesta a anónimos
  IF has_function_privilege('anon', 'public.get_dispatch_document_references_batch(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'CAJA C87 FAIL: expuesta a anónimos (T3)'; END IF;

  RAISE EXCEPTION 'CAJA C87 PASS (3/3) números documentarios por lote: una consulta, sede autorizada y límite';
END $test$;
ROLLBACK;
