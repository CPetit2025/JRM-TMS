-- Puesta en marcha: catálogo y conteos agregados; no modifica datos de colaboradores.
BEGIN;
DO $test$
DECLARE missing int; active_people int; scheduled_people int; pending_minutes bigint; cron_ready boolean:=false;
BEGIN
 IF to_regprocedure('public.gp_schedule_save(jsonb)') IS NULL OR to_regprocedure('public.gp_permit(jsonb)') IS NULL
 OR to_regprocedure('public.gp_overtime_validate(jsonb)') IS NULL THEN RAISE EXCEPTION 'CAJA C147 FAIL: faltan RPC de Gestión de Personal'; END IF;
 IF has_function_privilege('anon','public.gp_permit(jsonb)','EXECUTE')
 OR has_table_privilege('authenticated','public.gp_permits','SELECT') THEN RAISE EXCEPTION 'CAJA C147 FAIL: exposición directa'; END IF;
 SELECT count(*) INTO active_people FROM public.hhee_people h JOIN public.hhee_areas a ON a.id=h.area_id WHERE h.active AND a.active AND a.module_enabled;
 SELECT count(DISTINCT h.id) INTO scheduled_people FROM public.hhee_people h JOIN public.hhee_areas a ON a.id=h.area_id
 JOIN public.gp_schedules s ON s.person_id=h.id WHERE h.active AND a.active AND a.module_enabled AND s.valid_from<=(now() AT TIME ZONE 'America/Lima')::date
 AND (s.valid_to IS NULL OR s.valid_to>=(now() AT TIME ZONE 'America/Lima')::date);
 SELECT COALESCE(sum(actual_minutes),0) INTO pending_minutes FROM public.hhee_lines WHERE compensation AND actual_end IS NOT NULL AND gp_validated_at IS NULL;
 IF to_regclass('cron.job') IS NOT NULL THEN
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM cron.job WHERE jobname=''hhee-rutas-fuera-de-horario'' AND active)' INTO cron_ready;
 END IF;
 RAISE EXCEPTION 'CAJA C147 PASS: RPC privadas; personal activo %, con horario %, min históricos por revisar %, cron de rutas activo %',active_people,scheduled_people,pending_minutes,cron_ready;
END $test$;
ROLLBACK;
