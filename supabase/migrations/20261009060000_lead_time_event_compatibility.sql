-- Reuse the established event taxonomy while retaining exact old/new attention times.
BEGIN;
DO $patch$
DECLARE source text;
BEGIN
 SELECT pg_get_functiondef('public.reprogramar_solicitud_at(uuid,timestamptz,text,text,text)'::regprocedure) INTO source;
 IF position('ATTENTION_TIME_CHANGED' IN source)=0 THEN
  RAISE EXCEPTION 'La función de reprogramación cambió: revisar compatibilidad del historial';
 END IF;
 EXECUTE replace(source,'''ATTENTION_TIME_CHANGED''','''UPDATED''');
END $patch$;
COMMIT;
