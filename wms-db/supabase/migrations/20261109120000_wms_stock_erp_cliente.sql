-- Stock ERP: cliente de cada lote, tomado del Actualizable vigente por OT (el Stock Bodega Despacho no lo trae).
-- También se busca por cliente.
CREATE OR REPLACE FUNCTION public.erp_stock_query(p_bodega text DEFAULT NULL, p_search text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v public.erp_imports; v_q text := nullif(upper(btrim(p_search)), '');
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_any_warehouse_permission() THEN RAISE EXCEPTION 'Sin acceso al almacén' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v FROM public.erp_imports WHERE kind = 'STOCK' AND status = 'ACTIVA';
  IF v.id IS NULL THEN RETURN jsonb_build_object('import_id', NULL, 'cut_at', NULL, 'bodegas', '[]'::jsonb, 'rows', '[]'::jsonb); END IF;
  RETURN jsonb_build_object('import_id', v.id, 'cut_at', v.cut_at, 'file_name', v.file_name, 'applied_at', v.applied_at,
    'bodegas', (SELECT coalesce(jsonb_agg(DISTINCT bodega ORDER BY bodega), '[]') FROM public.erp_stock_lots WHERE import_id = v.id),
    'rows', coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.bodega, x.ot NULLS LAST, x.lote, x.cod_producto) FROM (
      WITH cli AS MATERIALIZED (SELECT ot, cliente FROM public.erp_ot_cliente_erp())
      SELECT s.bodega, s.cod_producto, s.producto, s.lote, s.lote_raw, s.ot, cli.cliente, s.unidad, s.stock, s.stock_falla, s.stock_comprometido, s.kg
      FROM public.erp_stock_lots s LEFT JOIN cli ON cli.ot = public.apt_ot_raiz(s.ot)
      WHERE s.import_id = v.id AND (p_bodega IS NULL OR s.bodega = p_bodega)
        AND (v_q IS NULL OR upper(coalesce(s.ot, '')) LIKE '%' || v_q || '%' OR upper(coalesce(s.lote, '')) LIKE '%' || v_q || '%'
             OR upper(coalesce(s.lote_raw, '')) LIKE '%' || v_q || '%' OR upper(s.cod_producto) LIKE '%' || v_q || '%'
             OR upper(coalesce(s.producto, '')) LIKE '%' || v_q || '%' OR upper(coalesce(cli.cliente, '')) LIKE '%' || v_q || '%')
      ORDER BY s.bodega, s.ot NULLS LAST, s.lote, s.cod_producto
      LIMIT 2000) x), '[]'::jsonb));
END $$;
