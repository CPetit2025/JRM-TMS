-- CAJA C140 — Excel del ERP (Actualizable Despacho y Stock Bodega Despacho): carga por bloques, fechas ERP/TMS por guía,
-- stock listo por OT y reemplazo de la foto. Siempre se revierte.
BEGIN;
UPDATE public.transport_lead_time_settings SET settings=jsonb_set(settings,'{enabled}','false'::jsonb);
CREATE FUNCTION pg_temp.ins(p_table text, p_cols jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  EXECUTE (SELECT format('INSERT INTO public.%I (%s) VALUES (%s) RETURNING id', p_table,
                         string_agg(quote_ident(k.key), ', '), string_agg(quote_nullable(k.value #>> '{}'), ', '))
           FROM jsonb_each(p_cols) k
           WHERE EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema = 'public' AND ic.table_name = p_table AND ic.column_name = k.key))
  INTO v_id;
  RETURN v_id;
END $$;

DO $test$
DECLARE admin_id uuid; site uuid; client uuid; ct uuid; ct2 uuid; r1 uuid; r2 uuid; r3 uuid; d1 uuid; d2 uuid; d3 uuid; up uuid; up2 uuid; res jsonb; g jsonb; o jsonb;
  n text := (90000 + floor(random() * 9999))::int::text; tag text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  g1 text; g2 text; g3 text; g4 text; d0 date := (now() AT TIME ZONE 'America/Lima')::date; pass int := 0; fails text[] := '{}';
BEGIN
  FOR admin_id IN SELECT id FROM public.profiles WHERE is_active AND id IN (SELECT id FROM auth.users) LOOP
    PERFORM set_config('request.jwt.claim.sub', admin_id::text, true); EXIT WHEN public.is_tms_admin() AND public.apt_can_load(); admin_id := NULL;
  END LOOP;
  SELECT site_id INTO site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
  SELECT id INTO client FROM public.clients ORDER BY id LIMIT 1;
  IF admin_id IS NULL OR site IS NULL THEN RAISE EXCEPTION 'CAJA C140 FAIL: faltan administrador con carga APT o sede'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  g1 := 'TZ' || n || '-00000001'; g2 := 'TZ' || n || '-00000002'; g3 := 'TZ' || n || '-00000003'; g4 := 'TZ' || n || '-00000004';

  -- T1 carga incompleta: no se aplica y se informa
  up := (public.erp_upload_begin('CONTRATOS', 'C140.xlsx', now(), 4)->>'upload_id')::uuid;
  res := public.erp_upload_rows(up, jsonb_build_array(
    -- Línea con dos guías (fecha ERP aproximada) y 4 pendientes
    jsonb_build_object('nro_contrato', n, 'nro_documento', n, 'secuencia', 1, 'tipo_documento', 'CONTRATO DE VENTAS', 'cliente', 'CLIENTE C140', 'ruc', '20999999991',
      'vigencia', 'S', 'cod_producto', 'ZZA' || tag, 'producto', 'PRODUCTO A', 'unidad', 'UND', 'cant_contrato', 10, 'cant_despachada', 6, 'cant_pendiente', 4,
      'estado', 'PARCIAL', 'nro_guias', 2, 'fecha_ult_despacho', d0, 'tipo_producto', 'PRODUCTO TERMINADO',
      'guias', jsonb_build_array(jsonb_build_object('g', g1, 'c', 4, 'p', 1), jsonb_build_object('g', g2, 'c', 2, 'p', 2))),
    -- Subcontrato sin despacho: 500 und (el stock viene en cientos)
    jsonb_build_object('nro_contrato', n, 'nro_documento', n || '-S001', 'secuencia', 1, 'tipo_documento', 'SUBCONTRATO DE VENTAS', 'cliente', 'CLIENTE C140',
      'cod_producto', 'ZZB' || tag, 'producto', 'PERNO B', 'unidad', 'UNID', 'cant_contrato', 500, 'cant_despachada', 0, 'cant_pendiente', 500, 'nro_guias', 0,
      'tipo_producto', 'MAT.AUX/SUMI/REPUEST', 'guias', '[]'::jsonb),
    -- Línea completa con una sola guía (fecha ERP exacta)
    jsonb_build_object('nro_contrato', n, 'nro_documento', n, 'secuencia', 2, 'tipo_documento', 'CONTRATO DE VENTAS', 'cliente', 'CLIENTE C140',
      'cod_producto', 'ZZC' || tag, 'producto', 'PRODUCTO C', 'unidad', 'UND', 'cant_contrato', 5, 'cant_despachada', 5, 'cant_pendiente', 0, 'estado', 'COMPLETO',
      'nro_guias', 1, 'fecha_ult_despacho', d0 - 3, 'guias', jsonb_build_array(jsonb_build_object('g', g3, 'c', 5, 'p', 1)))));
  -- Reintento del mismo bloque: no duplica
  PERFORM public.erp_upload_rows(up, jsonb_build_array(jsonb_build_object('nro_documento', n, 'secuencia', 1, 'cod_producto', 'ZZA' || tag)));
  res := public.erp_upload_apply(up);
  IF res->>'success' = 'false' AND (res->>'partial')::boolean AND (SELECT rows_loaded FROM public.erp_imports WHERE id = up) = 3
  THEN pass := pass + 1; ELSE fails := fails || ('T1 incompleta: ' || res::text); END IF;

  -- T2 completa: aplica, guía por despacho y fechas ERP (exacta / aproximada)
  PERFORM public.erp_upload_rows(up, jsonb_build_array(jsonb_build_object('nro_contrato', n, 'nro_documento', n || '-E001', 'secuencia', 1,
    'tipo_documento', 'ERROR DE CONTRATO', 'cod_producto', 'ZZD' || tag, 'producto', 'D', 'unidad', 'UND', 'cant_contrato', 1, 'cant_despachada', 0, 'cant_pendiente', 1)));
  res := public.erp_upload_apply(up);
  IF res->>'success' = 'true' AND (res->'summary'->>'lineas')::int = 4 AND (res->'summary'->>'despachos')::int = 3 AND (res->'summary'->>'guias')::int = 3
     AND (SELECT exacta AND fecha = d0 - 3 AND fuente = 'ACTUALIZABLE' FROM public.erp_guia_fechas WHERE import_id = up AND guia_key = public.apt_guia_key(g3))
     AND (SELECT NOT exacta AND fecha = d0 AND fuente = 'APROXIMADA' FROM public.erp_guia_fechas WHERE import_id = up AND guia_key = public.apt_guia_key(g1))
     AND (SELECT unidad FROM public.erp_contract_lines WHERE import_id = up AND nro_documento = n || '-S001') = 'UND'
  THEN pass := pass + 1; ELSE fails := fails || ('T2 aplicar: ' || res::text); END IF;

  -- Stock: lote con ceros (OT), subcontrato en cientos, OT completa, lote ajeno y sin lote
  up2 := (public.erp_upload_begin('STOCK', 'C140 stock.xlsx', now(), 5)->>'upload_id')::uuid;
  PERFORM public.erp_upload_rows(up2, jsonb_build_array(
    jsonb_build_object('linea', 2, 'bodega', 'ZZ-BOD', 'cod_producto', 'ZZA' || tag, 'unidad', 'UND', 'lote', '0000' || n, 'stock', 10, 'peso_unitario', 2, 'peso_total', 20),
    jsonb_build_object('linea', 3, 'bodega', 'ZZ-BOD', 'cod_producto', 'ZZB' || tag, 'unidad', 'CIEN', 'lote', n || '-S001', 'stock', 3, 'peso_unitario', 0.048, 'peso_total', 0.144),
    jsonb_build_object('linea', 4, 'bodega', 'ZZ-BOD', 'cod_producto', 'ZZC' || tag, 'unidad', 'UND', 'lote', n, 'stock', 2, 'peso_unitario', 1, 'peso_total', 2),
    jsonb_build_object('linea', 5, 'bodega', 'ZZ-BOD', 'cod_producto', 'ZZA' || tag, 'unidad', 'UND', 'lote', 'ZZ' || tag || 'X', 'stock', 1),
    jsonb_build_object('linea', 6, 'bodega', 'ZZ-BOD', 'cod_producto', 'ZZA' || tag, 'unidad', 'UND', 'stock', 1)));
  res := public.erp_upload_apply(up2);
  -- T3 situación del stock frente al pendiente (cientos → unidades; peso por unidad)
  res := public.erp_stock(jsonb_build_object('bodega', 'ZZ-BOD'));
  IF (SELECT string_agg(concat_ws(':', l->>'situacion', round((l->>'listo')::numeric), COALESCE(round((l->>'kg')::numeric, 1)::text, '-')), ',' ORDER BY l->>'situacion') FROM jsonb_array_elements(res->'lotes') l)
     = 'LISTO:300:14.4,OT_COMPLETA:0:2.0,SIN_CONTRATO:0:-,SIN_LOTE:0:-,SOBRANTE:4:20.0'
  THEN pass := pass + 1; ELSE fails := fails || ('T3 stock: ' || (res->'lotes')::text); END IF;

  -- T4 OT pendiente: sin «Error de contrato» por defecto; listo en stock y peso
  res := public.erp_ots(jsonb_build_object('q', n));
  o := res->'ots'->0;
  IF (o->>'ot') = n AND (o->>'pendiente')::numeric = 504 AND (o->>'listo')::numeric = 304 AND (o->>'t_listo')::numeric = 0.022
     AND (public.erp_ots(jsonb_build_object('q', n, 'incluir_errores', true))->'ots'->0->>'pendiente')::numeric = 505
  THEN pass := pass + 1; ELSE fails := fails || ('T4 OT: ' || COALESCE(o::text, res::text)); END IF;

  -- Rutas del TMS: g1 programada ayer (en ambas fuentes), g3 en otra OT, g4 solo en el TMS
  ct := pg_temp.ins('contracts', jsonb_build_object('code', n, 'type', 'CONTRATO', 'status', 'ACTIVO', 'site_id', site, 'client_id', client));
  ct2 := pg_temp.ins('contracts', jsonb_build_object('code', 'ZZ-C140-' || tag, 'type', 'CONTRATO', 'status', 'ACTIVO', 'site_id', site, 'client_id', client));
  r1 := pg_temp.ins('transport_requests', jsonb_build_object('request_number', 'ZZ-C140-' || tag || '-1', 'requester_name', 'ZZ C140', 'pickup_address', 'Origen',
    'delivery_address', 'Destino', 'request_type', 'DESPACHO', 'status', 'ASIGNADA', 'required_date', current_date, 'contract_id', ct, 'site_id', site, 'client_id', client, 'attention_mode', 'TRANSPORTE_JRM'));
  r2 := pg_temp.ins('transport_requests', jsonb_build_object('request_number', 'ZZ-C140-' || tag || '-2', 'requester_name', 'ZZ C140', 'pickup_address', 'Origen',
    'delivery_address', 'Destino', 'request_type', 'DESPACHO', 'status', 'ASIGNADA', 'required_date', current_date, 'contract_id', ct2, 'site_id', site, 'client_id', client, 'attention_mode', 'TRANSPORTE_JRM'));
  r3 := pg_temp.ins('transport_requests', jsonb_build_object('request_number', 'ZZ-C140-' || tag || '-3', 'requester_name', 'ZZ C140', 'pickup_address', 'Origen',
    'delivery_address', 'Destino', 'request_type', 'DESPACHO', 'status', 'ASIGNADA', 'required_date', current_date, 'contract_id', ct, 'site_id', site, 'client_id', client, 'attention_mode', 'TRANSPORTE_JRM'));
  d1 := pg_temp.ins('dispatches', jsonb_build_object('dispatch_number', 'ZZ-C140-1-' || tag, 'vehicle_plate', 'ZQ1' || tag, 'driver_name', 'ZZ C140',
    'scheduled_departure', ((d0 - 1)::timestamp + interval '12 hours') AT TIME ZONE 'America/Lima', 'status', 'PROGRAMADO', 'freight_cost', 0, 'site_id', site));
  d2 := pg_temp.ins('dispatches', jsonb_build_object('dispatch_number', 'ZZ-C140-2-' || tag, 'vehicle_plate', 'ZQ2' || tag, 'driver_name', 'ZZ C140',
    'scheduled_departure', ((d0 - 3)::timestamp + interval '12 hours') AT TIME ZONE 'America/Lima', 'status', 'PROGRAMADO', 'freight_cost', 0, 'site_id', site));
  d3 := pg_temp.ins('dispatches', jsonb_build_object('dispatch_number', 'ZZ-C140-3-' || tag, 'vehicle_plate', 'ZQ3' || tag, 'driver_name', 'ZZ C140',
    'scheduled_departure', (d0::timestamp + interval '12 hours') AT TIME ZONE 'America/Lima', 'status', 'PROGRAMADO', 'freight_cost', 0, 'site_id', site));
  INSERT INTO public.dispatch_requests(dispatch_id, transport_request_id, status, document_type, document_number, sequence_order)
  VALUES (d1, r1, 'PROGRAMADO', 'GR', lower(replace(g1, '-0000000', '-')), 1), (d2, r2, 'PROGRAMADO', 'GR', g3, 1), (d3, r3, 'PROGRAMADO', 'GR', g4, 1);

  -- T5 guías: dos fechas, diferencia, OT distinta y solo TMS (la clave de guía ignora ceros y mayúsculas)
  res := public.erp_guias(jsonb_build_object('q', 'TZ' || n, 'desde', d0 - 10, 'hasta', d0));
  SELECT x INTO g FROM jsonb_array_elements(res->'guias') x WHERE x->>'guia' = g1;
  IF g->>'origen' = 'AMBOS' AND (g->>'fecha_tms')::date = d0 - 1 AND (g->>'dif_dias')::int = -1 AND NOT (g->>'erp_exacta')::boolean
     AND (SELECT x->>'origen' = 'AMBOS' AND (x->>'ot_distinta')::boolean AND (x->>'dif_dias')::int = 0 FROM jsonb_array_elements(res->'guias') x WHERE x->>'guia' = g3)
     AND (SELECT x->>'origen' FROM jsonb_array_elements(res->'guias') x WHERE x->>'guia' = g4) = 'SOLO_TMS'
     AND (SELECT x->>'origen' FROM jsonb_array_elements(res->'guias') x WHERE x->>'guia' = g2) = 'SOLO_ERP'
     AND (res->'resumen'->>'ot_distinta')::int = 1
     AND jsonb_array_length(public.erp_guias(jsonb_build_object('q', 'TZ' || n, 'referencia', 'ERP', 'desde', d0, 'hasta', d0))->'guias') = 2
     AND jsonb_array_length(public.erp_guias(jsonb_build_object('q', 'TZ' || n, 'origen', 'DESFASE', 'tolerancia', 0, 'desde', d0 - 10, 'hasta', d0))->'guias') = 2
  THEN pass := pass + 1; ELSE fails := fails || ('T5 guías: ' || res::text); END IF;

  -- T6 detalle de la OT
  res := public.erp_ot_detalle(n || '-S001');
  IF res->>'success' = 'true' AND jsonb_array_length(res->'lineas') = 4 AND jsonb_array_length(res->'guias') = 3 AND jsonb_array_length(res->'stock') = 3
     AND (SELECT (l->>'listo')::numeric FROM jsonb_array_elements(res->'lineas') l WHERE l->>'documento' = n || '-S001') = 300
  THEN pass := pass + 1; ELSE fails := fails || ('T6 detalle: ' || left(res::text, 400)); END IF;

  -- T7 una nueva carga reemplaza la foto y borra sus filas; sin permiso no se ve ni se carga
  up2 := (public.erp_upload_begin('CONTRATOS', 'C140 b.xlsx', now(), 1)->>'upload_id')::uuid;
  PERFORM public.erp_upload_rows(up2, jsonb_build_array(jsonb_build_object('nro_documento', n, 'secuencia', 1, 'cod_producto', 'ZZA' || tag, 'cant_contrato', 1, 'cant_pendiente', 1)));
  res := public.erp_upload_apply(up2);
  IF res->>'success' = 'true' AND (SELECT status FROM public.erp_imports WHERE id = up) = 'REEMPLAZADA'
     AND NOT EXISTS (SELECT 1 FROM public.erp_contract_lines WHERE import_id = up) AND NOT EXISTS (SELECT 1 FROM public.erp_guia_fechas WHERE import_id = up)
     AND (SELECT count(*) FROM public.erp_imports WHERE kind = 'CONTRATOS' AND status = 'ACTIVA') = 1
     AND NOT has_function_privilege('anon', 'public.erp_estado()', 'EXECUTE')
     AND NOT has_table_privilege('authenticated', 'public.erp_contract_lines', 'SELECT')
  THEN pass := pass + 1; ELSE fails := fails || ('T7 reemplazo: ' || res::text); END IF;
  PERFORM set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  IF (public.erp_estado()->>'success') = 'true' OR (public.erp_upload_begin('STOCK', 'x', now(), 1)->>'success') = 'true' THEN fails := fails || 'T7 sin permiso'::text; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C140 FAIL (%/7): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C140 PASS (7/7) Excel del ERP: carga por bloques, fecha ERP y TMS por guía, stock listo por OT y reemplazo de la foto';
END $test$;
ROLLBACK;
