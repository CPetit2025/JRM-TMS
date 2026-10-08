-- Gantt APT precalculado: el rango de datos (data_max) y la cobertura dependen de los movimientos, no del
-- recálculo del flujo. Si una carga se aplica o descarta y el recálculo falla o queda pendiente, el Gantt
-- debe mostrar el rango vigente. Se actualizan también cuando cambia el estado de una carga.
BEGIN;
CREATE OR REPLACE FUNCTION public.apt_gantt_meta_movements() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.apt_gantt_meta SET
    data_max=(SELECT max(fecha) FROM public.apt_movements WHERE active AND valid),
    coverage=(SELECT COALESCE(jsonb_agg(jsonb_build_object('tipo',kind,'desde',f0,'hasta',f1,'filas',n,'sin_peso',sp) ORDER BY kind),'[]')
      FROM (SELECT kind,min(fecha) AS f0,max(fecha) AS f1,count(*) AS n,count(*) FILTER(WHERE peso_kg IS NULL OR peso_kg<=0) AS sp
        FROM public.apt_movements WHERE active AND valid GROUP BY kind) c)
  WHERE id=1;
$$;
REVOKE ALL ON FUNCTION public.apt_gantt_meta_movements() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_gantt_meta_movements() TO service_role;

CREATE OR REPLACE FUNCTION public.apt_gantt_meta_uploads_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN PERFORM public.apt_gantt_meta_movements(); RETURN NULL; END $$;
REVOKE ALL ON FUNCTION public.apt_gantt_meta_uploads_trigger() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS apt_uploads_gantt_meta ON public.apt_uploads;
CREATE TRIGGER apt_uploads_gantt_meta AFTER UPDATE OF status ON public.apt_uploads
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND 'APLICADA' IN (OLD.status, NEW.status))
  EXECUTE FUNCTION public.apt_gantt_meta_uploads_trigger();
SELECT public.apt_gantt_meta_movements();
COMMIT;
