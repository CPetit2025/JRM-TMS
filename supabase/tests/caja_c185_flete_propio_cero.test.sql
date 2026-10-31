-- C185: el flete de flota propia en S/ 0 se aprueba solo en el cierre económico (no se valoriza) y la función no está expuesta.
BEGIN;
DO $$
BEGIN
 IF position('Flota propia sin flete' IN pg_get_functiondef('public.economic_route_items(uuid)'::regprocedure)) = 0 THEN
  RAISE EXCEPTION 'CAJA C185 FAIL: el flete propio en S/ 0 sigue pidiendo confirmación';
 END IF;
 IF has_function_privilege('authenticated','public.economic_route_items(uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C185 FAIL: función interna expuesta';
 END IF;
 RAISE EXCEPTION 'CAJA C185 PASS: flete de flota propia en S/ 0 aprobado automáticamente';
END $$;
ROLLBACK;
