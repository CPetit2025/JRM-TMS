-- Normalizar documentos una vez por documento/RUC, no una vez por línea de producto.
-- Conserva la agregación por clave normalizada y la autorización por sede/cartera.
BEGIN;
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
  WITH tk AS MATERIALIZED (SELECT DISTINCT public.erp_doc_key(c.code) AS k FROM public.contracts c WHERE c.code IS NOT NULL),
  sites AS MATERIALIZED (SELECT DISTINCT c.site_id FROM public.contracts c WHERE c.parent_contract_id IS NULL),
  allowed_sites AS MATERIALIZED (SELECT site_id FROM sites WHERE public.can_access_site(site_id)),
  madres AS MATERIALIZED (SELECT c.code::text AS ot, c.id FROM public.contracts c WHERE c.parent_contract_id IS NULL AND c.site_id IN (SELECT site_id FROM allowed_sites)
             AND (NOT v_ca OR public.has_assigned_contract(c.id))),
  raw_docs AS MATERIALIZED (
    SELECT l.nro_documento, l.ruc, max(l.ot) AS ot, max(l.tipo_documento) AS tipo_erp,
      max(l.cliente) AS cliente, min(l.fecha_contrato) AS fecha_contrato,
      max(l.fecha_ult_despacho) AS ult_despacho,
      bool_or(l.cant_pendiente > 0 AND NOT l.cantidades_ausentes) AS pendiente
    FROM public.erp_contract_lines l WHERE l.import_id = v_c GROUP BY l.nro_documento, l.ruc),
  normalized AS MATERIALIZED (
    SELECT public.erp_doc_key(nro_documento) AS dk, public.erp_key(nro_documento) AS documento,
      ot,tipo_erp,cliente,public.client_tax_id_norm(ruc) AS ruc,fecha_contrato,ult_despacho,pendiente FROM raw_docs),
  d AS MATERIALIZED (
    SELECT dk,max(documento) AS documento,max(ot) AS ot,max(tipo_erp) AS tipo_erp,max(cliente) AS cliente,
      max(ruc) AS ruc,min(fecha_contrato) AS fecha_contrato,max(ult_despacho) AS ult_despacho,bool_or(pendiente) AS pendiente
    FROM normalized GROUP BY dk),
  f AS MATERIALIZED (
    SELECT d.*, public.erp_tipo_tms(d.tipo_erp) AS tipo, m.id AS madre_id
    FROM d LEFT JOIN madres m ON m.ot = d.ot
    WHERE d.dk NOT IN (SELECT tk.k FROM tk WHERE tk.k IS NOT NULL)
      AND (NOT v_ca OR m.id IS NOT NULL)
      AND (v_tipo IS NULL OR public.erp_tipo_tms(d.tipo_erp) = v_tipo)
      AND (v_q IS NULL OR d.documento LIKE '%' || v_q || '%' OR upper(d.cliente) LIKE '%' || v_q || '%')),
  a AS MATERIALIZED (SELECT * FROM public.erp_ot_actividad((SELECT array_agg(DISTINCT f.ot) FROM f))),
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

-- Los planes con nested loops deshabilitados pueden disparar JIT por su coste artificial.
-- Estas RPC cortas no deben compilar código en cada petición.
ALTER FUNCTION public.erp_ot_actividad(text[]) SET jit = off;
ALTER FUNCTION public.erp_ref_contratos(text[]) SET jit = off;
ALTER FUNCTION public.erp_ref_sin_alta(jsonb) SET jit = off;
NOTIFY pgrst, 'reload schema';
COMMIT;
