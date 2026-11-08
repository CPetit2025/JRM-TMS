-- Revisión del inventario (#511): congelamiento también para paquetes ya recogidos o empacados, acceso por sede en la
-- búsqueda de stock esperado y, al anular un paquete creado por rótulo, se anulan todos sus conteos de la campaña.
CREATE OR REPLACE FUNCTION public.wh_packages_count_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_code text;
BEGIN
  IF coalesce(current_setting('wh.count_op', true), '') = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.source_kind = 'IPT' THEN
      IF public.wh_count_open_campaign(NEW.source_warehouse) IS NOT NULL THEN
        RAISE EXCEPTION 'La bodega % está en inventario: el etiquetado por IPT se reanuda al cerrar la campaña', NEW.source_warehouse;
      END IF;
      -- El mismo bulto (IPT, producto, n/total) ya se etiquetó desde el inventario
      SELECT package_code INTO v_code FROM public.wh_packages
       WHERE source_kind = 'INVENTARIO' AND status <> 'VOID' AND source_document_no = NEW.source_document_no
         AND source_product_code = NEW.source_product_code AND sequence_no = NEW.sequence_no AND sequence_total = NEW.sequence_total LIMIT 1;
      IF v_code IS NOT NULL THEN RAISE EXCEPTION 'Ese bulto ya fue etiquetado en el inventario como %', v_code; END IF;
    END IF;
    RETURN NEW;
  END IF;
  -- Avanzar hacia el despacho (recoger, empacar, cargar) desde cualquier estado previo; deshacer un empaque no se bloquea
  IF NEW.status IS DISTINCT FROM OLD.status
     AND (NEW.status IN ('PACKED','LOADED') OR (NEW.status = 'PICKED' AND OLD.status IN ('AVAILABLE','RESERVED'))) THEN
    IF OLD.count_hold THEN RAISE EXCEPTION 'El paquete % está retenido por el inventario hasta su cierre', OLD.package_code; END IF;
    IF public.wh_count_open_campaign(OLD.source_warehouse) IS NOT NULL THEN
      RAISE EXCEPTION 'La bodega % está en inventario: no se puede despachar hasta cerrar la campaña', OLD.source_warehouse;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.wh_count_expected_search(p_campaign uuid, p_search text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_q text := nullif(upper(btrim(p_search)), '');
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT (public.wh_any_warehouse_permission() OR public.wh_count_can_count()) THEN RAISE EXCEPTION 'Sin acceso al almacén' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.wh_count_campaigns WHERE id = p_campaign AND public.can_access_site(site_id)) THEN RAISE EXCEPTION 'Campaña no disponible'; END IF;
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (
    SELECT e.linea, e.cod_producto, e.producto, e.lote, e.lote_raw, e.lote_key, e.ot, e.unidad, e.stock,
      (SELECT coalesce(sum(l.quantity), 0) FROM public.wh_count_lines l WHERE l.campaign_id = e.campaign_id AND l.voided_at IS NULL
         AND l.cod_producto = e.cod_producto AND l.lote_key = e.lote_key AND l.round = public.wh_count_round(e.campaign_id, e.cod_producto, e.lote_key)) AS counted
    FROM public.wh_count_expected e
    WHERE e.campaign_id = p_campaign AND (v_q IS NULL OR upper(coalesce(e.ot, '')) LIKE '%' || v_q || '%' OR upper(coalesce(e.lote_raw, '')) LIKE '%' || v_q || '%'
      OR upper(e.lote_key) LIKE '%' || v_q || '%' OR upper(e.cod_producto) LIKE '%' || v_q || '%' OR upper(coalesce(e.producto, '')) LIKE '%' || v_q || '%')
    ORDER BY e.ot NULLS LAST, e.lote_key, e.cod_producto LIMIT 50) x), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.wh_count_void_line(p_line bigint, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l public.wh_count_lines; c public.wh_count_campaigns;
BEGIN
  PERFORM public.security_assert_active_session();
  IF nullif(btrim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'Registre el motivo'; END IF;
  SELECT * INTO l FROM public.wh_count_lines WHERE id = p_line FOR UPDATE;
  IF NOT FOUND OR l.voided_at IS NOT NULL THEN RAISE EXCEPTION 'Línea no disponible'; END IF;
  SELECT * INTO c FROM public.wh_count_campaigns WHERE id = l.campaign_id FOR UPDATE;
  IF NOT public.can_access_site(c.site_id) OR c.status NOT IN ('EN_CONTEO','EN_REVISION') THEN RAISE EXCEPTION 'La campaña no está abierta'; END IF;
  IF l.counted_by <> auth.uid() AND NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN RAISE EXCEPTION 'Solo quien contó o supervisión anulan la línea' USING ERRCODE = '42501'; END IF;
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
END $$;
