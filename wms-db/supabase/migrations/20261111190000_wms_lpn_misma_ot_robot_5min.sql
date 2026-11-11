-- 1) LPN de recepción: «misma OT» compara el número de OT (16571), no el código completo de la línea del contrato
--    (16571-S002-022, -024…): cada ítem de un IPT trae su propio sufijo y no se podía marcar más de una línea.
-- 2) Robot de ingresos WMS cada 5 minutos (antes 30). La tarea de la PC ya consulta cada minuto; la base decide cuándo toca.
CREATE OR REPLACE FUNCTION public.wh_receipt_consolidate_lpn(p_receipt_keys text[], p_client_event_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_site uuid := public.primary_site_id(); v_keys text[]; v_key text; v_prev uuid; v_lpn_id uuid := gen_random_uuid(); v_lpn text;
  r record; v_val record; v_version integer; v_pkg uuid; v_code text; v_codes text[] := '{}'; v_ot text;
  v_qty numeric := 0; v_kg numeric := 0; v_has_kg boolean := false; v_n integer := 0; v_kg_line numeric;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para consolidar la recepción APT' USING ERRCODE = '42501'; END IF;
  IF v_site IS NULL OR NOT public.can_access_site(v_site) THEN RAISE EXCEPTION 'No hay sede operativa asignada'; END IF;
  IF p_client_event_id IS NOT NULL THEN
    SELECT lpn_id INTO v_prev FROM public.wh_scan_events WHERE site_id = v_site AND client_event_id = p_client_event_id AND event_type = 'RECEIPT_LPN_CONSOLIDATE';
    IF v_prev IS NOT NULL THEN
      RETURN public.wh_lpn_detail((SELECT lpn_code FROM public.wh_lpns WHERE id = v_prev)) || jsonb_build_object('duplicate_retry', true);
    END IF;
  END IF;
  -- Orden de selección sin duplicados: la primera línea define el lote del número del LPN.
  SELECT array_agg(k ORDER BY n) INTO v_keys
    FROM (SELECT trim(u.k) AS k, min(u.n) AS n FROM unnest(p_receipt_keys) WITH ORDINALITY AS u(k, n) WHERE nullif(trim(u.k), '') IS NOT NULL GROUP BY trim(u.k)) x;
  IF coalesce(cardinality(v_keys), 0) NOT BETWEEN 2 AND 100 THEN RAISE EXCEPTION 'Seleccione entre 2 y 100 líneas validadas para consolidar en un LPN'; END IF;
  -- Mismo bloqueo por ingreso que validar y etiquetar, en orden fijo para no interbloquear consolidaciones simultáneas.
  FOREACH v_key IN ARRAY (SELECT array_agg(k ORDER BY k) FROM unnest(v_keys) k) LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));
  END LOOP;
  FOREACH v_key IN ARRAY v_keys LOOP
    SELECT s.source_key, s.document_no, s.source_date AS fecha, s.lot AS lote, s.product_code, s.description, s.unit, s.warehouse AS bodega,
      coalesce(nullif(s.contract_code,''), nullif(s.origin_number,''), s.lot) AS contract_code, c.id AS contract_id, s.quantity, s.total_weight AS weight_kg
    INTO r FROM public.wh_receipt_sources s LEFT JOIN public.contracts c
      ON regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(coalesce(nullif(s.contract_code,''),nullif(s.origin_number,''),s.lot)),'[^A-Z0-9]','','g'),'^OT','')
     WHERE s.source_key = v_key AND s.active;
    IF NOT FOUND OR r.quantity <= 0 THEN RAISE EXCEPTION 'El ingreso % no existe o ya no está activo; actualice la fuente WMS', v_key; END IF;
    SELECT * INTO v_val FROM public.wh_receipt_validations WHERE source_movement_key = v_key ORDER BY validated_at DESC, id DESC LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'La línea % del IPT % no está validada: confirme su cantidad física antes de consolidar', r.product_code, r.document_no; END IF;
    IF v_val.erp_quantity <> r.quantity THEN RAISE EXCEPTION 'El IPT % cambió en el actualizable APT; valide de nuevo la línea % antes de consolidar', r.document_no, r.product_code; END IF;
    IF v_val.physical_quantity <= 0 THEN RAISE EXCEPTION 'La línea % del IPT % tiene conteo físico cero; no hay nada que consolidar', r.product_code, r.document_no; END IF;
    IF EXISTS (SELECT 1 FROM public.wh_packages WHERE source_movement_key = v_key AND status <> 'VOID') THEN
      RAISE EXCEPTION 'La línea % del IPT % ya tiene etiquetas o LPN; solo se consolidan líneas validadas sin etiquetar', r.product_code, r.document_no;
    END IF;
    IF EXISTS (SELECT 1 FROM public.wh_packages WHERE source_movement_key = v_key AND status = 'VOID') AND NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN
      RAISE EXCEPTION 'Solo supervisión puede volver a etiquetar la línea % con etiquetas anuladas', r.product_code;
    END IF;
    IF v_ot IS NULL THEN
      v_ot := coalesce(substring(upper(coalesce(r.contract_code, '')) FROM '([0-9]{5,6})'), regexp_replace(upper(coalesce(r.contract_code, '')),'[^A-Z0-9]','','g'));
      v_lpn := public.wh_next_bulto_code(r.lote);
      -- Un LPN anulado que ocupaba este código lo cede (el historial sigue por id), como en el picking.
      UPDATE public.wh_lpns SET lpn_code = lpn_code || '-ANULADO-' || upper(substr(replace(id::text, '-', ''), 1, 8)) WHERE lpn_code = v_lpn AND status = 'VOID';
      INSERT INTO public.wh_lpns(id, lpn_code, site_id, task_id, status, origin, created_by, closed_by, closed_at, print_count)
      VALUES (v_lpn_id, v_lpn, v_site, NULL, 'CLOSED', 'RECEPCION', auth.uid(), auth.uid(), now(), 0);
    ELSIF coalesce(substring(upper(coalesce(r.contract_code, '')) FROM '([0-9]{5,6})'), regexp_replace(upper(coalesce(r.contract_code, '')),'[^A-Z0-9]','','g')) IS DISTINCT FROM v_ot THEN
      RAISE EXCEPTION 'Solo se consolidan líneas de la misma OT: la línea % (OT/contrato %) es de otra OT', r.product_code, coalesce(r.contract_code, '—');
    END IF;
    SELECT coalesce(max(source_label_version), 0) + 1 INTO v_version FROM public.wh_packages WHERE source_movement_key = v_key;
    v_pkg := gen_random_uuid(); v_code := public.wh_next_bulto_code(r.lote);
    v_kg_line := CASE WHEN r.weight_kg IS NOT NULL THEN round(r.weight_kg * v_val.physical_quantity / r.quantity, 3) END;
    INSERT INTO public.wh_packages(id,package_code,source_document_no,source_contract_code,source_lot,source_product_code,source_unit,source_warehouse,source_date,source_movement_key,source_label_version,source_key,site_id,contract_id,description,quantity,unit,weight_kg,sequence_no,sequence_total,source_qty_snapshot,source_expected_total,source_expected_count,created_by,lpn_id)
    VALUES (v_pkg, v_code, r.document_no, r.contract_code, coalesce(r.lote,''), r.product_code, coalesce(r.unit,''), r.bodega, r.fecha, v_key, v_version,
      v_key || ':' || v_version::text || ':1', v_site, r.contract_id, coalesce(r.description, r.product_code), v_val.physical_quantity, nullif(r.unit,''), v_kg_line,
      1, 1, v_val.physical_quantity, v_val.physical_quantity, 1, auth.uid(), v_lpn_id);
    INSERT INTO public.wh_scan_events(site_id, package_id, lpn_id, event_type, scanned_code, payload, operator_id, client_event_id)
    VALUES (v_site, v_pkg, v_lpn_id, 'RECEIPT_LPN_ADD', v_code, jsonb_build_object('receipt_key', v_key, 'lpn_code', v_lpn), auth.uid(), gen_random_uuid());
    v_codes := v_codes || v_code; v_qty := v_qty + v_val.physical_quantity; v_kg := v_kg + coalesce(v_kg_line, 0); v_n := v_n + 1;
  END LOOP;
  -- Mismo cliente: el mismo cálculo que la etiqueta (Excel, OT/lote o nombre manual de la validación).
  IF (SELECT count(DISTINCT upper(btrim(c.customer_name))) FROM public.wh_receipt_control_customers(v_keys) c) > 1 THEN
    RAISE EXCEPTION 'Solo se consolidan líneas del mismo cliente';
  END IF;
  UPDATE public.wh_lpns SET package_count = v_n, quantity = v_qty, weight_kg = v_kg WHERE id = v_lpn_id;
  INSERT INTO public.wh_scan_events(site_id, lpn_id, event_type, scanned_code, payload, operator_id, client_event_id)
  VALUES (v_site, v_lpn_id, 'RECEIPT_LPN_CONSOLIDATE', v_lpn,
    jsonb_build_object('receipt_keys', v_keys, 'package_codes', v_codes, 'quantity', v_qty, 'weight_kg', v_kg), auth.uid(), coalesce(p_client_event_id, gen_random_uuid()));
  RETURN public.wh_lpn_detail(v_lpn);
END $function$;


CREATE OR REPLACE FUNCTION public.wh_receipt_robot_due()
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT NOT EXISTS (SELECT 1 FROM public.wh_receipt_robot_runs WHERE status='RUNNING' AND started_at>now()-interval '30 minutes')
  AND (EXISTS (SELECT 1 FROM public.wh_receipt_robot_runs WHERE status='PENDING')
   OR NOT EXISTS (SELECT 1 FROM public.wh_receipt_robot_runs WHERE kind='AUTO' AND started_at>now()-interval '4 minutes 30 seconds'));
$function$;
