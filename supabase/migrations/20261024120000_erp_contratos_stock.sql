-- ERP como fuente: «Actualizable Despacho» (usp_Rpt_ChecklistContratosListado) y «Stock Bodega Despacho»
-- (usp_Rpt_StockBodegasListado). Carga manual de los dos Excel: cada carga es una foto completa que reemplaza a la
-- anterior del mismo tipo. Del Actualizable salen las líneas de OT (contrato, despachado, pendiente) y cada despacho
-- por guía; del Stock, el stock por OT o subcontrato (el Lote del ERP es el documento). Cada guía queda con dos fechas:
-- la del ERP y la del TMS (salida programada de la ruta que la llevó).
BEGIN;

CREATE TABLE IF NOT EXISTS public.erp_imports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('CONTRATOS', 'STOCK')),
  status      text NOT NULL DEFAULT 'CARGANDO' CHECK (status IN ('CARGANDO', 'ACTIVA', 'REEMPLAZADA')),
  file_name   text NOT NULL,
  cut_at      timestamptz,
  expected    integer NOT NULL CHECK (expected > 0),
  rows_loaded integer NOT NULL DEFAULT 0,
  summary     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  applied_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS erp_imports_one_active ON public.erp_imports (kind) WHERE status = 'ACTIVA';

CREATE TABLE IF NOT EXISTS public.erp_contract_lines (
  import_id          uuid NOT NULL REFERENCES public.erp_imports(id) ON DELETE CASCADE,
  nro_documento      text NOT NULL,
  secuencia          integer NOT NULL,
  ot                 text NOT NULL,
  tipo_documento     text,
  correlativo        bigint,
  fecha_contrato     date,
  fecha_vcto         date,
  vigencia           text,
  ruc                text,
  cliente            text,
  cod_producto       text NOT NULL,
  producto           text,
  color              text,
  unidad             text,
  cant_contrato      numeric(20,6) NOT NULL DEFAULT 0,
  cant_despachada    numeric(20,6) NOT NULL DEFAULT 0,
  cant_reemplazada   numeric(20,6) NOT NULL DEFAULT 0,
  cant_pendiente     numeric(20,6) NOT NULL DEFAULT 0,
  estado             text,
  nro_guias          integer NOT NULL DEFAULT 0,
  fecha_ult_despacho date,
  tipo_producto      text,
  tipo               text,
  familia            text,
  subfamilia         text,
  peso_unit          numeric(20,6),
  PRIMARY KEY (import_id, nro_documento, secuencia)
);
CREATE INDEX IF NOT EXISTS erp_contract_lines_ot_idx ON public.erp_contract_lines (import_id, ot);
CREATE INDEX IF NOT EXISTS erp_contract_lines_doc_sku_idx ON public.erp_contract_lines (import_id, nro_documento, cod_producto);

-- Un despacho por guía: Guía_1…Guía_6 y «Guias_Adicionales» de cada línea
CREATE TABLE IF NOT EXISTS public.erp_contract_guias (
  import_id     uuid NOT NULL REFERENCES public.erp_imports(id) ON DELETE CASCADE,
  nro_documento text NOT NULL,
  secuencia     integer NOT NULL,
  guia          text NOT NULL,
  guia_key      text NOT NULL,
  cantidad      numeric(20,6) NOT NULL,
  posicion      integer NOT NULL,
  PRIMARY KEY (import_id, nro_documento, secuencia, guia)
);
CREATE INDEX IF NOT EXISTS erp_contract_guias_key_idx ON public.erp_contract_guias (import_id, guia_key);

-- Fecha ERP de cada guía, calculada al aplicar la carga
CREATE TABLE IF NOT EXISTS public.erp_guia_fechas (
  import_id uuid NOT NULL REFERENCES public.erp_imports(id) ON DELETE CASCADE,
  guia_key  text NOT NULL,
  guia      text NOT NULL,
  fecha     date,
  exacta    boolean NOT NULL DEFAULT false,
  fuente    text NOT NULL,
  PRIMARY KEY (import_id, guia_key)
);

CREATE TABLE IF NOT EXISTS public.erp_stock_lots (
  import_id          uuid NOT NULL REFERENCES public.erp_imports(id) ON DELETE CASCADE,
  linea              integer NOT NULL,
  bodega             text NOT NULL,
  cod_producto       text NOT NULL,
  producto           text,
  tipo_producto      text,
  unidad             text,
  factor             numeric NOT NULL DEFAULT 1,
  lote_raw           text,
  lote               text,
  ot                 text,
  stock              numeric(20,6) NOT NULL DEFAULT 0,
  stock_falla        numeric(20,6) NOT NULL DEFAULT 0,
  stock_comprometido numeric(20,6),
  requerimiento      numeric(20,6),
  orden_compra       numeric(20,6),
  peso_unitario      numeric(20,6),
  peso_total         numeric(20,6),
  -- Peso real: el «Peso_Unitario» del ERP es por unidad aunque el stock esté en cientos (su Peso_Total queda 100 veces bajo)
  kg                 numeric(20,6),
  familia            text,
  subfamilia         text,
  PRIMARY KEY (import_id, linea)
);
CREATE INDEX IF NOT EXISTS erp_stock_lots_doc_idx ON public.erp_stock_lots (import_id, lote, cod_producto);

ALTER TABLE public.erp_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_contract_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_contract_guias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_guia_fechas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_stock_lots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_imports FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.erp_contract_lines FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.erp_contract_guias FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.erp_guia_fechas FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.erp_stock_lots FROM PUBLIC, anon, authenticated;
-- Solo se leen y escriben por las funciones erp_*; la política exige además una cuenta activa
DROP POLICY IF EXISTS security_active_account ON public.erp_imports;
CREATE POLICY security_active_account ON public.erp_imports AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.erp_contract_lines;
CREATE POLICY security_active_account ON public.erp_contract_lines AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.erp_contract_guias;
CREATE POLICY security_active_account ON public.erp_contract_guias AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.erp_guia_fechas;
CREATE POLICY security_active_account ON public.erp_guia_fechas AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.erp_stock_lots;
CREATE POLICY security_active_account ON public.erp_stock_lots AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));

-- Lote del ERP → documento: sin ceros a la izquierda («0000016037» = 16037); «16497-S001» se mantiene
CREATE OR REPLACE FUNCTION public.erp_lote_doc(p text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN v = '' THEN NULL
    WHEN v ~ '^0*[0-9]+(-[A-Z][0-9]+)?$' THEN COALESCE(NULLIF(regexp_replace(v, '^0+', ''), ''), '0')
    ELSE v END
  FROM (SELECT upper(btrim(COALESCE(p, ''))) AS v) z;
$$;

-- Unidad del ERP: «CIEN» = cientos (el contrato va en unidades)
CREATE OR REPLACE FUNCTION public.erp_unit_factor(p text)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE upper(btrim(COALESCE(p, ''))) WHEN 'CIEN' THEN 100 WHEN 'MIL' THEN 1000 ELSE 1 END::numeric;
$$;

CREATE OR REPLACE FUNCTION public.erp_active_import(p_kind text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM public.erp_imports WHERE kind = p_kind AND status = 'ACTIVA';
$$;
REVOKE ALL ON FUNCTION public.erp_active_import(text) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- Carga: iniciar, enviar filas por bloques (reintento seguro) y aplicar
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.erp_upload_begin(p_kind text, p_file_name text, p_cut_at timestamptz, p_expected integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.apt_can_load() THEN RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar datos del ERP'); END IF;
  IF p_kind NOT IN ('CONTRATOS', 'STOCK') THEN RETURN jsonb_build_object('success', false, 'error', 'Tipo de archivo no válido'); END IF;
  IF COALESCE(p_expected, 0) <= 0 THEN RETURN jsonb_build_object('success', false, 'error', 'El archivo no tiene filas'); END IF;
  DELETE FROM public.erp_imports WHERE status = 'CARGANDO' AND created_at < now() - interval '1 day';
  INSERT INTO public.erp_imports (kind, file_name, cut_at, expected, created_by)
  VALUES (p_kind, left(COALESCE(NULLIF(btrim(p_file_name), ''), 'archivo.xlsx'), 300), p_cut_at, p_expected, auth.uid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', true, 'upload_id', v_id);
END $$;

-- Filas con las columnas ya normalizadas por el navegador (claves en minúscula). Las líneas del Actualizable traen
-- «guias»: [{ g, c, p }] (guía, cantidad, posición).
CREATE OR REPLACE FUNCTION public.erp_upload_rows(p_upload_id uuid, p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_kind text; v_n integer;
BEGIN
  IF NOT public.apt_can_load() THEN RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar datos del ERP'); END IF;
  SELECT kind INTO v_kind FROM public.erp_imports WHERE id = p_upload_id AND status = 'CARGANDO' FOR UPDATE;
  IF v_kind IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'La carga no existe o ya fue aplicada'); END IF;
  IF jsonb_typeof(p_rows) <> 'array' THEN RETURN jsonb_build_object('success', false, 'error', 'Formato de filas no válido'); END IF;

  IF v_kind = 'CONTRATOS' THEN
    INSERT INTO public.erp_contract_lines (import_id, nro_documento, secuencia, ot, tipo_documento, correlativo, fecha_contrato, fecha_vcto,
      vigencia, ruc, cliente, cod_producto, producto, color, unidad, cant_contrato, cant_despachada, cant_reemplazada, cant_pendiente,
      estado, nro_guias, fecha_ult_despacho, tipo_producto, tipo, familia, subfamilia)
    SELECT p_upload_id, btrim(r->>'nro_documento'), (r->>'secuencia')::integer,
      COALESCE(NULLIF(btrim(r->>'nro_contrato'), ''), split_part(btrim(r->>'nro_documento'), '-', 1)),
      NULLIF(btrim(r->>'tipo_documento'), ''), NULLIF(r->>'correlativo', '')::bigint, NULLIF(r->>'fecha_contrato', '')::date,
      NULLIF(r->>'fecha_vcto', '')::date, NULLIF(btrim(r->>'vigencia'), ''), NULLIF(btrim(r->>'ruc'), ''), NULLIF(btrim(r->>'cliente'), ''),
      btrim(r->>'cod_producto'), NULLIF(btrim(r->>'producto'), ''), NULLIF(btrim(r->>'color'), ''),
      CASE upper(btrim(COALESCE(r->>'unidad', ''))) WHEN 'UNID' THEN 'UND' WHEN '' THEN NULL ELSE upper(btrim(r->>'unidad')) END,
      COALESCE(NULLIF(r->>'cant_contrato', '')::numeric, 0), COALESCE(NULLIF(r->>'cant_despachada', '')::numeric, 0),
      COALESCE(NULLIF(r->>'cant_reemplazada', '')::numeric, 0), COALESCE(NULLIF(r->>'cant_pendiente', '')::numeric, 0),
      NULLIF(btrim(r->>'estado'), ''), COALESCE(NULLIF(r->>'nro_guias', '')::integer, 0), NULLIF(r->>'fecha_ult_despacho', '')::date,
      NULLIF(btrim(r->>'tipo_producto'), ''), NULLIF(btrim(r->>'tipo'), ''), NULLIF(btrim(r->>'familia'), ''), NULLIF(btrim(r->>'subfamilia'), '')
    FROM jsonb_array_elements(p_rows) r
    WHERE NULLIF(btrim(r->>'nro_documento'), '') IS NOT NULL AND NULLIF(r->>'secuencia', '') IS NOT NULL AND NULLIF(btrim(r->>'cod_producto'), '') IS NOT NULL
    ON CONFLICT DO NOTHING;
    INSERT INTO public.erp_contract_guias (import_id, nro_documento, secuencia, guia, guia_key, cantidad, posicion)
    SELECT p_upload_id, btrim(r->>'nro_documento'), (r->>'secuencia')::integer, upper(btrim(g->>'g')), public.apt_guia_key(g->>'g'),
      (g->>'c')::numeric, COALESCE((g->>'p')::integer, 0)
    FROM jsonb_array_elements(p_rows) r, jsonb_array_elements(COALESCE(r->'guias', '[]'::jsonb)) g
    WHERE NULLIF(btrim(r->>'nro_documento'), '') IS NOT NULL AND NULLIF(r->>'secuencia', '') IS NOT NULL
      AND NULLIF(btrim(g->>'g'), '') IS NOT NULL AND NULLIF(g->>'c', '') IS NOT NULL
    ON CONFLICT DO NOTHING;
    SELECT count(*) INTO v_n FROM public.erp_contract_lines WHERE import_id = p_upload_id;
  ELSE
    INSERT INTO public.erp_stock_lots (import_id, linea, bodega, cod_producto, producto, tipo_producto, unidad, factor, lote_raw, lote, ot,
      stock, stock_falla, stock_comprometido, requerimiento, orden_compra, peso_unitario, peso_total, kg, familia, subfamilia)
    SELECT p_upload_id, (r->>'linea')::integer, btrim(r->>'bodega'), btrim(r->>'cod_producto'), NULLIF(btrim(r->>'producto'), ''),
      NULLIF(btrim(r->>'tipo_producto'), ''), NULLIF(upper(btrim(r->>'unidad')), ''), public.erp_unit_factor(r->>'unidad'),
      NULLIF(btrim(r->>'lote'), ''), public.erp_lote_doc(r->>'lote'),
      NULLIF(substring(public.erp_lote_doc(r->>'lote') FROM '^([0-9]+)'), ''),
      COALESCE(NULLIF(r->>'stock', '')::numeric, 0), COALESCE(NULLIF(r->>'stock_falla', '')::numeric, 0),
      NULLIF(r->>'stock_comprometido', '')::numeric, NULLIF(r->>'requerimiento', '')::numeric, NULLIF(r->>'orden_compra', '')::numeric,
      NULLIF(r->>'peso_unitario', '')::numeric, NULLIF(r->>'peso_total', '')::numeric,
      CASE WHEN NULLIF(r->>'peso_unitario', '')::numeric > 0
        THEN COALESCE(NULLIF(r->>'stock', '')::numeric, 0) * public.erp_unit_factor(r->>'unidad') * (r->>'peso_unitario')::numeric
        ELSE NULLIF(r->>'peso_total', '')::numeric END,
      NULLIF(btrim(r->>'familia'), ''), NULLIF(btrim(r->>'subfamilia'), '')
    FROM jsonb_array_elements(p_rows) r
    WHERE NULLIF(r->>'linea', '') IS NOT NULL AND NULLIF(btrim(r->>'bodega'), '') IS NOT NULL AND NULLIF(btrim(r->>'cod_producto'), '') IS NOT NULL
    ON CONFLICT DO NOTHING;
    SELECT count(*) INTO v_n FROM public.erp_stock_lots WHERE import_id = p_upload_id;
  END IF;
  UPDATE public.erp_imports SET rows_loaded = v_n WHERE id = p_upload_id;
  RETURN jsonb_build_object('success', true, 'rows', v_n);
END $$;

-- Peso unitario por SKU (kg por unidad del contrato): Stock del ERP y, si falta, las Salidas del inventario. En ambos el
-- peso unitario del ERP ya es por unidad, también en los productos que se mueven en cientos.
CREATE OR REPLACE FUNCTION public.erp_refresh_peso()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); v_s uuid := public.erp_active_import('STOCK');
BEGIN
  IF v_c IS NULL THEN RETURN; END IF;
  EXECUTE $q$
  WITH skus AS MATERIALIZED (SELECT DISTINCT cod_producto FROM public.erp_contract_lines WHERE import_id = $1),
  st AS (SELECT cod_producto, max(peso_unitario) AS pu FROM public.erp_stock_lots
         WHERE import_id = $2 AND peso_unitario > 0 GROUP BY cod_producto),
  mv AS (SELECT m.producto AS cod_producto, max(m.peso_unit) AS pu FROM public.inv_movements m
         WHERE m.active AND m.peso_unit > 0 AND m.producto IN (SELECT cod_producto FROM skus) GROUP BY m.producto)
  UPDATE public.erp_contract_lines l SET peso_unit = COALESCE(st.pu, mv.pu)
  FROM skus LEFT JOIN st USING (cod_producto) LEFT JOIN mv USING (cod_producto)
  WHERE l.import_id = $1 AND l.cod_producto = skus.cod_producto AND l.peso_unit IS DISTINCT FROM COALESCE(st.pu, mv.pu)$q$ USING v_c, v_s;
END $$;
REVOKE ALL ON FUNCTION public.erp_refresh_peso() FROM PUBLIC, anon, authenticated;

-- Las funciones erp_* recorren decenas de miles de filas por carga: con estadísticas recién cambiadas el planificador
-- puede estimar 1 fila y elegir bucles anidados que no terminan. Se fuerzan uniones hash (SET enable_nestloop = off).

-- Aplicar: lo ejecuta el servidor (/api/erp/aplicar, sin el límite de 8 s del navegador) tras verificar el permiso;
-- erp_upload_apply es el respaldo desde el navegador
CREATE OR REPLACE FUNCTION public.erp_upload_apply_core(p_upload_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
DECLARE v public.erp_imports; v_summary jsonb;
BEGIN
  SELECT * INTO v FROM public.erp_imports WHERE id = p_upload_id FOR UPDATE;
  IF v.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'La carga no existe'); END IF;
  IF v.status = 'ACTIVA' THEN RETURN jsonb_build_object('success', true, 'rows', v.rows_loaded, 'summary', v.summary, 'duplicate', true); END IF;
  IF v.status <> 'CARGANDO' THEN RETURN jsonb_build_object('success', false, 'error', 'La carga ya fue reemplazada'); END IF;
  IF v.rows_loaded < v.expected THEN
    RETURN jsonb_build_object('success', false, 'error', format('Llegaron %s de %s filas; reanude la carga', v.rows_loaded, v.expected), 'partial', true);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('erp_import_' || v.kind));

  -- La foto anterior del mismo tipo queda como historial (sin filas)
  DELETE FROM public.erp_contract_lines WHERE import_id IN (SELECT id FROM public.erp_imports WHERE kind = v.kind AND status = 'ACTIVA');
  DELETE FROM public.erp_stock_lots WHERE import_id IN (SELECT id FROM public.erp_imports WHERE kind = v.kind AND status = 'ACTIVA');
  DELETE FROM public.erp_contract_guias WHERE import_id IN (SELECT id FROM public.erp_imports WHERE kind = v.kind AND status = 'ACTIVA');
  DELETE FROM public.erp_guia_fechas WHERE import_id IN (SELECT id FROM public.erp_imports WHERE kind = v.kind AND status = 'ACTIVA');
  UPDATE public.erp_imports SET status = 'REEMPLAZADA' WHERE kind = v.kind AND status = 'ACTIVA';
  UPDATE public.erp_imports SET status = 'ACTIVA', applied_at = now() WHERE id = v.id;

  IF v.kind = 'CONTRATOS' THEN
    -- Fecha ERP por guía: exacta si alguna línea la tiene como única guía o si está en las Salidas del inventario;
    -- si no, la del último despacho de la línea (aproximada: nunca anterior a la real)
    -- Estadísticas al día y SQL dinámico: un plan por carga (con un plan genérico la clave de guía se recalcula
    -- sobre todas las Salidas por cada guía y la carga no termina)
    ANALYZE public.erp_contract_lines; ANALYZE public.erp_contract_guias;
    EXECUTE $q$
    WITH g AS MATERIALIZED (
      SELECT g.guia_key, min(g.guia) AS guia, min(l.fecha_ult_despacho) FILTER (WHERE l.nro_guias = 1) AS f_unica,
        max(l.fecha_ult_despacho) AS f_max
      FROM public.erp_contract_guias g
      JOIN public.erp_contract_lines l ON l.import_id = g.import_id AND l.nro_documento = g.nro_documento AND l.secuencia = g.secuencia
      WHERE g.import_id = $1 GROUP BY g.guia_key),
    -- Las Salidas del inventario se recorren una sola vez
    s AS MATERIALIZED (
      SELECT public.apt_guia_key(m.numero) AS guia_key, m.fecha FROM public.inv_movements m
      WHERE m.active AND m.side = 'S' AND m.fecha >= (SELECT min(fecha_contrato) FROM public.erp_contract_lines WHERE import_id = $1)),
    mv AS (SELECT s.guia_key, min(s.fecha) AS fecha FROM s JOIN g USING (guia_key) WHERE g.f_unica IS NULL GROUP BY s.guia_key)
    INSERT INTO public.erp_guia_fechas (import_id, guia_key, guia, fecha, exacta, fuente)
    SELECT $1, g.guia_key, g.guia, COALESCE(g.f_unica, mv.fecha, g.f_max), (g.f_unica IS NOT NULL OR mv.fecha IS NOT NULL),
      CASE WHEN g.f_unica IS NOT NULL THEN 'ACTUALIZABLE' WHEN mv.fecha IS NOT NULL THEN 'SALIDAS' ELSE 'APROXIMADA' END
    FROM g LEFT JOIN mv USING (guia_key)$q$ USING v.id;
  END IF;
  PERFORM public.erp_refresh_peso();
  ANALYZE public.erp_contract_lines; ANALYZE public.erp_contract_guias; ANALYZE public.erp_guia_fechas; ANALYZE public.erp_stock_lots;

  IF v.kind = 'CONTRATOS' THEN
    SELECT jsonb_build_object('lineas', count(*), 'ots', count(DISTINCT ot), 'documentos', count(DISTINCT nro_documento),
      'clientes', count(DISTINCT ruc), 'guias', (SELECT count(*) FROM public.erp_guia_fechas WHERE import_id = v.id),
      'despachos', (SELECT count(*) FROM public.erp_contract_guias WHERE import_id = v.id),
      'lineas_pendientes', count(*) FILTER (WHERE cant_pendiente > 0),
      'sobredespacho', count(*) FILTER (WHERE cant_pendiente < 0),
      'desde', min(fecha_contrato), 'hasta', max(fecha_contrato))
    INTO v_summary FROM public.erp_contract_lines WHERE import_id = v.id;
  ELSE
    SELECT jsonb_build_object('lotes', count(*), 'bodegas', jsonb_agg(DISTINCT bodega), 'productos', count(DISTINCT cod_producto),
      'kg', round(COALESCE(sum(kg), 0), 1), 'kg_erp', round(COALESCE(sum(peso_total), 0), 1), 'sin_lote', count(*) FILTER (WHERE lote IS NULL),
      'stock_negativo', count(*) FILTER (WHERE stock < 0))
    INTO v_summary FROM public.erp_stock_lots WHERE import_id = v.id;
  END IF;
  UPDATE public.erp_imports SET summary = v_summary WHERE id = v.id;
  RETURN jsonb_build_object('success', true, 'rows', v.rows_loaded, 'summary', v_summary);
END $$;
REVOKE ALL ON FUNCTION public.erp_upload_apply_core(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erp_upload_apply_core(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.erp_upload_apply(p_upload_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apt_can_load() THEN RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar datos del ERP'); END IF;
  RETURN public.erp_upload_apply_core(p_upload_id);
END $$;

-- ------------------------------------------------------------
-- Consultas
-- ------------------------------------------------------------
-- Guías del TMS: la del documento al programar y la de la liquidación (conformidad), con la salida programada de la ruta
CREATE OR REPLACE FUNCTION public.erp_tms_guias(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE (guia_key text, guia text, fecha date, rutas text, placas text, ot text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
  SELECT public.apt_guia_key(x.g), min(upper(x.g)), min(x.fecha), string_agg(DISTINCT x.dispatch_number, ', '),
    string_agg(DISTINCT x.vehicle_plate, ', '), string_agg(DISTINCT x.ot, ', ')
  FROM (
    SELECT btrim(t.g) AS g, (d.scheduled_departure AT TIME ZONE 'America/Lima')::date AS fecha, d.dispatch_number, d.vehicle_plate, c.code AS ot
    FROM public.dispatch_requests dr
    JOIN public.dispatches d ON d.id = dr.dispatch_id
    JOIN public.transport_requests r ON r.id = dr.transport_request_id
    LEFT JOIN public.contracts c ON c.id = r.contract_id
    LEFT JOIN public.delivery_conformities dc ON dc.dispatch_id = dr.dispatch_id AND dc.request_id = dr.transport_request_id
    LEFT JOIN public.delivery_submissions s ON s.id = dc.current_submission_id
    CROSS JOIN LATERAL regexp_split_to_table(concat_ws(',', NULLIF(btrim(dr.document_number), ''), NULLIF(btrim(s.guide_number), '')), '[,;/]+|\s+') t(g)
    WHERE dr.status <> 'CANCELADO' AND d.status <> 'CANCELADO' AND btrim(t.g) ~ '^[A-Za-z0-9]+-[0-9]+$'
      AND (p_from IS NULL OR (d.scheduled_departure AT TIME ZONE 'America/Lima')::date >= p_from)
      AND (p_to IS NULL OR (d.scheduled_departure AT TIME ZONE 'America/Lima')::date <= p_to)
  ) x
  GROUP BY 1;
$$;
REVOKE ALL ON FUNCTION public.erp_tms_guias(date, date) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.erp_estado()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a los datos del ERP'); END IF;
  RETURN jsonb_build_object('success', true, 'can_load', public.apt_can_load(),
    'activas', COALESCE((SELECT jsonb_object_agg(kind, jsonb_build_object('id', id, 'file_name', file_name, 'cut_at', cut_at, 'applied_at', applied_at,
       'rows', rows_loaded, 'summary', summary)) FROM public.erp_imports WHERE status = 'ACTIVA'), '{}'::jsonb),
    'historial', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'status', status, 'file_name', file_name, 'cut_at', cut_at,
       'applied_at', applied_at, 'created_at', created_at, 'rows', rows_loaded) ORDER BY created_at DESC)
       FROM (SELECT * FROM public.erp_imports ORDER BY created_at DESC LIMIT 20) h), '[]'::jsonb));
END $$;

-- Pendiente por línea con el stock del ERP de su documento (OT o subcontrato) y SKU
CREATE OR REPLACE FUNCTION public.erp_lineas_stock(v_c uuid, v_s uuid)
RETURNS TABLE (nro_documento text, secuencia integer, stock numeric, listo numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
  WITH st AS (SELECT lote, cod_producto, sum(stock * factor) AS stock FROM public.erp_stock_lots WHERE import_id = v_s AND lote IS NOT NULL GROUP BY 1, 2),
  ln AS (SELECT l.nro_documento, l.secuencia, l.cod_producto, greatest(l.cant_pendiente, 0) AS pend,
           sum(greatest(l.cant_pendiente, 0)) OVER (PARTITION BY l.nro_documento, l.cod_producto ORDER BY l.secuencia) AS acum
         FROM public.erp_contract_lines l WHERE l.import_id = v_c)
  -- El stock de un documento y SKU se reparte entre sus líneas en orden de secuencia
  SELECT ln.nro_documento, ln.secuencia, st.stock,
    greatest(least(ln.pend, COALESCE(st.stock, 0) - (ln.acum - ln.pend)), 0)
  FROM ln LEFT JOIN st ON st.lote = ln.nro_documento AND st.cod_producto = ln.cod_producto;
$$;
REVOKE ALL ON FUNCTION public.erp_lineas_stock(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Filtros: q (OT, cliente o RUC), estado ('PENDIENTE' por defecto | 'TODAS'), incluir_servicios, incluir_errores, limit
CREATE OR REPLACE FUNCTION public.erp_ots(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); v_s uuid := public.erp_active_import('STOCK'); v_out jsonb;
  v_q text := NULLIF(btrim(p->>'q'), ''); v_all boolean := COALESCE(p->>'estado', 'PENDIENTE') = 'TODAS';
  v_srv boolean := COALESCE((p->>'incluir_servicios')::boolean, false); v_err boolean := COALESCE((p->>'incluir_errores')::boolean, false);
  v_lim integer := least(greatest(COALESCE((p->>'limit')::integer, 300), 1), 2000);
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a los datos del ERP'); END IF;
  IF v_c IS NULL THEN RETURN jsonb_build_object('success', true, 'sin_datos', true, 'ots', '[]'::jsonb); END IF;
  WITH l AS (
    SELECT l.*, s.stock AS stock_doc, s.listo FROM public.erp_contract_lines l
    LEFT JOIN public.erp_lineas_stock(v_c, v_s) s ON s.nro_documento = l.nro_documento AND s.secuencia = l.secuencia
    WHERE l.import_id = v_c
      AND (v_srv OR COALESCE(l.tipo_producto, '') <> 'SERVICIO A TERCEROS')
      AND (v_err OR COALESCE(l.tipo_documento, '') <> 'ERROR DE CONTRATO')),
  o AS (
    SELECT l.ot, max(l.cliente) AS cliente, max(l.ruc) AS ruc, min(l.fecha_contrato) AS fecha_contrato, max(l.fecha_vcto) AS fecha_vcto,
      bool_or(l.vigencia = 'S') AS vigente, count(*) AS lineas, count(DISTINCT l.nro_documento) AS documentos,
      sum(l.cant_contrato) AS contrato, sum(l.cant_despachada) AS despachado, sum(greatest(l.cant_pendiente, 0)) AS pendiente,
      count(*) FILTER (WHERE l.cant_pendiente > 0) AS lineas_pendientes, count(*) FILTER (WHERE l.cant_pendiente < 0) AS sobredespacho,
      sum(COALESCE(l.listo, 0)) AS listo, max(l.fecha_ult_despacho) AS ult_despacho,
      round(sum(greatest(l.cant_pendiente, 0) * l.peso_unit) / 1000, 3) AS t_pendiente,
      round(sum(COALESCE(l.listo, 0) * l.peso_unit) / 1000, 3) AS t_listo,
      bool_and(l.peso_unit IS NOT NULL OR l.cant_pendiente <= 0) AS peso_completo
    FROM l GROUP BY l.ot)
  SELECT jsonb_build_object('success', true, 'total', (SELECT count(*) FROM o WHERE v_all OR pendiente > 0),
    'ots', COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.listo DESC, x.pendiente DESC), '[]'::jsonb))
  INTO v_out
  FROM (SELECT * FROM o WHERE (v_all OR o.pendiente > 0)
          AND (v_q IS NULL OR o.ot ILIKE v_q || '%' OR o.cliente ILIKE '%' || v_q || '%' OR o.ruc ILIKE v_q || '%')
        ORDER BY o.listo DESC, o.pendiente DESC LIMIT v_lim) x;
  RETURN v_out;
END $$;

-- Detalle de una OT: líneas con pendiente y stock, y guías con las dos fechas
CREATE OR REPLACE FUNCTION public.erp_ot_detalle(p_ot text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); v_s uuid := public.erp_active_import('STOCK'); v_ot text := split_part(btrim(COALESCE(p_ot, '')), '-', 1);
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a los datos del ERP'); END IF;
  IF v_c IS NULL OR NOT EXISTS (SELECT 1 FROM public.erp_contract_lines WHERE import_id = v_c AND ot = v_ot) THEN
    RETURN jsonb_build_object('success', false, 'error', 'La OT no está en el Actualizable cargado'); END IF;
  RETURN jsonb_build_object('success', true, 'ot', v_ot,
    'lineas', (SELECT jsonb_agg(jsonb_build_object('documento', l.nro_documento, 'tipo_documento', l.tipo_documento, 'secuencia', l.secuencia,
        'cod_producto', l.cod_producto, 'producto', l.producto, 'color', l.color, 'unidad', l.unidad, 'tipo_producto', l.tipo_producto,
        'contrato', l.cant_contrato, 'despachado', l.cant_despachada, 'pendiente', l.cant_pendiente, 'estado', l.estado, 'guias', l.nro_guias,
        'ult_despacho', l.fecha_ult_despacho, 'stock', s.stock, 'listo', s.listo, 'peso_unit', l.peso_unit, 'cliente', l.cliente,
        'fecha_contrato', l.fecha_contrato, 'vigencia', l.vigencia) ORDER BY l.nro_documento, l.secuencia)
      FROM public.erp_contract_lines l
      LEFT JOIN public.erp_lineas_stock(v_c, v_s) s ON s.nro_documento = l.nro_documento AND s.secuencia = l.secuencia
      WHERE l.import_id = v_c AND l.ot = v_ot),
    'guias', COALESCE((SELECT jsonb_agg(jsonb_build_object('guia', f.guia, 'fecha_erp', f.fecha, 'erp_exacta', f.exacta, 'fecha_tms', t.fecha,
        'rutas', t.rutas, 'placas', t.placas, 'items', g.items, 'cantidad', g.cantidad, 'documentos', g.docs,
        'dif_dias', t.fecha - f.fecha) ORDER BY COALESCE(t.fecha, f.fecha) DESC NULLS LAST)
      FROM (SELECT g.guia_key, count(*) AS items, sum(g.cantidad) AS cantidad, string_agg(DISTINCT g.nro_documento, ', ') AS docs
            FROM public.erp_contract_guias g WHERE g.import_id = v_c AND split_part(g.nro_documento, '-', 1) = v_ot GROUP BY g.guia_key) g
      JOIN public.erp_guia_fechas f ON f.import_id = v_c AND f.guia_key = g.guia_key
      LEFT JOIN public.erp_tms_guias() t ON t.guia_key = g.guia_key), '[]'::jsonb),
    'stock', COALESCE((SELECT jsonb_agg(jsonb_build_object('bodega', s.bodega, 'lote', s.lote_raw, 'cod_producto', s.cod_producto, 'producto', s.producto,
        'stock', s.stock * s.factor, 'unidad', s.unidad, 'kg', s.kg) ORDER BY s.lote, s.cod_producto)
      FROM public.erp_stock_lots s WHERE s.import_id = v_s AND s.ot = v_ot), '[]'::jsonb));
END $$;

-- Guías con fecha ERP y fecha TMS. Filtros: desde, hasta (sobre la fecha de referencia), referencia ('AUTO' | 'ERP' | 'TMS'),
-- origen ('TODAS' | 'AMBOS' | 'SOLO_ERP' | 'SOLO_TMS' | 'DESFASE'), tolerancia (días, 2 por defecto), q (guía u OT), limit
CREATE OR REPLACE FUNCTION public.erp_guias(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); v_out jsonb;
  v_from date := NULLIF(p->>'desde', '')::date; v_to date := NULLIF(p->>'hasta', '')::date;
  v_ref text := COALESCE(NULLIF(p->>'referencia', ''), 'AUTO'); v_origen text := COALESCE(NULLIF(p->>'origen', ''), 'TODAS');
  v_tol integer := greatest(COALESCE((p->>'tolerancia')::integer, 2), 0); v_q text := NULLIF(upper(btrim(p->>'q')), '');
  v_lim integer := least(greatest(COALESCE((p->>'limit')::integer, 500), 1), 3000);
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a los datos del ERP'); END IF;
  IF v_c IS NULL THEN RETURN jsonb_build_object('success', true, 'sin_datos', true, 'guias', '[]'::jsonb); END IF;
  WITH e AS (
    SELECT f.guia_key, f.guia, f.fecha, f.exacta, f.fuente, g.ots, g.docs, g.items, g.cantidad, g.kg, g.cliente
    FROM public.erp_guia_fechas f
    JOIN (SELECT g.guia_key, string_agg(DISTINCT l.ot, ', ') AS ots, string_agg(DISTINCT g.nro_documento, ', ') AS docs, count(*) AS items,
            sum(g.cantidad) AS cantidad, round(sum(g.cantidad * l.peso_unit), 1) AS kg, max(l.cliente) AS cliente
          FROM public.erp_contract_guias g JOIN public.erp_contract_lines l ON l.import_id = g.import_id AND l.nro_documento = g.nro_documento AND l.secuencia = g.secuencia
          WHERE g.import_id = v_c GROUP BY g.guia_key) g USING (guia_key)
    WHERE f.import_id = v_c),
  t AS (SELECT * FROM public.erp_tms_guias()),
  j AS (
    SELECT COALESCE(e.guia, t.guia) AS guia, e.ots, e.docs, e.items, e.cantidad, e.kg, e.cliente, e.fecha AS fecha_erp, e.exacta AS erp_exacta,
      e.fuente AS erp_fuente, t.fecha AS fecha_tms, t.rutas, t.placas, t.ot AS ot_tms,
      CASE WHEN e.guia_key IS NOT NULL AND t.guia_key IS NOT NULL THEN 'AMBOS' WHEN e.guia_key IS NOT NULL THEN 'SOLO_ERP' ELSE 'SOLO_TMS' END AS origen,
      t.fecha - e.fecha AS dif_dias,
      CASE v_ref WHEN 'ERP' THEN e.fecha WHEN 'TMS' THEN t.fecha ELSE COALESCE(t.fecha, e.fecha) END AS fecha_ref,
      -- La OT del TMS no coincide con la del ERP (solo cuando ambas existen)
      (e.ots IS NOT NULL AND t.ot IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM unnest(string_to_array(e.ots, ', ')) a(o) JOIN unnest(string_to_array(t.ot, ', ')) b(o) ON split_part(b.o, '-', 1) = a.o)) AS ot_distinta
    FROM e FULL JOIN t ON t.guia_key = e.guia_key),
  f AS (
    SELECT * FROM j
    WHERE (v_from IS NULL OR fecha_ref >= v_from) AND (v_to IS NULL OR fecha_ref <= v_to)
      AND (v_q IS NULL OR upper(guia) LIKE '%' || v_q || '%' OR COALESCE(ots, '') LIKE v_q || '%' OR COALESCE(ot_tms, '') LIKE v_q || '%')
      -- Solo TMS: guías programadas desde la primera fecha que cubre el Actualizable (antes no hay con qué cruzar)
      AND (origen <> 'SOLO_TMS' OR fecha_tms >= (SELECT min(fecha) FROM e)))
  SELECT jsonb_build_object('success', true, 'tolerancia', v_tol, 'referencia', v_ref,
    'resumen', (SELECT jsonb_build_object('total', count(*), 'ambos', count(*) FILTER (WHERE origen = 'AMBOS'),
        'solo_erp', count(*) FILTER (WHERE origen = 'SOLO_ERP'), 'solo_tms', count(*) FILTER (WHERE origen = 'SOLO_TMS'),
        'desfase', count(*) FILTER (WHERE abs(dif_dias) > v_tol), 'ot_distinta', count(*) FILTER (WHERE ot_distinta),
        'erp_aproximada', count(*) FILTER (WHERE origen <> 'SOLO_TMS' AND NOT erp_exacta), 'kg', round(COALESCE(sum(kg), 0), 1)) FROM f),
    'guias', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.fecha_ref DESC NULLS LAST, x.guia) FROM (
        SELECT * FROM f WHERE v_origen = 'TODAS' OR origen = v_origen OR (v_origen = 'DESFASE' AND (abs(dif_dias) > v_tol OR ot_distinta))
        ORDER BY fecha_ref DESC NULLS LAST, guia LIMIT v_lim) x), '[]'::jsonb))
  INTO v_out;
  RETURN v_out;
END $$;

-- Stock del ERP por lote con su situación frente al pendiente del documento
CREATE OR REPLACE FUNCTION public.erp_stock(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); v_s uuid := public.erp_active_import('STOCK'); v_out jsonb;
  v_q text := NULLIF(upper(btrim(p->>'q')), ''); v_cat text := NULLIF(p->>'situacion', ''); v_bod text := NULLIF(p->>'bodega', '');
  v_lim integer := least(greatest(COALESCE((p->>'limit')::integer, 500), 1), 3000);
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a los datos del ERP'); END IF;
  IF v_s IS NULL THEN RETURN jsonb_build_object('success', true, 'sin_datos', true, 'lotes', '[]'::jsonb); END IF;
  WITH pend AS (SELECT nro_documento, cod_producto, sum(cant_pendiente) AS pend, max(cliente) AS cliente
                FROM public.erp_contract_lines WHERE import_id = v_c GROUP BY 1, 2),
  doc AS (SELECT DISTINCT nro_documento FROM public.erp_contract_lines WHERE import_id = v_c),
  -- Varios lotes del mismo documento y SKU comparten el pendiente: se reparte en orden de línea
  s AS (SELECT s.*, s.stock * s.factor AS stock_u,
          sum(greatest(s.stock * s.factor, 0)) OVER (PARTITION BY s.lote, s.cod_producto ORDER BY s.linea) AS acum
        FROM public.erp_stock_lots s WHERE s.import_id = v_s),
  x AS (
    SELECT s.bodega, s.lote_raw AS lote, s.lote AS documento, s.ot, s.cod_producto, s.producto, s.tipo_producto, s.unidad, s.stock_u AS stock,
      s.stock_falla, s.kg, pend.pend AS pendiente, pend.cliente,
      greatest(least(greatest(s.stock_u, 0), COALESCE(greatest(pend.pend, 0), 0) - (s.acum - greatest(s.stock_u, 0))), 0) AS listo,
      CASE WHEN s.stock_u < 0 THEN 'NEGATIVO' WHEN s.lote IS NULL THEN 'SIN_LOTE'
        WHEN v_c IS NULL THEN 'SIN_ACTUALIZABLE'
        WHEN pend.pend IS NULL AND s.lote IN (SELECT nro_documento FROM doc) THEN 'SKU_FUERA_DE_CONTRATO'
        WHEN pend.pend IS NULL THEN 'SIN_CONTRATO'
        WHEN pend.pend <= 0 THEN 'OT_COMPLETA'
        WHEN s.acum > pend.pend THEN 'SOBRANTE'
        ELSE 'LISTO' END AS situacion
    FROM s LEFT JOIN pend ON pend.nro_documento = s.lote AND pend.cod_producto = s.cod_producto)
  SELECT jsonb_build_object('success', true,
    'resumen', (SELECT jsonb_agg(jsonb_build_object('bodega', bodega, 'situacion', situacion, 'lotes', n, 'kg', kg) ORDER BY bodega, situacion)
                FROM (SELECT bodega, situacion, count(*) n, round(COALESCE(sum(kg), 0), 1) kg FROM x GROUP BY 1, 2) r),
    'lotes', COALESCE((SELECT jsonb_agg(to_jsonb(y) ORDER BY y.kg DESC NULLS LAST) FROM (
        SELECT * FROM x WHERE (v_cat IS NULL OR situacion = v_cat) AND (v_bod IS NULL OR bodega = v_bod)
          AND (v_q IS NULL OR upper(COALESCE(lote, '')) LIKE v_q || '%' OR upper(cod_producto) LIKE '%' || v_q || '%' OR upper(COALESCE(producto, '')) LIKE '%' || v_q || '%')
        ORDER BY kg DESC NULLS LAST LIMIT v_lim) y), '[]'::jsonb))
  INTO v_out;
  RETURN v_out;
END $$;

REVOKE ALL ON FUNCTION public.erp_upload_begin(text, text, timestamptz, integer), public.erp_upload_rows(uuid, jsonb), public.erp_upload_apply(uuid),
  public.erp_estado(), public.erp_ots(jsonb), public.erp_ot_detalle(text), public.erp_guias(jsonb), public.erp_stock(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_upload_begin(text, text, timestamptz, integer), public.erp_upload_rows(uuid, jsonb), public.erp_upload_apply(uuid),
  public.erp_estado(), public.erp_ots(jsonb), public.erp_ot_detalle(text), public.erp_guias(jsonb), public.erp_stock(jsonb) TO authenticated;

COMMIT;
