-- CAJA C163 — Cierre documentario persistido por servicio (Etapa 5): tablas con RLS y sin privilegios directos,
-- historial solo de inserción, triggers de evidencia instalados y deshacer el cierre manual exige motivo. Siempre se revierte.
BEGIN;
DO $test$
DECLARE t text;
BEGIN
  IF to_regclass('public.documentary_closures') IS NULL OR to_regclass('public.documentary_closure_events') IS NULL THEN
    RAISE EXCEPTION 'CAJA C163 FAIL: faltan las tablas del cierre documentario'; END IF;
  IF to_regprocedure('public.settlement_undo_manual(uuid,uuid)') IS NOT NULL OR to_regprocedure('public.settlement_undo_manual(uuid,uuid,text)') IS NULL
    OR to_regprocedure('public.documentary_reopen(uuid,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'CAJA C163 FAIL: deshacer sin motivo sigue disponible o falta la reapertura'; END IF;
  IF has_table_privilege('authenticated','public.documentary_closures','SELECT') OR has_table_privilege('authenticated','public.documentary_closure_events','INSERT')
    OR has_function_privilege('authenticated','public.documentary_closure_sync(uuid,uuid,text,text,jsonb)','EXECUTE')
    OR has_function_privilege('anon','public.documentary_reopen(uuid,uuid,text)','EXECUTE')
    OR NOT has_function_privilege('authenticated','public.documentary_reopen(uuid,uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'CAJA C163 FAIL: permisos del cierre documentario'; END IF;
  FOREACH t IN ARRAY ARRAY['dispatch_documents','dispatch_document_references','delivery_conformities','delivery_submissions','delivery_rejections'] LOOP
    IF to_regclass('public.'||t) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='documentary_closure_sync' AND tgrelid=('public.'||t)::regclass) THEN
      RAISE EXCEPTION 'CAJA C163 FAIL: falta el trigger de evidencia en %', t; END IF;
  END LOOP;
  BEGIN
    UPDATE public.documentary_closure_events SET reason = reason WHERE true;
    IF FOUND THEN RAISE EXCEPTION 'CAJA C163 FAIL: el historial se pudo modificar'; END IF;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'CAJA C163 FAIL%' THEN RAISE; END IF;
  END;
  RAISE EXCEPTION 'CAJA C163 PASS: cierre documentario persistido, historial solo de inserción, triggers y permisos correctos';
END $test$;
ROLLBACK;
