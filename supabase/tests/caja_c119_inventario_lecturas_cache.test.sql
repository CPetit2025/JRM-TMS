-- CAJA C119 — Lecturas del inventario desde caché: tras recalcular y preparar la caché, Resumen, Verificación, Catálogos
-- y Stock devuelven lo mismo que el cálculo en vivo; una vista de un recálculo anterior se muestra como pendiente y,
-- sin vista guardada, se responde «preparando» al instante; con cargas pendientes el control «Modelo recalculado»
-- avisa. Se revierte.
BEGIN;
-- Límites propios: una prueba cortada por la conexión no deja trabajo pesado corriendo en producción
SET LOCAL statement_timeout = '100s';
SET LOCAL lock_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('inv_rebuild'));
SELECT pg_advisory_xact_lock(hashtext('inv_cache'));
SET LOCAL inv.live = 'on';
DO $test$
DECLARE adm uuid; ue uuid; us uuid; r jsonb; pass int := 0; fails text[] := '{}';
BEGIN
  SELECT p.id INTO adm FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
  WHERE r.name = 'Administrador' AND p.is_active ORDER BY p.id LIMIT 1;
  IF adm IS NULL THEN RAISE EXCEPTION 'CAJA C119 FAIL: falta un Administrador activo'; END IF;
  PERFORM set_config('request.jwt.claim.sub', adm::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', adm, 'role', 'authenticated')::text, true);
  -- Aislar sin tocar los datos reales: el recálculo y las lecturas solo ven las bodegas de esta prueba
  PERFORM set_config('inv.scope', 'C119 %', true);
  UPDATE public.inv_uploads SET status = 'DESCARTADA' WHERE status = 'CARGANDO' OR (side = 'STOCK' AND status = 'APLICADA');

  ue := (public.inv_upload_begin('E', 'C119 Entradas.xlsx')->>'upload_id')::uuid;
  PERFORM public.inv_upload_rows(ue, jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', 'C119 647-04 ALM PT', 'Numero', '919001', 'Fecha', '2001-04-01',
      'Producto', 'C119.VIGA', 'GLOSA', 'VIGA C119', 'UNIDAD', 'UND', 'Cantidad', 9, 'Lote', '99995-S001', 'PesoUnitario', 2)));
  us := (public.inv_upload_begin('S', 'C119 Salidas.xlsx')->>'upload_id')::uuid;
  PERFORM public.inv_upload_rows(us, jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'DESPACHO VENTAS', 'BODEGA', 'C119 647-04 ALM PT', 'Numero', 'T001-919002', 'Fecha', '2001-04-02',
      'Producto', 'C119.VIGA', 'GLOSA', 'VIGA C119', 'UNIDAD', 'UND', 'Cantidad', -4, 'Lote', '99995-S001', 'RazonSocial', 'CLIENTE C119', 'PesoUnitario', 2)));
  PERFORM public.inv_upload_apply_core(ue);
  PERFORM public.inv_upload_apply_core(us);
  PERFORM public.inv_rebuild();
  r := public.inv_cache_refresh();
  IF (r->>'success')::boolean THEN pass := pass + 1; ELSE fails := fails || ('T1 refresh ' || r::text); END IF;
  -- La caché no cambia la identidad de quien la prepara
  IF auth.uid() IS DISTINCT FROM adm THEN fails := fails || 'T1 identidad'::text; END IF;

  -- T2: vistas guardadas = cálculo en vivo
  IF (public.inv_overview(NULL, NULL) - 'cache') = public.inv_overview_live(NULL, NULL)
     AND (public.inv_verify() - 'cache') = public.inv_verify_live()
     AND (public.inv_catalogs() - 'cache') = public.inv_catalogs_live()
     AND (public.inv_dwell('{}') - 'cache') = public.inv_dwell_live('{}')
     AND public.inv_verify() ? 'cache'
  THEN pass := pass + 1; ELSE fails := fails || 'T2 vistas distintas del cálculo en vivo'::text; END IF;

  -- T3: stock guardado = en vivo (totales y filas, con glosa y cliente)
  r := public.inv_stock('{"q":"C119"}');
  IF (r->'totales') = (public.inv_stock_live('{"q":"C119"}')->'totales') AND (r->'filas') = (public.inv_stock_live('{"q":"C119"}')->'filas')
     AND (r->'filas'->0->>'qty')::numeric = 5 AND r->'filas'->0->>'cliente' = 'CLIENTE C119' AND r->'filas'->0->>'glosa' = 'VIGA C119'
  THEN pass := pass + 1; ELSE fails := fails || ('T3 stock ' || left(r::text, 300)); END IF;

  -- T4: con cargas pendientes, «Modelo recalculado» avisa sobre la vista guardada
  UPDATE public.inv_state SET dirty = true WHERE id = 1;
  r := public.inv_verify();
  IF (SELECT x->>'estado' FROM jsonb_array_elements(r->'checks') x WHERE x->>'id' = 'al_dia') = 'AVISO' AND r ? 'cache'
  THEN pass := pass + 1; ELSE fails := fails || ('T4 pendiente ' || left(r::text, 200)); END IF;

  -- T5: una vista de un recálculo anterior se sigue mostrando, marcada como pendiente (no se calcula en vivo);
  --     sin vista guardada y sin permiso de cálculo en vivo, la respuesta es «se está preparando»
  UPDATE public.inv_state SET dirty = false, rebuilt_at = rebuilt_at + interval '1 second' WHERE id = 1;
  r := public.inv_verify();
  IF r ? 'cache' AND NOT (r->'cache'->>'al_dia')::boolean
     AND (SELECT x->>'estado' FROM jsonb_array_elements(r->'checks') x WHERE x->>'id' = 'al_dia') = 'AVISO'
     AND public.inv_overview(NULL, NULL) ? 'cache' THEN
    DELETE FROM public.inv_read_cache WHERE k = 'overview';
    PERFORM set_config('inv.live', 'off', true);
    r := public.inv_overview(NULL, NULL);
    PERFORM set_config('inv.live', 'on', true);
    IF (r->>'preparando')::boolean AND NOT (r->>'success')::boolean THEN pass := pass + 1;
    ELSE fails := fails || ('T5 sin vista ' || r::text); END IF;
  ELSE fails := fails || 'T5 vista anterior no mostrada'::text; END IF;

  -- T6: permisos (solo el servidor prepara la caché; las tablas no son legibles por la web)
  IF NOT has_function_privilege('authenticated', 'public.inv_cache_refresh()', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.inv_stock_live(jsonb)', 'EXECUTE')
     AND NOT has_table_privilege('authenticated', 'public.inv_stock_cache', 'SELECT')
     AND NOT has_table_privilege('authenticated', 'public.inv_read_cache', 'SELECT')
     AND has_function_privilege('authenticated', 'public.inv_stock(jsonb)', 'EXECUTE')
  THEN pass := pass + 1; ELSE fails := fails || 'T6 permisos'::text; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C119 FAIL (%/6): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C119 PASS (6/6) lecturas del inventario desde caché: iguales al cálculo en vivo, vigencia y permisos';
END $test$;
ROLLBACK;
