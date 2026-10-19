-- ============================================================
-- Inventario multi-almacén: recálculo automático en el servidor
-- ============================================================
-- Con un año de movimientos el recálculo puede tardar más que la petición web (la carga queda aplicada pero el modelo
-- pendiente). Un trabajo programado cada 2 minutos recalcula si hay cargas o cambios de catálogo pendientes, sin límite
-- de tiempo de la web. Si otro recálculo está en curso, espera al siguiente turno.
BEGIN;

CREATE OR REPLACE FUNCTION public.inv_rebuild_if_dirty()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.inv_state WHERE id = 1 AND dirty) THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'sin cambios');
  END IF;
  IF NOT pg_try_advisory_lock(hashtext('inv_rebuild_cron')) THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'recálculo en curso');
  END IF;
  BEGIN
    PERFORM public.inv_rebuild();
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_advisory_unlock(hashtext('inv_rebuild_cron'));
    RAISE;
  END;
  PERFORM pg_advisory_unlock(hashtext('inv_rebuild_cron'));
  RETURN jsonb_build_object('success', true, 'rebuilt', true);
END $$;
REVOKE ALL ON FUNCTION public.inv_rebuild_if_dirty() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_rebuild_if_dirty() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN PERFORM cron.unschedule('inventario-recalculo'); EXCEPTION WHEN OTHERS THEN NULL; END;
    PERFORM cron.schedule('inventario-recalculo', '*/2 * * * *', $cron$SELECT public.inv_rebuild_if_dirty()$cron$);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
