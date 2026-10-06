-- Partida bruta: utilidad protegida del 20%, operación del 80%. Conserva gastos históricos.
BEGIN;
ALTER TABLE public.contract_budgets ALTER COLUMN balance_pen DROP EXPRESSION;
CREATE OR REPLACE FUNCTION public.transport_operating_budget(p_gross numeric) RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$ SELECT COALESCE(p_gross,0)-round(COALESCE(p_gross,0)*0.20,2) $$;
CREATE OR REPLACE FUNCTION public.transport_budget_balance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_limit numeric; v_old numeric:=0;
BEGIN
 v_limit:=CASE WHEN NEW.concept='PARTIDA_TRANSPORTE' THEN public.transport_operating_budget(NEW.allocated_pen) ELSE COALESCE(NEW.allocated_pen,0) END;
 IF TG_OP='UPDATE' THEN v_old:=COALESCE(OLD.reserved_pen,0)+COALESCE(OLD.consumed_pen,0); END IF;
 NEW.balance_pen:=v_limit-COALESCE(NEW.reserved_pen,0)-COALESCE(NEW.consumed_pen,0);
 -- No altera históricos excedidos ni impide pasar una reserva a consumo al cierre.
 IF NEW.concept='PARTIDA_TRANSPORTE' AND NEW.balance_pen<0 AND
    COALESCE(NEW.reserved_pen,0)+COALESCE(NEW.consumed_pen,0)>v_old THEN
   RAISE EXCEPTION 'Saldo insuficiente: solo se dispone del 80%% de la partida; el 20%% de utilidad está protegido';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER transport_budget_balance BEFORE INSERT OR UPDATE ON public.contract_budgets
FOR EACH ROW EXECUTE FUNCTION public.transport_budget_balance();
UPDATE public.contract_budgets SET balance_pen=balance_pen;

-- El conductor es drivers.id; responsible_id sigue siendo el custodio (profiles.id) de Fleet 360.
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS assigned_driver_id uuid REFERENCES public.drivers(id);
CREATE UNIQUE INDEX vehicles_one_assigned_driver ON public.vehicles(assigned_driver_id) WHERE assigned_driver_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.vehicle_driver_assignment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.assigned_driver_id IS NOT NULL THEN
   PERFORM pg_advisory_xact_lock(hashtextextended(NEW.assigned_driver_id::text,450));
   IF NOT EXISTS(SELECT 1 FROM public.drivers WHERE id=NEW.assigned_driver_id AND is_active) THEN RAISE EXCEPTION 'Seleccione un conductor activo'; END IF;
   IF EXISTS(SELECT 1 FROM public.vehicles WHERE assigned_driver_id=NEW.assigned_driver_id AND id<>NEW.id) THEN
     RAISE EXCEPTION 'El conductor ya tiene otra unidad asignada. Libere la asignación anterior primero'; END IF;
   IF EXISTS(SELECT 1 FROM public.dispatches WHERE status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO') AND
     ((driver_id=NEW.assigned_driver_id AND vehicle_plate IS DISTINCT FROM NEW.plate) OR
      (vehicle_plate=NEW.plate AND driver_id IS DISTINCT FROM NEW.assigned_driver_id))) THEN
     RAISE EXCEPTION 'La asignación contradice una ruta activa. Reprograme la ruta antes de cambiar conductor o unidad'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER vehicle_driver_assignment_guard BEFORE INSERT OR UPDATE OF assigned_driver_id,plate ON public.vehicles
FOR EACH ROW EXECUTE FUNCTION public.vehicle_driver_assignment_guard();
CREATE OR REPLACE FUNCTION public.dispatch_driver_assignment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_assigned uuid; v_key text; v_assigned_key text;
BEGIN
 IF NEW.status NOT IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO') OR NEW.vehicle_plate='EXTERNO' THEN RETURN NEW; END IF;
 IF NEW.driver_id IS NOT NULL THEN
   PERFORM pg_advisory_xact_lock(hashtextextended(NEW.driver_id::text,450));
   SELECT upper(regexp_replace(COALESCE(document_number,''),'[^A-Za-z0-9]','','g')) INTO v_key FROM public.drivers WHERE id=NEW.driver_id;
   SELECT assigned_driver_id INTO v_assigned FROM public.vehicles WHERE plate=NEW.vehicle_plate;
   IF (v_assigned IS NOT NULL AND v_assigned<>NEW.driver_id) OR EXISTS(SELECT 1 FROM public.vehicles
     WHERE assigned_driver_id=NEW.driver_id AND plate IS DISTINCT FROM NEW.vehicle_plate) THEN
     RAISE EXCEPTION 'Conductor y unidad no coinciden con la asignación de Flota'; END IF;
 ELSIF COALESCE(to_jsonb(NEW)->>'modalidad','')='TERCERO' THEN
   IF TG_OP='INSERT' AND NULLIF(trim(to_jsonb(NEW)->>'tercero_doc'),'') IS NULL THEN RAISE EXCEPTION 'Indique el documento del chofer para controlar una sola unidad por conductor'; END IF;
   v_key:=upper(regexp_replace(COALESCE(to_jsonb(NEW)->>'tercero_doc',''),'[^A-Za-z0-9]','','g'));
   IF TG_OP='INSERT' AND NULLIF(v_key,'') IS NULL THEN RAISE EXCEPTION 'Documento del chofer inválido'; END IF;
   SELECT upper(regexp_replace(COALESCE(dr.document_number,''),'[^A-Za-z0-9]','','g')) INTO v_assigned_key
   FROM public.vehicles v JOIN public.drivers dr ON dr.id=v.assigned_driver_id WHERE v.plate=NEW.vehicle_plate;
   IF v_assigned_key IS NOT NULL AND v_assigned_key IS DISTINCT FROM v_key THEN RAISE EXCEPTION 'La unidad tiene otro conductor asignado en Flota'; END IF;
 END IF;
 IF NULLIF(v_key,'') IS NOT NULL THEN
   PERFORM pg_advisory_xact_lock(hashtextextended(v_key,451));
   IF EXISTS(SELECT 1 FROM public.dispatches d LEFT JOIN public.drivers dr ON dr.id=d.driver_id
     WHERE d.id<>NEW.id AND d.status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO')
       AND upper(regexp_replace(COALESCE(dr.document_number,to_jsonb(d)->>'tercero_doc',''),'[^A-Za-z0-9]','','g'))=v_key
       AND d.vehicle_plate IS DISTINCT FROM NEW.vehicle_plate) OR EXISTS(SELECT 1 FROM public.vehicles v JOIN public.drivers dr ON dr.id=v.assigned_driver_id
       WHERE upper(regexp_replace(COALESCE(dr.document_number,''),'[^A-Za-z0-9]','','g'))=v_key AND v.plate IS DISTINCT FROM NEW.vehicle_plate) THEN
     RAISE EXCEPTION 'El conductor ya tiene otra unidad asignada o una ruta activa. Libere o reprograme la asignación anterior';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dispatch_driver_assignment_guard BEFORE INSERT OR UPDATE ON public.dispatches
FOR EACH ROW EXECUTE FUNCTION public.dispatch_driver_assignment_guard();

CREATE OR REPLACE FUNCTION public.transport_request_budget_sync()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b       public.contract_budgets%ROWTYPE;
  v_cost  numeric := COALESCE(NEW.service_cost, 0) + COALESCE(NEW.unloading_estimate_pen,0);
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  -- Sale de "aprobada / reprogramada con aprobación": se libera su reserva
  IF COALESCE(OLD.reserved_pen, 0) > 0 AND NEW.status NOT IN ('APROBADA', 'REPROGRAMADA') THEN
    UPDATE public.contract_budgets SET reserved_pen = GREATEST(reserved_pen - OLD.reserved_pen, 0), updated_at = now()
    WHERE contract_id = OLD.contract_id AND concept = 'PARTIDA_TRANSPORTE';
    NEW.reserved_pen := 0;
  END IF;
  IF NEW.status IN ('PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'OBSERVADA', 'RECHAZADA', 'CANCELADA') THEN
    NEW.approved_at := NULL; NEW.approved_by := NULL;
  END IF;

  -- Entra a APROBADA: reserva el costo estimado; sin saldo queda OBSERVADA
  IF NEW.status='APROBADA' AND NEW.attention_mode IS NOT NULL AND auth.uid() IS NOT NULL AND NOT public.has_tms_permission('despacho-aprobacion') AND NOT (public.has_tms_permission('despacho') AND OLD.status='ASIGNADA' AND OLD.approved_at IS NOT NULL AND EXISTS(SELECT 1 FROM public.dispatch_requests dr JOIN public.dispatches d ON d.id=dr.dispatch_id WHERE dr.transport_request_id=OLD.id AND d.status='CANCELADO')) THEN RAISE EXCEPTION 'Solo el Supervisor de Despacho aprueba solicitudes'; END IF;
  IF NEW.status NOT IN ('APROBADA','REPROGRAMADA','ASIGNADA','EN_TRANSITO','ENTREGADA') THEN NEW.operational_approved_pen:=0; END IF;
  IF NEW.status='APROBADA' AND NEW.contract_id IS NULL THEN
    IF v_cost>0 THEN
      NEW.status:='OBSERVADA'; NEW.approved_at:=NULL; NEW.approved_by:=NULL;
      NEW.operational_approved_pen:=0; NEW.budget_shortfall:=v_cost;
      NEW.budget_observation:='Vincule una OT para financiar los costos a cargo de JRM';
      RETURN NEW;
    END IF;
    NEW.operational_approved_pen:=v_cost;
    NEW.approved_at:=COALESCE(NEW.approved_at,now()); NEW.approved_by:=COALESCE(NEW.approved_by,auth.uid());
    NEW.budget_shortfall:=0; NEW.budget_observation:=NULL;
    RETURN NEW;
  END IF;
  IF NEW.status = 'APROBADA' AND COALESCE(OLD.reserved_pen, 0) = 0 THEN
    IF v_cost > 0 THEN
      SELECT * INTO b FROM public.contract_budgets WHERE contract_id = NEW.contract_id AND concept = 'PARTIDA_TRANSPORTE' FOR UPDATE;
      IF b.id IS NULL OR b.balance_pen < v_cost THEN
        NEW.status := 'OBSERVADA';
        NEW.budget_shortfall := v_cost - COALESCE(b.balance_pen, 0);
        NEW.budget_observation := 'Partida insuficiente: faltan S/ ' || round(v_cost - COALESCE(b.balance_pen, 0), 2);
        NEW.approved_at := NULL; NEW.approved_by := NULL;
        RETURN NEW;
      END IF;
      UPDATE public.contract_budgets SET reserved_pen = reserved_pen + v_cost, updated_at = now() WHERE id = b.id;
      NEW.reserved_pen := v_cost;
    END IF;
    NEW.approved_at := COALESCE(NEW.approved_at, now());
    NEW.approved_by := COALESCE(NEW.approved_by, auth.uid());
    NEW.budget_shortfall := 0; NEW.budget_observation := NULL;
  END IF;

  -- Solo se programa lo aprobado (una reprogramación sin aprobación previa vuelve a aprobación)
  IF NEW.status = 'ASIGNADA' AND OLD.status IN ('REPROGRAMADA', 'APROBADA') AND OLD.approved_at IS NULL THEN
    RAISE EXCEPTION 'La solicitud % debe aprobarse antes de programarse', NEW.request_number;
  END IF;
  RETURN NEW;
END $$;

-- Un renglón por servicio/OT: suma exacta del flete, reservas independientes y retiro trazable.
CREATE TABLE public.dispatch_request_freight (
 dispatch_id uuid NOT NULL REFERENCES public.dispatches(id),
 request_id uuid NOT NULL REFERENCES public.transport_requests(id),
 contract_id uuid REFERENCES public.contracts(id),
 amount_pen numeric(15,2) NOT NULL CHECK(amount_pen>=0),
 service_id uuid REFERENCES public.contract_services(id),
 status text NOT NULL DEFAULT 'RESERVADO' CHECK(status IN ('RESERVADO','CONSUMIDO','LIBERADO')),
 PRIMARY KEY(dispatch_id,request_id)
);
ALTER TABLE public.dispatch_request_freight ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dispatch_request_freight FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.dispatch_request_freight TO authenticated;
CREATE POLICY dispatch_request_freight_read ON public.dispatch_request_freight FOR SELECT TO authenticated
USING(EXISTS(SELECT 1 FROM public.dispatches d WHERE d.id=dispatch_id AND public.can_operate_dispatch(d.site_id)));

CREATE OR REPLACE FUNCTION public.validate_mixed_dispatch(p_requests jsonb,p_doc text,p_freight numeric) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record; v_count int:=0; v_site uuid; v_total numeric:=0; v_amount numeric; b record;
BEGIN
 IF NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Sin permiso para programar despachos'; END IF;
 IF p_requests IS NULL OR jsonb_typeof(p_requests)<>'array' OR jsonb_array_length(p_requests) NOT BETWEEN 1 AND 100
    OR p_doc IS NULL OR p_doc NOT IN ('GR','NOTA_SALIDA') OR COALESCE(p_freight,0)<0 THEN RAISE EXCEPTION 'Seleccione solicitudes válidas'; END IF;
 IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p_requests))<>jsonb_array_length(p_requests) THEN RAISE EXCEPTION 'Solicitud duplicada'; END IF;
 FOR r IN SELECT t.* FROM public.transport_requests t WHERE t.id IN(SELECT (value->>'id')::uuid FROM jsonb_array_elements(p_requests)) ORDER BY t.id FOR UPDATE LOOP
   IF NOT public.can_access_site(r.site_id) THEN RAISE EXCEPTION 'Sede no autorizada'; END IF;
   IF r.status NOT IN ('APROBADA','REPROGRAMADA') OR r.approved_at IS NULL THEN RAISE EXCEPTION 'Solicitud no aprobada, ya asignada o inexistente'; END IF;
   IF r.attention_mode IS NULL OR (r.attention_mode='RECOJO_CLIENTE') IS DISTINCT FROM (p_doc='NOTA_SALIDA') THEN
     RAISE EXCEPTION 'La modalidad se define en la solicitud; no mezcle transporte JRM y recojo por cliente'; END IF;
   IF v_count>0 AND r.site_id IS DISTINCT FROM v_site THEN RAISE EXCEPTION 'Las solicitudes deben compartir sede de operación'; END IF;
   v_count:=v_count+1; v_site:=r.site_id;
   SELECT NULLIF(value->>'freight_share_pen','')::numeric INTO v_amount FROM jsonb_array_elements(p_requests) WHERE value->>'id'=r.id::text;
   IF v_amount IS NULL OR v_amount<0 OR v_amount<>round(v_amount,2) THEN RAISE EXCEPTION 'Indique el flete de cada servicio con dos decimales'; END IF;
   IF r.contract_id IS NULL AND v_amount>0 THEN RAISE EXCEPTION 'El flete a cargo de JRM debe imputarse a una OT con partida de transporte'; END IF;
   v_total:=v_total+v_amount;
 END LOOP;
 IF v_count<>jsonb_array_length(p_requests) THEN RAISE EXCEPTION 'Solicitud inexistente'; END IF;
 IF v_total<>COALESCE(p_freight,0) THEN RAISE EXCEPTION 'La suma del flete por servicio debe coincidir con el total de la ruta'; END IF;
 IF p_doc='NOTA_SALIDA' AND v_total<>0 THEN RAISE EXCEPTION 'El recojo por cliente tiene flete JRM cero'; END IF;
 -- Bloqueos ordenados por OT: no se presta saldo entre partidas.
 FOR r IN SELECT t.contract_id,sum((e.value->>'freight_share_pen')::numeric) AS amount,sum(COALESCE(t.reserved_pen,0)) AS old_reserved
   FROM jsonb_array_elements(p_requests)e JOIN public.transport_requests t ON t.id=(e.value->>'id')::uuid
   WHERE t.contract_id IS NOT NULL GROUP BY t.contract_id ORDER BY t.contract_id LOOP
   SELECT * INTO b FROM public.contract_budgets WHERE contract_id=r.contract_id AND concept='PARTIDA_TRANSPORTE' FOR UPDATE;
   IF r.amount>0 AND (b.id IS NULL OR b.balance_pen+r.old_reserved<r.amount) THEN
     RAISE EXCEPTION 'Saldo operativo insuficiente en la OT %: disponible S/ %, flete S/ %. Solo se dispone del 80%%',r.contract_id,COALESCE(b.balance_pen,0)+r.old_reserved,r.amount; END IF;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.reserve_mixed_dispatch(p_id uuid,p_requests jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record; d record; v_service uuid; c jsonb;
BEGIN
 SELECT * INTO d FROM public.dispatches WHERE id=p_id;
 SELECT to_jsonb(x) INTO c FROM public.carriers x WHERE x.id=d.carrier_id;
 FOR r IN SELECT t.id,t.contract_id,t.request_number,(e.value->>'freight_share_pen')::numeric AS amount
   FROM jsonb_array_elements(p_requests)e JOIN public.transport_requests t ON t.id=(e.value->>'id')::uuid ORDER BY t.contract_id,t.id LOOP
   v_service:=NULL;
   IF r.amount>0 THEN
     UPDATE public.contract_budgets SET reserved_pen=reserved_pen+r.amount,updated_at=now() WHERE contract_id=r.contract_id AND concept='PARTIDA_TRANSPORTE';
     INSERT INTO public.contract_services(contract_id,service_type,description,amount_pen,service_date,plate,driver_name,category,created_by,dispatch_id,provider_ruc,provider_name)
     VALUES(r.contract_id,'FLETE','Ruta mixta '||d.dispatch_number||' · '||r.request_number,r.amount,(d.scheduled_departure AT TIME ZONE 'America/Lima')::date,d.vehicle_plate,d.driver_name,'Contrato',auth.uid(),p_id,
       COALESCE(NULLIF(c->>'tax_id',''),NULLIF(c->>'ruc','')),c->>'business_name') RETURNING id INTO v_service;
   END IF;
   INSERT INTO public.dispatch_request_freight(dispatch_id,request_id,contract_id,amount_pen,service_id) VALUES(p_id,r.id,r.contract_id,r.amount,v_service);
 END LOOP;
 UPDATE public.dispatches SET site_id=(SELECT site_id FROM public.transport_requests WHERE id=(p_requests->0->>'id')::uuid) WHERE id=p_id;
 INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by) VALUES(p_id,'FLETE_POR_OT','Ruta mixta: flete distribuido por servicio y OT, utilidad del 20% protegida',auth.uid()::text);
END $$;

CREATE OR REPLACE FUNCTION public.schedule_dispatch(p_driver_id uuid,p_vehicle_plate text,p_departure timestamptz,p_estimated_km numeric,
 p_freight_cost numeric,p_contract_id uuid,p_document_type text,p_requests jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid; v_contract uuid; v_n int;
BEGIN
 SELECT count(DISTINCT COALESCE(t.contract_id::text,'SIN_OT')) INTO v_n FROM public.transport_requests t WHERE t.id IN(SELECT (value->>'id')::uuid FROM jsonb_array_elements(p_requests));
 IF v_n<=1 THEN
   PERFORM public.request_attention_for_dispatch(p_requests,p_document_type,p_contract_id,p_freight_cost);
   v_contract:=p_contract_id;
 ELSE
   PERFORM public.validate_mixed_dispatch(p_requests,p_document_type,p_freight_cost);
   v_contract:=NULL;
 END IF;
 v_id:=public.schedule_dispatch_attention_legacy(p_driver_id,p_vehicle_plate,p_departure,
   CASE WHEN p_document_type='NOTA_SALIDA' THEN 0 ELSE p_estimated_km END,p_freight_cost,v_contract,p_document_type,p_requests);
 IF v_n>1 THEN PERFORM public.reserve_mixed_dispatch(v_id,p_requests); END IF;
 UPDATE public.dispatches SET cost_center_id=NULL,site_id=(SELECT site_id FROM public.transport_requests WHERE id=(p_requests->0->>'id')::uuid) WHERE id=v_id;
 RETURN v_id;
END $$;
CREATE OR REPLACE FUNCTION public.schedule_dispatch_tercero(p_carrier_id uuid,p_plate text,p_conductor text,p_telefono text,p_doc text,
 p_departure timestamptz,p_estimated_km numeric,p_freight_cost numeric,p_contract_id uuid,p_requests jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid; v_contract uuid; v_n int;
BEGIN
 SELECT count(DISTINCT COALESCE(t.contract_id::text,'SIN_OT')) INTO v_n FROM public.transport_requests t WHERE t.id IN(SELECT (value->>'id')::uuid FROM jsonb_array_elements(p_requests));
 IF v_n<=1 THEN
   PERFORM public.request_attention_for_dispatch(p_requests,'GR',p_contract_id,p_freight_cost); v_contract:=p_contract_id;
 ELSE
   PERFORM public.validate_mixed_dispatch(p_requests,'GR',p_freight_cost); v_contract:=NULL;
 END IF;
 v_id:=public.schedule_dispatch_tercero_attention_legacy(p_carrier_id,p_plate,p_conductor,p_telefono,p_doc,p_departure,p_estimated_km,p_freight_cost,v_contract,p_requests);
 IF v_n>1 THEN PERFORM public.reserve_mixed_dispatch(v_id,p_requests); END IF;
 UPDATE public.dispatches SET cost_center_id=NULL,site_id=(SELECT site_id FROM public.transport_requests WHERE id=(p_requests->0->>'id')::uuid) WHERE id=v_id;
 RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.settle_mixed_dispatch_freight(p_id uuid,p_consume boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM public.dispatch_request_freight WHERE dispatch_id=p_id AND status='RESERVADO' ORDER BY contract_id,request_id FOR UPDATE LOOP
   IF r.amount_pen>0 THEN
     UPDATE public.contract_budgets SET reserved_pen=GREATEST(reserved_pen-r.amount_pen,0),
       consumed_pen=consumed_pen+CASE WHEN p_consume THEN r.amount_pen ELSE 0 END,updated_at=now()
     WHERE contract_id=r.contract_id AND concept='PARTIDA_TRANSPORTE';
     IF NOT FOUND THEN RAISE EXCEPTION 'La OT no tiene partida de transporte'; END IF;
   END IF;
   UPDATE public.dispatch_request_freight SET status=CASE WHEN p_consume THEN 'CONSUMIDO' ELSE 'LIBERADO' END WHERE dispatch_id=p_id AND request_id=r.request_id;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.release_mixed_stop_freight() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record;
BEGIN
 IF (SELECT status FROM public.dispatches WHERE id=OLD.dispatch_id)<>'PROGRAMADO' THEN RETURN OLD; END IF;
 SELECT * INTO r FROM public.dispatch_request_freight WHERE dispatch_id=OLD.dispatch_id AND request_id=OLD.transport_request_id AND status='RESERVADO' FOR UPDATE;
 IF FOUND THEN
   UPDATE public.contract_budgets SET reserved_pen=GREATEST(reserved_pen-r.amount_pen,0),updated_at=now() WHERE contract_id=r.contract_id AND concept='PARTIDA_TRANSPORTE';
   UPDATE public.contract_services SET status='ANULADO' WHERE id=r.service_id;
   UPDATE public.dispatch_request_freight SET status='LIBERADO' WHERE dispatch_id=r.dispatch_id AND request_id=r.request_id;
   UPDATE public.dispatches SET freight_cost=GREATEST(freight_cost-r.amount_pen,0) WHERE id=r.dispatch_id;
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER release_mixed_stop_freight AFTER DELETE ON public.dispatch_requests FOR EACH ROW EXECUTE FUNCTION public.release_mixed_stop_freight();

CREATE OR REPLACE FUNCTION public.dispatch_release_on_cancel(p_dispatch_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d      public.dispatches%ROWTYPE;
  v_reqs text;
BEGIN
  SELECT * INTO d FROM public.dispatches WHERE id = p_dispatch_id;
  PERFORM public.settle_mixed_dispatch_freight(p_dispatch_id,false);
  -- Reserva del flete en la partida de transporte de la OT
  IF COALESCE(d.freight_cost, 0) > 0 AND d.contract_id IS NOT NULL THEN
    UPDATE public.contract_budgets SET reserved_pen = GREATEST(reserved_pen - d.freight_cost, 0), updated_at = now()
    WHERE contract_id = d.contract_id AND concept = 'PARTIDA_TRANSPORTE';
  END IF;
  -- El servicio FLETE creado al programar deja de contar
  UPDATE public.contract_services SET status = 'ANULADO'
  WHERE dispatch_id = p_dispatch_id AND service_type = 'FLETE' AND COALESCE(status, '') <> 'ANULADO';
  -- Las solicitudes vuelven a estar aprobadas para programarse de nuevo
  SELECT string_agg(COALESCE(tr.request_number::text, tr.id::text), ', ') INTO v_reqs
  FROM public.dispatch_requests dr JOIN public.transport_requests tr ON tr.id = dr.transport_request_id
  WHERE dr.dispatch_id = p_dispatch_id;
  UPDATE public.transport_requests SET status = 'APROBADA'
  WHERE id IN (SELECT transport_request_id FROM public.dispatch_requests WHERE dispatch_id = p_dispatch_id)
    AND status = 'ASIGNADA';
  DELETE FROM public.dispatch_requests WHERE dispatch_id = p_dispatch_id;
  INSERT INTO public.dispatch_events (dispatch_id, event_type, description, created_by)
  VALUES (p_dispatch_id, 'CANCELACION', 'Despacho cancelado: ' || COALESCE(p_reason, 'sin motivo')
    || '. Se liberó la partida y volvieron a aprobadas: ' || COALESCE(v_reqs, 'ninguna'), COALESCE(auth.uid()::text, 'system'));
END $$;
CREATE OR REPLACE FUNCTION public.close_dispatch_route(p_dispatch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_dispatch public.dispatches%ROWTYPE;
DECLARE v_coverage boolean;
DECLARE v_mileage numeric;
DECLARE v_release jsonb;
BEGIN
  IF NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Sin permiso para cerrar despachos'; END IF;
  SELECT * INTO v_dispatch FROM public.dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF v_dispatch.id IS NULL OR NOT public.can_access_site(v_dispatch.site_id) THEN RAISE EXCEPTION 'Despacho inexistente'; END IF;
  IF v_dispatch.status = 'LIQUIDADO' THEN
    RETURN jsonb_build_object('actual_distance_km', v_dispatch.actual_distance_km,
      'gps_complete', v_dispatch.gps_coverage_complete);
  END IF;
  IF v_dispatch.status NOT IN ('RETORNO_COMPLETADO', 'ENTREGADO')
    OR EXISTS (SELECT 1 FROM public.dispatch_requests
      WHERE dispatch_id = p_dispatch_id AND status <> 'ENTREGADO') THEN
    RAISE EXCEPTION 'Falta confirmar el retorno a base (o la entrega) o hay paradas pendientes';
  END IF;
  SELECT count(*) > 0 AND bool_and(coalesce(leg_gps_complete, false))
    INTO v_coverage FROM public.dispatch_requests WHERE dispatch_id = p_dispatch_id;
  v_coverage := coalesce(v_coverage, false) AND coalesce(v_dispatch.return_gps_complete, false)
    AND NOT EXISTS (SELECT 1 FROM public.route_track_points
      WHERE dispatch_id = p_dispatch_id AND gap_detected);

  PERFORM public.settle_mixed_dispatch_freight(p_dispatch_id,true);
  IF coalesce(v_dispatch.freight_cost, 0) > 0 AND v_dispatch.contract_id IS NOT NULL THEN
    UPDATE public.contract_budgets SET reserved_pen = GREATEST(reserved_pen - v_dispatch.freight_cost, 0),
      consumed_pen = consumed_pen + v_dispatch.freight_cost, updated_at = now()
    WHERE contract_id = v_dispatch.contract_id AND concept = 'PARTIDA_TRANSPORTE';
    IF NOT FOUND THEN RAISE EXCEPTION 'La OT del despacho no tiene partida de transporte'; END IF;
  END IF;

  IF v_coverage AND coalesce(v_dispatch.actual_distance_km, 0) > 0
    AND v_dispatch.vehicle_plate IS NOT NULL AND v_dispatch.vehicle_plate <> 'EXTERNO' THEN
    -- El GPS solo sirve de contraste; el odómetro real se actualiza por checklist u otros métodos.
    SELECT current_mileage INTO v_mileage FROM public.vehicles WHERE plate = v_dispatch.vehicle_plate;
    IF v_mileage IS NOT NULL THEN
      INSERT INTO public.vehicle_maintenance_history(vehicle_id, action_type, description, mileage_at_time)
      SELECT id, 'GPS_REGISTRADO', 'Ruta ' || v_dispatch.dispatch_number
        || ' (Recorrido GPS: ' || v_dispatch.actual_distance_km || ' km)', v_mileage
      FROM public.vehicles WHERE plate = v_dispatch.vehicle_plate;
    END IF;
  END IF;

  UPDATE public.transport_requests SET status = 'ENTREGADA' WHERE id IN (
    SELECT transport_request_id FROM public.dispatch_requests WHERE dispatch_id = p_dispatch_id);
  UPDATE public.dispatches SET status = 'LIQUIDADO', gps_coverage_complete = v_coverage
    WHERE id = p_dispatch_id;
  INSERT INTO public.dispatch_events (dispatch_id, event_type, description, created_by)
  VALUES (p_dispatch_id, 'STATUS_CHANGE', 'Cierre de ruta: ' || v_dispatch.status || ' -> LIQUIDADO', COALESCE(auth.uid()::text, 'system'));

  IF v_dispatch.vehicle_plate IS NOT NULL
     AND (SELECT status FROM public.vehicles WHERE plate = v_dispatch.vehicle_plate) IN ('ASIGNADA', 'EN_OPERACION') THEN
    v_release := public.transition_vehicle_status(v_dispatch.vehicle_plate, 'DISPONIBLE',
      'Despacho cerrado (LIQUIDADO)', auth.uid(), jsonb_build_object('dispatch_id', p_dispatch_id));
  END IF;
  RETURN jsonb_build_object('actual_distance_km', v_dispatch.actual_distance_km, 'gps_complete', v_coverage);
END $$;
-- Conserva permisos y trazabilidad de la edición de servicios; el total de una ruta mixta es la suma.
CREATE OR REPLACE FUNCTION public.sync_mixed_freight_amount() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE public.dispatch_request_freight SET amount_pen=NEW.amount_pen WHERE service_id=NEW.id AND status<>'LIBERADO';
 RETURN NEW;
END $$;
CREATE TRIGGER sync_mixed_freight_amount AFTER UPDATE OF amount_pen ON public.contract_services FOR EACH ROW EXECUTE FUNCTION public.sync_mixed_freight_amount();
DO $patch$
DECLARE v_def text;
BEGIN
 v_def:=pg_get_functiondef('public.update_contract_service_amount(uuid,numeric)'::regprocedure);
 IF position('SET freight_cost = p_new_amount' IN v_def)=0 THEN RAISE EXCEPTION 'Motor de edición de flete no reconocido'; END IF;
 v_def:=replace(v_def,'SET freight_cost = p_new_amount','SET freight_cost = CASE WHEN EXISTS(SELECT 1 FROM public.dispatch_request_freight WHERE dispatch_id=s.dispatch_id) THEN (SELECT COALESCE(sum(amount_pen),0) FROM public.contract_services WHERE dispatch_id=s.dispatch_id AND service_type=''FLETE'' AND COALESCE(status,'''')<>''ANULADO'') ELSE p_new_amount END');
 EXECUTE v_def;
 v_def:=pg_get_functiondef('public.set_transport_request_status(uuid,text,date)'::regprocedure);
 v_def:=replace(v_def,'IF NOT (v_supervisor OR (public.is_contract_administrator()', 'IF NOT (v_supervisor OR public.has_tms_permission(''despacho'') OR (public.is_contract_administrator()');
 v_def:=replace(v_def,'p_required_date < current_date','p_required_date < (now() AT TIME ZONE ''America/Lima'')::date');
 EXECUTE v_def;
END $patch$;
REVOKE ALL ON FUNCTION public.transport_budget_balance(),public.vehicle_driver_assignment_guard(),public.dispatch_driver_assignment_guard(),
 public.validate_mixed_dispatch(jsonb,text,numeric),public.reserve_mixed_dispatch(uuid,jsonb),public.settle_mixed_dispatch_freight(uuid,boolean),
 public.release_mixed_stop_freight(),public.sync_mixed_freight_amount() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.transport_operating_budget(numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.transport_operating_budget(numeric) TO authenticated,service_role;

-- La planificación multi-OT reserva cada descarga en la OT de su propia solicitud.
ALTER FUNCTION public.plan_dispatch_unloading(uuid,jsonb) RENAME TO plan_dispatch_unloading_single_ot;
REVOKE ALL ON FUNCTION public.plan_dispatch_unloading_single_ot(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.plan_dispatch_unloading(p_dispatch_id uuid,p_items jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; l record; r record; b record; e jsonb; v_id uuid; v_req uuid; v_ctr uuid; v_amount numeric;
 v_rows jsonb:='[]'; v_keep uuid[]:='{}'; v_total numeric:=0;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.dispatch_request_freight WHERE dispatch_id=p_dispatch_id) THEN
   RETURN public.plan_dispatch_unloading_single_ot(p_dispatch_id,p_items); END IF;
 IF NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Solo el Supervisor de Transporte planifica los costos de descarga'; END IF;
 SELECT * INTO d FROM public.dispatches WHERE id=p_dispatch_id FOR UPDATE;
 IF NOT FOUND OR NOT public.can_access_site(d.site_id) THEN RAISE EXCEPTION 'Despacho inexistente'; END IF;
 IF d.status<>'PROGRAMADO' THEN RAISE EXCEPTION 'La descarga se planifica mientras el despacho está programado'; END IF;
 IF p_items IS NULL OR jsonb_typeof(p_items)<>'array' THEN RAISE EXCEPTION 'Costos de descarga inválidos'; END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(p_items) LOOP
   v_id:=NULLIF(e->>'id','')::uuid; v_req:=NULLIF(e->>'request_id','')::uuid;
   v_amount:=NULLIF(e->>'planned_pen','')::numeric;
   IF v_amount IS NULL OR v_amount<0 OR v_amount<>round(v_amount,2) THEN RAISE EXCEPTION 'Indique el monto planificado con dos decimales'; END IF;
   IF v_id IS NOT NULL THEN
     IF v_id=ANY(v_keep) THEN RAISE EXCEPTION 'Costo de descarga duplicado'; END IF;
     SELECT * INTO l FROM public.transport_unloading_costs WHERE id=v_id FOR UPDATE;
     IF NOT FOUND OR l.status NOT IN ('ESTIMADO','PLANIFICADO') OR COALESCE(l.dispatch_id,p_dispatch_id)<>p_dispatch_id THEN RAISE EXCEPTION 'Costo de descarga no disponible'; END IF;
     v_req:=l.transport_request_id; v_keep:=array_append(v_keep,v_id);
   ELSIF upper(COALESCE(e->>'concept','')) NOT IN ('MONTACARGAS','GRUA','ESTIBA','OTROS') THEN RAISE EXCEPTION 'Concepto de descarga inválido'; END IF;
   SELECT t.contract_id INTO v_ctr FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id=dr.transport_request_id
     WHERE dr.dispatch_id=p_dispatch_id AND t.id=v_req;
   IF NOT FOUND THEN RAISE EXCEPTION 'La solicitud no pertenece a este despacho'; END IF;
   IF v_ctr IS NULL AND v_amount>0 THEN RAISE EXCEPTION 'Vincule una OT para financiar los costos a cargo de JRM'; END IF;
   v_rows:=v_rows||jsonb_build_array(jsonb_build_object('id',v_id,'req',v_req,'contract',v_ctr,'amount',v_amount,'concept',upper(e->>'concept'),'description',e->>'description'));
 END LOOP;
 FOR r IN WITH proposed AS (
   SELECT (value->>'contract')::uuid AS contract_id,sum((value->>'amount')::numeric) AS amount FROM jsonb_array_elements(v_rows) GROUP BY 1
 ), previous AS (
   SELECT contract_id,sum(COALESCE(planned_pen,0)) AS amount FROM public.transport_unloading_costs WHERE dispatch_id=p_dispatch_id AND status='PLANIFICADO' GROUP BY 1
 ) SELECT COALESCE(p.contract_id,o.contract_id) AS contract_id,COALESCE(p.amount,0)-COALESCE(o.amount,0) AS delta FROM proposed p FULL JOIN previous o USING(contract_id) ORDER BY 1 LOOP
   IF r.contract_id IS NOT NULL THEN
     SELECT * INTO b FROM public.contract_budgets WHERE contract_id=r.contract_id AND concept='PARTIDA_TRANSPORTE' FOR UPDATE;
     IF r.delta>0 AND (b.id IS NULL OR r.delta>b.balance_pen) THEN RAISE EXCEPTION 'Saldo insuficiente para la descarga en OT %',r.contract_id; END IF;
     UPDATE public.contract_budgets SET reserved_pen=GREATEST(reserved_pen+r.delta,0),updated_at=now() WHERE id=b.id;
   END IF;
   v_total:=v_total+r.delta;
 END LOOP;
 UPDATE public.transport_unloading_costs SET status=CASE WHEN estimated_pen>0 THEN 'ESTIMADO' ELSE 'ANULADO' END,
   dispatch_id=CASE WHEN estimated_pen>0 THEN NULL ELSE dispatch_id END,planned_pen=NULL,planned_by=NULL,planned_at=NULL
 WHERE dispatch_id=p_dispatch_id AND status='PLANIFICADO' AND NOT(id=ANY(v_keep));
 FOR e IN SELECT value FROM jsonb_array_elements(v_rows) LOOP
   v_id:=(e->>'id')::uuid;
   IF v_id IS NOT NULL THEN
     UPDATE public.transport_unloading_costs SET status='PLANIFICADO',dispatch_id=p_dispatch_id,contract_id=(e->>'contract')::uuid,
       planned_pen=(e->>'amount')::numeric,description=COALESCE(NULLIF(trim(e->>'description'),''),description),planned_by=auth.uid(),planned_at=now() WHERE id=v_id;
   ELSE
     INSERT INTO public.transport_unloading_costs(transport_request_id,dispatch_id,contract_id,concept,description,planned_pen,status,created_by,planned_by,planned_at)
     VALUES((e->>'req')::uuid,p_dispatch_id,(e->>'contract')::uuid,e->>'concept',NULLIF(trim(e->>'description'),''),(e->>'amount')::numeric,'PLANIFICADO',auth.uid(),auth.uid(),now());
   END IF;
 END LOOP;
 RETURN jsonb_build_object('success',true,'reserved_delta',v_total);
EXCEPTION WHEN raise_exception THEN RETURN jsonb_build_object('success',false,'error',SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.plan_dispatch_unloading(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.plan_dispatch_unloading(uuid,jsonb) TO authenticated,service_role;

-- Caja no debe elegir una OT al azar. En rutas mixtas, la descarga se regulariza por la solicitud.
CREATE OR REPLACE FUNCTION public.mixed_route_expense_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF upper(COALESCE(NEW.status,''))='APROBADO' AND NEW.status IS DISTINCT FROM OLD.status AND upper(COALESCE(NEW.expense_type,'')) IN ('ALQUILER_EQUIPO','CUADRILLA_ESTIBA')
   AND EXISTS(SELECT 1 FROM public.dispatch_request_freight WHERE dispatch_id=NEW.dispatch_id) THEN
   RAISE EXCEPTION 'Ruta con varias OT: registre el costo real en Tripulación y descarga de la solicitud correspondiente; no se imputa una descarga sin identificar la OT';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mixed_route_expense_guard BEFORE UPDATE OF status ON public.dispatch_expenses FOR EACH ROW EXECUTE FUNCTION public.mixed_route_expense_guard();
REVOKE ALL ON FUNCTION public.mixed_route_expense_guard() FROM PUBLIC,anon,authenticated,service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
