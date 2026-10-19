-- CAJA C118 — El recálculo programado no compite con una carga en preparación: se salta mientras hay una carga reciente
-- en estado CARGANDO, recalcula cuando ya no la hay, y aplicar sigue funcionando con el bloqueo propio. Se revierte.
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
DECLARE adm uuid; u uuid; r jsonb; pass int := 0; fails text[] := '{}';
BEGIN
  SELECT p.id INTO adm FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
  WHERE r.name = 'Administrador' AND p.is_active ORDER BY p.id LIMIT 1;
  IF adm IS NULL THEN RAISE EXCEPTION 'CAJA C118 FAIL: falta un Administrador activo'; END IF;
  PERFORM set_config('request.jwt.claim.sub', adm::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', adm, 'role', 'authenticated')::text, true);
  -- Sin cargas reales en preparación (todo se revierte al final)
  -- Aislar sin tocar los datos reales: el recálculo y las lecturas solo ven las bodegas de esta prueba
  PERFORM set_config('inv.scope', 'C118 %', true);
  UPDATE public.inv_uploads SET status = 'DESCARTADA' WHERE status = 'CARGANDO' OR (side = 'STOCK' AND status = 'APLICADA');

  u := (public.inv_upload_begin('E', 'C118 Entradas.xlsx')->>'upload_id')::uuid;
  PERFORM public.inv_upload_rows(u, jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', 'C118 647-04 ALM PT', 'Numero', '918001', 'Fecha', '2001-03-01',
      'Producto', 'C118.VIGA', 'Cantidad', 7, 'Lote', '99996-S001', 'PesoUnitario', 2)));
  UPDATE public.inv_state SET dirty = true WHERE id = 1;

  -- T1: con una carga en preparación el recálculo programado se salta
  r := public.inv_rebuild_if_dirty();
  IF r->>'skipped' = 'carga en curso' THEN pass := pass + 1; ELSE fails := fails || ('T1 ' || r::text); END IF;

  -- T2: aplicar con el bloqueo libre funciona y deja la carga aplicada
  r := public.inv_upload_apply_core(u);
  IF (r->>'success')::boolean AND (r->>'rows')::int = 1 AND r->>'busy' IS NULL THEN pass := pass + 1; ELSE fails := fails || ('T2 ' || r::text); END IF;

  -- T3: sin cargas en preparación, recalcula y deja el modelo al día
  r := public.inv_rebuild_if_dirty();
  IF (r->>'rebuilt')::boolean AND NOT (SELECT dirty FROM public.inv_state WHERE id = 1)
     AND EXISTS (SELECT 1 FROM public.inv_layers WHERE bodega = 'C118 647-04 ALM PT')
  THEN pass := pass + 1; ELSE fails := fails || ('T3 ' || r::text); END IF;

  -- T4: sin cambios no recalcula; una carga abandonada (más de 45 min) no bloquea el recálculo
  r := public.inv_rebuild_if_dirty();
  IF r->>'skipped' = 'sin cambios' THEN pass := pass + 1; ELSE fails := fails || ('T4a ' || r::text); END IF;
  u := (public.inv_upload_begin('S', 'C118 Salidas.xlsx')->>'upload_id')::uuid;
  UPDATE public.inv_uploads SET created_at = now() - interval '2 hours' WHERE id = u;
  UPDATE public.inv_state SET dirty = true WHERE id = 1;
  r := public.inv_rebuild_if_dirty();
  IF (r->>'rebuilt')::boolean THEN pass := pass + 1; ELSE fails := fails || ('T4b ' || r::text); END IF;

  -- T5: permisos
  IF NOT has_function_privilege('authenticated', 'public.inv_rebuild_if_dirty()', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.inv_upload_apply_core(uuid,boolean)', 'EXECUTE')
  THEN pass := pass + 1; ELSE fails := fails || 'T5 permisos'::text; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C118 FAIL (%/6): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C118 PASS (6/6) carga sin bloqueo: el recálculo programado respeta las cargas en preparación';
END $test$;
ROLLBACK;
