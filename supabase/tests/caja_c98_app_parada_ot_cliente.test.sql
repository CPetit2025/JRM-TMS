-- CAJA C98 — App del conductor: cada parada informa su OT (u OC/OS/RQ) y el cliente o proveedor. Siempre se revierte.
BEGIN;
DO $test$
DECLARE r uuid; info jsonb; ot text; client_name text;
BEGIN
 SELECT t.id,c.code,cl.business_name INTO r,ot,client_name FROM public.transport_requests t
  JOIN public.contracts c ON c.id=t.contract_id JOIN public.clients cl ON cl.id=t.client_id
  WHERE t.request_type='DESPACHO' ORDER BY t.created_at DESC LIMIT 1;
 IF r IS NOT NULL THEN
  info:=public.trip_stop_info(r);
  IF info->>'ot_code' IS DISTINCT FROM ot OR info->>'party_name' IS DISTINCT FROM client_name OR info->>'party_label'<>'Cliente' THEN
   RAISE EXCEPTION 'CAJA C98 FAIL: OT y cliente de la parada (T1) %',info; END IF;
 END IF;
 IF to_regprocedure('public.get_active_trip_context_before_stop_info()') IS NULL
  -- El contexto se compone por capas (paradas, preuso, estado de la entrega): los datos por parada están en alguna de ellas
  OR position('trip_stop_info' IN pg_get_functiondef('public.get_active_trip_context()'::regprocedure)
     ||COALESCE(pg_get_functiondef(to_regprocedure('public.get_active_trip_context_before_delivery_status()')),''))=0 THEN
  RAISE EXCEPTION 'CAJA C98 FAIL: viaje del app sin datos por parada (T2)'; END IF;
 IF has_function_privilege('authenticated','public.trip_stop_info(uuid)','EXECUTE')
  OR has_function_privilege('authenticated','public.get_active_trip_context_before_stop_info()','EXECUTE')
  OR has_function_privilege('anon','public.get_active_trip_context()','EXECUTE')
  OR NOT has_function_privilege('authenticated','public.get_active_trip_context()','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C98 FAIL: permisos (T3)'; END IF;
 RAISE EXCEPTION 'CAJA C98 PASS (3/3) app del conductor: OT %, % y permisos del viaje',COALESCE(ot,'s/d'),COALESCE(client_name,'s/d');
END $test$;
ROLLBACK;
