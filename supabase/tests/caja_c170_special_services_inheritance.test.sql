-- C170: servicios especiales (Etapa 1) — herencia en la ruta, montacarga vinculado a su línea,
-- origen por flujo y "sin tarifa" distinto de S/ 0, instalados y protegidos.
BEGIN;
DO $$
BEGIN
 IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='transport_unloading_costs'
     AND column_name IN ('origin','estimated_source','tariff_missing','manual_reason'))<>4
  OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_forklifts' AND column_name='unloading_cost_id') THEN
  RAISE EXCEPTION 'CAJA C170 FAIL: faltan columnas de origen, tarifa o vínculo del montacarga';
 END IF;
 IF EXISTS(SELECT 1 FROM public.transport_unloading_costs WHERE origin IS NULL OR origin NOT IN ('SOLICITUD','PROGRAMACION','CAJA')) THEN
  RAISE EXCEPTION 'CAJA C170 FAIL: líneas de descarga sin origen';
 END IF;
 IF EXISTS(SELECT 1 FROM public.transport_unloading_costs WHERE description='No planificado · gasto de Caja' AND origin<>'CAJA') THEN
  RAISE EXCEPTION 'CAJA C170 FAIL: línea de Caja con origen distinto';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.route_forklifts'::regclass AND conname='route_forklifts_unloading_cost_fk')
  OR to_regclass('public.route_forklifts_unloading_cost_key') IS NULL THEN
  RAISE EXCEPTION 'CAJA C170 FAIL: falta integridad del vínculo montacarga-línea';
 END IF;
 IF EXISTS(SELECT 1 FROM public.route_forklifts f JOIN public.transport_unloading_costs u ON u.id=f.unloading_cost_id
   WHERE u.dispatch_id IS DISTINCT FROM f.dispatch_id OR u.concept<>'MONTACARGAS') THEN
  RAISE EXCEPTION 'CAJA C170 FAIL: montacarga vinculado a una línea de otra ruta o concepto';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.transport_unloading_costs'::regclass AND tgname='transport_unloading_costs_origin' AND NOT tgisinternal)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.transport_unloading_costs'::regclass AND tgname='route_forklift_unloading_link' AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'CAJA C170 FAIL: faltan disparadores de origen o vínculo';
 END IF;
 IF position('inherit_route_unloading' IN pg_get_functiondef('public.schedule_route_resources(jsonb)'::regprocedure))=0
  OR position('estimated_source' IN pg_get_functiondef('public.apply_request_tariff(uuid)'::regprocedure))=0
  OR position('manual_reason' IN pg_get_functiondef('public.save_request_unloading_costs(uuid,jsonb)'::regprocedure))=0 THEN
  RAISE EXCEPTION 'CAJA C170 FAIL: funciones sin la herencia o sin el costo manual protegido';
 END IF;
 IF has_function_privilege('anon','public.schedule_route_resources(jsonb)','EXECUTE')
  OR has_function_privilege('authenticated','public.inherit_route_unloading(uuid)','EXECUTE')
  OR has_function_privilege('authenticated','public.route_forklift_unloading_link()','EXECUTE')
  OR has_function_privilege('authenticated','public.transport_unloading_costs_origin()','EXECUTE')
  OR has_table_privilege('authenticated','public.route_forklifts','UPDATE') THEN
  RAISE EXCEPTION 'CAJA C170 FAIL: acceso directo a funciones internas o datos';
 END IF;
 RAISE EXCEPTION 'CAJA C170 PASS: herencia de servicios especiales, vínculo del montacarga, origen y sin tarifa protegidos';
END $$;
ROLLBACK;
