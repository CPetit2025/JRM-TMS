-- Cubicaje por familia de producto (sin LPN). Cada familia del ERP tiene una densidad de carga (kg por m³) que define
-- Programación y Ruteo; con ella el peso «listo» de cada OT (pendiente con stock en la foto del ERP) se convierte en m³
-- para comparar con la capacidad de la unidad. El LPN (pallet o bulto estándar por familia) queda pendiente.
-- Solo se agrega una tabla nueva; de tablas existentes se leen columnas ya creadas por migraciones desplegadas del ERP.
BEGIN;

CREATE TABLE IF NOT EXISTS public.cubicaje_familias (
  familia    text PRIMARY KEY CHECK (btrim(familia) <> ''),
  kg_por_m3  numeric(12,2) CHECK (kg_por_m3 IS NULL OR kg_por_m3 > 0),
  notas      text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
ALTER TABLE public.cubicaje_familias ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.cubicaje_familias;
CREATE POLICY security_active_account ON public.cubicaje_familias AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
-- Lectura y escritura solo por las funciones de abajo
REVOKE ALL ON public.cubicaje_familias FROM PUBLIC, anon, authenticated;

-- Familias que hoy existen en el ERP (stock y Actualizable vigentes), sin densidad hasta que se configure
INSERT INTO public.cubicaje_familias (familia)
SELECT DISTINCT btrim(f) FROM (
  SELECT familia AS f FROM public.erp_stock_lots WHERE import_id = public.erp_active_import('STOCK')
  UNION SELECT familia FROM public.erp_contract_lines WHERE import_id = public.erp_active_import('CONTRATOS')) x
WHERE NULLIF(btrim(f), '') IS NOT NULL
ON CONFLICT (familia) DO NOTHING;

-- Catálogo: familias configuradas y las que aparecen en el ERP vigente, con su peso en stock como referencia
CREATE OR REPLACE FUNCTION public.cubicaje_familias_lista()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_s uuid := public.erp_active_import('STOCK'); v_c uuid := public.erp_active_import('CONTRATOS'); v_out jsonb;
BEGIN
  IF NOT public.erp_ref_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a Programación y Ruteo'); END IF;
  WITH st AS (SELECT btrim(familia) AS familia, sum(kg) AS kg FROM public.erp_stock_lots
              WHERE import_id = v_s AND NULLIF(btrim(familia), '') IS NOT NULL GROUP BY 1),
  ct AS (SELECT DISTINCT btrim(familia) AS familia FROM public.erp_contract_lines
         WHERE import_id = v_c AND NULLIF(btrim(familia), '') IS NOT NULL),
  f AS (SELECT familia FROM public.cubicaje_familias UNION SELECT familia FROM st UNION SELECT familia FROM ct)
  SELECT jsonb_build_object('success', true, 'puede_editar', public.has_tms_permission('despacho'),
    'familias', COALESCE(jsonb_agg(jsonb_build_object('familia', f.familia, 'kg_por_m3', c.kg_por_m3, 'notas', c.notas,
        'updated_at', c.updated_at, 'kg_stock', round(COALESCE(st.kg, 0), 1),
        'en_erp', st.familia IS NOT NULL OR EXISTS (SELECT 1 FROM ct WHERE ct.familia = f.familia))
      ORDER BY COALESCE(st.kg, 0) DESC, f.familia), '[]'::jsonb))
  INTO v_out
  FROM f LEFT JOIN public.cubicaje_familias c ON c.familia = f.familia LEFT JOIN st ON st.familia = f.familia;
  RETURN v_out;
END $$;

-- p: { familia, kg_por_m3 (vacío = sin medida), notas }
CREATE OR REPLACE FUNCTION public.cubicaje_familia_guardar(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_fam text := NULLIF(btrim(p->>'familia'), ''); v_den numeric := NULLIF(btrim(p->>'kg_por_m3'), '')::numeric;
BEGIN
  IF NOT public.has_tms_permission('despacho') THEN RETURN jsonb_build_object('success', false, 'error', 'Requiere permiso de escritura en Programación y Ruteo'); END IF;
  IF v_fam IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Indique la familia'); END IF;
  IF v_den IS NOT NULL AND (v_den <= 0 OR v_den > 100000) THEN RETURN jsonb_build_object('success', false, 'error', 'La densidad debe estar entre 0 y 100.000 kg/m³'); END IF;
  INSERT INTO public.cubicaje_familias (familia, kg_por_m3, notas, updated_at, updated_by)
  VALUES (v_fam, round(v_den, 2), NULLIF(btrim(p->>'notas'), ''), now(), auth.uid())
  ON CONFLICT (familia) DO UPDATE SET kg_por_m3 = EXCLUDED.kg_por_m3, notas = EXCLUDED.notas, updated_at = now(), updated_by = auth.uid();
  RETURN jsonb_build_object('success', true, 'familia', v_fam, 'kg_por_m3', round(v_den, 2));
END $$;

-- Carga por OT y familia para armar una ruta. pendiente_kg: pendiente del Actualizable; listo_kg: la parte del pendiente
-- con stock en la foto del ERP (el stock de un documento y SKU se reparte entre sus líneas en orden, como erp_lineas_stock).
-- m³ = kg / densidad de la familia; sin densidad la familia queda «sin medida».
CREATE OR REPLACE FUNCTION public.route_cubicaje(p_ots text[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); v_s uuid := public.erp_active_import('STOCK'); v_out jsonb; v_ots text[];
BEGIN
  IF NOT public.erp_ref_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a la referencia del ERP'); END IF;
  SELECT array_agg(DISTINCT o) INTO v_ots FROM (
    SELECT split_part(public.erp_key(x), '-', 1) AS o FROM unnest(COALESCE(p_ots, '{}'::text[])) x LIMIT 50) y
  WHERE NULLIF(o, '') IS NOT NULL AND public.erp_ref_ot_visible(o);
  IF v_c IS NULL OR v_ots IS NULL THEN RETURN jsonb_build_object('success', true, 'sin_datos', v_c IS NULL, 'ots', '[]'::jsonb); END IF;
  WITH l AS (
    SELECT l.ot, l.nro_documento, l.secuencia, l.cod_producto, l.peso_unit, NULLIF(btrim(l.familia), '') AS familia,
      greatest(l.cant_pendiente, 0) AS pend
    FROM public.erp_contract_lines l
    WHERE l.import_id = v_c AND l.ot = ANY (v_ots) AND COALESCE(l.tipo_producto, '') <> 'SERVICIO A TERCEROS'),
  st AS (SELECT lote, cod_producto, sum(stock * factor) AS stock FROM public.erp_stock_lots
         WHERE import_id = v_s AND lote IN (SELECT DISTINCT nro_documento FROM l) GROUP BY 1, 2),
  ln AS (SELECT l.*, sum(l.pend) OVER (PARTITION BY l.nro_documento, l.cod_producto ORDER BY l.secuencia) AS acum FROM l),
  x AS (SELECT ln.ot, COALESCE(ln.familia, 'SIN FAMILIA') AS familia, ln.pend, ln.peso_unit,
          greatest(least(ln.pend, COALESCE(st.stock, 0) - (ln.acum - ln.pend)), 0) AS listo
        FROM ln LEFT JOIN st ON st.lote = ln.nro_documento AND st.cod_producto = ln.cod_producto),
  f AS (SELECT x.ot, x.familia, round(sum(x.pend * x.peso_unit), 1) AS pendiente_kg, round(sum(x.listo * x.peso_unit), 1) AS listo_kg,
          count(*) FILTER (WHERE x.pend > 0 AND x.peso_unit IS NULL) AS lineas_sin_peso, c.kg_por_m3
        FROM x LEFT JOIN public.cubicaje_familias c ON c.familia = x.familia
        WHERE x.pend > 0 GROUP BY x.ot, x.familia, c.kg_por_m3)
  SELECT jsonb_build_object('success', true,
    'corte_stock', (SELECT cut_at FROM public.erp_imports WHERE id = v_s),
    'ots', COALESCE(jsonb_agg(jsonb_build_object('ot', o.ot, 'familias', o.familias) ORDER BY o.ot), '[]'::jsonb))
  INTO v_out
  FROM (SELECT f.ot, jsonb_agg(jsonb_build_object('familia', f.familia, 'pendiente_kg', COALESCE(f.pendiente_kg, 0), 'listo_kg', COALESCE(f.listo_kg, 0),
          'lineas_sin_peso', f.lineas_sin_peso, 'kg_por_m3', f.kg_por_m3,
          'm3_listo', CASE WHEN f.kg_por_m3 > 0 THEN round(COALESCE(f.listo_kg, 0) / f.kg_por_m3, 2) END)
          ORDER BY f.listo_kg DESC NULLS LAST, f.familia) AS familias
        FROM f GROUP BY f.ot) o;
  RETURN v_out;
END $$;

REVOKE ALL ON FUNCTION public.cubicaje_familias_lista(), public.cubicaje_familia_guardar(jsonb), public.route_cubicaje(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cubicaje_familias_lista(), public.cubicaje_familia_guardar(jsonb), public.route_cubicaje(text[]) TO authenticated;

COMMIT;
