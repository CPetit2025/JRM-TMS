-- CAJA C34 — Liquidación de alquiler: documento, envío por correo y recordatorio del día 1.
--   T1 documento con liquidación, cálculo, contrato, unidad, arrendador y empresa; T2 sin permiso no hay documento;
--   T3 el día 1 avisa el envío del mes anterior (una sola vez); T4 el día 2 no avisa; T5 desde el día 3 avisa como
--   atrasada; T6 registrar el envío (con permiso) guarda destinatario y usuario y fija el correo del contrato;
--   T7 enviada, ya no hay aviso; T8 sin permiso no se registra el envío y no se registra sin destinatario.
--   Solo lectura (se revierte).
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

DO $test$
DECLARE v_user uuid; r_p uuid; r_n uuid; c record; v_set uuid; r jsonb; a jsonb; v_fail text[] := '{}'; v_pass int := 0; n int; v_key text; v_rep text; v_lessor_name text;
BEGIN
  SELECT id INTO v_user FROM public.profiles WHERE id IN (SELECT u2.id FROM auth.users u2)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C34 liquida', '["caja-liquidaciones"]') RETURNING id INTO r_p;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C34 nada', '["clientes"]') RETURNING id INTO r_n;
  UPDATE public.profiles SET role_id = r_p, is_active = true WHERE id = v_user;

  SELECT k.* INTO c FROM public.vehicle_lease_contracts k JOIN public.vehicles v ON v.id = k.vehicle_id
  WHERE public.fe_code(v.plate) = 'CJS 716' AND k.status = 'ACTIVO' ORDER BY k.start_date DESC LIMIT 1;
  IF c.id IS NULL THEN RAISE EXCEPTION 'CAJA C34 FAIL (0/8): no hay contrato activo de CJS716'; END IF;
  -- El proveedor puede cambiar legítimamente: el documento debe mostrar el del contrato seleccionado.
  SELECT business_name INTO v_lessor_name FROM public.carriers WHERE id = c.provider_id;
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_user, c.site_id) ON CONFLICT DO NOTHING;
  SELECT id INTO v_set FROM public.lease_settlements WHERE contract_id = c.id AND period_start = DATE '2026-09-01' AND status <> 'ANULADA' LIMIT 1;
  -- La prueba parte de setiembre sin enviar (si ya se envió, se quita dentro de la transacción)
  DELETE FROM public.lease_settlement_sends WHERE settlement_id = v_set;
  UPDATE public.vehicle_lease_contracts SET send_to_email = NULL WHERE id = c.id;
  DELETE FROM public.notifications WHERE dedupe_key LIKE 'alq-envio-' || c.id || '-202609%';

  -- T1
  PERFORM pg_temp.as_user(v_user); r := public.lease_settlement_document(v_set); PERFORM pg_temp.as_user(NULL);
  IF (r ->> 'success')::boolean AND (r -> 'calc' ->> 'subtotal')::numeric = 3834.29 AND r -> 'vehicle' ->> 'plate' IS NOT NULL
     AND NULLIF(trim(v_lessor_name), '') IS NOT NULL AND r -> 'lessor' ->> 'name' = v_lessor_name
     AND r -> 'company' ->> 'name' IS NOT NULL AND jsonb_typeof(r -> 'sends') = 'array'
     AND jsonb_array_length(r -> 'calc' -> 'viajes') > 0
  THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T1 documento: success=' || COALESCE(r ->> 'success', '?') || ' subtotal=' || COALESCE(r -> 'calc' ->> 'subtotal', '?')
    || ' placa=' || COALESCE(r -> 'vehicle' ->> 'plate', '?') || ' arrendador=' || COALESCE(r -> 'lessor' ->> 'name', '?')
    || ' empresa=' || COALESCE(r -> 'company' ->> 'name', '?') || ' envios=' || COALESCE(jsonb_typeof(r -> 'sends'), '?')
    || ' viajes=' || COALESCE(jsonb_array_length(r -> 'calc' -> 'viajes')::text, '?') || ' error=' || COALESCE(r ->> 'error', '-')); END IF;

  -- T2
  UPDATE public.profiles SET role_id = r_n WHERE id = v_user;
  PERFORM pg_temp.as_user(v_user); r := public.lease_settlement_document(v_set); PERFORM pg_temp.as_user(NULL);
  IF NOT (r ->> 'success')::boolean THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T2 documento sin permiso'::text; END IF;
  UPDATE public.profiles SET role_id = r_p WHERE id = v_user;

  -- T3 (día 1 de octubre: liquidación de setiembre)
  v_key := 'alq-envio-' || c.id || '-202609';
  PERFORM public.lease_envio_recordatorio(DATE '2026-10-01');
  PERFORM public.lease_envio_recordatorio(DATE '2026-10-01');
  SELECT count(*) INTO n FROM public.notifications WHERE dedupe_key = v_key AND evento = 'ALQUILER_ENVIO' AND link LIKE '/flota/liquidaciones-alquiler?contrato=%';
  IF n = 1 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 día 1: ' || n); END IF;
  SELECT titulo INTO v_rep FROM public.notifications WHERE dedupe_key = v_key;

  -- T4 y T5
  SELECT count(*) INTO n FROM public.notifications WHERE dedupe_key LIKE v_key || '-%';
  PERFORM public.lease_envio_recordatorio(DATE '2026-10-02');
  IF (SELECT count(*) FROM public.notifications WHERE dedupe_key LIKE v_key || '-%') = n THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T4 día 2'::text; END IF;
  PERFORM public.lease_envio_recordatorio(DATE '2026-10-03');
  IF EXISTS (SELECT 1 FROM public.notifications WHERE dedupe_key = v_key || '-03' AND evento = 'ALQUILER_ENVIO_ATRASADO') THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || 'T5 atrasada'::text; END IF;

  -- T6
  PERFORM pg_temp.as_user(v_user); a := public.register_lease_settlement_send(v_set, 'facturacion@valeriani.test', 'flota@jrm.test', 'CORREO', NULL); PERFORM pg_temp.as_user(NULL);
  IF (a ->> 'success')::boolean AND EXISTS (SELECT 1 FROM public.lease_settlement_sends WHERE settlement_id = v_set AND sent_to = 'facturacion@valeriani.test' AND sent_by = v_user)
     AND (SELECT send_to_email FROM public.vehicle_lease_contracts WHERE id = c.id) = 'facturacion@valeriani.test'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T6 envío: ' || a::text); END IF;

  -- T7
  PERFORM public.lease_envio_recordatorio(DATE '2026-10-04');
  IF NOT EXISTS (SELECT 1 FROM public.notifications WHERE dedupe_key = v_key || '-04') THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T7 enviada sigue avisando'::text; END IF;

  -- T8
  PERFORM pg_temp.as_user(v_user); a := public.register_lease_settlement_send(v_set, '  ', NULL, 'CORREO', NULL); PERFORM pg_temp.as_user(NULL);
  UPDATE public.profiles SET role_id = r_n WHERE id = v_user;
  PERFORM pg_temp.as_user(v_user); r := public.register_lease_settlement_send(v_set, 'x@y.test', NULL, 'CORREO', NULL); PERFORM pg_temp.as_user(NULL);
  IF NOT (a ->> 'success')::boolean AND NOT (r ->> 'success')::boolean THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T8 sin permiso / sin destinatario'::text; END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C34 PASS (%/8) aviso: %', v_pass, v_rep;
  ELSE
    RAISE EXCEPTION 'CAJA C34 FAIL (%/8): % || aviso: %', v_pass, array_to_string(v_fail, ' || '), v_rep;
  END IF;
END $test$;
