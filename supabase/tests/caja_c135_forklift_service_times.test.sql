DO $$
DECLARE p pg_policy; fn regprocedure;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_forklifts' AND column_name='service_started_at')
   OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_forklifts' AND column_name='service_ended_at') THEN
  RAISE EXCEPTION 'CAJA C135 FAIL: faltan inicio y fin del servicio';
 END IF;
 fn:=to_regprocedure('public.settle_route_forklift_times(uuid,timestamp with time zone,timestamp with time zone)');
 IF fn IS NULL OR NOT has_function_privilege('authenticated',fn,'EXECUTE') OR has_function_privilege('anon',fn,'EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C135 FAIL: RPC de liquidación sin permisos correctos';
 END IF;
 SELECT * INTO p FROM pg_policy WHERE polrelid='public.supplier_personnel'::regclass AND polname='supplier_personnel_logistics_read';
 IF p.polname IS NULL OR position('despacho' in pg_get_expr(p.polqual,p.polrelid))=0 THEN
  RAISE EXCEPTION 'CAJA C135 FAIL: Despacho no puede leer personal proveedor';
 END IF;
 RAISE EXCEPTION 'CAJA C135 PASS: horas por inicio/fin, RPC protegido y lectura de personal en Despacho';
END $$;
