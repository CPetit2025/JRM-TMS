-- Fase 4: tareas programadas del modelo de almacén, iguales a las del TMS (recálculo de inventario, modelos APT de
-- estadía y flujo, y caché de lecturas). Sin pg_cron (p. ej. en las pruebas locales) la migración no hace nada.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN RETURN; END IF;
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.schedule('inventario-recalculo', '*/2 * * * *', $c$SET statement_timeout = '5min'; SELECT public.inv_rebuild_if_dirty();$c$);
  PERFORM cron.schedule('apt-modelo-estadia', '* * * * *', $c$SET statement_timeout='5min'; SELECT public.apt_models_ensure_current_core('estadia');$c$);
  PERFORM cron.schedule('apt-modelo-flujo', '* * * * *', $c$SET statement_timeout='5min'; SELECT public.apt_models_ensure_current_core('flujo');$c$);
  PERFORM cron.schedule('apt-cache-turno', '* * * * *', $c$SELECT public.apt_read_cache_claim()$c$);
  PERFORM cron.schedule('apt-cache-lecturas', '* * * * *', $c$SET statement_timeout='5min'; SELECT public.apt_read_cache_warm();$c$);
END $$;
