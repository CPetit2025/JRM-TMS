-- ============================================================
-- Analítica logística APT y Distribución (/apt/analitica)
-- Capas separadas: importaciones → filas originales (tal cual) → movimientos normalizados → cálculo (en el navegador,
-- src/lib/apt-analitica) → presentación. Configuración editable con auditoría: áreas, clases de documento,
-- equivalencias de unidades, vínculos de trazabilidad, saldos iniciales, compromisos y recepciones.
-- Reglas: docs/apt-analitica.md. Prueba: supabase/tests/caja_c133_apt_analitica.test.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1. Permisos: consulta (apt), operación (apt-carga) y administración (apt-admin)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apa_can_view() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.apt_can_view();
$$;
CREATE OR REPLACE FUNCTION public.apa_can_operate() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.apt_can_load();
$$;
CREATE OR REPLACE FUNCTION public.apa_can_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
    WHERE p.id = auth.uid() AND p.is_active
      AND (r.name = 'Administrador' OR COALESCE(r.permissions, '[]'::jsonb) ?| ARRAY['apt-admin', 'apt-admin:write']));
$$;

-- ------------------------------------------------------------
-- 2. Tablas
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.apa_imports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type    text NOT NULL CHECK (source_type IN ('ENTRADAS', 'SALIDAS', 'MOVIMIENTOS', 'SALDO_INICIAL', 'COMPROMISOS', 'RECEPCIONES')),
  file_name      text NOT NULL,
  file_hash      text NOT NULL,
  file_size      bigint,
  sheets         jsonb NOT NULL DEFAULT '[]'::jsonb,
  period_from    date,
  period_to      date,
  cutoff         date,
  rows_total     integer NOT NULL DEFAULT 0,
  rows_accepted  integer NOT NULL DEFAULT 0,
  rows_rejected  integer NOT NULL DEFAULT 0,
  rows_review    integer NOT NULL DEFAULT 0,
  rows_discarded integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'PREPARANDO' CHECK (status IN ('PREPARANDO', 'ACTIVA', 'REVERTIDA')),
  parser_version text,
  warnings       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  activated_at   timestamptz,
  reverted_by    uuid,
  reverted_at    timestamptz,
  revert_reason  text
);
-- Un mismo archivo (huella del contenido) no puede estar vigente dos veces para el mismo tipo de fuente
CREATE UNIQUE INDEX IF NOT EXISTS apa_imports_hash_vigente ON public.apa_imports (file_hash, source_type) WHERE status <> 'REVERTIDA';
CREATE INDEX IF NOT EXISTS apa_imports_status ON public.apa_imports (status, source_type);

-- Fila original tal como vino (hoja y fila del archivo)
CREATE TABLE IF NOT EXISTS public.apa_raw_rows (
  import_id  uuid NOT NULL REFERENCES public.apa_imports(id) ON DELETE CASCADE,
  sheet      text NOT NULL,
  row_number integer NOT NULL,
  data       jsonb NOT NULL,
  PRIMARY KEY (import_id, sheet, row_number)
);

-- Capa normalizada (identificadores como texto; datos ausentes en NULL)
CREATE TABLE IF NOT EXISTS public.apa_movements (
  id              bigserial PRIMARY KEY,
  import_id       uuid NOT NULL REFERENCES public.apa_imports(id) ON DELETE CASCADE,
  sheet           text NOT NULL,
  row_number      integer NOT NULL,
  status          text NOT NULL CHECK (status IN ('ACEPTADO', 'RECHAZADO', 'REVISION', 'DESCARTADO')),
  reasons         text[] NOT NULL DEFAULT '{}',
  fingerprint     text,
  dup             integer NOT NULL DEFAULT 1,
  side            text CHECK (side IN ('E', 'S')),
  tipo            text,
  bodega_raw      text,
  bodega          text,
  numero          text,
  fecha           date,
  cod_legal       text,
  razon_social    text,
  producto        text,
  glosa           text,
  cantidad        numeric,
  unidad          text,
  doc_rel         text,
  num_rel         text,
  fecha_entrega   date,
  contrato        text,
  ref_tipo        text,
  ref_correlativo text,
  ref_numero      text,
  ref_fecha       date,
  lote            text,
  color           text,
  comentario      text,
  peso_unitario   numeric,
  peso_x_producir numeric,
  peso_producido  numeric,
  ccosto          text,
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  review_note     text,
  UNIQUE (import_id, sheet, row_number)
);
CREATE INDEX IF NOT EXISTS apa_movements_fingerprint ON public.apa_movements (fingerprint, dup) WHERE fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS apa_movements_bodega ON public.apa_movements (bodega);

CREATE TABLE IF NOT EXISTS public.apa_opening_balances (
  id         bigserial PRIMARY KEY,
  import_id  uuid NOT NULL REFERENCES public.apa_imports(id) ON DELETE CASCADE,
  sheet      text NOT NULL,
  row_number integer NOT NULL,
  status     text NOT NULL CHECK (status IN ('ACEPTADO', 'RECHAZADO', 'REVISION', 'DESCARTADO')),
  reasons    text[] NOT NULL DEFAULT '{}',
  bodega     text, producto text, lote text, unidad text, cantidad numeric, cutoff date,
  UNIQUE (import_id, sheet, row_number)
);

-- Compromisos comerciales con versiones (la versión mayor de cada pedido + línea es la vigente)
CREATE TABLE IF NOT EXISTS public.apa_commitments (
  id               bigserial PRIMARY KEY,
  import_id        uuid NOT NULL REFERENCES public.apa_imports(id) ON DELETE CASCADE,
  sheet            text NOT NULL,
  row_number       integer NOT NULL,
  status           text NOT NULL CHECK (status IN ('ACEPTADO', 'RECHAZADO', 'REVISION', 'DESCARTADO')),
  reasons          text[] NOT NULL DEFAULT '{}',
  pedido text, linea text, producto text, unidad text, cantidad numeric, fecha_compromiso date,
  version          integer NOT NULL DEFAULT 1,
  estado           text NOT NULL DEFAULT 'VIGENTE',
  UNIQUE (import_id, sheet, row_number)
);

-- Recepciones y constancias de entrega
CREATE TABLE IF NOT EXISTS public.apa_receipts (
  id         bigserial PRIMARY KEY,
  import_id  uuid NOT NULL REFERENCES public.apa_imports(id) ON DELETE CASCADE,
  sheet      text NOT NULL,
  row_number integer NOT NULL,
  status     text NOT NULL CHECK (status IN ('ACEPTADO', 'RECHAZADO', 'REVISION', 'DESCARTADO')),
  reasons    text[] NOT NULL DEFAULT '{}',
  despacho text, producto text, unidad text, aceptada numeric, rechazada numeric, fecha date, motivo text, pedido text, linea text,
  UNIQUE (import_id, sheet, row_number)
);

-- Bodega → área (editable por un administrador)
CREATE TABLE IF NOT EXISTS public.apa_areas (
  bodega     text PRIMARY KEY,
  area       text CHECK (area IN ('APT', 'APT_LB', 'DIST')),
  confirmed  boolean NOT NULL DEFAULT false,
  note       text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.apa_areas (bodega, area, confirmed, note) VALUES
  ('647-04 ALM PT', 'APT', true, 'APT principal'),
  ('540-04 APT LB', 'APT_LB', true, 'APT LB'),
  ('ST-VENTAS-IMD', 'DIST', false, 'Distribución: asociación pendiente de confirmación del negocio')
ON CONFLICT (bodega) DO NOTHING;

-- TipoDocto → clase de movimiento
CREATE TABLE IF NOT EXISTS public.apa_doc_classes (
  tipo       text PRIMARY KEY,
  clase      text NOT NULL CHECK (clase IN ('PRODUCCION', 'COMPRA', 'TRASPASO', 'DESPACHO_VENTA', 'CONSUMO', 'SERVICIO_TERCERO', 'PRESTAMO',
                                            'DEVOLUCION', 'AJUSTE', 'ANULACION', 'SIN_CLASIFICAR')),
  confirmed  boolean NOT NULL DEFAULT false,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.apa_doc_classes (tipo, clase, confirmed) VALUES
  ('P/E PRODUCCION ACT.', 'PRODUCCION', true), ('P/E RETACERIA', 'PRODUCCION', true),
  ('N/INGRESO ALMACEN', 'COMPRA', true), ('N/INGRESO ACTIVO', 'COMPRA', true), ('RECEPCION IMPORTACION', 'COMPRA', true),
  ('TRASPASO DE ALMACEN', 'TRASPASO', true), ('TRASPASO DE ALMACEN APT', 'TRASPASO', true),
  ('DESPACHO VENTAS', 'DESPACHO_VENTA', true),
  ('VALE DE CONSUMO', 'CONSUMO', true), ('V/C ACTIVOS', 'CONSUMO', true), ('V/C MANTENIMIENTOS', 'CONSUMO', true), ('V/C PRODUCCION ACT.', 'CONSUMO', true),
  ('GS SERV TERCEROS', 'SERVICIO_TERCERO', true), ('PE SERV TERCEROS', 'SERVICIO_TERCERO', true),
  ('SALIDA HERRAMIENTAS', 'PRESTAMO', true), ('DEV. HERRAMIENTAS', 'DEVOLUCION', true),
  ('G/DEV INDIRECTO', 'DEVOLUCION', true), ('GUIA DE RECOJO', 'DEVOLUCION', true)
ON CONFLICT (tipo) DO NOTHING;

-- Equivalencias de unidades: solo las verificadas se usan para convertir
CREATE TABLE IF NOT EXISTS public.apa_conversions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  producto   text,
  from_unit  text NOT NULL,
  to_unit    text NOT NULL,
  factor     numeric NOT NULL CHECK (factor > 0),
  verified   boolean NOT NULL DEFAULT false,
  note       text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS apa_conversions_key ON public.apa_conversions (COALESCE(producto, ''), from_unit, to_unit);

-- Equivalencias de trazabilidad: lote origen → traspaso → lote/asignación destino → OT/pedido → despacho → recepción.
-- Admite relaciones parciales (qty), divisiones y consolidaciones (varios vínculos por referencia).
CREATE TABLE IF NOT EXISTS public.apa_links (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_kind  text NOT NULL CHECK (from_kind IN ('LOTE', 'TRASPASO', 'OT', 'OP', 'PEDIDO', 'CONTRATO', 'DESPACHO', 'RECEPCION')),
  from_ref   text NOT NULL,
  to_kind    text NOT NULL CHECK (to_kind IN ('LOTE', 'TRASPASO', 'OT', 'OP', 'PEDIDO', 'CONTRATO', 'DESPACHO', 'RECEPCION')),
  to_ref     text NOT NULL,
  qty        numeric CHECK (qty IS NULL OR qty > 0),
  unidad     text,
  origin     text NOT NULL CHECK (origin IN ('SISTEMA', 'REGLA', 'MANUAL')),
  rule       text,
  note       text,
  status     text NOT NULL DEFAULT 'VIGENTE' CHECK (status IN ('VIGENTE', 'ANULADO')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS apa_links_from ON public.apa_links (from_kind, from_ref);
CREATE INDEX IF NOT EXISTS apa_links_to ON public.apa_links (to_kind, to_ref);

CREATE TABLE IF NOT EXISTS public.apa_settings (
  id               integer PRIMARY KEY CHECK (id = 1),
  same_day_order   text NOT NULL DEFAULT 'ENTRADAS_PRIMERO' CHECK (same_day_order IN ('ENTRADAS_PRIMERO', 'SALIDAS_PRIMERO')),
  age_buckets      integer[] NOT NULL DEFAULT '{0,1,3,7,15,30}',
  default_ref_date date NOT NULL DEFAULT '2020-03-22',
  updated_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.apa_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.apa_saved_views (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner      uuid NOT NULL,
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  state      jsonb NOT NULL,
  shared     boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS apa_saved_views_owner ON public.apa_saved_views (owner);

-- Auditoría de cargas, revisiones, equivalencias, correcciones y configuración (incluye el historial de vínculos)
CREATE TABLE IF NOT EXISTS public.apa_audit (
  id        bigserial PRIMARY KEY,
  entity    text NOT NULL,
  entity_id text,
  action    text NOT NULL,
  before    jsonb,
  after     jsonb,
  note      text,
  by_user   uuid,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS apa_audit_entity ON public.apa_audit (entity, entity_id, at DESC);

-- Seguridad: solo por funciones (sin acceso directo a las tablas)
ALTER TABLE public.apa_imports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.apa_imports;
CREATE POLICY security_active_account ON public.apa_imports AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.apa_imports FROM PUBLIC, anon, authenticated;
ALTER TABLE public.apa_raw_rows ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.apa_raw_rows;
CREATE POLICY security_active_account ON public.apa_raw_rows AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.apa_raw_rows FROM PUBLIC, anon, authenticated;
ALTER TABLE public.apa_movements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.apa_movements;
CREATE POLICY security_active_account ON public.apa_movements AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.apa_movements FROM PUBLIC, anon, authenticated;
ALTER TABLE public.apa_opening_balances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.apa_opening_balances;
CREATE POLICY security_active_account ON public.apa_opening_balances AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.apa_opening_balances FROM PUBLIC, anon, authenticated;
ALTER TABLE public.apa_commitments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.apa_commitments;
CREATE POLICY security_active_account ON public.apa_commitments AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.apa_commitments FROM PUBLIC, anon, authenticated;
ALTER TABLE public.apa_receipts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.apa_receipts;
CREATE POLICY security_active_account ON public.apa_receipts AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.apa_receipts FROM PUBLIC, anon, authenticated;
ALTER TABLE public.apa_areas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.apa_areas;
CREATE POLICY security_active_account ON public.apa_areas AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.apa_areas FROM PUBLIC, anon, authenticated;
ALTER TABLE public.apa_doc_classes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.apa_doc_classes;
CREATE POLICY security_active_account ON public.apa_doc_classes AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.apa_doc_classes FROM PUBLIC, anon, authenticated;
ALTER TABLE public.apa_conversions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.apa_conversions;
CREATE POLICY security_active_account ON public.apa_conversions AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.apa_conversions FROM PUBLIC, anon, authenticated;
ALTER TABLE public.apa_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.apa_links;
CREATE POLICY security_active_account ON public.apa_links AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.apa_links FROM PUBLIC, anon, authenticated;
ALTER TABLE public.apa_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.apa_settings;
CREATE POLICY security_active_account ON public.apa_settings AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.apa_settings FROM PUBLIC, anon, authenticated;
ALTER TABLE public.apa_saved_views ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.apa_saved_views;
CREATE POLICY security_active_account ON public.apa_saved_views AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.apa_saved_views FROM PUBLIC, anon, authenticated;
ALTER TABLE public.apa_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.apa_audit;
CREATE POLICY security_active_account ON public.apa_audit AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.apa_audit FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.apa_movements_id_seq, public.apa_opening_balances_id_seq, public.apa_commitments_id_seq,
  public.apa_receipts_id_seq, public.apa_audit_id_seq FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Entidades derivadas (documentos, productos, clientes, lotes, órdenes, traspasos) sobre lo aceptado y vigente
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.apa_v_movimientos_vigentes WITH (security_invoker = true) AS
  SELECT m.* FROM public.apa_movements m JOIN public.apa_imports i ON i.id = m.import_id
  WHERE i.status = 'ACTIVA' AND m.status = 'ACEPTADO';
CREATE OR REPLACE VIEW public.apa_v_documentos WITH (security_invoker = true) AS
  SELECT tipo, numero, fecha, min(razon_social) AS cliente, count(*) AS lineas, array_agg(DISTINCT bodega) AS bodegas
  FROM public.apa_v_movimientos_vigentes GROUP BY tipo, numero, fecha;
CREATE OR REPLACE VIEW public.apa_v_productos WITH (security_invoker = true) AS
  SELECT producto, min(glosa) AS glosa, array_agg(DISTINCT unidad) AS unidades, count(*) AS lineas
  FROM public.apa_v_movimientos_vigentes GROUP BY producto;
CREATE OR REPLACE VIEW public.apa_v_clientes WITH (security_invoker = true) AS
  SELECT cod_legal, razon_social, count(*) AS lineas FROM public.apa_v_movimientos_vigentes WHERE razon_social IS NOT NULL GROUP BY cod_legal, razon_social;
CREATE OR REPLACE VIEW public.apa_v_lotes WITH (security_invoker = true) AS
  SELECT lote, producto, bodega, unidad, min(fecha) AS primera, max(fecha) AS ultima, count(*) AS lineas
  FROM public.apa_v_movimientos_vigentes WHERE lote IS NOT NULL GROUP BY lote, producto, bodega, unidad;
CREATE OR REPLACE VIEW public.apa_v_ordenes WITH (security_invoker = true) AS
  SELECT doc_rel, num_rel, contrato, count(*) AS lineas FROM public.apa_v_movimientos_vigentes WHERE num_rel IS NOT NULL OR contrato IS NOT NULL
  GROUP BY doc_rel, num_rel, contrato;
CREATE OR REPLACE VIEW public.apa_v_traspasos WITH (security_invoker = true) AS
  SELECT tipo, numero, fecha, producto, unidad,
    sum(CASE WHEN side = 'S' THEN -cantidad ELSE 0 END) AS salida, sum(CASE WHEN side = 'E' THEN cantidad ELSE 0 END) AS entrada,
    array_agg(DISTINCT lote) FILTER (WHERE side = 'S') AS lotes_origen, array_agg(DISTINCT lote) FILTER (WHERE side = 'E') AS lotes_destino
  FROM public.apa_v_movimientos_vigentes m
  WHERE EXISTS (SELECT 1 FROM public.apa_doc_classes c WHERE c.tipo = m.tipo AND c.clase = 'TRASPASO')
  GROUP BY tipo, numero, fecha, producto, unidad;
DO $$
DECLARE v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['apa_v_movimientos_vigentes', 'apa_v_documentos', 'apa_v_productos', 'apa_v_clientes', 'apa_v_lotes', 'apa_v_ordenes', 'apa_v_traspasos'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v);
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 4. Auditoría
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apa_log(p_entity text, p_id text, p_action text, p_before jsonb, p_after jsonb, p_note text DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO public.apa_audit (entity, entity_id, action, before, after, note, by_user) VALUES (p_entity, p_id, p_action, p_before, p_after, p_note, auth.uid());
$$;

-- ------------------------------------------------------------
-- 5. Importación
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apa_family(p_source text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p_source IN ('ENTRADAS', 'SALIDAS', 'MOVIMIENTOS') THEN 'MOVIMIENTOS' ELSE p_source END;
$$;

CREATE OR REPLACE FUNCTION public.apa_import_begin(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid; v_dup record; v_src text := p->>'source_type'; v_from date := NULLIF(p->>'period_from', '')::date; v_to date := NULLIF(p->>'period_to', '')::date;
  v_over jsonb;
BEGIN
  IF NOT public.apa_can_operate() THEN RAISE EXCEPTION 'Sin permiso para cargar datos (apt-carga)'; END IF;
  IF COALESCE(p->>'file_hash', '') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Huella del archivo no válida'; END IF;
  IF COALESCE((p->>'file_size')::bigint, 0) > 41943040 THEN RAISE EXCEPTION 'El archivo supera 40 MB'; END IF;
  -- Cargas en preparación abandonadas por más de un día se eliminan
  DELETE FROM public.apa_imports WHERE status = 'PREPARANDO' AND created_at < now() - interval '1 day';
  SELECT id, file_name, created_at, status INTO v_dup FROM public.apa_imports
  WHERE file_hash = p->>'file_hash' AND source_type = v_src AND status <> 'REVERTIDA' LIMIT 1;
  IF FOUND THEN
    IF v_dup.status = 'PREPARANDO' THEN DELETE FROM public.apa_imports WHERE id = v_dup.id;
    ELSE
      RETURN jsonb_build_object('success', false, 'duplicate', jsonb_build_object('id', v_dup.id, 'file_name', v_dup.file_name, 'created_at', v_dup.created_at),
        'error', format('Este archivo ya está importado (%s, %s). Para volver a cargarlo, revierta primero esa importación.', v_dup.file_name, to_char(v_dup.created_at AT TIME ZONE 'America/Lima', 'DD/MM/YYYY HH24:MI')));
    END IF;
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'file_name', file_name, 'source_type', source_type, 'period_from', period_from, 'period_to', period_to) ORDER BY created_at), '[]')
  INTO v_over FROM public.apa_imports
  WHERE status = 'ACTIVA' AND public.apa_family(source_type) = public.apa_family(v_src) AND v_from IS NOT NULL AND v_to IS NOT NULL
    AND period_from <= v_to AND period_to >= v_from;
  INSERT INTO public.apa_imports (source_type, file_name, file_hash, file_size, sheets, period_from, period_to, cutoff, parser_version, warnings, created_by)
  VALUES (v_src, left(p->>'file_name', 250), p->>'file_hash', (p->>'file_size')::bigint, COALESCE(p->'sheets', '[]'), v_from, v_to,
    NULLIF(p->>'cutoff', '')::date, p->>'parser_version', COALESCE(p->'warnings', '[]'), auth.uid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', true, 'id', v_id, 'overlaps', v_over);
END $$;

-- Filas de una carga en bloques: fila original + capa normalizada. Reintentar un bloque no duplica filas.
CREATE OR REPLACE FUNCTION public.apa_import_rows(p_import uuid, p_rows jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_src text; v_n integer;
BEGIN
  IF NOT public.apa_can_operate() THEN RAISE EXCEPTION 'Sin permiso para cargar datos (apt-carga)'; END IF;
  SELECT source_type INTO v_src FROM public.apa_imports WHERE id = p_import AND status = 'PREPARANDO';
  IF v_src IS NULL THEN RAISE EXCEPTION 'La carga no existe o ya fue cerrada'; END IF;
  IF jsonb_array_length(p_rows) > 2000 THEN RAISE EXCEPTION 'Bloque demasiado grande (máximo 2000 filas)'; END IF;
  INSERT INTO public.apa_raw_rows (import_id, sheet, row_number, data)
  SELECT p_import, r->>'sheet', (r->>'row')::int, COALESCE(r->'raw', '{}') FROM jsonb_array_elements(p_rows) r
  ON CONFLICT DO NOTHING;
  IF public.apa_family(v_src) = 'MOVIMIENTOS' THEN
    INSERT INTO public.apa_movements (import_id, sheet, row_number, status, reasons, fingerprint, dup, side, tipo, bodega_raw, bodega, numero, fecha, cod_legal,
      razon_social, producto, glosa, cantidad, unidad, doc_rel, num_rel, fecha_entrega, contrato, ref_tipo, ref_correlativo, ref_numero, ref_fecha, lote, color,
      comentario, peso_unitario, peso_x_producir, peso_producido, ccosto)
    SELECT p_import, r->>'sheet', (r->>'row')::int, r->>'status', COALESCE(ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(r->'reasons') = 'array' THEN r->'reasons' ELSE '[]'::jsonb END)), '{}'), r->>'fingerprint',
      COALESCE((r->>'dup')::int, 1), n->>'side', n->>'tipo', n->>'bodegaRaw', n->>'bodega', n->>'numero', (n->>'fecha')::date, n->>'codLegal', n->>'razonSocial',
      n->>'producto', n->>'glosa', (n->>'cantidad')::numeric, n->>'unidad', n->>'docRel', n->>'numRel', (n->>'fechaEntrega')::date, n->>'contrato', n->>'refTipo',
      n->>'refCorrelativo', n->>'refNumero', (n->>'refFecha')::date, n->>'lote', n->>'color', n->>'comentario', (n->>'pesoUnitario')::numeric,
      (n->>'pesoXProducir')::numeric, (n->>'pesoProducido')::numeric, n->>'ccosto'
    FROM jsonb_array_elements(p_rows) r, LATERAL (SELECT COALESCE(r->'norm', '{}'::jsonb) AS n) x
    ON CONFLICT (import_id, sheet, row_number) DO NOTHING;
  ELSIF v_src = 'SALDO_INICIAL' THEN
    INSERT INTO public.apa_opening_balances (import_id, sheet, row_number, status, reasons, bodega, producto, lote, unidad, cantidad, cutoff)
    SELECT p_import, r->>'sheet', (r->>'row')::int, r->>'status', COALESCE(ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(r->'reasons') = 'array' THEN r->'reasons' ELSE '[]'::jsonb END)), '{}'),
      upper(regexp_replace(btrim(n->>'Bodega'), '\s+', ' ', 'g')), n->>'Producto', NULLIF(n->>'Lote', ''), n->>'Unidad', (n->>'Cantidad')::numeric, (n->>'FechaCorte')::date
    FROM jsonb_array_elements(p_rows) r, LATERAL (SELECT COALESCE(r->'norm', '{}'::jsonb) AS n) x
    ON CONFLICT (import_id, sheet, row_number) DO NOTHING;
  ELSIF v_src = 'COMPROMISOS' THEN
    INSERT INTO public.apa_commitments (import_id, sheet, row_number, status, reasons, pedido, linea, producto, unidad, cantidad, fecha_compromiso, version, estado)
    SELECT p_import, r->>'sheet', (r->>'row')::int, r->>'status', COALESCE(ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(r->'reasons') = 'array' THEN r->'reasons' ELSE '[]'::jsonb END)), '{}'),
      n->>'Pedido', n->>'Linea', n->>'Producto', n->>'Unidad', (n->>'Cantidad')::numeric, (n->>'FechaCompromiso')::date, COALESCE((n->>'Version')::numeric::int, 1),
      CASE WHEN upper(COALESCE(n->>'Estado', '')) ~ 'CANCEL|ANUL' THEN 'CANCELADO' ELSE 'VIGENTE' END
    FROM jsonb_array_elements(p_rows) r, LATERAL (SELECT COALESCE(r->'norm', '{}'::jsonb) AS n) x
    ON CONFLICT (import_id, sheet, row_number) DO NOTHING;
  ELSE
    INSERT INTO public.apa_receipts (import_id, sheet, row_number, status, reasons, despacho, producto, unidad, aceptada, rechazada, fecha, motivo, pedido, linea)
    SELECT p_import, r->>'sheet', (r->>'row')::int, r->>'status', COALESCE(ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(r->'reasons') = 'array' THEN r->'reasons' ELSE '[]'::jsonb END)), '{}'),
      n->>'Despacho', n->>'Producto', n->>'Unidad', (n->>'CantidadAceptada')::numeric, (n->>'CantidadRechazada')::numeric, (n->>'FechaRecepcion')::date,
      n->>'Motivo', n->>'Pedido', n->>'Linea'
    FROM jsonb_array_elements(p_rows) r, LATERAL (SELECT COALESCE(r->'norm', '{}'::jsonb) AS n) x
    ON CONFLICT (import_id, sheet, row_number) DO NOTHING;
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION public.apa_import_counts(p_import uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_src text; c record;
BEGIN
  SELECT source_type INTO v_src FROM public.apa_imports WHERE id = p_import;
  IF public.apa_family(v_src) = 'MOVIMIENTOS' THEN
    SELECT count(*) t, count(*) FILTER (WHERE status = 'ACEPTADO') a, count(*) FILTER (WHERE status = 'RECHAZADO') r,
      count(*) FILTER (WHERE status = 'REVISION') v, count(*) FILTER (WHERE status = 'DESCARTADO') d INTO c FROM public.apa_movements WHERE import_id = p_import;
  ELSIF v_src = 'SALDO_INICIAL' THEN
    SELECT count(*) t, count(*) FILTER (WHERE status = 'ACEPTADO') a, count(*) FILTER (WHERE status = 'RECHAZADO') r,
      count(*) FILTER (WHERE status = 'REVISION') v, count(*) FILTER (WHERE status = 'DESCARTADO') d INTO c FROM public.apa_opening_balances WHERE import_id = p_import;
  ELSIF v_src = 'COMPROMISOS' THEN
    SELECT count(*) t, count(*) FILTER (WHERE status = 'ACEPTADO') a, count(*) FILTER (WHERE status = 'RECHAZADO') r,
      count(*) FILTER (WHERE status = 'REVISION') v, count(*) FILTER (WHERE status = 'DESCARTADO') d INTO c FROM public.apa_commitments WHERE import_id = p_import;
  ELSE
    SELECT count(*) t, count(*) FILTER (WHERE status = 'ACEPTADO') a, count(*) FILTER (WHERE status = 'RECHAZADO') r,
      count(*) FILTER (WHERE status = 'REVISION') v, count(*) FILTER (WHERE status = 'DESCARTADO') d INTO c FROM public.apa_receipts WHERE import_id = p_import;
  END IF;
  UPDATE public.apa_imports SET rows_total = c.t, rows_accepted = c.a, rows_rejected = c.r, rows_review = c.v, rows_discarded = c.d WHERE id = p_import;
END $$;

-- Cierra la carga: las líneas iguales (misma huella y mismo n.° de repetición) a otra carga vigente quedan EN REVISIÓN
CREATE OR REPLACE FUNCTION public.apa_import_finish(p_import uuid, p_expected integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_imp public.apa_imports; v_rep integer := 0; v_raw integer;
BEGIN
  IF NOT public.apa_can_operate() THEN RAISE EXCEPTION 'Sin permiso para cargar datos (apt-carga)'; END IF;
  SELECT * INTO v_imp FROM public.apa_imports WHERE id = p_import AND status = 'PREPARANDO' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'La carga no existe o ya fue cerrada'; END IF;
  SELECT count(*) INTO v_raw FROM public.apa_raw_rows WHERE import_id = p_import;
  IF p_expected IS NOT NULL AND v_raw <> p_expected THEN
    RAISE EXCEPTION 'Faltan filas: se recibieron % de %. Reintente la carga.', v_raw, p_expected;
  END IF;
  IF public.apa_family(v_imp.source_type) = 'MOVIMIENTOS' THEN
    WITH rep AS (
      SELECT n.id, (SELECT i.file_name FROM public.apa_movements o JOIN public.apa_imports i ON i.id = o.import_id
                    WHERE o.fingerprint = n.fingerprint AND o.dup = n.dup AND o.import_id <> p_import AND i.status = 'ACTIVA'
                      AND o.status IN ('ACEPTADO', 'REVISION') LIMIT 1) AS other
      FROM public.apa_movements n WHERE n.import_id = p_import AND n.status = 'ACEPTADO' AND n.fingerprint IS NOT NULL)
    UPDATE public.apa_movements m SET status = 'REVISION', reasons = m.reasons || ('Posible movimiento repetido: la misma línea está en la carga «' || rep.other || '»')
    FROM rep WHERE rep.id = m.id AND rep.other IS NOT NULL;
    GET DIAGNOSTICS v_rep = ROW_COUNT;
  END IF;
  UPDATE public.apa_imports SET status = 'ACTIVA', activated_at = now() WHERE id = p_import;
  PERFORM public.apa_import_counts(p_import);
  SELECT * INTO v_imp FROM public.apa_imports WHERE id = p_import;
  PERFORM public.apa_log('importacion', p_import::text, 'ACTIVAR', NULL, to_jsonb(v_imp) - 'warnings', NULL);
  RETURN jsonb_build_object('success', true, 'id', p_import, 'repeated', v_rep, 'rows_total', v_imp.rows_total, 'rows_accepted', v_imp.rows_accepted,
    'rows_rejected', v_imp.rows_rejected, 'rows_review', v_imp.rows_review);
END $$;

CREATE OR REPLACE FUNCTION public.apa_import_revert(p_import uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_imp public.apa_imports;
BEGIN
  IF NOT public.apa_can_operate() THEN RAISE EXCEPTION 'Sin permiso para revertir cargas (apt-carga)'; END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 5 THEN RAISE EXCEPTION 'Indique el motivo de la reversión'; END IF;
  SELECT * INTO v_imp FROM public.apa_imports WHERE id = p_import AND status = 'ACTIVA' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Solo se revierte una carga vigente'; END IF;
  UPDATE public.apa_imports SET status = 'REVERTIDA', reverted_by = auth.uid(), reverted_at = now(), revert_reason = btrim(p_reason) WHERE id = p_import;
  PERFORM public.apa_log('importacion', p_import::text, 'REVERTIR', to_jsonb(v_imp) - 'warnings', NULL, btrim(p_reason));
  RETURN jsonb_build_object('success', true,
    'pending_elsewhere', (SELECT count(*) FROM public.apa_movements m JOIN public.apa_imports i ON i.id = m.import_id
      WHERE i.status = 'ACTIVA' AND m.status = 'REVISION' AND EXISTS (SELECT 1 FROM unnest(m.reasons) x WHERE x LIKE '%«' || v_imp.file_name || '»%')));
END $$;

-- Revisión de filas: aceptar (entran a los cálculos) o descartar (quedan guardadas, fuera de los cálculos)
CREATE OR REPLACE FUNCTION public.apa_review_resolve(p_import uuid, p_ids bigint[], p_decision text, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer; v_to text;
BEGIN
  IF NOT public.apa_can_operate() THEN RAISE EXCEPTION 'Sin permiso para revisar cargas (apt-carga)'; END IF;
  IF p_decision NOT IN ('ACEPTAR', 'DESCARTAR', 'REABRIR') THEN RAISE EXCEPTION 'Decisión no válida'; END IF;
  IF length(btrim(COALESCE(p_note, ''))) < 5 THEN RAISE EXCEPTION 'Indique el motivo de la decisión'; END IF;
  v_to := CASE p_decision WHEN 'ACEPTAR' THEN 'ACEPTADO' WHEN 'DESCARTAR' THEN 'DESCARTADO' ELSE 'REVISION' END;
  UPDATE public.apa_movements SET status = v_to, reviewed_by = auth.uid(), reviewed_at = now(), review_note = btrim(p_note)
  WHERE import_id = p_import
    AND (p_ids IS NULL OR id = ANY (p_ids))
    AND CASE WHEN p_decision = 'REABRIR' THEN status = 'DESCARTADO'
             WHEN p_decision = 'DESCARTAR' THEN status IN ('REVISION', 'ACEPTADO')
             ELSE status = 'REVISION' END
    AND (p_ids IS NOT NULL OR status = 'REVISION' OR p_decision = 'REABRIR');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM public.apa_import_counts(p_import);
  PERFORM public.apa_log('revision', p_import::text, p_decision, jsonb_build_object('ids', p_ids), jsonb_build_object('rows', v_n), btrim(p_note));
  RETURN jsonb_build_object('success', true, 'updated', v_n);
END $$;

CREATE OR REPLACE FUNCTION public.apa_imports_list() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apa_can_view() THEN RAISE EXCEPTION 'Sin permiso (apt)'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', i.id, 'source_type', i.source_type, 'file_name', i.file_name, 'file_hash', i.file_hash,
    'file_size', i.file_size, 'sheets', i.sheets, 'period_from', i.period_from, 'period_to', i.period_to, 'cutoff', i.cutoff, 'rows_total', i.rows_total,
    'rows_accepted', i.rows_accepted, 'rows_rejected', i.rows_rejected, 'rows_review', i.rows_review, 'rows_discarded', i.rows_discarded, 'status', i.status,
    'warnings', i.warnings, 'created_at', i.created_at, 'created_by', (SELECT COALESCE(to_jsonb(p)->>'full_name', to_jsonb(p)->>'email') FROM public.profiles p WHERE p.id = i.created_by),
    'reverted_at', i.reverted_at, 'revert_reason', i.revert_reason,
    'reverted_by', (SELECT COALESCE(to_jsonb(p)->>'full_name', to_jsonb(p)->>'email') FROM public.profiles p WHERE p.id = i.reverted_by)) ORDER BY i.created_at DESC)
    FROM public.apa_imports i WHERE i.status <> 'PREPARANDO'), '[]'::jsonb);
END $$;

-- ------------------------------------------------------------
-- 6. Lectura para el motor de cálculo
-- ------------------------------------------------------------
-- Alcance: bodegas mapeadas a un área + traspasos (para conciliar origen y destino) + filas no aceptadas (calidad)
CREATE OR REPLACE FUNCTION public.apa_dataset_page(p_after bigint, p_limit integer DEFAULT 5000, p_scope text DEFAULT 'AREAS') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_rows jsonb; v_last bigint; v_n integer; v_lim integer := LEAST(GREATEST(COALESCE(p_limit, 5000), 100), 10000);
BEGIN
  IF NOT public.apa_can_view() THEN RAISE EXCEPTION 'Sin permiso (apt)'; END IF;
  WITH page AS (
    SELECT m.* FROM public.apa_movements m JOIN public.apa_imports i ON i.id = m.import_id AND i.status = 'ACTIVA'
    WHERE m.id > COALESCE(p_after, 0) AND m.status <> 'DESCARTADO'
      AND (p_scope = 'TODO' OR m.status <> 'ACEPTADO'
           OR EXISTS (SELECT 1 FROM public.apa_areas a WHERE a.bodega = m.bodega AND a.area IS NOT NULL)
           OR EXISTS (SELECT 1 FROM public.apa_doc_classes c WHERE c.tipo = m.tipo AND c.clase = 'TRASPASO')
           OR m.tipo ILIKE '%TRASPASO%')
    ORDER BY m.id LIMIT v_lim)
  SELECT COALESCE(jsonb_agg(jsonb_build_array(id, import_id, sheet, row_number, status, reasons, dup, side, tipo, bodega_raw, bodega, numero, fecha, cod_legal,
    razon_social, producto, glosa, cantidad, unidad, doc_rel, num_rel, fecha_entrega, contrato, ref_tipo, ref_correlativo, ref_numero, ref_fecha, lote, color,
    comentario, peso_unitario, peso_x_producir, peso_producido, ccosto) ORDER BY id), '[]'), max(id), count(*)
  INTO v_rows, v_last, v_n FROM page;
  RETURN jsonb_build_object('rows', v_rows, 'last_id', v_last, 'done', v_n < v_lim);
END $$;

CREATE OR REPLACE FUNCTION public.apa_meta() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.apa_settings;
BEGIN
  IF NOT public.apa_can_view() THEN RAISE EXCEPTION 'Sin permiso (apt)'; END IF;
  SELECT * INTO s FROM public.apa_settings WHERE id = 1;
  RETURN jsonb_build_object(
    'can_operate', public.apa_can_operate(), 'can_admin', public.apa_can_admin(),
    'settings', jsonb_build_object('sameDayOrder', s.same_day_order, 'ageBuckets', to_jsonb(s.age_buckets), 'defaultRefDate', s.default_ref_date),
    'areas', COALESCE((SELECT jsonb_agg(jsonb_build_object('bodega', bodega, 'area', area, 'confirmed', confirmed, 'note', note, 'updated_at', updated_at) ORDER BY bodega) FROM public.apa_areas), '[]'),
    'classes', COALESCE((SELECT jsonb_object_agg(tipo, clase) FROM public.apa_doc_classes), '{}'),
    'class_rows', COALESCE((SELECT jsonb_agg(jsonb_build_object('tipo', tipo, 'clase', clase, 'confirmed', confirmed) ORDER BY tipo) FROM public.apa_doc_classes), '[]'),
    'conversions', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'producto', producto, 'fromUnit', from_unit, 'toUnit', to_unit, 'factor', factor, 'verified', verified, 'note', note)) FROM public.apa_conversions), '[]'),
    'links', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'fromKind', from_kind, 'fromRef', from_ref, 'toKind', to_kind, 'toRef', to_ref, 'qty', qty, 'unidad', unidad,
      'origin', origin, 'note', note, 'status', status, 'rule', rule, 'updated_at', updated_at) ORDER BY updated_at DESC) FROM public.apa_links), '[]'),
    'openings', COALESCE((SELECT jsonb_agg(jsonb_build_object('bodega', o.bodega, 'producto', o.producto, 'lote', o.lote, 'unidad', o.unidad, 'cantidad', o.cantidad, 'cutoff', o.cutoff))
      FROM public.apa_opening_balances o JOIN public.apa_imports i ON i.id = o.import_id AND i.status = 'ACTIVA' WHERE o.status = 'ACEPTADO'), '[]'),
    'commitments', COALESCE((SELECT jsonb_agg(jsonb_build_object('pedido', c.pedido, 'linea', c.linea, 'producto', c.producto, 'unidad', c.unidad, 'cantidad', c.cantidad,
      'fechaCompromiso', c.fecha_compromiso, 'version', c.version, 'estado', c.estado))
      FROM public.apa_commitments c JOIN public.apa_imports i ON i.id = c.import_id AND i.status = 'ACTIVA' WHERE c.status = 'ACEPTADO'), '[]'),
    'receipts', COALESCE((SELECT jsonb_agg(jsonb_build_object('despacho', r.despacho, 'producto', r.producto, 'unidad', r.unidad, 'aceptada', r.aceptada, 'rechazada', r.rechazada,
      'fecha', r.fecha, 'motivo', r.motivo, 'pedido', r.pedido, 'linea', r.linea))
      FROM public.apa_receipts r JOIN public.apa_imports i ON i.id = r.import_id AND i.status = 'ACTIVA' WHERE r.status = 'ACEPTADO'), '[]'),
    'imports_active', (SELECT count(*) FROM public.apa_imports WHERE status = 'ACTIVA'),
    'last_import_at', (SELECT max(activated_at) FROM public.apa_imports WHERE status = 'ACTIVA'),
    'last_change_at', GREATEST((SELECT max(at) FROM public.apa_audit), (SELECT max(activated_at) FROM public.apa_imports)),
    'discarded', (SELECT count(*) FROM public.apa_movements m JOIN public.apa_imports i ON i.id = m.import_id AND i.status = 'ACTIVA' WHERE m.status = 'DESCARTADO'),
    'outside_scope', (SELECT count(*) FROM public.apa_movements m JOIN public.apa_imports i ON i.id = m.import_id AND i.status = 'ACTIVA'
      WHERE m.status = 'ACEPTADO' AND NOT EXISTS (SELECT 1 FROM public.apa_areas a WHERE a.bodega = m.bodega AND a.area IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM public.apa_doc_classes c WHERE c.tipo = m.tipo AND c.clase = 'TRASPASO') AND m.tipo NOT ILIKE '%TRASPASO%'),
    'bodegas_sin_area', COALESCE((SELECT jsonb_agg(DISTINCT m.bodega) FROM public.apa_movements m JOIN public.apa_imports i ON i.id = m.import_id AND i.status = 'ACTIVA'
      WHERE m.bodega IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.apa_areas a WHERE a.bodega = m.bodega)), '[]'));
END $$;

-- Fila original y normalizada de un movimiento (trazabilidad hasta el archivo, hoja y fila)
CREATE OR REPLACE FUNCTION public.apa_raw_row(p_movement bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r jsonb;
BEGIN
  IF NOT public.apa_can_view() THEN RAISE EXCEPTION 'Sin permiso (apt)'; END IF;
  SELECT jsonb_build_object('movement', to_jsonb(m) - 'reviewed_by', 'raw', w.data, 'file_name', i.file_name, 'source_type', i.source_type,
    'import_status', i.status, 'imported_at', i.created_at)
  INTO r FROM public.apa_movements m JOIN public.apa_imports i ON i.id = m.import_id
  LEFT JOIN public.apa_raw_rows w ON w.import_id = m.import_id AND w.sheet = m.sheet AND w.row_number = m.row_number
  WHERE m.id = p_movement;
  RETURN r;
END $$;

-- Búsqueda de trazabilidad en todas las bodegas (no solo las del área), con tope de filas
CREATE OR REPLACE FUNCTION public.apa_trace_rows(p_q text, p_limit integer DEFAULT 3000) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_q text := upper(btrim(COALESCE(p_q, ''))); v_rows jsonb;
BEGIN
  IF NOT public.apa_can_view() THEN RAISE EXCEPTION 'Sin permiso (apt)'; END IF;
  IF length(v_q) < 3 THEN RETURN '[]'::jsonb; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_array(id, import_id, sheet, row_number, status, reasons, dup, side, tipo, bodega_raw, bodega, numero, fecha, cod_legal,
    razon_social, producto, glosa, cantidad, unidad, doc_rel, num_rel, fecha_entrega, contrato, ref_tipo, ref_correlativo, ref_numero, ref_fecha, lote, color,
    comentario, peso_unitario, peso_x_producir, peso_producido, ccosto) ORDER BY fecha, id), '[]')
  INTO v_rows FROM (
    SELECT m.* FROM public.apa_movements m JOIN public.apa_imports i ON i.id = m.import_id AND i.status = 'ACTIVA'
    WHERE m.status = 'ACEPTADO' AND (upper(m.lote) = v_q OR upper(m.numero) = v_q OR upper(m.num_rel) = v_q OR upper(m.contrato) = v_q OR upper(m.producto) = v_q)
    ORDER BY m.fecha, m.id LIMIT LEAST(GREATEST(COALESCE(p_limit, 3000), 1), 5000)) m;
  RETURN v_rows;
END $$;

-- ------------------------------------------------------------
-- 7. Configuración (administración) y equivalencias (operación), con auditoría
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apa_area_set(p_bodega text, p_area text, p_confirmed boolean, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_b text := upper(regexp_replace(btrim(COALESCE(p_bodega, '')), '\s+', ' ', 'g')); v_before jsonb; v_after public.apa_areas;
BEGIN
  IF NOT public.apa_can_admin() THEN RAISE EXCEPTION 'Solo un administrador cambia el mapeo de áreas (apt-admin)'; END IF;
  IF v_b = '' THEN RAISE EXCEPTION 'Indique la bodega'; END IF;
  IF p_area IS NOT NULL AND p_area NOT IN ('APT', 'APT_LB', 'DIST') THEN RAISE EXCEPTION 'Área no válida'; END IF;
  SELECT to_jsonb(a) INTO v_before FROM public.apa_areas a WHERE bodega = v_b;
  INSERT INTO public.apa_areas (bodega, area, confirmed, note, updated_by, updated_at) VALUES (v_b, p_area, COALESCE(p_confirmed, false), p_note, auth.uid(), now())
  ON CONFLICT (bodega) DO UPDATE SET area = EXCLUDED.area, confirmed = EXCLUDED.confirmed, note = EXCLUDED.note, updated_by = auth.uid(), updated_at = now()
  RETURNING * INTO v_after;
  PERFORM public.apa_log('area', v_b, CASE WHEN v_before IS NULL THEN 'CREAR' ELSE 'CAMBIAR' END, v_before, to_jsonb(v_after), p_note);
  RETURN jsonb_build_object('success', true);
END $$;

CREATE OR REPLACE FUNCTION public.apa_class_set(p_tipo text, p_clase text, p_confirmed boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_t text := upper(regexp_replace(btrim(COALESCE(p_tipo, '')), '\s+', ' ', 'g')); v_before jsonb; v_after public.apa_doc_classes;
BEGIN
  IF NOT public.apa_can_admin() THEN RAISE EXCEPTION 'Solo un administrador clasifica documentos (apt-admin)'; END IF;
  IF v_t = '' THEN RAISE EXCEPTION 'Indique el tipo de documento'; END IF;
  SELECT to_jsonb(c) INTO v_before FROM public.apa_doc_classes c WHERE tipo = v_t;
  INSERT INTO public.apa_doc_classes (tipo, clase, confirmed, updated_by, updated_at) VALUES (v_t, p_clase, COALESCE(p_confirmed, false), auth.uid(), now())
  ON CONFLICT (tipo) DO UPDATE SET clase = EXCLUDED.clase, confirmed = EXCLUDED.confirmed, updated_by = auth.uid(), updated_at = now()
  RETURNING * INTO v_after;
  PERFORM public.apa_log('clase', v_t, CASE WHEN v_before IS NULL THEN 'CREAR' ELSE 'CAMBIAR' END, v_before, to_jsonb(v_after), NULL);
  RETURN jsonb_build_object('success', true);
END $$;

CREATE OR REPLACE FUNCTION public.apa_conversion_save(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid := NULLIF(p->>'id', '')::uuid; v_before jsonb; v_after public.apa_conversions;
BEGIN
  IF NOT public.apa_can_admin() THEN RAISE EXCEPTION 'Solo un administrador registra equivalencias de unidades (apt-admin)'; END IF;
  IF COALESCE((p->>'factor')::numeric, 0) <= 0 THEN RAISE EXCEPTION 'El factor debe ser mayor que cero'; END IF;
  IF COALESCE(p->>'fromUnit', '') = '' OR COALESCE(p->>'toUnit', '') = '' OR upper(p->>'fromUnit') = upper(p->>'toUnit') THEN RAISE EXCEPTION 'Unidades no válidas'; END IF;
  IF v_id IS NOT NULL THEN SELECT to_jsonb(c) INTO v_before FROM public.apa_conversions c WHERE id = v_id; END IF;
  IF v_before IS NULL THEN
    INSERT INTO public.apa_conversions (producto, from_unit, to_unit, factor, verified, note, updated_by)
    VALUES (NULLIF(btrim(p->>'producto'), ''), upper(p->>'fromUnit'), upper(p->>'toUnit'), (p->>'factor')::numeric, COALESCE((p->>'verified')::boolean, false), p->>'note', auth.uid())
    RETURNING * INTO v_after;
  ELSE
    UPDATE public.apa_conversions SET producto = NULLIF(btrim(p->>'producto'), ''), from_unit = upper(p->>'fromUnit'), to_unit = upper(p->>'toUnit'),
      factor = (p->>'factor')::numeric, verified = COALESCE((p->>'verified')::boolean, false), note = p->>'note', updated_by = auth.uid(), updated_at = now()
    WHERE id = v_id RETURNING * INTO v_after;
  END IF;
  PERFORM public.apa_log('conversion', v_after.id::text, CASE WHEN v_before IS NULL THEN 'CREAR' ELSE 'CAMBIAR' END, v_before, to_jsonb(v_after), p->>'note');
  RETURN jsonb_build_object('success', true, 'id', v_after.id);
END $$;

CREATE OR REPLACE FUNCTION public.apa_conversion_delete(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_before jsonb;
BEGIN
  IF NOT public.apa_can_admin() THEN RAISE EXCEPTION 'Solo un administrador elimina equivalencias (apt-admin)'; END IF;
  DELETE FROM public.apa_conversions c WHERE id = p_id RETURNING to_jsonb(c) INTO v_before;
  PERFORM public.apa_log('conversion', p_id::text, 'ELIMINAR', v_before, NULL, NULL);
  RETURN jsonb_build_object('success', v_before IS NOT NULL);
END $$;

CREATE OR REPLACE FUNCTION public.apa_settings_set(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_before jsonb; v_after public.apa_settings;
BEGIN
  IF NOT public.apa_can_admin() THEN RAISE EXCEPTION 'Solo un administrador cambia la metodología (apt-admin)'; END IF;
  SELECT to_jsonb(s) INTO v_before FROM public.apa_settings s WHERE id = 1;
  UPDATE public.apa_settings SET
    same_day_order = COALESCE(p->>'sameDayOrder', same_day_order),
    age_buckets = COALESCE((SELECT array_agg(DISTINCT x::int ORDER BY x::int) FROM jsonb_array_elements_text(p->'ageBuckets') x WHERE x ~ '^\d+$'), age_buckets),
    default_ref_date = COALESCE(NULLIF(p->>'defaultRefDate', '')::date, default_ref_date),
    updated_by = auth.uid(), updated_at = now()
  WHERE id = 1 RETURNING * INTO v_after;
  PERFORM public.apa_log('metodologia', '1', 'CAMBIAR', v_before, to_jsonb(v_after), p->>'note');
  RETURN jsonb_build_object('success', true);
END $$;

CREATE OR REPLACE FUNCTION public.apa_link_save(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid := NULLIF(p->>'id', '')::uuid; v_before jsonb; v_after public.apa_links;
BEGIN
  IF NOT public.apa_can_operate() THEN RAISE EXCEPTION 'Sin permiso para registrar equivalencias (apt-carga)'; END IF;
  IF COALESCE(p->>'origin', 'MANUAL') = 'REGLA' AND NOT public.apa_can_admin() THEN RAISE EXCEPTION 'Solo un administrador registra vínculos por regla verificada'; END IF;
  IF COALESCE(btrim(p->>'fromRef'), '') = '' OR COALESCE(btrim(p->>'toRef'), '') = '' THEN RAISE EXCEPTION 'Indique las dos referencias'; END IF;
  IF v_id IS NOT NULL THEN SELECT to_jsonb(l) INTO v_before FROM public.apa_links l WHERE id = v_id; END IF;
  IF v_before IS NULL THEN
    INSERT INTO public.apa_links (from_kind, from_ref, to_kind, to_ref, qty, unidad, origin, rule, note, created_by, updated_by)
    VALUES (p->>'fromKind', btrim(p->>'fromRef'), p->>'toKind', btrim(p->>'toRef'), NULLIF(p->>'qty', '')::numeric, NULLIF(upper(p->>'unidad'), ''),
      COALESCE(p->>'origin', 'MANUAL'), p->>'rule', p->>'note', auth.uid(), auth.uid())
    RETURNING * INTO v_after;
  ELSE
    UPDATE public.apa_links SET from_kind = p->>'fromKind', from_ref = btrim(p->>'fromRef'), to_kind = p->>'toKind', to_ref = btrim(p->>'toRef'),
      qty = NULLIF(p->>'qty', '')::numeric, unidad = NULLIF(upper(p->>'unidad'), ''), origin = COALESCE(p->>'origin', origin), rule = p->>'rule', note = p->>'note',
      updated_by = auth.uid(), updated_at = now()
    WHERE id = v_id RETURNING * INTO v_after;
  END IF;
  PERFORM public.apa_log('vinculo', v_after.id::text, CASE WHEN v_before IS NULL THEN 'CREAR' ELSE 'CAMBIAR' END, v_before, to_jsonb(v_after), p->>'note');
  RETURN jsonb_build_object('success', true, 'id', v_after.id);
END $$;

CREATE OR REPLACE FUNCTION public.apa_link_annul(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_before jsonb;
BEGIN
  IF NOT public.apa_can_operate() THEN RAISE EXCEPTION 'Sin permiso para anular equivalencias (apt-carga)'; END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 5 THEN RAISE EXCEPTION 'Indique el motivo'; END IF;
  SELECT to_jsonb(l) INTO v_before FROM public.apa_links l WHERE id = p_id AND status = 'VIGENTE';
  IF v_before IS NULL THEN RAISE EXCEPTION 'El vínculo no existe o ya está anulado'; END IF;
  UPDATE public.apa_links SET status = 'ANULADO', updated_by = auth.uid(), updated_at = now() WHERE id = p_id;
  PERFORM public.apa_log('vinculo', p_id::text, 'ANULAR', v_before, jsonb_build_object('status', 'ANULADO'), btrim(p_reason));
  RETURN jsonb_build_object('success', true);
END $$;

CREATE OR REPLACE FUNCTION public.apa_audit_list(p_entity text DEFAULT NULL, p_entity_id text DEFAULT NULL, p_limit integer DEFAULT 200) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apa_can_view() THEN RAISE EXCEPTION 'Sin permiso (apt)'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'entity', a.entity, 'entity_id', a.entity_id, 'action', a.action, 'before', a.before, 'after', a.after,
    'note', a.note, 'at', a.at, 'by', (SELECT COALESCE(to_jsonb(p)->>'full_name', to_jsonb(p)->>'email') FROM public.profiles p WHERE p.id = a.by_user)) ORDER BY a.at DESC)
    FROM (SELECT * FROM public.apa_audit WHERE (p_entity IS NULL OR entity = p_entity) AND (p_entity_id IS NULL OR entity_id = p_entity_id)
          ORDER BY at DESC LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000)) a), '[]'::jsonb);
END $$;

-- Vistas guardadas (filtros y pestaña)
CREATE OR REPLACE FUNCTION public.apa_view_save(p_name text, p_state jsonb, p_shared boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.apa_can_view() THEN RAISE EXCEPTION 'Sin permiso (apt)'; END IF;
  IF length(btrim(COALESCE(p_name, ''))) = 0 THEN RAISE EXCEPTION 'Indique un nombre'; END IF;
  IF pg_column_size(p_state) > 20000 THEN RAISE EXCEPTION 'La vista es demasiado grande'; END IF;
  INSERT INTO public.apa_saved_views (owner, name, state, shared) VALUES (auth.uid(), left(btrim(p_name), 80), p_state, COALESCE(p_shared, false)) RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', true, 'id', v_id);
END $$;
CREATE OR REPLACE FUNCTION public.apa_view_delete(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apa_can_view() THEN RAISE EXCEPTION 'Sin permiso (apt)'; END IF;
  DELETE FROM public.apa_saved_views WHERE id = p_id AND (owner = auth.uid() OR public.apa_can_admin());
  RETURN jsonb_build_object('success', FOUND);
END $$;
CREATE OR REPLACE FUNCTION public.apa_views_list() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apa_can_view() THEN RAISE EXCEPTION 'Sin permiso (apt)'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name, 'state', state, 'shared', shared, 'mine', owner = auth.uid(), 'created_at', created_at) ORDER BY name)
    FROM public.apa_saved_views WHERE owner = auth.uid() OR shared), '[]'::jsonb);
END $$;

-- ------------------------------------------------------------
-- 8. Privilegios de las funciones
-- ------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['apa_can_view()', 'apa_can_operate()', 'apa_can_admin()', 'apa_log(text,text,text,jsonb,jsonb,text)', 'apa_family(text)',
    'apa_import_begin(jsonb)', 'apa_import_rows(uuid,jsonb)', 'apa_import_counts(uuid)', 'apa_import_finish(uuid,integer)', 'apa_import_revert(uuid,text)',
    'apa_review_resolve(uuid,bigint[],text,text)', 'apa_imports_list()', 'apa_dataset_page(bigint,integer,text)', 'apa_meta()', 'apa_raw_row(bigint)',
    'apa_trace_rows(text,integer)', 'apa_area_set(text,text,boolean,text)', 'apa_class_set(text,text,boolean)', 'apa_conversion_save(jsonb)',
    'apa_conversion_delete(uuid)', 'apa_settings_set(jsonb)', 'apa_link_save(jsonb)', 'apa_link_annul(uuid,text)', 'apa_audit_list(text,text,integer)',
    'apa_view_save(text,jsonb,boolean)', 'apa_view_delete(uuid)', 'apa_views_list()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
  END LOOP;
  -- Internas: ni siquiera usuarios autenticados
  REVOKE ALL ON FUNCTION public.apa_log(text,text,text,jsonb,jsonb,text) FROM authenticated;
  REVOKE ALL ON FUNCTION public.apa_import_counts(uuid) FROM authenticated;
  FOREACH f IN ARRAY ARRAY['apa_can_view()', 'apa_can_operate()', 'apa_can_admin()', 'apa_family(text)', 'apa_import_begin(jsonb)', 'apa_import_rows(uuid,jsonb)',
    'apa_import_finish(uuid,integer)', 'apa_import_revert(uuid,text)', 'apa_review_resolve(uuid,bigint[],text,text)', 'apa_imports_list()',
    'apa_dataset_page(bigint,integer,text)', 'apa_meta()', 'apa_raw_row(bigint)', 'apa_trace_rows(text,integer)', 'apa_area_set(text,text,boolean,text)',
    'apa_class_set(text,text,boolean)', 'apa_conversion_save(jsonb)', 'apa_conversion_delete(uuid)', 'apa_settings_set(jsonb)', 'apa_link_save(jsonb)',
    'apa_link_annul(uuid,text)', 'apa_audit_list(text,text,integer)', 'apa_view_save(text,jsonb,boolean)', 'apa_view_delete(uuid)', 'apa_views_list()'] LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', f);
  END LOOP;
END $$;
