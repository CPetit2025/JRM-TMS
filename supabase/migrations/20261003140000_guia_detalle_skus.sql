-- ============================================================
-- Detalle de una guía de remisión (SKUs) desde la SALIDA cargada en APT
-- ============================================================
-- Las guías que se registran en Contratos → Servicios, Despacho o el Asistente Documentario son las mismas de la hoja
-- SALIDA del ERP (Numero = T001-00006696). apt_guia_detalle recibe una o varias guías (separadas por coma, espacio o
-- punto y coma), las normaliza (serie y número sin ceros: T001-6696 = T001-00006696; solo número = cualquier serie) y
-- devuelve cada guía con todas sus líneas: producto, glosa, cantidad, unidad, peso, lote / NumRel, más el origen de
-- producción del flujo multi-almacén y el despacho del TMS.
-- Pueden consultarla quienes ven APT o trabajan con guías (servicios de contratos, OT, despacho, documentario).
BEGIN;

CREATE OR REPLACE FUNCTION public.apt_guia_key(p text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN v ~ '^[A-Z0-9]+-[0-9]+$' THEN split_part(v, '-', 1) || '-' || COALESCE(NULLIF(ltrim(split_part(v, '-', 2), '0'), ''), '0')
    WHEN v ~ '^[0-9]+$' THEN COALESCE(NULLIF(ltrim(v, '0'), ''), '0')
    ELSE v END
  FROM (SELECT upper(regexp_replace(COALESCE(p, ''), '\s+', '', 'g')) AS v) z;
$$;

CREATE INDEX IF NOT EXISTS apt_movements_guia_key_idx ON public.apt_movements (public.apt_guia_key(documento))
  WHERE active AND valid AND kind = 'SALIDA';

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
        'items', (SELECT jsonb_agg(jsonb_build_object('producto', producto, 'glosa', glosa, 'familia', familia, 'cantidad', cantidad,
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

REVOKE ALL ON FUNCTION public.apt_guia_detalle(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_guia_detalle(text) TO authenticated, service_role;

COMMIT;
