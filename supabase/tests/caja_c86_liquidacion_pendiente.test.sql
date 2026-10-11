-- CAJA C86 — Documentos «Liquidación pendiente»: la base devuelve solo rutas con cierre operativo y guías sin
-- validar, también sin salida programada (fecha efectiva created_at). Bloque que siempre se revierte.
BEGIN;
DO $policy$ BEGIN
  IF to_regclass('public.transport_lead_time_settings') IS NOT NULL THEN
    EXECUTE 'UPDATE public.transport_lead_time_settings SET settings=jsonb_set(settings,''{enabled}'',''false''::jsonb)';
  END IF;
END $policy$;
CREATE FUNCTION pg_temp.c86_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;
CREATE FUNCTION pg_temp.c86_ins(p_table text, p_cols jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  EXECUTE (SELECT format('INSERT INTO public.%I (%s) VALUES (%s) RETURNING id', p_table,
                         string_agg(quote_ident(k.key), ', '), string_agg(quote_nullable(k.value #>> '{}'), ', '))
           FROM jsonb_each(p_cols) k
           WHERE EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema = 'public' AND ic.table_name = p_table AND ic.column_name = k.key))
  INTO v_id;
  RETURN v_id;
END $$;
CREATE FUNCTION pg_temp.c86_route(p_plate text, p_site uuid, p_client uuid, p_at timestamptz, p_status text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE d uuid; r uuid;
BEGIN
  d := pg_temp.c86_ins('dispatches', jsonb_build_object('id', gen_random_uuid(), 'dispatch_number', 'ZZ-C86-' || p_plate, 'vehicle_plate', p_plate,
    'status', p_status, 'site_id', p_site, 'scheduled_departure', p_at, 'modalidad', 'PROPIA', 'docs_required', false));
  r := pg_temp.c86_ins('transport_requests', jsonb_build_object('request_number', 'ZZ-C86-' || p_plate, 'request_type', 'DESPACHO',
    'attention_mode', 'TRANSPORTE_JRM', 'status', 'ASIGNADA', 'site_id', p_site, 'client_id', p_client, 'requester_name', 'ZZ',
    'department', 'Logística', 'cargo_description', 'Prueba C86', 'pickup_address', 'Planta', 'delivery_address', 'Obra',
    'delivery_district', 'LURIN', 'required_date', (COALESCE(p_at, now()) AT TIME ZONE 'America/Lima')::date));
  INSERT INTO public.dispatch_requests(dispatch_id, transport_request_id, status, document_type, sequence_order) VALUES (d, r, 'PROGRAMADO', 'GR', 1);
  RETURN d;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE site uuid; carrier uuid; client uuid; actor uuid; v_role uuid; cut uuid; undated uuid; open_route uuid; req uuid; ids text[];
  suffix text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5)); v_from timestamptz := now() - interval '365 days'; v_until timestamptz := now() + interval '1 day';
BEGIN
  SELECT carrier_id, site_id INTO carrier, site FROM public.vehicles WHERE carrier_id IS NOT NULL AND site_id IS NOT NULL LIMIT 1;
  SELECT id INTO client FROM public.clients ORDER BY id LIMIT 1;
  SELECT id INTO actor FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  IF site IS NULL OR client IS NULL OR actor IS NULL THEN RAISE EXCEPTION 'CAJA C86 FAIL: faltan sede, cliente o perfil'; END IF;
  INSERT INTO public.roles(name, permissions) VALUES ('ZZ C86 ' || suffix, '["documentario:read"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET role_id = v_role, is_active = true WHERE id = actor;
  INSERT INTO public.user_site_access(user_id, site_id) VALUES (actor, site) ON CONFLICT DO NOTHING;
  PERFORM pg_temp.c86_ins('vehicles', jsonb_build_object('plate', 'ZC86A' || suffix, 'carrier_id', carrier, 'site_id', site, 'type', 'CAMION', 'status', 'EN_OPERACION'));
  PERFORM pg_temp.c86_ins('vehicles', jsonb_build_object('plate', 'ZC86C' || suffix, 'carrier_id', carrier, 'site_id', site, 'type', 'CAMION', 'status', 'EN_OPERACION'));

  -- Ruta de hace dos días con corte diario; ruta en curso de hoy (no aparece)
  cut := pg_temp.c86_route('ZC86A' || suffix, site, client, now() - interval '2 days', 'EN RUTA');
  UPDATE public.dispatches SET status = 'CIERRE_OPERATIVO' WHERE id = cut;
  open_route := pg_temp.c86_route('ZC86C' || suffix, site, client, now(), 'EN RUTA');
  -- Ruta cerrada sin salida programada, si el esquema lo admite
  BEGIN
    undated := pg_temp.c86_route('ZC86B' || suffix, site, client, NULL, 'RETORNO_COMPLETADO');
  EXCEPTION WHEN OTHERS THEN undated := NULL;
  END;

  -- T1: aparecen las rutas cerradas con guía pendiente, no la ruta en curso
  PERFORM pg_temp.c86_user(actor);
  SELECT array_agg(x->>'id') INTO ids FROM jsonb_array_elements(public.get_documentary_pending_settlement(true, v_from, v_until)) x;
  IF NOT cut::text = ANY (COALESCE(ids, '{}')) OR open_route::text = ANY (COALESCE(ids, '{}'))
     OR (undated IS NOT NULL AND NOT undated::text = ANY (COALESCE(ids, '{}'))) THEN
    PERFORM pg_temp.c86_user(NULL);
    RAISE EXCEPTION 'CAJA C86 FAIL: bandeja pendiente (T1): corte %, en curso %, sin fecha %', cut::text = ANY (COALESCE(ids, '{}')),
      open_route::text = ANY (COALESCE(ids, '{}')), CASE WHEN undated IS NULL THEN 'n/a' ELSE (undated::text = ANY (COALESCE(ids, '{}')))::text END; END IF;
  PERFORM pg_temp.c86_user(NULL);

  -- T2: con la guía validada, la ruta sale de la liquidación pendiente
  SELECT transport_request_id INTO req FROM public.dispatch_requests WHERE dispatch_id = cut;
  INSERT INTO public.delivery_conformities(dispatch_id, request_id, state) VALUES (cut, req, 'VALIDADA')
    ON CONFLICT (dispatch_id, request_id) DO UPDATE SET state = 'VALIDADA';
  PERFORM pg_temp.c86_user(actor);
  SELECT array_agg(x->>'id') INTO ids FROM jsonb_array_elements(public.get_documentary_pending_settlement(true, v_from, v_until)) x;
  PERFORM pg_temp.c86_user(NULL);
  IF cut::text = ANY (COALESCE(ids, '{}')) THEN RAISE EXCEPTION 'CAJA C86 FAIL: ruta validada sigue pendiente (T2)'; END IF;

  -- T3: no expuesta a anónimos
  IF has_function_privilege('anon', 'public.get_documentary_pending_settlement(boolean,timestamptz,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'CAJA C86 FAIL: bandeja expuesta a anónimos (T3)'; END IF;

  RAISE EXCEPTION 'CAJA C86 PASS (3/3) liquidación pendiente: solo rutas con cierre operativo y guías sin validar%',
    CASE WHEN undated IS NULL THEN ' (salida programada obligatoria en este esquema)' ELSE ', también sin salida programada' END;
END $test$;
ROLLBACK;
