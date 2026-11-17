-- CAJA C224 — Estadía por contrato y bodega (inv_estadia_contratos): una fila por contrato y bodega con el saldo actual,
-- estadía ponderada por kg del stock que queda, el traspaso 647 → ST no reinicia la antigüedad, lo despachado no cuenta,
-- % > 60 días, lote sin contrato y permisos. Se revierte.
BEGIN;
SET LOCAL statement_timeout = '100s';
SET LOCAL lock_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('inv_rebuild'));
SELECT pg_advisory_xact_lock(hashtext('inv_cache'));
SET LOCAL inv.live = 'on';
DO $test$
DECLARE adm uuid; ue uuid; us uuid; r jsonb; p jsonb; c date; d1 date := '2001-01-01'; d2 date := '2001-05-01';
  pass int := 0; fails text[] := '{}';
BEGIN
  SELECT p.id INTO adm FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
  WHERE r.name = 'Administrador' AND p.is_active ORDER BY p.id LIMIT 1;
  IF adm IS NULL THEN RAISE EXCEPTION 'CAJA C224 FAIL: falta un Administrador activo'; END IF;
  PERFORM set_config('request.jwt.claim.sub', adm::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', adm, 'role', 'authenticated')::text, true);
  PERFORM set_config('inv.scope', '%C224%', true);
  UPDATE public.inv_uploads SET status = 'DESCARTADA' WHERE status = 'CARGANDO' OR (side = 'STOCK' AND status = 'APLICADA');

  -- 647: dos ingresos de la misma OT (10 und × 2 kg el día d1 y 10 und × 2 kg el día d2); 6 und pasan a ST el día d1 + 1 y ST despacha 4 el día d2
  ue := (public.inv_upload_begin('E', 'C224 Entradas.xlsx')->>'upload_id')::uuid;
  PERFORM public.inv_upload_rows(ue, jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', '647-04 C224 ALM PT', 'Numero', '924001', 'Fecha', d1,
      'Producto', 'C224.VIGA', 'GLOSA', 'VIGA C224', 'UNIDAD', 'UND', 'Cantidad', 10, 'Lote', '99984-S001', 'PesoUnitario', 2),
    jsonb_build_object('__row', 3, 'TIPODOCTO', 'TRASPASO DE ALMACEN', 'BODEGA', 'ST-VENTAS C224', 'Numero', '924002', 'Fecha', d1 + 1,
      'Producto', 'C224.VIGA', 'GLOSA', 'VIGA C224', 'UNIDAD', 'UND', 'Cantidad', 6, 'Lote', '99984-S001', 'PesoUnitario', 2),
    jsonb_build_object('__row', 4, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', '647-04 C224 ALM PT', 'Numero', '924004', 'Fecha', d2,
      'Producto', 'C224.VIGA', 'GLOSA', 'VIGA C224', 'UNIDAD', 'UND', 'Cantidad', 10, 'Lote', '99984-S001', 'PesoUnitario', 2),
    -- Lote sin contrato (no tiene formato de OT)
    jsonb_build_object('__row', 5, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', '540-04 C224 APT LB', 'Numero', '924005', 'Fecha', d2,
      'Producto', 'C224.PLACA', 'GLOSA', 'PLACA C224', 'UNIDAD', 'UND', 'Cantidad', 5, 'Lote', '2224', 'PesoUnitario', 3)));
  us := (public.inv_upload_begin('S', 'C224 Salidas.xlsx')->>'upload_id')::uuid;
  PERFORM public.inv_upload_rows(us, jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'TRASPASO DE ALMACEN', 'BODEGA', '647-04 C224 ALM PT', 'Numero', '924002', 'Fecha', d1 + 1,
      'Producto', 'C224.VIGA', 'GLOSA', 'VIGA C224', 'UNIDAD', 'UND', 'Cantidad', -6, 'Lote', '99984-S001', 'PesoUnitario', 2),
    jsonb_build_object('__row', 3, 'TIPODOCTO', 'DESPACHO VENTAS', 'BODEGA', 'ST-VENTAS C224', 'Numero', 'T001-924003', 'Fecha', d2,
      'Producto', 'C224.VIGA', 'GLOSA', 'VIGA C224', 'UNIDAD', 'UND', 'Cantidad', -4, 'Lote', '99984-S001', 'RazonSocial', 'CLIENTE C224',
      'FechaEntrega', d2 + 1, 'PesoUnitario', 2)));
  PERFORM public.inv_upload_apply_core(ue);
  PERFORM public.inv_upload_apply_core(us);
  PERFORM public.inv_rebuild();
  r := public.inv_cache_refresh();
  SELECT data_max INTO c FROM public.inv_state WHERE id = 1;
  r := public.inv_estadia_contratos();
  IF (r->>'success')::boolean AND (r->>'corte')::date = c THEN pass := pass + 1; ELSE fails := fails || ('T1 ' || left(r::text, 300)); END IF;

  -- T2: 647 queda con 4 und de d1 (8 kg) y 10 und de d2 (20 kg): estadía ponderada por kg, % > 60 d = 8 / 28
  p := (SELECT x FROM jsonb_array_elements(r->'filas') x WHERE x->>'contrato' = '99984-S001' AND x->>'bodega' = '647-04 C224 ALM PT');
  IF (p->>'stock_kg')::numeric = 28 AND p->>'ot' = '99984' AND p->>'almacen' = '647'
     AND (p->>'estadia')::numeric = round((8 * (c - d1) + 20 * (c - d2)) / 28.0, 1)
     AND (p->>'pct_60')::numeric = round(100 * 8 / 28.0, 1) AND (p->>'kg_60')::numeric = 8 AND (p->>'pct_nd')::numeric = 0
  THEN pass := pass + 1; ELSE fails := fails || ('T2 647 ' || COALESCE(p::text, 'sin fila')); END IF;

  -- T3: ST queda con 2 und (4 kg): el traspaso 647 → ST no reinicia la antigüedad (cuenta desde d1) y lo despachado no suma
  p := (SELECT x FROM jsonb_array_elements(r->'filas') x WHERE x->>'contrato' = '99984-S001' AND x->>'bodega' = 'ST-VENTAS C224');
  IF (p->>'stock_kg')::numeric = 4 AND (p->>'estadia')::numeric = c - d1 AND (p->>'pct_60')::numeric = 100 AND p->>'cliente' = 'CLIENTE C224'
  THEN pass := pass + 1; ELSE fails := fails || ('T3 ST ' || COALESCE(p::text, 'sin fila')); END IF;

  -- T4: lote sin contrato: sin código de contrato ni OT inventados; saldo de la OT igual al de inv_dwell_dim
  p := (SELECT x FROM jsonb_array_elements(r->'filas') x WHERE x->>'lote' = '2224');
  IF p IS NOT NULL AND p->>'contrato' IS NULL AND p->>'ot' IS NULL AND (p->>'stock_kg')::numeric = 15
     AND (SELECT sum((x->>'stock_kg')::numeric) FROM jsonb_array_elements(r->'filas') x WHERE x->>'ot' = '99984')
       = (SELECT (x->>'stock_kg')::numeric FROM jsonb_array_elements(public.inv_dwell_dim('{"dim":"ot","ambito":"apt","limit":5000}')->'filas') x
          WHERE x->>'key' = '99984')
  THEN pass := pass + 1; ELSE fails := fails || ('T4 sin contrato / saldo ' || COALESCE(p::text, 'sin fila')); END IF;

  -- T5: permisos
  IF has_function_privilege('authenticated', 'public.inv_estadia_contratos()', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.inv_estadia_contratos()', 'EXECUTE')
  THEN pass := pass + 1; ELSE fails := fails || 'T5 permisos'::text; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C224 FAIL (%/5): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C224 PASS (5/5) estadía por contrato y bodega ponderada, sin reinicio por traspaso y stock de más de 60 días';
END $test$;
ROLLBACK;
