-- Tipos de inventario: el congelamiento total de la bodega bloqueaba la recepción por IPT en cualquier inventario.
--   GENERAL  · 100 % de la bodega · bloquea recepción IPT, picking y carga de toda la bodega (congelamiento total).
--   BARRIDO  · por zonas físicas · la bodega sigue operando; solo se bloquean los bultos ya contados en la campaña
--              (el WMS aún no registra la ubicación de cada bulto, así que el bloqueo por zona empieza al contarlo).
--   CICLICO  · por SKU · la bodega sigue operando; solo se bloquean recepción, picking y carga de los SKU elegidos.
-- Las campañas abiertas pasan a BARRIDO: la recepción por IPT se libera de inmediato.

ALTER TABLE public.wh_count_campaigns ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'BARRIDO';
ALTER TABLE public.wh_count_campaigns ADD COLUMN IF NOT EXISTS productos text[] NOT NULL DEFAULT '{}';
DO $$ BEGIN
  ALTER TABLE public.wh_count_campaigns ADD CONSTRAINT wh_count_campaigns_tipo_check CHECK (tipo IN ('GENERAL','BARRIDO','CICLICO'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.wh_packages_count_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_code text; c public.wh_count_campaigns;
BEGIN
  IF coalesce(current_setting('wh.count_op', true), '') = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.source_kind = 'IPT' THEN
      SELECT * INTO c FROM public.wh_count_campaigns WHERE bodega = NEW.source_warehouse AND status IN ('EN_CONTEO','EN_REVISION');
      IF c.tipo = 'GENERAL' THEN
        RAISE EXCEPTION 'La bodega % está en inventario general: la recepción por IPT se reanuda al cerrar la campaña', NEW.source_warehouse;
      ELSIF c.tipo = 'CICLICO' AND NEW.source_product_code = ANY (c.productos) THEN
        RAISE EXCEPTION 'El SKU % está en inventario cíclico: su recepción se reanuda al cerrar la campaña', NEW.source_product_code;
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
    SELECT * INTO c FROM public.wh_count_campaigns WHERE bodega = OLD.source_warehouse AND status IN ('EN_CONTEO','EN_REVISION');
    IF c.tipo = 'GENERAL' THEN
      RAISE EXCEPTION 'La bodega % está en inventario general: no se puede despachar hasta cerrar la campaña', OLD.source_warehouse;
    ELSIF c.tipo = 'CICLICO' AND OLD.source_product_code = ANY (c.productos) THEN
      RAISE EXCEPTION 'El SKU % está en inventario cíclico: no se puede despachar hasta cerrar la campaña', OLD.source_product_code;
    ELSIF c.tipo = 'BARRIDO' AND EXISTS (SELECT 1 FROM public.wh_count_lines l WHERE l.campaign_id = c.id AND l.package_id = OLD.id AND l.voided_at IS NULL) THEN
      RAISE EXCEPTION 'El paquete % ya se contó en el inventario de su zona: no se puede despachar hasta cerrar la campaña', OLD.package_code;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- El cíclico solo cuenta sus SKU
CREATE OR REPLACE FUNCTION public.wh_count_check(c public.wh_count_campaigns, p_product text, p_lote_key text)
RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_round integer := public.wh_count_round(c.id, p_product, p_lote_key);
BEGIN
  IF c.tipo = 'CICLICO' AND NOT p_product = ANY (c.productos) THEN RAISE EXCEPTION 'El SKU % no está en este inventario cíclico', p_product; END IF;
  IF c.status = 'EN_REVISION' AND v_round = 1 THEN RAISE EXCEPTION 'La campaña está en revisión: solo se cuentan los lotes en reconteo'; END IF;
  IF c.status NOT IN ('EN_CONTEO','EN_REVISION') THEN RAISE EXCEPTION 'La campaña no está abierta'; END IF;
  -- El reconteo lo hace un operario distinto al de la ronda anterior
  IF v_round > 1 AND EXISTS (SELECT 1 FROM public.wh_count_lines WHERE campaign_id = c.id AND cod_producto = p_product AND lote_key = p_lote_key
       AND round = v_round - 1 AND voided_at IS NULL AND counted_by = auth.uid()) THEN
    RAISE EXCEPTION 'El reconteo de este lote lo debe hacer un operario distinto';
  END IF;
  RETURN v_round;
END $$;
REVOKE ALL ON FUNCTION public.wh_count_check(public.wh_count_campaigns, text, text) FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.wh_count_open(text, text[], text, uuid);
CREATE OR REPLACE FUNCTION public.wh_count_open(p_bodega text, p_zones text[] DEFAULT '{}', p_notes text DEFAULT NULL, p_site_id uuid DEFAULT NULL,
  p_tipo text DEFAULT 'BARRIDO', p_productos text[] DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_import uuid; v_site uuid := p_site_id; v_id uuid := gen_random_uuid(); v_code text; v_n integer;
  v_tipo text := upper(coalesce(nullif(btrim(p_tipo), ''), 'BARRIDO'));
  v_prod text[] := ARRAY(SELECT DISTINCT upper(btrim(x)) FROM unnest(coalesce(p_productos, '{}')) x WHERE nullif(btrim(x), '') IS NOT NULL);
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN RAISE EXCEPTION 'Solo supervisión abre un inventario' USING ERRCODE = '42501'; END IF;
  IF v_tipo NOT IN ('GENERAL','BARRIDO','CICLICO') THEN RAISE EXCEPTION 'Tipo de inventario no reconocido'; END IF;
  IF v_tipo = 'CICLICO' AND cardinality(v_prod) = 0 THEN RAISE EXCEPTION 'Indique los SKU del inventario cíclico'; END IF;
  SELECT id INTO v_import FROM public.erp_imports WHERE kind = 'STOCK' AND status = 'ACTIVA';
  IF v_import IS NULL THEN RAISE EXCEPTION 'No hay una carga vigente del Stock Bodega Despacho'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.erp_stock_lots WHERE import_id = v_import AND bodega = p_bodega) THEN
    RAISE EXCEPTION 'La bodega % no figura en el stock ERP vigente', p_bodega;
  END IF;
  IF public.wh_count_open_campaign(p_bodega) IS NOT NULL THEN RAISE EXCEPTION 'Ya hay un inventario abierto en %', p_bodega; END IF;
  IF v_site IS NULL THEN SELECT id INTO v_site FROM public.sites WHERE public.can_access_site(id) ORDER BY code LIMIT 1; END IF;
  IF v_site IS NULL OR NOT public.can_access_site(v_site) THEN RAISE EXCEPTION 'Sede no disponible'; END IF;
  v_code := 'INV-' || to_char(now() AT TIME ZONE 'America/Lima', 'YYMMDD') || '-' || upper(substr(replace(v_id::text, '-', ''), 1, 4));
  INSERT INTO public.wh_count_campaigns (id, code, site_id, bodega, zones, erp_import_id, notes, created_by, tipo, productos)
  VALUES (v_id, v_code, v_site, p_bodega, coalesce(p_zones, '{}'), v_import, nullif(btrim(p_notes), ''), auth.uid(), v_tipo, v_prod);
  INSERT INTO public.wh_count_expected (campaign_id, linea, cod_producto, producto, lote, lote_raw, lote_key, ot, unidad, stock, kg)
  SELECT v_id, linea, cod_producto, producto, lote, lote_raw, public.wh_lote_key(coalesce(lote, lote_raw)), ot, unidad, stock, kg
  FROM public.erp_stock_lots WHERE import_id = v_import AND bodega = p_bodega AND stock <> 0
    AND (v_tipo <> 'CICLICO' OR upper(cod_producto) = ANY (v_prod));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_tipo = 'CICLICO' AND v_n = 0 THEN RAISE EXCEPTION 'Ninguno de esos SKU tiene stock en % según el ERP', p_bodega; END IF;
  -- La carga usada conserva sus filas aunque llegue otra
  UPDATE public.erp_imports SET retained = true WHERE id = v_import;
  RETURN jsonb_build_object('id', v_id, 'code', v_code, 'expected_lines', v_n, 'tipo', v_tipo);
END $$;
REVOKE ALL ON FUNCTION public.wh_count_open(text, text[], text, uuid, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_count_open(text, text[], text, uuid, text, text[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.wh_count_board(p_campaign uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT (public.wh_any_warehouse_permission() OR public.wh_count_can_count()) THEN RAISE EXCEPTION 'Sin acceso al almacén' USING ERRCODE = '42501'; END IF;
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC) FROM (
    SELECT c.id, c.code, c.bodega, c.zones, c.tipo, c.productos, c.status, c.notes, c.created_at, c.closed_at, c.close_note,
      i.cut_at AS erp_cut_at, public.wh_profile_name(c.created_by) AS created_by_name, public.wh_profile_name(c.closed_by) AS closed_by_name,
      (SELECT count(*) FROM public.wh_count_expected e WHERE e.campaign_id = c.id) AS expected_lines,
      (SELECT coalesce(sum(e.stock), 0) FROM public.wh_count_expected e WHERE e.campaign_id = c.id) AS expected_qty,
      (SELECT count(*) FROM public.wh_count_lines l WHERE l.campaign_id = c.id AND l.voided_at IS NULL) AS counted_lines,
      (SELECT count(*) FROM public.wh_count_lines l WHERE l.campaign_id = c.id AND l.voided_at IS NULL AND l.origin = 'ROTULO') AS labeled,
      (SELECT count(*) FROM public.wh_count_lines l WHERE l.campaign_id = c.id AND l.voided_at IS NULL AND l.origin = 'NO_IDENTIFICADO') AS unidentified,
      (SELECT count(*) FROM public.wh_count_rounds r WHERE r.campaign_id = c.id) AS recounts
    FROM public.wh_count_campaigns c JOIN public.erp_imports i ON i.id = c.erp_import_id
    WHERE public.can_access_site(c.site_id) AND (p_campaign IS NULL OR c.id = p_campaign)
    ORDER BY c.created_at DESC LIMIT 100) x), '[]'::jsonb);
END $$;
