-- C206: cierre final del servicio instalado (estados independientes, historial inalterable, sin RLS abierta) y los
-- estados se calculan para los viajes cerrados recientes sin error. Informa cuántos viajes están listos para cerrar.
BEGIN;
DO $$
DECLARE v_ready int; v_total int;
BEGIN
 IF to_regprocedure('public.dispatch_final_close(uuid,text,boolean)') IS NULL OR to_regprocedure('public.dispatch_closure_status(uuid[])') IS NULL
    OR to_regprocedure('public.dispatch_final_reopen(uuid,text)') IS NULL THEN
  RAISE EXCEPTION 'CAJA C206 FAIL: cierre final del servicio no instalado';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'dispatch_final_close_events_append_only') THEN
  RAISE EXCEPTION 'CAJA C206 FAIL: el historial del cierre final se puede modificar';
 END IF;
 IF has_table_privilege('authenticated', 'public.dispatch_final_closures', 'INSERT') OR has_table_privilege('authenticated', 'public.dispatch_final_close_events', 'DELETE') THEN
  RAISE EXCEPTION 'CAJA C206 FAIL: el cierre final se escribe sin pasar por sus validaciones';
 END IF;
 SELECT count(*), count(*) FILTER (WHERE (public.dispatch_closure_checks(d.id)->>'ready')::boolean) INTO v_total, v_ready
 FROM (SELECT id FROM public.dispatches WHERE status = 'LIQUIDADO' ORDER BY scheduled_departure DESC NULLS LAST LIMIT 300) d;
 RAISE EXCEPTION 'CAJA C206 PASS: cierre final instalado (% de % rutas cerradas recientes listas para el cierre final)', v_ready, v_total;
END $$;
ROLLBACK;
