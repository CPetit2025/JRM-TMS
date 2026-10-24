-- ERP como única fuente: los dos Excel (Actualizable Despacho y Stock Bodega Despacho) generan los movimientos que
-- antes venían del reporte de Entradas y Salidas (DATA). Cada día se compara el stock por bodega, producto y lote
-- (647-04 ALM PT, 540-04 APT LB y ST-VENTAS-IMD) con el del día anterior y se toman las guías nuevas:
--   * guía nueva del Actualizable        → salida por despacho (con su fecha del ERP, entre el día base y el corte);
--   * lote que baja en una bodega y sube en otra → traspaso (mismo número a ambos lados);
--   * lote que sube sin traspaso         → ingreso (producción en 647, ingreso en las demás);
--   * lote que baja sin guía ni traspaso → ajuste.
-- El navegador arma con esas filas un archivo de Entradas y Salidas del día y lo carga por el mismo camino que el DATA
-- (inventario, APT clásico, Analítica y peso de servicios). La primera vez la base es el inventario calculado con el
-- DATA ya cargado; después, el stock del último día derivado. Una bodega que no viene en el Stock no se toca.
BEGIN;

CREATE TABLE IF NOT EXISTS public.erp_derive_days (
  fecha            date PRIMARY KEY,
  base_fecha       date NOT NULL,
  base_fuente      text NOT NULL CHECK (base_fuente IN ('DATA', 'ERP', 'VACIA')),
  stock_import     uuid,
  contratos_import uuid,
  bodegas          text[] NOT NULL DEFAULT '{}',
  resumen          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.erp_derive_stock (
  fecha    date NOT NULL REFERENCES public.erp_derive_days(fecha) ON DELETE CASCADE,
  bodega   text NOT NULL,
  producto text NOT NULL,
  lote     text NOT NULL,
  cantidad numeric(20,6) NOT NULL,
  PRIMARY KEY (fecha, bodega, producto, lote)
);
CREATE TABLE IF NOT EXISTS public.erp_derive_guias (
  guia_key  text NOT NULL,
  producto  text NOT NULL,
  documento text NOT NULL,
  dia       date NOT NULL REFERENCES public.erp_derive_days(fecha) ON DELETE CASCADE,
  fecha     date NOT NULL,
  bodega    text NOT NULL,
  cantidad  numeric(20,6) NOT NULL,
  PRIMARY KEY (guia_key, producto, documento)
);
CREATE INDEX IF NOT EXISTS erp_derive_guias_dia_idx ON public.erp_derive_guias (dia);

REVOKE ALL ON public.erp_derive_days FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.erp_derive_stock FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.erp_derive_guias FROM PUBLIC, anon, authenticated;
ALTER TABLE public.erp_derive_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_derive_stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_derive_guias ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.erp_derive_days;
CREATE POLICY security_active_account ON public.erp_derive_days AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.erp_derive_stock;
CREATE POLICY security_active_account ON public.erp_derive_stock AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.erp_derive_guias;
CREATE POLICY security_active_account ON public.erp_derive_guias AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));

-- Tipos de documento de los movimientos derivados (el despacho y el traspaso usan los del ERP)
INSERT INTO public.inv_doc_types (tipodocto, clase, auto) VALUES
  ('INGRESO ERP (DERIVADO)', 'COMPRA', false), ('AJUSTE ERP (DERIVADO)', 'AJUSTE', false)
ON CONFLICT (tipodocto) DO NOTHING;

CREATE OR REPLACE FUNCTION public.erp_bodega(p text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT NULLIF(regexp_replace(upper(btrim(COALESCE(p, ''))), '\s+', ' ', 'g'), '');
$$;

-- Calcula los movimientos del día del corte del Stock vigente. p_commit = false: solo devuelve las filas (para cargarlas);
-- true: además guarda el stock del día y las guías tomadas, que serán la base del día siguiente.
-- Lo ejecuta el servidor (/api/erp/aplicar, sin el límite de 8 s) tras verificar el permiso; erp_derive es el respaldo.
CREATE OR REPLACE FUNCTION public.erp_derive_core(p_commit boolean, p_user uuid, p_resumen jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
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
    (SELECT max(s.factor) FROM public.erp_stock_lots s WHERE s.import_id = v_s AND s.cod_producto = d_g.producto), 1);
  UPDATE d_g SET bodega = COALESCE(
    (SELECT b.bodega FROM d_base b LEFT JOIN d_new n USING (bodega, producto, lote)
      WHERE b.producto = d_g.producto AND b.lote = d_g.lote AND b.qty - COALESCE(n.qty, 0) > 0 ORDER BY b.qty - COALESCE(n.qty, 0) DESC LIMIT 1),
    (SELECT b.bodega FROM d_base b WHERE b.producto = d_g.producto AND b.lote = d_g.lote ORDER BY b.qty DESC LIMIT 1),
    CASE WHEN '647-04 ALM PT' = ANY (v_bodegas) THEN '647-04 ALM PT' ELSE v_bodegas[1] END);

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
                             - COALESCE((SELECT sum(qty) FROM d_tr t WHERE t.destino = x.bodega AND t.producto = x.producto AND t.lote = x.lote), 0);

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
END $$;
REVOKE ALL ON FUNCTION public.erp_derive_core(boolean, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erp_derive_core(boolean, uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.erp_derive(p_commit boolean DEFAULT false, p_resumen jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apt_can_load() THEN RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar datos del ERP'); END IF;
  RETURN public.erp_derive_core(p_commit, auth.uid(), p_resumen);
END $$;
REVOKE ALL ON FUNCTION public.erp_derive(boolean, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_derive(boolean, jsonb) TO authenticated;

-- Historial de días derivados (para la pantalla de carga)
CREATE OR REPLACE FUNCTION public.erp_derive_estado()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso'); END IF;
  RETURN jsonb_build_object('success', true,
    'dias', COALESCE((SELECT jsonb_agg(jsonb_build_object('fecha', fecha, 'base_fecha', base_fecha, 'base_fuente', base_fuente, 'resumen', resumen, 'created_at', created_at,
        'es_base', resumen ? 'base')
      ORDER BY fecha DESC) FROM (SELECT * FROM public.erp_derive_days ORDER BY fecha DESC LIMIT 30) d), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.erp_derive_estado() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_derive_estado() TO authenticated;

COMMIT;
