-- CAJA C82 — Cierre operativo de rutas propias: a las 00:00 y al completar el conductor todos sus puntos.
-- La unidad se libera y la liquidación documentaria queda pendiente. Bloque que siempre se revierte.
BEGIN;
-- La anticipación mínima se prueba aparte (C56); se desactiva solo en esta transacción.
DO $policy$ BEGIN
  IF to_regclass('public.transport_lead_time_settings') IS NOT NULL THEN
    EXECUTE 'UPDATE public.transport_lead_time_settings SET settings=jsonb_set(settings,''{enabled}'',''false''::jsonb)';
  END IF;
END $policy$;
CREATE FUNCTION pg_temp.c82_ins(p_table text, p_cols jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  EXECUTE (SELECT format('INSERT INTO public.%I (%s) VALUES (%s) RETURNING id', p_table,
                         string_agg(quote_ident(k.key), ', '), string_agg(quote_nullable(k.value #>> '{}'), ', '))
           FROM jsonb_each(p_cols) k
           WHERE EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema = 'public' AND ic.table_name = p_table AND ic.column_name = k.key))
  INTO v_id;
  RETURN v_id;
END $$;
CREATE FUNCTION pg_temp.c82_route(p_plate text, p_site uuid, p_client uuid, p_at timestamptz, p_status text, p_mode text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE d uuid; r uuid;
BEGIN
  d := pg_temp.c82_ins('dispatches', jsonb_build_object('id', gen_random_uuid(), 'dispatch_number', 'ZZ-C82-' || p_plate, 'vehicle_plate', p_plate,
    'status', p_status, 'site_id', p_site, 'scheduled_departure', p_at, 'scheduled_date', (p_at AT TIME ZONE 'America/Lima')::date, 'modalidad', p_mode, 'docs_required', false,
    'tercero_doc', CASE WHEN p_mode = 'TERCERO' THEN 'C82' || replace(gen_random_uuid()::text, '-', '') END,
    'tercero_conductor', CASE WHEN p_mode = 'TERCERO' THEN 'Chofer C82' END));
  r := pg_temp.c82_ins('transport_requests', jsonb_build_object('request_number', 'ZZ-C82-' || p_plate, 'request_type', 'DESPACHO',
    'attention_mode', 'TRANSPORTE_JRM', 'status', 'ASIGNADA', 'site_id', p_site, 'client_id', p_client, 'requester_name', 'ZZ',
    'department', 'Logística', 'cargo_description', 'Prueba C82', 'pickup_address', 'Planta', 'delivery_address', 'Obra',
    'delivery_district', 'LURIN', 'required_date', (p_at AT TIME ZONE 'America/Lima')::date));
  INSERT INTO public.dispatch_requests(dispatch_id, transport_request_id, status, document_type, sequence_order) VALUES (d, r, p_status, 'GR', 1);
  RETURN d;
END $$;

DO $test$
DECLARE site uuid; carrier uuid; client uuid; suffix text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5));
  old_route uuid; today_route uuid; third_route uuid; req uuid; closed integer; backlog integer; v_err text; v_status text;
BEGIN
  SELECT carrier_id, site_id INTO carrier, site FROM public.vehicles WHERE carrier_id IS NOT NULL AND site_id IS NOT NULL LIMIT 1;
  SELECT id INTO client FROM public.clients ORDER BY id LIMIT 1;
  IF site IS NULL OR client IS NULL THEN RAISE EXCEPTION 'CAJA C82 FAIL: faltan sede o cliente'; END IF;
  PERFORM pg_temp.c82_ins('vehicles', jsonb_build_object('plate', 'ZC82A' || suffix, 'carrier_id', carrier, 'site_id', site, 'type', 'CAMION', 'status', 'EN_OPERACION'));
  PERFORM pg_temp.c82_ins('vehicles', jsonb_build_object('plate', 'ZC82B' || suffix, 'carrier_id', carrier, 'site_id', site, 'type', 'CAMION', 'status', 'EN_OPERACION'));
  old_route := pg_temp.c82_route('ZC82A' || suffix, site, client, now() - interval '1 day', 'EN RUTA', 'PROPIA');
  today_route := pg_temp.c82_route('ZC82B' || suffix, site, client, now(), 'EN RUTA', 'PROPIA');
  third_route := pg_temp.c82_route('ZC82T' || suffix, site, client, now() - interval '1 day', 'EN RUTA', 'TERCERO');

  -- T1: sin el cierre operativo, una ruta no avanza sin las guías validadas
  BEGIN UPDATE public.dispatches SET status = 'RETORNO_COMPLETADO' WHERE id = today_route; v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err IS NULL THEN RAISE EXCEPTION 'CAJA C82 FAIL: la guarda de guías dejó avanzar la ruta (T1)'; END IF;

  -- T2: a las 00:00 se cierra la ruta propia del día anterior y se libera la unidad; la documentación queda pendiente
  SELECT count(*) INTO backlog FROM public.dispatches d WHERE d.status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO')
    AND d.vehicle_plate <> 'EXTERNO' AND COALESCE(to_jsonb(d)->>'modalidad','PROPIA') <> 'TERCERO' AND d.dispatch_number NOT LIKE 'ZZ-C82-%'
    AND (COALESCE(d.scheduled_departure, d.created_at) AT TIME ZONE 'America/Lima')::date < (now() AT TIME ZONE 'America/Lima')::date;
  closed := public.dispatch_midnight_close();
  SELECT status INTO v_status FROM public.dispatches WHERE id = old_route;
  IF v_status <> 'RETORNO_COMPLETADO' OR NOT EXISTS (SELECT 1 FROM public.dispatch_events WHERE dispatch_id = old_route AND event_type = 'CIERRE_OPERATIVO')
     OR (SELECT status FROM public.vehicles WHERE plate = 'ZC82A' || suffix) NOT IN ('DISPONIBLE', 'OBSERVADA')
     OR NOT EXISTS (SELECT 1 FROM public.vehicle_history_logs WHERE vehicle_plate = 'ZC82A' || suffix AND new_value IN ('DISPONIBLE', 'OBSERVADA'))
     OR EXISTS (SELECT 1 FROM public.delivery_conformities WHERE dispatch_id = old_route AND state = 'VALIDADA') THEN
    RAISE EXCEPTION 'CAJA C82 FAIL: cierre de las 00:00 (T2): ruta %, unidad %', v_status, (SELECT status FROM public.vehicles WHERE plate = 'ZC82A' || suffix); END IF;

  -- T3: no se cierran la ruta del día ni la de un tercero
  IF (SELECT status FROM public.dispatches WHERE id = today_route) <> 'EN RUTA' OR (SELECT status FROM public.dispatches WHERE id = third_route) <> 'EN RUTA' THEN
    RAISE EXCEPTION 'CAJA C82 FAIL: cerró una ruta del día o de un tercero (T3)'; END IF;

  -- T4: el conductor envía la guía de su último punto → la ruta se cierra y la unidad se libera
  SELECT transport_request_id INTO req FROM public.dispatch_requests WHERE dispatch_id = today_route;
  INSERT INTO public.delivery_conformities(dispatch_id, request_id, state) VALUES (today_route, req, 'RECIBIDA');
  IF (SELECT status FROM public.dispatches WHERE id = today_route) <> 'RETORNO_COMPLETADO'
     OR NOT EXISTS (SELECT 1 FROM public.dispatch_events WHERE dispatch_id = today_route AND event_type = 'CIERRE_OPERATIVO' AND description LIKE 'El conductor%')
     OR (SELECT status FROM public.vehicles WHERE plate = 'ZC82B' || suffix) NOT IN ('DISPONIBLE', 'OBSERVADA') THEN
    RAISE EXCEPTION 'CAJA C82 FAIL: cierre al completar los puntos (T4)'; END IF;

  -- T5: «Agregar servicio» rechaza rutas de días anteriores; el conductor puede subir guías pendientes de la ruta cerrada
  IF position('día anterior' IN pg_get_functiondef('public.active_route_context(uuid)'::regprocedure)) = 0
     OR position('Ruta cerrada: guía pendiente' IN pg_get_functiondef('public.delivery_submit_driver(uuid,uuid,text[],text,text,text,uuid,timestamptz)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'CAJA C82 FAIL: regla de rutas vigentes o guías pendientes (T5)'; END IF;

  -- T6: solo el sistema ejecuta el cierre; la tarea de las 00:00 está programada
  IF has_function_privilege('authenticated', 'public.dispatch_midnight_close()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.dispatch_operational_close(uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.dispatch_operational_close(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'CAJA C82 FAIL: cierre expuesto a usuarios (T6)'; END IF;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE 'SELECT count(*) FROM cron.job WHERE jobname = ''cierre-operativo-rutas'' AND schedule = ''0 5 * * *''' INTO closed;
    IF closed <> 1 THEN RAISE EXCEPTION 'CAJA C82 FAIL: falta la tarea de las 00:00 (T6)'; END IF;
  END IF;

  RAISE EXCEPTION 'CAJA C82 PASS (6/6) cierre operativo: 00:00 y último punto liberan la unidad; liquidación documentaria pendiente | rutas propias atrasadas que se cerrarán a las 00:00: %', backlog;
END $test$;
ROLLBACK;
