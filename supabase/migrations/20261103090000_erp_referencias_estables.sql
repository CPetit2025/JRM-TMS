-- Referencias ERP: planes estables con lotes reales y tipos sin equivalencia visibles para revisión.
-- No altera permisos, unidades, reglas comerciales ni el tiempo límite de authenticated.
BEGIN;
CREATE INDEX IF NOT EXISTS erp_ref_contract_doc_key_idx ON public.contracts (public.erp_doc_key(code));
CREATE INDEX IF NOT EXISTS erp_ref_stock_exact_idx ON public.erp_stock_lots
 (import_id,public.erp_key(lote_raw),public.erp_key(cod_producto),public.erp_key(unidad));
CREATE OR REPLACE FUNCTION public.erp_ot_actividad(p_ots text[])
RETURNS TABLE (ot text, ult_despacho_erp date, ult_despacho_tms date, ultimo_despacho date, fecha_contrato date, pendiente boolean,
  activa boolean, motivo text, motivo_fecha date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
  WITH cfg AS (
    SELECT COALESCE((SELECT s.umbral_dias FROM public.erp_contract_settings s WHERE s.id = 1), 90) AS umbral,
      COALESCE((SELECT s.reactivan FROM public.erp_contract_settings s WHERE s.id = 1), ARRAY['GARANTIA', 'SUBCONTRATO', 'ERROR', 'SOLICITUD_TMS']) AS reactivan,
      (now() AT TIME ZONE 'America/Lima')::date AS hoy),
  o AS MATERIALIZED (SELECT DISTINCT x AS ot FROM unnest(COALESCE(p_ots, '{}'::text[])) x WHERE x IS NOT NULL),
  e AS (
    SELECT l.ot, max(l.fecha_ult_despacho) AS ult_erp,
      min(l.fecha_contrato) FILTER (WHERE l.tipo_documento = 'CONTRATO DE VENTAS') AS fecha_contrato,
      max(l.fecha_contrato) FILTER (WHERE l.tipo_documento = 'GARANTIA DE VENTAS') AS f_gar,
      max(l.fecha_contrato) FILTER (WHERE l.tipo_documento = 'SUBCONTRATO DE VENTAS') AS f_sub,
      max(l.fecha_contrato) FILTER (WHERE l.tipo_documento = 'ERROR DE CONTRATO') AS f_err,
      bool_or(l.cant_pendiente > 0 AND NOT l.cantidades_ausentes) AS pendiente
    FROM public.erp_contract_lines l
    WHERE l.import_id = public.erp_active_import('CONTRATOS') AND l.ot IN (SELECT o.ot FROM o) GROUP BY l.ot),
  roots AS MATERIALIZED (
    SELECT o.ot, r.id, r.type::text AS tipo, r.created_at
    FROM o JOIN public.contracts r ON r.code = o.ot AND r.parent_contract_id IS NULL),
  fam AS MATERIALIZED (
    SELECT roots.ot, roots.id, roots.tipo, roots.created_at FROM roots
    UNION ALL
    SELECT roots.ot, c.id, c.type::text, c.created_at
    FROM roots JOIN public.contracts c ON c.parent_contract_id = roots.id),
  req AS (
    SELECT fam.ot, tr.id, tr.status::text AS status, tr.created_at FROM fam JOIN public.transport_requests tr ON tr.contract_id = fam.id
    UNION
    SELECT fam.ot, tr.id, tr.status::text, tr.created_at FROM fam JOIN public.transport_request_components tc ON tc.component_contract_id = fam.id
      JOIN public.transport_requests tr ON tr.id = tc.request_id),
  t AS (
    SELECT req.ot, max((COALESCE((to_jsonb(d)->>'scheduled_date')::timestamptz, d.created_at) AT TIME ZONE 'America/Lima')::date) AS ult_tms
    FROM req JOIN public.dispatch_requests dr ON dr.transport_request_id = req.id JOIN public.dispatches d ON d.id = dr.dispatch_id
    WHERE COALESCE(d.status, '') NOT IN ('CANCELADO', 'CANCELADA', 'ANULADO', 'ANULADA') GROUP BY req.ot),
  s AS (
    SELECT req.ot, max((req.created_at AT TIME ZONE 'America/Lima')::date) AS f_sol FROM req
    WHERE COALESCE(req.status, '') NOT IN ('CANCELADA', 'ANULADA', 'RECHAZADA', 'BORRADOR') GROUP BY req.ot),
  g AS (SELECT fam.ot, max((fam.created_at AT TIME ZONE 'America/Lima')::date) AS f_gar_tms FROM fam WHERE fam.tipo = 'GARANTIA' GROUP BY fam.ot),
  m AS (
    SELECT o.ot, e.ult_erp, t.ult_tms, greatest(e.ult_erp, t.ult_tms) AS ultimo, e.fecha_contrato, COALESCE(e.pendiente, false) AS pendiente,
      greatest(e.f_gar, g.f_gar_tms) AS f_gar, e.f_sub, e.f_err, s.f_sol, cfg.hoy - cfg.umbral AS desde, cfg.reactivan
    FROM o CROSS JOIN cfg LEFT JOIN e ON e.ot = o.ot LEFT JOIN t ON t.ot = o.ot LEFT JOIN s ON s.ot = o.ot LEFT JOIN g ON g.ot = o.ot)
  SELECT m.ot, m.ult_erp, m.ult_tms, m.ultimo, m.fecha_contrato, m.pendiente, r.motivo IS NOT NULL, r.motivo, r.fecha
  FROM m LEFT JOIN LATERAL (
    SELECT v.motivo, v.fecha FROM (VALUES
      (1, 'DESPACHO', m.ultimo, true),
      (2, 'GARANTIA', m.f_gar, 'GARANTIA' = ANY (m.reactivan)),
      (3, 'SUBCONTRATO', m.f_sub, 'SUBCONTRATO' = ANY (m.reactivan)),
      (4, 'ERROR', m.f_err, 'ERROR' = ANY (m.reactivan)),
      (5, 'SOLICITUD_TMS', m.f_sol, 'SOLICITUD_TMS' = ANY (m.reactivan)),
      (6, 'CONTRATO_NUEVO', CASE WHEN m.ultimo IS NULL THEN m.fecha_contrato END, true)) v(orden, motivo, fecha, habilitado)
    WHERE v.habilitado AND v.fecha >= m.desde ORDER BY v.orden LIMIT 1) r ON true;
$$;
CREATE OR REPLACE FUNCTION public.erp_ref_contratos(p_codes text[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); v_s uuid := public.erp_active_import('STOCK');
  v_ca boolean := public.is_contract_administrator() AND NOT public.is_tms_admin(); v_out jsonb;
BEGIN
  IF NOT public.erp_ref_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a la referencia del ERP'); END IF;
  IF v_c IS NULL THEN RETURN jsonb_build_object('success', true, 'sin_datos', true, 'config', public.erp_contratos_config_json(), 'filas', '{}'::jsonb); END IF;
  WITH i AS (SELECT DISTINCT btrim(x) AS codigo FROM unnest(COALESCE(p_codes, '{}'::text[])) x WHERE NULLIF(btrim(x), '') IS NOT NULL LIMIT 5000),
  t AS (
    SELECT i.codigo, c.id, c.type::text AS tipo_tms, c.parent_contract_id IS NULL AS raiz, c.garantia_id,
      public.erp_doc_key(c.code) AS dk, split_part(public.erp_key(c.code), '-', 1) AS ot,
      public.client_tax_id_norm(COALESCE(to_jsonb(cl)->>'tax_id', to_jsonb(cl)->>'ruc')) AS ruc_tms, cl.business_name::text AS cliente_tms
    FROM i JOIN public.contracts c ON c.code = i.codigo LEFT JOIN public.clients cl ON cl.id = c.client_id
    WHERE public.can_access_site(c.site_id) AND (NOT v_ca OR public.has_assigned_contract(c.id))),
  l AS (
    SELECT l.ot, public.erp_doc_key(l.nro_documento) AS dk, public.erp_key(l.nro_documento) AS dkraw, l.tipo_documento, l.cliente,
      public.client_tax_id_norm(l.ruc) AS ruc, l.cant_contrato, l.cant_despachada, l.cant_pendiente, l.cantidades_ausentes,
      public.erp_key(l.cod_producto) AS pk, public.erp_key(COALESCE(l.unidad_erp, l.unidad)) AS u
    FROM public.erp_contract_lines l WHERE l.import_id = v_c AND l.ot IN (SELECT DISTINCT t.ot FROM t)),
  d AS (
    SELECT l.dk, max(l.dkraw) AS documento, max(l.tipo_documento) AS tipo_erp, max(l.cliente) AS cliente_erp, max(l.ruc) AS ruc_erp,
      count(DISTINCT l.ruc) AS n_ruc, count(*) AS lineas, count(*) FILTER (WHERE l.cantidades_ausentes) AS incompletas,
      count(DISTINCT l.u) FILTER (WHERE NOT l.cantidades_ausentes) AS unidades, min(l.u) FILTER (WHERE NOT l.cantidades_ausentes) AS unidad,
      sum(l.cant_contrato) FILTER (WHERE NOT l.cantidades_ausentes) AS contratado,
      sum(l.cant_despachada) FILTER (WHERE NOT l.cantidades_ausentes) AS despachado,
      sum(l.cant_pendiente) FILTER (WHERE NOT l.cantidades_ausentes) AS pendiente
    FROM l WHERE l.dk IN (SELECT t.dk FROM t) GROUP BY l.dk),
  sp AS (
    SELECT q.dk, sum(s.stock) AS stock
    FROM (SELECT DISTINCT l.dk, l.dkraw, l.pk, l.u FROM l WHERE l.cant_pendiente > 0 AND NOT l.cantidades_ausentes AND l.dk IN (SELECT t.dk FROM t)) q
    JOIN public.erp_stock_lots s ON s.import_id = v_s AND public.erp_key(s.lote_raw) = q.dkraw AND public.erp_key(s.cod_producto) = q.pk
      AND public.erp_key(s.unidad) = q.u AND s.stock > 0
    GROUP BY q.dk),
  tk AS (SELECT DISTINCT public.erp_doc_key(c.code) AS k FROM public.contracts c WHERE c.code IS NOT NULL),
  h AS (
    SELECT l.ot, array_agg(DISTINCT l.dkraw ORDER BY l.dkraw) AS docs FROM l
    WHERE l.tipo_documento IS DISTINCT FROM 'CONTRATO DE VENTAS' AND l.dk NOT IN (SELECT tk.k FROM tk WHERE tk.k IS NOT NULL) GROUP BY l.ot),
  a AS (SELECT * FROM public.erp_ot_actividad((SELECT array_agg(DISTINCT t.ot) FROM t))),
  ge AS (SELECT e.garantia_id, max(e.code::text) AS error_code FROM public.contracts e WHERE e.garantia_id IN (SELECT t.id FROM t) GROUP BY e.garantia_id),
  eg AS (SELECT t.id, g.code::text AS garantia_code FROM t JOIN public.contracts g ON g.id = t.garantia_id),
  r AS (
    SELECT t.codigo, t.tipo_tms, t.raiz, d.dk IS NOT NULL AS en_erp, d.documento, d.tipo_erp, d.cliente_erp, d.ruc_erp,
      COALESCE(d.n_ruc = 1 AND length(d.ruc_erp) = 11 AND public.is_valid_ruc(d.ruc_erp), false) AS ruc_valido,
      t.cliente_tms, t.ruc_tms, d.lineas, d.incompletas, d.unidades, d.unidad, d.contratado, d.despachado, d.pendiente, sp.stock AS stock_listo,
      a.ultimo_despacho, a.ult_despacho_erp, a.ult_despacho_tms, a.activa, a.motivo, a.motivo_fecha, a.fecha_contrato,
      CASE WHEN t.raiz THEN COALESCE(h.docs, '{}'::text[]) ELSE '{}'::text[] END AS hijos_sin_alta, ge.error_code, eg.garantia_code
    FROM t LEFT JOIN d ON d.dk = t.dk LEFT JOIN sp ON sp.dk = t.dk LEFT JOIN a ON a.ot = t.ot LEFT JOIN h ON h.ot = t.ot
      LEFT JOIN ge ON ge.garantia_id = t.id LEFT JOIN eg ON eg.id = t.id)
  SELECT jsonb_build_object('success', true, 'config', public.erp_contratos_config_json(),
    'cortes', (SELECT jsonb_object_agg(kind, cut_at) FROM public.erp_imports WHERE id IN (v_c, v_s)),
    'filas', COALESCE(jsonb_object_agg(r.codigo, jsonb_build_object(
      'aplica', r.en_erp OR r.tipo_tms <> 'OT_INDEPENDIENTE', 'en_erp', r.en_erp, 'documento', r.documento, 'tipo_erp', r.tipo_erp,
      'cliente_erp', r.cliente_erp, 'ruc_erp', r.ruc_erp, 'ruc_valido', r.ruc_valido, 'cliente_tms', r.cliente_tms,
      'cliente_coincide', CASE WHEN r.en_erp AND r.ruc_valido THEN r.ruc_tms IS NOT DISTINCT FROM r.ruc_erp END,
      'lineas', r.lineas, 'incompletas', r.incompletas, 'unidades', r.unidades, 'unidad', CASE WHEN r.unidades = 1 THEN r.unidad END,
      'contratado', CASE WHEN r.unidades = 1 THEN r.contratado END, 'despachado', CASE WHEN r.unidades = 1 THEN r.despachado END,
      'pendiente', CASE WHEN r.unidades = 1 THEN r.pendiente END,
      'avance', CASE WHEN r.unidades = 1 AND r.contratado > 0 THEN round(r.despachado / r.contratado, 4) END,
      'estado_erp', CASE WHEN NOT r.en_erp THEN NULL WHEN r.lineas = r.incompletas THEN 'SIN DATOS' WHEN r.pendiente <= 0 THEN 'COMPLETO'
        WHEN r.despachado > 0 THEN 'PARCIAL' ELSE 'SIN DESPACHO' END,
      'stock_listo', r.stock_listo, 'ultimo_despacho', r.ultimo_despacho, 'ultimo_despacho_erp', r.ult_despacho_erp,
      'ultimo_despacho_tms', r.ult_despacho_tms, 'fecha_contrato', r.fecha_contrato,
      'activa', r.activa, 'motivo', r.motivo, 'motivo_fecha', r.motivo_fecha,
      'hijos_sin_alta', to_jsonb(r.hijos_sin_alta), 'garantia_error', r.error_code, 'error_de_garantia', r.garantia_code,
      'diferencias', to_jsonb(array_remove(ARRAY[
        CASE WHEN NOT r.en_erp AND r.tipo_tms <> 'OT_INDEPENDIENTE' THEN 'NO_EN_ERP' END,
        CASE WHEN r.en_erp AND r.ruc_valido AND r.ruc_tms IS DISTINCT FROM r.ruc_erp THEN 'CLIENTE_DISTINTO' END,
        CASE WHEN r.en_erp AND NOT r.ruc_valido THEN 'RUC_INVALIDO' END,
        CASE WHEN cardinality(r.hijos_sin_alta) > 0 THEN 'HIJOS_SIN_ALTA' END,
        CASE WHEN r.tipo_tms = 'GARANTIA' AND r.error_code IS NULL THEN 'GARANTIA_SIN_ERROR' END]::text[], NULL)))), '{}'::jsonb))
  INTO v_out FROM r;
  RETURN v_out;
END $$;
CREATE OR REPLACE FUNCTION public.erp_ref_sin_alta(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); v_out jsonb;
  v_ca boolean := public.is_contract_administrator() AND NOT public.is_tms_admin();
  v_tipo text := NULLIF(upper(btrim(COALESCE(p->>'tipo', ''))), '');
  v_activas boolean := COALESCE((p->>'solo_activas')::boolean, true);
  v_q text := NULLIF(public.erp_key(p->>'q'), '');
  v_lim integer := least(greatest(COALESCE((p->>'limit')::integer, 50), 1), 500);
  v_off integer := greatest(COALESCE((p->>'offset')::integer, 0), 0);
BEGIN
  IF NOT (public.is_tms_admin() OR public.is_contract_administrator() OR public.has_tms_permission('ot')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso de Contratos y OTs');
  END IF;
  IF v_c IS NULL THEN RETURN jsonb_build_object('success', true, 'sin_datos', true, 'total', 0, 'filas', '[]'::jsonb); END IF;
  WITH tk AS (SELECT DISTINCT public.erp_doc_key(c.code) AS k FROM public.contracts c WHERE c.code IS NOT NULL),
  madres AS (SELECT c.code::text AS ot, c.id FROM public.contracts c WHERE c.parent_contract_id IS NULL AND public.can_access_site(c.site_id)
             AND (NOT v_ca OR public.has_assigned_contract(c.id))),
  d AS (
    SELECT public.erp_doc_key(l.nro_documento) AS dk, max(public.erp_key(l.nro_documento)) AS documento, max(l.ot) AS ot,
      max(l.tipo_documento) AS tipo_erp, max(l.cliente) AS cliente, max(public.client_tax_id_norm(l.ruc)) AS ruc, min(l.fecha_contrato) AS fecha_contrato,
      max(l.fecha_ult_despacho) AS ult_despacho, bool_or(l.cant_pendiente > 0 AND NOT l.cantidades_ausentes) AS pendiente
    FROM public.erp_contract_lines l WHERE l.import_id = v_c GROUP BY 1),
  f AS (
    SELECT d.*, public.erp_tipo_tms(d.tipo_erp) AS tipo, m.id AS madre_id
    FROM d LEFT JOIN madres m ON m.ot = d.ot
    WHERE d.dk NOT IN (SELECT tk.k FROM tk WHERE tk.k IS NOT NULL)
      AND (NOT v_ca OR m.id IS NOT NULL)
      AND (v_tipo IS NULL OR public.erp_tipo_tms(d.tipo_erp) = v_tipo)
      AND (v_q IS NULL OR d.documento LIKE '%' || v_q || '%' OR upper(d.cliente) LIKE '%' || v_q || '%')),
  a AS (SELECT * FROM public.erp_ot_actividad((SELECT array_agg(DISTINCT f.ot) FROM f))),
  x AS (SELECT f.*, a.activa, a.motivo, a.ultimo_despacho FROM f LEFT JOIN a ON a.ot = f.ot WHERE NOT v_activas OR a.activa)
  SELECT jsonb_build_object('success', true, 'total', (SELECT count(*) FROM x),
    'por_tipo', (SELECT COALESCE(jsonb_object_agg(COALESCE(tipo, 'OTROS'), n), '{}'::jsonb) FROM (SELECT x.tipo, count(*) AS n FROM x GROUP BY x.tipo) z),
    'filas', COALESCE((SELECT jsonb_agg(to_jsonb(y)) FROM (
       SELECT x.documento, x.ot, x.tipo, x.tipo_erp, x.cliente, x.ruc, x.fecha_contrato, x.ult_despacho, x.pendiente, x.activa, x.motivo,
         x.ultimo_despacho, x.madre_id IS NOT NULL AS madre_en_tms
       FROM x ORDER BY x.activa DESC NULLS LAST, x.ultimo_despacho DESC NULLS LAST, x.documento LIMIT v_lim OFFSET v_off) y), '[]'::jsonb))
  INTO v_out;
  RETURN v_out;
END $$;
ANALYZE public.contracts;
ANALYZE public.erp_contract_lines;
ANALYZE public.erp_stock_lots;
NOTIFY pgrst, 'reload schema';
COMMIT;
