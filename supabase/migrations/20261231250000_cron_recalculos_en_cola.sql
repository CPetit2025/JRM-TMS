-- Los recálculos pesados (inventario, modelos APT y caché de lecturas) corrían a la vez tras cada carga del ERP y
-- agotaban la memoria de la instancia (caídas del 23/11 17:04 y 25/11 09:18). Ahora comparten un solo turno:
-- si otro está corriendo, este se salta y lo reintenta el cron en el siguiente minuto.
CREATE OR REPLACE FUNCTION public.cron_recalculo_en_cola(p_job text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
BEGIN
  IF p_job NOT IN ('inventario','estadia','flujo','cache') THEN RAISE EXCEPTION 'Recálculo inválido: %', p_job; END IF;
  -- Lock de transacción: el cron ejecuta su comando en una sola transacción, se libera al terminar
  IF NOT pg_try_advisory_xact_lock(hashtext('cron_recalculo_pesado')) THEN
    RETURN jsonb_build_object('skipped', 'otro recálculo en curso');
  END IF;
  RETURN CASE p_job
    WHEN 'inventario' THEN public.inv_rebuild_if_dirty()
    WHEN 'cache' THEN jsonb_build_object('built', public.apt_read_cache_warm())
    ELSE public.apt_models_ensure_current_core(p_job) END;
END $$;
REVOKE ALL ON FUNCTION public.cron_recalculo_en_cola(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_recalculo_en_cola(text) TO service_role;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('inventario-recalculo', '*/2 * * * *', 'inventario'),
    ('apt-modelo-estadia', '* * * * *', 'estadia'),
    ('apt-modelo-flujo', '* * * * *', 'flujo'),
    ('apt-cache-lecturas', '* * * * *', 'cache')) v(jobname, schedule, job)
  LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = r.jobname) THEN PERFORM cron.unschedule(r.jobname); END IF;
    PERFORM cron.schedule(r.jobname, r.schedule,
      format($c$SET statement_timeout='5min'; SELECT public.cron_recalculo_en_cola(%L);$c$, r.job));
  END LOOP;
END $$;
