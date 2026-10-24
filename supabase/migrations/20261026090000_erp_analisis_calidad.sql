-- ERP: análisis de contratos, despachos y stock con cruce exacto, calidad de datos, versiones de reglas y registro de
-- cargas. No cambia ninguna regla vigente: las reglas heredadas (CIEN → UND, UNID → UND, lote sin ceros, peso por
-- unidad, suma de tipos por OT y exclusiones por defecto) quedan registradas como versión 1 «heredada, sin aprobación
-- comercial» y se comparan, con los mismos cortes, contra el cruce exacto (Nro_Documento = Lote, Cod_Producto y Unidad,
-- normalizando solo espacios y mayúsculas).
BEGIN;

-- ------------------------------------------------------------
-- 1. Datos originales y trazabilidad
-- ------------------------------------------------------------
ALTER TABLE public.erp_contract_lines ADD COLUMN IF NOT EXISTS unidad_erp text;
ALTER TABLE public.erp_contract_lines ADD COLUMN IF NOT EXISTS linea integer;
ALTER TABLE public.erp_contract_lines ADD COLUMN IF NOT EXISTS cantidades_ausentes boolean NOT NULL DEFAULT false;
-- Qué cantidades venían vacías (se guardan como 0 por la regla heredada; el análisis nuevo no las usa como dato)
ALTER TABLE public.erp_contract_lines ADD COLUMN IF NOT EXISTS cantidades_ausentes_campos text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.erp_imports ADD COLUMN IF NOT EXISTS rule_version integer;
ALTER TABLE public.erp_derive_days ADD COLUMN IF NOT EXISTS rule_version integer;

-- Clave de cruce: espacios y mayúsculas (sin quitar ceros ni sufijos)
CREATE OR REPLACE FUNCTION public.erp_key(p text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT NULLIF(regexp_replace(upper(btrim(COALESCE(p, ''))), '\s+', ' ', 'g'), '');
$$;

-- ------------------------------------------------------------
-- 2. Versiones de reglas: cada procesamiento registra la versión vigente
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.erp_rule_versions (
  version     integer PRIMARY KEY,
  estado      text NOT NULL CHECK (estado IN ('VIGENTE', 'REEMPLAZADA')),
  origen      text NOT NULL CHECK (origen IN ('HEREDADA', 'APROBADA')),
  reglas      jsonb NOT NULL,
  nota        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  approved_by uuid,
  approved_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS erp_rule_versions_one_current ON public.erp_rule_versions (estado) WHERE estado = 'VIGENTE';
REVOKE ALL ON public.erp_rule_versions FROM PUBLIC, anon, authenticated;
ALTER TABLE public.erp_rule_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.erp_rule_versions;
CREATE POLICY security_active_account ON public.erp_rule_versions AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));

INSERT INTO public.erp_rule_versions (version, estado, origen, nota, reglas) VALUES (1, 'VIGENTE', 'HEREDADA',
  'Reglas aplicadas desde la primera versión del módulo ERP (24/10/2026). No tienen aprobación comercial: se documentan y comparan.',
  '[
    {"codigo": "CIEN_A_UND", "titulo": "Stock en cientos convertido a unidades", "detalle": "El stock con unidad CIEN se multiplica por 100 (MIL por 1000) para compararlo con el contrato en UND. El archivo no trae factor de conversión: la equivalencia se infiere del nombre de la unidad.", "aplica_en": ["OT pendientes (listo en stock)", "Stock por OT", "Movimientos derivados"]},
    {"codigo": "UNID_A_UND", "titulo": "Unidad UNID del Actualizable guardada como UND", "detalle": "Al cargar el Actualizable, la unidad UNID se guarda como UND. Desde la versión de análisis también se guarda la unidad original (unidad_erp).", "aplica_en": ["OT pendientes", "Guías"]},
    {"codigo": "LOTE_SIN_CEROS", "titulo": "Lote sin ceros a la izquierda", "detalle": "El lote 0000016037 se trata como el documento 16037.", "aplica_en": ["OT pendientes (listo en stock)", "Stock por OT", "Movimientos derivados (clave de lote del inventario)"]},
    {"codigo": "PESO_POR_UNIDAD", "titulo": "Peso calculado por unidad", "detalle": "El peso del stock se calcula como stock × factor de unidad × Peso_Unitario, en lugar del Peso_Total del ERP, que en productos en cientos resulta 100 veces menor.", "aplica_en": ["Stock por OT (peso)", "OT pendientes (toneladas)", "Movimientos derivados (peso)"]},
    {"codigo": "OT_SUMA_TIPOS", "titulo": "Total por OT suma todos los tipos de documento", "detalle": "En OT pendientes, el total de la OT suma contrato, subcontratos, garantías y errores (si se incluyen), y también cantidades de unidades distintas. El pendiente negativo (sobredespacho) cuenta como 0. El stock se cruza por lote y producto, sin comparar la unidad.", "aplica_en": ["OT pendientes"]},
    {"codigo": "EXCLUSION_POR_DEFECTO", "titulo": "Exclusión por defecto de ERROR DE CONTRATO y SERVICIO A TERCEROS", "detalle": "OT pendientes no los cuenta salvo que se marquen las casillas para incluirlos.", "aplica_en": ["OT pendientes"]}
  ]'::jsonb)
ON CONFLICT (version) DO NOTHING;

CREATE OR REPLACE FUNCTION public.erp_rule_version()
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT version FROM public.erp_rule_versions WHERE estado = 'VIGENTE';
$$;

CREATE OR REPLACE FUNCTION public.erp_stamp_rule_version()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'erp_imports' THEN
    IF NEW.status = 'ACTIVA' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'ACTIVA') THEN NEW.rule_version := public.erp_rule_version(); END IF;
  ELSE
    NEW.rule_version := public.erp_rule_version();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS erp_imports_rule_version ON public.erp_imports;
CREATE TRIGGER erp_imports_rule_version BEFORE INSERT OR UPDATE OF status ON public.erp_imports FOR EACH ROW EXECUTE FUNCTION public.erp_stamp_rule_version();
DROP TRIGGER IF EXISTS erp_derive_days_rule_version ON public.erp_derive_days;
CREATE TRIGGER erp_derive_days_rule_version BEFORE INSERT ON public.erp_derive_days FOR EACH ROW EXECUTE FUNCTION public.erp_stamp_rule_version();
UPDATE public.erp_imports SET rule_version = 1 WHERE status = 'ACTIVA' AND rule_version IS NULL;
UPDATE public.erp_derive_days SET rule_version = 1 WHERE rule_version IS NULL;

-- ------------------------------------------------------------
-- 3. Registro de cargas (también las fallidas) y bloqueo de cargas simultáneas
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.erp_load_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('CONTRATOS', 'STOCK', 'MOVIMIENTOS', 'LECTURA')),
  file_name     text,
  cut_at        timestamptz,
  import_id     uuid,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text NOT NULL DEFAULT 'EN_CURSO' CHECK (status IN ('EN_CURSO', 'OK', 'ERROR')),
  rows_expected integer,
  rows_loaded   integer,
  detalle       jsonb NOT NULL DEFAULT '{}'::jsonb,
  error         text,
  rule_version  integer,
  created_by    uuid
);
CREATE INDEX IF NOT EXISTS erp_load_log_started_idx ON public.erp_load_log (started_at DESC);
REVOKE ALL ON public.erp_load_log FROM PUBLIC, anon, authenticated;
ALTER TABLE public.erp_load_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.erp_load_log;
CREATE POLICY security_active_account ON public.erp_load_log AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));

-- p: kind, file_name, cut_at, rows_expected, detalle. Una carga del mismo tipo en curso de otro usuario (últimos 15 min) bloquea.
CREATE OR REPLACE FUNCTION public.erp_log_start(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid; v_other record;
BEGIN
  IF NOT public.apt_can_load() THEN RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar datos del ERP'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('erp_log_' || COALESCE(p->>'kind', '')));
  SELECT l.started_at, COALESCE(NULLIF(btrim(concat_ws(' ', to_jsonb(pr)->>'first_name', to_jsonb(pr)->>'last_name')), ''), 'otro usuario') AS quien INTO v_other
  FROM public.erp_load_log l LEFT JOIN public.profiles pr ON pr.id = l.created_by
  WHERE l.kind = p->>'kind' AND l.status = 'EN_CURSO' AND l.started_at > now() - interval '15 minutes' AND l.created_by IS DISTINCT FROM auth.uid()
  ORDER BY l.started_at DESC LIMIT 1;
  IF v_other.started_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', format('Hay otra carga del mismo archivo en curso (%s, desde las %s). Espere a que termine.', v_other.quien,
      to_char(v_other.started_at AT TIME ZONE 'America/Lima', 'HH24:MI')));
  END IF;
  -- Las propias que quedaron abiertas se cierran como interrumpidas
  UPDATE public.erp_load_log SET status = 'ERROR', finished_at = now(), error = 'Interrumpida: se inició otra carga del mismo tipo'
  WHERE kind = p->>'kind' AND status = 'EN_CURSO' AND (created_by IS NOT DISTINCT FROM auth.uid() OR started_at <= now() - interval '15 minutes');
  INSERT INTO public.erp_load_log (kind, file_name, cut_at, rows_expected, detalle, rule_version, created_by)
  VALUES (p->>'kind', left(NULLIF(p->>'file_name', ''), 300), NULLIF(p->>'cut_at', '')::timestamptz, NULLIF(p->>'rows_expected', '')::integer,
    COALESCE(p->'detalle', '{}'::jsonb), public.erp_rule_version(), auth.uid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', true, 'id', v_id);
END $$;

-- p: id, status (OK | ERROR), rows_loaded, import_id, error, detalle
CREATE OR REPLACE FUNCTION public.erp_log_finish(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apt_can_load() THEN RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar datos del ERP'); END IF;
  IF COALESCE(p->>'status', '') NOT IN ('OK', 'ERROR') THEN RETURN jsonb_build_object('success', false, 'error', 'Estado no válido'); END IF;
  UPDATE public.erp_load_log SET status = p->>'status', finished_at = now(), rows_loaded = NULLIF(p->>'rows_loaded', '')::integer,
    import_id = COALESCE(NULLIF(p->>'import_id', '')::uuid, import_id), error = left(NULLIF(p->>'error', ''), 2000),
    detalle = detalle || COALESCE(p->'detalle', '{}'::jsonb)
  WHERE id = (p->>'id')::uuid AND status = 'EN_CURSO';
  RETURN jsonb_build_object('success', true);
END $$;

-- ------------------------------------------------------------
-- 4. Carga del Actualizable: guarda unidad original, fila del Excel y cantidades ausentes (la regla UNID → UND sigue)
-- ------------------------------------------------------------
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
      -- Unidad tal como viene del ERP (la columna unidad conserva la regla heredada UNID → UND) y fila del Excel
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

-- ------------------------------------------------------------
-- 5. Análisis con cruce exacto: documento + producto + unidad (unidad original del ERP, solo mayúsculas y espacios)
-- ------------------------------------------------------------
-- Filtros (p): ot, cliente (nombre o RUC), documento, tipo_documento, familia, producto (código o glosa), unidad, bodega, estado
-- (Estado del ERP), vigencia (atributo del ERP), cruce, solo_pendiente, vencida, vista ('DOCUMENTO' | 'OT'), orden, limit, offset
CREATE OR REPLACE FUNCTION public.erp_analisis(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); v_s uuid := public.erp_active_import('STOCK'); v_out jsonb;
  f_ot text := public.erp_key(p->>'ot'); f_cli text := public.erp_key(p->>'cliente'); f_doc text := public.erp_key(p->>'documento');
  f_tipo text := NULLIF(p->>'tipo_documento', ''); f_fam text := NULLIF(p->>'familia', ''); f_prod text := public.erp_key(p->>'producto');
  f_uni text := public.erp_key(p->>'unidad'); f_bod text := public.erp_bodega(p->>'bodega'); f_est text := NULLIF(p->>'estado', '');
  f_vig text := NULLIF(p->>'vigencia', ''); f_cruce text := NULLIF(p->>'cruce', ''); f_pend boolean := COALESCE((p->>'solo_pendiente')::boolean, false);
  f_venc boolean := COALESCE((p->>'vencida')::boolean, false); v_vista text := COALESCE(NULLIF(p->>'vista', ''), 'DOCUMENTO');
  v_lim integer := least(greatest(COALESCE((p->>'limit')::integer, 200), 1), 20000); v_off integer := greatest(COALESCE((p->>'offset')::integer, 0), 0);
  v_hoy date := (now() AT TIME ZONE 'America/Lima')::date; v_orig boolean;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a los datos del ERP'); END IF;
  IF v_c IS NULL THEN RETURN jsonb_build_object('success', true, 'sin_datos', true); END IF;
  -- Cargas anteriores a esta versión no guardaron la unidad original: se usa la guardada y se avisa
  SELECT bool_and(unidad_erp IS NOT NULL) INTO v_orig FROM (SELECT unidad_erp FROM public.erp_contract_lines WHERE import_id = v_c LIMIT 2000) z;
  SET LOCAL client_min_messages = warning;
  DROP TABLE IF EXISTS a_doc, a_stk;
  CREATE TEMP TABLE a_stk ON COMMIT DROP AS
  SELECT public.erp_key(lote_raw) AS lk, public.erp_key(cod_producto) AS pk, public.erp_key(unidad) AS u, sum(stock) AS stock, count(*) AS lotes,
    string_agg(DISTINCT public.erp_bodega(bodega), ' · ') AS bodegas, sum(stock_falla) AS falla
  FROM public.erp_stock_lots WHERE import_id = v_s AND public.erp_key(lote_raw) IS NOT NULL GROUP BY 1, 2, 3;
  CREATE TEMP TABLE a_doc ON COMMIT DROP AS
  WITH l AS (
    SELECT l.*, public.erp_key(COALESCE(l.unidad_erp, l.unidad)) AS u, public.erp_key(l.nro_documento) AS dk, public.erp_key(l.cod_producto) AS pk
    FROM public.erp_contract_lines l WHERE l.import_id = v_c)
  SELECT dk AS documento, pk AS cod_producto, u AS unidad, max(ot) AS ot, max(tipo_documento) AS tipo_documento, max(cliente) AS cliente, max(ruc) AS ruc,
    max(producto) AS producto, max(familia) AS familia, max(tipo_producto) AS tipo_producto, count(*) AS lineas,
    sum(cant_contrato) AS contratado, sum(cant_despachada) AS despachado, sum(cant_reemplazada) AS reemplazado, sum(cant_pendiente) AS pendiente,
    sum(cant_contrato - cant_despachada - cant_reemplazada - cant_pendiente) AS dif_formula, bool_or(cantidades_ausentes) AS dato_ausente,
    bool_or('cant_contrato' = ANY(cantidades_ausentes_campos)) AS aus_c, bool_or('cant_despachada' = ANY(cantidades_ausentes_campos)) AS aus_d,
    bool_or('cant_reemplazada' = ANY(cantidades_ausentes_campos)) AS aus_r, bool_or('cant_pendiente' = ANY(cantidades_ausentes_campos)) AS aus_p,
    min(fecha_contrato) AS fecha_contrato, max(fecha_vcto) AS fecha_vcto, max(fecha_ult_despacho) AS ult_despacho,
    string_agg(DISTINCT estado, ', ') AS estados, string_agg(DISTINCT vigencia, ', ') AS vigencia, sum(nro_guias) AS guias,
    array_agg(secuencia ORDER BY secuencia) AS secuencias, array_agg(linea ORDER BY secuencia) AS filas_origen
  FROM l GROUP BY 1, 2, 3;
  -- Cantidades ausentes: el análisis nuevo no las toma como 0. La cantidad afectada queda sin valor (también la diferencia de
  -- fórmula) y la fila se marca incompleta; las cargas anteriores sin detalle de campos se tratan como ausentes en todo.
  UPDATE a_doc SET aus_c = aus_c OR NOT (aus_c OR aus_d OR aus_r OR aus_p), aus_d = aus_d OR NOT (aus_c OR aus_d OR aus_r OR aus_p),
    aus_r = aus_r OR NOT (aus_c OR aus_d OR aus_r OR aus_p), aus_p = aus_p OR NOT (aus_c OR aus_d OR aus_r OR aus_p)
  WHERE dato_ausente;
  UPDATE a_doc SET contratado = CASE WHEN aus_c THEN NULL ELSE contratado END, despachado = CASE WHEN aus_d THEN NULL ELSE despachado END,
    reemplazado = CASE WHEN aus_r THEN NULL ELSE reemplazado END, pendiente = CASE WHEN aus_p THEN NULL ELSE pendiente END, dif_formula = NULL
  WHERE dato_ausente;
  ALTER TABLE a_doc ADD COLUMN stock numeric, ADD COLUMN lotes integer, ADD COLUMN bodegas text, ADD COLUMN cruce text;
  UPDATE a_doc d SET stock = s.stock, lotes = s.lotes, bodegas = s.bodegas, cruce = 'COINCIDE'
  FROM a_stk s WHERE s.lk = d.documento AND s.pk = d.cod_producto AND s.u = d.unidad;
  -- Sin coincidencia exacta: se informa la posible causa, sin asignar stock (reglas no aprobadas)
  UPDATE a_doc d SET cruce = CASE
      WHEN EXISTS (SELECT 1 FROM a_stk s WHERE s.lk = d.documento AND s.pk = d.cod_producto) THEN 'UNIDAD_DISTINTA'
      WHEN EXISTS (SELECT 1 FROM a_stk s WHERE s.lk ~ '^0+[0-9]' AND regexp_replace(s.lk, '^0+(?=[0-9])', '') = d.documento AND s.pk = d.cod_producto) THEN 'LOTE_CON_CEROS'
      WHEN EXISTS (SELECT 1 FROM a_stk s WHERE s.lk = d.documento || 'D' AND s.pk = d.cod_producto) THEN 'LOTE_CON_SUFIJO_D'
      ELSE 'SIN_COINCIDENCIA' END
  WHERE d.cruce IS NULL;

  WITH f AS (
    SELECT d.*, d.dato_ausente AS incompleto,
      array_remove(ARRAY[CASE WHEN d.aus_c THEN 'contratada' END, CASE WHEN d.aus_d THEN 'despachada' END, CASE WHEN d.aus_r THEN 'reemplazada' END,
        CASE WHEN d.aus_p THEN 'pendiente' END], NULL) AS cantidades_ausentes,
      CASE WHEN d.pendiente > 0 THEN greatest(d.pendiente - COALESCE(d.stock, 0), 0) END AS faltante,
      CASE WHEN d.pendiente > 0 AND d.cruce = 'COINCIDE' THEN round(d.stock / d.pendiente, 4) END AS cobertura,
      CASE WHEN d.contratado > 0 THEN round(d.despachado / d.contratado, 4) END AS avance,
      (d.pendiente > 0 AND d.fecha_vcto < v_hoy) AS vencida, v_hoy - d.fecha_contrato AS antiguedad
    FROM a_doc d
    WHERE (f_ot IS NULL OR d.ot = f_ot OR d.documento LIKE f_ot || '-%' OR d.documento = f_ot)
      AND (f_cli IS NULL OR public.erp_key(d.cliente) LIKE '%' || f_cli || '%' OR d.ruc LIKE f_cli || '%')
      AND (f_doc IS NULL OR d.documento = f_doc) AND (f_tipo IS NULL OR d.tipo_documento = f_tipo) AND (f_fam IS NULL OR d.familia = f_fam)
      AND (f_prod IS NULL OR d.cod_producto LIKE '%' || f_prod || '%' OR public.erp_key(d.producto) LIKE '%' || f_prod || '%')
      AND (f_uni IS NULL OR d.unidad = f_uni) AND (f_bod IS NULL OR d.bodegas LIKE '%' || f_bod || '%')
      AND (f_est IS NULL OR d.estados LIKE '%' || f_est || '%') AND (f_vig IS NULL OR d.vigencia LIKE '%' || f_vig || '%')
      AND (f_cruce IS NULL OR d.cruce = f_cruce) AND (NOT f_pend OR d.pendiente > 0 OR d.pendiente IS NULL)
      AND (NOT f_venc OR (d.pendiente > 0 AND d.fecha_vcto < v_hoy))),
  -- Por OT: un renglón por OT, tipo de documento y unidad (nunca se suman tipos ni unidades entre sí)
  o AS (
    SELECT ot, tipo_documento, unidad, max(cliente) AS cliente, count(*) AS documentos_producto, count(DISTINCT documento) AS documentos,
      sum(contratado) AS contratado, sum(despachado) AS despachado, sum(reemplazado) AS reemplazado, sum(pendiente) AS pendiente,
      sum(stock) AS stock, sum(faltante) AS faltante, count(*) FILTER (WHERE cruce = 'COINCIDE') AS con_stock,
      count(*) FILTER (WHERE vencida) AS vencidas, min(fecha_contrato) AS fecha_contrato, max(fecha_vcto) AS fecha_vcto, max(ult_despacho) AS ult_despacho,
      count(*) FILTER (WHERE incompleto) AS incompletas,
      CASE WHEN sum(contratado) > 0 THEN round(sum(despachado) / sum(contratado), 4) END AS avance,
      CASE WHEN sum(pendiente) FILTER (WHERE pendiente > 0) > 0 THEN round(sum(stock) FILTER (WHERE pendiente > 0 AND cruce = 'COINCIDE') / sum(pendiente) FILTER (WHERE pendiente > 0), 4) END AS cobertura
    FROM f GROUP BY 1, 2, 3)
  SELECT jsonb_build_object('success', true, 'vista', v_vista, 'unidad_original', COALESCE(v_orig, false), 'hoy', v_hoy,
    'total', CASE WHEN v_vista = 'OT' THEN (SELECT count(*) FROM o) ELSE (SELECT count(*) FROM f) END,
    -- Resumen por unidad y tipo de documento (porcentajes desde las sumas, no promedio de filas)
    'resumen', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.unidad, r.tipo_documento) FROM (
       SELECT unidad, tipo_documento, count(*) AS filas, count(DISTINCT documento) AS documentos, sum(lineas) AS lineas,
         sum(contratado) AS contratado, sum(despachado) AS despachado, sum(reemplazado) AS reemplazado, sum(pendiente) AS pendiente,
         CASE WHEN sum(contratado) > 0 THEN round(sum(despachado) / sum(contratado), 4) END AS avance,
         sum(stock) FILTER (WHERE pendiente > 0 AND cruce = 'COINCIDE') AS stock_coincidente, sum(faltante) AS faltante,
         CASE WHEN sum(pendiente) FILTER (WHERE pendiente > 0) > 0
           THEN round(sum(stock) FILTER (WHERE pendiente > 0 AND cruce = 'COINCIDE') / sum(pendiente) FILTER (WHERE pendiente > 0), 4) END AS cobertura,
         count(*) FILTER (WHERE pendiente > 0) AS con_pendiente, count(*) FILTER (WHERE pendiente > 0 AND cruce = 'COINCIDE') AS pendiente_con_stock,
         count(*) FILTER (WHERE pendiente < 0) AS sobredespacho, count(*) FILTER (WHERE vencida) AS vencidas,
         -- Filas con cantidades ausentes: sus cantidades no entran en las sumas, que quedan parciales
         count(*) FILTER (WHERE incompleto) AS incompletas
       FROM f GROUP BY 1, 2) r), '[]'::jsonb),
    'incompletas', (SELECT count(*) FROM f WHERE incompleto),
    'estados', COALESCE((SELECT jsonb_object_agg(e, n) FROM (
       SELECT COALESCE(l.estado, '(vacío)') AS e, count(*) AS n FROM public.erp_contract_lines l
       WHERE l.import_id = v_c AND EXISTS (SELECT 1 FROM f WHERE f.documento = public.erp_key(l.nro_documento) AND f.cod_producto = public.erp_key(l.cod_producto)
         AND f.unidad = public.erp_key(COALESCE(l.unidad_erp, l.unidad))) GROUP BY 1) z), '{}'::jsonb),
    'cruces', COALESCE((SELECT jsonb_object_agg(cruce, n) FROM (SELECT cruce, count(*) AS n FROM f GROUP BY 1) z), '{}'::jsonb),
    'filas', CASE WHEN v_vista = 'OT'
      THEN COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM o
        ORDER BY faltante DESC NULLS LAST, pendiente DESC NULLS LAST, ot, tipo_documento NULLS FIRST, unidad LIMIT v_lim OFFSET v_off) x), '[]'::jsonb)
      ELSE COALESCE((SELECT jsonb_agg(to_jsonb(x) - 'aus_c' - 'aus_d' - 'aus_r' - 'aus_p' - 'dato_ausente') FROM (SELECT * FROM f
        ORDER BY faltante DESC NULLS LAST, pendiente DESC NULLS LAST, documento, cod_producto, unidad LIMIT v_lim OFFSET v_off) x), '[]'::jsonb) END)
  INTO v_out;
  RETURN v_out;
END $$;

-- Detalle de un documento + producto + unidad: líneas del ERP (con su fila de origen), lotes con su bodega y guías
CREATE OR REPLACE FUNCTION public.erp_analisis_detalle(p_documento text, p_producto text, p_unidad text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); v_s uuid := public.erp_active_import('STOCK');
  d text := public.erp_key(p_documento); pr text := public.erp_key(p_producto); u text := public.erp_key(p_unidad);
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a los datos del ERP'); END IF;
  RETURN jsonb_build_object('success', true,
    'lineas', COALESCE((SELECT jsonb_agg(jsonb_build_object('fila_origen', l.linea, 'tipo_documento', l.tipo_documento, 'correlativo', l.correlativo, 'secuencia', l.secuencia,
        'producto', l.producto, 'color', l.color, 'unidad_erp', l.unidad_erp, 'unidad', l.unidad,
        -- Cantidad ausente en el archivo: sin valor (la base la guarda como 0 por la regla heredada)
        'contratado', CASE WHEN l.cantidades_ausentes AND ('cant_contrato' = ANY(l.cantidades_ausentes_campos) OR l.cantidades_ausentes_campos = '{}') THEN NULL ELSE l.cant_contrato END,
        'despachado', CASE WHEN l.cantidades_ausentes AND ('cant_despachada' = ANY(l.cantidades_ausentes_campos) OR l.cantidades_ausentes_campos = '{}') THEN NULL ELSE l.cant_despachada END,
        'reemplazado', CASE WHEN l.cantidades_ausentes AND ('cant_reemplazada' = ANY(l.cantidades_ausentes_campos) OR l.cantidades_ausentes_campos = '{}') THEN NULL ELSE l.cant_reemplazada END,
        'pendiente', CASE WHEN l.cantidades_ausentes AND ('cant_pendiente' = ANY(l.cantidades_ausentes_campos) OR l.cantidades_ausentes_campos = '{}') THEN NULL ELSE l.cant_pendiente END,
        'estado', l.estado, 'vigencia', l.vigencia, 'fecha_contrato', l.fecha_contrato,
        'fecha_vcto', l.fecha_vcto, 'ult_despacho', l.fecha_ult_despacho, 'guias', l.nro_guias, 'dato_ausente', l.cantidades_ausentes, 'cantidades_ausentes', l.cantidades_ausentes_campos) ORDER BY l.secuencia)
      FROM public.erp_contract_lines l WHERE l.import_id = v_c AND public.erp_key(l.nro_documento) = d AND public.erp_key(l.cod_producto) = pr
        AND public.erp_key(COALESCE(l.unidad_erp, l.unidad)) = u), '[]'::jsonb),
    'lotes', COALESCE((SELECT jsonb_agg(jsonb_build_object('fila_origen', s.linea, 'bodega', s.bodega, 'lote', s.lote_raw, 'unidad', s.unidad, 'stock', s.stock,
        'stock_falla', s.stock_falla, 'peso_unitario', s.peso_unitario, 'peso_total_erp', s.peso_total,
        -- Misma normalización que la tabla principal: coincide solo con lote, producto y unidad exactos; el resto son candidatos
        'cruce', CASE WHEN public.erp_key(s.lote_raw) = d AND public.erp_key(s.unidad) IS NOT DISTINCT FROM u THEN 'COINCIDE'
          WHEN public.erp_key(s.lote_raw) = d THEN 'CANDIDATO_UNIDAD_DISTINTA'
          WHEN public.erp_key(s.lote_raw) = d || 'D' THEN 'CANDIDATO_SUFIJO_D'
          ELSE 'CANDIDATO_CEROS' END,
        'coincide', public.erp_key(s.lote_raw) = d AND public.erp_key(s.unidad) IS NOT DISTINCT FROM u) ORDER BY s.bodega)
      FROM public.erp_stock_lots s WHERE s.import_id = v_s AND public.erp_key(s.cod_producto) = pr
        AND (public.erp_key(s.lote_raw) = d OR (public.erp_key(s.lote_raw) ~ '^0+[0-9]' AND regexp_replace(public.erp_key(s.lote_raw), '^0+(?=[0-9])', '') = d)
          OR public.erp_key(s.lote_raw) = d || 'D')), '[]'::jsonb),
    'guias', COALESCE((SELECT jsonb_agg(jsonb_build_object('guia', g.guia, 'cantidad', g.cantidad, 'secuencia', g.secuencia, 'fecha_erp', f.fecha, 'fecha_erp_exacta', f.exacta) ORDER BY f.fecha DESC NULLS LAST)
      FROM public.erp_contract_guias g JOIN public.erp_contract_lines l ON l.import_id = g.import_id AND l.nro_documento = g.nro_documento AND l.secuencia = g.secuencia
      LEFT JOIN public.erp_guia_fechas f ON f.import_id = g.import_id AND f.guia_key = g.guia_key
      WHERE g.import_id = v_c AND public.erp_key(l.nro_documento) = d AND public.erp_key(l.cod_producto) = pr AND public.erp_key(COALESCE(l.unidad_erp, l.unidad)) = u), '[]'::jsonb));
END $$;

-- Stock con su estado de cruce exacto (cada lote se ve una vez; las medidas por producto se marcan como tales)
CREATE OR REPLACE FUNCTION public.erp_stock_cruce(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); v_s uuid := public.erp_active_import('STOCK'); v_out jsonb;
  f_bod text := public.erp_bodega(p->>'bodega'); f_cruce text := NULLIF(p->>'cruce', ''); f_q text := public.erp_key(p->>'q'); f_uni text := public.erp_key(p->>'unidad');
  v_lim integer := least(greatest(COALESCE((p->>'limit')::integer, 500), 1), 20000);
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a los datos del ERP'); END IF;
  IF v_s IS NULL THEN RETURN jsonb_build_object('success', true, 'sin_datos', true); END IF;
  WITH pend AS (SELECT public.erp_key(nro_documento) AS dk, public.erp_key(cod_producto) AS pk, public.erp_key(COALESCE(unidad_erp, unidad)) AS u, sum(cant_pendiente) AS pendiente
           FROM public.erp_contract_lines WHERE import_id = v_c GROUP BY 1, 2, 3),
  dpp AS MATERIALIZED (SELECT DISTINCT dk, pk FROM pend),
  dd AS MATERIALIZED (SELECT DISTINCT dk FROM pend),
  s AS MATERIALIZED (
    SELECT s.linea AS fila_origen, s.bodega, s.cod_producto, s.producto, s.tipo_producto, s.unidad, s.lote_raw AS lote, s.stock, s.stock_falla,
      s.stock_comprometido, s.peso_unitario, s.peso_total AS peso_total_erp, s.familia,
      public.erp_key(s.lote_raw) AS lk, public.erp_key(s.cod_producto) AS pk, public.erp_key(s.unidad) AS u
    FROM public.erp_stock_lots s WHERE s.import_id = v_s),
  x AS (
    SELECT s.*, pe.pendiente,
      CASE WHEN s.lk IS NULL THEN 'SIN_LOTE'
        WHEN pe.dk IS NOT NULL THEN 'COINCIDE'
        WHEN pp.dk IS NOT NULL THEN 'UNIDAD_DISTINTA'
        WHEN d1.dk IS NOT NULL THEN 'DOCUMENTO_SIN_PRODUCTO'
        WHEN d0.dk IS NOT NULL THEN 'LOTE_CON_CEROS'
        WHEN dz.dk IS NOT NULL THEN 'LOTE_CON_SUFIJO_D'
        ELSE 'SIN_DOCUMENTO' END AS cruce
    FROM s LEFT JOIN pend pe ON pe.dk = s.lk AND pe.pk = s.pk AND pe.u = s.u
      LEFT JOIN dpp pp ON pp.dk = s.lk AND pp.pk = s.pk
      LEFT JOIN dd d1 ON d1.dk = s.lk
      LEFT JOIN dd d0 ON s.lk ~ '^0+[0-9]' AND d0.dk = regexp_replace(s.lk, '^0+(?=[0-9])', '')
      LEFT JOIN dd dz ON s.lk ~ '[0-9]D$' AND dz.dk = left(s.lk, -1)),
  y AS (SELECT * FROM x WHERE (f_bod IS NULL OR public.erp_bodega(bodega) = f_bod) AND (f_cruce IS NULL OR cruce = f_cruce) AND (f_uni IS NULL OR u = f_uni)
          AND (f_q IS NULL OR lk LIKE f_q || '%' OR pk LIKE '%' || f_q || '%' OR public.erp_key(producto) LIKE '%' || f_q || '%'))
  SELECT jsonb_build_object('success', true,
    'resumen', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.bodega, r.unidad, r.cruce) FROM (
       SELECT public.erp_bodega(bodega) AS bodega, unidad, cruce, count(*) AS lotes, sum(stock) AS stock FROM y GROUP BY 1, 2, 3) r), '[]'::jsonb),
    'total', (SELECT count(*) FROM y),
    'filas', COALESCE((SELECT jsonb_agg(to_jsonb(z) - 'lk' - 'pk' - 'u') FROM (SELECT * FROM y ORDER BY cruce <> 'COINCIDE' DESC, stock DESC LIMIT v_lim) z), '[]'::jsonb))
  INTO v_out;
  RETURN v_out;
END $$;

-- ------------------------------------------------------------
-- 6. Calidad de datos (sobre los cortes vigentes)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.erp_calidad()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); v_s uuid := public.erp_active_import('STOCK'); v jsonb := '[]'::jsonb; v_hoy date := (now() AT TIME ZONE 'America/Lima')::date;
  ic public.erp_imports; isk public.erp_imports;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a los datos del ERP'); END IF;
  SELECT * INTO ic FROM public.erp_imports WHERE id = v_c;
  SELECT * INTO isk FROM public.erp_imports WHERE id = v_s;
  -- Cada control: código, origen, título, tipo (ERROR | REVISAR | INFORMATIVO), cantidad y hasta 10 ejemplos
  WITH l AS (SELECT * FROM public.erp_contract_lines WHERE import_id = v_c), s AS (SELECT * FROM public.erp_stock_lots WHERE import_id = v_s),
  c AS (
    SELECT 'A01' AS codigo, 'Actualizable' AS origen, 'Clave de línea repetida (Tipo_Documento + Correlativo + Secuencia)' AS titulo, 'ERROR' AS tipo,
      (SELECT count(*) FROM (SELECT 1 FROM l GROUP BY tipo_documento, correlativo, secuencia HAVING count(*) > 1) z) AS cantidad,
      (SELECT jsonb_agg(z) FROM (SELECT tipo_documento, correlativo, secuencia, count(*) AS filas FROM l GROUP BY 1, 2, 3 HAVING count(*) > 1 LIMIT 10) z) AS ejemplos
    UNION ALL SELECT 'A02', 'Actualizable', 'Líneas con clave vacía (tipo, correlativo o secuencia)', 'ERROR',
      (SELECT count(*) FROM l WHERE tipo_documento IS NULL OR correlativo IS NULL OR secuencia IS NULL),
      (SELECT jsonb_agg(z) FROM (SELECT nro_documento, secuencia, linea AS fila_origen FROM l WHERE tipo_documento IS NULL OR correlativo IS NULL OR secuencia IS NULL LIMIT 10) z)
    UNION ALL SELECT 'A03', 'Actualizable', 'Filas omitidas al cargar (clave repetida o sin documento/secuencia/producto)', 'ERROR',
      COALESCE((ic.summary->>'omitidas')::integer, ic.expected - ic.rows_loaded, 0), NULL
    UNION ALL SELECT 'A04', 'Actualizable', 'Pendiente del ERP distinto de contratada − despachada − reemplazada', 'REVISAR',
      (SELECT count(*) FROM l WHERE NOT cantidades_ausentes AND abs(cant_contrato - cant_despachada - cant_reemplazada - cant_pendiente) > 0.000001),
      (SELECT jsonb_agg(z) FROM (SELECT nro_documento, secuencia, cod_producto, cant_contrato, cant_despachada, cant_reemplazada, cant_pendiente, linea AS fila_origen FROM l
        WHERE NOT cantidades_ausentes AND abs(cant_contrato - cant_despachada - cant_reemplazada - cant_pendiente) > 0.000001 LIMIT 10) z)
    UNION ALL SELECT 'A05', 'Actualizable', 'Despachado mayor que contratado (avance sobre 100 %, pendiente negativo)', 'REVISAR',
      (SELECT count(*) FROM l WHERE NOT cantidades_ausentes AND (cant_despachada > cant_contrato OR cant_pendiente < 0)),
      (SELECT jsonb_agg(z) FROM (SELECT nro_documento, secuencia, cod_producto, unidad_erp, cant_contrato, cant_despachada, cant_pendiente, linea AS fila_origen FROM l
        WHERE NOT cantidades_ausentes AND (cant_despachada > cant_contrato OR cant_pendiente < 0) LIMIT 10) z)
    UNION ALL SELECT 'A06', 'Actualizable', 'Cantidades ausentes en el archivo (las vistas v1 las toman como 0; el análisis exacto las deja sin valor y marca la fila incompleta)', 'REVISAR',
      (SELECT count(*) FROM l WHERE cantidades_ausentes), (SELECT jsonb_agg(z) FROM (SELECT nro_documento, secuencia, cod_producto,
        array_to_string(cantidades_ausentes_campos, ', ') AS cantidades_ausentes, linea AS fila_origen FROM l WHERE cantidades_ausentes LIMIT 10) z)
    UNION ALL SELECT 'A07', 'Actualizable', 'Cant_Reemplazada es 0 en todas las líneas (la regla de reemplazo no se puede validar)', 'INFORMATIVO',
      CASE WHEN (SELECT bool_and(cant_reemplazada = 0) FROM l) THEN (SELECT count(*) FROM l) ELSE 0 END, NULL
    UNION ALL SELECT 'A08', 'Actualizable', 'Escrituras de unidad distintas (no se suman entre sí; equivalencias sin aprobar)', 'INFORMATIVO',
      (SELECT count(DISTINCT COALESCE(unidad_erp, unidad)) FROM l),
      (SELECT jsonb_agg(z ORDER BY lineas DESC) FROM (SELECT COALESCE(unidad_erp, unidad) AS unidad_erp, count(*) AS lineas FROM l GROUP BY 1) z)
    UNION ALL SELECT 'A09', 'Actualizable', 'Vigencia_Contrato = S con Fecha_Vcto superada (Vigencia es un atributo del ERP, no se interpreta por fecha)', 'INFORMATIVO',
      (SELECT count(*) FROM l WHERE vigencia = 'S' AND fecha_vcto < v_hoy), NULL
    UNION ALL SELECT 'A10', 'Actualizable', 'Líneas sin Fecha_Contrato o sin Fecha_Vcto', 'REVISAR',
      (SELECT count(*) FROM l WHERE fecha_contrato IS NULL OR fecha_vcto IS NULL),
      (SELECT jsonb_agg(z) FROM (SELECT nro_documento, secuencia, linea AS fila_origen FROM l WHERE fecha_contrato IS NULL OR fecha_vcto IS NULL LIMIT 10) z)
    UNION ALL SELECT 'S01', 'Stock', 'Clave de stock repetida (Bodega + Cod_Producto + Unidad + Lote)', 'ERROR',
      (SELECT count(*) FROM (SELECT 1 FROM s GROUP BY public.erp_bodega(bodega), public.erp_key(cod_producto), public.erp_key(unidad), public.erp_key(lote_raw) HAVING count(*) > 1) z),
      (SELECT jsonb_agg(z) FROM (SELECT public.erp_bodega(bodega) AS bodega, cod_producto, unidad, lote_raw AS lote, count(*) AS filas FROM s GROUP BY 1, 2, 3, 4 HAVING count(*) > 1 LIMIT 10) z)
    UNION ALL SELECT 'S02', 'Stock', 'Filas sin lote (no se pueden cruzar con un documento)', 'REVISAR',
      (SELECT count(*) FROM s WHERE public.erp_key(lote_raw) IS NULL),
      (SELECT jsonb_agg(z) FROM (SELECT bodega, cod_producto, unidad, stock, linea AS fila_origen FROM s WHERE public.erp_key(lote_raw) IS NULL ORDER BY stock DESC LIMIT 10) z)
    UNION ALL SELECT 'S03', 'Stock', 'Lotes con ceros a la izquierda (se conservan; la clave sin ceros no está aprobada)', 'REVISAR',
      (SELECT count(*) FROM s WHERE public.erp_key(lote_raw) ~ '^0+[0-9]'),
      (SELECT jsonb_agg(z) FROM (SELECT lote_raw AS lote, regexp_replace(public.erp_key(lote_raw), '^0+(?=[0-9])', '') AS clave_auxiliar, cod_producto, unidad, stock, linea AS fila_origen
        FROM s WHERE public.erp_key(lote_raw) ~ '^0+[0-9]' LIMIT 10) z)
    UNION ALL SELECT 'S04', 'Stock', 'Lotes con sufijo D (significado sin confirmar)', 'REVISAR',
      (SELECT count(*) FROM s WHERE public.erp_key(lote_raw) ~ '[0-9]D$'),
      (SELECT jsonb_agg(z) FROM (SELECT lote_raw AS lote, cod_producto, unidad, stock, linea AS fila_origen FROM s WHERE public.erp_key(lote_raw) ~ '[0-9]D$' LIMIT 10) z)
    UNION ALL SELECT 'S05', 'Stock', 'Stock negativo', 'ERROR', (SELECT count(*) FROM s WHERE stock < 0),
      (SELECT jsonb_agg(z) FROM (SELECT bodega, cod_producto, lote_raw AS lote, unidad, stock, linea AS fila_origen FROM s WHERE stock < 0 LIMIT 10) z)
    UNION ALL SELECT 'S06', 'Stock', 'Stock en falla mayor que cero (significado sin confirmar: no se descuenta)', 'INFORMATIVO', (SELECT count(*) FROM s WHERE stock_falla > 0),
      (SELECT jsonb_agg(z) FROM (SELECT bodega, cod_producto, lote_raw AS lote, stock, stock_falla, linea AS fila_origen FROM s WHERE stock_falla > 0 LIMIT 10) z)
    UNION ALL SELECT 'S07', 'Stock', 'Stock_Comprometido, Requerimiento y Orden_Compra se repiten igual en lotes y bodegas del producto (medidas por producto: no se suman por lote)', 'INFORMATIVO',
      (SELECT count(*) FROM (SELECT cod_producto FROM s GROUP BY 1 HAVING count(*) > 1 AND count(DISTINCT stock_comprometido) = 1 AND max(stock_comprometido) > 0) z),
      (SELECT jsonb_agg(z) FROM (SELECT cod_producto, count(*) AS lotes, max(stock_comprometido) AS stock_comprometido, sum(stock_comprometido) AS suma_si_se_sumara
        FROM s GROUP BY 1 HAVING count(*) > 1 AND count(DISTINCT stock_comprometido) = 1 AND max(stock_comprometido) > 0 ORDER BY count(*) DESC LIMIT 10) z)
    UNION ALL SELECT 'X01', 'Cruce', 'Lote igual al documento y mismo producto, pero con unidad distinta (sin equivalencia aprobada)', 'REVISAR',
      (SELECT count(*) FROM s WHERE EXISTS (SELECT 1 FROM l WHERE public.erp_key(l.nro_documento) = public.erp_key(s.lote_raw) AND public.erp_key(l.cod_producto) = public.erp_key(s.cod_producto)
         AND public.erp_key(COALESCE(l.unidad_erp, l.unidad)) <> public.erp_key(s.unidad))),
      (SELECT jsonb_agg(z) FROM (SELECT DISTINCT s.lote_raw AS lote, s.cod_producto, s.unidad AS unidad_stock, COALESCE(l.unidad_erp, l.unidad) AS unidad_contrato, s.stock
        FROM s JOIN l ON public.erp_key(l.nro_documento) = public.erp_key(s.lote_raw) AND public.erp_key(l.cod_producto) = public.erp_key(s.cod_producto)
        WHERE public.erp_key(COALESCE(l.unidad_erp, l.unidad)) <> public.erp_key(s.unidad) LIMIT 10) z)
    UNION ALL SELECT 'X02', 'Cruce', 'Diferencia entre los cortes de los dos archivos (horas)', 'INFORMATIVO',
      round(abs(extract(epoch FROM (ic.cut_at - isk.cut_at)) / 3600)::numeric, 1)::bigint, NULL)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('codigo', codigo, 'origen', origen, 'titulo', titulo, 'tipo', tipo, 'cantidad', COALESCE(cantidad, 0), 'ejemplos', ejemplos) ORDER BY codigo), '[]'::jsonb)
  INTO v FROM c;
  RETURN jsonb_build_object('success', true, 'controles', v,
    'cortes', jsonb_build_object('contratos', ic.cut_at, 'stock', isk.cut_at, 'contratos_procesado', ic.applied_at, 'stock_procesado', isk.applied_at));
END $$;

-- ------------------------------------------------------------
-- 7. Reglas heredadas: comparación con y sin cada regla, con los mismos cortes
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.erp_reglas_comparacion()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); v_s uuid := public.erp_active_import('STOCK'); v_out jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a los datos del ERP'); END IF;
  IF v_c IS NULL OR v_s IS NULL THEN RETURN jsonb_build_object('success', true, 'sin_datos', true); END IF;
  WITH l AS (SELECT l.*, public.erp_key(l.nro_documento) AS dk, public.erp_key(l.cod_producto) AS pk, public.erp_key(COALESCE(l.unidad_erp, l.unidad)) AS u
             FROM public.erp_contract_lines l WHERE l.import_id = v_c),
  dpu AS (SELECT dk, pk, u, sum(cant_pendiente) AS pend FROM l GROUP BY 1, 2, 3),
  s AS (SELECT s.*, public.erp_key(s.lote_raw) AS lk, public.erp_key(s.cod_producto) AS pk, public.erp_key(s.unidad) AS u FROM public.erp_stock_lots s WHERE s.import_id = v_s),
  -- CIEN → UND: lote con documento y producto, stock en CIEN/MIL y contrato en otra unidad
  cien AS (
    SELECT s.lote_raw AS lote, s.cod_producto, s.producto, s.unidad AS unidad_stock, d.u AS unidad_contrato, s.stock AS stock_original, s.factor,
      s.stock * s.factor AS stock_convertido, d.pend AS pendiente_contrato, s.peso_unitario, s.peso_total AS peso_total_erp, s.bodega, d.dk, d.pk, d.u
    FROM s JOIN dpu d ON d.dk = s.lk AND d.pk = s.pk AND d.u <> s.u WHERE s.factor <> 1),
  -- Lote sin ceros: clave auxiliar y posibles colisiones
  ceros AS (
    SELECT s.lote_raw AS lote, regexp_replace(s.lk, '^0+(?=[0-9])', '') AS clave_auxiliar, s.cod_producto, s.unidad, s.stock, s.bodega,
      EXISTS (SELECT 1 FROM dpu d WHERE d.dk = regexp_replace(s.lk, '^0+(?=[0-9])', '') AND d.pk = s.pk AND d.u = s.u) AS coincide_con_clave,
      (SELECT count(*) FROM s s2 WHERE s2.lk = regexp_replace(s.lk, '^0+(?=[0-9])', '') AND s2.pk = s.pk AND s2.u = s.u AND public.erp_bodega(s2.bodega) = public.erp_bodega(s.bodega)) AS colision_misma_bodega,
      (SELECT count(*) FROM s s2 WHERE s2.lk <> s.lk AND regexp_replace(s2.lk, '^0+(?=[0-9])', '') = regexp_replace(s.lk, '^0+(?=[0-9])', '') AND s2.pk = s.pk) AS otros_lotes_misma_clave
    FROM s WHERE s.lk ~ '^0+[0-9]'),
  -- Peso: interpretación del ERP en productos con factor distinto de 1
  peso AS (
    SELECT s.bodega, s.lote_raw AS lote, s.cod_producto, s.producto, s.unidad, s.stock, s.peso_unitario, s.peso_total AS peso_total_erp,
      round(s.stock * s.peso_unitario, 4) AS stock_x_peso_unitario, round(s.stock * s.factor * s.peso_unitario, 4) AS stock_x_factor_x_peso_unitario
    FROM s WHERE s.factor <> 1 AND s.peso_unitario > 0),
  -- OT con varios tipos de documento con pendiente
  ot AS (SELECT ot, count(DISTINCT tipo_documento) AS tipos, count(DISTINCT u) AS unidades FROM l WHERE cant_pendiente > 0 GROUP BY 1)
  SELECT jsonb_build_object('success', true,
    'regla_vigente', (SELECT jsonb_build_object('version', version, 'origen', origen, 'nota', nota, 'reglas', reglas) FROM public.erp_rule_versions WHERE estado = 'VIGENTE'),
    'cortes', (SELECT jsonb_object_agg(kind, jsonb_build_object('corte', cut_at, 'procesado', applied_at, 'version_reglas', rule_version)) FROM public.erp_imports WHERE id IN (v_c, v_s)),
    'CIEN_A_UND', jsonb_build_object(
      'lotes_afectados', (SELECT count(*) FROM cien), 'productos', (SELECT count(DISTINCT cod_producto) FROM cien),
      'stock_original_por_unidad', (SELECT jsonb_object_agg(unidad_stock, q) FROM (SELECT unidad_stock, sum(stock_original) AS q FROM cien GROUP BY 1) z),
      'stock_convertido_und', (SELECT sum(stock_convertido) FROM cien),
      -- Documento + producto del contrato que solo encuentran stock con la regla (sin ella quedan «sin coincidencia»)
      'documentos_producto_que_cruzan_solo_con_regla', (SELECT count(DISTINCT (dk, pk, u)) FROM cien),
      'pendiente_que_cruza_solo_con_regla', (SELECT sum(pend) FROM (SELECT DISTINCT dk, pk, u, pendiente_contrato AS pend FROM cien) z),
      'catalogo', (SELECT jsonb_agg(z) FROM (SELECT cod_producto, max(producto) AS producto, unidad_stock, unidad_contrato, max(factor) AS factor_supuesto, count(*) AS lotes,
           'El archivo no trae factor de conversión: se infiere del nombre de la unidad' AS evidencia FROM cien GROUP BY 1, 3, 4 ORDER BY count(*) DESC) z),
      'ejemplos', (SELECT jsonb_agg(to_jsonb(z) - 'dk' - 'pk' - 'u') FROM (SELECT * FROM cien ORDER BY stock_convertido DESC LIMIT 10) z)),
    'LOTE_SIN_CEROS', jsonb_build_object(
      'lotes_con_ceros', (SELECT count(*) FROM ceros), 'coinciden_con_clave_auxiliar', (SELECT count(*) FILTER (WHERE coincide_con_clave) FROM ceros),
      'stock_que_cruza_solo_con_regla', (SELECT sum(stock) FILTER (WHERE coincide_con_clave) FROM ceros),
      'colisiones_misma_bodega', (SELECT count(*) FILTER (WHERE colision_misma_bodega > 0) FROM ceros),
      'claves_ambiguas', (SELECT count(*) FILTER (WHERE otros_lotes_misma_clave > 0) FROM ceros),
      'ejemplos', (SELECT jsonb_agg(z) FROM (SELECT * FROM ceros ORDER BY colision_misma_bodega DESC, otros_lotes_misma_clave DESC, stock DESC LIMIT 10) z)),
    'PESO_POR_UNIDAD', jsonb_build_object(
      'filas', (SELECT count(*) FROM peso),
      'peso_total_erp_coincide_con_stock_x_peso_unitario', (SELECT count(*) FILTER (WHERE abs(peso_total_erp - stock_x_peso_unitario) <= 0.01 * greatest(1, abs(peso_total_erp))) FROM peso),
      'kg_erp', (SELECT round(sum(peso_total_erp), 1) FROM peso), 'kg_con_regla', (SELECT round(sum(stock_x_factor_x_peso_unitario), 1) FROM peso),
      'ejemplos', (SELECT jsonb_agg(z) FROM (SELECT * FROM peso ORDER BY stock_x_factor_x_peso_unitario DESC LIMIT 10) z)),
    'OT_SUMA_TIPOS', jsonb_build_object(
      'ot_con_pendiente', (SELECT count(*) FROM ot), 'ot_con_varios_tipos', (SELECT count(*) FROM ot WHERE tipos > 1),
      'ot_con_varias_unidades', (SELECT count(*) FROM ot WHERE unidades > 1),
      'sobredespacho_que_la_regla_cuenta_como_cero', (SELECT jsonb_build_object('lineas', count(*), 'cantidad', sum(cant_pendiente)) FROM l WHERE cant_pendiente < 0),
      'pendiente_por_tipo_y_unidad', (SELECT jsonb_agg(z ORDER BY z.unidad, z.tipo_documento) FROM (
         SELECT tipo_documento, u AS unidad, count(*) AS lineas, sum(cant_pendiente) FILTER (WHERE cant_pendiente > 0) AS pendiente FROM l GROUP BY 1, 2) z)),
    'EXCLUSION_POR_DEFECTO', jsonb_build_object(
      'detalle', (SELECT jsonb_agg(z ORDER BY z.motivo, z.unidad) FROM (
         SELECT CASE WHEN tipo_documento = 'ERROR DE CONTRATO' THEN 'ERROR DE CONTRATO' ELSE 'SERVICIO A TERCEROS' END AS motivo, u AS unidad, count(*) AS lineas,
           count(*) FILTER (WHERE cant_pendiente > 0) AS lineas_con_pendiente, sum(cant_pendiente) FILTER (WHERE cant_pendiente > 0) AS pendiente
         FROM l WHERE tipo_documento = 'ERROR DE CONTRATO' OR tipo_producto = 'SERVICIO A TERCEROS' GROUP BY 1, 2) z)),
    'UNID_A_UND', jsonb_build_object(
      'lineas', (SELECT count(*) FROM l WHERE upper(btrim(unidad_erp)) = 'UNID'),
      'sin_unidad_original', (SELECT count(*) FROM l WHERE unidad_erp IS NULL)))
  INTO v_out;
  RETURN v_out;
END $$;

-- Registro de cargas y marcas de actualización
CREATE OR REPLACE FUNCTION public.erp_cargas_log(p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a los datos del ERP'); END IF;
  RETURN jsonb_build_object('success', true, 'regla_vigente', public.erp_rule_version(),
    'activas', COALESCE((SELECT jsonb_object_agg(kind, jsonb_build_object('corte_erp', cut_at, 'procesado_tms', applied_at, 'filas', rows_loaded, 'version_reglas', rule_version, 'archivo', file_name))
      FROM public.erp_imports WHERE status = 'ACTIVA'), '{}'::jsonb),
    'ultimo_dia_derivado', (SELECT jsonb_build_object('fecha', fecha, 'generado', created_at, 'version_reglas', rule_version) FROM public.erp_derive_days
      WHERE NOT (resumen ? 'base') ORDER BY fecha DESC LIMIT 1),
    'registro', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', l.id, 'tipo', l.kind, 'archivo', l.file_name, 'corte_erp', l.cut_at, 'inicio', l.started_at, 'fin', l.finished_at,
        'estado', CASE WHEN l.status = 'EN_CURSO' AND l.started_at < now() - interval '1 hour' THEN 'INTERRUMPIDA' ELSE l.status END,
        'filas_esperadas', l.rows_expected, 'filas_cargadas', l.rows_loaded, 'error', l.error, 'detalle', l.detalle, 'version_reglas', l.rule_version,
        'usuario', NULLIF(btrim(concat_ws(' ', to_jsonb(pr)->>'first_name', to_jsonb(pr)->>'last_name')), '')) ORDER BY l.started_at DESC)
      FROM (SELECT * FROM public.erp_load_log ORDER BY started_at DESC LIMIT least(greatest(p_limit, 1), 500)) l LEFT JOIN public.profiles pr ON pr.id = l.created_by), '[]'::jsonb));
END $$;

REVOKE ALL ON FUNCTION public.erp_log_start(jsonb), public.erp_log_finish(jsonb), public.erp_analisis(jsonb), public.erp_analisis_detalle(text, text, text),
  public.erp_stock_cruce(jsonb), public.erp_calidad(), public.erp_reglas_comparacion(), public.erp_cargas_log(integer), public.erp_rule_version() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_log_start(jsonb), public.erp_log_finish(jsonb), public.erp_analisis(jsonb), public.erp_analisis_detalle(text, text, text),
  public.erp_stock_cruce(jsonb), public.erp_calidad(), public.erp_reglas_comparacion(), public.erp_cargas_log(integer), public.erp_rule_version() TO authenticated;
REVOKE ALL ON FUNCTION public.erp_stamp_rule_version() FROM PUBLIC, anon, authenticated;

COMMIT;
