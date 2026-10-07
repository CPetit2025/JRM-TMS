-- CAJA C21 — APT: carga del reporte total del ERP. Identificadores con ceros a la izquierda ('0000021001', '02861')
-- coinciden con los mismos números sin ceros; la producción de otras bodegas queda excluida; la producción directa a 540
-- y la guía de recojo (devolución) quedan en 540 y alimentan su traspaso a ST.
-- Se ejecuta dentro de un bloque que siempre se revierte: no deja datos. Usa fechas de 2001 y fecha de corte manual
-- 31/01/2001, así el modelo de la prueba no mezcla movimientos reales.
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
  v_loader uuid; v_viewer uuid; v_none uuid; v_role uuid; v_up uuid;
  rb jsonb; g1 jsonb;
  v_fail text[] := '{}';
  v_pass int := 0;
BEGIN
  SELECT id INTO v_loader FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  SELECT id INTO v_viewer FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id <> v_loader ORDER BY id LIMIT 1;
  SELECT id INTO v_none FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_loader, v_viewer) ORDER BY id LIMIT 1;
  IF v_none IS NULL THEN RAISE EXCEPTION 'CAJA C21 FAIL: se requieren 3 perfiles'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ APT C21 carga', '["apt-carga"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET is_active = true, role_id = v_role WHERE id = v_loader;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ APT C21 ver', '["apt:read"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET is_active = true, role_id = v_role WHERE id = v_viewer;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ APT C21 nada', '["ot"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET is_active = true, role_id = v_role WHERE id = v_none;

  PERFORM pg_temp.as_user(v_loader);
  PERFORM public.apt_save_settings('{"cutoff_date":"2001-01-31","tolerance":0.02,"alert_days":60}'::jsonb);
  v_up := (public.apt_upload_begin('ZZ C21 DATA.xlsx') ->> 'id')::uuid;
  -- ENTRADA total: producción a 647 (lote con ceros), a 540 (adelanto) y a otra planta (se excluye)
  PERFORM public.apt_upload_rows(v_up, 'ENTRADA', jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', '647-04  ALM PT', 'Numero', '0000000101', 'Fecha', '2001-01-02',
      'Producto', 'ZZQ', 'NumRel', '0000021001-001', 'Lote', '0000021001', 'PesoTotalProduccido', 400),
    jsonb_build_object('__row', 3, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', '540-04 APT LB', 'Numero', '0000000102', 'Fecha', '2001-01-03',
      'Producto', 'ZZR', 'NumRel', '02861-001', 'Lote', '02861', 'Comentario', 'IPT: 003-000861', 'PesoTotalProduccido', 200),
    jsonb_build_object('__row', 4, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', 'PRODUCCION- CHILCA', 'Numero', '0000000103', 'Fecha', '2001-01-03',
      'Producto', 'ZZQ', 'NumRel', '21001-002', 'Lote', '21001', 'PesoTotalProduccido', 999)));
  -- Guía de recojo: el cliente devuelve 50 kg del adelanto a 540
  PERFORM public.apt_upload_rows(v_up, 'DEVOLUCION', jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'GUIA DE RECOJO', 'BODEGA', '540-04 APT LB', 'Numero', 'ZZR-1', 'Fecha', '2001-01-04',
      'Producto', 'ZZR', 'Cantidad', 1, 'Lote', '02861', 'PesoTotalProduccido', 50)));
  -- Traspasos: 647→ST con número relleno en un lado y sin ceros en el otro; 540→ST asignando contrato
  PERFORM public.apt_upload_rows(v_up, 'TRASPASO_SAL', jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'TRASPASO DE ALMACEN', 'BODEGA', '647-04  ALM PT', 'Numero', '0000000201', 'Fecha', '2001-01-05',
      'Producto', 'ZZQ', 'Cantidad', -4, 'Lote', '0000021001', 'PesoTotalProduccido', 400),
    jsonb_build_object('__row', 3, 'TIPODOCTO', 'TRASPASO DE ALMACEN', 'BODEGA', '540-04 APT LB', 'Numero', '202', 'Fecha', '2001-01-06',
      'Producto', 'ZZR', 'Cantidad', -2, 'Lote', '02861', 'PesoTotalProduccido', 250)));
  PERFORM public.apt_upload_rows(v_up, 'TRASPASO_ENT', jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'TRASPASO DE ALMACEN', 'BODEGA', 'ST-VENTAS-IMD', 'Numero', 201, 'Fecha', '2001-01-05',
      'Producto', 'ZZQ', 'Cantidad', 4, 'Lote', 21001, 'PesoTotalProduccido', 400),
    jsonb_build_object('__row', 3, 'TIPODOCTO', 'TRASPASO DE ALMACEN', 'BODEGA', 'ST-VENTAS-IMD', 'Numero', '0000000202', 'Fecha', '2001-01-06',
      'Producto', 'ZZR', 'Cantidad', 2, 'Lote', '0000021001-S001', 'PesoTotalProduccido', 250)));
  -- Guías: NumRel relleno con ceros (como lo exporta el reporte total)
  PERFORM public.apt_upload_rows(v_up, 'SALIDA', jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'DESPACHO VENTAS', 'BODEGA', 'ST-VENTAS-IMD', 'Numero', 'ZZG-21', 'Fecha', '2001-01-05',
      'RazonSocial', 'ZZ CLIENTE C21', 'Producto', 'ZZQ', 'Cantidad', -4, 'NumRel', '0000021001', 'PesoTotalProduccido', 400),
    jsonb_build_object('__row', 3, 'TIPODOCTO', 'DESPACHO VENTAS', 'BODEGA', 'RINTI', 'Numero', 'ZZG-22', 'Fecha', '2001-01-05',
      'Producto', 'ZZQ', 'Cantidad', -1, 'NumRel', '21001', 'PesoTotalProduccido', 1)));
  PERFORM public.apt_upload_apply(v_up, false);
  PERFORM public.apt_model_rebuild();
  rb := public.apt_flow_rebuild();
  g1 := public.apt_flow_trace('ZZG-21');
  PERFORM pg_temp.as_user(NULL);

  -- T1: identificadores sin ceros y filas de bodegas fuera de APT excluidas (producción de otra planta, guía de RINTI)
  IF (SELECT lote FROM public.apt_movements WHERE upload_id = v_up AND kind = 'ENTRADA' AND row_no = 2) = '21001'
     AND (SELECT documento FROM public.apt_movements WHERE upload_id = v_up AND kind = 'TRASPASO_SAL' AND row_no = 2) = '201'
     AND (SELECT lote FROM public.apt_movements WHERE upload_id = v_up AND kind = 'TRASPASO_ENT' AND row_no = 3) = '21001-S001'
     AND (SELECT lote FROM public.apt_movements WHERE upload_id = v_up AND kind = 'SALIDA' AND row_no = 2) = '21001'
     AND NOT (SELECT valid FROM public.apt_movements WHERE upload_id = v_up AND kind = 'ENTRADA' AND row_no = 4)
     AND NOT (SELECT valid FROM public.apt_movements WHERE upload_id = v_up AND kind = 'SALIDA' AND row_no = 3)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 normalización: ' || COALESCE(rb::text, '∅')); END IF;

  -- T2: traspasos emparejados aunque un lado traiga ceros; la guía viene de la producción de 647 (sin stock previo)
  IF (SELECT count(*) FROM public.apt_flow_exits WHERE tipo = 'TRASPASO') = 2
     AND g1 #>> '{lineas,0,origen}' = 'PRODUCCION' AND g1 #>> '{lineas,0,fecha_origen}' = '2001-01-02'
     AND NOT EXISTS (SELECT 1 FROM public.apt_flow_layers WHERE tipo = 'INICIAL' AND almacen IN ('647', 'ST'))
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 guía: ' || COALESCE(g1::text, '∅')); END IF;

  -- T3: la producción directa a 540 y la devolución quedan en 540 y cubren su traspaso a ST (250 kg) sin stock previo;
  -- quedan 0 kg en 540 y el saldo de ST (250 kg, sin guía) viene 200 de producción y 50 de devolución
  IF (SELECT sum(kg_in) FROM public.apt_flow_layers WHERE almacen = '540' AND tipo = 'PRODUCCION') = 200
     AND NOT EXISTS (SELECT 1 FROM public.apt_flow_layers WHERE tipo = 'INICIAL')
     AND (SELECT COALESCE(sum(kg_saldo), 0) FROM public.apt_flow_layers WHERE almacen = '540') = 0
     AND (SELECT sum(kg) FROM public.apt_flow_pieces WHERE es_saldo AND almacen = 'ST' AND origen = 'PRODUCCION') = 200
     AND (SELECT sum(kg) FROM public.apt_flow_pieces WHERE es_saldo AND almacen = 'ST' AND origen = 'DEVOLUCION') = 50
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 540: ' || COALESCE(rb::text, '∅')); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C21 PASS (%/3)', v_pass;
  ELSE
    RAISE EXCEPTION 'CAJA C21 FAIL (%/3): %', v_pass, array_to_string(v_fail, ' || ');
  END IF;
END $test$;
