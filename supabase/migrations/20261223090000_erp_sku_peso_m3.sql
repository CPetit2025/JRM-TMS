-- ============================================================
-- ERP · Catálogo por SKU: último peso conocido y m³ por medidas
-- ============================================================
-- 1. Peso: el Stock del ERP solo trae los SKU que hoy están en bodega; cuando un SKU queda en 0 su peso se perdía. El
--    catálogo guarda el último Peso_Unitario de cada SKU de cualquier Stock cargado y las líneas del Actualizable lo usan
--    (si no, el del inventario, como antes).
-- 2. m³: largo × ancho × alto por unidad (envolvente de la pieza, para el espacio en la unidad de transporte) leídos de la
--    descripción y del código (el último tramo del código es el largo en mm). Solo cuenta si la densidad que resulta con
--    el peso cuadra (50–7.900 kg/m³; el acero es 7.850) y el SKU es por unidad: la descripción es texto libre.
--    Con él se completa el volumen de cada OT (como el peso: sin pisar uno escrito a mano) y Cubicaje sugiere la densidad
--    de cada familia.
-- De tablas existentes solo se leen columnas creadas por migraciones del ERP ya desplegadas; contracts.total_volume_m3
-- se usa solo si existe (0 = sin dato, valor por defecto en producción).
BEGIN;
SET LOCAL lock_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.erp_sku_medidas (
  cod_producto  text PRIMARY KEY,
  producto      text,
  familia       text,
  unidad_und    boolean NOT NULL DEFAULT true,
  peso_unit     numeric(20,6),
  peso_at       timestamptz,
  medidas_de    text,  -- descripción con la que se leyeron las medidas (se recalculan si cambia)
  largo_m       numeric(14,6),
  ancho_m       numeric(14,6),
  alto_m        numeric(14,6),
  m3_unit       numeric(24,9),
  kg_m3         numeric(16,2),
  m3_confiable  boolean NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS erp_sku_medidas_familia_idx ON public.erp_sku_medidas (familia) WHERE m3_confiable;
ALTER TABLE public.erp_sku_medidas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.erp_sku_medidas;
CREATE POLICY security_active_account ON public.erp_sku_medidas AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.erp_sku_medidas FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.erp_contract_volumenes (
  contract_id    uuid PRIMARY KEY REFERENCES public.contracts(id) ON DELETE CASCADE,
  m3             numeric(20,3) NOT NULL,
  lineas         integer NOT NULL,
  lineas_sin_m3  integer NOT NULL,
  import_id      uuid REFERENCES public.erp_imports(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS erp_contract_volumenes_import_idx ON public.erp_contract_volumenes (import_id);
ALTER TABLE public.erp_contract_volumenes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.erp_contract_volumenes;
CREATE POLICY security_active_account ON public.erp_contract_volumenes AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.erp_contract_volumenes FROM PUBLIC, anon, authenticated;

-- Medidas en metros {largo, ancho, alto} de un producto. Lee números con unidad (mm, cm, m, ") y cadenas «a x b x c»:
-- en una cadena sin unidad propia rige la del último número, salvo que en metros dé piezas de 20 m o más (entonces los
-- demás van en mm: «200x300x6.0 x 9.702M»); enteros ≤ 12 ante un espesor en mm son pulgadas («5 X 3 X 4.5MM»), igual que
-- una cadena sin ninguna unidad con números ≤ 12 («3 X 3»).
-- Números sueltos sin unidad (colores, calibres) se ignoran. Largo: el del código si es ≥ 0,1 m; si no, la mayor medida.
CREATE OR REPLACE FUNCTION public.erp_medidas_texto(p_cod text, p_txt text)
RETURNS numeric[] LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
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
END $$;

-- Peso unitario de las líneas del Actualizable: catálogo (último Stock con ese SKU) o inventario. Al final, medidas y m³
-- del catálogo con la densidad comprobada contra el mejor peso conocido.
CREATE OR REPLACE FUNCTION public.erp_refresh_peso()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); v_s uuid := public.erp_active_import('STOCK');
BEGIN
  IF v_s IS NOT NULL THEN
    INSERT INTO public.erp_sku_medidas (cod_producto, peso_unit, peso_at)
    SELECT cod_producto, max(peso_unitario), now() FROM public.erp_stock_lots
    WHERE import_id = v_s AND peso_unitario > 0 GROUP BY cod_producto
    ON CONFLICT (cod_producto) DO UPDATE SET peso_unit = EXCLUDED.peso_unit, peso_at = EXCLUDED.peso_at, updated_at = now()
    WHERE public.erp_sku_medidas.peso_unit IS DISTINCT FROM EXCLUDED.peso_unit;
  END IF;

  INSERT INTO public.erp_sku_medidas AS s (cod_producto, producto, familia, unidad_und)
  SELECT cod_producto, max(producto), max(NULLIF(btrim(familia), '')), bool_and(COALESCE(upper(btrim(unidad)), 'UND') IN ('UND', 'UNID'))
  FROM (SELECT cod_producto, producto, familia, unidad FROM public.erp_contract_lines WHERE import_id = v_c
        UNION ALL SELECT cod_producto, producto, familia, unidad FROM public.erp_stock_lots WHERE import_id = v_s) x
  WHERE NULLIF(btrim(producto), '') IS NOT NULL GROUP BY cod_producto
  ON CONFLICT (cod_producto) DO UPDATE SET producto = EXCLUDED.producto, familia = COALESCE(EXCLUDED.familia, s.familia),
    unidad_und = EXCLUDED.unidad_und, updated_at = now()
  WHERE (s.producto, s.familia, s.unidad_und) IS DISTINCT FROM (EXCLUDED.producto, COALESCE(EXCLUDED.familia, s.familia), EXCLUDED.unidad_und);

  UPDATE public.erp_sku_medidas s SET medidas_de = s.producto, largo_m = z.d[1], ancho_m = z.d[2], alto_m = z.d[3], updated_at = now()
  FROM (SELECT cod_producto, public.erp_medidas_texto(cod_producto, producto) AS d FROM public.erp_sku_medidas
        WHERE producto IS DISTINCT FROM medidas_de) z
  WHERE s.cod_producto = z.cod_producto;

  IF v_c IS NOT NULL THEN
    EXECUTE $q$
    WITH skus AS MATERIALIZED (SELECT DISTINCT cod_producto FROM public.erp_contract_lines WHERE import_id = $1),
    cat AS (SELECT cod_producto, peso_unit AS pu FROM public.erp_sku_medidas WHERE peso_unit > 0 AND cod_producto IN (SELECT cod_producto FROM skus)),
    mv AS (SELECT m.producto AS cod_producto, max(m.peso_unit) AS pu FROM public.inv_movements m
           WHERE m.active AND m.peso_unit > 0 AND m.producto IN (SELECT cod_producto FROM skus) GROUP BY m.producto)
    UPDATE public.erp_contract_lines l SET peso_unit = COALESCE(cat.pu, mv.pu)
    FROM skus LEFT JOIN cat USING (cod_producto) LEFT JOIN mv USING (cod_producto)
    WHERE l.import_id = $1 AND l.cod_producto = skus.cod_producto AND l.peso_unit IS DISTINCT FROM COALESCE(cat.pu, mv.pu)$q$ USING v_c;
  END IF;

  WITH lp AS (SELECT cod_producto, max(peso_unit) AS pu FROM public.erp_contract_lines WHERE import_id = v_c AND peso_unit > 0 GROUP BY cod_producto),
  x AS (SELECT s.cod_producto, round(s.largo_m * s.ancho_m * s.alto_m, 9) AS m3, COALESCE(s.peso_unit, lp.pu) AS pu, s.unidad_und
        FROM public.erp_sku_medidas s LEFT JOIN lp USING (cod_producto)),
  y AS (SELECT cod_producto, m3, round(least(pu / NULLIF(m3, 0), 99999999999999), 2) AS den, unidad_und FROM x)
  UPDATE public.erp_sku_medidas s SET m3_unit = y.m3, kg_m3 = y.den,
    m3_confiable = COALESCE(y.unidad_und AND y.m3 > 0 AND y.den BETWEEN 50 AND 7900, false), updated_at = now()
  FROM y
  WHERE s.cod_producto = y.cod_producto
    AND (s.m3_unit, s.kg_m3, s.m3_confiable) IS DISTINCT FROM (y.m3, y.den, COALESCE(y.unidad_und AND y.m3 > 0 AND y.den BETWEEN 50 AND 7900, false));
END $$;
REVOKE ALL ON FUNCTION public.erp_refresh_peso() FROM PUBLIC, anon, authenticated;

-- Peso (sin cambios) y volumen de cada OT desde el Actualizable. Volumen: suma de cantidad del contrato × m³ por unidad
-- de las líneas con m³ confiable (sin servicios); se carga en contracts.total_volume_m3 cuando el TMS no tiene volumen
-- (vacío o 0) o el que tiene vino del ERP; uno escrito a mano no se pisa. Registro en erp_contract_volumenes.
CREATE OR REPLACE FUNCTION public.erp_contratos_pesos_core()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); n_upd integer := 0; n_manual integer := 0; n_parcial integer := 0;
  v_vol jsonb := NULL; nv_upd integer := 0; nv_manual integer := 0; nv_parcial integer := 0;
BEGIN
  IF v_c IS NULL THEN RETURN jsonb_build_object('success', true, 'sin_datos', true); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contracts'
                 AND column_name = 'total_weight_kg') THEN
    RETURN jsonb_build_object('success', true, 'sin_columna', true);
  END IF;
  CREATE TEMP TABLE IF NOT EXISTS erp_tmp_peso (id uuid, kg numeric, lineas integer, sin integer, actual numeric, anterior numeric) ON COMMIT DROP;
  TRUNCATE erp_tmp_peso;
  INSERT INTO erp_tmp_peso
  WITH d AS (
    SELECT public.erp_doc_key(l.nro_documento) AS dk,
      sum(l.cant_contrato * l.peso_unit) FILTER (WHERE l.peso_unit > 0 AND NOT l.cantidades_ausentes) AS kg,
      count(*)::integer AS lineas,
      count(*) FILTER (WHERE COALESCE(l.peso_unit, 0) <= 0 OR l.cantidades_ausentes)::integer AS sin
    FROM public.erp_contract_lines l WHERE l.import_id = v_c GROUP BY 1)
  SELECT c.id, round(d.kg, 2), d.lineas, d.sin, NULLIF(to_jsonb(c)->>'total_weight_kg', '')::numeric, p.kg
  FROM public.contracts c JOIN d ON d.dk = public.erp_doc_key(c.code)
  LEFT JOIN public.erp_contract_pesos p ON p.contract_id = c.id
  WHERE d.kg > 0;

  -- Solo donde el peso es del ERP: vacío, 0 o igual al último que se cargó desde el ERP
  DELETE FROM erp_tmp_peso t WHERE NOT (COALESCE(t.actual, 0) = 0 OR t.actual IS NOT DISTINCT FROM t.anterior);
  GET DIAGNOSTICS n_manual = ROW_COUNT;
  EXECUTE 'UPDATE public.contracts c SET total_weight_kg = t.kg FROM erp_tmp_peso t
           WHERE c.id = t.id AND c.total_weight_kg IS DISTINCT FROM t.kg';
  GET DIAGNOSTICS n_upd = ROW_COUNT;
  INSERT INTO public.erp_contract_pesos (contract_id, kg, lineas, lineas_sin_peso, import_id, updated_at)
  SELECT t.id, t.kg, t.lineas, t.sin, v_c, now() FROM erp_tmp_peso t
  ON CONFLICT (contract_id) DO UPDATE SET kg = EXCLUDED.kg, lineas = EXCLUDED.lineas, lineas_sin_peso = EXCLUDED.lineas_sin_peso,
    import_id = EXCLUDED.import_id, updated_at = EXCLUDED.updated_at;
  SELECT count(*) INTO n_parcial FROM erp_tmp_peso t WHERE t.sin > 0;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contracts'
             AND column_name = 'total_volume_m3') THEN
    CREATE TEMP TABLE IF NOT EXISTS erp_tmp_vol (id uuid, m3 numeric, lineas integer, sin integer, actual numeric, anterior numeric) ON COMMIT DROP;
    TRUNCATE erp_tmp_vol;
    INSERT INTO erp_tmp_vol
    WITH d AS (
      SELECT public.erp_doc_key(l.nro_documento) AS dk,
        sum(l.cant_contrato * s.m3_unit) FILTER (WHERE s.m3_confiable AND NOT l.cantidades_ausentes) AS m3,
        count(*)::integer AS lineas,
        count(*) FILTER (WHERE s.m3_confiable IS NOT TRUE OR l.cantidades_ausentes)::integer AS sin
      FROM public.erp_contract_lines l LEFT JOIN public.erp_sku_medidas s ON s.cod_producto = l.cod_producto
      WHERE l.import_id = v_c AND COALESCE(l.tipo_producto, '') <> 'SERVICIO A TERCEROS' GROUP BY 1)
    SELECT c.id, round(d.m3, 2), d.lineas, d.sin, NULLIF(to_jsonb(c)->>'total_volume_m3', '')::numeric, p.m3
    FROM public.contracts c JOIN d ON d.dk = public.erp_doc_key(c.code)
    LEFT JOIN public.erp_contract_volumenes p ON p.contract_id = c.id
    WHERE round(d.m3, 2) > 0 AND d.m3 < 10000000;  -- total_volume_m3 es DECIMAL(10,2) en producción
    DELETE FROM erp_tmp_vol t WHERE NOT (COALESCE(t.actual, 0) = 0 OR t.actual IS NOT DISTINCT FROM round(t.anterior, 2));
    GET DIAGNOSTICS nv_manual = ROW_COUNT;
    EXECUTE 'UPDATE public.contracts c SET total_volume_m3 = t.m3 FROM erp_tmp_vol t
             WHERE c.id = t.id AND c.total_volume_m3 IS DISTINCT FROM t.m3';
    GET DIAGNOSTICS nv_upd = ROW_COUNT;
    INSERT INTO public.erp_contract_volumenes (contract_id, m3, lineas, lineas_sin_m3, import_id, updated_at)
    SELECT t.id, t.m3, t.lineas, t.sin, v_c, now() FROM erp_tmp_vol t
    ON CONFLICT (contract_id) DO UPDATE SET m3 = EXCLUDED.m3, lineas = EXCLUDED.lineas, lineas_sin_m3 = EXCLUDED.lineas_sin_m3,
      import_id = EXCLUDED.import_id, updated_at = EXCLUDED.updated_at;
    SELECT count(*) INTO nv_parcial FROM erp_tmp_vol t WHERE t.sin > 0;
    v_vol := jsonb_build_object('actualizadas', nv_upd, 'con_volumen_erp', (SELECT count(*) FROM erp_tmp_vol), 'parciales', nv_parcial,
      'manuales_conservadas', nv_manual);
  END IF;
  RETURN jsonb_build_object('success', true, 'actualizadas', n_upd, 'con_peso_erp', (SELECT count(*) FROM erp_tmp_peso),
    'parciales', n_parcial, 'manuales_conservadas', n_manual, 'volumen', v_vol);
END $$;
REVOKE ALL ON FUNCTION public.erp_contratos_pesos_core() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erp_contratos_pesos_core() TO service_role;

-- Cubicaje: además de lo configurado, la densidad sugerida de cada familia (mediana de los SKU con m³ confiable)
CREATE OR REPLACE FUNCTION public.cubicaje_familias_lista()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_s uuid := public.erp_active_import('STOCK'); v_c uuid := public.erp_active_import('CONTRATOS'); v_out jsonb;
BEGIN
  IF NOT public.erp_ref_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a Programación y Ruteo'); END IF;
  WITH st AS (SELECT btrim(familia) AS familia, sum(kg) AS kg FROM public.erp_stock_lots
              WHERE import_id = v_s AND NULLIF(btrim(familia), '') IS NOT NULL GROUP BY 1),
  ct AS (SELECT DISTINCT btrim(familia) AS familia FROM public.erp_contract_lines
         WHERE import_id = v_c AND NULLIF(btrim(familia), '') IS NOT NULL),
  sg AS (SELECT familia, round(percentile_cont(0.5) WITHIN GROUP (ORDER BY kg_m3)::numeric, 0) AS sugerido, count(*) AS skus
         FROM public.erp_sku_medidas WHERE m3_confiable AND familia IS NOT NULL GROUP BY 1),
  f AS (SELECT familia FROM public.cubicaje_familias UNION SELECT familia FROM st UNION SELECT familia FROM ct)
  SELECT jsonb_build_object('success', true, 'puede_editar', public.has_tms_permission('despacho'),
    'familias', COALESCE(jsonb_agg(jsonb_build_object('familia', f.familia, 'kg_por_m3', c.kg_por_m3, 'notas', c.notas,
        'updated_at', c.updated_at, 'kg_stock', round(COALESCE(st.kg, 0), 1),
        'en_erp', st.familia IS NOT NULL OR EXISTS (SELECT 1 FROM ct WHERE ct.familia = f.familia),
        'kg_por_m3_sugerido', sg.sugerido, 'skus_medidos', COALESCE(sg.skus, 0))
      ORDER BY COALESCE(st.kg, 0) DESC, f.familia), '[]'::jsonb))
  INTO v_out
  FROM f LEFT JOIN public.cubicaje_familias c ON c.familia = f.familia LEFT JOIN st ON st.familia = f.familia
  LEFT JOIN sg ON sg.familia = f.familia;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.cubicaje_familias_lista() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cubicaje_familias_lista() TO authenticated;

-- Catálogo inicial con lo que ya está cargado
SELECT public.erp_refresh_peso();
SELECT public.erp_contratos_pesos_core();

COMMIT;
