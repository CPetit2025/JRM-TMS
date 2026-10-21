-- CAJA C133: costo por hora y horas finales del servicio de montacarga
DO $$
DECLARE v_ok boolean;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_forklifts' AND column_name='hourly_rate')
   OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_forklifts' AND column_name='final_hours')
   OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_forklifts' AND column_name='final_amount') THEN
  RAISE EXCEPTION 'CAJA C133 FAIL: columnas de tarifa y liquidación incompletas';
 END IF;
 IF NOT has_function_privilege('authenticated','public.close_route_with_forklift(uuid,text,uuid,text,text,text,numeric,numeric)','EXECUTE')
   OR has_function_privilege('anon','public.close_route_with_forklift(uuid,text,uuid,text,text,text,numeric,numeric)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C133 FAIL: permisos de cierre de montacarga incorrectos';
 END IF;
 IF NOT has_function_privilege('authenticated','public.route_forklift_settlement_document(uuid)','EXECUTE')
   OR has_function_privilege('anon','public.route_forklift_settlement_document(uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C133 FAIL: permisos de reporte incorrectos';
 END IF;
 IF to_regclass('public.supplier_personnel') IS NULL OR to_regclass('public.supplier_vehicles') IS NULL
   OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.carriers'::regclass AND attname='supplier_id' AND NOT attisdropped)
   OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.suppliers'::regclass AND tgname='suppliers_transport_carrier_sync' AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'CAJA C133 FAIL: maestro de personal, flota o enlace al transportista incompleto';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.supplier_vehicles'::regclass AND tgname='supplier_vehicle_personnel_same_company' AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'CAJA C133 FAIL: la unidad no valida que su conductor sea de la misma empresa';
 END IF;
 IF has_table_privilege('anon','public.supplier_personnel','SELECT') OR has_table_privilege('anon','public.supplier_vehicles','SELECT')
   OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.supplier_personnel'::regclass)
   OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.supplier_vehicles'::regclass) THEN
  RAISE EXCEPTION 'CAJA C133 FAIL: seguridad de datos del personal de proveedores';
 END IF;
 SELECT pg_get_functiondef('public.schedule_route_resources(jsonb)'::regprocedure) LIKE '%hourly_rate%'
   AND pg_get_functiondef('public.close_route_with_forklift(uuid,text,uuid,text,text,text,numeric,numeric)'::regprocedure) LIKE '%final_amount%'
   INTO v_ok;
 IF NOT v_ok THEN RAISE EXCEPTION 'CAJA C133 FAIL: tarifa no llega a programación y cierre'; END IF;
 RAISE NOTICE 'CAJA C133 PASS: tarifa horaria, horas finales, costo y reporte protegidos';
END $$;
