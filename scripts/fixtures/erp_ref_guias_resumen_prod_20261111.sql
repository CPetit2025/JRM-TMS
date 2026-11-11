CREATE OR REPLACE FUNCTION public.erp_ref_guias_resumen(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET enable_nestloop TO 'off'
AS $function$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); v_out jsonb;
  v_to date := COALESCE(NULLIF(p->>'hasta', '')::date, (now() AT TIME ZONE 'America/Lima')::date);
  v_from date := COALESCE(NULLIF(p->>'desde', '')::date, COALESCE(NULLIF(p->>'hasta', '')::date, (now() AT TIME ZONE 'America/Lima')::date) - 7);
  v_tol integer := greatest(COALESCE((p->>'tolerancia')::integer, 2), 0); v_lim integer := least(greatest(COALESCE((p->>'limit')::integer, 15), 1), 100);
  v_ca boolean := public.is_contract_administrator() AND NOT public.is_tms_admin();
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
  f AS (SELECT * FROM j WHERE fecha_ref BETWEEN v_from AND v_to AND (origen <> 'SOLO_TMS' OR fecha_tms >= (SELECT min(fecha) FROM e))
          -- El Administrador de Contratos solo ve las guías de su cartera
          AND (NOT v_ca OR public.erp_ref_ot_visible(split_part(COALESCE(ots, ot_tms, ''), ', ', 1))))
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
END $function$
