-- CAJA C249 — Sinceramiento APT en bloque: varias OT con todo su stock (un acta por OT con su bloque BQ-), la Jefatura
-- transfiere directo (propone y autoriza), el Analista no; regularización con el ERP: una salida del ERP posterior que deja
-- la clave por debajo de lo real deja de restarse en SF (REGULARIZADA), y un despacho de la parte real no devuelve el
-- stock fantasma al APT; si el ERP reemplaza el ajuste, vuelve a SF. (SF se mide en los movimientos del traspaso: inv.scope deja fuera la bodega virtual.) Se revierte.
BEGIN;
SET LOCAL statement_timeout = '100s';
SET LOCAL lock_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('inv_rebuild'));
SELECT pg_advisory_xact_lock(hashtext('inv_cache'));
SET LOCAL inv.live = 'on';
DO $test$
DECLARE ana uuid; jefe uuid; ue uuid; us uuid; r jsonb; r2 jsonb; ida bigint; idb bigint; idc bigint; pass int := 0; fails text[] := '{}';
  b647 constant text := '647-04 C249 ALM PT'; b540 constant text := '540-04 C249 APT LB';
  stk numeric; sf numeric; sin_ana boolean;
BEGIN
  SELECT p.id INTO jefe FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
  WHERE r.name IN ('Jefe de Distribución', 'Administrador') AND p.is_active ORDER BY r.name = 'Jefe de Distribución' DESC, p.id LIMIT 1;
  SELECT p.id INTO ana FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
  WHERE p.is_active AND p.id IS DISTINCT FROM jefe AND r.name NOT IN ('Jefe de Distribución', 'Administrador')
    AND COALESCE(r.permissions, '[]'::jsonb) ?| ARRAY['apt-carga', 'apt-carga:write'] AND NOT COALESCE(r.permissions, '[]'::jsonb) ? 'apt-sincerar-autorizar'
  ORDER BY p.id LIMIT 1;
  IF jefe IS NULL THEN RAISE EXCEPTION 'CAJA C249 FAIL: falta un Administrador o Jefe de Distribución activo'; END IF;
  -- Sin un Analista (apt-carga, no autorizador) la Jefatura propone el bloque y T2 se omite
  sin_ana := ana IS NULL; ana := COALESCE(ana, jefe);
  PERFORM set_config('request.jwt.claim.sub', ana::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', ana, 'role', 'authenticated')::text, true);
  PERFORM set_config('inv.scope', '%C249%', true);
  UPDATE public.inv_uploads SET status = 'DESCARTADA' WHERE status = 'CARGANDO' OR (side = 'STOCK' AND status = 'APLICADA');
  UPDATE public.inv_sinc SET estado = 'ANULADA' WHERE estado IN ('PROPUESTA', 'AUTORIZADA', 'REGULARIZADA');

  -- OT 99949: lote madre (A, 10 und de 2 kg en 647) y subcontrato (B, 5 und en 540); OT 99950: C, 3 und en 647; OT 99951 sin stock
  ue := (public.inv_upload_begin('E', 'C249 Entradas.xlsx')->>'upload_id')::uuid;
  PERFORM public.inv_upload_rows(ue, jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', b647, 'Numero', '949001', 'Fecha', '2001-03-01',
      'Producto', 'C249.A', 'GLOSA', 'VIGA A C249', 'UNIDAD', 'UND', 'Cantidad', 10, 'Lote', '99949', 'PesoUnitario', 2),
    jsonb_build_object('__row', 3, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', b540, 'Numero', '949002', 'Fecha', '2001-03-01',
      'Producto', 'C249.B', 'GLOSA', 'POSTE B C249', 'UNIDAD', 'UND', 'Cantidad', 5, 'Lote', '99949-S001', 'PesoUnitario', 3),
    jsonb_build_object('__row', 4, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', b647, 'Numero', '949003', 'Fecha', '2001-03-01',
      'Producto', 'C249.C', 'GLOSA', 'TAPA C C249', 'UNIDAD', 'UND', 'Cantidad', 3, 'Lote', '99950', 'PesoUnitario', 1)));
  PERFORM public.inv_upload_apply_core(ue);
  PERFORM public.inv_rebuild();

  -- T1: el Analista propone un bloque (sin autorizar): un acta por OT con todo su stock, mismo bloque; 99951 sin stock
  r := public.inv_sinc_transferir(jsonb_build_object('motivo', 'SALDO_INICIAL_INFERIDO', 'observacion', 'Bloque verificado en almacén C249',
    'ots', jsonb_build_array(jsonb_build_object('ot', '99949', 'cliente', 'CLIENTE C249'), jsonb_build_object('ot', '99950'), jsonb_build_object('ot', '99951'))));
  IF (r->>'success')::boolean AND r->>'bloque' LIKE 'BQ-%' AND jsonb_array_length(r->'actas') = 2 AND r->'sin_stock' = '["99951"]'::jsonb
     AND (SELECT count(*) FROM public.inv_sinc WHERE bloque = r->>'bloque' AND estado = 'PROPUESTA' AND NOT directo) = 2
     AND (SELECT count(*) FROM public.inv_sinc_lineas l JOIN public.inv_sinc s ON s.id = l.sinc_id WHERE s.bloque = r->>'bloque' AND s.ot = '99949') = 2
     AND (SELECT sum(l.cantidad * l.peso_unit) FROM public.inv_sinc_lineas l JOIN public.inv_sinc s ON s.id = l.sinc_id WHERE s.bloque = r->>'bloque') = 38
  THEN pass := pass + 1; ELSE fails := fails || ('T1 bloque propuesto ' || r::text); END IF;
  -- deja libre el stock para lo que sigue
  UPDATE public.inv_sinc SET estado = 'ANULADA' WHERE bloque = r->>'bloque';

  -- T2: el Analista no transfiere directo (no queda nada registrado)
  IF sin_ana THEN pass := pass + 1; ELSE
  r := public.inv_sinc_transferir(jsonb_build_object('motivo', 'MERMA_NO_UBICADO', 'observacion', 'Intento directo C249', 'directo', true,
    'ots', jsonb_build_array(jsonb_build_object('ot', '99949'))));
  IF NOT (r->>'success')::boolean AND NOT EXISTS (SELECT 1 FROM public.inv_sinc WHERE ot = '99949' AND estado IN ('PROPUESTA', 'AUTORIZADA'))
  THEN pass := pass + 1; ELSE fails := fails || ('T2 directo del Analista ' || r::text); END IF;
  END IF;

  -- T3: la Jefatura transfiere directo el bloque 99949: autorizada por quien propuso, saldo_previo guardado; tras el
  -- recálculo el APT queda en 0 y SF con 10 + 5
  PERFORM set_config('request.jwt.claim.sub', jefe::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', jefe, 'role', 'authenticated')::text, true);
  r := public.inv_sinc_transferir(jsonb_build_object('motivo', 'DESPACHADO_SIN_GUIA', 'observacion', 'No existe en almacén C249',
    'directo', true, 'ots', jsonb_build_array(jsonb_build_object('ot', '99949'))));
  ida := (r->'actas'->0->>'id')::bigint;
  PERFORM public.inv_rebuild();
  stk := (SELECT COALESCE(sum(qty - consumed), 0) FROM public.inv_layers WHERE bodega IN (b647, b540) AND producto IN ('C249.A', 'C249.B'));
  sf := (SELECT COALESCE(sum(cantidad), 0) FROM public.inv_movements WHERE active AND bodega = 'SF-SINCERAMIENTO' AND producto IN ('C249.A', 'C249.B'));
  IF (r->>'success')::boolean AND (r->>'directo')::boolean
     AND (SELECT estado = 'AUTORIZADA' AND directo AND autorizado_por = jefe AND propuesto_por = jefe FROM public.inv_sinc WHERE id = ida)
     AND (SELECT array_agg(saldo_previo ORDER BY producto) FROM public.inv_sinc_lineas WHERE sinc_id = ida) = ARRAY[10, 5]::numeric[]
     AND stk = 0 AND sf = 15
  THEN pass := pass + 1; ELSE fails := fails || ('T3 directo Jefatura ' || r::text || ' APT ' || stk || ' SF ' || sf); END IF;

  -- T4: la Jefatura no autoriza en la bandeja lo que propuso sin «directo» (regla de siempre)
  r := public.inv_sinc_transferir(jsonb_build_object('motivo', 'ERROR_DIGITACION', 'observacion', 'Propuesta normal C249',
    'ot', '99950', 'lineas', jsonb_build_array(jsonb_build_object('bodega', b647, 'producto', 'C249.C', 'lote', '99950', 'cantidad', 1, 'peso_unit', 1))));
  idc := (r->>'id')::bigint;
  idc := COALESCE(idc, (r->'actas'->0->>'id')::bigint);
  r2 := public.inv_sinc_decidir(jsonb_build_object('id', idc, 'accion', 'autorizar'));
  IF (r->>'success')::boolean AND NOT (r2->>'success')::boolean AND (SELECT estado FROM public.inv_sinc WHERE id = idc) = 'PROPUESTA'
  THEN pass := pass + 1; ELSE fails := fails || ('T4 autorizar lo propio ' || r::text || ' ' || r2::text); END IF;
  UPDATE public.inv_sinc SET estado = 'ANULADA' WHERE id = idc;

  -- T5: OT 99950: la Jefatura transfiere directo 1 de 3 (2 sí existen). Despachar en el ERP los 2 reales no regulariza
  -- (el APT queda en 0, no reaparece el fantasma); un ajuste posterior de 1 sí: REGULARIZADA y SF vuelve a 0
  r := public.inv_sinc_transferir(jsonb_build_object('motivo', 'MERMA_NO_UBICADO', 'observacion', 'Falta una tapa C249', 'directo', true,
    'ot', '99950', 'lineas', jsonb_build_array(jsonb_build_object('bodega', b647, 'producto', 'C249.C', 'lote', '99950', 'cantidad', 1, 'peso_unit', 1))));
  idb := (r->'actas'->0->>'id')::bigint;
  -- autorizaciones «antiguas» para fechar movimientos del ERP posteriores sin depender del día de hoy
  UPDATE public.inv_sinc SET autorizado_at = '2001-06-01 12:00-05' WHERE id IN (ida, idb);
  us := (public.inv_upload_begin('S', 'C249 Salidas.xlsx')->>'upload_id')::uuid;
  PERFORM public.inv_upload_rows(us, jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'DESPACHO VENTAS', 'BODEGA', b647, 'Numero', 'T001-9490001', 'Fecha', '2001-07-01',
      'Producto', 'C249.C', 'Cantidad', -2, 'UNIDAD', 'UND', 'Lote', '99950', 'PesoUnitario', 1),
    jsonb_build_object('__row', 3, 'TIPODOCTO', 'AJUSTE DE INVENTARIO', 'BODEGA', b647, 'Numero', '949101', 'Fecha', '2001-07-02',
      'Producto', 'C249.A', 'Cantidad', -10, 'UNIDAD', 'UND', 'Lote', '99949', 'PesoUnitario', 2)));
  PERFORM public.inv_upload_apply_core(us);
  PERFORM public.inv_rebuild();
  stk := (SELECT COALESCE(sum(qty - consumed), 0) FROM public.inv_layers WHERE bodega = b647 AND producto = 'C249.C');
  sf := (SELECT COALESCE(sum(cantidad), 0) FROM public.inv_movements WHERE active AND bodega = 'SF-SINCERAMIENTO' AND producto IN ('C249.A', 'C249.C'));
  -- A (10 fantasma) lo ajustó el ERP: deja de restar; B sigue en SF → el acta queda AUTORIZADA (parcial); C sigue en SF
  IF stk = 0 AND sf = 1 AND (SELECT estado FROM public.inv_sinc WHERE id = ida) = 'AUTORIZADA'
     AND (SELECT estado FROM public.inv_sinc WHERE id = idb) = 'AUTORIZADA'
     AND (SELECT COALESCE(sum(qty - consumed), 0) FROM public.inv_layers WHERE bodega = b647 AND producto = 'C249.A') = 0
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(public.inv_sinc_list()->'filas') x, jsonb_array_elements(x->'lineas') l
                 WHERE (x->>'id')::bigint = ida AND l->>'producto' = 'C249.A' AND (l->>'en_sf')::numeric = 0)
  THEN pass := pass + 1; ELSE fails := fails || ('T5 despacho real / ajuste parcial: APT C ' || stk || ' SF ' || sf); END IF;

  -- T6: el ERP ajusta lo que faltaba (B en 540 y la tapa C): ambas actas quedan REGULARIZADA y SF sin stock
  us := (public.inv_upload_begin('S', 'C249 Ajustes.xlsx')->>'upload_id')::uuid;
  PERFORM public.inv_upload_rows(us, jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'AJUSTE DE INVENTARIO', 'BODEGA', b540, 'Numero', '949102', 'Fecha', '2001-07-03',
      'Producto', 'C249.B', 'Cantidad', -5, 'UNIDAD', 'UND', 'Lote', '99949-S001', 'PesoUnitario', 3),
    jsonb_build_object('__row', 3, 'TIPODOCTO', 'AJUSTE DE INVENTARIO', 'BODEGA', b647, 'Numero', '949103', 'Fecha', '2001-07-03',
      'Producto', 'C249.C', 'Cantidad', -1, 'UNIDAD', 'UND', 'Lote', '99950', 'PesoUnitario', 1)));
  PERFORM public.inv_upload_apply_core(us);
  PERFORM public.inv_rebuild();
  sf := (SELECT COALESCE(sum(cantidad), 0) FROM public.inv_movements WHERE active AND bodega = 'SF-SINCERAMIENTO' AND producto LIKE 'C249.%');
  IF sf = 0 AND (SELECT bool_and(estado = 'REGULARIZADA' AND regularizado_at IS NOT NULL) FROM public.inv_sinc WHERE id IN (ida, idb))
     AND (SELECT COALESCE(sum(qty - consumed), 0) FROM public.inv_layers WHERE bodega IN (b647, b540) AND producto LIKE 'C249.%') = 0
  THEN pass := pass + 1; ELSE fails := fails || ('T6 regularizada: SF ' || sf); END IF;

  -- T7: una carga de reemplazo del ERP quita esos ajustes → las actas vuelven a AUTORIZADA y el stock a SF (B 5 + C 1)
  UPDATE public.inv_movements SET active = false WHERE upload_id = us;
  PERFORM public.inv_rebuild();
  sf := (SELECT COALESCE(sum(cantidad), 0) FROM public.inv_movements WHERE active AND bodega = 'SF-SINCERAMIENTO' AND producto LIKE 'C249.%');
  IF sf = 6 AND (SELECT bool_and(estado = 'AUTORIZADA' AND regularizado_at IS NULL) FROM public.inv_sinc WHERE id IN (ida, idb))
  THEN pass := pass + 1; ELSE fails := fails || ('T7 reevaluar regularizadas: SF ' || sf); END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C249 FAIL (%/7): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C249 PASS (7/7) sinceramiento en bloque: un acta por OT, directo de la Jefatura y regularización con el ERP (reevaluada) sin devolver el fantasma%', CASE WHEN sin_ana THEN ' (T2 omitida: sin Analista no autorizador)' ELSE '' END;
END $test$;
ROLLBACK;
