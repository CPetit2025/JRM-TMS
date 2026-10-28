-- Un servicio de montacarga corresponde a una parada concreta. La tarifa/horas/importe
-- siguen siendo un único servicio de proveedor; no forman parte del reparto del flete.
-- Los registros históricos sin parada se conservan como servicio general de ruta.
BEGIN;
SET LOCAL lock_timeout='60s';
ALTER TABLE public.route_forklifts ADD COLUMN IF NOT EXISTS transport_request_id uuid;
ALTER TABLE public.route_forklifts ADD CONSTRAINT route_forklifts_transport_request_fk
  FOREIGN KEY (transport_request_id) REFERENCES public.transport_requests(id) ON DELETE RESTRICT;
CREATE INDEX route_forklifts_transport_request_idx ON public.route_forklifts(transport_request_id);

CREATE OR REPLACE FUNCTION public.route_forklift_stop_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.transport_request_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM public.dispatch_requests dr WHERE dr.dispatch_id=NEW.dispatch_id AND dr.transport_request_id=NEW.transport_request_id
 ) THEN RAISE EXCEPTION 'La parada del montacarga no pertenece a esta ruta'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.route_forklift_stop_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER route_forklift_stop_guard BEFORE INSERT OR UPDATE OF dispatch_id,transport_request_id
 ON public.route_forklifts FOR EACH ROW EXECUTE FUNCTION public.route_forklift_stop_guard();

CREATE OR REPLACE FUNCTION public.route_forklift_stop_unlink_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_status text; f public.route_forklifts%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' AND NEW.dispatch_id=OLD.dispatch_id AND NEW.transport_request_id=OLD.transport_request_id THEN RETURN NEW; END IF;
 SELECT d.status INTO v_status FROM public.dispatches d WHERE d.id=OLD.dispatch_id;
 -- Borrado de ruta y cancelación completa: conservar el alcance histórico del servicio.
 IF NOT FOUND OR v_status='CANCELADO' THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 SELECT * INTO f FROM public.route_forklifts WHERE dispatch_id=OLD.dispatch_id AND transport_request_id=OLD.transport_request_id FOR UPDATE;
 IF FOUND THEN
  IF v_status='PROGRAMADO' AND f.service_started_at IS NULL AND f.service_ended_at IS NULL
    AND f.settled_at IS NULL AND f.final_hours IS NULL AND f.final_amount IS NULL THEN
   -- Cancelar/reprogramar la parada antes de salir retira solo el apoyo no ejecutado.
   -- No mover el servicio ni su importe a otra solicitud; no tocar gastos, pagos ni partidas.
   DELETE FROM public.route_forklifts WHERE dispatch_id=OLD.dispatch_id;
   INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by)
   VALUES(OLD.dispatch_id,'MONTACARGA_RETIRADO','Se retiró el apoyo de montacarga no ejecutado al quitar su parada de la ruta.',COALESCE(auth.uid()::text,'system'));
  ELSE RAISE EXCEPTION 'La parada tiene un montacarga ejecutado o liquidado y no se puede retirar de la ruta'; END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION public.route_forklift_stop_unlink_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER route_forklift_stop_unlink_guard BEFORE DELETE OR UPDATE OF dispatch_id,transport_request_id
 ON public.dispatch_requests FOR EACH ROW EXECUTE FUNCTION public.route_forklift_stop_unlink_guard();

CREATE OR REPLACE FUNCTION public.schedule_route_resources(p jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid; v_result jsonb; f jsonb:=p->'forklift'; hp public.hhee_people; v_person uuid; v_supplier_person uuid; v_name text; v_doc text; v_rate numeric;
 v_license text; v_expiration date; v_phone text; v_registered_plate text; v_stop uuid; v_stops uuid[];
BEGIN
 IF NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Sin permiso para programar rutas'; END IF;
 IF p->>'mode'='TERCERO' THEN
  v_id:=public.schedule_dispatch_tercero((p->>'p_carrier_id')::uuid,p->>'p_plate',p->>'p_conductor',p->>'p_telefono',p->>'p_doc',
   (p->>'p_departure')::timestamptz,(p->>'p_estimated_km')::numeric,(p->>'p_freight_cost')::numeric,(p->>'p_contract_id')::uuid,p->'p_requests');
 ELSE
  v_id:=public.schedule_dispatch((p->>'p_driver_id')::uuid,p->>'p_vehicle_plate',(p->>'p_departure')::timestamptz,
   (p->>'p_estimated_km')::numeric,(p->>'p_freight_cost')::numeric,(p->>'p_contract_id')::uuid,p->>'p_document_type',p->'p_requests');
 END IF;
 IF p->>'mode'='TERCERO' THEN
  UPDATE public.dispatches SET tercero_license_number=NULLIF(btrim(p->>'p_tercero_license_number'),''),
   tercero_license_expiration=NULLIF(p->>'p_tercero_license_expiration','')::date WHERE id=v_id;
  IF NULLIF(p->>'p_supplier_personnel_id','') IS NOT NULL THEN
   EXECUTE 'SELECT x.full_name,x.document_number,x.license_number,x.license_expiration,x.phone FROM public.supplier_personnel x JOIN public.carriers c ON c.supplier_id=x.supplier_id WHERE x.id=$1 AND c.id=(SELECT carrier_id FROM public.dispatches WHERE id=$2) AND x.is_active'
    INTO v_name,v_doc,v_license,v_expiration,v_phone USING (p->>'p_supplier_personnel_id')::uuid,v_id;
   IF v_name IS NULL THEN RAISE EXCEPTION 'El conductor no pertenece al transportista seleccionado o está inactivo'; END IF;
   UPDATE public.dispatches SET tercero_conductor=v_name,tercero_doc=v_doc,tercero_telefono=v_phone,tercero_license_number=v_license,tercero_license_expiration=v_expiration WHERE id=v_id;
  END IF;
  IF NULLIF(p->>'p_supplier_vehicle_id','') IS NOT NULL THEN
   EXECUTE 'SELECT x.plate FROM public.supplier_vehicles x JOIN public.carriers c ON c.supplier_id=x.supplier_id WHERE x.id=$1 AND c.id=(SELECT carrier_id FROM public.dispatches WHERE id=$2) AND x.is_active'
    INTO v_registered_plate USING (p->>'p_supplier_vehicle_id')::uuid,v_id;
   IF v_registered_plate IS NULL OR upper(regexp_replace(v_registered_plate,'[^A-Za-z0-9]','','g'))<>upper(regexp_replace((SELECT vehicle_plate FROM public.dispatches WHERE id=v_id),'[^A-Za-z0-9]','','g')) THEN
    RAISE EXCEPTION 'La placa seleccionada no corresponde a una unidad activa del transportista';
   END IF;
  END IF;
 END IF;
 IF jsonb_array_length(COALESCE(p->'auxiliaries','[]'::jsonb))>0 THEN
  v_result:=public.set_route_auxiliaries(v_id,ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(p->'auxiliaries')));
  IF NOT COALESCE((v_result->>'success')::boolean,false) THEN RAISE EXCEPTION '%',v_result->>'error'; END IF;
 END IF;
 IF f IS NOT NULL AND f<>'null'::jsonb THEN
  v_stop:=NULLIF(f->>'transport_request_id','')::uuid;
  SELECT array_agg(dr.transport_request_id) INTO v_stops FROM public.dispatch_requests dr WHERE dr.dispatch_id=v_id;
  IF v_stop IS NULL AND cardinality(v_stops)=1 THEN v_stop:=v_stops[1]; END IF;
  IF v_stop IS NULL OR NOT COALESCE(v_stop=ANY(v_stops),false) THEN
   RAISE EXCEPTION 'Seleccione la parada de esta ruta donde se usará el montacarga';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.suppliers WHERE id=(f->>'supplier_id')::uuid AND is_active) THEN RAISE EXCEPTION 'Seleccione un proveedor activo de montacarga'; END IF;
  v_rate:=NULLIF(f->>'hourly_rate','')::numeric;
  IF v_rate IS NULL OR v_rate<=0 OR v_rate>100000 THEN RAISE EXCEPTION 'Ingrese una tarifa por hora válida'; END IF;
  v_person:=NULLIF(f->>'person_id','')::uuid;
  IF v_person IS NOT NULL THEN
   SELECT * INTO hp FROM public.hhee_people WHERE id=v_person AND active;
   IF NOT FOUND THEN RAISE EXCEPTION 'Montacarguista inactivo o inexistente'; END IF;
   v_name:=hp.name; v_doc:=hp.document_number;
  ELSE v_name:=btrim(f->>'operator_name'); v_doc:=NULLIF(btrim(f->>'document_number'),''); END IF;
  IF COALESCE(length(v_name),0)<3 OR length(v_name)>200 THEN RAISE EXCEPTION 'Indique el nombre del montacarguista'; END IF;
  IF length(COALESCE(f->>'notes',''))>1000 OR length(COALESCE(f->>'license_number',''))>100 OR length(COALESCE(v_doc,''))>50 OR length(COALESCE(f->>'phone',''))>50 THEN RAISE EXCEPTION 'Datos de montacarga demasiado extensos'; END IF;
  INSERT INTO public.route_forklifts(dispatch_id,supplier_id,person_id,operator_name,document_number,license_number,license_expiration,phone,notes,assigned_by,hourly_rate,transport_request_id)
   VALUES(v_id,(f->>'supplier_id')::uuid,v_person,v_name,v_doc,NULLIF(btrim(f->>'license_number'),''),NULLIF(f->>'license_expiration','')::date,NULLIF(btrim(f->>'phone'),''),NULLIF(btrim(f->>'notes'),''),auth.uid(),v_rate,v_stop);
  v_supplier_person:=NULLIF(f->>'supplier_personnel_id','')::uuid;
  IF v_supplier_person IS NOT NULL THEN
   EXECUTE 'SELECT full_name,document_number,license_number,license_expiration,phone FROM public.supplier_personnel WHERE id=$1 AND supplier_id=$2 AND is_active'
    INTO v_name,v_doc,v_license,v_expiration,v_phone USING v_supplier_person,(f->>'supplier_id')::uuid;
   IF v_name IS NULL THEN RAISE EXCEPTION 'El montacarguista no pertenece al proveedor seleccionado o está inactivo'; END IF;
   EXECUTE 'UPDATE public.route_forklifts SET supplier_personnel_id=$1,operator_name=$2,document_number=$3,license_number=$4,license_expiration=$5,phone=$6 WHERE dispatch_id=$7'
    USING v_supplier_person,v_name,v_doc,v_license,v_expiration,v_phone,v_id;
  END IF;
 END IF;
 RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.get_route_share_details(p_dispatches uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid; d public.dispatches; dr jsonb; f jsonb; aux jsonb; services jsonb; result jsonb:='[]';
BEGIN
 IF auth.uid() IS NULL OR NOT (public.has_tms_read_permission('torre-control') OR public.has_tms_read_permission('despacho')) THEN RAISE EXCEPTION 'Sin permiso para compartir rutas'; END IF;
 IF COALESCE(cardinality(p_dispatches),0) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Seleccione entre 1 y 200 rutas'; END IF;
 FOR v_id IN SELECT DISTINCT unnest(p_dispatches) LOOP
  IF NOT public.delivery_can_read(v_id) THEN RAISE EXCEPTION 'Sin acceso a una de las rutas seleccionadas'; END IF;
  SELECT * INTO d FROM public.dispatches WHERE id=v_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ruta inexistente'; END IF;
  SELECT to_jsonb(x) INTO dr FROM public.drivers x WHERE x.id=d.driver_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('name',hp.name,'code',hp.code,'document_number',hp.document_number,'position',hp.position) ORDER BY hp.code),'[]') INTO aux
   FROM public.route_auxiliaries a JOIN public.hhee_people hp ON hp.id=a.person_id WHERE a.dispatch_id=v_id;
  SELECT jsonb_build_object('supplier',s.business_name,'tax_id',s.tax_id,'operator_name',x.operator_name,'document_number',x.document_number,
   'license_number',x.license_number,'license_expiration',x.license_expiration,'phone',x.phone,'notes',x.notes,
   'transport_request_id',x.transport_request_id,'request_number',t.request_number,'destination_address',t.delivery_address,
   'contract_id',t.contract_id,'ot_code',c.code) INTO f
   FROM public.route_forklifts x JOIN public.suppliers s ON s.id=x.supplier_id
   LEFT JOIN public.transport_requests t ON t.id=x.transport_request_id LEFT JOIN public.contracts c ON c.id=t.contract_id WHERE x.dispatch_id=v_id;
  SELECT COALESCE(jsonb_agg(item||jsonb_build_object('cargo_description',to_jsonb(t)->>'cargo_description','pickup_contact',to_jsonb(t)->>'pickup_contact',
   'pickup_phone',to_jsonb(t)->>'pickup_phone','delivery_contact',to_jsonb(t)->>'delivery_contact','delivery_phone',to_jsonb(t)->>'delivery_phone',
   'requester_name',to_jsonb(t)->>'requester_name') ORDER BY ord),'[]'::jsonb) INTO services
   FROM jsonb_array_elements(public.delivery_tracking_rows(ARRAY[v_id])) WITH ORDINALITY AS x(item,ord)
   LEFT JOIN public.transport_requests t ON t.id=(item->>'request_id')::uuid;
  result:=result||jsonb_build_array(jsonb_build_object('id',d.id,'number',d.dispatch_number,'plate',d.vehicle_plate,'status',d.status,'departure',d.scheduled_departure,
   'driver',COALESCE(NULLIF(to_jsonb(d)->>'tercero_conductor',''),d.driver_name),'driver_document',COALESCE(NULLIF(to_jsonb(d)->>'tercero_doc',''),dr->>'document_number'),
   'driver_license',COALESCE(dr->>'license_number',to_jsonb(d)->>'tercero_license_number'),'license_category',dr->>'license_category',
   'license_expiration',COALESCE(dr->>'license_expiration',to_jsonb(d)->>'tercero_license_expiration'),
   'driver_phone',COALESCE(NULLIF(to_jsonb(d)->>'tercero_telefono',''),dr->>'phone'),'auxiliaries',aux,'forklift',f,'services',services));
 END LOOP;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.route_forklift_settlement_document(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f record; d record; v_stop jsonb;
BEGIN
 IF NOT (public.has_tms_read_permission('caja-liquidaciones') OR public.has_tms_read_permission('despacho')) THEN
  RETURN jsonb_build_object('success',false,'error','Sin permiso para consultar el reporte');
 END IF;
 SELECT x.*,s.business_name,s.tax_id,s.contact_email,s.contact_name,s.contact_phone
 INTO f FROM public.route_forklifts x JOIN public.suppliers s ON s.id=x.supplier_id WHERE x.dispatch_id=p_dispatch_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','La ruta no tiene servicio de montacarga'); END IF;
 IF NOT public.delivery_can_read(p_dispatch_id) THEN RETURN jsonb_build_object('success',false,'error','Ruta no disponible'); END IF;
 SELECT dispatch_number,vehicle_plate,scheduled_departure,status INTO d FROM public.dispatches WHERE id=p_dispatch_id;
 SELECT jsonb_build_object('id',t.id,'number',t.request_number,'destination',t.delivery_address,'contract_id',t.contract_id,'ot_code',c.code)
 INTO v_stop FROM public.transport_requests t LEFT JOIN public.contracts c ON c.id=t.contract_id WHERE t.id=f.transport_request_id;
 RETURN jsonb_build_object('success',true,'dispatch',to_jsonb(d),'transport_request_id',f.transport_request_id,'stop',v_stop,'supplier',jsonb_build_object('name',f.business_name,'ruc',f.tax_id,
   'email',f.contact_email,'contact',f.contact_name,'phone',f.contact_phone),
   'service',jsonb_build_object('operator',f.operator_name,'document_number',f.document_number,'license',f.license_number,
   'rate',f.hourly_rate,'hours',f.final_hours,'amount',f.final_amount,'settled_at',f.settled_at,'notes',f.notes));
END $$;

REVOKE ALL ON FUNCTION public.schedule_route_resources(jsonb),public.get_route_share_details(uuid[]),public.route_forklift_settlement_document(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.schedule_route_resources(jsonb),public.get_route_share_details(uuid[]),public.route_forklift_settlement_document(uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
