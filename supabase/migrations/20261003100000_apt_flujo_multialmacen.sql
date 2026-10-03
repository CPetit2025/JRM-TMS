-- ============================================================
-- APT — Flujo multi-almacén: 647 (ingreso de producción) · 540 (stock antiguo / adelantos IPT) · ST VENTAS (por guiar)
-- ============================================================
-- Nuevas hojas de carga (además de ENTRADA y SALIDA), cada una con su propio reemplazo por fechas:
--  * TRASPASO_SAL: lado origen de los traspasos (cantidad negativa) · TRASPASO_ENT: lado destino (cantidad positiva).
--    Se emparejan por tipo de documento, número, producto y cantidad. Solo se guardan filas de 647, 540 y ST VENTAS:
--    un origen sin destino APT es una salida a otro almacén; un destino sin origen APT, un ingreso desde otro almacén.
--  * CONSUMO: vales de consumo (V/C activos, V/C producción) y otras salidas de los almacenes APT que no son despacho.
--  * DEVOLUCION: guías de recojo y otros ingresos a los almacenes APT que no son producción ni traspaso.
-- Modelo encadenado (apt_flow_rebuild):
--  * FIFO por almacén y Lote|Producto ordenado por fecha de llegada al almacén (en un mismo día, ingresos antes que salidas).
--  * Stock inicial: lo mínimo que debió existir antes del periodo para que el saldo nunca sea negativo; es la capa más
--    antigua del almacén (sin fecha conocida) y se consume primero.
--  * Un traspaso consume capas del origen y crea una capa en el destino con el lote de destino (asignación de contrato o
--    reasignación de OT). La composición de cada capa se expresa en sus capas raíz (producción, stock inicial,
--    devolución u otro almacén), con su fecha de producción: así cada guía sabe de qué producción viene y cuánto estuvo
--    en cada etapa.
-- El modelo de estadía existente (apt_layers) no cambia: sigue siendo la vista consolidada del APT.
BEGIN;

-- ------------------------------------------------------------
-- 1. Nuevos tipos de movimiento y almacén normalizado
-- ------------------------------------------------------------
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'public.apt_movements'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%kind%' LOOP
    EXECUTE format('ALTER TABLE public.apt_movements DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE public.apt_movements ADD CONSTRAINT apt_movements_kind_check
  CHECK (kind IN ('ENTRADA', 'SALIDA', 'TRASPASO_SAL', 'TRASPASO_ENT', 'CONSUMO', 'DEVOLUCION'));
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS almacen text;
ALTER TABLE public.apt_movements ADD COLUMN IF NOT EXISTS contrato text;

-- 647-04 ALM PT → 647 · 540-04 APT LB / APT.MAT.CONFO → 540 · ST-VENTAS-IMD → ST. Cualquier otra bodega no es APT.
CREATE OR REPLACE FUNCTION public.apt_almacen(p_bodega text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN upper(btrim(p_bodega)) ~ '^647-04\s' THEN '647'
              WHEN upper(btrim(p_bodega)) ~ '^540-04' THEN '540'
              WHEN upper(btrim(p_bodega)) ~ '^ST-VENTAS' THEN 'ST' END;
$$;

UPDATE public.apt_movements SET almacen = public.apt_almacen(bodega)
WHERE almacen IS DISTINCT FROM public.apt_almacen(bodega);
UPDATE public.apt_movements SET contrato = public.apt_txt(raw -> 'Contrato')
WHERE contrato IS NULL AND raw ? 'Contrato' AND public.apt_txt(raw -> 'Contrato') IS NOT NULL;
CREATE INDEX IF NOT EXISTS apt_movements_kind_alm_idx ON public.apt_movements (kind, almacen) WHERE active AND valid;

-- ------------------------------------------------------------
-- 2. Carga: nuevas hojas
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apt_upload_rows(p_upload_id uuid, p_kind text, p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
      upper(public.apt_str(x.r -> 'UNIDAD')) AS unidad,
      public.apt_txt(x.r -> 'Contrato') AS contrato) n
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
      WHEN p_kind NOT IN ('ENTRADA', 'SALIDA') AND public.apt_almacen(n.bodega) IS NULL THEN 'Fuera de los almacenes APT (647, 540, ST VENTAS)'
      WHEN p_kind NOT IN ('ENTRADA', 'SALIDA') AND l.lote IS NULL THEN 'Sin Lote ni Contrato'
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
END $$;


-- ------------------------------------------------------------
-- 3. Cobertura de fechas para todas las hojas
-- ------------------------------------------------------------
-- ENTRADA y SALIDA siempre se informan; las demás hojas solo si alguna vez se cargaron o vienen en la vista previa.
-- Además de los huecos de cada hoja, avisa cuando las hojas que se cruzan llegan a fechas distintas:
-- ENTRADA ↔ SALIDA, salidas ↔ entradas de traspasos, y traspasos ↔ ENTRADA/SALIDA.
CREATE OR REPLACE FUNCTION public.apt_coverage(p_preview jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
END $$;

-- ------------------------------------------------------------
-- 4. Modelo encadenado multi-almacén
-- ------------------------------------------------------------
-- Capas de ingreso a cada almacén (producción, traspaso recibido, devolución, ingreso desde otro almacén y stock inicial)
CREATE TABLE IF NOT EXISTS public.apt_flow_layers (
  id              bigint PRIMARY KEY,           -- id del movimiento que ingresa; negativo para el stock inicial
  almacen         text NOT NULL,
  lote            text NOT NULL,
  producto        text NOT NULL,
  tipo            text NOT NULL CHECK (tipo IN ('PRODUCCION', 'TRASPASO', 'DEVOLUCION', 'OTRO_ALMACEN', 'INICIAL')),
  exit_id         bigint,                       -- traspaso: salida del almacén de origen que lo originó
  almacen_origen  text,
  lote_origen     text,
  fecha           date,                         -- llegada al almacén (NULL en stock inicial)
  documento       text,
  glosa           text,
  cliente         text,                         -- cliente del lote (guías del lote o estadía consolidada)
  kg_in           numeric NOT NULL,
  kg_out          numeric NOT NULL DEFAULT 0,
  kg_saldo        numeric NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS apt_flow_layers_key_idx ON public.apt_flow_layers (almacen, lote, producto);
CREATE INDEX IF NOT EXISTS apt_flow_layers_lote_idx ON public.apt_flow_layers (lote);
CREATE INDEX IF NOT EXISTS apt_flow_layers_exit_idx ON public.apt_flow_layers (exit_id);

-- Salidas de cada almacén: traspaso, despacho (guía), consumo interno o salida a otro almacén
CREATE TABLE IF NOT EXISTS public.apt_flow_exits (
  id               bigint PRIMARY KEY,          -- id del movimiento
  almacen          text NOT NULL,
  lote             text NOT NULL,
  producto         text NOT NULL,
  tipo             text NOT NULL CHECK (tipo IN ('TRASPASO', 'DESPACHO', 'CONSUMO', 'OTRO_ALMACEN')),
  fecha            date NOT NULL,
  kg               numeric NOT NULL,
  almacen_destino  text,
  lote_destino     text,
  documento        text,
  cliente          text,
  numrel           text,
  docrel           text,
  glosa            text
);
CREATE INDEX IF NOT EXISTS apt_flow_exits_lote_idx ON public.apt_flow_exits (lote);
CREATE INDEX IF NOT EXISTS apt_flow_exits_doc_idx ON public.apt_flow_exits (documento);

CREATE TABLE IF NOT EXISTS public.apt_flow_alloc (
  layer_id  bigint NOT NULL,
  exit_id   bigint NOT NULL,
  kg        numeric NOT NULL,
  PRIMARY KEY (layer_id, exit_id)
);
CREATE INDEX IF NOT EXISTS apt_flow_alloc_exit_idx ON public.apt_flow_alloc (exit_id);

-- Composición de lo que salió del circuito (despacho, consumo, otro almacén) y del saldo, por capa raíz.
-- Desnormalizado para que las consultas no recorran la cadena.
CREATE TABLE IF NOT EXISTS public.apt_flow_pieces (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  es_saldo        boolean NOT NULL,
  exit_id         bigint,                       -- NULL en saldo
  salida_tipo     text,                         -- DESPACHO / CONSUMO / OTRO_ALMACEN
  fecha_salida    date,                         -- NULL en saldo
  documento       text,
  cliente         text,
  layer_id        bigint NOT NULL,              -- capa final (almacén donde estaba al salir o donde queda)
  almacen         text NOT NULL,
  layer_tipo      text NOT NULL,
  almacen_previo  text,                         -- origen del traspaso que trajo la capa final
  fecha_llegada   date,                         -- llegada al almacén final
  lote            text NOT NULL,
  producto        text NOT NULL,
  glosa           text,
  root_id         bigint NOT NULL,
  origen          text NOT NULL,                -- PRODUCCION, INICIAL_647, INICIAL_540, INICIAL_ST, DEVOLUCION, OTRO_ALMACEN
  root_almacen    text NOT NULL,
  root_lote       text NOT NULL,
  fecha_origen    date,                         -- producción / devolución / ingreso (NULL en stock inicial)
  kg              numeric NOT NULL
);
CREATE INDEX IF NOT EXISTS apt_flow_pieces_exit_idx ON public.apt_flow_pieces (exit_id);
CREATE INDEX IF NOT EXISTS apt_flow_pieces_lote_idx ON public.apt_flow_pieces (lote);
CREATE INDEX IF NOT EXISTS apt_flow_pieces_fecha_idx ON public.apt_flow_pieces (fecha_salida);

CREATE TABLE IF NOT EXISTS public.apt_flow_state (
  id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cutoff      date,
  data_min    date,
  rebuilt_at  timestamptz,
  stats       jsonb NOT NULL DEFAULT '{}'::jsonb
);
INSERT INTO public.apt_flow_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['apt_flow_layers', 'apt_flow_exits', 'apt_flow_alloc', 'apt_flow_pieces', 'apt_flow_state'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.apt_can_view())', t || '_select', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.apt_flow_rebuild_core()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_cut date; v_min date; v_stats jsonb; v_round integer := 0; v_n bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('apt_flow_rebuild'));
  SELECT min(fecha), COALESCE((SELECT cutoff_date FROM public.apt_settings WHERE id = 1), max(fecha))
    INTO v_min, v_cut FROM public.apt_movements WHERE active AND valid;

  DELETE FROM public.apt_flow_pieces WHERE true;
  DELETE FROM public.apt_flow_alloc WHERE true;
  DELETE FROM public.apt_flow_layers WHERE true;
  DELETE FROM public.apt_flow_exits WHERE true;
  IF v_cut IS NULL THEN
    UPDATE public.apt_flow_state SET cutoff = NULL, data_min = NULL, rebuilt_at = now(), stats = '{}' WHERE id = 1;
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
  UPDATE public.apt_flow_state SET cutoff = v_cut, data_min = v_min, rebuilt_at = now(), stats = v_stats WHERE id = 1;
  RETURN jsonb_build_object('success', true, 'cutoff', v_cut) || v_stats;
END $$;

CREATE OR REPLACE FUNCTION public.apt_flow_rebuild()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para recalcular el flujo multi-almacén');
  END IF;
  RETURN public.apt_flow_rebuild_core();
END $$;

-- ------------------------------------------------------------
-- 5. Consultas del flujo multi-almacén
-- ------------------------------------------------------------
-- Filtros comunes (p): desde, hasta (fecha del movimiento), clientes[], lote (contiene), ot (OT madre), almacen.
CREATE OR REPLACE FUNCTION public.apt_flow_match(p jsonb, p_lote text, p_cliente text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT (NULLIF(btrim(p ->> 'lote'), '') IS NULL OR p_lote ILIKE '%' || btrim(p ->> 'lote') || '%')
     AND (NULLIF(btrim(p ->> 'ot'), '') IS NULL OR split_part(p_lote, '-', 1) = upper(btrim(p ->> 'ot')))
     AND (jsonb_typeof(p -> 'clientes') IS DISTINCT FROM 'array' OR jsonb_array_length(p -> 'clientes') = 0
          OR COALESCE(p_cliente, '(Sin cliente identificado)') IN (SELECT jsonb_array_elements_text(p -> 'clientes')));
$$;

CREATE OR REPLACE FUNCTION public.apt_flow_range(p jsonb, OUT v_from date, OUT v_to date, OUT v_cut date, OUT v_min date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(public.apt_date(p -> 'desde'), s.data_min), COALESCE(public.apt_date(p -> 'hasta'), s.cutoff), s.cutoff, s.data_min
  FROM public.apt_flow_state s WHERE s.id = 1;
$$;

CREATE OR REPLACE FUNCTION public.apt_flow_tn(kg numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$ SELECT round(COALESCE(kg, 0) / 1000.0, 3) $$;

-- Datos del TMS de un conjunto de guías (guías registradas en el Asistente Documentario y su despacho)
CREATE OR REPLACE FUNCTION public.apt_flow_tms(p_docs text[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v jsonb := '{}'::jsonb;
BEGIN
  IF p_docs IS NULL OR cardinality(p_docs) = 0 OR to_regclass('public.dispatch_documents') IS NULL THEN RETURN v; END IF;
  EXECUTE $q$
    SELECT COALESCE(jsonb_object_agg(doc, info), '{}'::jsonb) FROM (
      SELECT DISTINCT ON (upper(dd.document_number)) upper(dd.document_number) AS doc, jsonb_build_object(
        'dispatch_id', d.id, 'numero', to_jsonb(d) ->> 'dispatch_number', 'estado', to_jsonb(d) ->> 'status',
        'programado', to_jsonb(d) ->> 'scheduled_date', 'salida', to_jsonb(d) ->> 'departure_time',
        'llegada', to_jsonb(d) ->> 'arrival_time', 'placa', to_jsonb(d) ->> 'vehicle_plate',
        'conductor', to_jsonb(d) ->> 'driver_name') AS info
      FROM public.dispatch_documents dd JOIN public.dispatches d ON d.id = dd.dispatch_id
      WHERE dd.voided_at IS NULL AND upper(dd.document_number) = ANY ($1)
      ORDER BY upper(dd.document_number), dd.uploaded_at DESC NULLS LAST) z $q$
  INTO v USING (SELECT array_agg(upper(btrim(x))) FROM unnest(p_docs) x);
  RETURN v;
EXCEPTION WHEN OTHERS THEN RETURN '{}'::jsonb;
END $$;

-- Tarjetas por almacén: saldo, stock inicial que queda, capas, lotes, edad desde la producción y días en el almacén
CREATE OR REPLACE FUNCTION public.apt_flow_cards(p jsonb, p_cut date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('almacen', a.almacen, 'saldo_tn', public.apt_flow_tn(a.kg), 'inicial_tn', public.apt_flow_tn(a.kg_ini),
           'capas', a.capas, 'lotes', a.lotes, 'edad_pond', a.edad, 'dias_almacen_pond', a.dias) ORDER BY a.o), '[]')
  FROM (SELECT almacen, CASE almacen WHEN '647' THEN 1 WHEN '540' THEN 2 ELSE 3 END AS o, sum(kg) AS kg,
               sum(kg) FILTER (WHERE origen LIKE 'INICIAL%') AS kg_ini, count(DISTINCT layer_id) AS capas, count(DISTINCT lote) AS lotes,
               round(sum(kg * (p_cut - fecha_origen)) FILTER (WHERE fecha_origen IS NOT NULL) / NULLIF(sum(kg) FILTER (WHERE fecha_origen IS NOT NULL), 0), 1) AS edad,
               round(sum(kg * (p_cut - fecha_llegada)) FILTER (WHERE fecha_llegada IS NOT NULL) / NULLIF(sum(kg) FILTER (WHERE fecha_llegada IS NOT NULL), 0), 1) AS dias
        FROM public.apt_flow_pieces WHERE es_saldo AND public.apt_flow_match(p, lote, cliente) GROUP BY 1) a;
$$;

-- Resumen: KPIs del circuito, flujos entre etapas y origen mensual de lo despachado
CREATE OR REPLACE FUNCTION public.apt_flow_summary(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
END $$;

-- Stock por almacén: tarjetas, antigüedad, evolución semanal, movimientos mensuales y lotes con saldo
CREATE OR REPLACE FUNCTION public.apt_flow_stock(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
    'resumen', public.apt_flow_cards(p, r.v_cut), 'aging', v_aging, 'serie', v_serie, 'movimientos', v_mov, 'lotes', v_lotes);
END $$;

-- Tiempos por etapa de lo despachado con trazabilidad completa (producción → … → guía)
-- p_dim: cliente | ot | lote | familia | ruta
CREATE OR REPLACE FUNCTION public.apt_flow_leadtime(p jsonb DEFAULT '{}'::jsonb, p_dim text DEFAULT 'cliente')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
END $$;

-- ST VENTAS: velocidad de guiado, saldo detenido y retornos
CREATE OR REPLACE FUNCTION public.apt_flow_st(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
END $$;

-- Adelantos y 540: asignación de contrato en el traspaso, reasignación de OT, movimientos y saldo de 540, consumos internos
CREATE OR REPLACE FUNCTION public.apt_flow_adelantos(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
END $$;

-- Trazabilidad: una guía (de qué producción viene cada kg y cuánto estuvo en cada etapa) o un lote (línea de tiempo)
CREATE OR REPLACE FUNCTION public.apt_flow_trace(p_q text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
END $$;

-- Calidad del flujo: emparejamiento de traspasos, stock inicial, cuadre por almacén y alertas
CREATE OR REPLACE FUNCTION public.apt_flow_quality()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['apt_flow_summary(jsonb)', 'apt_flow_stock(jsonb)', 'apt_flow_leadtime(jsonb, text)', 'apt_flow_st(jsonb)',
                           'apt_flow_adelantos(jsonb)', 'apt_flow_trace(text)', 'apt_flow_quality()', 'apt_flow_rebuild()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['apt_flow_rebuild_core()', 'apt_flow_tms(text[])', 'apt_flow_range(jsonb)', 'apt_flow_cards(jsonb, date)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;

-- Primer cálculo del flujo con lo ya cargado (ENTRADA y SALIDA); los traspasos llegan con las próximas cargas
SELECT public.apt_flow_rebuild_core();

COMMIT;
