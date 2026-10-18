-- ============================================================
-- Inventario multi-almacén (reingeniería de APT): un solo libro de movimientos para todas las bodegas
-- ============================================================
-- Fuente: los reportes del ERP "Entradas" y "Salidas" (mismas columnas: TIPODOCTO, BODEGA, Numero, Fecha, Producto,
-- Cantidad, Lote, PesoUnitario…), con todas las bodegas y tipos de documento. Opcional: una foto de stock del ERP.
--
-- Modelo (inv_rebuild):
--  * Catálogos editables: bodegas (tipo y etapa en el flujo) y tipos de documento (clase: producción, compra,
--    traspaso, despacho, consumo, servicio de terceros, préstamo, devolución, ajuste).
--  * Traspasos emparejados por documento y producto (primero cantidades iguales, luego en orden). Cada enlace guarda
--    el lote de origen y el de destino: así se ve la reasignación de stock (540 / Pernería) a un contrato.
--  * FIFO por cantidad, por bodega + producto + lote. Cada ingreso es una capa; las salidas consumen la más antigua.
--    Saldo inicial: la foto de stock del ERP (si se cargó) y, si aún falta, lo mínimo para que el saldo nunca sea
--    negativo (marcado como inferido).
--  * Cada capa conoce su origen raíz (producción, compra, servicio, devolución) siguiendo los traspasos: así la
--    estadía se mide en la bodega y desde el origen.
-- El modelo APT anterior (apt_*) no cambia y sigue disponible mientras se completa la migración de pantallas.
BEGIN;

-- ------------------------------------------------------------
-- 1. Normalización
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inv_code(v text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT NULLIF(upper(btrim(regexp_replace(COALESCE(v, ''), '\s+', ' ', 'g'))), '');
$$;

-- Lote: mayúsculas, sin ".0" de Excel ni ceros a la izquierda; "0", "1" y vacío son "sin lote"
CREATE OR REPLACE FUNCTION public.inv_lote(v text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  WITH a AS (SELECT upper(btrim(regexp_replace(COALESCE(v, ''), '\s+', '', 'g'))) AS s),
       b AS (SELECT CASE WHEN s ~ '^[0-9]+\.0+$' THEN split_part(s, '.', 1) ELSE s END AS s FROM a),
       c AS (SELECT CASE WHEN s ~ '^0+[0-9]+(-|$)' THEN regexp_replace(s, '^0+([0-9])', '\1') ELSE s END AS s FROM b)
  SELECT CASE WHEN s IN ('', '0', '1', '-', '.', 'NULL', 'N/A', 'NA') THEN NULL ELSE s END FROM c;
$$;

-- OT / contrato de un lote asignado (16339, 16339-S005 → 16339). Lotes de OP interna (2870) o de proveedor: NULL
CREATE OR REPLACE FUNCTION public.inv_ot(p_lote text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT substring(p_lote FROM '^([0-9]{5,6})(?:-[A-Z][0-9]{3})?$');
$$;

CREATE OR REPLACE FUNCTION public.inv_guess_kind(p_code text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN p_code ~ '(^|[^A-Z])MRO([^A-Z]|$)' THEN 'MRO'
    WHEN p_code ~ 'MATERIA PRIMA|MAT\.? ?PRIMA' THEN 'MATERIA_PRIMA'
    WHEN p_code ~ '^PRODUCCION' THEN 'PRODUCCION'
    WHEN p_code ~ 'ST-VENTAS|ST VENTAS' THEN 'DESPACHO'
    WHEN p_code ~ 'PERNERIA' THEN 'PERNERIA'
    WHEN p_code ~ 'MANTENIMIENTO|MTTO' THEN 'MANTENIMIENTO'
    WHEN p_code ~ 'HERRAMIENTA' THEN 'HERRAMIENTAS'
    WHEN p_code ~ 'ACTIVO' THEN 'ACTIVOS'
    WHEN p_code ~ '^(647-04|540-04)|APT|ALM PT' THEN 'PRODUCTO_TERMINADO'
    WHEN p_code ~ 'FLESA|UNIMAR|DEPOSITO|TERCERO' THEN 'TERCERO'
    WHEN p_code ~ 'OBRA|PMO|RINTI' THEN 'OBRA'
    ELSE 'OTRO' END;
$$;

-- Etapa en el flujo (orden de columnas del diagrama): abastecimiento → producción → producto terminado → despacho
CREATE OR REPLACE FUNCTION public.inv_kind_stage(p_kind text)
RETURNS smallint LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT (CASE p_kind WHEN 'MATERIA_PRIMA' THEN 10 WHEN 'TERCERO' THEN 12 WHEN 'PERNERIA' THEN 15 WHEN 'MRO' THEN 15
    WHEN 'PRODUCCION' THEN 20 WHEN 'PRODUCTO_TERMINADO' THEN 30 WHEN 'DESPACHO' THEN 40 WHEN 'OBRA' THEN 50
    WHEN 'MANTENIMIENTO' THEN 60 WHEN 'HERRAMIENTAS' THEN 60 WHEN 'ACTIVOS' THEN 60 ELSE 70 END)::smallint;
$$;

CREATE OR REPLACE FUNCTION public.inv_guess_class(p_tipo text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN p_tipo ~ '^TRASPASO|TRANSFER' THEN 'TRASPASO'
    WHEN p_tipo ~ '^V/C|VALE DE CONSUMO|CONSUMO' THEN 'CONSUMO'
    WHEN p_tipo ~ 'SERV\.? ?TERCEROS' THEN 'SERVICIO_TERCERO'
    WHEN p_tipo ~ 'DESPACHO|VENTA' THEN 'DESPACHO'
    WHEN p_tipo ~ 'SALIDA HERRAMIENTA|PRESTAMO|PRÉSTAMO' THEN 'PRESTAMO'
    WHEN p_tipo ~ '^P/?E |PRODUCCION|RETACERIA' THEN 'PRODUCCION'
    WHEN p_tipo ~ '^DEV|DEVOL|RECOJO' THEN 'DEVOLUCION'
    WHEN p_tipo ~ 'INGRESO|IMPORTACION|COMPRA|RECEPCION' THEN 'COMPRA'
    WHEN p_tipo ~ 'AJUSTE|INVENTARIO|REGULARIZ' THEN 'AJUSTE'
    ELSE 'OTRO' END;
$$;

-- ------------------------------------------------------------
-- 2. Tablas
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inv_warehouses (
  code       text PRIMARY KEY CHECK (length(code) BETWEEN 1 AND 120),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind       text NOT NULL CHECK (kind IN ('MATERIA_PRIMA', 'PRODUCCION', 'PRODUCTO_TERMINADO', 'DESPACHO', 'PERNERIA', 'MRO',
               'MANTENIMIENTO', 'HERRAMIENTAS', 'ACTIVOS', 'TERCERO', 'OBRA', 'OTRO')),
  stage      smallint NOT NULL DEFAULT 70,
  auto       boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.inv_doc_types (
  tipodocto  text PRIMARY KEY CHECK (length(tipodocto) BETWEEN 1 AND 120),
  clase      text NOT NULL CHECK (clase IN ('PRODUCCION', 'COMPRA', 'TRASPASO', 'DESPACHO', 'CONSUMO', 'SERVICIO_TERCERO',
               'PRESTAMO', 'DEVOLUCION', 'AJUSTE', 'OTRO')),
  auto       boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.inv_uploads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  side        text NOT NULL CHECK (side IN ('E', 'S', 'STOCK')),
  file_name   text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 300),
  status      text NOT NULL DEFAULT 'CARGANDO' CHECK (status IN ('CARGANDO', 'APLICADA', 'DESCARTADA')),
  cutoff      date,
  desde       date,
  hasta       date,
  rows_total  integer NOT NULL DEFAULT 0,
  rows_valid  integer NOT NULL DEFAULT 0,
  excluded    jsonb NOT NULL DEFAULT '{}'::jsonb,
  replaced    integer,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  applied_at  timestamptz
);
CREATE INDEX IF NOT EXISTS inv_uploads_side_status_idx ON public.inv_uploads (side, status, applied_at DESC);

CREATE TABLE IF NOT EXISTS public.inv_movements (
  id              bigserial PRIMARY KEY,
  upload_id       uuid NOT NULL REFERENCES public.inv_uploads(id) ON DELETE CASCADE,
  side            text NOT NULL CHECK (side IN ('E', 'S')),
  active          boolean NOT NULL DEFAULT false,
  linea           integer NOT NULL,
  tipodocto       text NOT NULL,
  clase           text NOT NULL DEFAULT 'OTRO',
  bodega          text NOT NULL,
  numero          text NOT NULL,
  fecha           date NOT NULL,
  cod_legal       text,
  razon_social    text,
  producto        text NOT NULL,
  glosa           text,
  cantidad        numeric(20,6) NOT NULL CHECK (cantidad <> 0),
  unidad          text,
  doc_rel         text,
  num_rel         text,
  fecha_entrega   date,
  contrato        text,
  ref_tipo        text,
  ref_correlativo text,
  ref_numero      text,
  ref_fecha       date,
  lote_raw        text,
  lote            text,
  ot              text,
  comentario      text,
  peso_unit       numeric(20,6),
  peso_kg         numeric(20,6),
  ccosto          text
);
CREATE INDEX IF NOT EXISTS inv_movements_upload_idx ON public.inv_movements (upload_id);
CREATE INDEX IF NOT EXISTS inv_movements_side_fecha_idx ON public.inv_movements (side, fecha) WHERE active;
CREATE INDEX IF NOT EXISTS inv_movements_key_idx ON public.inv_movements (bodega, producto, lote) WHERE active;
CREATE INDEX IF NOT EXISTS inv_movements_lote_idx ON public.inv_movements (lote) WHERE active;
CREATE INDEX IF NOT EXISTS inv_movements_ot_idx ON public.inv_movements (ot) WHERE active;
CREATE INDEX IF NOT EXISTS inv_movements_numero_idx ON public.inv_movements (numero) WHERE active;
CREATE INDEX IF NOT EXISTS inv_movements_num_rel_idx ON public.inv_movements (num_rel) WHERE active;
CREATE INDEX IF NOT EXISTS inv_movements_ref_numero_idx ON public.inv_movements (ref_numero) WHERE active;
CREATE INDEX IF NOT EXISTS inv_movements_producto_idx ON public.inv_movements (producto) WHERE active;

CREATE TABLE IF NOT EXISTS public.inv_stock_snapshots (
  id         bigserial PRIMARY KEY,
  upload_id  uuid NOT NULL REFERENCES public.inv_uploads(id) ON DELETE CASCADE,
  bodega     text NOT NULL,
  producto   text NOT NULL,
  lote       text,
  glosa      text,
  unidad     text,
  cantidad   numeric(20,6) NOT NULL,
  peso_kg    numeric(20,6)
);
CREATE INDEX IF NOT EXISTS inv_stock_snapshots_upload_idx ON public.inv_stock_snapshots (upload_id);

-- Derivadas (las reescribe inv_rebuild)
CREATE TABLE IF NOT EXISTS public.inv_transfer_links (
  out_id bigint NOT NULL REFERENCES public.inv_movements(id) ON DELETE CASCADE,
  in_id  bigint NOT NULL REFERENCES public.inv_movements(id) ON DELETE CASCADE,
  qty    numeric(20,6) NOT NULL,
  PRIMARY KEY (out_id, in_id)
);
CREATE INDEX IF NOT EXISTS inv_transfer_links_in_idx ON public.inv_transfer_links (in_id);

CREATE TABLE IF NOT EXISTS public.inv_layers (
  id          bigserial PRIMARY KEY,
  bodega      text NOT NULL,
  producto    text NOT NULL,
  lk          text NOT NULL,              -- lote ('' = sin lote)
  lseq        integer NOT NULL,           -- orden FIFO dentro de la clave
  source      text NOT NULL CHECK (source IN ('FOTO', 'INFERIDA', 'MOV')),
  mov_id      bigint REFERENCES public.inv_movements(id) ON DELETE CASCADE,
  clase       text,
  fecha       date,                       -- llegada a la bodega (NULL = saldo inicial)
  qty         numeric(20,6) NOT NULL,
  q_start     numeric(24,6) NOT NULL,
  q_end       numeric(24,6) NOT NULL,
  consumed    numeric(20,6) NOT NULL DEFAULT 0,
  peso_unit   numeric(20,6),
  root_fecha  date,                       -- fecha del origen raíz (promedio ponderado de la parte conocida)
  root_known  numeric(9,6) NOT NULL DEFAULT 0,  -- fracción con origen conocido
  root_clase  text,
  root_bodega text
);
CREATE INDEX IF NOT EXISTS inv_layers_key_idx ON public.inv_layers (bodega, producto, lk, lseq);
CREATE INDEX IF NOT EXISTS inv_layers_end_idx ON public.inv_layers (bodega, producto, lk, q_end);
CREATE INDEX IF NOT EXISTS inv_layers_start_idx ON public.inv_layers (bodega, producto, lk, q_start);
CREATE INDEX IF NOT EXISTS inv_layers_mov_idx ON public.inv_layers (mov_id);

CREATE TABLE IF NOT EXISTS public.inv_allocations (
  layer_id    bigint NOT NULL REFERENCES public.inv_layers(id) ON DELETE CASCADE,
  out_id      bigint NOT NULL REFERENCES public.inv_movements(id) ON DELETE CASCADE,
  qty         numeric(20,6) NOT NULL,
  kg          numeric(20,6),
  dias_bodega integer,                    -- días en la bodega (NULL si la capa es saldo inicial)
  PRIMARY KEY (layer_id, out_id)
);
CREATE INDEX IF NOT EXISTS inv_allocations_out_idx ON public.inv_allocations (out_id);

CREATE TABLE IF NOT EXISTS public.inv_state (
  id              smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  dirty           boolean NOT NULL DEFAULT true,
  rebuilt_at      timestamptz,
  data_min        date,
  data_max        date,
  model_from      date,
  snapshot_upload uuid,
  snapshot_cutoff date,
  stats           jsonb NOT NULL DEFAULT '{}'::jsonb
);
INSERT INTO public.inv_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Seguridad: solo por funciones (lectura con permiso apt, carga con apt-carga)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inv_warehouses', 'inv_doc_types', 'inv_uploads', 'inv_movements', 'inv_stock_snapshots',
                           'inv_transfer_links', 'inv_layers', 'inv_allocations', 'inv_state'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS security_active_account ON public.%I', t);
  END LOOP;
END $$;
ALTER TABLE public.inv_warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inv_doc_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inv_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inv_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inv_stock_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inv_transfer_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inv_layers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inv_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inv_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_active_account ON public.inv_warehouses AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
CREATE POLICY security_active_account ON public.inv_doc_types AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
CREATE POLICY security_active_account ON public.inv_uploads AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
CREATE POLICY security_active_account ON public.inv_movements AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
CREATE POLICY security_active_account ON public.inv_stock_snapshots AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
CREATE POLICY security_active_account ON public.inv_transfer_links AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
CREATE POLICY security_active_account ON public.inv_layers AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
CREATE POLICY security_active_account ON public.inv_allocations AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
CREATE POLICY security_active_account ON public.inv_state AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.inv_warehouses FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.inv_doc_types FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.inv_uploads FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.inv_movements FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.inv_stock_snapshots FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.inv_transfer_links FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.inv_layers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.inv_allocations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.inv_state FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.inv_movements_id_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.inv_stock_snapshots_id_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.inv_layers_id_seq FROM PUBLIC, anon, authenticated;

-- Catálogo inicial (lo observado en los reportes del ERP); lo nuevo se clasifica solo y se puede corregir
INSERT INTO public.inv_doc_types (tipodocto, clase, auto) VALUES
  ('P/E PRODUCCION ACT.', 'PRODUCCION', false), ('P/E RETACERIA', 'PRODUCCION', false),
  ('N/INGRESO ALMACEN', 'COMPRA', false), ('N/INGRESO ACTIVO', 'COMPRA', false), ('RECEPCION IMPORTACION', 'COMPRA', false),
  ('TRASPASO DE ALMACEN', 'TRASPASO', false), ('TRASPASO DE ALMACEN APT', 'TRASPASO', false),
  ('DESPACHO VENTAS', 'DESPACHO', false),
  ('VALE DE CONSUMO', 'CONSUMO', false), ('V/C ACTIVOS', 'CONSUMO', false), ('V/C MANTENIMIENTOS', 'CONSUMO', false),
  ('V/C PRODUCCION ACT.', 'CONSUMO', false),
  ('GS SERV TERCEROS', 'SERVICIO_TERCERO', false), ('PE SERV TERCEROS', 'SERVICIO_TERCERO', false),
  ('SALIDA HERRAMIENTAS', 'PRESTAMO', false), ('DEV. HERRAMIENTAS', 'DEVOLUCION', false),
  ('G/DEV INDIRECTO', 'DEVOLUCION', false), ('GUIA DE RECOJO', 'DEVOLUCION', false)
ON CONFLICT (tipodocto) DO NOTHING;

-- ------------------------------------------------------------
-- 3. Carga (navegador: iniciar, enviar filas por bloques; servidor: aplicar y recalcular)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inv_upload_begin(p_side text, p_file_name text, p_cutoff date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar movimientos de inventario');
  END IF;
  IF p_side NOT IN ('E', 'S', 'STOCK') THEN RETURN jsonb_build_object('success', false, 'error', 'Tipo de archivo no válido'); END IF;
  IF p_side = 'STOCK' AND p_cutoff IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique la fecha de corte de la foto de stock');
  END IF;
  -- Cargas abandonadas (más de un día sin aplicar) se descartan
  DELETE FROM public.inv_uploads WHERE status = 'CARGANDO' AND created_at < now() - interval '1 day';
  INSERT INTO public.inv_uploads (side, file_name, cutoff, created_by)
  VALUES (p_side, left(COALESCE(NULLIF(btrim(p_file_name), ''), 'archivo.xlsx'), 300), p_cutoff, auth.uid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', true, 'upload_id', v_id);
END $$;

-- Filas: objetos con las columnas del ERP (TIPODOCTO, BODEGA, Numero, Fecha 'YYYY-MM-DD', Producto, Cantidad…) y __row.
-- Se descartan (y se cuentan por motivo) las filas sin fecha, producto, bodega o cantidad.
CREATE OR REPLACE FUNCTION public.inv_upload_rows(p_upload_id uuid, p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_side text; v_ok integer := 0; v_total integer; v_excl jsonb;
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar movimientos de inventario');
  END IF;
  SELECT side INTO v_side FROM public.inv_uploads WHERE id = p_upload_id AND status = 'CARGANDO' FOR UPDATE;
  IF v_side IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'La carga no existe o ya fue cerrada'); END IF;
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) > 5000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Envíe como máximo 5000 filas por bloque');
  END IF;
  v_total := jsonb_array_length(p_rows);

  IF to_regclass('pg_temp.inv_tmp_rows') IS NULL THEN
    CREATE TEMP TABLE inv_tmp_rows (n integer, j jsonb, motivo text) ON COMMIT DROP;
  END IF;
  TRUNCATE inv_tmp_rows;
  INSERT INTO inv_tmp_rows (n, j, motivo)
  SELECT COALESCE((r.j->>'__row')::integer, r.ord::integer), r.j,
    CASE
      WHEN public.inv_code(r.j->>'BODEGA') IS NULL THEN 'Sin bodega'
      WHEN NULLIF(btrim(r.j->>'Producto'), '') IS NULL THEN 'Sin producto'
      WHEN v_side <> 'STOCK' AND (r.j->>'Fecha') !~ '^\d{4}-\d{2}-\d{2}$' THEN 'Sin fecha'
      WHEN v_side <> 'STOCK' AND public.inv_code(r.j->>'TIPODOCTO') IS NULL THEN 'Sin tipo de documento'
      WHEN (r.j->>'Cantidad') !~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$' THEN 'Cantidad no numérica'
      WHEN v_side <> 'STOCK' AND (r.j->>'Cantidad')::numeric = 0 THEN 'Cantidad cero'
    END
  FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS r(j, ord);

  IF v_side = 'STOCK' THEN
    INSERT INTO public.inv_stock_snapshots (upload_id, bodega, producto, lote, glosa, unidad, cantidad, peso_kg)
    SELECT p_upload_id, public.inv_code(j->>'BODEGA'), btrim(j->>'Producto'), public.inv_lote(j->>'Lote'),
      NULLIF(btrim(j->>'GLOSA'), ''), public.inv_code(j->>'UNIDAD'), (j->>'Cantidad')::numeric,
      CASE WHEN (j->>'Peso') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN abs((j->>'Peso')::numeric) END
    FROM inv_tmp_rows WHERE motivo IS NULL AND (j->>'Cantidad')::numeric > 0;
    GET DIAGNOSTICS v_ok = ROW_COUNT;
  ELSE
    INSERT INTO public.inv_movements (upload_id, side, linea, tipodocto, bodega, numero, fecha, cod_legal, razon_social,
      producto, glosa, cantidad, unidad, doc_rel, num_rel, fecha_entrega, contrato, ref_tipo, ref_correlativo, ref_numero,
      ref_fecha, lote_raw, lote, ot, comentario, peso_unit, peso_kg, ccosto)
    SELECT p_upload_id, v_side, n, public.inv_code(j->>'TIPODOCTO'), public.inv_code(j->>'BODEGA'),
      COALESCE(public.apt_id(NULLIF(btrim(j->>'Numero'), '')), 'S/N'), (j->>'Fecha')::date,
      NULLIF(regexp_replace(btrim(COALESCE(j->>'CodLegal', '')), '\.0+$', ''), ''), NULLIF(btrim(j->>'RazonSocial'), ''),
      btrim(j->>'Producto'), NULLIF(btrim(j->>'GLOSA'), ''), q.cant, public.inv_code(j->>'UNIDAD'),
      public.inv_code(j->>'DocRel'), public.inv_lote(j->>'NumRel'),
      CASE WHEN (j->>'FechaEntrega') ~ '^\d{4}-\d{2}-\d{2}$' THEN (j->>'FechaEntrega')::date END,
      public.inv_lote(j->>'Contrato'), public.inv_code(j->>'RefTipoDocto'),
      NULLIF(NULLIF(btrim(j->>'RefCorrelativo'), ''), '0'), NULLIF(NULLIF(btrim(j->>'RefNumero'), ''), '0'),
      -- 22/03/2020 es el valor por defecto del ERP: "sin dato"
      CASE WHEN (j->>'RefFecha') ~ '^\d{4}-\d{2}-\d{2}$' AND (j->>'RefFecha') <> '2020-03-22' THEN (j->>'RefFecha')::date END,
      NULLIF(btrim(j->>'Lote'), ''), l.lote, public.inv_ot(l.lote), NULLIF(btrim(j->>'Comentario'), ''),
      pu.v, CASE WHEN pu.v IS NOT NULL THEN round(abs(q.cant) * pu.v, 6) END, NULLIF(btrim(j->>'CCostoJRM'), '')
    FROM inv_tmp_rows
    CROSS JOIN LATERAL (SELECT (j->>'Cantidad')::numeric AS cant) q
    CROSS JOIN LATERAL (SELECT public.inv_lote(j->>'Lote') AS lote) l
    CROSS JOIN LATERAL (SELECT CASE
        WHEN (j->>'PesoUnitario') ~ '^[0-9]+(\.[0-9]+)?$' AND (j->>'PesoUnitario')::numeric > 0 THEN (j->>'PesoUnitario')::numeric
        WHEN (j->>'PesoTotalProduccido') ~ '^-?[0-9]+(\.[0-9]+)?$' AND (j->>'PesoTotalProduccido')::numeric <> 0
          THEN round(abs((j->>'PesoTotalProduccido')::numeric) / abs(q.cant), 6) END AS v) pu
    WHERE motivo IS NULL;
    GET DIAGNOSTICS v_ok = ROW_COUNT;

    INSERT INTO public.inv_doc_types (tipodocto, clase)
    SELECT DISTINCT public.inv_code(j->>'TIPODOCTO'), public.inv_guess_class(public.inv_code(j->>'TIPODOCTO'))
    FROM inv_tmp_rows WHERE motivo IS NULL
    ON CONFLICT (tipodocto) DO NOTHING;
  END IF;

  INSERT INTO public.inv_warehouses (code, name, kind, stage)
  SELECT DISTINCT ON (c) c, left(btrim(j->>'BODEGA'), 120), public.inv_guess_kind(c), public.inv_kind_stage(public.inv_guess_kind(c))
  FROM inv_tmp_rows CROSS JOIN LATERAL (SELECT public.inv_code(j->>'BODEGA') AS c) b
  WHERE motivo IS NULL
  ON CONFLICT (code) DO NOTHING;

  SELECT COALESCE(jsonb_object_agg(motivo, n), '{}'::jsonb) INTO v_excl
  FROM (SELECT motivo, count(*) AS n FROM inv_tmp_rows WHERE motivo IS NOT NULL GROUP BY motivo) x;

  UPDATE public.inv_uploads u SET rows_total = u.rows_total + v_total, rows_valid = u.rows_valid + v_ok,
    excluded = (SELECT COALESCE(jsonb_object_agg(k, COALESCE((u.excluded->>k)::integer, 0) + COALESCE((v_excl->>k)::integer, 0)), '{}'::jsonb)
                FROM (SELECT jsonb_object_keys(u.excluded) AS k UNION SELECT jsonb_object_keys(v_excl)) ks)
  WHERE u.id = p_upload_id;
  RETURN jsonb_build_object('success', true, 'inserted', v_ok, 'excluded', v_excl);
END $$;

CREATE OR REPLACE FUNCTION public.inv_upload_discard(p_upload_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar movimientos de inventario');
  END IF;
  DELETE FROM public.inv_uploads WHERE id = p_upload_id AND status = 'CARGANDO';
  RETURN jsonb_build_object('success', true);
END $$;

-- Aplica la carga: reemplaza, del mismo lado (Entradas o Salidas), los movimientos del rango de fechas del archivo.
-- Solo servidor (sin permiso de usuario: lo verifica la ruta /api/inventario/procesar) o vía inv_upload_apply.
CREATE OR REPLACE FUNCTION public.inv_upload_apply_core(p_upload_id uuid, p_force boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE u public.inv_uploads; v_from date; v_to date; v_valid integer; v_removed integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('inv_rebuild'));
  SELECT * INTO u FROM public.inv_uploads WHERE id = p_upload_id AND status = 'CARGANDO' FOR UPDATE;
  IF u.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'La carga no existe o ya fue cerrada'); END IF;

  IF u.side = 'STOCK' THEN
    IF NOT EXISTS (SELECT 1 FROM public.inv_stock_snapshots WHERE upload_id = u.id) THEN
      RETURN jsonb_build_object('success', false, 'error', 'La foto de stock no tiene filas con cantidad positiva');
    END IF;
    UPDATE public.inv_uploads SET status = 'APLICADA', applied_at = now(), desde = u.cutoff, hasta = u.cutoff WHERE id = u.id;
  ELSE
    SELECT min(fecha), max(fecha), count(*) INTO v_from, v_to, v_valid FROM public.inv_movements WHERE upload_id = u.id;
    IF v_valid = 0 THEN RETURN jsonb_build_object('success', false, 'error', 'El archivo no tiene movimientos válidos'); END IF;
    SELECT count(*) INTO v_removed FROM public.inv_movements m
    WHERE m.side = u.side AND m.active AND m.fecha BETWEEN v_from AND v_to;
    -- Protección: un archivo filtrado (p. ej. una sola bodega) no debe borrar la historia completa de su rango
    IF NOT p_force AND v_removed > 200 AND v_removed > 3 * v_valid THEN
      RETURN jsonb_build_object('success', false, 'partial', true, 'error', format(
        'El archivo trae %s filas del %s al %s, pero ya hay %s cargadas en ese rango. Parece un reporte parcial o filtrado: cargue el reporte completo de esas fechas.',
        v_valid, to_char(v_from, 'DD/MM/YYYY'), to_char(v_to, 'DD/MM/YYYY'), v_removed));
    END IF;
    DELETE FROM public.inv_movements m WHERE m.side = u.side AND m.active AND m.fecha BETWEEN v_from AND v_to;
    UPDATE public.inv_movements SET active = true WHERE upload_id = u.id;
    UPDATE public.inv_uploads SET status = 'APLICADA', applied_at = now(), desde = v_from, hasta = v_to, replaced = v_removed
    WHERE id = u.id;
  END IF;
  UPDATE public.inv_state SET dirty = true WHERE id = 1;
  RETURN jsonb_build_object('success', true, 'side', u.side, 'desde', COALESCE(v_from, u.cutoff), 'hasta', COALESCE(v_to, u.cutoff),
    'rows', COALESCE(v_valid, u.rows_valid), 'replaced', v_removed);
END $$;

-- ------------------------------------------------------------
-- 4. Modelo: emparejamiento de traspasos, capas FIFO, consumos y origen raíz
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inv_rebuild()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_snap uuid; v_cut date; v_from date; v_iter integer := 0; v_changed integer; v_t0 timestamptz := clock_timestamp();
  v_stats jsonb; v_tmp text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('inv_rebuild'));
  -- Tablas de trabajo (pueden quedar de un recálculo anterior en la misma transacción)
  FOREACH v_tmp IN ARRAY ARRAY['inv_tr', 'inv_ev', 'inv_pu', 'inv_open', 'inv_out', 'inv_comp', 'inv_root'] LOOP
    IF to_regclass('pg_temp.' || v_tmp) IS NOT NULL THEN EXECUTE format('DROP TABLE pg_temp.%I', v_tmp); END IF;
  END LOOP;

  -- Clase vigente del catálogo (se puede reclasificar un tipo de documento)
  UPDATE public.inv_movements m SET clase = d.clase FROM public.inv_doc_types d
  WHERE d.tipodocto = m.tipodocto AND m.clase IS DISTINCT FROM d.clase;

  -- Foto de stock vigente: la última aplicada. El modelo arranca el día siguiente al corte.
  SELECT id, cutoff INTO v_snap, v_cut FROM public.inv_uploads
  WHERE side = 'STOCK' AND status = 'APLICADA' ORDER BY cutoff DESC, applied_at DESC LIMIT 1;
  v_from := v_cut + 1;

  TRUNCATE public.inv_allocations, public.inv_transfer_links, public.inv_layers;

  -- 4.1 Traspasos: primero líneas con la misma cantidad (respeta la reasignación de lote línea a línea), luego el resto
  --     en orden de línea, repartiendo cantidades.
  CREATE TEMP TABLE inv_tr ON COMMIT DROP AS
  SELECT m.id, m.tipodocto, m.numero, m.producto, m.linea, abs(m.cantidad) AS q, m.cantidad < 0 AS is_out
  FROM public.inv_movements m
  WHERE m.active AND m.clase = 'TRASPASO' AND (v_from IS NULL OR m.fecha >= v_from);

  INSERT INTO public.inv_transfer_links (out_id, in_id, qty)
  SELECT s.id, e.id, s.q
  FROM (SELECT *, row_number() OVER (PARTITION BY tipodocto, numero, producto, q ORDER BY linea, id) AS rk FROM inv_tr WHERE is_out) s
  JOIN (SELECT *, row_number() OVER (PARTITION BY tipodocto, numero, producto, q ORDER BY linea, id) AS rk FROM inv_tr WHERE NOT is_out) e
    USING (tipodocto, numero, producto, q, rk);

  WITH s AS (
    SELECT t.id, t.tipodocto, t.numero, t.producto, t.q,
      sum(t.q) OVER (PARTITION BY t.tipodocto, t.numero, t.producto ORDER BY t.linea, t.id) AS ce
    FROM inv_tr t WHERE t.is_out AND NOT EXISTS (SELECT 1 FROM public.inv_transfer_links l WHERE l.out_id = t.id)
  ), e AS (
    SELECT t.id, t.tipodocto, t.numero, t.producto, t.q,
      sum(t.q) OVER (PARTITION BY t.tipodocto, t.numero, t.producto ORDER BY t.linea, t.id) AS ce
    FROM inv_tr t WHERE NOT t.is_out AND NOT EXISTS (SELECT 1 FROM public.inv_transfer_links l WHERE l.in_id = t.id)
  )
  INSERT INTO public.inv_transfer_links (out_id, in_id, qty)
  SELECT s.id, e.id, least(s.ce, e.ce) - greatest(s.ce - s.q, e.ce - e.q)
  FROM s JOIN e USING (tipodocto, numero, producto)
  WHERE least(s.ce, e.ce) - greatest(s.ce - s.q, e.ce - e.q) > 0.000001;

  -- 4.2 Eventos del modelo por clave bodega + producto + lote. En un mismo día, ingresos antes que salidas.
  CREATE TEMP TABLE inv_ev ON COMMIT DROP AS
  SELECT m.id, m.bodega, m.producto, COALESCE(m.lote, '') AS lk, m.fecha, abs(m.cantidad) AS q, m.cantidad > 0 AS is_in,
    m.clase, m.peso_unit
  FROM public.inv_movements m
  WHERE m.active AND (v_from IS NULL OR m.fecha >= v_from);
  CREATE INDEX ON inv_ev (bodega, producto, lk);

  -- Peso unitario de referencia por producto (para capas sin peso propio)
  CREATE TEMP TABLE inv_pu ON COMMIT DROP AS
  SELECT producto, round(sum(peso_kg) / NULLIF(sum(abs(cantidad)), 0), 6) AS pu
  FROM public.inv_movements WHERE active AND peso_kg > 0 GROUP BY producto;
  CREATE UNIQUE INDEX ON inv_pu (producto);

  -- Saldo inicial por clave: la foto (si existe) y lo inferido que aún falte para que el saldo nunca sea negativo
  CREATE TEMP TABLE inv_open ON COMMIT DROP AS
  WITH run AS (
    SELECT bodega, producto, lk, is_in,
      sum(CASE WHEN is_in THEN q ELSE 0 END) OVER w AS cin,
      sum(CASE WHEN is_in THEN 0 ELSE q END) OVER w AS cout
    FROM inv_ev
    WINDOW w AS (PARTITION BY bodega, producto, lk ORDER BY fecha, is_in DESC, id ROWS UNBOUNDED PRECEDING)
  ), need AS (
    SELECT bodega, producto, lk, greatest(max(cout - cin) FILTER (WHERE NOT is_in), 0) AS deficit
    FROM run GROUP BY bodega, producto, lk
  ), snap AS (
    SELECT bodega, producto, COALESCE(lote, '') AS lk, sum(cantidad) AS q, sum(peso_kg) AS kg
    FROM public.inv_stock_snapshots WHERE upload_id = v_snap GROUP BY 1, 2, 3
  )
  SELECT COALESCE(n.bodega, s.bodega) AS bodega, COALESCE(n.producto, s.producto) AS producto, COALESCE(n.lk, s.lk) AS lk,
    COALESCE(s.q, 0) AS foto, greatest(COALESCE(n.deficit, 0) - COALESCE(s.q, 0), 0) AS inferida,
    CASE WHEN s.kg > 0 AND s.q > 0 THEN round(s.kg / s.q, 6) END AS foto_pu
  FROM need n FULL JOIN snap s ON s.bodega = n.bodega AND s.producto = n.producto AND s.lk = n.lk;
  CREATE INDEX ON inv_open (bodega, producto, lk);

  -- 4.3 Capas: [foto][inferida][ingresos en orden]
  INSERT INTO public.inv_layers (bodega, producto, lk, lseq, source, fecha, qty, q_start, q_end, peso_unit, root_known)
  SELECT o.bodega, o.producto, o.lk, 1, 'FOTO', NULL, o.foto, 0, o.foto, COALESCE(o.foto_pu, pu.pu), 0
  FROM inv_open o LEFT JOIN inv_pu pu ON pu.producto = o.producto WHERE o.foto > 0;
  INSERT INTO public.inv_layers (bodega, producto, lk, lseq, source, fecha, qty, q_start, q_end, peso_unit, root_known)
  SELECT o.bodega, o.producto, o.lk, 2, 'INFERIDA', NULL, o.inferida, o.foto, o.foto + o.inferida, pu.pu, 0
  FROM inv_open o LEFT JOIN inv_pu pu ON pu.producto = o.producto WHERE o.inferida > 0;
  INSERT INTO public.inv_layers (bodega, producto, lk, lseq, source, mov_id, clase, fecha, qty, q_start, q_end, peso_unit,
    root_fecha, root_known, root_clase, root_bodega)
  SELECT e.bodega, e.producto, e.lk, 2 + e.rn, 'MOV', e.id, e.clase, e.fecha, e.q,
    COALESCE(o.foto + o.inferida, 0) + e.cin - e.q, COALESCE(o.foto + o.inferida, 0) + e.cin,
    COALESCE(e.peso_unit, pu.pu),
    CASE WHEN e.clase <> 'TRASPASO' THEN e.fecha END, CASE WHEN e.clase <> 'TRASPASO' THEN 1 ELSE 0 END,
    CASE WHEN e.clase <> 'TRASPASO' THEN e.clase END, CASE WHEN e.clase <> 'TRASPASO' THEN e.bodega END
  FROM (SELECT ev.*, row_number() OVER w AS rn, sum(q) OVER w AS cin FROM inv_ev ev WHERE is_in
        WINDOW w AS (PARTITION BY bodega, producto, lk ORDER BY fecha, id ROWS UNBOUNDED PRECEDING)) e
  LEFT JOIN inv_open o ON o.bodega = e.bodega AND o.producto = e.producto AND o.lk = e.lk
  LEFT JOIN inv_pu pu ON pu.producto = e.producto;

  ANALYZE public.inv_layers;

  -- 4.4 Consumos FIFO: cada salida ocupa [oe - q, oe) en la clave; se cruza con las capas que se solapan.
  CREATE TEMP TABLE inv_out ON COMMIT DROP AS
  SELECT ev.id, ev.bodega, ev.producto, ev.lk, ev.fecha, ev.q,
    sum(ev.q) OVER (PARTITION BY ev.bodega, ev.producto, ev.lk ORDER BY ev.fecha, ev.id ROWS UNBOUNDED PRECEDING) AS oe
  FROM inv_ev ev WHERE NOT ev.is_in;

  INSERT INTO public.inv_allocations (layer_id, out_id, qty, kg, dias_bodega)
  SELECT l.id, o.id, x.q, CASE WHEN l.peso_unit IS NOT NULL THEN round(x.q * l.peso_unit, 6) END, o.fecha - l.fecha
  FROM inv_out o
  CROSS JOIN LATERAL (SELECT f.lseq FROM public.inv_layers f
                      WHERE f.bodega = o.bodega AND f.producto = o.producto AND f.lk = o.lk AND f.q_end > o.oe - o.q + 0.0000001
                      ORDER BY f.q_end LIMIT 1) a
  CROSS JOIN LATERAL (SELECT f.lseq FROM public.inv_layers f
                      WHERE f.bodega = o.bodega AND f.producto = o.producto AND f.lk = o.lk AND f.q_start < o.oe - 0.0000001
                      ORDER BY f.q_start DESC LIMIT 1) b
  JOIN public.inv_layers l ON l.bodega = o.bodega AND l.producto = o.producto AND l.lk = o.lk AND l.lseq BETWEEN a.lseq AND b.lseq
  CROSS JOIN LATERAL (SELECT least(l.q_end, o.oe) - greatest(l.q_start, o.oe - o.q) AS q) x
  WHERE x.q > 0.0000001;

  UPDATE public.inv_layers l SET consumed = a.q
  FROM (SELECT layer_id, sum(qty) AS q FROM public.inv_allocations GROUP BY layer_id) a WHERE a.layer_id = l.id;

  -- 4.5 Origen raíz de las capas que llegaron por traspaso: lo que consumió su salida emparejada en la bodega de
  --     origen. Se repite para los traspasos encadenados (p. ej. Depósito → Unimar → Flesa).
  CREATE TEMP TABLE inv_comp ON COMMIT DROP AS
  SELECT tl.in_id, a.layer_id AS src_id, a.qty * tl.qty / NULLIF(s.q, 0) AS part
  FROM public.inv_transfer_links tl
  JOIN (SELECT out_id, sum(qty) AS q FROM public.inv_allocations GROUP BY out_id) s ON s.out_id = tl.out_id
  JOIN public.inv_allocations a ON a.out_id = tl.out_id;
  CREATE INDEX ON inv_comp (src_id);
  ANALYZE inv_comp;
  CREATE TEMP TABLE inv_root (in_id bigint PRIMARY KEY, known numeric, rf date, rc text, rb text) ON COMMIT DROP;
  LOOP
    v_iter := v_iter + 1;
    TRUNCATE inv_root;
    INSERT INTO inv_root (in_id, known, rf, rc, rb)
    SELECT c.in_id,
      round(COALESCE(sum(c.part * src.root_known) / NULLIF(sum(c.part), 0), 0), 6),
      (DATE '2000-01-01' + round(sum(c.part * src.root_known * (src.root_fecha - DATE '2000-01-01')) / NULLIF(sum(c.part * src.root_known), 0))::integer),
      COALESCE((array_agg(src.root_clase ORDER BY c.part * src.root_known DESC NULLS LAST))[1], 'TRASPASO'),
      (array_agg(COALESCE(src.root_bodega, src.bodega) ORDER BY c.part * src.root_known DESC NULLS LAST))[1]
    FROM inv_comp c JOIN public.inv_layers src ON src.id = c.src_id
    GROUP BY c.in_id;
    UPDATE public.inv_layers l SET root_known = g.known, root_fecha = g.rf, root_clase = g.rc, root_bodega = g.rb
    FROM inv_root g
    WHERE l.mov_id = g.in_id AND l.source = 'MOV' AND l.clase = 'TRASPASO'
      AND (l.root_known IS DISTINCT FROM g.known OR l.root_fecha IS DISTINCT FROM g.rf
           OR l.root_clase IS DISTINCT FROM g.rc OR l.root_bodega IS DISTINCT FROM g.rb);
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    EXIT WHEN v_changed = 0 OR v_iter >= 12;
  END LOOP;

  SELECT jsonb_build_object(
    'movimientos', (SELECT count(*) FROM inv_ev),
    'capas', (SELECT count(*) FROM public.inv_layers),
    'consumos', (SELECT count(*) FROM public.inv_allocations),
    'traspasos_enlazados', (SELECT count(*) FROM public.inv_transfer_links),
    'traspasos_sin_destino', (SELECT count(*) FROM inv_tr t WHERE t.is_out AND NOT EXISTS (SELECT 1 FROM public.inv_transfer_links l WHERE l.out_id = t.id)),
    'traspasos_sin_origen', (SELECT count(*) FROM inv_tr t WHERE NOT t.is_out AND NOT EXISTS (SELECT 1 FROM public.inv_transfer_links l WHERE l.in_id = t.id)),
    'iteraciones_origen', v_iter,
    'segundos', round(extract(epoch FROM clock_timestamp() - v_t0)::numeric, 2)) INTO v_stats;

  UPDATE public.inv_state SET dirty = false, rebuilt_at = now(),
    data_min = (SELECT min(fecha) FROM public.inv_movements WHERE active),
    data_max = (SELECT max(fecha) FROM public.inv_movements WHERE active),
    model_from = v_from, snapshot_upload = v_snap, snapshot_cutoff = v_cut, stats = v_stats
  WHERE id = 1;
  RETURN jsonb_build_object('success', true) || v_stats;
END $$;

-- Desde el navegador (cargas chicas y pruebas): aplica y recalcula con el permiso del usuario
CREATE OR REPLACE FUNCTION public.inv_upload_apply(p_upload_id uuid, p_force boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r jsonb;
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar movimientos de inventario');
  END IF;
  r := public.inv_upload_apply_core(p_upload_id, p_force);
  IF NOT COALESCE((r->>'success')::boolean, false) THEN RETURN r; END IF;
  RETURN r || jsonb_build_object('model', public.inv_rebuild());
END $$;

CREATE OR REPLACE FUNCTION public.inv_recalcular()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para recalcular el inventario');
  END IF;
  RETURN public.inv_rebuild();
END $$;

-- ------------------------------------------------------------
-- 5. Catálogos editables
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inv_catalogs()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  RETURN jsonb_build_object('success', true, 'can_load', public.apt_can_load(),
    'bodegas', COALESCE((SELECT jsonb_agg(jsonb_build_object('code', w.code, 'name', w.name, 'kind', w.kind, 'stage', w.stage, 'auto', w.auto,
        'movimientos', (SELECT count(*) FROM public.inv_movements m WHERE m.active AND m.bodega = w.code)) ORDER BY w.stage, w.code)
      FROM public.inv_warehouses w), '[]'::jsonb),
    'tipos', COALESCE((SELECT jsonb_agg(jsonb_build_object('tipodocto', d.tipodocto, 'clase', d.clase, 'auto', d.auto,
        'movimientos', (SELECT count(*) FROM public.inv_movements m WHERE m.active AND m.tipodocto = d.tipodocto)) ORDER BY d.clase, d.tipodocto)
      FROM public.inv_doc_types d), '[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION public.inv_catalog_save(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apt_can_load() THEN RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para editar los catálogos'); END IF;
  IF p ? 'bodega' THEN
    IF (p->>'kind') NOT IN ('MATERIA_PRIMA', 'PRODUCCION', 'PRODUCTO_TERMINADO', 'DESPACHO', 'PERNERIA', 'MRO', 'MANTENIMIENTO',
        'HERRAMIENTAS', 'ACTIVOS', 'TERCERO', 'OBRA', 'OTRO') THEN
      RETURN jsonb_build_object('success', false, 'error', 'Tipo de bodega no válido');
    END IF;
    UPDATE public.inv_warehouses SET kind = p->>'kind', stage = public.inv_kind_stage(p->>'kind'), auto = false, updated_at = now()
    WHERE code = p->>'bodega';
  ELSIF p ? 'tipodocto' THEN
    IF (p->>'clase') NOT IN ('PRODUCCION', 'COMPRA', 'TRASPASO', 'DESPACHO', 'CONSUMO', 'SERVICIO_TERCERO', 'PRESTAMO',
        'DEVOLUCION', 'AJUSTE', 'OTRO') THEN
      RETURN jsonb_build_object('success', false, 'error', 'Clase no válida');
    END IF;
    UPDATE public.inv_doc_types SET clase = p->>'clase', auto = false, updated_at = now() WHERE tipodocto = p->>'tipodocto';
    UPDATE public.inv_state SET dirty = true WHERE id = 1;
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'Nada que guardar');
  END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'No existe en el catálogo'); END IF;
  RETURN jsonb_build_object('success', true);
END $$;

-- ------------------------------------------------------------
-- 6. Lecturas
-- ------------------------------------------------------------
-- Estado, cargas y cobertura
CREATE OR REPLACE FUNCTION public.inv_status()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.inv_state;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  SELECT * INTO s FROM public.inv_state WHERE id = 1;
  RETURN jsonb_build_object('success', true, 'can_load', public.apt_can_load(),
    'state', jsonb_build_object('dirty', s.dirty, 'rebuilt_at', s.rebuilt_at, 'data_min', s.data_min, 'data_max', s.data_max,
      'model_from', s.model_from, 'snapshot_cutoff', s.snapshot_cutoff, 'stats', s.stats),
    'cobertura', COALESCE((SELECT jsonb_agg(jsonb_build_object('side', side, 'desde', mn, 'hasta', mx, 'filas', n, 'dias', d) ORDER BY side)
      FROM (SELECT side, min(fecha) mn, max(fecha) mx, count(*) n, count(DISTINCT fecha) d FROM public.inv_movements WHERE active GROUP BY side) c), '[]'::jsonb),
    'huecos', COALESCE((SELECT jsonb_agg(jsonb_build_object('side', side, 'desde', g_from, 'hasta', g_to) ORDER BY side, g_from)
      FROM (SELECT side, fecha + 1 AS g_from, nxt - 1 AS g_to
            FROM (SELECT side, fecha, lead(fecha) OVER (PARTITION BY side ORDER BY fecha) AS nxt
                  FROM (SELECT DISTINCT side, fecha FROM public.inv_movements WHERE active) f) x
            WHERE nxt - fecha > 4) h), '[]'::jsonb),
    'cargas', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'side', side, 'file_name', file_name, 'status', status, 'desde', desde,
        'hasta', hasta, 'cutoff', cutoff, 'filas', rows_valid, 'total', rows_total, 'excluidas', excluded, 'reemplazadas', replaced,
        'applied_at', applied_at, 'created_at', created_at) ORDER BY created_at DESC)
      FROM (SELECT * FROM public.inv_uploads WHERE status <> 'DESCARTADA' ORDER BY created_at DESC LIMIT 30) u), '[]'::jsonb));
END $$;

-- Saldo por clave al corte (capas con saldo), con la bodega y su tipo
CREATE OR REPLACE FUNCTION public.inv_stock_rows()
RETURNS TABLE (bodega text, kind text, stage smallint, producto text, lk text, qty numeric, kg numeric, kg_conocido boolean,
  fecha_min date, root_min date, inferido numeric, foto numeric, capas integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.bodega, COALESCE(w.kind, 'OTRO'), COALESCE(w.stage, 70::smallint), l.producto, l.lk,
    sum(l.qty - l.consumed), sum((l.qty - l.consumed) * COALESCE(l.peso_unit, 0)), bool_and(l.peso_unit IS NOT NULL),
    min(l.fecha), min(l.root_fecha) FILTER (WHERE l.root_known >= 0.5),
    sum(l.qty - l.consumed) FILTER (WHERE l.source = 'INFERIDA'), sum(l.qty - l.consumed) FILTER (WHERE l.source = 'FOTO'),
    count(*)::integer
  FROM public.inv_layers l LEFT JOIN public.inv_warehouses w ON w.code = l.bodega
  WHERE l.qty - l.consumed > 0.0000001
  GROUP BY l.bodega, w.kind, w.stage, l.producto, l.lk;
$$;
REVOKE ALL ON FUNCTION public.inv_stock_rows() FROM PUBLIC, anon, authenticated;

-- Panorama: stock por bodega, movimientos del período por clase, serie diaria, calidad y pendientes
CREATE OR REPLACE FUNCTION public.inv_overview(p_desde date DEFAULT NULL, p_hasta date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.inv_state; v_from date; v_to date;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  SELECT * INTO s FROM public.inv_state WHERE id = 1;
  v_to := COALESCE(p_hasta, s.data_max); v_from := COALESCE(p_desde, v_to - 29, s.data_min);
  RETURN jsonb_build_object('success', true,
    'state', jsonb_build_object('dirty', s.dirty, 'rebuilt_at', s.rebuilt_at, 'data_min', s.data_min, 'data_max', s.data_max,
      'model_from', s.model_from, 'snapshot_cutoff', s.snapshot_cutoff, 'stats', s.stats, 'desde', v_from, 'hasta', v_to),
    'bodegas', COALESCE((SELECT jsonb_agg(jsonb_build_object('bodega', bodega, 'kind', kind, 'stage', stage, 'claves', n, 'kg', round(kg, 1),
        'kg_libre', round(kg_libre, 1), 'kg_comprometido', round(kg - kg_libre, 1), 'claves_sin_peso', sin_peso,
        'claves_inferidas', inferidas, 'edad_max', edad_max) ORDER BY stage, kg DESC)
      FROM (SELECT r.bodega, r.kind, r.stage, count(*) n, sum(r.kg) kg, sum(r.kg) FILTER (WHERE public.inv_ot(NULLIF(r.lk, '')) IS NULL) AS kg_libre,
              count(*) FILTER (WHERE NOT r.kg_conocido) sin_peso, count(*) FILTER (WHERE r.inferido > 0) inferidas,
              max(s.data_max - COALESCE(r.root_min, r.fecha_min)) edad_max
            FROM public.inv_stock_rows() r GROUP BY r.bodega, r.kind, r.stage) b), '[]'::jsonb),
    'movimientos', COALESCE((SELECT jsonb_agg(jsonb_build_object('clase', clase, 'side', side, 'lineas', n, 'docs', docs, 'kg', round(kg, 1)) ORDER BY side, kg DESC)
      FROM (SELECT clase, side, count(*) n, count(DISTINCT numero) docs, COALESCE(sum(peso_kg), 0) kg
            FROM public.inv_movements WHERE active AND fecha BETWEEN v_from AND v_to GROUP BY clase, side) m), '[]'::jsonb),
    'serie', COALESCE((SELECT jsonb_agg(jsonb_build_object('fecha', fecha, 'produccion', round(prod, 1), 'compras', round(comp, 1),
        'despachos', round(desp, 1), 'consumos', round(cons, 1), 'traspasos', round(tras, 1)) ORDER BY fecha)
      FROM (SELECT fecha,
              COALESCE(sum(peso_kg) FILTER (WHERE side = 'E' AND clase = 'PRODUCCION'), 0) prod,
              COALESCE(sum(peso_kg) FILTER (WHERE side = 'E' AND clase IN ('COMPRA', 'SERVICIO_TERCERO')), 0) comp,
              COALESCE(sum(peso_kg) FILTER (WHERE side = 'S' AND clase = 'DESPACHO'), 0) desp,
              COALESCE(sum(peso_kg) FILTER (WHERE side = 'S' AND clase = 'CONSUMO'), 0) cons,
              COALESCE(sum(peso_kg) FILTER (WHERE side = 'S' AND clase = 'TRASPASO'), 0) tras
            FROM public.inv_movements WHERE active AND fecha BETWEEN v_from AND v_to GROUP BY fecha) d), '[]'::jsonb),
    'calidad', jsonb_build_object(
      'sin_peso', (SELECT count(*) FROM public.inv_movements WHERE active AND fecha BETWEEN v_from AND v_to AND peso_kg IS NULL),
      'lineas', (SELECT count(*) FROM public.inv_movements WHERE active AND fecha BETWEEN v_from AND v_to),
      'error_contrato', (SELECT count(*) FROM public.inv_movements WHERE active AND fecha BETWEEN v_from AND v_to AND doc_rel = 'ERROR DE CONTRATO'),
      'lote_minusculas', (SELECT count(*) FROM public.inv_movements WHERE active AND fecha BETWEEN v_from AND v_to AND lote_raw IS NOT NULL AND lote_raw <> upper(lote_raw)),
      'traspasos_sin_destino', s.stats->'traspasos_sin_destino', 'traspasos_sin_origen', s.stats->'traspasos_sin_origen',
      'claves_inferidas', (SELECT count(*) FROM public.inv_layers WHERE source = 'INFERIDA'),
      'qty_inferida_consumida', (SELECT round(COALESCE(sum(consumed), 0), 1) FROM public.inv_layers WHERE source = 'INFERIDA')),
    'herramientas', public.inv_tool_loans_summary(),
    'terceros', public.inv_third_party_summary());
END $$;

-- Préstamos de herramientas: salidas (SALIDA HERRAMIENTAS) menos devoluciones que apuntan a esa salida (NumRel)
CREATE OR REPLACE FUNCTION public.inv_tool_loans_summary()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH sal AS (
    SELECT numero, max(fecha) fecha, max(razon_social) cliente, producto, max(glosa) glosa, sum(abs(cantidad)) q
    FROM public.inv_movements WHERE active AND clase = 'PRESTAMO' AND cantidad < 0 GROUP BY numero, producto
  ), dev AS (
    SELECT num_rel, producto, sum(cantidad) q, max(fecha) ultima
    FROM public.inv_movements WHERE active AND clase = 'DEVOLUCION' AND cantidad > 0 AND num_rel IS NOT NULL GROUP BY num_rel, producto
  ), pend AS (
    SELECT s.*, COALESCE(d.q, 0) devuelto, s.q - COALESCE(d.q, 0) pendiente, d.ultima
    FROM sal s LEFT JOIN dev d ON d.num_rel = s.numero AND d.producto = s.producto
  )
  SELECT jsonb_build_object(
    'salidas', (SELECT count(DISTINCT numero) FROM sal),
    'pendientes', (SELECT count(*) FROM pend WHERE pendiente > 0),
    'unidades_pendientes', (SELECT COALESCE(sum(pendiente), 0) FROM pend WHERE pendiente > 0),
    'detalle', COALESCE((SELECT jsonb_agg(jsonb_build_object('numero', numero, 'fecha', fecha, 'cliente', cliente, 'producto', producto,
        'glosa', glosa, 'salida', q, 'devuelto', devuelto, 'pendiente', pendiente) ORDER BY fecha, numero)
      FROM (SELECT * FROM pend WHERE pendiente > 0 ORDER BY fecha LIMIT 200) x), '[]'::jsonb));
$$;
REVOKE ALL ON FUNCTION public.inv_tool_loans_summary() FROM PUBLIC, anon, authenticated;

-- Material en servicio de terceros: GS SERV TERCEROS (salida) vs PE SERV TERCEROS que la referencia (RefNumero)
CREATE OR REPLACE FUNCTION public.inv_third_party_summary()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH gs AS (
    SELECT numero, max(fecha) fecha, max(razon_social) proveedor, max(bodega) bodega, string_agg(DISTINCT lote, ', ') lotes,
      sum(COALESCE(peso_kg, 0)) kg
    FROM public.inv_movements WHERE active AND clase = 'SERVICIO_TERCERO' AND cantidad < 0 GROUP BY numero
  ), pe AS (
    SELECT ref_numero, sum(COALESCE(peso_kg, 0)) kg, max(fecha) ultima, string_agg(DISTINCT lote, ', ') lotes
    FROM public.inv_movements WHERE active AND clase = 'SERVICIO_TERCERO' AND cantidad > 0 AND ref_numero IS NOT NULL GROUP BY ref_numero
  ), x AS (
    SELECT g.*, COALESCE(p.kg, 0) kg_retorno, p.ultima, p.lotes lotes_retorno FROM gs g LEFT JOIN pe p ON p.ref_numero = g.numero
  )
  SELECT jsonb_build_object(
    'guias', (SELECT count(*) FROM x),
    'sin_retorno', (SELECT count(*) FROM x WHERE kg_retorno = 0),
    'kg_enviado', (SELECT round(COALESCE(sum(kg), 0), 1) FROM x),
    'kg_retornado', (SELECT round(COALESCE(sum(kg_retorno), 0), 1) FROM x),
    'detalle', COALESCE((SELECT jsonb_agg(jsonb_build_object('numero', numero, 'fecha', fecha, 'proveedor', proveedor, 'bodega', bodega,
        'lotes', lotes, 'kg', round(kg, 1), 'kg_retorno', round(kg_retorno, 1), 'ultima', ultima, 'lotes_retorno', lotes_retorno) ORDER BY fecha DESC)
      FROM (SELECT * FROM x ORDER BY fecha DESC LIMIT 200) y), '[]'::jsonb));
$$;
REVOKE ALL ON FUNCTION public.inv_third_party_summary() FROM PUBLIC, anon, authenticated;

-- Stock disponible por bodega · producto · lote. Filtros: bodegas[], kinds[], q (producto, glosa, lote, OT),
-- estado ('libre' | 'comprometido'), min_dias, orden ('kg' | 'edad' | 'qty'), limit/offset.
CREATE OR REPLACE FUNCTION public.inv_stock(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.inv_state; v_q text := NULLIF(btrim(p->>'q'), ''); v_lim integer := least(greatest(COALESCE((p->>'limit')::integer, 100), 1), 2000);
  v_off integer := greatest(COALESCE((p->>'offset')::integer, 0), 0);
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  SELECT * INTO s FROM public.inv_state WHERE id = 1;
  RETURN (
    WITH r AS (
      SELECT x.*, NULLIF(x.lk, '') AS lote, public.inv_ot(NULLIF(x.lk, '')) AS ot,
        s.data_max - x.fecha_min AS dias_bodega, s.data_max - x.root_min AS dias_origen
      FROM public.inv_stock_rows() x
    ), info AS (
      SELECT r.*, g.glosa, g.unidad, g.cliente
      FROM r LEFT JOIN LATERAL (
        SELECT m.glosa, m.unidad, (SELECT m2.razon_social FROM public.inv_movements m2
            WHERE m2.active AND r.lote IS NOT NULL AND m2.lote = r.lote AND m2.razon_social IS NOT NULL ORDER BY m2.fecha DESC LIMIT 1) AS cliente
        FROM public.inv_movements m WHERE m.active AND m.producto = r.producto ORDER BY m.fecha DESC LIMIT 1) g ON true
    ), f AS (
      SELECT * FROM info
      WHERE (NOT (p ? 'bodegas') OR jsonb_array_length(p->'bodegas') = 0 OR bodega IN (SELECT jsonb_array_elements_text(p->'bodegas')))
        AND (NOT (p ? 'kinds') OR jsonb_array_length(p->'kinds') = 0 OR kind IN (SELECT jsonb_array_elements_text(p->'kinds')))
        AND (v_q IS NULL OR producto ILIKE '%' || v_q || '%' OR glosa ILIKE '%' || v_q || '%' OR lk ILIKE '%' || v_q || '%'
             OR cliente ILIKE '%' || v_q || '%')
        AND (COALESCE(p->>'estado', '') = '' OR (p->>'estado' = 'libre' AND ot IS NULL) OR (p->>'estado' = 'comprometido' AND ot IS NOT NULL))
        AND (COALESCE((p->>'min_dias')::integer, 0) = 0 OR COALESCE(dias_origen, dias_bodega, 99999) >= (p->>'min_dias')::integer)
    )
    SELECT jsonb_build_object('success', true, 'corte', s.data_max, 'dirty', s.dirty, 'snapshot_cutoff', s.snapshot_cutoff,
      'total', (SELECT count(*) FROM f),
      'totales', (SELECT jsonb_build_object('kg', round(COALESCE(sum(kg), 0), 1), 'kg_libre', round(COALESCE(sum(kg) FILTER (WHERE ot IS NULL), 0), 1),
          'kg_comprometido', round(COALESCE(sum(kg) FILTER (WHERE ot IS NOT NULL), 0), 1), 'claves', count(*),
          'claves_inferidas', count(*) FILTER (WHERE inferido > 0), 'claves_sin_peso', count(*) FILTER (WHERE NOT kg_conocido)) FROM f),
      'filas', COALESCE((SELECT jsonb_agg(row_to_json(z2)::jsonb - 'ord1' ORDER BY z2.ord1 DESC NULLS LAST, z2.kg DESC)
          FROM (SELECT bodega, kind, producto, glosa, lote, ot, cliente, unidad, round(qty, 3) qty, round(kg, 1) kg, kg_conocido,
                  fecha_min fecha_ingreso, root_min fecha_origen, dias_bodega, dias_origen, round(COALESCE(inferido, 0), 3) inferido,
                  round(COALESCE(foto, 0), 3) foto, capas,
                  CASE p->>'orden' WHEN 'edad' THEN COALESCE(dias_origen, dias_bodega, 99999)::numeric WHEN 'qty' THEN qty ELSE kg END AS ord1
                FROM f ORDER BY ord1 DESC NULLS LAST, kg DESC LIMIT v_lim OFFSET v_off) z2), '[]'::jsonb)));
END $$;

-- Estadía: consumos del período (días en la bodega y desde el origen) por bodega y destino, y antigüedad del saldo
CREATE OR REPLACE FUNCTION public.inv_dwell(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.inv_state; v_from date; v_to date;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  SELECT * INTO s FROM public.inv_state WHERE id = 1;
  v_to := COALESCE((p->>'hasta')::date, s.data_max); v_from := COALESCE((p->>'desde')::date, s.data_min);
  RETURN (
    WITH c AS (
      SELECT a.*, m.fecha, m.clase AS destino, l.bodega, COALESCE(w.kind, 'OTRO') kind, COALESCE(w.stage, 70) stage, l.source,
        CASE WHEN l.root_known >= 0.5 THEN m.fecha - l.root_fecha END AS dias_origen
      FROM public.inv_allocations a JOIN public.inv_movements m ON m.id = a.out_id JOIN public.inv_layers l ON l.id = a.layer_id
      LEFT JOIN public.inv_warehouses w ON w.code = l.bodega
      WHERE m.fecha BETWEEN v_from AND v_to
        AND (NOT (p ? 'bodegas') OR jsonb_array_length(p->'bodegas') = 0 OR l.bodega IN (SELECT jsonb_array_elements_text(p->'bodegas')))
    ), stock AS (
      SELECT r.*, s.data_max - r.fecha_min AS dias FROM public.inv_stock_rows() r
      WHERE (NOT (p ? 'bodegas') OR jsonb_array_length(p->'bodegas') = 0 OR r.bodega IN (SELECT jsonb_array_elements_text(p->'bodegas')))
    )
    SELECT jsonb_build_object('success', true, 'desde', v_from, 'hasta', v_to, 'corte', s.data_max, 'model_from', s.model_from,
      'por_bodega', COALESCE((SELECT jsonb_agg(jsonb_build_object('bodega', bodega, 'kind', kind, 'stage', stage, 'consumos', n,
          'kg', round(kg, 1), 'prom_dias', prom, 'prom_dias_kg', prom_kg, 'p50', p50, 'p90', p90, 'max', mx,
          'pct_sin_fecha', round(100.0 * sin_fecha / NULLIF(n, 0), 1), 'prom_origen', prom_o) ORDER BY stage, bodega)
        FROM (SELECT bodega, kind, stage, count(*) n, COALESCE(sum(kg), 0) kg,
                round(avg(dias_bodega), 1) prom, round(sum(kg * dias_bodega) FILTER (WHERE kg > 0 AND dias_bodega IS NOT NULL)
                  / NULLIF(sum(kg) FILTER (WHERE kg > 0 AND dias_bodega IS NOT NULL), 0), 1) prom_kg,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY dias_bodega) p50, percentile_cont(0.9) WITHIN GROUP (ORDER BY dias_bodega) p90,
                max(dias_bodega) mx, count(*) FILTER (WHERE dias_bodega IS NULL) sin_fecha, round(avg(dias_origen), 1) prom_o
              FROM c GROUP BY bodega, kind, stage) b), '[]'::jsonb),
      'por_destino', COALESCE((SELECT jsonb_agg(jsonb_build_object('bodega', bodega, 'destino', destino, 'consumos', n, 'kg', round(kg, 1),
          'prom_dias', prom, 'prom_origen', prom_o) ORDER BY bodega, kg DESC)
        FROM (SELECT bodega, destino, count(*) n, COALESCE(sum(kg), 0) kg, round(avg(dias_bodega), 1) prom, round(avg(dias_origen), 1) prom_o
              FROM c GROUP BY bodega, destino) d), '[]'::jsonb),
      'distribucion', COALESCE((SELECT jsonb_agg(jsonb_build_object('bodega', bodega, 'rango', rango, 'consumos', n, 'kg', round(kg, 1)) ORDER BY bodega, ord)
        FROM (SELECT bodega, rango, ord, count(*) n, COALESCE(sum(kg), 0) kg
              FROM (SELECT c.*, r.rango, r.ord FROM c CROSS JOIN LATERAL (SELECT CASE
                  WHEN dias_bodega IS NULL THEN 'Saldo inicial' WHEN dias_bodega = 0 THEN 'Mismo día' WHEN dias_bodega <= 3 THEN '1–3 d'
                  WHEN dias_bodega <= 7 THEN '4–7 d' WHEN dias_bodega <= 15 THEN '8–15 d' WHEN dias_bodega <= 30 THEN '16–30 d' ELSE '> 30 d' END AS rango,
                  CASE WHEN dias_bodega IS NULL THEN 7 WHEN dias_bodega = 0 THEN 0 WHEN dias_bodega <= 3 THEN 1 WHEN dias_bodega <= 7 THEN 2
                  WHEN dias_bodega <= 15 THEN 3 WHEN dias_bodega <= 30 THEN 4 ELSE 5 END AS ord) r) x
              GROUP BY bodega, rango, ord) d), '[]'::jsonb),
      'antiguedad_stock', COALESCE((SELECT jsonb_agg(jsonb_build_object('bodega', bodega, 'rango', rango, 'claves', n, 'kg', round(kg, 1)) ORDER BY bodega, ord)
        FROM (SELECT bodega, rango, ord, count(*) n, sum(kg) kg
              FROM (SELECT st.*, CASE WHEN dias IS NULL THEN 'Saldo inicial' WHEN dias <= 7 THEN '0–7 d' WHEN dias <= 15 THEN '8–15 d'
                      WHEN dias <= 30 THEN '16–30 d' WHEN dias <= 60 THEN '31–60 d' WHEN dias <= 90 THEN '61–90 d' ELSE '> 90 d' END AS rango,
                      CASE WHEN dias IS NULL THEN 6 WHEN dias <= 7 THEN 0 WHEN dias <= 15 THEN 1 WHEN dias <= 30 THEN 2 WHEN dias <= 60 THEN 3
                      WHEN dias <= 90 THEN 4 ELSE 5 END AS ord FROM stock st) x
              GROUP BY bodega, rango, ord) a), '[]'::jsonb),
      'mas_antiguos', COALESCE((SELECT jsonb_agg(jsonb_build_object('bodega', bodega, 'producto', producto, 'lote', NULLIF(lk, ''), 'qty', round(qty, 3),
          'kg', round(kg, 1), 'fecha_ingreso', fecha_min, 'dias', dias, 'fecha_origen', root_min) ORDER BY dias DESC, kg DESC)
        FROM (SELECT * FROM stock WHERE dias IS NOT NULL ORDER BY dias DESC, kg DESC LIMIT 50) o), '[]'::jsonb),
      'etapas', COALESCE((SELECT jsonb_agg(jsonb_build_object('origen', root_clase, 'origen_bodega', root_bodega, 'bodega', bodega, 'destino', destino,
          'consumos', n, 'kg', round(kg, 1), 'prom_bodega', pb, 'prom_origen', po) ORDER BY kg DESC)
        FROM (SELECT l.root_clase, l.root_bodega, c.bodega, c.destino, count(*) n, COALESCE(sum(c.kg), 0) kg,
                round(avg(c.dias_bodega), 1) pb, round(avg(c.dias_origen), 1) po
              FROM c JOIN public.inv_layers l ON l.id = c.layer_id
              WHERE c.destino IN ('DESPACHO', 'CONSUMO') AND c.dias_origen IS NOT NULL
              GROUP BY 1, 2, 3, 4 HAVING count(*) > 0 ORDER BY kg DESC LIMIT 40) e), '[]'::jsonb)));
END $$;

-- Flujo entre bodegas: matriz de traspasos, ingresos por clase y salidas por clase (para el diagrama), reasignaciones
CREATE OR REPLACE FUNCTION public.inv_flow(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.inv_state; v_from date; v_to date;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  SELECT * INTO s FROM public.inv_state WHERE id = 1;
  v_to := COALESCE((p->>'hasta')::date, s.data_max); v_from := COALESCE((p->>'desde')::date, s.data_min);
  RETURN (
    WITH lk AS (
      SELECT o.bodega AS origen, i.bodega AS destino, o.numero, o.fecha, tl.qty, o.lote AS lote_origen, i.lote AS lote_destino,
        tl.qty * COALESCE(i.peso_unit, o.peso_unit, 0) AS kg, o.producto
      FROM public.inv_transfer_links tl JOIN public.inv_movements o ON o.id = tl.out_id JOIN public.inv_movements i ON i.id = tl.in_id
      WHERE o.fecha BETWEEN v_from AND v_to
    ), estadia_origen AS (
      SELECT ms.bodega AS origen, mi.bodega AS destino, round(sum(a.qty * a.dias_bodega) FILTER (WHERE a.dias_bodega IS NOT NULL)
        / NULLIF(sum(a.qty) FILTER (WHERE a.dias_bodega IS NOT NULL), 0), 1) AS dias
      FROM public.inv_transfer_links tl JOIN public.inv_movements ms ON ms.id = tl.out_id JOIN public.inv_movements mi ON mi.id = tl.in_id
      JOIN public.inv_allocations a ON a.out_id = tl.out_id
      WHERE ms.fecha BETWEEN v_from AND v_to GROUP BY 1, 2
    )
    SELECT jsonb_build_object('success', true, 'desde', v_from, 'hasta', v_to,
      'bodegas', COALESCE((SELECT jsonb_agg(jsonb_build_object('code', code, 'kind', kind, 'stage', stage) ORDER BY stage, code) FROM public.inv_warehouses), '[]'::jsonb),
      'traspasos', COALESCE((SELECT jsonb_agg(jsonb_build_object('origen', x.origen, 'destino', x.destino, 'docs', docs, 'lineas', n, 'kg', round(kg, 1),
          'reasignadas', reasig, 'dias_en_origen', e.dias) ORDER BY kg DESC)
        FROM (SELECT origen, destino, count(DISTINCT numero) docs, count(*) n, sum(kg) kg,
                count(*) FILTER (WHERE lote_origen IS DISTINCT FROM lote_destino) reasig FROM lk GROUP BY origen, destino) x
        LEFT JOIN estadia_origen e ON e.origen = x.origen AND e.destino = x.destino), '[]'::jsonb),
      'ingresos', COALESCE((SELECT jsonb_agg(jsonb_build_object('clase', clase, 'bodega', bodega, 'lineas', n, 'kg', round(kg, 1)) ORDER BY kg DESC)
        FROM (SELECT clase, bodega, count(*) n, COALESCE(sum(peso_kg), 0) kg FROM public.inv_movements
              WHERE active AND side = 'E' AND clase <> 'TRASPASO' AND fecha BETWEEN v_from AND v_to GROUP BY clase, bodega) i), '[]'::jsonb),
      'salidas', COALESCE((SELECT jsonb_agg(jsonb_build_object('clase', clase, 'bodega', bodega, 'lineas', n, 'kg', round(kg, 1)) ORDER BY kg DESC)
        FROM (SELECT clase, bodega, count(*) n, COALESCE(sum(peso_kg), 0) kg FROM public.inv_movements
              WHERE active AND side = 'S' AND clase <> 'TRASPASO' AND fecha BETWEEN v_from AND v_to GROUP BY clase, bodega) o), '[]'::jsonb),
      'reasignaciones', COALESCE((SELECT jsonb_agg(jsonb_build_object('origen', origen, 'destino', destino, 'numero', numero, 'fecha', fecha,
          'producto', producto, 'lote_origen', lote_origen, 'lote_destino', lote_destino, 'qty', round(qty, 3), 'kg', round(kg, 1)) ORDER BY fecha DESC, numero)
        FROM (SELECT * FROM lk WHERE lote_origen IS DISTINCT FROM lote_destino ORDER BY fecha DESC LIMIT 300) r), '[]'::jsonb)));
END $$;

-- Trazabilidad: busca por lote, OT, número de documento, OP (NumRel) o producto y arma la cadena completa:
-- lotes relacionados por reasignación en traspasos, servicio de terceros (RefNumero) y OP de producción (NumRel).
CREATE OR REPLACE FUNCTION public.inv_trace(p_q text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_q text := public.inv_lote(p_q); v_raw text := upper(btrim(COALESCE(p_q, ''))); v_seed text[]; v_up text[]; v_down text[];
  v_lotes text[]; v_prev integer; v_ids bigint[]; v_ops text[];
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  IF length(v_raw) < 3 THEN RETURN jsonb_build_object('success', false, 'error', 'Ingrese al menos 3 caracteres'); END IF;

  -- Semilla: lotes que coinciden (exacto, OT o subcontratos), lotes de los documentos con ese número y de la OP
  SELECT array_agg(DISTINCT x) INTO v_seed FROM (
    SELECT lote x FROM public.inv_movements WHERE active AND lote IS NOT NULL AND (lote = v_q OR ot = v_q OR lote LIKE v_q || '-%')
    UNION SELECT lote FROM public.inv_movements WHERE active AND lote IS NOT NULL AND (numero = v_q OR numero = v_raw OR num_rel = v_q)
  ) s;
  v_seed := COALESCE(v_seed, '{}');

  -- Hacia atrás (de dónde vino): lote de origen de los traspasos que llegaron con estos lotes y lote enviado a servicio
  -- de terceros cuando regresa con RefNumero. No se abren los "hermanos" (otros contratos servidos del mismo stock).
  v_up := v_seed; v_prev := -1;
  WHILE cardinality(v_up) > v_prev AND cardinality(v_up) < 300 LOOP
    v_prev := cardinality(v_up);
    SELECT array_agg(DISTINCT x) INTO v_up FROM (
      SELECT unnest(v_up) x
      UNION SELECT o.lote FROM public.inv_transfer_links tl JOIN public.inv_movements o ON o.id = tl.out_id JOIN public.inv_movements i ON i.id = tl.in_id
        WHERE i.lote = ANY (v_up) AND o.lote IS NOT NULL
      UNION SELECT gs.lote FROM public.inv_movements pe JOIN public.inv_movements gs ON gs.numero = pe.ref_numero AND gs.active
        WHERE pe.active AND pe.clase = 'SERVICIO_TERCERO' AND pe.cantidad > 0 AND pe.lote = ANY (v_up) AND gs.lote IS NOT NULL
    ) s;
  END LOOP;
  -- Hacia adelante (en qué se convirtió): lote de destino de sus traspasos y lotes que regresan del servicio
  v_down := v_seed; v_prev := -1;
  WHILE cardinality(v_down) > v_prev AND cardinality(v_down) < 300 LOOP
    v_prev := cardinality(v_down);
    SELECT array_agg(DISTINCT x) INTO v_down FROM (
      SELECT unnest(v_down) x
      UNION SELECT i.lote FROM public.inv_transfer_links tl JOIN public.inv_movements o ON o.id = tl.out_id JOIN public.inv_movements i ON i.id = tl.in_id
        WHERE o.lote = ANY (v_down) AND i.lote IS NOT NULL
      UNION SELECT pe.lote FROM public.inv_movements gs JOIN public.inv_movements pe ON pe.ref_numero = gs.numero AND pe.active
        WHERE gs.active AND gs.clase = 'SERVICIO_TERCERO' AND gs.cantidad < 0 AND gs.lote = ANY (v_down) AND pe.lote IS NOT NULL
    ) s;
  END LOOP;
  SELECT array_agg(DISTINCT x) INTO v_lotes FROM (SELECT unnest(v_up) x UNION SELECT unnest(v_down)) s;
  IF cardinality(v_lotes) = 0 THEN v_lotes := NULL; END IF;

  -- OP de producción del lote (para mostrar el consumo de materiales de esas OP)
  SELECT array_agg(DISTINCT num_rel) INTO v_ops FROM public.inv_movements
  WHERE active AND clase = 'PRODUCCION' AND num_rel IS NOT NULL AND (lote = ANY (COALESCE(v_lotes, '{}')) OR num_rel = v_q);

  -- Movimientos: todos los de los lotes buscados y sus derivados; de los lotes de origen (stock reasignado), solo cómo
  -- ingresaron y los traspasos que alimentaron a esta familia
  SELECT array_agg(id) INTO v_ids FROM (
    SELECT m.id FROM public.inv_movements m WHERE m.active AND (
      m.lote = ANY (v_down) OR m.numero = v_q OR m.numero = v_raw OR m.num_rel = ANY (COALESCE(v_ops, '{}'))
      OR (m.lote = ANY (v_up) AND m.side = 'E')
      OR (m.lote = ANY (v_up) AND EXISTS (SELECT 1 FROM public.inv_transfer_links tl JOIN public.inv_movements i ON i.id = tl.in_id
            WHERE tl.out_id = m.id AND i.lote = ANY (v_lotes)))
      OR (v_lotes IS NULL AND m.producto = btrim(p_q)))
    ORDER BY m.fecha, m.id LIMIT 3000) x;

  IF v_ids IS NULL THEN RETURN jsonb_build_object('success', true, 'encontrado', false, 'q', p_q); END IF;

  RETURN jsonb_build_object('success', true, 'encontrado', true, 'q', p_q, 'lotes', to_jsonb(COALESCE(v_lotes, '{}')),
    'lotes_buscados', to_jsonb(v_seed), 'lotes_origen', to_jsonb(ARRAY(SELECT unnest(v_up) EXCEPT SELECT unnest(v_seed))),
    'lotes_derivados', to_jsonb(ARRAY(SELECT unnest(v_down) EXCEPT SELECT unnest(v_seed))),
    'ops', to_jsonb(COALESCE(v_ops, '{}')), 'truncado', cardinality(v_ids) >= 3000,
    'movimientos', (SELECT jsonb_agg(jsonb_build_object('id', m.id, 'fecha', m.fecha, 'side', m.side, 'clase', m.clase, 'tipodocto', m.tipodocto,
        'bodega', m.bodega, 'kind', COALESCE(w.kind, 'OTRO'), 'stage', COALESCE(w.stage, 70), 'numero', m.numero, 'producto', m.producto,
        'glosa', m.glosa, 'cantidad', m.cantidad, 'unidad', m.unidad, 'kg', m.peso_kg, 'lote', m.lote, 'num_rel', m.num_rel,
        'razon_social', m.razon_social, 'doc_rel', m.doc_rel, 'ref_numero', m.ref_numero, 'comentario', m.comentario) ORDER BY m.fecha, m.side, m.id)
      FROM public.inv_movements m LEFT JOIN public.inv_warehouses w ON w.code = m.bodega WHERE m.id = ANY (v_ids)),
    'enlaces', COALESCE((SELECT jsonb_agg(jsonb_build_object('out_id', tl.out_id, 'in_id', tl.in_id, 'qty', tl.qty, 'origen', o.bodega,
        'destino', i.bodega, 'lote_origen', o.lote, 'lote_destino', i.lote, 'numero', o.numero, 'fecha', o.fecha))
      FROM public.inv_transfer_links tl JOIN public.inv_movements o ON o.id = tl.out_id JOIN public.inv_movements i ON i.id = tl.in_id
      WHERE tl.out_id = ANY (v_ids) OR tl.in_id = ANY (v_ids)), '[]'::jsonb),
    'etapas', COALESCE((SELECT jsonb_agg(jsonb_build_object('bodega', bodega, 'kind', kind, 'stage', stage, 'primera', primera, 'ultima', ultima,
        'entradas_kg', round(ekg, 1), 'salidas_kg', round(skg, 1), 'entradas', en, 'salidas', sn) ORDER BY stage, primera)
      FROM (SELECT m.bodega, COALESCE(w.kind, 'OTRO') kind, COALESCE(w.stage, 70) stage, min(m.fecha) primera, max(m.fecha) ultima,
              COALESCE(sum(m.peso_kg) FILTER (WHERE m.side = 'E'), 0) ekg, COALESCE(sum(m.peso_kg) FILTER (WHERE m.side = 'S'), 0) skg,
              count(*) FILTER (WHERE m.side = 'E') en, count(*) FILTER (WHERE m.side = 'S') sn
            FROM public.inv_movements m LEFT JOIN public.inv_warehouses w ON w.code = m.bodega WHERE m.id = ANY (v_ids)
            GROUP BY m.bodega, w.kind, w.stage) e), '[]'::jsonb),
    'saldo', COALESCE((SELECT jsonb_agg(jsonb_build_object('bodega', r.bodega, 'producto', r.producto, 'lote', NULLIF(r.lk, ''), 'qty', round(r.qty, 3),
        'kg', round(r.kg, 1), 'fecha_ingreso', r.fecha_min, 'inferido', round(COALESCE(r.inferido, 0), 3)) ORDER BY r.stage, r.bodega)
      FROM public.inv_stock_rows() r WHERE NULLIF(r.lk, '') = ANY (COALESCE(v_lotes, '{}'))), '[]'::jsonb),
    'estadia', COALESCE((SELECT jsonb_agg(jsonb_build_object('bodega', bodega, 'consumos', n, 'prom_dias', pd, 'max_dias', mx) ORDER BY bodega)
      FROM (SELECT l.bodega, count(*) n, round(avg(a.dias_bodega), 1) pd, max(a.dias_bodega) mx
            FROM public.inv_allocations a JOIN public.inv_layers l ON l.id = a.layer_id
            WHERE a.out_id = ANY (v_ids) GROUP BY l.bodega) d), '[]'::jsonb));
END $$;

-- ------------------------------------------------------------
-- 7. Permisos de ejecución
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.inv_upload_apply_core(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inv_rebuild() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_upload_apply_core(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.inv_rebuild() TO service_role;
GRANT EXECUTE ON FUNCTION public.inv_stock_rows() TO service_role;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['inv_upload_begin(text, text, date)', 'inv_upload_rows(uuid, jsonb)', 'inv_upload_discard(uuid)',
    'inv_upload_apply(uuid, boolean)', 'inv_recalcular()', 'inv_catalogs()', 'inv_catalog_save(jsonb)', 'inv_status()',
    'inv_overview(date, date)', 'inv_stock(jsonb)', 'inv_dwell(jsonb)', 'inv_flow(jsonb)', 'inv_trace(text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['inv_code(text)', 'inv_lote(text)', 'inv_ot(text)', 'inv_guess_kind(text)', 'inv_kind_stage(text)',
    'inv_guess_class(text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', f);
  END LOOP;
END $$;

COMMIT;
