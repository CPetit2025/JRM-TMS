-- CAJA C117 — Verificación del inventario: inv_verify cuadra por bodega (saldo = inicial + entradas − salidas, sin
-- pérdidas del modelo), mide traspasos emparejados y salidas con origen inferido, y detecta un descuadre. Se revierte.
BEGIN;
-- Límites propios: una prueba cortada por la conexión no deja trabajo pesado corriendo en producción
SET LOCAL statement_timeout = '100s';
SET LOCAL lock_timeout = '60s';
-- Esperar a un recálculo real en curso (cron o carga) en vez de chocar con él a mitad de la prueba
SELECT pg_advisory_xact_lock(hashtext('inv_rebuild'));
-- Sin vistas guardadas del modelo real: las lecturas se calculan en vivo sobre los datos de la prueba
SET LOCAL inv.live = 'on';
DELETE FROM public.inv_read_cache;
DO $test$
DECLARE adm uuid; ue uuid; us uuid; r jsonb; row jsonb; pass int := 0; fails text[] := '{}';
BEGIN
  SELECT p.id INTO adm FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
  WHERE r.name = 'Administrador' AND p.is_active ORDER BY p.id LIMIT 1;
  IF adm IS NULL THEN RAISE EXCEPTION 'CAJA C117 FAIL: falta un Administrador activo'; END IF;
  PERFORM set_config('request.jwt.claim.sub', adm::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', adm, 'role', 'authenticated')::text, true);
  UPDATE public.inv_uploads SET status = 'DESCARTADA' WHERE side = 'STOCK' AND status = 'APLICADA';
  -- Aislar la prueba: los controles son globales, así que los movimientos reales se desactivan dentro de esta
  -- transacción (se revierte al final) y los porcentajes dependen solo de los datos de la prueba.
  UPDATE public.inv_movements SET active = false WHERE active;

  -- PT: produce 10 (día 1); traspasa 6 a ST (día 2); ST despacha 4 (día 3). MRO consume 5 sin ingreso previo (inferido).
  ue := (public.inv_upload_begin('E', 'C117 Entradas.xlsx')->>'upload_id')::uuid;
  PERFORM public.inv_upload_rows(ue, jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', 'C117 647-04 ALM PT', 'Numero', '917001', 'Fecha', '2001-02-01',
      'Producto', 'C117.VIGA', 'Cantidad', 10, 'Lote', '99997-S001', 'PesoUnitario', 3),
    jsonb_build_object('__row', 3, 'TIPODOCTO', 'TRASPASO DE ALMACEN', 'BODEGA', 'C117 ST-VENTAS', 'Numero', '917002', 'Fecha', '2001-02-02',
      'Producto', 'C117.VIGA', 'Cantidad', 6, 'Lote', '99997-S001', 'PesoUnitario', 3)));
  us := (public.inv_upload_begin('S', 'C117 Salidas.xlsx')->>'upload_id')::uuid;
  PERFORM public.inv_upload_rows(us, jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'TRASPASO DE ALMACEN', 'BODEGA', 'C117 647-04 ALM PT', 'Numero', '917002', 'Fecha', '2001-02-02',
      'Producto', 'C117.VIGA', 'Cantidad', -6, 'Lote', '99997-S001', 'PesoUnitario', 3),
    jsonb_build_object('__row', 3, 'TIPODOCTO', 'DESPACHO VENTAS', 'BODEGA', 'C117 ST-VENTAS', 'Numero', 'T001-917003', 'Fecha', '2001-02-03',
      'Producto', 'C117.VIGA', 'Cantidad', -4, 'Lote', '99997-S001', 'PesoUnitario', 3),
    jsonb_build_object('__row', 4, 'TIPODOCTO', 'VALE DE CONSUMO', 'BODEGA', 'C117 MRO', 'Numero', '917004', 'Fecha', '2001-02-03',
      'Producto', 'C117.GUANTE', 'Cantidad', -5)));
  PERFORM public.inv_upload_apply_core(ue);
  PERFORM public.inv_upload_apply_core(us);
  PERFORM public.inv_rebuild();
  r := public.inv_verify();

  -- T1: seis controles con estado y el resumen de aprobados
  IF (r->>'success')::boolean AND jsonb_array_length(r->'checks') = 6 AND (r->>'total')::int = 6
     AND (SELECT bool_and(x->>'estado' IN ('OK', 'AVISO', 'FALLA', 'SIN_DATOS')) FROM jsonb_array_elements(r->'checks') x)
  THEN pass := pass + 1; ELSE fails := fails || ('T1 controles: ' || left(COALESCE(r::text, '∅'), 300)); END IF;

  -- T2: cuadre exacto por bodega (PT: 10 − 6 = 4; ST: 6 − 4 = 2; MRO: 5 inferido − 5 = 0)
  SELECT x INTO row FROM jsonb_array_elements(r->'cuadre') x WHERE x->>'bodega' = 'C117 647-04 ALM PT';
  IF (row->>'ok')::boolean AND (row->>'entradas_archivo')::numeric = 10 AND (row->>'salidas_modelo')::numeric = 6 AND (row->>'saldo_modelo')::numeric = 4
     AND (SELECT (x->>'saldo_modelo')::numeric FROM jsonb_array_elements(r->'cuadre') x WHERE x->>'bodega' = 'C117 ST-VENTAS') = 2
     AND (SELECT (x->>'ok')::boolean AND (x->>'saldo_inicial_inferido')::numeric = 5 AND (x->>'saldo_modelo')::numeric = 0
          FROM jsonb_array_elements(r->'cuadre') x WHERE x->>'bodega' = 'C117 MRO')
  THEN pass := pass + 1; ELSE fails := fails || ('T2 cuadre: ' || COALESCE(row::text, '∅')); END IF;

  -- T3: valores exactos: 2 de 2 líneas de traspaso emparejadas (100 %); 2 de 3 consumos con origen conocido
  --     (el de MRO sale de saldo inferido) = 66,7 %; 3 de 3 bodegas cuadran
  IF (SELECT (x->>'valor')::numeric FROM jsonb_array_elements(r->'checks') x WHERE x->>'id' = 'traspasos') = 100
     AND (SELECT (x->>'valor')::numeric FROM jsonb_array_elements(r->'checks') x WHERE x->>'id' = 'origen') = 66.7
     AND (SELECT x->>'estado' FROM jsonb_array_elements(r->'checks') x WHERE x->>'id' = 'origen') = 'FALLA'
     AND (SELECT (x->>'valor')::int FROM jsonb_array_elements(r->'checks') x WHERE x->>'id' = 'cuadre') = 3
  THEN pass := pass + 1;
  ELSE fails := fails || ('T3 traspasos y origen: ' || COALESCE((SELECT string_agg((x->>'id') || '=' || COALESCE(x->>'valor', '∅') || '/' || (x->>'estado'), ', ')
    FROM jsonb_array_elements(r->'checks') x), '∅'));
  END IF;

  -- T4: un descuadre (consumo alterado en el modelo) se detecta como FALLA en esa bodega
  UPDATE public.inv_layers SET consumed = consumed + 1 WHERE bodega = 'C117 ST-VENTAS';
  r := public.inv_verify();
  IF (SELECT x->>'estado' FROM jsonb_array_elements(r->'checks') x WHERE x->>'id' = 'cuadre') = 'FALLA'
     AND (SELECT NOT (x->>'ok')::boolean AND (x->>'diferencia')::numeric <> 0 FROM jsonb_array_elements(r->'cuadre') x WHERE x->>'bodega' = 'C117 ST-VENTAS')
  THEN pass := pass + 1; ELSE fails := fails || 'T4 descuadre no detectado'::text; END IF;

  -- T5: permisos
  IF NOT has_function_privilege('anon', 'public.inv_verify()', 'EXECUTE') AND has_function_privilege('authenticated', 'public.inv_verify()', 'EXECUTE')
  THEN pass := pass + 1; ELSE fails := fails || 'T5 permisos'::text; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C117 FAIL (%/5): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C117 PASS (5/5) verificación del inventario: cuadre por bodega, traspasos, origen inferido, detección de descuadre y permisos';
END $test$;
ROLLBACK;
