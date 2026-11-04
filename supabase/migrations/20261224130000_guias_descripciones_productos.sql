-- Completar glosas vacías solo con una descripción inequívoca del mismo SKU en APT.
-- Mantener la glosa original y el origen de la recuperación; no modificar movimientos.
BEGIN;
CREATE OR REPLACE FUNCTION public.apt_guia_detalle(p_guias text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
