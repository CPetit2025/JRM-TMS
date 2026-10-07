-- CAJA C23 — Detalle de SKUs de una guía de remisión desde la SALIDA cargada en APT: normalización del número
-- (T001-23 = T001-00000023 = 23), varias guías a la vez, guías no encontradas y permisos (servicios de contratos sí,
-- sin módulo no). Se ejecuta dentro de un bloque que siempre se revierte. Usa fechas de 2001 y la serie ZZ23.
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
  v_loader uuid; v_srv uuid; v_none uuid; v_role uuid; v_up uuid; r jsonb; r2 jsonb; r_none jsonb;
  v_fail text[] := '{}'; v_pass int := 0;
BEGIN
  SELECT id INTO v_loader FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  SELECT id INTO v_srv FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id <> v_loader ORDER BY id LIMIT 1;
  SELECT id INTO v_none FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_loader, v_srv) ORDER BY id LIMIT 1;
  IF v_none IS NULL THEN RAISE EXCEPTION 'CAJA C23 FAIL: se requieren 3 perfiles'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C23 carga', '["apt-carga"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET is_active = true, role_id = v_role WHERE id = v_loader;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C23 servicios', '["contratos-servicios"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET is_active = true, role_id = v_role WHERE id = v_srv;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C23 nada', '["ot-zz"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET is_active = true, role_id = v_role WHERE id = v_none;

  PERFORM pg_temp.as_user(v_loader);
  v_up := (public.apt_upload_begin('ZZ C23.xlsx') ->> 'id')::uuid;
  PERFORM public.apt_upload_rows(v_up, 'SALIDA', jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'DESPACHO VENTAS', 'BODEGA', 'ST-VENTAS-IMD', 'Numero', 'ZZ23-00000023', 'Fecha', '2001-01-05',
      'RazonSocial', 'ZZ CLIENTE C23', 'CodLegal', '20000000023', 'Producto', 'ZZA', 'GLOSA', 'POSTE ZZ', 'Cantidad', -4, 'UNIDAD', 'UND',
      'NumRel', 'ZZ23-001', 'DocRel', 'CONTRATO DE VENTAS', 'PesoUnitario', 100, 'PesoTotalProduccido', 400),
    jsonb_build_object('__row', 3, 'TIPODOCTO', 'DESPACHO VENTAS', 'BODEGA', 'ST-VENTAS-IMD', 'Numero', 'ZZ23-00000023', 'Fecha', '2001-01-05',
      'RazonSocial', 'ZZ CLIENTE C23', 'Producto', 'ZZB', 'GLOSA', 'PERNO ZZ', 'Cantidad', -1.5, 'UNIDAD', 'CIEN',
      'NumRel', 'ZZ23-001', 'PesoTotalProduccido', 3),
    jsonb_build_object('__row', 4, 'TIPODOCTO', 'DESPACHO VENTAS', 'BODEGA', 'ST-VENTAS-IMD', 'Numero', 'ZZ23-00000024', 'Fecha', '2001-01-06',
      'RazonSocial', 'ZZ CLIENTE C23', 'Producto', 'ZZA', 'Cantidad', -1, 'UNIDAD', 'UND', 'NumRel', 'ZZ23-002', 'PesoTotalProduccido', 100)));
  PERFORM public.apt_upload_apply(v_up, false);

  PERFORM pg_temp.as_user(v_srv);
  r := public.apt_guia_detalle('zz23-23');
  r2 := public.apt_guia_detalle('ZZ23-0000023, ZZ23-24; ZZ23-999');
  PERFORM pg_temp.as_user(v_none);
  r_none := public.apt_guia_detalle('ZZ23-23');
  PERFORM pg_temp.as_user(NULL);

  -- T1: el número sin ceros y en minúsculas encuentra la guía con sus dos SKUs, cantidades y peso
  IF (r ->> 'success')::boolean AND jsonb_array_length(r -> 'guias') = 1
     AND r #>> '{guias,0,documento}' = 'ZZ23-00000023' AND (r #>> '{guias,0,lineas}')::int = 2
     AND (r #>> '{guias,0,tn}')::numeric = 0.403 AND (r #>> '{guias,0,unidades,UND}')::numeric = 4
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(r #> '{guias,0,items}') i WHERE i ->> 'producto' = 'ZZB' AND (i ->> 'cantidad')::numeric = 1.5)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 guía: ' || COALESCE(r::text, '∅')); END IF;

  -- T2: varias guías a la vez y la que no existe se informa
  IF jsonb_array_length(r2 -> 'guias') = 2 AND r2 -> 'no_encontradas' = '["ZZ23-999"]'::jsonb
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 varias: ' || COALESCE(r2::text, '∅')); END IF;

  -- T3: sin módulo relacionado no se consulta
  IF NOT (r_none ->> 'success')::boolean
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 permiso: ' || COALESCE(r_none::text, '∅')); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C23 PASS (%/3)', v_pass;
  ELSE
    RAISE EXCEPTION 'CAJA C23 FAIL (%/3): %', v_pass, array_to_string(v_fail, ' || ');
  END IF;
END $test$;
