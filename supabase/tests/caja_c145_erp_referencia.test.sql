-- CAJA C145 — ERP como referencia de solo lectura en Operaciones: OT por tipo y unidad con las reglas del análisis exacto
-- (sin conversiones, filas incompletas fuera de las sumas), subcontrato, guías del ERP, validación de guías escritas en el
-- TMS, resumen de Torre de Control y permisos (ven APT u Operaciones; nadie más). Siempre se revierte.
BEGIN;
DO $test$
DECLARE admin_id uuid; other_id uuid; v_role uuid; up uuid; res jsonb; r jsonb; pass int := 0; fails text[] := '{}';
  tag text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)); ot text := (60000 + floor(random() * 9999))::int::text;
  pa text; pb text; pc text; g1 text; g2 text;
BEGIN
  FOR admin_id IN SELECT id FROM public.profiles WHERE is_active AND id IN (SELECT id FROM auth.users) LOOP
    PERFORM set_config('request.jwt.claim.sub', admin_id::text, true); EXIT WHEN public.apt_can_load(); admin_id := NULL;
  END LOOP;
  IF admin_id IS NULL THEN RAISE EXCEPTION 'CAJA C145 FAIL: falta un usuario con carga APT'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  pa := 'RA' || tag; pb := 'RB' || tag; pc := 'RC' || tag; g1 := 'T145-' || (100000 + floor(random() * 99999))::int; g2 := 'T145-' || (200000 + floor(random() * 99999))::int;

  -- Actualizable: A (2 secuencias, guía g1), B en KG (no se suma con UND), C con pendiente vacío (incompleta), subcontrato con guía g2
  up := (public.erp_upload_begin('CONTRATOS', 'C145.xlsx', '2099-05-01 18:00-05', 5)->>'upload_id')::uuid;
  PERFORM public.erp_upload_rows(up, jsonb_build_array(
    jsonb_build_object('linea', 2, 'nro_contrato', ot, 'nro_documento', ot, 'secuencia', 1, 'tipo_documento', 'CONTRATO DE VENTAS', 'correlativo', ot, 'cliente', 'CLIENTE C145', 'ruc', '20999999145',
      'cod_producto', pa, 'producto', 'PRODUCTO A', 'unidad', 'UND', 'cant_contrato', 10, 'cant_despachada', 4, 'cant_reemplazada', 0, 'cant_pendiente', 6,
      'fecha_ult_despacho', '2099-04-20', 'guias', jsonb_build_array(jsonb_build_object('g', g1, 'c', 4, 'p', 1))),
    jsonb_build_object('linea', 3, 'nro_contrato', ot, 'nro_documento', ot, 'secuencia', 2, 'tipo_documento', 'CONTRATO DE VENTAS', 'correlativo', ot, 'cliente', 'CLIENTE C145',
      'cod_producto', pa, 'producto', 'PRODUCTO A', 'unidad', 'UND', 'cant_contrato', 6, 'cant_despachada', 0, 'cant_reemplazada', 0, 'cant_pendiente', 6),
    jsonb_build_object('linea', 4, 'nro_contrato', ot, 'nro_documento', ot, 'secuencia', 3, 'tipo_documento', 'CONTRATO DE VENTAS', 'correlativo', ot, 'cliente', 'CLIENTE C145',
      'cod_producto', pb, 'producto', 'PRODUCTO B', 'unidad', 'KG', 'cant_contrato', 50, 'cant_despachada', 0, 'cant_reemplazada', 0, 'cant_pendiente', 50),
    jsonb_build_object('linea', 5, 'nro_contrato', ot, 'nro_documento', ot, 'secuencia', 4, 'tipo_documento', 'CONTRATO DE VENTAS', 'correlativo', ot, 'cliente', 'CLIENTE C145',
      'cod_producto', pc, 'producto', 'PRODUCTO C', 'unidad', 'UND', 'cant_contrato', 100, 'cant_despachada', 0, 'cant_reemplazada', 0, 'cant_pendiente', ''),
    jsonb_build_object('linea', 6, 'nro_contrato', ot, 'nro_documento', ot || '-S001', 'secuencia', 1, 'tipo_documento', 'SUBCONTRATO DE VENTAS', 'correlativo', ot || '1', 'cliente', 'CLIENTE C145',
      'cod_producto', pa, 'producto', 'PRODUCTO A', 'unidad', 'UND', 'cant_contrato', 8, 'cant_despachada', 3, 'cant_reemplazada', 0, 'cant_pendiente', 5,
      'fecha_ult_despacho', '2099-04-25', 'guias', jsonb_build_array(jsonb_build_object('g', g2, 'c', 3, 'p', 1)))));
  PERFORM public.erp_upload_apply(up);
  -- Stock: A en dos bodegas (3 + 2), A en CIEN (no coincide), C (incompleta) con stock 7
  up := (public.erp_upload_begin('STOCK', 'C145 stock.xlsx', '2099-05-01 20:00-05', 4)->>'upload_id')::uuid;
  PERFORM public.erp_upload_rows(up, jsonb_build_array(
    jsonb_build_object('linea', 2, 'bodega', '647-04 ALM PT', 'cod_producto', pa, 'unidad', 'UND', 'lote', ot, 'stock', 3),
    jsonb_build_object('linea', 3, 'bodega', 'ST-VENTAS-IMD', 'cod_producto', pa, 'unidad', 'UND', 'lote', ot, 'stock', 2),
    jsonb_build_object('linea', 4, 'bodega', 'ST-VENTAS-IMD', 'cod_producto', pa, 'unidad', 'CIEN', 'lote', ot, 'stock', 9),
    jsonb_build_object('linea', 5, 'bodega', '647-04 ALM PT', 'cod_producto', pc, 'unidad', 'UND', 'lote', ot, 'stock', 7)));
  PERFORM public.erp_upload_apply(up);

  -- T1 OT: contrato UND solo con filas válidas (A); KG aparte; incompleta informada; stock exacto sin CIEN
  res := public.erp_ref_ot(ot);
  SELECT x INTO r FROM jsonb_array_elements(res->'grupos') x WHERE x->>'tipo_documento' = 'CONTRATO DE VENTAS' AND x->>'unidad' = 'UND';
  IF res->>'success' = 'true' AND (res->>'en_erp')::boolean AND res->>'cliente' = 'CLIENTE C145'
     AND (r->>'contratado')::numeric = 16 AND (r->>'despachado')::numeric = 4 AND (r->>'pendiente')::numeric = 12 AND (r->>'avance')::numeric = 0.25
     AND (r->>'stock_coincidente')::numeric = 5 AND (r->>'cobertura')::numeric = 0.4167 AND (r->>'incompletas')::int = 1 AND (r->>'validas')::int = 1
     AND (SELECT (x->>'pendiente')::numeric FROM jsonb_array_elements(res->'grupos') x WHERE x->>'unidad' = 'KG') = 50
     AND (SELECT (x->>'pendiente')::numeric FROM jsonb_array_elements(res->'grupos') x WHERE x->>'tipo_documento' = 'SUBCONTRATO DE VENTAS') = 5
  THEN pass := pass + 1; ELSE fails := fails || ('T1 OT: ' || res::text); END IF;

  -- T2 subcontrato: misma OT madre, el documento consultado va primero; guías de la OT con su fecha ERP y sin ruta en el TMS
  res := public.erp_ref_ot(lower(ot) || '-s001');
  IF res->>'ot' = ot AND res->>'documento' = ot || '-S001' AND res->'documentos'->0->>'documento' = ot || '-S001'
     AND (res->>'guias_total')::int = 2 AND (res->>'guias_con_ruta')::int = 0
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(res->'guias') x WHERE x->>'guia' = g2 AND x->>'fecha_erp' = '2099-04-25' AND jsonb_typeof(x->'rutas') = 'null')
  THEN pass := pass + 1; ELSE fails := fails || ('T2 subcontrato: ' || res::text); END IF;

  -- T3 validar guías escritas: existe (con otra escritura), no existe, OT distinta
  res := public.erp_ref_guias(ARRAY[lower(g1), 'ZZ9-1', ' ' || g2 || ' '], ot);
  IF (SELECT (x->>'en_erp')::boolean AND x->>'guia' = g1 AND NOT (x->>'ot_distinta')::boolean AND (x->>'cantidad')::numeric = 4 FROM jsonb_array_elements(res->'guias') x WHERE x->>'entrada' = lower(g1))
     AND (SELECT NOT (x->>'en_erp')::boolean FROM jsonb_array_elements(res->'guias') x WHERE x->>'entrada' = 'ZZ9-1')
     AND (SELECT (x->>'ot_distinta')::boolean FROM jsonb_array_elements(public.erp_ref_guias(ARRAY[g1], '12345')->'guias') x)
     AND jsonb_array_length(res->'guias') = 3
  THEN pass := pass + 1; ELSE fails := fails || ('T3 guías: ' || res::text); END IF;

  -- T4 resumen de Torre de Control: las dos guías del ERP sin ruta en el rango
  res := public.erp_ref_guias_resumen(jsonb_build_object('desde', '2099-04-01', 'hasta', '2099-04-30'));
  IF (res->'resumen'->>'solo_erp')::int >= 2 AND EXISTS (SELECT 1 FROM jsonb_array_elements(res->'solo_erp') x WHERE x->>'guia' = g1)
  THEN pass := pass + 1; ELSE fails := fails || ('T4 resumen: ' || res::text); END IF;

  -- T5 permisos: un rol solo con Programación y Ruteo ve la referencia; sin permisos no; anon no puede ejecutar
  INSERT INTO public.roles (name, permissions) VALUES ('C145 Ruteo ' || tag, '["despacho:read"]'::jsonb) RETURNING id INTO v_role;
  SELECT id INTO other_id FROM public.profiles WHERE is_active AND id <> admin_id ORDER BY created_at LIMIT 1;
  IF other_id IS NULL THEN other_id := admin_id; END IF;
  UPDATE public.profiles SET role_id = v_role WHERE id = other_id;
  PERFORM set_config('request.jwt.claim.sub', other_id::text, true);
  IF NOT public.erp_ref_can_view() OR (public.erp_ref_ot(ot)->>'success') <> 'true' THEN fails := fails || 'T5 rol despacho'::text; END IF;
  UPDATE public.roles SET permissions = '["caja:read"]'::jsonb WHERE id = v_role;
  IF public.erp_ref_can_view() OR (public.erp_ref_ot(ot)->>'success') = 'true' OR (public.erp_ref_guias(ARRAY[g1])->>'success') = 'true'
     OR has_function_privilege('anon', 'public.erp_ref_ot(text)', 'EXECUTE')
  THEN fails := fails || 'T5 sin permiso'::text; ELSE pass := pass + 1; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C145 FAIL (%/5): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C145 PASS (5/5) ERP como referencia en Operaciones: OT por tipo y unidad con filas válidas, subcontrato, guías, validación, resumen y permisos';
END $test$;
ROLLBACK;
