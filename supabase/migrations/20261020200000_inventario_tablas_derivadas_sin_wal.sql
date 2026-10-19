-- ============================================================
-- Inventario: tablas derivadas sin registro de transacciones (menos escritura en disco)
-- ============================================================
-- El recálculo vacía y rehace por completo capas, consumos y enlaces de traspaso (~250 mil filas con índices), y la
-- caché de lecturas se rehace tras cada recálculo. Con un disco de E/S limitada, escribir además todo eso en el
-- registro de transacciones (WAL) duplicaba la escritura y el recálculo superaba su presupuesto de tiempo (C117).
-- Como tablas UNLOGGED no pasan por el WAL. Son reconstruibles: si tras un reinicio de la base quedan vacías,
-- el recálculo programado las rehace (abajo) y mientras tanto las lecturas responden «se está preparando».
-- Además, el recálculo vuelve a actualizar las estadísticas de inv_movements (no de la vista).
BEGIN;
SET LOCAL lock_timeout = '60s';

ALTER TABLE public.inv_allocations SET UNLOGGED;
ALTER TABLE public.inv_transfer_links SET UNLOGGED;
ALTER TABLE public.inv_layers SET UNLOGGED;
ALTER TABLE public.inv_stock_cache SET UNLOGGED;
ALTER TABLE public.inv_read_cache SET UNLOGGED;

-- El recálculo lee los movimientos por la vista inv_movements_v (20261020190000), pero sus estadísticas deben
-- actualizarse sobre la tabla: ANALYZE de una vista no hace nada
DO $migration$
DECLARE src text := pg_get_functiondef('public.inv_rebuild()'::regprocedure);
BEGIN
  IF position('ANALYZE public.inv_movements_v;' IN src) > 0 THEN
    EXECUTE replace(src, 'ANALYZE public.inv_movements_v;', 'ANALYZE public.inv_movements;');
  END IF;
END $migration$;

-- Recálculo programado: también rehace el modelo si quedó vacío (p. ej. tras un reinicio) habiendo movimientos
CREATE OR REPLACE FUNCTION public.inv_rebuild_if_dirty()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_rebuilt boolean := false; v_vacio boolean;
BEGIN
  v_vacio := NOT EXISTS (SELECT 1 FROM public.inv_layers) AND EXISTS (SELECT 1 FROM public.inv_movements WHERE active);
  IF v_vacio OR EXISTS (SELECT 1 FROM public.inv_state WHERE id = 1 AND dirty) THEN
    -- Una carga en preparación aplicará más partes y pedirá su propio recálculo: no bloquearla
    IF EXISTS (SELECT 1 FROM public.inv_uploads WHERE status = 'CARGANDO' AND created_at > now() - interval '45 minutes') THEN
      RETURN jsonb_build_object('success', true, 'skipped', 'carga en curso');
    END IF;
    IF NOT pg_try_advisory_xact_lock(hashtext('inv_rebuild')) THEN
      RETURN jsonb_build_object('success', true, 'skipped', 'recálculo en curso');
    END IF;
    PERFORM public.inv_rebuild();
    v_rebuilt := true;
  ELSIF EXISTS (SELECT 1 FROM public.inv_read_cache c, public.inv_state s
                WHERE c.k = 'stock' AND s.id = 1 AND c.stamp IS NOT DISTINCT FROM s.rebuilt_at)
        OR NOT EXISTS (SELECT 1 FROM public.inv_state WHERE id = 1 AND rebuilt_at IS NOT NULL) THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'sin cambios');
  END IF;
  RETURN jsonb_build_object('success', true, 'rebuilt', v_rebuilt, 'cache', public.inv_cache_refresh());
END $$;
REVOKE ALL ON FUNCTION public.inv_rebuild_if_dirty() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_rebuild_if_dirty() TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
