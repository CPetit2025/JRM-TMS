-- Sinceramiento APT en bloque desde «Contratos / OT por producto»: cada OT del bloque puede traer «productos» (códigos)
-- y entonces solo se sincera el stock del APT de esos productos de la OT. Sin «productos», todo el stock de la OT (igual
-- que antes). Se modifica solo el filtro de capas de inv_sinc_transferir sobre su definición vigente.
BEGIN;
SET LOCAL lock_timeout = '3min';

DO $migration$
DECLARE src text := pg_get_functiondef('public.inv_sinc_transferir(jsonb)'::regprocedure);
  pat text := 'AND public.apt_almacen(y.bodega) IS NOT NULL AND y.qty > y.consumed';
BEGIN
  IF position('o->''productos''' IN src) = 0 THEN
    IF (length(src) - length(replace(src, pat, ''))) / length(pat) <> 1 THEN
      RAISE EXCEPTION 'inv_sinc_transferir no coincide con la definición esperada';
    END IF;
    EXECUTE replace(src, pat, pat || chr(10) || '                -- Solo los productos elegidos de la OT (vista por producto)'
      || chr(10) || '                AND (jsonb_typeof(o->''productos'') IS DISTINCT FROM ''array'' OR y.producto IN (SELECT jsonb_array_elements_text(o->''productos'')))');
  END IF;
END $migration$;

NOTIFY pgrst, 'reload schema';
COMMIT;
