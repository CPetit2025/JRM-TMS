-- C212: ahorro por consolidación — los recojos aprovechados de una ruta se valorizan como un solo viaje (tarifa mayor +
-- parada adicional); conserva el estado COSTO_HORA_PENDIENTE (D2).
BEGIN;
DO $$
DECLARE v_src text;
BEGIN
 SELECT prosrc INTO v_src FROM pg_proc WHERE oid='public.consolidation_savings(date,date,uuid,uuid)'::regprocedure;
 IF position('PARADA_ADICIONAL' IN v_src)=0 OR position('group_value' IN v_src)=0 OR position('pickup_group' IN v_src)=0 THEN
  RAISE EXCEPTION 'CAJA C212 FAIL: los recojos de una ruta no se valorizan como un solo viaje';
 END IF;
 IF position('COSTO_HORA_PENDIENTE' IN v_src)=0 THEN
  RAISE EXCEPTION 'CAJA C212 FAIL: se perdió el estado de costo por hora pendiente (D2)';
 END IF;
 IF has_function_privilege('anon','public.consolidation_savings(date,date,uuid,uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C212 FAIL: acceso anónimo al ahorro por consolidación';
 END IF;
 RAISE EXCEPTION 'CAJA C212 PASS: recojos aprovechados valorizados como un solo viaje';
END $$;
ROLLBACK;
