-- LPN de recepción: varias líneas validadas (mismo cliente y misma OT/contrato; producto y lote pueden variar) se
-- consolidan en UN bulto físico (pallet) con una sola etiqueta, la del LPN, más su hoja de contenido.
--  · Cada línea conserva su fila en wh_packages (stock y trazabilidad por línea) con lpn_id = el LPN.
--  · Numeración: la misma serie por lote (wh_next_bulto_code). El LPN toma el siguiente número del lote de la primera
--    línea elegida; luego cada línea recibe el suyo (queda sin imprimir mientras siga en el LPN).
--  · label_print_count de esas líneas sigue en 0: significa "su etiqueta individual nunca se imprimió". Si el LPN se
--    deshace o anula, las líneas vuelven a la bandeja de recepción para imprimir sus etiquetas individuales.
--  · Picking: el LPN de recepción se recoge entero leyendo su etiqueta; sus paquetes no se toman sueltos. Para
--    separarlo se deshace el LPN (wh_lpn_undo, con motivo).
-- Las funciones reemplazadas se toman de la definición vigente en producción; solo se agregan las reglas del LPN.

ALTER TABLE public.wh_lpns ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'PICKING';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wh_lpns_origin_check' AND conrelid = 'public.wh_lpns'::regclass) THEN
    ALTER TABLE public.wh_lpns ADD CONSTRAINT wh_lpns_origin_check CHECK (origin IN ('PICKING', 'RECEPCION'));
  END IF;
END $$;

-- Detalle de un LPN por su código o por el de uno de sus paquetes (recepción, detalle de paquete, reimpresión).
CREATE OR REPLACE FUNCTION public.wh_lpn_detail(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE l public.wh_lpns%ROWTYPE;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT (public.wh_any_warehouse_permission() OR public.wh_has_permission(ARRAY['almacen-etiquetado'])) THEN
    RAISE EXCEPTION 'Sin permiso para consultar LPN' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO l FROM public.wh_lpns WHERE lpn_code = trim(p_code);
  IF NOT FOUND THEN
    SELECT x.* INTO l FROM public.wh_packages p JOIN public.wh_lpns x ON x.id = p.lpn_id WHERE p.package_code = trim(p_code);
  END IF;
  IF l.id IS NULL OR NOT public.can_access_site(l.site_id) THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('id', l.id, 'lpn_code', l.lpn_code, 'origin', l.origin, 'status', l.status, 'task_id', l.task_id,
    'print_count', l.print_count, 'package_count', l.package_count, 'quantity', l.quantity, 'weight_kg', l.weight_kg,
    'void_reason', l.void_reason, 'created_at', l.created_at, 'created_by_name', public.wh_profile_name(l.created_by),
    'packages', coalesce((SELECT jsonb_agg(jsonb_build_object('package_code', p.package_code, 'receipt_key', p.source_movement_key,
        'document', p.source_document_no, 'contract_code', p.source_contract_code, 'product_code', p.source_product_code,
        'description', p.description, 'lot', nullif(p.source_lot, ''), 'quantity', p.quantity, 'unit', p.unit, 'weight_kg', p.weight_kg,
        'warehouse', p.source_warehouse, 'date', p.source_date, 'status', p.status)
        ORDER BY p.source_document_no, p.source_product_code, p.source_lot, p.package_code)
      FROM public.wh_packages p WHERE p.lpn_id = l.id), '[]'::jsonb));
END $function$;

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
      v_ot := regexp_replace(regexp_replace(upper(coalesce(r.contract_code, '')),'[^A-Z0-9]','','g'),'^OT','');
      v_lpn := public.wh_next_bulto_code(r.lote);
      -- Un LPN anulado que ocupaba este código lo cede (el historial sigue por id), como en el picking.
      UPDATE public.wh_lpns SET lpn_code = lpn_code || '-ANULADO-' || upper(substr(replace(id::text, '-', ''), 1, 8)) WHERE lpn_code = v_lpn AND status = 'VOID';
      INSERT INTO public.wh_lpns(id, lpn_code, site_id, task_id, status, origin, created_by, closed_by, closed_at, print_count)
      VALUES (v_lpn_id, v_lpn, v_site, NULL, 'CLOSED', 'RECEPCION', auth.uid(), auth.uid(), now(), 0);
    ELSIF regexp_replace(regexp_replace(upper(coalesce(r.contract_code, '')),'[^A-Z0-9]','','g'),'^OT','') IS DISTINCT FROM v_ot THEN
      RAISE EXCEPTION 'Solo se consolidan líneas de la misma OT/contrato: la línea % (OT %) es de otra OT', r.product_code, coalesce(r.contract_code, '—');
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

REVOKE ALL ON FUNCTION public.wh_lpn_detail(text), public.wh_receipt_consolidate_lpn(text[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_lpn_detail(text), public.wh_receipt_consolidate_lpn(text[], uuid) TO authenticated;

-- Imprimir / reimprimir la etiqueta del LPN: en recepción también etiquetado.
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
  IF NOT public.wh_has_permission(CASE WHEN l.origin = 'RECEPCION' THEN ARRAY['almacen-etiquetado','almacen-picking','almacen-packing','almacen-supervisor']
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
 IF NOT public.wh_has_permission(CASE WHEN l.origin='RECEPCION' THEN ARRAY['almacen-etiquetado','almacen-packing','almacen-supervisor'] ELSE ARRAY['almacen-packing','almacen-supervisor'] END)
    OR nullif(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Reimpresión de LPN requiere permiso y motivo' USING ERRCODE='42501'; END IF;
 IF NOT FOUND OR NOT public.can_access_site(l.site_id) OR l.status IN ('VOID','OPEN') THEN RAISE EXCEPTION 'LPN no disponible para reimpresión'; END IF;
 UPDATE public.wh_lpns SET print_count=print_count+1 WHERE id=l.id;
 INSERT INTO public.wh_scan_events(site_id,task_id,lpn_id,event_type,scanned_code,payload,operator_id,client_event_id)
 VALUES(l.site_id,l.task_id,l.id,'LPN_REPRINT',l.lpn_code,jsonb_build_object('reason',trim(p_reason),'previous_print_count',l.print_count),auth.uid(),gen_random_uuid());
 RETURN jsonb_build_object('lpn_code',l.lpn_code,'print_count',l.print_count+1);
END $function$;

-- Deshacer: un LPN de recepción que aún no está en una tarea suelta sus líneas en stock (vuelven a la bandeja para
-- imprimir sus etiquetas individuales). En una tarea sigue el flujo del picking.
CREATE OR REPLACE FUNCTION public.wh_lpn_undo(p_lpn_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_code text; v_n integer := 0; l public.wh_lpns%ROWTYPE; v_codes text[];
BEGIN
  SELECT * INTO l FROM public.wh_lpns WHERE id = p_lpn_id;
  IF FOUND AND l.origin = 'RECEPCION' AND l.task_id IS NULL THEN
    PERFORM public.security_assert_active_session();
    IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para deshacer el LPN de recepción' USING ERRCODE = '42501'; END IF;
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

-- Quitar paquetes sueltos solo dentro de una tarea: el LPN de recepción sin tarea se deshace entero.
CREATE OR REPLACE FUNCTION public.wh_lpn_remove_package(p_lpn_id uuid, p_package_code text, p_release boolean, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE l public.wh_lpns%ROWTYPE; t public.wh_tasks%ROWTYPE; p public.wh_packages%ROWTYPE; v_left integer;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-picking','almacen-packing','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso de picking' USING ERRCODE = '42501'; END IF;
  IF nullif(trim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'Registre el motivo'; END IF;
  PERFORM 1 FROM public.wh_tasks WHERE id = (SELECT task_id FROM public.wh_lpns WHERE id = p_lpn_id) FOR UPDATE; -- mismo orden de bloqueo que la liberación
  SELECT * INTO l FROM public.wh_lpns WHERE id = p_lpn_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(l.site_id) THEN RAISE EXCEPTION 'LPN no disponible'; END IF;
  IF l.task_id IS NULL THEN RAISE EXCEPTION 'El LPN % no está en una tarea: deshágalo completo con motivo', l.lpn_code; END IF;
  SELECT * INTO t FROM public.wh_tasks WHERE id = l.task_id FOR UPDATE;
  IF l.status NOT IN ('OPEN','CLOSED') OR t.status NOT IN ('PICKING','PACKING','READY_FOR_LOAD') THEN RAISE EXCEPTION 'El LPN ya no se puede modificar'; END IF;
  IF l.audit_status = 'APROBADO' AND NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN
    RAISE EXCEPTION 'El LPN ya fue aprobado: solo supervisión puede modificarlo';
  END IF;
  SELECT * INTO p FROM public.wh_packages WHERE package_code = trim(p_package_code) AND lpn_id = l.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El paquete no pertenece a este LPN'; END IF;
  UPDATE public.wh_packages SET lpn_id = NULL,
    status = CASE WHEN p_release THEN 'AVAILABLE' ELSE 'PICKED' END,
    task_id = CASE WHEN p_release THEN NULL ELSE task_id END,
    task_line_id = CASE WHEN p_release THEN NULL ELSE task_line_id END
   WHERE id = p.id;
  IF p.task_line_id IS NOT NULL THEN
    UPDATE public.wh_task_lines SET packed_qty = greatest(packed_qty - p.quantity, 0),
      picked_qty = CASE WHEN p_release THEN greatest(picked_qty - p.quantity, 0) ELSE picked_qty END
     WHERE id = p.task_line_id;
  END IF;
  UPDATE public.wh_lpns SET package_count = package_count - 1, quantity = quantity - p.quantity, weight_kg = weight_kg - coalesce(p.weight_kg, 0),
    audit_status = 'PENDIENTE', audit_rev = audit_rev + 1, audited_by = NULL, audited_at = NULL,
    status = CASE WHEN package_count - 1 = 0 THEN 'VOID' ELSE status END,
    void_reason = CASE WHEN package_count - 1 = 0 THEN trim(p_reason) ELSE void_reason END
   WHERE id = l.id RETURNING package_count INTO v_left;
  IF l.audit_status <> 'PENDIENTE' THEN
    INSERT INTO public.wh_lpn_audits(lpn_id, task_id, site_id, audit_rev, result, package_code, comment, actor_id)
    VALUES (l.id, l.task_id, l.site_id, l.audit_rev + 1, 'REINICIADO', p.package_code, 'Composición modificada: ' || trim(p_reason), auth.uid());
  END IF;
  INSERT INTO public.wh_scan_events(site_id, task_id, package_id, lpn_id, event_type, scanned_code, payload, operator_id, client_event_id)
  VALUES (l.site_id, l.task_id, p.id, l.id, 'LPN_REMOVE', p.package_code,
          jsonb_build_object('reason', trim(p_reason), 'released_to_stock', p_release, 'previous_audit', l.audit_status), auth.uid(), gen_random_uuid());
  IF t.status = 'READY_FOR_LOAD' THEN UPDATE public.wh_tasks SET status = 'PICKING', updated_by = auth.uid() WHERE id = t.id; END IF;
  PERFORM public.wh_invalidate_release(t.id, 'Cambio en ' || l.lpn_code || ': ' || trim(p_reason));
  RETURN jsonb_build_object('success', true, 'lpn_code', l.lpn_code, 'remaining', v_left);
END $function$;

-- Picking: leer la etiqueta del LPN de recepción lo recoge entero (queda empacado y cerrado en la tarea). Un paquete
-- suyo leído suelto se rechaza.
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
    SELECT * INTO l FROM public.wh_lpns WHERE lpn_code = trim(p_code) AND origin = 'RECEPCION' FOR UPDATE;
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
     WHERE p.package_code = trim(p_code) AND x.origin = 'RECEPCION' AND x.task_id IS NULL AND x.status <> 'VOID';
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

-- Etiquetas individuales: una línea dentro de un LPN de recepción vigente solo se identifica con la etiqueta del LPN.
CREATE OR REPLACE FUNCTION public.wh_print_labels(p_package_codes text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_site uuid:=public.primary_site_id(); v_code text; v_count integer:=0; p public.wh_packages%ROWTYPE; v_lpn text;
BEGIN
 PERFORM public.security_assert_active_session(); IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para imprimir etiquetas' USING ERRCODE='42501'; END IF;
 IF coalesce(cardinality(p_package_codes),0) NOT BETWEEN 1 AND 100 OR v_site IS NULL OR NOT public.can_access_site(v_site) THEN RAISE EXCEPTION 'Lote de etiquetas inválido'; END IF;
 IF cardinality(ARRAY(SELECT DISTINCT trim(code) FROM unnest(p_package_codes) AS u(code)))<>cardinality(p_package_codes) THEN RAISE EXCEPTION 'El lote contiene códigos duplicados'; END IF;
 FOREACH v_code IN ARRAY p_package_codes LOOP
  SELECT * INTO p FROM public.wh_packages WHERE package_code=trim(v_code) AND site_id=v_site FOR UPDATE;
  IF NOT FOUND OR p.status='VOID' THEN RAISE EXCEPTION 'Etiqueta no disponible: %',v_code; END IF;
  SELECT lpn_code INTO v_lpn FROM public.wh_lpns WHERE id=p.lpn_id AND origin='RECEPCION' AND status<>'VOID';
  IF v_lpn IS NOT NULL THEN RAISE EXCEPTION 'El bulto % está consolidado en el LPN %: imprima la etiqueta del LPN',p.package_code,v_lpn; END IF;
  UPDATE public.wh_packages SET label_print_count=label_print_count+1 WHERE id=p.id;
  INSERT INTO public.wh_scan_events(site_id,task_id,package_id,event_type,scanned_code,payload,operator_id,client_event_id)
   VALUES(p.site_id,p.task_id,p.id,'LABEL_PRINT',p.package_code,jsonb_build_object('print_count',p.label_print_count+1),auth.uid(),gen_random_uuid());
  v_count:=v_count+1;
 END LOOP;
 RETURN jsonb_build_object('printed',v_count);
END $function$;

CREATE OR REPLACE FUNCTION public.wh_reprint_label(p_package_code text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE p public.wh_packages%ROWTYPE; v_lpn text;
BEGIN
 PERFORM public.security_assert_active_session(); IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) OR nullif(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Reimpresión requiere permiso y motivo'; END IF;
 SELECT * INTO p FROM public.wh_packages WHERE package_code=trim(p_package_code) FOR UPDATE;
 IF NOT FOUND OR NOT public.can_access_site(p.site_id) OR p.status='VOID' THEN RAISE EXCEPTION 'Etiqueta no disponible'; END IF;
 SELECT lpn_code INTO v_lpn FROM public.wh_lpns WHERE id=p.lpn_id AND origin='RECEPCION' AND status<>'VOID';
 IF v_lpn IS NOT NULL THEN RAISE EXCEPTION 'El bulto % está consolidado en el LPN %: reimprima la etiqueta del LPN',p.package_code,v_lpn; END IF;
 UPDATE public.wh_packages SET label_print_count=label_print_count+1 WHERE id=p.id;
 INSERT INTO public.wh_scan_events(site_id,task_id,package_id,event_type,scanned_code,payload,operator_id,client_event_id)
  VALUES(p.site_id,p.task_id,p.id,'LABEL_REPRINT',p.package_code,jsonb_build_object('reason',trim(p_reason),'previous_print_count',p.label_print_count),auth.uid(),gen_random_uuid());
 RETURN jsonb_build_object('package_code',p.package_code,'print_count',p.label_print_count+1);
END $function$;

-- Generar bultos individuales de una línea que está en un LPN de recepción vigente mezclaría ambos esquemas.
CREATE OR REPLACE FUNCTION public.wh_label_package(p_receipt_key text, p_package_count integer, p_units_per_package numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_site uuid:=public.primary_site_id(); v_i int; v_key text; v_id uuid; v_codes jsonb:='[]'::jsonb; v_code text;
 v_total numeric; v_qty numeric; v_remaining numeric; v_weight numeric; v_receipt record; v_validation record; v_version integer; v_lpn text;
BEGIN
 PERFORM public.security_assert_active_session(); IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso de etiquetado' USING ERRCODE='42501'; END IF;
 IF v_site IS NULL OR NOT public.can_access_site(v_site) OR p_package_count NOT BETWEEN 1 AND 100 OR nullif(trim(p_receipt_key),'') IS NULL OR
    (p_units_per_package IS NOT NULL AND p_units_per_package<=0) THEN RAISE EXCEPTION 'Datos de etiqueta inválidos'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_receipt_key,0));
 SELECT x.lpn_code INTO v_lpn FROM public.wh_packages p JOIN public.wh_lpns x ON x.id=p.lpn_id
  WHERE p.source_movement_key=p_receipt_key AND p.status<>'VOID' AND x.origin='RECEPCION' AND x.status<>'VOID' LIMIT 1;
 IF v_lpn IS NOT NULL THEN RAISE EXCEPTION 'La línea está consolidada en el LPN %; deshaga el LPN para generar bultos individuales',v_lpn; END IF;
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

-- Anular un paquete de un LPN de recepción que sigue en stock también suelta a los demás (antes solo los empacados).
CREATE OR REPLACE FUNCTION public.wh_void_package(p_package_code text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE p public.wh_packages%ROWTYPE;
BEGIN
 PERFORM public.security_assert_active_session(); IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) OR nullif(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Anulación requiere supervisión y motivo'; END IF;
 SELECT * INTO p FROM public.wh_packages WHERE package_code=trim(p_package_code) FOR UPDATE;
 IF NOT FOUND OR NOT public.can_access_site(p.site_id) OR p.status IN ('LOADED','VOID') THEN RAISE EXCEPTION 'Paquete no se puede anular'; END IF;
 IF p.task_line_id IS NOT NULL AND p.task_id IS NOT NULL THEN
  UPDATE public.wh_task_lines SET
   picked_qty=greatest(0,picked_qty-CASE WHEN p.status IN ('PICKED','PACKED') THEN p.quantity ELSE 0 END),
   packed_qty=greatest(0,packed_qty-CASE WHEN p.status='PACKED' THEN p.quantity ELSE 0 END)
   WHERE id=p.task_line_id AND task_id=p.task_id;
 END IF;
 IF p.lpn_id IS NOT NULL THEN
  UPDATE public.wh_packages SET lpn_id=NULL WHERE lpn_id=p.lpn_id AND id<>p.id AND status IN ('PACKED','AVAILABLE','RESERVED');
  UPDATE public.wh_lpns SET status='VOID',void_reason=trim(p_reason),package_count=0,quantity=0,weight_kg=0 WHERE id=p.lpn_id AND status IN ('OPEN','CLOSED');
 END IF;
 UPDATE public.wh_packages SET status='VOID',void_reason=trim(p_reason),lpn_id=NULL WHERE id=p.id;
 INSERT INTO public.wh_scan_events(site_id,task_id,package_id,event_type,scanned_code,payload,operator_id,client_event_id)
  VALUES(p.site_id,p.task_id,p.id,'PACKAGE_VOID',p.package_code,jsonb_build_object('reason',trim(p_reason)),auth.uid(),gen_random_uuid());
 RETURN jsonb_build_object('package_code',p.package_code,'status','VOID');
END $function$;

-- Bandeja de recepción: una línea dentro de un LPN de recepción cuenta como impresa cuando se imprimió el LPN; sus
-- pendientes informan el código del LPN para que la pantalla imprima la etiqueta del LPN y no la individual.
CREATE OR REPLACE FUNCTION public.wh_receipt_candidates_all(p_query text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE q text:=trim(coalesce(p_query,'')); result jsonb; missing_source_columns text[];
BEGIN
 PERFORM public.security_assert_active_session();
 SELECT array_agg(required.column_name ORDER BY required.column_name)
 INTO missing_source_columns
 FROM unnest(ARRAY['source_key','document_no','source_date','product_code','quantity']) AS required(column_name)
 WHERE NOT EXISTS (
   SELECT 1 FROM information_schema.columns c
   WHERE c.table_schema='public' AND c.table_name='wh_receipt_sources' AND c.column_name=required.column_name
 );
 IF cardinality(missing_source_columns)>0 THEN
   RAISE EXCEPTION 'Faltan columnas requeridas en wh_receipt_sources: %',array_to_string(missing_source_columns,', ');
 END IF;
 IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) THEN
  RAISE EXCEPTION 'Sin permiso para consultar recepciones APT' USING ERRCODE='42501';
 END IF;
 IF length(q)>0 AND length(q)<2 THEN RAISE EXCEPTION 'Ingrese dos o más caracteres para buscar'; END IF;

 WITH RECURSIVE r AS MATERIALIZED (
   SELECT src.j->>'source_key' AS receipt_key,
    src.j->>'document_no' AS document_no,
    nullif(src.j->>'source_date','')::date AS fecha,
    src.j->>'document_type' AS document_type,
    src.j->>'color' AS color,
    nullif(src.j->>'source_updated_at','')::timestamptz AS source_updated_at,
    src.j->>'lot' AS lote,
    src.j->>'product_code' AS product_code,
    src.j->>'description' AS description,
    src.j->>'unit' AS unit,
    src.j->>'warehouse' AS bodega,
    coalesce(nullif(src.j->>'contract_code',''),nullif(src.j->>'origin_number',''),src.j->>'lot') AS contract_code,
    src.j->>'customer_name' AS customer_name,
    nullif(src.j->>'quantity','')::numeric AS quantity,
    nullif(src.j->>'total_weight','')::numeric AS weight_kg
   FROM public.wh_receipt_sources s
   CROSS JOIN LATERAL (SELECT to_jsonb(s) AS j) src
   WHERE coalesce(nullif(src.j->>'active','')::boolean,true)
 ),
 -- Sin búsqueda solo se muestran ingresos sin bultos o con bultos sin imprimir: el cliente solo se resuelve para ellos.
 keys AS MATERIALIZED (
   SELECT DISTINCT r.contract_code,r.lote FROM r
   WHERE q<>''
    OR NOT EXISTS (SELECT 1 FROM public.wh_packages wp WHERE wp.source_movement_key=r.receipt_key AND wp.status<>'VOID')
    OR EXISTS (SELECT 1 FROM public.wh_packages wp WHERE wp.source_movement_key=r.receipt_key AND wp.status<>'VOID' AND wp.label_print_count=0)
 ),
 ot_customers AS MATERIALIZED (
   SELECT raiz,nullif(public.inv_ot_cliente(raiz),'') AS customer_name
   FROM (SELECT nullif(public.apt_ot_raiz(k.lote),'') AS raiz FROM keys k
         UNION SELECT nullif(public.inv_ot(k.contract_code),'') FROM keys k) t
   WHERE raiz IS NOT NULL
 ),
 -- Códigos de contrato y criterios del ingreso normalizados una sola vez (antes: expresiones regulares por contrato y
 -- por ingreso). Las comparaciones son las mismas.
 cn AS MATERIALIZED (
  SELECT c.id,c.client_id,c.parent_contract_id,
   regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','') AS norm,
   public.apt_ot_raiz(c.code::text) AS raiz
  FROM public.contracts c
 ),
 kn AS MATERIALIZED (
  SELECT k.contract_code,k.lote,
   regexp_replace(regexp_replace(upper(k.contract_code),'[^A-Z0-9]','','g'),'^OT','') AS n1,
   regexp_replace(regexp_replace(upper(k.lote),'[^A-Z0-9]','','g'),'^OT','') AS n2,
   regexp_replace(regexp_replace(upper(public.inv_ot(k.contract_code)),'[^A-Z0-9]','','g'),'^OT','') AS n3,
   regexp_replace(regexp_replace(upper(public.inv_ot(k.lote)),'[^A-Z0-9]','','g'),'^OT','') AS n4,
   regexp_replace(regexp_replace(upper(public.apt_ot_raiz(k.lote)),'[^A-Z0-9]','','g'),'^OT','') AS n5,
   coalesce(nullif(public.apt_ot_raiz(k.lote),''),nullif(public.inv_ot(k.lote),''),nullif(public.apt_ot_raiz(k.contract_code),''),nullif(public.inv_ot(k.contract_code),'')) AS raiz
  FROM keys k
 ),
 -- Cruce con contratos (y sus contratos padre) para todas las combinaciones a la vez; por combinación gana el mismo
 -- contrato que antes: menor prioridad de coincidencia, menor profundidad, menor id, con cliente con nombre.
 matches AS MATERIALIZED (
  SELECT k.contract_code,k.lote,c.id,c.client_id,c.parent_contract_id,
   CASE WHEN c.norm=k.n1 THEN 1 WHEN c.norm=k.n2 THEN 2 WHEN c.norm=k.n3 THEN 3 WHEN c.norm=k.n4 THEN 4 WHEN c.norm=k.n5 THEN 5 ELSE 6 END AS match_priority
  FROM kn k JOIN cn c ON c.norm IN (k.n1,k.n2,k.n3,k.n4,k.n5) OR (k.raiz IS NOT NULL AND c.raiz=k.raiz)
 ),
 ancestors AS (
  SELECT m.contract_code,m.lote,m.id,m.client_id,m.parent_contract_id,m.match_priority,0 AS depth FROM matches m
  UNION ALL
  SELECT a.contract_code,a.lote,parent.id,parent.client_id,parent.parent_contract_id,a.match_priority,a.depth+1
  FROM public.contracts parent JOIN ancestors a ON parent.id=a.parent_contract_id
  WHERE a.depth<20
 ),
 best AS MATERIALIZED (
  SELECT DISTINCT ON (a.contract_code,a.lote) a.contract_code,a.lote,a.id,nullif(cl.business_name,'') AS customer_name
  FROM ancestors a JOIN public.clients cl ON cl.id=a.client_id
  WHERE nullif(cl.business_name,'') IS NOT NULL
  ORDER BY a.contract_code,a.lote,a.match_priority,a.depth,a.id
 ),
 cust AS MATERIALIZED (
  SELECT k.contract_code,k.lote,b.id AS contract_id,b.customer_name AS contract_customer_name,
   o1.customer_name AS lot_customer,o2.customer_name AS contract_customer
  FROM keys k
  LEFT JOIN best b ON ARRAY[b.contract_code,b.lote]=ARRAY[k.contract_code,k.lote]
  LEFT JOIN ot_customers o1 ON o1.raiz=nullif(public.apt_ot_raiz(k.lote),'')
  LEFT JOIN ot_customers o2 ON o2.raiz=nullif(public.inv_ot(k.contract_code),'')
 )
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.fecha DESC,x.document_no,x.product_code),'[]'::jsonb)
 INTO result
 FROM (
  SELECT r.*,ck.contract_id,customer.customer_name,customer.customer_source,
   v.physical_quantity,v.variance,v.variance_reason,
   CASE WHEN v.id IS NULL THEN 'PENDING' WHEN v.erp_quantity<>r.quantity THEN 'STALE' ELSE 'VALIDATED' END AS validation_status,
   coalesce(p.label_count,0) AS label_count,coalesce(p.labeled_qty,0) AS labeled_qty,
   coalesce(p.unprinted_count,0) AS unprinted_count,
   coalesce(p.pending_labels,'[]'::jsonb) AS pending_labels,
   CASE
    WHEN coalesce(p.label_count,0)=0 THEN 'NOT_LABELED'
    WHEN coalesce(p.unprinted_count,0)>0 THEN 'PENDING_PRINT'
    WHEN p.labeled_qty=coalesce(v.physical_quantity,r.quantity) AND p.expected_count=p.label_count THEN 'MATCH'
    ELSE 'DIFFERENCE'
   END AS label_status
  FROM r
  LEFT JOIN cust ck ON ARRAY[ck.contract_code,ck.lote]=ARRAY[r.contract_code,r.lote]
  LEFT JOIN LATERAL (
   SELECT rv.* FROM public.wh_receipt_validations rv
   WHERE rv.source_movement_key=r.receipt_key ORDER BY rv.validated_at DESC,rv.id DESC LIMIT 1
  ) v ON true
  LEFT JOIN LATERAL (
   SELECT coalesce(nullif(r.customer_name,''),nullif(ck.contract_customer_name,''),ck.lot_customer,ck.contract_customer,nullif(v.manual_customer_name,'')) AS customer_name,
    CASE WHEN nullif(r.customer_name,'') IS NOT NULL THEN 'EXCEL'
      WHEN nullif(ck.contract_customer_name,'') IS NOT NULL OR ck.lot_customer IS NOT NULL OR ck.contract_customer IS NOT NULL THEN 'ERP/OT'
      WHEN nullif(v.manual_customer_name,'') IS NOT NULL THEN 'MANUAL' ELSE NULL END AS customer_source
  ) customer ON true
  LEFT JOIN LATERAL (
   SELECT count(*)::integer AS label_count,round(sum(wp.quantity),3) AS labeled_qty,
    max(wp.source_expected_count) AS expected_count,
    count(*) FILTER (WHERE wp.label_print_count=0 AND coalesce(wl.print_count,0)=0)::integer AS unprinted_count,
    jsonb_agg(jsonb_build_object(
      'package_code',wp.package_code,
      'source_document_no',wp.source_document_no,
      'source_lot',wp.source_lot,
      'source_product_code',wp.source_product_code,
      'description',wp.description,
      'quantity',wp.quantity,
      'weight_kg',wp.weight_kg,
      'unit',wp.unit,
      'sequence_no',wp.sequence_no,
      'sequence_total',wp.sequence_total,
      'source_warehouse',wp.source_warehouse,
      'source_date',wp.source_date,
      'contract_code',wp.source_contract_code,
      'customer_name',coalesce(customer.customer_name,'Cliente por registrar'),
      'lpn_code',wl.lpn_code
    ) ORDER BY wp.sequence_no) FILTER (WHERE wp.label_print_count=0 AND coalesce(wl.print_count,0)=0) AS pending_labels
   FROM public.wh_packages wp
   -- Línea consolidada en un LPN de recepción vigente: su etiqueta es la del LPN.
   LEFT JOIN public.wh_lpns wl ON wl.id=wp.lpn_id AND wl.origin='RECEPCION' AND wl.status<>'VOID'
   WHERE wp.source_movement_key=r.receipt_key AND wp.status<>'VOID'
  ) p ON true
  WHERE
   ((q='' AND (coalesce(p.label_count,0)=0 OR coalesce(p.unprinted_count,0)>0))
    OR (q<>'' AND (r.document_no ILIKE '%'||q||'%' OR coalesce(r.lote,'') ILIKE '%'||q||'%'
      OR r.product_code ILIKE '%'||q||'%' OR coalesce(r.description,'') ILIKE '%'||q||'%'
      OR coalesce(r.contract_code,'') ILIKE '%'||q||'%' OR coalesce(customer.customer_name,'') ILIKE '%'||q||'%')))
  ORDER BY (r.document_no=q) DESC,r.fecha DESC,r.document_no,r.product_code
  LIMIT 5000
 ) x;
 RETURN result;
END $function$;
