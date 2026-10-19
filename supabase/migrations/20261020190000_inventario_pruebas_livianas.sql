-- ============================================================
-- Inventario: alcance acotado para pruebas (sin tocar los datos reales)
-- ============================================================
-- Las pruebas de caja aislaban el inventario desactivando los ~200 mil movimientos reales dentro de su transacción
-- (UPDATE masivo, revertido al final). En una base con poco disco eso agotó el presupuesto de E/S y las pruebas se
-- cortaron por tiempo. Ahora una prueba fija inv.scope (patrón de bodega, p. ej. 'C115 %') y el recálculo y las
-- lecturas del modelo solo ven esos movimientos. Sin inv.scope (uso normal) se ven todos, como antes.
BEGIN;
SET LOCAL lock_timeout = '60s';

CREATE OR REPLACE VIEW public.inv_movements_v WITH (security_barrier = false) AS
  SELECT * FROM public.inv_movements
  WHERE COALESCE(current_setting('inv.scope', true), '') = '' OR bodega LIKE current_setting('inv.scope', true);
REVOKE ALL ON public.inv_movements_v FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.inv_movements_v TO service_role;
COMMENT ON VIEW public.inv_movements_v IS 'inv_movements limitado por inv.scope (solo pruebas); sin inv.scope devuelve todo.';

-- Las funciones del modelo leen los movimientos a través de la vista (mismo código, otro origen)
DO $migration$
DECLARE f text; src text; n integer;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.inv_rebuild()', 'public.inv_verify_live()', 'public.inv_overview_live(date,date)',
    'public.inv_dwell_live(jsonb)', 'public.inv_flow_live(jsonb)', 'public.inv_catalogs_live()', 'public.inv_stock_live(jsonb)',
    'public.inv_cache_refresh()'] LOOP
    src := pg_get_functiondef(f::regprocedure);
    n := (length(src) - length(regexp_replace(src, 'public\.inv_movements\M', '', 'g'))) / length('public.inv_movements');
    IF n = 0 THEN RAISE EXCEPTION 'La función % no lee inv_movements: revisar antes de migrar', f; END IF;
    EXECUTE regexp_replace(src, 'public\.inv_movements\M', 'public.inv_movements_v', 'g');
  END LOOP;
END $migration$;

NOTIFY pgrst, 'reload schema';
COMMIT;
