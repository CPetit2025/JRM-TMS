-- CAJA C142 — ERP como única fuente: el stock del día y las guías nuevas generan los movimientos (despacho, traspaso,
-- ingreso y ajuste) que cuadran la base con el stock nuevo. Siempre se revierte.
BEGIN;
DO $test$
DECLARE admin_id uuid; up uuid; res jsonb; f jsonb; pass int := 0; fails text[] := '{}';
  tag text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)); a text; b text; c text; d text; ot text := (80000 + floor(random() * 9999))::int::text;
BEGIN
  FOR admin_id IN SELECT id FROM public.profiles WHERE is_active AND id IN (SELECT id FROM auth.users) LOOP
    PERFORM set_config('request.jwt.claim.sub', admin_id::text, true); EXIT WHEN public.apt_can_load(); admin_id := NULL;
  END LOOP;
  IF admin_id IS NULL THEN RAISE EXCEPTION 'CAJA C142 FAIL: falta un usuario con carga APT'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  a := 'ZZA' || tag; b := 'ZZB' || tag; c := 'ZZC' || tag; d := 'ZZD' || tag;
  -- Día base (ya derivado): 10 de A en 647, 5 de B en 647, 4 de D en ST
  INSERT INTO public.erp_derive_days (fecha, base_fecha, base_fuente, bodegas) VALUES (DATE '2099-01-01', DATE '2098-12-31', 'ERP', ARRAY['647-04 ALM PT', 'ST-VENTAS-IMD']);
  INSERT INTO public.erp_derive_stock VALUES (DATE '2099-01-01', '647-04 ALM PT', a, ot, 10), (DATE '2099-01-01', '647-04 ALM PT', b, ot, 5),
    (DATE '2099-01-01', 'ST-VENTAS-IMD', d, ot, 4);

  -- Actualizable: guía nueva de 3 de A (una sola guía en la línea: fecha exacta)
  up := (public.erp_upload_begin('CONTRATOS', 'C142.xlsx', '2099-01-02 18:00-05', 1)->>'upload_id')::uuid;
  PERFORM public.erp_upload_rows(up, jsonb_build_array(jsonb_build_object('nro_contrato', ot, 'nro_documento', ot, 'secuencia', 1, 'cliente', 'CLIENTE C142', 'ruc', '20999999992',
    'cod_producto', a, 'producto', 'PRODUCTO A', 'unidad', 'UND', 'cant_contrato', 10, 'cant_despachada', 3, 'cant_pendiente', 7, 'nro_guias', 1,
    'fecha_ult_despacho', '2099-01-02', 'guias', jsonb_build_array(jsonb_build_object('g', 'TZ142-' || tag, 'c', 3, 'p', 1)))));
  PERFORM public.erp_upload_apply(up);
  -- Stock nuevo: A baja a 4 en 647 y aparece 3 en ST (traspaso); B igual; C nuevo en cientos (ingreso); D baja a 1 (ajuste)
  up := (public.erp_upload_begin('STOCK', 'C142 stock.xlsx', '2099-01-02 18:00-05', 5)->>'upload_id')::uuid;
  PERFORM public.erp_upload_rows(up, jsonb_build_array(
    jsonb_build_object('linea', 2, 'bodega', '647-04  ALM PT', 'cod_producto', a, 'unidad', 'UND', 'lote', ot, 'stock', 4, 'peso_unitario', 2),
    jsonb_build_object('linea', 3, 'bodega', 'ST-VENTAS-IMD', 'cod_producto', a, 'unidad', 'UND', 'lote', ot, 'stock', 3, 'peso_unitario', 2),
    jsonb_build_object('linea', 4, 'bodega', '647-04  ALM PT', 'cod_producto', b, 'unidad', 'UND', 'lote', ot, 'stock', 5, 'peso_unitario', 1),
    jsonb_build_object('linea', 5, 'bodega', '647-04  ALM PT', 'cod_producto', c, 'unidad', 'CIEN', 'lote', ot || '-S001', 'stock', 2, 'peso_unitario', 0.05),
    jsonb_build_object('linea', 6, 'bodega', 'ST-VENTAS-IMD', 'cod_producto', d, 'unidad', 'UND', 'lote', ot, 'stock', 1, 'peso_unitario', 1)));
  res := public.erp_upload_apply(up);

  -- T1 movimientos del día
  res := public.erp_derive(false);
  SELECT jsonb_agg(concat_ws('|', x->>'TipoDocto', public.erp_bodega(x->>'Bodega'), x->>'Producto', round((x->>'Cantidad')::numeric, 2), round((x->>'PesoTotalProduccido')::numeric, 2)) ORDER BY x->>'TipoDocto', x->>'Bodega', x->>'Producto')
  INTO f FROM jsonb_array_elements(res->'filas') x;
  IF res->>'success' = 'true' AND res->'resumen'->>'base_fuente' = 'ERP' AND (res->'resumen'->>'desde')::date = DATE '2099-01-02'
     AND f = jsonb_build_array(
       'AJUSTE ERP (DERIVADO)|ST-VENTAS-IMD|' || d || '|-3.00|-3.00',
       'DESPACHO VENTAS|647-04 ALM PT|' || a || '|-3.00|-6.00',
       'P/E PRODUCCION ACT.|647-04 ALM PT|' || c || '|2.00|10.00',
       'TRASPASO DE ALMACEN APT|647-04 ALM PT|' || a || '|-3.00|-6.00',
       'TRASPASO DE ALMACEN APT|ST-VENTAS-IMD|' || a || '|3.00|6.00')
     AND (SELECT count(DISTINCT x->>'Numero') FROM jsonb_array_elements(res->'filas') x WHERE x->>'TipoDocto' = 'TRASPASO DE ALMACEN APT') = 1
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(res->'filas') x WHERE x->>'Numero' = 'TZ142-' || tag AND x->>'Fecha' = '2099-01-02' AND x->>'NumRel' = ot)
  THEN pass := pass + 1; ELSE fails := fails || ('T1 movimientos: ' || COALESCE(f::text, res::text)); END IF;

  -- T2 guardar el día: queda como base y la guía no se repite; recalcular el mismo día da lo mismo
  res := public.erp_derive(true);
  IF res->>'success' = 'true' AND (SELECT count(*) FROM public.erp_derive_stock WHERE fecha = DATE '2099-01-02') = 5
     AND EXISTS (SELECT 1 FROM public.erp_derive_guias WHERE guia_key = public.apt_guia_key('TZ142-' || tag) AND dia = DATE '2099-01-02')
     AND jsonb_array_length(public.erp_derive(false)->'filas') = 5
  THEN pass := pass + 1; ELSE fails := fails || ('T2 guardar: ' || res::text); END IF;

  -- T3 un Stock anterior al último día derivado se rechaza; sin permiso no se deriva
  UPDATE public.erp_imports SET cut_at = '2098-12-31 18:00-05' WHERE id = up;
  res := public.erp_derive(false);
  IF res->>'success' = 'false' AND res->>'error' LIKE 'Ya hay movimientos derivados%' THEN pass := pass + 1; ELSE fails := fails || ('T3 anterior: ' || res::text); END IF;
  PERFORM set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  IF (public.erp_derive(false)->>'success') = 'true' OR has_function_privilege('authenticated', 'public.erp_derive_core(boolean,uuid,jsonb)', 'EXECUTE')
  THEN fails := fails || 'T3 permisos'::text; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C142 FAIL (%/3): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C142 PASS (3/3) ERP como única fuente: despacho por guía, traspaso entre bodegas, ingreso en cientos y ajuste cuadran la base con el stock del día';
END $test$;
ROLLBACK;
