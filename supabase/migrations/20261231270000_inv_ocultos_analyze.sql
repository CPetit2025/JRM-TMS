-- Sin estadísticas, el planificador suponía ~700 filas en inv_contratos_ocultos y elegía planes en bucle sobre
-- inv_movements_v: el recálculo pasaba los 5 min del cron y fallaba siempre, así que ocultar no tenía efecto.
-- Se analiza la tabla ahora y cada vez que se oculta o se muestra un contrato (tabla pequeña: es instantáneo).
BEGIN;
ANALYZE public.inv_contratos_ocultos;

DO $migration$
DECLARE src text := pg_get_functiondef('public.inv_ocultos_save(jsonb)'::regprocedure);
  pat text := 'UPDATE public.inv_state SET dirty = true WHERE id = 1;';
BEGIN
  IF (length(src) - length(replace(src, pat, ''))) / length(pat) <> 1 THEN
    RAISE EXCEPTION 'inv_ocultos_save no marca el recálculo como se esperaba: revisar antes de migrar';
  END IF;
  EXECUTE replace(src, pat, 'ANALYZE public.inv_contratos_ocultos;' || chr(10) || '  ' || pat);
END $migration$;
COMMIT;
