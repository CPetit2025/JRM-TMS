-- CAJA C248 — Sinceramiento APT: proponer con tope en el saldo del sistema, nadie autoriza lo propio, autorizado el stock
-- pasa del APT al almacén virtual SF tras el recálculo (sin tocar los movimientos del ERP), revertir lo devuelve,
-- rechazar/anular y permisos. Se revierte.
BEGIN;
SET LOCAL statement_timeout = '100s';
SET LOCAL lock_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('inv_rebuild'));
SELECT pg_advisory_xact_lock(hashtext('inv_cache'));
SET LOCAL inv.live = 'on';
DO $test$
DECLARE adm uuid; jefe uuid; ue uuid; r jsonb; r2 jsonb; id1 bigint; id2 bigint; n_erp int; pass int := 0; fails text[] := '{}';
  bod constant text := '647-04 C248 ALM PT';
  stk numeric;
BEGIN
  -- Propone quien carga el APT (apt-carga, sin ser Administrador); autoriza la Jefatura o el Administrador
  SELECT p.id INTO jefe FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
  WHERE r.name IN ('Jefe de Distribución', 'Administrador') AND p.is_active ORDER BY r.name = 'Jefe de Distribución' DESC, p.id LIMIT 1;
  SELECT p.id INTO adm FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
  WHERE p.is_active AND p.id IS DISTINCT FROM jefe AND COALESCE(r.permissions, '[]'::jsonb) ?| ARRAY['apt-carga', 'apt-carga:write'] ORDER BY p.id LIMIT 1;
  IF adm IS NULL OR jefe IS NULL THEN RAISE EXCEPTION 'CAJA C248 FAIL: faltan un usuario activo con apt-carga y un Administrador o Jefe de Distribución activo'; END IF;
  PERFORM set_config('request.jwt.claim.sub', adm::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', adm, 'role', 'authenticated')::text, true);
  PERFORM set_config('inv.scope', '%C248%', true);
  UPDATE public.inv_uploads SET status = 'DESCARTADA' WHERE status = 'CARGANDO' OR (side = 'STOCK' AND status = 'APLICADA');
  -- Sin sinceramientos previos dentro de la prueba (se revierte)
  UPDATE public.inv_sinc SET estado = 'ANULADA' WHERE estado IN ('PROPUESTA', 'AUTORIZADA', 'REGULARIZADA');

  ue := (public.inv_upload_begin('E', 'C248 Entradas.xlsx')->>'upload_id')::uuid;
  PERFORM public.inv_upload_rows(ue, jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', bod, 'Numero', '948001', 'Fecha', '2001-03-01',
      'Producto', 'C248.VIGA', 'GLOSA', 'VIGA C248', 'UNIDAD', 'UND', 'Cantidad', 10, 'Lote', '99948-S001', 'PesoUnitario', 2)));
  PERFORM public.inv_upload_apply_core(ue);
  PERFORM public.inv_rebuild();
  SELECT count(*) INTO n_erp FROM public.inv_movements WHERE bodega LIKE '%C248%';
  stk := (SELECT sum(qty - consumed) FROM public.inv_layers WHERE bodega = bod AND producto = 'C248.VIGA' AND lk = '99948-S001');

  -- T1: permisos y validaciones (sin motivo, lote de otra OT, bodega fuera del APT, más que el saldo)
  IF NOT has_function_privilege('anon', 'public.inv_sinc_proponer(jsonb)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.inv_sinc_materializar(date)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.inv_sinc_decidir(jsonb)', 'EXECUTE')
     AND stk = 10
     AND NOT (public.inv_sinc_proponer(jsonb_build_object('ot', '99948', 'motivo', 'X', 'observacion', 'Verificado en almacén C248',
          'lineas', jsonb_build_array(jsonb_build_object('bodega', bod, 'producto', 'C248.VIGA', 'lote', '99948-S001', 'cantidad', 1))))->>'success')::boolean
     AND NOT (public.inv_sinc_proponer(jsonb_build_object('ot', '9994', 'motivo', 'MERMA_NO_UBICADO', 'observacion', 'Verificado en almacén C248',
          'lineas', jsonb_build_array(jsonb_build_object('bodega', bod, 'producto', 'C248.VIGA', 'lote', '99948-S001', 'cantidad', 1))))->>'success')::boolean
     AND NOT (public.inv_sinc_proponer(jsonb_build_object('ot', '99948', 'motivo', 'MERMA_NO_UBICADO', 'observacion', 'Verificado en almacén C248',
          'lineas', jsonb_build_array(jsonb_build_object('bodega', 'PRODUCCION C248', 'producto', 'C248.VIGA', 'lote', '99948-S001', 'cantidad', 1))))->>'success')::boolean
     AND NOT (public.inv_sinc_proponer(jsonb_build_object('ot', '99948', 'motivo', 'MERMA_NO_UBICADO', 'observacion', 'Verificado en almacén C248',
          'lineas', jsonb_build_array(jsonb_build_object('bodega', bod, 'producto', 'C248.VIGA', 'lote', '99948-S001', 'cantidad', 11))))->>'success')::boolean
  THEN pass := pass + 1; ELSE fails := fails || ('T1 permisos / validaciones, saldo ' || COALESCE(stk::text, 'null')); END IF;

  -- T2: propone 4 de 10; otra propuesta de 7 ya no entra (quedan 6 sin comprometer)
  r := public.inv_sinc_proponer(jsonb_build_object('ot', ' 99948 ', 'cliente', 'CLIENTE C248', 'motivo', 'DESPACHADO_SIN_GUIA',
    'observacion', 'No se encontró en el almacén C248', 'lineas', jsonb_build_array(jsonb_build_object('bodega', bod, 'producto', 'C248.VIGA',
    'glosa', 'VIGA C248', 'lote', '99948-s001', 'unidad', 'UND', 'cantidad', 4, 'peso_unit', 2))));
  id1 := (r->>'id')::bigint;
  IF (r->>'success')::boolean AND r->>'numero' LIKE 'SF-%'
     AND (SELECT estado FROM public.inv_sinc WHERE id = id1) = 'PROPUESTA'
     AND NOT (public.inv_sinc_proponer(jsonb_build_object('ot', '99948', 'motivo', 'MERMA_NO_UBICADO', 'observacion', 'Verificado en almacén C248',
          'lineas', jsonb_build_array(jsonb_build_object('bodega', bod, 'producto', 'C248.VIGA', 'lote', '99948-S001', 'cantidad', 7))))->>'success')::boolean
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(public.inv_sinc_list()->'filas') x WHERE (x->>'id')::bigint = id1 AND x->>'proponente' IS NOT NULL
                 AND (x->'lineas'->0->>'kg')::numeric = 8)
  THEN pass := pass + 1; ELSE fails := fails || ('T2 proponer ' || r::text); END IF;

  -- T3: quien propuso no autoriza; la Jefatura sí y marca el recálculo
  UPDATE public.inv_state SET dirty = false WHERE id = 1;
  r := public.inv_sinc_decidir(jsonb_build_object('id', id1, 'accion', 'autorizar'));
  PERFORM set_config('request.jwt.claim.sub', jefe::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', jefe, 'role', 'authenticated')::text, true);
  -- (cada llamada que escribe va en su propia sentencia: una consulta no ve lo que escribe una función dentro de ella)
  r2 := public.inv_sinc_decidir(jsonb_build_object('id', id1, 'accion', 'autorizar'));
  IF NOT (r->>'success')::boolean AND (r2->>'success')::boolean
     AND (SELECT estado = 'AUTORIZADA' AND autorizado_por = jefe FROM public.inv_sinc WHERE id = id1)
     AND (SELECT dirty FROM public.inv_state WHERE id = 1)
  THEN pass := pass + 1; ELSE fails := fails || ('T3 autorizar ' || r::text); END IF;

  -- T4: tras el recálculo quedan 6 en el APT y 4 en SF; los movimientos del ERP siguen intactos
  PERFORM public.inv_rebuild();
  stk := (SELECT sum(qty - consumed) FROM public.inv_layers WHERE bodega = bod AND producto = 'C248.VIGA' AND lk = '99948-S001');
  IF stk = 6
     AND (SELECT count(*) FROM public.inv_movements m JOIN public.inv_sinc s ON s.numero = m.numero WHERE s.id = id1 AND m.active) = 2
     AND (SELECT count(*) FROM public.inv_movements WHERE bodega LIKE '%C248%' AND numero NOT LIKE 'SF-%') = n_erp
     AND EXISTS (SELECT 1 FROM public.inv_movements m JOIN public.inv_sinc s ON s.numero = m.numero
                 WHERE s.id = id1 AND m.bodega = 'SF-SINCERAMIENTO' AND m.cantidad = 4 AND m.peso_kg = 8)
  THEN pass := pass + 1; ELSE fails := fails || ('T4 efecto en stock: APT ' || COALESCE(stk::text, 'null')); END IF;

  -- un nuevo recálculo no duplica el traspaso
  PERFORM public.inv_rebuild();
  IF (SELECT count(*) FROM public.inv_movements m JOIN public.inv_sinc s ON s.numero = m.numero WHERE s.id = id1) <> 2 THEN fails := fails || 'T4 traspaso duplicado'::text; END IF;

  -- T5: revertir (con motivo) devuelve el stock al APT tras el recálculo
  r := public.inv_sinc_decidir(jsonb_build_object('id', id1, 'accion', 'revertir', 'motivo', 'Se ubicó el material C248'));
  PERFORM public.inv_rebuild();
  stk := (SELECT sum(qty - consumed) FROM public.inv_layers WHERE bodega = bod AND producto = 'C248.VIGA' AND lk = '99948-S001');
  r2 := public.inv_sinc_decidir(jsonb_build_object('id', id1, 'accion', 'revertir', 'motivo', 'otra vez'));
  IF (r->>'success')::boolean AND stk = 10 AND NOT (r2->>'success')::boolean
     AND NOT EXISTS (SELECT 1 FROM public.inv_movements m JOIN public.inv_sinc s ON s.numero = m.numero WHERE s.id = id1)
  THEN pass := pass + 1; ELSE fails := fails || ('T5 revertir ' || r::text || ' APT ' || COALESCE(stk::text, 'null')); END IF;

  -- T6: rechazar exige motivo; anular solo quien propuso
  r := public.inv_sinc_proponer(jsonb_build_object('ot', '99948', 'motivo', 'ERROR_DIGITACION', 'observacion', 'Lote digitado dos veces C248',
    'lineas', jsonb_build_array(jsonb_build_object('bodega', bod, 'producto', 'C248.VIGA', 'lote', '99948-S001', 'cantidad', 2))));
  id2 := (r->>'id')::bigint;
  IF (public.inv_sinc_decidir(jsonb_build_object('id', id2, 'accion', 'rechazar'))->>'success')::boolean
     OR (public.inv_sinc_decidir(jsonb_build_object('id', id1, 'accion', 'anular'))->>'success')::boolean THEN
    fails := fails || 'T6 rechazo sin motivo o anulación ajena aceptados'::text;
  END IF;
  r2 := public.inv_sinc_decidir(jsonb_build_object('id', id2, 'accion', 'anular'));
  IF (r->>'success')::boolean AND (r2->>'success')::boolean
     AND (SELECT estado FROM public.inv_sinc WHERE id = id2) = 'ANULADA'
  THEN pass := pass + 1; ELSE fails := fails || ('T6 rechazar / anular ' || r::text); END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C248 FAIL (%/6): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C248 PASS (6/6) sinceramiento APT: tope en saldo, autoriza otro, APT → SF tras el recálculo, revertir, rechazar y anular';
END $test$;
ROLLBACK;
