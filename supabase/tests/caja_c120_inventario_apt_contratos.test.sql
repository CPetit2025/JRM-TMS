-- CAJA C120 — APT en tres almacenes (647 · 540 · ST) y ficha de contrato / OT: la OT reúne sus lotes; el traspaso
-- 647 → ST de la misma OT es interno (no se cuenta dos veces); Ingresado − Despachado − Otras salidas − Stock = 0 por ID;
-- stock por almacén, glosa, guías, lotes parecidos; la lista de contratos y el ámbito APT de Stock y Estadía dejan
-- fuera las bodegas que no son del APT. Se revierte.
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
  IF adm IS NULL THEN RAISE EXCEPTION 'CAJA C120 FAIL: falta un Administrador activo'; END IF;
  PERFORM set_config('request.jwt.claim.sub', adm::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', adm, 'role', 'authenticated')::text, true);
  -- Aislar sin tocar los datos reales: solo las bodegas de esta prueba (sus nombres conservan el prefijo del almacén APT)
  PERFORM set_config('inv.scope', '%C120%', true);
  UPDATE public.inv_uploads SET status = 'DESCARTADA' WHERE status = 'CARGANDO' OR (side = 'STOCK' AND status = 'APLICADA');

  ue := (public.inv_upload_begin('E', 'C120 Entradas.xlsx')->>'upload_id')::uuid;
  PERFORM public.inv_upload_rows(ue, jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', '647-04 C120 ALM PT', 'Numero', '920001', 'Fecha', '2001-05-01',
      'Producto', 'C120.VIGA', 'GLOSA', 'VIGA C120', 'UNIDAD', 'UND', 'Cantidad', 10, 'Lote', '99996-S001', 'PesoUnitario', 2),
    jsonb_build_object('__row', 3, 'TIPODOCTO', 'TRASPASO DE ALMACEN', 'BODEGA', 'ST-VENTAS C120', 'Numero', '920002', 'Fecha', '2001-05-02',
      'Producto', 'C120.VIGA', 'GLOSA', 'VIGA C120', 'UNIDAD', 'UND', 'Cantidad', 6, 'Lote', '99996-S001', 'PesoUnitario', 2),
    -- Fuera del APT: no entra en la ficha ni en el ámbito APT
    jsonb_build_object('__row', 4, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', 'C120 PLANTA', 'Numero', '920004', 'Fecha', '2001-05-01',
      'Producto', 'C120.VIGA', 'GLOSA', 'VIGA C120', 'UNIDAD', 'UND', 'Cantidad', 3, 'Lote', '99996-S001', 'PesoUnitario', 2),
    -- Lote con un dígito distinto (posible error de digitación)
    jsonb_build_object('__row', 5, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', '647-04 C120 ALM PT', 'Numero', '920005', 'Fecha', '2001-05-01',
      'Producto', 'C120.PERNO', 'GLOSA', 'PERNO C120', 'UNIDAD', 'UND', 'Cantidad', 1, 'Lote', '99906-S001', 'PesoUnitario', 1)));
  us := (public.inv_upload_begin('S', 'C120 Salidas.xlsx')->>'upload_id')::uuid;
  PERFORM public.inv_upload_rows(us, jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'TRASPASO DE ALMACEN', 'BODEGA', '647-04 C120 ALM PT', 'Numero', '920002', 'Fecha', '2001-05-02',
      'Producto', 'C120.VIGA', 'GLOSA', 'VIGA C120', 'UNIDAD', 'UND', 'Cantidad', -6, 'Lote', '99996-S001', 'PesoUnitario', 2),
    jsonb_build_object('__row', 3, 'TIPODOCTO', 'DESPACHO VENTAS', 'BODEGA', 'ST-VENTAS C120', 'Numero', 'T001-920003', 'Fecha', '2001-05-03',
      'Producto', 'C120.VIGA', 'GLOSA', 'VIGA C120', 'UNIDAD', 'UND', 'Cantidad', -4, 'Lote', '99996-S001', 'RazonSocial', 'CLIENTE C120',
      'FechaEntrega', '2001-05-05', 'PesoUnitario', 2)));
  PERFORM public.inv_upload_apply_core(ue);
  PERFORM public.inv_upload_apply_core(us);
  PERFORM public.inv_rebuild();
  r := public.inv_cache_refresh();
  IF (r->>'success')::boolean THEN pass := pass + 1; ELSE fails := fails || ('T1 refresh ' || r::text); END IF;

  -- T2: ficha por un lote de la OT → la OT madre con su ID, glosa y balance
  r := public.inv_contrato('99996-S001');
  p := r->'productos'->0;
  IF (r->>'encontrado')::boolean AND r->>'ot' = '99996' AND jsonb_array_length(r->'productos') = 1
     AND p->>'producto' = 'C120.VIGA' AND p->>'glosa' = 'VIGA C120'
     AND (p->>'ingresado')::numeric = 10 AND (p->>'despachado')::numeric = 4 AND (p->>'otras_salidas')::numeric = 0
     AND (p->>'stock_647')::numeric = 4 AND (p->>'stock_st')::numeric = 2 AND (p->>'stock_540')::numeric = 0
     AND (p->>'stock')::numeric = 6 AND (p->>'diferencia')::numeric = 0
     AND p->>'ultimo_ingreso' = '2001-05-01' AND p->>'ultima_salida' = '2001-05-03'
  THEN pass := pass + 1; ELSE fails := fails || ('T2 ficha ' || left(r::text, 400)); END IF;

  -- T3: resumen (cliente, avance en kg, cumplimiento) y guías
  IF r->'resumen'->>'cliente' = 'CLIENTE C120' AND (r->'resumen'->>'ingresado_kg')::numeric = 20
     AND (r->'resumen'->>'despachado_kg')::numeric = 8 AND (r->'resumen'->>'avance_pct')::numeric = 40
     AND (r->'resumen'->>'a_tiempo_pct')::numeric = 100 AND (r->'resumen'->>'stock_647_kg')::numeric = 8
     AND jsonb_array_length(r->'guias') = 1 AND r->'guias'->0->>'numero' = 'T001-920003' AND r->'guias'->0->>'almacen' = 'ST'
     AND (r->'guias'->0->>'a_tiempo')::boolean
  THEN pass := pass + 1; ELSE fails := fails || ('T3 resumen ' || left((r->'resumen')::text || (r->'guias')::text, 400)); END IF;

  -- T4: lotes de una OT parecida
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(r->'sospechosos') x WHERE x->>'ot' = '99906')
  THEN pass := pass + 1; ELSE fails := fails || ('T4 sospechosos ' || (r->'sospechosos')::text); END IF;

  -- T5: lista de contratos y resumen por almacén
  r := public.inv_contratos();
  p := (SELECT x FROM jsonb_array_elements(r->'contratos') x WHERE x->>'ot' = '99996');
  IF p IS NOT NULL AND (p->>'stock_kg')::numeric = 12 AND (p->>'avance_pct')::numeric = 40 AND p->>'cliente' = 'CLIENTE C120'
     AND (SELECT (x->>'stock_kg')::numeric FROM jsonb_array_elements(public.inv_apt_resumen()->'almacenes') x WHERE x->>'almacen' = '647') = 9
  THEN pass := pass + 1; ELSE fails := fails || ('T5 contratos ' || left(p::text, 300)); END IF;

  -- T6: ámbito APT en Stock y Estadía (sin la planta) y glosa en el stock más antiguo
  r := public.inv_stock('{"ambito":"apt"}');
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'filas') x WHERE public.apt_almacen(x->>'bodega') IS NULL)
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(public.inv_stock('{}')->'filas') x WHERE x->>'bodega' = 'C120 PLANTA')
     AND jsonb_array_length(r->'filas') > 0
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.inv_dwell('{"ambito":"apt"}')->'mas_antiguos') x
                     WHERE public.apt_almacen(x->>'bodega') IS NULL OR x->>'glosa' IS NULL)
  THEN pass := pass + 1; ELSE fails := fails || ('T6 ámbito ' || left(r::text, 300)); END IF;

  -- T7: OT inexistente o texto sin número
  IF NOT (public.inv_contrato('99997')->>'encontrado')::boolean AND NOT (public.inv_contrato('abc')->>'success')::boolean
  THEN pass := pass + 1; ELSE fails := fails || 'T7 búsqueda vacía'::text; END IF;

  -- T8: permisos (la web solo usa las lecturas públicas)
  IF has_function_privilege('authenticated', 'public.inv_contrato(text)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.inv_contratos()', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.inv_apt_resumen()', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.inv_apt_movs(text)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.inv_contratos_refresh(timestamptz)', 'EXECUTE')
  THEN pass := pass + 1; ELSE fails := fails || 'T8 permisos'::text; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C120 FAIL (%/8): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C120 PASS (8/8) APT 647·540·ST: ficha de OT con balance por ID, guías, contratos y ámbito APT';
END $test$;
ROLLBACK;
