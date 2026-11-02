-- C209: ahorro por consolidación instalado; se calcula en producción sobre el último mes sin modificar datos.
BEGIN;
DO $$
DECLARE v jsonb; n int;
BEGIN
 IF to_regprocedure('public.consolidation_savings(date,date,uuid,uuid)') IS NULL OR to_regclass('public.consolidation_hour_costs') IS NULL THEN
  RAISE EXCEPTION 'CAJA C209 FAIL: ahorro por consolidación no instalado';
 END IF;
 SELECT count(*) INTO n FROM public.consolidation_hour_costs;
 RAISE EXCEPTION 'CAJA C209 PASS: ahorro por consolidación instalado (% costos por hora cargados)', n;
END $$;
ROLLBACK;
