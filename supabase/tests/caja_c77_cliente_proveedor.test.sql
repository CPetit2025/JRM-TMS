-- CAJA C77 — Nada sin cliente o proveedor: OT con cliente obligatorio y heredado en su familia, entregas con cliente,
-- recojos/traslados con proveedor, no se programa una solicitud incompleta, y el cliente asignado no se quita.
-- Los controles son diferidos: la prueba los vuelve inmediatos para verlos. Bloque que siempre se revierte.
BEGIN;
CREATE FUNCTION pg_temp.c77_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE
  v_admin uuid; v_ot_user uuid; v_role uuid; v_site uuid; v_c1 uuid; v_c2 uuid; v_sup uuid;
  i int; v_root uuid; v_child uuid; v_legacy uuid; v_req uuid; v_free uuid; v_pick uuid; v_disp uuid; r jsonb; v_err text;
  suffix text := upper(substr(gen_random_uuid()::text, 1, 6));
BEGIN
  SELECT id INTO v_site FROM public.sites LIMIT 1;
  -- Clientes y proveedor propios de la prueba (la tabla de clientes difiere entre entornos: solo columnas existentes)
  FOR i IN 1..2 LOOP
    EXECUTE (SELECT format('INSERT INTO public.clients (%s) VALUES (%s) RETURNING id',
               string_agg(quote_ident(k.key), ', '), string_agg(quote_nullable(k.value #>> '{}'), ', '))
               FROM jsonb_each(jsonb_build_object('business_name', 'ZZ C77 Cliente ' || i || ' ' || suffix,
                 'tax_id', '2099' || i || lpad((random() * 999999)::int::text, 6, '0'), 'ruc', '2099' || i || lpad((random() * 999999)::int::text, 6, '0'), 'is_active', true, 'status', 'ACTIVO')) k
              WHERE EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'clients' AND c.column_name = k.key))
      INTO v_sup;
    IF i = 1 THEN v_c1 := v_sup; ELSE v_c2 := v_sup; END IF;
  END LOOP;
  INSERT INTO public.suppliers (tax_id, business_name) VALUES ('2098' || lpad((random() * 9999999)::int::text, 7, '0'), 'ZZ C77 Proveedor ' || suffix) RETURNING id INTO v_sup;
  IF v_site IS NULL OR NOT public.client_is_active(v_c2) THEN RAISE EXCEPTION 'CAJA C77 FAIL: faltan sede o clientes de prueba'; END IF;
  FOR v_admin IN SELECT id FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u) LOOP
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXIT WHEN public.is_tms_admin();
    v_admin := NULL;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  SELECT id INTO v_ot_user FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL)
    AND id IS DISTINCT FROM v_admin ORDER BY id LIMIT 1;
  IF v_admin IS NULL OR v_ot_user IS NULL THEN RAISE EXCEPTION 'CAJA C77 FAIL: faltan perfiles (administrador y usuario)'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C77 OT ' || suffix, '["ot:write","solicitudes:write"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET role_id = v_role, is_active = true WHERE id = v_ot_user;
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_ot_user, v_site), (v_admin, v_site) ON CONFLICT DO NOTHING;

  -- OT antigua sin cliente (queda pendiente, el control diferido aún no se evalúa) para completarla después
  INSERT INTO public.contracts (code, type, status, site_id) VALUES ('ZZ-C77-ANT-' || suffix, 'CONTRATO', 'ACTIVO', v_site) RETURNING id INTO v_legacy;
  -- Solicitud de entrega sin OT ni cliente y recojo sin proveedor (pendientes, como los registros antiguos)
  INSERT INTO public.transport_requests (request_number, status, site_id, requester_name, department, request_type, cargo_description,
    pickup_address, pickup_district, delivery_address, delivery_district, required_date)
  VALUES ('ZZ-C77-E-' || suffix, 'PENDIENTE', v_site, 'Prueba C77', 'Logística', 'DESPACHO', 'Carga', 'Planta', 'LURIN', 'Obra', 'ATE', current_date)
  RETURNING id INTO v_free;

  -- T1: la OT antigua se completa con permiso de Contratos y OTs y deja de estar pendiente al validar
  PERFORM pg_temp.c77_user(v_ot_user);
  r := public.set_contract_client(v_legacy, v_c1);
  -- T5 (preparación): la entrega sin OT se vincula a su cliente desde Solicitudes
  r := public.set_request_party(v_free, v_c1, NULL);
  PERFORM pg_temp.c77_user(NULL);
  SET CONSTRAINTS ALL IMMEDIATE;
  IF (SELECT client_id FROM public.contracts WHERE id = v_legacy) IS DISTINCT FROM v_c1 THEN
    RAISE EXCEPTION 'CAJA C77 FAIL: completar cliente de OT (T1)'; END IF;
  IF (SELECT client_id FROM public.transport_requests WHERE id = v_free) IS DISTINCT FROM v_c1 THEN
    RAISE EXCEPTION 'CAJA C77 FAIL: vincular cliente a entrega sin OT (T5)'; END IF;

  -- T2: OT madre sin cliente se rechaza
  BEGIN
    INSERT INTO public.contracts (code, type, status, site_id) VALUES ('ZZ-C77-SIN-' || suffix, 'CONTRATO', 'ACTIVO', v_site);
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err IS NULL OR v_err NOT LIKE '%necesita un cliente%' THEN RAISE EXCEPTION 'CAJA C77 FAIL: OT madre sin cliente (T2): %', v_err; END IF;

  -- T3: el subcontrato hereda el cliente de su OT raíz aunque no lo indique o indique otro
  INSERT INTO public.contracts (code, type, status, site_id, client_id) VALUES ('ZZ-C77-' || suffix, 'CONTRATO', 'ACTIVO', v_site, v_c1)
    RETURNING id INTO v_root;
  INSERT INTO public.contracts (code, type, status, site_id, parent_contract_id) VALUES ('ZZ-C77-' || suffix || '-S1', 'SUBCONTRATO', 'ACTIVO', v_site, v_root)
    RETURNING id INTO v_child;
  UPDATE public.contracts SET client_id = v_c2 WHERE id = v_child;
  IF (SELECT client_id FROM public.contracts WHERE id = v_child) IS DISTINCT FROM v_c1 THEN
    RAISE EXCEPTION 'CAJA C77 FAIL: subcontrato no hereda el cliente (T3)'; END IF;

  -- T4: la entrega con OT toma el cliente de la OT; el cliente de la OT no se puede quitar
  INSERT INTO public.transport_requests (request_number, status, site_id, contract_id, requester_name, department, request_type, cargo_description,
    pickup_address, pickup_district, delivery_address, delivery_district, required_date)
  VALUES ('ZZ-C77-R-' || suffix, 'PENDIENTE', v_site, v_child, 'Prueba C77', 'Logística', 'DESPACHO', 'Carga', 'Planta', 'LURIN', 'Obra', 'ATE', current_date)
  RETURNING id INTO v_req;
  IF (SELECT client_id FROM public.transport_requests WHERE id = v_req) IS DISTINCT FROM v_c1 THEN
    RAISE EXCEPTION 'CAJA C77 FAIL: la entrega no toma el cliente de la OT (T4)'; END IF;
  BEGIN UPDATE public.contracts SET client_id = NULL WHERE id = v_root; v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err IS NULL OR v_err NOT LIKE '%No se puede quitar el cliente%' THEN RAISE EXCEPTION 'CAJA C77 FAIL: se quitó el cliente (T4): %', v_err; END IF;

  -- T5: entrega sin OT y sin cliente se rechaza
  BEGIN
    INSERT INTO public.transport_requests (request_number, status, site_id, requester_name, department, request_type, cargo_description,
      pickup_address, pickup_district, delivery_address, delivery_district, required_date)
    VALUES ('ZZ-C77-X-' || suffix, 'PENDIENTE', v_site, 'Prueba C77', 'Logística', 'DESPACHO', 'Carga', 'Planta', 'LURIN', 'Obra', 'ATE', current_date);
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err IS NULL OR v_err NOT LIKE '%Seleccione el cliente%' THEN RAISE EXCEPTION 'CAJA C77 FAIL: entrega sin cliente (T5): %', v_err; END IF;

  -- T6: solo el Administrador cambia un cliente ya asignado, y el cambio llega a la familia y a sus solicitudes
  PERFORM pg_temp.c77_user(v_ot_user);
  BEGIN PERFORM public.set_contract_client(v_child, v_c2); v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err IS NULL OR v_err NOT LIKE '%solo el Administrador%' THEN RAISE EXCEPTION 'CAJA C77 FAIL: usuario cambia cliente (T6): %', v_err; END IF;
  BEGIN UPDATE public.contracts SET client_id = v_c2 WHERE id = v_root; v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  -- Rechazado por el control o filtrado por la RLS: en ambos casos el cliente sigue igual (se verifica sin RLS)
  PERFORM pg_temp.c77_user(NULL);
  IF v_err IS NULL AND (SELECT client_id FROM public.contracts WHERE id = v_root) IS DISTINCT FROM v_c1 THEN
    RAISE EXCEPTION 'CAJA C77 FAIL: usuario cambia cliente por actualización directa (T6)'; END IF;
  PERFORM pg_temp.c77_user(v_admin);
  r := public.set_contract_client(v_child, v_c2);
  PERFORM pg_temp.c77_user(NULL);
  IF (SELECT client_id FROM public.contracts WHERE id = v_root) IS DISTINCT FROM v_c2
     OR (SELECT client_id FROM public.contracts WHERE id = v_child) IS DISTINCT FROM v_c2
     OR (SELECT client_id FROM public.transport_requests WHERE id = v_req) IS DISTINCT FROM v_c2 THEN
    RAISE EXCEPTION 'CAJA C77 FAIL: el cambio del Administrador no se propaga (T6): % raíz=% sub=% sol=%', r, (SELECT client_id = v_c2 FROM public.contracts WHERE id = v_root), (SELECT client_id = v_c2 FROM public.contracts WHERE id = v_child), (SELECT client_id = v_c2 FROM public.transport_requests WHERE id = v_req); END IF;

  -- T7: recojo sin proveedor no se registra; con proveedor sí, y set_request_party no cambia un proveedor ajeno
  BEGIN
    INSERT INTO public.transport_requests (request_number, status, site_id, requester_name, department, request_type, cargo_description,
      pickup_address, pickup_district, delivery_address, delivery_district, required_date)
    VALUES ('ZZ-C77-P-' || suffix, 'PENDIENTE', v_site, 'Prueba C77', 'Logística', 'RECOJO', 'Carga', 'Proveedor', 'LURIN', 'Planta', 'ATE', current_date);
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err IS NULL THEN RAISE EXCEPTION 'CAJA C77 FAIL: recojo sin proveedor (T7)'; END IF;
  SET CONSTRAINTS ALL DEFERRED;
  INSERT INTO public.transport_requests (request_number, status, site_id, requester_name, department, request_type, cargo_description,
    pickup_address, pickup_district, delivery_address, delivery_district, required_date)
  VALUES ('ZZ-C77-P-' || suffix, 'PENDIENTE', v_site, 'Prueba C77', 'Logística', 'RECOJO', 'Carga', 'Proveedor', 'LURIN', 'Planta', 'ATE', current_date)
  RETURNING id INTO v_pick;
  IF public.request_party_missing(v_pick) IS DISTINCT FROM 'PROVEEDOR' THEN RAISE EXCEPTION 'CAJA C77 FAIL: pendiente de proveedor (T7)'; END IF;

  -- T8: una solicitud sin proveedor no entra a una ruta
  EXECUTE (SELECT format('INSERT INTO public.dispatches (%s) VALUES (%s) RETURNING id',
             string_agg(quote_ident(k.key), ', '), string_agg(quote_nullable(k.value #>> '{}'), ', '))
             FROM jsonb_each(jsonb_build_object('dispatch_number', 'ZZ-C77-D-' || suffix, 'vehicle_plate', 'ZC77' || substr(suffix, 1, 3),
               'status', 'PROGRAMADO', 'site_id', v_site, 'scheduled_date', current_date, 'scheduled_departure', now())) k
            WHERE EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'dispatches' AND c.column_name = k.key))
    INTO v_disp;
  BEGIN
    INSERT INTO public.dispatch_requests (dispatch_id, transport_request_id, status) VALUES (v_disp, v_pick, 'PROGRAMADO');
    SET CONSTRAINTS dispatch_requests_party IMMEDIATE;
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err IS NULL OR v_err NOT LIKE '%no tiene proveedor%' THEN RAISE EXCEPTION 'CAJA C77 FAIL: se programó sin proveedor (T8): %', v_err; END IF;
  PERFORM pg_temp.c77_user(v_ot_user);
  r := public.set_request_party(v_pick, NULL, v_sup);
  PERFORM pg_temp.c77_user(NULL);
  INSERT INTO public.dispatch_requests (dispatch_id, transport_request_id, status) VALUES (v_disp, v_pick, 'PROGRAMADO');
  SET CONSTRAINTS ALL IMMEDIATE;
  IF public.request_party_missing(v_pick) IS NOT NULL THEN RAISE EXCEPTION 'CAJA C77 FAIL: proveedor vinculado (T8)'; END IF;

  -- T9: una solicitud con OT no se vincula a otro cliente desde Solicitudes
  PERFORM pg_temp.c77_user(v_ot_user);
  BEGIN PERFORM public.set_request_party(v_req, v_c1, NULL); v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  PERFORM pg_temp.c77_user(NULL);
  IF v_err IS NULL OR v_err NOT LIKE '%toma el cliente de su OT%' THEN RAISE EXCEPTION 'CAJA C77 FAIL: cliente de solicitud con OT (T9): %', v_err; END IF;

  -- T10: funciones cerradas a anónimos
  IF has_function_privilege('anon', 'public.set_contract_client(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_request_party(uuid,uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.enforce_contract_client()', 'EXECUTE') THEN
    RAISE EXCEPTION 'CAJA C77 FAIL: funciones expuestas (T10)'; END IF;

  RAISE EXCEPTION 'CAJA C77 PASS (10/10) nada sin cliente o proveedor: OT, familia, entregas, recojos y programación';
END $test$;
ROLLBACK;
