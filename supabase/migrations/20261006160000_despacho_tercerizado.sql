-- ============================================================
-- DESPACHO TERCERIZADO — unidad de un transportista que no usa el app
-- ============================================================
-- Cuando una entrega se terceriza, la unidad y el chofer no están en Flota ni en Trabajadores y el proveedor no usa
-- el app (sin checklist pre-ruta ni GPS). El despacho se programa igual (solicitudes, guía, partida de la OT) y el
-- avance lo registra Despacho / Torre de Control desde la web, o el chofer del tercero desde un enlace sin instalar
-- nada:
--   · Programar: transportista (Maestros → Transportistas), placa, chofer y teléfono escritos a mano; el flete se
--     reserva en la partida a nombre del proveedor (RUC).
--   · Salida: hora real (pasa a EN CURSO; la Asistente Documentario sigue debiendo confirmar la guía antes).
--   · Entrega por parada: hora, quién recibió y foto de la guía firmada o constancia. Con todas, pasa a ENTREGADO y
--     "Cerrar ruta" (close_dispatch_route) consume la partida como siempre.
--   · Desempeño por proveedor (salida puntual, entrega a tiempo, flete), aparte del de los conductores propios: el
--     despacho no tiene driver_id, así que no entra en sus indicadores.
-- Producción no coincide con el historial del repositorio: las columnas opcionales se leen con to_jsonb() y el
-- historial de estados (kpi_dispatch_log) y dispatches.departure_time se tocan solo si existen.
BEGIN;

-- ------------------------------------------------------------
-- 1. Datos del tercero en el despacho
-- ------------------------------------------------------------
ALTER TABLE public.dispatches
  ADD COLUMN IF NOT EXISTS modalidad          text NOT NULL DEFAULT 'PROPIA',
  ADD COLUMN IF NOT EXISTS carrier_id         uuid,
  ADD COLUMN IF NOT EXISTS tercero_conductor  text,
  ADD COLUMN IF NOT EXISTS tercero_telefono   text,
  ADD COLUMN IF NOT EXISTS tercero_doc        text,
  ADD COLUMN IF NOT EXISTS tercero_salida_at  timestamptz,
  ADD COLUMN IF NOT EXISTS tercero_entrega_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatches_modalidad_chk') THEN
    ALTER TABLE public.dispatches ADD CONSTRAINT dispatches_modalidad_chk CHECK (modalidad IN ('PROPIA', 'TERCERO'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS dispatches_tercero_idx ON public.dispatches (carrier_id) WHERE modalidad = 'TERCERO';

-- Entregas registradas por la web o por el enlace del chofer (constancia de cada parada)
CREATE TABLE IF NOT EXISTS public.dispatch_tercero_entregas (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id          uuid NOT NULL REFERENCES public.dispatches(id) ON DELETE CASCADE,
  transport_request_id uuid NOT NULL,
  entregado_at         timestamptz NOT NULL,
  recibido_por         text,
  foto_path            text NOT NULL,
  nota                 text,
  fuente               text NOT NULL CHECK (fuente IN ('WEB', 'ENLACE')),
  registrado_por       uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dispatch_id, transport_request_id)
);
ALTER TABLE public.dispatch_tercero_entregas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dispatch_tercero_entregas_read ON public.dispatch_tercero_entregas;
CREATE POLICY dispatch_tercero_entregas_read ON public.dispatch_tercero_entregas FOR SELECT TO authenticated
  USING (public.can_operate_dispatch(NULL));

-- Enlace para el chofer del tercero: vale para un viaje, vence y se puede revocar (solo vía funciones)
CREATE TABLE IF NOT EXISTS public.dispatch_tercero_enlaces (
  token        text PRIMARY KEY,
  dispatch_id  uuid NOT NULL REFERENCES public.dispatches(id) ON DELETE CASCADE,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS dispatch_tercero_enlaces_dispatch_idx ON public.dispatch_tercero_enlaces (dispatch_id);
ALTER TABLE public.dispatch_tercero_enlaces ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- 2. Programar con un tercero (espejo de schedule_dispatch sin conductor propio ni unidad de Flota)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.schedule_dispatch_tercero(
  p_carrier_id uuid, p_plate text, p_conductor text, p_telefono text, p_doc text,
  p_departure timestamptz, p_estimated_km numeric, p_freight_cost numeric, p_contract_id uuid, p_requests jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_carrier   jsonb;
  v_plate     text := upper(regexp_replace(COALESCE(p_plate, ''), '[^A-Za-z0-9-]', '', 'g'));
  v_conductor text := NULLIF(trim(COALESCE(p_conductor, '')), '');
  v_dispatch_id uuid;
  v_number    text;
  v_budget    public.contract_budgets%ROWTYPE;
  v_request   jsonb;
  v_request_id uuid;
  v_order     integer := 0;
  v_request_reserved numeric := 0;
  v_row       jsonb;
  v_cols      text;
BEGIN
  IF NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Sin permiso para programar despachos'; END IF;
  IF p_departure IS NULL OR p_requests IS NULL OR jsonb_typeof(p_requests) <> 'array' OR jsonb_array_length(p_requests) = 0
     OR COALESCE(p_freight_cost, 0) < 0 THEN
    RAISE EXCEPTION 'Datos de programación incompletos';
  END IF;
  IF length(v_plate) < 5 OR length(v_plate) > 10 THEN RAISE EXCEPTION 'Placa del tercero inválida'; END IF;
  IF v_conductor IS NULL THEN RAISE EXCEPTION 'Indique el nombre del chofer del tercero'; END IF;
  IF NULLIF(trim(COALESCE(p_telefono, '')), '') IS NULL THEN RAISE EXCEPTION 'Indique el teléfono del chofer del tercero'; END IF;

  SELECT to_jsonb(c) INTO v_carrier FROM public.carriers c WHERE c.id = p_carrier_id;
  IF v_carrier IS NULL OR NOT COALESCE((v_carrier ->> 'is_active')::boolean, true) THEN
    RAISE EXCEPTION 'Transportista inexistente o inactivo';
  END IF;
  IF upper(COALESCE(v_carrier ->> 'type', '')) = 'PROPIO' THEN
    RAISE EXCEPTION 'El transportista % es la empresa propia: programe con unidad propia', v_carrier ->> 'business_name';
  END IF;
  IF EXISTS (SELECT 1 FROM public.vehicles v JOIN public.carriers c ON c.id = v.carrier_id
             WHERE upper(replace(v.plate, ' ', '')) = v_plate AND upper(COALESCE(to_jsonb(c) ->> 'type', '')) = 'PROPIO') THEN
    RAISE EXCEPTION 'La placa % es de la flota propia: prográmela como unidad propia', v_plate;
  END IF;
  IF EXISTS (SELECT 1 FROM public.dispatches d WHERE d.vehicle_plate = v_plate
             AND d.status IN ('PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO')) THEN
    RAISE EXCEPTION 'La placa % ya tiene un despacho activo', v_plate;
  END IF;

  -- Bloqueo pre-ordenado de las solicitudes y su reserva vigente desde la aprobación (igual que schedule_dispatch)
  FOR v_request_id IN (SELECT (value ->> 'id')::uuid AS req_id FROM jsonb_array_elements(p_requests) ORDER BY req_id) LOOP
    PERFORM 1 FROM public.transport_requests WHERE id = v_request_id AND status IN ('APROBADA', 'REPROGRAMADA') FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Solicitud no aprobada, ya asignada o inexistente'; END IF;
  END LOOP;
  SELECT COALESCE(sum((to_jsonb(t) ->> 'reserved_pen')::numeric), 0) INTO v_request_reserved
  FROM public.transport_requests t
  WHERE t.id IN (SELECT (value ->> 'id')::uuid FROM jsonb_array_elements(p_requests)) AND t.contract_id IS NOT DISTINCT FROM p_contract_id;

  IF COALESCE(p_freight_cost, 0) > 0 AND p_contract_id IS NOT NULL THEN
    SELECT * INTO v_budget FROM public.contract_budgets WHERE contract_id = p_contract_id AND concept = 'PARTIDA_TRANSPORTE' FOR UPDATE;
    IF v_budget.id IS NULL OR v_budget.balance_pen + v_request_reserved < p_freight_cost THEN
      RAISE EXCEPTION 'Presupuesto de transporte insuficiente';
    END IF;
  END IF;

  v_number := 'DESP-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  -- Solo las columnas que existen (en producción dispatches puede conservar scheduled_date obligatorio)
  v_row := jsonb_build_object('dispatch_number', v_number, 'driver_id', NULL, 'driver_name', v_conductor, 'vehicle_plate', v_plate,
    'scheduled_departure', p_departure, 'scheduled_date', p_departure, 'status', 'PROGRAMADO',
    'estimated_distance_km', COALESCE(p_estimated_km, 0), 'freight_cost', COALESCE(p_freight_cost, 0), 'contract_id', p_contract_id,
    'docs_required', true, 'created_by', auth.uid(), 'modalidad', 'TERCERO', 'carrier_id', p_carrier_id, 'tercero_conductor', v_conductor,
    'tercero_telefono', trim(p_telefono), 'tercero_doc', NULLIF(trim(COALESCE(p_doc, '')), ''));
  SELECT string_agg(quote_ident(k), ', ') INTO v_cols FROM jsonb_object_keys(v_row) k
  WHERE EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema = 'public' AND ic.table_name = 'dispatches' AND ic.column_name = k)
    AND (v_row ->> k IS NOT NULL OR k = 'driver_id');
  EXECUTE format('INSERT INTO public.dispatches (%1$s) SELECT %1$s FROM jsonb_populate_record(NULL::public.dispatches, $1) RETURNING id', v_cols)
    INTO v_dispatch_id USING v_row;

  FOR v_request IN SELECT value FROM jsonb_array_elements(p_requests) LOOP
    v_order := v_order + 1;
    v_request_id := (v_request ->> 'id')::uuid;
    IF p_contract_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.transport_requests
        WHERE id = v_request_id AND contract_id IS DISTINCT FROM p_contract_id) THEN
      RAISE EXCEPTION 'Las solicitudes deben pertenecer al mismo contrato';
    END IF;
    INSERT INTO public.dispatch_requests(dispatch_id, transport_request_id, status, document_type, document_number, leg_planned_km, sequence_order)
    VALUES (v_dispatch_id, v_request_id, 'PROGRAMADO', 'GR', NULLIF(v_request ->> 'document_number', ''),
            NULLIF(v_request ->> 'leg_planned_km', '')::numeric, v_order);
    UPDATE public.transport_requests SET status = 'ASIGNADA' WHERE id = v_request_id;
  END LOOP;

  -- El flete se reserva en la partida y queda como servicio a nombre del proveedor
  IF COALESCE(p_freight_cost, 0) > 0 AND p_contract_id IS NOT NULL THEN
    UPDATE public.contract_budgets SET reserved_pen = reserved_pen + p_freight_cost, updated_at = now() WHERE id = v_budget.id;
    INSERT INTO public.contract_services(contract_id, service_type, description, amount_pen, service_date, plate, driver_name,
      category, created_by, dispatch_id, provider_ruc, provider_name)
    VALUES (p_contract_id, 'FLETE', 'Flete tercerizado del despacho ' || v_number || ' · ' || (v_carrier ->> 'business_name'),
      p_freight_cost, p_departure::date, v_plate, v_conductor, 'Contrato', auth.uid(), v_dispatch_id,
      v_carrier ->> 'ruc', v_carrier ->> 'business_name');
  END IF;

  INSERT INTO public.dispatch_events (dispatch_id, event_type, description, created_by)
  VALUES (v_dispatch_id, 'TERCERIZADO', 'Unidad de tercero: ' || (v_carrier ->> 'business_name') || ' · ' || v_plate || ' · ' || v_conductor,
          COALESCE(auth.uid()::text, 'system'));
  RETURN v_dispatch_id;
END $$;

-- ------------------------------------------------------------
-- 3. Hora real en el historial de estados (los KPI miden la salida y la entrega con kpi_dispatch_log)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tercero_ajustar_hora(p_dispatch_id uuid, p_estados text[], p_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF to_regclass('public.kpi_dispatch_log') IS NOT NULL THEN
    EXECUTE 'UPDATE public.kpi_dispatch_log SET at = $3 WHERE dispatch_id = $1 AND estado_nuevo = ANY($2)'
      USING p_dispatch_id, p_estados, p_at;
  END IF;
  IF 'EN_CURSO' = ANY(p_estados) AND EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'dispatches' AND column_name = 'departure_time') THEN
    EXECUTE 'UPDATE public.dispatches SET departure_time = $2 WHERE id = $1' USING p_dispatch_id, p_at;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 4. Salida y entregas (núcleo común de la web y del enlace; uso interno)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tercero_salida_core(p_dispatch_id uuid, p_at timestamptz, p_fuente text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d jsonb; r jsonb; v_at timestamptz := COALESCE(p_at, now());
BEGIN
  SELECT to_jsonb(x) INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id FOR UPDATE;
  IF d IS NULL OR d ->> 'modalidad' IS DISTINCT FROM 'TERCERO' THEN
    RETURN jsonb_build_object('success', false, 'error', 'El despacho no es de una unidad tercerizada');
  END IF;
  IF d ->> 'status' IN ('EN_CURSO', 'EN RUTA') AND d ->> 'tercero_salida_at' IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'note', 'La salida ya estaba registrada', 'salida_at', d ->> 'tercero_salida_at');
  END IF;
  IF d ->> 'status' <> 'PROGRAMADO' THEN
    RETURN jsonb_build_object('success', false, 'error', 'El despacho ya no está programado (' || (d ->> 'status') || ')');
  END IF;
  IF v_at > now() + interval '5 minutes' THEN RETURN jsonb_build_object('success', false, 'error', 'La hora de salida no puede ser futura'); END IF;
  IF v_at < COALESCE(NULLIF(d ->> 'scheduled_departure', '')::timestamptz, now()) - interval '1 day' THEN
    RETURN jsonb_build_object('success', false, 'error', 'La hora de salida es muy anterior a la programada');
  END IF;

  r := public.transition_dispatch_status(p_dispatch_id, 'EN_CURSO', 'Salida de la unidad tercerizada (' || p_fuente || ')');
  IF NOT COALESCE((r ->> 'success')::boolean, false) THEN RETURN r; END IF;
  UPDATE public.dispatches SET tercero_salida_at = v_at WHERE id = p_dispatch_id;
  PERFORM public.tercero_ajustar_hora(p_dispatch_id, ARRAY['EN_CURSO', 'EN CURSO', 'EN RUTA', 'EN_RUTA'], v_at);
  RETURN jsonb_build_object('success', true, 'salida_at', v_at);
END $$;

CREATE OR REPLACE FUNCTION public.tercero_entrega_core(
  p_dispatch_id uuid, p_request_id uuid, p_at timestamptz, p_recibido_por text, p_foto text, p_nota text, p_fuente text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d jsonb; r jsonb; v_at timestamptz := COALESCE(p_at, now()); v_pend int; v_ult timestamptz;
BEGIN
  SELECT to_jsonb(x) INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id FOR UPDATE;
  IF d IS NULL OR d ->> 'modalidad' IS DISTINCT FROM 'TERCERO' THEN
    RETURN jsonb_build_object('success', false, 'error', 'El despacho no es de una unidad tercerizada');
  END IF;
  IF d ->> 'status' = 'PROGRAMADO' THEN RETURN jsonb_build_object('success', false, 'error', 'Registre primero la salida de la unidad'); END IF;
  IF d ->> 'status' NOT IN ('EN_CURSO', 'EN RUTA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'El despacho no está en ruta (' || (d ->> 'status') || ')');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.dispatch_requests WHERE dispatch_id = p_dispatch_id AND transport_request_id = p_request_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'La parada no pertenece a este despacho');
  END IF;
  IF EXISTS (SELECT 1 FROM public.dispatch_requests WHERE dispatch_id = p_dispatch_id AND transport_request_id = p_request_id AND status = 'ENTREGADO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Esa parada ya está entregada');
  END IF;
  IF NULLIF(trim(COALESCE(p_foto, '')), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Adjunte la foto de la guía firmada o de la constancia de entrega');
  END IF;
  IF v_at > now() + interval '5 minutes' THEN RETURN jsonb_build_object('success', false, 'error', 'La hora de entrega no puede ser futura'); END IF;
  IF v_at < NULLIF(d ->> 'tercero_salida_at', '')::timestamptz - interval '5 minutes' THEN
    RETURN jsonb_build_object('success', false, 'error', 'La hora de entrega es anterior a la salida');
  END IF;

  UPDATE public.dispatch_requests SET status = 'ENTREGADO' WHERE dispatch_id = p_dispatch_id AND transport_request_id = p_request_id;
  UPDATE public.transport_requests SET status = 'ENTREGADA' WHERE id = p_request_id;
  INSERT INTO public.route_stops_log(dispatch_id, transport_request_id, driver_id, stop_type, arrival_time, odometer_km, photo_url, notes)
  VALUES (p_dispatch_id, p_request_id, NULL, 'ENTREGA', v_at, 0, trim(p_foto),
          concat_ws(' · ', 'Tercero (' || p_fuente || ')', 'Recibió: ' || NULLIF(trim(COALESCE(p_recibido_por, '')), ''), NULLIF(trim(COALESCE(p_nota, '')), '')));
  INSERT INTO public.dispatch_tercero_entregas (dispatch_id, transport_request_id, entregado_at, recibido_por, foto_path, nota, fuente, registrado_por)
  VALUES (p_dispatch_id, p_request_id, v_at, NULLIF(trim(COALESCE(p_recibido_por, '')), ''), trim(p_foto), NULLIF(trim(COALESCE(p_nota, '')), ''), p_fuente, auth.uid());

  SELECT count(*) INTO v_pend FROM public.dispatch_requests WHERE dispatch_id = p_dispatch_id AND status <> 'ENTREGADO';
  IF v_pend = 0 THEN
    r := public.transition_dispatch_status(p_dispatch_id, 'ENTREGADO', 'Entregas de la unidad tercerizada registradas (' || p_fuente || ')');
    IF NOT COALESCE((r ->> 'success')::boolean, false) THEN RAISE EXCEPTION '%', COALESCE(r ->> 'error', 'No se pudo marcar como entregado'); END IF;
    SELECT max(entregado_at) INTO v_ult FROM public.dispatch_tercero_entregas WHERE dispatch_id = p_dispatch_id;
    UPDATE public.dispatches SET tercero_entrega_at = v_ult WHERE id = p_dispatch_id;
    PERFORM public.tercero_ajustar_hora(p_dispatch_id, ARRAY['ENTREGADO'], v_ult);
  END IF;
  RETURN jsonb_build_object('success', true, 'pendientes', v_pend, 'entregado', v_pend = 0);
END $$;

-- ------------------------------------------------------------
-- 5. Desde la web (Despacho / Monitoreo / Torre de Control de la sede)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tercero_puede_operar(p_dispatch_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.dispatches x WHERE x.id = p_dispatch_id
                 AND public.can_operate_dispatch(NULLIF(to_jsonb(x) ->> 'site_id', '')::uuid));
$$;

CREATE OR REPLACE FUNCTION public.tercero_registrar_salida(p_dispatch_id uuid, p_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.tercero_puede_operar(p_dispatch_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para registrar el avance de este despacho');
  END IF;
  RETURN public.tercero_salida_core(p_dispatch_id, p_at, 'WEB');
END $$;

CREATE OR REPLACE FUNCTION public.tercero_registrar_entrega(
  p_dispatch_id uuid, p_request_id uuid, p_at timestamptz, p_recibido_por text, p_foto text, p_nota text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.tercero_puede_operar(p_dispatch_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para registrar el avance de este despacho');
  END IF;
  RETURN public.tercero_entrega_core(p_dispatch_id, p_request_id, p_at, p_recibido_por, p_foto, p_nota, 'WEB');
END $$;

-- Paradas con su constancia (para la ventana de avance en Despacho)
CREATE OR REPLACE FUNCTION public.tercero_avance(p_dispatch_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d jsonb;
BEGIN
  IF NOT public.tercero_puede_operar(p_dispatch_id) THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso'); END IF;
  SELECT to_jsonb(x) INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
  RETURN jsonb_build_object('success', true,
    'despacho', jsonb_build_object('id', d ->> 'id', 'numero', d ->> 'dispatch_number', 'estado', d ->> 'status', 'placa', d ->> 'vehicle_plate',
      'conductor', d ->> 'tercero_conductor', 'telefono', d ->> 'tercero_telefono', 'doc', d ->> 'tercero_doc',
      'transportista', (SELECT c.business_name FROM public.carriers c WHERE c.id::text = d ->> 'carrier_id'),
      'salida_programada', d ->> 'scheduled_departure', 'salida_at', d ->> 'tercero_salida_at', 'entrega_at', d ->> 'tercero_entrega_at',
      'docs_listos', NOT COALESCE((d ->> 'docs_required')::boolean, false) OR (d ->> 'docs_ready_at' IS NOT NULL AND NOT COALESCE((d ->> 'docs_reissue')::boolean, false))),
    'paradas', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'request_id', dr.transport_request_id, 'orden', dr.sequence_order, 'solicitud', t.request_number,
        'destino', to_jsonb(t) ->> 'delivery_address', 'contacto', to_jsonb(t) ->> 'requester_name', 'documento', dr.document_number,
        'estado', dr.status, 'entregado_at', e.entregado_at, 'recibido_por', e.recibido_por, 'foto', e.foto_path, 'nota', e.nota, 'fuente', e.fuente)
        ORDER BY dr.sequence_order)
      FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id
      LEFT JOIN public.dispatch_tercero_entregas e ON e.dispatch_id = dr.dispatch_id AND e.transport_request_id = dr.transport_request_id
      WHERE dr.dispatch_id = p_dispatch_id), '[]'::jsonb),
    'enlace', (SELECT jsonb_build_object('token', l.token, 'expires_at', l.expires_at, 'last_used_at', l.last_used_at)
               FROM public.dispatch_tercero_enlaces l WHERE l.dispatch_id = p_dispatch_id AND l.revoked_at IS NULL AND l.expires_at > now()
               ORDER BY l.created_at DESC LIMIT 1));
END $$;

-- ------------------------------------------------------------
-- 6. Enlace para el chofer del tercero (sin cuenta ni app)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tercero_generar_enlace(p_dispatch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d jsonb; v_token text; v_exp timestamptz;
BEGIN
  IF NOT public.tercero_puede_operar(p_dispatch_id) THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso'); END IF;
  SELECT to_jsonb(x) INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
  IF d ->> 'modalidad' IS DISTINCT FROM 'TERCERO' THEN RETURN jsonb_build_object('success', false, 'error', 'El despacho no es de una unidad tercerizada'); END IF;
  IF d ->> 'status' NOT IN ('PROGRAMADO', 'EN_CURSO', 'EN RUTA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'El viaje ya no admite registros (' || (d ->> 'status') || ')');
  END IF;
  UPDATE public.dispatch_tercero_enlaces SET revoked_at = now() WHERE dispatch_id = p_dispatch_id AND revoked_at IS NULL;
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_exp := GREATEST(now(), COALESCE(NULLIF(d ->> 'scheduled_departure', '')::timestamptz, now())) + interval '3 days';
  INSERT INTO public.dispatch_tercero_enlaces (token, dispatch_id, created_by, expires_at) VALUES (v_token, p_dispatch_id, auth.uid(), v_exp);
  INSERT INTO public.dispatch_events (dispatch_id, event_type, description, created_by)
  VALUES (p_dispatch_id, 'ENLACE_TERCERO', 'Enlace para el chofer del tercero (vence ' || to_char(v_exp AT TIME ZONE 'America/Lima', 'DD/MM HH24:MI') || ')', COALESCE(auth.uid()::text, 'system'));
  RETURN jsonb_build_object('success', true, 'token', v_token, 'expires_at', v_exp);
END $$;

CREATE OR REPLACE FUNCTION public.tercero_revocar_enlace(p_dispatch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.tercero_puede_operar(p_dispatch_id) THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso'); END IF;
  UPDATE public.dispatch_tercero_enlaces SET revoked_at = now() WHERE dispatch_id = p_dispatch_id AND revoked_at IS NULL;
  RETURN jsonb_build_object('success', true);
END $$;

-- Valida el enlace (vigente, no revocado, viaje abierto). Las funciones del enlace solo las llama el servidor
-- (/api/tercero/[token], con la llave de servicio), nunca el navegador directamente.
CREATE OR REPLACE FUNCTION public.tercero_enlace_despacho(p_token text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  SELECT l.dispatch_id INTO v_id FROM public.dispatch_tercero_enlaces l JOIN public.dispatches d ON d.id = l.dispatch_id
  WHERE l.token = p_token AND l.revoked_at IS NULL AND l.expires_at > now()
    AND d.status NOT IN ('LIQUIDADO', 'CERRADO', 'CANCELADO');
  IF v_id IS NOT NULL THEN UPDATE public.dispatch_tercero_enlaces SET last_used_at = now() WHERE token = p_token; END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.tercero_enlace_info(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid := public.tercero_enlace_despacho(p_token); d jsonb;
BEGIN
  IF v_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'El enlace no es válido, venció o el viaje ya se cerró'); END IF;
  SELECT to_jsonb(x) INTO d FROM public.dispatches x WHERE x.id = v_id;
  -- Solo lo que el chofer necesita: sin costos ni datos del contrato
  RETURN jsonb_build_object('success', true, 'dispatch_id', v_id,
    'despacho', jsonb_build_object('numero', d ->> 'dispatch_number', 'estado', d ->> 'status', 'placa', d ->> 'vehicle_plate',
      'conductor', d ->> 'tercero_conductor', 'transportista', (SELECT c.business_name FROM public.carriers c WHERE c.id::text = d ->> 'carrier_id'),
      'salida_programada', d ->> 'scheduled_departure', 'salida_at', d ->> 'tercero_salida_at'),
    'paradas', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'request_id', dr.transport_request_id, 'orden', dr.sequence_order, 'solicitud', t.request_number,
        'destino', to_jsonb(t) ->> 'delivery_address', 'contacto', to_jsonb(t) ->> 'requester_name', 'documento', dr.document_number,
        'estado', dr.status, 'entregado_at', e.entregado_at, 'recibido_por', e.recibido_por) ORDER BY dr.sequence_order)
      FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id
      LEFT JOIN public.dispatch_tercero_entregas e ON e.dispatch_id = dr.dispatch_id AND e.transport_request_id = dr.transport_request_id
      WHERE dr.dispatch_id = v_id), '[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION public.tercero_enlace_salida(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid := public.tercero_enlace_despacho(p_token);
BEGIN
  IF v_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'El enlace no es válido, venció o el viaje ya se cerró'); END IF;
  RETURN public.tercero_salida_core(v_id, now(), 'ENLACE');
END $$;

CREATE OR REPLACE FUNCTION public.tercero_enlace_entregar(p_token text, p_request_id uuid, p_recibido_por text, p_foto text, p_nota text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid := public.tercero_enlace_despacho(p_token);
BEGIN
  IF v_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'El enlace no es válido, venció o el viaje ya se cerró'); END IF;
  -- La foto la sube el servidor a la carpeta del despacho
  IF COALESCE(p_foto, '') NOT LIKE 'tercero/' || v_id::text || '/%' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Foto no válida para este viaje');
  END IF;
  RETURN public.tercero_entrega_core(v_id, p_request_id, now(), p_recibido_por, p_foto, p_nota, 'ENLACE');
END $$;

-- ------------------------------------------------------------
-- 7. Desempeño por proveedor (aparte de los conductores propios)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tercero_desempeno(p_desde date DEFAULT NULL, p_hasta date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_hasta date := COALESCE(p_hasta, (now() AT TIME ZONE 'America/Lima')::date);
  v_desde date := COALESCE(p_desde, COALESCE(p_hasta, (now() AT TIME ZONE 'America/Lima')::date) - 89);
  v_tol interval := interval '30 minutes';
BEGIN
  IF NOT (public.has_tms_permission('despacho') OR public.has_tms_permission('desempeno') OR public.has_tms_permission('tarifas')
          OR public.has_tms_permission('torre-control')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso');
  END IF;
  RETURN (
    WITH v AS (
      SELECT x.id, x.dispatch_number AS numero, x.carrier_id, x.vehicle_plate AS placa, x.tercero_conductor AS conductor, x.status AS estado,
             COALESCE(x.freight_cost, 0) AS flete, x.scheduled_departure AS programado, x.tercero_salida_at AS salida_at, x.tercero_entrega_at AS entrega_at
      FROM public.dispatches x
      WHERE x.modalidad = 'TERCERO' AND x.status <> 'CANCELADO'
        AND (x.scheduled_departure AT TIME ZONE 'America/Lima')::date BETWEEN v_desde AND v_hasta
    ), p AS (  -- paradas entregadas frente a la fecha requerida de la solicitud
      SELECT v.carrier_id, e.entregado_at, NULLIF(to_jsonb(t) ->> 'required_date', '')::date AS requerida
      FROM v JOIN public.dispatch_tercero_entregas e ON e.dispatch_id = v.id
      JOIN public.transport_requests t ON t.id = e.transport_request_id
    ), agg AS (
      SELECT v.carrier_id, count(*) AS viajes,
             count(*) FILTER (WHERE v.estado IN ('LIQUIDADO', 'CERRADO')) AS cerrados,
             count(*) FILTER (WHERE v.salida_at IS NOT NULL) AS con_salida,
             count(*) FILTER (WHERE v.salida_at <= v.programado + v_tol) AS salida_puntual,
             round(sum(v.flete), 2) AS flete,
             round(avg(EXTRACT(epoch FROM v.entrega_at - v.salida_at) / 3600) FILTER (WHERE v.entrega_at IS NOT NULL AND v.salida_at IS NOT NULL)::numeric, 1) AS horas_ruta
      FROM v GROUP BY v.carrier_id
    ), pagg AS (
      SELECT p.carrier_id, count(*) AS entregas, count(*) FILTER (WHERE p.requerida IS NOT NULL) AS con_fecha,
             count(*) FILTER (WHERE (p.entregado_at AT TIME ZONE 'America/Lima')::date <= p.requerida) AS a_tiempo
      FROM p GROUP BY p.carrier_id
    )
    SELECT jsonb_build_object('success', true, 'desde', v_desde, 'hasta', v_hasta, 'tolerancia_min', 30,
      'proveedores', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'carrier_id', a.carrier_id, 'proveedor', COALESCE(c.business_name, 'Sin transportista'), 'ruc', c.ruc,
          'viajes', a.viajes, 'cerrados', a.cerrados, 'flete', a.flete, 'horas_ruta', a.horas_ruta,
          'salida_puntual_pct', CASE WHEN a.con_salida > 0 THEN round(100.0 * a.salida_puntual / a.con_salida, 1) END,
          'entregas', COALESCE(pa.entregas, 0),
          'entrega_a_tiempo_pct', CASE WHEN pa.con_fecha > 0 THEN round(100.0 * pa.a_tiempo / pa.con_fecha, 1) END)
          ORDER BY a.viajes DESC, c.business_name)
        FROM agg a LEFT JOIN public.carriers c ON c.id = a.carrier_id LEFT JOIN pagg pa ON pa.carrier_id IS NOT DISTINCT FROM a.carrier_id), '[]'::jsonb),
      'viajes', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', v.id, 'numero', v.numero, 'proveedor', c.business_name, 'placa', v.placa,
          'conductor', v.conductor, 'estado', v.estado, 'flete', v.flete, 'programado', v.programado, 'salida_at', v.salida_at, 'entrega_at', v.entrega_at,
          'salida_puntual', CASE WHEN v.salida_at IS NOT NULL THEN v.salida_at <= v.programado + v_tol END) ORDER BY v.programado DESC)
        FROM (SELECT * FROM v ORDER BY v.programado DESC LIMIT 100) v LEFT JOIN public.carriers c ON c.id = v.carrier_id), '[]'::jsonb))
  );
END $$;

-- ------------------------------------------------------------
-- 8. Permisos de ejecución
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.schedule_dispatch_tercero(uuid, text, text, text, text, timestamptz, numeric, numeric, uuid, jsonb),
  public.tercero_ajustar_hora(uuid, text[], timestamptz), public.tercero_salida_core(uuid, timestamptz, text),
  public.tercero_entrega_core(uuid, uuid, timestamptz, text, text, text, text), public.tercero_puede_operar(uuid),
  public.tercero_registrar_salida(uuid, timestamptz), public.tercero_registrar_entrega(uuid, uuid, timestamptz, text, text, text),
  public.tercero_avance(uuid), public.tercero_generar_enlace(uuid), public.tercero_revocar_enlace(uuid),
  public.tercero_enlace_despacho(text), public.tercero_enlace_info(text), public.tercero_enlace_salida(text),
  public.tercero_enlace_entregar(text, uuid, text, text, text), public.tercero_desempeno(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.schedule_dispatch_tercero(uuid, text, text, text, text, timestamptz, numeric, numeric, uuid, jsonb),
  public.tercero_puede_operar(uuid), public.tercero_registrar_salida(uuid, timestamptz),
  public.tercero_registrar_entrega(uuid, uuid, timestamptz, text, text, text), public.tercero_avance(uuid),
  public.tercero_generar_enlace(uuid), public.tercero_revocar_enlace(uuid), public.tercero_desempeno(date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tercero_enlace_info(text), public.tercero_enlace_salida(text),
  public.tercero_enlace_entregar(text, uuid, text, text, text) TO service_role;
GRANT SELECT ON public.dispatch_tercero_entregas TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
