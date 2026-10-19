-- ============================================================
-- Inventario: aplicar una carga sin chocar con el recálculo automático
-- ============================================================
-- Incidente: al cargar Entradas y Salidas, la primera parte dejaba el modelo pendiente y el recálculo programado
-- (cada 2 min, ~85 s con un año de datos) tomaba el bloqueo del inventario. La segunda parte esperaba ese bloqueo
-- dentro de la petición web y se cortaba por tiempo («la conexión o el procesamiento se interrumpió").
-- 1) El recálculo programado no corre mientras hay una carga en preparación (reciente) ni si el bloqueo está tomado.
-- 2) Aplicar espera como máximo 20 s el bloqueo y, si sigue ocupado, responde busy para que el navegador reintente.
BEGIN;

CREATE OR REPLACE FUNCTION public.inv_upload_apply_core(p_upload_id uuid, p_force boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE u public.inv_uploads; v_from date; v_to date; v_valid integer; v_removed integer := 0; v_lt text := current_setting('lock_timeout');
BEGIN
  -- Si hay un recálculo en curso se espera hasta 20 s; después se responde «ocupado» (el navegador reintenta solo)
  -- en vez de agotar el tiempo de la petición web esperando el bloqueo.
  IF NOT pg_try_advisory_xact_lock(hashtext('inv_rebuild')) THEN
    PERFORM set_config('lock_timeout', '20s', true);
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('inv_rebuild'));
    EXCEPTION WHEN lock_not_available THEN
      PERFORM set_config('lock_timeout', v_lt, true);
      RETURN jsonb_build_object('success', false, 'busy', true,
        'error', 'Se está recalculando el inventario; la carga se aplica en cuanto termine.');
    END;
    PERFORM set_config('lock_timeout', v_lt, true);
  END IF;
  SELECT * INTO u FROM public.inv_uploads WHERE id = p_upload_id FOR UPDATE;
  IF u.status = 'APLICADA' THEN
    RETURN jsonb_build_object('success', true, 'replayed', true, 'side', u.side, 'desde', u.desde, 'hasta', u.hasta,
      'rows', u.rows_valid, 'replaced', u.replaced);
  END IF;
  IF u.status = 'DESCARTADA' THEN RETURN jsonb_build_object('success', false, 'error', 'La carga fue descartada'); END IF;
  IF u.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'La carga no existe o ya fue cerrada'); END IF;

  IF u.side = 'STOCK' THEN
    IF NOT EXISTS (SELECT 1 FROM public.inv_stock_snapshots WHERE upload_id = u.id) THEN
      RETURN jsonb_build_object('success', false, 'error', 'La foto de stock no tiene filas con cantidad positiva');
    END IF;
    UPDATE public.inv_uploads SET status = 'APLICADA', applied_at = now(), desde = u.cutoff, hasta = u.cutoff WHERE id = u.id;
  ELSE
    SELECT min(fecha), max(fecha), count(*) INTO v_from, v_to, v_valid FROM public.inv_movements WHERE upload_id = u.id;
    IF v_valid = 0 THEN RETURN jsonb_build_object('success', false, 'error', 'El archivo no tiene movimientos válidos'); END IF;
    SELECT count(*) INTO v_removed FROM public.inv_movements m
    WHERE m.side = u.side AND m.active AND m.fecha BETWEEN v_from AND v_to;
    -- Protección: un archivo filtrado (p. ej. una sola bodega) no debe borrar la historia completa de su rango
    IF NOT p_force AND v_removed > 200 AND v_removed > 3 * v_valid THEN
      RETURN jsonb_build_object('success', false, 'partial', true, 'error', format(
        'El archivo trae %s filas del %s al %s, pero ya hay %s cargadas en ese rango. Parece un reporte parcial o filtrado: cargue el reporte completo de esas fechas.',
        v_valid, to_char(v_from, 'DD/MM/YYYY'), to_char(v_to, 'DD/MM/YYYY'), v_removed));
    END IF;
    DELETE FROM public.inv_movements m WHERE m.side = u.side AND m.active AND m.fecha BETWEEN v_from AND v_to;
    UPDATE public.inv_movements SET active = true WHERE upload_id = u.id;
    UPDATE public.inv_uploads SET status = 'APLICADA', applied_at = now(), desde = v_from, hasta = v_to, replaced = v_removed
    WHERE id = u.id;
  END IF;
  UPDATE public.inv_state SET dirty = true WHERE id = 1;
  RETURN jsonb_build_object('success', true, 'side', u.side, 'desde', COALESCE(v_from, u.cutoff), 'hasta', COALESCE(v_to, u.cutoff),
    'rows', COALESCE(v_valid, u.rows_valid), 'replaced', v_removed);
END $$;
REVOKE ALL ON FUNCTION public.inv_upload_apply_core(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_upload_apply_core(uuid, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.inv_rebuild_if_dirty()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.inv_state WHERE id = 1 AND dirty) THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'sin cambios');
  END IF;
  -- Una carga en preparación aplicará más partes y pedirá su propio recálculo: no bloquearla
  IF EXISTS (SELECT 1 FROM public.inv_uploads WHERE status = 'CARGANDO' AND created_at > now() - interval '45 minutes') THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'carga en curso');
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('inv_rebuild')) THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'recálculo en curso');
  END IF;
  PERFORM public.inv_rebuild();
  RETURN jsonb_build_object('success', true, 'rebuilt', true);
END $$;
REVOKE ALL ON FUNCTION public.inv_rebuild_if_dirty() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_rebuild_if_dirty() TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
