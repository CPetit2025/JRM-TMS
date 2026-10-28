-- Vigencia de la foto de stock del ERP para la programación de rutas. Solo lectura: el planificador ve hasta qué hora es
-- el stock que consulta (corte del Excel «Stock Bodega Despacho») y si está desactualizado según el mismo umbral de horas
-- configurado para el Actualizable (erp_contract_settings.corte_max_horas). No cambia el acceso: usa erp_ref_can_view().
BEGIN;

CREATE OR REPLACE FUNCTION public.erp_stock_corte()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN NOT public.erp_ref_can_view() THEN jsonb_build_object('success', false, 'error', 'Sin acceso a la referencia del ERP')
    ELSE jsonb_build_object('success', true,
      'cut_at', i.cut_at, 'applied_at', i.applied_at,
      'horas', CASE WHEN i.cut_at IS NOT NULL THEN round((extract(epoch FROM now() - i.cut_at) / 3600)::numeric, 1) END,
      'max_horas', COALESCE(s.corte_max_horas, 48),
      'estado', CASE WHEN i.id IS NULL THEN 'SIN_CARGA'
        WHEN i.cut_at IS NULL OR i.cut_at < now() - make_interval(hours => COALESCE(s.corte_max_horas, 48)) THEN 'DESACTUALIZADO'
        ELSE 'VIGENTE' END) END
  FROM (SELECT 1) one
  LEFT JOIN public.erp_imports i ON i.id = public.erp_active_import('STOCK')
  LEFT JOIN public.erp_contract_settings s ON s.id = 1;
$$;
REVOKE ALL ON FUNCTION public.erp_stock_corte() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_stock_corte() TO authenticated;

COMMIT;
