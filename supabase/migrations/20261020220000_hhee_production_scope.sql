-- Production profiles includes an "area" column that is absent in older schemas.
-- Every HHEE table column in these RPCs is qualified; unqualified names intentionally
-- refer to the function's local scope (area/site/config/etc.). Preserve that intent
-- even when an existing ERP/profile table has an optional column with the same name.
-- Keep function signatures, security attributes and grants; no business rows change.
BEGIN;
DO $migration$
DECLARE fn record; definition text; patched text;
BEGIN
 FOR fn IN
  SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   JOIN pg_language l ON l.oid=p.prolang
  WHERE n.nspname='public' AND l.lanname='plpgsql' AND p.proname IN
   ('hhee_context','hhee_minutes','hhee_local_time','hhee_reference_search','hhee_mutate','hhee_attendance','hhee_read','hhee_detail')
 LOOP
  definition:=pg_get_functiondef(fn.oid);
  IF position('#variable_conflict use_variable' IN definition)>0 THEN CONTINUE; END IF;
  patched:=replace(definition,'AS $function$',E'AS $function$\n#variable_conflict use_variable');
  IF patched=definition THEN RAISE EXCEPTION 'Cannot identify HHEE function body: %',fn.oid::regprocedure; END IF;
  EXECUTE patched;
 END LOOP;
END $migration$;
COMMIT;
