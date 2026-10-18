-- CAJA C115 — Inventario multi-almacén: carga de Entradas/Salidas (filas descartadas por motivo), reemplazo por rango,
-- emparejamiento de traspasos con reasignación de lote, FIFO con estadía en bodega y desde el origen, saldo inicial
-- inferido y desde la foto de stock, trazabilidad hacia el origen, préstamos de herramientas y permisos.
-- Usa bodegas y fechas propias (enero 2001) y siempre se revierte.
BEGIN;
DO $test$
DECLARE adm uuid; ue uuid; us uuid; ust uuid; r jsonb; pass int := 0; fails text[] := '{}'; v numeric; v2 numeric; t text;
  rows_e jsonb; rows_s jsonb;
BEGIN
  SELECT p.id INTO adm FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
  WHERE r.name = 'Administrador' AND p.is_active ORDER BY p.id LIMIT 1;
  IF adm IS NULL THEN RAISE EXCEPTION 'CAJA C115 FAIL: falta un Administrador activo'; END IF;
  PERFORM set_config('request.jwt.claim.sub', adm::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', adm, 'role', 'authenticated')::text, true);
  -- Que ninguna foto de stock real cambie el inicio del modelo durante la prueba
  UPDATE public.inv_uploads SET status = 'DESCARTADA' WHERE side = 'STOCK' AND status = 'APLICADA';

  -- T1: normalización de lotes, OT, bodegas y tipos de documento
  IF public.inv_lote('0016339-s005') = '16339-S005' AND public.inv_lote('2870.0') = '2870' AND public.inv_lote('0') IS NULL
     AND public.inv_ot('16339-S005') = '16339' AND public.inv_ot('2870') IS NULL
     AND public.inv_guess_kind('MRO - 647-01') = 'MRO' AND public.inv_guess_kind('647-04 ALM PT') = 'PRODUCTO_TERMINADO'
     AND public.inv_guess_kind('ST-VENTAS-IMD') = 'DESPACHO' AND public.inv_guess_class('V/C PRODUCCION ACT.') = 'CONSUMO'
     AND public.inv_guess_class('PE SERV TERCEROS') = 'SERVICIO_TERCERO'
  THEN pass := pass + 1; ELSE fails := fails || 'T1 normalización'::text; END IF;

  -- Entradas: producción a C115 PT (días 1 y 3), ingreso por traspaso a C115 ST (días 5 y 6), devolución de herramienta
  rows_e := jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', 'C115 647-04 ALM PT', 'Numero', '900001', 'Fecha', '2001-01-01',
      'Producto', 'C115.VIGA', 'Cantidad', 10, 'UNIDAD', 'UND', 'NumRel', '99998-S001-001', 'Lote', '99998-S001', 'PesoUnitario', 2),
    jsonb_build_object('__row', 3, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', 'C115 647-04 ALM PT', 'Numero', '900002', 'Fecha', '2001-01-03',
      'Producto', 'C115.VIGA', 'Cantidad', 10, 'UNIDAD', 'UND', 'NumRel', '99998-S001-002', 'Lote', '99998-S001', 'PesoUnitario', 2),
    jsonb_build_object('__row', 4, 'TIPODOCTO', 'TRASPASO DE ALMACEN', 'BODEGA', 'C115 ST-VENTAS', 'Numero', '900010', 'Fecha', '2001-01-05',
      'Producto', 'C115.VIGA', 'Cantidad', 15, 'UNIDAD', 'UND', 'Lote', '99998-S001', 'PesoUnitario', 2),
    jsonb_build_object('__row', 5, 'TIPODOCTO', 'TRASPASO DE ALMACEN APT', 'BODEGA', 'C115 ST-VENTAS', 'Numero', '900011', 'Fecha', '2001-01-06',
      'Producto', 'C115.PERNO', 'Cantidad', 100, 'UNIDAD', 'UND', 'Lote', '99998-s001'),
    jsonb_build_object('__row', 6, 'TIPODOCTO', 'DEV. HERRAMIENTAS', 'BODEGA', 'C115 ALM HERRAMIENTAS', 'Numero', 'T003-9000002', 'Fecha', '2001-01-07',
      'Producto', 'C115.CONO', 'Cantidad', 1, 'UNIDAD', 'UND', 'NumRel', 'T003-9000001'),
    jsonb_build_object('__row', 7, 'TIPODOCTO', 'N/INGRESO ALMACEN', 'BODEGA', 'C115 MRO', 'Numero', '900020', 'Fecha', '', 'Producto', 'X', 'Cantidad', 1),
    jsonb_build_object('__row', 8, 'TIPODOCTO', 'N/INGRESO ALMACEN', 'BODEGA', 'C115 MRO', 'Numero', '900021', 'Fecha', '2001-01-02', 'Producto', 'X', 'Cantidad', 0));
  -- Salidas: traspaso de PT a ST (día 5), reasignación de pernería (lote 2870 → contrato), despacho, consumo sin stock
  -- previo (inferido) y préstamo de herramienta
  rows_s := jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'TRASPASO DE ALMACEN', 'BODEGA', 'C115 647-04 ALM PT', 'Numero', '900010', 'Fecha', '2001-01-05',
      'Producto', 'C115.VIGA', 'Cantidad', -15, 'UNIDAD', 'UND', 'Lote', '99998-S001', 'PesoUnitario', 2),
    jsonb_build_object('__row', 3, 'TIPODOCTO', 'TRASPASO DE ALMACEN APT', 'BODEGA', 'C115 ALM PERNERIA', 'Numero', '900011', 'Fecha', '2001-01-06',
      'Producto', 'C115.PERNO', 'Cantidad', -100, 'UNIDAD', 'UND', 'Lote', '2870'),
    jsonb_build_object('__row', 4, 'TIPODOCTO', 'DESPACHO VENTAS', 'BODEGA', 'C115 ST-VENTAS', 'Numero', 'T001-9000001', 'Fecha', '2001-01-06',
      'Producto', 'C115.VIGA', 'Cantidad', -15, 'UNIDAD', 'UND', 'NumRel', '99998-S001', 'Lote', '99998-S001', 'RazonSocial', 'CLIENTE C115', 'PesoUnitario', 2),
    jsonb_build_object('__row', 5, 'TIPODOCTO', 'VALE DE CONSUMO', 'BODEGA', 'C115 MRO', 'Numero', '900030', 'Fecha', '2001-01-04',
      'Producto', 'C115.GUANTE', 'Cantidad', -5, 'UNIDAD', 'PAR'),
    jsonb_build_object('__row', 6, 'TIPODOCTO', 'SALIDA HERRAMIENTAS', 'BODEGA', 'C115 ALM HERRAMIENTAS', 'Numero', 'T003-9000001', 'Fecha', '2001-01-02',
      'Producto', 'C115.CONO', 'Cantidad', -3, 'UNIDAD', 'UND', 'RazonSocial', 'OBRA C115'));

  -- T2: carga (Entradas y Salidas) con filas descartadas por motivo
  ue := (public.inv_upload_begin('E', 'Entradas C115.xlsx')->>'upload_id')::uuid;
  r := public.inv_upload_rows(ue, rows_e);
  us := (public.inv_upload_begin('S', 'Salidas C115.xlsx')->>'upload_id')::uuid;
  PERFORM public.inv_upload_rows(us, rows_s);
  t := (public.inv_upload_apply_core(ue)->>'success') || '/' || (public.inv_upload_apply_core(us)->>'success');
  IF (r->>'inserted')::int = 5 AND (r->'excluded'->>'Sin fecha')::int = 1 AND (r->'excluded'->>'Cantidad cero')::int = 1
     AND t = 'true/true'
     AND (SELECT count(*) FROM public.inv_movements WHERE active AND bodega LIKE 'C115 %') = 10
     AND EXISTS (SELECT 1 FROM public.inv_warehouses WHERE code = 'C115 ST-VENTAS' AND kind = 'DESPACHO')
  THEN pass := pass + 1; ELSE fails := fails || ('T2 carga: ' || COALESCE(r::text, '∅')); END IF;
  r := public.inv_rebuild();

  -- T3: traspasos emparejados; el de pernería registra la reasignación del lote 2870 al contrato 99998-S001
  IF (SELECT count(*) FROM public.inv_transfer_links tl JOIN public.inv_movements o ON o.id = tl.out_id
      WHERE o.bodega LIKE 'C115 %') = 2
     AND EXISTS (SELECT 1 FROM public.inv_transfer_links tl JOIN public.inv_movements o ON o.id = tl.out_id JOIN public.inv_movements i ON i.id = tl.in_id
                 WHERE o.lote = '2870' AND i.lote = '99998-S001' AND i.bodega = 'C115 ST-VENTAS' AND tl.qty = 100)
  THEN pass := pass + 1; ELSE fails := fails || 'T3 traspasos'::text; END IF;

  -- T4: FIFO — el traspaso de 15 consume 10 del día 1 (4 días) y 5 del día 3 (2 días); en ST la capa conoce su origen
  --     (producción) y el despacho del día 6 lleva 1 día en ST y ≈ 4 días desde la producción
  SELECT sum(a.qty * a.dias_bodega) / sum(a.qty) INTO v FROM public.inv_allocations a JOIN public.inv_movements m ON m.id = a.out_id
  WHERE m.numero = '900010' AND m.side = 'S' AND m.bodega = 'C115 647-04 ALM PT';
  SELECT d - DATE '2001-01-01' INTO v2 FROM (SELECT l.root_fecha d FROM public.inv_layers l JOIN public.inv_movements m ON m.id = l.mov_id
    WHERE m.numero = '900010' AND m.side = 'E') x;
  IF round(v, 4) = round((10 * 4 + 5 * 2) / 15.0, 4) AND v2 BETWEEN 0 AND 1
     AND EXISTS (SELECT 1 FROM public.inv_layers l JOIN public.inv_movements m ON m.id = l.mov_id
                 WHERE m.numero = '900010' AND m.side = 'E' AND l.root_known = 1 AND l.root_clase = 'PRODUCCION' AND l.root_bodega = 'C115 647-04 ALM PT')
     AND EXISTS (SELECT 1 FROM public.inv_allocations a JOIN public.inv_movements m ON m.id = a.out_id
                 WHERE m.numero = 'T001-9000001' AND a.dias_bodega = 1 AND a.qty = 15 AND a.kg = 30)
     AND (SELECT sum(qty - consumed) FROM public.inv_layers WHERE bodega = 'C115 647-04 ALM PT') = 5
  THEN pass := pass + 1; ELSE fails := fails || ('T4 FIFO: ' || COALESCE(v::text, '∅') || ' / ' || COALESCE(v2::text, '∅')); END IF;

  -- T5: salida sin stock previo → saldo inicial inferido (y saldo final 0); la pernería también es inferida
  IF EXISTS (SELECT 1 FROM public.inv_layers WHERE bodega = 'C115 MRO' AND producto = 'C115.GUANTE' AND source = 'INFERIDA' AND qty = 5 AND consumed = 5)
     AND EXISTS (SELECT 1 FROM public.inv_layers WHERE bodega = 'C115 ALM PERNERIA' AND lk = '2870' AND source = 'INFERIDA' AND qty = 100)
  THEN pass := pass + 1; ELSE fails := fails || 'T5 saldo inferido'::text; END IF;

  -- T6: foto de stock al 31/12/2000 con 8 pares → la capa inicial pasa a ser FOTO (sin inferido) y quedan 3
  ust := (public.inv_upload_begin('STOCK', 'Stock C115.xlsx', DATE '2000-12-31')->>'upload_id')::uuid;
  PERFORM public.inv_upload_rows(ust, jsonb_build_array(jsonb_build_object('__row', 2, 'BODEGA', 'C115 MRO', 'Producto', 'C115.GUANTE',
    'Cantidad', 8, 'UNIDAD', 'PAR')));
  PERFORM public.inv_upload_apply_core(ust);
  r := public.inv_rebuild();
  IF EXISTS (SELECT 1 FROM public.inv_layers WHERE bodega = 'C115 MRO' AND source = 'FOTO' AND qty = 8 AND consumed = 5)
     AND NOT EXISTS (SELECT 1 FROM public.inv_layers WHERE bodega = 'C115 MRO' AND source = 'INFERIDA')
     AND (SELECT snapshot_cutoff FROM public.inv_state) = DATE '2000-12-31'
     AND (SELECT (x->>'qty')::numeric FROM jsonb_array_elements(public.inv_stock(jsonb_build_object('q', 'C115.GUANTE'))->'filas') x LIMIT 1) = 3
  THEN pass := pass + 1; ELSE fails := fails || 'T6 foto de stock'::text; END IF;

  -- T7: volver a cargar Entradas del mismo rango reemplaza (no duplica)
  ue := (public.inv_upload_begin('E', 'Entradas C115 bis.xlsx')->>'upload_id')::uuid;
  PERFORM public.inv_upload_rows(ue, rows_e);
  r := public.inv_upload_apply_core(ue);
  IF (r->>'success')::boolean AND (r->>'replaced')::int >= 5
     AND (SELECT count(*) FROM public.inv_movements WHERE active AND side = 'E' AND bodega LIKE 'C115 %') = 5
  THEN pass := pass + 1; ELSE fails := fails || ('T7 reemplazo: ' || COALESCE(r::text, '∅')); END IF;
  r := public.inv_rebuild();

  -- T8: trazabilidad del contrato: encuentra el lote de origen (pernería 2870) y las etapas PT → ST
  r := public.inv_trace('99998-S001');
  IF (r->>'encontrado')::boolean AND r->'lotes_origen' ? '2870'
     AND (SELECT count(*) FROM jsonb_array_elements(r->'etapas') e WHERE e->>'bodega' IN ('C115 647-04 ALM PT', 'C115 ST-VENTAS', 'C115 ALM PERNERIA')) = 3
  THEN pass := pass + 1; ELSE fails := fails || ('T8 trazabilidad: ' || left(COALESCE(r::text, '∅'), 300)); END IF;

  -- T9: préstamo de herramientas: salieron 3, volvió 1 → pendiente 2
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(public.inv_tool_loans_summary()->'detalle') x
             WHERE x->>'numero' = 'T003-9000001' AND (x->>'pendiente')::numeric = 2)
  THEN pass := pass + 1; ELSE fails := fails || 'T9 herramientas'::text; END IF;

  -- T10: lecturas para el usuario con permiso y barreras de permisos
  IF (public.inv_overview()->>'success')::boolean AND (public.inv_dwell('{}')->>'success')::boolean
     AND (public.inv_flow('{}')->>'success')::boolean AND (public.inv_status()->>'success')::boolean
     AND NOT has_function_privilege('anon', 'public.inv_status()', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.inv_rebuild()', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.inv_upload_apply_core(uuid,boolean)', 'EXECUTE')
     AND NOT has_table_privilege('authenticated', 'public.inv_movements', 'SELECT')
     AND NOT has_table_privilege('anon', 'public.inv_layers', 'SELECT')
  THEN pass := pass + 1; ELSE fails := fails || 'T10 lecturas y permisos'::text; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C115 FAIL (%/10): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C115 PASS (10/10) inventario multi-almacén: carga, traspasos con reasignación, FIFO y estadía, saldo inicial, foto de stock, trazabilidad y permisos';
END $test$;
ROLLBACK;
