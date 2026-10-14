-- CAJA C103 — La guía del conductor no se bloquea por falta de un punto GPS de los 45 s previos: se usa el último punto
-- del despacho y el tramo queda «GPS incompleto». Solo lectura del catálogo; siempre se revierte.
BEGIN;
DO $test$
DECLARE def text := pg_get_functiondef('public.delivery_submit_driver(uuid,uuid,text[],text,text,text,uuid,timestamptz)'::regprocedure);
BEGIN
  IF position('Se requiere GPS de la captura' IN def) > 0 THEN RAISE EXCEPTION 'CAJA C103 FAIL: el envío sigue exigiendo GPS reciente (T1)'; END IF;
  IF position('Sin GPS reciente' IN def) = 0 OR position('complete:=COALESCE(complete,false) AND point.id IS NOT NULL' IN def) = 0 THEN
    RAISE EXCEPTION 'CAJA C103 FAIL: falta el respaldo con el último punto y la marca de GPS incompleto (T2)'; END IF;
  IF has_function_privilege('anon', 'public.delivery_submit_driver(uuid,uuid,text[],text,text,text,uuid,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'CAJA C103 FAIL: expuesta a anónimos (T3)'; END IF;
  RAISE EXCEPTION 'CAJA C103 PASS (3/3) guía del conductor sin GPS reciente: último punto del despacho y tramo con GPS incompleto';
END $test$;
ROLLBACK;
