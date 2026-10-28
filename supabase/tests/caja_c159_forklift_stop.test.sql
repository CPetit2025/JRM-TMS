-- C159: alcance del servicio de montacarga y validaciones de seguridad instaladas.
BEGIN;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_forklifts' AND column_name='transport_request_id') THEN
  RAISE EXCEPTION 'CAJA C159 FAIL: falta la parada del servicio';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.route_forklifts'::regclass AND conname='route_forklifts_transport_request_fk') THEN
  RAISE EXCEPTION 'CAJA C159 FAIL: falta integridad de la parada';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.route_forklifts'::regclass AND tgname='route_forklift_stop_guard' AND NOT tgisinternal)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.dispatch_requests'::regclass AND tgname='route_forklift_stop_unlink_guard' AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'CAJA C159 FAIL: faltan guardas de asociación y retiro';
 END IF;
 IF has_table_privilege('authenticated','public.route_forklifts','INSERT') OR has_table_privilege('authenticated','public.route_forklifts','UPDATE')
  OR has_function_privilege('anon','public.schedule_route_resources(jsonb)','EXECUTE')
  OR has_function_privilege('authenticated','public.route_forklift_stop_guard()','EXECUTE')
  OR has_function_privilege('authenticated','public.route_forklift_stop_unlink_guard()','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C159 FAIL: acceso directo a datos o funciones internas';
 END IF;
 RAISE EXCEPTION 'CAJA C159 PASS: parada del montacarga, integridad, retiro seguro y permisos protegidos';
END $$;
ROLLBACK;
