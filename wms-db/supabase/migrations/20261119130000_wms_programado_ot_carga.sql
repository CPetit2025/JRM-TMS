-- Fase 2.4 · Programado desde el contrato ERP por OT con avance acumulado, stock separado y cumplimiento de carga.
-- Por ítem del contrato de la OT (saldo pendiente del ERP = programado):
--  · preparado en esta tarea y en otras tareas abiertas de la misma OT (paquetes recogidos/empacados/cargados);
--  · stock WMS disponible (paquetes AVAILABLE), nunca el físico total como disponible;
--  · ERP: stock del lote, con falla (bloqueado por calidad) y comprometido;
--  · faltante contra la OT = saldo − preparado en tareas abiertas − disponible WMS (si es > 0).
-- Carga de la tarea: LPN asignados a una unidad frente a LPN cargados (cumplimiento de carga).
-- Limitación: el saldo del ERP baja cuando el ERP registra la guía; lo cargado aún no reflejado en el ERP se informa aparte.
CREATE OR REPLACE FUNCTION public.wh_prepicking_checklist(p_task_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_site uuid; v_ot text; v_ci uuid; v_si uuid; v_ci_at timestamptz; v_si_at timestamptz; v_carga jsonb;
BEGIN
  PERFORM public.security_assert_active_session();
  SELECT t.site_id, substring(coalesce(c.code, '') FROM '([0-9]{5,6})') INTO v_site, v_ot
    FROM public.wh_tasks t JOIN public.transport_requests r ON r.id = t.transport_request_id
    LEFT JOIN public.contracts c ON c.id = r.contract_id WHERE t.id = p_task_id;
  IF v_site IS NULL OR NOT public.can_access_site(v_site) OR NOT public.wh_any_warehouse_permission() THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
  SELECT id, coalesce(applied_at, created_at) INTO v_ci, v_ci_at FROM public.erp_imports WHERE kind = 'CONTRATOS' AND status = 'ACTIVA' ORDER BY applied_at DESC NULLS LAST LIMIT 1;
  SELECT id, coalesce(applied_at, created_at) INTO v_si, v_si_at FROM public.erp_imports WHERE kind = 'STOCK' AND status = 'ACTIVA' ORDER BY applied_at DESC NULLS LAST LIMIT 1;
  SELECT jsonb_build_object(
      'lpn_asignados', count(*) FILTER (WHERE l.load_unit_id IS NOT NULL),
      'lpn_cargados', count(*) FILTER (WHERE l.load_unit_id IS NOT NULL AND l.status = 'LOADED'),
      'lpn_sin_unidad', count(*) FILTER (WHERE l.load_unit_id IS NULL),
      'lpn_total', count(*),
      'cumplimiento_pct', CASE WHEN count(*) FILTER (WHERE l.load_unit_id IS NOT NULL) > 0 THEN round(100.0 *
        count(*) FILTER (WHERE l.load_unit_id IS NOT NULL AND l.status = 'LOADED') / count(*) FILTER (WHERE l.load_unit_id IS NOT NULL), 1) END)
    INTO v_carga FROM public.wh_lpns l WHERE l.task_id = p_task_id AND l.status <> 'VOID';
  RETURN jsonb_build_object('ot', v_ot, 'contratos_at', v_ci_at, 'stock_at', v_si_at, 'carga', v_carga, 'items', coalesce((
    SELECT jsonb_agg(to_jsonb(x) || jsonb_build_object('faltante_qty',
        greatest(x.pending_qty - x.prepared_qty - x.prepared_other_qty - x.stock_wms, 0)) ORDER BY x.item_code) FROM (
      SELECT l.item_code, l.item, l.lote, l.cod_producto AS product_code, l.producto AS description, l.unidad AS unit,
             l.cant_contrato AS contract_qty, l.cant_despachada AS dispatched_qty, l.cant_pendiente AS pending_qty,
             CASE WHEN l.cant_contrato > 0 THEN round(100 * l.cant_despachada / l.cant_contrato, 1) END AS avance_pct,
             coalesce(w.qty, 0) AS stock_wms, coalesce(w.packages, 0) AS stock_wms_packages,
             coalesce(pt.qty, 0) AS prepared_qty, coalesce(pt.loaded, 0) AS loaded_qty, coalesce(po.qty, 0) AS prepared_other_qty,
             coalesce(e.qty, 0) AS stock_erp, coalesce(e.falla, 0) AS stock_erp_falla, e.comprometido AS stock_erp_comprometido
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
      LEFT JOIN LATERAL (SELECT sum(p.quantity) AS qty, sum(p.quantity) FILTER (WHERE p.status = 'LOADED') AS loaded FROM public.wh_packages p
                          WHERE p.task_id = p_task_id AND p.status IN ('RESERVED','PICKED','PACKED','LOADED')
                            AND p.source_contract_code = l.item_code AND p.source_product_code = l.cod_producto) pt ON true
      LEFT JOIN LATERAL (SELECT sum(p.quantity) AS qty FROM public.wh_packages p JOIN public.wh_tasks ot ON ot.id = p.task_id
                          WHERE p.task_id <> p_task_id AND ot.status NOT IN ('LOADED','RECONCILED','CANCELLED')
                            AND p.status IN ('RESERVED','PICKED','PACKED','LOADED')
                            AND p.source_contract_code = l.item_code AND p.source_product_code = l.cod_producto) po ON true
      LEFT JOIN LATERAL (SELECT sum(s.stock) AS qty, sum(s.stock_falla) AS falla, sum(s.stock_comprometido) AS comprometido FROM public.erp_stock_lots s
                          WHERE s.import_id = v_si AND s.cod_producto = l.cod_producto AND s.lote = l.lote) e ON true
      WHERE l.cant_pendiente > 0 OR coalesce(w.qty, 0) > 0 OR coalesce(pt.qty, 0) > 0
    ) x), '[]'::jsonb));
END $function$;
REVOKE ALL ON FUNCTION public.wh_prepicking_checklist(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_prepicking_checklist(uuid) TO authenticated;
