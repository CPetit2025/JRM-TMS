BEGIN;
SET LOCAL lock_timeout = '60s';

ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS tercero_license_number text;
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS tercero_license_expiration date;
ALTER TABLE public.route_forklifts ADD COLUMN IF NOT EXISTS supplier_personnel_id uuid;

-- Tarifa comercial congelada en el despacho; las horas y el importe se completan al liquidar.
ALTER TABLE public.route_forklifts
  ADD COLUMN IF NOT EXISTS hourly_rate numeric(12,2),
  ADD COLUMN IF NOT EXISTS final_hours numeric(8,2),
  ADD COLUMN IF NOT EXISTS final_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS settled_at timestamptz;
DO $$ BEGIN
  ALTER TABLE public.route_forklifts ADD CONSTRAINT route_forklifts_rate_positive
    CHECK (hourly_rate IS NULL OR hourly_rate > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.route_forklifts ADD CONSTRAINT route_forklifts_hours_nonnegative
    CHECK (final_hours IS NULL OR final_hours >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Reemplaza el RPC sin modificar las reglas previas de programación. El precio es obligatorio solo
-- para servicios nuevos de montacarga; los registros históricos mantienen hourly_rate NULL.
CREATE OR REPLACE FUNCTION public.schedule_route_resources(p jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid; v_result jsonb; f jsonb:=p->'forklift'; hp public.hhee_people; v_person uuid; v_supplier_person uuid; v_name text; v_doc text; v_rate numeric;
 v_license text; v_expiration date; v_phone text; v_registered_plate text;
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
  INSERT INTO public.route_forklifts(dispatch_id,supplier_id,person_id,operator_name,document_number,license_number,license_expiration,phone,notes,assigned_by,hourly_rate)
   VALUES(v_id,(f->>'supplier_id')::uuid,v_person,v_name,v_doc,NULLIF(btrim(f->>'license_number'),''),NULLIF(f->>'license_expiration','')::date,NULLIF(btrim(f->>'phone'),''),NULLIF(btrim(f->>'notes'),''),auth.uid(),v_rate);
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
REVOKE ALL ON FUNCTION public.schedule_route_resources(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.schedule_route_resources(jsonb) TO authenticated;

-- Cierre de Caja y liquidación del apoyo de montacarga en una única transacción.
CREATE FUNCTION public.close_route_with_forklift(p_dispatch_id uuid,p_resolution text,p_box_id uuid DEFAULT NULL,
 p_payment_method text DEFAULT NULL,p_reference text DEFAULT NULL,p_notes text DEFAULT NULL,p_forklift_hours numeric DEFAULT NULL,
 p_forklift_hourly_rate numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_result jsonb; f public.route_forklifts%ROWTYPE; v_has_forklift boolean; v_rate numeric;
BEGIN
 IF NOT public.has_tms_permission('caja-liquidaciones') THEN RETURN jsonb_build_object('success',false,'error','Sin permiso para liquidar viajes'); END IF;
 SELECT * INTO f FROM public.route_forklifts WHERE dispatch_id=p_dispatch_id FOR UPDATE;
 v_has_forklift:=FOUND;
 IF v_has_forklift AND (p_forklift_hours IS NULL OR p_forklift_hours<0 OR p_forklift_hours>168) THEN
  RETURN jsonb_build_object('success',false,'error','Ingrese las horas finales del servicio de montacarga (de 0 a 168)');
 END IF;
 IF NOT v_has_forklift AND p_forklift_hours IS NOT NULL THEN
  RETURN jsonb_build_object('success',false,'error','Esta ruta no tiene un servicio de montacarga registrado');
 END IF;
 IF v_has_forklift THEN
  v_rate:=COALESCE(f.hourly_rate,p_forklift_hourly_rate);
  IF v_rate IS NULL OR v_rate<=0 OR v_rate>100000 THEN
   RETURN jsonb_build_object('success',false,'error','Ingrese una tarifa por hora válida para este servicio');
  END IF;
 END IF;
 v_result:=public.close_trip_settlement(p_dispatch_id,p_resolution,p_box_id,p_payment_method,p_reference,p_notes);
 IF NOT COALESCE((v_result->>'success')::boolean,false) THEN RETURN v_result; END IF;
 IF v_has_forklift THEN
  UPDATE public.route_forklifts SET hourly_rate=v_rate,final_hours=round(p_forklift_hours,2),
    final_amount=round(p_forklift_hours*v_rate,2),settled_at=now()
   WHERE dispatch_id=p_dispatch_id;
 END IF;
 RETURN v_result || jsonb_build_object('forklift_hours',CASE WHEN v_has_forklift THEN round(p_forklift_hours,2) END,
   'forklift_hourly_rate',CASE WHEN v_has_forklift THEN v_rate END,
   'forklift_amount',CASE WHEN v_has_forklift THEN round(p_forklift_hours*v_rate,2) END);
END $$;
REVOKE ALL ON FUNCTION public.close_route_with_forklift(uuid,text,uuid,text,text,text,numeric,numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.close_route_with_forklift(uuid,text,uuid,text,text,text,numeric,numeric) TO authenticated;

CREATE FUNCTION public.route_forklift_settlement_document(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f record; d record;
BEGIN
 IF NOT (public.has_tms_read_permission('caja-liquidaciones') OR public.has_tms_read_permission('despacho')) THEN
  RETURN jsonb_build_object('success',false,'error','Sin permiso para consultar el reporte');
 END IF;
 SELECT x.*,s.business_name,s.tax_id,s.contact_email,s.contact_name,s.contact_phone
 INTO f FROM public.route_forklifts x JOIN public.suppliers s ON s.id=x.supplier_id WHERE x.dispatch_id=p_dispatch_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','La ruta no tiene servicio de montacarga'); END IF;
 IF NOT public.delivery_can_read(p_dispatch_id) THEN RETURN jsonb_build_object('success',false,'error','Ruta no disponible'); END IF;
 SELECT dispatch_number,vehicle_plate,scheduled_departure,status INTO d FROM public.dispatches WHERE id=p_dispatch_id;
 RETURN jsonb_build_object('success',true,'dispatch',to_jsonb(d),'supplier',jsonb_build_object('name',f.business_name,'ruc',f.tax_id,
   'email',f.contact_email,'contact',f.contact_name,'phone',f.contact_phone),
   'service',jsonb_build_object('operator',f.operator_name,'document_number',f.document_number,'license',f.license_number,
   'rate',f.hourly_rate,'hours',f.final_hours,'amount',f.final_amount,'settled_at',f.settled_at,'notes',f.notes));
END $$;
REVOKE ALL ON FUNCTION public.route_forklift_settlement_document(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.route_forklift_settlement_document(uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
