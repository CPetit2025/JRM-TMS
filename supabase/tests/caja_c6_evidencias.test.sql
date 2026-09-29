-- Pruebas C6 — Evidencias del app del conductor visibles en la web (despacho y unidad).
-- Termina siempre en error para forzar ROLLBACK: "CAJA C6 PASS (...)" o "CAJA C6 FAIL: ...".
--   npx supabase db query --linked -f supabase/tests/caja_c6_evidencias.test.sql
BEGIN;

CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

DO $test$
DECLARE
  v_admin uuid; v_desp uuid; v_mant uuid; v_nobody uuid;
  v_role_d uuid; v_role_m uuid; v_site uuid; v_carrier uuid; t1 uuid;
  v_fail text[] := '{}';
  v_pass int := 0;
  v_txt text; v_n int; v_m int; v_b boolean; v_b2 boolean;
BEGIN
  SELECT carrier_id, site_id INTO v_carrier, v_site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
  FOR v_admin IN SELECT id FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u) LOOP
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXIT WHEN public.is_tms_admin();
    v_admin := NULL;
  END LOOP;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'CAJA C6 FAIL: no hay administrador'; END IF;
  SELECT id INTO v_desp FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id <> v_admin ORDER BY id LIMIT 1;
  SELECT id INTO v_mant FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_desp) ORDER BY id LIMIT 1;
  SELECT id INTO v_nobody FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_desp, v_mant) ORDER BY id LIMIT 1;
  IF v_nobody IS NULL THEN RAISE EXCEPTION 'CAJA C6 FAIL: se requieren 4 perfiles'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ Despacho lectura', '["despacho:read"]') RETURNING id INTO v_role_d;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ Mantenimiento fallas', '["mantenimiento-fallas:read"]') RETURNING id INTO v_role_m;
  UPDATE public.profiles SET role_id = v_role_d, is_active = true WHERE id = v_desp;
  UPDATE public.profiles SET role_id = v_role_m, is_active = true WHERE id = v_mant;
  UPDATE public.profiles SET role_id = NULL, is_active = true WHERE id = v_nobody;
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_desp, v_site), (v_mant, v_site) ON CONFLICT DO NOTHING;
  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, status, current_odometer) VALUES ('ZZC6A', v_carrier, v_site, 'TRACTO', 'DISPONIBLE', 100);
  INSERT INTO public.dispatches (dispatch_number, vehicle_plate, status, site_id) VALUES ('ZZ-C6-001', 'ZZC6A', 'ENTREGADO', v_site) RETURNING id INTO t1;
  UPDATE public.dispatches SET liquidation_data = '{"guias": ["u/zz/guias/g1.pdf", "u/zz/guias/g2.jpg"]}' WHERE id = t1;
  INSERT INTO public.route_stops_log (dispatch_id, stop_type, odometer_km, photo_url) VALUES (t1, 'ENTREGA', 10, 'u/zz/entrega.jpg');
  -- driver_checklists no se inserta aquí: en producción exige GPS en geocerca y la foto real en storage
  INSERT INTO public.vehicle_odometer_logs (vehicle_plate, dispatch_id, odometer_value, photo_url, source_event) VALUES ('ZZC6A', t1, 120, 'u/zz/odo.jpg', 'FIN_RUTA');
  INSERT INTO public.maintenance_requests (vehicle_plate, dispatch_id, description, severity, photo_url, audio_url, evidence)
  VALUES ('ZZC6A', t1, 'Ruido en frenos', 'MEDIA', 'u/zz/falla.jpg', 'u/zz/falla.webm', '["u/zz/falla2.jpg"]');

  -- T1: permiso de lectura de evidencias por rol
  PERFORM pg_temp.as_user(v_desp);  v_b := public.can_view_driver_evidence();
  PERFORM pg_temp.as_user(v_nobody); v_b2 := public.can_view_driver_evidence();
  PERFORM pg_temp.as_user(NULL);
  IF v_b AND NOT v_b2 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 permiso: desp=' || v_b || ' tercero=' || v_b2); END IF;

  -- T2: el despacho reúne entrega, guías, odómetro y la falla (foto, audio y fotos extra)
  PERFORM pg_temp.as_user(v_desp);
  SELECT count(*), string_agg(DISTINCT kind, ',' ORDER BY kind) INTO v_n, v_txt FROM public.get_dispatch_evidence(t1);
  PERFORM pg_temp.as_user(v_nobody);
  SELECT count(*) INTO v_m FROM public.get_dispatch_evidence(t1);
  PERFORM pg_temp.as_user(NULL);
  IF v_n = 7 AND v_txt = 'ENTREGA,FALLA,GUIA,ODOMETRO' AND v_m = 0
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 despacho: n=' || v_n || ' ' || COALESCE(v_txt, '∅') || ' tercero=' || v_m); END IF;

  -- T3: la ficha de la unidad muestra las evidencias a Mantenimiento
  PERFORM pg_temp.as_user(v_mant);
  SELECT count(*) FILTER (WHERE kind = 'FALLA'), count(*) INTO v_n, v_m FROM public.get_vehicle_evidence('zzc6a');
  PERFORM pg_temp.as_user(NULL);
  IF v_n = 3 AND v_m = 4 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 unidad: fallas=' || v_n || ' total=' || v_m); END IF;

  -- T4: el bucket admite PDF y audio
  IF (SELECT allowed_mime_types IS NULL OR ('application/pdf' = ANY (allowed_mime_types) AND 'audio/webm' = ANY (allowed_mime_types))
      FROM storage.buckets WHERE id = 'driver_evidence')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || text 'T4 tipos del bucket'; END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C6 PASS (%/4)', v_pass;
  END IF;
  RAISE EXCEPTION 'CAJA C6 FAIL: %', array_to_string(v_fail, ' || ');
END $test$;

ROLLBACK;
