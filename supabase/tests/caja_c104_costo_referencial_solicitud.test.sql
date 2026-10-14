-- CAJA C104 — Costo de la solicitud solo referencial: sin unidad no toma la tarifa más alta (más baja + rango), con peso
-- sugiere la unidad que lo soporta, la partida no observa la solicitud y aprobar no reserva saldo (lo valida y reserva
-- el armado de ruta con el flete real). Siempre se revierte.
BEGIN;
DO $policy$ BEGIN
  IF to_regclass('public.transport_lead_time_settings') IS NOT NULL THEN
    EXECUTE 'UPDATE public.transport_lead_time_settings SET settings=jsonb_set(settings,''{enabled}'',''false''::jsonb)';
  END IF;
END $policy$;
DO $test$
DECLARE actor uuid; q jsonb; v_contract uuid; v_site uuid; v_req uuid; v_status text; dist text := 'ZZ C104 ' || upper(substr(md5(random()::text), 1, 6));
  def text := pg_get_functiondef('public.transport_request_budget_sync()'::regprocedure);
BEGIN
  FOR actor IN SELECT p.id FROM public.profiles p JOIN auth.users u ON u.id = p.id WHERE p.is_active LOOP
    PERFORM set_config('request.jwt.claim.sub', actor::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', actor, 'role', 'authenticated')::text, true);
    EXIT WHEN public.is_tms_admin(); actor := NULL;
  END LOOP;
  IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C104 FAIL: falta administrador activo'; END IF;
  -- Tarifario de prueba: un camión de 4 t y un tráiler de 32 t al mismo destino
  EXECUTE format('INSERT INTO public.freight_rates(%s) SELECT %s FROM jsonb_populate_recordset(NULL::public.freight_rates, $1)',
    'origin, district, vehicle_type, capacity_ton, rate, concept, rate_basis, scope, vehicle_class, is_active, valid_from',
    'origin, district, vehicle_type, capacity_ton, rate, concept, rate_basis, scope, vehicle_class, is_active, valid_from')
  USING jsonb_build_array(
    jsonb_build_object('origin','LURIN','district',dist,'vehicle_type','Camión','capacity_ton',4,'rate',380,'concept','FLETE','rate_basis','VIAJE','scope','GENERAL','vehicle_class','Camión 4 t','is_active',true,'valid_from','2020-01-01'),
    jsonb_build_object('origin','LURIN','district',dist,'vehicle_type','Tráiler','capacity_ton',32,'rate',1144,'concept','FLETE','rate_basis','VIAJE','scope','GENERAL','vehicle_class','Tráiler 32 t','is_active',true,'valid_from','2020-01-01'));
  -- T1: sin unidad ni peso el referencial es la tarifa más baja y devuelve el rango (no S/ 1,144)
  q := public.quote_transport(NULL, jsonb_build_array(jsonb_build_object('district', dist)), NULL, NULL, NULL, '[]'::jsonb);
  IF (q->>'freight_total')::numeric <> 380 OR (q->'freight_range'->>'min')::numeric <> 380 OR (q->'freight_range'->>'max')::numeric <> 1144
     OR NOT (q->>'freight_referential')::boolean THEN RAISE EXCEPTION 'CAJA C104 FAIL: referencial sin unidad (T1) %', q; END IF;
  -- T2: con peso (3,5 t) se sugiere el camión de 4 t; con unidad indicada se cotiza esa unidad
  q := public.quote_transport(NULL, jsonb_build_array(jsonb_build_object('district', dist)), 3500, NULL, NULL, '[]'::jsonb);
  IF q->>'vehicle_class' <> 'Camión 4 t' OR (q->>'freight_total')::numeric <> 380 THEN RAISE EXCEPTION 'CAJA C104 FAIL: unidad por peso (T2) %', q; END IF;
  q := public.quote_transport(NULL, jsonb_build_array(jsonb_build_object('district', dist)), NULL, 'Tráiler 32 t', NULL, '[]'::jsonb);
  IF (q->>'freight_total')::numeric <> 1144 THEN RAISE EXCEPTION 'CAJA C104 FAIL: unidad indicada (T2) %', q; END IF;
  -- T3: una solicitud con OT no queda OBSERVADA por «Partida insuficiente»: vuelve a pendiente de aprobación
  SELECT c.id INTO v_contract FROM public.contracts c ORDER BY c.created_at DESC NULLS LAST LIMIT 1;
  SELECT s.id INTO v_site FROM public.sites s LIMIT 1;
  IF v_contract IS NULL THEN RAISE EXCEPTION 'CAJA C104 FAIL: falta una OT'; END IF;
  EXECUTE (SELECT format('INSERT INTO public.transport_requests (%s) SELECT %s FROM jsonb_populate_record(NULL::public.transport_requests, $1) RETURNING id',
      string_agg(quote_ident(k), ','), string_agg(quote_ident(k), ','))
    FROM jsonb_object_keys(jsonb_build_object('request_number',1,'request_type',1,'attention_mode',1,'status',1,'contract_id',1,'site_id',1,'requester_name',1,
      'department',1,'cargo_description',1,'pickup_address',1,'delivery_address',1,'delivery_district',1,'required_date',1,'service_cost',1,'budget_shortfall',1,'budget_observation',1)) k
    WHERE EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema='public' AND ic.table_name='transport_requests' AND ic.column_name=k))
  INTO v_req USING jsonb_build_object('request_number','ZZ-C104-'||substr(dist,9),'request_type','DESPACHO','attention_mode','TRANSPORTE_JRM',
    'status','OBSERVADA','contract_id',v_contract,'site_id',v_site,'requester_name','ZZ','department','Logística','cargo_description','Prueba C104',
    'pickup_address','Planta','delivery_address','Obra','delivery_district',dist,'required_date',(current_date + 10)::text,'service_cost',99999,
    'budget_shortfall',99999,'budget_observation','Partida insuficiente: faltan S/ 99999');
  SELECT status INTO v_status FROM public.transport_requests WHERE id = v_req;
  IF v_status <> 'PENDIENTE DE APROBACIÓN' THEN RAISE EXCEPTION 'CAJA C104 FAIL: observada por partida (T3) %', v_status; END IF;
  -- T4: aprobar ya no reserva el referencial en la partida (el armado de ruta valida y reserva el flete real)
  IF position('NEW.reserved_pen := v_cost' IN def) > 0 OR position('Aprobación sin reserva' IN def) = 0 THEN
    RAISE EXCEPTION 'CAJA C104 FAIL: la aprobación aún reserva el referencial (T4)'; END IF;
  RAISE EXCEPTION 'CAJA C104 PASS (4/4) costo referencial: tarifa más baja y rango sin unidad, unidad por peso, sin observación por partida y aprobación sin reserva';
END $test$;
ROLLBACK;
