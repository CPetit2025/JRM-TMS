-- C213: no repetir tariff_pick para cada recojo ni para cada lectura de su JSON.
-- Una tarifa por clase/fecha, con la misma función y los mismos parámetros.
-- Adaptar la definición instalada conserva las reglas vigentes y las ACL.
BEGIN;
DO $patch$
DECLARE
 definition text := pg_get_functiondef('public.consolidation_savings(date,date,uuid,uuid)'::regprocedure);
 anchor text;
 old_pick text := 'FROM (SELECT public.tariff_pick(''PARADA_ADICIONAL'', gc.gclass, NULL, NULL, NULL, NULL, gc.day) AS tp) z WHERE tp IS NOT NULL';
 new_pick text := 'FROM ahorro_stop_tariffs z WHERE z.gclass IS NOT DISTINCT FROM gc.gclass AND z.day = gc.day AND z.tp IS NOT NULL';
 cache_cte text := $cache$ahorro_stop_tariffs AS MATERIALIZED (
   SELECT key.gclass, key.day,
     public.tariff_pick('PARADA_ADICIONAL', key.gclass, NULL, NULL, NULL, NULL, key.day) AS tp
   FROM (SELECT DISTINCT gclass, day FROM gc) key
 ),
 gt AS (
$cache$;
BEGIN
 IF position('ahorro_stop_tariffs AS MATERIALIZED' IN definition) > 0 THEN RETURN; END IF;
 anchor := CASE WHEN position(E'gt AS (\r\n' IN definition) > 0 THEN E'gt AS (\r\n' ELSE E'gt AS (\n' END;
 IF position(anchor IN definition) = 0 OR position(old_pick IN definition) = 0 THEN
  RAISE EXCEPTION 'consolidation_savings no coincide con los puntos de cache; revisar la definición instalada';
 END IF;
 EXECUTE replace(replace(definition, anchor, cache_cte), old_pick, new_pick);
END $patch$;
COMMIT;
NOTIFY pgrst, 'reload schema';
