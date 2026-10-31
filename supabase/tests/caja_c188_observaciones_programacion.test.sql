-- C188: observaciones operativas de la programación — columna y función instaladas, sin acceso anónimo.
BEGIN;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='dispatches' AND column_name='programming_notes') THEN
  RAISE EXCEPTION 'CAJA C188 FAIL: falta dispatches.programming_notes';
 END IF;
 IF NOT has_function_privilege('authenticated','public.set_dispatch_programming_notes(uuid,text)','EXECUTE')
  OR has_function_privilege('anon','public.set_dispatch_programming_notes(uuid,text)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C188 FAIL: permisos de set_dispatch_programming_notes';
 END IF;
 RAISE EXCEPTION 'CAJA C188 PASS: observaciones operativas de la programación instaladas';
END $$;
ROLLBACK;
