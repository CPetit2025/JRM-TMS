-- Fases 2 y 3 (docs/plan-wms-inventario-apt.md): inventario por barrido con etiquetado, cuadre por bodega y cierre.
-- - Una campaña por bodega: copia inmutable del stock ERP (wh_count_expected) de la importación usada (retenida).
-- - Barrido: bulto con etiqueta → se cuenta; bulto con rótulo → se identifica, se crea el PKG y se imprime.
-- - Identidad del bulto: IPT + producto + n/total; no se etiqueta dos veces (ni desde inventario ni desde IPT).
-- - Congelamiento: mientras la campaña está abierta, la bodega no despacha, no carga ni etiqueta por IPT.
-- - Retención: los paquetes creados en la campaña no entran al picking hasta el cierre.
-- - Cuadre por bodega, producto y lote; reconteo por otro operario; cierre con motivo por diferencia.
-- Unidades: las del ERP (las mismas del IPT); no se aplica el factor CIEN/MIL.

ALTER TABLE public.wh_packages ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'IPT';
ALTER TABLE public.wh_packages ADD COLUMN IF NOT EXISTS count_campaign_id uuid;
ALTER TABLE public.wh_packages ADD COLUMN IF NOT EXISTS count_hold boolean NOT NULL DEFAULT false;
ALTER TABLE public.wh_packages ADD COLUMN IF NOT EXISTS physical_key text;
DO $$ BEGIN
  ALTER TABLE public.wh_packages ADD CONSTRAINT wh_packages_source_kind_check CHECK (source_kind IN ('IPT','INVENTARIO'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.wh_count_campaigns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  site_id       uuid NOT NULL REFERENCES public.sites(id),
  bodega        text NOT NULL,
  zones         text[] NOT NULL DEFAULT '{}',
  erp_import_id uuid NOT NULL REFERENCES public.erp_imports(id),
  status        text NOT NULL DEFAULT 'EN_CONTEO' CHECK (status IN ('EN_CONTEO','EN_REVISION','CERRADA','ANULADA')),
  notes         text,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_by     uuid,
  closed_at     timestamptz,
  close_note    text
);
CREATE UNIQUE INDEX IF NOT EXISTS wh_count_campaigns_one_open ON public.wh_count_campaigns (bodega) WHERE status IN ('EN_CONTEO','EN_REVISION');
CREATE INDEX IF NOT EXISTS wh_count_campaigns_site_idx ON public.wh_count_campaigns (site_id);
CREATE INDEX IF NOT EXISTS wh_count_campaigns_import_idx ON public.wh_count_campaigns (erp_import_id);
DO $$ BEGIN
  ALTER TABLE public.wh_packages ADD CONSTRAINT wh_packages_count_campaign_fk FOREIGN KEY (count_campaign_id) REFERENCES public.wh_count_campaigns(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS wh_packages_count_campaign_idx ON public.wh_packages (count_campaign_id);
-- Un bulto físico se etiqueta una sola vez desde inventario
CREATE UNIQUE INDEX IF NOT EXISTS wh_packages_physical_key_uq ON public.wh_packages (physical_key) WHERE source_kind = 'INVENTARIO' AND status <> 'VOID';
CREATE INDEX IF NOT EXISTS wh_packages_identity_idx ON public.wh_packages (source_document_no, source_product_code, sequence_no, sequence_total) WHERE status <> 'VOID';

-- Copia inmutable del stock ERP de la bodega al abrir la campaña
CREATE TABLE IF NOT EXISTS public.wh_count_expected (
  campaign_id  uuid NOT NULL REFERENCES public.wh_count_campaigns(id),
  linea        integer NOT NULL,
  cod_producto text NOT NULL,
  producto     text,
  lote         text,
  lote_raw     text,
  lote_key     text NOT NULL,
  ot           text,
  unidad       text,
  stock        numeric(20,6) NOT NULL,
  kg           numeric(20,6),
  PRIMARY KEY (campaign_id, linea)
);
CREATE INDEX IF NOT EXISTS wh_count_expected_key_idx ON public.wh_count_expected (campaign_id, cod_producto, lote_key);

-- Ronda vigente de conteo por lote (1 = conteo inicial; 2+ = reconteos)
CREATE TABLE IF NOT EXISTS public.wh_count_rounds (
  campaign_id  uuid NOT NULL REFERENCES public.wh_count_campaigns(id),
  cod_producto text NOT NULL,
  lote_key     text NOT NULL,
  round        integer NOT NULL CHECK (round >= 2),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, cod_producto, lote_key)
);

CREATE TABLE IF NOT EXISTS public.wh_count_lines (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id     uuid NOT NULL REFERENCES public.wh_count_campaigns(id),
  round           integer NOT NULL DEFAULT 1,
  package_id      uuid REFERENCES public.wh_packages(id),
  origin          text NOT NULL CHECK (origin IN ('ETIQUETA','ROTULO','NO_IDENTIFICADO')),
  zone            text,
  cod_producto    text,
  lote_key        text,
  ot              text,
  quantity        numeric(20,6),
  weight_kg       numeric(20,6),
  note            text,
  other_bodega    boolean NOT NULL DEFAULT false,
  counted_by      uuid NOT NULL,
  counted_at      timestamptz NOT NULL DEFAULT now(),
  client_event_id uuid NOT NULL,
  voided_at       timestamptz,
  voided_by       uuid,
  void_reason     text,
  UNIQUE (campaign_id, client_event_id)
);
-- Un paquete se cuenta una sola vez por campaña y ronda, aunque cambie de zona
CREATE UNIQUE INDEX IF NOT EXISTS wh_count_lines_one_per_round ON public.wh_count_lines (campaign_id, round, package_id) WHERE package_id IS NOT NULL AND voided_at IS NULL;
CREATE INDEX IF NOT EXISTS wh_count_lines_key_idx ON public.wh_count_lines (campaign_id, cod_producto, lote_key);
CREATE INDEX IF NOT EXISTS wh_count_lines_package_idx ON public.wh_count_lines (package_id);

-- Resultado del cuadre al cerrar
CREATE TABLE IF NOT EXISTS public.wh_count_results (
  campaign_id  uuid NOT NULL REFERENCES public.wh_count_campaigns(id),
  cod_producto text NOT NULL,
  lote_key     text NOT NULL,
  ot           text,
  expected_qty numeric(20,6) NOT NULL,
  counted_qty  numeric(20,6) NOT NULL,
  result       text NOT NULL CHECK (result IN ('CUADRA','FALTANTE','SOBRANTE','NO_EN_ERP')),
  reason       text,
  PRIMARY KEY (campaign_id, cod_producto, lote_key)
);

ALTER TABLE public.wh_count_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wh_count_expected ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wh_count_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wh_count_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wh_count_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wh_count_campaigns, public.wh_count_expected, public.wh_count_rounds, public.wh_count_lines, public.wh_count_results FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.wh_count_campaigns, public.wh_count_expected, public.wh_count_rounds, public.wh_count_lines, public.wh_count_results TO service_role;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['wh_count_campaigns','wh_count_expected','wh_count_rounds','wh_count_lines','wh_count_results'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS security_active_account ON public.%I', t);
    EXECUTE format('CREATE POLICY security_active_account ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()))', t);
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- Ayudantes
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wh_lote_key(p text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$ SELECT coalesce(public.erp_lote_doc(p), '') $$;

CREATE OR REPLACE FUNCTION public.wh_count_open_campaign(p_bodega text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM public.wh_count_campaigns WHERE bodega = p_bodega AND status IN ('EN_CONTEO','EN_REVISION');
$$;

CREATE OR REPLACE FUNCTION public.wh_count_can_count()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-carga','almacen-supervisor']);
$$;

-- Ronda vigente del lote en la campaña
CREATE OR REPLACE FUNCTION public.wh_count_round(p_campaign uuid, p_product text, p_lote_key text)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT round FROM public.wh_count_rounds WHERE campaign_id = p_campaign AND cod_producto = p_product AND lote_key = p_lote_key), 1);
$$;

-- Congelamiento y retención en cualquier camino que mueva paquetes (picking, carga, IPT). Las funciones del inventario
-- marcan wh.count_op para operar sobre la bodega congelada.
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
  IF OLD.status IN ('AVAILABLE','RESERVED') AND NEW.status IN ('PICKED','PACKED','LOADED') THEN
    IF OLD.count_hold THEN RAISE EXCEPTION 'El paquete % está retenido por el inventario hasta su cierre', OLD.package_code; END IF;
    IF public.wh_count_open_campaign(OLD.source_warehouse) IS NOT NULL THEN
      RAISE EXCEPTION 'La bodega % está en inventario: no se puede despachar hasta cerrar la campaña', OLD.source_warehouse;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS wh_packages_count_guard ON public.wh_packages;
CREATE TRIGGER wh_packages_count_guard BEFORE INSERT OR UPDATE OF status ON public.wh_packages FOR EACH ROW EXECUTE FUNCTION public.wh_packages_count_guard();

-- ------------------------------------------------------------
-- Campañas
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wh_count_open(p_bodega text, p_zones text[] DEFAULT '{}', p_notes text DEFAULT NULL, p_site_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_import uuid; v_site uuid := p_site_id; v_id uuid := gen_random_uuid(); v_code text; v_n integer;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN RAISE EXCEPTION 'Solo supervisión abre un inventario' USING ERRCODE = '42501'; END IF;
  SELECT id INTO v_import FROM public.erp_imports WHERE kind = 'STOCK' AND status = 'ACTIVA';
  IF v_import IS NULL THEN RAISE EXCEPTION 'No hay una carga vigente del Stock Bodega Despacho'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.erp_stock_lots WHERE import_id = v_import AND bodega = p_bodega) THEN
    RAISE EXCEPTION 'La bodega % no figura en el stock ERP vigente', p_bodega;
  END IF;
  IF public.wh_count_open_campaign(p_bodega) IS NOT NULL THEN RAISE EXCEPTION 'Ya hay un inventario abierto en %', p_bodega; END IF;
  IF v_site IS NULL THEN SELECT id INTO v_site FROM public.sites WHERE public.can_access_site(id) ORDER BY code LIMIT 1; END IF;
  IF v_site IS NULL OR NOT public.can_access_site(v_site) THEN RAISE EXCEPTION 'Sede no disponible'; END IF;
  v_code := 'INV-' || to_char(now() AT TIME ZONE 'America/Lima', 'YYMMDD') || '-' || upper(substr(replace(v_id::text, '-', ''), 1, 4));
  INSERT INTO public.wh_count_campaigns (id, code, site_id, bodega, zones, erp_import_id, notes, created_by)
  VALUES (v_id, v_code, v_site, p_bodega, coalesce(p_zones, '{}'), v_import, nullif(btrim(p_notes), ''), auth.uid());
  INSERT INTO public.wh_count_expected (campaign_id, linea, cod_producto, producto, lote, lote_raw, lote_key, ot, unidad, stock, kg)
  SELECT v_id, linea, cod_producto, producto, lote, lote_raw, public.wh_lote_key(coalesce(lote, lote_raw)), ot, unidad, stock, kg
  FROM public.erp_stock_lots WHERE import_id = v_import AND bodega = p_bodega AND stock <> 0;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  -- La carga usada conserva sus filas aunque llegue otra
  UPDATE public.erp_imports SET retained = true WHERE id = v_import;
  RETURN jsonb_build_object('id', v_id, 'code', v_code, 'expected_lines', v_n);
END $$;

CREATE OR REPLACE FUNCTION public.wh_count_board(p_campaign uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT (public.wh_any_warehouse_permission() OR public.wh_count_can_count()) THEN RAISE EXCEPTION 'Sin acceso al almacén' USING ERRCODE = '42501'; END IF;
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC) FROM (
    SELECT c.id, c.code, c.bodega, c.zones, c.status, c.notes, c.created_at, c.closed_at, c.close_note,
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

-- Líneas esperadas para identificar un rótulo (con lo contado en la ronda vigente)
CREATE OR REPLACE FUNCTION public.wh_count_expected_search(p_campaign uuid, p_search text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_q text := nullif(upper(btrim(p_search)), '');
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT (public.wh_any_warehouse_permission() OR public.wh_count_can_count()) THEN RAISE EXCEPTION 'Sin acceso al almacén' USING ERRCODE = '42501'; END IF;
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (
    SELECT e.linea, e.cod_producto, e.producto, e.lote, e.lote_raw, e.lote_key, e.ot, e.unidad, e.stock,
      (SELECT coalesce(sum(l.quantity), 0) FROM public.wh_count_lines l WHERE l.campaign_id = e.campaign_id AND l.voided_at IS NULL
         AND l.cod_producto = e.cod_producto AND l.lote_key = e.lote_key AND l.round = public.wh_count_round(e.campaign_id, e.cod_producto, e.lote_key)) AS counted
    FROM public.wh_count_expected e
    WHERE e.campaign_id = p_campaign AND (v_q IS NULL OR upper(coalesce(e.ot, '')) LIKE '%' || v_q || '%' OR upper(coalesce(e.lote_raw, '')) LIKE '%' || v_q || '%'
      OR upper(e.lote_key) LIKE '%' || v_q || '%' OR upper(e.cod_producto) LIKE '%' || v_q || '%' OR upper(coalesce(e.producto, '')) LIKE '%' || v_q || '%')
    ORDER BY e.ot NULLS LAST, e.lote_key, e.cod_producto LIMIT 50) x), '[]'::jsonb);
END $$;

-- Valida que la campaña admite conteo del lote por este usuario y devuelve la ronda vigente
CREATE OR REPLACE FUNCTION public.wh_count_check(c public.wh_count_campaigns, p_product text, p_lote_key text)
RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_round integer := public.wh_count_round(c.id, p_product, p_lote_key);
BEGIN
  IF c.status = 'EN_REVISION' AND v_round = 1 THEN RAISE EXCEPTION 'La campaña está en revisión: solo se cuentan los lotes en reconteo'; END IF;
  IF c.status NOT IN ('EN_CONTEO','EN_REVISION') THEN RAISE EXCEPTION 'La campaña no está abierta'; END IF;
  -- El reconteo lo hace un operario distinto al de la ronda anterior
  IF v_round > 1 AND EXISTS (SELECT 1 FROM public.wh_count_lines WHERE campaign_id = c.id AND cod_producto = p_product AND lote_key = p_lote_key
       AND round = v_round - 1 AND voided_at IS NULL AND counted_by = auth.uid()) THEN
    RAISE EXCEPTION 'El reconteo de este lote lo debe hacer un operario distinto';
  END IF;
  RETURN v_round;
END $$;

-- Bulto con etiqueta: se escanea y queda contado
CREATE OR REPLACE FUNCTION public.wh_count_scan(p_campaign uuid, p_code text, p_zone text DEFAULT NULL, p_client_event_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c public.wh_count_campaigns; p public.wh_packages; v_round integer; v_event uuid := coalesce(p_client_event_id, gen_random_uuid()); v_key text; v_prev bigint;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_count_can_count() THEN RAISE EXCEPTION 'Sin permiso de inventario' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM public.wh_count_campaigns WHERE id = p_campaign FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(c.site_id) THEN RAISE EXCEPTION 'Campaña no disponible'; END IF;
  SELECT id INTO v_prev FROM public.wh_count_lines WHERE campaign_id = c.id AND client_event_id = v_event;
  IF v_prev IS NOT NULL THEN RETURN jsonb_build_object('line_id', v_prev, 'duplicate_retry', true); END IF;
  SELECT * INTO p FROM public.wh_packages WHERE package_code = upper(btrim(p_code)) AND site_id = c.site_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Código % no registrado: si el bulto solo tiene rótulo, etiquételo', p_code; END IF;
  IF p.status = 'VOID' THEN RAISE EXCEPTION 'El paquete % está anulado', p.package_code; END IF;
  IF p.status = 'LOADED' THEN RAISE EXCEPTION 'El paquete % figura como cargado en un despacho', p.package_code; END IF;
  v_key := public.wh_lote_key(p.source_lot);
  v_round := public.wh_count_check(c, p.source_product_code, v_key);
  IF EXISTS (SELECT 1 FROM public.wh_count_lines WHERE campaign_id = c.id AND round = v_round AND package_id = p.id AND voided_at IS NULL) THEN
    RAISE EXCEPTION 'El paquete % ya fue contado en esta campaña', p.package_code;
  END IF;
  INSERT INTO public.wh_count_lines (campaign_id, round, package_id, origin, zone, cod_producto, lote_key, ot, quantity, weight_kg, other_bodega, counted_by, client_event_id)
  VALUES (c.id, v_round, p.id, 'ETIQUETA', nullif(btrim(p_zone), ''), p.source_product_code, v_key, p.source_contract_code, p.quantity, p.weight_kg,
          p.source_warehouse <> c.bodega, auth.uid(), v_event)
  RETURNING id INTO v_prev;
  RETURN jsonb_build_object('line_id', v_prev, 'package_code', p.package_code, 'product', p.source_product_code, 'description', p.description,
    'lote', p.source_lot, 'ot', p.source_contract_code, 'quantity', p.quantity, 'unit', p.unit, 'other_bodega', p.source_warehouse <> c.bodega, 'round', v_round);
END $$;

-- Bulto con rótulo: se identifica contra una línea esperada, se crea el PKG (retenido) y queda contado e impreso
CREATE OR REPLACE FUNCTION public.wh_count_label(p_campaign uuid, p_linea integer, p_quantity numeric, p_weight_kg numeric DEFAULT NULL,
  p_zone text DEFAULT NULL, p_ipt_doc text DEFAULT NULL, p_seq integer DEFAULT NULL, p_total integer DEFAULT NULL,
  p_confirm_over boolean DEFAULT false, p_client_event_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
    IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN RAISE EXCEPTION 'Solo supervisión confirma un conteo que supera el stock del ERP' USING ERRCODE = '42501'; END IF;
  END IF;

  SELECT id INTO v_contract FROM public.contracts WHERE code = e.ot ORDER BY created_at LIMIT 1;
  v_code := 'PKG-' || to_char(now() AT TIME ZONE 'America/Lima', 'YYMMDD') || '-' || upper(substr(replace(v_id::text, '-', ''), 1, 8));
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
END $$;

-- Bulto que no se puede identificar: queda registrado para supervisión
CREATE OR REPLACE FUNCTION public.wh_count_unidentified(p_campaign uuid, p_note text, p_zone text DEFAULT NULL, p_client_event_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c public.wh_count_campaigns; v_line bigint; v_event uuid := coalesce(p_client_event_id, gen_random_uuid());
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_count_can_count() THEN RAISE EXCEPTION 'Sin permiso de inventario' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM public.wh_count_campaigns WHERE id = p_campaign FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(c.site_id) THEN RAISE EXCEPTION 'Campaña no disponible'; END IF;
  IF c.status <> 'EN_CONTEO' THEN RAISE EXCEPTION 'La campaña no está en conteo'; END IF;
  IF nullif(btrim(p_note), '') IS NULL THEN RAISE EXCEPTION 'Describa el bulto y lo que dice su rótulo'; END IF;
  INSERT INTO public.wh_count_lines (campaign_id, origin, zone, note, counted_by, client_event_id)
  VALUES (c.id, 'NO_IDENTIFICADO', nullif(btrim(p_zone), ''), btrim(p_note), auth.uid(), v_event)
  ON CONFLICT (campaign_id, client_event_id) DO NOTHING RETURNING id INTO v_line;
  RETURN jsonb_build_object('line_id', v_line);
END $$;

-- Anular una línea contada (error de conteo). Si creó un paquete, el paquete también se anula.
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
  END IF;
  RETURN jsonb_build_object('success', true);
END $$;

CREATE OR REPLACE FUNCTION public.wh_count_lines_list(p_campaign uuid, p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT (public.wh_any_warehouse_permission() OR public.wh_count_can_count()) THEN RAISE EXCEPTION 'Sin acceso al almacén' USING ERRCODE = '42501'; END IF;
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.counted_at DESC) FROM (
    SELECT l.id, l.round, l.origin, l.zone, l.cod_producto, l.lote_key, l.ot, l.quantity, l.weight_kg, l.note, l.other_bodega, l.counted_at,
      public.wh_profile_name(l.counted_by) AS counted_by_name, l.counted_by = auth.uid() AS mine, p.package_code, p.description, p.unit
    FROM public.wh_count_lines l LEFT JOIN public.wh_packages p ON p.id = l.package_id
    JOIN public.wh_count_campaigns c ON c.id = l.campaign_id
    WHERE l.campaign_id = p_campaign AND l.voided_at IS NULL AND public.can_access_site(c.site_id)
    ORDER BY l.counted_at DESC LIMIT least(greatest(coalesce(p_limit, 200), 1), 1000)) x), '[]'::jsonb);
END $$;

-- ------------------------------------------------------------
-- Fase 3: cuadre, reconteo y cierre
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wh_count_summary(p_campaign uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT (public.wh_any_warehouse_permission() OR public.wh_count_can_count()) THEN RAISE EXCEPTION 'Sin acceso al almacén' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.wh_count_campaigns WHERE id = p_campaign AND public.can_access_site(site_id)) THEN RAISE EXCEPTION 'Campaña no disponible'; END IF;
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.result = 'CUADRA', x.ot NULLS LAST, x.lote_key, x.cod_producto) FROM (
    WITH ex AS (SELECT cod_producto, lote_key, max(ot) AS ot, max(producto) AS producto, max(unidad) AS unidad, sum(stock) AS expected
                FROM public.wh_count_expected WHERE campaign_id = p_campaign GROUP BY 1, 2),
    ct AS (SELECT l.cod_producto, l.lote_key, max(l.ot) AS ot, sum(l.quantity) AS counted, count(*) AS bultos
           FROM public.wh_count_lines l
           WHERE l.campaign_id = p_campaign AND l.voided_at IS NULL AND l.origin <> 'NO_IDENTIFICADO'
             AND l.round = public.wh_count_round(p_campaign, l.cod_producto, l.lote_key)
           GROUP BY 1, 2)
    SELECT coalesce(ex.cod_producto, ct.cod_producto) AS cod_producto, coalesce(ex.lote_key, ct.lote_key) AS lote_key,
      coalesce(ex.ot, ct.ot) AS ot, ex.producto, ex.unidad, coalesce(ex.expected, 0) AS expected, coalesce(ct.counted, 0) AS counted,
      coalesce(ct.bultos, 0) AS bultos, coalesce(ct.counted, 0) - coalesce(ex.expected, 0) AS diff,
      public.wh_count_round(p_campaign, coalesce(ex.cod_producto, ct.cod_producto), coalesce(ex.lote_key, ct.lote_key)) AS round,
      CASE WHEN ex.cod_producto IS NULL THEN 'NO_EN_ERP'
           WHEN abs(coalesce(ct.counted, 0) - ex.expected) < 0.0005 THEN 'CUADRA'
           WHEN coalesce(ct.counted, 0) < ex.expected THEN 'FALTANTE' ELSE 'SOBRANTE' END AS result
    FROM ex FULL JOIN ct ON ct.cod_producto = ex.cod_producto AND ct.lote_key = ex.lote_key) x), '[]'::jsonb);
END $$;

-- Pasa la campaña a revisión (termina el conteo general)
CREATE OR REPLACE FUNCTION public.wh_count_to_review(p_campaign uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c public.wh_count_campaigns;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN RAISE EXCEPTION 'Solo supervisión' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM public.wh_count_campaigns WHERE id = p_campaign FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(c.site_id) OR c.status <> 'EN_CONTEO' THEN RAISE EXCEPTION 'La campaña no está en conteo'; END IF;
  UPDATE public.wh_count_campaigns SET status = 'EN_REVISION' WHERE id = c.id;
  RETURN jsonb_build_object('success', true);
END $$;

-- Reconteo de lotes con diferencia: abre una ronda nueva para esos lotes
CREATE OR REPLACE FUNCTION public.wh_count_recount(p_campaign uuid, p_lots jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c public.wh_count_campaigns; v jsonb; v_n integer := 0;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN RAISE EXCEPTION 'Solo supervisión pide reconteo' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM public.wh_count_campaigns WHERE id = p_campaign FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(c.site_id) OR c.status NOT IN ('EN_CONTEO','EN_REVISION') THEN RAISE EXCEPTION 'La campaña no está abierta'; END IF;
  IF jsonb_typeof(p_lots) <> 'array' OR jsonb_array_length(p_lots) = 0 THEN RAISE EXCEPTION 'Seleccione los lotes a recontar'; END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(p_lots) LOOP
    INSERT INTO public.wh_count_rounds (campaign_id, cod_producto, lote_key, round, requested_by)
    VALUES (c.id, v->>'cod_producto', coalesce(v->>'lote_key', ''), 2, auth.uid())
    ON CONFLICT (campaign_id, cod_producto, lote_key) DO UPDATE SET round = wh_count_rounds.round + 1, requested_by = auth.uid(), requested_at = now();
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'lots', v_n);
END $$;

-- Cierre: cada diferencia con motivo; libera los paquetes retenidos y la carga del ERP retenida
CREATE OR REPLACE FUNCTION public.wh_count_close(p_campaign uuid, p_reasons jsonb DEFAULT '{}', p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c public.wh_count_campaigns; r jsonb; v_missing integer; v_released integer;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN RAISE EXCEPTION 'Solo supervisión cierra el inventario' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM public.wh_count_campaigns WHERE id = p_campaign FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(c.site_id) OR c.status NOT IN ('EN_CONTEO','EN_REVISION') THEN RAISE EXCEPTION 'La campaña no está abierta'; END IF;
  IF EXISTS (SELECT 1 FROM public.wh_count_lines WHERE campaign_id = c.id AND origin = 'NO_IDENTIFICADO' AND voided_at IS NULL) THEN
    RAISE EXCEPTION 'Hay bultos no identificados: etiquételos o anule la línea antes de cerrar';
  END IF;
  r := public.wh_count_summary(c.id);
  SELECT count(*) INTO v_missing FROM jsonb_array_elements(r) x
   WHERE x->>'result' <> 'CUADRA' AND nullif(btrim(coalesce(p_reasons->>((x->>'cod_producto') || '|' || (x->>'lote_key')), '')), '') IS NULL;
  IF v_missing > 0 THEN RAISE EXCEPTION 'Registre el motivo de las % diferencias', v_missing; END IF;
  INSERT INTO public.wh_count_results (campaign_id, cod_producto, lote_key, ot, expected_qty, counted_qty, result, reason)
  SELECT c.id, x->>'cod_producto', x->>'lote_key', x->>'ot', (x->>'expected')::numeric, (x->>'counted')::numeric, x->>'result',
    nullif(btrim(coalesce(p_reasons->>((x->>'cod_producto') || '|' || (x->>'lote_key')), '')), '')
  FROM jsonb_array_elements(r) x;
  PERFORM set_config('wh.count_op', 'on', true);
  UPDATE public.wh_packages SET count_hold = false WHERE count_campaign_id = c.id AND count_hold;
  GET DIAGNOSTICS v_released = ROW_COUNT;
  PERFORM set_config('wh.count_op', '', true);
  UPDATE public.wh_count_campaigns SET status = 'CERRADA', closed_by = auth.uid(), closed_at = now(), close_note = nullif(btrim(p_note), '') WHERE id = c.id;
  UPDATE public.erp_imports SET retained = false WHERE id = c.erp_import_id
    AND NOT EXISTS (SELECT 1 FROM public.wh_count_campaigns WHERE erp_import_id = c.erp_import_id AND status IN ('EN_CONTEO','EN_REVISION'));
  RETURN jsonb_build_object('success', true, 'lots', jsonb_array_length(r), 'released_packages', v_released);
END $$;

REVOKE ALL ON FUNCTION public.wh_lote_key(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.wh_count_open_campaign(text), public.wh_count_can_count(), public.wh_count_round(uuid, text, text),
  public.wh_packages_count_guard(), public.wh_count_check(public.wh_count_campaigns, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wh_count_open(text, text[], text, uuid), public.wh_count_board(uuid), public.wh_count_expected_search(uuid, text),
  public.wh_count_scan(uuid, text, text, uuid), public.wh_count_label(uuid, integer, numeric, numeric, text, text, integer, integer, boolean, uuid),
  public.wh_count_unidentified(uuid, text, text, uuid), public.wh_count_void_line(bigint, text), public.wh_count_lines_list(uuid, integer),
  public.wh_count_summary(uuid), public.wh_count_to_review(uuid), public.wh_count_recount(uuid, jsonb), public.wh_count_close(uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_count_open(text, text[], text, uuid), public.wh_count_board(uuid), public.wh_count_expected_search(uuid, text),
  public.wh_count_scan(uuid, text, text, uuid), public.wh_count_label(uuid, integer, numeric, numeric, text, text, integer, integer, boolean, uuid),
  public.wh_count_unidentified(uuid, text, text, uuid), public.wh_count_void_line(bigint, text), public.wh_count_lines_list(uuid, integer),
  public.wh_count_summary(uuid), public.wh_count_to_review(uuid), public.wh_count_recount(uuid, jsonb), public.wh_count_close(uuid, jsonb, text) TO authenticated;
