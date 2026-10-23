-- Registro de Servicios: cada ruta programada figura en /contratos/servicios por cada OT que atiende.
--
-- Causa: al programar, la línea FLETE del servicio solo se creaba con flete > 0 (schedule_dispatch, reserve_mixed_dispatch,
-- add_active_route_service). Una ruta de flota propia sin tarifa detectada (flete 0) quedaba en Torre de Control pero no en
-- el Registro de Servicios (p. ej. OT 16396: 4 unidades programadas, 2 servicios registrados).
--
-- Corrección:
--  1. Disparador diferido (al confirmar la transacción) sobre dispatch_requests: si la ruta no tiene una línea FLETE vigente para
--     la OT de la solicitud, crea una con monto 0 («sin valorizar»). Corre después de las funciones de programación, así que
--     nunca duplica la línea con monto que ellas crean. Sin efecto en la partida (monto 0); al valorizarla desde el registro,
--     update_contract_service_amount reserva o consume como siempre. En rutas mixtas se vincula a su reparto por OT.
--  2. Regularización de las rutas vigentes sin línea y con flete 0 (o reparto 0 para esa OT). Las rutas con flete > 0 sin línea
--     siguen en la cola existente de «Regularizar flete» (reconcile_dispatch_freight), que sí revisa la partida.
--  Exclusiones: recojo por el cliente (NOTA_SALIDA / placa EXTERNO), rutas canceladas y solicitudes sin OT.
BEGIN;

CREATE OR REPLACE FUNCTION public.ensure_route_service_line(p_dispatch uuid, p_contract uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d record; v_service uuid; v_amount numeric;
BEGIN
  IF p_dispatch IS NULL OR p_contract IS NULL THEN RETURN NULL; END IF;
  SELECT x.id, x.dispatch_number, x.status, x.vehicle_plate, x.scheduled_departure, x.created_by,
    COALESCE(x.driver_name, to_jsonb(x)->>'tercero_conductor') AS driver, x.carrier_id
  INTO d FROM public.dispatches x WHERE x.id = p_dispatch;
  IF NOT FOUND OR d.status = 'CANCELADO' OR d.vehicle_plate = 'EXTERNO' THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id
                 WHERE dr.dispatch_id = p_dispatch AND t.contract_id = p_contract AND dr.document_type IS DISTINCT FROM 'NOTA_SALIDA') THEN
    RETURN NULL;
  END IF;
  -- Serializa por ruta: dos solicitudes de la misma OT no crean dos líneas
  PERFORM 1 FROM public.dispatches WHERE id = p_dispatch FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.contract_services s WHERE s.dispatch_id = p_dispatch AND s.contract_id = p_contract
             AND s.service_type = 'FLETE' AND COALESCE(s.status, '') <> 'ANULADO') THEN
    RETURN NULL;
  END IF;
  -- En una ruta mixta, una OT con reparto > 0 sin línea es un vínculo perdido: va a «Regularizar flete», no se inventa en 0
  SELECT COALESCE(sum(f.amount_pen), 0) INTO v_amount FROM public.dispatch_request_freight f
  WHERE f.dispatch_id = p_dispatch AND f.contract_id = p_contract AND f.status <> 'LIBERADO';
  IF v_amount > 0 THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.dispatch_request_freight f WHERE f.dispatch_id = p_dispatch)
     AND COALESCE((SELECT freight_cost FROM public.dispatches WHERE id = p_dispatch), 0) > 0 THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.contract_services(contract_id, service_type, description, amount_pen, service_date, plate, driver_name,
    category, created_by, dispatch_id, provider_ruc, provider_name)
  SELECT p_contract, 'FLETE', 'Flete del despacho ' || d.dispatch_number || ' · sin valorizar', 0,
    (d.scheduled_departure AT TIME ZONE 'America/Lima')::date, d.vehicle_plate, d.driver,
    'Contrato', COALESCE(auth.uid(), d.created_by), p_dispatch,
    COALESCE(NULLIF(to_jsonb(c)->>'tax_id', ''), NULLIF(to_jsonb(c)->>'ruc', '')), to_jsonb(c)->>'business_name'
  FROM (SELECT 1) one LEFT JOIN public.carriers c ON c.id = d.carrier_id
  RETURNING id INTO v_service;
  -- Ruta mixta: el reparto de esa OT apunta a su línea (al valorizarla, sync_mixed_freight_amount actualiza el reparto)
  UPDATE public.dispatch_request_freight SET service_id = v_service
  WHERE dispatch_id = p_dispatch AND contract_id = p_contract AND service_id IS NULL AND status <> 'LIBERADO';
  INSERT INTO public.dispatch_events(dispatch_id, event_type, description, created_by)
  VALUES (p_dispatch, 'FLETE_SIN_VALORIZAR', 'Servicio registrado en la OT con flete por valorizar', COALESCE(auth.uid()::text, 'system'));
  RETURN v_service;
END $$;

CREATE OR REPLACE FUNCTION public.route_service_line_on_commit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- La fila pudo borrarse en la misma transacción (cancelación): solo se registra si sigue en la ruta
  IF EXISTS (SELECT 1 FROM public.dispatch_requests WHERE dispatch_id = NEW.dispatch_id AND transport_request_id = NEW.transport_request_id) THEN
    PERFORM public.ensure_route_service_line(NEW.dispatch_id, (SELECT contract_id FROM public.transport_requests WHERE id = NEW.transport_request_id));
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS route_service_line_on_commit ON public.dispatch_requests;
CREATE CONSTRAINT TRIGGER route_service_line_on_commit AFTER INSERT ON public.dispatch_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.route_service_line_on_commit();

REVOKE ALL ON FUNCTION public.ensure_route_service_line(uuid, uuid), public.route_service_line_on_commit() FROM PUBLIC, anon, authenticated;

-- Regularización: rutas vigentes (no canceladas) sin su línea en el registro
DO $$
DECLARE r record; v_created int := 0; v_pending_freight int := 0;
BEGIN
  FOR r IN SELECT DISTINCT dr.dispatch_id, t.contract_id
           FROM public.dispatch_requests dr
           JOIN public.transport_requests t ON t.id = dr.transport_request_id
           JOIN public.dispatches d ON d.id = dr.dispatch_id
           WHERE t.contract_id IS NOT NULL AND d.status <> 'CANCELADO' AND d.vehicle_plate <> 'EXTERNO'
             AND dr.document_type IS DISTINCT FROM 'NOTA_SALIDA'
             AND NOT EXISTS (SELECT 1 FROM public.contract_services s WHERE s.dispatch_id = dr.dispatch_id AND s.contract_id = t.contract_id
                             AND s.service_type = 'FLETE' AND COALESCE(s.status, '') <> 'ANULADO')
           ORDER BY dr.dispatch_id, t.contract_id LOOP
    IF public.ensure_route_service_line(r.dispatch_id, r.contract_id) IS NOT NULL THEN v_created := v_created + 1;
    ELSE v_pending_freight := v_pending_freight + 1; END IF;
  END LOOP;
  RAISE NOTICE 'Registro de servicios: % rutas·OT registradas sin valorizar; % con flete > 0 quedan en «Regularizar flete»', v_created, v_pending_freight;
END $$;

COMMIT;
