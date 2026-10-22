BEGIN;
-- Registro de Servicios: toda ruta programada figura por cada OT que atiende, aunque su flete aún no tenga monto.
-- La anticipación mínima tiene su propia prueba (C56); aquí se aísla el registro.
UPDATE public.transport_lead_time_settings SET settings=jsonb_set(settings,'{enabled}','false'::jsonb);
CREATE FUNCTION pg_temp.ins(p_table text, p_cols jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  EXECUTE (SELECT format('INSERT INTO public.%I (%s) VALUES (%s) RETURNING id', p_table,
                         string_agg(quote_ident(k.key), ', '), string_agg(quote_nullable(k.value #>> '{}'), ', '))
           FROM jsonb_each(p_cols) k
           WHERE EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema = 'public' AND ic.table_name = p_table AND ic.column_name = k.key))
  INTO v_id;
  RETURN v_id;
END $$;

DO $test$
DECLARE site uuid; client uuid; ct uuid; ct2 uuid; r1 uuid; r2 uuid; r3 uuid; r4 uuid; r5 uuid; r6 uuid; r7 uuid;
  own uuid; legacy uuid; mixed uuid; priced uuid; pickup uuid; dropped uuid; sid uuid; n int; tag text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  reqs uuid[] := '{}';
BEGIN
  SELECT site_id INTO site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
  SELECT id INTO client FROM public.clients ORDER BY id LIMIT 1;
  IF site IS NULL THEN RAISE EXCEPTION 'CAJA C137 FAIL: falta sede de prueba'; END IF;
  ct := pg_temp.ins('contracts', jsonb_build_object('code', 'ZZ-C137-A-' || tag, 'type', 'CONTRATO', 'status', 'ACTIVO', 'site_id', site, 'client_id', client));
  ct2 := pg_temp.ins('contracts', jsonb_build_object('code', 'ZZ-C137-B-' || tag, 'type', 'CONTRATO', 'status', 'ACTIVO', 'site_id', site, 'client_id', client));
  INSERT INTO public.contract_budgets(contract_id, concept, allocated_pen) VALUES (ct, 'PARTIDA_TRANSPORTE', 10000), (ct2, 'PARTIDA_TRANSPORTE', 10000)
    ON CONFLICT (contract_id, concept) DO UPDATE SET allocated_pen = 10000;
  -- Solicitudes ya asignadas (el flujo de aprobación tiene sus propias pruebas); r3 y r5 son de la OT B
  FOR i IN 1..7 LOOP
    reqs := reqs || pg_temp.ins('transport_requests', jsonb_build_object('request_number', 'ZZ-C137-' || tag || '-' || i, 'requester_name', 'ZZ C137',
      'pickup_address', 'Origen', 'delivery_address', 'Destino', 'request_type', 'DESPACHO', 'status', 'ASIGNADA', 'required_date', current_date,
      'contract_id', CASE WHEN i IN (3, 5) THEN ct2 ELSE ct END, 'site_id', site, 'client_id', client, 'attention_mode', 'TRANSPORTE_JRM'));
  END LOOP;
  r1 := reqs[1]; r2 := reqs[2]; r3 := reqs[3]; r4 := reqs[4]; r5 := reqs[5]; r6 := reqs[6]; r7 := reqs[7];

  -- T1 flota propia sin tarifa (flete 0): dos servicios de la OT A y uno de la OT B → una línea por OT, sin valorizar
  INSERT INTO public.dispatches(dispatch_number, vehicle_plate, driver_name, scheduled_departure, status, freight_cost, contract_id, site_id)
  VALUES ('ZZ-C137-1-' || tag, 'ZZ1' || tag, 'ZZ C137', now() + interval '1 day', 'PROGRAMADO', 0, NULL, site) RETURNING id INTO own;
  INSERT INTO public.dispatch_requests(dispatch_id, transport_request_id, status, document_type, sequence_order)
  VALUES (own, r1, 'PROGRAMADO', 'GR', 1), (own, r2, 'PROGRAMADO', 'GR', 2), (own, r3, 'PROGRAMADO', 'GR', 3);

  -- T2 programación con flete (orden real: primero las paradas, luego la línea con monto) → no se duplica en 0
  INSERT INTO public.dispatches(dispatch_number, vehicle_plate, driver_name, scheduled_departure, status, freight_cost, contract_id, site_id)
  VALUES ('ZZ-C137-2-' || tag, 'ZZ2' || tag, 'ZZ C137', now() + interval '1 day', 'PROGRAMADO', 500, ct, site) RETURNING id INTO legacy;
  INSERT INTO public.dispatch_requests(dispatch_id, transport_request_id, status, document_type, sequence_order) VALUES (legacy, r4, 'PROGRAMADO', 'GR', 1);
  INSERT INTO public.contract_services(contract_id, service_type, description, amount_pen, service_date, plate, category, dispatch_id)
  VALUES (ct, 'FLETE', 'Flete del despacho ZZ-C137-2', 500, current_date, 'ZZ2' || tag, 'Contrato', legacy);

  -- T3 ruta mixta: la OT A con reparto y línea, la OT B con reparto 0 → la OT B recibe su línea y su reparto la apunta
  INSERT INTO public.dispatches(dispatch_number, vehicle_plate, driver_name, scheduled_departure, status, freight_cost, contract_id, site_id)
  VALUES ('ZZ-C137-3-' || tag, 'ZZ3' || tag, 'ZZ C137', now() + interval '1 day', 'PROGRAMADO', 300, NULL, site) RETURNING id INTO mixed;
  INSERT INTO public.contract_services(contract_id, service_type, description, amount_pen, service_date, plate, category, dispatch_id)
  VALUES (ct, 'FLETE', 'Ruta mixta ZZ-C137-3', 300, current_date, 'ZZ3' || tag, 'Contrato', mixed) RETURNING id INTO sid;
  INSERT INTO public.dispatch_request_freight(dispatch_id, request_id, contract_id, amount_pen, service_id) VALUES (mixed, r6, ct, 300, sid), (mixed, r5, ct2, 0, NULL);
  INSERT INTO public.dispatch_requests(dispatch_id, transport_request_id, status, document_type, sequence_order)
  VALUES (mixed, r6, 'PROGRAMADO', 'GR', 1), (mixed, r5, 'PROGRAMADO', 'GR', 2);

  -- T4 flete > 0 sin línea: no se inventa una línea en 0 (queda en «Regularizar flete»)
  INSERT INTO public.dispatches(dispatch_number, vehicle_plate, driver_name, scheduled_departure, status, freight_cost, contract_id, site_id)
  VALUES ('ZZ-C137-4-' || tag, 'ZZ4' || tag, 'ZZ C137', now() + interval '2 day', 'PROGRAMADO', 250, ct, site) RETURNING id INTO priced;
  INSERT INTO public.dispatch_requests(dispatch_id, transport_request_id, status, document_type, sequence_order) VALUES (priced, r7, 'PROGRAMADO', 'GR', 1);

  -- T5 recojo por el cliente (EXTERNO / Nota de salida) y parada retirada en la misma transacción → sin línea
  INSERT INTO public.dispatches(dispatch_number, vehicle_plate, driver_name, scheduled_departure, status, freight_cost, contract_id, site_id)
  VALUES ('ZZ-C137-5-' || tag, 'EXTERNO', 'ZZ C137', now() + interval '2 day', 'PROGRAMADO', 0, ct, site) RETURNING id INTO pickup;
  INSERT INTO public.dispatch_requests(dispatch_id, transport_request_id, status, document_type, sequence_order) VALUES (pickup, r1, 'PROGRAMADO', 'NOTA_SALIDA', 1);
  INSERT INTO public.dispatches(dispatch_number, vehicle_plate, driver_name, scheduled_departure, status, freight_cost, contract_id, site_id)
  VALUES ('ZZ-C137-6-' || tag, 'ZZ6' || tag, 'ZZ C137', now() + interval '3 day', 'PROGRAMADO', 0, ct, site) RETURNING id INTO dropped;
  INSERT INTO public.dispatch_requests(dispatch_id, transport_request_id, status, document_type, sequence_order) VALUES (dropped, r2, 'PROGRAMADO', 'GR', 1);
  DELETE FROM public.dispatch_requests WHERE dispatch_id = dropped;

  -- Equivale a confirmar la transacción para este disparador (los demás disparadores diferidos siguen diferidos)
  EXECUTE 'SET CONSTRAINTS public.route_service_line_on_commit IMMEDIATE';

  IF (SELECT count(*) FROM public.contract_services WHERE dispatch_id = own AND contract_id = ct AND service_type = 'FLETE' AND amount_pen = 0) <> 1
     OR (SELECT count(*) FROM public.contract_services WHERE dispatch_id = own AND contract_id = ct2 AND service_type = 'FLETE' AND amount_pen = 0) <> 1
     OR (SELECT count(*) FROM public.contract_services WHERE dispatch_id = own) <> 2 THEN
    RAISE EXCEPTION 'CAJA C137 FAIL: T1 la ruta de flota propia sin tarifa no figura una vez por OT';
  END IF;
  IF (SELECT count(*) FROM public.contract_services WHERE dispatch_id = legacy) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.contract_services WHERE dispatch_id = legacy AND amount_pen = 500) THEN
    RAISE EXCEPTION 'CAJA C137 FAIL: T2 duplica la línea de una ruta con flete';
  END IF;
  SELECT id INTO sid FROM public.contract_services WHERE dispatch_id = mixed AND contract_id = ct2 AND amount_pen = 0;
  IF sid IS NULL OR (SELECT count(*) FROM public.contract_services WHERE dispatch_id = mixed) <> 2
     OR NOT EXISTS (SELECT 1 FROM public.dispatch_request_freight WHERE dispatch_id = mixed AND contract_id = ct2 AND service_id = sid) THEN
    RAISE EXCEPTION 'CAJA C137 FAIL: T3 la OT con reparto 0 de una ruta mixta no figura o no queda vinculada';
  END IF;
  IF EXISTS (SELECT 1 FROM public.contract_services WHERE dispatch_id = priced) THEN
    RAISE EXCEPTION 'CAJA C137 FAIL: T4 inventa una línea en 0 para una ruta con flete';
  END IF;
  IF EXISTS (SELECT 1 FROM public.contract_services WHERE dispatch_id IN (pickup, dropped)) THEN
    RAISE EXCEPTION 'CAJA C137 FAIL: T5 registra recojo por el cliente o una parada retirada';
  END IF;
  -- T6 idempotencia de la regularización y sin efecto en la partida
  IF public.ensure_route_service_line(own, ct) IS NOT NULL OR public.ensure_route_service_line(mixed, ct2) IS NOT NULL THEN
    RAISE EXCEPTION 'CAJA C137 FAIL: T6 la regularización no es idempotente';
  END IF;
  IF (SELECT reserved_pen + consumed_pen FROM public.contract_budgets WHERE contract_id = ct2 AND concept = 'PARTIDA_TRANSPORTE') <> 0 THEN
    RAISE EXCEPTION 'CAJA C137 FAIL: T6 la línea sin valorizar toca la partida';
  END IF;
  -- T7 cancelar la ruta anula sus líneas
  PERFORM public.dispatch_release_on_cancel(own, 'ZZ C137');
  IF EXISTS (SELECT 1 FROM public.contract_services WHERE dispatch_id = own AND COALESCE(status, '') <> 'ANULADO') THEN
    RAISE EXCEPTION 'CAJA C137 FAIL: T7 la cancelación deja líneas vigentes';
  END IF;
  RAISE EXCEPTION 'CAJA C137 PASS (7/7) toda ruta programada figura por OT en el Registro de Servicios; sin duplicar ni tocar la partida';
END $test$;
ROLLBACK;
