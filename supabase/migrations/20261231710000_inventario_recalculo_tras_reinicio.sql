-- ============================================================
-- Inventario: el recálculo tras un reinicio de la base tiene tiempo para terminar
-- ============================================================
-- Las tablas derivadas del inventario son UNLOGGED (20261020200000): tras una caída de la base quedan vacías y el
-- recálculo programado las rehace desde cero. El 27/11 la base se reinició a las 11:28 y, con la memoria fría, ese
-- recálculo completo no entró en los 5 minutos del cron: se cortaba y reintentaba cada ~5 minutos durante horas
-- (la base ocupada todo el tiempo y el inventario «se está preparando»). Con las tablas vacías el cron da ahora
-- 20 minutos a una sola corrida; con datos, sigue con 5 minutos (una corrida normal sin cambios tarda milisegundos).
BEGIN;
SET LOCAL lock_timeout = '60s';

CREATE OR REPLACE FUNCTION public.inv_recalculo_timeout()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.inv_layers) THEN '5min' ELSE '20min' END;
$$;
REVOKE ALL ON FUNCTION public.inv_recalculo_timeout() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_recalculo_timeout() TO service_role;
COMMENT ON FUNCTION public.inv_recalculo_timeout() IS 'Límite del cron inventario-recalculo: 20min si las tablas derivadas están vacías (tras un reinicio), si no 5min.';

-- set_config fija el límite de la sentencia siguiente del mismo comando (igual que el SET anterior); se conserva
-- el estado activo del job (por si estaba pausado a mano)
DO $$
DECLARE v_active boolean;
BEGIN
  SELECT active INTO v_active FROM cron.job WHERE jobname = 'inventario-recalculo';
  IF FOUND THEN PERFORM cron.unschedule('inventario-recalculo'); END IF;
  PERFORM cron.schedule('inventario-recalculo', '*/2 * * * *',
    $c$SELECT set_config('statement_timeout', public.inv_recalculo_timeout(), false); SELECT public.cron_recalculo_en_cola('inventario');$c$);
  IF v_active IS FALSE THEN
    PERFORM cron.alter_job(jobid, active := false) FROM cron.job WHERE jobname = 'inventario-recalculo';
  END IF;
END $$;

COMMIT;
