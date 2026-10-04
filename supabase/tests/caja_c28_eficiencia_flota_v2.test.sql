-- CAJA C28 — Eficiencia de Flota v2:
--   T1 reclasificación: un "preventivo" que describe una reparación cuenta como correctivo; las llantas se amortizan;
--   T2 amortización: S/ 2 400 de llantas en ene-2025 aportan S/ 100 por mes (24 meses) al mantenimiento devengado;
--   T3 precio constante: con precio de referencia S/ 20 el combustible a S/ 10 se valora al doble;
--   T4 decisión económica (fe_econ): caso con ahorro conocido (≈ S/ 20 157) y caso donde conviene seguir;
--   T5 montacargas con poco uso y costo alto: tenerlo cuesta más por hora que alquilarlo → "Dar de baja o alquilar";
--   T6 vínculo con Flota: una unidad inexistente se rechaza; una existente queda vinculada;
--   T7 clientes: las variantes de "JRM" son traslado interno; T8 sin permiso no hay ficha del activo.
-- Solo lectura (se revierte).
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

DO $test$
DECLARE v_user uuid; v_rc uuid; v_up uuid; r jsonb; u jsonb; e jsonb; x jsonb; v_vid uuid; n numeric;
  v_fail text[] := '{}'; v_pass int := 0;
BEGIN
  SELECT id INTO v_user FROM public.profiles WHERE id IN (SELECT u2.id FROM auth.users u2)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C28 carga', '["flota-eficiencia-carga"]') RETURNING id INTO v_rc;
  UPDATE public.fe_settings SET desde = DATE '2025-01-01', corte = NULL,
    params = params || '{"precio_ref": 20, "amortizar_meses": 24, "alquiler_hora": 60, "tasa_capital": 0.10}'::jsonb WHERE id = 1;
  UPDATE public.profiles SET is_active = true, role_id = v_rc WHERE id = v_user;

  PERFORM pg_temp.as_user(v_user);
  v_up := (public.fe_upload_begin('zz28.xlsx') ->> 'id')::uuid;
  PERFORM public.fe_upload_rows(v_up, 'MANT', jsonb_build_array(
    jsonb_build_object('activo', 'ZZU 902', 'clase', 'UNIDAD VEHICULAR', 'fecha', '2025-01-10', 'monto', 2400, 'tipo', 'PREVENTIVO', 'categoria', 'LLANTAS / NEUMÁTICOS', 'anio_fab', 2015),
    jsonb_build_object('activo', 'ZZU 902', 'clase', 'UNIDAD VEHICULAR', 'fecha', '2025-02-10', 'monto', 300, 'tipo', 'PREVENTIVO', 'detalle', 'REPARACION DE BOMBA DE AGUA', 'anio_fab', 2015),
    jsonb_build_object('activo', 'ZZU 902', 'clase', 'UNIDAD VEHICULAR', 'fecha', '2025-03-10', 'monto', 200, 'tipo', 'PREVENTIVO', 'detalle', 'CAMBIO DE ACEITE', 'anio_fab', 2015),
    jsonb_build_object('activo', 'ZZ MONTA 28', 'clase', 'MONTACARGA', 'fecha', '2025-01-05', 'monto', 3000, 'km_hrs', 1000, 'anio_fab', 2012),
    jsonb_build_object('activo', 'ZZ MONTA 28', 'clase', 'MONTACARGA', 'fecha', '2025-05-05', 'monto', 3000, 'km_hrs', 1050, 'anio_fab', 2012),
    jsonb_build_object('activo', 'ZZ MONTA 28', 'clase', 'MONTACARGA', 'fecha', '2025-09-05', 'monto', 3000, 'km_hrs', 1100, 'anio_fab', 2012)));
  PERFORM public.fe_upload_rows(v_up, 'COMB', jsonb_build_array(
    jsonb_build_object('placa', 'ZZU 902', 'vehiculo', 'CAMION', 'anio', 2025, 'mes', 1, 'galones', 50, 'soles', 500, 'precio', 10, 'km_real', 1000, 'valida', 1),
    jsonb_build_object('placa', 'ZZU 902', 'vehiculo', 'CAMION', 'anio', 2025, 'mes', 2, 'galones', 50, 'soles', 500, 'precio', 10, 'km_real', 1000, 'valida', 1),
    jsonb_build_object('placa', 'ZZU 902', 'vehiculo', 'CAMION', 'anio', 2025, 'mes', 3, 'galones', 50, 'soles', 500, 'precio', 10, 'km_real', 1000, 'valida', 1)));
  r := public.fe_upload_apply(v_up);
  PERFORM pg_temp.as_user(NULL);

  -- T1
  IF (r ->> 'success')::boolean
     AND EXISTS (SELECT 1 FROM public.fe_maint WHERE asset_code = 'ZZU 902' AND monto = 300 AND tipo_real = 'CORRECTIVO')
     AND EXISTS (SELECT 1 FROM public.fe_maint WHERE asset_code = 'ZZU 902' AND monto = 2400 AND tipo_real = 'NEUMATICOS' AND amortizable)
     AND EXISTS (SELECT 1 FROM public.fe_maint WHERE asset_code = 'ZZU 902' AND monto = 200 AND tipo_real = 'PREVENTIVO' AND NOT amortizable)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 reclasificación: ' || left(COALESCE(r::text, '∅'), 300)); END IF;

  -- T2 y T3: resumen ene–mar 2025 de la unidad
  PERFORM pg_temp.as_user(v_user);
  r := public.fe_resumen(jsonb_build_object('desde', '2025-01-01', 'hasta', '2025-03-01'));
  PERFORM pg_temp.as_user(NULL);
  SELECT t INTO u FROM jsonb_array_elements(r -> 'transporte') t WHERE t ->> 'code' = 'ZZU 902';
  -- devengado: llantas 100 × 3 meses + 300 + 200 = 800; combustible a precio constante 150 gal × 20 = 3 000
  IF (u ->> 'mant_a')::numeric = 800 AND (u ->> 'comb_c')::numeric = 3000 AND (u ->> 'comb')::numeric = 1500
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 amortización: ' || left(COALESCE(u::text, r::text, '∅'), 400)); END IF;
  IF abs((u ->> 'costo_km')::numeric - (3000 + 800) / 3000.0) < 0.0001 AND abs((u ->> 'costo_km_real')::numeric - (1500 + 2900) / 3000.0) < 0.0001
     AND (r ->> 'precio_ref')::numeric = 20
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 precio constante: ' || left(COALESCE(u::text, '∅'), 300)); END IF;

  -- T4
  x := public.fe_econ(100000, 'CAMION', 10, 12, 30000, 0, 0, 0.10, (SELECT params FROM public.fe_settings WHERE id = 1), 5000);
  e := public.fe_econ(100000, 'CAMION', 10, 12, 5000, 0, 0, 0.10, (SELECT params FROM public.fe_settings WHERE id = 1), 5000);
  IF (x ->> 'ahorro')::numeric BETWEEN 20000 AND 20300 AND (x ->> 'anios')::int = 0 AND (e ->> 'ahorro')::numeric < 0 AND e ->> 'anios' IS NULL
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 económico: ' || COALESCE(x::text, '∅') || ' / ' || COALESCE(e::text, '∅')); END IF;

  -- T5: montacargas, 100 h en 8 meses y S/ 9 000 de mantenimiento en el año
  PERFORM pg_temp.as_user(v_user);
  r := public.fe_resumen(jsonb_build_object('desde', '2025-01-01', 'hasta', '2025-12-01'));
  PERFORM pg_temp.as_user(NULL);
  SELECT t INTO e FROM jsonb_array_elements(r -> 'equipos') t WHERE t ->> 'code' = 'ZZ MONTA 28';
  IF (e ->> 'costo_propio_hora')::numeric > 60 AND e ->> 'rec' = 'Dar de baja o alquilar' AND (e ->> 'alquiler_anual')::numeric > 0
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T5 alquiler: ' || left(COALESCE(e::text, '∅'), 400)); END IF;

  -- T6: vínculo con Flota
  PERFORM pg_temp.as_user(v_user);
  r := public.fe_save_asset(jsonb_build_object('code', 'ZZU 902', 'clase', 'TRANSPORTE', 'vehicle_id', gen_random_uuid()));
  PERFORM pg_temp.as_user(NULL);
  SELECT id INTO v_vid FROM public.vehicles ORDER BY id LIMIT 1;
  IF v_vid IS NOT NULL THEN
    PERFORM pg_temp.as_user(v_user);
    u := public.fe_save_asset(jsonb_build_object('code', 'ZZU 902', 'clase', 'TRANSPORTE', 'vehicle_id', v_vid));
    PERFORM pg_temp.as_user(NULL);
  END IF;
  IF NOT (r ->> 'success')::boolean AND (v_vid IS NULL OR ((u ->> 'success')::boolean AND EXISTS (SELECT 1 FROM public.fe_assets WHERE code = 'ZZU 902' AND vehicle_id = v_vid)))
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T6 vínculo: ' || COALESCE(r::text, '∅') || ' / ' || COALESCE(u::text, '∅')); END IF;

  -- T7
  IF public.fe_cli_key('ESTANTERIAS METALICAS J.R.M. S.A.C') = 'JRM (TRASLADO INTERNO)' AND public.fe_cli_key('Flejes Peruanos S.A.C.') = 'FLEJES PERUANOS'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T7 clientes'::text; END IF;

  -- T8
  UPDATE public.profiles SET role_id = NULL WHERE id = v_user;
  PERFORM pg_temp.as_user(v_user);
  r := public.fe_activo('ZZU 902');
  PERFORM pg_temp.as_user(NULL);
  IF NOT (r ->> 'success')::boolean THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T8 sin permiso con acceso'::text; END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C28 PASS (%/8)', v_pass;
  ELSE
    RAISE EXCEPTION 'CAJA C28 FAIL (%/8): %', v_pass, array_to_string(v_fail, ' || ');
  END IF;
END $test$;
