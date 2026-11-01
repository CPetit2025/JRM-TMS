-- Monitoreo GPS: la ruta de un tercero (sin conductor propio) que ya regresa se muestra «Retorno», no «En ruta».
-- Parche guardado de get_driver_gps_monitor (20261007170000); si ya está aplicado no hace nada.
BEGIN;
DO $patch$
DECLARE def text := pg_get_functiondef('public.get_driver_gps_monitor()'::regprocedure);
 o text := '''operational_status'',''EN_RUTA'',';
 n text := '''operational_status'',CASE WHEN d.status=''RETORNO'' THEN ''RETORNO'' ELSE ''EN_RUTA'' END,';
BEGIN
 IF position(n IN def) > 0 THEN RETURN; END IF;
 IF position(o IN def) = 0 THEN RAISE EXCEPTION 'get_driver_gps_monitor cambió: revisar el parche de rutas de terceros'; END IF;
 EXECUTE replace(def, o, n);
END $patch$;
NOTIFY pgrst,'reload schema';
COMMIT;
