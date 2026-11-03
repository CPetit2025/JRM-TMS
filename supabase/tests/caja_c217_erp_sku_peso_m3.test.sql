-- CAJA C217 — Catálogo por SKU del ERP: el peso de un SKU sigue disponible cuando sale del Stock; las medidas de la
-- descripción dan m³ confiable si la densidad cuadra con el peso; el volumen de la OT se completa sin pisar uno escrito a
-- mano. Siempre se revierte (termina en error a propósito).
BEGIN;
DO $test$
DECLARE admin_id uuid; up uuid; v_site uuid; v_cli uuid; oa text; ob text; sku text; res jsonb; pass int := 0; fails text[] := '{}';
  hoy date := (now() AT TIME ZONE 'America/Lima')::date;
BEGIN
  SELECT p.id INTO admin_id FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id
   WHERE p.is_active AND ro.name = 'Administrador' AND p.id IN (SELECT id FROM auth.users) ORDER BY p.created_at LIMIT 1;
  IF admin_id IS NULL THEN RAISE EXCEPTION 'CAJA C217 FAIL: falta un Administrador activo'; END IF;
  PERFORM set_config('request.jwt.claim.sub', admin_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  SELECT site_id INTO v_site FROM public.contracts WHERE site_id IS NOT NULL AND parent_contract_id IS NULL LIMIT 1;
  SELECT client_id INTO v_cli FROM public.contracts WHERE client_id IS NOT NULL AND parent_contract_id IS NULL LIMIT 1;
  LOOP oa := (70000 + floor(random() * 9999))::int::text; EXIT WHEN NOT EXISTS (SELECT 1 FROM public.contracts WHERE code LIKE oa || '%'); END LOOP;
  LOOP ob := (70000 + floor(random() * 9999))::int::text; EXIT WHEN ob <> oa AND NOT EXISTS (SELECT 1 FROM public.contracts WHERE code LIKE ob || '%'); END LOOP;
  sku := 'CJA' || floor(random() * 99999)::int || '.20.033.0760';
  INSERT INTO public.contracts (code, type, status, site_id, client_id) VALUES (oa, 'CONTRATO', 'ACTIVO', v_site, v_cli), (ob, 'CONTRATO', 'ACTIVO', v_site, v_cli);
  EXECUTE 'UPDATE public.contracts SET total_volume_m3 = 7 WHERE code = $1' USING ob;

  -- Stock con el poste (2,5 kg por unidad)
  up := (public.erp_upload_begin('STOCK', 'C217 stock.xlsx', now() - interval '1 hour', 1)->>'upload_id')::uuid;
  PERFORM public.erp_upload_rows(up, jsonb_build_array(jsonb_build_object('linea', 1, 'bodega', '647-04 ALM PT', 'cod_producto', sku,
    'producto', 'POSTE DE RACK OMEGA DE 3 X 3 DE 2mm x 0.76m DE LARGO', 'unidad', 'UND', 'lote', oa, 'stock', 5, 'peso_unitario', 2.5, 'familia', 'C217')));
  PERFORM public.erp_upload_apply(up);
  -- Actualizable: A pide 100 postes; B 10 postes (B tiene 7 m³ escritos a mano)
  up := (public.erp_upload_begin('CONTRATOS', 'C217.xlsx', now() - interval '1 hour', 2)->>'upload_id')::uuid;
  PERFORM public.erp_upload_rows(up, (SELECT jsonb_agg(jsonb_build_object('linea', x.i, 'nro_contrato', x.ot, 'nro_documento', x.ot, 'secuencia', 1,
      'tipo_documento', 'CONTRATO DE VENTAS', 'correlativo', x.ot || '1', 'cliente', 'CLIENTE C217', 'ruc', '20100000001', 'cod_producto', sku,
      'producto', 'POSTE DE RACK OMEGA DE 3 X 3 DE 2mm x 0.76m DE LARGO', 'unidad', 'UND', 'familia', 'C217', 'tipo_producto', 'PRODUCTO TERMINADO',
      'cant_contrato', x.cant, 'cant_despachada', 0, 'cant_reemplazada', 0, 'cant_pendiente', x.cant,
      'fecha_contrato', to_char(hoy - 10, 'YYYY-MM-DD'), 'fecha_vcto', to_char(hoy + 10, 'YYYY-MM-DD')))
    FROM (VALUES (1, oa, 100), (2, ob, 10)) x(i, ot, cant)));
  PERFORM public.erp_upload_apply(up);

  -- T1 medidas 0,76 × 0,0762 × 0,0762 m con densidad ~566 kg/m³: confiable
  IF EXISTS (SELECT 1 FROM public.erp_sku_medidas WHERE cod_producto = sku AND m3_confiable AND peso_unit = 2.5
             AND largo_m = 0.76 AND ancho_m = 0.0762 AND alto_m = 0.0762 AND kg_m3 BETWEEN 560 AND 570)
  THEN pass := pass + 1; ELSE fails := fails || ('T1 catálogo: ' || COALESCE((SELECT to_jsonb(s)::text FROM public.erp_sku_medidas s WHERE cod_producto = sku), 'sin fila')); END IF;

  -- T2 un Stock nuevo sin el poste: la línea conserva el peso del catálogo
  up := (public.erp_upload_begin('STOCK', 'C217 stock 2.xlsx', now() - interval '30 minutes', 1)->>'upload_id')::uuid;
  PERFORM public.erp_upload_rows(up, jsonb_build_array(jsonb_build_object('linea', 1, 'bodega', '647-04 ALM PT', 'cod_producto', sku || 'B',
    'producto', 'OTRO', 'unidad', 'UND', 'lote', ob, 'stock', 1, 'peso_unitario', 1)));
  PERFORM public.erp_upload_apply(up);
  IF (SELECT bool_and(peso_unit = 2.5) FROM public.erp_contract_lines WHERE import_id = public.erp_active_import('CONTRATOS') AND cod_producto = sku)
  THEN pass := pass + 1; ELSE fails := fails || 'T2 el peso se perdió al salir del Stock'::text; END IF;

  -- T3 volumen: A 100 × 0,00441 = 0,44 m³; B conserva sus 7 m³
  res := public.erp_contratos_pesos_core();
  IF (res->>'success')::boolean AND (SELECT to_jsonb(c)->>'total_volume_m3' FROM public.contracts c WHERE code = oa)::numeric = 0.44
     AND (SELECT to_jsonb(c)->>'total_volume_m3' FROM public.contracts c WHERE code = ob)::numeric = 7
     AND EXISTS (SELECT 1 FROM public.erp_contract_volumenes v JOIN public.contracts c ON c.id = v.contract_id
                 WHERE c.code = oa AND v.m3 = 0.44 AND v.lineas = 1 AND v.lineas_sin_m3 = 0)
  THEN pass := pass + 1; ELSE fails := fails || ('T3 volumen: ' || res::text); END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C217 FAIL (%/3): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C217 PASS (%/3) peso por SKU persistente y m³ por medidas con control de densidad', pass;
END $test$;
ROLLBACK;
