-- Checklist previo al picking: por cada ítem del contrato de la OT de la tarea (ERP, carga de CONTRATOS vigente) muestra
-- lo que pide el contrato, lo despachado y lo pendiente, junto al stock disponible:
--  · stock WMS: paquetes AVAILABLE con el mismo código de ítem (OT-SUBCONTRATO-ítem) y producto (listo para picking);
--  · stock ERP: stock del producto en el lote del documento (carga de STOCK vigente).
-- El ítem es el documento + secuencia en 3 dígitos (16571-S002 + 22 → 16571-S002-022), igual que los bultos del WMS.
-- Se excluyen las líneas de servicio (SERVICIO A TERCEROS) y los documentos «ERROR DE CONTRATO».
CREATE OR REPLACE FUNCTION public.wh_prepicking_checklist(p_task_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_site uuid; v_ot text; v_ci uuid; v_si uuid; v_ci_at timestamptz; v_si_at timestamptz;
BEGIN
  PERFORM public.security_assert_active_session();
  SELECT t.site_id, substring(coalesce(c.code, '') FROM '([0-9]{5,6})') INTO v_site, v_ot
    FROM public.wh_tasks t JOIN public.transport_requests r ON r.id = t.transport_request_id
    LEFT JOIN public.contracts c ON c.id = r.contract_id WHERE t.id = p_task_id;
  IF v_site IS NULL OR NOT public.can_access_site(v_site) OR NOT public.wh_any_warehouse_permission() THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
  SELECT id, coalesce(applied_at, created_at) INTO v_ci, v_ci_at FROM public.erp_imports WHERE kind = 'CONTRATOS' AND status = 'ACTIVA' ORDER BY applied_at DESC NULLS LAST LIMIT 1;
  SELECT id, coalesce(applied_at, created_at) INTO v_si, v_si_at FROM public.erp_imports WHERE kind = 'STOCK' AND status = 'ACTIVA' ORDER BY applied_at DESC NULLS LAST LIMIT 1;
  RETURN jsonb_build_object('ot', v_ot, 'contratos_at', v_ci_at, 'stock_at', v_si_at, 'items', coalesce((
    SELECT jsonb_agg(to_jsonb(x) ORDER BY x.item_code) FROM (
      SELECT l.item_code, l.item, l.lote, l.cod_producto AS product_code, l.producto AS description, l.unidad AS unit,
             l.cant_contrato AS contract_qty, l.cant_despachada AS dispatched_qty, l.cant_pendiente AS pending_qty,
             coalesce(w.qty, 0) AS stock_wms, coalesce(w.packages, 0) AS stock_wms_packages, coalesce(e.qty, 0) AS stock_erp
      FROM (SELECT DISTINCT ON (cl.nro_documento, cl.secuencia, cl.cod_producto)
              cl.nro_documento || '-' || lpad(cl.secuencia::text, 3, '0') AS item_code, lpad(cl.secuencia::text, 3, '0') AS item,
              cl.nro_documento AS lote, cl.cod_producto, cl.producto, cl.unidad,
              coalesce(cl.cant_contrato, 0) AS cant_contrato, coalesce(cl.cant_despachada, 0) AS cant_despachada, coalesce(cl.cant_pendiente, 0) AS cant_pendiente
            FROM public.erp_contract_lines cl
            WHERE cl.import_id = v_ci AND cl.ot = v_ot
              AND coalesce(cl.tipo_producto, '') <> 'SERVICIO A TERCEROS' AND coalesce(cl.tipo_documento, '') NOT ILIKE 'ERROR%'
            ORDER BY cl.nro_documento, cl.secuencia, cl.cod_producto) l
      LEFT JOIN LATERAL (SELECT sum(p.quantity) AS qty, count(*) AS packages FROM public.wh_packages p
                          WHERE p.status = 'AVAILABLE' AND p.source_contract_code = l.item_code AND p.source_product_code = l.cod_producto) w ON true
      LEFT JOIN LATERAL (SELECT sum(s.stock) AS qty FROM public.erp_stock_lots s
                          WHERE s.import_id = v_si AND s.cod_producto = l.cod_producto AND s.lote = l.lote) e ON true
      WHERE l.cant_pendiente > 0 OR coalesce(w.qty, 0) > 0
    ) x), '[]'::jsonb));
END $function$;
REVOKE ALL ON FUNCTION public.wh_prepicking_checklist(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_prepicking_checklist(uuid) TO authenticated;
