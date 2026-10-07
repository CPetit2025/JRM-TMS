-- CAJA C38 — Servicios de contrato: peso (TON) desde la SALIDA cargada en APT.
--   T1 al registrar un servicio con guías se calcula el peso de las encontradas y se listan las que faltan;
--   T2 la guía se reconoce con o sin ceros y solo por número; T3 al cambiar la guía se recalcula y no se toca la
--   descripción/KG escrita a mano; T4 sin guía no queda peso; T5 al aplicar una carga de APT se recalculan los servicios;
--   T6 el botón exige permiso sobre servicios de contrato. Solo lectura (se revierte).
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
  v_up uuid; v_up2 uuid; v_ct uuid; v_srv uuid; v_u uuid; r_nada uuid; p record; a jsonb; n int;
  v_fail text[] := '{}'; v_pass int := 0; v_rep text;
  g1 text := 'T9Z9-00000123'; g2 text := 'T9Z9-00000124';
BEGIN
  SELECT id INTO v_ct FROM public.contracts ORDER BY code LIMIT 1;
  IF v_ct IS NULL THEN RAISE EXCEPTION 'CAJA C38 FAIL (0/6): no hay contratos'; END IF;
  INSERT INTO public.apt_uploads (file_name, status) VALUES ('ZZ C38', 'APLICADA') RETURNING id INTO v_up;
  INSERT INTO public.apt_movements (upload_id, kind, row_no, raw, active, valid, documento, peso_kg)
  VALUES (v_up, 'SALIDA', 900001, '{}', true, true, g1, 1500), (v_up, 'SALIDA', 900002, '{}', true, true, g1, 500),
         (v_up, 'SALIDA', 900003, '{}', true, true, g2, 1000);

  -- T1
  INSERT INTO public.contract_services (contract_id, service_type, description, amount_pen, referral_guide)
  VALUES (v_ct, 'FLETE', '9999', 1, 'T9Z9-123, T9Z9-00000124, T9Z9-999') RETURNING id INTO v_srv;
  SELECT * INTO p FROM public.contract_service_peso_apt WHERE service_id = v_srv;
  IF p.kg = 3000 AND p.encontradas = 2 AND p.faltan = 'T9Z9-999' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T1 peso: ' || COALESCE(p.kg::text, 'null') || ' / ' || COALESCE(p.faltan, '-')); END IF;

  -- T2 (solo número y forma con ceros)
  IF (SELECT kg FROM public.apt_guias_peso('t9z9-0124')) = 1000 AND (SELECT encontradas FROM public.apt_guias_peso('T9Z9-00000123;T9Z9-124')) = 2
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T2 formatos de guía'::text; END IF;

  -- T3
  UPDATE public.contract_services SET referral_guide = g1 WHERE id = v_srv;
  SELECT * INTO p FROM public.contract_service_peso_apt WHERE service_id = v_srv;
  IF p.kg = 2000 AND p.faltan IS NULL AND (SELECT description FROM public.contract_services WHERE id = v_srv) = '9999'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 recalcular: ' || COALESCE(p.kg::text, 'null')); END IF;

  -- T4
  UPDATE public.contract_services SET referral_guide = NULL WHERE id = v_srv;
  IF NOT EXISTS (SELECT 1 FROM public.contract_service_peso_apt WHERE service_id = v_srv) THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || 'T4 sin guía'::text; END IF;

  -- T5 (guía que aún no está en APT; luego se aplica una carga que la trae y corre la actualización horaria)
  UPDATE public.contract_services SET referral_guide = 'T9Z9-125' WHERE id = v_srv;
  INSERT INTO public.apt_uploads (file_name, status) VALUES ('ZZ C38 b', 'CARGANDO') RETURNING id INTO v_up2;
  INSERT INTO public.apt_movements (upload_id, kind, row_no, raw, active, valid, documento, peso_kg)
  VALUES (v_up2, 'SALIDA', 900004, '{}', true, true, 'T9Z9-00000125', 750);
  n := (SELECT encontradas FROM public.contract_service_peso_apt WHERE service_id = v_srv);
  UPDATE public.apt_uploads SET status = 'APLICADA' WHERE id = v_up2;
  PERFORM public.servicios_sync_peso_apt(NULL);   -- lo hace el cron cada hora (o el botón «Actualizar peso»)
  SELECT * INTO p FROM public.contract_service_peso_apt WHERE service_id = v_srv;
  IF n = 0 AND p.kg = 750 AND p.encontradas = 1 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T5 carga APT: antes ' || n || ', después ' || COALESCE(p.kg::text, 'null')); END IF;

  -- T6
  SELECT id INTO v_u FROM public.profiles WHERE id IN (SELECT id FROM auth.users)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C38 nada', '["apt"]') RETURNING id INTO r_nada;
  UPDATE public.profiles SET role_id = r_nada, is_active = true WHERE id = v_u;
  PERFORM pg_temp.as_user(v_u); a := public.servicios_actualizar_peso_apt(); PERFORM pg_temp.as_user(NULL);
  IF NOT (a ->> 'success')::boolean AND (public.servicios_sync_peso_apt(NULL) ->> 'success')::boolean THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || 'T6 permiso'::text; END IF;

  SELECT 'servicios con guía ' || count(*) || ', con peso ' || count(kg) || ', con guías no encontradas ' || count(faltan)
         || ', ' || round(COALESCE(sum(kg), 0) / 1000.0, 1) || ' t'
  INTO v_rep FROM public.contract_service_peso_apt WHERE service_id <> v_srv;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C38 PASS (%/6) %', v_pass, v_rep;
  ELSE
    RAISE EXCEPTION 'CAJA C38 FAIL (%/6): % || %', v_pass, array_to_string(v_fail, ' || '), v_rep;
  END IF;
END $test$;
