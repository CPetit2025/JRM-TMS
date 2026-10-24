-- CAJA C150 — Lista de Contratos en una sola pasada (contracts_dashboard_list): la OT madre aparece con sus
-- subcontratos, errores, solicitudes, cliente y partida de la familia; los hijos no aparecen como filas; sin sesión no
-- devuelve datos. Siempre se revierte (termina en error a propósito).
BEGIN;
DO $test$
DECLARE admin_id uuid; v_site uuid; v_cli uuid; v_madre uuid; v_sub uuid; ot text; res jsonb; r jsonb; pass int := 0; fails text[] := '{}';
BEGIN
  SELECT p.id INTO admin_id FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id
   WHERE p.is_active AND ro.name = 'Administrador' AND p.id IN (SELECT id FROM auth.users) ORDER BY p.created_at LIMIT 1;
  IF admin_id IS NULL THEN RAISE EXCEPTION 'CAJA C150 FAIL: falta un Administrador activo'; END IF;

  -- T1 sin sesión: no devuelve datos
  res := public.contracts_dashboard_list();
  IF (res->>'success')::boolean IS DISTINCT FROM false OR res ? 'filas' THEN fails := fails || ('T1 sin sesión: ' || left(res::text, 200));
  ELSE pass := pass + 1; END IF;

  PERFORM set_config('request.jwt.claim.sub', admin_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  SELECT site_id INTO v_site FROM public.contracts WHERE site_id IS NOT NULL AND parent_contract_id IS NULL LIMIT 1;
  SELECT client_id INTO v_cli FROM public.contracts WHERE client_id IS NOT NULL AND parent_contract_id IS NULL LIMIT 1;
  LOOP ot := (90000 + floor(random() * 9999))::int::text; EXIT WHEN NOT EXISTS (SELECT 1 FROM public.contracts WHERE code LIKE ot || '%'); END LOOP;
  INSERT INTO public.contracts (code, type, status, site_id, client_id) VALUES (ot, 'CONTRATO', 'ACTIVO', v_site, v_cli) RETURNING id INTO v_madre;
  INSERT INTO public.contracts (code, type, status, site_id, parent_contract_id) VALUES (ot || '-S001', 'SUBCONTRATO', 'ACTIVO', v_site, v_madre) RETURNING id INTO v_sub;
  INSERT INTO public.contracts (code, type, status, site_id, parent_contract_id) VALUES (ot || '-E001', 'ERROR', 'ACTIVO', v_site, v_madre);

  -- T2 la madre aparece con sus conteos y su cliente; los hijos no son filas
  res := public.contracts_dashboard_list();
  SELECT x INTO r FROM jsonb_array_elements(res->'filas') x WHERE x->>'id' = v_madre::text;
  IF (res->>'success')::boolean AND r IS NOT NULL AND (r->>'subcontracts_count')::int = 1 AND (r->>'errors_count')::int = 1
     AND (r->>'requests_count')::int = 0 AND r->>'client_name' IS NOT DISTINCT FROM (SELECT business_name FROM public.clients WHERE id = v_cli)
     AND r ? 'family_reserved_pen' AND r ? 'allocated_pen'
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(res->'filas') x WHERE x->>'id' = v_sub::text)
  THEN pass := pass + 1; ELSE fails := fails || ('T2 lista: ' || COALESCE(r::text, 'sin fila') || ' ' || left(COALESCE(res->>'error', ''), 200)); END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C150 FAIL (%/2): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C150 PASS (%/2) Lista de Contratos en una sola pasada con conteos, cliente y partida de la familia', pass;
END $test$;
ROLLBACK;
