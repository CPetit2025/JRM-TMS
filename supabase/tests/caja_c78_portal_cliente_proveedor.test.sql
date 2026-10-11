-- CAJA C78 — Portal público: el registro de solicitudes y la ruta del día publican el cliente o el proveedor.
DO $test$
DECLARE src text := pg_get_functiondef('public.get_public_tracking_portal_info(uuid,text,date,date)'::regprocedure);
BEGIN
  IF position('''supplier_name'',(SELECT xs.business_name' IN src) = 0 THEN
    RAISE EXCEPTION 'CAJA C78 FAIL: el registro del portal no publica el proveedor (T1)'; END IF;
  IF position('''supplier_name'',supplier_name,''request_type'',req_type,''attention_mode'',req_mode' IN src) = 0 THEN
    RAISE EXCEPTION 'CAJA C78 FAIL: la ruta del día no publica cliente/proveedor (T2)'; END IF;
  IF position('xc.id=t.client_id' IN src) = 0 THEN
    RAISE EXCEPTION 'CAJA C78 FAIL: entregas sin OT sin cliente en el portal (T3)'; END IF;
  RAISE EXCEPTION 'CAJA C78 PASS (3/3) portal: cliente o proveedor en el registro y la ruta del día';
END $test$;
