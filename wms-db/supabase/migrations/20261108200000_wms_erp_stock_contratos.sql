-- Fase 1 (docs/plan-wms-inventario-apt.md): stock de referencia del ERP en la base WMS.
-- Se cargan los mismos dos Excel que en el TMS: «Stock Bodega Despacho» (stock por bodega, producto y lote) y
-- «Actualizable Despacho» (contratos y guías, que la derivación de la fase 4 necesita). Carga portada del TMS
-- (20261024120000_erp_contratos_stock.sql y 20261026090000_erp_analisis_calidad.sql) con dos diferencias:
-- permisos de almacén y retención: una importación marcada «retained» (la usa un inventario) conserva sus filas.
-- Fuera de alcance: alta automática de contratos y clientes, pesos y derivación de movimientos.

-- Ayudantes del TMS (mismas reglas)
CREATE OR REPLACE FUNCTION public.apt_guia_key(p text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN v ~ '^[A-Z0-9]+-[0-9]+$' THEN split_part(v, '-', 1) || '-' || COALESCE(NULLIF(ltrim(split_part(v, '-', 2), '0'), ''), '0')
    WHEN v ~ '^[0-9]+$' THEN COALESCE(NULLIF(ltrim(v, '0'), ''), '0')
    ELSE v END
  FROM (SELECT upper(regexp_replace(COALESCE(p, ''), '\s+', '', 'g')) AS v) z;
$$;
-- Lote del ERP → documento: sin ceros a la izquierda («0000016037» = 16037); «16497-S001» se mantiene
CREATE OR REPLACE FUNCTION public.erp_lote_doc(p text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN v = '' THEN NULL
    WHEN v ~ '^0*[0-9]+(-[A-Z][0-9]+)?$' THEN COALESCE(NULLIF(regexp_replace(v, '^0+', ''), ''), '0')
    ELSE v END
  FROM (SELECT upper(btrim(COALESCE(p, ''))) AS v) z;
$$;
-- Unidad del ERP: «CIEN» = cientos, «MIL» = miles
CREATE OR REPLACE FUNCTION public.erp_unit_factor(p text)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE upper(btrim(COALESCE(p, ''))) WHEN 'CIEN' THEN 100 WHEN 'MIL' THEN 1000 ELSE 1 END::numeric;
$$;

-- Quién carga datos del ERP en el WMS (las funciones portadas del TMS preguntan por apt_can_load)
CREATE OR REPLACE FUNCTION public.apt_can_load()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.is_active_tms_user() AND public.wh_has_permission(ARRAY['almacen-carga','almacen-supervisor']);
$$;
-- La ruta /api/erp/aplicar verifica el permiso con erp_estado().can_load antes de aplicar con la llave de servicio
CREATE OR REPLACE FUNCTION public.erp_estado()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('success', true, 'can_load', public.apt_can_load(),
    'imports', (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'file_name', file_name, 'cut_at', cut_at, 'rows', rows_loaded, 'applied_at', applied_at)), '[]')
                  FROM public.erp_imports WHERE status = 'ACTIVA'));
$$;

ALTER TABLE public.erp_imports ADD COLUMN IF NOT EXISTS retained boolean NOT NULL DEFAULT false;

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
  -- Peso real: el «Peso_Unitario» del ERP es por unidad aunque el stock esté en cientos
  kg                 numeric(20,6),
  familia            text,
  subfamilia         text,
  PRIMARY KEY (import_id, linea)
);
CREATE INDEX IF NOT EXISTS erp_stock_lots_doc_idx ON public.erp_stock_lots (import_id, lote, cod_producto);
CREATE INDEX IF NOT EXISTS erp_stock_lots_bodega_idx ON public.erp_stock_lots (import_id, bodega);

-- Solo se leen y escriben por las funciones erp_*; la política exige además una cuenta activa
ALTER TABLE public.erp_contract_guias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_guia_fechas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_stock_lots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_contract_guias, public.erp_guia_fechas, public.erp_stock_lots FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.erp_contract_guias, public.erp_guia_fechas, public.erp_stock_lots TO service_role;
DROP POLICY IF EXISTS security_active_account ON public.erp_contract_guias;
CREATE POLICY security_active_account ON public.erp_contract_guias AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.erp_guia_fechas;
CREATE POLICY security_active_account ON public.erp_guia_fechas AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.erp_stock_lots;
CREATE POLICY security_active_account ON public.erp_stock_lots AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));

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

-- Filas ya normalizadas por el navegador (src/lib/erp/parse.ts). Las del Actualizable traen «guias»: [{ g, c, p }].
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
      estado, nro_guias, fecha_ult_despacho, tipo_producto, tipo, familia, subfamilia, unidad_erp, linea, cantidades_ausentes, cantidades_ausentes_campos)
    SELECT p_upload_id, btrim(r->>'nro_documento'), (r->>'secuencia')::integer,
      COALESCE(NULLIF(btrim(r->>'nro_contrato'), ''), split_part(btrim(r->>'nro_documento'), '-', 1)),
      NULLIF(btrim(r->>'tipo_documento'), ''), NULLIF(r->>'correlativo', '')::bigint, NULLIF(r->>'fecha_contrato', '')::date,
      NULLIF(r->>'fecha_vcto', '')::date, NULLIF(btrim(r->>'vigencia'), ''), NULLIF(btrim(r->>'ruc'), ''), NULLIF(btrim(r->>'cliente'), ''),
      btrim(r->>'cod_producto'), NULLIF(btrim(r->>'producto'), ''), NULLIF(btrim(r->>'color'), ''),
      CASE upper(btrim(COALESCE(r->>'unidad', ''))) WHEN 'UNID' THEN 'UND' WHEN '' THEN NULL ELSE upper(btrim(r->>'unidad')) END,
      COALESCE(NULLIF(r->>'cant_contrato', '')::numeric, 0), COALESCE(NULLIF(r->>'cant_despachada', '')::numeric, 0),
      COALESCE(NULLIF(r->>'cant_reemplazada', '')::numeric, 0), COALESCE(NULLIF(r->>'cant_pendiente', '')::numeric, 0),
      NULLIF(btrim(r->>'estado'), ''), COALESCE(NULLIF(r->>'nro_guias', '')::integer, 0), NULLIF(r->>'fecha_ult_despacho', '')::date,
      NULLIF(btrim(r->>'tipo_producto'), ''), NULLIF(btrim(r->>'tipo'), ''), NULLIF(btrim(r->>'familia'), ''), NULLIF(btrim(r->>'subfamilia'), ''),
      NULLIF(r->>'unidad', ''), NULLIF(r->>'linea', '')::integer,
      COALESCE(NULLIF(r->>'cantidades_ausentes', '')::integer, 0) = 1 OR cardinality(a.campos) > 0, a.campos
    FROM jsonb_array_elements(p_rows) r
    CROSS JOIN LATERAL (SELECT ARRAY(SELECT k FROM unnest(ARRAY['cant_contrato', 'cant_despachada', 'cant_reemplazada', 'cant_pendiente']) k
      WHERE NULLIF(btrim(r->>k), '') IS NULL) AS campos) a
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

-- Aplicar: lo ejecuta /api/erp/aplicar con la llave de servicio tras verificar el permiso; erp_upload_apply es el
-- respaldo desde el navegador
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

  -- La foto anterior del mismo tipo queda como historial; sus filas se borran salvo que la retenga un inventario
  DELETE FROM public.erp_contract_lines WHERE import_id IN (SELECT id FROM public.erp_imports WHERE kind = v.kind AND status = 'ACTIVA' AND NOT retained);
  DELETE FROM public.erp_stock_lots WHERE import_id IN (SELECT id FROM public.erp_imports WHERE kind = v.kind AND status = 'ACTIVA' AND NOT retained);
  DELETE FROM public.erp_contract_guias WHERE import_id IN (SELECT id FROM public.erp_imports WHERE kind = v.kind AND status = 'ACTIVA' AND NOT retained);
  DELETE FROM public.erp_guia_fechas WHERE import_id IN (SELECT id FROM public.erp_imports WHERE kind = v.kind AND status = 'ACTIVA' AND NOT retained);
  UPDATE public.erp_imports SET status = 'REEMPLAZADA' WHERE kind = v.kind AND status = 'ACTIVA';
  UPDATE public.erp_imports SET status = 'ACTIVA', applied_at = now() WHERE id = v.id;

  IF v.kind = 'CONTRATOS' THEN
    -- Fecha ERP por guía: exacta si alguna línea la tiene como única guía o si está en las Salidas del inventario;
    -- si no, la del último despacho de la línea (aproximada)
    ANALYZE public.erp_contract_lines; ANALYZE public.erp_contract_guias;
    EXECUTE $q$
    WITH g AS MATERIALIZED (
      SELECT g.guia_key, min(g.guia) AS guia, min(l.fecha_ult_despacho) FILTER (WHERE l.nro_guias = 1) AS f_unica,
        max(l.fecha_ult_despacho) AS f_max
      FROM public.erp_contract_guias g
      JOIN public.erp_contract_lines l ON l.import_id = g.import_id AND l.nro_documento = g.nro_documento AND l.secuencia = g.secuencia
      WHERE g.import_id = $1 GROUP BY g.guia_key),
    s AS MATERIALIZED (
      SELECT public.apt_guia_key(m.numero) AS guia_key, m.fecha FROM public.inv_movements m
      WHERE m.active AND m.side = 'S' AND m.fecha >= (SELECT min(fecha_contrato) FROM public.erp_contract_lines WHERE import_id = $1)),
    mv AS (SELECT s.guia_key, min(s.fecha) AS fecha FROM s JOIN g USING (guia_key) WHERE g.f_unica IS NULL GROUP BY s.guia_key)
    INSERT INTO public.erp_guia_fechas (import_id, guia_key, guia, fecha, exacta, fuente)
    SELECT $1, g.guia_key, g.guia, COALESCE(g.f_unica, mv.fecha, g.f_max), (g.f_unica IS NOT NULL OR mv.fecha IS NOT NULL),
      CASE WHEN g.f_unica IS NOT NULL THEN 'ACTUALIZABLE' WHEN mv.fecha IS NOT NULL THEN 'SALIDAS' ELSE 'APROXIMADA' END
    FROM g LEFT JOIN mv USING (guia_key)$q$ USING v.id;
  END IF;
  ANALYZE public.erp_contract_lines; ANALYZE public.erp_contract_guias; ANALYZE public.erp_guia_fechas; ANALYZE public.erp_stock_lots;

  IF v.kind = 'CONTRATOS' THEN
    SELECT jsonb_build_object('lineas', count(*), 'ots', count(DISTINCT ot), 'documentos', count(DISTINCT nro_documento),
      'clientes', count(DISTINCT ruc), 'guias', (SELECT count(*) FROM public.erp_guia_fechas WHERE import_id = v.id),
      'despachos', (SELECT count(*) FROM public.erp_contract_guias WHERE import_id = v.id),
      'lineas_pendientes', count(*) FILTER (WHERE cant_pendiente > 0),
      'desde', min(fecha_contrato), 'hasta', max(fecha_contrato))
    INTO v_summary FROM public.erp_contract_lines WHERE import_id = v.id;
  ELSE
    SELECT jsonb_build_object('lotes', count(*), 'bodegas', jsonb_agg(DISTINCT bodega), 'productos', count(DISTINCT cod_producto),
      'kg', round(COALESCE(sum(kg), 0), 1), 'sin_lote', count(*) FILTER (WHERE lote IS NULL),
      'stock_negativo', count(*) FILTER (WHERE stock < 0))
    INTO v_summary FROM public.erp_stock_lots WHERE import_id = v.id;
  END IF;
  UPDATE public.erp_imports SET summary = v_summary WHERE id = v.id;
  RETURN jsonb_build_object('success', true, 'rows', v.rows_loaded, 'summary', v_summary);
END $$;

CREATE OR REPLACE FUNCTION public.erp_upload_apply(p_upload_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apt_can_load() THEN RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar datos del ERP'); END IF;
  RETURN public.erp_upload_apply_core(p_upload_id);
END $$;

-- ------------------------------------------------------------
-- Consulta del stock activo (lectura de almacén)
-- ------------------------------------------------------------
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
      SELECT s.bodega, s.cod_producto, s.producto, s.lote, s.lote_raw, s.ot, s.unidad, s.stock, s.stock_falla, s.stock_comprometido, s.kg
      FROM public.erp_stock_lots s
      WHERE s.import_id = v.id AND (p_bodega IS NULL OR s.bodega = p_bodega)
        AND (v_q IS NULL OR upper(coalesce(s.ot, '')) LIKE '%' || v_q || '%' OR upper(coalesce(s.lote, '')) LIKE '%' || v_q || '%'
             OR upper(coalesce(s.lote_raw, '')) LIKE '%' || v_q || '%' OR upper(s.cod_producto) LIKE '%' || v_q || '%'
             OR upper(coalesce(s.producto, '')) LIKE '%' || v_q || '%')
      ORDER BY s.bodega, s.ot NULLS LAST, s.lote, s.cod_producto
      LIMIT 2000) x), '[]'::jsonb));
END $$;

-- Últimas cargas para la pantalla (sin exponer la tabla)
CREATE OR REPLACE FUNCTION public.erp_imports_recent(p_limit integer DEFAULT 10)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_any_warehouse_permission() THEN RAISE EXCEPTION 'Sin acceso al almacén' USING ERRCODE = '42501'; END IF;
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC) FROM (
    SELECT kind, status, file_name, cut_at, rows_loaded, expected, retained, created_at, applied_at
    FROM public.erp_imports WHERE status <> 'CARGANDO' ORDER BY created_at DESC LIMIT least(greatest(coalesce(p_limit, 10), 1), 50)) x), '[]'::jsonb);
END $$;

REVOKE ALL ON FUNCTION public.apt_guia_key(text), public.erp_lote_doc(text), public.erp_unit_factor(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.apt_can_load(), public.erp_upload_apply_core(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erp_upload_apply_core(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.erp_estado(), public.erp_upload_begin(text, text, timestamptz, integer), public.erp_upload_rows(uuid, jsonb),
  public.erp_upload_apply(uuid), public.erp_stock_query(text, text), public.erp_imports_recent(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_estado(), public.erp_upload_begin(text, text, timestamptz, integer), public.erp_upload_rows(uuid, jsonb),
  public.erp_upload_apply(uuid), public.erp_stock_query(text, text), public.erp_imports_recent(integer) TO authenticated;
