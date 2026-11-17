-- CAJA C225 — Contratos ocultos en el APT: ocultar una OT (raíz) la saca del modelo (estadía, estadía por OT, stock y
-- trazabilidad) tras el recálculo sin borrar sus movimientos; ocultar un lote exacto solo saca ese lote; volver a mostrar
-- la recupera; código inexistente o sin motivo se rechaza; permisos. Se revierte.
BEGIN;
SET LOCAL statement_timeout = '100s';
SET LOCAL lock_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('inv_rebuild'));
SELECT pg_advisory_xact_lock(hashtext('inv_cache'));
SET LOCAL inv.live = 'on';
DO $test$
DECLARE adm uuid; ue uuid; r jsonb; n_mov int; pass int := 0; fails text[] := '{}';
BEGIN
  SELECT p.id INTO adm FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
  WHERE r.name = 'Administrador' AND p.is_active ORDER BY p.id LIMIT 1;
  IF adm IS NULL THEN RAISE EXCEPTION 'CAJA C225 FAIL: falta un Administrador activo'; END IF;
  PERFORM set_config('request.jwt.claim.sub', adm::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', adm, 'role', 'authenticated')::text, true);
  PERFORM set_config('inv.scope', '%C225%', true);
  UPDATE public.inv_uploads SET status = 'DESCARTADA' WHERE status = 'CARGANDO' OR (side = 'STOCK' AND status = 'APLICADA');
  -- Sin ocultos previos dentro de la prueba (se revierte)
  DELETE FROM public.inv_contratos_ocultos;

  ue := (public.inv_upload_begin('E', 'C225 Entradas.xlsx')->>'upload_id')::uuid;
  PERFORM public.inv_upload_rows(ue, jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', '647-04 C225 ALM PT', 'Numero', '925001', 'Fecha', '2001-03-01',
      'Producto', 'C225.VIGA', 'GLOSA', 'VIGA C225', 'UNIDAD', 'UND', 'Cantidad', 10, 'Lote', '99975-S001', 'PesoUnitario', 2),
    jsonb_build_object('__row', 3, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', '647-04 C225 ALM PT', 'Numero', '925002', 'Fecha', '2001-03-02',
      'Producto', 'C225.VIGA', 'GLOSA', 'VIGA C225', 'UNIDAD', 'UND', 'Cantidad', 5, 'Lote', '99975-S002', 'PesoUnitario', 2),
    jsonb_build_object('__row', 4, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', '647-04 C225 ALM PT', 'Numero', '925003', 'Fecha', '2001-03-03',
      'Producto', 'C225.PLACA', 'GLOSA', 'PLACA C225', 'UNIDAD', 'UND', 'Cantidad', 4, 'Lote', '99974-S001', 'PesoUnitario', 3)));
  PERFORM public.inv_upload_apply_core(ue);
  SELECT count(*) INTO n_mov FROM public.inv_movements WHERE bodega LIKE '%C225%';

  -- T1: validaciones (código inexistente, sin motivo) y permisos
  IF NOT (public.inv_ocultos_save('{"codigo":"88888","motivo":"error"}')->>'success')::boolean
     AND NOT (public.inv_ocultos_save('{"codigo":"99975","motivo":""}')->>'success')::boolean
     AND NOT has_function_privilege('anon', 'public.inv_ocultos_save(jsonb)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.inv_ocultos_list()', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.inv_ocultos_save(jsonb)', 'EXECUTE')
  THEN pass := pass + 1; ELSE fails := fails || 'T1 validaciones / permisos'::text; END IF;

  -- T2: ocultar la OT raíz 99975 (sus dos lotes) y el lote exacto 99974-S001 no; marca el modelo para recalcular
  UPDATE public.inv_state SET dirty = false WHERE id = 1;
  r := public.inv_ocultos_save('{"codigo":" 99975 ","motivo":"Error del sistema C225"}');
  IF (r->>'success')::boolean AND r->>'codigo' = '99975' AND (SELECT dirty FROM public.inv_state WHERE id = 1)
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(public.inv_ocultos_list()->'filas') x
                 WHERE x->>'codigo' = '99975' AND x->>'motivo' = 'Error del sistema C225' AND x->>'usuario' IS NOT NULL)
  THEN pass := pass + 1; ELSE fails := fails || ('T2 ocultar ' || r::text); END IF;

  -- T3: tras el recálculo la OT no está en estadía, estadía por OT, stock ni trazabilidad; la otra OT sí; nada se borró
  PERFORM public.inv_rebuild();
  PERFORM public.inv_cache_refresh();
  r := public.inv_estadia_contratos();
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'filas') x WHERE x->>'ot' = '99975')
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(r->'filas') x WHERE x->>'contrato' = '99974-S001' AND (x->>'stock_kg')::numeric = 12)
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.inv_dwell_dim('{"dim":"ot","ambito":"apt","limit":5000}')->'filas') x WHERE x->>'key' = '99975')
     AND NOT EXISTS (SELECT 1 FROM public.inv_stock_cache WHERE lote LIKE '99975%')
     AND position('99975-S00' IN public.inv_trace('99975')::text) = 0
     AND (SELECT count(*) FROM public.inv_movements WHERE bodega LIKE '%C225%') = n_mov
     AND (SELECT (x->>'stock_kg')::numeric FROM jsonb_array_elements(public.inv_ocultos_list()->'filas') x WHERE x->>'codigo' = '99975') = 30
  THEN pass := pass + 1; ELSE fails := fails || ('T3 fuera del modelo ' || left(r::text, 300)); END IF;

  -- T4: volver a mostrar la recupera con su saldo; ocultar solo un lote exacto saca ese lote y deja el otro
  r := public.inv_ocultos_save('{"codigo":"99975","ocultar":false}');
  PERFORM public.inv_ocultos_save('{"codigo":"99975-s002","motivo":"Lote duplicado C225"}');
  PERFORM public.inv_rebuild();
  PERFORM public.inv_cache_refresh();
  IF (r->>'success')::boolean
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(public.inv_estadia_contratos()->'filas') x WHERE x->>'contrato' = '99975-S001' AND (x->>'stock_kg')::numeric = 20)
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.inv_estadia_contratos()->'filas') x WHERE x->>'contrato' = '99975-S002')
     AND NOT (public.inv_ocultos_save('{"codigo":"99975","ocultar":false}')->>'success')::boolean
  THEN pass := pass + 1; ELSE fails := fails || ('T4 mostrar de nuevo ' || r::text); END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C225 FAIL (%/4): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C225 PASS (4/4) contratos ocultos fuera del modelo APT sin borrar movimientos, y se recuperan';
END $test$;
ROLLBACK;
