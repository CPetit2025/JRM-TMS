-- Diagnóstico agregado de C213: solo lecturas y tabla temporal; no publica personas ni registros de negocio.
BEGIN;
SET LOCAL statement_timeout = '60s';
CREATE TEMP TABLE fleet_perf_metrics (name text, elapsed_ms numeric, success boolean) ON COMMIT DROP;
DO $$
DECLARE actor uuid; result jsonb; started timestamptz;
 from_date date := (now() AT TIME ZONE 'America/Lima')::date - 30;
 to_date date := (now() AT TIME ZONE 'America/Lima')::date;
BEGIN
 SELECT p.id INTO actor FROM public.profiles p JOIN auth.users u ON u.id=p.id
 JOIN public.roles r ON r.id=p.role_id WHERE p.is_active AND r.name='Administrador' LIMIT 1;
 IF actor IS NULL THEN RAISE EXCEPTION 'Falta administrador activo para la medición'; END IF;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
 started := clock_timestamp(); result := public.consolidation_savings(from_date,to_date);
 INSERT INTO fleet_perf_metrics VALUES('consolidation_savings',round(extract(epoch FROM clock_timestamp()-started)*1000,1),COALESCE((result->>'success')::boolean,false));
 started := clock_timestamp(); result := public.fleet_workdays(from_date,to_date);
 INSERT INTO fleet_perf_metrics VALUES('fleet_workdays',round(extract(epoch FROM clock_timestamp()-started)*1000,1),COALESCE((result->>'success')::boolean,false));
END $$;
SELECT 'FLEET_PERFORMANCE' AS section, jsonb_build_object('function',name,'elapsed_ms',elapsed_ms,'success',success) AS finding FROM fleet_perf_metrics;
ROLLBACK;
