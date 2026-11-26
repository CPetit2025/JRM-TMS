-- Avance del contrato por ítem: el peso unitario del ERP permite mostrar cada cantidad también en toneladas.
CREATE OR REPLACE FUNCTION public.inv_contrato_lineas(p_q text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE v_raiz text := public.apt_ot_raiz(p_q); v_import uuid; v_lineas jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  IF v_raiz IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Escriba el número de la OT o contrato'); END IF;
  SELECT id INTO v_import FROM public.erp_imports WHERE kind = 'CONTRATOS' AND status = 'ACTIVA' ORDER BY applied_at DESC NULLS LAST LIMIT 1;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'item', l.nro_documento || '-' || lpad(l.secuencia::text, 3, '0'), 'documento', l.nro_documento, 'secuencia', l.secuencia,
      'producto', l.cod_producto, 'glosa', l.producto, 'unidad', l.unidad, 'peso_unit', NULLIF(l.peso_unit, 0),
      'contratado', round(COALESCE(l.cant_contrato, 0), 3), 'despachado', round(COALESCE(l.cant_despachada, 0), 3),
      'pendiente', round(COALESCE(l.cant_pendiente, 0), 3), 'estado', l.estado, 'guias', l.nro_guias,
      'fecha_contrato', l.fecha_contrato, 'ultimo_despacho', l.fecha_ult_despacho)
      ORDER BY l.nro_documento, l.secuencia), '[]'::jsonb)
  INTO v_lineas
  FROM public.erp_contract_lines l
  WHERE l.import_id = v_import AND upper(btrim(l.nro_documento)) LIKE v_raiz || '%' AND public.apt_ot_raiz(l.nro_documento) = v_raiz;
  RETURN jsonb_build_object('success', true, 'ot', v_raiz, 'lineas', v_lineas,
    'corte', (SELECT cut_at FROM public.erp_imports WHERE id = v_import));
END $function$;
REVOKE ALL ON FUNCTION public.inv_contrato_lineas(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_contrato_lineas(text) TO authenticated;
