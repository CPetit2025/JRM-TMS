-- C193: flete según la operación — flota propia sin OT es operación interna (sin flete); tercero sin OT se autoriza
-- contra la OC, OS o RQ (recojos y traslados).
BEGIN;
DO $$
DECLARE v_src text;
BEGIN
 SELECT prosrc INTO v_src FROM pg_proc WHERE oid='public.schedule_route_resources(jsonb)'::regprocedure;
 IF position('v_all_internal' IN v_src)=0 OR position('freight_reason' IN v_src)=0 OR position('inherit_route_unloading' IN v_src)=0
  OR position('set_special_service_agreements' IN v_src)=0 THEN
  RAISE EXCEPTION 'CAJA C193 FAIL: la programación no aplica la operación interna con flota propia';
 END IF;
 SELECT prosrc INTO v_src FROM pg_proc WHERE oid='public.authorize_pickup_reference_freight(uuid,numeric,text,text,numeric,text)'::regprocedure;
 IF position('TRASLADO' IN v_src)=0 OR position('despacho-aprobacion' IN v_src)=0 THEN
  RAISE EXCEPTION 'CAJA C193 FAIL: el flete del tercero en traslados sin OT no se puede autorizar';
 END IF;
 IF has_function_privilege('anon','public.schedule_route_resources(jsonb)','EXECUTE')
  OR has_function_privilege('anon','public.authorize_pickup_reference_freight(uuid,numeric,text,text,numeric,text)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C193 FAIL: acceso anónimo a la programación';
 END IF;
 RAISE EXCEPTION 'CAJA C193 PASS: flota propia sin OT sin flete; tercero sin OT autorizado contra la OC, OS o RQ';
END $$;
ROLLBACK;
