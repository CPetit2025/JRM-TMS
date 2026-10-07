-- CAJA C18 — Flota: SOAT y revisión técnica editables desde la ficha (renovación / corrección) y código interno automático
-- Se ejecuta dentro de un bloque que siempre se revierte: no deja datos.
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

-- Test-only temporary helpers: public execution defaults are intentionally revoked.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE
  v_user uuid; v_none uuid; v_role uuid; v_veh uuid; v_site uuid; v_new uuid; v_code text; v_next text;
  r jsonb; r_none jsonb; r2 jsonb; v_docs_antes bigint;
  v_fail text[] := '{}';
  v_pass int := 0;
BEGIN
  SELECT id, site_id INTO v_veh, v_site FROM public.vehicles WHERE site_id IS NOT NULL ORDER BY plate LIMIT 1;
  IF v_veh IS NULL THEN RAISE EXCEPTION 'CAJA C18 FAIL: no hay unidades con sede'; END IF;
  SELECT id INTO v_user FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  SELECT id INTO v_none FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id <> v_user ORDER BY id LIMIT 1;
  IF v_none IS NULL THEN RAISE EXCEPTION 'CAJA C18 FAIL: se requieren 2 perfiles'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C18 flota', '["mantenimiento-flota"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET role_id = v_role, is_active = true WHERE id = v_user;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C18 nada', '["ot"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET role_id = v_role, is_active = true WHERE id = v_none;
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_user, v_site), (v_none, v_site) ON CONFLICT DO NOTHING;
  -- Punto de partida conocido: un SOAT vigente al 31/03/2030
  UPDATE public.vehicle_documents SET is_active = false WHERE vehicle_id = v_veh AND document_type IN ('SOAT', 'REVISION_TECNICA');
  INSERT INTO public.vehicle_documents (vehicle_id, document_type, expiration_date, notes) VALUES (v_veh, 'SOAT', DATE '2030-03-31', 'ZZ C18');

  -- T1: sin permiso de flota no se edita
  PERFORM pg_temp.as_user(v_none);
  r_none := public.update_vehicle_compliance_dates(v_veh, DATE '2031-03-31', NULL);
  PERFORM pg_temp.as_user(NULL);
  IF NOT (r_none ->> 'success')::boolean THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 permiso: ' || r_none::text); END IF;

  -- T2: fecha posterior = renovación (nuevo documento; el anterior queda en el historial) y espejo actualizado; RT nueva
  PERFORM pg_temp.as_user(v_user);
  r := public.update_vehicle_compliance_dates(v_veh, DATE '2031-03-31', DATE '2030-12-15');
  PERFORM pg_temp.as_user(NULL);
  IF (r ->> 'success')::boolean AND (r ->> 'cambios')::int = 2
     AND (SELECT soat_expiration = DATE '2031-03-31' AND technical_review_expiration = DATE '2030-12-15' FROM public.vehicles WHERE id = v_veh)
     AND (SELECT count(*) FROM public.vehicle_documents WHERE vehicle_id = v_veh AND document_type = 'SOAT' AND is_active) = 1
     AND EXISTS (SELECT 1 FROM public.vehicle_documents WHERE vehicle_id = v_veh AND document_type = 'SOAT' AND NOT is_active AND notes = 'ZZ C18')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 renovación: ' || COALESCE(r::text, '∅')); END IF;

  -- T3: fecha anterior = corrección del documento vigente (sin documento nuevo; la unidad puede tener historial real)
  SELECT count(*) INTO v_docs_antes FROM public.vehicle_documents WHERE vehicle_id = v_veh AND document_type = 'SOAT';
  PERFORM pg_temp.as_user(v_user);
  r2 := public.update_vehicle_compliance_dates(v_veh, DATE '2031-02-28', NULL);
  PERFORM pg_temp.as_user(NULL);
  IF (r2 ->> 'success')::boolean
     AND (SELECT soat_expiration = DATE '2031-02-28' FROM public.vehicles WHERE id = v_veh)
     AND (SELECT count(*) FROM public.vehicle_documents WHERE vehicle_id = v_veh AND document_type = 'SOAT') = v_docs_antes
     AND (SELECT count(*) FROM public.vehicle_documents WHERE vehicle_id = v_veh AND document_type = 'SOAT' AND is_active) = 1
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 corrección: ' || COALESCE(r2::text, '∅')
    || ' docs ' || v_docs_antes || '→' || (SELECT count(*) FROM public.vehicle_documents WHERE vehicle_id = v_veh AND document_type = 'SOAT')); END IF;

  -- T4: código interno automático por tipo y normalización del ingresado
  v_next := public.next_vehicle_internal_code('TRACTO');
  INSERT INTO public.vehicles (plate, type, site_id, carrier_id)
  SELECT 'ZZC18A', 'TRACTO', site_id, carrier_id FROM public.vehicles WHERE id = v_veh RETURNING id, internal_code INTO v_new, v_code;
  INSERT INTO public.vehicles (plate, type, site_id, carrier_id, internal_code)
  SELECT 'ZZC18B', 'TRACTO', site_id, carrier_id, ' zz-18 ' FROM public.vehicles WHERE id = v_veh;
  IF v_code = v_next AND v_code ~ '^TRC-[0-9]{3,}$'
     AND public.next_vehicle_internal_code('TRACTO') <> v_code
     AND (SELECT internal_code = 'ZZ-18' FROM public.vehicles WHERE plate = 'ZZC18B')
     AND public.next_vehicle_internal_code('MONTACARGAS') ~ '^MTC-'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 código: ' || COALESCE(v_code, '∅') || ' / ' || COALESCE(v_next, '∅')); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C18 PASS (%/4)', v_pass;
  ELSE
    RAISE EXCEPTION 'CAJA C18 FAIL (%/4): %', v_pass, array_to_string(v_fail, ' || ');
  END IF;
END $test$;
