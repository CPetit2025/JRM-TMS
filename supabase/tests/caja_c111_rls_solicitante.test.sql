-- CAJA C111 — RLS del «Solicitante de Transporte» (Administración de Contratos, Logística, Almacén y otras áreas).
-- Con una cuenta real de la web y ese rol se comprueba, con las políticas de producción:
--   ve todas las solicitudes y OT de su sede; no ve otros perfiles ni se cambia rol o estado; no lee Caja ni el
--   historial de roles; una cuenta pendiente (inactiva) no ve nada. Además informa qué tablas lee con datos.
-- Bloque que siempre se revierte: no deja datos.
BEGIN;
CREATE FUNCTION pg_temp.c111_as(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE
  v_user uuid; v_role uuid; v_admin_role uuid; v_site uuid; v_rows int; v_err text; n bigint; t record;
  total_req bigint; seen_req bigint; total_ot bigint; seen_ot bigint; r jsonb;
  sensitive text[] := ARRAY['cash_boxes','cash_movements','cash_box_closures','trip_advances','trip_settlements',
    'dispatch_expenses','dispatch_expense_events','fuel_station_invoices','lease_settlements','role_permission_changes'];
  owned text[] := '{}'; readable text[] := '{}'; leaks text[] := '{}'; fails text[] := '{}'; pass int := 0;
BEGIN
  SELECT id INTO v_role FROM public.roles WHERE lower(btrim(name)) = 'solicitante de transporte';
  SELECT id INTO v_admin_role FROM public.roles WHERE name = 'Administrador';
  SELECT id INTO v_site FROM public.sites WHERE code = 'PRINCIPAL';
  -- Cuenta web real (con autenticación, sin conductor vinculado)
  SELECT id INTO v_user FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT d.profile_id FROM public.drivers d WHERE d.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  IF v_role IS NULL OR v_user IS NULL OR v_site IS NULL THEN RAISE EXCEPTION 'CAJA C111 FAIL: falta rol, perfil o sede'; END IF;
  UPDATE public.profiles SET role_id = v_role, is_active = true WHERE id = v_user;
  INSERT INTO public.user_site_access(user_id, site_id) VALUES (v_user, v_site) ON CONFLICT DO NOTHING;

  -- Lo que existe en sus sedes (sin RLS) y las tablas sensibles con datos
  SELECT count(*) INTO total_req FROM public.transport_requests WHERE site_id IN (SELECT a.site_id FROM public.user_site_access a WHERE a.user_id = v_user);
  SELECT count(*) INTO total_ot FROM public.contracts WHERE status = 'ACTIVO' AND site_id IN (SELECT a.site_id FROM public.user_site_access a WHERE a.user_id = v_user);
  FOREACH v_err IN ARRAY sensitive LOOP
    IF to_regclass('public.' || v_err) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM (SELECT 1 FROM public.%I LIMIT 1) x', v_err) INTO n;
      IF n > 0 THEN owned := owned || v_err; END IF;
    END IF;
  END LOOP;

  PERFORM pg_temp.c111_as(v_user);
  SELECT count(*) INTO seen_req FROM public.transport_requests;
  SELECT count(*) INTO seen_ot FROM public.contracts WHERE status = 'ACTIVO';

  -- T1: visión general — todas las solicitudes de su sede, no solo las propias
  IF seen_req >= total_req THEN pass := pass + 1; ELSE fails := fails || format('T1 solicitudes %s de %s', seen_req, total_req); END IF;
  -- T2: todas las OT activas de su sede para elegir en la Nueva solicitud
  IF seen_ot >= total_ot THEN pass := pass + 1; ELSE fails := fails || format('T2 OT %s de %s', seen_ot, total_ot); END IF;

  -- T3: no ve otros perfiles
  SELECT count(*) INTO n FROM public.profiles WHERE id <> v_user;
  IF n = 0 THEN pass := pass + 1; ELSE fails := fails || format('T3 ve %s perfiles ajenos', n); END IF;

  -- T4: no se da rol de administrador, no cambia su estado ni se agrega sedes
  v_rows := 0;
  BEGIN UPDATE public.profiles SET role_id = v_admin_role WHERE id = v_user; GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN v_rows := 0; END;
  IF v_rows = 0 THEN
    BEGIN INSERT INTO public.user_site_access(user_id, site_id) SELECT v_user, s.id FROM public.sites s WHERE s.id <> v_site; GET DIAGNOSTICS v_rows = ROW_COUNT;
    EXCEPTION WHEN OTHERS THEN v_rows := 0; END;
  END IF;
  IF v_rows = 0 THEN pass := pass + 1; ELSE fails := fails || 'T4 se modificó su rol o sus sedes'::text; END IF;

  -- T5: no lee Caja, gastos de viaje, alquileres ni el historial de roles
  FOREACH v_err IN ARRAY owned LOOP
    BEGIN EXECUTE format('SELECT count(*) FROM (SELECT 1 FROM public.%I LIMIT 1) x', v_err) INTO n;
    EXCEPTION WHEN OTHERS THEN n := 0; END;
    IF n > 0 THEN leaks := leaks || v_err; END IF;
  END LOOP;
  IF cardinality(leaks) = 0 THEN pass := pass + 1; ELSE fails := fails || ('T5 lee ' || array_to_string(leaks, ', ')); END IF;

  -- T6: el menú no le muestra registros pendientes de Usuarios ni pendientes de Caja
  r := public.menu_pending_counts();
  IF NOT COALESCE(r->'counts' ?| ARRAY['/usuarios','/caja/aprobaciones','/caja/anticipos'], false) THEN pass := pass + 1;
  ELSE fails := fails || ('T6 menú ' || (r->'counts')::text); END IF;

  -- Informe: tablas que lee con datos (para revisar a mano, no falla)
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
           WHERE s.nspname = 'public' AND c.relkind IN ('r','p') AND has_table_privilege('authenticated', c.oid, 'SELECT') ORDER BY c.relname LOOP
    BEGIN EXECUTE format('SELECT count(*) FROM (SELECT 1 FROM public.%I LIMIT 1) x', t.relname) INTO n;
    EXCEPTION WHEN OTHERS THEN n := 0; END;
    IF n > 0 THEN readable := readable || t.relname::text; END IF;
  END LOOP;
  PERFORM pg_temp.c111_as(NULL);

  -- T7: una cuenta pendiente de aprobación (inactiva) no ve solicitudes ni OT
  UPDATE public.profiles SET is_active = false WHERE id = v_user;
  PERFORM pg_temp.c111_as(v_user);
  SELECT count(*) INTO seen_req FROM public.transport_requests;
  SELECT count(*) INTO seen_ot FROM public.contracts;
  PERFORM pg_temp.c111_as(NULL);
  IF seen_req = 0 AND seen_ot = 0 THEN pass := pass + 1; ELSE fails := fails || format('T7 inactiva ve %s solicitudes y %s OT', seen_req, seen_ot); END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C111 FAIL (%/7): % || lee con datos (%): %', pass, array_to_string(fails, ' | '),
    cardinality(readable), left(array_to_string(readable, ', '), 1500); END IF;
  RAISE EXCEPTION 'CAJA C111 PASS (7/7) RLS del solicitante: % solicitudes y % OT de su sede; sensibles verificadas: %; lee con datos (%): %',
    total_req, total_ot, COALESCE(NULLIF(array_to_string(owned, ', '), ''), 'ninguna con datos'), cardinality(readable), left(array_to_string(readable, ', '), 1800);
END $test$;
ROLLBACK;
