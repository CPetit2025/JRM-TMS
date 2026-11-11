-- inv_status recorre inv_movements (~360 mil filas) dos veces para cobertura y huecos. La cabecera de todas las
-- páginas APT (InvHeader) no los usa: con p_full=false se omiten. Sin argumentos se comporta igual que antes.
DROP FUNCTION IF EXISTS public.inv_status();
CREATE OR REPLACE FUNCTION public.inv_status(p_full boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s public.inv_state;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  SELECT * INTO s FROM public.inv_state WHERE id = 1;
  RETURN jsonb_build_object('success', true, 'can_load', public.apt_can_load(),
    'state', jsonb_build_object('dirty', s.dirty, 'rebuilt_at', s.rebuilt_at, 'data_min', s.data_min, 'data_max', s.data_max,
      'model_from', s.model_from, 'snapshot_cutoff', s.snapshot_cutoff, 'stats', s.stats),
    'cobertura', CASE WHEN p_full THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('side', side, 'desde', mn, 'hasta', mx, 'filas', n, 'dias', d) ORDER BY side)
      FROM (SELECT side, min(fecha) mn, max(fecha) mx, count(*) n, count(DISTINCT fecha) d FROM public.inv_movements WHERE active GROUP BY side) c), '[]'::jsonb) END,
    'huecos', CASE WHEN p_full THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('side', side, 'desde', g_from, 'hasta', g_to) ORDER BY side, g_from)
      FROM (SELECT side, fecha + 1 AS g_from, nxt - 1 AS g_to
            FROM (SELECT side, fecha, lead(fecha) OVER (PARTITION BY side ORDER BY fecha) AS nxt
                  FROM (SELECT DISTINCT side, fecha FROM public.inv_movements WHERE active) f) x
            WHERE nxt - fecha > 4) h), '[]'::jsonb) END,
    'cargas', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'side', side, 'file_name', file_name, 'status', status, 'desde', desde,
        'hasta', hasta, 'cutoff', cutoff, 'filas', rows_valid, 'total', rows_total, 'excluidas', excluded, 'reemplazadas', replaced,
        'applied_at', applied_at, 'created_at', created_at) ORDER BY created_at DESC)
      FROM (SELECT * FROM public.inv_uploads WHERE status <> 'DESCARTADA' ORDER BY created_at DESC LIMIT 30) u), '[]'::jsonb));
END $function$;
REVOKE ALL ON FUNCTION public.inv_status(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_status(boolean) TO authenticated, service_role;
