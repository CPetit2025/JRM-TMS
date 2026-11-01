-- CAJA C139 — Reporte por unidad: km de la ruta (real o estimado) y referencias OS/OC/RQ por parada. Siempre se revierte.
BEGIN;
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
DECLARE admin_id uuid; site uuid; carrier uuid; client uuid; supplier uuid; ct uuid; r1 uuid; r2 uuid; r3 uuid; d1 uuid; d2 uuid; e1 uuid; rep jsonb; d jsonb; refs text[];
  tag text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)); plate text; day date := (now() AT TIME ZONE 'America/Lima')::date;
  pass int := 0; fails text[] := '{}';
BEGIN
  FOR admin_id IN SELECT id FROM public.profiles WHERE is_active AND id IN (SELECT id FROM auth.users) LOOP
    PERFORM set_config('request.jwt.claim.sub', admin_id::text, true); EXIT WHEN public.is_tms_admin(); admin_id := NULL;
  END LOOP;
  SELECT carrier_id, site_id INTO carrier, site FROM public.vehicles WHERE carrier_id IS NOT NULL AND site_id IS NOT NULL LIMIT 1;
  SELECT id INTO client FROM public.clients ORDER BY id LIMIT 1;
  IF admin_id IS NULL OR site IS NULL THEN RAISE EXCEPTION 'CAJA C139 FAIL: faltan administrador o sede'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  plate := 'ZZ9' || tag;
  supplier := pg_temp.ins('suppliers', jsonb_build_object('tax_id', '20' || lpad(regexp_replace(translate(tag, 'ABCDEF', '123456'), '[^0-9]', '', 'g'), 9, '0'), 'business_name', 'ZZ C139 Proveedor ' || tag));
  INSERT INTO public.vehicles(plate, carrier_id, site_id, type, status, soat_expiration, technical_review_expiration)
  VALUES (plate, carrier, site, 'CAMION', 'DISPONIBLE', current_date + 365, current_date + 365);
  ct := pg_temp.ins('contracts', jsonb_build_object('code', 'ZZ-C139-' || tag, 'type', 'CONTRATO', 'status', 'ACTIVO', 'site_id', site, 'client_id', client));
  r1 := pg_temp.ins('transport_requests', jsonb_build_object('request_number', 'ZZ-C139-' || tag || '-1', 'requester_name', 'ZZ C139', 'pickup_address', 'Origen',
    'delivery_address', 'Destino', 'request_type', 'DESPACHO', 'status', 'ASIGNADA', 'required_date', current_date, 'contract_id', ct, 'site_id', site,
    'client_id', client, 'attention_mode', 'TRANSPORTE_JRM', 'reference_type', 'OC', 'reference_number', ' 4500123 ', 'reference_supplier_id', supplier));
  r2 := pg_temp.ins('transport_requests', jsonb_build_object('request_number', 'ZZ-C139-' || tag || '-2', 'requester_name', 'ZZ C139', 'pickup_address', 'Origen',
    'delivery_address', 'Destino', 'request_type', 'DESPACHO', 'status', 'ASIGNADA', 'required_date', current_date, 'contract_id', ct, 'site_id', site,
    'client_id', client, 'attention_mode', 'TRANSPORTE_JRM', 'reference_type', 'RQ', 'reference_number', 'RQ-77', 'reference_supplier_id', supplier));
  r3 := pg_temp.ins('transport_requests', jsonb_build_object('request_number', 'ZZ-C139-' || tag || '-3', 'requester_name', 'ZZ C139', 'pickup_address', 'Origen',
    'delivery_address', 'Destino', 'request_type', 'DESPACHO', 'status', 'ASIGNADA', 'required_date', current_date, 'contract_id', ct, 'site_id', site,
    'client_id', client, 'attention_mode', 'TRANSPORTE_JRM'));
  -- Ruta 1: km estimados al programar, real 0 (valor por defecto de producción = sin dato)
  d1 := pg_temp.ins('dispatches', jsonb_build_object('dispatch_number', 'ZZ-C139-1-' || tag, 'vehicle_plate', plate, 'driver_name', 'ZZ C139',
    'scheduled_departure', now(), 'status', 'PROGRAMADO', 'freight_cost', 0, 'site_id', site, 'estimated_distance_km', 42.5, 'actual_distance_km', 0));
  INSERT INTO public.dispatch_requests(dispatch_id, transport_request_id, status, document_type, sequence_order)
  VALUES (d1, r1, 'PROGRAMADO', 'GR', 1), (d1, r2, 'PROGRAMADO', 'GR', 2);
  -- Ruta 2 (mismo día, luego de cerrar la primera): km real registrado
  UPDATE public.dispatches SET status = 'COMPLETADO' WHERE id = d1;
  d2 := pg_temp.ins('dispatches', jsonb_build_object('dispatch_number', 'ZZ-C139-2-' || tag, 'vehicle_plate', plate, 'driver_name', 'ZZ C139',
    'scheduled_departure', now(), 'status', 'PROGRAMADO', 'freight_cost', 0, 'site_id', site, 'estimated_distance_km', 10, 'actual_distance_km', 15));
  INSERT INTO public.dispatch_requests(dispatch_id, transport_request_id, status, document_type, sequence_order) VALUES (d2, r3, 'PROGRAMADO', 'GR', 1);
  e1 := pg_temp.ins('dispatch_expenses', jsonb_build_object('dispatch_id',d1,'expense_type','COMBUSTIBLE','amount',100,
    'status','PENDIENTE','source','WEB','receipt_url','caja/c139.jpg','fuel_gallons',20,'fuel_odometer',10000));
  INSERT INTO public.cost_allocations(kind,dispatch_id,expense_id,request_id,contract_id,amount_pen,basis,status,detail)
    VALUES('CAJA',d1,e1,r1,ct,50,'PESO','APLICADO','{"share":0.5,"expense_type":"COMBUSTIBLE"}'::jsonb);

  rep := public.unit_daily_report(plate, day, day);
  d := rep->'days'->0;
  -- T1 cada parada trae su referencia de compra (normalizada) y la OT
  SELECT array_agg(concat_ws(':', s->>'ref_type', s->>'ref_number', s->>'ot') ORDER BY s->>'request_number') INTO refs
  FROM jsonb_array_elements(d->'dispatches') x, jsonb_array_elements(x->'stops') s;
  IF rep->>'success' = 'true' AND refs = ARRAY['OC:4500123:ZZ-C139-' || tag, 'RQ:RQ-77:ZZ-C139-' || tag, 'ZZ-C139-' || tag]
  THEN pass := pass + 1; ELSE fails := fails || ('T1 referencias: ' || COALESCE(array_to_string(refs, ','), rep::text)); END IF;
  IF (SELECT bool_and(s->>'reference_supplier' = 'ZZ C139 Proveedor ' || tag AND s->>'origin' = 'Origen' AND s->>'destination' = 'Destino')
      FROM jsonb_array_elements(d->'dispatches') x, jsonb_array_elements(x->'stops') s WHERE s->>'ref_type' IN ('OC','RQ'))
  THEN pass := pass + 1; ELSE fails := fails || 'T1b proveedor y direcciones de referencia'::text; END IF;
  -- T2 km de la ruta: el real 0 es «sin dato»; el día y el total suman real y estimado
  IF (SELECT count(*) FROM jsonb_array_elements(d->'dispatches') x WHERE x->>'km_real' IS NULL AND (x->>'km_est')::numeric = 42.5) = 1
     AND (d->>'km_real')::numeric = 15 AND (d->>'km_est')::numeric = 52.5
     AND (rep->'totals'->>'km_real')::numeric = 15 AND (rep->'totals'->>'km_est')::numeric = 52.5 AND (d->>'routes')::int = 2
  THEN pass := pass + 1; ELSE fails := fails || ('T2 km: ' || COALESCE(d::text, rep::text)); END IF;
  IF (SELECT c->>'fuel_gallons'='10.000' AND c->>'fuel_odometer'='10000' AND c->>'ot'='ZZ-C139-'||tag
      FROM jsonb_array_elements(d->'dispatches') x, jsonb_array_elements(x->'costs') c WHERE c->>'request_number'='ZZ-C139-'||tag||'-1')
  THEN pass := pass + 1; ELSE fails := fails || 'T3 combustible por OT: galones prorrateados con costo y odómetro de abastecimiento'::text; END IF;
  -- T3 rango: hasta 13 meses para el resumen mensual; más se rechaza
  IF (public.unit_daily_report(plate, day - 395, day)->>'success') = 'true' AND (public.unit_daily_report(plate, day - 401, day)->>'success') = 'false'
  THEN pass := pass + 1; ELSE fails := fails || 'T4 rango'::text; END IF;
  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C139 FAIL (%/5): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C139 PASS (5/5) reporte por unidad con km real/estimado, proveedor, direcciones y combustible asignado por OT';
END $test$;
ROLLBACK;
