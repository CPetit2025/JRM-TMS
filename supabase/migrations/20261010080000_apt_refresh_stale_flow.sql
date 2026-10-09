-- Las cargas de octubre reemplazaron movimientos, pero un fallo previo de estadía
-- impidió ejecutar el segundo paso (flujo). Actualiza exclusivamente el modelo derivado.
BEGIN;
SET LOCAL statement_timeout='5min';
SET LOCAL lock_timeout='30s';
-- Serializa el flujo con el reemplazo de movimientos; publica la hora real de finalización.
DO $$
DECLARE v_definition text;
 v_old text:='PERFORM pg_advisory_xact_lock(hashtext(''apt_flow_rebuild''));';
 v_new text:=E'PERFORM pg_advisory_xact_lock(hashtext(''apt_rebuild''));\n  PERFORM pg_advisory_xact_lock(hashtext(''apt_flow_rebuild''));';
BEGIN
 v_definition:=pg_get_functiondef('public.apt_flow_rebuild_core()'::regprocedure);
 IF strpos(v_definition,v_new)=0 THEN
  IF strpos(v_definition,v_old)=0 THEN RAISE EXCEPTION 'Revisar los bloqueos del flujo APT antes de recalcular'; END IF;
  v_definition:=replace(v_definition,v_old,v_new);
 END IF;
 EXECUTE replace(v_definition,'rebuilt_at = now()','rebuilt_at = clock_timestamp()');
END $$;
DO $$
DECLARE v_applied timestamptz; v_rebuilt timestamptz; v_result jsonb;
BEGIN
 SELECT max(applied_at) INTO v_applied FROM public.apt_uploads WHERE status='APLICADA';
 SELECT rebuilt_at INTO v_rebuilt FROM public.apt_flow_state WHERE id=1;
 IF v_applied IS NOT NULL AND (v_rebuilt IS NULL OR v_rebuilt<v_applied) THEN
  v_result:=public.apt_flow_rebuild_core();
  IF (v_result->>'success')::boolean IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'No se pudo actualizar el flujo APT: %',v_result;
  END IF;
 END IF;
END $$;
COMMIT;
