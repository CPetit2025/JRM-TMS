-- Inventario: ítem del contrato en «Bulto con rótulo», registro de N bultos con peso automático y LPN de inventario.
-- 1) La búsqueda por OT/lote resuelve el ítem del contrato (carga de CONTRATOS vigente): documento = lote (o la OT si el
--    lote es solo la OT) y mismo producto. Si el producto figura en varios ítems del lote, devuelve una fila por ítem.
-- 2) wh_count_label_bultos: el operario indica cantidad por bulto y n° de bultos (y el IPT si figura); la cantidad y el
--    peso totales se calculan (peso unitario del stock ERP del corte de la campaña; si falta, el maestro de SKU). Crea
--    N bultos n/N con el ítem elegido en source_contract_code. Con IPT, sigue impidiendo etiquetar dos veces el mismo bulto.
-- 3) LPN de inventario (origen INVENTARIO): agrupa bultos con rótulo de la campaña, sin LPN, del mismo SKU, lote e ítem.
--    Número = siguiente bulto del lote; se imprime y deshace (con motivo) como el LPN de recepción.

ALTER TABLE public.wh_lpns DROP CONSTRAINT IF EXISTS wh_lpns_origin_check;
ALTER TABLE public.wh_lpns ADD CONSTRAINT wh_lpns_origin_check CHECK (origin IN ('PICKING', 'RECEPCION', 'INVENTARIO'));

-- Ítems del contrato y peso unitario de una línea del stock de la campaña (uso interno de las funciones del inventario).
CREATE OR REPLACE FUNCTION public.wh_count_line_items(p_campaign uuid, p_linea integer)
 RETURNS TABLE(item_code text, item text, contract_qty numeric)
 LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT  -- (import_id, nro_documento, secuencia) es la clave: una fila por ítem
         cl.nro_documento || '-' || lpad(cl.secuencia::text, 3, '0'), lpad(cl.secuencia::text, 3, '0'), coalesce(cl.cant_contrato, 0)
    FROM public.wh_count_expected e
    JOIN public.erp_contract_lines cl
      ON cl.import_id = (SELECT id FROM public.erp_imports WHERE kind = 'CONTRATOS' AND status = 'ACTIVA' ORDER BY applied_at DESC NULLS LAST LIMIT 1)
     AND cl.cod_producto = e.cod_producto AND cl.nro_documento = coalesce(nullif(e.lote_key, ''), e.ot)
   WHERE e.campaign_id = p_campaign AND e.linea = p_linea
     AND coalesce(cl.tipo_producto, '') <> 'SERVICIO A TERCEROS' AND coalesce(cl.tipo_documento, '') NOT ILIKE 'ERROR%'
   ORDER BY cl.nro_documento, cl.secuencia;
$function$;

CREATE OR REPLACE FUNCTION public.wh_count_line_unit_weight(p_campaign uuid, p_linea integer)
 RETURNS TABLE(unit_weight_kg numeric, weight_source text)
 LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp'
AS $function$
  -- El stock ERP del corte trae el peso unitario del lote (peso_total = peso_unitario × stock); el maestro de SKU lo completa.
  SELECT coalesce(nullif(s.peso_unitario, 0), nullif(m.peso_unit, 0)),
         CASE WHEN nullif(s.peso_unitario, 0) IS NOT NULL THEN 'STOCK_ERP' WHEN nullif(m.peso_unit, 0) IS NOT NULL THEN 'MAESTRO_SKU' END
    FROM public.wh_count_expected e JOIN public.wh_count_campaigns c ON c.id = e.campaign_id
    LEFT JOIN public.erp_stock_lots s ON s.import_id = c.erp_import_id AND s.linea = e.linea AND s.cod_producto = e.cod_producto
    LEFT JOIN public.erp_sku_medidas m ON m.cod_producto = e.cod_producto
   WHERE e.campaign_id = p_campaign AND e.linea = p_linea
   LIMIT 1;
$function$;
REVOKE ALL ON FUNCTION public.wh_count_line_items(uuid, integer), public.wh_count_line_unit_weight(uuid, integer) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.wh_count_expected_search(p_campaign uuid, p_search text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_q text := nullif(upper(btrim(p_search)), '');
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT (public.wh_any_warehouse_permission() OR public.wh_count_can_count()) THEN RAISE EXCEPTION 'Sin acceso al almacén' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.wh_count_campaigns WHERE id = p_campaign AND public.can_access_site(site_id)) THEN RAISE EXCEPTION 'Campaña no disponible'; END IF;
  -- Una fila por ítem del contrato (o una sin ítem si el lote no figura en la carga de contratos).
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (
    SELECT e.linea, e.cod_producto, e.producto, e.lote, e.lote_raw, e.lote_key, e.ot, e.unidad, e.stock,
      (SELECT coalesce(sum(l.quantity), 0) FROM public.wh_count_lines l WHERE l.campaign_id = e.campaign_id AND l.voided_at IS NULL
         AND l.cod_producto = e.cod_producto AND l.lote_key = e.lote_key AND l.round = public.wh_count_round(e.campaign_id, e.cod_producto, e.lote_key)) AS counted,
      i.item_code, i.item, i.contract_qty, w.unit_weight_kg, w.weight_source
    FROM public.wh_count_expected e
    LEFT JOIN LATERAL public.wh_count_line_items(e.campaign_id, e.linea) i ON true
    LEFT JOIN LATERAL public.wh_count_line_unit_weight(e.campaign_id, e.linea) w ON true
    WHERE e.campaign_id = p_campaign AND (v_q IS NULL OR upper(coalesce(e.ot, '')) LIKE '%' || v_q || '%' OR upper(coalesce(e.lote_raw, '')) LIKE '%' || v_q || '%'
      OR upper(e.lote_key) LIKE '%' || v_q || '%' OR upper(e.cod_producto) LIKE '%' || v_q || '%' OR upper(coalesce(e.producto, '')) LIKE '%' || v_q || '%'
      OR upper(coalesce(i.item_code, '')) LIKE '%' || v_q || '%')
    ORDER BY e.ot NULLS LAST, e.lote_key, e.cod_producto, i.item_code LIMIT 100) x), '[]'::jsonb);
END $function$;

-- N bultos iguales de un rótulo: cantidad por bulto × n° de bultos; el peso se calcula con el peso unitario del ERP.
CREATE OR REPLACE FUNCTION public.wh_count_label_bultos(p_campaign uuid, p_linea integer, p_item_code text, p_qty_per_bulto numeric, p_bultos integer,
  p_zone text DEFAULT NULL, p_ipt_doc text DEFAULT NULL, p_confirm_over boolean DEFAULT false, p_client_event_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE c public.wh_count_campaigns; e public.wh_count_expected; v_round integer; v_event uuid := coalesce(p_client_event_id, gen_random_uuid());
  v_doc text := nullif(upper(btrim(p_ipt_doc)), ''); v_item text := nullif(btrim(p_item_code), ''); v_unit_kg numeric; v_source text; v_kg numeric;
  v_events uuid[]; v_codes text[] := '{}'; v_code text; v_prefix text; v_base integer := 0; v_id uuid; v_counted numeric; v_contract uuid; i integer;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_count_can_count() THEN RAISE EXCEPTION 'Sin permiso de inventario' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM public.wh_count_campaigns WHERE id = p_campaign FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(c.site_id) THEN RAISE EXCEPTION 'Campaña no disponible'; END IF;
  IF coalesce(p_bultos, 0) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Registre el número de bultos (1 a 200)'; END IF;
  -- Un identificador por bulto derivado del de la operación: el reintento devuelve los mismos bultos.
  SELECT array_agg(CASE WHEN n = 1 THEN v_event ELSE md5(v_event::text || ':' || n)::uuid END ORDER BY n) INTO v_events FROM generate_series(1, p_bultos) n;
  IF EXISTS (SELECT 1 FROM public.wh_count_lines WHERE campaign_id = c.id AND client_event_id = v_event) THEN
    RETURN jsonb_build_object('duplicate_retry', true, 'package_codes', (SELECT jsonb_agg(p.package_code ORDER BY p.sequence_no) FROM public.wh_count_lines l
      JOIN public.wh_packages p ON p.id = l.package_id WHERE l.campaign_id = c.id AND l.client_event_id = ANY (v_events)));
  END IF;
  SELECT * INTO e FROM public.wh_count_expected WHERE campaign_id = c.id AND linea = p_linea;
  IF NOT FOUND THEN RAISE EXCEPTION 'Línea del stock no encontrada en esta campaña'; END IF;
  IF coalesce(p_qty_per_bulto, 0) <= 0 THEN RAISE EXCEPTION 'Registre la cantidad por bulto del rótulo'; END IF;
  IF v_item IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.wh_count_line_items(c.id, e.linea) x WHERE x.item_code = v_item) THEN
    RAISE EXCEPTION 'El ítem % no corresponde al lote % y producto %', v_item, coalesce(e.lote_raw, e.lote, '—'), e.cod_producto;
  END IF;
  IF v_item IS NULL AND EXISTS (SELECT 1 FROM public.wh_count_line_items(c.id, e.linea)) THEN
    RAISE EXCEPTION 'Elija el ítem del contrato del rótulo (el producto % figura en el contrato del lote)', e.cod_producto;
  END IF;
  SELECT unit_weight_kg, weight_source INTO v_unit_kg, v_source FROM public.wh_count_line_unit_weight(c.id, e.linea);
  v_kg := round(p_qty_per_bulto * v_unit_kg, 3);
  v_round := public.wh_count_check(c, e.cod_producto, e.lote_key);
  PERFORM pg_advisory_xact_lock(hashtext('wh_count_identity:' || c.bodega || ':' || e.cod_producto));

  IF v_doc IS NOT NULL THEN
    -- Identidad física: el mismo bulto (IPT, producto, n/N) ya tiene etiqueta (por IPT o por inventario)
    SELECT package_code INTO v_code FROM public.wh_packages WHERE status <> 'VOID' AND source_document_no = v_doc
      AND source_product_code = e.cod_producto AND sequence_total = p_bultos AND sequence_no BETWEEN 1 AND p_bultos LIMIT 1;
    IF v_code IS NOT NULL THEN RAISE EXCEPTION 'Ese bulto ya tiene etiqueta %: escanéela en lugar de etiquetar', v_code; END IF;
  ELSE
    -- Sin IPT: correlativo por bodega, lote y producto (en la identidad física; el rótulo muestra n/N)
    v_prefix := 'LOT|' || c.bodega || '|' || e.lote_key || '|' || e.cod_producto || '|';
    SELECT coalesce(max(substr(physical_key, length(v_prefix) + 1)::integer), 0) INTO v_base FROM public.wh_packages
     WHERE source_kind = 'INVENTARIO' AND left(physical_key, length(v_prefix)) = v_prefix AND substr(physical_key, length(v_prefix) + 1) ~ '^[0-9]+$';
  END IF;

  -- El saldo del lote es una alarma: superar el stock del ERP exige confirmación de supervisión
  SELECT coalesce(sum(quantity), 0) INTO v_counted FROM public.wh_count_lines
   WHERE campaign_id = c.id AND cod_producto = e.cod_producto AND lote_key = e.lote_key AND round = v_round AND voided_at IS NULL;
  IF v_counted + p_qty_per_bulto * p_bultos > (SELECT coalesce(sum(stock), 0) FROM public.wh_count_expected WHERE campaign_id = c.id AND cod_producto = e.cod_producto AND lote_key = e.lote_key) THEN
    IF NOT p_confirm_over THEN RAISE EXCEPTION 'SUPERA_STOCK: lo contado del lote supera el stock del ERP; requiere confirmación de supervisión'; END IF;
    IF NOT public.wh_has_permission(ARRAY['almacen-supervisor','almacen-inventario']) THEN RAISE EXCEPTION 'Solo supervisión confirma un conteo que supera el stock del ERP' USING ERRCODE = '42501'; END IF;
  END IF;

  SELECT id INTO v_contract FROM public.contracts WHERE code = e.ot ORDER BY created_at LIMIT 1;
  FOR i IN 1..p_bultos LOOP
    v_id := gen_random_uuid();
    v_code := public.wh_next_bulto_code(coalesce(e.lote_raw, e.lote));
    PERFORM set_config('wh.count_op', 'on', true);
    INSERT INTO public.wh_packages (id, package_code, source_document_no, source_contract_code, source_lot, source_product_code, source_unit, source_warehouse,
      source_date, source_movement_key, source_label_version, source_key, site_id, contract_id, description, quantity, unit, weight_kg, sequence_no, sequence_total,
      label_print_count, created_by, source_kind, count_campaign_id, count_hold, physical_key)
    VALUES (v_id, v_code, coalesce(v_doc, c.code), coalesce(v_item, e.ot), coalesce(e.lote_raw, e.lote, ''), e.cod_producto, coalesce(e.unidad, ''), c.bodega,
      (now() AT TIME ZONE 'America/Lima')::date, 'INV:' || c.id || ':' || e.linea, 1, 'INV:' || v_id, c.site_id, v_contract, coalesce(e.producto, e.cod_producto),
      p_qty_per_bulto, nullif(e.unidad, ''), v_kg, i, p_bultos, 1, auth.uid(), 'INVENTARIO', c.id, true,
      CASE WHEN v_doc IS NOT NULL THEN 'IPT|' || v_doc || '|' || e.cod_producto || '|' || i || '/' || p_bultos ELSE v_prefix || (v_base + i) END);
    PERFORM set_config('wh.count_op', '', true);
    INSERT INTO public.wh_scan_events (site_id, package_id, event_type, scanned_code, payload, operator_id, client_event_id)
    VALUES (c.site_id, v_id, 'LABEL_PRINT', v_code, jsonb_build_object('print_count', 1, 'count_campaign', c.code, 'item_code', v_item), auth.uid(), gen_random_uuid());
    INSERT INTO public.wh_count_lines (campaign_id, round, package_id, origin, zone, cod_producto, lote_key, ot, quantity, weight_kg, counted_by, client_event_id)
    VALUES (c.id, v_round, v_id, 'ROTULO', nullif(btrim(p_zone), ''), e.cod_producto, e.lote_key, e.ot, p_qty_per_bulto, v_kg, auth.uid(), v_events[i]);
    v_codes := v_codes || v_code;
  END LOOP;
  RETURN jsonb_build_object('package_codes', to_jsonb(v_codes), 'product', e.cod_producto, 'lote', coalesce(e.lote_raw, e.lote), 'ot', e.ot, 'item_code', v_item,
    'qty_per_bulto', p_qty_per_bulto, 'bultos', p_bultos, 'quantity_total', p_qty_per_bulto * p_bultos, 'unit', e.unidad,
    'unit_weight_kg', v_unit_kg, 'weight_source', v_source, 'weight_per_bulto_kg', v_kg, 'weight_total_kg', v_kg * p_bultos,
    'document', coalesce(v_doc, c.code), 'bodega', c.bodega, 'round', v_round);
END $function$;
REVOKE ALL ON FUNCTION public.wh_count_label_bultos(uuid, integer, text, numeric, integer, text, text, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_count_label_bultos(uuid, integer, text, numeric, integer, text, text, boolean, uuid) TO authenticated;

-- LPN de inventario: bultos con rótulo de esta campaña, sin LPN, del mismo SKU, lote e ítem.
CREATE OR REPLACE FUNCTION public.wh_count_consolidate_lpn(p_campaign uuid, p_package_codes text[], p_client_event_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE c public.wh_count_campaigns; v_codes text[]; v_code text; v_prev uuid; v_lpn_id uuid := gen_random_uuid(); v_lpn text; p public.wh_packages%ROWTYPE;
  v_prod text; v_lot text; v_item text; v_qty numeric := 0; v_kg numeric := 0; v_n integer := 0;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_count_can_count() THEN RAISE EXCEPTION 'Sin permiso de inventario' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM public.wh_count_campaigns WHERE id = p_campaign FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(c.site_id) THEN RAISE EXCEPTION 'Campaña no disponible'; END IF;
  IF p_client_event_id IS NOT NULL THEN
    SELECT lpn_id INTO v_prev FROM public.wh_scan_events WHERE site_id = c.site_id AND client_event_id = p_client_event_id AND event_type = 'INVENTORY_LPN_CONSOLIDATE';
    IF v_prev IS NOT NULL THEN
      RETURN public.wh_lpn_detail((SELECT lpn_code FROM public.wh_lpns WHERE id = v_prev)) || jsonb_build_object('duplicate_retry', true);
    END IF;
  END IF;
  IF c.status NOT IN ('EN_CONTEO', 'EN_REVISION') THEN RAISE EXCEPTION 'La campaña no está abierta'; END IF;
  -- Orden de selección sin duplicados: el primer bulto define SKU, lote e ítem del LPN.
  SELECT array_agg(k ORDER BY n) INTO v_codes
    FROM (SELECT upper(trim(u.k)) AS k, min(u.n) AS n FROM unnest(p_package_codes) WITH ORDINALITY AS u(k, n) WHERE nullif(trim(u.k), '') IS NOT NULL GROUP BY upper(trim(u.k))) x;
  IF coalesce(cardinality(v_codes), 0) NOT BETWEEN 2 AND 100 THEN RAISE EXCEPTION 'Seleccione entre 2 y 100 bultos para agrupar en un LPN'; END IF;
  PERFORM 1 FROM public.wh_packages WHERE package_code = ANY (v_codes) ORDER BY package_code FOR UPDATE;
  FOREACH v_code IN ARRAY v_codes LOOP
    SELECT * INTO p FROM public.wh_packages WHERE package_code = v_code;
    IF NOT FOUND OR p.status = 'VOID' THEN RAISE EXCEPTION 'El bulto % no existe o está anulado', v_code; END IF;
    IF p.count_campaign_id IS DISTINCT FROM c.id OR p.source_kind IS DISTINCT FROM 'INVENTARIO' OR NOT EXISTS (
         SELECT 1 FROM public.wh_count_lines l WHERE l.campaign_id = c.id AND l.package_id = p.id AND l.origin = 'ROTULO' AND l.voided_at IS NULL) THEN
      RAISE EXCEPTION 'El bulto % no se registró con rótulo en este inventario', v_code;
    END IF;
    IF p.lpn_id IS NOT NULL THEN
      RAISE EXCEPTION 'El bulto % ya está en el LPN %', v_code, (SELECT lpn_code FROM public.wh_lpns WHERE id = p.lpn_id);
    END IF;
    IF v_prod IS NULL THEN
      v_prod := p.source_product_code; v_lot := public.wh_lote_key(p.source_lot); v_item := coalesce(p.source_contract_code, '');
      v_lpn := public.wh_next_bulto_code(p.source_lot);
      -- Un LPN anulado que ocupaba este código lo cede (el historial sigue por id), como en recepción.
      UPDATE public.wh_lpns SET lpn_code = lpn_code || '-ANULADO-' || upper(substr(replace(id::text, '-', ''), 1, 8)) WHERE lpn_code = v_lpn AND status = 'VOID';
      INSERT INTO public.wh_lpns(id, lpn_code, site_id, task_id, status, origin, created_by, closed_by, closed_at, print_count)
      VALUES (v_lpn_id, v_lpn, c.site_id, NULL, 'CLOSED', 'INVENTARIO', auth.uid(), auth.uid(), now(), 0);
    ELSIF p.source_product_code <> v_prod OR public.wh_lote_key(p.source_lot) <> v_lot OR coalesce(p.source_contract_code, '') <> v_item THEN
      RAISE EXCEPTION 'Solo se agrupan bultos del mismo SKU, lote e ítem: % es de otro (SKU %, lote %, ítem %)', v_code, p.source_product_code, p.source_lot, coalesce(p.source_contract_code, '—');
    END IF;
    UPDATE public.wh_packages SET lpn_id = v_lpn_id WHERE id = p.id;
    INSERT INTO public.wh_scan_events(site_id, package_id, lpn_id, event_type, scanned_code, payload, operator_id, client_event_id)
    VALUES (c.site_id, p.id, v_lpn_id, 'INVENTORY_LPN_ADD', v_code, jsonb_build_object('count_campaign', c.code, 'lpn_code', v_lpn), auth.uid(), gen_random_uuid());
    v_qty := v_qty + p.quantity; v_kg := v_kg + coalesce(p.weight_kg, 0); v_n := v_n + 1;
  END LOOP;
  UPDATE public.wh_lpns SET package_count = v_n, quantity = v_qty, weight_kg = v_kg WHERE id = v_lpn_id;
  INSERT INTO public.wh_scan_events(site_id, lpn_id, event_type, scanned_code, payload, operator_id, client_event_id)
  VALUES (c.site_id, v_lpn_id, 'INVENTORY_LPN_CONSOLIDATE', v_lpn,
    jsonb_build_object('count_campaign', c.code, 'package_codes', v_codes, 'product', v_prod, 'lote', v_lot, 'item_code', nullif(v_item, ''), 'quantity', v_qty, 'weight_kg', v_kg),
    auth.uid(), coalesce(p_client_event_id, gen_random_uuid()));
  RETURN public.wh_lpn_detail(v_lpn);
END $function$;
REVOKE ALL ON FUNCTION public.wh_count_consolidate_lpn(uuid, text[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_count_consolidate_lpn(uuid, text[], uuid) TO authenticated;

-- Últimos bultos contados: ítem y LPN de cada bulto (para agrupar en LPN desde la pantalla del inventario).
CREATE OR REPLACE FUNCTION public.wh_count_lines_list(p_campaign uuid, p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT (public.wh_any_warehouse_permission() OR public.wh_count_can_count()) THEN RAISE EXCEPTION 'Sin acceso al almacén' USING ERRCODE = '42501'; END IF;
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.counted_at DESC) FROM (
    SELECT l.id, l.round, l.origin, l.zone, l.cod_producto, l.lote_key, l.ot, l.quantity, l.weight_kg, l.note, l.other_bodega, l.counted_at,
      public.wh_profile_name(l.counted_by) AS counted_by_name, l.counted_by = auth.uid() AS mine, p.package_code, p.description, p.unit,
      p.source_contract_code AS contract_code, x.id AS lpn_id, x.lpn_code
    FROM public.wh_count_lines l LEFT JOIN public.wh_packages p ON p.id = l.package_id
    LEFT JOIN public.wh_lpns x ON x.id = p.lpn_id AND x.status <> 'VOID'
    JOIN public.wh_count_campaigns c ON c.id = l.campaign_id
    WHERE l.campaign_id = p_campaign AND l.voided_at IS NULL AND public.can_access_site(c.site_id)
    ORDER BY l.counted_at DESC LIMIT least(greatest(coalesce(p_limit, 200), 1), 1000)) x), '[]'::jsonb);
END $function$;

-- Anular una línea cuyo bulto está en un LPN dejaría un LPN con un paquete anulado: primero se deshace el LPN.
CREATE OR REPLACE FUNCTION public.wh_count_void_line(p_line bigint, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE l public.wh_count_lines; c public.wh_count_campaigns; v_lpn text;
BEGIN
  PERFORM public.security_assert_active_session();
  IF nullif(btrim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'Registre el motivo'; END IF;
  SELECT * INTO l FROM public.wh_count_lines WHERE id = p_line FOR UPDATE;
  IF NOT FOUND OR l.voided_at IS NOT NULL THEN RAISE EXCEPTION 'Línea no disponible'; END IF;
  SELECT * INTO c FROM public.wh_count_campaigns WHERE id = l.campaign_id FOR UPDATE;
  IF NOT public.can_access_site(c.site_id) OR c.status NOT IN ('EN_CONTEO','EN_REVISION') THEN RAISE EXCEPTION 'La campaña no está abierta'; END IF;
  IF l.counted_by <> auth.uid() AND NOT public.wh_has_permission(ARRAY['almacen-supervisor','almacen-inventario']) THEN RAISE EXCEPTION 'Solo quien contó o supervisión anulan la línea' USING ERRCODE = '42501'; END IF;
  IF l.origin = 'ROTULO' THEN
    SELECT x.lpn_code INTO v_lpn FROM public.wh_packages p JOIN public.wh_lpns x ON x.id = p.lpn_id WHERE p.id = l.package_id AND x.status <> 'VOID';
    IF v_lpn IS NOT NULL THEN RAISE EXCEPTION 'El bulto está en el LPN %: deshaga el LPN antes de anular la línea', v_lpn; END IF;
  END IF;
  UPDATE public.wh_count_lines SET voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason) WHERE id = l.id;
  IF l.origin = 'ROTULO' THEN
    PERFORM set_config('wh.count_op', 'on', true);
    UPDATE public.wh_packages SET status = 'VOID', count_hold = false WHERE id = l.package_id AND count_campaign_id = c.id AND status <> 'VOID';
    PERFORM set_config('wh.count_op', '', true);
    -- El paquete deja de existir: sus conteos de otras rondas tampoco suman
    UPDATE public.wh_count_lines SET voided_at = now(), voided_by = auth.uid(), void_reason = 'Paquete anulado: ' || btrim(p_reason)
     WHERE campaign_id = c.id AND package_id = l.package_id AND voided_at IS NULL;
  END IF;
  RETURN jsonb_build_object('success', true);
END $function$;

-- LPN de inventario igual que el de recepción (definiciones de producción con el origen INVENTARIO agregado):
-- se deshace con motivo sin tarea, se imprime/reimprime con etiquetado y en el picking se recoge entero por su etiqueta.
CREATE OR REPLACE FUNCTION public.wh_lpn_undo(p_lpn_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_code text; v_n integer := 0; l public.wh_lpns%ROWTYPE; v_codes text[];
BEGIN
  SELECT * INTO l FROM public.wh_lpns WHERE id = p_lpn_id;
  IF FOUND AND l.origin IN ('RECEPCION', 'INVENTARIO') AND l.task_id IS NULL THEN
    PERFORM public.security_assert_active_session();
    IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para deshacer el LPN' USING ERRCODE = '42501'; END IF;
    IF nullif(trim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'Registre el motivo'; END IF;
    SELECT * INTO l FROM public.wh_lpns WHERE id = p_lpn_id FOR UPDATE;
    IF NOT public.can_access_site(l.site_id) THEN RAISE EXCEPTION 'LPN no disponible'; END IF;
    IF l.status <> 'CLOSED' OR l.task_id IS NOT NULL THEN RAISE EXCEPTION 'El LPN % ya no se puede deshacer desde recepción', l.lpn_code; END IF;
    WITH freed AS (
      UPDATE public.wh_packages SET lpn_id = NULL WHERE lpn_id = l.id RETURNING id, package_code
    ), ev AS (
      INSERT INTO public.wh_scan_events(site_id, package_id, lpn_id, event_type, scanned_code, payload, operator_id, client_event_id)
      SELECT l.site_id, f.id, l.id, 'LPN_REMOVE', f.package_code, jsonb_build_object('reason', trim(p_reason), 'released_to_stock', true), auth.uid(), gen_random_uuid() FROM freed f
      RETURNING scanned_code
    ) SELECT array_agg(scanned_code ORDER BY scanned_code) INTO v_codes FROM ev;
    IF coalesce(cardinality(v_codes), 0) = 0 THEN RAISE EXCEPTION 'El LPN no tiene paquetes'; END IF;
    UPDATE public.wh_lpns SET status = 'VOID', void_reason = trim(p_reason), package_count = 0, quantity = 0, weight_kg = 0 WHERE id = l.id;
    INSERT INTO public.wh_scan_events(site_id, lpn_id, event_type, scanned_code, payload, operator_id, client_event_id)
    VALUES (l.site_id, l.id, 'LPN_UNDO', l.lpn_code, jsonb_build_object('reason', trim(p_reason), 'package_codes', v_codes), auth.uid(), gen_random_uuid());
    RETURN jsonb_build_object('success', true, 'packages', cardinality(v_codes));
  END IF;
  FOR v_code IN SELECT package_code FROM public.wh_packages WHERE lpn_id = p_lpn_id ORDER BY package_code LOOP
    PERFORM public.wh_lpn_remove_package(p_lpn_id, v_code, false, p_reason);
    v_n := v_n + 1;
  END LOOP;
  IF v_n = 0 THEN RAISE EXCEPTION 'El LPN no tiene paquetes'; END IF;
  RETURN jsonb_build_object('success', true, 'packages', v_n);
END $function$;
CREATE OR REPLACE FUNCTION public.wh_record_scan(p_task_id uuid, p_code text, p_event text, p_client_event_id uuid, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE l public.wh_lpns%ROWTYPE; t public.wh_tasks%ROWTYPE; v_unit text := nullif(coalesce(p_payload, '{}'::jsonb)->>'load_unit_id', '');
  v_code text; v_n integer := 0;
BEGIN
  IF upper(coalesce(p_event, '')) = 'PICK' THEN
    SELECT * INTO l FROM public.wh_lpns WHERE lpn_code = trim(p_code) AND origin IN ('RECEPCION', 'INVENTARIO') FOR UPDATE;
    IF FOUND THEN
      PERFORM public.security_assert_active_session();
      SELECT * INTO t FROM public.wh_tasks WHERE id = p_task_id;
      IF NOT FOUND OR NOT public.can_access_site(t.site_id) OR l.site_id <> t.site_id THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
      IF NOT public.wh_has_permission(ARRAY['almacen-picking','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para registrar esta lectura' USING ERRCODE = '42501'; END IF;
      IF p_client_event_id IS NULL THEN RAISE EXCEPTION 'Lea un código válido; se requiere identificador de operación'; END IF;
      IF EXISTS (SELECT 1 FROM public.wh_scan_events WHERE site_id = t.site_id AND client_event_id = p_client_event_id AND event_type = 'PICK_LPN' AND task_id = t.id) THEN
        RETURN jsonb_build_object('success', true, 'duplicate_retry', true, 'code', l.lpn_code, 'event', 'PICK');
      END IF;
      IF l.status <> 'CLOSED' OR l.task_id IS NOT NULL THEN RAISE EXCEPTION 'El LPN % no está disponible para picking (ya fue recogido o anulado)', l.lpn_code; END IF;
      -- Cada paquete pasa las mismas validaciones del picking (OT de la solicitud, cantidades, inventario).
      FOR v_code IN SELECT package_code FROM public.wh_packages WHERE lpn_id = l.id AND status <> 'VOID' ORDER BY package_code LOOP
        PERFORM public.wh_record_scan_core(t.id, v_code, 'PICK', gen_random_uuid(), coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('lpn_code', l.lpn_code));
        v_n := v_n + 1;
      END LOOP;
      IF v_n = 0 THEN RAISE EXCEPTION 'El LPN % no tiene paquetes', l.lpn_code; END IF;
      WITH moved AS (
        UPDATE public.wh_packages SET status = 'PACKED' WHERE lpn_id = l.id AND task_id = t.id AND status = 'PICKED' RETURNING task_line_id, quantity
      ), totals AS (
        SELECT task_line_id, sum(quantity) AS qty FROM moved WHERE task_line_id IS NOT NULL GROUP BY task_line_id
      )
      UPDATE public.wh_task_lines tl SET packed_qty = packed_qty + x.qty FROM totals x WHERE tl.id = x.task_line_id;
      UPDATE public.wh_lpns SET task_id = t.id WHERE id = l.id;
      INSERT INTO public.wh_scan_events(site_id, task_id, lpn_id, event_type, scanned_code, payload, operator_id, client_event_id)
      VALUES (t.site_id, t.id, l.id, 'PICK_LPN', l.lpn_code, jsonb_build_object('package_count', v_n), auth.uid(), p_client_event_id);
      PERFORM public.wh_invalidate_release(t.id, 'Nuevo LPN ' || l.lpn_code);
      RETURN jsonb_build_object('success', true, 'lpn', l.lpn_code, 'packages_picked', v_n, 'event', 'PICK');
    END IF;
    SELECT x.* INTO l FROM public.wh_packages p JOIN public.wh_lpns x ON x.id = p.lpn_id
     WHERE p.package_code = trim(p_code) AND x.origin IN ('RECEPCION', 'INVENTARIO') AND x.task_id IS NULL AND x.status <> 'VOID';
    IF l.id IS NOT NULL THEN
      RAISE EXCEPTION 'El paquete % forma parte del LPN de recepción %: lea la etiqueta del LPN para recogerlo completo o deshaga el LPN para separarlo', trim(p_code), l.lpn_code;
    END IF;
  END IF;
  IF upper(coalesce(p_event, '')) = 'LOAD' THEN
    -- Mismas comprobaciones que el registro original, antes de revelar datos de unidades.
    PERFORM public.security_assert_active_session();
    SELECT * INTO t FROM public.wh_tasks WHERE id = p_task_id;
    IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
    IF NOT public.wh_has_permission(ARRAY['almacen-carga','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para registrar esta lectura' USING ERRCODE = '42501'; END IF;
  END IF;
  IF upper(coalesce(p_event, '')) = 'LOAD' AND EXISTS (SELECT 1 FROM public.wh_load_units WHERE task_id = p_task_id) THEN
    -- Se bloquea el bulto: una reasignación simultánea no puede validar contra una unidad obsoleta.
    SELECT * INTO l FROM public.wh_lpns
     WHERE task_id = p_task_id AND status <> 'VOID'
       AND (lpn_code = trim(p_code) OR id = (SELECT lpn_id FROM public.wh_packages WHERE package_code = trim(p_code) AND task_id = p_task_id))
     LIMIT 1 FOR UPDATE;
    -- Una lectura ya registrada (reintento offline) no se vuelve a validar: el registro original la reconoce.
    IF FOUND AND l.status = 'CLOSED' THEN
      IF l.load_unit_id IS NULL THEN RAISE EXCEPTION 'Asigne el bulto % a una unidad de carga antes de cargarlo', l.lpn_code; END IF;
      IF v_unit IS NULL THEN RAISE EXCEPTION 'Seleccione la unidad que se está cargando'; END IF;
      IF l.load_unit_id::text <> v_unit THEN
        RAISE EXCEPTION 'El bulto % corresponde a %, no a la unidad seleccionada', l.lpn_code,
          (SELECT 'UT' || seq || coalesce(' · ' || plate, '') FROM public.wh_load_units WHERE id = l.load_unit_id);
      END IF;
    END IF;
  END IF;
  RETURN public.wh_record_scan_core(p_task_id, p_code, p_event, p_client_event_id, p_payload);
END $function$;
CREATE OR REPLACE FUNCTION public.wh_print_lpn_label(p_lpn_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE l public.wh_lpns%ROWTYPE;
BEGIN
  PERFORM public.security_assert_active_session();
  SELECT * INTO l FROM public.wh_lpns WHERE id = p_lpn_id FOR UPDATE;
  IF NOT public.wh_has_permission(CASE WHEN l.origin IN ('RECEPCION', 'INVENTARIO') THEN ARRAY['almacen-etiquetado','almacen-picking','almacen-packing','almacen-supervisor']
      ELSE ARRAY['almacen-picking','almacen-packing','almacen-supervisor'] END) THEN RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501'; END IF;
  IF NOT FOUND OR NOT public.can_access_site(l.site_id) OR l.status <> 'CLOSED' THEN RAISE EXCEPTION 'LPN no disponible para imprimir'; END IF;
  IF l.print_count > 0 THEN RAISE EXCEPTION 'La etiqueta ya se imprimió: use reimpresión con motivo'; END IF;
  UPDATE public.wh_lpns SET print_count = 1 WHERE id = l.id;
  INSERT INTO public.wh_scan_events(site_id, task_id, lpn_id, event_type, scanned_code, operator_id, client_event_id)
  VALUES (l.site_id, l.task_id, l.id, 'LPN_PRINT', l.lpn_code, auth.uid(), gen_random_uuid());
  RETURN jsonb_build_object('lpn_code', l.lpn_code, 'print_count', 1);
END $function$;
CREATE OR REPLACE FUNCTION public.wh_reprint_lpn_label(p_lpn_code text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE l public.wh_lpns%ROWTYPE;
BEGIN
 PERFORM public.security_assert_active_session();
 SELECT * INTO l FROM public.wh_lpns WHERE lpn_code=trim(p_lpn_code) FOR UPDATE;
 IF NOT public.wh_has_permission(CASE WHEN l.origin IN ('RECEPCION','INVENTARIO') THEN ARRAY['almacen-etiquetado','almacen-packing','almacen-supervisor'] ELSE ARRAY['almacen-packing','almacen-supervisor'] END)
    OR nullif(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Reimpresión de LPN requiere permiso y motivo' USING ERRCODE='42501'; END IF;
 IF NOT FOUND OR NOT public.can_access_site(l.site_id) OR l.status IN ('VOID','OPEN') THEN RAISE EXCEPTION 'LPN no disponible para reimpresión'; END IF;
 UPDATE public.wh_lpns SET print_count=print_count+1 WHERE id=l.id;
 INSERT INTO public.wh_scan_events(site_id,task_id,lpn_id,event_type,scanned_code,payload,operator_id,client_event_id)
 VALUES(l.site_id,l.task_id,l.id,'LPN_REPRINT',l.lpn_code,jsonb_build_object('reason',trim(p_reason),'previous_print_count',l.print_count),auth.uid(),gen_random_uuid());
 RETURN jsonb_build_object('lpn_code',l.lpn_code,'print_count',l.print_count+1);
END $function$;
