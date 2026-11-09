-- Número de bulto correlativo POR LOTE: cada lote numera sus bultos desde B-0001 (primer ingreso) y sigue la misma
-- serie al agrupar. Código del bulto = lote-B-0001 (único y escaneable entre lotes); sin lote: SIN-LOTE-B-0001.
--  · Recepción (wh_label_package) e inventario (wh_count_label) numeran cada paquete al generar su etiqueta;
--    regenerar etiquetas ya existentes reutiliza su número y no avanza el contador.
--  · Picking no genera números: se escanea el bulto.
--  · Agrupar 2+ paquetes (wh_consolidate_lpn) crea un bulto nuevo con el siguiente número del lote; un paquete que
--    sale solo conserva el suyo.
-- Los paquetes ya etiquetados conservan su código PKG-… (sus etiquetas físicas ya están impresas).
-- Las funciones se toman de la definición vigente en producción; solo cambia la expresión del código.
-- Se retira la consolidación antigua (crear/agregar/cerrar LPN), reemplazada por la de la tarea.
CREATE TABLE IF NOT EXISTS public.wh_bulto_counters (
  lot text PRIMARY KEY,
  last_no integer NOT NULL CHECK (last_no > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.wh_bulto_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wh_bulto_counters FROM PUBLIC, anon, authenticated;

-- La fila del lote se bloquea al incrementar: dos etiquetados simultáneos del mismo lote no repiten número.
CREATE OR REPLACE FUNCTION public.wh_next_bulto_code(p_lot text) RETURNS text
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
-- El lote se normaliza a A-Z, 0-9 y guiones (Code 128 solo representa ASCII); el lote original queda en source_lot.
DECLARE v_lot text := coalesce(nullif(btrim(regexp_replace(translate(upper(btrim(coalesce(p_lot, ''))), 'ÁÀÄÂÉÈËÊÍÌÏÎÓÒÖÔÚÙÜÛÑÇ', 'AAAAEEEEIIIIOOOOUUUUNC'), '[^A-Z0-9]+', '-', 'g'), '-'), ''), 'SIN-LOTE'); v_n integer;
BEGIN
  INSERT INTO public.wh_bulto_counters(lot, last_no) VALUES (v_lot, 1)
  ON CONFLICT (lot) DO UPDATE SET last_no = public.wh_bulto_counters.last_no + 1, updated_at = now()
  RETURNING last_no INTO v_n;
  RETURN v_lot || '-B-' || lpad(v_n::text, greatest(4, length(v_n::text)), '0');
END $$;
REVOKE ALL ON FUNCTION public.wh_next_bulto_code(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.wh_label_package(p_receipt_key text, p_package_count integer, p_units_per_package numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_site uuid:=public.primary_site_id(); v_i int; v_key text; v_id uuid; v_codes jsonb:='[]'::jsonb; v_code text;
 v_total numeric; v_qty numeric; v_remaining numeric; v_weight numeric; v_receipt record; v_validation record; v_version integer;
BEGIN
 PERFORM public.security_assert_active_session(); IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso de etiquetado' USING ERRCODE='42501'; END IF;
 IF v_site IS NULL OR NOT public.can_access_site(v_site) OR p_package_count NOT BETWEEN 1 AND 100 OR nullif(trim(p_receipt_key),'') IS NULL OR
    (p_units_per_package IS NOT NULL AND p_units_per_package<=0) THEN RAISE EXCEPTION 'Datos de etiqueta inválidos'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_receipt_key,0));
 SELECT s.source_key AS receipt_key,s.document_no,s.source_date AS fecha,s.lot AS lote,s.product_code,s.description,s.unit,s.warehouse AS bodega,
   coalesce(nullif(s.contract_code,''),nullif(s.origin_number,''),s.lot) AS contract_code,c.id AS contract_id,s.quantity,s.total_weight AS weight_kg
 INTO v_receipt FROM public.wh_receipt_sources s LEFT JOIN public.contracts c
   ON regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(coalesce(nullif(s.contract_code,''),nullif(s.origin_number,''),s.lot)),'[^A-Z0-9]','','g'),'^OT','')
  WHERE s.source_key=p_receipt_key AND s.active;
 IF NOT FOUND OR v_receipt.quantity<=0 THEN RAISE EXCEPTION 'El ingreso APT no existe o ya no está activo; actualice la fuente WMS'; END IF;
 SELECT * INTO v_validation FROM public.wh_receipt_validations WHERE source_movement_key=p_receipt_key ORDER BY validated_at DESC,id DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'Confirme la cantidad física del ingreso antes de generar etiquetas'; END IF;
 IF v_validation.erp_quantity<>v_receipt.quantity THEN RAISE EXCEPTION 'El IPT cambió en el actualizable APT; valide de nuevo antes de etiquetar'; END IF;
 v_total:=v_validation.physical_quantity; v_remaining:=v_total; v_weight:=v_receipt.weight_kg;
 IF v_total<=0 THEN RAISE EXCEPTION 'El conteo físico es cero; no hay bultos para etiquetar'; END IF;
 IF p_units_per_package IS NOT NULL AND ceil(v_total/p_units_per_package)::integer<>p_package_count THEN RAISE EXCEPTION 'El número de paquetes no coincide con la capacidad estándar'; END IF;
 SELECT max(source_label_version) INTO v_version FROM public.wh_packages WHERE source_movement_key=p_receipt_key AND status<>'VOID';
 IF v_version IS NOT NULL AND EXISTS(SELECT 1 FROM public.wh_packages WHERE source_movement_key=p_receipt_key AND status='VOID' AND source_label_version=v_version) THEN RAISE EXCEPTION 'Hay etiquetas anuladas y activas en la misma versión; anule primero todas las etiquetas activas'; END IF;
 IF v_version IS NULL THEN
  IF EXISTS(SELECT 1 FROM public.wh_packages WHERE source_movement_key=p_receipt_key AND status='VOID') AND NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN RAISE EXCEPTION 'Solo supervisión puede generar una nueva versión de etiquetas anuladas'; END IF;
  SELECT coalesce(max(source_label_version),0)+1 INTO v_version FROM public.wh_packages WHERE source_movement_key=p_receipt_key;
 END IF;
 FOR v_i IN 1..p_package_count LOOP
  v_key:=p_receipt_key||':'||v_version::text||':'||v_i::text; v_id:=gen_random_uuid();
  v_qty:=CASE WHEN p_units_per_package IS NULL THEN
   CASE WHEN v_i=p_package_count THEN v_remaining ELSE round(v_total/p_package_count,3) END
   ELSE least(p_units_per_package,v_remaining) END;
  IF v_qty<=0 THEN RAISE EXCEPTION 'La división produce un paquete vacío'; END IF;
  INSERT INTO public.wh_packages(id,package_code,source_document_no,source_contract_code,source_lot,source_product_code,source_unit,source_warehouse,source_date,source_movement_key,source_label_version,source_key,site_id,contract_id,description,quantity,unit,weight_kg,sequence_no,sequence_total,source_qty_snapshot,source_expected_total,source_expected_count,created_by)
  VALUES(v_id,coalesce((SELECT package_code FROM public.wh_packages WHERE source_key=v_key),public.wh_next_bulto_code(v_receipt.lote)),v_receipt.document_no,v_receipt.contract_code,coalesce(v_receipt.lote,''),v_receipt.product_code,coalesce(v_receipt.unit,''),v_receipt.bodega,v_receipt.fecha,p_receipt_key,v_version,v_key,v_site,v_receipt.contract_id,v_receipt.description,v_qty,nullif(v_receipt.unit,''),CASE WHEN v_weight IS NOT NULL AND v_receipt.quantity>0 THEN round(v_weight*v_qty/v_receipt.quantity,3) END,v_i,p_package_count,v_qty,v_total,p_package_count,auth.uid())
  ON CONFLICT(source_key) DO UPDATE SET source_qty_snapshot=excluded.source_qty_snapshot,source_expected_total=excluded.source_expected_total,source_expected_count=excluded.source_expected_count,
    quantity=CASE WHEN wh_packages.status='AVAILABLE' AND wh_packages.label_print_count=0 THEN excluded.quantity ELSE wh_packages.quantity END,
    sequence_total=CASE WHEN wh_packages.status='AVAILABLE' AND wh_packages.label_print_count=0 THEN excluded.sequence_total ELSE wh_packages.sequence_total END,
    source_contract_code=excluded.source_contract_code,source_warehouse=excluded.source_warehouse,source_date=excluded.source_date,description=excluded.description,updated_at=now();
  SELECT package_code INTO v_code FROM public.wh_packages WHERE source_key=v_key AND status<>'VOID';
  IF v_code IS NULL THEN RAISE EXCEPTION 'No fue posible recuperar la etiqueta del ingreso'; END IF;
  v_codes:=v_codes||jsonb_build_array(v_code);
  v_remaining:=v_remaining-v_qty;
 END LOOP;
 IF v_remaining<>0 THEN RAISE EXCEPTION 'La división no conserva la cantidad total del ingreso'; END IF;
 UPDATE public.wh_packages SET source_expected_total=v_total,source_expected_count=p_package_count,updated_at=now()
  WHERE source_movement_key=p_receipt_key AND site_id=v_site AND status<>'VOID';
 RETURN jsonb_build_object('package_codes',v_codes,'count',jsonb_array_length(v_codes));
END $function$;

CREATE OR REPLACE FUNCTION public.wh_count_label(p_campaign uuid, p_linea integer, p_quantity numeric, p_weight_kg numeric DEFAULT NULL::numeric, p_zone text DEFAULT NULL::text, p_ipt_doc text DEFAULT NULL::text, p_seq integer DEFAULT NULL::integer, p_total integer DEFAULT NULL::integer, p_confirm_over boolean DEFAULT false, p_client_event_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE c public.wh_count_campaigns; e public.wh_count_expected; v_round integer; v_event uuid := coalesce(p_client_event_id, gen_random_uuid());
  v_doc text := nullif(upper(btrim(p_ipt_doc)), ''); v_seq integer := p_seq; v_total integer := p_total; v_key text; v_code text;
  v_id uuid := gen_random_uuid(); v_line bigint; v_counted numeric; v_contract uuid;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_count_can_count() THEN RAISE EXCEPTION 'Sin permiso de inventario' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM public.wh_count_campaigns WHERE id = p_campaign FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(c.site_id) THEN RAISE EXCEPTION 'Campaña no disponible'; END IF;
  SELECT l.id, p.package_code INTO v_line, v_code FROM public.wh_count_lines l LEFT JOIN public.wh_packages p ON p.id = l.package_id
   WHERE l.campaign_id = c.id AND l.client_event_id = v_event;
  IF v_line IS NOT NULL THEN RETURN jsonb_build_object('line_id', v_line, 'package_code', v_code, 'duplicate_retry', true); END IF;
  SELECT * INTO e FROM public.wh_count_expected WHERE campaign_id = c.id AND linea = p_linea;
  IF NOT FOUND THEN RAISE EXCEPTION 'Línea del stock no encontrada en esta campaña'; END IF;
  IF coalesce(p_quantity, 0) <= 0 THEN RAISE EXCEPTION 'Registre la cantidad del rótulo'; END IF;
  IF p_weight_kg IS NOT NULL AND p_weight_kg < 0 THEN RAISE EXCEPTION 'Peso no válido'; END IF;
  v_round := public.wh_count_check(c, e.cod_producto, e.lote_key);
  PERFORM pg_advisory_xact_lock(hashtext('wh_count_identity:' || c.bodega || ':' || e.cod_producto));

  IF v_doc IS NOT NULL THEN
    IF v_seq IS NULL OR v_total IS NULL OR v_seq < 1 OR v_total < v_seq THEN RAISE EXCEPTION 'Registre el número de bulto del rótulo (n de total)'; END IF;
    -- Identidad física: el mismo bulto ya tiene etiqueta (por IPT o por inventario)
    SELECT package_code INTO v_code FROM public.wh_packages WHERE status <> 'VOID' AND source_document_no = v_doc
      AND source_product_code = e.cod_producto AND sequence_no = v_seq AND sequence_total = v_total LIMIT 1;
    IF v_code IS NOT NULL THEN RAISE EXCEPTION 'Ese bulto ya tiene etiqueta %: escanéela en lugar de etiquetar', v_code; END IF;
    v_key := 'IPT|' || v_doc || '|' || e.cod_producto || '|' || v_seq || '/' || v_total;
  ELSE
    -- Sin IPT en el rótulo: secuencia correlativa por bodega, lote y producto
    SELECT coalesce(max(sequence_no), 0) + 1 INTO v_seq FROM public.wh_packages
     WHERE source_kind = 'INVENTARIO' AND source_warehouse = c.bodega AND source_product_code = e.cod_producto
       AND public.wh_lote_key(source_lot) = e.lote_key AND source_document_no LIKE 'INV-%';
    v_total := v_seq;
    v_key := 'LOT|' || c.bodega || '|' || e.lote_key || '|' || e.cod_producto || '|' || v_seq;
  END IF;

  -- El saldo del lote es una alarma: superar el stock del ERP exige confirmación de supervisión
  SELECT coalesce(sum(quantity), 0) INTO v_counted FROM public.wh_count_lines
   WHERE campaign_id = c.id AND cod_producto = e.cod_producto AND lote_key = e.lote_key AND round = v_round AND voided_at IS NULL;
  IF v_counted + p_quantity > (SELECT coalesce(sum(stock), 0) FROM public.wh_count_expected WHERE campaign_id = c.id AND cod_producto = e.cod_producto AND lote_key = e.lote_key) THEN
    IF NOT p_confirm_over THEN RAISE EXCEPTION 'SUPERA_STOCK: lo contado del lote supera el stock del ERP; requiere confirmación de supervisión'; END IF;
    IF NOT public.wh_has_permission(ARRAY['almacen-supervisor','almacen-inventario']) THEN RAISE EXCEPTION 'Solo supervisión confirma un conteo que supera el stock del ERP' USING ERRCODE = '42501'; END IF;
  END IF;

  SELECT id INTO v_contract FROM public.contracts WHERE code = e.ot ORDER BY created_at LIMIT 1;
  v_code := public.wh_next_bulto_code(coalesce(e.lote_raw, e.lote));
  PERFORM set_config('wh.count_op', 'on', true);
  INSERT INTO public.wh_packages (id, package_code, source_document_no, source_contract_code, source_lot, source_product_code, source_unit, source_warehouse,
    source_date, source_movement_key, source_label_version, source_key, site_id, contract_id, description, quantity, unit, weight_kg, sequence_no, sequence_total,
    label_print_count, created_by, source_kind, count_campaign_id, count_hold, physical_key)
  VALUES (v_id, v_code, coalesce(v_doc, c.code), e.ot, coalesce(e.lote_raw, e.lote, ''), e.cod_producto, coalesce(e.unidad, ''), c.bodega,
    (now() AT TIME ZONE 'America/Lima')::date, 'INV:' || c.id || ':' || e.linea, 1, 'INV:' || v_id, c.site_id, v_contract, coalesce(e.producto, e.cod_producto),
    p_quantity, nullif(e.unidad, ''), p_weight_kg, v_seq, v_total, 1, auth.uid(), 'INVENTARIO', c.id, true, v_key);
  PERFORM set_config('wh.count_op', '', true);
  INSERT INTO public.wh_scan_events (site_id, package_id, event_type, scanned_code, payload, operator_id, client_event_id)
  VALUES (c.site_id, v_id, 'LABEL_PRINT', v_code, jsonb_build_object('print_count', 1, 'count_campaign', c.code), auth.uid(), gen_random_uuid());
  INSERT INTO public.wh_count_lines (campaign_id, round, package_id, origin, zone, cod_producto, lote_key, ot, quantity, weight_kg, counted_by, client_event_id)
  VALUES (c.id, v_round, v_id, 'ROTULO', nullif(btrim(p_zone), ''), e.cod_producto, e.lote_key, e.ot, p_quantity, p_weight_kg, auth.uid(), v_event)
  RETURNING id INTO v_line;
  RETURN jsonb_build_object('line_id', v_line, 'package_code', v_code, 'product', e.cod_producto, 'description', coalesce(e.producto, e.cod_producto),
    'lote', coalesce(e.lote_raw, e.lote), 'ot', e.ot, 'quantity', p_quantity, 'unit', e.unidad, 'weight_kg', p_weight_kg,
    'document', coalesce(v_doc, c.code), 'sequence_no', v_seq, 'sequence_total', v_total, 'bodega', c.bodega, 'round', v_round);
END $function$;

CREATE OR REPLACE FUNCTION public.wh_consolidate_lpn(p_task_id uuid, p_package_codes text[], p_client_event_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t public.wh_tasks%ROWTYPE; p public.wh_packages%ROWTYPE; v_codes text[]; v_code text; v_id uuid := gen_random_uuid();
  v_lpn text; v_qty numeric := 0; v_kg numeric := 0; v_n integer := 0; v_prev uuid; v_own boolean := false;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-picking','almacen-packing','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso de picking' USING ERRCODE = '42501'; END IF;
  SELECT * INTO t FROM public.wh_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
  IF p_client_event_id IS NOT NULL THEN
    SELECT lpn_id INTO v_prev FROM public.wh_scan_events WHERE site_id = t.site_id AND client_event_id = p_client_event_id AND event_type = 'LPN_CONSOLIDATE';
    IF v_prev IS NOT NULL THEN
      RETURN (SELECT jsonb_build_object('id', id, 'lpn_code', lpn_code, 'package_count', package_count, 'quantity', quantity, 'weight_kg', weight_kg, 'duplicate_retry', true) FROM public.wh_lpns WHERE id = v_prev);
    END IF;
  END IF;
  IF t.status NOT IN ('PICKING','PACKING') THEN RAISE EXCEPTION 'La tarea no está en preparación'; END IF;
  SELECT array_agg(DISTINCT trim(x)) INTO v_codes FROM unnest(p_package_codes) x WHERE nullif(trim(x), '') IS NOT NULL;
  IF coalesce(array_length(v_codes, 1), 0) = 0 THEN RAISE EXCEPTION 'Seleccione al menos un paquete'; END IF;
  -- Un LPN anulado que usaba la etiqueta de alguno de estos paquetes cede el código (el historial sigue por id).
  UPDATE public.wh_lpns SET lpn_code = lpn_code || '-ANULADO-' || upper(substr(replace(id::text, '-', ''), 1, 8))
   WHERE lpn_code = ANY(v_codes) AND status = 'VOID';
  IF array_length(v_codes, 1) = 1 THEN
    IF NOT EXISTS (SELECT 1 FROM public.wh_lpns WHERE lpn_code = v_codes[1]) THEN v_lpn := v_codes[1]; v_own := true; END IF;
  END IF;
  -- Agrupar dos o más paquetes crea un bulto físico nuevo: el siguiente número de la serie de su lote
  -- (con lotes mezclados, el lote con más paquetes; empate: el menor).
  IF NOT v_own THEN
    v_lpn := public.wh_next_bulto_code((SELECT source_lot FROM public.wh_packages WHERE site_id = t.site_id AND package_code = ANY(v_codes)
      GROUP BY source_lot ORDER BY count(*) DESC, source_lot LIMIT 1));
  END IF;
  INSERT INTO public.wh_lpns(id, lpn_code, site_id, task_id, status, created_by, closed_by, closed_at, print_count)
  VALUES (v_id, v_lpn, t.site_id, t.id, 'CLOSED', auth.uid(), auth.uid(), now(), CASE WHEN v_own THEN 1 ELSE 0 END);
  FOREACH v_code IN ARRAY v_codes LOOP
    SELECT * INTO p FROM public.wh_packages WHERE package_code = v_code AND site_id = t.site_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'El paquete % no existe en este almacén', v_code; END IF;
    IF p.task_id IS DISTINCT FROM t.id THEN RAISE EXCEPTION 'El paquete % no fue recogido para esta tarea', v_code; END IF;
    IF p.lpn_id IS NOT NULL THEN RAISE EXCEPTION 'El paquete % ya está en el LPN %', v_code, (SELECT lpn_code FROM public.wh_lpns WHERE id = p.lpn_id); END IF;
    IF p.status <> 'PICKED' THEN RAISE EXCEPTION 'El paquete % no está recogido (estado %)', v_code, p.status; END IF;
    UPDATE public.wh_packages SET status = 'PACKED', lpn_id = v_id WHERE id = p.id;
    IF p.task_line_id IS NOT NULL THEN UPDATE public.wh_task_lines SET packed_qty = packed_qty + p.quantity WHERE id = p.task_line_id; END IF;
    INSERT INTO public.wh_scan_events(site_id, task_id, package_id, lpn_id, event_type, scanned_code, operator_id, client_event_id)
    VALUES (t.site_id, t.id, p.id, v_id, CASE WHEN v_n = 0 THEN 'LPN_CONSOLIDATE' ELSE 'LPN_ADD' END, v_code, auth.uid(),
            CASE WHEN v_n = 0 THEN coalesce(p_client_event_id, gen_random_uuid()) ELSE gen_random_uuid() END);
    v_qty := v_qty + p.quantity; v_kg := v_kg + coalesce(p.weight_kg, 0); v_n := v_n + 1;
  END LOOP;
  UPDATE public.wh_lpns SET package_count = v_n, quantity = v_qty, weight_kg = v_kg WHERE id = v_id;
  PERFORM public.wh_invalidate_release(t.id, 'Nuevo LPN ' || v_lpn);
  RETURN jsonb_build_object('id', v_id, 'lpn_code', v_lpn, 'package_count', v_n, 'quantity', v_qty, 'weight_kg', v_kg, 'own_label', v_own);
END $function$;

REVOKE ALL ON FUNCTION public.wh_create_lpn(uuid), public.wh_add_package_to_lpn(uuid, text), public.wh_close_lpn(uuid) FROM PUBLIC, anon, authenticated;
