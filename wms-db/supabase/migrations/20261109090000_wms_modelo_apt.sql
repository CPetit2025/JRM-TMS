-- Fase 4 (docs/plan-wms-inventario-apt.md): réplica del modelo de almacén del TMS en la base WMS.
-- Generada desde producción del TMS (no desde las migraciones del repo, que no coinciden con producción).
-- Incluye APT (apt_*), inventario multialmacén (inv_*), analítica APT (apa_*) y la derivación ERP (erp_derive_*).
-- Excluye contratos y clientes (siguen en el TMS) y apt_flow_tms / apt_vinculacion_estado (leen despachos del TMS).
-- Las funciones que el WMS define a su manera (permisos y carga del ERP) no se reemplazan.
SET check_function_bodies = off;

-- Secuencias
CREATE SEQUENCE IF NOT EXISTS apa_audit_id_seq;
CREATE SEQUENCE IF NOT EXISTS apa_commitments_id_seq;
CREATE SEQUENCE IF NOT EXISTS apa_movements_id_seq;
CREATE SEQUENCE IF NOT EXISTS apa_opening_balances_id_seq;
CREATE SEQUENCE IF NOT EXISTS apa_receipts_id_seq;
CREATE SEQUENCE IF NOT EXISTS inv_layers_id_seq;
CREATE SEQUENCE IF NOT EXISTS inv_movements_id_seq;
CREATE SEQUENCE IF NOT EXISTS inv_stock_snapshots_id_seq;

-- Tablas
CREATE TABLE IF NOT EXISTS public.apa_areas (
  "bodega" text NOT NULL,
  "area" text,
  "confirmed" boolean DEFAULT false NOT NULL,
  "note" text,
  "updated_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.apa_areas ADD COLUMN IF NOT EXISTS "bodega" text;
ALTER TABLE public.apa_areas ADD COLUMN IF NOT EXISTS "area" text;
ALTER TABLE public.apa_areas ADD COLUMN IF NOT EXISTS "confirmed" boolean DEFAULT false;
ALTER TABLE public.apa_areas ADD COLUMN IF NOT EXISTS "note" text;
ALTER TABLE public.apa_areas ADD COLUMN IF NOT EXISTS "updated_by" uuid;
ALTER TABLE public.apa_areas ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
CREATE TABLE IF NOT EXISTS public.apa_audit (
  "id" bigint DEFAULT nextval('apa_audit_id_seq'::regclass) NOT NULL,
  "entity" text NOT NULL,
  "entity_id" text,
  "action" text NOT NULL,
  "before" jsonb,
  "after" jsonb,
  "note" text,
  "by_user" uuid,
  "at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.apa_audit ADD COLUMN IF NOT EXISTS "id" bigint DEFAULT nextval('apa_audit_id_seq'::regclass);
ALTER TABLE public.apa_audit ADD COLUMN IF NOT EXISTS "entity" text;
ALTER TABLE public.apa_audit ADD COLUMN IF NOT EXISTS "entity_id" text;
ALTER TABLE public.apa_audit ADD COLUMN IF NOT EXISTS "action" text;
ALTER TABLE public.apa_audit ADD COLUMN IF NOT EXISTS "before" jsonb;
ALTER TABLE public.apa_audit ADD COLUMN IF NOT EXISTS "after" jsonb;
ALTER TABLE public.apa_audit ADD COLUMN IF NOT EXISTS "note" text;
ALTER TABLE public.apa_audit ADD COLUMN IF NOT EXISTS "by_user" uuid;
ALTER TABLE public.apa_audit ADD COLUMN IF NOT EXISTS "at" timestamp with time zone DEFAULT now();
CREATE TABLE IF NOT EXISTS public.apa_commitments (
  "id" bigint DEFAULT nextval('apa_commitments_id_seq'::regclass) NOT NULL,
  "import_id" uuid NOT NULL,
  "sheet" text NOT NULL,
  "row_number" integer NOT NULL,
  "status" text NOT NULL,
  "reasons" text[] DEFAULT '{}'::text[] NOT NULL,
  "pedido" text,
  "linea" text,
  "producto" text,
  "unidad" text,
  "cantidad" numeric,
  "fecha_compromiso" date,
  "version" integer DEFAULT 1 NOT NULL,
  "estado" text DEFAULT 'VIGENTE'::text NOT NULL
);
ALTER TABLE public.apa_commitments ADD COLUMN IF NOT EXISTS "id" bigint DEFAULT nextval('apa_commitments_id_seq'::regclass);
ALTER TABLE public.apa_commitments ADD COLUMN IF NOT EXISTS "import_id" uuid;
ALTER TABLE public.apa_commitments ADD COLUMN IF NOT EXISTS "sheet" text;
ALTER TABLE public.apa_commitments ADD COLUMN IF NOT EXISTS "row_number" integer;
ALTER TABLE public.apa_commitments ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE public.apa_commitments ADD COLUMN IF NOT EXISTS "reasons" text[] DEFAULT '{}'::text[];
ALTER TABLE public.apa_commitments ADD COLUMN IF NOT EXISTS "pedido" text;
ALTER TABLE public.apa_commitments ADD COLUMN IF NOT EXISTS "linea" text;
ALTER TABLE public.apa_commitments ADD COLUMN IF NOT EXISTS "producto" text;
ALTER TABLE public.apa_commitments ADD COLUMN IF NOT EXISTS "unidad" text;
ALTER TABLE public.apa_commitments ADD COLUMN IF NOT EXISTS "cantidad" numeric;
ALTER TABLE public.apa_commitments ADD COLUMN IF NOT EXISTS "fecha_compromiso" date;
ALTER TABLE public.apa_commitments ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1;
ALTER TABLE public.apa_commitments ADD COLUMN IF NOT EXISTS "estado" text DEFAULT 'VIGENTE'::text;
CREATE TABLE IF NOT EXISTS public.apa_conversions (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "producto" text,
  "from_unit" text NOT NULL,
  "to_unit" text NOT NULL,
  "factor" numeric NOT NULL,
  "verified" boolean DEFAULT false NOT NULL,
  "note" text,
  "updated_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.apa_conversions ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid();
ALTER TABLE public.apa_conversions ADD COLUMN IF NOT EXISTS "producto" text;
ALTER TABLE public.apa_conversions ADD COLUMN IF NOT EXISTS "from_unit" text;
ALTER TABLE public.apa_conversions ADD COLUMN IF NOT EXISTS "to_unit" text;
ALTER TABLE public.apa_conversions ADD COLUMN IF NOT EXISTS "factor" numeric;
ALTER TABLE public.apa_conversions ADD COLUMN IF NOT EXISTS "verified" boolean DEFAULT false;
ALTER TABLE public.apa_conversions ADD COLUMN IF NOT EXISTS "note" text;
ALTER TABLE public.apa_conversions ADD COLUMN IF NOT EXISTS "updated_by" uuid;
ALTER TABLE public.apa_conversions ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
CREATE TABLE IF NOT EXISTS public.apa_doc_classes (
  "tipo" text NOT NULL,
  "clase" text NOT NULL,
  "confirmed" boolean DEFAULT false NOT NULL,
  "updated_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.apa_doc_classes ADD COLUMN IF NOT EXISTS "tipo" text;
ALTER TABLE public.apa_doc_classes ADD COLUMN IF NOT EXISTS "clase" text;
ALTER TABLE public.apa_doc_classes ADD COLUMN IF NOT EXISTS "confirmed" boolean DEFAULT false;
ALTER TABLE public.apa_doc_classes ADD COLUMN IF NOT EXISTS "updated_by" uuid;
ALTER TABLE public.apa_doc_classes ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
CREATE TABLE IF NOT EXISTS public.apa_imports (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "source_type" text NOT NULL,
  "file_name" text NOT NULL,
  "file_hash" text NOT NULL,
  "file_size" bigint,
  "sheets" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "period_from" date,
  "period_to" date,
  "cutoff" date,
  "rows_total" integer DEFAULT 0 NOT NULL,
  "rows_accepted" integer DEFAULT 0 NOT NULL,
  "rows_rejected" integer DEFAULT 0 NOT NULL,
  "rows_review" integer DEFAULT 0 NOT NULL,
  "rows_discarded" integer DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'PREPARANDO'::text NOT NULL,
  "parser_version" text,
  "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "activated_at" timestamp with time zone,
  "reverted_by" uuid,
  "reverted_at" timestamp with time zone,
  "revert_reason" text
);
ALTER TABLE public.apa_imports ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid();
ALTER TABLE public.apa_imports ADD COLUMN IF NOT EXISTS "source_type" text;
ALTER TABLE public.apa_imports ADD COLUMN IF NOT EXISTS "file_name" text;
ALTER TABLE public.apa_imports ADD COLUMN IF NOT EXISTS "file_hash" text;
ALTER TABLE public.apa_imports ADD COLUMN IF NOT EXISTS "file_size" bigint;
ALTER TABLE public.apa_imports ADD COLUMN IF NOT EXISTS "sheets" jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.apa_imports ADD COLUMN IF NOT EXISTS "period_from" date;
ALTER TABLE public.apa_imports ADD COLUMN IF NOT EXISTS "period_to" date;
ALTER TABLE public.apa_imports ADD COLUMN IF NOT EXISTS "cutoff" date;
ALTER TABLE public.apa_imports ADD COLUMN IF NOT EXISTS "rows_total" integer DEFAULT 0;
ALTER TABLE public.apa_imports ADD COLUMN IF NOT EXISTS "rows_accepted" integer DEFAULT 0;
ALTER TABLE public.apa_imports ADD COLUMN IF NOT EXISTS "rows_rejected" integer DEFAULT 0;
ALTER TABLE public.apa_imports ADD COLUMN IF NOT EXISTS "rows_review" integer DEFAULT 0;
ALTER TABLE public.apa_imports ADD COLUMN IF NOT EXISTS "rows_discarded" integer DEFAULT 0;
ALTER TABLE public.apa_imports ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'PREPARANDO'::text;
ALTER TABLE public.apa_imports ADD COLUMN IF NOT EXISTS "parser_version" text;
ALTER TABLE public.apa_imports ADD COLUMN IF NOT EXISTS "warnings" jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.apa_imports ADD COLUMN IF NOT EXISTS "created_by" uuid;
ALTER TABLE public.apa_imports ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE public.apa_imports ADD COLUMN IF NOT EXISTS "activated_at" timestamp with time zone;
ALTER TABLE public.apa_imports ADD COLUMN IF NOT EXISTS "reverted_by" uuid;
ALTER TABLE public.apa_imports ADD COLUMN IF NOT EXISTS "reverted_at" timestamp with time zone;
ALTER TABLE public.apa_imports ADD COLUMN IF NOT EXISTS "revert_reason" text;
CREATE TABLE IF NOT EXISTS public.apa_links (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "from_kind" text NOT NULL,
  "from_ref" text NOT NULL,
  "to_kind" text NOT NULL,
  "to_ref" text NOT NULL,
  "qty" numeric,
  "unidad" text,
  "origin" text NOT NULL,
  "rule" text,
  "note" text,
  "status" text DEFAULT 'VIGENTE'::text NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.apa_links ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid();
ALTER TABLE public.apa_links ADD COLUMN IF NOT EXISTS "from_kind" text;
ALTER TABLE public.apa_links ADD COLUMN IF NOT EXISTS "from_ref" text;
ALTER TABLE public.apa_links ADD COLUMN IF NOT EXISTS "to_kind" text;
ALTER TABLE public.apa_links ADD COLUMN IF NOT EXISTS "to_ref" text;
ALTER TABLE public.apa_links ADD COLUMN IF NOT EXISTS "qty" numeric;
ALTER TABLE public.apa_links ADD COLUMN IF NOT EXISTS "unidad" text;
ALTER TABLE public.apa_links ADD COLUMN IF NOT EXISTS "origin" text;
ALTER TABLE public.apa_links ADD COLUMN IF NOT EXISTS "rule" text;
ALTER TABLE public.apa_links ADD COLUMN IF NOT EXISTS "note" text;
ALTER TABLE public.apa_links ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'VIGENTE'::text;
ALTER TABLE public.apa_links ADD COLUMN IF NOT EXISTS "created_by" uuid;
ALTER TABLE public.apa_links ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE public.apa_links ADD COLUMN IF NOT EXISTS "updated_by" uuid;
ALTER TABLE public.apa_links ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
CREATE TABLE IF NOT EXISTS public.apa_movements (
  "id" bigint DEFAULT nextval('apa_movements_id_seq'::regclass) NOT NULL,
  "import_id" uuid NOT NULL,
  "sheet" text NOT NULL,
  "row_number" integer NOT NULL,
  "status" text NOT NULL,
  "reasons" text[] DEFAULT '{}'::text[] NOT NULL,
  "fingerprint" text,
  "dup" integer DEFAULT 1 NOT NULL,
  "side" text,
  "tipo" text,
  "bodega_raw" text,
  "bodega" text,
  "numero" text,
  "fecha" date,
  "cod_legal" text,
  "razon_social" text,
  "producto" text,
  "glosa" text,
  "cantidad" numeric,
  "unidad" text,
  "doc_rel" text,
  "num_rel" text,
  "fecha_entrega" date,
  "contrato" text,
  "ref_tipo" text,
  "ref_correlativo" text,
  "ref_numero" text,
  "ref_fecha" date,
  "lote" text,
  "color" text,
  "comentario" text,
  "peso_unitario" numeric,
  "peso_x_producir" numeric,
  "peso_producido" numeric,
  "ccosto" text,
  "reviewed_by" uuid,
  "reviewed_at" timestamp with time zone,
  "review_note" text
);
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "id" bigint DEFAULT nextval('apa_movements_id_seq'::regclass);
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "import_id" uuid;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "sheet" text;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "row_number" integer;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "reasons" text[] DEFAULT '{}'::text[];
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "fingerprint" text;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "dup" integer DEFAULT 1;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "side" text;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "tipo" text;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "bodega_raw" text;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "bodega" text;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "numero" text;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "fecha" date;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "cod_legal" text;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "razon_social" text;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "producto" text;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "glosa" text;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "cantidad" numeric;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "unidad" text;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "doc_rel" text;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "num_rel" text;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "fecha_entrega" date;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "contrato" text;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "ref_tipo" text;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "ref_correlativo" text;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "ref_numero" text;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "ref_fecha" date;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "lote" text;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "color" text;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "comentario" text;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "peso_unitario" numeric;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "peso_x_producir" numeric;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "peso_producido" numeric;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "ccosto" text;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "reviewed_by" uuid;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone;
ALTER TABLE public.apa_movements ADD COLUMN IF NOT EXISTS "review_note" text;
CREATE TABLE IF NOT EXISTS public.apa_opening_balances (
  "id" bigint DEFAULT nextval('apa_opening_balances_id_seq'::regclass) NOT NULL,
  "import_id" uuid NOT NULL,
  "sheet" text NOT NULL,
  "row_number" integer NOT NULL,
  "status" text NOT NULL,
  "reasons" text[] DEFAULT '{}'::text[] NOT NULL,
  "bodega" text,
  "producto" text,
  "lote" text,
  "unidad" text,
  "cantidad" numeric,
  "cutoff" date
);
ALTER TABLE public.apa_opening_balances ADD COLUMN IF NOT EXISTS "id" bigint DEFAULT nextval('apa_opening_balances_id_seq'::regclass);
ALTER TABLE public.apa_opening_balances ADD COLUMN IF NOT EXISTS "import_id" uuid;
ALTER TABLE public.apa_opening_balances ADD COLUMN IF NOT EXISTS "sheet" text;
ALTER TABLE public.apa_opening_balances ADD COLUMN IF NOT EXISTS "row_number" integer;
ALTER TABLE public.apa_opening_balances ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE public.apa_opening_balances ADD COLUMN IF NOT EXISTS "reasons" text[] DEFAULT '{}'::text[];
ALTER TABLE public.apa_opening_balances ADD COLUMN IF NOT EXISTS "bodega" text;
ALTER TABLE public.apa_opening_balances ADD COLUMN IF NOT EXISTS "producto" text;
ALTER TABLE public.apa_opening_balances ADD COLUMN IF NOT EXISTS "lote" text;
ALTER TABLE public.apa_opening_balances ADD COLUMN IF NOT EXISTS "unidad" text;
ALTER TABLE public.apa_opening_balances ADD COLUMN IF NOT EXISTS "cantidad" numeric;
ALTER TABLE public.apa_opening_balances ADD COLUMN IF NOT EXISTS "cutoff" date;
CREATE TABLE IF NOT EXISTS public.apa_raw_rows (
  "import_id" uuid NOT NULL,
  "sheet" text NOT NULL,
  "row_number" integer NOT NULL,
  "data" jsonb NOT NULL
);
ALTER TABLE public.apa_raw_rows ADD COLUMN IF NOT EXISTS "import_id" uuid;
ALTER TABLE public.apa_raw_rows ADD COLUMN IF NOT EXISTS "sheet" text;
ALTER TABLE public.apa_raw_rows ADD COLUMN IF NOT EXISTS "row_number" integer;
ALTER TABLE public.apa_raw_rows ADD COLUMN IF NOT EXISTS "data" jsonb;
CREATE TABLE IF NOT EXISTS public.apa_receipts (
  "id" bigint DEFAULT nextval('apa_receipts_id_seq'::regclass) NOT NULL,
  "import_id" uuid NOT NULL,
  "sheet" text NOT NULL,
  "row_number" integer NOT NULL,
  "status" text NOT NULL,
  "reasons" text[] DEFAULT '{}'::text[] NOT NULL,
  "despacho" text,
  "producto" text,
  "unidad" text,
  "aceptada" numeric,
  "rechazada" numeric,
  "fecha" date,
  "motivo" text,
  "pedido" text,
  "linea" text
);
ALTER TABLE public.apa_receipts ADD COLUMN IF NOT EXISTS "id" bigint DEFAULT nextval('apa_receipts_id_seq'::regclass);
ALTER TABLE public.apa_receipts ADD COLUMN IF NOT EXISTS "import_id" uuid;
ALTER TABLE public.apa_receipts ADD COLUMN IF NOT EXISTS "sheet" text;
ALTER TABLE public.apa_receipts ADD COLUMN IF NOT EXISTS "row_number" integer;
ALTER TABLE public.apa_receipts ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE public.apa_receipts ADD COLUMN IF NOT EXISTS "reasons" text[] DEFAULT '{}'::text[];
ALTER TABLE public.apa_receipts ADD COLUMN IF NOT EXISTS "despacho" text;
ALTER TABLE public.apa_receipts ADD COLUMN IF NOT EXISTS "producto" text;
ALTER TABLE public.apa_receipts ADD COLUMN IF NOT EXISTS "unidad" text;
ALTER TABLE public.apa_receipts ADD COLUMN IF NOT EXISTS "aceptada" numeric;
ALTER TABLE public.apa_receipts ADD COLUMN IF NOT EXISTS "rechazada" numeric;
ALTER TABLE public.apa_receipts ADD COLUMN IF NOT EXISTS "fecha" date;
ALTER TABLE public.apa_receipts ADD COLUMN IF NOT EXISTS "motivo" text;
ALTER TABLE public.apa_receipts ADD COLUMN IF NOT EXISTS "pedido" text;
ALTER TABLE public.apa_receipts ADD COLUMN IF NOT EXISTS "linea" text;
CREATE TABLE IF NOT EXISTS public.apa_saved_views (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "owner" uuid NOT NULL,
  "name" text NOT NULL,
  "state" jsonb NOT NULL,
  "shared" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.apa_saved_views ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid();
ALTER TABLE public.apa_saved_views ADD COLUMN IF NOT EXISTS "owner" uuid;
ALTER TABLE public.apa_saved_views ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE public.apa_saved_views ADD COLUMN IF NOT EXISTS "state" jsonb;
ALTER TABLE public.apa_saved_views ADD COLUMN IF NOT EXISTS "shared" boolean DEFAULT false;
ALTER TABLE public.apa_saved_views ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
CREATE TABLE IF NOT EXISTS public.apa_settings (
  "id" integer NOT NULL,
  "same_day_order" text DEFAULT 'ENTRADAS_PRIMERO'::text NOT NULL,
  "age_buckets" integer[] DEFAULT '{0,1,3,7,15,30}'::integer[] NOT NULL,
  "default_ref_date" date DEFAULT '2020-03-22'::date NOT NULL,
  "updated_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.apa_settings ADD COLUMN IF NOT EXISTS "id" integer;
ALTER TABLE public.apa_settings ADD COLUMN IF NOT EXISTS "same_day_order" text DEFAULT 'ENTRADAS_PRIMERO'::text;
ALTER TABLE public.apa_settings ADD COLUMN IF NOT EXISTS "age_buckets" integer[] DEFAULT '{0,1,3,7,15,30}'::integer[];
ALTER TABLE public.apa_settings ADD COLUMN IF NOT EXISTS "default_ref_date" date DEFAULT '2020-03-22'::date;
ALTER TABLE public.apa_settings ADD COLUMN IF NOT EXISTS "updated_by" uuid;
ALTER TABLE public.apa_settings ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
CREATE TABLE IF NOT EXISTS public.apt_aging_ranges (
  "desde" integer NOT NULL,
  "label" text NOT NULL
);
ALTER TABLE public.apt_aging_ranges ADD COLUMN IF NOT EXISTS "desde" integer;
ALTER TABLE public.apt_aging_ranges ADD COLUMN IF NOT EXISTS "label" text;
CREATE TABLE IF NOT EXISTS public.apt_allocations (
  "layer_id" bigint NOT NULL,
  "exit_id" bigint NOT NULL,
  "kg" numeric NOT NULL,
  "fecha_ingreso" date NOT NULL,
  "fecha_salida" date NOT NULL,
  "dias" integer NOT NULL
);
ALTER TABLE public.apt_allocations ADD COLUMN IF NOT EXISTS "layer_id" bigint;
ALTER TABLE public.apt_allocations ADD COLUMN IF NOT EXISTS "exit_id" bigint;
ALTER TABLE public.apt_allocations ADD COLUMN IF NOT EXISTS "kg" numeric;
ALTER TABLE public.apt_allocations ADD COLUMN IF NOT EXISTS "fecha_ingreso" date;
ALTER TABLE public.apt_allocations ADD COLUMN IF NOT EXISTS "fecha_salida" date;
ALTER TABLE public.apt_allocations ADD COLUMN IF NOT EXISTS "dias" integer;
CREATE TABLE IF NOT EXISTS public.apt_exit_class (
  "exit_id" bigint NOT NULL,
  "lote" text,
  "producto" text,
  "fecha" date NOT NULL,
  "kg" numeric NOT NULL,
  "kg_asignado" numeric DEFAULT 0 NOT NULL,
  "kg_sin_entrada" numeric DEFAULT 0 NOT NULL,
  "clase" text NOT NULL
);
ALTER TABLE public.apt_exit_class ADD COLUMN IF NOT EXISTS "exit_id" bigint;
ALTER TABLE public.apt_exit_class ADD COLUMN IF NOT EXISTS "lote" text;
ALTER TABLE public.apt_exit_class ADD COLUMN IF NOT EXISTS "producto" text;
ALTER TABLE public.apt_exit_class ADD COLUMN IF NOT EXISTS "fecha" date;
ALTER TABLE public.apt_exit_class ADD COLUMN IF NOT EXISTS "kg" numeric;
ALTER TABLE public.apt_exit_class ADD COLUMN IF NOT EXISTS "kg_asignado" numeric DEFAULT 0;
ALTER TABLE public.apt_exit_class ADD COLUMN IF NOT EXISTS "kg_sin_entrada" numeric DEFAULT 0;
ALTER TABLE public.apt_exit_class ADD COLUMN IF NOT EXISTS "clase" text;
CREATE TABLE IF NOT EXISTS public.apt_flow_alloc (
  "layer_id" bigint NOT NULL,
  "exit_id" bigint NOT NULL,
  "kg" numeric NOT NULL
);
ALTER TABLE public.apt_flow_alloc ADD COLUMN IF NOT EXISTS "layer_id" bigint;
ALTER TABLE public.apt_flow_alloc ADD COLUMN IF NOT EXISTS "exit_id" bigint;
ALTER TABLE public.apt_flow_alloc ADD COLUMN IF NOT EXISTS "kg" numeric;
CREATE TABLE IF NOT EXISTS public.apt_flow_exits (
  "id" bigint NOT NULL,
  "almacen" text NOT NULL,
  "lote" text NOT NULL,
  "producto" text NOT NULL,
  "tipo" text NOT NULL,
  "fecha" date NOT NULL,
  "kg" numeric NOT NULL,
  "almacen_destino" text,
  "lote_destino" text,
  "documento" text,
  "cliente" text,
  "numrel" text,
  "docrel" text,
  "glosa" text
);
ALTER TABLE public.apt_flow_exits ADD COLUMN IF NOT EXISTS "id" bigint;
ALTER TABLE public.apt_flow_exits ADD COLUMN IF NOT EXISTS "almacen" text;
ALTER TABLE public.apt_flow_exits ADD COLUMN IF NOT EXISTS "lote" text;
ALTER TABLE public.apt_flow_exits ADD COLUMN IF NOT EXISTS "producto" text;
ALTER TABLE public.apt_flow_exits ADD COLUMN IF NOT EXISTS "tipo" text;
ALTER TABLE public.apt_flow_exits ADD COLUMN IF NOT EXISTS "fecha" date;
ALTER TABLE public.apt_flow_exits ADD COLUMN IF NOT EXISTS "kg" numeric;
ALTER TABLE public.apt_flow_exits ADD COLUMN IF NOT EXISTS "almacen_destino" text;
ALTER TABLE public.apt_flow_exits ADD COLUMN IF NOT EXISTS "lote_destino" text;
ALTER TABLE public.apt_flow_exits ADD COLUMN IF NOT EXISTS "documento" text;
ALTER TABLE public.apt_flow_exits ADD COLUMN IF NOT EXISTS "cliente" text;
ALTER TABLE public.apt_flow_exits ADD COLUMN IF NOT EXISTS "numrel" text;
ALTER TABLE public.apt_flow_exits ADD COLUMN IF NOT EXISTS "docrel" text;
ALTER TABLE public.apt_flow_exits ADD COLUMN IF NOT EXISTS "glosa" text;
CREATE TABLE IF NOT EXISTS public.apt_flow_layers (
  "id" bigint NOT NULL,
  "almacen" text NOT NULL,
  "lote" text NOT NULL,
  "producto" text NOT NULL,
  "tipo" text NOT NULL,
  "exit_id" bigint,
  "almacen_origen" text,
  "lote_origen" text,
  "fecha" date,
  "documento" text,
  "glosa" text,
  "cliente" text,
  "kg_in" numeric NOT NULL,
  "kg_out" numeric DEFAULT 0 NOT NULL,
  "kg_saldo" numeric DEFAULT 0 NOT NULL
);
ALTER TABLE public.apt_flow_layers ADD COLUMN IF NOT EXISTS "id" bigint;
ALTER TABLE public.apt_flow_layers ADD COLUMN IF NOT EXISTS "almacen" text;
ALTER TABLE public.apt_flow_layers ADD COLUMN IF NOT EXISTS "lote" text;
ALTER TABLE public.apt_flow_layers ADD COLUMN IF NOT EXISTS "producto" text;
ALTER TABLE public.apt_flow_layers ADD COLUMN IF NOT EXISTS "tipo" text;
ALTER TABLE public.apt_flow_layers ADD COLUMN IF NOT EXISTS "exit_id" bigint;
ALTER TABLE public.apt_flow_layers ADD COLUMN IF NOT EXISTS "almacen_origen" text;
ALTER TABLE public.apt_flow_layers ADD COLUMN IF NOT EXISTS "lote_origen" text;
ALTER TABLE public.apt_flow_layers ADD COLUMN IF NOT EXISTS "fecha" date;
ALTER TABLE public.apt_flow_layers ADD COLUMN IF NOT EXISTS "documento" text;
ALTER TABLE public.apt_flow_layers ADD COLUMN IF NOT EXISTS "glosa" text;
ALTER TABLE public.apt_flow_layers ADD COLUMN IF NOT EXISTS "cliente" text;
ALTER TABLE public.apt_flow_layers ADD COLUMN IF NOT EXISTS "kg_in" numeric;
ALTER TABLE public.apt_flow_layers ADD COLUMN IF NOT EXISTS "kg_out" numeric DEFAULT 0;
ALTER TABLE public.apt_flow_layers ADD COLUMN IF NOT EXISTS "kg_saldo" numeric DEFAULT 0;
CREATE TABLE IF NOT EXISTS public.apt_flow_pieces (
  "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  "es_saldo" boolean NOT NULL,
  "exit_id" bigint,
  "salida_tipo" text,
  "fecha_salida" date,
  "documento" text,
  "cliente" text,
  "layer_id" bigint NOT NULL,
  "almacen" text NOT NULL,
  "layer_tipo" text NOT NULL,
  "almacen_previo" text,
  "fecha_llegada" date,
  "lote" text NOT NULL,
  "producto" text NOT NULL,
  "glosa" text,
  "root_id" bigint NOT NULL,
  "origen" text NOT NULL,
  "root_almacen" text NOT NULL,
  "root_lote" text NOT NULL,
  "fecha_origen" date,
  "kg" numeric NOT NULL
);
ALTER TABLE public.apt_flow_pieces ADD COLUMN IF NOT EXISTS "es_saldo" boolean;
ALTER TABLE public.apt_flow_pieces ADD COLUMN IF NOT EXISTS "exit_id" bigint;
ALTER TABLE public.apt_flow_pieces ADD COLUMN IF NOT EXISTS "salida_tipo" text;
ALTER TABLE public.apt_flow_pieces ADD COLUMN IF NOT EXISTS "fecha_salida" date;
ALTER TABLE public.apt_flow_pieces ADD COLUMN IF NOT EXISTS "documento" text;
ALTER TABLE public.apt_flow_pieces ADD COLUMN IF NOT EXISTS "cliente" text;
ALTER TABLE public.apt_flow_pieces ADD COLUMN IF NOT EXISTS "layer_id" bigint;
ALTER TABLE public.apt_flow_pieces ADD COLUMN IF NOT EXISTS "almacen" text;
ALTER TABLE public.apt_flow_pieces ADD COLUMN IF NOT EXISTS "layer_tipo" text;
ALTER TABLE public.apt_flow_pieces ADD COLUMN IF NOT EXISTS "almacen_previo" text;
ALTER TABLE public.apt_flow_pieces ADD COLUMN IF NOT EXISTS "fecha_llegada" date;
ALTER TABLE public.apt_flow_pieces ADD COLUMN IF NOT EXISTS "lote" text;
ALTER TABLE public.apt_flow_pieces ADD COLUMN IF NOT EXISTS "producto" text;
ALTER TABLE public.apt_flow_pieces ADD COLUMN IF NOT EXISTS "glosa" text;
ALTER TABLE public.apt_flow_pieces ADD COLUMN IF NOT EXISTS "root_id" bigint;
ALTER TABLE public.apt_flow_pieces ADD COLUMN IF NOT EXISTS "origen" text;
ALTER TABLE public.apt_flow_pieces ADD COLUMN IF NOT EXISTS "root_almacen" text;
ALTER TABLE public.apt_flow_pieces ADD COLUMN IF NOT EXISTS "root_lote" text;
ALTER TABLE public.apt_flow_pieces ADD COLUMN IF NOT EXISTS "fecha_origen" date;
ALTER TABLE public.apt_flow_pieces ADD COLUMN IF NOT EXISTS "kg" numeric;
CREATE TABLE IF NOT EXISTS public.apt_flow_state (
  "id" integer DEFAULT 1 NOT NULL,
  "cutoff" date,
  "data_min" date,
  "rebuilt_at" timestamp with time zone,
  "stats" jsonb DEFAULT '{}'::jsonb NOT NULL
);
ALTER TABLE public.apt_flow_state ADD COLUMN IF NOT EXISTS "id" integer DEFAULT 1;
ALTER TABLE public.apt_flow_state ADD COLUMN IF NOT EXISTS "cutoff" date;
ALTER TABLE public.apt_flow_state ADD COLUMN IF NOT EXISTS "data_min" date;
ALTER TABLE public.apt_flow_state ADD COLUMN IF NOT EXISTS "rebuilt_at" timestamp with time zone;
ALTER TABLE public.apt_flow_state ADD COLUMN IF NOT EXISTS "stats" jsonb DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS public.apt_gantt_daily (
  "lote" text NOT NULL,
  "fecha" date,
  "kg" numeric NOT NULL
);
ALTER TABLE public.apt_gantt_daily ADD COLUMN IF NOT EXISTS "lote" text;
ALTER TABLE public.apt_gantt_daily ADD COLUMN IF NOT EXISTS "fecha" date;
ALTER TABLE public.apt_gantt_daily ADD COLUMN IF NOT EXISTS "kg" numeric;
CREATE TABLE IF NOT EXISTS public.apt_gantt_lotes (
  "lote" text NOT NULL,
  "ot" text,
  "cliente" text,
  "productos" integer,
  "ingreso" numeric,
  "inicial" numeric,
  "asignado" numeric,
  "despacho" numeric,
  "otro" numeric,
  "cedido" numeric,
  "saldo" numeric,
  "desconocido" numeric,
  "primera" date,
  "ultima" date,
  "primera_salida" date,
  "age_kg_days" numeric,
  "age_kg" numeric,
  "critico_kg" numeric,
  "almacenes" text[]
);
ALTER TABLE public.apt_gantt_lotes ADD COLUMN IF NOT EXISTS "lote" text;
ALTER TABLE public.apt_gantt_lotes ADD COLUMN IF NOT EXISTS "ot" text;
ALTER TABLE public.apt_gantt_lotes ADD COLUMN IF NOT EXISTS "cliente" text;
ALTER TABLE public.apt_gantt_lotes ADD COLUMN IF NOT EXISTS "productos" integer;
ALTER TABLE public.apt_gantt_lotes ADD COLUMN IF NOT EXISTS "ingreso" numeric;
ALTER TABLE public.apt_gantt_lotes ADD COLUMN IF NOT EXISTS "inicial" numeric;
ALTER TABLE public.apt_gantt_lotes ADD COLUMN IF NOT EXISTS "asignado" numeric;
ALTER TABLE public.apt_gantt_lotes ADD COLUMN IF NOT EXISTS "despacho" numeric;
ALTER TABLE public.apt_gantt_lotes ADD COLUMN IF NOT EXISTS "otro" numeric;
ALTER TABLE public.apt_gantt_lotes ADD COLUMN IF NOT EXISTS "cedido" numeric;
ALTER TABLE public.apt_gantt_lotes ADD COLUMN IF NOT EXISTS "saldo" numeric;
ALTER TABLE public.apt_gantt_lotes ADD COLUMN IF NOT EXISTS "desconocido" numeric;
ALTER TABLE public.apt_gantt_lotes ADD COLUMN IF NOT EXISTS "primera" date;
ALTER TABLE public.apt_gantt_lotes ADD COLUMN IF NOT EXISTS "ultima" date;
ALTER TABLE public.apt_gantt_lotes ADD COLUMN IF NOT EXISTS "primera_salida" date;
ALTER TABLE public.apt_gantt_lotes ADD COLUMN IF NOT EXISTS "age_kg_days" numeric;
ALTER TABLE public.apt_gantt_lotes ADD COLUMN IF NOT EXISTS "age_kg" numeric;
ALTER TABLE public.apt_gantt_lotes ADD COLUMN IF NOT EXISTS "critico_kg" numeric;
ALTER TABLE public.apt_gantt_lotes ADD COLUMN IF NOT EXISTS "almacenes" text[];
CREATE TABLE IF NOT EXISTS public.apt_gantt_meta (
  "id" integer DEFAULT 1 NOT NULL,
  "flow_rebuilt_at" timestamp with time zone,
  "cutoff" date,
  "alert_days" integer,
  "data_max" date,
  "coverage" jsonb,
  "built_at" timestamp with time zone
);
ALTER TABLE public.apt_gantt_meta ADD COLUMN IF NOT EXISTS "id" integer DEFAULT 1;
ALTER TABLE public.apt_gantt_meta ADD COLUMN IF NOT EXISTS "flow_rebuilt_at" timestamp with time zone;
ALTER TABLE public.apt_gantt_meta ADD COLUMN IF NOT EXISTS "cutoff" date;
ALTER TABLE public.apt_gantt_meta ADD COLUMN IF NOT EXISTS "alert_days" integer;
ALTER TABLE public.apt_gantt_meta ADD COLUMN IF NOT EXISTS "data_max" date;
ALTER TABLE public.apt_gantt_meta ADD COLUMN IF NOT EXISTS "coverage" jsonb;
ALTER TABLE public.apt_gantt_meta ADD COLUMN IF NOT EXISTS "built_at" timestamp with time zone;
CREATE TABLE IF NOT EXISTS public.apt_layers (
  "movement_id" bigint NOT NULL,
  "lote" text NOT NULL,
  "producto" text NOT NULL,
  "numrel_op" text,
  "glosa" text,
  "familia" text,
  "ipt" text,
  "documento" text,
  "docrel" text,
  "fecha_ingreso" date NOT NULL,
  "fecha_entrega" date,
  "cantidad" numeric,
  "unidad" text,
  "kg_in" numeric NOT NULL,
  "kg_out" numeric DEFAULT 0 NOT NULL,
  "kg_saldo" numeric DEFAULT 0 NOT NULL,
  "kg_out_before_in" numeric DEFAULT 0 NOT NULL,
  "kg_out_fechado" numeric DEFAULT 0 NOT NULL,
  "out_kg_days" numeric DEFAULT 0 NOT NULL,
  "problema_info" boolean DEFAULT false NOT NULL,
  "posible_cruce" boolean DEFAULT false NOT NULL,
  "first_out" date,
  "last_out" date,
  "dias" integer,
  "dias_saldo" integer,
  "estado" text NOT NULL,
  "rango" text,
  "rango_orden" integer,
  "tn_dias" numeric DEFAULT 0 NOT NULL,
  "cliente" text,
  "cliente_fuente" text
);
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "movement_id" bigint;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "lote" text;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "producto" text;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "numrel_op" text;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "glosa" text;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "familia" text;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "ipt" text;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "documento" text;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "docrel" text;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "fecha_ingreso" date;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "fecha_entrega" date;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "cantidad" numeric;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "unidad" text;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "kg_in" numeric;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "kg_out" numeric DEFAULT 0;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "kg_saldo" numeric DEFAULT 0;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "kg_out_before_in" numeric DEFAULT 0;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "kg_out_fechado" numeric DEFAULT 0;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "out_kg_days" numeric DEFAULT 0;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "problema_info" boolean DEFAULT false;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "posible_cruce" boolean DEFAULT false;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "first_out" date;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "last_out" date;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "dias" integer;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "dias_saldo" integer;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "estado" text;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "rango" text;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "rango_orden" integer;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "tn_dias" numeric DEFAULT 0;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "cliente" text;
ALTER TABLE public.apt_layers ADD COLUMN IF NOT EXISTS "cliente_fuente" text;
CREATE TABLE IF NOT EXISTS public.apt_movements (
  "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  "upload_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "row_no" integer NOT NULL,
  "raw" jsonb NOT NULL,
  "active" boolean DEFAULT false NOT NULL,
  "valid" boolean NOT NULL,
  "invalid_reason" text,
  "fecha" date,
  "documento" text,
  "tipodocto" text,
  "bodega" text,
  "numrel" text,
  "lote_origen" text,
  "lote" text,
  "lote_derivado" boolean DEFAULT false NOT NULL,
  "docrel" text,
  "cliente" text,
  "ruc" text,
  "producto" text,
  "glosa" text,
  "familia" text,
  "ipt" text,
  "cantidad" numeric,
  "unidad" text,
  "peso_unitario" numeric,
  "peso_kg" numeric DEFAULT 0 NOT NULL,
  "fecha_entrega" date,
  "almacen" text,
  "contrato" text
);
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "upload_id" uuid;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "kind" text;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "row_no" integer;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "raw" jsonb;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "active" boolean DEFAULT false;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "valid" boolean;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "invalid_reason" text;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "fecha" date;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "documento" text;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "tipodocto" text;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "bodega" text;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "numrel" text;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "lote_origen" text;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "lote" text;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "lote_derivado" boolean DEFAULT false;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "docrel" text;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "cliente" text;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "ruc" text;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "producto" text;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "glosa" text;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "familia" text;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "ipt" text;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "cantidad" numeric;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "unidad" text;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "peso_unitario" numeric;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "peso_kg" numeric DEFAULT 0;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "fecha_entrega" date;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "almacen" text;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS "contrato" text;
CREATE TABLE IF NOT EXISTS public.apt_operational_readiness (
  "almacen" text NOT NULL,
  "lote" text NOT NULL,
  "producto" text DEFAULT '*'::text NOT NULL,
  "status" text DEFAULT 'NO_EVALUADO'::text NOT NULL,
  "reason" text,
  "responsible_name" text,
  "next_action" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" uuid
);
ALTER TABLE public.apt_operational_readiness ADD COLUMN IF NOT EXISTS "almacen" text;
ALTER TABLE public.apt_operational_readiness ADD COLUMN IF NOT EXISTS "lote" text;
ALTER TABLE public.apt_operational_readiness ADD COLUMN IF NOT EXISTS "producto" text DEFAULT '*'::text;
ALTER TABLE public.apt_operational_readiness ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'NO_EVALUADO'::text;
ALTER TABLE public.apt_operational_readiness ADD COLUMN IF NOT EXISTS "reason" text;
ALTER TABLE public.apt_operational_readiness ADD COLUMN IF NOT EXISTS "responsible_name" text;
ALTER TABLE public.apt_operational_readiness ADD COLUMN IF NOT EXISTS "next_action" text;
ALTER TABLE public.apt_operational_readiness ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
ALTER TABLE public.apt_operational_readiness ADD COLUMN IF NOT EXISTS "updated_by" uuid;
CREATE TABLE IF NOT EXISTS public.apt_operational_readiness_history (
  "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  "almacen" text NOT NULL,
  "lote" text NOT NULL,
  "producto" text NOT NULL,
  "before_data" jsonb,
  "after_data" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid
);
ALTER TABLE public.apt_operational_readiness_history ADD COLUMN IF NOT EXISTS "almacen" text;
ALTER TABLE public.apt_operational_readiness_history ADD COLUMN IF NOT EXISTS "lote" text;
ALTER TABLE public.apt_operational_readiness_history ADD COLUMN IF NOT EXISTS "producto" text;
ALTER TABLE public.apt_operational_readiness_history ADD COLUMN IF NOT EXISTS "before_data" jsonb;
ALTER TABLE public.apt_operational_readiness_history ADD COLUMN IF NOT EXISTS "after_data" jsonb;
ALTER TABLE public.apt_operational_readiness_history ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE public.apt_operational_readiness_history ADD COLUMN IF NOT EXISTS "created_by" uuid;
CREATE TABLE IF NOT EXISTS public.apt_read_cache (
  "fn" text NOT NULL,
  "key_hash" text NOT NULL,
  "params" jsonb NOT NULL,
  "version" text NOT NULL,
  "result" jsonb NOT NULL,
  "built_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
ALTER TABLE public.apt_read_cache ADD COLUMN IF NOT EXISTS "fn" text;
ALTER TABLE public.apt_read_cache ADD COLUMN IF NOT EXISTS "key_hash" text;
ALTER TABLE public.apt_read_cache ADD COLUMN IF NOT EXISTS "params" jsonb;
ALTER TABLE public.apt_read_cache ADD COLUMN IF NOT EXISTS "version" text;
ALTER TABLE public.apt_read_cache ADD COLUMN IF NOT EXISTS "result" jsonb;
ALTER TABLE public.apt_read_cache ADD COLUMN IF NOT EXISTS "built_at" timestamp with time zone DEFAULT clock_timestamp();
CREATE TABLE IF NOT EXISTS public.apt_read_cache_requests (
  "fn" text NOT NULL,
  "key_hash" text NOT NULL,
  "params" jsonb NOT NULL,
  "requested_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "claimed_at" timestamp with time zone
);
ALTER TABLE public.apt_read_cache_requests ADD COLUMN IF NOT EXISTS "fn" text;
ALTER TABLE public.apt_read_cache_requests ADD COLUMN IF NOT EXISTS "key_hash" text;
ALTER TABLE public.apt_read_cache_requests ADD COLUMN IF NOT EXISTS "params" jsonb;
ALTER TABLE public.apt_read_cache_requests ADD COLUMN IF NOT EXISTS "requested_at" timestamp with time zone DEFAULT clock_timestamp();
ALTER TABLE public.apt_read_cache_requests ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0;
ALTER TABLE public.apt_read_cache_requests ADD COLUMN IF NOT EXISTS "claimed_at" timestamp with time zone;
CREATE TABLE IF NOT EXISTS public.apt_settings (
  "id" integer DEFAULT 1 NOT NULL,
  "cutoff_date" date,
  "tolerance" numeric DEFAULT 0.02 NOT NULL,
  "alert_days" integer DEFAULT 60 NOT NULL,
  "updated_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.apt_settings ADD COLUMN IF NOT EXISTS "id" integer DEFAULT 1;
ALTER TABLE public.apt_settings ADD COLUMN IF NOT EXISTS "cutoff_date" date;
ALTER TABLE public.apt_settings ADD COLUMN IF NOT EXISTS "tolerance" numeric DEFAULT 0.02;
ALTER TABLE public.apt_settings ADD COLUMN IF NOT EXISTS "alert_days" integer DEFAULT 60;
ALTER TABLE public.apt_settings ADD COLUMN IF NOT EXISTS "updated_by" uuid;
ALTER TABLE public.apt_settings ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
CREATE TABLE IF NOT EXISTS public.apt_state (
  "id" integer DEFAULT 1 NOT NULL,
  "cutoff" date,
  "data_min" date,
  "data_max" date,
  "rebuilt_at" timestamp with time zone
);
ALTER TABLE public.apt_state ADD COLUMN IF NOT EXISTS "id" integer DEFAULT 1;
ALTER TABLE public.apt_state ADD COLUMN IF NOT EXISTS "cutoff" date;
ALTER TABLE public.apt_state ADD COLUMN IF NOT EXISTS "data_min" date;
ALTER TABLE public.apt_state ADD COLUMN IF NOT EXISTS "data_max" date;
ALTER TABLE public.apt_state ADD COLUMN IF NOT EXISTS "rebuilt_at" timestamp with time zone;
CREATE TABLE IF NOT EXISTS public.apt_stock_observations (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "cutoff" date NOT NULL,
  "almacen" text NOT NULL,
  "lote" text NOT NULL,
  "producto" text NOT NULL,
  "peso_kg" numeric(18,6) NOT NULL,
  "source" text NOT NULL,
  "reference" text NOT NULL,
  "notes" text,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.apt_stock_observations ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid();
ALTER TABLE public.apt_stock_observations ADD COLUMN IF NOT EXISTS "cutoff" date;
ALTER TABLE public.apt_stock_observations ADD COLUMN IF NOT EXISTS "almacen" text;
ALTER TABLE public.apt_stock_observations ADD COLUMN IF NOT EXISTS "lote" text;
ALTER TABLE public.apt_stock_observations ADD COLUMN IF NOT EXISTS "producto" text;
ALTER TABLE public.apt_stock_observations ADD COLUMN IF NOT EXISTS "peso_kg" numeric(18,6);
ALTER TABLE public.apt_stock_observations ADD COLUMN IF NOT EXISTS "source" text;
ALTER TABLE public.apt_stock_observations ADD COLUMN IF NOT EXISTS "reference" text;
ALTER TABLE public.apt_stock_observations ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE public.apt_stock_observations ADD COLUMN IF NOT EXISTS "created_by" uuid;
ALTER TABLE public.apt_stock_observations ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
CREATE TABLE IF NOT EXISTS public.apt_uploads (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "file_name" text NOT NULL,
  "status" text DEFAULT 'CARGANDO'::text NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "applied_at" timestamp with time zone,
  "summary" jsonb DEFAULT '{}'::jsonb NOT NULL
);
ALTER TABLE public.apt_uploads ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid();
ALTER TABLE public.apt_uploads ADD COLUMN IF NOT EXISTS "file_name" text;
ALTER TABLE public.apt_uploads ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'CARGANDO'::text;
ALTER TABLE public.apt_uploads ADD COLUMN IF NOT EXISTS "created_by" uuid;
ALTER TABLE public.apt_uploads ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE public.apt_uploads ADD COLUMN IF NOT EXISTS "applied_at" timestamp with time zone;
ALTER TABLE public.apt_uploads ADD COLUMN IF NOT EXISTS "summary" jsonb DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS public.erp_derive_days (
  "fecha" date NOT NULL,
  "base_fecha" date NOT NULL,
  "base_fuente" text NOT NULL,
  "stock_import" uuid,
  "contratos_import" uuid,
  "bodegas" text[] DEFAULT '{}'::text[] NOT NULL,
  "resumen" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "rule_version" integer
);
ALTER TABLE public.erp_derive_days ADD COLUMN IF NOT EXISTS "fecha" date;
ALTER TABLE public.erp_derive_days ADD COLUMN IF NOT EXISTS "base_fecha" date;
ALTER TABLE public.erp_derive_days ADD COLUMN IF NOT EXISTS "base_fuente" text;
ALTER TABLE public.erp_derive_days ADD COLUMN IF NOT EXISTS "stock_import" uuid;
ALTER TABLE public.erp_derive_days ADD COLUMN IF NOT EXISTS "contratos_import" uuid;
ALTER TABLE public.erp_derive_days ADD COLUMN IF NOT EXISTS "bodegas" text[] DEFAULT '{}'::text[];
ALTER TABLE public.erp_derive_days ADD COLUMN IF NOT EXISTS "resumen" jsonb DEFAULT '{}'::jsonb;
ALTER TABLE public.erp_derive_days ADD COLUMN IF NOT EXISTS "created_by" uuid;
ALTER TABLE public.erp_derive_days ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE public.erp_derive_days ADD COLUMN IF NOT EXISTS "rule_version" integer;
CREATE TABLE IF NOT EXISTS public.erp_derive_guias (
  "guia_key" text NOT NULL,
  "producto" text NOT NULL,
  "documento" text NOT NULL,
  "dia" date NOT NULL,
  "fecha" date NOT NULL,
  "bodega" text NOT NULL,
  "cantidad" numeric(20,6) NOT NULL
);
ALTER TABLE public.erp_derive_guias ADD COLUMN IF NOT EXISTS "guia_key" text;
ALTER TABLE public.erp_derive_guias ADD COLUMN IF NOT EXISTS "producto" text;
ALTER TABLE public.erp_derive_guias ADD COLUMN IF NOT EXISTS "documento" text;
ALTER TABLE public.erp_derive_guias ADD COLUMN IF NOT EXISTS "dia" date;
ALTER TABLE public.erp_derive_guias ADD COLUMN IF NOT EXISTS "fecha" date;
ALTER TABLE public.erp_derive_guias ADD COLUMN IF NOT EXISTS "bodega" text;
ALTER TABLE public.erp_derive_guias ADD COLUMN IF NOT EXISTS "cantidad" numeric(20,6);
CREATE TABLE IF NOT EXISTS public.erp_derive_stock (
  "fecha" date NOT NULL,
  "bodega" text NOT NULL,
  "producto" text NOT NULL,
  "lote" text NOT NULL,
  "cantidad" numeric(20,6) NOT NULL
);
ALTER TABLE public.erp_derive_stock ADD COLUMN IF NOT EXISTS "fecha" date;
ALTER TABLE public.erp_derive_stock ADD COLUMN IF NOT EXISTS "bodega" text;
ALTER TABLE public.erp_derive_stock ADD COLUMN IF NOT EXISTS "producto" text;
ALTER TABLE public.erp_derive_stock ADD COLUMN IF NOT EXISTS "lote" text;
ALTER TABLE public.erp_derive_stock ADD COLUMN IF NOT EXISTS "cantidad" numeric(20,6);
CREATE TABLE IF NOT EXISTS public.erp_load_log (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "file_name" text,
  "cut_at" timestamp with time zone,
  "import_id" uuid,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "status" text DEFAULT 'EN_CURSO'::text NOT NULL,
  "rows_expected" integer,
  "rows_loaded" integer,
  "detalle" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error" text,
  "rule_version" integer,
  "created_by" uuid
);
ALTER TABLE public.erp_load_log ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid();
ALTER TABLE public.erp_load_log ADD COLUMN IF NOT EXISTS "kind" text;
ALTER TABLE public.erp_load_log ADD COLUMN IF NOT EXISTS "file_name" text;
ALTER TABLE public.erp_load_log ADD COLUMN IF NOT EXISTS "cut_at" timestamp with time zone;
ALTER TABLE public.erp_load_log ADD COLUMN IF NOT EXISTS "import_id" uuid;
ALTER TABLE public.erp_load_log ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone DEFAULT now();
ALTER TABLE public.erp_load_log ADD COLUMN IF NOT EXISTS "finished_at" timestamp with time zone;
ALTER TABLE public.erp_load_log ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'EN_CURSO'::text;
ALTER TABLE public.erp_load_log ADD COLUMN IF NOT EXISTS "rows_expected" integer;
ALTER TABLE public.erp_load_log ADD COLUMN IF NOT EXISTS "rows_loaded" integer;
ALTER TABLE public.erp_load_log ADD COLUMN IF NOT EXISTS "detalle" jsonb DEFAULT '{}'::jsonb;
ALTER TABLE public.erp_load_log ADD COLUMN IF NOT EXISTS "error" text;
ALTER TABLE public.erp_load_log ADD COLUMN IF NOT EXISTS "rule_version" integer;
ALTER TABLE public.erp_load_log ADD COLUMN IF NOT EXISTS "created_by" uuid;
CREATE TABLE IF NOT EXISTS public.erp_rule_versions (
  "version" integer NOT NULL,
  "estado" text NOT NULL,
  "origen" text NOT NULL,
  "reglas" jsonb NOT NULL,
  "nota" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "approved_by" uuid,
  "approved_at" timestamp with time zone
);
ALTER TABLE public.erp_rule_versions ADD COLUMN IF NOT EXISTS "version" integer;
ALTER TABLE public.erp_rule_versions ADD COLUMN IF NOT EXISTS "estado" text;
ALTER TABLE public.erp_rule_versions ADD COLUMN IF NOT EXISTS "origen" text;
ALTER TABLE public.erp_rule_versions ADD COLUMN IF NOT EXISTS "reglas" jsonb;
ALTER TABLE public.erp_rule_versions ADD COLUMN IF NOT EXISTS "nota" text;
ALTER TABLE public.erp_rule_versions ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE public.erp_rule_versions ADD COLUMN IF NOT EXISTS "approved_by" uuid;
ALTER TABLE public.erp_rule_versions ADD COLUMN IF NOT EXISTS "approved_at" timestamp with time zone;
CREATE TABLE IF NOT EXISTS public.erp_sku_medidas (
  "cod_producto" text NOT NULL,
  "producto" text,
  "familia" text,
  "unidad_und" boolean DEFAULT true NOT NULL,
  "peso_unit" numeric(20,6),
  "peso_at" timestamp with time zone,
  "medidas_de" text,
  "largo_m" numeric(14,6),
  "ancho_m" numeric(14,6),
  "alto_m" numeric(14,6),
  "m3_unit" numeric(24,9),
  "kg_m3" numeric(16,2),
  "m3_confiable" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.erp_sku_medidas ADD COLUMN IF NOT EXISTS "cod_producto" text;
ALTER TABLE public.erp_sku_medidas ADD COLUMN IF NOT EXISTS "producto" text;
ALTER TABLE public.erp_sku_medidas ADD COLUMN IF NOT EXISTS "familia" text;
ALTER TABLE public.erp_sku_medidas ADD COLUMN IF NOT EXISTS "unidad_und" boolean DEFAULT true;
ALTER TABLE public.erp_sku_medidas ADD COLUMN IF NOT EXISTS "peso_unit" numeric(20,6);
ALTER TABLE public.erp_sku_medidas ADD COLUMN IF NOT EXISTS "peso_at" timestamp with time zone;
ALTER TABLE public.erp_sku_medidas ADD COLUMN IF NOT EXISTS "medidas_de" text;
ALTER TABLE public.erp_sku_medidas ADD COLUMN IF NOT EXISTS "largo_m" numeric(14,6);
ALTER TABLE public.erp_sku_medidas ADD COLUMN IF NOT EXISTS "ancho_m" numeric(14,6);
ALTER TABLE public.erp_sku_medidas ADD COLUMN IF NOT EXISTS "alto_m" numeric(14,6);
ALTER TABLE public.erp_sku_medidas ADD COLUMN IF NOT EXISTS "m3_unit" numeric(24,9);
ALTER TABLE public.erp_sku_medidas ADD COLUMN IF NOT EXISTS "kg_m3" numeric(16,2);
ALTER TABLE public.erp_sku_medidas ADD COLUMN IF NOT EXISTS "m3_confiable" boolean DEFAULT false;
ALTER TABLE public.erp_sku_medidas ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
CREATE TABLE IF NOT EXISTS public.inv_allocations (
  "layer_id" bigint NOT NULL,
  "out_id" bigint NOT NULL,
  "qty" numeric(20,6) NOT NULL,
  "kg" numeric(20,6),
  "dias_bodega" integer
);
ALTER TABLE public.inv_allocations ADD COLUMN IF NOT EXISTS "layer_id" bigint;
ALTER TABLE public.inv_allocations ADD COLUMN IF NOT EXISTS "out_id" bigint;
ALTER TABLE public.inv_allocations ADD COLUMN IF NOT EXISTS "qty" numeric(20,6);
ALTER TABLE public.inv_allocations ADD COLUMN IF NOT EXISTS "kg" numeric(20,6);
ALTER TABLE public.inv_allocations ADD COLUMN IF NOT EXISTS "dias_bodega" integer;
CREATE TABLE IF NOT EXISTS public.inv_doc_types (
  "tipodocto" text NOT NULL,
  "clase" text NOT NULL,
  "auto" boolean DEFAULT true NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.inv_doc_types ADD COLUMN IF NOT EXISTS "tipodocto" text;
ALTER TABLE public.inv_doc_types ADD COLUMN IF NOT EXISTS "clase" text;
ALTER TABLE public.inv_doc_types ADD COLUMN IF NOT EXISTS "auto" boolean DEFAULT true;
ALTER TABLE public.inv_doc_types ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
CREATE TABLE IF NOT EXISTS public.inv_layers (
  "id" bigint DEFAULT nextval('inv_layers_id_seq'::regclass) NOT NULL,
  "bodega" text NOT NULL,
  "producto" text NOT NULL,
  "lk" text NOT NULL,
  "lseq" integer NOT NULL,
  "source" text NOT NULL,
  "mov_id" bigint,
  "clase" text,
  "fecha" date,
  "qty" numeric(20,6) NOT NULL,
  "q_start" numeric(24,6) NOT NULL,
  "q_end" numeric(24,6) NOT NULL,
  "consumed" numeric(20,6) DEFAULT 0 NOT NULL,
  "peso_unit" numeric(20,6),
  "root_fecha" date,
  "root_known" numeric(9,6) DEFAULT 0 NOT NULL,
  "root_clase" text,
  "root_bodega" text
);
ALTER TABLE public.inv_layers ADD COLUMN IF NOT EXISTS "id" bigint DEFAULT nextval('inv_layers_id_seq'::regclass);
ALTER TABLE public.inv_layers ADD COLUMN IF NOT EXISTS "bodega" text;
ALTER TABLE public.inv_layers ADD COLUMN IF NOT EXISTS "producto" text;
ALTER TABLE public.inv_layers ADD COLUMN IF NOT EXISTS "lk" text;
ALTER TABLE public.inv_layers ADD COLUMN IF NOT EXISTS "lseq" integer;
ALTER TABLE public.inv_layers ADD COLUMN IF NOT EXISTS "source" text;
ALTER TABLE public.inv_layers ADD COLUMN IF NOT EXISTS "mov_id" bigint;
ALTER TABLE public.inv_layers ADD COLUMN IF NOT EXISTS "clase" text;
ALTER TABLE public.inv_layers ADD COLUMN IF NOT EXISTS "fecha" date;
ALTER TABLE public.inv_layers ADD COLUMN IF NOT EXISTS "qty" numeric(20,6);
ALTER TABLE public.inv_layers ADD COLUMN IF NOT EXISTS "q_start" numeric(24,6);
ALTER TABLE public.inv_layers ADD COLUMN IF NOT EXISTS "q_end" numeric(24,6);
ALTER TABLE public.inv_layers ADD COLUMN IF NOT EXISTS "consumed" numeric(20,6) DEFAULT 0;
ALTER TABLE public.inv_layers ADD COLUMN IF NOT EXISTS "peso_unit" numeric(20,6);
ALTER TABLE public.inv_layers ADD COLUMN IF NOT EXISTS "root_fecha" date;
ALTER TABLE public.inv_layers ADD COLUMN IF NOT EXISTS "root_known" numeric(9,6) DEFAULT 0;
ALTER TABLE public.inv_layers ADD COLUMN IF NOT EXISTS "root_clase" text;
ALTER TABLE public.inv_layers ADD COLUMN IF NOT EXISTS "root_bodega" text;
CREATE TABLE IF NOT EXISTS public.inv_movements (
  "id" bigint DEFAULT nextval('inv_movements_id_seq'::regclass) NOT NULL,
  "upload_id" uuid NOT NULL,
  "side" text NOT NULL,
  "active" boolean DEFAULT false NOT NULL,
  "linea" integer NOT NULL,
  "tipodocto" text NOT NULL,
  "clase" text DEFAULT 'OTRO'::text NOT NULL,
  "bodega" text NOT NULL,
  "numero" text NOT NULL,
  "fecha" date NOT NULL,
  "cod_legal" text,
  "razon_social" text,
  "producto" text NOT NULL,
  "glosa" text,
  "cantidad" numeric(20,6) NOT NULL,
  "unidad" text,
  "doc_rel" text,
  "num_rel" text,
  "fecha_entrega" date,
  "contrato" text,
  "ref_tipo" text,
  "ref_correlativo" text,
  "ref_numero" text,
  "ref_fecha" date,
  "lote_raw" text,
  "lote" text,
  "ot" text,
  "comentario" text,
  "peso_unit" numeric(20,6),
  "peso_kg" numeric(20,6),
  "ccosto" text
);
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "id" bigint DEFAULT nextval('inv_movements_id_seq'::regclass);
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "upload_id" uuid;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "side" text;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "active" boolean DEFAULT false;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "linea" integer;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "tipodocto" text;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "clase" text DEFAULT 'OTRO'::text;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "bodega" text;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "numero" text;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "fecha" date;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "cod_legal" text;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "razon_social" text;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "producto" text;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "glosa" text;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "cantidad" numeric(20,6);
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "unidad" text;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "doc_rel" text;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "num_rel" text;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "fecha_entrega" date;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "contrato" text;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "ref_tipo" text;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "ref_correlativo" text;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "ref_numero" text;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "ref_fecha" date;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "lote_raw" text;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "lote" text;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "ot" text;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "comentario" text;
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "peso_unit" numeric(20,6);
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "peso_kg" numeric(20,6);
ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS "ccosto" text;
CREATE TABLE IF NOT EXISTS public.inv_read_cache (
  "k" text NOT NULL,
  "payload" jsonb NOT NULL,
  "stamp" timestamp with time zone,
  "built_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
ALTER TABLE public.inv_read_cache ADD COLUMN IF NOT EXISTS "k" text;
ALTER TABLE public.inv_read_cache ADD COLUMN IF NOT EXISTS "payload" jsonb;
ALTER TABLE public.inv_read_cache ADD COLUMN IF NOT EXISTS "stamp" timestamp with time zone;
ALTER TABLE public.inv_read_cache ADD COLUMN IF NOT EXISTS "built_at" timestamp with time zone DEFAULT clock_timestamp();
CREATE TABLE IF NOT EXISTS public.inv_state (
  "id" smallint DEFAULT 1 NOT NULL,
  "dirty" boolean DEFAULT true NOT NULL,
  "rebuilt_at" timestamp with time zone,
  "data_min" date,
  "data_max" date,
  "model_from" date,
  "snapshot_upload" uuid,
  "snapshot_cutoff" date,
  "stats" jsonb DEFAULT '{}'::jsonb NOT NULL
);
ALTER TABLE public.inv_state ADD COLUMN IF NOT EXISTS "id" smallint DEFAULT 1;
ALTER TABLE public.inv_state ADD COLUMN IF NOT EXISTS "dirty" boolean DEFAULT true;
ALTER TABLE public.inv_state ADD COLUMN IF NOT EXISTS "rebuilt_at" timestamp with time zone;
ALTER TABLE public.inv_state ADD COLUMN IF NOT EXISTS "data_min" date;
ALTER TABLE public.inv_state ADD COLUMN IF NOT EXISTS "data_max" date;
ALTER TABLE public.inv_state ADD COLUMN IF NOT EXISTS "model_from" date;
ALTER TABLE public.inv_state ADD COLUMN IF NOT EXISTS "snapshot_upload" uuid;
ALTER TABLE public.inv_state ADD COLUMN IF NOT EXISTS "snapshot_cutoff" date;
ALTER TABLE public.inv_state ADD COLUMN IF NOT EXISTS "stats" jsonb DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS public.inv_stock_cache (
  "bodega" text NOT NULL,
  "kind" text NOT NULL,
  "producto" text NOT NULL,
  "lk" text NOT NULL,
  "lote" text,
  "ot" text,
  "qty" numeric NOT NULL,
  "kg" numeric NOT NULL,
  "kg_conocido" boolean NOT NULL,
  "fecha_min" date,
  "root_min" date,
  "inferido" numeric,
  "foto" numeric,
  "capas" integer NOT NULL,
  "glosa" text,
  "unidad" text,
  "cliente" text
);
ALTER TABLE public.inv_stock_cache ADD COLUMN IF NOT EXISTS "bodega" text;
ALTER TABLE public.inv_stock_cache ADD COLUMN IF NOT EXISTS "kind" text;
ALTER TABLE public.inv_stock_cache ADD COLUMN IF NOT EXISTS "producto" text;
ALTER TABLE public.inv_stock_cache ADD COLUMN IF NOT EXISTS "lk" text;
ALTER TABLE public.inv_stock_cache ADD COLUMN IF NOT EXISTS "lote" text;
ALTER TABLE public.inv_stock_cache ADD COLUMN IF NOT EXISTS "ot" text;
ALTER TABLE public.inv_stock_cache ADD COLUMN IF NOT EXISTS "qty" numeric;
ALTER TABLE public.inv_stock_cache ADD COLUMN IF NOT EXISTS "kg" numeric;
ALTER TABLE public.inv_stock_cache ADD COLUMN IF NOT EXISTS "kg_conocido" boolean;
ALTER TABLE public.inv_stock_cache ADD COLUMN IF NOT EXISTS "fecha_min" date;
ALTER TABLE public.inv_stock_cache ADD COLUMN IF NOT EXISTS "root_min" date;
ALTER TABLE public.inv_stock_cache ADD COLUMN IF NOT EXISTS "inferido" numeric;
ALTER TABLE public.inv_stock_cache ADD COLUMN IF NOT EXISTS "foto" numeric;
ALTER TABLE public.inv_stock_cache ADD COLUMN IF NOT EXISTS "capas" integer;
ALTER TABLE public.inv_stock_cache ADD COLUMN IF NOT EXISTS "glosa" text;
ALTER TABLE public.inv_stock_cache ADD COLUMN IF NOT EXISTS "unidad" text;
ALTER TABLE public.inv_stock_cache ADD COLUMN IF NOT EXISTS "cliente" text;
CREATE TABLE IF NOT EXISTS public.inv_stock_snapshots (
  "id" bigint DEFAULT nextval('inv_stock_snapshots_id_seq'::regclass) NOT NULL,
  "upload_id" uuid NOT NULL,
  "bodega" text NOT NULL,
  "producto" text NOT NULL,
  "lote" text,
  "glosa" text,
  "unidad" text,
  "cantidad" numeric(20,6) NOT NULL,
  "peso_kg" numeric(20,6)
);
ALTER TABLE public.inv_stock_snapshots ADD COLUMN IF NOT EXISTS "id" bigint DEFAULT nextval('inv_stock_snapshots_id_seq'::regclass);
ALTER TABLE public.inv_stock_snapshots ADD COLUMN IF NOT EXISTS "upload_id" uuid;
ALTER TABLE public.inv_stock_snapshots ADD COLUMN IF NOT EXISTS "bodega" text;
ALTER TABLE public.inv_stock_snapshots ADD COLUMN IF NOT EXISTS "producto" text;
ALTER TABLE public.inv_stock_snapshots ADD COLUMN IF NOT EXISTS "lote" text;
ALTER TABLE public.inv_stock_snapshots ADD COLUMN IF NOT EXISTS "glosa" text;
ALTER TABLE public.inv_stock_snapshots ADD COLUMN IF NOT EXISTS "unidad" text;
ALTER TABLE public.inv_stock_snapshots ADD COLUMN IF NOT EXISTS "cantidad" numeric(20,6);
ALTER TABLE public.inv_stock_snapshots ADD COLUMN IF NOT EXISTS "peso_kg" numeric(20,6);
CREATE TABLE IF NOT EXISTS public.inv_transfer_links (
  "out_id" bigint NOT NULL,
  "in_id" bigint NOT NULL,
  "qty" numeric(20,6) NOT NULL
);
ALTER TABLE public.inv_transfer_links ADD COLUMN IF NOT EXISTS "out_id" bigint;
ALTER TABLE public.inv_transfer_links ADD COLUMN IF NOT EXISTS "in_id" bigint;
ALTER TABLE public.inv_transfer_links ADD COLUMN IF NOT EXISTS "qty" numeric(20,6);
CREATE TABLE IF NOT EXISTS public.inv_upload_chunks (
  "upload_id" uuid NOT NULL,
  "chunk_hash" text NOT NULL,
  "result" jsonb NOT NULL
);
ALTER TABLE public.inv_upload_chunks ADD COLUMN IF NOT EXISTS "upload_id" uuid;
ALTER TABLE public.inv_upload_chunks ADD COLUMN IF NOT EXISTS "chunk_hash" text;
ALTER TABLE public.inv_upload_chunks ADD COLUMN IF NOT EXISTS "result" jsonb;
CREATE TABLE IF NOT EXISTS public.inv_uploads (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "side" text NOT NULL,
  "file_name" text NOT NULL,
  "status" text DEFAULT 'CARGANDO'::text NOT NULL,
  "cutoff" date,
  "desde" date,
  "hasta" date,
  "rows_total" integer DEFAULT 0 NOT NULL,
  "rows_valid" integer DEFAULT 0 NOT NULL,
  "excluded" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "replaced" integer,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "applied_at" timestamp with time zone
);
ALTER TABLE public.inv_uploads ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid();
ALTER TABLE public.inv_uploads ADD COLUMN IF NOT EXISTS "side" text;
ALTER TABLE public.inv_uploads ADD COLUMN IF NOT EXISTS "file_name" text;
ALTER TABLE public.inv_uploads ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'CARGANDO'::text;
ALTER TABLE public.inv_uploads ADD COLUMN IF NOT EXISTS "cutoff" date;
ALTER TABLE public.inv_uploads ADD COLUMN IF NOT EXISTS "desde" date;
ALTER TABLE public.inv_uploads ADD COLUMN IF NOT EXISTS "hasta" date;
ALTER TABLE public.inv_uploads ADD COLUMN IF NOT EXISTS "rows_total" integer DEFAULT 0;
ALTER TABLE public.inv_uploads ADD COLUMN IF NOT EXISTS "rows_valid" integer DEFAULT 0;
ALTER TABLE public.inv_uploads ADD COLUMN IF NOT EXISTS "excluded" jsonb DEFAULT '{}'::jsonb;
ALTER TABLE public.inv_uploads ADD COLUMN IF NOT EXISTS "replaced" integer;
ALTER TABLE public.inv_uploads ADD COLUMN IF NOT EXISTS "created_by" uuid;
ALTER TABLE public.inv_uploads ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE public.inv_uploads ADD COLUMN IF NOT EXISTS "applied_at" timestamp with time zone;
CREATE TABLE IF NOT EXISTS public.inv_warehouses (
  "code" text NOT NULL,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "stage" smallint DEFAULT 70 NOT NULL,
  "auto" boolean DEFAULT true NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.inv_warehouses ADD COLUMN IF NOT EXISTS "code" text;
ALTER TABLE public.inv_warehouses ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE public.inv_warehouses ADD COLUMN IF NOT EXISTS "kind" text;
ALTER TABLE public.inv_warehouses ADD COLUMN IF NOT EXISTS "stage" smallint DEFAULT 70;
ALTER TABLE public.inv_warehouses ADD COLUMN IF NOT EXISTS "auto" boolean DEFAULT true;
ALTER TABLE public.inv_warehouses ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

-- Restricciones
DO $c$ BEGIN ALTER TABLE public.apa_areas ADD CONSTRAINT "apa_areas_pkey" PRIMARY KEY (bodega); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_areas ADD CONSTRAINT "apa_areas_area_check" CHECK ((area = ANY (ARRAY['APT'::text, 'APT_LB'::text, 'DIST'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_audit ADD CONSTRAINT "apa_audit_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_commitments ADD CONSTRAINT "apa_commitments_import_id_sheet_row_number_key" UNIQUE (import_id, sheet, row_number); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_commitments ADD CONSTRAINT "apa_commitments_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_commitments ADD CONSTRAINT "apa_commitments_status_check" CHECK ((status = ANY (ARRAY['ACEPTADO'::text, 'RECHAZADO'::text, 'REVISION'::text, 'DESCARTADO'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_conversions ADD CONSTRAINT "apa_conversions_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_conversions ADD CONSTRAINT "apa_conversions_factor_check" CHECK ((factor > (0)::numeric)); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_doc_classes ADD CONSTRAINT "apa_doc_classes_pkey" PRIMARY KEY (tipo); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_doc_classes ADD CONSTRAINT "apa_doc_classes_clase_check" CHECK ((clase = ANY (ARRAY['PRODUCCION'::text, 'COMPRA'::text, 'TRASPASO'::text, 'DESPACHO_VENTA'::text, 'CONSUMO'::text, 'SERVICIO_TERCERO'::text, 'PRESTAMO'::text, 'DEVOLUCION'::text, 'AJUSTE'::text, 'ANULACION'::text, 'SIN_CLASIFICAR'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_imports ADD CONSTRAINT "apa_imports_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_imports ADD CONSTRAINT "apa_imports_source_type_check" CHECK ((source_type = ANY (ARRAY['ENTRADAS'::text, 'SALIDAS'::text, 'MOVIMIENTOS'::text, 'SALDO_INICIAL'::text, 'COMPROMISOS'::text, 'RECEPCIONES'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_imports ADD CONSTRAINT "apa_imports_status_check" CHECK ((status = ANY (ARRAY['PREPARANDO'::text, 'ACTIVA'::text, 'REVERTIDA'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_links ADD CONSTRAINT "apa_links_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_links ADD CONSTRAINT "apa_links_from_kind_check" CHECK ((from_kind = ANY (ARRAY['LOTE'::text, 'TRASPASO'::text, 'OT'::text, 'OP'::text, 'PEDIDO'::text, 'CONTRATO'::text, 'DESPACHO'::text, 'RECEPCION'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_links ADD CONSTRAINT "apa_links_origin_check" CHECK ((origin = ANY (ARRAY['SISTEMA'::text, 'REGLA'::text, 'MANUAL'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_links ADD CONSTRAINT "apa_links_qty_check" CHECK (((qty IS NULL) OR (qty > (0)::numeric))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_links ADD CONSTRAINT "apa_links_status_check" CHECK ((status = ANY (ARRAY['VIGENTE'::text, 'ANULADO'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_links ADD CONSTRAINT "apa_links_to_kind_check" CHECK ((to_kind = ANY (ARRAY['LOTE'::text, 'TRASPASO'::text, 'OT'::text, 'OP'::text, 'PEDIDO'::text, 'CONTRATO'::text, 'DESPACHO'::text, 'RECEPCION'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_movements ADD CONSTRAINT "apa_movements_import_id_sheet_row_number_key" UNIQUE (import_id, sheet, row_number); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_movements ADD CONSTRAINT "apa_movements_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_movements ADD CONSTRAINT "apa_movements_side_check" CHECK ((side = ANY (ARRAY['E'::text, 'S'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_movements ADD CONSTRAINT "apa_movements_status_check" CHECK ((status = ANY (ARRAY['ACEPTADO'::text, 'RECHAZADO'::text, 'REVISION'::text, 'DESCARTADO'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_opening_balances ADD CONSTRAINT "apa_opening_balances_import_id_sheet_row_number_key" UNIQUE (import_id, sheet, row_number); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_opening_balances ADD CONSTRAINT "apa_opening_balances_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_opening_balances ADD CONSTRAINT "apa_opening_balances_status_check" CHECK ((status = ANY (ARRAY['ACEPTADO'::text, 'RECHAZADO'::text, 'REVISION'::text, 'DESCARTADO'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_raw_rows ADD CONSTRAINT "apa_raw_rows_pkey" PRIMARY KEY (import_id, sheet, row_number); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_receipts ADD CONSTRAINT "apa_receipts_import_id_sheet_row_number_key" UNIQUE (import_id, sheet, row_number); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_receipts ADD CONSTRAINT "apa_receipts_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_receipts ADD CONSTRAINT "apa_receipts_status_check" CHECK ((status = ANY (ARRAY['ACEPTADO'::text, 'RECHAZADO'::text, 'REVISION'::text, 'DESCARTADO'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_saved_views ADD CONSTRAINT "apa_saved_views_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_saved_views ADD CONSTRAINT "apa_saved_views_name_check" CHECK (((length(name) >= 1) AND (length(name) <= 80))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_settings ADD CONSTRAINT "apa_settings_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_settings ADD CONSTRAINT "apa_settings_id_check" CHECK ((id = 1)); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_settings ADD CONSTRAINT "apa_settings_same_day_order_check" CHECK ((same_day_order = ANY (ARRAY['ENTRADAS_PRIMERO'::text, 'SALIDAS_PRIMERO'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_aging_ranges ADD CONSTRAINT "apt_aging_ranges_pkey" PRIMARY KEY (desde); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_aging_ranges ADD CONSTRAINT "apt_aging_ranges_desde_check" CHECK ((desde >= 0)); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_allocations ADD CONSTRAINT "apt_allocations_pkey" PRIMARY KEY (layer_id, exit_id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_exit_class ADD CONSTRAINT "apt_exit_class_pkey" PRIMARY KEY (exit_id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_exit_class ADD CONSTRAINT "apt_exit_class_clase_check" CHECK ((clase = ANY (ARRAY['ASIGNADA'::text, 'EXCEDE_INGRESO'::text, 'OTRO_PRODUCTO_DEL_LOTE'::text, 'LOTE_SIN_INGRESO'::text, 'SIN_NUMREL'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_flow_alloc ADD CONSTRAINT "apt_flow_alloc_pkey" PRIMARY KEY (layer_id, exit_id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_flow_exits ADD CONSTRAINT "apt_flow_exits_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_flow_exits ADD CONSTRAINT "apt_flow_exits_tipo_check" CHECK ((tipo = ANY (ARRAY['TRASPASO'::text, 'DESPACHO'::text, 'CONSUMO'::text, 'OTRO_ALMACEN'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_flow_layers ADD CONSTRAINT "apt_flow_layers_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_flow_layers ADD CONSTRAINT "apt_flow_layers_tipo_check" CHECK ((tipo = ANY (ARRAY['PRODUCCION'::text, 'TRASPASO'::text, 'DEVOLUCION'::text, 'OTRO_ALMACEN'::text, 'INICIAL'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_flow_pieces ADD CONSTRAINT "apt_flow_pieces_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_flow_state ADD CONSTRAINT "apt_flow_state_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_flow_state ADD CONSTRAINT "apt_flow_state_id_check" CHECK ((id = 1)); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_gantt_lotes ADD CONSTRAINT "apt_gantt_lotes_pkey" PRIMARY KEY (lote); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_gantt_meta ADD CONSTRAINT "apt_gantt_meta_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_gantt_meta ADD CONSTRAINT "apt_gantt_meta_id_check" CHECK ((id = 1)); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_layers ADD CONSTRAINT "apt_layers_pkey" PRIMARY KEY (movement_id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_movements ADD CONSTRAINT "apt_movements_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_movements ADD CONSTRAINT "apt_movements_kind_check" CHECK ((kind = ANY (ARRAY['ENTRADA'::text, 'SALIDA'::text, 'TRASPASO_SAL'::text, 'TRASPASO_ENT'::text, 'CONSUMO'::text, 'DEVOLUCION'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_operational_readiness ADD CONSTRAINT "apt_operational_readiness_pkey" PRIMARY KEY (almacen, lote, producto); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_operational_readiness ADD CONSTRAINT "apt_operational_readiness_almacen_check" CHECK ((almacen = ANY (ARRAY['647'::text, '540'::text, 'ST'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_operational_readiness ADD CONSTRAINT "apt_operational_readiness_check" CHECK (((status = 'NO_EVALUADO'::text) OR ((length(TRIM(BOTH FROM COALESCE(reason, ''::text))) > 0) AND (length(TRIM(BOTH FROM COALESCE(responsible_name, ''::text))) > 0) AND (length(TRIM(BOTH FROM COALESCE(next_action, ''::text))) > 0)))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_operational_readiness ADD CONSTRAINT "apt_operational_readiness_lote_check" CHECK (((length(lote) >= 1) AND (length(lote) <= 120))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_operational_readiness ADD CONSTRAINT "apt_operational_readiness_producto_check" CHECK (((length(producto) >= 1) AND (length(producto) <= 120))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_operational_readiness ADD CONSTRAINT "apt_operational_readiness_status_check" CHECK ((status = ANY (ARRAY['NO_EVALUADO'::text, 'DISPONIBLE'::text, 'BLOQUEADO'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_operational_readiness_history ADD CONSTRAINT "apt_operational_readiness_history_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_read_cache ADD CONSTRAINT "apt_read_cache_pkey" PRIMARY KEY (fn, key_hash); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_read_cache_requests ADD CONSTRAINT "apt_read_cache_requests_pkey" PRIMARY KEY (fn, key_hash); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_settings ADD CONSTRAINT "apt_settings_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_settings ADD CONSTRAINT "apt_settings_alert_days_check" CHECK ((alert_days > 0)); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_settings ADD CONSTRAINT "apt_settings_id_check" CHECK ((id = 1)); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_settings ADD CONSTRAINT "apt_settings_tolerance_check" CHECK (((tolerance >= (0)::numeric) AND (tolerance < 0.5))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_state ADD CONSTRAINT "apt_state_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_state ADD CONSTRAINT "apt_state_id_check" CHECK ((id = 1)); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_stock_observations ADD CONSTRAINT "apt_stock_observations_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_stock_observations ADD CONSTRAINT "apt_stock_observations_almacen_check" CHECK ((almacen = ANY (ARRAY['647'::text, '540'::text, 'ST'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_stock_observations ADD CONSTRAINT "apt_stock_observations_lote_check" CHECK (((length(lote) >= 1) AND (length(lote) <= 120))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_stock_observations ADD CONSTRAINT "apt_stock_observations_notes_check" CHECK ((length(notes) <= 2000)); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_stock_observations ADD CONSTRAINT "apt_stock_observations_peso_kg_check" CHECK (((peso_kg >= (0)::numeric) AND (peso_kg < ('1000000000000'::bigint)::numeric))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_stock_observations ADD CONSTRAINT "apt_stock_observations_producto_check" CHECK (((length(producto) >= 1) AND (length(producto) <= 160))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_stock_observations ADD CONSTRAINT "apt_stock_observations_reference_check" CHECK (((length(reference) >= 1) AND (length(reference) <= 500))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_stock_observations ADD CONSTRAINT "apt_stock_observations_source_check" CHECK ((source = ANY (ARRAY['ERP'::text, 'FISICO'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_uploads ADD CONSTRAINT "apt_uploads_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_uploads ADD CONSTRAINT "apt_uploads_status_check" CHECK ((status = ANY (ARRAY['CARGANDO'::text, 'APLICADA'::text, 'DESCARTADA'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.erp_derive_days ADD CONSTRAINT "erp_derive_days_pkey" PRIMARY KEY (fecha); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.erp_derive_days ADD CONSTRAINT "erp_derive_days_base_fuente_check" CHECK ((base_fuente = ANY (ARRAY['DATA'::text, 'ERP'::text, 'VACIA'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.erp_derive_guias ADD CONSTRAINT "erp_derive_guias_pkey" PRIMARY KEY (guia_key, producto, documento); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.erp_derive_stock ADD CONSTRAINT "erp_derive_stock_pkey" PRIMARY KEY (fecha, bodega, producto, lote); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.erp_load_log ADD CONSTRAINT "erp_load_log_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.erp_load_log ADD CONSTRAINT "erp_load_log_kind_check" CHECK ((kind = ANY (ARRAY['CONTRATOS'::text, 'STOCK'::text, 'MOVIMIENTOS'::text, 'LECTURA'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.erp_load_log ADD CONSTRAINT "erp_load_log_status_check" CHECK ((status = ANY (ARRAY['EN_CURSO'::text, 'OK'::text, 'ERROR'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.erp_rule_versions ADD CONSTRAINT "erp_rule_versions_pkey" PRIMARY KEY (version); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.erp_rule_versions ADD CONSTRAINT "erp_rule_versions_estado_check" CHECK ((estado = ANY (ARRAY['VIGENTE'::text, 'REEMPLAZADA'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.erp_rule_versions ADD CONSTRAINT "erp_rule_versions_origen_check" CHECK ((origen = ANY (ARRAY['HEREDADA'::text, 'APROBADA'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.erp_sku_medidas ADD CONSTRAINT "erp_sku_medidas_pkey" PRIMARY KEY (cod_producto); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_allocations ADD CONSTRAINT "inv_allocations_pkey" PRIMARY KEY (layer_id, out_id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_doc_types ADD CONSTRAINT "inv_doc_types_pkey" PRIMARY KEY (tipodocto); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_doc_types ADD CONSTRAINT "inv_doc_types_clase_check" CHECK ((clase = ANY (ARRAY['PRODUCCION'::text, 'COMPRA'::text, 'TRASPASO'::text, 'DESPACHO'::text, 'CONSUMO'::text, 'SERVICIO_TERCERO'::text, 'PRESTAMO'::text, 'DEVOLUCION'::text, 'AJUSTE'::text, 'OTRO'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_doc_types ADD CONSTRAINT "inv_doc_types_tipodocto_check" CHECK (((length(tipodocto) >= 1) AND (length(tipodocto) <= 120))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_layers ADD CONSTRAINT "inv_layers_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_layers ADD CONSTRAINT "inv_layers_source_check" CHECK ((source = ANY (ARRAY['FOTO'::text, 'INFERIDA'::text, 'MOV'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_movements ADD CONSTRAINT "inv_movements_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_movements ADD CONSTRAINT "inv_movements_cantidad_check" CHECK ((cantidad <> (0)::numeric)); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_movements ADD CONSTRAINT "inv_movements_side_check" CHECK ((side = ANY (ARRAY['E'::text, 'S'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_read_cache ADD CONSTRAINT "inv_read_cache_pkey" PRIMARY KEY (k); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_state ADD CONSTRAINT "inv_state_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_state ADD CONSTRAINT "inv_state_id_check" CHECK ((id = 1)); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_stock_snapshots ADD CONSTRAINT "inv_stock_snapshots_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_transfer_links ADD CONSTRAINT "inv_transfer_links_pkey" PRIMARY KEY (out_id, in_id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_upload_chunks ADD CONSTRAINT "inv_upload_chunks_pkey" PRIMARY KEY (upload_id, chunk_hash); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_uploads ADD CONSTRAINT "inv_uploads_pkey" PRIMARY KEY (id); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_uploads ADD CONSTRAINT "inv_uploads_file_name_check" CHECK (((length(file_name) >= 1) AND (length(file_name) <= 300))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_uploads ADD CONSTRAINT "inv_uploads_side_check" CHECK ((side = ANY (ARRAY['E'::text, 'S'::text, 'STOCK'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_uploads ADD CONSTRAINT "inv_uploads_status_check" CHECK ((status = ANY (ARRAY['CARGANDO'::text, 'APLICADA'::text, 'DESCARTADA'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_warehouses ADD CONSTRAINT "inv_warehouses_pkey" PRIMARY KEY (code); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_warehouses ADD CONSTRAINT "inv_warehouses_code_check" CHECK (((length(code) >= 1) AND (length(code) <= 120))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_warehouses ADD CONSTRAINT "inv_warehouses_kind_check" CHECK ((kind = ANY (ARRAY['MATERIA_PRIMA'::text, 'PRODUCCION'::text, 'PRODUCTO_TERMINADO'::text, 'DESPACHO'::text, 'PERNERIA'::text, 'MRO'::text, 'MANTENIMIENTO'::text, 'HERRAMIENTAS'::text, 'ACTIVOS'::text, 'TERCERO'::text, 'OBRA'::text, 'OTRO'::text]))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_warehouses ADD CONSTRAINT "inv_warehouses_name_check" CHECK (((length(name) >= 1) AND (length(name) <= 120))); EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;

-- Claves foráneas
DO $c$ BEGIN ALTER TABLE public.apa_commitments ADD CONSTRAINT "apa_commitments_import_id_fkey" FOREIGN KEY (import_id) REFERENCES apa_imports(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_movements ADD CONSTRAINT "apa_movements_import_id_fkey" FOREIGN KEY (import_id) REFERENCES apa_imports(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_opening_balances ADD CONSTRAINT "apa_opening_balances_import_id_fkey" FOREIGN KEY (import_id) REFERENCES apa_imports(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_raw_rows ADD CONSTRAINT "apa_raw_rows_import_id_fkey" FOREIGN KEY (import_id) REFERENCES apa_imports(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apa_receipts ADD CONSTRAINT "apa_receipts_import_id_fkey" FOREIGN KEY (import_id) REFERENCES apa_imports(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.apt_movements ADD CONSTRAINT "apt_movements_upload_id_fkey" FOREIGN KEY (upload_id) REFERENCES apt_uploads(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
-- FK omitida (tabla solo del TMS): apt_stock_observations.apt_stock_observations_created_by_fkey → auth.users
DO $c$ BEGIN ALTER TABLE public.erp_derive_guias ADD CONSTRAINT "erp_derive_guias_dia_fkey" FOREIGN KEY (dia) REFERENCES erp_derive_days(fecha) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.erp_derive_stock ADD CONSTRAINT "erp_derive_stock_fecha_fkey" FOREIGN KEY (fecha) REFERENCES erp_derive_days(fecha) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_movements ADD CONSTRAINT "inv_movements_upload_id_fkey" FOREIGN KEY (upload_id) REFERENCES inv_uploads(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_stock_snapshots ADD CONSTRAINT "inv_stock_snapshots_upload_id_fkey" FOREIGN KEY (upload_id) REFERENCES inv_uploads(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;
DO $c$ BEGIN ALTER TABLE public.inv_upload_chunks ADD CONSTRAINT "inv_upload_chunks_upload_id_fkey" FOREIGN KEY (upload_id) REFERENCES inv_uploads(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;

-- Índices
CREATE INDEX IF NOT EXISTS apa_audit_entity ON public.apa_audit USING btree (entity, entity_id, at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS apa_conversions_key ON public.apa_conversions USING btree (COALESCE(producto, ''::text), from_unit, to_unit);
CREATE INDEX IF NOT EXISTS apa_imports_status ON public.apa_imports USING btree (status, source_type);
CREATE UNIQUE INDEX IF NOT EXISTS apa_imports_hash_vigente ON public.apa_imports USING btree (file_hash, source_type) WHERE (status <> 'REVERTIDA'::text);
CREATE INDEX IF NOT EXISTS apa_links_from ON public.apa_links USING btree (from_kind, from_ref);
CREATE INDEX IF NOT EXISTS apa_links_to ON public.apa_links USING btree (to_kind, to_ref);
CREATE INDEX IF NOT EXISTS apa_movements_bodega ON public.apa_movements USING btree (bodega);
CREATE INDEX IF NOT EXISTS apa_movements_fingerprint ON public.apa_movements USING btree (fingerprint, dup) WHERE (fingerprint IS NOT NULL);
CREATE INDEX IF NOT EXISTS apa_saved_views_owner ON public.apa_saved_views USING btree (owner);
CREATE INDEX IF NOT EXISTS apt_allocations_temporal_quality_idx ON public.apt_allocations USING btree (fecha_salida, layer_id) WHERE (fecha_salida < fecha_ingreso);
CREATE INDEX IF NOT EXISTS apt_allocations_exit_idx ON public.apt_allocations USING btree (exit_id);
CREATE INDEX IF NOT EXISTS apt_exit_class_lote_idx ON public.apt_exit_class USING btree (lote);
CREATE INDEX IF NOT EXISTS apt_exit_class_producto_idx ON public.apt_exit_class USING btree (producto);
CREATE INDEX IF NOT EXISTS apt_flow_alloc_layer_exit_gantt_idx ON public.apt_flow_alloc USING btree (layer_id, exit_id) INCLUDE (kg);
CREATE INDEX IF NOT EXISTS apt_flow_alloc_exit_idx ON public.apt_flow_alloc USING btree (exit_id);
CREATE INDEX IF NOT EXISTS apt_flow_exits_lote_idx ON public.apt_flow_exits USING btree (lote);
CREATE INDEX IF NOT EXISTS apt_flow_exits_ot_raiz_idx ON public.apt_flow_exits USING btree (apt_ot_raiz(lote));
CREATE INDEX IF NOT EXISTS apt_flow_exits_gantt_fecha_idx ON public.apt_flow_exits USING btree (fecha, lote);
CREATE INDEX IF NOT EXISTS apt_flow_exits_doc_idx ON public.apt_flow_exits USING btree (documento);
CREATE INDEX IF NOT EXISTS apt_flow_layers_exit_idx ON public.apt_flow_layers USING btree (exit_id);
CREATE INDEX IF NOT EXISTS apt_flow_layers_gantt_fecha_idx ON public.apt_flow_layers USING btree (fecha, lote);
CREATE INDEX IF NOT EXISTS apt_flow_layers_key_idx ON public.apt_flow_layers USING btree (almacen, lote, producto);
CREATE INDEX IF NOT EXISTS apt_flow_layers_ot_raiz_idx ON public.apt_flow_layers USING btree (apt_ot_raiz(lote));
CREATE INDEX IF NOT EXISTS apt_flow_layers_lote_idx ON public.apt_flow_layers USING btree (lote);
CREATE INDEX IF NOT EXISTS apt_flow_pieces_lote_idx ON public.apt_flow_pieces USING btree (lote);
CREATE INDEX IF NOT EXISTS apt_flow_pieces_exit_idx ON public.apt_flow_pieces USING btree (exit_id);
CREATE INDEX IF NOT EXISTS apt_flow_pieces_fecha_idx ON public.apt_flow_pieces USING btree (fecha_salida);
CREATE INDEX IF NOT EXISTS apt_gantt_daily_lote_idx ON public.apt_gantt_daily USING btree (lote);
CREATE INDEX IF NOT EXISTS apt_gantt_lotes_ot_idx ON public.apt_gantt_lotes USING btree (ot);
CREATE INDEX IF NOT EXISTS apt_layers_cliente_idx ON public.apt_layers USING btree (cliente);
CREATE INDEX IF NOT EXISTS apt_layers_lote_idx ON public.apt_layers USING btree (lote);
CREATE INDEX IF NOT EXISTS apt_layers_producto_idx ON public.apt_layers USING btree (producto);
CREATE INDEX IF NOT EXISTS apt_movements_key_idx ON public.apt_movements USING btree (lote, producto) WHERE active;
CREATE INDEX IF NOT EXISTS apt_movements_salida_documento_idx ON public.apt_movements USING btree (documento) WHERE (active AND valid AND (kind = 'SALIDA'::text));
CREATE UNIQUE INDEX IF NOT EXISTS apt_movements_row_key ON public.apt_movements USING btree (upload_id, kind, row_no);
CREATE INDEX IF NOT EXISTS apt_movements_active_idx ON public.apt_movements USING btree (kind, fecha) WHERE active;
CREATE INDEX IF NOT EXISTS apt_movements_guia_num_idx ON public.apt_movements USING btree (split_part(apt_guia_key(documento), '-'::text, 2)) WHERE (active AND valid AND (kind = 'SALIDA'::text));
CREATE INDEX IF NOT EXISTS apt_movements_kind_alm_idx ON public.apt_movements USING btree (kind, almacen) WHERE (active AND valid);
CREATE INDEX IF NOT EXISTS apt_movements_guia_key_idx ON public.apt_movements USING btree (apt_guia_key(documento)) WHERE (active AND valid AND (kind = 'SALIDA'::text));
CREATE INDEX IF NOT EXISTS apt_movements_ot_raiz_idx ON public.apt_movements USING btree (apt_ot_raiz(lote)) WHERE (active AND valid);
CREATE INDEX IF NOT EXISTS apt_stock_observations_created_by_idx ON public.apt_stock_observations USING btree (created_by);
CREATE INDEX IF NOT EXISTS apt_stock_observations_key ON public.apt_stock_observations USING btree (cutoff, almacen, lote, producto, source, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS erp_derive_guias_dia_idx ON public.erp_derive_guias USING btree (dia);
CREATE INDEX IF NOT EXISTS erp_load_log_started_idx ON public.erp_load_log USING btree (started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS erp_rule_versions_one_current ON public.erp_rule_versions USING btree (estado) WHERE (estado = 'VIGENTE'::text);
CREATE INDEX IF NOT EXISTS erp_sku_medidas_familia_idx ON public.erp_sku_medidas USING btree (familia) WHERE m3_confiable;
CREATE INDEX IF NOT EXISTS inv_allocations_out_idx ON public.inv_allocations USING btree (out_id);
CREATE INDEX IF NOT EXISTS inv_layers_end_idx ON public.inv_layers USING btree (bodega, producto, lk, q_end);
CREATE INDEX IF NOT EXISTS inv_layers_key_idx ON public.inv_layers USING btree (bodega, producto, lk, lseq);
CREATE INDEX IF NOT EXISTS inv_layers_mov_idx ON public.inv_layers USING btree (mov_id);
CREATE INDEX IF NOT EXISTS inv_layers_start_idx ON public.inv_layers USING btree (bodega, producto, lk, q_start);
CREATE INDEX IF NOT EXISTS inv_movements_key_idx ON public.inv_movements USING btree (bodega, producto, lote) WHERE active;
CREATE INDEX IF NOT EXISTS inv_movements_lote_idx ON public.inv_movements USING btree (lote) WHERE active;
CREATE INDEX IF NOT EXISTS inv_movements_numero_idx ON public.inv_movements USING btree (numero) WHERE active;
CREATE INDEX IF NOT EXISTS inv_movements_num_rel_idx ON public.inv_movements USING btree (num_rel) WHERE active;
CREATE INDEX IF NOT EXISTS inv_movements_ot_idx ON public.inv_movements USING btree (ot) WHERE active;
CREATE INDEX IF NOT EXISTS inv_movements_producto_idx ON public.inv_movements USING btree (producto) WHERE active;
CREATE INDEX IF NOT EXISTS inv_movements_side_fecha_idx ON public.inv_movements USING btree (side, fecha) WHERE active;
CREATE INDEX IF NOT EXISTS inv_movements_upload_idx ON public.inv_movements USING btree (upload_id);
CREATE INDEX IF NOT EXISTS inv_movements_ref_numero_idx ON public.inv_movements USING btree (ref_numero) WHERE active;
CREATE INDEX IF NOT EXISTS inv_stock_cache_bodega_idx ON public.inv_stock_cache USING btree (bodega);
CREATE INDEX IF NOT EXISTS inv_stock_snapshots_upload_idx ON public.inv_stock_snapshots USING btree (upload_id);
CREATE INDEX IF NOT EXISTS inv_transfer_links_in_idx ON public.inv_transfer_links USING btree (in_id);
CREATE INDEX IF NOT EXISTS inv_uploads_side_status_idx ON public.inv_uploads USING btree (side, status, applied_at DESC);

-- Funciones
CREATE OR REPLACE FUNCTION public.apa_area_set(p_bodega text, p_area text, p_confirmed boolean, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.apa_area_set(p_bodega text, p_area text, p_confirmed boolean, p_note text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_area_set(p_bodega text, p_area text, p_confirmed boolean, p_note text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_audit_list(p_entity text DEFAULT NULL::text, p_entity_id text DEFAULT NULL::text, p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.apa_can_view() THEN RAISE EXCEPTION 'Sin permiso (apt)'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'entity', a.entity, 'entity_id', a.entity_id, 'action', a.action, 'before', a.before, 'after', a.after,
    'note', a.note, 'at', a.at, 'by', (SELECT COALESCE(to_jsonb(p)->>'full_name', to_jsonb(p)->>'email') FROM public.profiles p WHERE p.id = a.by_user)) ORDER BY a.at DESC)
    FROM (SELECT * FROM public.apa_audit WHERE (p_entity IS NULL OR entity = p_entity) AND (p_entity_id IS NULL OR entity_id = p_entity_id)
          ORDER BY at DESC LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000)) a), '[]'::jsonb);
END $function$;
REVOKE ALL ON FUNCTION public.apa_audit_list(p_entity text, p_entity_id text, p_limit integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_audit_list(p_entity text, p_entity_id text, p_limit integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_can_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
    WHERE p.id = auth.uid() AND p.is_active
      AND (r.name = 'Administrador' OR COALESCE(r.permissions, '[]'::jsonb) ?| ARRAY['apt-admin', 'apt-admin:write']));
$function$;
REVOKE ALL ON FUNCTION public.apa_can_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_can_admin() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_can_operate()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.apt_can_load();
$function$;
REVOKE ALL ON FUNCTION public.apa_can_operate() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_can_operate() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_can_view()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.apt_can_view();
$function$;
REVOKE ALL ON FUNCTION public.apa_can_view() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_can_view() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_class_set(p_tipo text, p_clase text, p_confirmed boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.apa_class_set(p_tipo text, p_clase text, p_confirmed boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_class_set(p_tipo text, p_clase text, p_confirmed boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_conversion_delete(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_before jsonb;
BEGIN
  IF NOT public.apa_can_admin() THEN RAISE EXCEPTION 'Solo un administrador elimina equivalencias (apt-admin)'; END IF;
  DELETE FROM public.apa_conversions c WHERE id = p_id RETURNING to_jsonb(c) INTO v_before;
  PERFORM public.apa_log('conversion', p_id::text, 'ELIMINAR', v_before, NULL, NULL);
  RETURN jsonb_build_object('success', v_before IS NOT NULL);
END $function$;
REVOKE ALL ON FUNCTION public.apa_conversion_delete(p_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_conversion_delete(p_id uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_conversion_save(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.apa_conversion_save(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_conversion_save(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_dataset_page(p_after bigint, p_limit integer DEFAULT 5000, p_scope text DEFAULT 'AREAS'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.apa_dataset_page(p_after bigint, p_limit integer, p_scope text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_dataset_page(p_after bigint, p_limit integer, p_scope text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_family(p_source text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN p_source IN ('ENTRADAS', 'SALIDAS', 'MOVIMIENTOS') THEN 'MOVIMIENTOS' ELSE p_source END;
$function$;
REVOKE ALL ON FUNCTION public.apa_family(p_source text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_family(p_source text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_import_begin(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.apa_import_begin(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_import_begin(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_import_counts(p_import uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.apa_import_counts(p_import uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apa_import_counts(p_import uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.apa_import_finish(p_import uuid, p_expected integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.apa_import_finish(p_import uuid, p_expected integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_import_finish(p_import uuid, p_expected integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_import_revert(p_import uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.apa_import_revert(p_import uuid, p_reason text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_import_revert(p_import uuid, p_reason text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_import_rows(p_import uuid, p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.apa_import_rows(p_import uuid, p_rows jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_import_rows(p_import uuid, p_rows jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_imports_list()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.apa_can_view() THEN RAISE EXCEPTION 'Sin permiso (apt)'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', i.id, 'source_type', i.source_type, 'file_name', i.file_name, 'file_hash', i.file_hash,
    'file_size', i.file_size, 'sheets', i.sheets, 'period_from', i.period_from, 'period_to', i.period_to, 'cutoff', i.cutoff, 'rows_total', i.rows_total,
    'rows_accepted', i.rows_accepted, 'rows_rejected', i.rows_rejected, 'rows_review', i.rows_review, 'rows_discarded', i.rows_discarded, 'status', i.status,
    'warnings', i.warnings, 'created_at', i.created_at, 'created_by', (SELECT COALESCE(to_jsonb(p)->>'full_name', to_jsonb(p)->>'email') FROM public.profiles p WHERE p.id = i.created_by),
    'reverted_at', i.reverted_at, 'revert_reason', i.revert_reason,
    'reverted_by', (SELECT COALESCE(to_jsonb(p)->>'full_name', to_jsonb(p)->>'email') FROM public.profiles p WHERE p.id = i.reverted_by)) ORDER BY i.created_at DESC)
    FROM public.apa_imports i WHERE i.status <> 'PREPARANDO'), '[]'::jsonb);
END $function$;
REVOKE ALL ON FUNCTION public.apa_imports_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_imports_list() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_link_annul(p_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_before jsonb;
BEGIN
  IF NOT public.apa_can_operate() THEN RAISE EXCEPTION 'Sin permiso para anular equivalencias (apt-carga)'; END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 5 THEN RAISE EXCEPTION 'Indique el motivo'; END IF;
  SELECT to_jsonb(l) INTO v_before FROM public.apa_links l WHERE id = p_id AND status = 'VIGENTE';
  IF v_before IS NULL THEN RAISE EXCEPTION 'El vínculo no existe o ya está anulado'; END IF;
  UPDATE public.apa_links SET status = 'ANULADO', updated_by = auth.uid(), updated_at = now() WHERE id = p_id;
  PERFORM public.apa_log('vinculo', p_id::text, 'ANULAR', v_before, jsonb_build_object('status', 'ANULADO'), btrim(p_reason));
  RETURN jsonb_build_object('success', true);
END $function$;
REVOKE ALL ON FUNCTION public.apa_link_annul(p_id uuid, p_reason text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_link_annul(p_id uuid, p_reason text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_link_save(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.apa_link_save(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_link_save(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_log(p_entity text, p_id text, p_action text, p_before jsonb, p_after jsonb, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  INSERT INTO public.apa_audit (entity, entity_id, action, before, after, note, by_user) VALUES (p_entity, p_id, p_action, p_before, p_after, p_note, auth.uid());
$function$;
REVOKE ALL ON FUNCTION public.apa_log(p_entity text, p_id text, p_action text, p_before jsonb, p_after jsonb, p_note text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apa_log(p_entity text, p_id text, p_action text, p_before jsonb, p_after jsonb, p_note text) TO service_role;

CREATE OR REPLACE FUNCTION public.apa_meta()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.apa_meta() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_meta() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_raw_row(p_movement bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r jsonb;
BEGIN
  IF NOT public.apa_can_view() THEN RAISE EXCEPTION 'Sin permiso (apt)'; END IF;
  SELECT jsonb_build_object('movement', to_jsonb(m) - 'reviewed_by', 'raw', w.data, 'file_name', i.file_name, 'source_type', i.source_type,
    'import_status', i.status, 'imported_at', i.created_at)
  INTO r FROM public.apa_movements m JOIN public.apa_imports i ON i.id = m.import_id
  LEFT JOIN public.apa_raw_rows w ON w.import_id = m.import_id AND w.sheet = m.sheet AND w.row_number = m.row_number
  WHERE m.id = p_movement;
  RETURN r;
END $function$;
REVOKE ALL ON FUNCTION public.apa_raw_row(p_movement bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_raw_row(p_movement bigint) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_review_resolve(p_import uuid, p_ids bigint[], p_decision text, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.apa_review_resolve(p_import uuid, p_ids bigint[], p_decision text, p_note text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_review_resolve(p_import uuid, p_ids bigint[], p_decision text, p_note text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_settings_set(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.apa_settings_set(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_settings_set(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_trace_rows(p_q text, p_limit integer DEFAULT 3000)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.apa_trace_rows(p_q text, p_limit integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_trace_rows(p_q text, p_limit integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_view_delete(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.apa_can_view() THEN RAISE EXCEPTION 'Sin permiso (apt)'; END IF;
  DELETE FROM public.apa_saved_views WHERE id = p_id AND (owner = auth.uid() OR public.apa_can_admin());
  RETURN jsonb_build_object('success', FOUND);
END $function$;
REVOKE ALL ON FUNCTION public.apa_view_delete(p_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_view_delete(p_id uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_view_save(p_name text, p_state jsonb, p_shared boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_id uuid;
BEGIN
  IF NOT public.apa_can_view() THEN RAISE EXCEPTION 'Sin permiso (apt)'; END IF;
  IF length(btrim(COALESCE(p_name, ''))) = 0 THEN RAISE EXCEPTION 'Indique un nombre'; END IF;
  IF pg_column_size(p_state) > 20000 THEN RAISE EXCEPTION 'La vista es demasiado grande'; END IF;
  INSERT INTO public.apa_saved_views (owner, name, state, shared) VALUES (auth.uid(), left(btrim(p_name), 80), p_state, COALESCE(p_shared, false)) RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', true, 'id', v_id);
END $function$;
REVOKE ALL ON FUNCTION public.apa_view_save(p_name text, p_state jsonb, p_shared boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_view_save(p_name text, p_state jsonb, p_shared boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apa_views_list()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.apa_can_view() THEN RAISE EXCEPTION 'Sin permiso (apt)'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name, 'state', state, 'shared', shared, 'mine', owner = auth.uid(), 'created_at', created_at) ORDER BY name)
    FROM public.apa_saved_views WHERE owner = auth.uid() OR shared), '[]'::jsonb);
END $function$;
REVOKE ALL ON FUNCTION public.apa_views_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apa_views_list() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_almacen(p_bodega text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN upper(btrim(p_bodega)) ~ '^647-04\s' THEN '647'
              WHEN upper(btrim(p_bodega)) ~ '^540-04' THEN '540'
              WHEN upper(btrim(p_bodega)) ~ '^ST-VENTAS' THEN 'ST' END;
$function$;
REVOKE ALL ON FUNCTION public.apt_almacen(p_bodega text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_almacen(p_bodega text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_arr(p jsonb, k text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN jsonb_typeof(p -> k) = 'array' AND jsonb_array_length(p -> k) > 0
              THEN ARRAY(SELECT jsonb_array_elements_text(p -> k)) END;
$function$;
REVOKE ALL ON FUNCTION public.apt_arr(p jsonb, k text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_arr(p jsonb, k text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_can_view()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
    WHERE p.id = auth.uid() AND p.is_active
      AND (r.name IN ('Administrador', 'Jefe de Distribución')
           OR COALESCE(r.permissions, '[]'::jsonb) ?| ARRAY['apt', 'apt:read', 'apt:write', 'apt-carga', 'apt-carga:write']));
$function$;
REVOKE ALL ON FUNCTION public.apt_can_view() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_can_view() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_coverage(p_preview jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  k text; v_kinds jsonb := '{}'::jsonb; v_alerts jsonb := '[]'::jsonb; v_max jsonb := '{}'::jsonb;
  v_ranges jsonb; v_gaps jsonb; v_idle jsonb; v_min date; v_mx date; v_pd date; v_ph date; v_rep bigint; v_prev jsonb;
  g jsonb; v_list text[]; v_ts date; v_te date; v_es date;
  c_label CONSTANT jsonb := '{"ENTRADA": "ENTRADA", "SALIDA": "SALIDA", "TRASPASO_SAL": "TRASPASOS (salidas)",
    "TRASPASO_ENT": "TRASPASOS (entradas)", "CONSUMO": "CONSUMOS", "DEVOLUCION": "DEVOLUCIONES"}';
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;

  SELECT array_agg(x ORDER BY o) INTO v_list FROM (VALUES ('ENTRADA', 1), ('SALIDA', 2), ('TRASPASO_SAL', 3), ('TRASPASO_ENT', 4),
    ('CONSUMO', 5), ('DEVOLUCION', 6)) t(x, o)
  WHERE x IN ('ENTRADA', 'SALIDA') OR p_preview ? x
     OR EXISTS (SELECT 1 FROM public.apt_uploads u WHERE u.status = 'APLICADA' AND u.summary -> lower(x) ->> 'desde' IS NOT NULL);

  FOREACH k IN ARRAY v_list LOOP
    v_pd := public.apt_date(p_preview -> k -> 'desde');
    v_ph := public.apt_date(p_preview -> k -> 'hasta');

    WITH r AS (
      SELECT (u.summary -> lower(k) ->> 'desde')::date AS desde, (u.summary -> lower(k) ->> 'hasta')::date AS hasta
      FROM public.apt_uploads u
      WHERE u.status = 'APLICADA' AND u.summary -> lower(k) ->> 'desde' IS NOT NULL
      UNION ALL SELECT v_pd, v_ph WHERE v_pd IS NOT NULL AND v_ph IS NOT NULL),
    o AS (SELECT desde, hasta, max(hasta) OVER (ORDER BY desde, hasta ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max FROM r),
    g AS (SELECT desde, hasta, sum(CASE WHEN prev_max IS NULL OR desde > prev_max + 1 THEN 1 ELSE 0 END) OVER (ORDER BY desde, hasta) AS grp FROM o),
    m AS (SELECT min(desde) AS desde, max(hasta) AS hasta FROM g GROUP BY grp),
    h AS (SELECT lag(hasta) OVER (ORDER BY desde) + 1 AS desde, desde - 1 AS hasta FROM m)
    SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('desde', desde, 'hasta', hasta) ORDER BY desde) FROM m), '[]'),
           COALESCE((SELECT jsonb_agg(jsonb_build_object('desde', desde, 'hasta', hasta, 'dias', hasta - desde + 1) ORDER BY desde)
                     FROM h WHERE desde IS NOT NULL AND hasta >= desde), '[]'),
           (SELECT min(desde) FROM m), (SELECT max(hasta) FROM m)
      INTO v_ranges, v_gaps, v_min, v_mx;

    -- Días seguidos sin movimientos (solo hojas de movimiento diario; consumos y devoluciones son esporádicos)
    v_idle := '[]'::jsonb;
    IF k IN ('ENTRADA', 'SALIDA', 'TRASPASO_SAL', 'TRASPASO_ENT') THEN
      WITH d AS (SELECT fecha, lead(fecha) OVER (ORDER BY fecha) AS nx
                 FROM (SELECT DISTINCT fecha FROM public.apt_movements WHERE active AND valid AND kind = k) z)
      SELECT COALESCE(jsonb_agg(jsonb_build_object('desde', fecha + 1, 'hasta', nx - 1, 'dias', nx - fecha - 1) ORDER BY fecha), '[]')
        INTO v_idle FROM d WHERE nx - fecha - 1 >= 4;
    END IF;

    v_prev := NULL;
    IF v_pd IS NOT NULL THEN
      SELECT count(*) INTO v_rep FROM public.apt_movements WHERE active AND valid AND kind = k AND fecha BETWEEN v_pd AND v_ph;
      v_prev := jsonb_build_object('desde', v_pd, 'hasta', v_ph, 'filas_a_reemplazar', v_rep,
        'hueco_antes', (SELECT jsonb_build_object('desde', mx + 1, 'hasta', v_pd - 1, 'dias', v_pd - mx - 1)
                        FROM (SELECT max((u.summary -> lower(k) ->> 'hasta')::date) AS mx FROM public.apt_uploads u
                              WHERE u.status = 'APLICADA' AND (u.summary -> lower(k) ->> 'hasta')::date < v_pd) z
                        WHERE mx IS NOT NULL AND v_pd > mx + 1));
    END IF;

    v_kinds := v_kinds || jsonb_build_object(k, jsonb_build_object('etiqueta', c_label ->> k, 'rangos', v_ranges, 'huecos', v_gaps,
      'desde', v_min, 'hasta', v_mx, 'dias_sin_movimiento', v_idle, 'preview', v_prev));
    IF v_mx IS NOT NULL THEN v_max := v_max || jsonb_build_object(k, v_mx); END IF;

    FOR g IN SELECT * FROM jsonb_array_elements(v_gaps) LOOP
      CONTINUE WHEN v_prev IS NOT NULL AND g ->> 'desde' = v_prev #>> '{hueco_antes,desde}';
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('nivel', 'error', 'hoja', k, 'mensaje', format(
        '%s: faltan cargar %s día(s), del %s al %s. Suba el reporte de esas fechas para no perder movimientos.',
        c_label ->> k, g ->> 'dias', to_char((g ->> 'desde')::date, 'DD/MM/YYYY'), to_char((g ->> 'hasta')::date, 'DD/MM/YYYY'))));
    END LOOP;
    IF v_prev IS NOT NULL AND v_prev -> 'hueco_antes' <> 'null'::jsonb THEN
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('nivel', 'error', 'hoja', k, 'mensaje', format(
        '%s: la carga empieza el %s pero lo cargado termina el %s; quedarían sin cargar %s día(s).',
        c_label ->> k, to_char(v_pd, 'DD/MM/YYYY'), to_char((v_prev #>> '{hueco_antes,desde}')::date - 1, 'DD/MM/YYYY'), v_prev #>> '{hueco_antes,dias}')));
    END IF;
    FOR g IN SELECT * FROM jsonb_array_elements(v_idle) LOOP
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('nivel', 'info', 'hoja', k, 'mensaje', format(
        '%s: %s días seguidos sin movimientos, del %s al %s. Confirme si fueron feriados o si el reporte vino incompleto.',
        c_label ->> k, g ->> 'dias', to_char((g ->> 'desde')::date, 'DD/MM/YYYY'), to_char((g ->> 'hasta')::date, 'DD/MM/YYYY'))));
    END LOOP;
  END LOOP;

  IF v_max ? 'ENTRADA' AND v_max ? 'SALIDA' AND v_max ->> 'ENTRADA' <> v_max ->> 'SALIDA' THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('nivel', 'aviso', 'hoja', NULL, 'mensaje', format(
      'ENTRADA llega al %s y SALIDA al %s: cargue la hoja atrasada para que el saldo de esos días sea correcto.',
      to_char((v_max ->> 'ENTRADA')::date, 'DD/MM/YYYY'), to_char((v_max ->> 'SALIDA')::date, 'DD/MM/YYYY'))));
  END IF;
  v_ts := (v_max ->> 'TRASPASO_SAL')::date; v_te := (v_max ->> 'TRASPASO_ENT')::date;
  IF (v_ts IS NULL) <> (v_te IS NULL) OR v_ts <> v_te THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('nivel', 'aviso', 'hoja', NULL, 'mensaje', format(
      'Traspasos: las salidas llegan al %s y las entradas al %s. Cargue ambos lados del mismo periodo: un traspaso sin su otro lado se lee como salida a otro almacén o ingreso desde otro almacén.',
      COALESCE(to_char(v_ts, 'DD/MM/YYYY'), '(sin cargar)'), COALESCE(to_char(v_te, 'DD/MM/YYYY'), '(sin cargar)'))));
  END IF;
  v_es := LEAST((v_max ->> 'ENTRADA')::date, (v_max ->> 'SALIDA')::date);
  IF LEAST(v_ts, v_te) IS NOT NULL AND v_es IS NOT NULL AND LEAST(v_ts, v_te) < v_es THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('nivel', 'aviso', 'hoja', NULL, 'mensaje', format(
      'Los traspasos llegan al %s y ENTRADA/SALIDA al %s: el flujo multi-almacén de esos días queda incompleto (las guías aparecerán sin traspaso a ST VENTAS).',
      to_char(LEAST(v_ts, v_te), 'DD/MM/YYYY'), to_char(v_es, 'DD/MM/YYYY'))));
  END IF;

  RETURN jsonb_build_object('success', true, 'hojas', v_kinds, 'alertas', v_alerts,
    'secuencia_ok', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_alerts) a WHERE a ->> 'nivel' IN ('error', 'aviso')));
END $function$;
REVOKE ALL ON FUNCTION public.apt_coverage(p_preview jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_coverage(p_preview jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_dashboard(p jsonb DEFAULT '{}'::jsonb, p_grain text DEFAULT 'semana'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  RETURN public.apt_read_cached('apt_dashboard', public.apt_read_cache_key('apt_dashboard', p, p_grain));
END $function$;
REVOKE ALL ON FUNCTION public.apt_dashboard(p jsonb, p_grain text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_dashboard(p jsonb, p_grain text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_dashboard_live(p jsonb DEFAULT '{}'::jsonb, p_grain text DEFAULT 'semana'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_cut date; v_alert integer; v_k jsonb; v_lotes jsonb; v_prod jsonb; v_aging jsonb; v_estados jsonb; v_fam jsonb;
        v_pareto jsonb; v_trend jsonb; v_q jsonb := COALESCE(p, '{}'::jsonb);
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  SELECT cutoff INTO v_cut FROM public.apt_state WHERE id = 1;
  SELECT alert_days INTO v_alert FROM public.apt_settings WHERE id = 1;

  WITH f AS (SELECT * FROM public.apt_filtered(v_q)), o AS (SELECT * FROM f WHERE kg_saldo > 0.0005),
  lo AS (SELECT * FROM public.apt_group(v_q, 'lote')),
  pr AS (SELECT * FROM public.apt_group(v_q, 'producto'))
  SELECT jsonb_build_object(
    'tn_ingresadas', round(COALESCE((SELECT sum(kg_in) FROM f), 0) / 1000, 3),
    'tn_despachadas', round(COALESCE((SELECT sum(kg_out) FROM f), 0) / 1000, 3),
    'tn_saldo', round(COALESCE((SELECT sum(kg_saldo) FROM o), 0) / 1000, 3),
    'kg_saldo', round(COALESCE((SELECT sum(kg_saldo) FROM o), 0), 1),
    'pct_despachado', round(100 * (SELECT sum(kg_out) FROM f) / NULLIF((SELECT sum(kg_in) FROM f), 0), 1),
    'lotes_total', (SELECT count(DISTINCT lote) FROM f),
    'lotes_activos', (SELECT count(DISTINCT lote) FROM o),
    'ops_activas', (SELECT count(DISTINCT numrel_op) FROM o),
    'productos_apt', (SELECT count(DISTINCT producto) FROM o),
    'ipt_apt', (SELECT count(DISTINCT ipt) FROM o),
    'capas_abiertas', (SELECT count(*) FROM o),
    'dias_prom', (SELECT round(avg(dias_saldo), 1) FROM o),
    'dias_mediana', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY dias_saldo) FROM o),
    'dias_max', (SELECT max(dias_saldo) FROM o),
    'aging_pond', (SELECT round(sum(kg_saldo * dias_saldo) / NULLIF(sum(kg_saldo), 0), 1) FROM o),
    'tn_gt7', round(COALESCE((SELECT sum(kg_saldo) FROM o WHERE dias_saldo > 7), 0) / 1000, 3),
    'tn_gt15', round(COALESCE((SELECT sum(kg_saldo) FROM o WHERE dias_saldo > 15), 0) / 1000, 3),
    'tn_gt30', round(COALESCE((SELECT sum(kg_saldo) FROM o WHERE dias_saldo > 30), 0) / 1000, 3),
    'tn_gt_alerta', round(COALESCE((SELECT sum(kg_saldo) FROM o WHERE dias_saldo > v_alert), 0) / 1000, 3),
    'pct_gt7', round(100 * (SELECT sum(kg_saldo) FROM o WHERE dias_saldo > 7) / NULLIF((SELECT sum(kg_saldo) FROM o), 0), 1),
    'pct_gt15', round(100 * (SELECT sum(kg_saldo) FROM o WHERE dias_saldo > 15) / NULLIF((SELECT sum(kg_saldo) FROM o), 0), 1),
    'pct_gt30', round(100 * (SELECT sum(kg_saldo) FROM o WHERE dias_saldo > 30) / NULLIF((SELECT sum(kg_saldo) FROM o), 0), 1),
    'lotes_criticos', (SELECT count(*) FROM lo WHERE kg_saldo > 0.0005 AND dias > v_alert),
    'lotes_sin_salida', (SELECT count(*) FROM lo WHERE kg_saldo > 0.0005 AND kg_out = 0),
    'lotes_parciales', (SELECT count(*) FROM lo WHERE estado = 'Salida parcial'),
    'tn_dias', round(COALESCE((SELECT sum(tn_dias) FROM o), 0), 1),
    'fecha_mas_antigua', (SELECT min(fecha_ingreso) FROM o),
    'dias_despacho_pond', (SELECT round(sum(out_kg_days) / NULLIF(sum(kg_out_fechado), 0), 1) FROM f),
    'capas_problema', (SELECT count(*) FROM f WHERE problema_info),
    'tn_posible_cruce', round(COALESCE((SELECT sum(kg_saldo) FROM o WHERE posible_cruce), 0) / 1000, 3),
    'tn_fe_vencida', round(COALESCE((SELECT sum(kg_saldo) FROM o WHERE fecha_entrega < v_cut), 0) / 1000, 3),
    'dias_fe_vencida_pond', (SELECT round(sum(kg_saldo * (v_cut - fecha_entrega)) / NULLIF(sum(kg_saldo), 0), 1) FROM o WHERE fecha_entrega < v_cut),
    'despacho_diario_30d', (SELECT round(COALESCE(sum(a.kg), 0) / 1000 / 30, 3) FROM public.apt_allocations a JOIN f ON f.movement_id = a.layer_id
                            WHERE a.fecha_salida > v_cut - 30),
    'cobertura_dias', (SELECT round((SELECT sum(kg_saldo) FROM o) / NULLIF(sum(a.kg) / 30, 0), 1) FROM public.apt_allocations a
                       JOIN f ON f.movement_id = a.layer_id WHERE a.fecha_salida > v_cut - 30),
    'rotacion_30d', (SELECT round(sum(a.kg) / NULLIF((SELECT sum(kg_saldo) FROM o), 0), 2) FROM public.apt_allocations a
                     JOIN f ON f.movement_id = a.layer_id WHERE a.fecha_salida > v_cut - 30),
    'lote_mayor_tn', (SELECT jsonb_build_object('lote', clave, 'tn', round(kg_saldo / 1000, 3)) FROM lo WHERE kg_saldo > 0.0005 ORDER BY kg_saldo DESC LIMIT 1),
    'lote_mayor_txd', (SELECT jsonb_build_object('lote', clave, 'tn_dias', tn_dias) FROM lo WHERE tn_dias > 0 ORDER BY tn_dias DESC LIMIT 1),
    'lote_mas_antiguo', (SELECT jsonb_build_object('lote', clave, 'dias', dias, 'tn', round(kg_saldo / 1000, 3)) FROM lo WHERE kg_saldo > 0.0005 ORDER BY dias DESC, kg_saldo DESC LIMIT 1),
    'producto_mayor_tn', (SELECT jsonb_build_object('producto', clave, 'glosa', etiqueta, 'tn', round(kg_saldo / 1000, 3)) FROM pr WHERE kg_saldo > 0.0005 ORDER BY kg_saldo DESC LIMIT 1),
    'producto_mas_antiguo', (SELECT jsonb_build_object('producto', clave, 'glosa', etiqueta, 'dias', dias) FROM pr WHERE kg_saldo > 0.0005 ORDER BY dias DESC, kg_saldo DESC LIMIT 1)
  ) INTO v_k;

  SELECT COALESCE(jsonb_agg(x ORDER BY (x ->> 'tn_saldo')::numeric DESC), '[]') INTO v_lotes FROM (
    SELECT jsonb_build_object('lote', clave, 'tipo', tipo, 'glosa', etiqueta, 'tn_saldo', round(kg_saldo / 1000, 3), 'tn_in', round(kg_in / 1000, 3),
      'tn_dias', tn_dias, 'dias', dias, 'aging_pond', aging_pond, 'estado', estado, 'rango', rango, 'fecha_saldo', fecha_saldo,
      'fecha_entrega', fecha_entrega, 'productos', productos) AS x
    FROM public.apt_group(v_q, 'lote') WHERE kg_saldo > 0.0005) z;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('producto', clave, 'glosa', etiqueta, 'tn_saldo', round(kg_saldo / 1000, 3),
      'tn_dias', tn_dias, 'dias', dias, 'aging_pond', aging_pond, 'lotes', lotes) ORDER BY kg_saldo DESC), '[]') INTO v_prod
  FROM (SELECT * FROM public.apt_group(v_q, 'producto') WHERE kg_saldo > 0.0005 ORDER BY kg_saldo DESC LIMIT 10) z;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('familia', clave, 'tn_saldo', round(kg_saldo / 1000, 3), 'tn_dias', tn_dias,
      'aging_pond', aging_pond, 'lotes', lotes) ORDER BY kg_saldo DESC), '[]') INTO v_fam
  FROM (SELECT * FROM public.apt_group(v_q, 'familia') WHERE kg_saldo > 0.0005 ORDER BY kg_saldo DESC LIMIT 10) z;

  WITH o AS (SELECT * FROM public.apt_filtered(v_q) WHERE kg_saldo > 0.0005), t AS (SELECT sum(kg_saldo) AS tot FROM o)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('rango', r.label, 'desde', r.desde, 'tn', round(COALESCE(x.kg, 0) / 1000, 3),
      'pct', round(100 * COALESCE(x.kg, 0) / NULLIF((SELECT tot FROM t), 0), 1), 'capas', COALESCE(x.n, 0), 'lotes', COALESCE(x.lotes, 0),
      'tn_dias', round(COALESCE(x.txd, 0), 1)) ORDER BY r.desde), '[]') INTO v_aging
  FROM public.apt_aging_ranges r
  LEFT JOIN (SELECT rango_orden, sum(kg_saldo) AS kg, count(*) AS n, count(DISTINCT lote) AS lotes, sum(tn_dias) AS txd
             FROM o GROUP BY rango_orden) x ON x.rango_orden = r.desde;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('estado', estado, 'capas', n, 'tn_in', round(kg_in / 1000, 3), 'tn_saldo', round(kg_saldo / 1000, 3))
      ORDER BY kg_in DESC), '[]') INTO v_estados
  FROM (SELECT estado, count(*) AS n, sum(kg_in) AS kg_in, sum(kg_saldo) AS kg_saldo FROM public.apt_filtered(v_q) GROUP BY estado) z;

  WITH lo AS (SELECT clave, kg_saldo FROM public.apt_group(v_q, 'lote') WHERE kg_saldo > 0.0005),
  r AS (SELECT clave, kg_saldo, sum(kg_saldo) OVER (ORDER BY kg_saldo DESC, clave) / NULLIF(sum(kg_saldo) OVER (), 0) AS cum,
               row_number() OVER (ORDER BY kg_saldo DESC, clave) AS rk FROM lo)
  SELECT jsonb_build_object('lotes_con_saldo', (SELECT count(*) FROM lo),
    'lotes_80', (SELECT min(rk) FROM r WHERE cum >= 0.8),
    'pct_lotes_80', round(100.0 * (SELECT min(rk) FROM r WHERE cum >= 0.8) / NULLIF((SELECT count(*) FROM lo), 0), 1),
    'top10_pct', round(100 * (SELECT sum(kg_saldo) FROM r WHERE rk <= 10) / NULLIF((SELECT sum(kg_saldo) FROM lo), 0), 1))
  INTO v_pareto;

  v_trend := public.apt_trends(v_q, p_grain) -> 'series';

  RETURN jsonb_build_object('success', true, 'cutoff', v_cut, 'alert_days', v_alert, 'kpis', v_k,
    'aging', v_aging, 'estados', v_estados,
    'top_lotes_tn', (SELECT COALESCE(jsonb_agg(e), '[]') FROM (SELECT e FROM jsonb_array_elements(v_lotes) e LIMIT 10) z),
    'top_lotes_txd', (SELECT COALESCE(jsonb_agg(e ORDER BY (e ->> 'tn_dias')::numeric DESC), '[]')
                      FROM (SELECT e FROM jsonb_array_elements(v_lotes) e ORDER BY (e ->> 'tn_dias')::numeric DESC LIMIT 10) z),
    'top_productos', v_prod, 'top_familias', v_fam, 'pareto', v_pareto, 'trend', v_trend);
END $function$;
REVOKE ALL ON FUNCTION public.apt_dashboard_live(p jsonb, p_grain text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_dashboard_live(p jsonb, p_grain text) TO service_role;

CREATE OR REPLACE FUNCTION public.apt_data_version()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  RETURN jsonb_build_object('success', true, 'version', concat_ws('|',
    (SELECT count(*) || ':' || COALESCE(max(applied_at)::text, '-') FROM public.apt_uploads WHERE status = 'APLICADA'),
    (SELECT COALESCE(max(rebuilt_at)::text, '-') FROM public.apt_state),
    (SELECT COALESCE(max(rebuilt_at)::text, '-') FROM public.apt_flow_state),
    (SELECT COALESCE(max(to_jsonb(s)->>'updated_at'), '-') FROM public.apt_settings s)));
END $function$;
REVOKE ALL ON FUNCTION public.apt_data_version() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_data_version() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_date(v jsonb)
 RETURNS date
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s text := btrim(v #>> '{}');
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' OR s IS NULL OR s = '' THEN RETURN NULL; END IF;
  IF jsonb_typeof(v) = 'number' THEN RETURN DATE '1899-12-30' + floor((v #>> '{}')::numeric)::int; END IF;
  IF s ~ '^\d{4}-\d{2}-\d{2}' THEN RETURN left(s, 10)::date; END IF;
  IF s ~ '^\d{1,2}/\d{1,2}/\d{4}' THEN RETURN to_date(substring(s FROM '^\d{1,2}/\d{1,2}/\d{4}'), 'DD/MM/YYYY'); END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION public.apt_date(v jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_date(v jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_detail(p jsonb DEFAULT '{}'::jsonb, p_level text DEFAULT 'capa'::text, p_sort text DEFAULT 'tn_dias'::text, p_desc boolean DEFAULT true, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_q jsonb := COALESCE(p, '{}'::jsonb); v_rows jsonb; v_total bigint; v_tot jsonb; v_sort text; v_dir text := CASE WHEN p_desc THEN 'DESC' ELSE 'ASC' END;
        v_lim integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 20000); v_off integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  IF p_level = 'capa' THEN
    v_sort := CASE WHEN p_sort IN ('lote', 'numrel_op', 'producto', 'glosa', 'ipt', 'fecha_ingreso', 'fecha_entrega', 'last_out', 'kg_in',
                                   'kg_out', 'kg_saldo', 'dias', 'dias_saldo', 'tn_dias', 'estado', 'rango_orden', 'cantidad', 'cliente')
                   THEN p_sort ELSE 'tn_dias' END;
    EXECUTE format($q$
      SELECT COALESCE(jsonb_agg(r ORDER BY rn), '[]') FROM (
        SELECT row_number() OVER () AS rn, jsonb_build_object(
          'id', movement_id, 'lote', lote, 'tipo', public.apt_lote_tipo(lote), 'numrel_op', numrel_op, 'producto', producto, 'glosa', glosa,
          'familia', familia, 'ipt', ipt, 'cliente', cliente, 'documento', documento, 'fecha_ingreso', fecha_ingreso, 'fecha_entrega', fecha_entrega,
          'primera_salida', first_out, 'ultima_salida', last_out, 'cantidad', cantidad, 'unidad', unidad,
          'kg_in', round(kg_in, 2), 'kg_out', round(kg_out, 2), 'kg_saldo', round(kg_saldo, 2),
          'tn_in', round(kg_in / 1000, 3), 'tn_out', round(kg_out / 1000, 3), 'tn_saldo', round(kg_saldo / 1000, 3),
          'dias', dias, 'dias_saldo', dias_saldo, 'dias_despacho_pond', round(out_kg_days / NULLIF(kg_out_fechado, 0), 1),
          'rango', rango, 'tn_dias', round(tn_dias, 3), 'estado', estado,
          'salida_antes_ingreso', kg_out_before_in > 0.5, 'problema_info', problema_info, 'posible_cruce', posible_cruce) AS r
        FROM (SELECT * FROM public.apt_filtered($1) ORDER BY %I %s NULLS LAST, movement_id LIMIT $2 OFFSET $3) z) y$q$, v_sort, v_dir)
    INTO v_rows USING v_q, v_lim, v_off;
    SELECT count(*), jsonb_build_object('tn_in', round(sum(kg_in) / 1000, 3), 'tn_out', round(sum(kg_out) / 1000, 3),
        'tn_saldo', round(sum(kg_saldo) / 1000, 3), 'tn_dias', round(sum(tn_dias), 1))
      INTO v_total, v_tot FROM public.apt_filtered(v_q);
  ELSIF p_level IN ('lote', 'producto', 'glosa', 'familia', 'numrel_op', 'ipt', 'contrato', 'cliente') THEN
    v_sort := CASE WHEN p_sort IN ('clave', 'etiqueta', 'tipo', 'capas', 'lotes', 'productos', 'ops', 'ipts', 'kg_in', 'kg_out', 'kg_saldo',
                                   'primer_ingreso', 'ultimo_ingreso', 'primera_salida', 'ultima_salida', 'fecha_entrega', 'fecha_saldo',
                                   'dias', 'dias_max', 'aging_pond', 'dias_despacho_pond', 'tn_dias', 'estado', 'rango_orden', 'capas_problema',
                                   'cliente', 'contratos', 'ultimo_despacho')
                   THEN p_sort ELSE 'tn_dias' END;
    EXECUTE format($q$
      SELECT COALESCE(jsonb_agg(r ORDER BY rn), '[]') FROM (
        SELECT row_number() OVER () AS rn, to_jsonb(z) || jsonb_build_object(
          'tn_in', round(z.kg_in / 1000, 3), 'tn_out', round(z.kg_out / 1000, 3), 'tn_saldo', round(z.kg_saldo / 1000, 3),
          'pct_despachado', round(100 * z.kg_out / NULLIF(z.kg_in, 0), 1)) AS r
        FROM (SELECT * FROM public.apt_group($1, %L) ORDER BY %I %s NULLS LAST, clave LIMIT $2 OFFSET $3) z) y$q$, p_level, v_sort, v_dir)
    INTO v_rows USING v_q, v_lim, v_off;
    SELECT count(*), jsonb_build_object('tn_in', round(sum(kg_in) / 1000, 3), 'tn_out', round(sum(kg_out) / 1000, 3),
        'tn_saldo', round(sum(kg_saldo) / 1000, 3), 'tn_dias', round(sum(tn_dias), 1))
      INTO v_total, v_tot FROM public.apt_group(v_q, p_level);
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'Nivel de detalle no válido');
  END IF;
  RETURN jsonb_build_object('success', true, 'level', p_level, 'total', v_total, 'totals', v_tot, 'rows', v_rows);
END $function$;
REVOKE ALL ON FUNCTION public.apt_detail(p jsonb, p_level text, p_sort text, p_desc boolean, p_limit integer, p_offset integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_detail(p jsonb, p_level text, p_sort text, p_desc boolean, p_limit integer, p_offset integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_fecha_entrega(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_cut date; v_out jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  SELECT cutoff INTO v_cut FROM public.apt_state WHERE id = 1;
  WITH f AS (SELECT * FROM public.apt_filtered(COALESCE(p, '{}'::jsonb))),
  ing AS (SELECT CASE WHEN fecha_entrega IS NULL THEN 'Sin FechaEntrega' WHEN fecha_ingreso < fecha_entrega THEN 'Antes de FechaEntrega'
                      WHEN fecha_ingreso = fecha_entrega THEN 'En fecha' ELSE 'Después de FechaEntrega' END AS clase,
                 fecha_ingreso - fecha_entrega AS dif, kg_in, lote FROM f),
  sal AS (SELECT CASE WHEN f.fecha_entrega IS NULL THEN 'Sin FechaEntrega' WHEN a.fecha_salida < f.fecha_entrega THEN 'Antes de FechaEntrega'
                      WHEN a.fecha_salida = f.fecha_entrega THEN 'En fecha' ELSE 'Después de FechaEntrega' END AS clase,
                 a.fecha_salida - f.fecha_entrega AS dif, a.kg
          FROM public.apt_allocations a JOIN f ON f.movement_id = a.layer_id),
  buckets AS (SELECT * FROM (VALUES (1, '< -30', -100000, -31), (2, '-30 a -8', -30, -8), (3, '-7 a -1', -7, -1), (4, '0', 0, 0),
                                    (5, '1 a 7', 1, 7), (6, '8 a 15', 8, 15), (7, '16 a 30', 16, 30), (8, '31 a 60', 31, 60), (9, '> 60', 61, 100000)) b(o, label, lo, hi))
  SELECT jsonb_build_object('success', true, 'cutoff', v_cut,
    'ingreso_vs_fe', (SELECT COALESCE(jsonb_agg(jsonb_build_object('clase', clase, 'capas', n, 'tn', round(kg / 1000, 3), 'dias_prom', d) ORDER BY clase), '[]')
                      FROM (SELECT clase, count(*) AS n, sum(kg_in) AS kg, round(avg(dif), 1) AS d FROM ing GROUP BY clase) z),
    'salida_vs_fe', (SELECT COALESCE(jsonb_agg(jsonb_build_object('clase', clase, 'tn', round(kg / 1000, 3), 'dias_prom', d) ORDER BY clase), '[]')
                     FROM (SELECT clase, sum(kg) AS kg, round(sum(kg * dif) / NULLIF(sum(kg), 0), 1) AS d FROM sal GROUP BY clase) z),
    'distribucion_ingreso', (SELECT jsonb_agg(jsonb_build_object('rango', b.label, 'tn', round(COALESCE((SELECT sum(kg_in) FROM ing WHERE dif BETWEEN b.lo AND b.hi), 0) / 1000, 3),
                               'capas', (SELECT count(*) FROM ing WHERE dif BETWEEN b.lo AND b.hi)) ORDER BY b.o) FROM buckets b),
    'distribucion_salida', (SELECT jsonb_agg(jsonb_build_object('rango', b.label, 'tn', round(COALESCE((SELECT sum(kg) FROM sal WHERE dif BETWEEN b.lo AND b.hi), 0) / 1000, 3)) ORDER BY b.o) FROM buckets b),
    'saldo_vencido', jsonb_build_object(
      'tn', round(COALESCE((SELECT sum(kg_saldo) FROM f WHERE kg_saldo > 0.0005 AND fecha_entrega < v_cut), 0) / 1000, 3),
      'tn_sin_fe', round(COALESCE((SELECT sum(kg_saldo) FROM f WHERE kg_saldo > 0.0005 AND fecha_entrega IS NULL), 0) / 1000, 3),
      'dias_prom_pond', (SELECT round(sum(kg_saldo * (v_cut - fecha_entrega)) / NULLIF(sum(kg_saldo), 0), 1) FROM f WHERE kg_saldo > 0.0005 AND fecha_entrega < v_cut)),
    'top_lotes_saldo_vencido', (SELECT COALESCE(jsonb_agg(z ORDER BY (z ->> 'tn')::numeric DESC), '[]') FROM (
        SELECT jsonb_build_object('lote', lote, 'tn', round(sum(kg_saldo) / 1000, 3), 'fecha_entrega', min(fecha_entrega),
          'dias_desde_fe', v_cut - min(fecha_entrega), 'primer_ingreso', min(fecha_ingreso)) AS z
        FROM f WHERE kg_saldo > 0.0005 AND fecha_entrega < v_cut GROUP BY lote ORDER BY sum(kg_saldo) DESC LIMIT 15) y))
  INTO v_out;
  RETURN v_out;
END $function$;
REVOKE ALL ON FUNCTION public.apt_fecha_entrega(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_fecha_entrega(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_filter_options()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  RETURN jsonb_build_object('success', true,
    'lotes', (SELECT COALESCE(jsonb_agg(jsonb_build_object('lote', lote, 'tipo', public.apt_lote_tipo(lote), 'tn_saldo', round(kg / 1000, 3)) ORDER BY lote), '[]')
              FROM (SELECT lote, sum(kg_saldo) AS kg FROM public.apt_layers GROUP BY lote) z),
    'contratos', (SELECT COALESCE(jsonb_agg(c ORDER BY c), '[]') FROM (SELECT DISTINCT split_part(lote, '-', 1) AS c FROM public.apt_layers) z),
    'familias', (SELECT COALESCE(jsonb_agg(jsonb_build_object('familia', familia, 'tn_saldo', round(kg / 1000, 3)) ORDER BY kg DESC), '[]')
                 FROM (SELECT COALESCE(familia, '(sin glosa)') AS familia, sum(kg_saldo) AS kg FROM public.apt_layers GROUP BY 1) z),
    'clientes', (SELECT COALESCE(jsonb_agg(jsonb_build_object('cliente', cliente, 'tn_saldo', round(kg / 1000, 3)) ORDER BY kg DESC, cliente), '[]')
                 FROM (SELECT COALESCE(cliente, '(Sin cliente identificado)') AS cliente, sum(kg_saldo) AS kg FROM public.apt_layers GROUP BY 1) z),
    'docrels', (SELECT COALESCE(jsonb_agg(DISTINCT docrel), '[]') FROM public.apt_layers WHERE docrel IS NOT NULL),
    'estados', '["En APT","Salida parcial","Despachado","Sin salida identificada","Problema de información"]'::jsonb,
    'rangos', (SELECT jsonb_agg(label ORDER BY desde) FROM public.apt_aging_ranges),
    'fechas', (SELECT jsonb_build_object('ingreso_min', min(fecha_ingreso), 'ingreso_max', max(fecha_ingreso),
                 'entrega_min', min(fecha_entrega), 'entrega_max', max(fecha_entrega)) FROM public.apt_layers),
    'state', (SELECT to_jsonb(st) - 'id' FROM public.apt_state st WHERE id = 1));
END $function$;
REVOKE ALL ON FUNCTION public.apt_filter_options() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_filter_options() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_filtered(p jsonb)
 RETURNS SETOF apt_layers
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  q jsonb := COALESCE(p, '{}'::jsonb);
  f_lote text := public.apt_like(q, 'lote'); f_lotes text[] := public.apt_arr(q, 'lotes');
  f_contrato text := upper(NULLIF(btrim(q ->> 'contrato'), '')); f_tipos text[] := public.apt_arr(q, 'tipos');
  f_op text := public.apt_like(q, 'numrel_op'); f_prod text := public.apt_like(q, 'producto');
  f_glosa text := public.apt_like(q, 'glosa'); f_ipt text := public.apt_like(q, 'ipt');
  f_fam text[] := public.apt_arr(q, 'familias'); f_est text[] := public.apt_arr(q, 'estados');
  f_rng text[] := public.apt_arr(q, 'rangos'); f_doc text[] := public.apt_arr(q, 'docrels');
  f_id date := public.apt_date(q -> 'ingreso_desde'); f_ih date := public.apt_date(q -> 'ingreso_hasta');
  f_ed date := public.apt_date(q -> 'entrega_desde'); f_eh date := public.apt_date(q -> 'entrega_hasta');
  f_saldo boolean := COALESCE(lower(q ->> 'solo_saldo') IN ('true', '1', 'si'), false);
  f_dmin numeric := public.apt_num(q -> 'dias_min'); f_cli text := public.apt_like(q, 'cliente');
  f_prods text[] := public.apt_arr(q, 'productos'); f_glosas text[] := public.apt_arr(q, 'glosas');
  f_alert text[] := public.apt_arr(q, 'alertas');
  f_clientes text[] := public.apt_arr(q, 'clientes'); f_ots text[] := public.apt_arr(q, 'contratos');
BEGIN
  RETURN QUERY
  SELECT l.* FROM public.apt_layers l
  WHERE -- apt_filter_almacenes_ingreso
    (public.apt_arr(q, 'almacenes') IS NULL OR EXISTS (
      SELECT 1 FROM public.apt_movements m
      WHERE m.id = l.movement_id
        AND COALESCE(NULLIF(to_jsonb(m) ->> 'almacen', ''),
                     public.apt_almacen(to_jsonb(m) ->> 'bodega'), '647')
            = ANY (public.apt_arr(q, 'almacenes'))
    )) AND (f_lote IS NULL OR l.lote ILIKE f_lote)
    AND (f_lotes IS NULL OR l.lote = ANY (f_lotes))
    AND (f_contrato IS NULL OR split_part(l.lote, '-', 1) = f_contrato)
    AND (f_tipos IS NULL OR public.apt_lote_tipo(l.lote) = ANY (f_tipos))
    AND (f_op IS NULL OR l.numrel_op ILIKE f_op)
    AND (f_prod IS NULL OR l.producto ILIKE f_prod)
    AND (f_glosa IS NULL OR l.glosa ILIKE f_glosa)
    AND (f_ipt IS NULL OR l.ipt ILIKE f_ipt)
    AND (f_fam IS NULL OR COALESCE(l.familia, '(sin glosa)') = ANY (f_fam))
    AND (f_est IS NULL OR l.estado = ANY (f_est))
    AND (f_rng IS NULL OR l.rango = ANY (f_rng))
    AND (f_doc IS NULL OR l.docrel = ANY (f_doc))
    AND (f_id IS NULL OR l.fecha_ingreso >= f_id)
    AND (f_ih IS NULL OR l.fecha_ingreso <= f_ih)
    AND (f_ed IS NULL OR l.fecha_entrega >= f_ed)
    AND (f_eh IS NULL OR l.fecha_entrega <= f_eh)
    AND (NOT f_saldo OR l.kg_saldo > 0.0005)
    AND (f_dmin IS NULL OR COALESCE(l.dias_saldo, l.dias) >= f_dmin)
    AND (f_prods IS NULL OR l.producto = ANY (f_prods))
    AND (f_glosas IS NULL OR COALESCE(l.glosa, l.producto) = ANY (f_glosas))
    AND (f_alert IS NULL OR ('problema_info' = ANY (f_alert) AND l.problema_info) OR ('posible_cruce' = ANY (f_alert) AND l.posible_cruce))
    AND (f_cli IS NULL OR l.cliente ILIKE f_cli)
    AND (f_clientes IS NULL OR COALESCE(l.cliente, '(Sin cliente identificado)') = ANY (f_clientes))
    AND (f_ots IS NULL OR split_part(l.lote, '-', 1) = ANY (f_ots));
END $function$;
REVOKE ALL ON FUNCTION public.apt_filtered(p jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_filtered(p jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.apt_flow_adelantos(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r record; v_kpi jsonb; v_mes jsonb; v_list jsonb; v_contr jsonb; v_540 jsonb; v_cons jsonb; v_cons_res jsonb; v_ini jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  p := COALESCE(p, '{}'::jsonb);
  SELECT * INTO r FROM public.apt_flow_range(p);
  IF r.v_cut IS NULL THEN RETURN jsonb_build_object('success', true, 'vacio', true); END IF;

  -- Asignación: el lote de origen no tiene formato de contrato (adelanto / OP interna con IPT). Reasignación: contrato → otro contrato.
  DROP TABLE IF EXISTS pg_temp.f_cl;
  CREATE TEMP TABLE f_cl ON COMMIT DROP AS
    SELECT x.id, x.fecha, x.almacen, x.almacen_destino, x.lote, x.lote_destino, x.producto, x.glosa, x.documento, x.kg,
           COALESCE((SELECT c.cliente FROM public.apt_flow_layers c WHERE c.exit_id = x.id LIMIT 1), x.cliente) AS cliente,
           CASE WHEN x.lote ~ '^[0-9]{5}' THEN 'REASIGNACION' ELSE 'ASIGNACION' END AS clase,
           (SELECT round(sum(a.kg * (x.fecha - l.fecha)) / NULLIF(sum(a.kg), 0), 1) FROM public.apt_flow_alloc a
            JOIN public.apt_flow_layers l ON l.id = a.layer_id WHERE a.exit_id = x.id AND l.fecha IS NOT NULL) AS dias_espera,
           (SELECT sum(a.kg) FROM public.apt_flow_alloc a JOIN public.apt_flow_layers l ON l.id = a.layer_id
            WHERE a.exit_id = x.id AND l.tipo = 'INICIAL') AS kg_inicial
    FROM public.apt_flow_exits x
    WHERE x.tipo = 'TRASPASO' AND x.lote <> x.lote_destino AND x.fecha BETWEEN r.v_from AND r.v_to
      AND (public.apt_flow_match(p, x.lote, x.cliente) OR public.apt_flow_match(p, x.lote_destino, x.cliente));

  SELECT jsonb_build_object(
    'asignacion_tn', (SELECT public.apt_flow_tn(sum(kg)) FROM f_cl WHERE clase = 'ASIGNACION'),
    'asignacion_filas', (SELECT count(*) FROM f_cl WHERE clase = 'ASIGNACION'),
    'asignacion_lotes', (SELECT count(DISTINCT lote) FROM f_cl WHERE clase = 'ASIGNACION'),
    'asignacion_dias_pond', (SELECT round(sum(kg * dias_espera) / NULLIF(sum(kg) FILTER (WHERE dias_espera IS NOT NULL), 0), 1) FROM f_cl WHERE clase = 'ASIGNACION'),
    'asignacion_inicial_tn', (SELECT public.apt_flow_tn(sum(kg_inicial)) FROM f_cl WHERE clase = 'ASIGNACION'),
    'reasignacion_tn', (SELECT public.apt_flow_tn(sum(kg)) FROM f_cl WHERE clase = 'REASIGNACION'),
    'reasignacion_filas', (SELECT count(*) FROM f_cl WHERE clase = 'REASIGNACION'),
    'saldo_540_tn', (SELECT public.apt_flow_tn(sum(kg_saldo)) FROM public.apt_flow_layers WHERE almacen = '540' AND public.apt_flow_match(p, lote, cliente)),
    'inicial_540_tn', (SELECT public.apt_flow_tn(sum(kg_in)) FROM public.apt_flow_layers WHERE almacen = '540' AND tipo = 'INICIAL' AND public.apt_flow_match(p, lote, cliente)),
    'inicial_540_saldo_tn', (SELECT public.apt_flow_tn(sum(kg_saldo)) FROM public.apt_flow_layers WHERE almacen = '540' AND tipo = 'INICIAL' AND public.apt_flow_match(p, lote, cliente)),
    'ingresos_540_tn', (SELECT public.apt_flow_tn(sum(kg_in)) FROM public.apt_flow_layers WHERE almacen = '540' AND tipo <> 'INICIAL'
                        AND fecha BETWEEN r.v_from AND r.v_to AND public.apt_flow_match(p, lote, cliente)),
    'ultimo_ingreso_540', (SELECT max(fecha) FROM public.apt_flow_layers WHERE almacen = '540' AND tipo <> 'INICIAL'),
    'consumo_tn', (SELECT public.apt_flow_tn(sum(kg)) FROM public.apt_flow_exits WHERE tipo = 'CONSUMO' AND fecha BETWEEN r.v_from AND r.v_to
                   AND public.apt_flow_match(p, lote, cliente)))
  INTO v_kpi;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('mes', mes, 'asignacion_tn', public.apt_flow_tn(a), 'reasignacion_tn', public.apt_flow_tn(b),
           'dias_espera', d) ORDER BY mes), '[]')
  INTO v_mes
  FROM (SELECT date_trunc('month', fecha)::date AS mes, sum(kg) FILTER (WHERE clase = 'ASIGNACION') AS a, sum(kg) FILTER (WHERE clase = 'REASIGNACION') AS b,
               round(sum(kg * dias_espera) FILTER (WHERE clase = 'ASIGNACION') / NULLIF(sum(kg) FILTER (WHERE clase = 'ASIGNACION' AND dias_espera IS NOT NULL), 0), 1) AS d
        FROM f_cl GROUP BY 1) z;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('fecha', fecha, 'clase', clase, 'desde', almacen, 'hacia', almacen_destino, 'lote', lote,
           'lote_destino', lote_destino, 'producto', producto, 'glosa', glosa, 'documento', documento, 'cliente', cliente,
           'tn', public.apt_flow_tn(kg), 'dias_espera', dias_espera, 'inicial_tn', public.apt_flow_tn(kg_inicial)) ORDER BY fecha DESC, kg DESC), '[]')
  INTO v_list FROM (SELECT * FROM f_cl ORDER BY fecha DESC, kg DESC LIMIT 500) z;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('contrato', lote_destino, 'cliente', cliente, 'tn', public.apt_flow_tn(kg), 'lotes_origen', n,
           'primera', f0, 'ultima', f1, 'clase', clase) ORDER BY kg DESC), '[]')
  INTO v_contr
  FROM (SELECT lote_destino, clase, max(cliente) AS cliente, sum(kg) AS kg, count(DISTINCT lote) AS n, min(fecha) AS f0, max(fecha) AS f1
        FROM f_cl GROUP BY 1, 2 ORDER BY 4 DESC LIMIT 80) z;

  -- 540 por mes: ingresos y salidas por tipo, y uso del stock inicial en lo despachado
  SELECT COALESCE(jsonb_agg(jsonb_build_object('mes', m.mes,
    'ingresos', (SELECT COALESCE(jsonb_object_agg(t, tn), '{}') FROM (SELECT CASE WHEN tipo = 'TRASPASO' THEN 'DESDE_' || almacen_origen ELSE tipo END AS t,
                 public.apt_flow_tn(sum(kg_in)) AS tn FROM public.apt_flow_layers WHERE almacen = '540' AND tipo <> 'INICIAL'
                 AND date_trunc('month', fecha) = m.mes AND public.apt_flow_match(p, lote, cliente) GROUP BY 1) z),
    'salidas', (SELECT COALESCE(jsonb_object_agg(t, tn), '{}') FROM (SELECT CASE WHEN tipo = 'TRASPASO' THEN 'HACIA_' || almacen_destino ELSE tipo END AS t,
                 public.apt_flow_tn(sum(kg)) AS tn FROM public.apt_flow_exits WHERE almacen = '540'
                 AND date_trunc('month', fecha) = m.mes AND public.apt_flow_match(p, lote, cliente) GROUP BY 1) z),
    'inicial_despachado_tn', (SELECT public.apt_flow_tn(sum(kg)) FROM public.apt_flow_pieces WHERE NOT es_saldo AND origen = 'INICIAL_540'
                 AND date_trunc('month', fecha_salida) = m.mes AND public.apt_flow_match(p, lote, cliente))) ORDER BY m.mes), '[]')
  INTO v_540
  FROM (SELECT generate_series(date_trunc('month', r.v_from), date_trunc('month', r.v_to), interval '1 month')::date AS mes) m;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('origen', origen, 'tn', public.apt_flow_tn(kg), 'lotes', n) ORDER BY kg DESC), '[]')
  INTO v_ini
  FROM (SELECT origen, sum(kg) AS kg, count(DISTINCT lote) AS n FROM public.apt_flow_pieces WHERE es_saldo AND almacen = '540'
        AND public.apt_flow_match(p, lote, cliente) GROUP BY 1) z;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('fecha', fecha, 'almacen', almacen, 'lote', lote, 'producto', producto, 'glosa', glosa,
           'numrel', numrel, 'docrel', docrel, 'documento', documento, 'cliente', cliente, 'tn', public.apt_flow_tn(kg)) ORDER BY fecha DESC, kg DESC), '[]')
  INTO v_cons
  FROM (SELECT * FROM public.apt_flow_exits WHERE tipo = 'CONSUMO' AND fecha BETWEEN r.v_from AND r.v_to AND public.apt_flow_match(p, lote, cliente)
        ORDER BY fecha DESC, kg DESC LIMIT 400) z;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('almacen', almacen, 'docrel', docrel, 'tn', public.apt_flow_tn(kg), 'filas', n) ORDER BY kg DESC), '[]')
  INTO v_cons_res
  FROM (SELECT almacen, COALESCE(docrel, '(sin documento relacionado)') AS docrel, sum(kg) AS kg, count(*) AS n FROM public.apt_flow_exits
        WHERE tipo = 'CONSUMO' AND fecha BETWEEN r.v_from AND r.v_to AND public.apt_flow_match(p, lote, cliente) GROUP BY 1, 2) z;

  RETURN jsonb_build_object('success', true, 'cutoff', r.v_cut, 'desde', r.v_from, 'hasta', r.v_to,
    'kpis', v_kpi, 'mensual', v_mes, 'cambios', v_list, 'contratos', v_contr, 'mensual_540', v_540, 'saldo_540_origen', v_ini,
    'consumos', v_cons, 'consumos_resumen', v_cons_res);
END $function$;
REVOKE ALL ON FUNCTION public.apt_flow_adelantos(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_flow_adelantos(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_flow_cards(p jsonb, p_cut date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('almacen', a.almacen, 'saldo_tn', public.apt_flow_tn(a.kg), 'inicial_tn', public.apt_flow_tn(a.kg_ini),
           'capas', a.capas, 'lotes', a.lotes, 'edad_pond', a.edad, 'dias_almacen_pond', a.dias) ORDER BY a.o), '[]')
  FROM (SELECT almacen, CASE almacen WHEN '647' THEN 1 WHEN '540' THEN 2 ELSE 3 END AS o, sum(kg) AS kg,
               sum(kg) FILTER (WHERE origen LIKE 'INICIAL%') AS kg_ini, count(DISTINCT layer_id) AS capas, count(DISTINCT lote) AS lotes,
               round(sum(kg * (p_cut - fecha_origen)) FILTER (WHERE fecha_origen IS NOT NULL) / NULLIF(sum(kg) FILTER (WHERE fecha_origen IS NOT NULL), 0), 1) AS edad,
               round(sum(kg * (p_cut - fecha_llegada)) FILTER (WHERE fecha_llegada IS NOT NULL) / NULLIF(sum(kg) FILTER (WHERE fecha_llegada IS NOT NULL), 0), 1) AS dias
        FROM public.apt_flow_pieces WHERE es_saldo AND public.apt_flow_match(p, lote, cliente) GROUP BY 1) a;
$function$;
REVOKE ALL ON FUNCTION public.apt_flow_cards(p jsonb, p_cut date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_flow_cards(p jsonb, p_cut date) TO service_role;

CREATE OR REPLACE FUNCTION public.apt_flow_ensure_current_core()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_applied timestamptz; v_rebuilt timestamptz; v_cut date; v_target date; v_result jsonb; v_missing boolean;
BEGIN
 -- El chequeo y su reparación comparten los bloqueos del reemplazo y del FIFO.
 PERFORM pg_advisory_xact_lock(hashtext('apt_rebuild'));
 PERFORM pg_advisory_xact_lock(hashtext('apt_flow_rebuild'));
 SELECT max(applied_at) INTO v_applied FROM public.apt_uploads WHERE status='APLICADA';
 SELECT rebuilt_at,cutoff INTO v_rebuilt,v_cut FROM public.apt_flow_state WHERE id=1;
 SELECT COALESCE((SELECT cutoff_date FROM public.apt_settings WHERE id=1),max(fecha))
  INTO v_target FROM public.apt_movements WHERE active AND valid;
 SELECT EXISTS(
  SELECT 1 FROM public.apt_movements m
  WHERE m.active AND m.valid AND m.fecha<=v_cut AND m.peso_kg>0
   AND m.lote IS NOT NULL AND m.producto IS NOT NULL
   AND (m.almacen IS NOT NULL OR m.kind='ENTRADA')
   AND ((m.kind IN ('ENTRADA','TRASPASO_ENT','DEVOLUCION')
         AND NOT EXISTS(SELECT 1 FROM public.apt_flow_layers l WHERE l.id=m.id))
     OR (m.kind IN ('SALIDA','TRASPASO_SAL','CONSUMO')
         AND NOT EXISTS(SELECT 1 FROM public.apt_flow_exits x WHERE x.id=m.id)))
 ) INTO v_missing;
 IF v_cut IS DISTINCT FROM v_target OR v_missing OR (v_applied IS NOT NULL AND (v_rebuilt IS NULL OR v_rebuilt<v_applied)) THEN
  v_result:=public.apt_flow_rebuild_core();
  IF (v_result->>'success')::boolean IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'No se pudo reconciliar el flujo APT con los movimientos actuales: %',v_result;
  END IF;
  RETURN v_result || jsonb_build_object('rebuilt',true);
 END IF;
 RETURN jsonb_build_object('success',true,'rebuilt',false,'cutoff',v_cut);
END $function$;
REVOKE ALL ON FUNCTION public.apt_flow_ensure_current_core() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_flow_ensure_current_core() TO service_role;

CREATE OR REPLACE FUNCTION public.apt_flow_leadtime(p jsonb DEFAULT '{}'::jsonb, p_dim text DEFAULT 'cliente'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r record; v_kpi jsonb; v_dist jsonb; v_mes jsonb; v_dim jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  IF p_dim NOT IN ('cliente', 'ot', 'lote', 'familia', 'ruta') THEN RETURN jsonb_build_object('success', false, 'error', 'Dimensión no válida'); END IF;
  p := COALESCE(p, '{}'::jsonb);
  SELECT * INTO r FROM public.apt_flow_range(p);
  IF r.v_cut IS NULL THEN RETURN jsonb_build_object('success', true, 'vacio', true); END IF;

  DROP TABLE IF EXISTS pg_temp.f_lt;
  CREATE TEMP TABLE f_lt ON COMMIT DROP AS
    SELECT kg, documento, cliente, lote, glosa, fecha_salida,
           fecha_salida - fecha_origen AS total,
           COALESCE(fecha_llegada, fecha_origen) - fecha_origen AS previo,
           fecha_salida - COALESCE(fecha_llegada, fecha_origen) AS final,
           CASE WHEN layer_tipo = 'TRASPASO' THEN COALESCE(almacen_previo, '?') || '→' || almacen ELSE almacen END AS ruta
    FROM public.apt_flow_pieces
    WHERE NOT es_saldo AND salida_tipo = 'DESPACHO' AND origen = 'PRODUCCION'
      AND fecha_salida BETWEEN r.v_from AND r.v_to AND public.apt_flow_match(p, lote, cliente);

  WITH o AS (SELECT total, kg, sum(kg) OVER (ORDER BY total ROWS UNBOUNDED PRECEDING) AS cum, sum(kg) OVER () AS tot FROM f_lt)
  SELECT jsonb_build_object(
    'tn', (SELECT public.apt_flow_tn(sum(kg)) FROM f_lt),
    'guias', (SELECT count(DISTINCT documento) FROM f_lt),
    'dias_total', (SELECT round(sum(kg * total) / NULLIF(sum(kg), 0), 1) FROM f_lt),
    'dias_previo', (SELECT round(sum(kg * previo) / NULLIF(sum(kg), 0), 1) FROM f_lt),
    'dias_final', (SELECT round(sum(kg * final) / NULLIF(sum(kg), 0), 1) FROM f_lt),
    'p50', (SELECT min(total) FROM o WHERE cum >= 0.5 * tot),
    'p90', (SELECT min(total) FROM o WHERE cum >= 0.9 * tot),
    'mismo_dia_pct', (SELECT round(100.0 * sum(kg) FILTER (WHERE final = 0) / NULLIF(sum(kg), 0), 1) FROM f_lt),
    'sin_traza_tn', (SELECT public.apt_flow_tn(sum(kg)) FROM public.apt_flow_pieces WHERE NOT es_saldo AND salida_tipo = 'DESPACHO'
                     AND origen <> 'PRODUCCION' AND fecha_salida BETWEEN r.v_from AND r.v_to AND public.apt_flow_match(p, lote, cliente)))
  INTO v_kpi;

  SELECT jsonb_build_object(
    'total', (SELECT COALESCE(jsonb_agg(jsonb_build_object('rango', b.l, 'orden', b.o, 'tn', public.apt_flow_tn(
                (SELECT sum(kg) FROM f_lt WHERE total BETWEEN b.a AND b.z))) ORDER BY b.o), '[]')
              FROM (VALUES (1, '0-7 días', 0, 7), (2, '8-15 días', 8, 15), (3, '16-30 días', 16, 30), (4, '31-60 días', 31, 60),
                           (5, '61-90 días', 61, 90), (6, '> 90 días', 91, 100000)) b(o, l, a, z)),
    'final', (SELECT COALESCE(jsonb_agg(jsonb_build_object('rango', b.l, 'orden', b.o, 'tn', public.apt_flow_tn(
                (SELECT sum(kg) FROM f_lt WHERE final BETWEEN b.a AND b.z))) ORDER BY b.o), '[]')
              FROM (VALUES (1, 'Mismo día', 0, 0), (2, '1 día', 1, 1), (3, '2-3 días', 2, 3), (4, '4-7 días', 4, 7), (5, '> 7 días', 8, 100000)) b(o, l, a, z)))
  INTO v_dist;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('mes', mes, 'tn', public.apt_flow_tn(kg), 'dias_total', t, 'dias_previo', pv, 'dias_final', fi,
           'mismo_dia_pct', md) ORDER BY mes), '[]')
  INTO v_mes
  FROM (SELECT date_trunc('month', fecha_salida)::date AS mes, sum(kg) AS kg, round(sum(kg * total) / NULLIF(sum(kg), 0), 1) AS t,
               round(sum(kg * previo) / NULLIF(sum(kg), 0), 1) AS pv, round(sum(kg * final) / NULLIF(sum(kg), 0), 1) AS fi,
               round(100.0 * sum(kg) FILTER (WHERE final = 0) / NULLIF(sum(kg), 0), 1) AS md
        FROM f_lt GROUP BY 1) z;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('clave', k, 'tn', public.apt_flow_tn(kg), 'guias', g, 'dias_total', t, 'dias_previo', pv,
           'dias_final', fi, 'max_total', mx) ORDER BY kg DESC), '[]')
  INTO v_dim
  FROM (SELECT CASE p_dim WHEN 'cliente' THEN COALESCE(cliente, '(Sin cliente identificado)') WHEN 'ot' THEN split_part(lote, '-', 1)
                          WHEN 'lote' THEN lote WHEN 'familia' THEN COALESCE(split_part(glosa, ' ', 1), '(sin glosa)') ELSE ruta END AS k,
               sum(kg) AS kg, count(DISTINCT documento) AS g, round(sum(kg * total) / NULLIF(sum(kg), 0), 1) AS t,
               round(sum(kg * previo) / NULLIF(sum(kg), 0), 1) AS pv, round(sum(kg * final) / NULLIF(sum(kg), 0), 1) AS fi, max(total) AS mx
        FROM f_lt GROUP BY 1 ORDER BY 2 DESC LIMIT 60) z;

  RETURN jsonb_build_object('success', true, 'cutoff', r.v_cut, 'desde', r.v_from, 'hasta', r.v_to, 'dim', p_dim,
    'kpis', v_kpi, 'distribucion', v_dist, 'mensual', v_mes, 'por_dim', v_dim);
END $function$;
REVOKE ALL ON FUNCTION public.apt_flow_leadtime(p jsonb, p_dim text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_flow_leadtime(p jsonb, p_dim text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_flow_match(p jsonb, p_lote text, p_cliente text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT (NULLIF(btrim(p ->> 'lote'), '') IS NULL OR p_lote ILIKE '%' || btrim(p ->> 'lote') || '%')
     AND (NULLIF(btrim(p ->> 'ot'), '') IS NULL
          OR public.apt_ot_raiz(p_lote) = COALESCE(public.apt_ot_raiz(p ->> 'ot'), upper(btrim(p ->> 'ot'))))
     AND (jsonb_typeof(p -> 'clientes') IS DISTINCT FROM 'array' OR jsonb_array_length(p -> 'clientes') = 0
          OR COALESCE(p_cliente, '(Sin cliente identificado)') IN (SELECT jsonb_array_elements_text(p -> 'clientes')));
$function$;
REVOKE ALL ON FUNCTION public.apt_flow_match(p jsonb, p_lote text, p_cliente text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_flow_match(p jsonb, p_lote text, p_cliente text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_flow_quality()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE st record; v_alm jsonb; v_kinds jsonb; v_alerts jsonb := '[]'::jsonb; v_det numeric; v_ini numeric; v_un numeric; v_ue numeric;
  v_tms jsonb; v_docs text[]; v_est numeric; v_flow_prod numeric; v_last540 date;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  SELECT * INTO st FROM public.apt_flow_state WHERE id = 1;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('tipo', kind, 'filas', n, 'validas', v, 'excluidas', n - v, 'tn', public.apt_flow_tn(kg),
           'desde', f0, 'hasta', f1) ORDER BY o), '[]')
  INTO v_kinds
  FROM (SELECT kind, CASE kind WHEN 'ENTRADA' THEN 1 WHEN 'SALIDA' THEN 2 WHEN 'TRASPASO_SAL' THEN 3 WHEN 'TRASPASO_ENT' THEN 4 WHEN 'CONSUMO' THEN 5 ELSE 6 END AS o,
               count(*) AS n, count(*) FILTER (WHERE valid) AS v, sum(peso_kg) FILTER (WHERE valid) AS kg,
               min(fecha) FILTER (WHERE valid) AS f0, max(fecha) FILTER (WHERE valid) AS f1
        FROM public.apt_movements WHERE active GROUP BY kind) z;

  -- Cuadre: stock inicial + ingresos − salidas = saldo (por construcción del FIFO)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('almacen', a.almacen, 'inicial_tn', public.apt_flow_tn(a.ini), 'ingresos_tn', public.apt_flow_tn(a.ing),
           'salidas_tn', public.apt_flow_tn(a.sal), 'saldo_tn', public.apt_flow_tn(a.sdo), 'diferencia_tn', public.apt_flow_tn(a.ini + a.ing - a.sal - a.sdo),
           'traspasos_sin_destino_tn', public.apt_flow_tn(a.sd), 'traspasos_sin_origen_tn', public.apt_flow_tn(a.so)) ORDER BY a.o), '[]')
  INTO v_alm
  FROM (SELECT l.almacen, CASE l.almacen WHEN '647' THEN 1 WHEN '540' THEN 2 ELSE 3 END AS o,
               COALESCE(sum(l.kg_in) FILTER (WHERE l.tipo = 'INICIAL'), 0) AS ini, COALESCE(sum(l.kg_in) FILTER (WHERE l.tipo <> 'INICIAL'), 0) AS ing,
               COALESCE((SELECT sum(kg) FROM public.apt_flow_exits x WHERE x.almacen = l.almacen), 0) AS sal,
               COALESCE(sum(l.kg_saldo), 0) AS sdo,
               COALESCE((SELECT sum(kg) FROM public.apt_flow_exits x WHERE x.almacen = l.almacen AND x.tipo = 'OTRO_ALMACEN'), 0) AS sd,
               COALESCE(sum(l.kg_in) FILTER (WHERE l.tipo = 'OTRO_ALMACEN'), 0) AS so
        FROM public.apt_flow_layers l GROUP BY l.almacen) a;

  SELECT sum(kg_saldo) INTO v_det FROM public.apt_flow_layers WHERE almacen = 'ST' AND kg_saldo > 0 AND (fecha IS NULL OR st.cutoff - fecha >= 1);
  IF v_det > 500 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('nivel', 'aviso', 'area', 'st', 'mensaje', format(
      'ST VENTAS tiene %s TN con más de un día sin guiarse. Lo ideal es 0: guíe o devuelva a 647/540.', public.apt_flow_tn(v_det))));
  END IF;
  SELECT sum(kg_in) INTO v_ini FROM public.apt_flow_layers WHERE tipo = 'INICIAL';
  IF v_ini > 1000 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('nivel', 'info', 'area', 'almacenes', 'mensaje', format(
      'Se infieren %s TN de stock inicial (existían antes del %s y no tienen fecha de producción). Cargue una foto de stock al inicio para conocer su antigüedad.',
      public.apt_flow_tn(v_ini), to_char(st.data_min, 'DD/MM/YYYY'))));
  END IF;
  SELECT sum(kg) INTO v_un FROM public.apt_flow_exits WHERE tipo = 'OTRO_ALMACEN';
  SELECT sum(kg_in) INTO v_ue FROM public.apt_flow_layers WHERE tipo = 'OTRO_ALMACEN';
  IF COALESCE(v_un, 0) + COALESCE(v_ue, 0) > 1000 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('nivel', 'info', 'area', 'calidad', 'mensaje', format(
      'Traspasos con un solo lado APT: %s TN salieron a otros almacenes y %s TN llegaron desde otros almacenes. Si esperaba que fueran entre 647, 540 y ST, revise que ambos reportes de traspasos cubran las mismas fechas.',
      public.apt_flow_tn(v_un), public.apt_flow_tn(v_ue))));
  END IF;
  SELECT max(fecha) INTO v_last540 FROM public.apt_flow_layers WHERE almacen = '540' AND tipo IN ('PRODUCCION', 'OTRO_ALMACEN', 'TRASPASO');
  IF v_last540 IS NOT NULL AND st.cutoff - v_last540 <= 30 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('nivel', 'aviso', 'area', 'adelantos', 'mensaje', format(
      'El almacén 540 recibió ingresos el %s. Si está suspendido, revise ese ingreso.', to_char(v_last540, 'DD/MM/YYYY'))));
  END IF;

  -- Guías del último mes encontradas en el TMS
  v_docs := ARRAY(SELECT DISTINCT documento FROM public.apt_flow_exits WHERE tipo = 'DESPACHO' AND documento IS NOT NULL AND fecha > st.cutoff - 30);
  v_tms := public.apt_flow_tms(v_docs);

  SELECT sum(kg_saldo) INTO v_est FROM public.apt_layers;
  SELECT sum(kg) INTO v_flow_prod FROM public.apt_flow_pieces WHERE es_saldo AND origen = 'PRODUCCION';

  RETURN jsonb_build_object('success', true, 'cutoff', st.cutoff, 'data_min', st.data_min, 'rebuilt_at', st.rebuilt_at, 'stats', st.stats,
    'hojas', v_kinds, 'almacenes', v_alm, 'alertas', v_alerts,
    'tms', jsonb_build_object('guias_30d', cardinality(v_docs), 'en_tms', (SELECT count(*) FROM jsonb_object_keys(v_tms))),
    'estadia', jsonb_build_object('saldo_estadia_tn', public.apt_flow_tn(v_est), 'saldo_produccion_flujo_tn', public.apt_flow_tn(v_flow_prod),
      'explicacion', 'La estadía consolidada considera solo ENTRADA y SALIDA; el flujo descuenta además consumos internos y salidas a otros almacenes, y separa el saldo por almacén.'));
END $function$;
REVOKE ALL ON FUNCTION public.apt_flow_quality() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_flow_quality() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_flow_range(p jsonb, OUT v_from date, OUT v_to date, OUT v_cut date, OUT v_min date)
 RETURNS record
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(public.apt_date(p -> 'desde'), s.data_min), COALESCE(public.apt_date(p -> 'hasta'), s.cutoff), s.cutoff, s.data_min
  FROM public.apt_flow_state s WHERE s.id = 1;
$function$;
REVOKE ALL ON FUNCTION public.apt_flow_range(p jsonb, OUT v_from date, OUT v_to date, OUT v_cut date, OUT v_min date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_flow_range(p jsonb, OUT v_from date, OUT v_to date, OUT v_cut date, OUT v_min date) TO service_role;

CREATE OR REPLACE FUNCTION public.apt_flow_rebuild()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para recalcular el flujo multi-almacén');
  END IF;
  RETURN public.apt_flow_rebuild_core();
END $function$;
REVOKE ALL ON FUNCTION public.apt_flow_rebuild() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_flow_rebuild() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_flow_rebuild_core()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_cut date; v_min date; v_stats jsonb; v_round integer := 0; v_n bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('apt_rebuild'));
  PERFORM pg_advisory_xact_lock(hashtext('apt_flow_rebuild'));
  SELECT min(fecha), COALESCE((SELECT cutoff_date FROM public.apt_settings WHERE id = 1), max(fecha))
    INTO v_min, v_cut FROM public.apt_movements WHERE active AND valid;

  DELETE FROM public.apt_flow_pieces WHERE true;
  DELETE FROM public.apt_flow_alloc WHERE true;
  DELETE FROM public.apt_flow_layers WHERE true;
  DELETE FROM public.apt_flow_exits WHERE true;
  IF v_cut IS NULL THEN
    UPDATE public.apt_flow_state SET cutoff = NULL, data_min = NULL, rebuilt_at = clock_timestamp(), stats = '{}' WHERE id = 1;
    RETURN jsonb_build_object('success', true, 'cutoff', NULL);
  END IF;

  DROP TABLE IF EXISTS pg_temp.f_mov;
  CREATE TEMP TABLE f_mov ON COMMIT DROP AS
    SELECT id, kind, almacen, lote, producto, fecha, peso_kg AS kg, documento, tipodocto, cantidad, glosa, cliente, numrel, docrel
    FROM public.apt_movements
    WHERE active AND valid AND fecha <= v_cut AND peso_kg > 0 AND lote IS NOT NULL AND producto IS NOT NULL
      AND (almacen IS NOT NULL OR kind = 'ENTRADA');
  UPDATE f_mov SET almacen = '647' WHERE kind = 'ENTRADA' AND almacen IS NULL;  -- todo ingreso de producción llega a 647

  -- Emparejar los dos lados de cada traspaso
  DROP TABLE IF EXISTS pg_temp.f_pair;
  CREATE TEMP TABLE f_pair ON COMMIT DROP AS
    SELECT s.id AS sal_id, e.id AS ent_id
    FROM (SELECT id, tipodocto, documento, producto, cantidad,
                 row_number() OVER (PARTITION BY tipodocto, documento, producto, cantidad ORDER BY fecha, id) AS rn
          FROM f_mov WHERE kind = 'TRASPASO_SAL') s
    JOIN (SELECT id, tipodocto, documento, producto, cantidad,
                 row_number() OVER (PARTITION BY tipodocto, documento, producto, cantidad ORDER BY fecha, id) AS rn
          FROM f_mov WHERE kind = 'TRASPASO_ENT') e
      ON e.tipodocto IS NOT DISTINCT FROM s.tipodocto AND e.documento IS NOT DISTINCT FROM s.documento
     AND e.producto = s.producto AND e.cantidad IS NOT DISTINCT FROM s.cantidad AND e.rn = s.rn;
  CREATE UNIQUE INDEX ON f_pair (sal_id);
  CREATE UNIQUE INDEX ON f_pair (ent_id);

  INSERT INTO public.apt_flow_exits (id, almacen, lote, producto, tipo, fecha, kg, almacen_destino, lote_destino, documento, cliente, numrel, docrel, glosa)
  SELECT m.id, m.almacen, m.lote, m.producto,
    CASE m.kind WHEN 'SALIDA' THEN 'DESPACHO' WHEN 'CONSUMO' THEN 'CONSUMO'
                ELSE CASE WHEN p.ent_id IS NULL THEN 'OTRO_ALMACEN' ELSE 'TRASPASO' END END,
    m.fecha, m.kg, d.almacen, d.lote, m.documento, m.cliente, m.numrel, m.docrel, m.glosa
  FROM f_mov m
  LEFT JOIN f_pair p ON m.kind = 'TRASPASO_SAL' AND p.sal_id = m.id
  LEFT JOIN f_mov d ON d.id = p.ent_id
  WHERE m.kind IN ('SALIDA', 'CONSUMO', 'TRASPASO_SAL') AND m.almacen IS NOT NULL;

  -- Un traspaso emparejado ingresa al destino con el peso del origen (ambos lados deben pesar lo mismo)
  INSERT INTO public.apt_flow_layers (id, almacen, lote, producto, tipo, exit_id, almacen_origen, lote_origen, fecha, documento, glosa, kg_in)
  SELECT m.id, m.almacen, m.lote, m.producto,
    CASE m.kind WHEN 'ENTRADA' THEN 'PRODUCCION' WHEN 'DEVOLUCION' THEN 'DEVOLUCION'
                ELSE CASE WHEN p.sal_id IS NULL THEN 'OTRO_ALMACEN' ELSE 'TRASPASO' END END,
    p.sal_id, s.almacen, s.lote, m.fecha, m.documento, m.glosa, COALESCE(s.kg, m.kg)
  FROM f_mov m
  LEFT JOIN f_pair p ON m.kind = 'TRASPASO_ENT' AND p.ent_id = m.id
  LEFT JOIN f_mov s ON s.id = p.sal_id
  WHERE m.kind IN ('ENTRADA', 'DEVOLUCION', 'TRASPASO_ENT');
  UPDATE public.apt_flow_exits x SET kg = l.kg_in FROM public.apt_flow_layers l WHERE l.exit_id = x.id AND x.kg <> l.kg_in;

  -- Stock inicial: el mínimo saldo previo que evita saldos negativos (en el día, primero ingresos y luego salidas)
  INSERT INTO public.apt_flow_layers (id, almacen, lote, producto, tipo, fecha, kg_in)
  SELECT -row_number() OVER (ORDER BY almacen, lote, producto), almacen, lote, producto, 'INICIAL', NULL, need
  FROM (SELECT almacen, lote, producto, -min(bal) AS need
        FROM (SELECT almacen, lote, producto,
                     sum(q) OVER (PARTITION BY almacen, lote, producto ORDER BY fecha, o, id ROWS UNBOUNDED PRECEDING) AS bal
              FROM (SELECT almacen, lote, producto, fecha, 0 AS o, id, kg_in AS q FROM public.apt_flow_layers
                    UNION ALL
                    SELECT almacen, lote, producto, fecha, 1, id, -kg FROM public.apt_flow_exits) ev) b
        GROUP BY 1, 2, 3) z
  WHERE need > 0.0005;

  -- FIFO por almacén y Lote|Producto: superposición de tramos acumulados (el stock inicial va primero)
  DROP TABLE IF EXISTS pg_temp.f_in;
  DROP TABLE IF EXISTS pg_temp.f_out;
  CREATE TEMP TABLE f_in ON COMMIT DROP AS
    SELECT id, almacen, lote, producto, sum(kg_in) OVER w - kg_in AS c0, sum(kg_in) OVER w AS c1
    FROM public.apt_flow_layers
    WINDOW w AS (PARTITION BY almacen, lote, producto ORDER BY fecha NULLS FIRST, id ROWS UNBOUNDED PRECEDING);
  CREATE INDEX ON f_in (almacen, lote, producto);
  CREATE TEMP TABLE f_out ON COMMIT DROP AS
    SELECT id, almacen, lote, producto, sum(kg) OVER w - kg AS c0, sum(kg) OVER w AS c1
    FROM public.apt_flow_exits
    WINDOW w AS (PARTITION BY almacen, lote, producto ORDER BY fecha, id ROWS UNBOUNDED PRECEDING);
  CREATE INDEX ON f_out (almacen, lote, producto);
  ANALYZE f_in;
  ANALYZE f_out;

  INSERT INTO public.apt_flow_alloc (layer_id, exit_id, kg)
  SELECT i.id, o.id, LEAST(i.c1, o.c1) - GREATEST(i.c0, o.c0)
  FROM f_in i JOIN f_out o ON o.almacen = i.almacen AND o.lote = i.lote AND o.producto = i.producto AND o.c0 < i.c1 AND o.c1 > i.c0
  WHERE LEAST(i.c1, o.c1) - GREATEST(i.c0, o.c0) > 0.000001;

  UPDATE public.apt_flow_layers l SET kg_out = a.kg, kg_saldo = GREATEST(l.kg_in - a.kg, 0)
  FROM (SELECT l2.id, COALESCE(sum(a2.kg), 0) AS kg FROM public.apt_flow_layers l2 LEFT JOIN public.apt_flow_alloc a2 ON a2.layer_id = l2.id
        GROUP BY l2.id) a
  WHERE a.id = l.id;

  -- Composición de cada capa en sus capas raíz (un traspaso hereda la mezcla de lo que consumió en el origen).
  -- Se propaga por rondas: una capa de traspaso se resuelve cuando todas las capas que consumió ya están resueltas.
  DROP TABLE IF EXISTS pg_temp.f_comp;
  DROP TABLE IF EXISTS pg_temp.f_done;
  DROP TABLE IF EXISTS pg_temp.f_src;
  DROP TABLE IF EXISTS pg_temp.f_pend;
  CREATE TEMP TABLE f_comp ON COMMIT DROP AS SELECT id AS layer_id, id AS root_id, kg_in AS kg FROM public.apt_flow_layers WHERE tipo <> 'TRASPASO';
  CREATE INDEX ON f_comp (layer_id);
  CREATE TEMP TABLE f_done ON COMMIT DROP AS SELECT layer_id AS id FROM f_comp;
  CREATE UNIQUE INDEX ON f_done (id);
  CREATE TEMP TABLE f_src ON COMMIT DROP AS
    SELECT t.id AS t_id, a.layer_id AS o_id, a.kg, o.kg_in AS o_kg
    FROM public.apt_flow_layers t JOIN public.apt_flow_alloc a ON a.exit_id = t.exit_id JOIN public.apt_flow_layers o ON o.id = a.layer_id
    WHERE t.tipo = 'TRASPASO';
  CREATE INDEX ON f_src (t_id);
  CREATE INDEX ON f_src (o_id);
  CREATE TEMP TABLE f_pend ON COMMIT DROP AS SELECT DISTINCT t_id FROM f_src;
  CREATE UNIQUE INDEX ON f_pend (t_id);
  ANALYZE f_src;
  LOOP
    v_round := v_round + 1;
    DROP TABLE IF EXISTS pg_temp.f_ready;
    CREATE TEMP TABLE f_ready ON COMMIT DROP AS
      SELECT p.t_id FROM f_pend p
      WHERE NOT EXISTS (SELECT 1 FROM f_src s WHERE s.t_id = p.t_id AND NOT EXISTS (SELECT 1 FROM f_done d WHERE d.id = s.o_id));
    GET DIAGNOSTICS v_n = ROW_COUNT;
    EXIT WHEN v_n = 0 OR v_round > 500;
    INSERT INTO f_comp (layer_id, root_id, kg)
    SELECT s.t_id, c.root_id, sum(s.kg * c.kg / s.o_kg)
    FROM f_ready r JOIN f_src s ON s.t_id = r.t_id JOIN f_comp c ON c.layer_id = s.o_id
    GROUP BY 1, 2;
    INSERT INTO f_done SELECT t_id FROM f_ready;
    DELETE FROM f_pend p USING f_ready r WHERE r.t_id = p.t_id;
  END LOOP;
  -- Un traspaso que no se pudo resolver (ciclo dentro del mismo día) queda como su propia raíz
  INSERT INTO f_comp (layer_id, root_id, kg)
  SELECT id, id, kg_in FROM public.apt_flow_layers l WHERE NOT EXISTS (SELECT 1 FROM f_done d WHERE d.id = l.id);

  -- Piezas: lo que salió del circuito y lo que queda, por capa final y capa raíz
  INSERT INTO public.apt_flow_pieces (es_saldo, exit_id, salida_tipo, fecha_salida, documento, cliente, layer_id, almacen, layer_tipo,
    almacen_previo, fecha_llegada, lote, producto, glosa, root_id, origen, root_almacen, root_lote, fecha_origen, kg)
  SELECT false, x.id, x.tipo, x.fecha, x.documento, x.cliente, l.id, l.almacen, l.tipo, l.almacen_origen, l.fecha,
    x.lote, x.producto, COALESCE(x.glosa, l.glosa), r.id,
    CASE WHEN r.tipo = 'INICIAL' THEN 'INICIAL_' || r.almacen WHEN r.tipo = 'TRASPASO' THEN 'OTRO_ALMACEN' ELSE r.tipo END, r.almacen, r.lote, r.fecha,
    a.kg * c.kg / l.kg_in
  FROM public.apt_flow_exits x
  JOIN public.apt_flow_alloc a ON a.exit_id = x.id
  JOIN public.apt_flow_layers l ON l.id = a.layer_id
  JOIN f_comp c ON c.layer_id = l.id
  JOIN public.apt_flow_layers r ON r.id = c.root_id
  WHERE x.tipo <> 'TRASPASO'
  UNION ALL
  SELECT true, NULL, NULL, NULL, NULL, NULL, l.id, l.almacen, l.tipo, l.almacen_origen, l.fecha,
    l.lote, l.producto, l.glosa, r.id,
    CASE WHEN r.tipo = 'INICIAL' THEN 'INICIAL_' || r.almacen WHEN r.tipo = 'TRASPASO' THEN 'OTRO_ALMACEN' ELSE r.tipo END, r.almacen, r.lote, r.fecha,
    l.kg_saldo * c.kg / l.kg_in
  FROM public.apt_flow_layers l
  JOIN f_comp c ON c.layer_id = l.id
  JOIN public.apt_flow_layers r ON r.id = c.root_id
  WHERE l.kg_saldo > 0.0005;

  -- Cliente del lote: el de más kg en sus guías; si no tiene guías, el de la estadía consolidada
  DROP TABLE IF EXISTS pg_temp.f_cli;
  CREATE TEMP TABLE f_cli ON COMMIT DROP AS
    SELECT DISTINCT ON (lote) lote, cliente FROM (
      SELECT lote, cliente, sum(kg) AS kg, 1 AS pr FROM public.apt_flow_exits WHERE tipo = 'DESPACHO' AND cliente IS NOT NULL GROUP BY 1, 2
      UNION ALL
      SELECT lote, cliente, sum(kg_in), 2 FROM public.apt_layers WHERE cliente IS NOT NULL GROUP BY 1, 2) q
    ORDER BY lote, pr, kg DESC;
  CREATE UNIQUE INDEX ON f_cli (lote);
  UPDATE public.apt_flow_layers l SET cliente = c.cliente FROM f_cli c WHERE c.lote = l.lote;
  UPDATE public.apt_flow_exits x SET cliente = c.cliente FROM f_cli c WHERE x.tipo <> 'DESPACHO' AND x.cliente IS NULL AND c.lote = x.lote;
  UPDATE public.apt_flow_pieces p SET cliente = c.cliente FROM f_cli c WHERE p.cliente IS NULL AND c.lote = p.lote;

  SELECT jsonb_build_object(
    'capas', (SELECT count(*) FROM public.apt_flow_layers),
    'salidas', (SELECT count(*) FROM public.apt_flow_exits),
    'piezas', (SELECT count(*) FROM public.apt_flow_pieces),
    'traspasos_emparejados', (SELECT count(*) FROM f_pair),
    'traspasos_sal', (SELECT count(*) FROM f_mov WHERE kind = 'TRASPASO_SAL'),
    'traspasos_ent', (SELECT count(*) FROM f_mov WHERE kind = 'TRASPASO_ENT'),
    'rondas', v_round,
    'saldo_tn', (SELECT jsonb_object_agg(almacen, tn) FROM (SELECT almacen, round(sum(kg_saldo) / 1000, 3) AS tn
                 FROM public.apt_flow_layers GROUP BY 1) z))
  INTO v_stats;
  UPDATE public.apt_flow_state SET cutoff = v_cut, data_min = v_min, rebuilt_at = clock_timestamp(), stats = v_stats WHERE id = 1;
  RETURN jsonb_build_object('success', true, 'cutoff', v_cut) || v_stats;
END $function$;
REVOKE ALL ON FUNCTION public.apt_flow_rebuild_core() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_flow_rebuild_core() TO service_role;

CREATE OR REPLACE FUNCTION public.apt_flow_st(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r record; v_kpi jsonb; v_mes jsonb; v_det jsonb; v_ret jsonb; v_top jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  p := COALESCE(p, '{}'::jsonb);
  SELECT * INTO r FROM public.apt_flow_range(p);
  IF r.v_cut IS NULL THEN RETURN jsonb_build_object('success', true, 'vacio', true); END IF;

  DROP TABLE IF EXISTS pg_temp.f_st;
  CREATE TEMP TABLE f_st ON COMMIT DROP AS
    SELECT kg, fecha_salida, fecha_salida - fecha_llegada AS d
    FROM public.apt_flow_pieces
    WHERE NOT es_saldo AND salida_tipo = 'DESPACHO' AND almacen = 'ST' AND fecha_llegada IS NOT NULL
      AND fecha_salida BETWEEN r.v_from AND r.v_to AND public.apt_flow_match(p, lote, cliente);

  DROP TABLE IF EXISTS pg_temp.f_ret;
  CREATE TEMP TABLE f_ret ON COMMIT DROP AS
    SELECT x.id, x.fecha, x.lote, x.producto, x.glosa, x.almacen_destino, x.lote_destino, x.documento, x.cliente, x.kg,
           (SELECT round(sum(a.kg * (x.fecha - l.fecha)) / NULLIF(sum(a.kg), 0), 1) FROM public.apt_flow_alloc a
            JOIN public.apt_flow_layers l ON l.id = a.layer_id WHERE a.exit_id = x.id AND l.fecha IS NOT NULL) AS dias_st
    FROM public.apt_flow_exits x
    WHERE x.almacen = 'ST' AND x.tipo IN ('TRASPASO', 'OTRO_ALMACEN') AND x.fecha BETWEEN r.v_from AND r.v_to
      AND public.apt_flow_match(p, x.lote, x.cliente);

  SELECT jsonb_build_object(
    'despacho_tn', (SELECT public.apt_flow_tn(sum(kg)) FROM f_st),
    'mismo_dia_pct', (SELECT round(100.0 * sum(kg) FILTER (WHERE d = 0) / NULLIF(sum(kg), 0), 1) FROM f_st),
    'd1_3_pct', (SELECT round(100.0 * sum(kg) FILTER (WHERE d BETWEEN 1 AND 3) / NULLIF(sum(kg), 0), 1) FROM f_st),
    'mas3_pct', (SELECT round(100.0 * sum(kg) FILTER (WHERE d > 3) / NULLIF(sum(kg), 0), 1) FROM f_st),
    'dias_pond', (SELECT round(sum(kg * d) / NULLIF(sum(kg), 0), 2) FROM f_st),
    'saldo_tn', (SELECT public.apt_flow_tn(sum(kg_saldo)) FROM public.apt_flow_layers WHERE almacen = 'ST' AND public.apt_flow_match(p, lote, cliente)),
    'detenido_tn', (SELECT public.apt_flow_tn(sum(kg_saldo)) FROM public.apt_flow_layers WHERE almacen = 'ST' AND kg_saldo > 0
                    AND (fecha IS NULL OR r.v_cut - fecha >= 1) AND public.apt_flow_match(p, lote, cliente)),
    'detenido_lotes', (SELECT count(DISTINCT lote) FROM public.apt_flow_layers WHERE almacen = 'ST' AND kg_saldo > 0.5
                       AND (fecha IS NULL OR r.v_cut - fecha >= 1) AND public.apt_flow_match(p, lote, cliente)),
    'retorno_tn', (SELECT public.apt_flow_tn(sum(kg)) FROM f_ret),
    'retorno_filas', (SELECT count(*) FROM f_ret),
    'retorno_dias_pond', (SELECT round(sum(kg * dias_st) / NULLIF(sum(kg) FILTER (WHERE dias_st IS NOT NULL), 0), 1) FROM f_ret))
  INTO v_kpi;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('mes', z.mes, 'd0', public.apt_flow_tn(z.d0), 'd1_3', public.apt_flow_tn(z.d13),
           'd4_7', public.apt_flow_tn(z.d47), 'd8', public.apt_flow_tn(z.d8), 'mismo_dia_pct', z.pct,
           'retorno_tn', public.apt_flow_tn((SELECT sum(kg) FROM f_ret WHERE date_trunc('month', fecha) = z.mes))) ORDER BY z.mes), '[]')
  INTO v_mes
  FROM (SELECT date_trunc('month', fecha_salida)::date AS mes, sum(kg) FILTER (WHERE d = 0) AS d0, sum(kg) FILTER (WHERE d BETWEEN 1 AND 3) AS d13,
               sum(kg) FILTER (WHERE d BETWEEN 4 AND 7) AS d47, sum(kg) FILTER (WHERE d > 7) AS d8,
               round(100.0 * sum(kg) FILTER (WHERE d = 0) / NULLIF(sum(kg), 0), 1) AS pct
        FROM f_st GROUP BY 1) z;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('layer_id', l.id, 'lote', l.lote, 'producto', l.producto, 'glosa', l.glosa, 'cliente', l.cliente,
           'desde', l.almacen_origen, 'tipo', l.tipo, 'fecha_llegada', l.fecha, 'dias', r.v_cut - l.fecha, 'documento', l.documento,
           'tn', public.apt_flow_tn(l.kg_saldo)) ORDER BY l.fecha NULLS FIRST, l.kg_saldo DESC), '[]')
  INTO v_det
  FROM (SELECT * FROM public.apt_flow_layers WHERE almacen = 'ST' AND kg_saldo > 0.5 AND public.apt_flow_match(p, lote, cliente)
        ORDER BY fecha NULLS FIRST, kg_saldo DESC LIMIT 400) l;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('fecha', fecha, 'lote', lote, 'lote_destino', lote_destino, 'producto', producto, 'glosa', glosa,
           'hacia', COALESCE(almacen_destino, 'Otro almacén'), 'documento', documento, 'cliente', cliente, 'tn', public.apt_flow_tn(kg), 'dias_st', dias_st)
           ORDER BY fecha DESC, kg DESC), '[]')
  INTO v_ret FROM (SELECT * FROM f_ret ORDER BY fecha DESC, kg DESC LIMIT 400) z;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('lote', lote, 'cliente', cliente, 'veces', n, 'tn', public.apt_flow_tn(kg), 'dias_st', ds) ORDER BY kg DESC), '[]')
  INTO v_top
  FROM (SELECT lote, max(cliente) AS cliente, count(DISTINCT documento) AS n, sum(kg) AS kg,
               round(sum(kg * dias_st) / NULLIF(sum(kg) FILTER (WHERE dias_st IS NOT NULL), 0), 1) AS ds
        FROM f_ret GROUP BY 1 ORDER BY 4 DESC LIMIT 30) z;

  RETURN jsonb_build_object('success', true, 'cutoff', r.v_cut, 'desde', r.v_from, 'hasta', r.v_to,
    'kpis', v_kpi, 'mensual', v_mes, 'detenido', v_det, 'retornos', v_ret, 'retornos_lotes', v_top);
END $function$;
REVOKE ALL ON FUNCTION public.apt_flow_st(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_flow_st(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_flow_stock(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r record; v_alert integer; v_aging jsonb; v_serie jsonb; v_mov jsonb; v_lotes jsonb; v_alm text;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  p := COALESCE(p, '{}'::jsonb);
  SELECT * INTO r FROM public.apt_flow_range(p);
  IF r.v_cut IS NULL THEN RETURN jsonb_build_object('success', true, 'vacio', true); END IF;
  SELECT alert_days INTO v_alert FROM public.apt_settings WHERE id = 1;
  v_alm := NULLIF(btrim(p ->> 'almacen'), '');

  -- Antigüedad desde la producción (o el ingreso de la devolución); el stock inicial no tiene fecha
  SELECT COALESCE(jsonb_agg(jsonb_build_object('almacen', z.almacen, 'rango', z.rango, 'orden', z.orden, 'tn', public.apt_flow_tn(z.kg)) ORDER BY z.almacen, z.orden), '[]')
  INTO v_aging
  FROM (SELECT x.almacen, COALESCE(g.label, 'Stock inicial (sin fecha)') AS rango, COALESCE(g.desde, -1) AS orden, sum(x.kg) AS kg
        FROM public.apt_flow_pieces x
        LEFT JOIN LATERAL (SELECT a.label, a.desde FROM public.apt_aging_ranges a
                           WHERE x.fecha_origen IS NOT NULL AND a.desde <= r.v_cut - x.fecha_origen ORDER BY a.desde DESC LIMIT 1) g ON true
        WHERE x.es_saldo AND public.apt_flow_match(p, x.lote, x.cliente) GROUP BY 1, 2, 3) z;

  -- Saldo semanal por almacén = stock inicial + ingresos − salidas acumulados hasta cada fin de semana
  WITH mv AS MATERIALIZED (SELECT almacen, fecha, kg_in AS q FROM public.apt_flow_layers WHERE tipo <> 'INICIAL' AND public.apt_flow_match(p, lote, cliente)
              UNION ALL SELECT almacen, fecha, -kg FROM public.apt_flow_exits WHERE public.apt_flow_match(p, lote, cliente)),
       ini AS MATERIALIZED (SELECT almacen, sum(kg_in) AS kg FROM public.apt_flow_layers WHERE tipo = 'INICIAL' AND public.apt_flow_match(p, lote, cliente) GROUP BY 1),
       w AS MATERIALIZED (SELECT DISTINCT LEAST(d::date + 6, r.v_cut) AS f FROM generate_series(date_trunc('week', r.v_from), r.v_to, interval '1 week') d),
       wk AS MATERIALIZED (SELECT almacen, LEAST(date_trunc('week', fecha)::date + 6, r.v_cut) AS f, sum(q) AS q FROM mv GROUP BY 1, 2),
       cum AS (SELECT w.f, a.almacen, COALESCE((SELECT kg FROM ini WHERE ini.almacen = a.almacen), 0)
                      + COALESCE((SELECT sum(q) FROM wk WHERE wk.almacen = a.almacen AND (wk.f <= w.f)), 0) AS kg
               FROM w CROSS JOIN (VALUES ('647'), ('540'), ('ST')) a(almacen))
  SELECT COALESCE(jsonb_agg(jsonb_build_object('fecha', f, '647', public.apt_flow_tn(k647), '540', public.apt_flow_tn(k540), 'ST', public.apt_flow_tn(kst)) ORDER BY f), '[]')
  INTO v_serie
  FROM (SELECT f, sum(kg) FILTER (WHERE almacen = '647') AS k647, sum(kg) FILTER (WHERE almacen = '540') AS k540,
               sum(kg) FILTER (WHERE almacen = 'ST') AS kst FROM cum GROUP BY f) z;

  -- Ingresos y salidas por mes y almacén
  SELECT COALESCE(jsonb_agg(jsonb_build_object('mes', z.mes, 'almacen', z.almacen, 'sentido', z.sentido, 'tipo', z.tipo, 'tn', public.apt_flow_tn(z.kg))
         ORDER BY z.mes, z.almacen, z.sentido, z.tipo), '[]')
  INTO v_mov
  FROM (SELECT date_trunc('month', fecha)::date AS mes, almacen, 'INGRESO' AS sentido,
               CASE WHEN tipo = 'TRASPASO' THEN 'DESDE_' || almacen_origen ELSE tipo END AS tipo, sum(kg_in) AS kg
        FROM public.apt_flow_layers WHERE tipo <> 'INICIAL' AND fecha BETWEEN r.v_from AND r.v_to AND public.apt_flow_match(p, lote, cliente) GROUP BY 1, 2, 3, 4
        UNION ALL
        SELECT date_trunc('month', fecha)::date, almacen, 'SALIDA', CASE WHEN tipo = 'TRASPASO' THEN 'HACIA_' || almacen_destino ELSE tipo END, sum(kg)
        FROM public.apt_flow_exits WHERE fecha BETWEEN r.v_from AND r.v_to AND public.apt_flow_match(p, lote, cliente) GROUP BY 1, 2, 3, 4) z;

  -- Lotes con saldo (ordenados por TN × días desde la producción)
  SELECT COALESCE(jsonb_agg(z.j ORDER BY z.txd DESC NULLS LAST, z.kg DESC), '[]') INTO v_lotes
  FROM (SELECT jsonb_build_object('almacen', almacen, 'lote', lote, 'cliente', max(cliente), 'tn', public.apt_flow_tn(sum(kg)),
          'productos', count(DISTINCT producto), 'capas', count(DISTINCT layer_id),
          'fecha_origen_min', min(fecha_origen), 'fecha_llegada_min', min(fecha_llegada),
          'edad_pond', round(sum(kg * (r.v_cut - fecha_origen)) FILTER (WHERE fecha_origen IS NOT NULL) / NULLIF(sum(kg) FILTER (WHERE fecha_origen IS NOT NULL), 0), 1),
          'dias_almacen_pond', round(sum(kg * (r.v_cut - fecha_llegada)) FILTER (WHERE fecha_llegada IS NOT NULL) / NULLIF(sum(kg) FILTER (WHERE fecha_llegada IS NOT NULL), 0), 1),
          'inicial_tn', public.apt_flow_tn(sum(kg) FILTER (WHERE origen LIKE 'INICIAL%')),
          'tn_dias', round(sum(kg / 1000.0 * (r.v_cut - fecha_origen)) FILTER (WHERE fecha_origen IS NOT NULL), 1),
          'alerta', bool_or(r.v_cut - fecha_origen > v_alert)) AS j,
          sum(kg / 1000.0 * (r.v_cut - fecha_origen)) FILTER (WHERE fecha_origen IS NOT NULL) AS txd, sum(kg) AS kg
        FROM public.apt_flow_pieces
        WHERE es_saldo AND (v_alm IS NULL OR almacen = v_alm) AND public.apt_flow_match(p, lote, cliente)
        GROUP BY almacen, lote
        ORDER BY 2 DESC NULLS LAST, 3 DESC LIMIT 300) z;

  RETURN jsonb_build_object('success', true, 'cutoff', r.v_cut, 'desde', r.v_from, 'hasta', r.v_to, 'alert_days', v_alert,
    'resumen', public.apt_flow_cards(p, r.v_cut), 'aging', v_aging, 'serie', v_serie, 'movimientos', v_mov, 'lotes', v_lotes, 'glosas', public.apt_flow_stock_glosas(p, r.v_cut, v_alert, v_alm));
END $function$;
REVOKE ALL ON FUNCTION public.apt_flow_stock(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_flow_stock(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_flow_stock_glosas(p jsonb, p_cut date, p_alert integer, p_almacen text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(jsonb_agg(z.j ORDER BY z.txd DESC NULLS LAST, z.kg DESC), '[]')
  FROM (SELECT jsonb_build_object('almacen', x.almacen, 'glosa', x.etiqueta, 'tn', public.apt_flow_tn(sum(x.kg)),
          'lotes', count(DISTINCT x.lote), 'productos', count(DISTINCT x.producto), 'clientes', count(DISTINCT x.cliente),
          'fecha_origen_min', min(x.fecha_origen), 'fecha_llegada_min', min(x.fecha_llegada),
          'edad_pond', round(sum(x.kg * (p_cut - x.fecha_origen)) FILTER (WHERE x.fecha_origen IS NOT NULL)
                             / NULLIF(sum(x.kg) FILTER (WHERE x.fecha_origen IS NOT NULL), 0), 1),
          'dias_almacen_pond', round(sum(x.kg * (p_cut - x.fecha_llegada)) FILTER (WHERE x.fecha_llegada IS NOT NULL)
                                     / NULLIF(sum(x.kg) FILTER (WHERE x.fecha_llegada IS NOT NULL), 0), 1),
          'inicial_tn', public.apt_flow_tn(sum(x.kg) FILTER (WHERE x.origen LIKE 'INICIAL%')),
          'tn_dias', round(sum(x.kg / 1000.0 * (p_cut - x.fecha_origen)) FILTER (WHERE x.fecha_origen IS NOT NULL), 1),
          'alerta', COALESCE(bool_or(p_cut - x.fecha_origen > p_alert), false)) AS j,
          sum(x.kg / 1000.0 * (p_cut - x.fecha_origen)) FILTER (WHERE x.fecha_origen IS NOT NULL) AS txd, sum(x.kg) AS kg
        FROM (SELECT s.*, COALESCE(NULLIF(btrim(s.glosa), ''), '(Sin glosa) ' || s.producto) AS etiqueta
              FROM public.apt_flow_pieces s
              WHERE s.es_saldo AND (p_almacen IS NULL OR s.almacen = p_almacen) AND public.apt_flow_match(p, s.lote, s.cliente)) x
        GROUP BY x.almacen, x.etiqueta
        ORDER BY 2 DESC NULLS LAST, 3 DESC LIMIT 2000) z;
$function$;
REVOKE ALL ON FUNCTION public.apt_flow_stock_glosas(p jsonb, p_cut date, p_alert integer, p_almacen text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_flow_stock_glosas(p jsonb, p_cut date, p_alert integer, p_almacen text) TO service_role;

CREATE OR REPLACE FUNCTION public.apt_flow_summary(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r record; v_kpi jsonb; v_flows jsonb; v_mes jsonb; v_alm jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  p := COALESCE(p, '{}'::jsonb);
  SELECT * INTO r FROM public.apt_flow_range(p);
  IF r.v_cut IS NULL THEN RETURN jsonb_build_object('success', true, 'vacio', true); END IF;

  -- Conjuntos filtrados una sola vez
  DROP TABLE IF EXISTS pg_temp.s_ly;
  DROP TABLE IF EXISTS pg_temp.s_ex;
  DROP TABLE IF EXISTS pg_temp.s_pc;
  CREATE TEMP TABLE s_ly ON COMMIT DROP AS
    SELECT almacen, tipo, fecha, kg_in, kg_saldo, date_trunc('month', fecha)::date AS mes FROM public.apt_flow_layers
    WHERE public.apt_flow_match(p, lote, cliente);
  CREATE TEMP TABLE s_ex ON COMMIT DROP AS
    SELECT almacen, tipo, fecha, kg, almacen_destino, lote, lote_destino, date_trunc('month', fecha)::date AS mes FROM public.apt_flow_exits
    WHERE fecha BETWEEN r.v_from AND r.v_to AND public.apt_flow_match(p, lote, cliente);
  CREATE TEMP TABLE s_pc ON COMMIT DROP AS
    SELECT es_saldo, salida_tipo, origen, almacen, documento, kg, fecha_salida, fecha_llegada, fecha_origen,
           date_trunc('month', fecha_salida)::date AS mes FROM public.apt_flow_pieces
    WHERE (es_saldo OR (salida_tipo = 'DESPACHO' AND fecha_salida BETWEEN r.v_from AND r.v_to)) AND public.apt_flow_match(p, lote, cliente);

  WITH d AS (SELECT * FROM s_pc WHERE NOT es_saldo),
       dp AS (SELECT * FROM d WHERE origen = 'PRODUCCION')
  SELECT jsonb_build_object(
    'produccion_tn', (SELECT public.apt_flow_tn(sum(kg_in)) FROM s_ly WHERE tipo = 'PRODUCCION' AND fecha BETWEEN r.v_from AND r.v_to),
    'devolucion_tn', (SELECT public.apt_flow_tn(sum(kg_in)) FROM s_ly WHERE tipo = 'DEVOLUCION' AND fecha BETWEEN r.v_from AND r.v_to),
    'despacho_tn', (SELECT public.apt_flow_tn(sum(kg)) FROM d),
    'guias', (SELECT count(DISTINCT documento) FROM d),
    'consumo_tn', (SELECT public.apt_flow_tn(sum(kg)) FROM s_ex WHERE tipo = 'CONSUMO'),
    'otro_almacen_tn', (SELECT public.apt_flow_tn(sum(kg)) FROM s_ex WHERE tipo = 'OTRO_ALMACEN'),
    'trazado_pct', (SELECT round(100.0 * sum(kg) FILTER (WHERE origen = 'PRODUCCION') / NULLIF(sum(kg), 0), 1) FROM d),
    'origen_despacho', (SELECT COALESCE(jsonb_object_agg(origen, tn), '{}') FROM (SELECT origen, public.apt_flow_tn(sum(kg)) AS tn FROM d GROUP BY 1) z),
    'dias_total', (SELECT round(sum(kg * (fecha_salida - fecha_origen)) / NULLIF(sum(kg), 0), 1) FROM dp),
    'dias_previo', (SELECT round(sum(kg * (COALESCE(fecha_llegada, fecha_origen) - fecha_origen)) / NULLIF(sum(kg), 0), 1) FROM dp),
    'dias_final', (SELECT round(sum(kg * (fecha_salida - COALESCE(fecha_llegada, fecha_origen))) / NULLIF(sum(kg), 0), 1) FROM dp),
    'st_mismo_dia_pct', (SELECT round(100.0 * sum(kg) FILTER (WHERE fecha_salida = fecha_llegada) / NULLIF(sum(kg), 0), 1)
                         FROM d WHERE almacen = 'ST' AND fecha_llegada IS NOT NULL),
    'st_detenido_tn', (SELECT public.apt_flow_tn(sum(kg)) FROM s_pc WHERE es_saldo AND almacen = 'ST' AND (fecha_llegada IS NULL OR r.v_cut - fecha_llegada >= 1)),
    'retorno_st_tn', (SELECT public.apt_flow_tn(sum(kg)) FROM s_ex WHERE tipo IN ('TRASPASO', 'OTRO_ALMACEN') AND almacen = 'ST'),
    'cambio_lote_tn', (SELECT public.apt_flow_tn(sum(kg)) FROM s_ex WHERE tipo = 'TRASPASO' AND lote <> lote_destino),
    'asignacion_tn', (SELECT public.apt_flow_tn(sum(kg)) FROM s_ex WHERE tipo = 'TRASPASO' AND lote <> lote_destino AND lote !~ '^[0-9]{5}'))
  INTO v_kpi;

  v_alm := public.apt_flow_cards(p, r.v_cut);

  -- Flujos (origen → destino). INICIAL solo cuando el periodo empieza con los datos; SALDO solo cuando termina en el corte.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('desde', f.desde, 'hacia', f.hacia, 'tn', public.apt_flow_tn(f.kg)) ORDER BY f.kg DESC), '[]')
  INTO v_flows
  FROM (
    SELECT tipo AS desde, almacen AS hacia, sum(kg_in) AS kg FROM s_ly
    WHERE tipo IN ('PRODUCCION', 'DEVOLUCION', 'OTRO_ALMACEN') AND fecha BETWEEN r.v_from AND r.v_to GROUP BY 1, 2
    UNION ALL
    SELECT 'INICIAL', almacen, sum(kg_in) FROM s_ly WHERE tipo = 'INICIAL' AND r.v_from <= r.v_min GROUP BY 1, 2
    UNION ALL
    SELECT almacen, CASE tipo WHEN 'TRASPASO' THEN almacen_destino WHEN 'DESPACHO' THEN 'CLIENTE' WHEN 'CONSUMO' THEN 'CONSUMO' ELSE 'OTRO_ALMACEN' END,
           sum(kg) FROM s_ex GROUP BY 1, 2
    UNION ALL
    SELECT almacen, 'SALDO', sum(kg_saldo) FROM s_ly WHERE r.v_to >= r.v_cut AND kg_saldo > 0 GROUP BY 1, 2) f
  WHERE f.kg > 0.5;

  WITH m AS (SELECT generate_series(date_trunc('month', r.v_from), date_trunc('month', r.v_to), interval '1 month')::date AS mes),
       pr AS (SELECT mes, sum(kg_in) AS kg FROM s_ly WHERE tipo = 'PRODUCCION' AND fecha BETWEEN r.v_from AND r.v_to GROUP BY 1),
       de AS (SELECT mes, jsonb_object_agg(origen, public.apt_flow_tn(kg)) AS j FROM (SELECT mes, origen, sum(kg) AS kg FROM s_pc WHERE NOT es_saldo GROUP BY 1, 2) z GROUP BY 1),
       lt AS (SELECT mes, round(sum(kg * (fecha_salida - fecha_origen)) / NULLIF(sum(kg), 0), 1) AS d FROM s_pc WHERE NOT es_saldo AND origen = 'PRODUCCION' GROUP BY 1),
       tr AS (SELECT mes, jsonb_object_agg(ruta, public.apt_flow_tn(kg)) AS j FROM (SELECT mes, almacen || '→' || almacen_destino AS ruta, sum(kg) AS kg
              FROM s_ex WHERE tipo = 'TRASPASO' GROUP BY 1, 2) z GROUP BY 1),
       co AS (SELECT mes, sum(kg) AS kg FROM s_ex WHERE tipo = 'CONSUMO' GROUP BY 1)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('mes', m.mes, 'produccion_tn', public.apt_flow_tn(pr.kg), 'despacho', COALESCE(de.j, '{}'),
           'traspasos', COALESCE(tr.j, '{}'), 'consumo_tn', public.apt_flow_tn(co.kg), 'dias_total', lt.d) ORDER BY m.mes), '[]')
  INTO v_mes
  FROM m LEFT JOIN pr USING (mes) LEFT JOIN de USING (mes) LEFT JOIN lt USING (mes) LEFT JOIN tr USING (mes) LEFT JOIN co USING (mes);

  RETURN jsonb_build_object('success', true, 'cutoff', r.v_cut, 'data_min', r.v_min, 'desde', r.v_from, 'hasta', r.v_to,
    'rebuilt_at', (SELECT rebuilt_at FROM public.apt_flow_state WHERE id = 1),
    'kpis', v_kpi, 'almacenes', v_alm, 'flujos', v_flows, 'mensual', v_mes);
END $function$;
REVOKE ALL ON FUNCTION public.apt_flow_summary(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_flow_summary(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_flow_tn(kg numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT round(COALESCE(kg, 0) / 1000.0, 3) $function$;
REVOKE ALL ON FUNCTION public.apt_flow_tn(kg numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_flow_tn(kg numeric) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_flow_trace(p_q text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_q text := upper(btrim(COALESCE(p_q, ''))); v_doc text; v_lote text; v_cut date; v_head jsonb; v_lines jsonb; v_events jsonb; v_guias jsonb;
  v_saldo jsonb; v_tms jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  IF length(v_q) < 2 THEN RETURN jsonb_build_object('success', false, 'error', 'Escriba un número de guía o un lote'); END IF;
  SELECT cutoff INTO v_cut FROM public.apt_flow_state WHERE id = 1;

  SELECT documento INTO v_doc FROM public.apt_flow_exits WHERE tipo = 'DESPACHO' AND upper(documento) = v_q LIMIT 1;
  IF v_doc IS NULL THEN
    SELECT lote INTO v_lote FROM (SELECT lote FROM public.apt_flow_layers WHERE lote = v_q UNION ALL SELECT lote FROM public.apt_flow_exits WHERE lote = v_q) z LIMIT 1;
  END IF;

  IF v_doc IS NOT NULL THEN
    SELECT jsonb_build_object('documento', v_doc, 'fecha', min(fecha), 'cliente', max(cliente), 'tn', public.apt_flow_tn(sum(kg)), 'filas', count(*),
             'lotes', jsonb_agg(DISTINCT lote))
      INTO v_head FROM public.apt_flow_exits WHERE tipo = 'DESPACHO' AND documento = v_doc;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('lote', lote, 'producto', producto, 'glosa', glosa, 'origen', origen, 'lote_origen', root_lote,
             'almacen_origen', root_almacen, 'fecha_origen', fecha_origen, 'via', almacen_previo, 'almacen', almacen, 'fecha_llegada', fecha_llegada,
             'fecha_salida', fecha_salida, 'tn', public.apt_flow_tn(kg),
             'dias_total', fecha_salida - fecha_origen, 'dias_previo', COALESCE(fecha_llegada, fecha_origen) - fecha_origen,
             'dias_final', fecha_salida - COALESCE(fecha_llegada, fecha_origen)) ORDER BY lote, producto, fecha_origen NULLS FIRST), '[]')
      INTO v_lines
    FROM (SELECT lote, producto, max(glosa) AS glosa, origen, root_lote, root_almacen, fecha_origen, almacen_previo, almacen, fecha_llegada, fecha_salida, sum(kg) AS kg
          FROM public.apt_flow_pieces WHERE exit_id IN (SELECT id FROM public.apt_flow_exits WHERE tipo = 'DESPACHO' AND documento = v_doc)
          GROUP BY lote, producto, origen, root_lote, root_almacen, fecha_origen, almacen_previo, almacen, fecha_llegada, fecha_salida) z;
    v_tms := public.apt_flow_tms(ARRAY[v_doc]) -> upper(v_doc);
    RETURN jsonb_build_object('success', true, 'modo', 'guia', 'cutoff', v_cut, 'guia', v_head, 'lineas', v_lines, 'tms', v_tms);
  END IF;

  IF v_lote IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(e.j ORDER BY e.fecha NULLS FIRST, e.o, e.tn DESC), '[]') INTO v_events FROM (
      SELECT fecha, 0 AS o, sum(kg_in) AS tn, jsonb_build_object('fecha', fecha, 'evento', CASE tipo WHEN 'PRODUCCION' THEN 'Ingreso de producción'
               WHEN 'TRASPASO' THEN 'Llega por traspaso' WHEN 'DEVOLUCION' THEN 'Devolución / otro ingreso' WHEN 'OTRO_ALMACEN' THEN 'Ingreso desde otro almacén'
               ELSE 'Stock inicial (antes del periodo)' END, 'tipo', tipo, 'almacen', almacen, 'desde', almacen_origen,
               'lote_origen', NULLIF(lote_origen, lote), 'documento', documento, 'tn', public.apt_flow_tn(sum(kg_in)), 'filas', count(*)) AS j
      FROM public.apt_flow_layers WHERE lote = v_lote GROUP BY fecha, tipo, almacen, almacen_origen, lote_origen, documento, lote
      UNION ALL
      SELECT fecha, 1, sum(kg), jsonb_build_object('fecha', fecha, 'evento', CASE tipo WHEN 'TRASPASO' THEN 'Sale por traspaso' WHEN 'DESPACHO' THEN 'Guía al cliente'
               WHEN 'CONSUMO' THEN 'Consumo interno' ELSE 'Salida a otro almacén' END, 'tipo', tipo, 'almacen', almacen, 'hacia', almacen_destino,
               'lote_destino', NULLIF(lote_destino, lote), 'documento', documento, 'cliente', cliente, 'tn', public.apt_flow_tn(sum(kg)), 'filas', count(*))
      FROM public.apt_flow_exits WHERE lote = v_lote GROUP BY fecha, tipo, almacen, almacen_destino, lote_destino, documento, cliente, lote
    ) e;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('almacen', almacen, 'tn', public.apt_flow_tn(kg), 'dias', d) ORDER BY almacen), '[]') INTO v_saldo
    FROM (SELECT almacen, sum(kg_saldo) AS kg, max(v_cut - fecha) AS d FROM public.apt_flow_layers WHERE lote = v_lote AND kg_saldo > 0.0005 GROUP BY 1) z;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('documento', documento, 'fecha', fecha, 'cliente', cliente, 'tn', public.apt_flow_tn(kg)) ORDER BY fecha), '[]')
      INTO v_guias
    FROM (SELECT documento, min(fecha) AS fecha, max(cliente) AS cliente, sum(kg) AS kg FROM public.apt_flow_exits
          WHERE lote = v_lote AND tipo = 'DESPACHO' GROUP BY 1) z;
    v_tms := public.apt_flow_tms(ARRAY(SELECT DISTINCT documento FROM public.apt_flow_exits WHERE lote = v_lote AND tipo = 'DESPACHO' AND documento IS NOT NULL));
    SELECT jsonb_build_object('lote', v_lote, 'cliente', (SELECT max(cliente) FROM public.apt_flow_layers WHERE lote = v_lote),
      'produccion_tn', (SELECT public.apt_flow_tn(sum(kg_in)) FROM public.apt_flow_layers WHERE lote = v_lote AND tipo = 'PRODUCCION'),
      'primera_produccion', (SELECT min(fecha) FROM public.apt_flow_layers WHERE lote = v_lote AND tipo = 'PRODUCCION'),
      'primer_traspaso_st', (SELECT min(fecha) FROM public.apt_flow_layers WHERE lote = v_lote AND almacen = 'ST' AND tipo = 'TRASPASO'),
      'despacho_tn', (SELECT public.apt_flow_tn(sum(kg)) FROM public.apt_flow_exits WHERE lote = v_lote AND tipo = 'DESPACHO'),
      'ultima_guia', (SELECT max(fecha) FROM public.apt_flow_exits WHERE lote = v_lote AND tipo = 'DESPACHO'),
      'saldo_tn', (SELECT public.apt_flow_tn(sum(kg_saldo)) FROM public.apt_flow_layers WHERE lote = v_lote),
      'dias_total', (SELECT round(sum(kg * (fecha_salida - fecha_origen)) / NULLIF(sum(kg), 0), 1) FROM public.apt_flow_pieces
                     WHERE lote = v_lote AND NOT es_saldo AND salida_tipo = 'DESPACHO' AND origen = 'PRODUCCION'))
      INTO v_head;
    RETURN jsonb_build_object('success', true, 'modo', 'lote', 'cutoff', v_cut, 'lote', v_head, 'eventos', v_events, 'saldo', v_saldo,
      'guias', v_guias, 'tms', v_tms);
  END IF;

  RETURN jsonb_build_object('success', true, 'modo', 'buscar', 'cutoff', v_cut,
    'guias', (SELECT COALESCE(jsonb_agg(jsonb_build_object('documento', documento, 'fecha', fecha, 'cliente', cliente, 'tn', public.apt_flow_tn(kg)) ORDER BY fecha DESC), '[]')
              FROM (SELECT documento, max(fecha) AS fecha, max(cliente) AS cliente, sum(kg) AS kg FROM public.apt_flow_exits
                    WHERE tipo = 'DESPACHO' AND documento ILIKE '%' || v_q || '%' GROUP BY 1 ORDER BY 2 DESC LIMIT 15) z),
    'lotes', (SELECT COALESCE(jsonb_agg(jsonb_build_object('lote', lote, 'cliente', cliente, 'tn', public.apt_flow_tn(kg)) ORDER BY kg DESC), '[]')
              FROM (SELECT lote, max(cliente) AS cliente, sum(kg_in) AS kg FROM public.apt_flow_layers
                    WHERE lote ILIKE '%' || v_q || '%' GROUP BY 1 ORDER BY 3 DESC LIMIT 15) z));
END $function$;
REVOKE ALL ON FUNCTION public.apt_flow_trace(p_q text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_flow_trace(p_q text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_gantt(p jsonb DEFAULT '{}'::jsonb, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE st record; v_cut date; v_from date; v_to date; v_alert integer; v_tol numeric;
  v_limit integer := LEAST(50,GREATEST(1,COALESCE(p_limit,25))); v_offset integer := GREATEST(0,COALESCE(p_offset,0));
  v_rows jsonb; v_kpi jsonb; v_priority jsonb; v_series jsonb; v_coverage jsonb; v_total integer; v_max date; v_last_upload timestamptz; v_pending boolean;
  m record; v_fast boolean := false;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success',false,'error','Sin acceso al módulo APT'); END IF;
  p := COALESCE(p,'{}');
  SELECT * INTO st FROM public.apt_flow_state WHERE id=1;
  SELECT max(applied_at) INTO v_last_upload FROM public.apt_uploads WHERE status='APLICADA';
  v_pending := COALESCE(v_last_upload>st.rebuilt_at,v_last_upload IS NOT NULL);
  SELECT * INTO m FROM public.apt_gantt_meta WHERE id=1;
  IF m.flow_rebuilt_at IS NOT NULL AND m.flow_rebuilt_at = st.rebuilt_at THEN v_max := m.data_max;
  ELSE SELECT max(fecha) INTO v_max FROM public.apt_movements WHERE active AND valid; END IF;
  SELECT COALESCE(alert_days,60),COALESCE(tolerance,0.02) INTO v_alert,v_tol FROM public.apt_settings WHERE id=1;
  v_alert := COALESCE(v_alert,60); v_tol := COALESCE(v_tol,0.02);
  IF st.cutoff IS NULL THEN
    RETURN jsonb_build_object('success',true,'vacio',true,'cutoff',NULL,'data_min',NULL,'data_max',v_max,'model_cutoff',NULL,'requested_cutoff',NULLIF(p->>'corte',''),'age_basis','ORIGEN','desde',NULL,'hasta',NULL,'rebuilt_at',st.rebuilt_at,'model_pending',v_pending,'last_upload_at',v_last_upload,
      'alert_days',v_alert,'tolerance',v_tol,'total',0,'limit',v_limit,'offset',v_offset,'filas','[]'::jsonb,'prioridades','[]'::jsonb,'serie','[]'::jsonb,'cobertura',COALESCE(m.coverage,'[]'::jsonb),
      'kpis',jsonb_build_object('lotes',0,'ot',0,'abiertas',0,'ingresadas_tn',0,'inicial_tn',0,'asignadas_tn',0,'cedidas_tn',0,'despachadas_tn',0,'saldo_tn',0,'criticas_tn',0,'sin_fecha_tn',0,'edad_ponderada',NULL,'tn_dias',0));
  END IF;
  BEGIN
    v_cut := LEAST(st.cutoff,COALESCE(NULLIF(p->>'corte','')::date,st.cutoff));
    v_from := COALESCE(NULLIF(p->>'desde','')::date,st.data_min);
    v_to := LEAST(v_cut,COALESCE(NULLIF(p->>'hasta','')::date,v_cut));
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RETURN jsonb_build_object('success',false,'error','Fecha inválida');
  END;
  IF v_cut < st.data_min OR v_from > v_to THEN RETURN jsonb_build_object('success',false,'error','Seleccione fechas dentro de la cobertura del modelo'); END IF;
  IF NULLIF(p->>'almacen','') IS NOT NULL AND p->>'almacen' NOT IN ('647','540','ST') THEN RETURN jsonb_build_object('success',false,'error','Almacén inválido'); END IF;
  IF NULLIF(p->>'estado','') IS NOT NULL AND p->>'estado' NOT IN ('CON_SALDO','PARCIAL','DESPACHADO','SALIDA_NO_ENTREGA','RESIDUAL') THEN RETURN jsonb_build_object('success',false,'error','Estado inválido'); END IF;
  -- Al corte del modelo se lee el resumen por lote precalculado en el recálculo (apt_gantt_refresh):
  -- no se recorre todo el historial en cada consulta. Otros cortes se calculan en vivo.
  v_fast := m.flow_rebuilt_at IS NOT NULL AND m.flow_rebuilt_at = st.rebuilt_at AND m.cutoff = st.cutoff
    AND m.alert_days = v_alert AND v_cut = st.cutoff;
  DROP TABLE IF EXISTS pg_temp.apt_gantt_layers,pg_temp.apt_gantt_exits,pg_temp.apt_gantt_rows,pg_temp.apt_gantt_page;
  IF v_fast THEN
    CREATE TEMP TABLE apt_gantt_rows ON COMMIT DROP AS
    WITH z AS (SELECT g.lote,g.ot,g.cliente,g.productos,g.ingreso,g.inicial,g.asignado,g.despacho,g.otro,g.cedido,g.saldo,g.desconocido,
        g.primera,g.ultima,g.primera_salida,g.age_kg_days,g.age_kg,g.critico_kg,
        (NULLIF(p->>'almacen','') IS NULL OR COALESCE(p->>'almacen'=ANY(g.almacenes),false)) AS en_almacen
      FROM public.apt_gantt_lotes g
      WHERE (NULLIF(p->>'ot','') IS NULL OR g.ot=btrim(p->>'ot'))
        AND (NULLIF(p->>'lote_exacto','') IS NULL OR g.lote=btrim(p->>'lote_exacto'))
        AND (NULLIF(p->>'lote','') IS NULL OR g.lote ILIKE '%'||btrim(p->>'lote')||'%')),
    classified AS (SELECT z.*,CASE WHEN saldo<=0.0005 THEN CASE WHEN despacho>0 AND otro+cedido=0 THEN 'DESPACHADO' ELSE 'SALIDA_NO_ENTREGA' END
      WHEN saldo<=GREATEST(ingreso+inicial+asignado,0)*v_tol THEN 'RESIDUAL'
      WHEN despacho>0 THEN 'PARCIAL' ELSE 'CON_SALDO' END AS estado,
      (COALESCE(critico_kg,0)>0.0005) AS critico,
      CASE WHEN saldo>0.0005 THEN v_cut-primera ELSE ultima-primera END AS dias,
      round(age_kg_days/NULLIF(age_kg,0),1) AS edad_ponderada,
      round(COALESCE(age_kg_days,0)/1000,3) AS tn_dias FROM z)
    SELECT * FROM classified WHERE (NULLIF(p->>'cliente','') IS NULL OR cliente ILIKE '%'||btrim(p->>'cliente')||'%')
      AND (NULLIF(p->>'almacen','') IS NULL OR en_almacen)
      AND (NULLIF(p->>'estado','') IS NULL OR estado=p->>'estado')
      AND (primera IS NULL OR primera<=v_to) AND (saldo>0.0005 OR ultima>=v_from);
  ELSE
  CREATE TEMP TABLE apt_gantt_layers ON COMMIT DROP AS
    SELECT l.*,GREATEST(l.kg_in-COALESCE(a.kg,0),0) AS saldo_corte,a.ultima_salida,
      public.apt_ot_raiz(l.lote) AS ot
    FROM public.apt_flow_layers l
    LEFT JOIN (SELECT a.layer_id,sum(a.kg) AS kg,max(e.fecha) AS ultima_salida
      FROM public.apt_flow_alloc a JOIN public.apt_flow_exits e ON e.id=a.exit_id WHERE e.fecha<=v_cut GROUP BY a.layer_id) a ON a.layer_id=l.id
    WHERE (l.fecha IS NULL OR l.fecha<=v_cut)
      AND (NULLIF(p->>'ot','') IS NULL OR public.apt_ot_raiz(l.lote)=btrim(p->>'ot'))
      AND (NULLIF(p->>'lote_exacto','') IS NULL OR l.lote=btrim(p->>'lote_exacto'))
      AND (NULLIF(p->>'lote','') IS NULL OR l.lote ILIKE '%'||btrim(p->>'lote')||'%');
  CREATE INDEX ON apt_gantt_layers(lote);
  CREATE TEMP TABLE apt_gantt_exits ON COMMIT DROP AS
    SELECT e.* FROM public.apt_flow_exits e WHERE e.fecha<=v_cut
      AND (NULLIF(p->>'ot','') IS NULL OR public.apt_ot_raiz(e.lote)=btrim(p->>'ot'))
      AND (NULLIF(p->>'lote_exacto','') IS NULL OR e.lote=btrim(p->>'lote_exacto'))
      AND (NULLIF(p->>'lote','') IS NULL OR e.lote ILIKE '%'||btrim(p->>'lote')||'%');
  CREATE INDEX ON apt_gantt_exits(lote);
  CREATE TEMP TABLE apt_gantt_rows ON COMMIT DROP AS
    WITH ly AS (SELECT lote,max(ot) AS ot,max(cliente) AS cliente,count(DISTINCT producto) AS productos,
      sum(kg_in) FILTER(WHERE tipo NOT IN ('TRASPASO','INICIAL')) AS ingreso,
      sum(kg_in) FILTER(WHERE tipo='INICIAL') AS inicial,
      sum(kg_in) FILTER(WHERE tipo='TRASPASO' AND lote_origen IS DISTINCT FROM lote) AS asignado,
      sum(saldo_corte) AS saldo,sum(saldo_corte) FILTER(WHERE fecha IS NULL) AS desconocido,
      min(fecha) AS primera,max(fecha) AS ultima,
      sum(saldo_corte*(v_cut-fecha)) FILTER(WHERE fecha IS NOT NULL) AS age_kg_days,
      sum(saldo_corte) FILTER(WHERE fecha IS NOT NULL) AS age_kg,
      COALESCE(sum(saldo_corte) FILTER(WHERE fecha IS NOT NULL AND v_cut-fecha>=v_alert),0) AS critico_kg,
      bool_or(almacen=COALESCE(NULLIF(p->>'almacen',''),almacen)) AS en_almacen
      FROM apt_gantt_layers GROUP BY lote),
    ex AS (SELECT lote,max(cliente) AS cliente,min(fecha) AS primera,max(fecha) AS ultima,
      sum(kg) FILTER(WHERE tipo='DESPACHO') AS despacho,
      sum(kg) FILTER(WHERE tipo IN ('CONSUMO','OTRO_ALMACEN')) AS otro,
      sum(kg) FILTER(WHERE tipo='TRASPASO' AND lote_destino IS DISTINCT FROM lote) AS cedido,
      min(fecha) FILTER(WHERE tipo='DESPACHO') AS primera_salida FROM apt_gantt_exits GROUP BY lote),
    z AS (SELECT COALESCE(ly.lote,ex.lote) AS lote,COALESCE(ly.ot,public.apt_ot_raiz(ex.lote)) AS ot,
      COALESCE(ly.cliente,ex.cliente) AS cliente,COALESCE(ly.productos,0) AS productos,
      COALESCE(ingreso,0) AS ingreso,COALESCE(inicial,0) AS inicial,COALESCE(asignado,0) AS asignado,
      COALESCE(despacho,0) AS despacho,COALESCE(otro,0) AS otro,COALESCE(cedido,0) AS cedido,
      COALESCE(saldo,0) AS saldo,COALESCE(desconocido,0) AS desconocido,
      LEAST(ly.primera,ex.primera) AS primera,GREATEST(ly.ultima,ex.ultima) AS ultima,ex.primera_salida,
      ly.age_kg_days,ly.age_kg,ly.critico_kg,COALESCE(ly.en_almacen,false) AS en_almacen
      FROM ly FULL JOIN ex USING(lote)),
    classified AS (SELECT z.*,CASE WHEN saldo<=0.0005 THEN CASE WHEN despacho>0 AND otro+cedido=0 THEN 'DESPACHADO' ELSE 'SALIDA_NO_ENTREGA' END
      WHEN saldo<=GREATEST(ingreso+inicial+asignado,0)*v_tol THEN 'RESIDUAL'
      WHEN despacho>0 THEN 'PARCIAL' ELSE 'CON_SALDO' END AS estado,
      (COALESCE(critico_kg,0)>0.0005) AS critico,
      CASE WHEN saldo>0.0005 THEN v_cut-primera ELSE ultima-primera END AS dias,
      round(age_kg_days/NULLIF(age_kg,0),1) AS edad_ponderada,
      round(COALESCE(age_kg_days,0)/1000,3) AS tn_dias FROM z)
    SELECT * FROM classified WHERE (NULLIF(p->>'cliente','') IS NULL OR cliente ILIKE '%'||btrim(p->>'cliente')||'%')
      AND (NULLIF(p->>'almacen','') IS NULL OR en_almacen)
      AND (NULLIF(p->>'estado','') IS NULL OR estado=p->>'estado')
      AND (primera IS NULL OR primera<=v_to) AND (saldo>0.0005 OR ultima>=v_from);
  -- Root composition is persisted only for final circuit exits and current balances.
  -- At the model cut it preserves age through transfers; historical intermediate
  -- balances have no persisted root composition and are explicitly stage age.
  IF v_cut=st.cutoff THEN
    UPDATE apt_gantt_rows r SET
      age_kg_days=a.days_kg,age_kg=a.known_kg,desconocido=a.unknown_kg,
      critico_kg=a.critical_kg,critico=a.critical_kg>0.0005,
      edad_ponderada=round(a.days_kg/NULLIF(a.known_kg,0),1),tn_dias=round(a.days_kg/1000,3)
    FROM (SELECT lote,COALESCE(sum(kg*GREATEST(v_cut-fecha_origen,0)) FILTER(WHERE fecha_origen IS NOT NULL AND fecha_origen<=v_cut),0) AS days_kg,
      COALESCE(sum(kg) FILTER(WHERE fecha_origen IS NOT NULL AND fecha_origen<=v_cut),0) AS known_kg,
      COALESCE(sum(kg) FILTER(WHERE fecha_origen IS NULL OR fecha_origen>v_cut),0) AS unknown_kg,
      COALESCE(sum(kg) FILTER(WHERE fecha_origen IS NOT NULL AND v_cut-fecha_origen>=v_alert),0) AS critical_kg
      FROM public.apt_flow_pieces WHERE es_saldo GROUP BY lote) a WHERE r.lote=a.lote;
  END IF;
  END IF;
  IF COALESCE(p->>'solo_criticos','false')='true' THEN DELETE FROM apt_gantt_rows WHERE NOT critico; END IF;
  SELECT count(*) INTO v_total FROM apt_gantt_rows;
  CREATE TEMP TABLE apt_gantt_page ON COMMIT DROP AS SELECT * FROM apt_gantt_rows ORDER BY critico DESC,tn_dias DESC NULLS LAST,lote LIMIT v_limit OFFSET v_offset;
  IF v_fast THEN
    -- Capas y salidas solo de los lotes de la página (recorrido y eventos del Gantt).
    CREATE TEMP TABLE apt_gantt_layers ON COMMIT DROP AS
      SELECT l.*,GREATEST(l.kg_in-COALESCE(a.kg,0),0) AS saldo_corte,a.ultima_salida,public.apt_ot_raiz(l.lote) AS ot
      FROM public.apt_flow_layers l
      LEFT JOIN LATERAL (SELECT sum(x.kg) AS kg,max(e.fecha) AS ultima_salida FROM public.apt_flow_alloc x
        JOIN public.apt_flow_exits e ON e.id=x.exit_id WHERE x.layer_id=l.id AND e.fecha<=v_cut) a ON true
      WHERE l.lote IN (SELECT lote FROM apt_gantt_page) AND (l.fecha IS NULL OR l.fecha<=v_cut);
    CREATE TEMP TABLE apt_gantt_exits ON COMMIT DROP AS
      SELECT e.* FROM public.apt_flow_exits e WHERE e.lote IN (SELECT lote FROM apt_gantt_page) AND e.fecha<=v_cut;
  END IF;
  SELECT jsonb_build_object('lotes',count(*),'ot',count(DISTINCT ot),'abiertas',count(*) FILTER(WHERE saldo>0.0005),
    'ingresadas_tn',round(COALESCE(sum(ingreso),0)/1000,3),'inicial_tn',round(COALESCE(sum(inicial),0)/1000,3),
    'asignadas_tn',round(COALESCE(sum(asignado),0)/1000,3),'cedidas_tn',round(COALESCE(sum(cedido),0)/1000,3),
    'despachadas_tn',round(COALESCE(sum(despacho),0)/1000,3),'saldo_tn',round(COALESCE(sum(saldo),0)/1000,3),
    'criticas_tn',round(COALESCE(sum(critico_kg),0)/1000,3),'sin_fecha_tn',round(COALESCE(sum(desconocido),0)/1000,3),
    'edad_ponderada',round(sum(age_kg_days)/NULLIF(sum(age_kg),0),1),'tn_dias',COALESCE(sum(tn_dias),0)) INTO v_kpi FROM apt_gantt_rows;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('lote',lote,'ot',ot,'cliente',cliente,'saldo_tn',round(saldo/1000,3),'dias',dias,'tn_dias',COALESCE(tn_dias,0),
    'motivo',CASE WHEN desconocido>0 THEN 'Saldo con fecha de origen desconocida' WHEN critico THEN 'Permanencia sobre el límite' ELSE 'Saldo pendiente de liberar' END) ORDER BY critico DESC,tn_dias DESC NULLS LAST,lote),'[]')
    INTO v_priority FROM (SELECT * FROM apt_gantt_rows WHERE saldo>0.0005 ORDER BY critico DESC,tn_dias DESC NULLS LAST,lote LIMIT 8) q;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('lote',q.lote,'ot',q.ot,'cliente',q.cliente,'productos',q.productos,
    'ingresadas_tn',round(q.ingreso/1000,3),'inicial_tn',round(q.inicial/1000,3),'asignadas_tn',round(q.asignado/1000,3),'cedidas_tn',round(q.cedido/1000,3),
    'despachadas_tn',round(q.despacho/1000,3),'otras_salidas_tn',round(q.otro/1000,3),'saldo_tn',round(q.saldo/1000,3),'saldo_sin_fecha_tn',round(q.desconocido/1000,3),
    'fecha_entrega_min',pr.min_fecha,'fecha_entrega_max',pr.max_fecha,'fechas_entrega_total',pr.n,
    'primera_fecha',q.primera,'ultima_fecha',q.ultima,'primera_salida',q.primera_salida,'dias',q.dias,'edad_ponderada',q.edad_ponderada,
    'tn_dias',COALESCE(q.tn_dias,0),'estado',q.estado,'critico',q.critico,
    'segmentos_total',sg.n,'segmentos',sg.j,'eventos_total',ev.n,'eventos',ev.j) ORDER BY q.critico DESC,q.tn_dias DESC NULLS LAST,q.lote),'[]')
  INTO v_rows FROM apt_gantt_page q
  CROSS JOIN LATERAL (SELECT min(fecha_entrega) AS min_fecha,max(fecha_entrega) AS max_fecha,count(DISTINCT fecha_entrega) AS n
    FROM public.apt_movements WHERE active AND valid AND lote=q.lote AND fecha<=v_cut) pr
  CROSS JOIN LATERAL (SELECT count(*) AS n,COALESCE(jsonb_agg(j ORDER BY fecha NULLS FIRST,almacen,producto) FILTER(WHERE rn<=120),'[]') AS j
    FROM (SELECT fecha,almacen,producto,row_number() OVER(ORDER BY fecha NULLS FIRST,almacen,producto,tipo,documento) AS rn,
      jsonb_build_object('almacen',almacen,'producto',producto,'tipo',tipo,'desde',fecha,
        'hasta',CASE WHEN sum(saldo_corte)>0.0005 THEN v_cut ELSE COALESCE(max(ultima_salida),fecha,v_cut) END,
        'ingresadas_tn',round(sum(kg_in)/1000,3),'saldo_tn',round(sum(saldo_corte)/1000,3),
        'dias',CASE WHEN fecha IS NULL THEN NULL ELSE (CASE WHEN sum(saldo_corte)>0.0005 THEN v_cut ELSE COALESCE(max(ultima_salida),fecha) END)-fecha END,
        'abierto',sum(saldo_corte)>0.0005,'documento',documento,'precision','FIFO','capas',count(*)) AS j
      FROM apt_gantt_layers WHERE lote=q.lote GROUP BY fecha,almacen,producto,tipo,documento) s) sg
  CROSS JOIN LATERAL (SELECT count(*) AS n,COALESCE(jsonb_agg(j ORDER BY fecha NULLS FIRST,sentido,documento) FILTER(WHERE rn<=200),'[]') AS j
    FROM (SELECT *,row_number() OVER(ORDER BY fecha NULLS FIRST,sentido,documento,tipo,almacen,lote_rel) AS rn,
      jsonb_build_object('fecha',fecha,'tipo',tipo,'almacen',almacen,'documento',documento,'tn',round(kg/1000,3),
        'sentido',sentido,'lote_rel',lote_rel,'precision',CASE WHEN tipo='INICIAL' THEN 'INFERIDO' ELSE 'DOCUMENTAL' END) AS j
      FROM (SELECT fecha,tipo,almacen,documento,'INGRESO'::text AS sentido,NULLIF(lote_origen,lote) AS lote_rel,sum(kg_in) AS kg
        FROM apt_gantt_layers WHERE lote=q.lote GROUP BY fecha,tipo,almacen,documento,lote_origen,lote
        UNION ALL SELECT fecha,tipo,almacen,documento,'SALIDA',NULLIF(lote_destino,lote),sum(kg)
        FROM apt_gantt_exits WHERE lote=q.lote GROUP BY fecha,tipo,almacen,documento,lote_destino,lote) m) e) ev;
  -- Serie de saldo: un acumulado por fecha calculado una sola vez (antes se recalculaba por cada punto
  -- del gráfico y superaba el statement_timeout de authenticated con la data completa).
  IF v_fast THEN
  WITH movement AS MATERIALIZED (SELECT d.fecha,sum(d.kg) AS kg FROM public.apt_gantt_daily d JOIN apt_gantt_rows r USING(lote) GROUP BY d.fecha),
    sin_fecha AS (SELECT COALESCE(sum(kg),0) AS kg FROM movement WHERE fecha IS NULL),
    acumulado AS MATERIALIZED (SELECT fecha,sum(sum(kg)) OVER(ORDER BY fecha) AS kg FROM movement WHERE fecha IS NOT NULL GROUP BY fecha),
    points AS (SELECT DISTINCT LEAST(d::date,v_to) AS fecha FROM generate_series(v_from,v_to,GREATEST(1,CEIL((v_to-v_from+1)/120.0))::integer*interval '1 day') d UNION SELECT v_to)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('fecha',p.fecha,'saldo_tn',round((s.kg+COALESCE((SELECT a.kg FROM acumulado a WHERE a.fecha<=p.fecha ORDER BY a.fecha DESC LIMIT 1),0))/1000,3)) ORDER BY p.fecha),'[]') INTO v_series
    FROM points p CROSS JOIN sin_fecha s;
  ELSE
  WITH movement AS MATERIALIZED (SELECT l.fecha,sum(l.kg_in) AS kg FROM apt_gantt_layers l JOIN apt_gantt_rows r USING(lote) GROUP BY l.fecha
    UNION ALL SELECT e.fecha,-sum(e.kg) FROM apt_gantt_exits e JOIN apt_gantt_rows r USING(lote) GROUP BY e.fecha),
    sin_fecha AS (SELECT COALESCE(sum(kg),0) AS kg FROM movement WHERE fecha IS NULL),
    acumulado AS MATERIALIZED (SELECT fecha,sum(sum(kg)) OVER(ORDER BY fecha) AS kg FROM movement WHERE fecha IS NOT NULL GROUP BY fecha),
    points AS (SELECT DISTINCT LEAST(d::date,v_to) AS fecha FROM generate_series(v_from,v_to,GREATEST(1,CEIL((v_to-v_from+1)/120.0))::integer*interval '1 day') d UNION SELECT v_to)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('fecha',p.fecha,'saldo_tn',round((s.kg+COALESCE((SELECT a.kg FROM acumulado a WHERE a.fecha<=p.fecha ORDER BY a.fecha DESC LIMIT 1),0))/1000,3)) ORDER BY p.fecha),'[]') INTO v_series
    FROM points p CROSS JOIN sin_fecha s;
  END IF;
  IF v_fast THEN v_coverage := COALESCE(m.coverage,'[]'::jsonb);
  ELSE
  SELECT COALESCE(jsonb_agg(jsonb_build_object('tipo',kind,'desde',f0,'hasta',f1,'filas',n,'sin_peso',sp) ORDER BY kind),'[]') INTO v_coverage
    FROM (SELECT kind,min(fecha) AS f0,max(fecha) AS f1,count(*) AS n,count(*) FILTER(WHERE peso_kg IS NULL OR peso_kg<=0) AS sp
      FROM public.apt_movements WHERE active AND valid GROUP BY kind) c;
  END IF;
  RETURN jsonb_build_object('success',true,'cutoff',v_cut,'data_min',st.data_min,'data_max',v_max,'model_cutoff',st.cutoff,'requested_cutoff',NULLIF(p->>'corte',''),'age_basis',CASE WHEN v_cut=st.cutoff THEN 'ORIGEN' ELSE 'ALMACEN' END,'desde',v_from,'hasta',v_to,'rebuilt_at',st.rebuilt_at,'model_pending',v_pending,'last_upload_at',v_last_upload,
    'alert_days',v_alert,'tolerance',v_tol,'total',v_total,'limit',v_limit,'offset',v_offset,'kpis',v_kpi,'filas',v_rows,
    'prioridades',v_priority,'serie',v_series,'cobertura',v_coverage);
END $function$;
REVOKE ALL ON FUNCTION public.apt_gantt(p jsonb, p_limit integer, p_offset integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_gantt(p jsonb, p_limit integer, p_offset integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_gantt_meta_movements()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  UPDATE public.apt_gantt_meta SET
    data_max=(SELECT max(fecha) FROM public.apt_movements WHERE active AND valid),
    coverage=(SELECT COALESCE(jsonb_agg(jsonb_build_object('tipo',kind,'desde',f0,'hasta',f1,'filas',n,'sin_peso',sp) ORDER BY kind),'[]')
      FROM (SELECT kind,min(fecha) AS f0,max(fecha) AS f1,count(*) AS n,count(*) FILTER(WHERE peso_kg IS NULL OR peso_kg<=0) AS sp
        FROM public.apt_movements WHERE active AND valid GROUP BY kind) c)
  WHERE id=1;
$function$;
REVOKE ALL ON FUNCTION public.apt_gantt_meta_movements() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_gantt_meta_movements() TO service_role;

CREATE OR REPLACE FUNCTION public.apt_gantt_meta_uploads_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN PERFORM public.apt_gantt_meta_movements(); RETURN NULL; END $function$;
REVOKE ALL ON FUNCTION public.apt_gantt_meta_uploads_trigger() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_gantt_meta_uploads_trigger() TO service_role;

CREATE OR REPLACE FUNCTION public.apt_gantt_refresh()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE st record; v_cut date; v_alert integer;
BEGIN
  SELECT * INTO st FROM public.apt_flow_state WHERE id=1;
  SELECT COALESCE(alert_days,60) INTO v_alert FROM public.apt_settings WHERE id=1;
  v_alert := COALESCE(v_alert,60); v_cut := st.cutoff;
  DELETE FROM public.apt_gantt_lotes WHERE true; DELETE FROM public.apt_gantt_daily WHERE true;
  IF v_cut IS NOT NULL THEN
    DROP TABLE IF EXISTS pg_temp.apt_gr_layers, pg_temp.apt_gr_exits;
    CREATE TEMP TABLE apt_gr_layers ON COMMIT DROP AS
      SELECT l.*,GREATEST(l.kg_in-COALESCE(a.kg,0),0) AS saldo_corte,a.ultima_salida,public.apt_ot_raiz(l.lote) AS ot
      FROM public.apt_flow_layers l
      LEFT JOIN (SELECT a.layer_id,sum(a.kg) AS kg,max(e.fecha) AS ultima_salida
        FROM public.apt_flow_alloc a JOIN public.apt_flow_exits e ON e.id=a.exit_id WHERE e.fecha<=v_cut GROUP BY a.layer_id) a ON a.layer_id=l.id
      WHERE l.fecha IS NULL OR l.fecha<=v_cut;
    CREATE TEMP TABLE apt_gr_exits ON COMMIT DROP AS SELECT e.* FROM public.apt_flow_exits e WHERE e.fecha<=v_cut;
    INSERT INTO public.apt_gantt_lotes
    WITH ly AS (SELECT lote,max(ot) AS ot,max(cliente) AS cliente,count(DISTINCT producto) AS productos,
      sum(kg_in) FILTER(WHERE tipo NOT IN ('TRASPASO','INICIAL')) AS ingreso,
      sum(kg_in) FILTER(WHERE tipo='INICIAL') AS inicial,
      sum(kg_in) FILTER(WHERE tipo='TRASPASO' AND lote_origen IS DISTINCT FROM lote) AS asignado,
      sum(saldo_corte) AS saldo,sum(saldo_corte) FILTER(WHERE fecha IS NULL) AS desconocido,
      min(fecha) AS primera,max(fecha) AS ultima,
      sum(saldo_corte*(v_cut-fecha)) FILTER(WHERE fecha IS NOT NULL) AS age_kg_days,
      sum(saldo_corte) FILTER(WHERE fecha IS NOT NULL) AS age_kg,
      COALESCE(sum(saldo_corte) FILTER(WHERE fecha IS NOT NULL AND v_cut-fecha>=v_alert),0) AS critico_kg,
      array_agg(DISTINCT almacen) FILTER(WHERE almacen IS NOT NULL) AS almacenes
      FROM apt_gr_layers GROUP BY lote),
    ex AS (SELECT lote,max(cliente) AS cliente,min(fecha) AS primera,max(fecha) AS ultima,
      sum(kg) FILTER(WHERE tipo='DESPACHO') AS despacho,
      sum(kg) FILTER(WHERE tipo IN ('CONSUMO','OTRO_ALMACEN')) AS otro,
      sum(kg) FILTER(WHERE tipo='TRASPASO' AND lote_destino IS DISTINCT FROM lote) AS cedido,
      min(fecha) FILTER(WHERE tipo='DESPACHO') AS primera_salida FROM apt_gr_exits GROUP BY lote)
    SELECT COALESCE(ly.lote,ex.lote),COALESCE(ly.ot,public.apt_ot_raiz(ex.lote)),
      COALESCE(ly.cliente,ex.cliente),COALESCE(ly.productos,0),
      COALESCE(ingreso,0),COALESCE(inicial,0),COALESCE(asignado,0),
      COALESCE(despacho,0),COALESCE(otro,0),COALESCE(cedido,0),
      COALESCE(saldo,0),COALESCE(desconocido,0),
      LEAST(ly.primera,ex.primera),GREATEST(ly.ultima,ex.ultima),ex.primera_salida,
      ly.age_kg_days,ly.age_kg,ly.critico_kg,ly.almacenes
    FROM ly FULL JOIN ex USING(lote);
    UPDATE public.apt_gantt_lotes r SET age_kg_days=a.days_kg,age_kg=a.known_kg,desconocido=a.unknown_kg,critico_kg=a.critical_kg
    FROM (SELECT lote,COALESCE(sum(kg*GREATEST(v_cut-fecha_origen,0)) FILTER(WHERE fecha_origen IS NOT NULL AND fecha_origen<=v_cut),0) AS days_kg,
      COALESCE(sum(kg) FILTER(WHERE fecha_origen IS NOT NULL AND fecha_origen<=v_cut),0) AS known_kg,
      COALESCE(sum(kg) FILTER(WHERE fecha_origen IS NULL OR fecha_origen>v_cut),0) AS unknown_kg,
      COALESCE(sum(kg) FILTER(WHERE fecha_origen IS NOT NULL AND v_cut-fecha_origen>=v_alert),0) AS critical_kg
      FROM public.apt_flow_pieces WHERE es_saldo GROUP BY lote) a WHERE r.lote=a.lote;
    INSERT INTO public.apt_gantt_daily (lote,fecha,kg)
      SELECT lote,fecha,sum(kg_in) FROM apt_gr_layers GROUP BY lote,fecha
      UNION ALL SELECT lote,fecha,-sum(kg) FROM apt_gr_exits GROUP BY lote,fecha;
  END IF;
  UPDATE public.apt_gantt_meta SET flow_rebuilt_at=st.rebuilt_at, cutoff=v_cut, alert_days=v_alert, built_at=now(),
    data_max=(SELECT max(fecha) FROM public.apt_movements WHERE active AND valid),
    coverage=(SELECT COALESCE(jsonb_agg(jsonb_build_object('tipo',kind,'desde',f0,'hasta',f1,'filas',n,'sin_peso',sp) ORDER BY kind),'[]')
      FROM (SELECT kind,min(fecha) AS f0,max(fecha) AS f1,count(*) AS n,count(*) FILTER(WHERE peso_kg IS NULL OR peso_kg<=0) AS sp
        FROM public.apt_movements WHERE active AND valid GROUP BY kind) c)
  WHERE id=1;
END $function$;
REVOKE ALL ON FUNCTION public.apt_gantt_refresh() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_gantt_refresh() TO service_role;

CREATE OR REPLACE FUNCTION public.apt_gantt_refresh_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN PERFORM public.apt_gantt_refresh(); RETURN NULL; END $function$;
REVOKE ALL ON FUNCTION public.apt_gantt_refresh_trigger() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_gantt_refresh_trigger() TO service_role;

CREATE OR REPLACE FUNCTION public.apt_get_settings()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  RETURN jsonb_build_object('success', true,
    'settings', (SELECT to_jsonb(s) - 'id' FROM public.apt_settings s WHERE id = 1),
    'ranges', (SELECT COALESCE(jsonb_agg(jsonb_build_object('desde', desde, 'label', label) ORDER BY desde), '[]') FROM public.apt_aging_ranges),
    'state', (SELECT to_jsonb(st) - 'id' FROM public.apt_state st WHERE id = 1),
    'can_load', public.apt_can_load(),
    'last_upload', (SELECT to_jsonb(u) - 'summary' || jsonb_build_object('summary', u.summary)
                    FROM public.apt_uploads u WHERE status = 'APLICADA' ORDER BY applied_at DESC LIMIT 1));
END $function$;
REVOKE ALL ON FUNCTION public.apt_get_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_get_settings() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_group(p jsonb, p_dim text)
 RETURNS TABLE(clave text, etiqueta text, tipo text, capas bigint, lotes bigint, productos bigint, ops bigint, ipts bigint, kg_in numeric, kg_out numeric, kg_saldo numeric, primer_ingreso date, ultimo_ingreso date, primera_salida date, ultima_salida date, fecha_entrega date, fecha_saldo date, dias integer, dias_max integer, aging_pond numeric, dias_despacho_pond numeric, tn_dias numeric, capas_problema bigint, estado text, rango text, rango_orden integer, cliente text, contratos bigint, ultimo_despacho date, kg_salidas_lote numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH s AS (SELECT * FROM public.apt_settings WHERE id = 1),
  st AS (SELECT cutoff FROM public.apt_state WHERE id = 1),
  f AS (SELECT l.*, CASE p_dim WHEN 'producto' THEN l.producto WHEN 'glosa' THEN COALESCE(l.glosa, l.producto)
                    WHEN 'familia' THEN COALESCE(l.familia, '(sin glosa)') WHEN 'numrel_op' THEN COALESCE(l.numrel_op, l.lote)
                    WHEN 'ipt' THEN COALESCE(l.ipt, '(sin IPT)') WHEN 'contrato' THEN split_part(l.lote, '-', 1)
                    WHEN 'cliente' THEN COALESCE(l.cliente, '(Sin cliente identificado)') ELSE l.lote END AS k
        FROM public.apt_filtered(p) l),
  g AS (
    SELECT f.k,
      count(*) AS capas, count(DISTINCT f.lote) AS lotes, count(DISTINCT f.producto) AS productos,
      count(DISTINCT f.numrel_op) AS ops, count(DISTINCT f.ipt) AS ipts,
      sum(f.kg_in) AS kg_in, sum(f.kg_out) AS kg_out, sum(f.kg_saldo) AS kg_saldo,
      min(f.fecha_ingreso) AS primer_ingreso, max(f.fecha_ingreso) AS ultimo_ingreso,
      min(f.first_out) AS primera_salida, max(f.last_out) AS ultima_salida, min(f.fecha_entrega) AS fecha_entrega,
      min(f.fecha_ingreso) FILTER (WHERE f.kg_saldo > 0.0005) AS fecha_saldo,
      max(COALESCE(f.dias_saldo, f.dias)) AS dias_max,
      sum(f.kg_saldo * f.dias_saldo) FILTER (WHERE f.kg_saldo > 0.0005) / NULLIF(sum(f.kg_saldo) FILTER (WHERE f.kg_saldo > 0.0005), 0) AS aging_pond,
      sum(f.out_kg_days) / NULLIF(sum(f.kg_out_fechado), 0) AS dias_despacho_pond,
      sum(f.tn_dias) AS tn_dias,
      count(*) FILTER (WHERE f.problema_info) AS capas_problema,
      (array_agg(COALESCE(f.glosa, f.producto) ORDER BY f.kg_in DESC, f.movement_id))[1] AS glosa_principal,
      (array_agg(f.cliente ORDER BY f.kg_in DESC, f.movement_id) FILTER (WHERE f.cliente IS NOT NULL))[1] AS cliente_principal,
      count(DISTINCT split_part(f.lote, '-', 1)) AS contratos
    FROM f GROUP BY f.k),
  -- Todas las guías de los lotes del grupo (incluye productos que no ingresaron por APT)
  sal AS (
    SELECT fl.k, max(c.fecha) AS ultimo_despacho, sum(c.kg) AS kg
    FROM (SELECT DISTINCT k, lote FROM f) fl JOIN public.apt_exit_class c ON c.lote = fl.lote
    GROUP BY fl.k
  )
  SELECT g.k,
    CASE WHEN p_dim IN ('lote', 'numrel_op', 'producto', 'ipt', 'contrato') THEN g.glosa_principal END,
    CASE WHEN p_dim IN ('lote', 'numrel_op', 'contrato') THEN public.apt_lote_tipo(g.k) END,
    g.capas, g.lotes, g.productos, g.ops, g.ipts, g.kg_in, g.kg_out, g.kg_saldo,
    g.primer_ingreso, g.ultimo_ingreso, g.primera_salida, g.ultima_salida, g.fecha_entrega, g.fecha_saldo,
    CASE WHEN g.fecha_saldo IS NOT NULL THEN (SELECT cutoff FROM st) - g.fecha_saldo
         WHEN g.ultima_salida IS NOT NULL THEN GREATEST(g.ultima_salida - g.primer_ingreso, 0) END,
    g.dias_max, round(g.aging_pond, 1), round(g.dias_despacho_pond, 1), round(g.tn_dias, 3), g.capas_problema,
    CASE WHEN g.kg_in <= 0 THEN 'Problema de información'
         WHEN g.kg_saldo <= g.kg_in * (SELECT tolerance FROM s) THEN 'Despachado'
         WHEN g.kg_out > 0 THEN 'Salida parcial'
         WHEN (SELECT cutoff FROM st) - g.fecha_saldo > (SELECT alert_days FROM s) THEN 'Sin salida identificada'
         ELSE 'En APT' END,
    r.label, r.desde,
    CASE WHEN p_dim = 'cliente' THEN NULL ELSE g.cliente_principal END, g.contratos, sal.ultimo_despacho, sal.kg
  FROM g
  LEFT JOIN sal ON sal.k = g.k
  LEFT JOIN LATERAL (SELECT r.label, r.desde FROM public.apt_aging_ranges r
    WHERE r.desde <= COALESCE((SELECT cutoff FROM st) - g.fecha_saldo, GREATEST(g.ultima_salida - g.primer_ingreso, 0), 0)
    ORDER BY r.desde DESC LIMIT 1) r ON true;
$function$;
REVOKE ALL ON FUNCTION public.apt_group(p jsonb, p_dim text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_group(p jsonb, p_dim text) TO service_role;

CREATE OR REPLACE FUNCTION public.apt_guia_detalle(p_guias text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_keys text[]; v_out jsonb;
BEGIN
  IF NOT (public.apt_can_view() OR public.has_tms_permission('contratos-servicios') OR public.has_tms_permission('ot')
          OR public.has_tms_permission('despacho') OR public.has_tms_permission('documentario')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al detalle de guías');
  END IF;
  SELECT array_agg(DISTINCT public.apt_guia_key(g)) INTO v_keys
  FROM regexp_split_to_table(COALESCE(p_guias, ''), '[,;/\s]+') g WHERE btrim(g) <> '';
  IF v_keys IS NULL THEN RETURN jsonb_build_object('success', true, 'guias', '[]'::jsonb, 'no_encontradas', '[]'::jsonb); END IF;

  WITH m AS (
    SELECT mv.*, public.apt_guia_key(mv.documento) AS k
    FROM public.apt_movements mv
    WHERE mv.active AND mv.valid AND mv.kind = 'SALIDA'
      AND (public.apt_guia_key(mv.documento) = ANY (v_keys)
           OR split_part(public.apt_guia_key(mv.documento), '-', 2) = ANY (v_keys))),
  descripciones AS (
    -- Solo códigos requeridos sin glosa. No reutilizar movimientos inactivos o inválidos.
    -- Una descripción única por SKU evita elegir arbitrariamente entre textos distintos.
    SELECT mv.producto, min(btrim(mv.glosa)) AS glosa
    FROM public.apt_movements mv
    JOIN (SELECT DISTINCT producto FROM m WHERE NULLIF(btrim(glosa), '') IS NULL) vacios
      ON vacios.producto = mv.producto
    WHERE mv.active AND mv.valid AND NULLIF(btrim(mv.glosa), '') IS NOT NULL
    GROUP BY mv.producto HAVING count(DISTINCT btrim(mv.glosa)) = 1),
  g AS (
    SELECT documento, min(fecha) AS fecha, max(cliente) AS cliente, max(ruc) AS ruc, max(bodega) AS bodega,
      count(*) AS lineas, sum(peso_kg) AS kg, array_agg(DISTINCT lote) FILTER (WHERE lote IS NOT NULL) AS lotes,
      array_agg(DISTINCT docrel) FILTER (WHERE docrel IS NOT NULL) AS docrels, max(k) AS k
    FROM m GROUP BY documento)
  SELECT jsonb_build_object('success', true,
    'guias', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'documento', g.documento, 'fecha', g.fecha, 'cliente', g.cliente, 'ruc', g.ruc, 'bodega', g.bodega,
        'lineas', g.lineas, 'tn', round(g.kg / 1000.0, 3), 'lotes', to_jsonb(g.lotes), 'tipos', to_jsonb(g.docrels),
        'unidades', (SELECT jsonb_object_agg(COALESCE(unidad, '—'), c) FROM (SELECT unidad, sum(cantidad) AS c FROM m WHERE m.documento = g.documento GROUP BY 1) u),
        'items', (SELECT jsonb_agg(jsonb_build_object('producto', producto,
                    'glosa', COALESCE(NULLIF(btrim(glosa), ''), (SELECT d.glosa FROM descripciones d WHERE d.producto = m.producto)),
                    'glosa_recuperada', NULLIF(btrim(glosa), '') IS NULL AND EXISTS (SELECT 1 FROM descripciones d WHERE d.producto = m.producto),
                    'familia', familia, 'cantidad', cantidad,
                    'unidad', unidad, 'peso_unitario', peso_unitario, 'kg', peso_kg, 'lote', lote, 'numrel', numrel, 'docrel', docrel,
                    'fecha_entrega', fecha_entrega) ORDER BY lote, producto)
                  FROM m WHERE m.documento = g.documento),
        'origen', (SELECT jsonb_build_object(
                    'produccion_min', min(p.fecha_origen), 'produccion_max', max(p.fecha_origen),
                    'dias_pond', round(sum(p.kg * (p.fecha_salida - p.fecha_origen)) FILTER (WHERE p.fecha_origen IS NOT NULL)
                                 / NULLIF(sum(p.kg) FILTER (WHERE p.fecha_origen IS NOT NULL), 0), 1),
                    'por_origen', (SELECT jsonb_object_agg(origen, tn) FROM (SELECT origen, round(sum(kg) / 1000.0, 3) AS tn
                                   FROM public.apt_flow_pieces WHERE exit_id IN (SELECT id FROM m WHERE m.documento = g.documento) GROUP BY 1) z))
                  FROM public.apt_flow_pieces p WHERE p.exit_id IN (SELECT id FROM m WHERE m.documento = g.documento)),
        'tms', public.apt_flow_tms(ARRAY[g.documento]) -> upper(g.documento)) ORDER BY g.fecha DESC, g.documento) FROM g), '[]'::jsonb),
    'no_encontradas', COALESCE((SELECT jsonb_agg(q.clave) FROM unnest(v_keys) AS q(clave)
                                WHERE NOT EXISTS (SELECT 1 FROM g WHERE g.k = q.clave OR split_part(g.k, '-', 2) = q.clave)), '[]'::jsonb),
    'datos_hasta', (SELECT max(fecha) FROM public.apt_movements WHERE active AND valid AND kind = 'SALIDA'))
  INTO v_out;
  RETURN v_out;
END $function$;
REVOKE ALL ON FUNCTION public.apt_guia_detalle(p_guias text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_guia_detalle(p_guias text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_guias_peso(p_guias text)
 RETURNS TABLE(kg numeric, encontradas integer, faltan text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET jit TO 'off'
AS $function$
  WITH claves AS MATERIALIZED (
    SELECT DISTINCT public.apt_guia_key(g) AS clave
    FROM regexp_split_to_table(COALESCE(p_guias,''), '[,;/\s]+') g WHERE btrim(g)<>''
  ), coincidencias AS MATERIALIZED (
    SELECT k.clave, mv.id, mv.peso_kg
    FROM claves k CROSS JOIN LATERAL (
      SELECT mv.id,mv.peso_kg FROM public.apt_movements mv
      WHERE mv.active AND mv.valid AND mv.kind='SALIDA'
        AND public.apt_guia_key(mv.documento)=k.clave
      OFFSET 0
    ) mv
    UNION
    SELECT k.clave, mv.id, mv.peso_kg
    FROM claves k CROSS JOIN LATERAL (
      SELECT mv.id,mv.peso_kg FROM public.apt_movements mv
      WHERE mv.active AND mv.valid AND mv.kind='SALIDA'
        AND split_part(public.apt_guia_key(mv.documento),'-',2)=k.clave
      OFFSET 0
    ) mv WHERE k.clave NOT LIKE '%-%'
  )
  SELECT (SELECT sum(peso_kg) FROM (SELECT DISTINCT id,peso_kg FROM coincidencias) p),
    (SELECT count(DISTINCT clave)::int FROM coincidencias),
    (SELECT string_agg(k.clave,', ' ORDER BY k.clave) FROM claves k
      WHERE NOT EXISTS(SELECT 1 FROM coincidencias m WHERE m.clave=k.clave));
$function$;
REVOKE ALL ON FUNCTION public.apt_guias_peso(p_guias text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_guias_peso(p_guias text) TO service_role;

CREATE OR REPLACE FUNCTION public.apt_heatmap(p jsonb DEFAULT '{}'::jsonb, p_dim text DEFAULT 'lote'::text, p_top integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_rows jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  IF p_dim NOT IN ('lote', 'producto', 'glosa', 'familia') THEN p_dim := 'lote'; END IF;
  WITH f AS (SELECT l.*, CASE p_dim WHEN 'producto' THEN l.producto WHEN 'glosa' THEN COALESCE(l.glosa, l.producto)
                         WHEN 'familia' THEN COALESCE(l.familia, '(sin glosa)') ELSE l.lote END AS k
             FROM public.apt_filtered(COALESCE(p, '{}'::jsonb)) l WHERE l.kg_saldo > 0.0005),
  top AS (SELECT k, sum(kg_saldo) AS kg, sum(tn_dias) AS txd FROM f GROUP BY k ORDER BY sum(kg_saldo) DESC LIMIT LEAST(GREATEST(COALESCE(p_top, 25), 1), 100))
  SELECT COALESCE(jsonb_agg(jsonb_build_object('clave', t.k,
      'etiqueta', (SELECT COALESCE(x.glosa, x.producto) FROM f x WHERE x.k = t.k ORDER BY x.kg_saldo DESC LIMIT 1),
      'tn', round(t.kg / 1000, 3), 'tn_dias', round(t.txd, 1),
      'celdas', (SELECT jsonb_agg(jsonb_build_object('rango', r.label, 'tn', round(COALESCE((SELECT sum(kg_saldo) FROM f WHERE f.k = t.k AND f.rango_orden = r.desde), 0) / 1000, 3))
                 ORDER BY r.desde) FROM public.apt_aging_ranges r)) ORDER BY t.kg DESC), '[]')
  INTO v_rows FROM top t;
  RETURN jsonb_build_object('success', true, 'dim', p_dim,
    'rangos', (SELECT jsonb_agg(label ORDER BY desde) FROM public.apt_aging_ranges), 'rows', v_rows);
END $function$;
REVOKE ALL ON FUNCTION public.apt_heatmap(p jsonb, p_dim text, p_top integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_heatmap(p jsonb, p_dim text, p_top integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_id(v text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN v ~ '^0+[0-9]+(-|$)' THEN regexp_replace(v, '^0+([0-9])', '\1') ELSE v END;
$function$;
REVOKE ALL ON FUNCTION public.apt_id(v text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_id(v text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_ingresos(p jsonb DEFAULT '{}'::jsonb, p_vista text DEFAULT 'resumen'::text, p_limit integer DEFAULT 500, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_min date; v_max date; v_desde date; v_hasta date; v_rows jsonb; v_tot jsonb; v_cli jsonb;
  v_ot text := NULLIF(upper(btrim(COALESCE(p ->> 'ot', ''))), '');
  v_cliente text := NULLIF(btrim(COALESCE(p ->> 'cliente', '')), '');
  v_glosa text := NULLIF(btrim(COALESCE(p ->> 'glosa', '')), '');
  v_lote text := NULLIF(upper(btrim(COALESCE(p ->> 'lote', ''))), '');
  v_doc text := NULLIF(btrim(COALESCE(p ->> 'documento', '')), '');
  v_sin_cliente boolean := COALESCE((p ->> 'sin_cliente')::boolean, false);
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  IF p_vista NOT IN ('resumen', 'detalle') THEN RETURN jsonb_build_object('success', false, 'error', 'Vista no válida'); END IF;
  p := COALESCE(p, '{}'::jsonb);
  p_limit := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 20000);
  p_offset := GREATEST(COALESCE(p_offset, 0), 0);
  SELECT min(fecha), max(fecha) INTO v_min, v_max FROM public.apt_movements WHERE kind = 'ENTRADA' AND active AND valid;
  -- Por defecto, el mes del último ingreso cargado
  v_hasta := COALESCE(public.apt_date(p -> 'hasta'), v_max);
  v_desde := COALESCE(public.apt_date(p -> 'desde'), date_trunc('month', v_hasta)::date);
  IF v_desde > v_hasta THEN RETURN jsonb_build_object('success', false, 'error', 'La fecha inicial es posterior a la final'); END IF;

  DROP TABLE IF EXISTS pg_temp.i_mov;
  CREATE TEMP TABLE i_mov ON COMMIT DROP AS
  WITH e AS (
    SELECT m.id, m.fecha, m.documento, m.lote, m.producto, m.glosa, m.cantidad, m.unidad, m.peso_kg
    FROM public.apt_movements m
    WHERE m.kind = 'ENTRADA' AND m.active AND m.valid AND m.fecha BETWEEN v_desde AND v_hasta),
  lotes AS (SELECT DISTINCT lote, public.apt_ot_raiz(lote) AS raiz FROM e),
  cli AS (SELECT l.lote, max(l.cliente) AS cliente FROM public.apt_flow_layers l
          WHERE l.cliente IS NOT NULL AND l.lote IN (SELECT lote FROM lotes) GROUP BY 1),
  -- Lote nuevo sin guías todavía: el cliente de otro lote de la misma OT madre (el de más kg)
  cli_ot AS (SELECT DISTINCT ON (raiz) raiz, cliente FROM (
               SELECT public.apt_ot_raiz(l.lote) AS raiz, l.cliente, sum(l.kg_in) AS kg FROM public.apt_flow_layers l
               WHERE l.cliente IS NOT NULL AND public.apt_ot_raiz(l.lote) IN (SELECT raiz FROM lotes) GROUP BY 1, 2) z
             ORDER BY raiz, kg DESC NULLS LAST, cliente),
  -- Si tampoco, la OT registrada en Contratos del TMS (código = lote u OT madre)
  tms AS (SELECT DISTINCT ON (upper(c.code)) upper(c.code) AS code, cl.business_name AS cliente
          FROM public.contracts c JOIN public.clients cl ON cl.id = c.client_id
          WHERE cl.business_name IS NOT NULL
            AND upper(c.code) IN (SELECT lote FROM lotes UNION SELECT raiz FROM lotes) ORDER BY upper(c.code))
  SELECT e.*, COALESCE(lo.raiz, e.lote) AS ot,
    COALESCE(c.cliente, co.cliente, t1.cliente, t2.cliente, '(Sin cliente identificado)') AS cliente
  FROM e JOIN lotes lo ON lo.lote = e.lote
  LEFT JOIN cli c ON c.lote = e.lote LEFT JOIN cli_ot co ON co.raiz = lo.raiz
  LEFT JOIN tms t1 ON t1.code = upper(e.lote) LEFT JOIN tms t2 ON t2.code = lo.raiz
  WHERE (v_ot IS NULL OR e.lote ILIKE '%' || v_ot || '%' OR public.apt_ot_raiz(e.lote) = public.apt_ot_raiz(v_ot))
    AND (v_cliente IS NULL OR COALESCE(c.cliente, co.cliente, t1.cliente, t2.cliente, '(Sin cliente identificado)') ILIKE '%' || v_cliente || '%')
    AND (v_glosa IS NULL OR e.glosa ILIKE '%' || v_glosa || '%' OR e.producto ILIKE '%' || v_glosa || '%')
    AND (v_lote IS NULL OR e.lote ILIKE '%' || v_lote || '%')
    AND (v_doc IS NULL OR e.documento ILIKE '%' || v_doc || '%')
    AND (NOT v_sin_cliente OR COALESCE(c.cliente, co.cliente, t1.cliente, t2.cliente) IS NULL);

  SELECT jsonb_build_object('ingresos', count(*), 'cantidad', COALESCE(sum(cantidad), 0),
      'tn', round(COALESCE(sum(peso_kg), 0) / 1000, 3), 'ots', count(DISTINCT ot), 'lotes', count(DISTINCT lote),
      'clientes', count(DISTINCT cliente) FILTER (WHERE cliente <> '(Sin cliente identificado)'),
      'sin_cliente_tn', round(COALESCE(sum(peso_kg) FILTER (WHERE cliente = '(Sin cliente identificado)'), 0) / 1000, 3),
      'filas', CASE p_vista WHEN 'detalle' THEN count(*) ELSE count(DISTINCT (lote, producto, glosa, unidad)) END)
    INTO v_tot FROM i_mov;

  SELECT COALESCE(jsonb_agg(x ORDER BY x.tn DESC), '[]'::jsonb) INTO v_cli FROM (
    SELECT cliente, count(DISTINCT ot) AS ots, count(DISTINCT lote) AS lotes, sum(cantidad) AS cantidad,
      round(sum(peso_kg) / 1000, 3) AS tn
    FROM i_mov GROUP BY cliente ORDER BY sum(peso_kg) DESC LIMIT 15) x;

  IF p_vista = 'detalle' THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.fecha, r.ot, r.lote, r.glosa), '[]'::jsonb) INTO v_rows FROM (
      SELECT fecha, documento, ot, lote, cliente, producto, glosa, cantidad, unidad, round(peso_kg, 3) AS kg
      FROM i_mov ORDER BY fecha, ot, lote, glosa, id LIMIT p_limit OFFSET p_offset) r;
  ELSE
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.ot, r.lote, r.glosa), '[]'::jsonb) INTO v_rows FROM (
      SELECT ot, lote, cliente, producto, glosa, unidad, sum(cantidad) AS cantidad, round(sum(peso_kg), 3) AS kg,
        count(*) AS ingresos, min(fecha) AS primera, max(fecha) AS ultima
      FROM i_mov GROUP BY ot, lote, cliente, producto, glosa, unidad
      ORDER BY ot, lote, glosa, producto LIMIT p_limit OFFSET p_offset) r;
  END IF;

  RETURN jsonb_build_object('success', true, 'desde', v_desde, 'hasta', v_hasta, 'min', v_min, 'max', v_max,
    'vista', p_vista, 'totales', v_tot, 'clientes', v_cli, 'rows', v_rows);
END $function$;
REVOKE ALL ON FUNCTION public.apt_ingresos(p jsonb, p_vista text, p_limit integer, p_offset integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_ingresos(p jsonb, p_vista text, p_limit integer, p_offset integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_kardex(p jsonb DEFAULT '{}'::jsonb, p_nivel text DEFAULT 'lote_producto'::text, p_por_almacen boolean DEFAULT true, p_limit integer DEFAULT 500, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_desde date; v_hasta date; v_rows jsonb; v_res jsonb; v_alm jsonb; v_tipos jsonb; v_total bigint; v_min date; v_max date;
  v_ot text := COALESCE(public.apt_ot_raiz(p ->> 'ot'), upper(NULLIF(btrim(p ->> 'ot'), ''))); v_sosp text[] := '{}';
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  IF p_nivel NOT IN ('lote_producto', 'producto', 'lote', 'total') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Nivel de saldo no válido');
  END IF;
  p := COALESCE(p, '{}'::jsonb);
  p_limit := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 20000);
  p_offset := GREATEST(COALESCE(p_offset, 0), 0);
  SELECT min(fecha), max(fecha) INTO v_min, v_max FROM public.apt_movements WHERE active AND valid;
  v_desde := COALESCE(public.apt_date(p -> 'desde'), v_min);
  v_hasta := COALESCE(public.apt_date(p -> 'hasta'), v_max);
  -- Familia de la OT: todos los lotes con la misma raíz (madre, -S, -E, -G, D) y, si se pide, los de posible error de digitación
  IF v_ot IS NOT NULL AND COALESCE((p ->> 'incluir_sospechosos')::boolean, false) THEN
    SELECT COALESCE(array_agg(lote), '{}') INTO v_sosp FROM public.apt_ot_sospechosos(v_ot);
  END IF;

  DROP TABLE IF EXISTS pg_temp.k_mov;
  CREATE TEMP TABLE k_mov ON COMMIT DROP AS
  WITH cli AS (SELECT lote, max(cliente) AS cliente FROM public.apt_flow_layers WHERE cliente IS NOT NULL GROUP BY 1),
  base AS (
    SELECT m.id, m.fecha,
      CASE m.kind WHEN 'ENTRADA' THEN 'PRODUCCION' WHEN 'SALIDA' THEN 'DESPACHO' ELSE m.kind END AS tipo,
      COALESCE(m.almacen, '647') AS almacen, m.documento, m.tipodocto, m.lote, m.producto, m.glosa, m.unidad,
      CASE WHEN m.kind IN ('ENTRADA', 'TRASPASO_ENT', 'DEVOLUCION') THEN 1 ELSE -1 END AS signo,
      m.cantidad, CASE WHEN m.kind = 'TRASPASO_ENT' THEN COALESCE(l.kg_in, m.peso_kg) ELSE m.peso_kg END AS kg, m.numrel, m.docrel,
      COALESCE(CASE WHEN m.kind = 'SALIDA' THEN m.cliente END, c.cliente) AS cliente,
      CASE m.kind WHEN 'TRASPASO_SAL' THEN COALESCE(x.almacen_destino, 'Otro almacén') WHEN 'TRASPASO_ENT' THEN COALESCE(l.almacen_origen, 'Otro almacén') END AS contraparte,
      CASE m.kind WHEN 'TRASPASO_SAL' THEN NULLIF(x.lote_destino, m.lote) WHEN 'TRASPASO_ENT' THEN NULLIF(l.lote_origen, m.lote) END AS lote_rel,
      CASE WHEN m.kind IN ('ENTRADA', 'TRASPASO_ENT', 'DEVOLUCION') THEN 0 ELSE 1 END AS o
    FROM public.apt_movements m
    LEFT JOIN public.apt_flow_exits x ON m.kind = 'TRASPASO_SAL' AND x.id = m.id
    LEFT JOIN public.apt_flow_layers l ON m.kind = 'TRASPASO_ENT' AND l.id = m.id
    LEFT JOIN cli c ON c.lote = m.lote
    WHERE m.active AND m.valid AND m.lote IS NOT NULL AND (m.almacen IS NOT NULL OR m.kind = 'ENTRADA')
    UNION ALL
    -- Stock previo inferido por el flujo: primera fila de cada lote y producto en su almacén
    SELECT -l.id, NULL::date, 'INICIAL', l.almacen, NULL, 'STOCK PREVIO INFERIDO', l.lote, l.producto, l.glosa, NULL,
      1, NULL::numeric, l.kg_in, NULL, NULL, l.cliente, NULL, NULL, -1
    FROM public.apt_flow_layers l WHERE l.tipo = 'INICIAL')
  SELECT * FROM base b
  WHERE (NULLIF(btrim(p ->> 'lote_exacto'), '') IS NULL OR b.lote = upper(btrim(p ->> 'lote_exacto')))
    AND (NULLIF(btrim(p ->> 'lote'), '') IS NULL OR b.lote ILIKE '%' || btrim(p ->> 'lote') || '%' OR b.lote_rel ILIKE '%' || btrim(p ->> 'lote') || '%')
    AND (v_ot IS NULL OR public.apt_ot_raiz(b.lote) = v_ot OR b.lote = ANY (v_sosp))
    AND (jsonb_typeof(p -> 'variantes') IS DISTINCT FROM 'array' OR jsonb_array_length(p -> 'variantes') = 0
         OR CASE WHEN b.lote = ANY (v_sosp) THEN 'SOSPECHOSO' ELSE public.apt_lote_variante(b.lote) END
            IN (SELECT jsonb_array_elements_text(p -> 'variantes')))
    AND (NULLIF(btrim(p ->> 'producto'), '') IS NULL OR b.producto ILIKE '%' || btrim(p ->> 'producto') || '%')
    AND (NULLIF(btrim(p ->> 'glosa'), '') IS NULL OR b.glosa ILIKE '%' || btrim(p ->> 'glosa') || '%')
    AND (NULLIF(btrim(p ->> 'documento'), '') IS NULL OR b.documento ILIKE '%' || btrim(p ->> 'documento') || '%')
    AND (jsonb_typeof(p -> 'clientes') IS DISTINCT FROM 'array' OR jsonb_array_length(p -> 'clientes') = 0
         OR COALESCE(b.cliente, '(Sin cliente identificado)') IN (SELECT jsonb_array_elements_text(p -> 'clientes')))
    AND (jsonb_typeof(p -> 'almacenes') IS DISTINCT FROM 'array' OR jsonb_array_length(p -> 'almacenes') = 0
         OR b.almacen IN (SELECT jsonb_array_elements_text(p -> 'almacenes')))
    AND (jsonb_typeof(p -> 'tipos') IS DISTINCT FROM 'array' OR jsonb_array_length(p -> 'tipos') = 0
         OR b.tipo IN (SELECT jsonb_array_elements_text(p -> 'tipos')));

  -- Saldo acumulado por la clave elegida (las filas anteriores al periodo forman el saldo inicial)
  DROP TABLE IF EXISTS pg_temp.k_run;
  CREATE TEMP TABLE k_run ON COMMIT DROP AS
  SELECT k.*, z.clave,
    sum(k.signo * k.kg) OVER w AS saldo_kg,
    CASE WHEN p_nivel IN ('lote_producto', 'producto') THEN sum(k.signo * COALESCE(k.cantidad, 0)) OVER w END AS saldo_cant,
    row_number() OVER (ORDER BY z.clave, k.fecha NULLS FIRST, k.o, k.id) AS rn
  FROM k_mov k
  CROSS JOIN LATERAL (SELECT concat_ws(' · ', CASE WHEN p_por_almacen THEN k.almacen END,
      CASE p_nivel WHEN 'lote_producto' THEN k.lote || ' | ' || k.producto WHEN 'producto' THEN k.producto WHEN 'lote' THEN k.lote ELSE 'Total' END) AS clave) z
  WINDOW w AS (PARTITION BY z.clave ORDER BY k.fecha NULLS FIRST, k.o, k.id ROWS UNBOUNDED PRECEDING);
  CREATE INDEX ON k_run (rn);

  SELECT count(*) INTO v_total FROM k_run WHERE fecha BETWEEN v_desde AND v_hasta;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', r.id, 'clave', r.clave, 'fecha', r.fecha, 'tipo', r.tipo, 'documento', r.documento,
           'tipodocto', r.tipodocto, 'almacen', r.almacen,
           'variante', CASE WHEN r.lote = ANY (v_sosp) THEN 'SOSPECHOSO' ELSE public.apt_lote_variante(r.lote) END, 'contraparte', r.contraparte, 'lote', r.lote, 'lote_rel', r.lote_rel,
           'producto', r.producto, 'glosa', r.glosa, 'cliente', r.cliente, 'numrel', r.numrel, 'docrel', r.docrel, 'unidad', r.unidad,
           'cant_in', CASE WHEN r.signo > 0 THEN r.cantidad END, 'cant_out', CASE WHEN r.signo < 0 THEN r.cantidad END,
           'kg_in', CASE WHEN r.signo > 0 THEN round(r.kg, 3) END, 'kg_out', CASE WHEN r.signo < 0 THEN round(r.kg, 3) END,
           'saldo_kg', round(r.saldo_kg, 3), 'saldo_cant', r.saldo_cant,
           'saldo_kg_antes', round(r.saldo_kg - r.signo * r.kg, 3)) ORDER BY r.rn), '[]')
  INTO v_rows
  FROM (SELECT * FROM k_run WHERE fecha BETWEEN v_desde AND v_hasta ORDER BY rn OFFSET p_offset LIMIT p_limit) r;

  -- Resumen del periodo: saldo inicial (incluye stock previo y movimientos anteriores), entradas, salidas y saldo final
  SELECT jsonb_build_object(
    'claves', (SELECT count(DISTINCT clave) FROM k_run WHERE fecha BETWEEN v_desde AND v_hasta),
    'movimientos', v_total,
    'guias', (SELECT count(DISTINCT documento) FROM k_run WHERE tipo = 'DESPACHO' AND fecha BETWEEN v_desde AND v_hasta),
    'lotes', (SELECT count(DISTINCT lote) FROM k_run WHERE fecha BETWEEN v_desde AND v_hasta),
    'saldo_inicial_tn', round(COALESCE((SELECT sum(signo * kg) FROM k_run WHERE fecha IS NULL OR fecha < v_desde), 0) / 1000.0, 3),
    'entradas_tn', round(COALESCE((SELECT sum(kg) FROM k_run WHERE signo > 0 AND fecha BETWEEN v_desde AND v_hasta), 0) / 1000.0, 3),
    'salidas_tn', round(COALESCE((SELECT sum(kg) FROM k_run WHERE signo < 0 AND fecha BETWEEN v_desde AND v_hasta), 0) / 1000.0, 3),
    'saldo_final_tn', round(COALESCE((SELECT sum(signo * kg) FROM k_run WHERE fecha IS NULL OR fecha <= v_hasta), 0) / 1000.0, 3),
    'claves_negativas', (SELECT count(*) FROM (SELECT clave FROM k_run WHERE fecha IS NULL OR fecha <= v_hasta GROUP BY clave
                                              HAVING sum(signo * kg) < -0.5) z))
  INTO v_res;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('almacen', almacen, 'inicial_tn', round(ini / 1000.0, 3), 'entradas_tn', round(ent / 1000.0, 3),
           'salidas_tn', round(sal / 1000.0, 3), 'saldo_tn', round((ini + ent - sal) / 1000.0, 3))
           ORDER BY CASE almacen WHEN '647' THEN 1 WHEN '540' THEN 2 ELSE 3 END), '[]')
  INTO v_alm
  FROM (SELECT almacen, COALESCE(sum(signo * kg) FILTER (WHERE fecha IS NULL OR fecha < v_desde), 0) AS ini,
               COALESCE(sum(kg) FILTER (WHERE signo > 0 AND fecha BETWEEN v_desde AND v_hasta), 0) AS ent,
               COALESCE(sum(kg) FILTER (WHERE signo < 0 AND fecha BETWEEN v_desde AND v_hasta), 0) AS sal
        FROM k_run GROUP BY almacen) z;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('tipo', tipo, 'filas', n, 'tn', round(kg / 1000.0, 3)) ORDER BY kg DESC), '[]')
  INTO v_tipos
  FROM (SELECT tipo, count(*) AS n, sum(kg) AS kg FROM k_run WHERE fecha BETWEEN v_desde AND v_hasta GROUP BY 1) z;

  RETURN jsonb_build_object('success', true, 'desde', v_desde, 'hasta', v_hasta, 'data_min', v_min, 'data_max', v_max,
    'nivel', p_nivel, 'por_almacen', p_por_almacen, 'total', v_total, 'offset', p_offset, 'limit', p_limit,
    'resumen', v_res, 'almacenes', v_alm, 'tipos', v_tipos, 'filas', v_rows);
END $function$;
REVOKE ALL ON FUNCTION public.apt_kardex(p jsonb, p_nivel text, p_por_almacen boolean, p_limit integer, p_offset integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_kardex(p jsonb, p_nivel text, p_por_almacen boolean, p_limit integer, p_offset integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_like(p jsonb, k text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT '%' || replace(replace(replace(NULLIF(btrim(p ->> k), ''), '\', '\\'), '%', '\%'), '_', '\_') || '%';
$function$;
REVOKE ALL ON FUNCTION public.apt_like(p jsonb, k text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_like(p jsonb, k text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_lote(p_lote text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_lote text := upper(btrim(COALESCE(p_lote, ''))); v_q jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  v_q := jsonb_build_object('lotes', jsonb_build_array(v_lote));
  RETURN jsonb_build_object('success', true, 'lote', v_lote, 'tipo', public.apt_lote_tipo(v_lote),
    'cutoff', (SELECT cutoff FROM public.apt_state WHERE id = 1),
    'resumen', (SELECT to_jsonb(g) || jsonb_build_object('tn_in', round(g.kg_in / 1000, 3), 'tn_out', round(g.kg_out / 1000, 3),
                  'tn_saldo', round(g.kg_saldo / 1000, 3), 'pct_despachado', round(100 * g.kg_out / NULLIF(g.kg_in, 0), 1))
                FROM public.apt_group(v_q, 'lote') g LIMIT 1),
    'contrato', (SELECT jsonb_build_object('id', c.id, 'code', c.code, 'type', c.type::text, 'status', c.status::text)
                 FROM public.contracts c WHERE upper(c.code) = v_lote LIMIT 1),
    'productos', (SELECT COALESCE(jsonb_agg(to_jsonb(g) || jsonb_build_object('tn_in', round(g.kg_in / 1000, 3), 'tn_out', round(g.kg_out / 1000, 3),
                  'tn_saldo', round(g.kg_saldo / 1000, 3)) ORDER BY g.tn_dias DESC, g.kg_saldo DESC), '[]')
                  FROM public.apt_group(v_q, 'producto') g),
    'capas', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', l.movement_id, 'producto', l.producto, 'glosa', l.glosa, 'numrel_op', l.numrel_op,
                'ipt', l.ipt, 'documento', l.documento, 'fecha_ingreso', l.fecha_ingreso, 'fecha_entrega', l.fecha_entrega,
                'cantidad', l.cantidad, 'unidad', l.unidad, 'kg_in', round(l.kg_in, 2), 'kg_out', round(l.kg_out, 2), 'kg_saldo', round(l.kg_saldo, 2),
                'dias', l.dias, 'dias_saldo', l.dias_saldo, 'tn_dias', round(l.tn_dias, 3), 'estado', l.estado, 'rango', l.rango,
                'ultima_salida', l.last_out, 'problema_info', l.problema_info, 'posible_cruce', l.posible_cruce,
                'salida_antes_ingreso', l.kg_out_before_in > 0.5, 'row_no', m.row_no, 'archivo', u.file_name, 'raw', m.raw)
                ORDER BY l.fecha_ingreso, l.movement_id), '[]')
              FROM public.apt_layers l JOIN public.apt_movements m ON m.id = l.movement_id JOIN public.apt_uploads u ON u.id = m.upload_id
              WHERE l.lote = v_lote),
    'salidas', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', m.id, 'fecha', m.fecha, 'guia', m.documento, 'cliente', m.cliente,
                  'docrel', m.docrel, 'numrel', m.numrel, 'producto', m.producto, 'glosa', m.glosa, 'cantidad', m.cantidad, 'unidad', m.unidad,
                  'kg', round(m.peso_kg, 2), 'kg_asignado', round(COALESCE(x.kg_asignado, 0), 2), 'kg_sin_entrada', round(COALESCE(x.kg_sin_entrada, 0), 2),
                  'clase', x.clase, 'row_no', m.row_no, 'archivo', u.file_name, 'raw', m.raw) ORDER BY m.fecha, m.id), '[]')
                FROM public.apt_movements m JOIN public.apt_uploads u ON u.id = m.upload_id
                LEFT JOIN public.apt_exit_class x ON x.exit_id = m.id
                WHERE m.active AND m.valid AND m.kind = 'SALIDA' AND m.lote = v_lote),
    'asignaciones', (SELECT COALESCE(jsonb_agg(jsonb_build_object('capa', a.layer_id, 'salida', a.exit_id, 'kg', round(a.kg, 2),
                       'fecha_ingreso', a.fecha_ingreso, 'fecha_salida', a.fecha_salida, 'dias', a.dias) ORDER BY a.fecha_salida, a.layer_id), '[]')
                     FROM public.apt_allocations a JOIN public.apt_layers l ON l.movement_id = a.layer_id WHERE l.lote = v_lote));
END $function$;
REVOKE ALL ON FUNCTION public.apt_lote(p_lote text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_lote(p_lote text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_lote_tipo(p_lote text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN p_lote IS NULL THEN NULL
              WHEN p_lote ~* '-S[0-9]' THEN 'SUBCONTRATO'
              WHEN p_lote ~* '-E[0-9]' THEN 'ERROR'
              WHEN p_lote ~* '-G[0-9]' THEN 'GARANTIA'
              ELSE 'CONTRATO' END;
$function$;
REVOKE ALL ON FUNCTION public.apt_lote_tipo(p_lote text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_lote_tipo(p_lote text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_lote_variante(p_lote text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN p_lote IS NULL THEN NULL
              WHEN upper(btrim(p_lote)) ~ '[0-9]\s*D$' THEN 'DEVOLUCION'
              WHEN upper(p_lote) ~ '-S[0-9]' THEN 'SUBCONTRATO'
              WHEN upper(p_lote) ~ '-E[0-9]' THEN 'ERROR'
              WHEN upper(p_lote) ~ '-G[0-9]' THEN 'GARANTIA'
              WHEN btrim(p_lote) ~ '^[0-9]+$' THEN 'MADRE'
              ELSE 'OTRO' END;
$function$;
REVOKE ALL ON FUNCTION public.apt_lote_variante(p_lote text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_lote_variante(p_lote text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_model_rebuild()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para recalcular el modelo de APT');
  END IF;
  RETURN public.apt_rebuild();
END $function$;
REVOKE ALL ON FUNCTION public.apt_model_rebuild() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_model_rebuild() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_models_ensure_current_core(p_model text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_applied timestamptz; v_settings timestamptz; v_rebuilt timestamptz;
 v_target date; v_cut date; v_result jsonb;
BEGIN
 IF p_model IS NULL OR p_model NOT IN ('estadia','flujo') THEN RAISE EXCEPTION 'Modelo APT inválido'; END IF;
 -- Nunca competir con un reemplazo o cálculo en curso ni acumular esperas del cron.
 IF NOT pg_try_advisory_xact_lock(hashtext('apt_rebuild')) THEN
  RETURN jsonb_build_object('success',true,'rebuilt',false,'busy',true); END IF;
 IF NOT pg_try_advisory_xact_lock(hashtext('apt_flow_rebuild')) THEN
  RETURN jsonb_build_object('success',true,'rebuilt',false,'busy',true); END IF;
 SELECT max(applied_at) INTO v_applied FROM public.apt_uploads WHERE status='APLICADA';
 SELECT NULLIF(to_jsonb(s)->>'updated_at','')::timestamptz INTO v_settings FROM public.apt_settings s WHERE id=1;
 SELECT COALESCE((SELECT cutoff_date FROM public.apt_settings WHERE id=1),max(fecha))
 INTO v_target FROM public.apt_movements WHERE active AND valid;
 IF p_model='estadia' THEN
  SELECT rebuilt_at,cutoff INTO v_rebuilt,v_cut FROM public.apt_state WHERE id=1;
 ELSE
  SELECT rebuilt_at,cutoff INTO v_rebuilt,v_cut FROM public.apt_flow_state WHERE id=1;
 END IF;
 IF v_cut IS NOT DISTINCT FROM v_target AND v_rebuilt IS NOT NULL
  AND (v_applied IS NULL OR v_rebuilt>=v_applied) AND (v_settings IS NULL OR v_rebuilt>=v_settings) THEN
  RETURN jsonb_build_object('success',true,'rebuilt',false,'cutoff',v_cut); END IF;
 IF v_target IS NULL AND v_rebuilt IS NULL AND v_applied IS NULL THEN
  RETURN jsonb_build_object('success',true,'rebuilt',false,'empty',true); END IF;
 IF p_model='estadia' THEN v_result:=public.apt_rebuild();
 ELSE v_result:=public.apt_flow_rebuild_core(); END IF;
 IF (v_result->>'success')::boolean IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'No se pudo actualizar automáticamente APT (%): %',p_model,v_result;
 END IF;
 RETURN v_result||jsonb_build_object('rebuilt',true);
END $function$;
REVOKE ALL ON FUNCTION public.apt_models_ensure_current_core(p_model text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_models_ensure_current_core(p_model text) TO service_role;

CREATE OR REPLACE FUNCTION public.apt_num(v jsonb)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE jsonb_typeof(v)
    WHEN 'number' THEN (v #>> '{}')::numeric
    WHEN 'string' THEN CASE WHEN btrim(v #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN btrim(v #>> '{}')::numeric END
  END;
$function$;
REVOKE ALL ON FUNCTION public.apt_num(v jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_num(v jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_operational_summary(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_full jsonb; v_limit integer; v_offset integer;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  p := COALESCE(p, '{}'::jsonb);
  -- Filtros y paginación inválidos: el cálculo en vivo responde de inmediato con su mensaje de validación.
  IF jsonb_typeof(p) <> 'object' OR COALESCE(p ->> 'limit', '25') !~ '^[0-9]{1,6}$' OR COALESCE(p ->> 'offset', '0') !~ '^[0-9]{1,9}$' THEN
    RETURN public.apt_operational_summary_live(p);
  END IF;
  v_limit := LEAST(GREATEST(COALESCE((p ->> 'limit')::integer, 25), 1), 100);
  v_offset := GREATEST(COALESCE((p ->> 'offset')::integer, 0), 0);
  -- La caché guarda hasta 999 999 filas; una página más allá se calcula en vivo como antes.
  IF v_offset + v_limit > 999999 THEN RETURN public.apt_operational_summary_live(p); END IF;
  v_full := public.apt_read_cached('apt_operational_summary', public.apt_read_cache_key('apt_operational_summary', p));
  IF (v_full ->> 'success') IS DISTINCT FROM 'true' OR jsonb_typeof(v_full -> 'rows') <> 'array' THEN RETURN v_full; END IF;
  RETURN v_full || jsonb_build_object(
    'rows', COALESCE((SELECT jsonb_agg(r.value ORDER BY r.ordinality) FROM jsonb_array_elements(v_full -> 'rows') WITH ORDINALITY r
                      WHERE r.ordinality > v_offset AND r.ordinality <= v_offset + v_limit), '[]'::jsonb),
    'limit', v_limit, 'offset', v_offset);
END $function$;
REVOKE ALL ON FUNCTION public.apt_operational_summary(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_operational_summary(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_operational_summary_live(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
 s public.apt_flow_state%ROWTYPE;
 v_cut date; v_from date; v_to date; v_max date; v_applied timestamptz;
 v_alm text; v_limit integer; v_offset integer; v_current boolean;
 v_meta jsonb; v_kpis jsonb; v_series jsonb; v_rows jsonb; v_warehouses jsonb; v_coverage jsonb;
 v_total integer; v_missing integer; v_temporal integer; v_negative integer; v_alert integer;
 v_stock numeric; v_average numeric; v_out numeric; v_inferred numeric; v_known numeric;
 v_unknown numeric; v_age numeric; v_exposure numeric; v_version text;
 v_lote text; v_ot text; v_clients text[];
BEGIN
 IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success',false,'error','Sin acceso al módulo APT'); END IF;
 p:=COALESCE(p,'{}'::jsonb);
 IF jsonb_typeof(p)<>'object' THEN RETURN jsonb_build_object('success',false,'error','Filtros APT inválidos'); END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('desde','hasta','cutoff','almacen','lote','ot','clientes','limit','offset')) THEN
  RETURN jsonb_build_object('success',false,'error','Hay filtros no compatibles con el análisis operativo APT');
 END IF;
 IF p ? 'clientes' AND jsonb_typeof(p->'clientes')<>'array' THEN
  RETURN jsonb_build_object('success',false,'error','Clientes debe ser una lista');
 END IF;
 IF p ? 'clientes' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p->'clientes') c WHERE jsonb_typeof(c)<>'string') THEN
  RETURN jsonb_build_object('success',false,'error','Cada cliente debe ser un texto');
 END IF;
 IF jsonb_array_length(COALESCE(p->'clientes','[]'))>100
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(p->'clientes','[]')) c WHERE length(c)>200)
  OR length(COALESCE(p->>'lote',''))>100 OR length(COALESCE(p->>'ot',''))>100 THEN
  RETURN jsonb_build_object('success',false,'error','Los filtros superan el tamaño permitido');
 END IF;
 SELECT * INTO s FROM public.apt_flow_state WHERE id=1;
 SELECT max(fecha) INTO v_max FROM public.apt_movements WHERE active AND valid;
 SELECT max(applied_at) INTO v_applied FROM public.apt_uploads WHERE status='APLICADA';
 SELECT alert_days INTO v_alert FROM public.apt_settings WHERE id=1;
 v_alert:=COALESCE(v_alert,60);
 FOREACH v_alm IN ARRAY ARRAY['cutoff','desde','hasta'] LOOP
  IF NULLIF(p->>v_alm,'') IS NOT NULL AND public.apt_date(p->v_alm) IS NULL THEN
   RETURN jsonb_build_object('success',false,'error','Fecha inválida: '||v_alm);
  END IF;
 END LOOP;
 v_cut:=COALESCE(public.apt_date(p->'cutoff'),s.cutoff);
 IF v_cut>s.cutoff THEN RETURN jsonb_build_object('success',false,'error','El corte supera la fecha del modelo. Actualice los datos antes de analizar.'); END IF;
 IF v_cut<s.data_min THEN RETURN jsonb_build_object('success',false,'error','El corte es anterior al inicio de los datos disponibles'); END IF;
 v_to:=COALESCE(public.apt_date(p->'hasta'),v_cut);
 v_from:=COALESCE(public.apt_date(p->'desde'),GREATEST(s.data_min,v_to-29));
 IF v_from>v_to OR v_to>v_cut OR v_to-v_from>365 THEN
  RETURN jsonb_build_object('success',false,'error','Seleccione un período de hasta 366 días, ordenado y anterior o igual al corte');
 END IF;
 IF v_from<s.data_min THEN RETURN jsonb_build_object('success',false,'error','El período comienza antes de los datos disponibles'); END IF;
 v_alm:=NULLIF(btrim(p->>'almacen'),'');
 IF v_alm IS NOT NULL AND v_alm NOT IN ('647','540','ST') THEN RETURN jsonb_build_object('success',false,'error','Almacén no compatible'); END IF;
 IF COALESCE(p->>'limit','25') !~ '^[0-9]{1,6}$' OR COALESCE(p->>'offset','0') !~ '^[0-9]{1,9}$' THEN
  RETURN jsonb_build_object('success',false,'error','Paginación inválida');
 END IF;
 v_limit:=LEAST(GREATEST(COALESCE((p->>'limit')::integer,25),1),1000000);
 v_offset:=GREATEST(COALESCE((p->>'offset')::integer,0),0);
 v_current:=v_cut=s.cutoff;
 v_lote:=NULLIF(btrim(p->>'lote'),'');
 v_ot:=CASE WHEN NULLIF(btrim(p->>'ot'),'') IS NOT NULL THEN COALESCE(public.apt_ot_raiz(p->>'ot'),upper(btrim(p->>'ot'))) END;
 SELECT COALESCE(array_agg(c),'{}'::text[]) INTO v_clients FROM jsonb_array_elements_text(COALESCE(p->'clientes','[]')) c;
 v_version:=concat_ws('|',s.rebuilt_at::text,v_applied::text,v_max::text);
 v_meta:=jsonb_build_object('cutoff',v_cut,'desde',v_from,'hasta',v_to,'data_min',s.data_min,'data_max',v_max,
  'flow_rebuilt_at',s.rebuilt_at,'latest_applied_at',v_applied,
  'model_fresh',s.cutoff IS NOT NULL AND s.rebuilt_at IS NOT NULL AND (v_applied IS NULL OR s.rebuilt_at>=v_applied),
  'calculation_basis','DOCUMENTAL_RECONSTRUIDO','composition_available',COALESCE(v_current,false),
  'physical_reconciliation','NO_VERIFICADA','age_basis',CASE WHEN v_current THEN 'ORIGEN' ELSE 'NO_DISPONIBLE' END,
  'alert_days',v_alert,'version',v_version);
 IF s.cutoff IS NULL THEN
  RETURN jsonb_build_object('success',true,'schema_version',1,'vacio',true,'filters',p-'limit'-'offset','meta',v_meta,
   'kpis',jsonb_build_object('stock_tn',0,'inferred_opening_tn',NULL,'known_origin_stock_tn',NULL,'unknown_origin_stock_tn',NULL,
    'weighted_age_days',NULL,'stock_tn_days',NULL,'production_tn',0,'dispatch_tn',0,'consumption_tn',0,'returns_tn',0,
    'average_stock_tn',NULL,'turnover',NULL,'observed_days',0),
   'quality',jsonb_build_object('missing_weight_rows',0,'temporal_anomaly_rows',0,'negative_balance_rows',0),
   'coverage','[]'::jsonb,'series','[]'::jsonb,'warehouses','[]'::jsonb,'rows','[]'::jsonb,'total',0,'limit',v_limit,'offset',v_offset);
 END IF;
 DROP TABLE IF EXISTS pg_temp.apt_op_scope;
 DROP TABLE IF EXISTS pg_temp.apt_op_mv;
 DROP TABLE IF EXISTS pg_temp.apt_op_keys;
 DROP TABLE IF EXISTS pg_temp.apt_op_bal;
 DROP TABLE IF EXISTS pg_temp.apt_op_series;
 DROP TABLE IF EXISTS pg_temp.apt_op_composition;
 -- Select one inventory cohort first. An exit's customer may be absent or differ from the
 -- inferred layer customer; filtering each event independently would create fictitious stock.
 CREATE TEMP TABLE apt_op_keys ON COMMIT DROP AS
 SELECT DISTINCT almacen,lote,producto FROM public.apt_flow_layers
 WHERE (v_alm IS NULL OR almacen=v_alm)
 AND (v_lote IS NULL OR lote ILIKE '%'||v_lote||'%')
 AND (v_ot IS NULL OR public.apt_ot_raiz(lote)=v_ot)
 AND (cardinality(v_clients)=0 OR COALESCE(cliente,'(Sin cliente identificado)')=ANY(v_clients));
 CREATE UNIQUE INDEX ON apt_op_keys(almacen,lote,producto);
 ANALYZE apt_op_keys;
 CREATE TEMP TABLE apt_op_mv ON COMMIT DROP AS
 SELECT l.almacen,l.lote,l.producto,l.cliente,l.fecha,l.tipo,l.kg_in AS kg FROM public.apt_flow_layers l
 JOIN apt_op_keys k USING(almacen,lote,producto) WHERE l.fecha IS NULL OR l.fecha<=v_cut
 UNION ALL
 SELECT e.almacen,e.lote,e.producto,e.cliente,e.fecha,e.tipo,-e.kg FROM public.apt_flow_exits e
 JOIN apt_op_keys k USING(almacen,lote,producto) WHERE e.fecha<=v_cut;
 ANALYZE apt_op_mv;
 -- Group before pagination. Never clamp negatives: they remain visible as reconciliation exceptions.
 CREATE TEMP TABLE apt_op_bal ON COMMIT DROP AS
 SELECT almacen,lote,max(cliente) AS cliente,sum(kg) AS kg FROM apt_op_mv GROUP BY almacen,lote;
 CREATE TEMP TABLE apt_op_composition ON COMMIT DROP AS
 SELECT almacen,lote,sum(kg) FILTER(WHERE origen LIKE 'INICIAL%') AS inferred,
  sum(kg) FILTER(WHERE fecha_origen IS NOT NULL AND fecha_origen<=v_cut) AS known,
  sum(kg) FILTER(WHERE fecha_origen IS NULL OR fecha_origen>v_cut) AS unknown,
  sum(kg*(v_cut-fecha_origen)) FILTER(WHERE fecha_origen IS NOT NULL AND fecha_origen<=v_cut) AS kg_days
 FROM public.apt_flow_pieces pc JOIN apt_op_keys k USING(almacen,lote,producto)
 WHERE v_current AND es_saldo GROUP BY almacen,lote;
 CREATE UNIQUE INDEX ON apt_op_bal(almacen,lote);
 CREATE UNIQUE INDEX ON apt_op_composition(almacen,lote);
 ANALYZE apt_op_bal;
 ANALYZE apt_op_composition;
 -- Mean inventory is the mean of daily closing balances of the requested observed window.
 CREATE TEMP TABLE apt_op_series ON COMMIT DROP AS
 WITH daily AS (SELECT fecha,sum(kg) AS delta,
   sum(kg) FILTER(WHERE tipo='PRODUCCION') AS production,
   -sum(kg) FILTER(WHERE tipo='DESPACHO') AS dispatch
   FROM apt_op_mv WHERE fecha BETWEEN v_from AND v_to GROUP BY fecha),
 opening AS (SELECT COALESCE(sum(kg),0) AS kg FROM apt_op_mv WHERE fecha IS NULL OR fecha<v_from)
 SELECT d::date AS fecha, o.kg+sum(COALESCE(m.delta,0)) OVER(ORDER BY d) AS kg,
  COALESCE(m.production,0) AS production,COALESCE(m.dispatch,0) AS dispatch
 FROM generate_series(v_from,v_to,interval '1 day') d CROSS JOIN opening o LEFT JOIN daily m ON m.fecha=d::date;
 SELECT COALESCE(sum(kg),0) INTO v_stock FROM apt_op_bal;
 SELECT avg(kg) INTO v_average FROM apt_op_series;
 SELECT COALESCE(sum(-kg),0) INTO v_out FROM apt_op_mv WHERE tipo='DESPACHO' AND fecha BETWEEN v_from AND v_to;
 SELECT CASE WHEN v_current THEN COALESCE(sum(inferred),0) END,
  CASE WHEN v_current THEN COALESCE(sum(known),0) END,CASE WHEN v_current THEN COALESCE(sum(unknown),0) END,
  CASE WHEN v_current THEN round(sum(kg_days)/NULLIF(sum(known),0),1) END,
  CASE WHEN v_current THEN round(sum(kg_days)/1000,1) END
 INTO v_inferred,v_known,v_unknown,v_age,v_exposure FROM apt_op_composition;
 v_kpis:=jsonb_build_object('stock_tn',round(v_stock/1000,3),'inferred_opening_tn',round(v_inferred/1000,3),
  'known_origin_stock_tn',round(v_known/1000,3),'unknown_origin_stock_tn',round(v_unknown/1000,3),
  'weighted_age_days',v_age,'stock_tn_days',v_exposure,
  'production_tn',(SELECT round(COALESCE(sum(kg),0)/1000,3) FROM apt_op_mv WHERE tipo='PRODUCCION' AND fecha BETWEEN v_from AND v_to),
  'dispatch_tn',round(v_out/1000,3),
  'consumption_tn',(SELECT round(COALESCE(sum(-kg),0)/1000,3) FROM apt_op_mv WHERE tipo='CONSUMO' AND fecha BETWEEN v_from AND v_to),
  'returns_tn',(SELECT round(COALESCE(sum(kg),0)/1000,3) FROM apt_op_mv WHERE tipo='DEVOLUCION' AND fecha BETWEEN v_from AND v_to),
  'average_stock_tn',round(v_average/1000,3),
  'turnover',CASE WHEN v_average>0 THEN round(v_out/v_average,3) END,
  'observed_days',v_to-v_from+1);
 SELECT COALESCE(jsonb_agg(jsonb_build_object('fecha',fecha,'stock_tn',round(kg/1000,3),
  'production_tn',round(production/1000,3),'dispatch_tn',round(dispatch/1000,3)) ORDER BY fecha),'[]') INTO v_series FROM apt_op_series;
 SELECT count(*) INTO v_total FROM apt_op_bal WHERE abs(kg)>0.0005;
 SELECT count(*) INTO v_negative FROM (SELECT almacen,lote,producto FROM apt_op_mv GROUP BY almacen,lote,producto HAVING sum(kg)< -0.0005) deficits;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('almacen',b.almacen,'lote',b.lote,'cliente',b.cliente,'stock_tn',round(b.kg/1000,3),
  'inferred_opening_tn',CASE WHEN v_current THEN round(COALESCE(c.inferred,0)/1000,3) END,
  'age_days',CASE WHEN v_current THEN round(c.kg_days/NULLIF(c.known,0),1) END,
  'stock_tn_days',CASE WHEN v_current THEN round(c.kg_days/1000,1) END) ORDER BY b.kg DESC,b.almacen,b.lote),'[]')
 INTO v_rows FROM (SELECT * FROM apt_op_bal WHERE abs(kg)>0.0005 ORDER BY kg DESC,almacen,lote LIMIT v_limit OFFSET v_offset) b
 LEFT JOIN apt_op_composition c USING(almacen,lote);
 SELECT COALESCE(jsonb_agg(jsonb_build_object('almacen',almacen,'stock_tn',round(kg/1000,3),
  'inferred_opening_tn',CASE WHEN v_current THEN round(inferred/1000,3) END) ORDER BY almacen),'[]') INTO v_warehouses
 FROM (SELECT b.almacen,sum(b.kg) AS kg,COALESCE(sum(c.inferred),0) AS inferred FROM apt_op_bal b
  LEFT JOIN apt_op_composition c USING(almacen,lote) GROUP BY b.almacen) x;
 -- Materialize raw documentary scope once. Unlike the inventory cohort, it includes
 -- missing-weight documents even when they have no layer; customer scope still requires
 -- an inventory key, preserving the previous EXISTS semantics.
 CREATE TEMP TABLE apt_op_scope ON COMMIT DROP AS
 SELECT m.id,m.kind,m.fecha,m.peso_kg,m.almacen,m.lote FROM public.apt_movements m
 WHERE m.active AND m.valid AND (v_alm IS NULL OR m.almacen=v_alm)
 AND (v_lote IS NULL OR m.lote ILIKE '%'||v_lote||'%')
 AND (v_ot IS NULL OR public.apt_ot_raiz(m.lote)=v_ot)
 AND (cardinality(v_clients)=0 OR EXISTS(SELECT 1 FROM apt_op_keys k WHERE k.almacen=m.almacen AND k.lote=m.lote));
 CREATE UNIQUE INDEX ON apt_op_scope(id);
 ANALYZE apt_op_scope;
 SELECT count(*) INTO v_missing FROM apt_op_scope WHERE peso_kg<=0 AND fecha<=v_cut;
 -- Restrict anomalies first, before joining the historical entry and source tables.
 -- apt_layers may contain repeated movement identifiers in historical installations;
 -- retaining this join preserves the previous anomaly count exactly.
 SELECT count(*) INTO v_temporal FROM public.apt_allocations a
 JOIN public.apt_layers l ON l.movement_id=a.layer_id
 JOIN public.apt_movements m ON m.id=l.movement_id
 WHERE a.fecha_salida<a.fecha_ingreso AND a.fecha_salida<=v_cut
 AND (v_alm IS NULL OR m.almacen=v_alm)
 AND (v_lote IS NULL OR l.lote ILIKE '%'||v_lote||'%')
 AND (v_ot IS NULL OR public.apt_ot_raiz(l.lote)=v_ot)
 AND (cardinality(v_clients)=0 OR EXISTS(SELECT 1 FROM apt_op_keys k WHERE k.almacen=m.almacen AND k.lote=l.lote));
 -- Coverage remains first/last observed dates, not proof of continuous activity.
 SELECT COALESCE(jsonb_agg(jsonb_build_object('kind',kind,'desde',desde,'hasta',hasta,'rows',rows,'missing_weight_rows',missing) ORDER BY kind),'[]')
 INTO v_coverage FROM (SELECT kind,min(fecha) AS desde,max(fecha) AS hasta,count(*) AS rows,count(*) FILTER(WHERE peso_kg<=0) AS missing
 FROM apt_op_scope GROUP BY kind) x;
 RETURN jsonb_build_object('success',true,'schema_version',1,'filters',p-'limit'-'offset','meta',v_meta,'kpis',v_kpis,
  'quality',jsonb_build_object('missing_weight_rows',v_missing,'temporal_anomaly_rows',v_temporal,'negative_balance_rows',v_negative),
  'coverage',v_coverage,'series',v_series,'warehouses',v_warehouses,'rows',v_rows,'total',v_total,'limit',v_limit,'offset',v_offset);
END $function$;
REVOKE ALL ON FUNCTION public.apt_operational_summary_live(p jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_operational_summary_live(p jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.apt_ot_familia(p_q text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_ot text := public.apt_ot_raiz(p_q); v_cut date; v_miembros jsonb; v_grupos jsonb; v_res jsonb; v_vinc jsonb; v_sosp jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  IF v_ot IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Escriba una OT (p. ej. 16339) o uno de sus lotes'); END IF;
  SELECT cutoff INTO v_cut FROM public.apt_flow_state WHERE id = 1;

  DROP TABLE IF EXISTS pg_temp.f_sosp;
  CREATE TEMP TABLE f_sosp ON COMMIT DROP AS SELECT * FROM public.apt_ot_sospechosos(v_ot);
  CREATE INDEX ON f_sosp(lote);
  ANALYZE f_sosp;

  -- Lotes de la familia (y sospechosos) con sus cifras por lote
  DROP TABLE IF EXISTS pg_temp.f_lot;
  DROP TABLE IF EXISTS pg_temp.f_keys;
  CREATE TEMP TABLE f_keys ON COMMIT DROP AS

    SELECT DISTINCT m.lote FROM public.apt_movements m WHERE m.active AND m.valid AND public.apt_ot_raiz(m.lote) = v_ot
    UNION SELECT lote FROM public.apt_flow_layers WHERE public.apt_ot_raiz(lote) = v_ot
    UNION SELECT lote FROM f_sosp;
  CREATE UNIQUE INDEX apt_family_keys_idx ON f_keys(lote);
  ANALYZE f_keys;
  CREATE TEMP TABLE f_lot ON COMMIT DROP AS
  WITH   ly AS (SELECT l.lote, sum(l.kg_in) FILTER (WHERE l.tipo = 'PRODUCCION') AS prod,
                sum(l.kg_in) FILTER (WHERE l.tipo IN ('INICIAL', 'DEVOLUCION', 'OTRO_ALMACEN')) AS otros_in,
                sum(l.kg_in) FILTER (WHERE l.tipo = 'TRASPASO' AND public.apt_ot_raiz(l.lote_origen) IS DISTINCT FROM v_ot
                                     AND l.lote_origen IS DISTINCT FROM l.lote) AS asignado,
                sum(l.kg_saldo) AS saldo,
                sum(l.kg_saldo) FILTER (WHERE l.almacen = '647') AS s647, sum(l.kg_saldo) FILTER (WHERE l.almacen = '540') AS s540,
                sum(l.kg_saldo) FILTER (WHERE l.almacen = 'ST') AS sst,
                max(l.cliente) AS cliente, min(l.fecha) FILTER (WHERE l.tipo = 'PRODUCCION') AS primera_prod,
                max(v_cut - l.fecha) FILTER (WHERE l.kg_saldo > 0.0005) AS dias_saldo
         FROM public.apt_flow_layers l JOIN pg_temp.f_keys USING (lote) GROUP BY l.lote),
  ex AS (SELECT x.lote, sum(x.kg) FILTER (WHERE x.tipo = 'DESPACHO') AS desp, count(DISTINCT x.documento) FILTER (WHERE x.tipo = 'DESPACHO') AS guias,
                max(x.fecha) FILTER (WHERE x.tipo = 'DESPACHO') AS ultima_guia, sum(x.kg) FILTER (WHERE x.tipo = 'CONSUMO') AS cons,
                sum(x.kg) FILTER (WHERE x.tipo = 'OTRO_ALMACEN') AS otro_out,
                sum(x.kg) FILTER (WHERE x.tipo = 'TRASPASO' AND public.apt_ot_raiz(x.lote_destino) IS DISTINCT FROM v_ot
                                  AND x.lote_destino IS DISTINCT FROM x.lote) AS cedido,
                max(x.cliente) FILTER (WHERE x.tipo = 'DESPACHO') AS cliente
         FROM public.apt_flow_exits x JOIN pg_temp.f_keys USING (lote) GROUP BY x.lote),
  mv AS (SELECT m.lote, count(*) AS movs, min(m.fecha) AS f0, max(m.fecha) AS f1
         FROM public.apt_movements m JOIN pg_temp.f_keys USING (lote) WHERE m.active AND m.valid GROUP BY m.lote)
  SELECT lt.lote, CASE WHEN s.lote IS NOT NULL THEN 'SOSPECHOSO' ELSE public.apt_lote_variante(lt.lote) END AS variante, s.parecido_a,
    COALESCE(ex.cliente, ly.cliente) AS cliente, COALESCE(ly.prod, 0) AS prod, COALESCE(ly.otros_in, 0) AS otros_in, COALESCE(ly.asignado, 0) AS asignado,
    COALESCE(ex.desp, 0) AS desp, COALESCE(ex.guias, 0) AS guias, COALESCE(ex.cons, 0) AS cons, COALESCE(ex.otro_out, 0) AS otro_out,
    COALESCE(ex.cedido, 0) AS cedido, COALESCE(ly.saldo, 0) AS saldo, COALESCE(ly.s647, 0) AS s647, COALESCE(ly.s540, 0) AS s540,
    COALESCE(ly.sst, 0) AS sst, ly.primera_prod, ex.ultima_guia, ly.dias_saldo, COALESCE(mv.movs, 0) AS movs, mv.f0, mv.f1
  FROM pg_temp.f_keys lt LEFT JOIN f_sosp s ON s.lote = lt.lote LEFT JOIN ly ON ly.lote = lt.lote LEFT JOIN ex ON ex.lote = lt.lote LEFT JOIN mv ON mv.lote = lt.lote;
  CREATE INDEX ON f_lot(lote);
  ANALYZE f_lot;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('lote', lote, 'variante', variante, 'parecido_a', parecido_a, 'cliente', cliente,
           'produccion_tn', public.apt_flow_tn(prod), 'otros_ingresos_tn', public.apt_flow_tn(otros_in), 'asignado_tn', public.apt_flow_tn(asignado),
           'despacho_tn', public.apt_flow_tn(desp), 'guias', guias, 'consumo_tn', public.apt_flow_tn(cons), 'otro_almacen_tn', public.apt_flow_tn(otro_out),
           'cedido_tn', public.apt_flow_tn(cedido), 'saldo_tn', public.apt_flow_tn(saldo),
           'saldo_almacen', jsonb_build_object('647', public.apt_flow_tn(s647), '540', public.apt_flow_tn(s540), 'ST', public.apt_flow_tn(sst)),
           'primera_produccion', primera_prod, 'ultima_guia', ultima_guia, 'dias_saldo', dias_saldo, 'movimientos', movs, 'desde', f0, 'hasta', f1)
           ORDER BY CASE variante WHEN 'MADRE' THEN 1 WHEN 'SUBCONTRATO' THEN 2 WHEN 'ERROR' THEN 3 WHEN 'GARANTIA' THEN 4 WHEN 'DEVOLUCION' THEN 5
                                  WHEN 'OTRO' THEN 6 ELSE 7 END, lote), '[]')
  INTO v_miembros FROM f_lot;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('variante', variante, 'lotes', n, 'produccion_tn', public.apt_flow_tn(prod),
           'despacho_tn', public.apt_flow_tn(desp), 'saldo_tn', public.apt_flow_tn(saldo),
           'guias', (SELECT count(DISTINCT x.documento) FROM public.apt_flow_exits x JOIN f_lot f2 ON f2.lote = x.lote
                     WHERE x.tipo = 'DESPACHO' AND f2.variante = z.variante))
           ORDER BY CASE variante WHEN 'MADRE' THEN 1 WHEN 'SUBCONTRATO' THEN 2 WHEN 'ERROR' THEN 3 WHEN 'GARANTIA' THEN 4 WHEN 'DEVOLUCION' THEN 5
                                  WHEN 'OTRO' THEN 6 ELSE 7 END), '[]')
  INTO v_grupos
  FROM (SELECT variante, count(*) AS n, sum(prod) AS prod, sum(desp) AS desp, sum(saldo) AS saldo FROM f_lot GROUP BY 1) z;

  SELECT jsonb_build_object('lotes', count(*) FILTER (WHERE variante <> 'SOSPECHOSO'), 'sospechosos', count(*) FILTER (WHERE variante = 'SOSPECHOSO'),
      'produccion_tn', public.apt_flow_tn(sum(prod) FILTER (WHERE variante <> 'SOSPECHOSO')),
      'asignado_tn', public.apt_flow_tn(sum(asignado) FILTER (WHERE variante <> 'SOSPECHOSO')),
      'despacho_tn', public.apt_flow_tn(sum(desp) FILTER (WHERE variante <> 'SOSPECHOSO')),
      'consumo_tn', public.apt_flow_tn(sum(cons) FILTER (WHERE variante <> 'SOSPECHOSO')),
      'cedido_tn', public.apt_flow_tn(sum(cedido) FILTER (WHERE variante <> 'SOSPECHOSO')),
      'saldo_tn', public.apt_flow_tn(sum(saldo) FILTER (WHERE variante <> 'SOSPECHOSO')),
      'sospechoso_tn', public.apt_flow_tn(sum(prod + otros_in + asignado) FILTER (WHERE variante = 'SOSPECHOSO')),
      'guias', (SELECT count(DISTINCT x.documento) FROM public.apt_flow_exits x WHERE x.tipo = 'DESPACHO'
                AND x.lote IN (SELECT lote FROM f_lot WHERE variante <> 'SOSPECHOSO')),
      'primera_produccion', min(primera_prod), 'ultima_guia', max(ultima_guia),
      'cliente', (SELECT cliente FROM f_lot WHERE cliente IS NOT NULL GROUP BY cliente ORDER BY sum(prod + desp) DESC LIMIT 1),
      'dias_total', (SELECT round(sum(p.kg * (p.fecha_salida - p.fecha_origen)) / NULLIF(sum(p.kg), 0), 1) FROM public.apt_flow_pieces p
                     WHERE public.apt_ot_raiz(p.lote) = v_ot AND NOT p.es_saldo AND p.salida_tipo = 'DESPACHO' AND p.origen = 'PRODUCCION'))
  INTO v_res FROM f_lot;

  -- Vinculados: lotes de otra raíz relacionados con la OT
  -- (el traspaso de un adelanto también trae el contrato de la OT: la referencia solo suma si no hay otro rol)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('lote', lote, 'roles', roles, 'tn', public.apt_flow_tn(kg),
           'adelanto_tn', public.apt_flow_tn(ade), 'reasignado_tn', public.apt_flow_tn(rea), 'insumo_tn', public.apt_flow_tn(ins),
           'movimientos', n, 'hacia', hacia, 'glosa', glosa, 'desde', f0, 'hasta', f1) ORDER BY kg DESC NULLS LAST, lote), '[]')
  INTO v_vinc
  FROM (SELECT lote, array_agg(DISTINCT rol ORDER BY rol) AS roles,
               COALESCE(sum(kg) FILTER (WHERE rol = 'ADELANTO'), 0) AS ade, COALESCE(sum(kg) FILTER (WHERE rol = 'REASIGNADO'), 0) AS rea,
               COALESCE(sum(kg) FILTER (WHERE rol = 'INSUMO'), 0) AS ins,
               CASE WHEN bool_or(rol <> 'REFERENCIA') THEN COALESCE(sum(kg) FILTER (WHERE rol <> 'REFERENCIA'), 0) ELSE sum(kg) END AS kg,
               sum(n) AS n,
               (array_agg(hacia ORDER BY kg DESC NULLS LAST))[1] AS hacia, max(glosa) AS glosa, min(f0) AS f0, max(f1) AS f1
        FROM (
          -- Adelanto: material de otro lote que pasó a la familia por traspaso
          SELECT l.lote_origen AS lote, 'ADELANTO' AS rol, sum(l.kg_in) AS kg, count(*) AS n, max(l.lote) AS hacia, max(l.glosa) AS glosa,
                 min(l.fecha) AS f0, max(l.fecha) AS f1
          FROM public.apt_flow_layers l
          WHERE public.apt_ot_raiz(l.lote) = v_ot AND l.tipo = 'TRASPASO' AND l.lote_origen IS NOT NULL
            AND public.apt_ot_raiz(l.lote_origen) IS DISTINCT FROM v_ot AND l.lote_origen NOT IN (SELECT lote FROM f_sosp)
          GROUP BY 1
          UNION ALL
          -- Reasignado: material de la familia que pasó a otro lote
          SELECT x.lote_destino, 'REASIGNADO', sum(x.kg), count(*), max(x.lote), max(x.glosa), min(x.fecha), max(x.fecha)
          FROM public.apt_flow_exits x
          WHERE public.apt_ot_raiz(x.lote) = v_ot AND x.tipo = 'TRASPASO' AND x.lote_destino IS NOT NULL
            AND public.apt_ot_raiz(x.lote_destino) IS DISTINCT FROM v_ot AND x.lote_destino NOT IN (SELECT lote FROM f_sosp)
          GROUP BY 1
          UNION ALL
          -- Referencia del ERP: otro lote cuyo contrato o NumRel es de la OT (insumos consumidos, traspasos al contrato)
          SELECT m.lote, CASE m.kind WHEN 'CONSUMO' THEN 'INSUMO' ELSE 'REFERENCIA' END, sum(m.peso_kg), count(*),
                 max(COALESCE(m.contrato, m.numrel)), max(m.glosa), min(m.fecha), max(m.fecha)
          FROM public.apt_movements m
          WHERE m.active AND m.valid AND m.lote IS NOT NULL AND public.apt_ot_raiz(m.lote) IS DISTINCT FROM v_ot
            AND m.lote NOT IN (SELECT lote FROM f_sosp)
            AND (public.apt_ot_raiz(m.contrato) = v_ot OR public.apt_ot_raiz(m.numrel) = v_ot)
          GROUP BY 1, 2) z
        GROUP BY lote) v;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('lote', lote, 'parecido_a', parecido_a) ORDER BY lote), '[]') INTO v_sosp FROM f_sosp;

  RETURN jsonb_build_object('success', true, 'ot', v_ot, 'q', upper(btrim(p_q)), 'cutoff', v_cut, 'resumen', v_res, 'grupos', v_grupos,
    'miembros', v_miembros, 'vinculados', v_vinc, 'sospechosos', v_sosp);
END $function$;
REVOKE ALL ON FUNCTION public.apt_ot_familia(p_q text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_ot_familia(p_q text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_ot_raiz(p_lote text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT substring(upper(btrim(p_lote)) FROM '^([0-9]{3,})(?:$|[^0-9])');
$function$;
REVOKE ALL ON FUNCTION public.apt_ot_raiz(p_lote text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_ot_raiz(p_lote text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_ot_sospechosos(p_ot text)
 RETURNS TABLE(lote text, parecido_a text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH mv AS (SELECT DISTINCT m.lote, public.apt_ot_raiz(m.lote) AS raiz FROM public.apt_movements m WHERE m.active AND m.valid AND m.lote IS NOT NULL),
  fam AS (SELECT lote, substr(lote, length(raiz) + 1) AS suf FROM mv WHERE raiz = p_ot),
  cand AS (SELECT mv.lote, mv.raiz, substr(mv.lote, length(mv.raiz) + 1) AS suf FROM mv
           WHERE mv.raiz IS NOT NULL AND mv.raiz <> p_ot AND abs(length(mv.raiz) - length(p_ot)) <= 1 AND public.apt_raiz_parecida(mv.raiz, p_ot))
  SELECT c.lote, f.lote FROM cand c
  JOIN fam f ON f.suf = c.suf
  WHERE c.suf ~ '^-[SEG][0-9]'   -- solo códigos con sufijo: una OT madre parecida suele ser otra OT real
    -- Una OT real tiene producción o guías propias; el lote mal digitado solo aparece en traspasos o consumos
    AND NOT EXISTS (SELECT 1 FROM public.apt_movements e WHERE e.active AND e.valid AND e.kind IN ('ENTRADA', 'SALIDA')
                    AND public.apt_ot_raiz(e.lote) = c.raiz);
$function$;
REVOKE ALL ON FUNCTION public.apt_ot_sospechosos(p_ot text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_ot_sospechosos(p_ot text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_pareto(p jsonb DEFAULT '{}'::jsonb, p_dim text DEFAULT 'lote'::text, p_metric text DEFAULT 'tn'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_out jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  IF p_dim NOT IN ('lote', 'producto', 'glosa', 'familia') THEN p_dim := 'lote'; END IF;
  WITH g AS (SELECT clave, etiqueta, CASE WHEN p_metric = 'txd' THEN tn_dias ELSE kg_saldo / 1000 END AS v, dias
             FROM public.apt_group(COALESCE(p, '{}'::jsonb), p_dim) WHERE kg_saldo > 0.0005),
  r AS (SELECT *, row_number() OVER (ORDER BY v DESC, clave) AS rk, sum(v) OVER (ORDER BY v DESC, clave) AS cum, sum(v) OVER () AS tot, count(*) OVER () AS n FROM g),
  c AS (SELECT *, round(100 * v / NULLIF(tot, 0), 2) AS pct, round(100 * cum / NULLIF(tot, 0), 2) AS pct_acum FROM r)
  SELECT jsonb_build_object('success', true, 'dim', p_dim, 'metric', p_metric,
    'total', round(COALESCE(max(tot), 0), 3), 'items_total', COALESCE(max(n), 0),
    'items_80', min(rk) FILTER (WHERE pct_acum >= 80),
    'pct_items_80', round(100.0 * min(rk) FILTER (WHERE pct_acum >= 80) / NULLIF(max(n), 0), 1),
    'items', COALESCE(jsonb_agg(jsonb_build_object('rank', rk, 'clave', clave, 'etiqueta', etiqueta, 'valor', round(v, 3), 'dias', dias,
               'pct', pct, 'pct_acum', pct_acum, 'clase', CASE WHEN pct_acum - pct < 80 THEN 'A' WHEN pct_acum - pct < 95 THEN 'B' ELSE 'C' END)
               ORDER BY rk) FILTER (WHERE rk <= 500), '[]'))
  INTO v_out FROM c;
  RETURN v_out;
END $function$;
REVOKE ALL ON FUNCTION public.apt_pareto(p jsonb, p_dim text, p_metric text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_pareto(p jsonb, p_dim text, p_metric text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_quality()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_cut date; v_src_in numeric; v_mod_in numeric; v_src_out numeric; v_mod_out numeric; v_alloc numeric; v_out_layers numeric;
        v_saldo numeric; v_checks jsonb; v_rec jsonb; v_raw_in numeric; v_raw_out numeric; v_rest_in numeric; v_rest_out numeric;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  SELECT cutoff INTO v_cut FROM public.apt_state WHERE id = 1;

  SELECT jsonb_agg(jsonb_build_object('tipo', k.kind,
      'filas', (SELECT count(*) FROM public.apt_movements WHERE active AND kind = k.kind),
      'validas', (SELECT count(*) FROM public.apt_movements WHERE active AND valid AND kind = k.kind),
      'excluidas', (SELECT count(*) FROM public.apt_movements WHERE active AND NOT valid AND kind = k.kind),
      'motivos_exclusion', (SELECT COALESCE(jsonb_object_agg(invalid_reason, n), '{}') FROM (SELECT invalid_reason, count(*) AS n FROM public.apt_movements
                             WHERE active AND NOT valid AND kind = k.kind GROUP BY 1) z),
      'fecha_min', (SELECT min(fecha) FROM public.apt_movements WHERE active AND valid AND kind = k.kind),
      'fecha_max', (SELECT max(fecha) FROM public.apt_movements WHERE active AND valid AND kind = k.kind),
      'dias_con_movimiento', (SELECT count(DISTINCT fecha) FROM public.apt_movements WHERE active AND valid AND kind = k.kind),
      'posteriores_al_corte', (SELECT count(*) FROM public.apt_movements WHERE active AND valid AND kind = k.kind AND fecha > v_cut),
      'tn', (SELECT round(COALESCE(sum(peso_kg), 0) / 1000, 3) FROM public.apt_movements WHERE active AND valid AND kind = k.kind),
      'lotes', (SELECT count(DISTINCT lote) FROM public.apt_movements WHERE active AND valid AND kind = k.kind),
      'productos', (SELECT count(DISTINCT producto) FROM public.apt_movements WHERE active AND valid AND kind = k.kind),
      'documentos', (SELECT count(DISTINCT documento) FROM public.apt_movements WHERE active AND valid AND kind = k.kind),
      'sin_peso', (SELECT count(*) FROM public.apt_movements WHERE active AND valid AND kind = k.kind AND peso_kg <= 0),
      'sin_numrel', (SELECT count(*) FROM public.apt_movements WHERE active AND valid AND kind = k.kind AND numrel IS NULL),
      'lote_derivado', (SELECT count(*) FROM public.apt_movements WHERE active AND valid AND kind = k.kind AND lote_derivado),
      'error_contrato_a_lote', (SELECT count(*) FROM public.apt_movements WHERE active AND valid AND kind = k.kind AND docrel = 'ERROR DE CONTRATO' AND lote_origen IS NOT NULL),
      'peso_inconsistente', (SELECT count(*) FROM public.apt_movements WHERE active AND valid AND kind = k.kind AND peso_unitario IS NOT NULL
                               AND cantidad IS NOT NULL AND abs(cantidad * peso_unitario - peso_kg) > 1),
      'duplicados', (SELECT COALESCE(sum(n - 1), 0) FROM (SELECT count(*) AS n FROM public.apt_movements WHERE active AND valid AND kind = k.kind
                       GROUP BY documento, producto, numrel, cantidad, peso_kg HAVING count(*) > 1) z),
      'unidades', (SELECT COALESCE(jsonb_object_agg(COALESCE(unidad, '(vacía)'), n), '{}') FROM (SELECT unidad, count(*) AS n FROM public.apt_movements
                     WHERE active AND valid AND kind = k.kind GROUP BY 1) z),
      'bodegas', (SELECT COALESCE(jsonb_object_agg(COALESCE(bodega, '(vacía)'), n), '{}') FROM (SELECT bodega, count(*) AS n FROM public.apt_movements
                     WHERE active AND valid AND kind = k.kind GROUP BY 1) z),
      'docrels', (SELECT COALESCE(jsonb_object_agg(COALESCE(docrel, '(vacío)'), n), '{}') FROM (SELECT docrel, count(*) AS n FROM public.apt_movements
                     WHERE active AND valid AND kind = k.kind GROUP BY 1) z)) ORDER BY k.kind)
  INTO v_checks FROM (VALUES ('ENTRADA'), ('SALIDA')) k(kind);

  SELECT COALESCE(sum(peso_kg), 0) INTO v_src_in FROM public.apt_movements WHERE active AND valid AND kind = 'ENTRADA' AND fecha <= v_cut;
  SELECT COALESCE(sum(kg_in), 0), COALESCE(sum(kg_out), 0), COALESCE(sum(kg_saldo), 0) INTO v_mod_in, v_out_layers, v_saldo FROM public.apt_layers;
  SELECT COALESCE(sum(peso_kg), 0) INTO v_src_out FROM public.apt_movements WHERE active AND valid AND kind = 'SALIDA' AND fecha <= v_cut;
  SELECT COALESCE(sum(kg), 0) INTO v_mod_out FROM public.apt_exit_class;
  SELECT COALESCE(sum(kg), 0) INTO v_alloc FROM public.apt_allocations;
  -- Desde la fila original (raw): todo el peso de la hoja = modelo + excluidas + posteriores al corte
  SELECT COALESCE(sum(abs(public.apt_num(raw -> 'PesoTotalProduccido'))) FILTER (WHERE kind = 'ENTRADA'), 0),
         COALESCE(sum(abs(public.apt_num(raw -> 'PesoTotalProduccido'))) FILTER (WHERE kind = 'SALIDA'), 0),
         COALESCE(sum(CASE WHEN NOT valid THEN COALESCE(abs(public.apt_num(raw -> 'PesoTotalProduccido')), 0) WHEN fecha > v_cut THEN peso_kg ELSE 0 END)
                  FILTER (WHERE kind = 'ENTRADA'), 0),
         COALESCE(sum(CASE WHEN NOT valid THEN COALESCE(abs(public.apt_num(raw -> 'PesoTotalProduccido')), 0) WHEN fecha > v_cut THEN peso_kg ELSE 0 END)
                  FILTER (WHERE kind = 'SALIDA'), 0)
    INTO v_raw_in, v_raw_out, v_rest_in, v_rest_out
  FROM public.apt_movements WHERE active;

  v_rec := jsonb_build_array(
    jsonb_build_object('concepto', 'TN hoja ENTRADA (fila original)', 'fuente', round(v_raw_in / 1000, 3), 'modelo', round((v_mod_in + v_rest_in) / 1000, 3),
      'explicacion', 'Peso de todas las filas cargadas = capas FIFO + filas excluidas + ingresos posteriores al corte'),
    jsonb_build_object('concepto', 'TN hoja SALIDA (fila original)', 'fuente', round(v_raw_out / 1000, 3), 'modelo', round((v_mod_out + v_rest_out) / 1000, 3),
      'explicacion', 'Asignadas a capas + sin entrada identificada + otros productos del lote + lotes sin ingreso + sin NumRel + excluidas + posteriores al corte'),
    jsonb_build_object('concepto', 'TN ENTRADA válidas hasta el corte', 'fuente', round(v_src_in / 1000, 3), 'modelo', round(v_mod_in / 1000, 3),
      'explicacion', 'Σ capas FIFO = Σ filas de ENTRADA válidas'),
    jsonb_build_object('concepto', 'TN despachadas de lo ingresado', 'fuente', round(v_alloc / 1000, 3), 'modelo', round(v_out_layers / 1000, 3),
      'explicacion', 'Σ asignaciones FIFO = Σ despachado de las capas'),
    jsonb_build_object('concepto', 'Saldo = ingresado − despachado', 'fuente', round((v_mod_in - v_out_layers) / 1000, 3), 'modelo', round(v_saldo / 1000, 3),
      'explicacion', 'Saldo de las capas'),
    jsonb_build_object('concepto', 'Asignado por salida = asignado por capa', 'fuente', round((SELECT COALESCE(sum(kg_asignado), 0) FROM public.apt_exit_class) / 1000, 3),
      'modelo', round(v_alloc / 1000, 3), 'explicacion', 'Cada kg despachado se asigna una sola vez'));
  SELECT jsonb_agg(e || jsonb_build_object('diferencia', round((e ->> 'fuente')::numeric - (e ->> 'modelo')::numeric, 3),
           'estado', CASE WHEN abs((e ->> 'fuente')::numeric - (e ->> 'modelo')::numeric) < 0.001 THEN 'OK' ELSE 'REVISAR' END))
    INTO v_rec FROM jsonb_array_elements(v_rec) e;

  RETURN jsonb_build_object('success', true, 'cutoff', v_cut, 'hojas', v_checks, 'conciliacion', v_rec,
    'salidas_por_clase', (SELECT COALESCE(jsonb_agg(jsonb_build_object('clase', clase, 'filas', n, 'tn', round(kg / 1000, 3),
                            'tn_sin_entrada', round(kse / 1000, 3)) ORDER BY kg DESC), '[]')
                          FROM (SELECT clase, count(*) AS n, sum(kg) AS kg, sum(kg_sin_entrada) AS kse FROM public.apt_exit_class GROUP BY clase) z),
    'capas_por_estado', (SELECT COALESCE(jsonb_agg(jsonb_build_object('estado', estado, 'capas', n, 'tn_in', round(kg / 1000, 3)) ORDER BY kg DESC), '[]')
                         FROM (SELECT estado, count(*) AS n, sum(kg_in) AS kg FROM public.apt_layers GROUP BY estado) z),
    'salida_antes_de_ingreso', jsonb_build_object('capas', (SELECT count(*) FROM public.apt_layers WHERE kg_out_before_in > 0.5),
                                 'tn', round((SELECT COALESCE(sum(kg_out_before_in), 0) FROM public.apt_layers) / 1000, 3)),
    'lotes_sin_ingreso', (SELECT count(DISTINCT lote) FROM public.apt_exit_class WHERE clase = 'LOTE_SIN_INGRESO'),
    'posible_cruce', jsonb_build_object('capas', (SELECT count(*) FROM public.apt_layers WHERE posible_cruce),
                       'lotes', (SELECT count(DISTINCT lote) FROM public.apt_layers WHERE posible_cruce),
                       'tn_saldo', round((SELECT COALESCE(sum(kg_saldo), 0) FROM public.apt_layers WHERE posible_cruce) / 1000, 3)),
    'problema_info', jsonb_build_object('capas', (SELECT count(*) FROM public.apt_layers WHERE problema_info),
                       'tn_in', round((SELECT COALESCE(sum(kg_in), 0) FROM public.apt_layers WHERE problema_info) / 1000, 3)),
    'historico_suficiente', (SELECT count(DISTINCT fecha) >= 7 FROM public.apt_movements WHERE active AND valid AND kind = 'ENTRADA'),
    'excluidas_total', (SELECT count(*) FROM public.apt_movements WHERE active AND NOT valid),
    'excluidas', (SELECT COALESCE(jsonb_agg(jsonb_build_object('tipo', m.kind, 'fila', m.row_no, 'archivo', u.file_name, 'motivo', m.invalid_reason, 'raw', m.raw)
                    ORDER BY m.kind, m.row_no), '[]')
                  FROM (SELECT * FROM public.apt_movements WHERE active AND NOT valid ORDER BY kind, row_no LIMIT 200) m
                  JOIN public.apt_uploads u ON u.id = m.upload_id));
END $function$;
REVOKE ALL ON FUNCTION public.apt_quality() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_quality() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_raiz_parecida(a text, b text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT a IS NOT NULL AND b IS NOT NULL AND a <> b AND (
    (length(a) = length(b) + 1 AND EXISTS (SELECT 1 FROM generate_series(1, length(a)) i WHERE overlay(a PLACING '' FROM i FOR 1) = b))
    OR (length(b) = length(a) + 1 AND EXISTS (SELECT 1 FROM generate_series(1, length(b)) i WHERE overlay(b PLACING '' FROM i FOR 1) = a))
    OR (length(a) = length(b) AND (
          (SELECT count(*) FROM generate_series(1, length(a)) i WHERE substr(a, i, 1) <> substr(b, i, 1)) = 1
          OR EXISTS (SELECT 1 FROM generate_series(1, length(a) - 1) i
                     WHERE overlay(a PLACING substr(a, i + 1, 1) || substr(a, i, 1) FROM i FOR 2) = b))));
$function$;
REVOKE ALL ON FUNCTION public.apt_raiz_parecida(a text, b text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_raiz_parecida(a text, b text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_read_cache_actor()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_actor uuid;
BEGIN
  -- Primero las cuentas cuyo rol declara acceso APT; apt_can_view decide con la regla vigente.
  FOR v_actor IN SELECT p.id FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
      WHERE p.is_active
      ORDER BY (r.name IN ('Administrador', 'Jefe de Distribución') OR COALESCE(r.permissions, '[]'::jsonb)::text ILIKE '%apt%') DESC, p.id LOOP
    PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
    IF public.apt_can_view() THEN RETURN v_actor; END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION public.apt_read_cache_actor() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_read_cache_actor() TO service_role;

CREATE OR REPLACE FUNCTION public.apt_read_cache_build(p_fn text, p_params jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_ok boolean;
BEGIN
  IF public.apt_read_cache_actor() IS NULL THEN RETURN false; END IF;
  v_ok := (public.apt_read_cached(p_fn, p_params) ->> 'success') = 'true';
  IF NOT v_ok THEN DELETE FROM public.apt_read_cache_requests r WHERE r.fn = p_fn AND r.key_hash = md5(p_params::text); END IF;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_ok;
END $function$;
REVOKE ALL ON FUNCTION public.apt_read_cache_build(p_fn text, p_params jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_read_cache_build(p_fn text, p_params jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.apt_read_cache_claim()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_claimed integer;
BEGIN
  DELETE FROM public.apt_read_cache_requests r WHERE r.requested_at < now() - interval '1 day'
    OR (r.attempts >= 3 AND r.claimed_at < now() - interval '6 minutes');
  -- Una sola solicitud asignada a la vez: el cálculo la atiende antes de que se asigne otra.
  IF EXISTS (SELECT 1 FROM public.apt_read_cache_requests q WHERE q.claimed_at >= now() - interval '6 minutes') THEN RETURN 0; END IF;
  UPDATE public.apt_read_cache_requests r SET attempts = r.attempts + 1, claimed_at = clock_timestamp()
  WHERE (r.fn, r.key_hash) = (SELECT q.fn, q.key_hash FROM public.apt_read_cache_requests q
    WHERE q.attempts < 3 AND (q.claimed_at IS NULL OR q.claimed_at < now() - interval '6 minutes')
    ORDER BY q.attempts, q.requested_at LIMIT 1 FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  RETURN v_claimed;
END $function$;
REVOKE ALL ON FUNCTION public.apt_read_cache_claim() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_read_cache_claim() TO service_role;

CREATE OR REPLACE FUNCTION public.apt_read_cache_key(p_fn text, p jsonb, p_grain text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE p_fn
    WHEN 'apt_dashboard' THEN jsonb_build_object('p', COALESCE(p, '{}'::jsonb), 'grain', COALESCE(p_grain, 'semana'))
    WHEN 'apt_operational_summary' THEN jsonb_build_object('p', COALESCE(p, '{}'::jsonb) - 'limit' - 'offset')
  END;
$function$;
REVOKE ALL ON FUNCTION public.apt_read_cache_key(p_fn text, p jsonb, p_grain text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_read_cache_key(p_fn text, p jsonb, p_grain text) TO service_role;

CREATE OR REPLACE FUNCTION public.apt_read_cache_next(p_skip text[] DEFAULT '{}'::text[])
 RETURNS TABLE(fn text, params jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_version text := public.apt_read_cache_version();
BEGIN
  DELETE FROM public.apt_read_cache c WHERE c.version <> v_version OR c.built_at < now() - interval '2 days';
  IF NOT EXISTS (SELECT 1 FROM public.apt_state WHERE cutoff IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM public.apt_flow_state WHERE cutoff IS NOT NULL) THEN RETURN; END IF;
  RETURN QUERY SELECT k.fn, k.params FROM (
      SELECT d.fn, d.params, 0 AS ord, NULL::timestamptz AS at FROM (VALUES
        ('apt_operational_summary', '{"p":{}}'::jsonb),
        ('apt_dashboard', '{"p":{},"grain":"semana"}'::jsonb),
        ('apt_dashboard', '{"p":{},"grain":"dia"}'::jsonb)) d(fn, params)
      UNION ALL
      SELECT x.fn, x.params, 1, x.claimed_at FROM (SELECT r.fn, r.params, r.claimed_at FROM public.apt_read_cache_requests r
        WHERE r.claimed_at >= now() - interval '6 minutes' ORDER BY r.claimed_at LIMIT 1) x) k
    WHERE NOT (k.fn || ':' || md5(k.params::text)) = ANY (p_skip)
      AND NOT EXISTS (SELECT 1 FROM public.apt_read_cache c WHERE c.fn = k.fn AND c.key_hash = md5(k.params::text)
                      AND c.params = k.params AND c.version = v_version)
    ORDER BY k.ord, k.at DESC LIMIT 1;
END $function$;
REVOKE ALL ON FUNCTION public.apt_read_cache_next(p_skip text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_read_cache_next(p_skip text[]) TO service_role;

CREATE OR REPLACE FUNCTION public.apt_read_cache_request(p_fn text, p_args jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_key jsonb;
BEGIN
  IF NOT public.is_active_tms_user() OR NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  IF p_fn NOT IN ('apt_dashboard', 'apt_operational_summary') OR jsonb_typeof(p_args) <> 'object'
     OR jsonb_typeof(COALESCE(p_args -> 'p', '{}'::jsonb)) <> 'object' OR length(p_args::text) > 1000000
     OR (p_fn = 'apt_dashboard' AND COALESCE(p_args ->> 'p_grain', 'semana') NOT IN ('dia', 'semana', 'mes')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solicitud de cálculo APT inválida');
  END IF;
  v_key := public.apt_read_cache_key(p_fn, p_args -> 'p', p_args ->> 'p_grain');
  INSERT INTO public.apt_read_cache_requests (fn, key_hash, params) VALUES (p_fn, md5(v_key::text), v_key)
  ON CONFLICT (fn, key_hash) DO UPDATE SET requested_at = clock_timestamp();
  -- Acota la cola: conserva las 50 solicitudes más recientes.
  DELETE FROM public.apt_read_cache_requests r WHERE (r.fn, r.key_hash) NOT IN
    (SELECT q.fn, q.key_hash FROM public.apt_read_cache_requests q ORDER BY q.requested_at DESC LIMIT 50);
  RETURN jsonb_build_object('success', true);
END $function$;
REVOKE ALL ON FUNCTION public.apt_read_cache_request(p_fn text, p_args jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_read_cache_request(p_fn text, p_args jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_read_cache_version()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT md5(concat_ws('|',
    (SELECT count(*) || ':' || COALESCE(max(applied_at)::text, '-') FROM public.apt_uploads WHERE status = 'APLICADA'),
    (SELECT string_agg(to_jsonb(s)::text, ',') FROM public.apt_state s),
    (SELECT string_agg(to_jsonb(s)::text, ',') FROM public.apt_flow_state s),
    (SELECT string_agg(to_jsonb(s)::text, ',') FROM public.apt_settings s),
    (SELECT string_agg(to_jsonb(r)::text, ',' ORDER BY r.desde) FROM public.apt_aging_ranges r)));
$function$;
REVOKE ALL ON FUNCTION public.apt_read_cache_version() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_read_cache_version() TO service_role;

CREATE OR REPLACE FUNCTION public.apt_read_cache_warm()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_key record; v_skip text[] := '{}'; v_built integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('apt_read_cache_warm')) THEN RETURN 0; END IF;
  FOR i IN 1..4 LOOP
    SELECT * INTO v_key FROM public.apt_read_cache_next(v_skip);
    EXIT WHEN v_key.fn IS NULL;
    v_skip := v_skip || (v_key.fn || ':' || md5(v_key.params::text));
    IF public.apt_read_cache_build(v_key.fn, v_key.params) THEN v_built := v_built + 1; END IF;
  END LOOP;
  RETURN v_built;
END $function$;
REVOKE ALL ON FUNCTION public.apt_read_cache_warm() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_read_cache_warm() TO service_role;

CREATE OR REPLACE FUNCTION public.apt_read_cached(p_fn text, p_params jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_version text := public.apt_read_cache_version(); v_result jsonb;
BEGIN
  SELECT c.result INTO v_result FROM public.apt_read_cache c
  WHERE c.fn = p_fn AND c.key_hash = md5(p_params::text) AND c.params = p_params AND c.version = v_version;
  IF FOUND THEN RETURN v_result; END IF;
  v_result := CASE p_fn
    WHEN 'apt_dashboard' THEN public.apt_dashboard_live(p_params -> 'p', p_params ->> 'grain')
    WHEN 'apt_operational_summary' THEN public.apt_operational_summary_live((p_params -> 'p') || '{"limit":999999,"offset":0}')
  END;
  IF v_result IS NULL THEN RAISE EXCEPTION 'Lectura APT no reconocida: %', p_fn; END IF;
  IF (v_result ->> 'success') = 'true' THEN
    INSERT INTO public.apt_read_cache (fn, key_hash, params, version, result) VALUES (p_fn, md5(p_params::text), p_params, v_version, v_result)
    ON CONFLICT (fn, key_hash) DO UPDATE SET params = EXCLUDED.params, version = EXCLUDED.version, result = EXCLUDED.result, built_at = clock_timestamp();
    DELETE FROM public.apt_read_cache_requests r WHERE r.fn = p_fn AND r.key_hash = md5(p_params::text);
  END IF;
  RETURN v_result;
END $function$;
REVOKE ALL ON FUNCTION public.apt_read_cached(p_fn text, p_params jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_read_cached(p_fn text, p_params jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.apt_readiness_history_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN RAISE EXCEPTION 'El historial de revisión es inmutable'; END $function$;
REVOKE ALL ON FUNCTION public.apt_readiness_history_immutable() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_readiness_history_immutable() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_readiness_list(p_keys jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_rows jsonb;
BEGIN
 IF NOT public.is_active_tms_user() OR NOT public.apt_can_view() THEN RETURN jsonb_build_object('success',false,'error','Sin acceso al módulo APT'); END IF;
 IF jsonb_typeof(p_keys)<>'array' OR jsonb_array_length(p_keys)>100 THEN RETURN jsonb_build_object('success',false,'error','Seleccione hasta 100 registros'); END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]') INTO v_rows FROM public.apt_operational_readiness r
 WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(p_keys) k WHERE r.almacen=k->>'almacen' AND r.lote=k->>'lote' AND r.producto=COALESCE(NULLIF(k->>'producto',''),'*'));
 RETURN jsonb_build_object('success',true,'rows',v_rows,'can_edit',public.apt_can_load());
END $function$;
REVOKE ALL ON FUNCTION public.apt_readiness_list(p_keys jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_readiness_list(p_keys jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_readiness_save(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_almacen text:=p->>'almacen';v_lote text:=trim(p->>'lote');v_producto text:=COALESCE(NULLIF(trim(p->>'producto'),''),'*');v_before jsonb;v_after jsonb;v_expected text:=p->>'expected_updated_at';
BEGIN
 IF NOT public.is_active_tms_user() OR NOT public.apt_can_load() OR auth.uid() IS NULL THEN RETURN jsonb_build_object('success',false,'error','Sin permiso para registrar la revisión APT'); END IF;
 IF v_almacen NOT IN('647','540','ST') OR v_lote IS NULL OR length(v_lote) NOT BETWEEN 1 AND 120 OR length(v_producto)>120 OR COALESCE(p->>'status','') NOT IN('NO_EVALUADO','DISPONIBLE','BLOQUEADO') THEN RETURN jsonb_build_object('success',false,'error','Revise almacén, lote y estado'); END IF;
 IF length(COALESCE(p->>'reason',''))>2000 OR length(COALESCE(p->>'responsible_name',''))>200 OR length(COALESCE(p->>'next_action',''))>2000 THEN RETURN jsonb_build_object('success',false,'error','El texto supera el tamaño permitido'); END IF;
 IF p->>'status'<>'NO_EVALUADO' AND (length(trim(COALESCE(p->>'reason','')))=0 OR length(trim(COALESCE(p->>'responsible_name','')))=0 OR length(trim(COALESCE(p->>'next_action','')))=0) THEN RETURN jsonb_build_object('success',false,'error','Registre motivo, responsable y próxima acción'); END IF;
 -- Serialize new keys as well as updates, so two reviewers cannot silently overwrite one another.
 PERFORM pg_advisory_xact_lock(hashtextextended(v_almacen||'|'||v_lote||'|'||v_producto,0));
 SELECT to_jsonb(r) INTO v_before FROM public.apt_operational_readiness r WHERE almacen=v_almacen AND lote=v_lote AND producto=v_producto FOR UPDATE;
 IF (v_before IS NOT NULL AND (v_expected IS NULL OR (v_before->>'updated_at')::timestamptz<>v_expected::timestamptz)) OR (v_before IS NULL AND v_expected IS NOT NULL) THEN RETURN jsonb_build_object('success',false,'error','La revisión cambió. Actualice y vuelva a revisar.'); END IF;
 INSERT INTO public.apt_operational_readiness(almacen,lote,producto,status,reason,responsible_name,next_action,updated_by) VALUES(v_almacen,v_lote,v_producto,p->>'status',NULLIF(trim(p->>'reason'),''),NULLIF(trim(p->>'responsible_name'),''),NULLIF(trim(p->>'next_action'),''),auth.uid())
 ON CONFLICT(almacen,lote,producto) DO UPDATE SET status=EXCLUDED.status,reason=EXCLUDED.reason,responsible_name=EXCLUDED.responsible_name,next_action=EXCLUDED.next_action,updated_at=clock_timestamp(),updated_by=auth.uid()
 RETURNING to_jsonb(apt_operational_readiness) INTO v_after;
 INSERT INTO public.apt_operational_readiness_history(almacen,lote,producto,before_data,after_data,created_by) VALUES(v_almacen,v_lote,v_producto,v_before,v_after,auth.uid());
 RETURN jsonb_build_object('success',true,'row',v_after);
END $function$;
REVOKE ALL ON FUNCTION public.apt_readiness_save(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_readiness_save(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_rebuild()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s record; v_min date; v_max date; v_cut date;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('apt_rebuild'));
  SELECT * INTO s FROM public.apt_settings WHERE id = 1;
  SELECT min(fecha), max(fecha) INTO v_min, v_max FROM public.apt_movements WHERE active AND valid;
  v_cut := COALESCE(s.cutoff_date, v_max);

  DELETE FROM public.apt_allocations WHERE true;
  DELETE FROM public.apt_exit_class WHERE true;
  DELETE FROM public.apt_layers WHERE true;
  UPDATE public.apt_state SET cutoff = v_cut, data_min = v_min, data_max = v_max, rebuilt_at = now() WHERE id = 1;
  IF v_cut IS NULL THEN RETURN jsonb_build_object('success', true, 'cutoff', NULL); END IF;

  DROP TABLE IF EXISTS pg_temp.apt_e;
  DROP TABLE IF EXISTS pg_temp.apt_s;
  CREATE TEMP TABLE apt_e ON COMMIT DROP AS
    SELECT id, lote, producto, fecha, peso_kg AS kg,
           sum(peso_kg) OVER w - peso_kg AS c0, sum(peso_kg) OVER w AS c1
    FROM public.apt_movements
    WHERE active AND valid AND kind = 'ENTRADA' AND fecha <= v_cut
    WINDOW w AS (PARTITION BY lote, producto ORDER BY fecha, id ROWS UNBOUNDED PRECEDING);
  CREATE INDEX ON apt_e (lote, producto);
  ANALYZE apt_e;

  CREATE TEMP TABLE apt_s ON COMMIT DROP AS
    SELECT m.id, m.lote, m.producto, m.fecha, m.peso_kg AS kg,
           sum(m.peso_kg) OVER w - m.peso_kg AS c0, sum(m.peso_kg) OVER w AS c1
    FROM public.apt_movements m
    WHERE m.active AND m.valid AND m.kind = 'SALIDA' AND m.fecha <= v_cut AND m.lote IS NOT NULL
      AND EXISTS (SELECT 1 FROM apt_e e WHERE e.lote = m.lote AND e.producto = m.producto)
    WINDOW w AS (PARTITION BY m.lote, m.producto ORDER BY m.fecha, m.id ROWS UNBOUNDED PRECEDING);

  CREATE INDEX apt_s_rebuild_key_idx ON apt_s (lote, producto);
  ANALYZE apt_s;

  -- Superposición de tramos acumulados = kg que cada salida toma de cada capa (FIFO)
  INSERT INTO public.apt_allocations (layer_id, exit_id, kg, fecha_ingreso, fecha_salida, dias)
  SELECT e.id, x.id, LEAST(e.c1, x.c1) - GREATEST(e.c0, x.c0), e.fecha, x.fecha, GREATEST(x.fecha - e.fecha, 0)
  FROM apt_e e JOIN apt_s x ON x.lote = e.lote AND x.producto = e.producto AND x.c0 < e.c1 AND x.c1 > e.c0
  WHERE LEAST(e.c1, x.c1) - GREATEST(e.c0, x.c0) > 0;

  INSERT INTO public.apt_exit_class (exit_id, lote, producto, fecha, kg, kg_asignado, kg_sin_entrada, clase)
  SELECT m.id, m.lote, m.producto, m.fecha, m.peso_kg, COALESCE(a.kg, 0), GREATEST(m.peso_kg - COALESCE(a.kg, 0), 0),
    CASE WHEN m.lote IS NULL THEN 'SIN_NUMREL'
         WHEN k.matched AND m.peso_kg - COALESCE(a.kg, 0) <= 0.001 THEN 'ASIGNADA'
         WHEN k.matched THEN 'EXCEDE_INGRESO'
         WHEN EXISTS (SELECT 1 FROM apt_e e WHERE e.lote = m.lote) THEN 'OTRO_PRODUCTO_DEL_LOTE'
         ELSE 'LOTE_SIN_INGRESO' END
  FROM public.apt_movements m
  LEFT JOIN (SELECT exit_id, sum(kg) AS kg FROM public.apt_allocations GROUP BY exit_id) a ON a.exit_id = m.id
  CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM apt_e e WHERE e.lote = m.lote AND e.producto = m.producto) AS matched) k
  WHERE m.active AND m.valid AND m.kind = 'SALIDA' AND m.fecha <= v_cut;

  INSERT INTO public.apt_layers (movement_id, lote, producto, numrel_op, glosa, familia, ipt, documento, docrel,
    fecha_ingreso, fecha_entrega, cantidad, unidad, kg_in, kg_out, kg_saldo, kg_out_before_in, kg_out_fechado, out_kg_days,
    problema_info, first_out, last_out, dias, dias_saldo, tn_dias, estado, rango, rango_orden)
  SELECT x.id, x.lote, x.producto, x.numrel, x.glosa, x.familia, x.ipt, x.documento, x.docrel, x.fecha, x.fecha_entrega,
    x.cantidad, x.unidad, x.kg_in, x.kg_out, x.kg_saldo, x.before_in, x.kg_out - x.before_in, x.kg_days,
    (x.kg_in <= 0 OR x.before_in > 0.5), x.first_out, x.last_out,
    x.dias, CASE WHEN x.abierta THEN x.dias END,
    CASE WHEN x.abierta THEN x.kg_saldo / 1000.0 * x.dias ELSE 0 END,
    CASE WHEN x.kg_in <= 0 THEN 'Problema de información'
         WHEN x.kg_saldo <= x.kg_in * s.tolerance THEN 'Despachado'
         WHEN x.kg_out > 0 THEN 'Salida parcial'
         WHEN x.dias > s.alert_days THEN 'Sin salida identificada'
         ELSE 'En APT' END,
    r.label, r.desde
  FROM (
    SELECT m.id, m.lote, m.producto, m.numrel, m.glosa, m.familia, m.ipt, m.documento, m.docrel, m.fecha, m.fecha_entrega,
      m.cantidad, m.unidad, m.peso_kg AS kg_in, COALESCE(a.kg, 0) AS kg_out, GREATEST(m.peso_kg - COALESCE(a.kg, 0), 0) AS kg_saldo,
      COALESCE(a.before_in, 0) AS before_in, COALESCE(a.kg_days, 0) AS kg_days, a.first_out, a.last_out,
      (m.peso_kg - COALESCE(a.kg, 0) > 0.0005) AS abierta,
      -- Permanencia: con saldo → corte − ingreso; cerrada → última salida − ingreso
      CASE WHEN m.peso_kg - COALESCE(a.kg, 0) > 0.0005 OR a.last_out IS NULL THEN v_cut - m.fecha
           ELSE GREATEST(a.last_out - m.fecha, 0) END AS dias
    FROM apt_e e JOIN public.apt_movements m ON m.id = e.id
    LEFT JOIN (SELECT layer_id, sum(kg) AS kg, sum(kg * dias) FILTER (WHERE fecha_salida >= fecha_ingreso) AS kg_days,
                      min(fecha_salida) AS first_out, max(fecha_salida) AS last_out,
                      sum(kg) FILTER (WHERE fecha_salida < fecha_ingreso) AS before_in
               FROM public.apt_allocations GROUP BY layer_id) a ON a.layer_id = e.id) x
  LEFT JOIN LATERAL (SELECT r.label, r.desde FROM public.apt_aging_ranges r WHERE r.desde <= x.dias ORDER BY r.desde DESC LIMIT 1) r ON true;

  UPDATE public.apt_layers l SET posible_cruce = true
  WHERE l.kg_saldo > 0.0005 AND EXISTS (
    SELECT 1 FROM public.apt_exit_class c
    WHERE c.producto = l.producto AND c.lote IS DISTINCT FROM l.lote AND c.kg_sin_entrada > 0.5 AND c.fecha >= l.fecha_ingreso
      AND c.clase IN ('OTRO_PRODUCTO_DEL_LOTE', 'LOTE_SIN_INGRESO', 'EXCEDE_INGRESO', 'SIN_NUMREL'));

  -- Cliente de cada lote: el de más TN en las guías de SALIDA del lote; si no tiene guías, el de su OT madre;
  -- si tampoco, el cliente de la OT registrada en Contratos del TMS
  UPDATE public.apt_layers l SET cliente = x.cliente, cliente_fuente = x.fuente
  FROM (
    WITH ex AS (
      SELECT m.lote, m.cliente, sum(m.peso_kg) AS kg, count(*) AS n FROM public.apt_movements m
      WHERE m.active AND m.valid AND m.kind = 'SALIDA' AND m.lote IS NOT NULL AND m.cliente IS NOT NULL AND m.fecha <= v_cut
      GROUP BY m.lote, m.cliente),
    por_lote AS (SELECT DISTINCT ON (lote) lote, cliente FROM ex ORDER BY lote, kg DESC, n DESC, cliente),
    por_ot AS (SELECT DISTINCT ON (ot) ot, cliente FROM (
                 SELECT split_part(lote, '-', 1) AS ot, cliente, sum(kg) AS kg, sum(n) AS n FROM ex GROUP BY 1, 2) z
               ORDER BY ot, kg DESC, n DESC, cliente),
    tms AS (SELECT DISTINCT ON (upper(c.code)) upper(c.code) AS code, cl.business_name AS cliente
            FROM public.contracts c JOIN public.clients cl ON cl.id = c.client_id
            WHERE cl.business_name IS NOT NULL ORDER BY upper(c.code)),
    lotes AS (SELECT DISTINCT lote FROM public.apt_layers)
    SELECT lo.lote,
      COALESCE(pl.cliente, po.cliente, t1.cliente, t2.cliente) AS cliente,
      CASE WHEN pl.cliente IS NOT NULL THEN 'GUIAS_LOTE' WHEN po.cliente IS NOT NULL THEN 'GUIAS_OT'
           WHEN COALESCE(t1.cliente, t2.cliente) IS NOT NULL THEN 'CONTRATO_TMS' END AS fuente
    FROM lotes lo
    LEFT JOIN por_lote pl ON pl.lote = lo.lote
    LEFT JOIN por_ot po ON po.ot = split_part(lo.lote, '-', 1)
    LEFT JOIN tms t1 ON t1.code = lo.lote
    LEFT JOIN tms t2 ON t2.code = split_part(lo.lote, '-', 1)) x
  WHERE x.lote = l.lote;

  RETURN jsonb_build_object('success', true, 'cutoff', v_cut,
    'capas', (SELECT count(*) FROM public.apt_layers), 'asignaciones', (SELECT count(*) FROM public.apt_allocations),
    'advertencia', CASE WHEN v_cut < v_min THEN 'La fecha de corte es anterior a los datos cargados: el modelo queda vacío'
                        WHEN v_cut > v_max THEN 'La fecha de corte es posterior al último movimiento: los días incluyen días sin datos' END);
END $function$;
REVOKE ALL ON FUNCTION public.apt_rebuild() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_rebuild() TO service_role;

CREATE OR REPLACE FUNCTION public.apt_save_settings(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_tol numeric; v_alert integer; v_cut date; v_ranges jsonb := p -> 'ranges';
BEGIN
  IF NOT public.apt_can_load() THEN RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cambiar los parámetros de APT'); END IF;
  v_tol := COALESCE(public.apt_num(p -> 'tolerance'), 0.02);
  v_alert := COALESCE(public.apt_num(p -> 'alert_days')::int, 60);
  v_cut := public.apt_date(p -> 'cutoff_date');
  IF NULLIF(btrim(COALESCE(p ->> 'cutoff_date', '')), '') IS NOT NULL AND v_cut IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'La fecha de corte no es válida');
  END IF;
  IF v_tol < 0 OR v_tol >= 0.5 THEN RETURN jsonb_build_object('success', false, 'error', 'La tolerancia debe estar entre 0 % y 50 %'); END IF;
  IF v_alert < 1 THEN RETURN jsonb_build_object('success', false, 'error', 'Los días de alerta deben ser mayores a 0'); END IF;
  IF v_ranges IS NOT NULL AND jsonb_typeof(v_ranges) = 'array' THEN
    IF jsonb_array_length(v_ranges) < 2 OR jsonb_array_length(v_ranges) > 15
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_ranges) e WHERE public.apt_num(e -> 'desde') = 0)
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_ranges) e WHERE public.apt_num(e -> 'desde') IS NULL OR public.apt_num(e -> 'desde') < 0
                    OR NULLIF(btrim(e ->> 'label'), '') IS NULL)
       OR (SELECT count(DISTINCT public.apt_num(e -> 'desde')) FROM jsonb_array_elements(v_ranges) e) <> jsonb_array_length(v_ranges) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Rangos no válidos: entre 2 y 15, uno debe empezar en 0 y no pueden repetirse');
    END IF;
    DELETE FROM public.apt_aging_ranges WHERE true;
    INSERT INTO public.apt_aging_ranges (desde, label)
    SELECT public.apt_num(e -> 'desde')::int, left(btrim(e ->> 'label'), 40) FROM jsonb_array_elements(v_ranges) e;
  END IF;
  UPDATE public.apt_settings SET cutoff_date = v_cut, tolerance = v_tol, alert_days = v_alert, updated_by = auth.uid(), updated_at = now()
  WHERE id = 1;
  RETURN jsonb_build_object('success', true, 'model', public.apt_rebuild());
END $function$;
REVOKE ALL ON FUNCTION public.apt_save_settings(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_save_settings(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_stock_observation_save(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_cut date; v_id uuid; v_user uuid:=auth.uid(); v_weight numeric;
BEGIN
 IF v_user IS NULL OR NOT public.is_active_tms_user() OR NOT public.apt_can_load() THEN RETURN jsonb_build_object('success',false,'error','Sin permiso para registrar conciliaciones APT'); END IF;
 IF p IS NULL OR jsonb_typeof(p)<>'object' THEN RETURN jsonb_build_object('success',false,'error','Registro inválido'); END IF;
 v_cut:=public.apt_date(p->'cutoff');
 IF v_cut IS NULL OR v_cut>(now() AT TIME ZONE 'America/Lima')::date THEN RETURN jsonb_build_object('success',false,'error','Seleccione una fecha de corte válida, hasta hoy'); END IF;
 IF COALESCE(p->>'almacen','') NOT IN ('647','540','ST') OR COALESCE(p->>'source','') NOT IN ('ERP','FISICO') THEN
  RETURN jsonb_build_object('success',false,'error','Indique almacén y fuente ERP o FISICO'); END IF;
 IF length(btrim(COALESCE(p->>'lote',''))) NOT BETWEEN 1 AND 120 OR length(btrim(COALESCE(p->>'producto',''))) NOT BETWEEN 1 AND 160
 OR length(btrim(COALESCE(p->>'reference',''))) NOT BETWEEN 1 AND 500 OR length(COALESCE(p->>'notes',''))>2000 THEN
  RETURN jsonb_build_object('success',false,'error','Complete lote, producto y referencia de evidencia dentro de los límites'); END IF;
 IF COALESCE(p->>'peso_kg','') !~ '^[0-9]{1,12}(\.[0-9]{1,6})?$' THEN
  RETURN jsonb_build_object('success',false,'error','Peso en kg inválido: debe ser no negativo con hasta seis decimales'); END IF;
 v_weight:=(p->>'peso_kg')::numeric;
 INSERT INTO public.apt_stock_observations(cutoff,almacen,lote,producto,peso_kg,source,reference,notes,created_by)
 VALUES(v_cut,p->>'almacen',upper(btrim(p->>'lote')),btrim(p->>'producto'),v_weight,p->>'source',btrim(p->>'reference'),NULLIF(btrim(p->>'notes'),''),v_user)
 RETURNING id INTO v_id;
 RETURN jsonb_build_object('success',true,'id',v_id,'message','Observación registrada; el inventario reconstruido no fue modificado');
END $function$;
REVOKE ALL ON FUNCTION public.apt_stock_observation_save(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_stock_observation_save(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_stock_reconciliation(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s public.apt_flow_state%ROWTYPE; v_cut date; v_rows jsonb; v_count integer; v_limit integer; v_offset integer; v_available boolean; v_fresh boolean; v_applied timestamptz;
BEGIN
 IF NOT public.is_active_tms_user() OR NOT public.apt_can_view() THEN RETURN jsonb_build_object('success',false,'error','Sin acceso al módulo APT'); END IF;
 p:=COALESCE(p,'{}'::jsonb);
 IF jsonb_typeof(p)<>'object' THEN RETURN jsonb_build_object('success',false,'error','Filtros inválidos'); END IF;
 SELECT * INTO s FROM public.apt_flow_state WHERE id=1;
 SELECT max(applied_at) INTO v_applied FROM public.apt_uploads WHERE status='APLICADA';
 v_cut:=COALESCE(public.apt_date(p->'cutoff'),s.cutoff);
 IF p ? 'cutoff' AND public.apt_date(p->'cutoff') IS NULL THEN RETURN jsonb_build_object('success',false,'error','Corte inválido'); END IF;
 IF NULLIF(p->>'almacen','') IS NOT NULL AND p->>'almacen' NOT IN ('647','540','ST') THEN RETURN jsonb_build_object('success',false,'error','Almacén inválido'); END IF;
 IF NULLIF(p->>'source','') IS NOT NULL AND p->>'source' NOT IN ('ERP','FISICO') THEN RETURN jsonb_build_object('success',false,'error','Fuente inválida'); END IF;
 IF COALESCE(p->>'limit','25') !~ '^[0-9]{1,6}$' OR COALESCE(p->>'offset','0') !~ '^[0-9]{1,9}$' THEN RETURN jsonb_build_object('success',false,'error','Paginación inválida'); END IF;
 v_limit:=LEAST(GREATEST(COALESCE((p->>'limit')::integer,25),1),100);
 v_offset:=GREATEST(COALESCE((p->>'offset')::integer,0),0);
 -- A same-date replacement can invalidate the model without changing its cutoff.
 -- Observations remain visible, but cannot be certified against old movements.
 v_fresh:=s.cutoff IS NOT NULL AND s.rebuilt_at IS NOT NULL AND (v_applied IS NULL OR s.rebuilt_at>=v_applied);
 v_available:=COALESCE(v_cut BETWEEN s.data_min AND s.cutoff,false) AND v_fresh;
 WITH latest AS (
 SELECT DISTINCT ON(almacen,lote,producto,source) * FROM public.apt_stock_observations
 WHERE cutoff=v_cut AND (NULLIF(p->>'almacen','') IS NULL OR almacen=p->>'almacen')
 AND (NULLIF(p->>'source','') IS NULL OR source=p->>'source')
 AND (NULLIF(p->>'lote','') IS NULL OR lote ILIKE '%'||btrim(p->>'lote')||'%')
 ORDER BY almacen,lote,producto,source,created_at DESC,id DESC)
 SELECT count(*) INTO v_count FROM latest;
 WITH latest AS (
 SELECT DISTINCT ON(almacen,lote,producto,source) * FROM public.apt_stock_observations
 WHERE cutoff=v_cut AND (NULLIF(p->>'almacen','') IS NULL OR almacen=p->>'almacen')
 AND (NULLIF(p->>'source','') IS NULL OR source=p->>'source')
 AND (NULLIF(p->>'lote','') IS NULL OR lote ILIKE '%'||btrim(p->>'lote')||'%')
 ORDER BY almacen,lote,producto,source,created_at DESC,id DESC),
 page AS(SELECT * FROM latest ORDER BY almacen,lote,producto,source LIMIT v_limit OFFSET v_offset),
 compared AS(SELECT o.*, CASE WHEN v_available THEN
 COALESCE((SELECT sum(l.kg_in) FROM public.apt_flow_layers l WHERE l.almacen=o.almacen AND l.lote=o.lote AND l.producto=o.producto AND (l.fecha IS NULL OR l.fecha<=v_cut)),0)
 - COALESCE((SELECT sum(x.kg) FROM public.apt_flow_exits x WHERE x.almacen=o.almacen AND x.lote=o.lote AND x.producto=o.producto AND x.fecha<=v_cut),0)
 END AS documentary_kg FROM page o)
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'cutoff',cutoff,'almacen',almacen,'lote',lote,'producto',producto,
 'source',source,'reference',reference,'notes',notes,'observed_kg',peso_kg,'documentary_kg',documentary_kg,
 'difference_kg',peso_kg-documentary_kg,'created_at',created_at,
 'status',CASE WHEN NOT v_fresh AND v_cut BETWEEN s.data_min AND s.cutoff THEN 'MODELO_PENDIENTE' WHEN documentary_kg IS NULL THEN 'MODELO_NO_DISPONIBLE' WHEN abs(peso_kg-documentary_kg)<=0.0005 THEN 'COINCIDE_DOCUMENTAL' ELSE 'DIFERENCIA' END)
 ORDER BY almacen,lote,producto,source),'[]') INTO v_rows FROM compared;
 RETURN jsonb_build_object('success',true,'cutoff',v_cut,'model_cutoff',s.cutoff,'rebuilt_at',s.rebuilt_at,'documentary_available',v_available,
 'model_fresh',v_fresh,'latest_applied_at',v_applied,'scope','OBSERVACIONES_REGISTRADAS','certifies_full_inventory',false,'rows',v_rows,'total',v_count,'limit',v_limit,'offset',v_offset);
END $function$;
REVOKE ALL ON FUNCTION public.apt_stock_reconciliation(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_stock_reconciliation(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_str(v jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT NULLIF(btrim(regexp_replace(regexp_replace(v #>> '{}', '[[:cntrl:]]', '', 'g'), '\s+', ' ', 'g')), '');
$function$;
REVOKE ALL ON FUNCTION public.apt_str(v jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_str(v jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_trends(p jsonb DEFAULT '{}'::jsonb, p_grain text DEFAULT 'semana'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_unit text := CASE p_grain WHEN 'dia' THEN 'day' WHEN 'mes' THEN 'month' ELSE 'week' END; v_cut date; v_out jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  SELECT cutoff INTO v_cut FROM public.apt_state WHERE id = 1;
  IF v_cut IS NULL THEN RETURN jsonb_build_object('success', true, 'grain', p_grain, 'series', '[]'::jsonb); END IF;
  WITH f AS (SELECT l.*, min(l.fecha_ingreso) OVER (PARTITION BY l.lote) AS first_lote FROM public.apt_filtered(COALESCE(p, '{}'::jsonb)) l),
  a AS (SELECT a.* FROM public.apt_allocations a JOIN f ON f.movement_id = a.layer_id),
  per AS (
    SELECT gs::date AS ini, LEAST((gs + ('1 ' || v_unit)::interval - interval '1 day')::date, v_cut) AS fin
    FROM generate_series(date_trunc(v_unit, LEAST((SELECT min(fecha_ingreso) FROM f), (SELECT min(fecha_salida) FROM a))::timestamp),
                         date_trunc(v_unit, v_cut::timestamp), ('1 ' || v_unit)::interval) gs),
  ins AS (SELECT date_trunc(v_unit, fecha_ingreso::timestamp)::date AS ini, sum(kg_in) AS kg,
                 sum(kg_in * (fecha_ingreso - DATE '2000-01-01')) AS kge, count(*) AS n,
                 count(DISTINCT lote) FILTER (WHERE fecha_ingreso = first_lote) AS lotes_nuevos
          FROM f GROUP BY 1),
  outs AS (SELECT date_trunc(v_unit, fecha_salida::timestamp)::date AS ini, sum(kg) AS kg,
                  sum(kg * (fecha_ingreso - DATE '2000-01-01')) AS kge, count(DISTINCT exit_id) AS n, sum(kg * dias) AS kg_dias
           FROM a GROUP BY 1),
  closed AS (SELECT date_trunc(v_unit, x.ult::timestamp)::date AS ini, count(*) AS lotes
             FROM (SELECT f.lote, max(f.last_out) AS ult FROM f GROUP BY f.lote
                   HAVING sum(f.kg_saldo) <= sum(f.kg_in) * (SELECT tolerance FROM public.apt_settings WHERE id = 1) AND max(f.last_out) IS NOT NULL) x
             GROUP BY 1),
  b AS (
    SELECT per.ini, per.fin, COALESCE(ins.kg, 0) AS kg_in, COALESCE(outs.kg, 0) AS kg_out, COALESCE(ins.n, 0) AS n_in, COALESCE(outs.n, 0) AS n_out,
      COALESCE(ins.lotes_nuevos, 0) AS lotes_nuevos, COALESCE(closed.lotes, 0) AS lotes_cerrados, outs.kg_dias,
      sum(COALESCE(ins.kg, 0)) OVER w AS cum_in, sum(COALESCE(ins.kge, 0)) OVER w AS cum_in_e,
      sum(COALESCE(outs.kg, 0)) OVER w AS cum_out, sum(COALESCE(outs.kge, 0)) OVER w AS cum_out_e
    FROM per LEFT JOIN ins USING (ini) LEFT JOIN outs USING (ini) LEFT JOIN closed USING (ini)
    WINDOW w AS (ORDER BY per.ini))
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'periodo', ini, 'hasta', fin,
      'tn_in', round(kg_in / 1000, 3), 'tn_out', round(kg_out / 1000, 3), 'neto', round((kg_in - kg_out) / 1000, 3),
      'entradas', n_in, 'salidas', n_out, 'lotes_ingresados', lotes_nuevos, 'lotes_despachados', lotes_cerrados,
      'tn_prom_entrada', CASE WHEN n_in > 0 THEN round(kg_in / 1000 / n_in, 3) END,
      'tn_prom_salida', CASE WHEN n_out > 0 THEN round(kg_out / 1000 / n_out, 3) END,
      'dias_prom_despacho', CASE WHEN kg_out > 0 THEN round(kg_dias / kg_out, 1) END,
      'tn_in_acum', round(cum_in / 1000, 3), 'tn_out_acum', round(cum_out / 1000, 3),
      'saldo_tn', round((cum_in - cum_out) / 1000, 3),
      'aging_pond', CASE WHEN cum_in - cum_out > 0.5
        THEN round(((fin - DATE '2000-01-01') * (cum_in - cum_out) - (cum_in_e - cum_out_e)) / (cum_in - cum_out), 1) END
    ) ORDER BY ini), '[]'::jsonb)
  INTO v_out FROM b;
  RETURN jsonb_build_object('success', true, 'grain', p_grain, 'cutoff', v_cut, 'series', v_out);
END $function$;
REVOKE ALL ON FUNCTION public.apt_trends(p jsonb, p_grain text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_trends(p jsonb, p_grain text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_txt(v jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT NULLIF(upper(btrim(regexp_replace(
    CASE WHEN jsonb_typeof(v) = 'number' THEN regexp_replace(v #>> '{}', '\.0+$', '') ELSE v #>> '{}' END,
    '[[:cntrl:]]', '', 'g'))), '');
$function$;
REVOKE ALL ON FUNCTION public.apt_txt(v jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_txt(v jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_upload_apply(p_upload_id uuid, p_rebuild boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar movimientos de APT');
  END IF;
  RETURN public.apt_upload_apply_core(p_upload_id, p_rebuild);
END $function$;
REVOKE ALL ON FUNCTION public.apt_upload_apply(p_upload_id uuid, p_rebuild boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_upload_apply(p_upload_id uuid, p_rebuild boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_upload_apply_core(p_upload_id uuid, p_rebuild boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE k text; v_from date; v_to date; v_rows integer; v_valid integer; v_removed integer; v_summary jsonb := '{}'::jsonb; v_model jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('apt_rebuild'));
  PERFORM 1 FROM public.apt_uploads WHERE id = p_upload_id AND status = 'CARGANDO' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'La carga no existe o ya fue cerrada'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.apt_movements WHERE upload_id = p_upload_id AND valid) THEN
    RETURN jsonb_build_object('success', false, 'error', 'El archivo no tiene movimientos válidos (revise las hojas ENTRADA, SALIDA o de traspasos)');
  END IF;

  -- Protección: una carga parcial (p. ej. filtrada a un lote) no debe borrar la historia de su rango de fechas
  FOREACH k IN ARRAY ARRAY['ENTRADA', 'SALIDA', 'TRASPASO_SAL', 'TRASPASO_ENT', 'CONSUMO', 'DEVOLUCION'] LOOP
    SELECT min(fecha) FILTER (WHERE valid), max(fecha) FILTER (WHERE valid), count(*) FILTER (WHERE valid)
      INTO v_from, v_to, v_valid
    FROM public.apt_movements WHERE upload_id = p_upload_id AND kind = k;
    IF v_valid > 0 THEN
      SELECT count(*) INTO v_removed FROM public.apt_movements m
      WHERE m.kind = k AND m.active AND m.valid AND m.upload_id <> p_upload_id AND m.fecha BETWEEN v_from AND v_to;
      IF v_removed > 200 AND v_removed > 3 * v_valid THEN
        RETURN jsonb_build_object('success', false, 'error', format(
          'La hoja %s trae %s filas del %s al %s, pero ya hay %s cargadas en ese rango. Parece un archivo parcial o filtrado: cargue el reporte completo de esas fechas.',
          k, v_valid, to_char(v_from, 'DD/MM/YYYY'), to_char(v_to, 'DD/MM/YYYY'), v_removed));
      END IF;
    END IF;
  END LOOP;

  FOREACH k IN ARRAY ARRAY['ENTRADA', 'SALIDA', 'TRASPASO_SAL', 'TRASPASO_ENT', 'CONSUMO', 'DEVOLUCION'] LOOP
    SELECT min(fecha) FILTER (WHERE valid), max(fecha) FILTER (WHERE valid), count(*), count(*) FILTER (WHERE valid)
      INTO v_from, v_to, v_rows, v_valid
    FROM public.apt_movements WHERE upload_id = p_upload_id AND kind = k;
    v_removed := 0;
    IF v_valid > 0 THEN
      -- Reemplaza lo anterior del mismo rango de fechas (y las filas sin fecha de cargas previas)
      DELETE FROM public.apt_movements m
      WHERE m.kind = k AND m.active AND m.upload_id <> p_upload_id
        AND (m.fecha BETWEEN v_from AND v_to OR m.fecha IS NULL);
      GET DIAGNOSTICS v_removed = ROW_COUNT;
    END IF;
    v_summary := v_summary || jsonb_build_object(lower(k), jsonb_build_object(
      'filas', v_rows, 'validas', v_valid, 'excluidas', v_rows - v_valid, 'desde', v_from, 'hasta', v_to, 'reemplazadas', v_removed,
      'tn', (SELECT round(COALESCE(sum(peso_kg), 0) / 1000, 3) FROM public.apt_movements WHERE upload_id = p_upload_id AND kind = k AND valid)));
  END LOOP;

  UPDATE public.apt_movements SET active = true WHERE upload_id = p_upload_id;
  UPDATE public.apt_uploads SET status = 'APLICADA', applied_at = now(), summary = v_summary WHERE id = p_upload_id;
  -- La pantalla recalcula en una segunda llamada (apt_model_rebuild) para no sumar ambos tiempos en una sola petición
  IF p_rebuild THEN v_model := public.apt_rebuild(); END IF;
  RETURN jsonb_build_object('success', true, 'summary', v_summary, 'model', v_model);
END $function$;
REVOKE ALL ON FUNCTION public.apt_upload_apply_core(p_upload_id uuid, p_rebuild boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_upload_apply_core(p_upload_id uuid, p_rebuild boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.apt_upload_begin(p_file_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_id uuid;
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar movimientos de APT');
  END IF;
  -- El mantenimiento de cargas antiguas debe ejecutarse fuera del inicio interactivo.
  -- APT_BEGIN_NO_CLEANUP: crear solo la carga solicitada, sin tocar cargas anteriores.
  INSERT INTO public.apt_uploads (file_name, created_by)
  VALUES (left(COALESCE(NULLIF(btrim(p_file_name), ''), 'archivo.xlsx'), 200), auth.uid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', true, 'id', v_id);
END $function$;
REVOKE ALL ON FUNCTION public.apt_upload_begin(p_file_name text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_upload_begin(p_file_name text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_upload_discard(p_upload_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar movimientos de APT');
  END IF;
  DELETE FROM public.apt_movements WHERE upload_id = p_upload_id
    AND EXISTS (SELECT 1 FROM public.apt_uploads u WHERE u.id = p_upload_id AND u.status = 'CARGANDO');
  UPDATE public.apt_uploads SET status = 'DESCARTADA' WHERE id = p_upload_id AND status = 'CARGANDO';
  RETURN jsonb_build_object('success', true);
END $function$;
REVOKE ALL ON FUNCTION public.apt_upload_discard(p_upload_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_upload_discard(p_upload_id uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_upload_rows(p_upload_id uuid, p_kind text, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_n integer;
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar movimientos de APT');
  END IF;
  IF p_kind NOT IN ('ENTRADA', 'SALIDA', 'TRASPASO_SAL', 'TRASPASO_ENT', 'CONSUMO', 'DEVOLUCION') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Tipo de hoja no válido');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.apt_uploads WHERE id = p_upload_id AND status = 'CARGANDO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'La carga no existe o ya fue cerrada');
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Formato de filas no válido');
  END IF;

  INSERT INTO public.apt_movements (upload_id, kind, row_no, raw, valid, invalid_reason, fecha, documento, tipodocto, bodega,
    numrel, lote_origen, lote, lote_derivado, docrel, cliente, ruc, producto, glosa, familia, ipt, cantidad, unidad,
    peso_unitario, peso_kg, fecha_entrega, almacen, contrato)
  SELECT p_upload_id, p_kind, COALESCE(public.apt_num(x.r -> '__row')::int, 0), x.r - '__row',
    v.ok, v.reason, n.fecha, n.documento, n.tipodocto, n.bodega, n.numrel, n.lote_origen, l.lote,
    (p_kind = 'ENTRADA' AND n.lote_origen IS NULL AND n.numrel IS NOT NULL),
    n.docrel, n.cliente, n.ruc, n.producto, n.glosa, split_part(n.glosa, ' ', 1),
    left(btrim(substring(n.comentario FROM 'IPT:\s*(.*)$')), 40),
    abs(public.apt_num(x.r -> 'Cantidad')), n.unidad, public.apt_num(x.r -> 'PesoUnitario'),
    COALESCE(abs(public.apt_num(x.r -> 'PesoTotalProduccido')), 0), public.apt_date(x.r -> 'FechaEntrega'),
    public.apt_almacen(n.bodega), n.contrato
  FROM jsonb_array_elements(p_rows) AS x(r)
  CROSS JOIN LATERAL (SELECT
      public.apt_date(x.r -> 'Fecha') AS fecha,
      public.apt_id(public.apt_str(x.r -> 'Numero')) AS documento,
      public.apt_str(x.r -> 'TIPODOCTO') AS tipodocto,
      public.apt_str(x.r -> 'BODEGA') AS bodega,
      public.apt_id(public.apt_txt(x.r -> 'NumRel')) AS numrel,
      public.apt_id(public.apt_txt(x.r -> 'Lote')) AS lote_origen,
      upper(public.apt_str(x.r -> 'DocRel')) AS docrel,
      public.apt_str(x.r -> 'RazonSocial') AS cliente,
      public.apt_txt(x.r -> 'CodLegal') AS ruc,
      public.apt_txt(x.r -> 'Producto') AS producto,
      public.apt_str(x.r -> 'GLOSA') AS glosa,
      public.apt_str(x.r -> 'Comentario') AS comentario,
      upper(public.apt_str(x.r -> 'UNIDAD')) AS unidad,
      public.apt_id(public.apt_txt(x.r -> 'Contrato')) AS contrato) n
  CROSS JOIN LATERAL (SELECT CASE
      WHEN p_kind = 'ENTRADA' THEN COALESCE(n.lote_origen,
        regexp_replace(n.numrel, '-[0-9]+$', ''))
      WHEN p_kind = 'SALIDA' AND n.docrel = 'ERROR DE CONTRATO' AND n.lote_origen IS NOT NULL THEN n.lote_origen
      WHEN p_kind = 'SALIDA' THEN n.numrel
      -- Traspasos, consumos y devoluciones: Lote del APT; si falta, el contrato (NumRel en un consumo es la OP que consume)
      ELSE COALESCE(n.lote_origen, n.contrato, regexp_replace(n.numrel, '-[0-9]+$', '')) END AS lote) l
  CROSS JOIN LATERAL (SELECT CASE
      WHEN n.fecha IS NULL AND n.producto IS NULL THEN 'Fila sin fecha ni producto (totalizadora o vacía)'
      WHEN n.fecha IS NULL THEN 'Sin fecha'
      WHEN n.fecha > current_date + 1 THEN 'Fecha futura'
      WHEN n.fecha < DATE '2000-01-01' THEN 'Fecha fuera de rango'
      WHEN n.producto IS NULL THEN 'Sin producto'
      WHEN p_kind = 'ENTRADA' AND l.lote IS NULL THEN 'Sin NumRel ni Lote'
      WHEN (p_kind NOT IN ('ENTRADA', 'SALIDA') OR n.bodega IS NOT NULL) AND public.apt_almacen(n.bodega) IS NULL
        THEN 'Fuera de los almacenes APT (647, 540, ST VENTAS)'
      WHEN p_kind NOT IN ('ENTRADA', 'SALIDA') AND l.lote IS NULL THEN 'Sin Lote ni Contrato'
      WHEN x.r ? 'PesoTotalProduccido' AND jsonb_typeof(x.r -> 'PesoTotalProduccido') <> 'null'
           AND public.apt_num(x.r -> 'PesoTotalProduccido') IS NULL THEN 'Peso no numérico' END AS reason) v0
  CROSS JOIN LATERAL (SELECT v0.reason IS NULL AS ok, v0.reason) v
  ON CONFLICT (upload_id, kind, row_no) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'rows', v_n);
END $function$;
REVOKE ALL ON FUNCTION public.apt_upload_rows(p_upload_id uuid, p_kind text, p_rows jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_upload_rows(p_upload_id uuid, p_kind text, p_rows jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apt_uploads_trg_peso_servicios()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status = 'APLICADA' AND OLD.status IS DISTINCT FROM 'APLICADA' THEN
    BEGIN PERFORM public.servicios_sync_peso_apt(NULL); EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;
  RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION public.apt_uploads_trg_peso_servicios() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_uploads_trg_peso_servicios() TO service_role;

CREATE OR REPLACE FUNCTION public.erp_analisis(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET enable_nestloop TO 'off'
AS $function$
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
  -- Exportación por páginas: el cliente fija las cargas de la primera página; si otra carga las reemplazó, se rechaza
  IF (p ? 'contratos_id' AND NULLIF(p->>'contratos_id', '')::uuid IS DISTINCT FROM v_c) OR (p ? 'stock_id' AND NULLIF(p->>'stock_id', '')::uuid IS DISTINCT FROM v_s) THEN
    RETURN jsonb_build_object('success', false, 'cargas_cambiaron', true,
      'error', 'Las cargas del ERP cambiaron durante la exportación (se aplicó otro Actualizable o Stock). Vuelva a exportar.');
  END IF;
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
  -- Por OT y en el resumen, una fila incompleta (cantidades ausentes) queda fuera de todas las sumas, conteos e indicadores;
  -- cada porcentaje usa la misma población válida. Se informa cuántas filas se excluyeron.
  o AS (
    SELECT ot, tipo_documento, unidad, max(cliente) AS cliente, count(*) AS documentos_producto, count(*) FILTER (WHERE NOT incompleto) AS validas,
      count(*) FILTER (WHERE incompleto) AS incompletas, count(DISTINCT documento) FILTER (WHERE NOT incompleto) AS documentos,
      sum(contratado) FILTER (WHERE NOT incompleto) AS contratado, sum(despachado) FILTER (WHERE NOT incompleto) AS despachado,
      sum(reemplazado) FILTER (WHERE NOT incompleto) AS reemplazado, sum(pendiente) FILTER (WHERE NOT incompleto) AS pendiente,
      sum(stock) FILTER (WHERE NOT incompleto) AS stock, sum(faltante) FILTER (WHERE NOT incompleto) AS faltante,
      count(*) FILTER (WHERE NOT incompleto AND cruce = 'COINCIDE') AS con_stock, count(*) FILTER (WHERE NOT incompleto AND vencida) AS vencidas,
      min(fecha_contrato) AS fecha_contrato, max(fecha_vcto) AS fecha_vcto, max(ult_despacho) AS ult_despacho,
      CASE WHEN sum(contratado) FILTER (WHERE NOT incompleto) > 0
        THEN round(sum(despachado) FILTER (WHERE NOT incompleto) / sum(contratado) FILTER (WHERE NOT incompleto), 4) END AS avance,
      CASE WHEN sum(pendiente) FILTER (WHERE NOT incompleto AND pendiente > 0) > 0
        THEN round(COALESCE(sum(stock) FILTER (WHERE NOT incompleto AND pendiente > 0 AND cruce = 'COINCIDE'), 0)
          / sum(pendiente) FILTER (WHERE NOT incompleto AND pendiente > 0), 4) END AS cobertura
    FROM f GROUP BY 1, 2, 3)
  SELECT jsonb_build_object('success', true, 'vista', v_vista, 'unidad_original', COALESCE(v_orig, false), 'hoy', v_hoy,
    'cargas', jsonb_build_object('contratos', v_c, 'stock', v_s),
    'total', CASE WHEN v_vista = 'OT' THEN (SELECT count(*) FROM o) ELSE (SELECT count(*) FROM f) END,
    -- Resumen por unidad y tipo de documento (porcentajes desde las sumas, no promedio de filas)
    'resumen', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.unidad, r.tipo_documento) FROM (
       SELECT unidad, tipo_documento, count(*) AS filas, count(*) FILTER (WHERE NOT incompleto) AS validas, count(*) FILTER (WHERE incompleto) AS incompletas,
         count(DISTINCT documento) FILTER (WHERE NOT incompleto) AS documentos, sum(lineas) FILTER (WHERE NOT incompleto) AS lineas,
         sum(contratado) FILTER (WHERE NOT incompleto) AS contratado, sum(despachado) FILTER (WHERE NOT incompleto) AS despachado,
         sum(reemplazado) FILTER (WHERE NOT incompleto) AS reemplazado, sum(pendiente) FILTER (WHERE NOT incompleto) AS pendiente,
         CASE WHEN sum(contratado) FILTER (WHERE NOT incompleto) > 0
           THEN round(sum(despachado) FILTER (WHERE NOT incompleto) / sum(contratado) FILTER (WHERE NOT incompleto), 4) END AS avance,
         sum(stock) FILTER (WHERE NOT incompleto AND pendiente > 0 AND cruce = 'COINCIDE') AS stock_coincidente,
         sum(faltante) FILTER (WHERE NOT incompleto) AS faltante,
         CASE WHEN sum(pendiente) FILTER (WHERE NOT incompleto AND pendiente > 0) > 0
           THEN round(COALESCE(sum(stock) FILTER (WHERE NOT incompleto AND pendiente > 0 AND cruce = 'COINCIDE'), 0)
             / sum(pendiente) FILTER (WHERE NOT incompleto AND pendiente > 0), 4) END AS cobertura,
         count(*) FILTER (WHERE NOT incompleto AND pendiente > 0) AS con_pendiente,
         count(*) FILTER (WHERE NOT incompleto AND pendiente > 0 AND cruce = 'COINCIDE') AS pendiente_con_stock,
         count(*) FILTER (WHERE NOT incompleto AND pendiente < 0) AS sobredespacho, count(*) FILTER (WHERE NOT incompleto AND vencida) AS vencidas
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
  -- Si otra carga reemplazó las usadas mientras se calculaba, el resultado mezclaría cortes: se rechaza
  IF public.erp_active_import('CONTRATOS') IS DISTINCT FROM v_c OR public.erp_active_import('STOCK') IS DISTINCT FROM v_s THEN
    RETURN jsonb_build_object('success', false, 'cargas_cambiaron', true, 'error', 'Las cargas del ERP cambiaron durante la consulta. Vuelva a intentar.');
  END IF;
  RETURN v_out;
END $function$;
REVOKE ALL ON FUNCTION public.erp_analisis(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_analisis(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.erp_analisis_detalle(p_documento text, p_producto text, p_unidad text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.erp_analisis_detalle(p_documento text, p_producto text, p_unidad text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_analisis_detalle(p_documento text, p_producto text, p_unidad text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.erp_bodega(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT NULLIF(regexp_replace(upper(btrim(COALESCE(p, ''))), '\s+', ' ', 'g'), '');
$function$;
REVOKE ALL ON FUNCTION public.erp_bodega(p text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_bodega(p text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.erp_calidad()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET enable_nestloop TO 'off'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.erp_calidad() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_calidad() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.erp_cargas_log(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.erp_cargas_log(p_limit integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_cargas_log(p_limit integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.erp_derive(p_commit boolean DEFAULT false, p_resumen jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.apt_can_load() THEN RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar datos del ERP'); END IF;
  RETURN public.erp_derive_core(p_commit, auth.uid(), p_resumen);
END $function$;
REVOKE ALL ON FUNCTION public.erp_derive(p_commit boolean, p_resumen jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_derive(p_commit boolean, p_resumen jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.erp_derive_core(p_commit boolean, p_user uuid, p_resumen jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET enable_nestloop TO 'off'
AS $function$
DECLARE
  apt CONSTANT text[] := ARRAY['647-04 ALM PT', '540-04 APT LB', 'ST-VENTAS-IMD'];
  v_s uuid := public.erp_active_import('STOCK'); v_c uuid := public.erp_active_import('CONTRATOS');
  v_d date; v_b date; v_fuente text; v_bodegas text[]; v_tag text; v_rows jsonb; v_res jsonb;
BEGIN
  IF v_s IS NULL OR v_c IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Faltan los dos archivos del ERP: cargue el Actualizable Despacho y el Stock Bodega Despacho');
  END IF;
  SELECT COALESCE((cut_at AT TIME ZONE 'America/Lima')::date, (now() AT TIME ZONE 'America/Lima')::date) INTO v_d FROM public.erp_imports WHERE id = v_s;
  IF EXISTS (SELECT 1 FROM public.erp_derive_days WHERE fecha > v_d) THEN
    RETURN jsonb_build_object('success', false, 'error', format('Ya hay movimientos derivados del %s: cargue un Stock con corte igual o posterior', (SELECT to_char(max(fecha), 'DD/MM/YYYY') FROM public.erp_derive_days)));
  END IF;
  SELECT array_agg(DISTINCT public.erp_bodega(bodega)) INTO v_bodegas FROM public.erp_stock_lots
  WHERE import_id = v_s AND public.erp_bodega(bodega) = ANY (apt);
  IF v_bodegas IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'El Stock no trae ninguna de las bodegas 647-04, 540 o ST-VENTAS-IMD'); END IF;
  v_tag := to_char(v_d, 'YYYYMMDD');

  -- Base: el último día guardado antes del corte. La primera vez se guarda como base el stock del inventario calculado
  -- con el DATA (antes de aplicar nada derivado), así recalcular el mismo día no depende del inventario ya actualizado.
  SET LOCAL client_min_messages = warning;
  DROP TABLE IF EXISTS d_base, d_new, d_dk, d_g, d_desp, d_res, d_rows, d_tr, d_first;
  CREATE TEMP TABLE d_base (bodega text, producto text, lote text, qty numeric) ON COMMIT DROP;
  SELECT max(fecha) INTO v_b FROM public.erp_derive_days WHERE fecha < v_d;
  IF v_b IS NULL THEN
    -- Último día del DATA (sin contar lo derivado del ERP)
    SELECT max(hasta) INTO v_b FROM public.inv_uploads WHERE status = 'APLICADA' AND side IN ('E', 'S') AND file_name NOT LIKE 'ERP_derivado_%';
    IF v_b IS NULL THEN
      v_b := v_d - 1;
      INSERT INTO public.erp_derive_days (fecha, base_fecha, base_fuente, bodegas, resumen, created_by)
      VALUES (v_b, v_b, 'VACIA', v_bodegas, '{"base": true}'::jsonb, p_user);
    ELSE
      IF v_b >= v_d THEN
        RETURN jsonb_build_object('success', false, 'error', format('El DATA cargado llega al %s y el Stock es del %s: la primera carga del ERP debe ser posterior al DATA', to_char(v_b, 'DD/MM/YYYY'), to_char(v_d, 'DD/MM/YYYY')));
      END IF;
      IF (SELECT dirty FROM public.inv_state WHERE id = 1) THEN
        RETURN jsonb_build_object('success', false, 'error', 'El inventario se está recalculando: espere unos minutos y vuelva a aplicar (la base es el stock calculado con el DATA)', 'retry', true);
      END IF;
      INSERT INTO public.erp_derive_days (fecha, base_fecha, base_fuente, bodegas, resumen, created_by)
      VALUES (v_b, v_b, 'DATA', ARRAY['647-04 ALM PT', '540-04 APT LB', 'ST-VENTAS-IMD'], '{"base": true}'::jsonb, p_user);
      INSERT INTO public.erp_derive_stock (fecha, bodega, producto, lote, cantidad)
      SELECT v_b, public.erp_bodega(bodega), producto, lk, sum(qty - consumed) FROM public.inv_layers
      WHERE public.erp_bodega(bodega) = ANY (apt) GROUP BY 2, 3, 4 HAVING sum(qty - consumed) > 0.000001;
    END IF;
  END IF;
  SELECT CASE WHEN resumen ? 'base' THEN base_fuente ELSE 'ERP' END INTO v_fuente FROM public.erp_derive_days WHERE fecha = v_b;
  INSERT INTO d_base SELECT bodega, producto, lote, cantidad FROM public.erp_derive_stock WHERE fecha = v_b AND bodega = ANY (v_bodegas);

  -- Stock nuevo por bodega, producto y lote (en la unidad del ERP; el factor pasa a unidades)
  CREATE TEMP TABLE d_new ON COMMIT DROP AS
  SELECT public.erp_bodega(bodega) AS bodega, cod_producto AS producto, COALESCE(public.inv_lote(lote_raw), '') AS lote, sum(stock) AS qty,
    max(factor) AS factor, max(peso_unitario) FILTER (WHERE peso_unitario > 0) AS pu, max(producto) AS glosa, max(unidad) AS unidad
  FROM public.erp_stock_lots WHERE import_id = v_s AND public.erp_bodega(bodega) = ANY (v_bodegas) GROUP BY 1, 2, 3;

  -- Guías nuevas: no derivadas en días anteriores ni presentes en el DATA, con fecha del ERP posterior a la base
  CREATE TEMP TABLE d_dk ON COMMIT DROP AS
  SELECT DISTINCT public.apt_guia_key(numero) AS k FROM public.inv_movements
  WHERE active AND side = 'S' AND fecha <= v_b AND numero ~ '-' AND v_fuente = 'DATA';  -- guías que ya trae el DATA
  CREATE TEMP TABLE d_g ON COMMIT DROP AS
  SELECT g.guia_key, g.guia, g.cantidad AS cant_und, l.cod_producto AS producto, l.nro_documento AS documento, COALESCE(public.inv_lote(l.nro_documento), '') AS lote,
    l.producto AS glosa, l.ruc, l.cliente, l.tipo_documento, l.unidad, l.peso_unit,
    greatest(least(f.fecha, v_d), v_b + 1) AS fecha, NULL::text AS bodega, 1::numeric AS factor
  FROM public.erp_contract_guias g
  JOIN public.erp_contract_lines l ON l.import_id = g.import_id AND l.nro_documento = g.nro_documento AND l.secuencia = g.secuencia
  JOIN public.erp_guia_fechas f ON f.import_id = g.import_id AND f.guia_key = g.guia_key
  WHERE g.import_id = v_c AND g.cantidad > 0
    AND (f.fecha > v_b OR (v_fuente = 'ERP' AND f.fecha = v_b))
    AND NOT EXISTS (SELECT 1 FROM public.erp_derive_guias x WHERE x.guia_key = g.guia_key AND x.producto = l.cod_producto AND x.documento = l.nro_documento AND x.dia < v_d)
    AND NOT EXISTS (SELECT 1 FROM d_dk WHERE d_dk.k = g.guia_key);
  -- Unidad del stock del SKU (cientos) y bodega de salida: donde bajó ese lote; si no, donde había stock
  UPDATE d_g SET factor = COALESCE((SELECT max(n.factor) FROM d_new n WHERE n.producto = d_g.producto),
    (SELECT max(s.factor) FROM public.erp_stock_lots s WHERE s.import_id = v_s AND s.cod_producto = d_g.producto), 1)
  WHERE true;
  UPDATE d_g SET bodega = COALESCE(
    (SELECT b.bodega FROM d_base b LEFT JOIN d_new n USING (bodega, producto, lote)
      WHERE b.producto = d_g.producto AND b.lote = d_g.lote AND b.qty - COALESCE(n.qty, 0) > 0 ORDER BY b.qty - COALESCE(n.qty, 0) DESC LIMIT 1),
    (SELECT b.bodega FROM d_base b WHERE b.producto = d_g.producto AND b.lote = d_g.lote ORDER BY b.qty DESC LIMIT 1),
    CASE WHEN '647-04 ALM PT' = ANY (v_bodegas) THEN '647-04 ALM PT' ELSE v_bodegas[1] END)
  WHERE true;

  CREATE TEMP TABLE d_desp ON COMMIT DROP AS
  SELECT bodega, producto, lote, sum(cant_und / factor) AS qty FROM d_g GROUP BY 1, 2, 3;
  -- Residuo por clave: lo que el stock nuevo no explica con la base menos los despachos
  CREATE TEMP TABLE d_res ON COMMIT DROP AS
  SELECT k.bodega, k.producto, k.lote,
    COALESCE(n.qty, 0) - (COALESCE(b.qty, 0) - COALESCE(x.qty, 0)) AS r
  FROM (SELECT bodega, producto, lote FROM d_new UNION SELECT bodega, producto, lote FROM d_base UNION SELECT bodega, producto, lote FROM d_desp) k
  LEFT JOIN d_new n USING (bodega, producto, lote) LEFT JOIN d_base b USING (bodega, producto, lote) LEFT JOIN d_desp x USING (bodega, producto, lote);
  DELETE FROM d_res WHERE abs(r) < 0.000001;

  CREATE TEMP TABLE d_rows (kind text, tipodocto text, bodega text, numero text, fecha date, producto text, lote text, cantidad numeric,
    documento text, tipo_documento text, ruc text, cliente text) ON COMMIT DROP;
  -- Traspasos: dentro de cada producto y lote, lo que baja en una bodega cubre lo que sube en otra (intervalos acumulados)
  CREATE TEMP TABLE d_tr ON COMMIT DROP AS
  WITH neg AS (SELECT bodega, producto, lote, -r AS q, sum(-r) OVER (PARTITION BY producto, lote ORDER BY bodega) AS ce FROM d_res WHERE r < 0),
       pos AS (SELECT bodega, producto, lote, r AS q, sum(r) OVER (PARTITION BY producto, lote ORDER BY bodega) AS ce FROM d_res WHERE r > 0)
  SELECT n.bodega AS origen, p.bodega AS destino, producto, lote,
    least(n.ce, p.ce) - greatest(n.ce - n.q, p.ce - p.q) AS qty,
    'ERP-T-' || v_tag || '-' || row_number() OVER (ORDER BY producto, lote, n.bodega, p.bodega) AS numero
  FROM neg n JOIN pos p USING (producto, lote)
  WHERE least(n.ce, p.ce) - greatest(n.ce - n.q, p.ce - p.q) > 0.000001;
  -- Lo que entra o se mueve antes de despacharse: si el lote tiene despachos en el período, su ingreso o traspaso va
  -- con la fecha del primer despacho (en un mismo día el inventario procesa ingresos antes que salidas)
  CREATE TEMP TABLE d_first ON COMMIT DROP AS SELECT producto, lote, min(fecha) AS fecha FROM d_g GROUP BY 1, 2;
  INSERT INTO d_rows
  SELECT 'TRASPASO_S', 'TRASPASO DE ALMACEN APT', origen, numero, COALESCE(f.fecha, v_d), t.producto, t.lote, -qty, NULLIF(t.lote, ''), NULL, NULL, NULL
  FROM d_tr t LEFT JOIN d_first f USING (producto, lote)
  UNION ALL
  SELECT 'TRASPASO_E', 'TRASPASO DE ALMACEN APT', destino, numero, COALESCE(f.fecha, v_d), t.producto, t.lote, qty, NULLIF(t.lote, ''), NULL, NULL, NULL
  FROM d_tr t LEFT JOIN d_first f USING (producto, lote);
  UPDATE d_res x SET r = x.r + COALESCE((SELECT sum(qty) FROM d_tr t WHERE t.origen = x.bodega AND t.producto = x.producto AND t.lote = x.lote), 0)
                             - COALESCE((SELECT sum(qty) FROM d_tr t WHERE t.destino = x.bodega AND t.producto = x.producto AND t.lote = x.lote), 0)
  WHERE true;

  -- Lo que queda: ingresos (producción en 647) y ajustes
  INSERT INTO d_rows
  SELECT CASE WHEN r > 0 THEN 'INGRESO' ELSE 'AJUSTE' END,
    CASE WHEN r < 0 THEN 'AJUSTE ERP (DERIVADO)' WHEN bodega = '647-04 ALM PT' THEN 'P/E PRODUCCION ACT.' ELSE 'INGRESO ERP (DERIVADO)' END,
    x.bodega, CASE WHEN x.r > 0 THEN 'ERP-I-' ELSE 'ERP-A-' END || v_tag || '-' || row_number() OVER (ORDER BY x.bodega, x.producto, x.lote),
    CASE WHEN x.r > 0 THEN COALESCE(f.fecha, v_d) ELSE v_d END, x.producto, x.lote, x.r, NULLIF(x.lote, ''), NULL, NULL, NULL
  FROM d_res x LEFT JOIN d_first f USING (producto, lote) WHERE abs(x.r) > 0.000001;
  INSERT INTO d_rows
  SELECT 'DESPACHO', 'DESPACHO VENTAS', bodega, guia, fecha, producto, lote, -(cant_und / factor), documento, tipo_documento, ruc, cliente FROM d_g;

  -- Filas con las columnas del reporte de Entradas y Salidas del ERP
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'TipoDocto', x.tipodocto, 'Bodega', x.bodega, 'Numero', x.numero, 'Fecha', x.fecha, 'CodLegal', x.ruc, 'RazonSocial', x.cliente,
      'Producto', x.producto, 'GLOSA', COALESCE(n.glosa, p.glosa), 'Cantidad', round(x.cantidad, 6), 'UNIDAD', COALESCE(n.unidad, p.unidad, 'UND'),
      'DocRel', x.tipo_documento, 'NumRel', x.documento, 'Lote', NULLIF(x.lote, ''),
      'PesoUnitario', round(COALESCE(n.pu, p.pu, 0) * COALESCE(n.factor, p.factor, 1), 6),
      'PesoTotalProduccido', round(x.cantidad * COALESCE(n.pu, p.pu, 0) * COALESCE(n.factor, p.factor, 1), 6),
      'Comentario', 'Derivado del ERP (corte ' || to_char(v_d, 'DD/MM/YYYY') || ')')
      ORDER BY x.fecha, x.kind, x.numero), '[]'::jsonb)
  INTO v_rows
  FROM d_rows x
  LEFT JOIN d_new n ON n.bodega = x.bodega AND n.producto = x.producto AND n.lote = x.lote
  LEFT JOIN LATERAL (SELECT max(s.producto) AS glosa, max(upper(s.unidad)) AS unidad, max(s.peso_unitario) FILTER (WHERE s.peso_unitario > 0) AS pu, max(s.factor) AS factor
                     FROM public.erp_stock_lots s WHERE s.import_id = v_s AND s.cod_producto = x.producto) p ON true;

  v_res := jsonb_build_object('fecha', v_d, 'base_fecha', v_b, 'base_fuente', v_fuente, 'desde', v_b + 1, 'hasta', v_d, 'bodegas', to_jsonb(v_bodegas),
    'bodegas_sin_stock', to_jsonb(ARRAY(SELECT unnest(apt) EXCEPT SELECT unnest(v_bodegas))),
    'despachos', (SELECT count(*) FROM d_rows WHERE kind = 'DESPACHO'), 'guias', (SELECT count(DISTINCT numero) FROM d_rows WHERE kind = 'DESPACHO'),
    'traspasos', (SELECT count(*) FROM d_rows WHERE kind = 'TRASPASO_E'), 'ingresos', (SELECT count(*) FROM d_rows WHERE kind = 'INGRESO'),
    'ajustes', (SELECT count(*) FROM d_rows WHERE kind = 'AJUSTE'));

  IF p_commit THEN
    DELETE FROM public.erp_derive_days WHERE fecha = v_d;
    INSERT INTO public.erp_derive_days (fecha, base_fecha, base_fuente, stock_import, contratos_import, bodegas, resumen, created_by)
    VALUES (v_d, v_b, v_fuente, v_s, v_c, v_bodegas, COALESCE(p_resumen, v_res), p_user);
    -- Stock del día: lo nuevo en las bodegas que trae el archivo; las demás conservan su última base
    INSERT INTO public.erp_derive_stock (fecha, bodega, producto, lote, cantidad)
    SELECT v_d, bodega, producto, lote, qty FROM d_new WHERE abs(qty) > 0.000001
    UNION ALL  -- las bodegas que no vienen en el Stock conservan su base
    SELECT v_d, bodega, producto, lote, cantidad FROM public.erp_derive_stock WHERE fecha = v_b AND NOT (bodega = ANY (v_bodegas));
    INSERT INTO public.erp_derive_guias (guia_key, producto, documento, dia, fecha, bodega, cantidad)
    SELECT guia_key, producto, documento, v_d, min(fecha), min(bodega), sum(cant_und) FROM d_g GROUP BY 1, 2, 3
    ON CONFLICT (guia_key, producto, documento) DO NOTHING;
  END IF;
  RETURN jsonb_build_object('success', true, 'resumen', v_res, 'filas', v_rows, 'committed', p_commit);
END $function$;
REVOKE ALL ON FUNCTION public.erp_derive_core(p_commit boolean, p_user uuid, p_resumen jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erp_derive_core(p_commit boolean, p_user uuid, p_resumen jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.erp_derive_estado()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso'); END IF;
  RETURN jsonb_build_object('success', true,
    'dias', COALESCE((SELECT jsonb_agg(jsonb_build_object('fecha', fecha, 'base_fecha', base_fecha, 'base_fuente', base_fuente, 'resumen', resumen, 'created_at', created_at,
        'es_base', resumen ? 'base')
      ORDER BY fecha DESC) FROM (SELECT * FROM public.erp_derive_days ORDER BY fecha DESC LIMIT 30) d), '[]'::jsonb));
END $function$;
REVOKE ALL ON FUNCTION public.erp_derive_estado() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_derive_estado() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.erp_doc_key(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT regexp_replace(public.erp_key(p), '^([0-9]+)-([A-Z])0*([0-9]+)$', '\1-\2\3');
$function$;
REVOKE ALL ON FUNCTION public.erp_doc_key(p text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_doc_key(p text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.erp_guias(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET enable_nestloop TO 'off'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.erp_guias(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_guias(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.erp_key(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT NULLIF(regexp_replace(upper(btrim(COALESCE(p, ''))), '\s+', ' ', 'g'), '');
$function$;
REVOKE ALL ON FUNCTION public.erp_key(p text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_key(p text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.erp_lineas_stock(v_c uuid, v_s uuid)
 RETURNS TABLE(nro_documento text, secuencia integer, stock numeric, listo numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET enable_nestloop TO 'off'
AS $function$
  WITH st AS (SELECT lote, cod_producto, sum(stock * factor) AS stock FROM public.erp_stock_lots WHERE import_id = v_s AND lote IS NOT NULL GROUP BY 1, 2),
  ln AS (SELECT l.nro_documento, l.secuencia, l.cod_producto, greatest(l.cant_pendiente, 0) AS pend,
           sum(greatest(l.cant_pendiente, 0)) OVER (PARTITION BY l.nro_documento, l.cod_producto ORDER BY l.secuencia) AS acum
         FROM public.erp_contract_lines l WHERE l.import_id = v_c)
  -- El stock de un documento y SKU se reparte entre sus líneas en orden de secuencia
  SELECT ln.nro_documento, ln.secuencia, st.stock,
    greatest(least(ln.pend, COALESCE(st.stock, 0) - (ln.acum - ln.pend)), 0)
  FROM ln LEFT JOIN st ON st.lote = ln.nro_documento AND st.cod_producto = ln.cod_producto;
$function$;
REVOKE ALL ON FUNCTION public.erp_lineas_stock(v_c uuid, v_s uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erp_lineas_stock(v_c uuid, v_s uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.erp_log_finish(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.apt_can_load() THEN RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar datos del ERP'); END IF;
  IF COALESCE(p->>'status', '') NOT IN ('OK', 'ERROR') THEN RETURN jsonb_build_object('success', false, 'error', 'Estado no válido'); END IF;
  UPDATE public.erp_load_log SET status = p->>'status', finished_at = now(), rows_loaded = NULLIF(p->>'rows_loaded', '')::integer,
    import_id = COALESCE(NULLIF(p->>'import_id', '')::uuid, import_id), error = left(NULLIF(p->>'error', ''), 2000),
    detalle = detalle || COALESCE(p->'detalle', '{}'::jsonb)
  WHERE id = (p->>'id')::uuid AND status = 'EN_CURSO';
  RETURN jsonb_build_object('success', true);
END $function$;
REVOKE ALL ON FUNCTION public.erp_log_finish(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_log_finish(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.erp_log_start(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.erp_log_start(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_log_start(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.erp_medidas_texto(p_cod text, p_txt text)
 RETURNS numeric[]
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t text; m text[]; v numeric; f numeric; chain numeric[] := '{}'; dims numeric[] := '{}'; rest numeric[] := '{}';
  largo numeric; quitado boolean := false; big boolean; pulg boolean; d numeric; i integer;
BEGIN
  t := upper(COALESCE(p_txt, ''));
  t := replace(replace(replace(t, '”', '"'), '″', '"'), '''''', '"');
  t := regexp_replace(t, '(\d),(\d)', '\1.\2', 'g');
  FOR m IN SELECT regexp_matches(t, '(\d+(?:\.\d+)?(?:/\d+)?)\s*(MM|CM|MTS|MT|M|")?(?![A-WYZ0-9])(\s*X(?=\s*\d))?', 'g') LOOP
    v := CASE WHEN m[1] LIKE '%/%' THEN split_part(m[1], '/', 1)::numeric / NULLIF(split_part(m[1], '/', 2)::numeric, 0) ELSE m[1]::numeric END;
    CONTINUE WHEN v IS NULL;
    chain := chain || v;
    IF m[2] IS NOT NULL THEN
      f := CASE m[2] WHEN 'MM' THEN 0.001 WHEN 'CM' THEN 0.01 WHEN '"' THEN 0.0254 ELSE 1 END;
      big := f = 1 AND EXISTS (SELECT 1 FROM unnest(chain[1:cardinality(chain) - 1]) c WHERE c >= 20);
      -- «5 X 3 X 4.5MM»: la sección en pulgadas y el espesor en mm
      pulg := f = 0.001 AND cardinality(chain) >= 3
        AND NOT EXISTS (SELECT 1 FROM unnest(chain[1:cardinality(chain) - 1]) c WHERE c > 12 OR c <> trunc(c));
      FOR i IN 1..cardinality(chain) LOOP
        dims := dims || CASE WHEN i = cardinality(chain) THEN chain[i] * f WHEN big THEN chain[i] * 0.001 WHEN pulg THEN chain[i] * 0.0254
          ELSE chain[i] * f END;
      END LOOP;
      chain := '{}';
    ELSIF m[3] IS NULL THEN
      IF cardinality(chain) >= 2 AND NOT EXISTS (SELECT 1 FROM unnest(chain) c WHERE c > 12) THEN
        dims := dims || ARRAY(SELECT c * 0.0254 FROM unnest(chain) c);
      END IF;
      chain := '{}';
    END IF;
  END LOOP;
  dims := ARRAY(SELECT x FROM unnest(dims) x WHERE x > 0);
  IF EXISTS (SELECT 1 FROM unnest(dims) x WHERE x > 15) THEN RETURN NULL; END IF;  -- más largo que una plataforma: mal leído

  IF COALESCE(p_cod, '') ~ '^\.?(E\.)?[A-Z][A-Z0-9]*\.[0-9]{2}\.[0-9]{3,6}\.[0-9]{4,5}$' THEN
    largo := substring(p_cod FROM '([0-9]+)$')::numeric / 1000;
    IF largo < 0.1 THEN largo := NULL; END IF;
  END IF;
  IF largo IS NULL THEN largo := (SELECT max(x) FROM unnest(dims) x); END IF;
  IF largo IS NULL THEN RETURN NULL; END IF;
  FOREACH d IN ARRAY dims LOOP
    IF NOT quitado AND abs(d - largo) < 0.0006 THEN quitado := true; ELSE rest := rest || d; END IF;
  END LOOP;
  rest := ARRAY(SELECT x FROM unnest(rest) x ORDER BY x DESC);
  RETURN ARRAY[largo, rest[1], rest[2]];
END $function$;
REVOKE ALL ON FUNCTION public.erp_medidas_texto(p_cod text, p_txt text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_medidas_texto(p_cod text, p_txt text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.erp_ot_detalle(p_ot text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET enable_nestloop TO 'off'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.erp_ot_detalle(p_ot text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_ot_detalle(p_ot text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.erp_ots(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET enable_nestloop TO 'off'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.erp_ots(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_ots(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.erp_reglas_comparacion()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET enable_nestloop TO 'off'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.erp_reglas_comparacion() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_reglas_comparacion() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.erp_rule_version()
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT version FROM public.erp_rule_versions WHERE estado = 'VIGENTE';
$function$;
REVOKE ALL ON FUNCTION public.erp_rule_version() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_rule_version() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.erp_stamp_rule_version()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'erp_imports' THEN
    IF NEW.status = 'ACTIVA' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'ACTIVA') THEN NEW.rule_version := public.erp_rule_version(); END IF;
  ELSE
    NEW.rule_version := public.erp_rule_version();
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.erp_stamp_rule_version() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erp_stamp_rule_version() TO service_role;

CREATE OR REPLACE FUNCTION public.erp_stock(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET enable_nestloop TO 'off'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.erp_stock(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_stock(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.erp_stock_corte()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN NOT public.erp_ref_can_view() THEN jsonb_build_object('success', false, 'error', 'Sin acceso a la referencia del ERP')
    ELSE jsonb_build_object('success', true,
      'cut_at', i.cut_at, 'applied_at', i.applied_at,
      'horas', CASE WHEN i.cut_at IS NOT NULL THEN round((extract(epoch FROM now() - i.cut_at) / 3600)::numeric, 1) END,
      'max_horas', COALESCE(s.corte_max_horas, 48),
      'estado', CASE WHEN i.id IS NULL THEN 'SIN_CARGA'
        WHEN i.cut_at IS NULL OR i.cut_at < now() - make_interval(hours => COALESCE(s.corte_max_horas, 48)) THEN 'DESACTUALIZADO'
        ELSE 'VIGENTE' END) END
  FROM (SELECT 1) one
  LEFT JOIN public.erp_imports i ON i.id = public.erp_active_import('STOCK')
  LEFT JOIN public.erp_contract_settings s ON s.id = 1;
$function$;
REVOKE ALL ON FUNCTION public.erp_stock_corte() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_stock_corte() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.erp_stock_cruce(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET enable_nestloop TO 'off'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.erp_stock_cruce(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_stock_cruce(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.erp_tipo_tms(p_tipo text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE upper(btrim(COALESCE(p_tipo, ''))) WHEN 'CONTRATO DE VENTAS' THEN 'CONTRATO' WHEN 'SUBCONTRATO DE VENTAS' THEN 'SUBCONTRATO'
    WHEN 'ERROR DE CONTRATO' THEN 'ERROR' WHEN 'GARANTIA DE VENTAS' THEN 'GARANTIA' END;
$function$;
REVOKE ALL ON FUNCTION public.erp_tipo_tms(p_tipo text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_tipo_tms(p_tipo text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_apt_movs(p_raiz text DEFAULT NULL::text)
 RETURNS TABLE(id bigint, side text, clase text, tipodocto text, almacen text, bodega text, numero text, fecha date, producto text, glosa text, unidad text, lote text, raiz text, qty numeric, kg numeric, razon_social text, fecha_entrega date, interno boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Dos consultas separadas: con OT el filtro por prefijo del lote deja pocas filas y el plan es otro
  IF p_raiz IS NULL THEN
    RETURN QUERY
    WITH m AS (
      SELECT m.id, m.side, m.clase, m.tipodocto, public.apt_almacen(m.bodega) AS almacen, m.bodega, m.numero, m.fecha,
        m.producto, m.glosa, m.unidad, m.lote, public.apt_ot_raiz(m.lote) AS raiz, abs(m.cantidad) AS qty,
        public.inv_kg(m.peso_kg, m.cantidad, m.peso_unit) AS kg, m.razon_social, m.fecha_entrega
      FROM public.inv_movements_v m
      WHERE m.active AND public.apt_almacen(m.bodega) IS NOT NULL)
    SELECT m.*, (m.clase = 'TRASPASO' AND EXISTS (
        SELECT 1 FROM public.inv_movements_v c
        WHERE c.active AND c.numero = m.numero AND c.tipodocto = m.tipodocto AND c.producto = m.producto
          AND c.side <> m.side AND c.bodega <> m.bodega AND public.apt_almacen(c.bodega) IS NOT NULL
          AND public.apt_ot_raiz(c.lote) IS NOT DISTINCT FROM m.raiz)) AS interno
    FROM m;
  ELSE
    RETURN QUERY EXECUTE $q$
    WITH m AS (
      SELECT m.id, m.side, m.clase, m.tipodocto, public.apt_almacen(m.bodega) AS almacen, m.bodega, m.numero, m.fecha,
        m.producto, m.glosa, m.unidad, m.lote, public.apt_ot_raiz(m.lote) AS raiz, abs(m.cantidad) AS qty,
        public.inv_kg(m.peso_kg, m.cantidad, m.peso_unit) AS kg, m.razon_social, m.fecha_entrega
      FROM public.inv_movements_v m
      WHERE m.active AND upper(btrim(m.lote)) LIKE $1 || '%' AND public.apt_almacen(m.bodega) IS NOT NULL
        AND public.apt_ot_raiz(m.lote) = $1)
    SELECT m.*, (m.clase = 'TRASPASO' AND EXISTS (
        SELECT 1 FROM public.inv_movements_v c
        WHERE c.active AND c.numero = m.numero AND c.tipodocto = m.tipodocto AND c.producto = m.producto
          AND c.side <> m.side AND c.bodega <> m.bodega AND public.apt_almacen(c.bodega) IS NOT NULL
          AND public.apt_ot_raiz(c.lote) IS NOT DISTINCT FROM m.raiz)) AS interno
    FROM m$q$ USING p_raiz;
  END IF;
END $function$;
REVOKE ALL ON FUNCTION public.inv_apt_movs(p_raiz text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_apt_movs(p_raiz text) TO service_role;

CREATE OR REPLACE FUNCTION public.inv_apt_resumen()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  v := public.inv_read_cached('apt_resumen');
  RETURN COALESCE(v, public.inv_preparing());
END $function$;
REVOKE ALL ON FUNCTION public.inv_apt_resumen() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_apt_resumen() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_cache_refresh()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_sub text := current_setting('request.jwt.claim.sub', true); v_claims text := current_setting('request.jwt.claims', true);
  v_stamp timestamptz; v_t0 timestamptz := clock_timestamp(); v_k text; v_payload jsonb; v_n integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('inv_cache')) THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'en curso');
  END IF;
  SELECT rebuilt_at INTO v_stamp FROM public.inv_state WHERE id = 1;
  IF public.apt_read_cache_actor() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No hay una cuenta activa con acceso APT para preparar la caché');
  END IF;
  FOREACH v_k IN ARRAY ARRAY['overview', 'dwell', 'flow', 'verify', 'catalogs'] LOOP
    v_payload := CASE v_k
      WHEN 'overview' THEN public.inv_overview_live(NULL, NULL)
      WHEN 'dwell' THEN public.inv_dwell_live('{}'::jsonb)
      WHEN 'flow' THEN public.inv_flow_live('{}'::jsonb)
      WHEN 'verify' THEN public.inv_verify_live()
      ELSE public.inv_catalogs_live() END;
    IF (v_payload->>'success')::boolean THEN
      INSERT INTO public.inv_read_cache (k, payload, stamp, built_at) VALUES (v_k, v_payload, v_stamp, clock_timestamp())
      ON CONFLICT (k) DO UPDATE SET payload = EXCLUDED.payload, stamp = EXCLUDED.stamp, built_at = EXCLUDED.built_at;
      v_n := v_n + 1;
    END IF;
  END LOOP;

  -- Stock por clave con su descripción (último movimiento del producto) y cliente (último con razón social del lote)
  DELETE FROM public.inv_stock_cache;
  INSERT INTO public.inv_stock_cache (bodega, kind, producto, lk, lote, ot, qty, kg, kg_conocido, fecha_min, root_min, inferido,
    foto, capas, glosa, unidad, cliente)
  WITH r AS (SELECT x.*, NULLIF(x.lk, '') AS lote FROM public.inv_stock_rows() x),
  g AS (SELECT DISTINCT ON (producto) producto, glosa, unidad FROM public.inv_movements_v WHERE active ORDER BY producto, fecha DESC),
  c AS (SELECT DISTINCT ON (lote) lote, razon_social FROM public.inv_movements_v
        WHERE active AND lote IS NOT NULL AND razon_social IS NOT NULL ORDER BY lote, fecha DESC)
  SELECT r.bodega, r.kind, r.producto, r.lk, r.lote, public.inv_ot(r.lote), r.qty, r.kg, r.kg_conocido, r.fecha_min, r.root_min,
    r.inferido, r.foto, r.capas, g.glosa, g.unidad, c.razon_social
  FROM r LEFT JOIN g ON g.producto = r.producto LEFT JOIN c ON c.lote = r.lote;
  ANALYZE public.inv_stock_cache;
  INSERT INTO public.inv_read_cache (k, payload, stamp, built_at)
  VALUES ('stock', jsonb_build_object('success', true, 'filas', (SELECT count(*) FROM public.inv_stock_cache)), v_stamp, clock_timestamp())
  ON CONFLICT (k) DO UPDATE SET payload = EXCLUDED.payload, stamp = EXCLUDED.stamp, built_at = EXCLUDED.built_at;

  PERFORM public.inv_contratos_refresh(v_stamp);
  INSERT INTO public.inv_read_cache (k, payload, stamp, built_at)
    SELECT 'dwell_apt_' || d, public.inv_dwell_dim_live(jsonb_build_object('dim', d, 'ambito', 'apt')), v_stamp, now()
    FROM unnest(ARRAY['ot', 'producto', 'cliente']) d
    ON CONFLICT (k) DO UPDATE SET payload = EXCLUDED.payload, stamp = EXCLUDED.stamp, built_at = EXCLUDED.built_at;
  v_payload := public.inv_dwell_live(jsonb_build_object('bodegas', (SELECT COALESCE(jsonb_agg(code), '[]'::jsonb)
    FROM public.inv_warehouses WHERE public.apt_almacen(code) IS NOT NULL)));
  IF (v_payload->>'success')::boolean THEN
    INSERT INTO public.inv_read_cache (k, payload, stamp, built_at) VALUES ('dwell_apt', v_payload, v_stamp, clock_timestamp())
    ON CONFLICT (k) DO UPDATE SET payload = EXCLUDED.payload, stamp = EXCLUDED.stamp, built_at = EXCLUDED.built_at;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', COALESCE(v_sub, ''), true);
  PERFORM set_config('request.jwt.claims', COALESCE(v_claims, ''), true);
  RETURN jsonb_build_object('success', true, 'vistas', v_n + 1, 'segundos', round(extract(epoch FROM clock_timestamp() - v_t0)::numeric, 2));
END $function$;
REVOKE ALL ON FUNCTION public.inv_cache_refresh() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_cache_refresh() TO service_role;

CREATE OR REPLACE FUNCTION public.inv_catalog_save(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r jsonb; v jsonb;
BEGIN
  r := public.inv_catalog_save_core(p);
  IF (r->>'success')::boolean AND EXISTS (SELECT 1 FROM public.inv_read_cache WHERE k = 'catalogs') THEN
    v := public.inv_catalogs_live();
    IF (v->>'success')::boolean THEN
      UPDATE public.inv_read_cache SET payload = v, built_at = clock_timestamp() WHERE k = 'catalogs';
    END IF;
  END IF;
  RETURN r;
END $function$;
REVOKE ALL ON FUNCTION public.inv_catalog_save(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_catalog_save(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_catalog_save_core(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.inv_catalog_save_core(p jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_catalog_save_core(p jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.inv_catalogs()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  v := public.inv_read_cached('catalogs');
  IF v IS NULL THEN
    IF NOT public.inv_live_allowed() THEN RETURN public.inv_preparing(); END IF;
    RETURN public.inv_catalogs_live();
  END IF;
  RETURN v || jsonb_build_object('can_load', public.apt_can_load());
END $function$;
REVOKE ALL ON FUNCTION public.inv_catalogs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_catalogs() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_catalogs_live()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET jit TO 'off'
AS $function$
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  RETURN jsonb_build_object('success', true, 'can_load', public.apt_can_load(),
    'bodegas', COALESCE((SELECT jsonb_agg(jsonb_build_object('code', w.code, 'name', w.name, 'kind', w.kind, 'stage', w.stage, 'auto', w.auto,
        'movimientos', COALESCE(c.n, 0)) ORDER BY w.stage, w.code)
      FROM public.inv_warehouses w LEFT JOIN (SELECT bodega, count(*) n FROM public.inv_movements_v WHERE active GROUP BY bodega) c
      ON c.bodega = w.code), '[]'::jsonb),
    'tipos', COALESCE((SELECT jsonb_agg(jsonb_build_object('tipodocto', d.tipodocto, 'clase', d.clase, 'auto', d.auto,
        'movimientos', COALESCE(c.n, 0)) ORDER BY d.clase, d.tipodocto)
      FROM public.inv_doc_types d LEFT JOIN (SELECT tipodocto, count(*) n FROM public.inv_movements_v WHERE active GROUP BY tipodocto) c
      ON c.tipodocto = d.tipodocto), '[]'::jsonb));
END $function$;
REVOKE ALL ON FUNCTION public.inv_catalogs_live() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_catalogs_live() TO service_role;

CREATE OR REPLACE FUNCTION public.inv_code(v text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT NULLIF(upper(btrim(regexp_replace(COALESCE(v, ''), '\s+', ' ', 'g'))), '');
$function$;
REVOKE ALL ON FUNCTION public.inv_code(v text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_code(v text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_con_glosa(p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE g jsonb;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN RETURN p_items; END IF;
  g := public.inv_glosas(ARRAY(SELECT DISTINCT x->>'producto' FROM jsonb_array_elements(p_items) x WHERE x ? 'producto'));
  RETURN (SELECT jsonb_agg(CASE WHEN x ? 'producto' AND NOT (x ? 'glosa') THEN x || jsonb_build_object('glosa', g->>(x->>'producto')) ELSE x END ORDER BY o)
          FROM jsonb_array_elements(p_items) WITH ORDINALITY t(x, o));
END $function$;
REVOKE ALL ON FUNCTION public.inv_con_glosa(p_items jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_con_glosa(p_items jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.inv_contrato(p_q text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_raiz text := public.apt_ot_raiz(p_q); v_corte date := (SELECT data_max FROM public.inv_state WHERE id = 1);
  v_productos jsonb; v_guias jsonb; v_lotes jsonb; v_sosp jsonb; v_res jsonb; v_tms jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  IF v_raiz IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Escriba el número de la OT o contrato (por ejemplo 16339 o 16339-S005)');
  END IF;
  CREATE TEMP TABLE IF NOT EXISTS inv_tmp_ot ON COMMIT DROP AS SELECT * FROM public.inv_apt_movs(NULL) WITH NO DATA;
  TRUNCATE inv_tmp_ot;
  INSERT INTO inv_tmp_ot SELECT * FROM public.inv_apt_movs(v_raiz);
  IF NOT EXISTS (SELECT 1 FROM inv_tmp_ot) THEN
    RETURN jsonb_build_object('success', true, 'encontrado', false, 'ot', v_raiz, 'corte', v_corte);
  END IF;

  WITH mv AS (
    SELECT producto, max(unidad) AS unidad, array_agg(DISTINCT lote ORDER BY lote) AS lotes,
      (array_agg(glosa ORDER BY fecha DESC, id DESC) FILTER (WHERE glosa IS NOT NULL))[1] AS glosa,
      sum(qty) FILTER (WHERE side = 'E' AND NOT interno) AS ingresado, sum(kg) FILTER (WHERE side = 'E' AND NOT interno) AS ingresado_kg,
      sum(qty) FILTER (WHERE side = 'E' AND NOT interno AND clase = 'PRODUCCION') AS producido,
      sum(qty) FILTER (WHERE clase = 'DESPACHO') AS despachado, sum(kg) FILTER (WHERE clase = 'DESPACHO') AS despachado_kg,
      sum(qty) FILTER (WHERE side = 'S' AND NOT interno AND clase <> 'DESPACHO') AS otras_salidas,
      max(fecha) FILTER (WHERE side = 'E' AND NOT interno) AS ultimo_ingreso, max(fecha) FILTER (WHERE side = 'S' AND NOT interno) AS ultima_salida,
      count(DISTINCT numero) FILTER (WHERE clase = 'DESPACHO') AS guias
    FROM inv_tmp_ot GROUP BY producto),
  st AS (
    SELECT producto, sum(qty) FILTER (WHERE public.apt_almacen(bodega) = '647') AS s647, sum(qty) FILTER (WHERE public.apt_almacen(bodega) = '540') AS s540,
      sum(qty) FILTER (WHERE public.apt_almacen(bodega) = 'ST') AS sst, sum(qty) AS stock, sum(kg) AS stock_kg, sum(inferido) AS inferido,
      min(fecha_min) AS ingreso_stock
    FROM public.inv_stock_cache WHERE upper(btrim(lote)) LIKE v_raiz || '%' AND public.apt_almacen(bodega) IS NOT NULL AND public.apt_ot_raiz(lote) = v_raiz GROUP BY producto)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('producto', mv.producto, 'glosa', mv.glosa, 'unidad', mv.unidad, 'lotes', to_jsonb(mv.lotes),
      'ingresado', round(COALESCE(mv.ingresado, 0), 3), 'producido', round(COALESCE(mv.producido, 0), 3),
      'despachado', round(COALESCE(mv.despachado, 0), 3), 'otras_salidas', round(COALESCE(mv.otras_salidas, 0), 3),
      'stock_647', round(COALESCE(st.s647, 0), 3), 'stock_540', round(COALESCE(st.s540, 0), 3), 'stock_st', round(COALESCE(st.sst, 0), 3),
      'stock', round(COALESCE(st.stock, 0), 3), 'stock_kg', round(COALESCE(st.stock_kg, 0), 1), 'inferido', round(COALESCE(st.inferido, 0), 3),
      'ingresado_kg', round(COALESCE(mv.ingresado_kg, 0), 1), 'despachado_kg', round(COALESCE(mv.despachado_kg, 0), 1),
      'diferencia', round(COALESCE(mv.ingresado, 0) - COALESCE(mv.despachado, 0) - COALESCE(mv.otras_salidas, 0) - COALESCE(st.stock, 0), 3),
      'ultimo_ingreso', mv.ultimo_ingreso, 'ultima_salida', mv.ultima_salida, 'guias', mv.guias,
      'dias_apt', CASE WHEN COALESCE(st.stock, 0) > 0 THEN v_corte - st.ingreso_stock END)
      ORDER BY COALESCE(st.stock_kg, 0) DESC, COALESCE(mv.despachado_kg, 0) DESC, mv.producto), '[]'::jsonb)
  INTO v_productos FROM mv LEFT JOIN st ON st.producto = mv.producto;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('lote', lote, 'lineas', n, 'ingresado_kg', round(ing, 1), 'despachado_kg', round(desp, 1)) ORDER BY lote), '[]'::jsonb)
  INTO v_lotes FROM (SELECT lote, count(*) n, COALESCE(sum(kg) FILTER (WHERE side = 'E' AND NOT interno), 0) ing,
                      COALESCE(sum(kg) FILTER (WHERE clase = 'DESPACHO'), 0) desp FROM inv_tmp_ot GROUP BY lote) l;

  SELECT public.apt_flow_tms(ARRAY(SELECT DISTINCT numero FROM inv_tmp_ot WHERE clase = 'DESPACHO')) INTO v_tms;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('numero', numero, 'fecha', fecha, 'almacen', almacen, 'cliente', cliente, 'lineas', lineas,
      'cantidad', round(qty, 3), 'kg', round(kg, 1), 'fecha_entrega', fecha_entrega,
      'a_tiempo', CASE WHEN fecha_entrega IS NOT NULL THEN fecha <= fecha_entrega END, 'tms', v_tms->upper(numero))
      ORDER BY fecha DESC, numero), '[]'::jsonb)
  INTO v_guias FROM (SELECT numero, min(fecha) fecha, min(almacen) almacen, max(razon_social) cliente, count(*) lineas, sum(qty) qty, sum(kg) kg,
                      min(fecha_entrega) fecha_entrega FROM inv_tmp_ot WHERE clase = 'DESPACHO' GROUP BY numero) d;

  -- Lotes de otra raíz con un dígito de diferencia (posible error de digitación); candidatas desde la lista guardada
  WITH c AS MATERIALIZED (
    SELECT x->>'ot' AS raiz FROM jsonb_array_elements(COALESCE(
        (SELECT r.payload->'contratos' FROM public.inv_read_cache r WHERE r.k = 'contratos'), '[]'::jsonb)) x
    WHERE length(x->>'ot') BETWEEN length(v_raiz) - 1 AND length(v_raiz) + 1 AND public.apt_raiz_parecida(x->>'ot', v_raiz)),
  l AS MATERIALIZED (
    SELECT m.bodega, m.lote, count(*) n FROM public.inv_movements_v m
    WHERE m.active AND upper(btrim(m.lote)) LIKE ANY (ARRAY(SELECT raiz || '%' FROM c)) GROUP BY 1, 2)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('ot', raiz, 'lotes', lotes, 'lineas', n) ORDER BY n DESC, raiz), '[]'::jsonb) INTO v_sosp
  FROM (SELECT c.raiz, array_agg(DISTINCT l.lote ORDER BY l.lote) lotes, sum(l.n) n
        FROM l JOIN c ON public.apt_ot_raiz(l.lote) = c.raiz
        WHERE public.apt_almacen(l.bodega) IS NOT NULL GROUP BY 1 ORDER BY 3 DESC LIMIT 20) s;

  SELECT jsonb_build_object('cliente', public.inv_ot_cliente(v_raiz),
      'ingresado_kg', round(COALESCE(sum(kg) FILTER (WHERE side = 'E' AND NOT interno), 0), 1),
      'despachado_kg', round(COALESCE(sum(kg) FILTER (WHERE clase = 'DESPACHO'), 0), 1),
      'otras_salidas_kg', round(COALESCE(sum(kg) FILTER (WHERE side = 'S' AND NOT interno AND clase <> 'DESPACHO'), 0), 1),
      'guias', count(DISTINCT numero) FILTER (WHERE clase = 'DESPACHO'),
      'primer_ingreso', min(fecha) FILTER (WHERE side = 'E' AND NOT interno), 'ultimo_ingreso', max(fecha) FILTER (WHERE side = 'E' AND NOT interno),
      'ultima_salida', max(fecha) FILTER (WHERE side = 'S' AND NOT interno),
      'fecha_entrega_min', min(fecha_entrega), 'fecha_entrega_max', max(fecha_entrega),
      'a_tiempo_pct', round(100 * sum(kg) FILTER (WHERE clase = 'DESPACHO' AND fecha_entrega IS NOT NULL AND fecha <= fecha_entrega)
                      / NULLIF(sum(kg) FILTER (WHERE clase = 'DESPACHO' AND fecha_entrega IS NOT NULL), 0), 1),
      'productos', count(DISTINCT producto), 'lotes', count(DISTINCT lote))
  INTO v_res FROM inv_tmp_ot;
  v_res := v_res || (SELECT jsonb_build_object('stock_kg', round(COALESCE(sum(kg), 0), 1),
      'stock_647_kg', round(COALESCE(sum(kg) FILTER (WHERE public.apt_almacen(bodega) = '647'), 0), 1),
      'stock_540_kg', round(COALESCE(sum(kg) FILTER (WHERE public.apt_almacen(bodega) = '540'), 0), 1),
      'stock_st_kg', round(COALESCE(sum(kg) FILTER (WHERE public.apt_almacen(bodega) = 'ST'), 0), 1))
    FROM public.inv_stock_cache WHERE upper(btrim(lote)) LIKE v_raiz || '%' AND public.apt_almacen(bodega) IS NOT NULL AND public.apt_ot_raiz(lote) = v_raiz);
  v_res := v_res || jsonb_build_object('avance_pct', CASE WHEN (v_res->>'ingresado_kg')::numeric > 0
    THEN round(100 * least((v_res->>'despachado_kg')::numeric / (v_res->>'ingresado_kg')::numeric, 1), 1) END);

  RETURN jsonb_build_object('success', true, 'encontrado', true, 'ot', v_raiz, 'corte', v_corte,
    'stock_al_dia', COALESCE((public.inv_read_cached('stock')->'cache'->>'al_dia')::boolean, false),
    'resumen', v_res, 'productos', v_productos, 'lotes', v_lotes, 'guias', v_guias, 'sospechosos', v_sosp);
END $function$;
REVOKE ALL ON FUNCTION public.inv_contrato(p_q text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_contrato(p_q text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_contrato_kardex(p_q text, p_producto text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_raiz text := public.apt_ot_raiz(p_q); v_prod text := NULLIF(btrim(p_producto), ''); v_movs jsonb; v_serie jsonb; v_n int;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  IF v_raiz IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Escriba el número de la OT o contrato'); END IF;
  CREATE TEMP TABLE IF NOT EXISTS inv_tmp_kx ON COMMIT DROP AS SELECT * FROM public.inv_apt_movs(NULL) WITH NO DATA;
  TRUNCATE inv_tmp_kx;
  INSERT INTO inv_tmp_kx SELECT * FROM public.inv_apt_movs(v_raiz) WHERE v_prod IS NULL OR producto = v_prod;
  SELECT count(*) INTO v_n FROM inv_tmp_kx;

  WITH m AS (
    SELECT *, CASE WHEN side = 'E' AND NOT interno THEN qty ELSE 0 END AS e_qty, CASE WHEN side = 'S' AND NOT interno THEN qty ELSE 0 END AS s_qty,
      CASE WHEN side = 'E' AND NOT interno THEN kg ELSE 0 END AS e_kg, CASE WHEN side = 'S' AND NOT interno THEN kg ELSE 0 END AS s_kg
    FROM inv_tmp_kx),
  r AS (
    SELECT m.*, sum(e_kg - s_kg) OVER (ORDER BY fecha, side, id) AS saldo_kg,
      sum(e_qty - s_qty) OVER (PARTITION BY producto ORDER BY fecha, side, id) AS saldo_qty
    FROM m)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('fecha', fecha, 'tipo', tipodocto, 'clase', clase, 'numero', numero, 'almacen', almacen,
      'bodega', bodega, 'producto', producto, 'glosa', glosa, 'unidad', unidad, 'lote', lote, 'tercero', razon_social, 'interno', interno,
      'entrada', CASE WHEN side = 'E' THEN round(qty, 3) END, 'salida', CASE WHEN side = 'S' THEN round(qty, 3) END,
      'kg_entrada', CASE WHEN side = 'E' THEN round(kg, 1) END, 'kg_salida', CASE WHEN side = 'S' THEN round(kg, 1) END,
      'saldo_kg', round(saldo_kg, 1), 'saldo_qty', round(saldo_qty, 3)) ORDER BY fecha DESC, side DESC, id DESC), '[]'::jsonb)
  INTO v_movs FROM (SELECT * FROM r ORDER BY fecha DESC, side DESC, id DESC LIMIT 3000) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('fecha', fecha, 'ingreso_kg', round(e, 1), 'salida_kg', round(s, 1), 'saldo_kg', round(saldo, 1)) ORDER BY fecha), '[]'::jsonb)
  INTO v_serie FROM (
    SELECT fecha, e, s, sum(e - s) OVER (ORDER BY fecha) saldo FROM (
      SELECT fecha, COALESCE(sum(kg) FILTER (WHERE side = 'E' AND NOT interno), 0) e, COALESCE(sum(kg) FILTER (WHERE side = 'S' AND NOT interno), 0) s
      FROM inv_tmp_kx GROUP BY fecha) d) z;

  RETURN jsonb_build_object('success', true, 'ot', v_raiz, 'producto', v_prod, 'lineas', v_n, 'truncado', v_n > 3000,
    'corte', (SELECT data_max FROM public.inv_state WHERE id = 1),
    'totales', (SELECT jsonb_build_object(
        'ingreso_kg', round(COALESCE(sum(kg) FILTER (WHERE side = 'E' AND NOT interno), 0), 1),
        'salida_kg', round(COALESCE(sum(kg) FILTER (WHERE side = 'S' AND NOT interno), 0), 1),
        'ingreso_qty', CASE WHEN v_prod IS NOT NULL THEN round(COALESCE(sum(qty) FILTER (WHERE side = 'E' AND NOT interno), 0), 3) END,
        'salida_qty', CASE WHEN v_prod IS NOT NULL THEN round(COALESCE(sum(qty) FILTER (WHERE side = 'S' AND NOT interno), 0), 3) END,
        'internos', count(*) FILTER (WHERE interno)) FROM inv_tmp_kx),
    'serie', v_serie, 'movimientos', v_movs);
END $function$;
REVOKE ALL ON FUNCTION public.inv_contrato_kardex(p_q text, p_producto text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_contrato_kardex(p_q text, p_producto text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_contratos()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  v := public.inv_read_cached('contratos');
  RETURN COALESCE(v, public.inv_preparing());
END $function$;
REVOKE ALL ON FUNCTION public.inv_contratos() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_contratos() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_contratos_refresh(p_stamp timestamp with time zone)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_corte date := (SELECT data_max FROM public.inv_state WHERE id = 1); v_lista jsonb; v_res jsonb;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS inv_tmp_apt ON COMMIT DROP AS SELECT * FROM public.inv_apt_movs(NULL) WITH NO DATA;
  TRUNCATE inv_tmp_apt;
  INSERT INTO inv_tmp_apt SELECT * FROM public.inv_apt_movs(NULL);
  ANALYZE inv_tmp_apt;

  WITH mv AS (
    SELECT raiz,
      sum(qty) FILTER (WHERE side = 'E' AND NOT interno) AS ing_qty, sum(kg) FILTER (WHERE side = 'E' AND NOT interno) AS ing_kg,
      sum(qty) FILTER (WHERE clase = 'DESPACHO') AS desp_qty, sum(kg) FILTER (WHERE clase = 'DESPACHO') AS desp_kg,
      sum(kg) FILTER (WHERE clase = 'DESPACHO' AND fecha_entrega IS NOT NULL AND fecha <= fecha_entrega) AS desp_kg_a_tiempo,
      sum(kg) FILTER (WHERE clase = 'DESPACHO' AND fecha_entrega IS NOT NULL) AS desp_kg_con_fecha,
      count(DISTINCT numero) FILTER (WHERE clase = 'DESPACHO') AS guias, count(DISTINCT producto) AS productos,
      count(DISTINCT lote) AS lotes, min(fecha) FILTER (WHERE side = 'E' AND NOT interno) AS primer_ingreso,
      max(fecha) FILTER (WHERE side = 'E' AND NOT interno) AS ultimo_ingreso,
      max(fecha) FILTER (WHERE side = 'S' AND NOT interno) AS ultima_salida, min(fecha_entrega) AS fecha_entrega,
      (array_agg(razon_social ORDER BY kg DESC) FILTER (WHERE clase = 'DESPACHO' AND razon_social IS NOT NULL))[1] AS cliente_guia
    FROM inv_tmp_apt WHERE raiz IS NOT NULL GROUP BY raiz),
  st AS (
    SELECT public.apt_ot_raiz(lote) AS raiz, sum(qty) AS qty, sum(kg) AS kg,
      sum(kg) FILTER (WHERE public.apt_almacen(bodega) = '647') AS kg_647, sum(kg) FILTER (WHERE public.apt_almacen(bodega) = '540') AS kg_540,
      sum(kg) FILTER (WHERE public.apt_almacen(bodega) = 'ST') AS kg_st, min(fecha_min) AS ingreso_mas_antiguo
    FROM public.inv_stock_cache WHERE public.apt_almacen(bodega) IS NOT NULL AND public.apt_ot_raiz(lote) IS NOT NULL GROUP BY 1),
  tms AS (SELECT DISTINCT ON (upper(c.code)) upper(c.code) AS code, cl.business_name AS cliente
          FROM public.contracts c JOIN public.clients cl ON cl.id = c.client_id WHERE cl.business_name IS NOT NULL ORDER BY upper(c.code)),
  tmsr AS (SELECT DISTINCT ON (public.apt_ot_raiz(c.code)) public.apt_ot_raiz(c.code) AS raiz, cl.business_name AS cliente
           FROM public.contracts c JOIN public.clients cl ON cl.id = c.client_id
           WHERE cl.business_name IS NOT NULL AND public.apt_ot_raiz(c.code) IS NOT NULL
           ORDER BY public.apt_ot_raiz(c.code), (c.parent_contract_id IS NULL) DESC, c.code),
  erp AS (SELECT * FROM public.erp_ot_cliente_erp())
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'ot', mv.raiz, 'cliente', COALESCE(mv.cliente_guia, tms.cliente, tmsr.cliente, erp.cliente), 'productos', mv.productos, 'lotes', mv.lotes,
      'ingresado_kg', round(COALESCE(mv.ing_kg, 0), 1), 'despachado_kg', round(COALESCE(mv.desp_kg, 0), 1),
      'stock_kg', round(COALESCE(st.kg, 0), 1), 'stock_qty', round(COALESCE(st.qty, 0), 3),
      'stock_647_kg', round(COALESCE(st.kg_647, 0), 1), 'stock_540_kg', round(COALESCE(st.kg_540, 0), 1), 'stock_st_kg', round(COALESCE(st.kg_st, 0), 1),
      'avance_pct', CASE WHEN COALESCE(mv.ing_kg, 0) > 0 THEN round(100 * least(COALESCE(mv.desp_kg, 0) / mv.ing_kg, 1), 1) END,
      'a_tiempo_pct', CASE WHEN COALESCE(mv.desp_kg_con_fecha, 0) > 0 THEN round(100 * COALESCE(mv.desp_kg_a_tiempo, 0) / mv.desp_kg_con_fecha, 1) END,
      'guias', mv.guias, 'primer_ingreso', mv.primer_ingreso, 'ultimo_ingreso', mv.ultimo_ingreso, 'ultima_salida', mv.ultima_salida,
      'fecha_entrega', mv.fecha_entrega, 'dias_stock', CASE WHEN COALESCE(st.kg, 0) > 0 THEN v_corte - st.ingreso_mas_antiguo END)
      ORDER BY COALESCE(st.kg, 0) DESC, COALESCE(mv.desp_kg, 0) DESC), '[]'::jsonb)
  INTO v_lista
  FROM mv LEFT JOIN st ON st.raiz = mv.raiz LEFT JOIN tms ON tms.code = mv.raiz
    LEFT JOIN tmsr ON tmsr.raiz = mv.raiz LEFT JOIN erp ON erp.ot = mv.raiz;

  WITH sc AS (SELECT public.apt_almacen(bodega) AS almacen, * FROM public.inv_stock_cache WHERE public.apt_almacen(bodega) IS NOT NULL),
  alm AS (SELECT a.almacen, a.o FROM (VALUES ('647', 1), ('540', 2), ('ST', 3)) a(almacen, o)),
  porst AS (SELECT almacen, sum(kg) kg, sum(kg) FILTER (WHERE ot IS NULL) kg_libre, sum(kg) FILTER (WHERE ot IS NOT NULL) kg_comprometido,
              count(*) claves, count(DISTINCT public.apt_ot_raiz(lote)) ots,
              round(sum(kg * (v_corte - fecha_min)) FILTER (WHERE fecha_min IS NOT NULL) / NULLIF(sum(kg) FILTER (WHERE fecha_min IS NOT NULL), 0), 1) AS dias_pond,
              sum(kg) FILTER (WHERE v_corte - fecha_min <= 30) AS kg_0_30, sum(kg) FILTER (WHERE v_corte - fecha_min BETWEEN 31 AND 60) AS kg_31_60,
              sum(kg) FILTER (WHERE v_corte - fecha_min BETWEEN 61 AND 90) AS kg_61_90, sum(kg) FILTER (WHERE v_corte - fecha_min > 90) AS kg_90,
              sum(kg) FILTER (WHERE fecha_min IS NULL) AS kg_sin_fecha
            FROM sc GROUP BY 1),
  pormv AS (SELECT almacen, sum(kg) FILTER (WHERE side = 'E' AND NOT interno) ing_kg, sum(kg) FILTER (WHERE clase = 'DESPACHO') desp_kg,
              sum(kg) FILTER (WHERE side = 'E' AND NOT interno AND fecha > v_corte - 30) ing_kg_30,
              sum(kg) FILTER (WHERE clase = 'DESPACHO' AND fecha > v_corte - 30) desp_kg_30,
              count(DISTINCT numero) FILTER (WHERE clase = 'DESPACHO' AND fecha > v_corte - 30) guias_30
            FROM inv_tmp_apt GROUP BY 1)
  SELECT jsonb_build_object('success', true, 'corte', v_corte,
    'almacenes', COALESCE(jsonb_agg(jsonb_build_object('almacen', alm.almacen,
       'stock_kg', round(COALESCE(porst.kg, 0), 1), 'kg_libre', round(COALESCE(porst.kg_libre, 0), 1),
       'kg_comprometido', round(COALESCE(porst.kg_comprometido, 0), 1), 'claves', COALESCE(porst.claves, 0), 'ots', COALESCE(porst.ots, 0),
       'dias_pond', porst.dias_pond, 'ingresado_kg', round(COALESCE(pormv.ing_kg, 0), 1), 'despachado_kg', round(COALESCE(pormv.desp_kg, 0), 1),
       'ingresado_kg_30', round(COALESCE(pormv.ing_kg_30, 0), 1), 'despachado_kg_30', round(COALESCE(pormv.desp_kg_30, 0), 1),
       'guias_30', COALESCE(pormv.guias_30, 0),
       'antiguedad', jsonb_build_object('0-30', round(COALESCE(porst.kg_0_30, 0), 1), '31-60', round(COALESCE(porst.kg_31_60, 0), 1),
          '61-90', round(COALESCE(porst.kg_61_90, 0), 1), '>90', round(COALESCE(porst.kg_90, 0), 1), 'sin fecha', round(COALESCE(porst.kg_sin_fecha, 0), 1)))
       ORDER BY alm.o), '[]'::jsonb),
    'top_ot', (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (SELECT x FROM jsonb_array_elements(v_lista) x
               WHERE (x->>'stock_kg')::numeric > 0 ORDER BY (x->>'stock_kg')::numeric DESC LIMIT 10) t))
  INTO v_res FROM alm LEFT JOIN porst ON porst.almacen = alm.almacen LEFT JOIN pormv ON pormv.almacen = alm.almacen;

  INSERT INTO public.inv_read_cache (k, payload, stamp, built_at)
  VALUES ('contratos', jsonb_build_object('success', true, 'corte', v_corte, 'contratos', v_lista), p_stamp, clock_timestamp()),
         ('apt_resumen', v_res, p_stamp, clock_timestamp())
  ON CONFLICT (k) DO UPDATE SET payload = EXCLUDED.payload, stamp = EXCLUDED.stamp, built_at = EXCLUDED.built_at;
  RETURN jsonb_array_length(v_lista);
END $function$;
REVOKE ALL ON FUNCTION public.inv_contratos_refresh(p_stamp timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_contratos_refresh(p_stamp timestamp with time zone) TO service_role;

CREATE OR REPLACE FUNCTION public.inv_dwell(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v jsonb; v_apt boolean := COALESCE(p->>'ambito', '') = 'apt'; v_sin_filtro boolean;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  v_sin_filtro := COALESCE(p->>'desde', '') = '' AND COALESCE(p->>'hasta', '') = ''
     AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(p->'bodegas') = 'array' THEN p->'bodegas' END), 0) = 0;
  IF v_sin_filtro THEN
    v := public.inv_read_cached(CASE WHEN v_apt THEN 'dwell_apt' ELSE 'dwell' END);
    IF v IS NULL AND NOT public.inv_live_allowed() THEN RETURN public.inv_preparing(); END IF;
  END IF;
  IF v IS NULL THEN
    IF v_apt AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(p->'bodegas') = 'array' THEN p->'bodegas' END), 0) = 0 THEN
      p := p || jsonb_build_object('bodegas', (SELECT COALESCE(jsonb_agg(code), '[]'::jsonb) FROM public.inv_warehouses WHERE public.apt_almacen(code) IS NOT NULL));
    END IF;
    v := public.inv_dwell_live(p);
  END IF;
  IF v ? 'mas_antiguos' THEN v := jsonb_set(v, '{mas_antiguos}', public.inv_con_glosa(v->'mas_antiguos')); END IF;
  RETURN v;
END $function$;
REVOKE ALL ON FUNCTION public.inv_dwell(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_dwell(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_dwell_dim(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v jsonb; v_dim text := COALESCE(NULLIF(p->>'dim', ''), 'ot'); v_q text := upper(btrim(COALESCE(p->>'q', '')));
  v_limit int := LEAST(GREATEST(COALESCE(NULLIF(p->>'limit', '')::int, 300), 1), 5000);
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  IF COALESCE(p->>'ambito', '') = 'apt' AND COALESCE(p->>'desde', '') = '' AND COALESCE(p->>'hasta', '') = '' AND COALESCE(p->>'ot', '') = '' THEN
    v := public.inv_read_cached('dwell_apt_' || v_dim);
  END IF;
  IF v IS NULL THEN v := public.inv_dwell_dim_live(p); END IF;
  IF v ? 'filas' THEN
    SELECT v || jsonb_build_object('total', count(*), 'filas', COALESCE(jsonb_agg(x ORDER BY o) FILTER (WHERE rn <= v_limit), '[]'::jsonb))
    INTO v FROM (SELECT x, o, row_number() OVER (ORDER BY o) rn FROM jsonb_array_elements(v->'filas') WITH ORDINALITY t(x, o)
                 WHERE v_q = '' OR upper(concat_ws(' ', x->>'key', x->>'glosa', x->>'cliente')) LIKE '%' || v_q || '%') f;
  END IF;
  RETURN v;
END $function$;
REVOKE ALL ON FUNCTION public.inv_dwell_dim(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_dwell_dim(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_dwell_dim_live(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s public.inv_state; v_from date; v_to date; v_dim text := COALESCE(NULLIF(p->>'dim', ''), 'ot');
  v_apt boolean := COALESCE(p->>'ambito', '') = 'apt'; v_ot text := public.apt_ot_raiz(NULLIF(p->>'ot', ''));
BEGIN
  IF v_dim NOT IN ('ot', 'producto', 'cliente') THEN RETURN jsonb_build_object('success', false, 'error', 'Vista no válida'); END IF;
  SELECT * INTO s FROM public.inv_state WHERE id = 1;
  v_to := COALESCE(NULLIF(p->>'hasta', '')::date, s.data_max); v_from := COALESCE(NULLIF(p->>'desde', '')::date, s.data_min);
  RETURN (
    WITH oc AS MATERIALIZED (SELECT * FROM public.inv_ot_clientes()),
    -- Salidas del período cruzadas con la capa que consumieron (FIFO)
    c AS MATERIALIZED (
      SELECT a.qty, a.kg, a.dias_bodega, m.clase, l.producto, m.glosa, m.unidad,
        public.apt_ot_raiz(COALESCE(NULLIF(l.lk, ''), m.lote)) AS ot,
        CASE WHEN m.clase = 'DESPACHO' THEN m.razon_social END AS cliente_guia,
        CASE WHEN l.root_known >= 0.5 THEN m.fecha - l.root_fecha END AS dias_origen
      FROM public.inv_allocations a JOIN public.inv_movements_v m ON m.id = a.out_id JOIN public.inv_layers l ON l.id = a.layer_id
      WHERE m.fecha BETWEEN v_from AND v_to AND (NOT v_apt OR public.apt_almacen(l.bodega) IS NOT NULL)),
    c2 AS (
      SELECT c.*, COALESCE(c.cliente_guia, oc.cliente) AS cliente FROM c LEFT JOIN oc ON oc.ot = c.ot
      WHERE v_ot IS NULL OR c.ot = v_ot),
    st AS (
      SELECT r.producto, r.glosa, r.unidad, r.qty, r.kg, r.ot, COALESCE(r.cliente, oc.cliente) AS cliente, s.data_max - r.fecha_min AS dias
      FROM public.inv_stock_cache r LEFT JOIN oc ON oc.ot = r.ot
      WHERE (NOT v_apt OR public.apt_almacen(r.bodega) IS NOT NULL) AND (v_ot IS NULL OR r.ot = v_ot)),
    k AS (SELECT CASE v_dim WHEN 'ot' THEN ot WHEN 'producto' THEN producto ELSE cliente END AS key, * FROM c2),
    ks AS (SELECT CASE v_dim WHEN 'ot' THEN ot WHEN 'producto' THEN producto ELSE cliente END AS key, * FROM st),
    sal AS (
      SELECT key, count(*) n, COALESCE(sum(kg), 0) kg, COALESCE(sum(kg) FILTER (WHERE clase = 'DESPACHO'), 0) kg_desp,
        round(avg(dias_bodega), 1) prom, round(sum(kg * dias_bodega) FILTER (WHERE kg > 0 AND dias_bodega IS NOT NULL)
          / NULLIF(sum(kg) FILTER (WHERE kg > 0 AND dias_bodega IS NOT NULL), 0), 1) prom_kg,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY dias_bodega))::numeric, 1) p50,
        round((percentile_cont(0.9) WITHIN GROUP (ORDER BY dias_bodega))::numeric, 1) p90,
        max(dias_bodega) mx, round(avg(dias_origen), 1) prom_o,
        (array_agg(glosa ORDER BY glosa IS NULL) )[1] glosa, max(unidad) unidad,
        (array_agg(cliente ORDER BY cliente IS NULL))[1] cliente, count(DISTINCT ot) ots
      FROM k WHERE key IS NOT NULL GROUP BY key),
    stk AS (
      SELECT key, COALESCE(sum(kg), 0) kg, COALESCE(sum(qty), 0) qty, count(*) claves,
        round(sum(kg * dias) FILTER (WHERE dias IS NOT NULL AND kg > 0) / NULLIF(sum(kg) FILTER (WHERE dias IS NOT NULL AND kg > 0), 0), 1) dias_pond,
        max(dias) dias_max, COALESCE(sum(kg) FILTER (WHERE dias > 60), 0) kg_60,
        (array_agg(glosa ORDER BY glosa IS NULL))[1] glosa, max(unidad) unidad,
        (array_agg(cliente ORDER BY cliente IS NULL))[1] cliente, count(DISTINCT ot) ots
      FROM ks WHERE key IS NOT NULL GROUP BY key),
    j AS (
      SELECT COALESCE(sal.key, stk.key) key, sal.n, sal.kg, sal.kg_desp, sal.prom, sal.prom_kg, sal.p50, sal.p90, sal.mx, sal.prom_o,
        stk.kg skg, stk.qty sqty, stk.claves, stk.dias_pond, stk.dias_max, stk.kg_60,
        COALESCE(stk.glosa, sal.glosa) glosa, COALESCE(stk.unidad, sal.unidad) unidad, COALESCE(sal.cliente, stk.cliente) cliente,
        GREATEST(COALESCE(sal.ots, 0), COALESCE(stk.ots, 0)) ots
      FROM sal FULL JOIN stk ON stk.key = sal.key)
    SELECT jsonb_build_object('success', true, 'dim', v_dim, 'ambito', CASE WHEN v_apt THEN 'apt' ELSE 'todas' END, 'ot', v_ot,
      'desde', v_from, 'hasta', v_to, 'corte', s.data_max, 'total', (SELECT count(*) FROM j),
      'filas', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', key, 'glosa', CASE WHEN v_dim = 'producto' THEN glosa END,
          'unidad', CASE WHEN v_dim = 'producto' THEN unidad END, 'cliente', CASE WHEN v_dim = 'ot' THEN cliente END, 'ots', ots,
          'salidas', COALESCE(n, 0), 'kg_salidas', round(COALESCE(kg, 0), 1), 'kg_despachado', round(COALESCE(kg_desp, 0), 1),
          'prom_dias', prom, 'prom_dias_kg', prom_kg, 'p50', p50, 'p90', p90, 'max', mx, 'prom_origen', prom_o,
          'stock_kg', round(COALESCE(skg, 0), 1), 'stock_qty', round(COALESCE(sqty, 0), 3), 'claves', COALESCE(claves, 0),
          'stock_dias', dias_pond, 'stock_dias_max', dias_max, 'stock_kg_60', round(COALESCE(kg_60, 0), 1))
          ORDER BY COALESCE(skg, 0) DESC, COALESCE(kg, 0) DESC, key)
        FROM (SELECT * FROM j ORDER BY COALESCE(skg, 0) DESC, COALESCE(kg, 0) DESC, key LIMIT 5000) z), '[]'::jsonb)));
END $function$;
REVOKE ALL ON FUNCTION public.inv_dwell_dim_live(p jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_dwell_dim_live(p jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.inv_dwell_live(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s public.inv_state; v_from date; v_to date;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  SELECT * INTO s FROM public.inv_state WHERE id = 1;
  v_to := COALESCE((p->>'hasta')::date, s.data_max); v_from := COALESCE((p->>'desde')::date, s.data_min);
  RETURN (
    WITH c AS (
      SELECT a.*, m.fecha, m.clase AS destino, l.bodega, COALESCE(w.kind, 'OTRO') kind, COALESCE(w.stage, 70) stage, l.source,
        CASE WHEN l.root_known >= 0.5 THEN m.fecha - l.root_fecha END AS dias_origen
      FROM public.inv_allocations a JOIN public.inv_movements_v m ON m.id = a.out_id JOIN public.inv_layers l ON l.id = a.layer_id
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
END $function$;
REVOKE ALL ON FUNCTION public.inv_dwell_live(p jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_dwell_live(p jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.inv_flow(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  IF COALESCE(p->>'desde', '') = '' AND COALESCE(p->>'hasta', '') = '' THEN
    v := public.inv_read_cached('flow');
    IF v IS NULL AND NOT public.inv_live_allowed() THEN RETURN public.inv_preparing(); END IF;
  END IF;
  IF v IS NULL THEN v := public.inv_flow_live(p); END IF;
  IF v ? 'reasignaciones' THEN v := jsonb_set(v, '{reasignaciones}', public.inv_con_glosa(v->'reasignaciones')); END IF;
  RETURN v;
END $function$;
REVOKE ALL ON FUNCTION public.inv_flow(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_flow(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_flow_live(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s public.inv_state; v_from date; v_to date;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  SELECT * INTO s FROM public.inv_state WHERE id = 1;
  v_to := COALESCE((p->>'hasta')::date, s.data_max); v_from := COALESCE((p->>'desde')::date, s.data_min);
  RETURN (
    WITH lk AS (
      SELECT o.bodega AS origen, i.bodega AS destino, o.numero, o.fecha, tl.qty, o.lote AS lote_origen, i.lote AS lote_destino,
        tl.qty * COALESCE(i.peso_unit, o.peso_unit, 0) AS kg, o.producto
      FROM public.inv_transfer_links tl JOIN public.inv_movements_v o ON o.id = tl.out_id JOIN public.inv_movements_v i ON i.id = tl.in_id
      WHERE o.fecha BETWEEN v_from AND v_to
    ), estadia_origen AS (
      SELECT ms.bodega AS origen, mi.bodega AS destino, round(sum(a.qty * a.dias_bodega) FILTER (WHERE a.dias_bodega IS NOT NULL)
        / NULLIF(sum(a.qty) FILTER (WHERE a.dias_bodega IS NOT NULL), 0), 1) AS dias
      FROM public.inv_transfer_links tl JOIN public.inv_movements_v ms ON ms.id = tl.out_id JOIN public.inv_movements_v mi ON mi.id = tl.in_id
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
        FROM (SELECT clase, bodega, count(*) n, COALESCE(sum(peso_kg), 0) kg FROM public.inv_movements_v
              WHERE active AND side = 'E' AND clase <> 'TRASPASO' AND fecha BETWEEN v_from AND v_to GROUP BY clase, bodega) i), '[]'::jsonb),
      'salidas', COALESCE((SELECT jsonb_agg(jsonb_build_object('clase', clase, 'bodega', bodega, 'lineas', n, 'kg', round(kg, 1)) ORDER BY kg DESC)
        FROM (SELECT clase, bodega, count(*) n, COALESCE(sum(peso_kg), 0) kg FROM public.inv_movements_v
              WHERE active AND side = 'S' AND clase <> 'TRASPASO' AND fecha BETWEEN v_from AND v_to GROUP BY clase, bodega) o), '[]'::jsonb),
      'reasignaciones', COALESCE((SELECT jsonb_agg(jsonb_build_object('origen', origen, 'destino', destino, 'numero', numero, 'fecha', fecha,
          'producto', producto, 'lote_origen', lote_origen, 'lote_destino', lote_destino, 'qty', round(qty, 3), 'kg', round(kg, 1)) ORDER BY fecha DESC, numero)
        FROM (SELECT * FROM lk WHERE lote_origen IS DISTINCT FROM lote_destino ORDER BY fecha DESC LIMIT 300) r), '[]'::jsonb)));
END $function$;
REVOKE ALL ON FUNCTION public.inv_flow_live(p jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_flow_live(p jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.inv_glosas(p_productos text[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(jsonb_object_agg(p.producto, g.glosa) FILTER (WHERE g.glosa IS NOT NULL), '{}'::jsonb)
  FROM (SELECT DISTINCT unnest(p_productos) AS producto) p
  CROSS JOIN LATERAL (SELECT m.glosa FROM public.inv_movements m
    WHERE m.active AND m.producto = p.producto AND m.glosa IS NOT NULL ORDER BY m.id DESC LIMIT 1) g;
$function$;
REVOKE ALL ON FUNCTION public.inv_glosas(p_productos text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_glosas(p_productos text[]) TO service_role;

CREATE OR REPLACE FUNCTION public.inv_guess_class(p_tipo text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;
REVOKE ALL ON FUNCTION public.inv_guess_class(p_tipo text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_guess_class(p_tipo text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_guess_kind(p_code text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;
REVOKE ALL ON FUNCTION public.inv_guess_kind(p_code text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_guess_kind(p_code text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_kg(p_peso numeric, p_qty numeric, p_unit numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(NULLIF(p_peso, 0), abs(p_qty) * NULLIF(p_unit, 0), 0);
$function$;
REVOKE ALL ON FUNCTION public.inv_kg(p_peso numeric, p_qty numeric, p_unit numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_kg(p_peso numeric, p_qty numeric, p_unit numeric) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_kind_stage(p_kind text)
 RETURNS smallint
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT (CASE p_kind WHEN 'MATERIA_PRIMA' THEN 10 WHEN 'TERCERO' THEN 12 WHEN 'PERNERIA' THEN 15 WHEN 'MRO' THEN 15
    WHEN 'PRODUCCION' THEN 20 WHEN 'PRODUCTO_TERMINADO' THEN 30 WHEN 'DESPACHO' THEN 40 WHEN 'OBRA' THEN 50
    WHEN 'MANTENIMIENTO' THEN 60 WHEN 'HERRAMIENTAS' THEN 60 WHEN 'ACTIVOS' THEN 60 ELSE 70 END)::smallint;
$function$;
REVOKE ALL ON FUNCTION public.inv_kind_stage(p_kind text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_kind_stage(p_kind text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_live_allowed()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(current_setting('inv.live', true), '') = 'on';
$function$;
REVOKE ALL ON FUNCTION public.inv_live_allowed() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_live_allowed() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_lote(v text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s text;
BEGIN
  s := upper(btrim(regexp_replace(COALESCE(v, ''), '\s+', '', 'g')));
  IF s ~ '^[0-9]+\.0+$' THEN s := split_part(s, '.', 1); END IF;
  IF s ~ '^0+[0-9]+(-|$)' THEN s := regexp_replace(s, '^0+([0-9])', '\1'); END IF;
  RETURN CASE WHEN s IN ('', '0', '1', '-', '.', 'NULL', 'N/A', 'NA') THEN NULL ELSE s END;
END $function$;
REVOKE ALL ON FUNCTION public.inv_lote(v text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_lote(v text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_ot(p_lote text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT substring(p_lote FROM '^([0-9]{5,6})(?:-[A-Z][0-9]{3})?$');
$function$;
REVOKE ALL ON FUNCTION public.inv_ot(p_lote text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_ot(p_lote text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_ot_cliente(p_raiz text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    (SELECT m.razon_social FROM public.inv_movements_v m
     WHERE m.active AND m.clase = 'DESPACHO' AND m.razon_social IS NOT NULL AND upper(btrim(m.lote)) LIKE p_raiz || '%' AND public.apt_ot_raiz(m.lote) = p_raiz
     GROUP BY m.razon_social ORDER BY sum(public.inv_kg(m.peso_kg, m.cantidad, m.peso_unit)) DESC, count(*) DESC LIMIT 1),
    (SELECT cl.business_name FROM public.contracts c JOIN public.clients cl ON cl.id = c.client_id
     WHERE upper(c.code) = p_raiz OR public.apt_ot_raiz(c.code) = p_raiz ORDER BY (upper(c.code) = p_raiz) DESC LIMIT 1),
    (SELECT max(btrim(l.cliente)) FROM public.erp_contract_lines l
     WHERE l.import_id = public.erp_active_import('CONTRATOS') AND l.ot = p_raiz AND NULLIF(btrim(l.cliente), '') IS NOT NULL));
$function$;
REVOKE ALL ON FUNCTION public.inv_ot_cliente(p_raiz text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_ot_cliente(p_raiz text) TO service_role;

CREATE OR REPLACE FUNCTION public.inv_ot_clientes()
 RETURNS TABLE(ot text, cliente text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT x->>'ot', x->>'cliente' FROM jsonb_array_elements(COALESCE(
    (SELECT r.payload->'contratos' FROM public.inv_read_cache r WHERE r.k = 'contratos'), '[]'::jsonb)) x
  WHERE x->>'cliente' IS NOT NULL;
$function$;
REVOKE ALL ON FUNCTION public.inv_ot_clientes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_ot_clientes() TO service_role;

CREATE OR REPLACE FUNCTION public.inv_overview(p_desde date DEFAULT NULL::date, p_hasta date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  IF p_desde IS NULL AND p_hasta IS NULL THEN
    v := public.inv_read_cached('overview');
    IF v IS NOT NULL THEN
      RETURN jsonb_set(v, '{state,dirty}', to_jsonb((SELECT dirty FROM public.inv_state WHERE id = 1)), true);
    END IF;
  END IF;
  IF p_desde IS NULL AND p_hasta IS NULL AND NOT public.inv_live_allowed() THEN RETURN public.inv_preparing(); END IF;
  RETURN public.inv_overview_live(p_desde, p_hasta);
END $function$;
REVOKE ALL ON FUNCTION public.inv_overview(p_desde date, p_hasta date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_overview(p_desde date, p_hasta date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_overview_live(p_desde date DEFAULT NULL::date, p_hasta date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
            FROM public.inv_movements_v WHERE active AND fecha BETWEEN v_from AND v_to GROUP BY clase, side) m), '[]'::jsonb),
    'serie', COALESCE((SELECT jsonb_agg(jsonb_build_object('fecha', fecha, 'produccion', round(prod, 1), 'compras', round(comp, 1),
        'despachos', round(desp, 1), 'consumos', round(cons, 1), 'traspasos', round(tras, 1)) ORDER BY fecha)
      FROM (SELECT fecha,
              COALESCE(sum(peso_kg) FILTER (WHERE side = 'E' AND clase = 'PRODUCCION'), 0) prod,
              COALESCE(sum(peso_kg) FILTER (WHERE side = 'E' AND clase IN ('COMPRA', 'SERVICIO_TERCERO')), 0) comp,
              COALESCE(sum(peso_kg) FILTER (WHERE side = 'S' AND clase = 'DESPACHO'), 0) desp,
              COALESCE(sum(peso_kg) FILTER (WHERE side = 'S' AND clase = 'CONSUMO'), 0) cons,
              COALESCE(sum(peso_kg) FILTER (WHERE side = 'S' AND clase = 'TRASPASO'), 0) tras
            FROM public.inv_movements_v WHERE active AND fecha BETWEEN v_from AND v_to GROUP BY fecha) d), '[]'::jsonb),
    'calidad', jsonb_build_object(
      'sin_peso', (SELECT count(*) FROM public.inv_movements_v WHERE active AND fecha BETWEEN v_from AND v_to AND peso_kg IS NULL),
      'lineas', (SELECT count(*) FROM public.inv_movements_v WHERE active AND fecha BETWEEN v_from AND v_to),
      'error_contrato', (SELECT count(*) FROM public.inv_movements_v WHERE active AND fecha BETWEEN v_from AND v_to AND doc_rel = 'ERROR DE CONTRATO'),
      'lote_minusculas', (SELECT count(*) FROM public.inv_movements_v WHERE active AND fecha BETWEEN v_from AND v_to AND lote_raw IS NOT NULL AND lote_raw <> upper(lote_raw)),
      'traspasos_sin_destino', s.stats->'traspasos_sin_destino', 'traspasos_sin_origen', s.stats->'traspasos_sin_origen',
      'claves_inferidas', (SELECT count(*) FROM public.inv_layers WHERE source = 'INFERIDA'),
      'qty_inferida_consumida', (SELECT round(COALESCE(sum(consumed), 0), 1) FROM public.inv_layers WHERE source = 'INFERIDA')),
    'herramientas', public.inv_tool_loans_summary(),
    'terceros', public.inv_third_party_summary());
END $function$;
REVOKE ALL ON FUNCTION public.inv_overview_live(p_desde date, p_hasta date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_overview_live(p_desde date, p_hasta date) TO service_role;

CREATE OR REPLACE FUNCTION public.inv_preparing()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object('success', false, 'preparando', true,
    'error', 'Las cifras del inventario se están preparando en el servidor. Vuelva a intentar en unos minutos.');
$function$;
REVOKE ALL ON FUNCTION public.inv_preparing() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_preparing() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_read_cached(p_k text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT c.payload || jsonb_build_object('cache', jsonb_build_object('built_at', c.built_at,
    'al_dia', NOT s.dirty AND c.stamp IS NOT DISTINCT FROM s.rebuilt_at))
  FROM public.inv_read_cache c CROSS JOIN public.inv_state s WHERE c.k = p_k AND s.id = 1;
$function$;
REVOKE ALL ON FUNCTION public.inv_read_cached(p_k text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_read_cached(p_k text) TO service_role;

CREATE OR REPLACE FUNCTION public.inv_rebuild()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET jit TO 'off'
AS $function$
DECLARE v_snap uuid; v_cut date; v_from date; v_iter integer := 0; v_changed integer; v_t0 timestamptz := clock_timestamp();
  v_stats jsonb; v_tmp text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('inv_rebuild'));
  -- Tablas de trabajo (pueden quedar de un recálculo anterior en la misma transacción)
  FOREACH v_tmp IN ARRAY ARRAY['inv_tr', 'inv_ev', 'inv_pu', 'inv_open', 'inv_otot', 'inv_out', 'inv_comp', 'inv_root', 'inv_chg'] LOOP
    IF to_regclass('pg_temp.' || v_tmp) IS NOT NULL THEN EXECUTE format('DROP TABLE pg_temp.%I', v_tmp); END IF;
  END LOOP;

  -- Clase vigente del catálogo (se puede reclasificar un tipo de documento)
  UPDATE public.inv_movements_v m SET clase = d.clase FROM public.inv_doc_types d
  WHERE d.tipodocto = m.tipodocto AND m.clase IS DISTINCT FROM d.clase;

  ANALYZE public.inv_movements;
  -- Foto de stock vigente: la última aplicada. El modelo arranca el día siguiente al corte.
  SELECT id, cutoff INTO v_snap, v_cut FROM public.inv_uploads
  WHERE side = 'STOCK' AND status = 'APLICADA' ORDER BY cutoff DESC, applied_at DESC LIMIT 1;
  v_from := v_cut + 1;

  TRUNCATE public.inv_allocations, public.inv_transfer_links, public.inv_layers;

  -- 4.1 Traspasos: primero líneas con la misma cantidad (respeta la reasignación de lote línea a línea), luego el resto
  --     en orden de línea, repartiendo cantidades.
  CREATE TEMP TABLE inv_tr ON COMMIT DROP AS
  SELECT m.id, m.tipodocto, m.numero, m.producto, m.linea, abs(m.cantidad) AS q, m.cantidad < 0 AS is_out
  FROM public.inv_movements_v m
  WHERE m.active AND m.clase = 'TRASPASO' AND (v_from IS NULL OR m.fecha >= v_from);

  ANALYZE inv_tr;
  INSERT INTO public.inv_transfer_links (out_id, in_id, qty)
  SELECT s.id, e.id, s.q
  FROM (SELECT *, row_number() OVER (PARTITION BY tipodocto, numero, producto, q ORDER BY linea, id) AS rk FROM inv_tr WHERE is_out) s
  JOIN (SELECT *, row_number() OVER (PARTITION BY tipodocto, numero, producto, q ORDER BY linea, id) AS rk FROM inv_tr WHERE NOT is_out) e
    USING (tipodocto, numero, producto, q, rk);

  ANALYZE public.inv_transfer_links;
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
  FROM public.inv_movements_v m
  WHERE m.active AND (v_from IS NULL OR m.fecha >= v_from);
  CREATE INDEX ON inv_ev (bodega, producto, lk);
  ANALYZE inv_ev;

  -- Peso unitario de referencia por producto (para capas sin peso propio)
  CREATE TEMP TABLE inv_pu ON COMMIT DROP AS
  SELECT producto, round(sum(peso_kg) / NULLIF(sum(abs(cantidad)), 0), 6) AS pu
  FROM public.inv_movements_v WHERE active AND peso_kg > 0 GROUP BY producto;
  CREATE UNIQUE INDEX ON inv_pu (producto);
  ANALYZE inv_pu;

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
  ANALYZE inv_open;

  -- Salida total por clave: el FIFO consume [0, total) de la clave, así que lo consumido de cada capa es su solape con
  -- ese tramo (igual a la suma de sus consumos detallados) y se guarda al crear la capa, sin una actualización posterior.
  CREATE TEMP TABLE inv_otot ON COMMIT DROP AS
  SELECT bodega, producto, lk, sum(q) AS tot FROM inv_ev WHERE NOT is_in GROUP BY 1, 2, 3;
  CREATE UNIQUE INDEX ON inv_otot (bodega, producto, lk);
  ANALYZE inv_otot;

  -- 4.3 Capas: [foto][inferida][ingresos en orden]
  INSERT INTO public.inv_layers (bodega, producto, lk, lseq, source, fecha, qty, q_start, q_end, peso_unit, root_known, consumed)
  SELECT o.bodega, o.producto, o.lk, 1, 'FOTO', NULL, o.foto, 0, o.foto, COALESCE(o.foto_pu, pu.pu), 0,
    greatest(least(o.foto, COALESCE(t.tot, 0)), 0)
  FROM inv_open o LEFT JOIN inv_pu pu ON pu.producto = o.producto
  LEFT JOIN inv_otot t ON t.bodega = o.bodega AND t.producto = o.producto AND t.lk = o.lk WHERE o.foto > 0;
  INSERT INTO public.inv_layers (bodega, producto, lk, lseq, source, fecha, qty, q_start, q_end, peso_unit, root_known, consumed)
  SELECT o.bodega, o.producto, o.lk, 2, 'INFERIDA', NULL, o.inferida, o.foto, o.foto + o.inferida, pu.pu, 0,
    greatest(least(o.foto + o.inferida, COALESCE(t.tot, 0)) - o.foto, 0)
  FROM inv_open o LEFT JOIN inv_pu pu ON pu.producto = o.producto
  LEFT JOIN inv_otot t ON t.bodega = o.bodega AND t.producto = o.producto AND t.lk = o.lk WHERE o.inferida > 0;
  INSERT INTO public.inv_layers (bodega, producto, lk, lseq, source, mov_id, clase, fecha, qty, q_start, q_end, peso_unit,
    root_fecha, root_known, root_clase, root_bodega, consumed)
  SELECT e.bodega, e.producto, e.lk, 2 + e.rn, 'MOV', e.id, e.clase, e.fecha, e.q,
    COALESCE(o.foto + o.inferida, 0) + e.cin - e.q, COALESCE(o.foto + o.inferida, 0) + e.cin,
    COALESCE(e.peso_unit, pu.pu),
    CASE WHEN e.clase <> 'TRASPASO' THEN e.fecha END, CASE WHEN e.clase <> 'TRASPASO' THEN 1 ELSE 0 END,
    CASE WHEN e.clase <> 'TRASPASO' THEN e.clase END, CASE WHEN e.clase <> 'TRASPASO' THEN e.bodega END,
    greatest(least(COALESCE(o.foto + o.inferida, 0) + e.cin, COALESCE(t.tot, 0)) - (COALESCE(o.foto + o.inferida, 0) + e.cin - e.q), 0)
  FROM (SELECT ev.*, row_number() OVER w AS rn, sum(q) OVER w AS cin FROM inv_ev ev WHERE is_in
        WINDOW w AS (PARTITION BY bodega, producto, lk ORDER BY fecha, id ROWS UNBOUNDED PRECEDING)) e
  LEFT JOIN inv_open o ON o.bodega = e.bodega AND o.producto = e.producto AND o.lk = e.lk
  LEFT JOIN inv_otot t ON t.bodega = e.bodega AND t.producto = e.producto AND t.lk = e.lk
  LEFT JOIN inv_pu pu ON pu.producto = e.producto;

  ANALYZE public.inv_layers;

  -- 4.4 Consumos FIFO: cada salida ocupa [oe - q, oe) en la clave; se cruza con las capas que se solapan.
  CREATE TEMP TABLE inv_out ON COMMIT DROP AS
  SELECT ev.id, ev.bodega, ev.producto, ev.lk, ev.fecha, ev.q,
    sum(ev.q) OVER (PARTITION BY ev.bodega, ev.producto, ev.lk ORDER BY ev.fecha, ev.id ROWS UNBOUNDED PRECEDING) AS oe
  FROM inv_ev ev WHERE NOT ev.is_in;

  ANALYZE inv_out;
  INSERT INTO public.inv_allocations (layer_id, out_id, qty, kg, dias_bodega)
  SELECT l.id, o.id, x.q, CASE WHEN l.peso_unit IS NOT NULL THEN round(x.q * l.peso_unit, 6) END, o.fecha - l.fecha
  FROM inv_out o
  CROSS JOIN LATERAL (SELECT f.lseq FROM public.inv_layers f
                      WHERE f.bodega = o.bodega AND f.producto = o.producto AND f.lk = o.lk AND f.q_end > o.oe - o.q + 0.0000001
                      ORDER BY f.q_end LIMIT 1) a
  CROSS JOIN LATERAL (SELECT f.lseq FROM public.inv_layers f
                      WHERE f.bodega = o.bodega AND f.producto = o.producto AND f.lk = o.lk AND f.q_start < o.oe - 0.0000001
                      ORDER BY f.q_start DESC LIMIT 1) b
  -- Keep the bounded layer lookup dependent on both FIFO endpoints. OFFSET 0 prevents
  -- flattening this lookup into a warehouse/product/lot Cartesian join before filtering.
  CROSS JOIN LATERAL (
    SELECT f.id, f.q_start, f.q_end, f.peso_unit, f.fecha
    FROM public.inv_layers f
    WHERE f.bodega = o.bodega AND f.producto = o.producto AND f.lk = o.lk
      AND f.lseq BETWEEN a.lseq AND b.lseq
    ORDER BY f.lseq
    OFFSET 0
  ) l
  CROSS JOIN LATERAL (SELECT least(l.q_end, o.oe) - greatest(l.q_start, o.oe - o.q) AS q) x
  WHERE x.q > 0.0000001;

  ANALYZE public.inv_allocations;

  -- 4.5 Origen raíz de las capas que llegaron por traspaso: lo que consumió su salida emparejada en la bodega de
  --     origen. Se repite para los traspasos encadenados (p. ej. Depósito → Unimar → Flesa).
  ANALYZE public.inv_transfer_links;
  CREATE TEMP TABLE inv_comp ON COMMIT DROP AS
  SELECT tl.in_id, a.layer_id AS src_id, a.qty * tl.qty / NULLIF(s.q, 0) AS part
  FROM public.inv_transfer_links tl
  JOIN (SELECT out_id, sum(qty) AS q FROM public.inv_allocations GROUP BY out_id) s ON s.out_id = tl.out_id
  JOIN public.inv_allocations a ON a.out_id = tl.out_id;
  CREATE INDEX ON inv_comp (src_id);
  ANALYZE inv_comp;
  CREATE TEMP TABLE inv_root (in_id bigint PRIMARY KEY, known numeric, rf date, rc text, rb text) ON COMMIT DROP;
  -- Capas que cambiaron en la vuelta anterior: solo se recalculan los traspasos que dependen de ellas
  CREATE TEMP TABLE inv_chg (id bigint PRIMARY KEY) ON COMMIT DROP;
  LOOP
    v_iter := v_iter + 1;
    TRUNCATE inv_root;
    INSERT INTO inv_root (in_id, known, rf, rc, rb)
    SELECT c.in_id,
      round(COALESCE(sum(c.part * src.root_known) / NULLIF(sum(c.part), 0), 0), 6),
      (DATE '2000-01-01' + round(sum(c.part * src.root_known * (src.root_fecha - DATE '2000-01-01')) / NULLIF(sum(c.part * src.root_known), 0))::integer),
      COALESCE((array_agg(src.root_clase ORDER BY c.part * src.root_known DESC NULLS LAST, c.part DESC, src.id))[1], 'TRASPASO'),
      (array_agg(COALESCE(src.root_bodega, src.bodega) ORDER BY c.part * src.root_known DESC NULLS LAST, c.part DESC, src.id))[1]
    FROM inv_comp c JOIN public.inv_layers src ON src.id = c.src_id
    WHERE v_iter = 1 OR c.in_id IN (SELECT d.in_id FROM inv_comp d JOIN inv_chg ch ON ch.id = d.src_id)
    GROUP BY c.in_id;
    ANALYZE inv_root;
    TRUNCATE inv_chg;
    WITH u AS (
      UPDATE public.inv_layers l SET root_known = g.known, root_fecha = g.rf, root_clase = g.rc, root_bodega = g.rb
      FROM inv_root g
      WHERE l.mov_id = g.in_id AND l.source = 'MOV' AND l.clase = 'TRASPASO'
        AND (l.root_known IS DISTINCT FROM g.known OR l.root_fecha IS DISTINCT FROM g.rf
             OR l.root_clase IS DISTINCT FROM g.rc OR l.root_bodega IS DISTINCT FROM g.rb)
      RETURNING l.id)
    INSERT INTO inv_chg SELECT id FROM u;
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    ANALYZE inv_chg;
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
    data_min = (SELECT min(fecha) FROM public.inv_movements_v WHERE active),
    data_max = (SELECT max(fecha) FROM public.inv_movements_v WHERE active),
    model_from = v_from, snapshot_upload = v_snap, snapshot_cutoff = v_cut, stats = v_stats
  WHERE id = 1;
  RETURN jsonb_build_object('success', true) || v_stats;
END $function$;
REVOKE ALL ON FUNCTION public.inv_rebuild() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_rebuild() TO service_role;

CREATE OR REPLACE FUNCTION public.inv_rebuild_if_dirty()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_rebuilt boolean := false; v_vacio boolean;
BEGIN
  v_vacio := NOT EXISTS (SELECT 1 FROM public.inv_layers) AND EXISTS (SELECT 1 FROM public.inv_movements WHERE active);
  IF v_vacio OR EXISTS (SELECT 1 FROM public.inv_state WHERE id = 1 AND dirty) THEN
    -- Una carga en preparación aplicará más partes y pedirá su propio recálculo: no bloquearla
    IF EXISTS (SELECT 1 FROM public.inv_uploads WHERE status = 'CARGANDO' AND created_at > now() - interval '45 minutes') THEN
      RETURN jsonb_build_object('success', true, 'skipped', 'carga en curso');
    END IF;
    IF NOT pg_try_advisory_xact_lock(hashtext('inv_rebuild')) THEN
      RETURN jsonb_build_object('success', true, 'skipped', 'recálculo en curso');
    END IF;
    PERFORM public.inv_rebuild();
    v_rebuilt := true;
  ELSIF EXISTS (SELECT 1 FROM public.inv_read_cache c, public.inv_state s
                WHERE c.k = 'stock' AND s.id = 1 AND c.stamp IS NOT DISTINCT FROM s.rebuilt_at)
        OR NOT EXISTS (SELECT 1 FROM public.inv_state WHERE id = 1 AND rebuilt_at IS NOT NULL) THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'sin cambios');
  END IF;
  RETURN jsonb_build_object('success', true, 'rebuilt', v_rebuilt, 'cache', public.inv_cache_refresh());
END $function$;
REVOKE ALL ON FUNCTION public.inv_rebuild_if_dirty() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_rebuild_if_dirty() TO service_role;

CREATE OR REPLACE FUNCTION public.inv_rebuild_request()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('inv_rebuild')) THEN
    RETURN jsonb_build_object('success', true, 'pending', true, 'en_curso', true);
  END IF;
  RETURN public.inv_rebuild();
END $function$;
REVOKE ALL ON FUNCTION public.inv_rebuild_request() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_rebuild_request() TO service_role;

CREATE OR REPLACE FUNCTION public.inv_recalcular()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para recalcular el inventario');
  END IF;
  RETURN public.inv_rebuild();
END $function$;
REVOKE ALL ON FUNCTION public.inv_recalcular() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_recalcular() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_snapshot_discard()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_id uuid; v_cut date;
BEGIN
  IF NOT public.apt_can_load() THEN RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar movimientos de inventario'); END IF;
  -- La misma foto que usa el recálculo: la última aplicada
  SELECT id, cutoff INTO v_id, v_cut FROM public.inv_uploads
  WHERE side = 'STOCK' AND status = 'APLICADA' ORDER BY cutoff DESC, applied_at DESC LIMIT 1 FOR UPDATE;
  IF v_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'No hay una foto de stock vigente'); END IF;
  UPDATE public.inv_uploads SET status = 'DESCARTADA' WHERE id = v_id;
  DELETE FROM public.inv_stock_snapshots WHERE upload_id = v_id;
  UPDATE public.inv_state SET dirty = true WHERE id = 1;
  RETURN jsonb_build_object('success', true, 'upload_id', v_id, 'cutoff', v_cut);
END $function$;
REVOKE ALL ON FUNCTION public.inv_snapshot_discard() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_snapshot_discard() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.inv_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_status() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_stock(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s public.inv_state; v_q text := NULLIF(btrim(p->>'q'), ''); v_lim integer := least(greatest(COALESCE((p->>'limit')::integer, 100), 1), 2000);
  v_off integer := greatest(COALESCE((p->>'offset')::integer, 0), 0);
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  IF public.inv_read_cached('stock') IS NULL THEN
    IF NOT public.inv_live_allowed() THEN RETURN public.inv_preparing(); END IF;
    RETURN public.inv_stock_live(p);
  END IF;
  SELECT * INTO s FROM public.inv_state WHERE id = 1;
  RETURN (
    WITH info AS (
      SELECT c.*, s.data_max - c.fecha_min AS dias_bodega, s.data_max - c.root_min AS dias_origen FROM public.inv_stock_cache c
    ), f AS (
      SELECT * FROM info
      WHERE (NOT (p ? 'bodegas') OR jsonb_array_length(p->'bodegas') = 0 OR bodega IN (SELECT jsonb_array_elements_text(p->'bodegas')))
        AND (NOT (p ? 'kinds') OR jsonb_array_length(p->'kinds') = 0 OR kind IN (SELECT jsonb_array_elements_text(p->'kinds')))
        AND (COALESCE(p->>'ambito', '') <> 'apt' OR public.apt_almacen(bodega) IS NOT NULL)
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
END $function$;
REVOKE ALL ON FUNCTION public.inv_stock(p jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_stock(p jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_stock_live(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
        SELECT m.glosa, m.unidad, (SELECT m2.razon_social FROM public.inv_movements_v m2
            WHERE m2.active AND r.lote IS NOT NULL AND m2.lote = r.lote AND m2.razon_social IS NOT NULL ORDER BY m2.fecha DESC LIMIT 1) AS cliente
        FROM public.inv_movements_v m WHERE m.active AND m.producto = r.producto ORDER BY m.fecha DESC LIMIT 1) g ON true
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
END $function$;
REVOKE ALL ON FUNCTION public.inv_stock_live(p jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_stock_live(p jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.inv_stock_rows()
 RETURNS TABLE(bodega text, kind text, stage smallint, producto text, lk text, qty numeric, kg numeric, kg_conocido boolean, fecha_min date, root_min date, inferido numeric, foto numeric, capas integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT l.bodega, COALESCE(w.kind, 'OTRO'), COALESCE(w.stage, 70::smallint), l.producto, l.lk,
    sum(l.qty - l.consumed), sum((l.qty - l.consumed) * COALESCE(l.peso_unit, 0)), bool_and(l.peso_unit IS NOT NULL),
    min(l.fecha), min(l.root_fecha) FILTER (WHERE l.root_known >= 0.5),
    sum(l.qty - l.consumed) FILTER (WHERE l.source = 'INFERIDA'), sum(l.qty - l.consumed) FILTER (WHERE l.source = 'FOTO'),
    count(*)::integer
  FROM public.inv_layers l LEFT JOIN public.inv_warehouses w ON w.code = l.bodega
  WHERE l.qty - l.consumed > 0.0000001
  GROUP BY l.bodega, w.kind, w.stage, l.producto, l.lk;
$function$;
REVOKE ALL ON FUNCTION public.inv_stock_rows() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_stock_rows() TO service_role;

CREATE OR REPLACE FUNCTION public.inv_third_party_summary()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;
REVOKE ALL ON FUNCTION public.inv_third_party_summary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_third_party_summary() TO service_role;

CREATE OR REPLACE FUNCTION public.inv_tool_loans_summary()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;
REVOKE ALL ON FUNCTION public.inv_tool_loans_summary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_tool_loans_summary() TO service_role;

CREATE OR REPLACE FUNCTION public.inv_trace(p_q text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.inv_trace(p_q text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_trace(p_q text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_upload_apply(p_upload_id uuid, p_force boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r jsonb;
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar movimientos de inventario');
  END IF;
  r := public.inv_upload_apply_core(p_upload_id, p_force);
  IF NOT COALESCE((r->>'success')::boolean, false) THEN RETURN r; END IF;
  RETURN r || jsonb_build_object('model', public.inv_rebuild());
END $function$;
REVOKE ALL ON FUNCTION public.inv_upload_apply(p_upload_id uuid, p_force boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_upload_apply(p_upload_id uuid, p_force boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_upload_apply_core(p_upload_id uuid, p_force boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE u public.inv_uploads; v_from date; v_to date; v_valid integer; v_removed integer := 0; v_lt text := current_setting('lock_timeout');
BEGIN
  -- Si hay un recálculo en curso se espera hasta 20 s; después se responde «ocupado» (el navegador reintenta solo)
  -- en vez de agotar el tiempo de la petición web esperando el bloqueo.
  IF NOT pg_try_advisory_xact_lock(hashtext('inv_rebuild')) THEN
    PERFORM set_config('lock_timeout', '20s', true);
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('inv_rebuild'));
    EXCEPTION WHEN lock_not_available THEN
      PERFORM set_config('lock_timeout', v_lt, true);
      RETURN jsonb_build_object('success', false, 'busy', true,
        'error', 'Se está recalculando el inventario; la carga se aplica en cuanto termine.');
    END;
    PERFORM set_config('lock_timeout', v_lt, true);
  END IF;
  SELECT * INTO u FROM public.inv_uploads WHERE id = p_upload_id FOR UPDATE;
  IF u.status = 'APLICADA' THEN
    RETURN jsonb_build_object('success', true, 'replayed', true, 'side', u.side, 'desde', u.desde, 'hasta', u.hasta,
      'rows', u.rows_valid, 'replaced', u.replaced);
  END IF;
  IF u.status = 'DESCARTADA' THEN RETURN jsonb_build_object('success', false, 'error', 'La carga fue descartada'); END IF;
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
END $function$;
REVOKE ALL ON FUNCTION public.inv_upload_apply_core(p_upload_id uuid, p_force boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_upload_apply_core(p_upload_id uuid, p_force boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.inv_upload_begin(p_side text, p_file_name text, p_cutoff date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.inv_upload_begin(p_side text, p_file_name text, p_cutoff date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_upload_begin(p_side text, p_file_name text, p_cutoff date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_upload_discard(p_upload_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar movimientos de inventario');
  END IF;
  DELETE FROM public.inv_uploads WHERE id = p_upload_id AND status = 'CARGANDO';
  RETURN jsonb_build_object('success', true);
END $function$;
REVOKE ALL ON FUNCTION public.inv_upload_discard(p_upload_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_upload_discard(p_upload_id uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_upload_rows(p_upload_id uuid, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET jit TO 'off'
AS $function$
DECLARE v_side text; v_ok integer := 0; v_total integer; v_excl jsonb; v_hash text; v_result jsonb;
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar movimientos de inventario');
  END IF;
  SELECT side INTO v_side FROM public.inv_uploads WHERE id = p_upload_id AND status = 'CARGANDO' FOR UPDATE;
  IF v_side IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'La carga no existe o ya fue cerrada'); END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Envíe un arreglo de filas');
  END IF;
  IF jsonb_array_length(p_rows) > 5000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Envíe como máximo 5000 filas por bloque');
  END IF;
  -- A network retry of a committed chunk must not duplicate rows or counters.
  -- Serialized by the upload row lock; the digest includes original ERP line numbers.
  v_hash := md5(p_rows::text);
  SELECT result INTO v_result FROM public.inv_upload_chunks WHERE upload_id = p_upload_id AND chunk_hash = v_hash;
  IF FOUND THEN RETURN v_result || jsonb_build_object('replayed', true); END IF;
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
    INSERT INTO public.inv_movements (upload_id, side, clase, linea, tipodocto, bodega, numero, fecha, cod_legal, razon_social,
      producto, glosa, cantidad, unidad, doc_rel, num_rel, fecha_entrega, contrato, ref_tipo, ref_correlativo, ref_numero,
      ref_fecha, lote_raw, lote, ot, comentario, peso_unit, peso_kg, ccosto)
    SELECT p_upload_id, v_side, COALESCE(d.clase, public.inv_guess_class(public.inv_code(j->>'TIPODOCTO'))), n, public.inv_code(j->>'TIPODOCTO'), public.inv_code(j->>'BODEGA'),
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
    LEFT JOIN public.inv_doc_types d ON d.tipodocto = public.inv_code(j->>'TIPODOCTO')
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
  v_result := jsonb_build_object('success', true, 'inserted', v_ok, 'excluded', v_excl);
  INSERT INTO public.inv_upload_chunks(upload_id, chunk_hash, result) VALUES(p_upload_id, v_hash, v_result);
  RETURN v_result;
END $function$;
REVOKE ALL ON FUNCTION public.inv_upload_rows(p_upload_id uuid, p_rows jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_upload_rows(p_upload_id uuid, p_rows jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_verify()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v jsonb; v_checks jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  v := public.inv_read_cached('verify');
  IF v IS NULL THEN
    IF NOT public.inv_live_allowed() THEN RETURN public.inv_preparing(); END IF;
    RETURN public.inv_verify_live();
  END IF;
  IF (v->'cache'->>'al_dia')::boolean THEN RETURN v; END IF;
  SELECT jsonb_agg(CASE WHEN x->>'id' = 'al_dia' THEN x || jsonb_build_object('estado', 'AVISO',
      'detalle', 'Hay cargas o cambios pendientes de recalcular, o se están preparando las cifras: se actualizan solas en unos minutos.')
    ELSE x END ORDER BY o)
  INTO v_checks FROM jsonb_array_elements(v->'checks') WITH ORDINALITY t(x, o);
  RETURN v || jsonb_build_object('checks', v_checks,
    'ok', (SELECT count(*) FROM jsonb_array_elements(v_checks) x WHERE x->>'estado' = 'OK'));
END $function$;
REVOKE ALL ON FUNCTION public.inv_verify() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_verify() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inv_verify_live()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s public.inv_state; v_cuadre jsonb; v_bad integer; v_total integer; v_tr numeric; v_tr_ok numeric; v_alloc numeric;
  v_alloc_inf numeric; v_lines numeric; v_peso numeric; v_e record; v_s record; v_gaps integer; v_checks jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  SELECT * INTO s FROM public.inv_state WHERE id = 1;

  WITH mov AS (
    SELECT bodega, COALESCE(sum(cantidad) FILTER (WHERE cantidad > 0), 0) AS ent, COALESCE(-sum(cantidad) FILTER (WHERE cantidad < 0), 0) AS sal,
      count(*) AS lineas
    FROM public.inv_movements_v WHERE active AND (s.model_from IS NULL OR fecha >= s.model_from) GROUP BY bodega
  ), lay AS (
    SELECT bodega, COALESCE(sum(qty) FILTER (WHERE source = 'FOTO'), 0) AS foto, COALESCE(sum(qty) FILTER (WHERE source = 'INFERIDA'), 0) AS inferida,
      COALESCE(sum(qty) FILTER (WHERE source = 'MOV'), 0) AS ent_modelo, COALESCE(sum(qty - consumed), 0) AS saldo
    FROM public.inv_layers GROUP BY bodega
  ), alo AS (
    SELECT l.bodega, sum(a.qty) AS sal_modelo FROM public.inv_allocations a JOIN public.inv_layers l ON l.id = a.layer_id GROUP BY l.bodega
  ), c AS (
    SELECT bodega, COALESCE(w.kind, 'OTRO') AS kind, COALESCE(w.stage, 70) AS stage, COALESCE(m.lineas, 0) AS lineas,
      COALESCE(m.ent, 0) AS ent, COALESCE(m.sal, 0) AS sal, COALESCE(l.foto, 0) AS foto, COALESCE(l.inferida, 0) AS inferida,
      COALESCE(l.ent_modelo, 0) AS ent_modelo, COALESCE(a.sal_modelo, 0) AS sal_modelo, COALESCE(l.saldo, 0) AS saldo
    FROM mov m FULL JOIN lay l USING (bodega) LEFT JOIN alo a USING (bodega) LEFT JOIN public.inv_warehouses w ON w.code = bodega
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('bodega', bodega, 'kind', kind, 'lineas', lineas,
      'saldo_inicial_foto', round(foto, 3), 'saldo_inicial_inferido', round(inferida, 3),
      'entradas_archivo', round(ent, 3), 'entradas_modelo', round(ent_modelo, 3),
      'salidas_archivo', round(sal, 3), 'salidas_modelo', round(sal_modelo, 3),
      'saldo_calculado', round(foto + inferida + ent - sal, 3), 'saldo_modelo', round(saldo, 3),
      'diferencia', round((foto + inferida + ent - sal) - saldo, 3),
      'ok', abs(ent - ent_modelo) < 0.001 AND abs(sal - sal_modelo) < 0.001 AND abs((foto + inferida + ent - sal) - saldo) < 0.001)
      ORDER BY stage, bodega), '[]'::jsonb),
    count(*) FILTER (WHERE NOT (abs(ent - ent_modelo) < 0.001 AND abs(sal - sal_modelo) < 0.001 AND abs((foto + inferida + ent - sal) - saldo) < 0.001)),
    count(*)
  INTO v_cuadre, v_bad, v_total FROM c;

  v_checks := v_checks || jsonb_build_object('id', 'cuadre', 'titulo', 'Cuadre de cantidades por bodega',
    'valor', v_total - v_bad, 'meta', v_total, 'unidad', 'bodegas',
    'estado', CASE WHEN v_total = 0 THEN 'SIN_DATOS' WHEN v_bad = 0 THEN 'OK' ELSE 'FALLA' END,
    'detalle', 'Saldo = saldo inicial + entradas − salidas, y el modelo registró exactamente las entradas y salidas del archivo.');

  SELECT count(*), count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.inv_transfer_links t WHERE t.out_id = m.id OR t.in_id = m.id))
  INTO v_tr, v_tr_ok
  FROM public.inv_movements_v m WHERE m.active AND m.clase = 'TRASPASO' AND (s.model_from IS NULL OR m.fecha >= s.model_from);
  v_checks := v_checks || jsonb_build_object('id', 'traspasos', 'titulo', 'Traspasos con origen y destino',
    'valor', CASE WHEN v_tr > 0 THEN round(100 * v_tr_ok / v_tr, 1) END, 'meta', 99, 'unidad', '%',
    'estado', CASE WHEN v_tr = 0 THEN 'SIN_DATOS' WHEN v_tr_ok / v_tr >= 0.99 THEN 'OK' WHEN v_tr_ok / v_tr >= 0.95 THEN 'AVISO' ELSE 'FALLA' END,
    'detalle', format('%s de %s líneas de traspaso emparejadas. Sin pareja: falta cargar el otro lado (Entradas o Salidas) de esas fechas.', v_tr_ok, v_tr));

  SELECT count(*), count(*) FILTER (WHERE l.source = 'INFERIDA') INTO v_alloc, v_alloc_inf
  FROM public.inv_allocations a JOIN public.inv_layers l ON l.id = a.layer_id;
  v_checks := v_checks || jsonb_build_object('id', 'origen', 'titulo', 'Salidas con origen conocido',
    'valor', CASE WHEN v_alloc > 0 THEN round(100 * (v_alloc - v_alloc_inf) / v_alloc, 1) END, 'meta', 95, 'unidad', '%',
    'estado', CASE WHEN v_alloc = 0 THEN 'SIN_DATOS' WHEN (v_alloc - v_alloc_inf) / v_alloc >= 0.95 THEN 'OK'
                   WHEN (v_alloc - v_alloc_inf) / v_alloc >= 0.80 THEN 'AVISO' ELSE 'FALLA' END,
    'detalle', format('%s de %s consumos salen de ingresos cargados o de la foto de stock; el resto, de saldo anterior inferido. Para subirlo: cargue una foto de stock del ERP o más meses de historia.',
      v_alloc - v_alloc_inf, v_alloc));

  SELECT count(*), count(*) FILTER (WHERE peso_kg IS NOT NULL) INTO v_lines, v_peso
  FROM public.inv_movements_v WHERE active AND (s.model_from IS NULL OR fecha >= s.model_from);
  v_checks := v_checks || jsonb_build_object('id', 'peso', 'titulo', 'Líneas con peso',
    'valor', CASE WHEN v_lines > 0 THEN round(100 * v_peso / v_lines, 1) END, 'meta', 90, 'unidad', '%',
    'estado', CASE WHEN v_lines = 0 THEN 'SIN_DATOS' WHEN v_peso / v_lines >= 0.90 THEN 'OK' ELSE 'AVISO' END,
    'detalle', format('%s de %s líneas traen peso. Las cifras en kg solo suman esas líneas; las cantidades se cuentan siempre.', v_peso, v_lines));

  SELECT min(fecha) AS d, max(fecha) AS h INTO v_e FROM public.inv_movements_v WHERE active AND side = 'E';
  SELECT min(fecha) AS d, max(fecha) AS h INTO v_s FROM public.inv_movements_v WHERE active AND side = 'S';
  SELECT count(*) INTO v_gaps FROM (
    SELECT side, fecha, lead(fecha) OVER (PARTITION BY side ORDER BY fecha) AS nxt FROM (SELECT DISTINCT side, fecha FROM public.inv_movements_v WHERE active) f
  ) x WHERE nxt - fecha > 4;
  v_checks := v_checks || jsonb_build_object('id', 'cobertura', 'titulo', 'Cobertura de fechas',
    'valor', v_gaps, 'meta', 0, 'unidad', 'huecos',
    'estado', CASE WHEN v_e.d IS NULL AND v_s.d IS NULL THEN 'SIN_DATOS' WHEN v_e.d IS NULL OR v_s.d IS NULL THEN 'FALLA'
                   WHEN v_gaps = 0 AND v_e.d = v_s.d AND v_e.h = v_s.h THEN 'OK' ELSE 'AVISO' END,
    'detalle', format('Entradas: %s a %s · Salidas: %s a %s · %s hueco(s) de más de 4 días sin movimientos.',
      COALESCE(to_char(v_e.d, 'DD/MM/YYYY'), '—'), COALESCE(to_char(v_e.h, 'DD/MM/YYYY'), '—'),
      COALESCE(to_char(v_s.d, 'DD/MM/YYYY'), '—'), COALESCE(to_char(v_s.h, 'DD/MM/YYYY'), '—'), v_gaps));

  v_checks := v_checks || jsonb_build_object('id', 'al_dia', 'titulo', 'Modelo recalculado',
    'valor', NULL, 'meta', NULL, 'unidad', NULL,
    'estado', CASE WHEN s.rebuilt_at IS NULL THEN 'SIN_DATOS' WHEN s.dirty THEN 'AVISO' ELSE 'OK' END,
    'detalle', CASE WHEN s.dirty THEN 'Hay cargas o cambios de catálogo pendientes: el recálculo termina solo en unos minutos.'
                    ELSE 'Última actualización: ' || COALESCE(to_char(s.rebuilt_at AT TIME ZONE 'America/Lima', 'DD/MM/YYYY HH24:MI'), '—') END);

  RETURN jsonb_build_object('success', true, 'checks', v_checks, 'cuadre', v_cuadre,
    'ok', (SELECT count(*) FROM jsonb_array_elements(v_checks) x WHERE x->>'estado' = 'OK'),
    'total', jsonb_array_length(v_checks),
    'corte', s.data_max, 'desde', s.data_min, 'model_from', s.model_from, 'snapshot_cutoff', s.snapshot_cutoff);
END $function$;
REVOKE ALL ON FUNCTION public.inv_verify_live() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_verify_live() TO service_role;

-- Vistas (orden de dependencia)
DROP VIEW IF EXISTS public.inv_movements_v;
DROP VIEW IF EXISTS public.apa_v_traspasos;
DROP VIEW IF EXISTS public.apa_v_productos;
DROP VIEW IF EXISTS public.apa_v_ordenes;
DROP VIEW IF EXISTS public.apa_v_lotes;
DROP VIEW IF EXISTS public.apa_v_documentos;
DROP VIEW IF EXISTS public.apa_v_clientes;
DROP VIEW IF EXISTS public.apa_v_movimientos_vigentes;
CREATE OR REPLACE VIEW public.apa_v_movimientos_vigentes AS
 SELECT m.id,
    m.import_id,
    m.sheet,
    m.row_number,
    m.status,
    m.reasons,
    m.fingerprint,
    m.dup,
    m.side,
    m.tipo,
    m.bodega_raw,
    m.bodega,
    m.numero,
    m.fecha,
    m.cod_legal,
    m.razon_social,
    m.producto,
    m.glosa,
    m.cantidad,
    m.unidad,
    m.doc_rel,
    m.num_rel,
    m.fecha_entrega,
    m.contrato,
    m.ref_tipo,
    m.ref_correlativo,
    m.ref_numero,
    m.ref_fecha,
    m.lote,
    m.color,
    m.comentario,
    m.peso_unitario,
    m.peso_x_producir,
    m.peso_producido,
    m.ccosto,
    m.reviewed_by,
    m.reviewed_at,
    m.review_note
   FROM apa_movements m
     JOIN apa_imports i ON i.id = m.import_id
  WHERE i.status = 'ACTIVA'::text AND m.status = 'ACEPTADO'::text;
REVOKE ALL ON public.apa_v_movimientos_vigentes FROM PUBLIC, anon;

CREATE OR REPLACE VIEW public.apa_v_clientes AS
 SELECT cod_legal,
    razon_social,
    count(*) AS lineas
   FROM apa_v_movimientos_vigentes
  WHERE razon_social IS NOT NULL
  GROUP BY cod_legal, razon_social;
REVOKE ALL ON public.apa_v_clientes FROM PUBLIC, anon;

CREATE OR REPLACE VIEW public.apa_v_documentos AS
 SELECT tipo,
    numero,
    fecha,
    min(razon_social) AS cliente,
    count(*) AS lineas,
    array_agg(DISTINCT bodega) AS bodegas
   FROM apa_v_movimientos_vigentes
  GROUP BY tipo, numero, fecha;
REVOKE ALL ON public.apa_v_documentos FROM PUBLIC, anon;

CREATE OR REPLACE VIEW public.apa_v_lotes AS
 SELECT lote,
    producto,
    bodega,
    unidad,
    min(fecha) AS primera,
    max(fecha) AS ultima,
    count(*) AS lineas
   FROM apa_v_movimientos_vigentes
  WHERE lote IS NOT NULL
  GROUP BY lote, producto, bodega, unidad;
REVOKE ALL ON public.apa_v_lotes FROM PUBLIC, anon;

CREATE OR REPLACE VIEW public.apa_v_ordenes AS
 SELECT doc_rel,
    num_rel,
    contrato,
    count(*) AS lineas
   FROM apa_v_movimientos_vigentes
  WHERE num_rel IS NOT NULL OR contrato IS NOT NULL
  GROUP BY doc_rel, num_rel, contrato;
REVOKE ALL ON public.apa_v_ordenes FROM PUBLIC, anon;

CREATE OR REPLACE VIEW public.apa_v_productos AS
 SELECT producto,
    min(glosa) AS glosa,
    array_agg(DISTINCT unidad) AS unidades,
    count(*) AS lineas
   FROM apa_v_movimientos_vigentes
  GROUP BY producto;
REVOKE ALL ON public.apa_v_productos FROM PUBLIC, anon;

CREATE OR REPLACE VIEW public.apa_v_traspasos AS
 SELECT tipo,
    numero,
    fecha,
    producto,
    unidad,
    sum(
        CASE
            WHEN side = 'S'::text THEN - cantidad
            ELSE 0::numeric
        END) AS salida,
    sum(
        CASE
            WHEN side = 'E'::text THEN cantidad
            ELSE 0::numeric
        END) AS entrada,
    array_agg(DISTINCT lote) FILTER (WHERE side = 'S'::text) AS lotes_origen,
    array_agg(DISTINCT lote) FILTER (WHERE side = 'E'::text) AS lotes_destino
   FROM apa_v_movimientos_vigentes m
  WHERE (EXISTS ( SELECT 1
           FROM apa_doc_classes c
          WHERE c.tipo = m.tipo AND c.clase = 'TRASPASO'::text))
  GROUP BY tipo, numero, fecha, producto, unidad;
REVOKE ALL ON public.apa_v_traspasos FROM PUBLIC, anon;

CREATE OR REPLACE VIEW public.inv_movements_v AS
 SELECT id,
    upload_id,
    side,
    active,
    linea,
    tipodocto,
    clase,
    bodega,
    numero,
    fecha,
    cod_legal,
    razon_social,
    producto,
    glosa,
    cantidad,
    unidad,
    doc_rel,
    num_rel,
    fecha_entrega,
    contrato,
    ref_tipo,
    ref_correlativo,
    ref_numero,
    ref_fecha,
    lote_raw,
    lote,
    ot,
    comentario,
    peso_unit,
    peso_kg,
    ccosto
   FROM inv_movements
  WHERE COALESCE(current_setting('inv.scope'::text, true), ''::text) = ''::text OR bodega ~~ current_setting('inv.scope'::text, true);
REVOKE ALL ON public.inv_movements_v FROM PUBLIC, anon;

-- Funciones que usan vistas en su firma
-- Disparadores
DROP TRIGGER IF EXISTS "apt_flow_state_gantt_refresh" ON public.apt_flow_state;
CREATE TRIGGER apt_flow_state_gantt_refresh AFTER UPDATE OF rebuilt_at ON public.apt_flow_state FOR EACH ROW WHEN ((old.rebuilt_at IS DISTINCT FROM new.rebuilt_at)) EXECUTE FUNCTION apt_gantt_refresh_trigger();
DROP TRIGGER IF EXISTS "apt_readiness_history_immutable" ON public.apt_operational_readiness_history;
CREATE TRIGGER apt_readiness_history_immutable BEFORE DELETE OR UPDATE ON public.apt_operational_readiness_history FOR EACH ROW EXECUTE FUNCTION apt_readiness_history_immutable();
DROP TRIGGER IF EXISTS "apt_uploads_gantt_meta" ON public.apt_uploads;
CREATE TRIGGER apt_uploads_gantt_meta AFTER UPDATE OF status ON public.apt_uploads FOR EACH ROW WHEN (((old.status IS DISTINCT FROM new.status) AND (('APLICADA'::text = old.status) OR ('APLICADA'::text = new.status)))) EXECUTE FUNCTION apt_gantt_meta_uploads_trigger();
DROP TRIGGER IF EXISTS "erp_derive_days_rule_version" ON public.erp_derive_days;
CREATE TRIGGER erp_derive_days_rule_version BEFORE INSERT ON public.erp_derive_days FOR EACH ROW EXECUTE FUNCTION erp_stamp_rule_version();

-- Seguridad
DROP POLICY IF EXISTS "security_active_account" ON public.apa_areas;
CREATE POLICY "security_active_account" ON public.apa_areas AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apa_areas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apa_areas FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.apa_audit;
CREATE POLICY "security_active_account" ON public.apa_audit AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apa_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apa_audit FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.apa_commitments;
CREATE POLICY "security_active_account" ON public.apa_commitments AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apa_commitments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apa_commitments FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.apa_conversions;
CREATE POLICY "security_active_account" ON public.apa_conversions AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apa_conversions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apa_conversions FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.apa_doc_classes;
CREATE POLICY "security_active_account" ON public.apa_doc_classes AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apa_doc_classes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apa_doc_classes FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.apa_imports;
CREATE POLICY "security_active_account" ON public.apa_imports AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apa_imports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apa_imports FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.apa_links;
CREATE POLICY "security_active_account" ON public.apa_links AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apa_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apa_links FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.apa_movements;
CREATE POLICY "security_active_account" ON public.apa_movements AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apa_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apa_movements FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.apa_opening_balances;
CREATE POLICY "security_active_account" ON public.apa_opening_balances AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apa_opening_balances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apa_opening_balances FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.apa_raw_rows;
CREATE POLICY "security_active_account" ON public.apa_raw_rows AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apa_raw_rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apa_raw_rows FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.apa_receipts;
CREATE POLICY "security_active_account" ON public.apa_receipts AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apa_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apa_receipts FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.apa_saved_views;
CREATE POLICY "security_active_account" ON public.apa_saved_views AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apa_saved_views ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apa_saved_views FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.apa_settings;
CREATE POLICY "security_active_account" ON public.apa_settings AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apa_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apa_settings FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "apt_aging_ranges_select" ON public.apt_aging_ranges;
CREATE POLICY "apt_aging_ranges_select" ON public.apt_aging_ranges AS PERMISSIVE FOR SELECT TO authenticated USING (apt_can_view());
DROP POLICY IF EXISTS "security_active_account" ON public.apt_aging_ranges;
CREATE POLICY "security_active_account" ON public.apt_aging_ranges AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apt_aging_ranges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apt_aging_ranges FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "apt_allocations_select" ON public.apt_allocations;
CREATE POLICY "apt_allocations_select" ON public.apt_allocations AS PERMISSIVE FOR SELECT TO authenticated USING (apt_can_view());
DROP POLICY IF EXISTS "security_active_account" ON public.apt_allocations;
CREATE POLICY "security_active_account" ON public.apt_allocations AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apt_allocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apt_allocations FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "apt_exit_class_select" ON public.apt_exit_class;
CREATE POLICY "apt_exit_class_select" ON public.apt_exit_class AS PERMISSIVE FOR SELECT TO authenticated USING (apt_can_view());
DROP POLICY IF EXISTS "security_active_account" ON public.apt_exit_class;
CREATE POLICY "security_active_account" ON public.apt_exit_class AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apt_exit_class ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apt_exit_class FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "apt_flow_alloc_select" ON public.apt_flow_alloc;
CREATE POLICY "apt_flow_alloc_select" ON public.apt_flow_alloc AS PERMISSIVE FOR SELECT TO authenticated USING (apt_can_view());
DROP POLICY IF EXISTS "security_active_account" ON public.apt_flow_alloc;
CREATE POLICY "security_active_account" ON public.apt_flow_alloc AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apt_flow_alloc ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apt_flow_alloc FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "apt_flow_exits_select" ON public.apt_flow_exits;
CREATE POLICY "apt_flow_exits_select" ON public.apt_flow_exits AS PERMISSIVE FOR SELECT TO authenticated USING (apt_can_view());
DROP POLICY IF EXISTS "security_active_account" ON public.apt_flow_exits;
CREATE POLICY "security_active_account" ON public.apt_flow_exits AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apt_flow_exits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apt_flow_exits FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "apt_flow_layers_select" ON public.apt_flow_layers;
CREATE POLICY "apt_flow_layers_select" ON public.apt_flow_layers AS PERMISSIVE FOR SELECT TO authenticated USING (apt_can_view());
DROP POLICY IF EXISTS "security_active_account" ON public.apt_flow_layers;
CREATE POLICY "security_active_account" ON public.apt_flow_layers AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apt_flow_layers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apt_flow_layers FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "apt_flow_pieces_select" ON public.apt_flow_pieces;
CREATE POLICY "apt_flow_pieces_select" ON public.apt_flow_pieces AS PERMISSIVE FOR SELECT TO authenticated USING (apt_can_view());
DROP POLICY IF EXISTS "security_active_account" ON public.apt_flow_pieces;
CREATE POLICY "security_active_account" ON public.apt_flow_pieces AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apt_flow_pieces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apt_flow_pieces FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "apt_flow_state_select" ON public.apt_flow_state;
CREATE POLICY "apt_flow_state_select" ON public.apt_flow_state AS PERMISSIVE FOR SELECT TO authenticated USING (apt_can_view());
DROP POLICY IF EXISTS "security_active_account" ON public.apt_flow_state;
CREATE POLICY "security_active_account" ON public.apt_flow_state AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apt_flow_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apt_flow_state FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.apt_gantt_daily;
CREATE POLICY "security_active_account" ON public.apt_gantt_daily AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apt_gantt_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apt_gantt_daily FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.apt_gantt_lotes;
CREATE POLICY "security_active_account" ON public.apt_gantt_lotes AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apt_gantt_lotes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apt_gantt_lotes FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.apt_gantt_meta;
CREATE POLICY "security_active_account" ON public.apt_gantt_meta AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apt_gantt_meta ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apt_gantt_meta FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "apt_layers_select" ON public.apt_layers;
CREATE POLICY "apt_layers_select" ON public.apt_layers AS PERMISSIVE FOR SELECT TO authenticated USING (apt_can_view());
DROP POLICY IF EXISTS "security_active_account" ON public.apt_layers;
CREATE POLICY "security_active_account" ON public.apt_layers AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apt_layers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apt_layers FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "apt_movements_select" ON public.apt_movements;
CREATE POLICY "apt_movements_select" ON public.apt_movements AS PERMISSIVE FOR SELECT TO authenticated USING (apt_can_view());
DROP POLICY IF EXISTS "security_active_account" ON public.apt_movements;
CREATE POLICY "security_active_account" ON public.apt_movements AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apt_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apt_movements FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "apt_readiness_read" ON public.apt_operational_readiness;
CREATE POLICY "apt_readiness_read" ON public.apt_operational_readiness AS PERMISSIVE FOR SELECT TO authenticated USING (apt_can_view());
DROP POLICY IF EXISTS "security_active_account" ON public.apt_operational_readiness;
CREATE POLICY "security_active_account" ON public.apt_operational_readiness AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apt_operational_readiness ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apt_operational_readiness FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "apt_readiness_history_read" ON public.apt_operational_readiness_history;
CREATE POLICY "apt_readiness_history_read" ON public.apt_operational_readiness_history AS PERMISSIVE FOR SELECT TO authenticated USING (apt_can_view());
DROP POLICY IF EXISTS "security_active_account" ON public.apt_operational_readiness_history;
CREATE POLICY "security_active_account" ON public.apt_operational_readiness_history AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apt_operational_readiness_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apt_operational_readiness_history FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.apt_read_cache;
CREATE POLICY "security_active_account" ON public.apt_read_cache AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apt_read_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apt_read_cache FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.apt_read_cache_requests;
CREATE POLICY "security_active_account" ON public.apt_read_cache_requests AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apt_read_cache_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apt_read_cache_requests FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "apt_settings_select" ON public.apt_settings;
CREATE POLICY "apt_settings_select" ON public.apt_settings AS PERMISSIVE FOR SELECT TO authenticated USING (apt_can_view());
DROP POLICY IF EXISTS "security_active_account" ON public.apt_settings;
CREATE POLICY "security_active_account" ON public.apt_settings AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apt_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apt_settings FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "apt_state_select" ON public.apt_state;
CREATE POLICY "apt_state_select" ON public.apt_state AS PERMISSIVE FOR SELECT TO authenticated USING (apt_can_view());
DROP POLICY IF EXISTS "security_active_account" ON public.apt_state;
CREATE POLICY "security_active_account" ON public.apt_state AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apt_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apt_state FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.apt_stock_observations;
CREATE POLICY "security_active_account" ON public.apt_stock_observations AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apt_stock_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apt_stock_observations FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "apt_uploads_select" ON public.apt_uploads;
CREATE POLICY "apt_uploads_select" ON public.apt_uploads AS PERMISSIVE FOR SELECT TO authenticated USING (apt_can_view());
DROP POLICY IF EXISTS "security_active_account" ON public.apt_uploads;
CREATE POLICY "security_active_account" ON public.apt_uploads AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.apt_uploads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apt_uploads FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.erp_derive_days;
CREATE POLICY "security_active_account" ON public.erp_derive_days AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.erp_derive_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_derive_days FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.erp_derive_guias;
CREATE POLICY "security_active_account" ON public.erp_derive_guias AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.erp_derive_guias ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_derive_guias FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.erp_derive_stock;
CREATE POLICY "security_active_account" ON public.erp_derive_stock AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.erp_derive_stock ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_derive_stock FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.erp_load_log;
CREATE POLICY "security_active_account" ON public.erp_load_log AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.erp_load_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_load_log FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.erp_rule_versions;
CREATE POLICY "security_active_account" ON public.erp_rule_versions AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.erp_rule_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_rule_versions FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.erp_sku_medidas;
CREATE POLICY "security_active_account" ON public.erp_sku_medidas AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.erp_sku_medidas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_sku_medidas FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.inv_allocations;
CREATE POLICY "security_active_account" ON public.inv_allocations AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.inv_allocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inv_allocations FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.inv_doc_types;
CREATE POLICY "security_active_account" ON public.inv_doc_types AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.inv_doc_types ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inv_doc_types FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.inv_layers;
CREATE POLICY "security_active_account" ON public.inv_layers AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.inv_layers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inv_layers FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.inv_movements;
CREATE POLICY "security_active_account" ON public.inv_movements AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.inv_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inv_movements FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.inv_read_cache;
CREATE POLICY "security_active_account" ON public.inv_read_cache AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.inv_read_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inv_read_cache FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.inv_state;
CREATE POLICY "security_active_account" ON public.inv_state AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.inv_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inv_state FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.inv_stock_cache;
CREATE POLICY "security_active_account" ON public.inv_stock_cache AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.inv_stock_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inv_stock_cache FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.inv_stock_snapshots;
CREATE POLICY "security_active_account" ON public.inv_stock_snapshots AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.inv_stock_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inv_stock_snapshots FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.inv_transfer_links;
CREATE POLICY "security_active_account" ON public.inv_transfer_links AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.inv_transfer_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inv_transfer_links FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.inv_upload_chunks;
CREATE POLICY "security_active_account" ON public.inv_upload_chunks AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.inv_upload_chunks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inv_upload_chunks FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.inv_uploads;
CREATE POLICY "security_active_account" ON public.inv_uploads AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.inv_uploads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inv_uploads FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "security_active_account" ON public.inv_warehouses;
CREATE POLICY "security_active_account" ON public.inv_warehouses AS RESTRICTIVE FOR ALL TO authenticated USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));
ALTER TABLE public.inv_warehouses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inv_warehouses FROM PUBLIC, anon, authenticated;

-- Permisos del WMS: las funciones del TMS preguntan por roles y permisos apt-* que el WMS no usa
CREATE OR REPLACE FUNCTION public.apt_can_view()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $f$
  SELECT public.is_active_tms_user() AND (public.wh_any_warehouse_permission() OR public.wh_has_permission(ARRAY['almacen-etiquetado']));
$f$;
CREATE OR REPLACE FUNCTION public.apa_can_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $f$
  SELECT public.is_active_tms_user() AND public.wh_has_permission(ARRAY['almacen-supervisor']);
$f$;

RESET check_function_bodies;
