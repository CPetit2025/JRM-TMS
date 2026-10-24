-- CAJA C143 — ERP análisis: cruce exacto documento + producto + unidad (espacios y mayúsculas, sin quitar ceros), stock
-- no coincidente (NULL) distinto de stock cero, sin multiplicar cantidades por lotes ni bodegas, vista por OT sin sumar
-- tipos, versión de reglas en cada procesamiento, registro de cargas y controles de calidad. Siempre se revierte.
BEGIN;
DO $test$
DECLARE admin_id uuid; up uuid; res jsonb; r jsonb; lg jsonb; pass int := 0; fails text[] := '{}';
  tag text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)); ot text := (70000 + floor(random() * 9999))::int::text;
  pa text; pb text; pc text; pd text; pe text;
  rows jsonb := '[]'::jsonb;
BEGIN
  FOR admin_id IN SELECT id FROM public.profiles WHERE is_active AND id IN (SELECT id FROM auth.users) LOOP
    PERFORM set_config('request.jwt.claim.sub', admin_id::text, true); EXIT WHEN public.apt_can_load(); admin_id := NULL;
  END LOOP;
  IF admin_id IS NULL THEN RAISE EXCEPTION 'CAJA C143 FAIL: falta un usuario con carga APT'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  pa := 'ZA' || tag; pb := 'ZB' || tag; pc := 'ZC' || tag; pd := 'ZD' || tag; pe := 'ZE' || tag;

  -- Actualizable: A con dos secuencias (5 + 5 pendientes, unidad «und » del ERP); B con stock 0; C sin stock; D con lote con ceros;
  -- E en UND con stock en CIEN; subcontrato de A en la misma OT (no se suma con el contrato); una línea en UNID con cantidades ausentes
  rows := jsonb_build_array(
    jsonb_build_object('linea', 2, 'nro_contrato', ot, 'nro_documento', ' ' || ot || ' ', 'secuencia', 1, 'tipo_documento', 'CONTRATO DE VENTAS', 'correlativo', ot, 'cliente', 'CLIENTE C143',
      'cod_producto', pa, 'producto', 'PRODUCTO A', 'unidad', 'und ', 'cant_contrato', 10, 'cant_despachada', 5, 'cant_pendiente', 5, 'fecha_contrato', '2026-01-01', 'fecha_vcto', '2026-02-01', 'vigencia', 'S'),
    jsonb_build_object('linea', 3, 'nro_contrato', ot, 'nro_documento', ot, 'secuencia', 2, 'tipo_documento', 'CONTRATO DE VENTAS', 'correlativo', ot, 'cliente', 'CLIENTE C143',
      'cod_producto', pa, 'producto', 'PRODUCTO A', 'unidad', 'UND', 'cant_contrato', 5, 'cant_despachada', 0, 'cant_pendiente', 5, 'fecha_contrato', '2026-01-01', 'fecha_vcto', '2099-01-01', 'vigencia', 'S'),
    jsonb_build_object('linea', 4, 'nro_contrato', ot, 'nro_documento', ot, 'secuencia', 3, 'tipo_documento', 'CONTRATO DE VENTAS', 'correlativo', ot, 'cliente', 'CLIENTE C143',
      'cod_producto', pb, 'producto', 'PRODUCTO B', 'unidad', 'UND', 'cant_contrato', 4, 'cant_despachada', 0, 'cant_pendiente', 4, 'fecha_contrato', '2026-01-01', 'fecha_vcto', '2099-01-01'),
    jsonb_build_object('linea', 5, 'nro_contrato', ot, 'nro_documento', ot, 'secuencia', 4, 'tipo_documento', 'CONTRATO DE VENTAS', 'correlativo', ot, 'cliente', 'CLIENTE C143',
      'cod_producto', pc, 'producto', 'PRODUCTO C', 'unidad', 'UND', 'cant_contrato', 6, 'cant_despachada', 0, 'cant_pendiente', 6, 'fecha_contrato', '2026-01-01', 'fecha_vcto', '2099-01-01'),
    jsonb_build_object('linea', 6, 'nro_contrato', ot, 'nro_documento', ot, 'secuencia', 5, 'tipo_documento', 'CONTRATO DE VENTAS', 'correlativo', ot, 'cliente', 'CLIENTE C143',
      'cod_producto', pd, 'producto', 'PRODUCTO D', 'unidad', 'UND', 'cant_contrato', 3, 'cant_despachada', 0, 'cant_pendiente', 3, 'fecha_contrato', '2026-01-01', 'fecha_vcto', '2099-01-01'),
    jsonb_build_object('linea', 7, 'nro_contrato', ot, 'nro_documento', ot, 'secuencia', 6, 'tipo_documento', 'CONTRATO DE VENTAS', 'correlativo', ot, 'cliente', 'CLIENTE C143',
      'cod_producto', pe, 'producto', 'PRODUCTO E', 'unidad', 'UND', 'cant_contrato', 200, 'cant_despachada', 0, 'cant_pendiente', 200, 'fecha_contrato', '2026-01-01', 'fecha_vcto', '2099-01-01'),
    jsonb_build_object('linea', 8, 'nro_contrato', ot, 'nro_documento', ot || '-1', 'secuencia', 1, 'tipo_documento', 'SUBCONTRATO DE VENTAS', 'correlativo', ot || '1', 'cliente', 'CLIENTE C143',
      'cod_producto', pa, 'producto', 'PRODUCTO A', 'unidad', 'UND', 'cant_contrato', 7, 'cant_despachada', 0, 'cant_pendiente', 7, 'fecha_contrato', '2026-01-01', 'fecha_vcto', '2099-01-01'),
    jsonb_build_object('linea', 9, 'nro_contrato', ot, 'nro_documento', ot || '-1', 'secuencia', 2, 'tipo_documento', 'SUBCONTRATO DE VENTAS', 'correlativo', ot || '1', 'cliente', 'CLIENTE C143',
      'cod_producto', pc, 'producto', 'PRODUCTO C', 'unidad', 'UNID', 'cantidades_ausentes', 1, 'fecha_contrato', '2026-01-01', 'fecha_vcto', '2099-01-01'));
  lg := public.erp_log_start(jsonb_build_object('kind', 'CONTRATOS', 'file_name', 'C143.xlsx', 'rows_expected', 8));
  up := (public.erp_upload_begin('CONTRATOS', 'C143.xlsx', '2099-03-01 18:00-05', 8)->>'upload_id')::uuid;
  PERFORM public.erp_upload_rows(up, rows);
  PERFORM public.erp_upload_apply(up);
  PERFORM public.erp_log_finish(jsonb_build_object('id', lg->>'id', 'status', 'OK', 'rows_loaded', 8, 'import_id', up));
  -- Stock: A en dos bodegas (3 + 4), B en 0, D con lote 000<doc>, E en CIEN
  up := (public.erp_upload_begin('STOCK', 'C143 stock.xlsx', '2099-03-01 20:00-05', 5)->>'upload_id')::uuid;
  PERFORM public.erp_upload_rows(up, jsonb_build_array(
    jsonb_build_object('linea', 2, 'bodega', '647-04  ALM PT', 'cod_producto', pa, 'unidad', 'UND', 'lote', ot, 'stock', 3, 'peso_unitario', 1),
    jsonb_build_object('linea', 3, 'bodega', 'ST-VENTAS-IMD', 'cod_producto', pa, 'unidad', 'UND', 'lote', ' ' || ot, 'stock', 4, 'peso_unitario', 1),
    jsonb_build_object('linea', 4, 'bodega', '647-04 ALM PT', 'cod_producto', pb, 'unidad', 'UND', 'lote', ot, 'stock', 0, 'peso_unitario', 1),
    jsonb_build_object('linea', 5, 'bodega', '647-04 ALM PT', 'cod_producto', pd, 'unidad', 'UND', 'lote', '000' || ot, 'stock', 2, 'peso_unitario', 1),
    jsonb_build_object('linea', 6, 'bodega', 'ST-VENTAS-IMD', 'cod_producto', pe, 'unidad', 'CIEN', 'lote', ot, 'stock', 1.5, 'peso_unitario', 0.02, 'peso_total', 0.03)));
  PERFORM public.erp_upload_apply(up);

  -- T1 unidad original y fila de origen guardadas; la regla heredada UNID → UND sigue igual
  IF (SELECT unidad_erp = 'und ' AND unidad = 'UND' AND linea = 2 FROM public.erp_contract_lines WHERE import_id = public.erp_active_import('CONTRATOS') AND cod_producto = pa AND secuencia = 1 AND tipo_documento = 'CONTRATO DE VENTAS')
     AND (SELECT unidad_erp = 'UNID' AND unidad = 'UND' AND cantidades_ausentes FROM public.erp_contract_lines WHERE import_id = public.erp_active_import('CONTRATOS') AND cod_producto = pc AND tipo_documento = 'SUBCONTRATO DE VENTAS')
  THEN pass := pass + 1; ELSE fails := fails || 'T1 datos originales'::text; END IF;

  -- T2 cruce exacto por documento: A suma sus dos secuencias (10) y su stock de dos bodegas (7) sin multiplicar; B coincide con stock 0;
  -- C sin coincidencia (stock NULL); D por ceros y E por unidad quedan sin stock asignado
  res := public.erp_analisis(jsonb_build_object('ot', ot, 'limit', 50));
  SELECT jsonb_object_agg(x->>'cod_producto' || '|' || (x->>'documento'), jsonb_build_object('pend', (x->>'pendiente')::numeric, 'stock', x->'stock', 'cruce', x->>'cruce',
    'falt', x->'faltante', 'cob', x->'cobertura', 'lineas', (x->>'lineas')::int, 'u', x->>'unidad'))
  INTO r FROM jsonb_array_elements(res->'filas') x;
  IF res->>'success' = 'true' AND (res->>'total')::int = 7
     AND r->(pa || '|' || ot) = jsonb_build_object('pend', 10, 'stock', 7, 'cruce', 'COINCIDE', 'falt', 3, 'cob', 0.7, 'lineas', 2, 'u', 'UND')
     AND r->(pb || '|' || ot)->>'cruce' = 'COINCIDE' AND (r->(pb || '|' || ot)->>'stock')::numeric = 0 AND (r->(pb || '|' || ot)->>'falt')::numeric = 4
     AND (r->(pb || '|' || ot)->>'cob')::numeric = 0
     AND r->(pc || '|' || ot)->>'cruce' = 'SIN_COINCIDENCIA' AND jsonb_typeof(r->(pc || '|' || ot)->'stock') = 'null' AND jsonb_typeof(r->(pc || '|' || ot)->'cob') = 'null'
     AND (r->(pc || '|' || ot)->>'falt')::numeric = 6
     AND r->(pd || '|' || ot)->>'cruce' = 'LOTE_CON_CEROS' AND jsonb_typeof(r->(pd || '|' || ot)->'stock') = 'null'
     AND r->(pe || '|' || ot)->>'cruce' = 'UNIDAD_DISTINTA' AND jsonb_typeof(r->(pe || '|' || ot)->'stock') = 'null'
     AND jsonb_typeof(r->(pc || '|' || ot || '-1')->'falt') = 'null'
  THEN pass := pass + 1; ELSE fails := fails || ('T2 cruce: ' || COALESCE(r::text, res::text)); END IF;

  -- T3 vista por OT: contrato y subcontrato en renglones separados (no se suman), también por unidad
  res := public.erp_analisis(jsonb_build_object('ot', ot, 'vista', 'OT'));
  IF (SELECT count(*) FROM jsonb_array_elements(res->'filas') x WHERE x->>'ot' = ot) = 3
     AND (SELECT (x->>'pendiente')::numeric FROM jsonb_array_elements(res->'filas') x WHERE x->>'tipo_documento' = 'SUBCONTRATO DE VENTAS' AND x->>'unidad' = 'UND') = 7
     AND (SELECT (x->>'pendiente')::numeric FROM jsonb_array_elements(res->'filas') x WHERE x->>'tipo_documento' = 'CONTRATO DE VENTAS' AND x->>'unidad' = 'UND') = 223
  THEN pass := pass + 1; ELSE fails := fails || ('T3 vista OT: ' || res::text); END IF;

  -- T4 versión de reglas: cada carga activa y cada día derivado registran la versión vigente
  INSERT INTO public.erp_derive_days (fecha, base_fecha, base_fuente, bodegas) VALUES (DATE '2099-03-01', DATE '2099-02-28', 'ERP', ARRAY['647-04 ALM PT']);
  IF (SELECT bool_and(rule_version = public.erp_rule_version()) FROM public.erp_imports WHERE status = 'ACTIVA')
     AND (SELECT rule_version FROM public.erp_derive_days WHERE fecha = DATE '2099-03-01') = public.erp_rule_version()
     AND (SELECT origen FROM public.erp_rule_versions WHERE estado = 'VIGENTE') IS NOT NULL
  THEN pass := pass + 1; ELSE fails := fails || 'T4 versión de reglas'::text; END IF;

  -- T5 registro: la carga terminada queda OK; otra en curso de otro usuario bloquea; una fallida queda con su error
  INSERT INTO public.erp_load_log (kind, file_name, created_by) VALUES ('STOCK', 'otro.xlsx', gen_random_uuid());
  res := public.erp_log_start(jsonb_build_object('kind', 'STOCK', 'file_name', 'C143 stock.xlsx'));
  lg := public.erp_log_start(jsonb_build_object('kind', 'LECTURA', 'file_name', 'roto.xlsx'));
  PERFORM public.erp_log_finish(jsonb_build_object('id', lg->>'id', 'status', 'ERROR', 'error', 'No se reconoce el archivo'));
  r := public.erp_cargas_log(20);
  IF res->>'success' = 'false' AND res->>'error' LIKE 'Hay otra carga%'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(r->'registro') x WHERE x->>'archivo' = 'C143.xlsx' AND x->>'estado' = 'OK' AND (x->>'filas_cargadas')::int = 8)
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(r->'registro') x WHERE x->>'archivo' = 'roto.xlsx' AND x->>'estado' = 'ERROR' AND x->>'error' = 'No se reconoce el archivo')
     AND (r->'activas'->'CONTRATOS'->>'version_reglas')::int = public.erp_rule_version()
  THEN pass := pass + 1; ELSE fails := fails || ('T5 registro: ' || res::text); END IF;

  -- T6 calidad y comparación de reglas sobre los mismos cortes
  r := public.erp_calidad();
  res := public.erp_reglas_comparacion();
  IF (SELECT (c->>'cantidad')::int FROM jsonb_array_elements(r->'controles') c WHERE c->>'codigo' = 'A06') = 1
     AND (SELECT (c->>'cantidad')::int FROM jsonb_array_elements(r->'controles') c WHERE c->>'codigo' = 'S03') = 1
     AND (SELECT (c->>'cantidad')::int FROM jsonb_array_elements(r->'controles') c WHERE c->>'codigo' = 'X01') = 1
     AND (SELECT (c->>'cantidad')::int FROM jsonb_array_elements(r->'controles') c WHERE c->>'codigo' = 'A09') = 1
     AND (res->'CIEN_A_UND'->>'lotes_afectados')::int = 1 AND (res->'CIEN_A_UND'->>'stock_convertido_und')::numeric = 150
     AND (res->'CIEN_A_UND'->>'pendiente_que_cruza_solo_con_regla')::numeric = 200
     AND (res->'LOTE_SIN_CEROS'->>'coinciden_con_clave_auxiliar')::int = 1 AND (res->'LOTE_SIN_CEROS'->>'colisiones_misma_bodega')::int = 0
     AND (res->'PESO_POR_UNIDAD'->>'kg_erp')::numeric = 0.0 AND (res->'PESO_POR_UNIDAD'->>'kg_con_regla')::numeric = 3.0
     AND (res->'OT_SUMA_TIPOS'->>'ot_con_varios_tipos')::int = 1 AND (res->'UNID_A_UND'->>'lineas')::int = 1
  THEN pass := pass + 1; ELSE fails := fails || ('T6 calidad: ' || (res - 'regla_vigente')::text); END IF;

  -- T7 sin permiso no se ve ni se registra
  PERFORM set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  IF (public.erp_analisis('{}')->>'success') = 'true' OR (public.erp_log_start('{"kind":"STOCK"}')->>'success') = 'true'
     OR has_function_privilege('anon', 'public.erp_analisis(jsonb)', 'EXECUTE')
  THEN fails := fails || 'T7 permisos'::text; ELSE pass := pass + 1; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C143 FAIL (%/7): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C143 PASS (7/7) ERP análisis: cruce exacto sin multiplicar, stock cero distinto de sin coincidencia, tipos separados, versión de reglas, registro de cargas y calidad';
END $test$;
ROLLBACK;
