-- Cálculo puro y privilegios de producción; sin crear decisiones ni movimientos reales.
BEGIN;
DO $test$
DECLARE p jsonb; shifts jsonb:='[]'; d date; v jsonb; n int:=0;
BEGIN
 FOR d IN SELECT generate_series('2025-03-02'::date,'2025-03-11'::date,interval '1 day')::date LOOP
  shifts:=shifts||jsonb_build_array(jsonb_build_object('date',d,'shift',CASE WHEN extract(isodow FROM d)=7 THEN jsonb_build_object('kind','DESCANSO') ELSE jsonb_build_object('kind','TRABAJO','start','08:00','end',CASE WHEN extract(isodow FROM d)=6 THEN '13:30' ELSE '17:30' END,'next_day',false) END));
 END LOOP;
 p:=jsonb_build_object('shifts',shifts);
 v:=public.gp_plan_measure(p,'2025-03-03 07:00-05','2025-03-03 19:00-05','2025-03-03 13:00-05','2025-03-03 14:00-05');
 IF (v->>'minutes')::int<>150 OR (v->>'ordinary_minutes')::int<>510 OR jsonb_array_length(v->'parts')<>2 THEN RAISE EXCEPTION 'CAJA C148 FAIL: turno diurno %',v; END IF;n:=n+1;
 v:=public.gp_plan_measure(p,'2025-03-03 19:00-05','2025-03-04 07:00-05','2025-03-04 01:00-05','2025-03-04 02:00-05');
 IF (v->>'minutes')::int<>660 OR jsonb_array_length(v->'parts')<>3 THEN RAISE EXCEPTION 'CAJA C148 FAIL: nocturno %',v; END IF;n:=n+1;
 v:=public.gp_plan_measure(p,'2025-03-08 07:00-05','2025-03-08 13:00-05','2025-03-08 10:00-05','2025-03-08 11:00-05');
 IF (v->>'minutes')::int<>60 THEN RAISE EXCEPTION 'CAJA C148 FAIL: sábado mañana %',v; END IF;n:=n+1;
 v:=public.gp_plan_measure(p,'2025-03-08 13:00-05','2025-03-08 19:00-05','2025-03-08 16:00-05','2025-03-08 17:00-05');
 IF (v->>'minutes')::int<>270 THEN RAISE EXCEPTION 'CAJA C148 FAIL: sábado tarde %',v; END IF;n:=n+1;
 v:=public.gp_plan_measure(p,'2025-03-09 07:00-05','2025-03-09 19:00-05','2025-03-09 13:00-05','2025-03-09 14:00-05');
 IF (v->>'minutes')::int<>660 OR EXISTS(SELECT 1 FROM jsonb_array_elements(v->'parts') x WHERE NOT (x->>'rest')::boolean) THEN RAISE EXCEPTION 'CAJA C148 FAIL: domingo %',v; END IF;n:=n+1;
 IF has_function_privilege('authenticated','public.gp_plan_build(uuid,jsonb)','EXECUTE') OR has_function_privilege('authenticated','public.gp_overview_before_parts(jsonb)','EXECUTE') OR has_function_privilege('anon','public.gp_plan_close(jsonb)','EXECUTE') THEN RAISE EXCEPTION 'CAJA C148 FAIL: exposición RPC'; END IF;n:=n+1;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='gp_execution_parts' AND NOT tgisinternal) OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='gp_plan_request_review' AND NOT tgisinternal) THEN RAISE EXCEPTION 'CAJA C148 FAIL: faltan guardas de cierre/revisión'; END IF;n:=n+1;
 v:=public.gp_plan_measure(p,'2025-03-03 17:30:25-05','2025-03-03 19:00:40-05');
 IF (v->>'minutes')::int<>90 OR (v#>>'{parts,0,start}')::timestamptz<>'2025-03-03 17:30:25-05'::timestamptz THEN RAISE EXCEPTION 'CAJA C148 FAIL: precisión de cierre real %',v; END IF;n:=n+1;
 RAISE EXCEPTION 'CAJA C148 PASS: %/% cálculo por tramos y protecciones',n,8;
END $test$;
ROLLBACK;
