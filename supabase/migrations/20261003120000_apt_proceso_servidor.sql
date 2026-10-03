-- ============================================================
-- APT — Procesar cargas grandes en el servidor (sin el límite de 8 s de las peticiones del navegador)
-- ============================================================
-- Con el reporte total del ERP (≈ 90 000 filas), aplicar la carga y recalcular la estadía y el flujo superaba el
-- límite de 8 s por consulta del rol authenticated ("canceling statement due to statement timeout"). La pantalla ahora
-- llama a /api/apt/procesar: el servidor verifica que el usuario tenga permiso de carga y ejecuta los mismos pasos con
-- la llave de servicio, sin ese límite. Las funciones para el navegador siguen existiendo (cargas pequeñas, pruebas).
BEGIN;

-- Aplicar una carga sin verificar permisos (solo service_role; el permiso lo verifica la ruta del servidor)
CREATE OR REPLACE FUNCTION public.apt_upload_apply_core(p_upload_id uuid, p_rebuild boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE k text; v_from date; v_to date; v_rows integer; v_valid integer; v_removed integer; v_summary jsonb := '{}'::jsonb; v_model jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('apt_rebuild'));
  PERFORM 1 FROM public.apt_uploads WHERE id = p_upload_id AND status = 'CARGANDO' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'La carga no existe o ya fue cerrada'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.apt_movements WHERE upload_id = p_upload_id AND valid) THEN
    RETURN jsonb_build_object('success', false, 'error', 'El archivo no tiene movimientos válidos (revise las hojas ENTRADA, SALIDA o de traspasos)');
  END IF;

  -- Protección: una carga parcial (p. ej. filtrada a un lote) no debe borrar la historia de su rango de fechas
  FOREACH k IN ARRAY ARRAY['ENTRADA', 'SALIDA', 'TRASPASO_SAL', 'TRASPASO_ENT', 'CONSUMO', 'DEVOLUCION'] LOOP
    SELECT min(fecha) FILTER (WHERE valid), max(fecha) FILTER (WHERE valid), count(*) FILTER (WHERE valid)
      INTO v_from, v_to, v_valid
    FROM public.apt_movements WHERE upload_id = p_upload_id AND kind = k;
    IF v_valid > 0 THEN
      SELECT count(*) INTO v_removed FROM public.apt_movements m
      WHERE m.kind = k AND m.active AND m.valid AND m.upload_id <> p_upload_id AND m.fecha BETWEEN v_from AND v_to;
      IF v_removed > 200 AND v_removed > 3 * v_valid THEN
        RETURN jsonb_build_object('success', false, 'error', format(
          'La hoja %s trae %s filas del %s al %s, pero ya hay %s cargadas en ese rango. Parece un archivo parcial o filtrado: cargue el reporte completo de esas fechas.',
          k, v_valid, to_char(v_from, 'DD/MM/YYYY'), to_char(v_to, 'DD/MM/YYYY'), v_removed));
      END IF;
    END IF;
  END LOOP;

  FOREACH k IN ARRAY ARRAY['ENTRADA', 'SALIDA', 'TRASPASO_SAL', 'TRASPASO_ENT', 'CONSUMO', 'DEVOLUCION'] LOOP
    SELECT min(fecha) FILTER (WHERE valid), max(fecha) FILTER (WHERE valid), count(*), count(*) FILTER (WHERE valid)
      INTO v_from, v_to, v_rows, v_valid
    FROM public.apt_movements WHERE upload_id = p_upload_id AND kind = k;
    v_removed := 0;
    IF v_valid > 0 THEN
      -- Reemplaza lo anterior del mismo rango de fechas (y las filas sin fecha de cargas previas)
      DELETE FROM public.apt_movements m
      WHERE m.kind = k AND m.active AND m.upload_id <> p_upload_id
        AND (m.fecha BETWEEN v_from AND v_to OR m.fecha IS NULL);
      GET DIAGNOSTICS v_removed = ROW_COUNT;
    END IF;
    v_summary := v_summary || jsonb_build_object(lower(k), jsonb_build_object(
      'filas', v_rows, 'validas', v_valid, 'excluidas', v_rows - v_valid, 'desde', v_from, 'hasta', v_to, 'reemplazadas', v_removed,
      'tn', (SELECT round(COALESCE(sum(peso_kg), 0) / 1000, 3) FROM public.apt_movements WHERE upload_id = p_upload_id AND kind = k AND valid)));
  END LOOP;

  UPDATE public.apt_movements SET active = true WHERE upload_id = p_upload_id;
  UPDATE public.apt_uploads SET status = 'APLICADA', applied_at = now(), summary = v_summary WHERE id = p_upload_id;
  -- La pantalla recalcula en una segunda llamada (apt_model_rebuild) para no sumar ambos tiempos en una sola petición
  IF p_rebuild THEN v_model := public.apt_rebuild(); END IF;
  RETURN jsonb_build_object('success', true, 'summary', v_summary, 'model', v_model);
END $$;


CREATE OR REPLACE FUNCTION public.apt_upload_apply(p_upload_id uuid, p_rebuild boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar movimientos de APT');
  END IF;
  RETURN public.apt_upload_apply_core(p_upload_id, p_rebuild);
END $$;

REVOKE ALL ON FUNCTION public.apt_upload_apply_core(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_upload_apply_core(uuid, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.apt_rebuild() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_rebuild() TO service_role;
REVOKE ALL ON FUNCTION public.apt_flow_rebuild_core() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_flow_rebuild_core() TO service_role;

COMMIT;
