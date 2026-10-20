BEGIN;
SET LOCAL lock_timeout = '60s';

-- Datos operativos del apoyo de montacarga; no modifica partidas ni costos de descarga.
CREATE TABLE public.route_forklifts (
 dispatch_id uuid PRIMARY KEY REFERENCES public.dispatches(id) ON DELETE CASCADE,
 supplier_id uuid NOT NULL REFERENCES public.suppliers(id),
 person_id uuid REFERENCES public.hhee_people(id),
 operator_name text NOT NULL CHECK (length(btrim(operator_name)) BETWEEN 3 AND 200),
 document_number text, license_number text, license_expiration date, phone text, notes text,
 assigned_by uuid REFERENCES public.profiles(id), assigned_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX route_forklifts_supplier_idx ON public.route_forklifts(supplier_id);
CREATE INDEX route_forklifts_person_idx ON public.route_forklifts(person_id);
CREATE INDEX route_forklifts_author_idx ON public.route_forklifts(assigned_by);
ALTER TABLE public.route_forklifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_active_account ON public.route_forklifts AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.route_forklifts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.route_forklifts TO authenticated;
CREATE POLICY route_forklifts_read ON public.route_forklifts FOR SELECT TO authenticated
 USING (public.is_active_tms_user() AND public.delivery_can_read(dispatch_id));

CREATE FUNCTION public.route_forklift_candidates() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT public.has_tms_read_permission('despacho') THEN RAISE EXCEPTION 'Sin permiso de despacho'; END IF;
 RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id',hp.id,'code',hp.code,'name',hp.name,
   'document_number',hp.document_number,'position',hp.position,
   'license_number',COALESCE(to_jsonb(dr)->>'license_number',to_jsonb(p)->>'license_number'),
   'license_expiration',COALESCE(to_jsonb(dr)->>'license_expiration',to_jsonb(p)->>'license_expiration'),
   'phone',COALESCE(to_jsonb(dr)->>'phone',to_jsonb(p)->>'phone')) ORDER BY hp.code)
  FROM public.hhee_people hp LEFT JOIN public.profiles p ON p.id=hp.profile_id
  LEFT JOIN public.drivers dr ON dr.id=hp.driver_id WHERE hp.active), '[]'::jsonb);
END $$;

-- Un único RPC conserva la transacción: una asignación inválida revierte también la programación.
CREATE FUNCTION public.schedule_route_resources(p jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid; v_result jsonb; f jsonb:=p->'forklift'; hp public.hhee_people; v_person uuid; v_name text; v_doc text;
BEGIN
 IF NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Sin permiso para programar rutas'; END IF;
 IF p->>'mode'='TERCERO' THEN
  v_id:=public.schedule_dispatch_tercero((p->>'p_carrier_id')::uuid,p->>'p_plate',p->>'p_conductor',p->>'p_telefono',p->>'p_doc',
   (p->>'p_departure')::timestamptz,(p->>'p_estimated_km')::numeric,(p->>'p_freight_cost')::numeric,(p->>'p_contract_id')::uuid,p->'p_requests');
 ELSE
  v_id:=public.schedule_dispatch((p->>'p_driver_id')::uuid,p->>'p_vehicle_plate',(p->>'p_departure')::timestamptz,
   (p->>'p_estimated_km')::numeric,(p->>'p_freight_cost')::numeric,(p->>'p_contract_id')::uuid,p->>'p_document_type',p->'p_requests');
 END IF;
 IF jsonb_array_length(COALESCE(p->'auxiliaries','[]'::jsonb))>0 THEN
  v_result:=public.set_route_auxiliaries(v_id,ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(p->'auxiliaries')));
  IF NOT COALESCE((v_result->>'success')::boolean,false) THEN RAISE EXCEPTION '%',v_result->>'error'; END IF;
 END IF;
 IF f IS NOT NULL AND f<>'null'::jsonb THEN
  IF NOT EXISTS(SELECT 1 FROM public.suppliers WHERE id=(f->>'supplier_id')::uuid AND is_active) THEN RAISE EXCEPTION 'Seleccione un proveedor activo de montacarga'; END IF;
  v_person:=NULLIF(f->>'person_id','')::uuid;
  IF v_person IS NOT NULL THEN
   SELECT * INTO hp FROM public.hhee_people WHERE id=v_person AND active;
   IF NOT FOUND THEN RAISE EXCEPTION 'Montacarguista inactivo o inexistente'; END IF;
   v_name:=hp.name; v_doc:=hp.document_number;
  ELSE v_name:=btrim(f->>'operator_name'); v_doc:=NULLIF(btrim(f->>'document_number'),''); END IF;
  IF COALESCE(length(v_name),0)<3 OR length(v_name)>200 THEN RAISE EXCEPTION 'Indique el nombre del montacarguista'; END IF;
  IF length(COALESCE(f->>'notes',''))>1000 OR length(COALESCE(f->>'license_number',''))>100 OR length(COALESCE(v_doc,''))>50 OR length(COALESCE(f->>'phone',''))>50 THEN RAISE EXCEPTION 'Datos de montacarga demasiado extensos'; END IF;
  INSERT INTO public.route_forklifts(dispatch_id,supplier_id,person_id,operator_name,document_number,license_number,license_expiration,phone,notes,assigned_by)
   VALUES(v_id,(f->>'supplier_id')::uuid,v_person,v_name,v_doc,NULLIF(btrim(f->>'license_number'),''),NULLIF(f->>'license_expiration','')::date,NULLIF(btrim(f->>'phone'),''),NULLIF(btrim(f->>'notes'),''),auth.uid());
 END IF;
 RETURN v_id;
END $$;

-- Solo información operativa explícita: nunca exportar PIN, credenciales, tarifas o remuneraciones.
CREATE FUNCTION public.get_route_share_details(p_dispatches uuid[]) RETURNS jsonb
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
   'license_number',x.license_number,'license_expiration',x.license_expiration,'phone',x.phone,'notes',x.notes) INTO f
   FROM public.route_forklifts x JOIN public.suppliers s ON s.id=x.supplier_id WHERE x.dispatch_id=v_id;
  SELECT COALESCE(jsonb_agg(item||jsonb_build_object('cargo_description',to_jsonb(t)->>'cargo_description',
   'pickup_contact',to_jsonb(t)->>'pickup_contact','pickup_phone',to_jsonb(t)->>'pickup_phone',
   'delivery_contact',to_jsonb(t)->>'delivery_contact','delivery_phone',to_jsonb(t)->>'delivery_phone',
   'requester_name',to_jsonb(t)->>'requester_name') ORDER BY ord),'[]'::jsonb) INTO services
   FROM jsonb_array_elements(public.delivery_tracking_rows(ARRAY[v_id])) WITH ORDINALITY AS x(item,ord)
   LEFT JOIN public.transport_requests t ON t.id=(item->>'request_id')::uuid;
  result:=result||jsonb_build_array(jsonb_build_object('id',d.id,'number',d.dispatch_number,'plate',d.vehicle_plate,'status',d.status,'departure',d.scheduled_departure,
   'driver',COALESCE(NULLIF(to_jsonb(d)->>'tercero_conductor',''),d.driver_name),'driver_document',COALESCE(NULLIF(to_jsonb(d)->>'tercero_doc',''),dr->>'document_number'),
   'driver_license',dr->>'license_number','license_category',dr->>'license_category','license_expiration',dr->>'license_expiration',
   'driver_phone',COALESCE(NULLIF(to_jsonb(d)->>'tercero_telefono',''),dr->>'phone'),'auxiliaries',aux,'forklift',f,
   'services',services));
 END LOOP;
 RETURN result;
END $$;

INSERT INTO public.notif_reglas(evento,categoria,descripcion,severidad,permisos,al_solicitante)
 VALUES('RUTA_ULTIMO_EVENTO','DESPACHO','Cambio del último evento de una ruta','info','{}',true)
 ON CONFLICT(evento) DO NOTHING;
CREATE FUNCTION public.notify_route_latest_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.dispatches; recipient record; v_latest timestamptz; v_event text; v_key text;
BEGIN
 IF TG_OP='UPDATE' AND NEW.event_type IS NOT DISTINCT FROM OLD.event_type AND NEW.description IS NOT DISTINCT FROM OLD.description AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN RETURN NEW; END IF;
 SELECT max(e.created_at) INTO v_latest FROM public.dispatch_events e WHERE e.dispatch_id=NEW.dispatch_id;
 IF NEW.created_at IS DISTINCT FROM v_latest THEN RETURN NEW; END IF;
 SELECT * INTO d FROM public.dispatches WHERE id=NEW.dispatch_id;
 v_event:=replace(NEW.event_type,'_',' ');
 v_key:='route-event-'||(to_jsonb(NEW)->>'id')||'-'||md5(COALESCE(NEW.description,'')||NEW.event_type||NEW.created_at::text);
 FOR recipient IN
  SELECT p.id FROM public.profiles p JOIN public.roles r ON r.id=p.role_id
  WHERE p.is_active AND (lower(btrim(r.name)) IN ('administrador','admin','administrador de sistema','administrador del sistema','administrador de contratos','jefe de distribución','jefe de distribucion') OR lower(btrim(r.name)) LIKE 'geren%' OR lower(btrim(r.name)) LIKE 'supervisor%')
   AND (lower(btrim(r.name)) IN ('administrador','admin','administrador de sistema','administrador del sistema') OR EXISTS(SELECT 1 FROM public.user_site_access a WHERE a.user_id=p.id AND a.site_id=d.site_id))
   AND (NOT (r.name='Administrador de Contratos' OR r.permissions ? 'cartera-propia') OR EXISTS(
    SELECT 1 FROM public.contract_user_assignments a WHERE a.user_id=p.id AND a.active AND
     (a.contract_id=public.contract_root_id(d.contract_id) OR a.contract_id IN(SELECT public.contract_root_id(t.contract_id) FROM public.dispatch_requests x JOIN public.transport_requests t ON t.id=x.transport_request_id WHERE x.dispatch_id=d.id))))
 LOOP
  PERFORM public.notif_emit('RUTA_ULTIMO_EVENTO',v_key||'-'||recipient.id,'Ruta '||d.dispatch_number||' · '||v_event,
   left(concat_ws(' · ',d.vehicle_plate,NEW.description),500),'/torre-control?despacho='||d.id,recipient.id);
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER route_latest_event_notification AFTER INSERT OR UPDATE ON public.dispatch_events FOR EACH ROW EXECUTE FUNCTION public.notify_route_latest_event();

REVOKE ALL ON FUNCTION public.route_forklift_candidates(),public.schedule_route_resources(jsonb),public.get_route_share_details(uuid[]),public.notify_route_latest_event() FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.notify_route_latest_event() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_forklift_candidates(),public.schedule_route_resources(jsonb),public.get_route_share_details(uuid[]) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
