-- Crear una carga no debe esperar la limpieza de cargas antiguas ni sus borrados
-- en cascada. Un movimiento bloqueado de una carga abandonada hacía vencer el
-- statement_timeout del navegador antes de recibir siquiera el upload_id.
-- Conservar la definición instalada, la autorización, el propietario y los ACL.
BEGIN;
DO $migration$
DECLARE
  definition text;
  cleanup constant text := 'DELETE FROM public.apt_uploads WHERE status = ''CARGANDO'' AND created_at < now() - interval ''1 day'';';
BEGIN
  SELECT pg_get_functiondef('public.apt_upload_begin(text)'::regprocedure) INTO definition;
  IF position(cleanup IN definition) = 0 THEN
    IF position('APT_BEGIN_NO_CLEANUP' IN definition) > 0 THEN RETURN; END IF;
    RAISE EXCEPTION 'apt_upload_begin no tiene el punto de limpieza esperado; revisar la definición instalada';
  END IF;
  definition := replace(definition, '-- Cargas abandonadas a medio subir',
    '-- El mantenimiento de cargas antiguas debe ejecutarse fuera del inicio interactivo.');
  EXECUTE replace(definition, cleanup,
    '-- APT_BEGIN_NO_CLEANUP: crear solo la carga solicitada, sin tocar cargas anteriores.');
END $migration$;
COMMIT;
NOTIFY pgrst, 'reload schema';
