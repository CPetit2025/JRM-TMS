-- Almacén APT: estado de vinculación de la carga única (solo lectura).
-- Una carga en «Cargar datos del ERP» alimenta el inventario multi-almacén, el APT clásico (y con él el peso APT de
-- Registro de Servicios) y la Analítica APT y Distribución. Esta función muestra, para cada uno, qué rango de fechas
-- tiene y desde dónde calcula, para detectar lo que quedó sin vincular: p. ej. una foto de stock posterior hace que el
-- inventario ignore los movimientos anteriores a su corte, o el APT clásico quedó con un corte manual o sin recalcular.
BEGIN;

CREATE OR REPLACE FUNCTION public.apt_vinculacion_estado() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s record; v_inv jsonb; v_apt jsonb; v_apa jsonb; v_srv jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT (public.has_tms_read_permission('apt') OR public.has_tms_read_permission('apt-carga') OR public.is_tms_admin()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para consultar el Almacén APT');
  END IF;

  SELECT * INTO s FROM public.inv_state WHERE id = 1;
  SELECT jsonb_build_object(
      'data_min', s.data_min, 'data_max', s.data_max, 'model_from', s.model_from, 'snapshot_cutoff', s.snapshot_cutoff,
      'dirty', COALESCE(s.dirty, false), 'rebuilt_at', s.rebuilt_at,
      'movimientos', count(*),
      'sin_usar', count(*) FILTER (WHERE s.model_from IS NOT NULL AND m.fecha < s.model_from),
      'sin_usar_desde', min(m.fecha) FILTER (WHERE s.model_from IS NOT NULL AND m.fecha < s.model_from),
      'sin_usar_hasta', max(m.fecha) FILTER (WHERE s.model_from IS NOT NULL AND m.fecha < s.model_from),
      'cargas_en_preparacion', (SELECT count(*) FROM public.inv_uploads WHERE status = 'CARGANDO'),
      'fotos_stock', (SELECT count(*) FROM public.inv_uploads WHERE side = 'STOCK' AND status = 'APLICADA'))
  INTO v_inv FROM public.inv_movements m WHERE m.active;

  SELECT jsonb_build_object('data_min', a.data_min, 'data_max', a.data_max, 'cutoff', a.cutoff, 'rebuilt_at', a.rebuilt_at,
      'corte_manual', (SELECT cutoff_date FROM public.apt_settings ORDER BY id LIMIT 1),
      'ultima_carga', (SELECT applied_at FROM public.apt_uploads WHERE status = 'APLICADA' ORDER BY applied_at DESC NULLS LAST LIMIT 1))
  INTO v_apt FROM public.apt_state a ORDER BY a.id LIMIT 1;

  SELECT jsonb_build_object('importaciones', count(*), 'desde', min(period_from), 'hasta', max(period_to),
      'filas', COALESCE(sum(rows_accepted), 0), 'ultima', max(activated_at))
  INTO v_apa FROM public.apa_imports WHERE status = 'ACTIVA' AND source_type IN ('ENTRADAS', 'SALIDAS', 'MOVIMIENTOS');

  SELECT jsonb_build_object('con_guia', count(*) FILTER (WHERE COALESCE(referral_guide, '') <> ''),
      'con_peso', (SELECT count(*) FROM public.contract_service_peso_apt))
  INTO v_srv FROM public.contract_services WHERE COALESCE(status, '') <> 'ANULADO';

  RETURN jsonb_build_object('success', true, 'inventario', v_inv, 'clasico', COALESCE(v_apt, '{}'::jsonb),
    'analitica', v_apa, 'servicios', v_srv);
END $$;

REVOKE ALL ON FUNCTION public.apt_vinculacion_estado() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_vinculacion_estado() TO authenticated;

COMMIT;
