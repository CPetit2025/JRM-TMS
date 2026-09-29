-- Pruebas C12 — Solicitudes: descarga declarada (Sí/No) y memoria de solicitudes anteriores por destino/cliente/OT.
-- Termina en error para forzar ROLLBACK: "CAJA C12 PASS/FAIL".
--   npx supabase db query --linked -f supabase/tests/caja_c12_descarga_memoria.test.sql
BEGIN;

CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

DO $test$
DECLARE
  v_user uuid; v_role uuid; v_site uuid; cl1 uuid; cl2 uuid; ca uuid; cb uuid; cc uuid;
  r1 uuid; r2 uuid; r3 uuid; r4 uuid;
  v_fail text[] := '{}';
  v_pass int := 0;
  h jsonb; r jsonb;
BEGIN
  SELECT site_id INTO v_site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
  SELECT id INTO v_user FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  IF v_user IS NULL THEN RAISE EXCEPTION 'CAJA C12 FAIL: se requiere un perfil'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ Solicitudes C12', '["solicitudes"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET role_id = v_role, is_active = true WHERE id = v_user;
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_user, v_site) ON CONFLICT DO NOTHING;
  INSERT INTO public.clients (business_name, tax_id, address, contact_name, phone, email, is_active) VALUES
    ('ZZ C12 Cliente Uno', '20999999922', 'x', 'x', 'x', 'x', true) RETURNING id INTO cl1;
  INSERT INTO public.clients (business_name, tax_id, address, contact_name, phone, email, is_active) VALUES
    ('ZZ C12 Cliente Dos', '20999999914', 'x', 'x', 'x', 'x', true) RETURNING id INTO cl2;
  INSERT INTO public.contracts (code, type, status, site_id, client_id) VALUES ('ZZ-C12-A', 'CONTRATO', 'ACTIVO', v_site, cl1) RETURNING id INTO ca;
  INSERT INTO public.contracts (code, type, status, site_id, client_id) VALUES ('ZZ-C12-B', 'CONTRATO', 'ACTIVO', v_site, cl1) RETURNING id INTO cb;
  INSERT INTO public.contracts (code, type, status, site_id, client_id) VALUES ('ZZ-C12-C', 'CONTRATO', 'ACTIVO', v_site, cl2) RETURNING id INTO cc;
  INSERT INTO public.contract_budgets (contract_id, concept, allocated_pen) VALUES (ca, 'PARTIDA_TRANSPORTE', 5000), (cb, 'PARTIDA_TRANSPORTE', 5000), (cc, 'PARTIDA_TRANSPORTE', 5000);
  INSERT INTO public.transport_requests (request_number, status, site_id, contract_id, service_cost, requester_name, department, request_type, cargo_description, pickup_address, pickup_district, delivery_address, delivery_district, required_date) VALUES
    ('ZZ-C12-R1', 'PENDIENTE DE APROBACIÓN', v_site, ca, 100, 'ZZ', 'Logística', 'DESPACHO', 'Carga', 'Planta', 'Lurín', 'Av. Los Pinos 123', 'Ate', current_date),
    ('ZZ-C12-R2', 'PENDIENTE DE APROBACIÓN', v_site, cb, 100, 'ZZ', 'Logística', 'DESPACHO', 'Carga', 'Planta', 'Lurín', 'AV LOS PINOS 123', 'ATE', current_date),
    ('ZZ-C12-R3', 'PENDIENTE DE APROBACIÓN', v_site, cc, 100, 'ZZ', 'Logística', 'DESPACHO', 'Carga', 'Planta', 'Lurín', 'Av. Los Pinos 123', 'Ate', current_date),
    ('ZZ-C12-R4', 'PENDIENTE DE APROBACIÓN', v_site, ca, 100, 'ZZ', 'Logística', 'DESPACHO', 'Carga', 'Planta', 'Lurín', 'Jr. Otro 9', 'Surco', current_date);
  SELECT id INTO r1 FROM public.transport_requests WHERE request_number = 'ZZ-C12-R1';
  SELECT id INTO r2 FROM public.transport_requests WHERE request_number = 'ZZ-C12-R2';
  SELECT id INTO r3 FROM public.transport_requests WHERE request_number = 'ZZ-C12-R3';
  SELECT id INTO r4 FROM public.transport_requests WHERE request_number = 'ZZ-C12-R4';

  -- T1: Sí con montacargas; Sí con grúa aún sin cotizar (monto 0 se guarda); No deja la respuesta en falso
  PERFORM pg_temp.as_user(v_user);
  r := public.save_request_unloading_costs(r1, '[{"concept":"MONTACARGAS","estimated_pen":200,"description":"Descarga en patio"}]');
  PERFORM public.save_request_unloading_costs(r3, '[{"concept":"ESTIBA","estimated_pen":80}]');
  PERFORM public.save_request_unloading_costs(r4, '[{"concept":"GRUA","estimated_pen":0}]');
  PERFORM public.save_request_unloading_costs(r2, '[]');
  PERFORM pg_temp.as_user(NULL);
  IF (r->>'success')::boolean
     AND (SELECT unloading_required AND unloading_estimate_pen = 200 FROM public.transport_requests WHERE id = r1)
     AND (SELECT NOT unloading_required FROM public.transport_requests WHERE id = r2)
     AND (SELECT unloading_required FROM public.transport_requests WHERE id = r4)
     AND EXISTS (SELECT 1 FROM public.transport_unloading_costs WHERE transport_request_id = r4 AND concept = 'GRUA' AND estimated_pen = 0)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 respuesta: ' || COALESCE(r::text, '∅')); END IF;

  -- T2: nueva solicitud del cliente 1 en OT B al mismo destino (escrito distinto): ve R1 (montacargas) y R2 (sin descarga),
  --     no ve la del otro cliente; la misma OT A a otro destino aparece después (menor coincidencia)
  PERFORM pg_temp.as_user(v_user);
  h := public.get_unloading_history(cb, 'ate', 'av. los pinos, 123', NULL);
  PERFORM pg_temp.as_user(NULL);
  IF jsonb_array_length(h) = 2
     AND (SELECT bool_and((e->>'score')::int = 3) FROM jsonb_array_elements(h) e)
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(h) e WHERE e->>'request_number' = 'ZZ-C12-R1'
                 AND e->'lines'->0->>'concept' = 'MONTACARGAS' AND (e->>'unloading_required')::boolean)
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(h) e WHERE e->>'request_number' = 'ZZ-C12-R2' AND NOT (e->>'unloading_required')::boolean)
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(h) e WHERE e->>'request_number' = 'ZZ-C12-R3')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 memoria destino: ' || COALESCE(h::text, '∅')); END IF;

  PERFORM pg_temp.as_user(v_user);
  h := public.get_unloading_history(ca, 'Ate', 'Av. Los Pinos 123', r1);
  PERFORM pg_temp.as_user(NULL);
  IF h->0->>'request_number' = 'ZZ-C12-R2' AND h->-1->>'request_number' = 'ZZ-C12-R4' AND (h->-1->>'score')::int = 1
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(h) e WHERE e->>'request_number' IN ('ZZ-C12-R1', 'ZZ-C12-R3'))
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 memoria OT: ' || COALESCE(h::text, '∅')); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C12 PASS (%/3)', v_pass;
  END IF;
  RAISE EXCEPTION 'CAJA C12 FAIL: %', array_to_string(v_fail, ' || ');
END $test$;

ROLLBACK;
