-- C211: flete referencial manual sin tarifa — el guardado pasa el monto y su motivo al tarifario, que solo lo usa
-- cuando el flete tarifado es 0; la versión envuelta del guardado no queda expuesta.
BEGIN;
DO $$
DECLARE v_src text;
BEGIN
 SELECT prosrc INTO v_src FROM pg_proc WHERE oid='public.apply_request_tariff(uuid)'::regprocedure;
 IF position('tms.manual_freight' IN v_src)=0 OR position('freight_manual_reason' IN v_src)=0 THEN
  RAISE EXCEPTION 'CAJA C211 FAIL: el tarifario no respeta el flete referencial manual sin tarifa';
 END IF;
 SELECT prosrc INTO v_src FROM pg_proc WHERE oid='public.save_transport_request_full(uuid,jsonb,jsonb,jsonb)'::regprocedure;
 IF position('freight_manual_pen' IN v_src)=0 OR to_regprocedure('public.save_transport_request_full_before_manual_freight(uuid,jsonb,jsonb,jsonb)') IS NULL THEN
  RAISE EXCEPTION 'CAJA C211 FAIL: el guardado de la solicitud no recibe el flete manual';
 END IF;
 IF has_function_privilege('authenticated','public.save_transport_request_full_before_manual_freight(uuid,jsonb,jsonb,jsonb)','EXECUTE')
  OR has_function_privilege('anon','public.save_transport_request_full(uuid,jsonb,jsonb,jsonb)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C211 FAIL: acceso indebido al guardado de solicitudes';
 END IF;
 RAISE EXCEPTION 'CAJA C211 PASS: flete referencial manual con motivo solo sin tarifa';
END $$;
ROLLBACK;
