-- ============================================================
-- APT — Estadía del inventario en el Almacén de Producto Terminado
-- ============================================================
-- Todo nace de ENTRADA (P/E Producción → bodega 647-04 ALM PT) y SALIDA (Despacho Ventas):
--  * Cada carga guarda las filas originales intactas (raw) y su versión normalizada. Ninguna fila se elimina:
--    las que no se pueden usar quedan con valid = false y su motivo.
--  * Una carga reemplaza, por tipo, los movimientos del rango de fechas que trae (acumulado o solo el día).
--  * NumRel padre (lote): ENTRADA usa la columna Lote; si falta, el NumRel de la OP sin su último tramo
--    (16325-S002-033 → 16325-S002). SALIDA usa NumRel; las salidas "ERROR DE CONTRATO" van a su Lote.
--  * Peso = |PesoTotalProduccido| (kg; TN = kg / 1000). Cantidad tiene unidades mezcladas y no se suma.
--  * FIFO por clave Lote|Producto: las salidas consumen primero los ingresos más antiguos (capas). Cada capa
--    sabe cuánto se despachó, cuándo y cuánto sigue en APT; el saldo hereda la fecha de su ingreso.
--  * Una salida registrada antes del ingreso que consume (el ingreso se registró tarde) se asigna igual, con
--    0 días, queda fuera del promedio de permanencia y marca la capa con problema_info (el estado sigue siendo el operativo).
--  * posible_cruce: capa con saldo cuyo producto salió después por otro NumRel sin capa que lo respalde (posible
--    despacho con otro NumRel). No se reasigna: se muestra para revisión.
--  * Días del saldo = fecha de corte − fecha de ingreso de la capa. TN×Días = saldo TN × días del saldo.
BEGIN;

-- ------------------------------------------------------------
-- Permisos: ver (apt) y cargar/configurar (apt-carga). Administrador y Jefe de Distribución, siempre.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apt_can_view()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
    WHERE p.id = auth.uid() AND p.is_active
      AND (r.name IN ('Administrador', 'Jefe de Distribución')
           OR COALESCE(r.permissions, '[]'::jsonb) ?| ARRAY['apt', 'apt:read', 'apt:write', 'apt-carga', 'apt-carga:write']));
$$;

CREATE OR REPLACE FUNCTION public.apt_can_load()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
    WHERE p.id = auth.uid() AND p.is_active
      AND (r.name IN ('Administrador', 'Jefe de Distribución')
           OR COALESCE(r.permissions, '[]'::jsonb) ?| ARRAY['apt-carga', 'apt-carga:write']));
$$;

-- ------------------------------------------------------------
-- Tablas
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.apt_uploads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name   text NOT NULL,
  status      text NOT NULL DEFAULT 'CARGANDO' CHECK (status IN ('CARGANDO', 'APLICADA', 'DESCARTADA')),
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  applied_at  timestamptz,
  summary     jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.apt_movements (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  upload_id       uuid NOT NULL REFERENCES public.apt_uploads(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('ENTRADA', 'SALIDA')),
  row_no          integer NOT NULL,              -- fila de la hoja de origen (encabezado = 1)
  raw             jsonb NOT NULL,                -- fila original sin cambios
  active          boolean NOT NULL DEFAULT false,
  valid           boolean NOT NULL,
  invalid_reason  text,
  fecha           date,
  documento       text,
  tipodocto       text,
  bodega          text,
  numrel          text,                          -- NumRel_OP en ENTRADA / NumRel_Salida en SALIDA
  lote_origen     text,                          -- columna Lote
  lote            text,                          -- NumRel padre
  lote_derivado   boolean NOT NULL DEFAULT false,
  docrel          text,
  cliente         text,
  ruc             text,
  producto        text,
  glosa           text,
  familia         text,
  ipt             text,
  cantidad        numeric,
  unidad          text,
  peso_unitario   numeric,
  peso_kg         numeric NOT NULL DEFAULT 0,
  fecha_entrega   date
);
CREATE UNIQUE INDEX IF NOT EXISTS apt_movements_row_key ON public.apt_movements (upload_id, kind, row_no);  -- reintento de un lote no duplica
CREATE INDEX IF NOT EXISTS apt_movements_active_idx ON public.apt_movements (kind, fecha) WHERE active;
CREATE INDEX IF NOT EXISTS apt_movements_key_idx ON public.apt_movements (lote, producto) WHERE active;

CREATE TABLE IF NOT EXISTS public.apt_settings (
  id           integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cutoff_date  date,                                   -- vacío = fecha máxima de los datos
  tolerance    numeric NOT NULL DEFAULT 0.02 CHECK (tolerance >= 0 AND tolerance < 0.5),
  alert_days   integer NOT NULL DEFAULT 60 CHECK (alert_days > 0),
  updated_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.apt_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.apt_aging_ranges (
  desde  integer PRIMARY KEY CHECK (desde >= 0),
  label  text NOT NULL
);
INSERT INTO public.apt_aging_ranges (desde, label)
SELECT * FROM (VALUES (0, '0-1 días'), (2, '2-3 días'), (4, '4-7 días'), (8, '8-15 días'), (16, '16-30 días'),
                      (31, '31-45 días'), (46, '46-60 días'), (61, '> 60 días')) v(desde, label)
WHERE NOT EXISTS (SELECT 1 FROM public.apt_aging_ranges);

-- Resultado del modelo (se recalcula en cada carga o cambio de parámetros)
CREATE TABLE IF NOT EXISTS public.apt_layers (
  movement_id        bigint PRIMARY KEY,
  lote               text NOT NULL,
  producto           text NOT NULL,
  numrel_op          text,
  glosa              text,
  familia            text,
  ipt                text,
  documento          text,
  docrel             text,
  fecha_ingreso      date NOT NULL,
  fecha_entrega      date,
  cantidad           numeric,
  unidad             text,
  kg_in              numeric NOT NULL,
  kg_out             numeric NOT NULL DEFAULT 0,
  kg_saldo           numeric NOT NULL DEFAULT 0,
  kg_out_before_in   numeric NOT NULL DEFAULT 0,
  kg_out_fechado     numeric NOT NULL DEFAULT 0,      -- despachado con fecha de salida ≥ ingreso
  out_kg_days        numeric NOT NULL DEFAULT 0,      -- Σ kg despachado × días de permanencia (solo salidas ≥ ingreso)
  problema_info      boolean NOT NULL DEFAULT false,  -- ingreso sin peso o salida registrada antes del ingreso
  posible_cruce      boolean NOT NULL DEFAULT false,
  first_out          date,
  last_out           date,
  dias               integer,                         -- permanencia: saldo → corte − ingreso; cerrada → última salida − ingreso
  dias_saldo         integer,                         -- solo si queda saldo
  estado             text NOT NULL,
  rango              text,
  rango_orden        integer,
  tn_dias            numeric NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS apt_layers_lote_idx ON public.apt_layers (lote);
CREATE INDEX IF NOT EXISTS apt_layers_producto_idx ON public.apt_layers (producto);

CREATE TABLE IF NOT EXISTS public.apt_allocations (
  layer_id       bigint NOT NULL,
  exit_id        bigint NOT NULL,
  kg             numeric NOT NULL,
  fecha_ingreso  date NOT NULL,
  fecha_salida   date NOT NULL,
  dias           integer NOT NULL,
  PRIMARY KEY (layer_id, exit_id)
);
CREATE INDEX IF NOT EXISTS apt_allocations_exit_idx ON public.apt_allocations (exit_id);

-- Cada salida válida con su correspondencia
CREATE TABLE IF NOT EXISTS public.apt_exit_class (
  exit_id         bigint PRIMARY KEY,
  lote            text,
  producto        text,
  fecha           date NOT NULL,
  kg              numeric NOT NULL,
  kg_asignado     numeric NOT NULL DEFAULT 0,
  kg_sin_entrada  numeric NOT NULL DEFAULT 0,
  clase           text NOT NULL CHECK (clase IN ('ASIGNADA', 'EXCEDE_INGRESO', 'OTRO_PRODUCTO_DEL_LOTE', 'LOTE_SIN_INGRESO', 'SIN_NUMREL'))
);
CREATE INDEX IF NOT EXISTS apt_exit_class_lote_idx ON public.apt_exit_class (lote);
CREATE INDEX IF NOT EXISTS apt_exit_class_producto_idx ON public.apt_exit_class (producto);

CREATE TABLE IF NOT EXISTS public.apt_state (
  id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cutoff      date,
  data_min    date,
  data_max    date,
  rebuilt_at  timestamptz
);
INSERT INTO public.apt_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Lectura directa solo para quien ve el módulo; toda escritura pasa por las funciones
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['apt_uploads', 'apt_movements', 'apt_settings', 'apt_aging_ranges', 'apt_layers',
                           'apt_allocations', 'apt_exit_class', 'apt_state'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.apt_can_view())', t || '_select', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- Normalización
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apt_txt(v jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT NULLIF(upper(btrim(regexp_replace(
    CASE WHEN jsonb_typeof(v) = 'number' THEN regexp_replace(v #>> '{}', '\.0+$', '') ELSE v #>> '{}' END,
    '[[:cntrl:]]', '', 'g'))), '');
$$;

CREATE OR REPLACE FUNCTION public.apt_str(v jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT NULLIF(btrim(regexp_replace(regexp_replace(v #>> '{}', '[[:cntrl:]]', '', 'g'), '\s+', ' ', 'g')), '');
$$;

CREATE OR REPLACE FUNCTION public.apt_num(v jsonb)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE jsonb_typeof(v)
    WHEN 'number' THEN (v #>> '{}')::numeric
    WHEN 'string' THEN CASE WHEN btrim(v #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN btrim(v #>> '{}')::numeric END
  END;
$$;

CREATE OR REPLACE FUNCTION public.apt_date(v jsonb)
RETURNS date LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE s text := btrim(v #>> '{}');
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' OR s IS NULL OR s = '' THEN RETURN NULL; END IF;
  IF jsonb_typeof(v) = 'number' THEN RETURN DATE '1899-12-30' + floor((v #>> '{}')::numeric)::int; END IF;
  IF s ~ '^\d{4}-\d{2}-\d{2}' THEN RETURN left(s, 10)::date; END IF;
  IF s ~ '^\d{1,2}/\d{1,2}/\d{4}' THEN RETURN to_date(substring(s FROM '^\d{1,2}/\d{1,2}/\d{4}'), 'DD/MM/YYYY'); END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.apt_lote_tipo(p_lote text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p_lote IS NULL THEN NULL
              WHEN p_lote ~* '-S[0-9]' THEN 'SUBCONTRATO'
              WHEN p_lote ~* '-E[0-9]' THEN 'ERROR'
              WHEN p_lote ~* '-G[0-9]' THEN 'GARANTIA'
              ELSE 'CONTRATO' END;
$$;

-- ------------------------------------------------------------
-- Modelo FIFO
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apt_rebuild()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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

  CREATE TEMP TABLE apt_s ON COMMIT DROP AS
    SELECT m.id, m.lote, m.producto, m.fecha, m.peso_kg AS kg,
           sum(m.peso_kg) OVER w - m.peso_kg AS c0, sum(m.peso_kg) OVER w AS c1
    FROM public.apt_movements m
    WHERE m.active AND m.valid AND m.kind = 'SALIDA' AND m.fecha <= v_cut AND m.lote IS NOT NULL
      AND EXISTS (SELECT 1 FROM apt_e e WHERE e.lote = m.lote AND e.producto = m.producto)
    WINDOW w AS (PARTITION BY m.lote, m.producto ORDER BY m.fecha, m.id ROWS UNBOUNDED PRECEDING);

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

  RETURN jsonb_build_object('success', true, 'cutoff', v_cut,
    'capas', (SELECT count(*) FROM public.apt_layers), 'asignaciones', (SELECT count(*) FROM public.apt_allocations),
    'advertencia', CASE WHEN v_cut < v_min THEN 'La fecha de corte es anterior a los datos cargados: el modelo queda vacío'
                        WHEN v_cut > v_max THEN 'La fecha de corte es posterior al último movimiento: los días incluyen días sin datos' END);
END $$;

-- ------------------------------------------------------------
-- Carga
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apt_upload_begin(p_file_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar movimientos de APT');
  END IF;
  -- Cargas abandonadas a medio subir
  DELETE FROM public.apt_uploads WHERE status = 'CARGANDO' AND created_at < now() - interval '1 day';
  INSERT INTO public.apt_uploads (file_name, created_by)
  VALUES (left(COALESCE(NULLIF(btrim(p_file_name), ''), 'archivo.xlsx'), 200), auth.uid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', true, 'id', v_id);
END $$;

-- p_rows: arreglo de objetos con los encabezados originales de la hoja y "__row" (fila de la hoja)
CREATE OR REPLACE FUNCTION public.apt_upload_rows(p_upload_id uuid, p_kind text, p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar movimientos de APT');
  END IF;
  IF p_kind NOT IN ('ENTRADA', 'SALIDA') THEN
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
    peso_unitario, peso_kg, fecha_entrega)
  SELECT p_upload_id, p_kind, COALESCE(public.apt_num(x.r -> '__row')::int, 0), x.r - '__row',
    v.ok, v.reason, n.fecha, n.documento, n.tipodocto, n.bodega, n.numrel, n.lote_origen, l.lote,
    (p_kind = 'ENTRADA' AND n.lote_origen IS NULL AND n.numrel IS NOT NULL),
    n.docrel, n.cliente, n.ruc, n.producto, n.glosa, split_part(n.glosa, ' ', 1),
    left(btrim(substring(n.comentario FROM 'IPT:\s*(.*)$')), 40),
    abs(public.apt_num(x.r -> 'Cantidad')), n.unidad, public.apt_num(x.r -> 'PesoUnitario'),
    COALESCE(abs(public.apt_num(x.r -> 'PesoTotalProduccido')), 0), public.apt_date(x.r -> 'FechaEntrega')
  FROM jsonb_array_elements(p_rows) AS x(r)
  CROSS JOIN LATERAL (SELECT
      public.apt_date(x.r -> 'Fecha') AS fecha,
      public.apt_str(x.r -> 'Numero') AS documento,
      public.apt_str(x.r -> 'TIPODOCTO') AS tipodocto,
      public.apt_str(x.r -> 'BODEGA') AS bodega,
      public.apt_txt(x.r -> 'NumRel') AS numrel,
      public.apt_txt(x.r -> 'Lote') AS lote_origen,
      upper(public.apt_str(x.r -> 'DocRel')) AS docrel,
      public.apt_str(x.r -> 'RazonSocial') AS cliente,
      public.apt_txt(x.r -> 'CodLegal') AS ruc,
      public.apt_txt(x.r -> 'Producto') AS producto,
      public.apt_str(x.r -> 'GLOSA') AS glosa,
      public.apt_str(x.r -> 'Comentario') AS comentario,
      upper(public.apt_str(x.r -> 'UNIDAD')) AS unidad) n
  CROSS JOIN LATERAL (SELECT CASE
      WHEN p_kind = 'ENTRADA' THEN COALESCE(n.lote_origen,
        regexp_replace(n.numrel, '-[0-9]+$', ''))
      WHEN n.docrel = 'ERROR DE CONTRATO' AND n.lote_origen IS NOT NULL THEN n.lote_origen
      ELSE n.numrel END AS lote) l
  CROSS JOIN LATERAL (SELECT CASE
      WHEN n.fecha IS NULL AND n.producto IS NULL THEN 'Fila sin fecha ni producto (totalizadora o vacía)'
      WHEN n.fecha IS NULL THEN 'Sin fecha'
      WHEN n.fecha > current_date + 1 THEN 'Fecha futura'
      WHEN n.fecha < DATE '2000-01-01' THEN 'Fecha fuera de rango'
      WHEN n.producto IS NULL THEN 'Sin producto'
      WHEN p_kind = 'ENTRADA' AND l.lote IS NULL THEN 'Sin NumRel ni Lote'
      WHEN x.r ? 'PesoTotalProduccido' AND jsonb_typeof(x.r -> 'PesoTotalProduccido') <> 'null'
           AND public.apt_num(x.r -> 'PesoTotalProduccido') IS NULL THEN 'Peso no numérico' END AS reason) v0
  CROSS JOIN LATERAL (SELECT v0.reason IS NULL AS ok, v0.reason) v
  ON CONFLICT (upload_id, kind, row_no) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'rows', v_n);
END $$;

CREATE OR REPLACE FUNCTION public.apt_upload_apply(p_upload_id uuid, p_rebuild boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE k text; v_from date; v_to date; v_rows integer; v_valid integer; v_removed integer; v_summary jsonb := '{}'::jsonb; v_model jsonb;
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar movimientos de APT');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('apt_rebuild'));
  PERFORM 1 FROM public.apt_uploads WHERE id = p_upload_id AND status = 'CARGANDO' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'La carga no existe o ya fue cerrada'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.apt_movements WHERE upload_id = p_upload_id AND valid) THEN
    RETURN jsonb_build_object('success', false, 'error', 'El archivo no tiene movimientos válidos (revise las hojas ENTRADA y SALIDA)');
  END IF;

  -- Protección: una carga parcial (p. ej. filtrada a un lote) no debe borrar la historia de su rango de fechas
  FOREACH k IN ARRAY ARRAY['ENTRADA', 'SALIDA'] LOOP
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

  FOREACH k IN ARRAY ARRAY['ENTRADA', 'SALIDA'] LOOP
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
END $$;

CREATE OR REPLACE FUNCTION public.apt_model_rebuild()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para recalcular el modelo de APT');
  END IF;
  RETURN public.apt_rebuild();
END $$;

CREATE OR REPLACE FUNCTION public.apt_upload_discard(p_upload_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar movimientos de APT');
  END IF;
  DELETE FROM public.apt_movements WHERE upload_id = p_upload_id
    AND EXISTS (SELECT 1 FROM public.apt_uploads u WHERE u.id = p_upload_id AND u.status = 'CARGANDO');
  UPDATE public.apt_uploads SET status = 'DESCARTADA' WHERE id = p_upload_id AND status = 'CARGANDO';
  RETURN jsonb_build_object('success', true);
END $$;

-- ------------------------------------------------------------
-- Parámetros
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apt_get_settings()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  RETURN jsonb_build_object('success', true,
    'settings', (SELECT to_jsonb(s) - 'id' FROM public.apt_settings s WHERE id = 1),
    'ranges', (SELECT COALESCE(jsonb_agg(jsonb_build_object('desde', desde, 'label', label) ORDER BY desde), '[]') FROM public.apt_aging_ranges),
    'state', (SELECT to_jsonb(st) - 'id' FROM public.apt_state st WHERE id = 1),
    'can_load', public.apt_can_load(),
    'last_upload', (SELECT to_jsonb(u) - 'summary' || jsonb_build_object('summary', u.summary)
                    FROM public.apt_uploads u WHERE status = 'APLICADA' ORDER BY applied_at DESC LIMIT 1));
END $$;

-- p: {cutoff_date: 'YYYY-MM-DD' | null, tolerance: 0.02, alert_days: 60, ranges: [{desde, label}]}
CREATE OR REPLACE FUNCTION public.apt_save_settings(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
END $$;

-- ------------------------------------------------------------
-- Filtros comunes (p jsonb; cada clave es opcional)
--   lote, numrel_op, producto, glosa, ipt: texto contenido
--   lotes, tipos (CONTRATO|SUBCONTRATO|ERROR), familias, estados, rangos, docrels: arreglos
--   contrato: código raíz (16034); ingreso_desde/hasta, entrega_desde/hasta: fechas
--   cliente: texto contenido (capas con despacho a ese cliente); solo_saldo: boolean; dias_min: entero
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apt_arr(p jsonb, k text)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(p -> k) = 'array' AND jsonb_array_length(p -> k) > 0
              THEN ARRAY(SELECT jsonb_array_elements_text(p -> k)) END;
$$;

CREATE OR REPLACE FUNCTION public.apt_like(p jsonb, k text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT '%' || replace(replace(replace(NULLIF(btrim(p ->> k), ''), '\', '\\'), '%', '\%'), '_', '\_') || '%';
$$;

CREATE OR REPLACE FUNCTION public.apt_filtered(p jsonb)
RETURNS SETOF public.apt_layers LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
BEGIN
  RETURN QUERY
  SELECT l.* FROM public.apt_layers l
  WHERE (f_lote IS NULL OR l.lote ILIKE f_lote)
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
    AND (f_cli IS NULL OR EXISTS (
          SELECT 1 FROM public.apt_allocations a JOIN public.apt_movements m ON m.id = a.exit_id
          WHERE a.layer_id = l.movement_id AND m.cliente ILIKE f_cli));
END $$;

-- Agregado por dimensión (lote, producto, glosa, familia, numrel_op, ipt) sobre las capas filtradas
CREATE OR REPLACE FUNCTION public.apt_group(p jsonb, p_dim text)
RETURNS TABLE (clave text, etiqueta text, tipo text, capas bigint, lotes bigint, productos bigint, ops bigint, ipts bigint,
  kg_in numeric, kg_out numeric, kg_saldo numeric, primer_ingreso date, ultimo_ingreso date, primera_salida date, ultima_salida date,
  fecha_entrega date, fecha_saldo date, dias integer, dias_max integer, aging_pond numeric, dias_despacho_pond numeric, tn_dias numeric,
  capas_problema bigint, estado text, rango text, rango_orden integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH s AS (SELECT * FROM public.apt_settings WHERE id = 1),
  st AS (SELECT cutoff FROM public.apt_state WHERE id = 1),
  f AS (SELECT l.*, CASE p_dim WHEN 'producto' THEN l.producto WHEN 'glosa' THEN COALESCE(l.glosa, l.producto)
                    WHEN 'familia' THEN COALESCE(l.familia, '(sin glosa)') WHEN 'numrel_op' THEN COALESCE(l.numrel_op, l.lote)
                    WHEN 'ipt' THEN COALESCE(l.ipt, '(sin IPT)') ELSE l.lote END AS k
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
      (array_agg(COALESCE(f.glosa, f.producto) ORDER BY f.kg_in DESC, f.movement_id))[1] AS glosa_principal
    FROM f GROUP BY f.k)
  SELECT g.k,
    CASE WHEN p_dim IN ('lote', 'numrel_op', 'producto', 'ipt') THEN g.glosa_principal END,
    CASE WHEN p_dim IN ('lote', 'numrel_op') THEN public.apt_lote_tipo(g.k) END,
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
    r.label, r.desde
  FROM g
  LEFT JOIN LATERAL (SELECT r.label, r.desde FROM public.apt_aging_ranges r
    WHERE r.desde <= COALESCE((SELECT cutoff FROM st) - g.fecha_saldo, GREATEST(g.ultima_salida - g.primer_ingreso, 0), 0)
    ORDER BY r.desde DESC LIMIT 1) r ON true;
$$;

-- ------------------------------------------------------------
-- Consultas para las pantallas
-- ------------------------------------------------------------
-- Serie temporal de ingresos, despachos e inventario (saldo y aging ponderado al cierre de cada periodo)
CREATE OR REPLACE FUNCTION public.apt_trends(p jsonb DEFAULT '{}'::jsonb, p_grain text DEFAULT 'semana')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
END $$;

CREATE OR REPLACE FUNCTION public.apt_dashboard(p jsonb DEFAULT '{}'::jsonb, p_grain text DEFAULT 'semana')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
END $$;

-- Matriz de detalle. p_level: capa | lote | producto | glosa | familia | numrel_op | ipt
CREATE OR REPLACE FUNCTION public.apt_detail(p jsonb DEFAULT '{}'::jsonb, p_level text DEFAULT 'capa', p_sort text DEFAULT 'tn_dias',
  p_desc boolean DEFAULT true, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_q jsonb := COALESCE(p, '{}'::jsonb); v_rows jsonb; v_total bigint; v_tot jsonb; v_sort text; v_dir text := CASE WHEN p_desc THEN 'DESC' ELSE 'ASC' END;
        v_lim integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 20000); v_off integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  IF p_level = 'capa' THEN
    v_sort := CASE WHEN p_sort IN ('lote', 'numrel_op', 'producto', 'glosa', 'ipt', 'fecha_ingreso', 'fecha_entrega', 'last_out', 'kg_in',
                                   'kg_out', 'kg_saldo', 'dias', 'dias_saldo', 'tn_dias', 'estado', 'rango_orden', 'cantidad')
                   THEN p_sort ELSE 'tn_dias' END;
    EXECUTE format($q$
      SELECT COALESCE(jsonb_agg(r ORDER BY rn), '[]') FROM (
        SELECT row_number() OVER () AS rn, jsonb_build_object(
          'id', movement_id, 'lote', lote, 'tipo', public.apt_lote_tipo(lote), 'numrel_op', numrel_op, 'producto', producto, 'glosa', glosa,
          'familia', familia, 'ipt', ipt, 'documento', documento, 'fecha_ingreso', fecha_ingreso, 'fecha_entrega', fecha_entrega,
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
  ELSIF p_level IN ('lote', 'producto', 'glosa', 'familia', 'numrel_op', 'ipt') THEN
    v_sort := CASE WHEN p_sort IN ('clave', 'etiqueta', 'tipo', 'capas', 'lotes', 'productos', 'ops', 'ipts', 'kg_in', 'kg_out', 'kg_saldo',
                                   'primer_ingreso', 'ultimo_ingreso', 'primera_salida', 'ultima_salida', 'fecha_entrega', 'fecha_saldo',
                                   'dias', 'dias_max', 'aging_pond', 'dias_despacho_pond', 'tn_dias', 'estado', 'rango_orden', 'capas_problema')
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
END $$;

-- Ficha de un lote / NumRel: resumen, capas FIFO, salidas (todas, con su correspondencia), asignaciones y OT del sistema
CREATE OR REPLACE FUNCTION public.apt_lote(p_lote text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
END $$;

-- Pareto. p_dim: lote | producto | glosa | familia ; p_metric: tn | txd
CREATE OR REPLACE FUNCTION public.apt_pareto(p jsonb DEFAULT '{}'::jsonb, p_dim text DEFAULT 'lote', p_metric text DEFAULT 'tn')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
END $$;

-- Mapa de calor: TN de saldo por dimensión × rango de aging. p_dim: lote | producto | familia | glosa
CREATE OR REPLACE FUNCTION public.apt_heatmap(p jsonb DEFAULT '{}'::jsonb, p_dim text DEFAULT 'lote', p_top integer DEFAULT 25)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
END $$;

-- FechaEntrega (independiente del aging): ingreso vs FechaEntrega, despacho vs FechaEntrega y saldo pasado de su FechaEntrega
CREATE OR REPLACE FUNCTION public.apt_fecha_entrega(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
END $$;

-- Opciones para los filtros
CREATE OR REPLACE FUNCTION public.apt_filter_options()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  RETURN jsonb_build_object('success', true,
    'lotes', (SELECT COALESCE(jsonb_agg(jsonb_build_object('lote', lote, 'tipo', public.apt_lote_tipo(lote), 'tn_saldo', round(kg / 1000, 3)) ORDER BY lote), '[]')
              FROM (SELECT lote, sum(kg_saldo) AS kg FROM public.apt_layers GROUP BY lote) z),
    'contratos', (SELECT COALESCE(jsonb_agg(c ORDER BY c), '[]') FROM (SELECT DISTINCT split_part(lote, '-', 1) AS c FROM public.apt_layers) z),
    'familias', (SELECT COALESCE(jsonb_agg(jsonb_build_object('familia', familia, 'tn_saldo', round(kg / 1000, 3)) ORDER BY kg DESC), '[]')
                 FROM (SELECT COALESCE(familia, '(sin glosa)') AS familia, sum(kg_saldo) AS kg FROM public.apt_layers GROUP BY 1) z),
    'docrels', (SELECT COALESCE(jsonb_agg(DISTINCT docrel), '[]') FROM public.apt_layers WHERE docrel IS NOT NULL),
    'estados', '["En APT","Salida parcial","Despachado","Sin salida identificada","Problema de información"]'::jsonb,
    'rangos', (SELECT jsonb_agg(label ORDER BY desde) FROM public.apt_aging_ranges),
    'fechas', (SELECT jsonb_build_object('ingreso_min', min(fecha_ingreso), 'ingreso_max', max(fecha_ingreso),
                 'entrega_min', min(fecha_entrega), 'entrega_max', max(fecha_entrega)) FROM public.apt_layers),
    'state', (SELECT to_jsonb(st) - 'id' FROM public.apt_state st WHERE id = 1));
END $$;

-- Control de calidad y conciliación fuente vs modelo
CREATE OR REPLACE FUNCTION public.apt_quality()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
END $$;

-- Permisos de ejecución
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'apt_can_view()', 'apt_can_load()', 'apt_upload_begin(text)', 'apt_upload_rows(uuid, text, jsonb)', 'apt_upload_apply(uuid, boolean)', 'apt_model_rebuild()',
    'apt_upload_discard(uuid)', 'apt_get_settings()', 'apt_save_settings(jsonb)', 'apt_trends(jsonb, text)', 'apt_dashboard(jsonb, text)',
    'apt_detail(jsonb, text, text, boolean, integer, integer)', 'apt_lote(text)', 'apt_pareto(jsonb, text, text)', 'apt_heatmap(jsonb, text, integer)',
    'apt_fecha_entrega(jsonb)', 'apt_filter_options()', 'apt_quality()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['apt_rebuild()', 'apt_filtered(jsonb)', 'apt_group(jsonb, text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;

COMMIT;
