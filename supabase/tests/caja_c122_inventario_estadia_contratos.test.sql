-- CAJA C122 — Estadía por contrato / OT, ID (glosa) y cliente, y kardex del contrato: el ámbito APT deja fuera la planta,
-- el traspaso 647 → ST de la misma OT no cambia el saldo, la búsqueda filtra y la caché guarda las tres vistas. Se revierte.
BEGIN;
-- Límites propios: una prueba cortada por la conexión no deja trabajo pesado corriendo en producción
SET LOCAL statement_timeout = '100s';
SET LOCAL lock_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('inv_rebuild'));
SELECT pg_advisory_xact_lock(hashtext('inv_cache'));
SET LOCAL inv.live = 'on';
DO $test$
DECLARE adm uuid; ue uuid; us uuid; r jsonb; p jsonb; pass int := 0; fails text[] := '{}';
BEGIN
  SELECT p.id INTO adm FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
  WHERE r.name = 'Administrador' AND p.is_active ORDER BY p.id LIMIT 1;
  IF adm IS NULL THEN RAISE EXCEPTION 'CAJA C122 FAIL: falta un Administrador activo'; END IF;
  PERFORM set_config('request.jwt.claim.sub', adm::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', adm, 'role', 'authenticated')::text, true);
  -- Aislar sin tocar los datos reales: solo las bodegas de esta prueba (sus nombres conservan el prefijo del almacén APT)
  PERFORM set_config('inv.scope', '%C122%', true);
  UPDATE public.inv_uploads SET status = 'DESCARTADA' WHERE status = 'CARGANDO' OR (side = 'STOCK' AND status = 'APLICADA');

  ue := (public.inv_upload_begin('E', 'C122 Entradas.xlsx')->>'upload_id')::uuid;
  PERFORM public.inv_upload_rows(ue, jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', '647-04 C122 ALM PT', 'Numero', '922001', 'Fecha', '2001-05-01',
      'Producto', 'C122.VIGA', 'GLOSA', 'VIGA C122', 'UNIDAD', 'UND', 'Cantidad', 10, 'Lote', '99986-S001', 'PesoUnitario', 2),
    jsonb_build_object('__row', 3, 'TIPODOCTO', 'TRASPASO DE ALMACEN', 'BODEGA', 'ST-VENTAS C122', 'Numero', '922002', 'Fecha', '2001-05-02',
      'Producto', 'C122.VIGA', 'GLOSA', 'VIGA C122', 'UNIDAD', 'UND', 'Cantidad', 6, 'Lote', '99986-S001', 'PesoUnitario', 2),
    -- Fuera del APT: no entra en la ficha ni en el ámbito APT
    jsonb_build_object('__row', 4, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', 'C122 PLANTA', 'Numero', '922004', 'Fecha', '2001-05-01',
      'Producto', 'C122.VIGA', 'GLOSA', 'VIGA C122', 'UNIDAD', 'UND', 'Cantidad', 3, 'Lote', '99986-S001', 'PesoUnitario', 2),
    -- Lote con un dígito distinto (posible error de digitación)
    jsonb_build_object('__row', 5, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', '647-04 C122 ALM PT', 'Numero', '922005', 'Fecha', '2001-05-01',
      'Producto', 'C122.PERNO', 'GLOSA', 'PERNO C122', 'UNIDAD', 'UND', 'Cantidad', 1, 'Lote', '99886-S001', 'PesoUnitario', 1)));
  us := (public.inv_upload_begin('S', 'C122 Salidas.xlsx')->>'upload_id')::uuid;
  PERFORM public.inv_upload_rows(us, jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'TRASPASO DE ALMACEN', 'BODEGA', '647-04 C122 ALM PT', 'Numero', '922002', 'Fecha', '2001-05-02',
      'Producto', 'C122.VIGA', 'GLOSA', 'VIGA C122', 'UNIDAD', 'UND', 'Cantidad', -6, 'Lote', '99986-S001', 'PesoUnitario', 2),
    jsonb_build_object('__row', 3, 'TIPODOCTO', 'DESPACHO VENTAS', 'BODEGA', 'ST-VENTAS C122', 'Numero', 'T001-922003', 'Fecha', '2001-05-03',
      'Producto', 'C122.VIGA', 'GLOSA', 'VIGA C122', 'UNIDAD', 'UND', 'Cantidad', -4, 'Lote', '99986-S001', 'RazonSocial', 'CLIENTE C122',
      'FechaEntrega', '2001-05-05', 'PesoUnitario', 2)));
  PERFORM public.inv_upload_apply_core(ue);
  PERFORM public.inv_upload_apply_core(us);
  PERFORM public.inv_rebuild();
  r := public.inv_cache_refresh();
  IF (r->>'success')::boolean THEN pass := pass + 1; ELSE fails := fails || ('T1 refresh ' || r::text); END IF;

  -- T2: estadía por OT (solo APT: la planta no suma), con cliente, despacho y días en bodega
  r := public.inv_dwell_dim('{"dim":"ot","ambito":"apt"}');
  p := (SELECT x FROM jsonb_array_elements(r->'filas') x WHERE x->>'key' = '99986');
  IF p IS NOT NULL AND (p->>'stock_kg')::numeric = 12 AND (p->>'kg_despachado')::numeric = 8 AND p->>'cliente' = 'CLIENTE C122'
     AND (p->>'max')::numeric = 1 AND (p->>'stock_dias') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.inv_read_cache WHERE k = 'dwell_apt_ot')
  THEN pass := pass + 1; ELSE fails := fails || ('T2 por OT ' || left(r::text, 400)); END IF;

  -- T3: por ID dentro de la OT, con glosa; por cliente; búsqueda por texto
  r := public.inv_dwell_dim('{"dim":"producto","ambito":"apt","ot":"99986-S001"}');
  p := (SELECT x FROM jsonb_array_elements(r->'filas') x WHERE x->>'key' = 'C122.VIGA');
  IF p->>'glosa' = 'VIGA C122' AND (p->>'stock_qty')::numeric = 6 AND (r->>'total')::int = 1
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(public.inv_dwell_dim('{"dim":"cliente","ambito":"apt"}')->'filas') x
                 WHERE x->>'key' = 'CLIENTE C122' AND (x->>'kg_despachado')::numeric = 8)
     AND (public.inv_dwell_dim('{"dim":"producto","ambito":"apt","q":"perno c122"}')->>'total')::int = 1
  THEN pass := pass + 1; ELSE fails := fails || ('T3 por ID / cliente ' || left(r::text, 300)); END IF;

  -- T4: kardex de la OT: ingresó 20 kg, salió 8 kg, saldo 12 kg; el traspaso es interno
  r := public.inv_contrato_kardex('99986');
  IF (r->'totales'->>'ingreso_kg')::numeric = 20 AND (r->'totales'->>'salida_kg')::numeric = 8 AND (r->'totales'->>'internos')::int = 2
     AND (r->'movimientos'->0->>'saldo_kg')::numeric = 12 AND (r->'serie'->-1->>'saldo_kg')::numeric = 12
     AND jsonb_array_length(r->'movimientos') = 4
  THEN pass := pass + 1; ELSE fails := fails || ('T4 kardex ' || left(r::text, 400)); END IF;

  -- T5: kardex de un ID en su unidad
  r := public.inv_contrato_kardex('99986', 'C122.VIGA');
  IF (r->'totales'->>'ingreso_qty')::numeric = 10 AND (r->'totales'->>'salida_qty')::numeric = 4 AND (r->'movimientos'->0->>'saldo_qty')::numeric = 6
  THEN pass := pass + 1; ELSE fails := fails || ('T5 kardex por ID ' || left(r::text, 300)); END IF;

  -- T6: permisos
  IF has_function_privilege('authenticated', 'public.inv_dwell_dim(jsonb)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.inv_contrato_kardex(text, text)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.inv_dwell_dim_live(jsonb)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.inv_ot_clientes()', 'EXECUTE')
  THEN pass := pass + 1; ELSE fails := fails || 'T6 permisos'::text; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C122 FAIL (%/6): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C122 PASS (6/6) estadía por OT, ID y cliente, y kardex del contrato con saldo';
END $test$;
ROLLBACK;
