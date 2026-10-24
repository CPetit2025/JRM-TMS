-- ERP como referencia de solo lectura para Operaciones (Registro de Servicios, Programación y Ruteo, Torre de Control,
-- Monitoreo y Documentos de Despacho). No crea ni modifica registros del TMS. Usa las reglas del análisis exacto
-- (20261026090000): sin conversiones de unidad, lote = documento con el mismo producto y unidad, y las filas con cantidades
-- ausentes quedan fuera de las sumas (se informan aparte).
BEGIN;

-- Ven la referencia quienes ven APT o alguna pantalla de Operaciones
CREATE OR REPLACE FUNCTION public.erp_ref_can_view()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.apt_can_view() OR EXISTS (SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
    WHERE p.id = auth.uid() AND p.is_active
      AND COALESCE(r.permissions, '[]'::jsonb) ?| ARRAY['despacho', 'despacho:read', 'despacho:write', 'monitoreo', 'monitoreo:read', 'monitoreo:write',
        'torre-control', 'torre-control:read', 'torre-control:write', 'documentario', 'documentario:read', 'documentario:write',
        'packing-list', 'packing-list:read', 'packing-list:write', 'planificacion', 'planificacion:read', 'planificacion:write',
        'contratos-servicios', 'contratos-servicios:read', 'contratos-servicios:write', 'clientes', 'clientes:read', 'clientes:write']);
$$;

-- Guías del ERP con su fecha y documentos (carga vigente del Actualizable); p_keys acota a esas guías
CREATE OR REPLACE FUNCTION public.erp_ref_guias_erp(v_c uuid, p_keys text[] DEFAULT NULL)
RETURNS TABLE (guia_key text, guia text, fecha date, exacta boolean, ots text, docs text, items bigint, cantidad numeric, cliente text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
  SELECT f.guia_key, f.guia, f.fecha, f.exacta, g.ots, g.docs, g.items, g.cantidad, g.cliente
  FROM public.erp_guia_fechas f
  JOIN (SELECT g.guia_key, string_agg(DISTINCT l.ot, ', ') AS ots, string_agg(DISTINCT g.nro_documento, ', ') AS docs, count(*) AS items,
          sum(g.cantidad) AS cantidad, max(l.cliente) AS cliente
        FROM public.erp_contract_guias g JOIN public.erp_contract_lines l ON l.import_id = g.import_id AND l.nro_documento = g.nro_documento AND l.secuencia = g.secuencia
        WHERE g.import_id = v_c AND (p_keys IS NULL OR g.guia_key = ANY (p_keys)) GROUP BY g.guia_key) g USING (guia_key)
  WHERE f.import_id = v_c AND (p_keys IS NULL OR f.guia_key = ANY (p_keys));
$$;
REVOKE ALL ON FUNCTION public.erp_ref_guias_erp(uuid, text[]) FROM PUBLIC, anon, authenticated;

-- Una OT (o subcontrato) en el ERP: resumen por tipo de documento y unidad, documentos y guías con su ruta en el TMS
CREATE OR REPLACE FUNCTION public.erp_ref_ot(p_ot text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); v_s uuid := public.erp_active_import('STOCK');
  v_doc text := public.erp_key(p_ot); v_ot text := split_part(public.erp_key(p_ot), '-', 1); v_out jsonb; v_keys text[];
BEGIN
  IF NOT public.erp_ref_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a la referencia del ERP'); END IF;
  IF v_c IS NULL THEN RETURN jsonb_build_object('success', true, 'sin_datos', true); END IF;
  IF v_ot IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Indique una OT'); END IF;
  -- Guías de los documentos de la OT (se acota antes de cruzar con el TMS)
  SELECT array_agg(DISTINCT g.guia_key) INTO v_keys FROM public.erp_contract_guias g
  WHERE g.import_id = v_c AND g.nro_documento IN (SELECT DISTINCT nro_documento FROM public.erp_contract_lines WHERE import_id = v_c AND ot = v_ot);
  WITH l AS (
    SELECT l.*, public.erp_key(l.nro_documento) AS dk, public.erp_key(l.cod_producto) AS pk, public.erp_key(COALESCE(l.unidad_erp, l.unidad)) AS u
    FROM public.erp_contract_lines l WHERE l.import_id = v_c AND l.ot = v_ot),
  -- Documento + producto + unidad, como el análisis exacto
  d AS (
    SELECT dk, pk, u, max(tipo_documento) AS tipo_documento, max(cliente) AS cliente, max(ruc) AS ruc, bool_or(cantidades_ausentes) AS incompleto,
      sum(cant_contrato) AS contratado, sum(cant_despachada) AS despachado, sum(cant_pendiente) AS pendiente, max(fecha_vcto) AS fecha_vcto
    FROM l GROUP BY 1, 2, 3),
  s AS (
    SELECT public.erp_key(lote_raw) AS lk, public.erp_key(cod_producto) AS pk, public.erp_key(unidad) AS u, sum(stock) AS stock, string_agg(DISTINCT public.erp_bodega(bodega), ' · ') AS bodegas
    FROM public.erp_stock_lots WHERE import_id = v_s AND public.erp_key(lote_raw) IN (SELECT DISTINCT dk FROM l) GROUP BY 1, 2, 3),
  ds AS (SELECT d.*, s.stock, s.bodegas FROM d LEFT JOIN s ON s.lk = d.dk AND s.pk = d.pk AND s.u = d.u),
  g AS (
    SELECT e.*, t.rutas, t.fecha AS fecha_tms, t.placas
    FROM public.erp_ref_guias_erp(v_c, COALESCE(v_keys, '{}'::text[])) e LEFT JOIN public.erp_tms_guias() t ON t.guia_key = e.guia_key)
  SELECT jsonb_build_object('success', true, 'ot', v_ot, 'documento', CASE WHEN v_doc <> v_ot THEN v_doc END, 'en_erp', EXISTS (SELECT 1 FROM l),
    'cortes', (SELECT jsonb_object_agg(kind, cut_at) FROM public.erp_imports WHERE id IN (v_c, v_s)),
    'cliente', (SELECT max(cliente) FROM l), 'ruc', (SELECT max(ruc) FROM l),
    -- Las filas incompletas no entran en ninguna suma ni porcentaje; se informan aparte
    'grupos', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.tipo_documento, x.unidad) FROM (
       SELECT tipo_documento, u AS unidad, count(*) AS filas, count(*) FILTER (WHERE NOT incompleto) AS validas, count(*) FILTER (WHERE incompleto) AS incompletas,
         count(DISTINCT dk) FILTER (WHERE NOT incompleto) AS documentos,
         sum(contratado) FILTER (WHERE NOT incompleto) AS contratado, sum(despachado) FILTER (WHERE NOT incompleto) AS despachado,
         sum(pendiente) FILTER (WHERE NOT incompleto) AS pendiente,
         CASE WHEN sum(contratado) FILTER (WHERE NOT incompleto) > 0
           THEN round(sum(despachado) FILTER (WHERE NOT incompleto) / sum(contratado) FILTER (WHERE NOT incompleto), 4) END AS avance,
         sum(stock) FILTER (WHERE NOT incompleto AND pendiente > 0) AS stock_coincidente,
         CASE WHEN sum(pendiente) FILTER (WHERE NOT incompleto AND pendiente > 0) > 0
           THEN round(COALESCE(sum(stock) FILTER (WHERE NOT incompleto AND pendiente > 0), 0) / sum(pendiente) FILTER (WHERE NOT incompleto AND pendiente > 0), 4) END AS cobertura
       FROM ds GROUP BY 1, 2) x), '[]'::jsonb),
    'documentos', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.documento = v_doc DESC, x.documento) FROM (
       SELECT dk AS documento, max(tipo_documento) AS tipo_documento, u AS unidad, count(*) AS productos, bool_or(incompleto) AS incompleto,
         sum(contratado) FILTER (WHERE NOT incompleto) AS contratado, sum(despachado) FILTER (WHERE NOT incompleto) AS despachado,
         sum(pendiente) FILTER (WHERE NOT incompleto) AS pendiente, sum(stock) FILTER (WHERE NOT incompleto AND pendiente > 0) AS stock_coincidente,
         string_agg(DISTINCT bodegas, ' · ') AS bodegas, max(fecha_vcto) AS fecha_vcto
       FROM ds GROUP BY dk, u LIMIT 200) x), '[]'::jsonb),
    'guias_total', (SELECT count(*) FROM g), 'guias_con_ruta', (SELECT count(*) FROM g WHERE rutas IS NOT NULL),
    'guias', COALESCE((SELECT jsonb_agg(jsonb_build_object('guia', guia, 'documentos', docs, 'items', items, 'cantidad', cantidad, 'fecha_erp', fecha,
         'fecha_erp_exacta', exacta, 'rutas', rutas, 'placas', placas, 'fecha_tms', fecha_tms) ORDER BY fecha DESC NULLS LAST, guia)
       FROM (SELECT * FROM g ORDER BY fecha DESC NULLS LAST, guia LIMIT 40) z), '[]'::jsonb))
  INTO v_out;
  RETURN v_out;
END $$;

-- Validación de guías escritas en el TMS contra el ERP (existe, OT, documentos, cantidad y fecha en el ERP)
CREATE OR REPLACE FUNCTION public.erp_ref_guias(p_guias text[], p_ot text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); v_ot text := split_part(public.erp_key(p_ot), '-', 1); v_out jsonb;
BEGIN
  IF NOT public.erp_ref_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a la referencia del ERP'); END IF;
  IF v_c IS NULL THEN RETURN jsonb_build_object('success', true, 'sin_datos', true, 'guias', '[]'::jsonb); END IF;
  WITH i AS (SELECT DISTINCT btrim(x) AS entrada, public.apt_guia_key(x) AS guia_key FROM unnest(COALESCE(p_guias, '{}'::text[])) x WHERE NULLIF(btrim(x), '') IS NOT NULL LIMIT 200),
  e AS (SELECT * FROM public.erp_ref_guias_erp(v_c, (SELECT array_agg(guia_key) FROM i)))
  SELECT jsonb_build_object('success', true, 'cortes', (SELECT jsonb_object_agg(kind, cut_at) FROM public.erp_imports WHERE id = v_c),
    'guias', COALESCE(jsonb_agg(jsonb_build_object('entrada', i.entrada, 'guia', e.guia, 'en_erp', e.guia_key IS NOT NULL, 'ots', e.ots, 'documentos', e.docs,
      'items', e.items, 'cantidad', e.cantidad, 'cliente', e.cliente, 'fecha_erp', e.fecha, 'fecha_erp_exacta', e.exacta,
      'ot_distinta', v_ot IS NOT NULL AND e.ots IS NOT NULL AND NOT (v_ot = ANY (string_to_array(e.ots, ', ')))) ORDER BY i.entrada), '[]'::jsonb))
  INTO v_out
  FROM i LEFT JOIN e ON e.guia_key = i.guia_key;
  RETURN v_out;
END $$;

-- Resumen para Torre de Control: guías del ERP sin ruta en el TMS, guías del TMS que el ERP no muestra y desfases
CREATE OR REPLACE FUNCTION public.erp_ref_guias_resumen(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); v_out jsonb;
  v_to date := COALESCE(NULLIF(p->>'hasta', '')::date, (now() AT TIME ZONE 'America/Lima')::date);
  v_from date := COALESCE(NULLIF(p->>'desde', '')::date, COALESCE(NULLIF(p->>'hasta', '')::date, (now() AT TIME ZONE 'America/Lima')::date) - 7);
  v_tol integer := greatest(COALESCE((p->>'tolerancia')::integer, 2), 0); v_lim integer := least(greatest(COALESCE((p->>'limit')::integer, 15), 1), 100);
BEGIN
  IF NOT public.erp_ref_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a la referencia del ERP'); END IF;
  IF v_c IS NULL THEN RETURN jsonb_build_object('success', true, 'sin_datos', true); END IF;
  WITH e AS (SELECT * FROM public.erp_ref_guias_erp(v_c)),
  t AS (SELECT * FROM public.erp_tms_guias()),
  j AS (
    SELECT COALESCE(e.guia, t.guia) AS guia, e.ots, e.cliente, e.fecha AS fecha_erp, e.exacta AS fecha_erp_exacta, t.fecha AS fecha_tms, t.rutas, t.placas, t.ot AS ot_tms,
      CASE WHEN e.guia_key IS NOT NULL AND t.guia_key IS NOT NULL THEN 'AMBOS' WHEN e.guia_key IS NOT NULL THEN 'SOLO_ERP' ELSE 'SOLO_TMS' END AS origen,
      t.fecha - e.fecha AS dif_dias, COALESCE(t.fecha, e.fecha) AS fecha_ref
    FROM e FULL JOIN t ON t.guia_key = e.guia_key),
  -- Solo TMS desde la primera fecha que cubre el Actualizable (antes no hay con qué cruzar)
  f AS (SELECT * FROM j WHERE fecha_ref BETWEEN v_from AND v_to AND (origen <> 'SOLO_TMS' OR fecha_tms >= (SELECT min(fecha) FROM e)))
  SELECT jsonb_build_object('success', true, 'desde', v_from, 'hasta', v_to, 'tolerancia', v_tol,
    'cortes', (SELECT jsonb_object_agg(kind, cut_at) FROM public.erp_imports WHERE id = v_c),
    'resumen', (SELECT jsonb_build_object('total', count(*), 'ambos', count(*) FILTER (WHERE origen = 'AMBOS'), 'solo_erp', count(*) FILTER (WHERE origen = 'SOLO_ERP'),
       'solo_tms', count(*) FILTER (WHERE origen = 'SOLO_TMS'), 'desfase', count(*) FILTER (WHERE abs(dif_dias) > v_tol)) FROM f),
    'solo_erp', COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT guia, ots, cliente, fecha_erp, fecha_erp_exacta FROM f WHERE origen = 'SOLO_ERP'
       ORDER BY fecha_erp DESC, guia LIMIT v_lim) x), '[]'::jsonb),
    'solo_tms', COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT guia, ot_tms, rutas, placas, fecha_tms FROM f WHERE origen = 'SOLO_TMS'
       ORDER BY fecha_tms DESC, guia LIMIT v_lim) x), '[]'::jsonb),
    'desfase', COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT guia, ots, rutas, fecha_erp, fecha_tms, dif_dias FROM f WHERE abs(dif_dias) > v_tol
       ORDER BY abs(dif_dias) DESC, guia LIMIT v_lim) x), '[]'::jsonb))
  INTO v_out;
  RETURN v_out;
END $$;

REVOKE ALL ON FUNCTION public.erp_ref_can_view(), public.erp_ref_ot(text), public.erp_ref_guias(text[], text), public.erp_ref_guias_resumen(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_ref_can_view(), public.erp_ref_ot(text), public.erp_ref_guias(text[], text), public.erp_ref_guias_resumen(jsonb) TO authenticated;

COMMIT;
