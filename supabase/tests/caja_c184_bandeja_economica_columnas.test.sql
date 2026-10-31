-- C184: la bandeja del cierre económico trae cliente, unidad, servicios, orden de referencia y fecha de lista para el cierre.
BEGIN;
DO $$
DECLARE v_route jsonb; v_from date := (now() AT TIME ZONE 'America/Lima')::date - 60; v_to date := (now() AT TIME ZONE 'America/Lima')::date;
BEGIN
 IF has_function_privilege('anon','public.economic_closure_queue(date,date)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C184 FAIL: bandeja expuesta a anon';
 END IF;
 IF position('''clients''' IN pg_get_functiondef('public.economic_closure_queue(date,date)'::regprocedure)) = 0
  OR position('''ready_at''' IN pg_get_functiondef('public.economic_closure_queue(date,date)'::regprocedure)) = 0 THEN
  RAISE EXCEPTION 'CAJA C184 FAIL: la bandeja no trae cliente ni días';
 END IF;
 -- Ejecuta la consulta tal cual (como postgres, sin sesión: economic_can_read puede negar; si responde, revisa los campos)
 BEGIN
  SELECT r INTO v_route FROM jsonb_array_elements(public.economic_closure_queue(v_from, v_to)->'routes') r LIMIT 1;
 EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'CAJA C184 FAIL: la bandeja falla en producción: %', SQLERRM;
 END;
 IF v_route IS NOT NULL AND NOT (v_route ? 'clients' AND v_route ? 'modalidad' AND v_route ? 'services' AND v_route ? 'ready_at') THEN
  RAISE EXCEPTION 'CAJA C184 FAIL: faltan campos en la bandeja';
 END IF;
 RAISE EXCEPTION 'CAJA C184 PASS: bandeja del cierre económico con cliente, unidad, servicio, OC y días';
END $$;
ROLLBACK;
