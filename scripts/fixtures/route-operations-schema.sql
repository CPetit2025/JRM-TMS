CREATE TABLE public.drivers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),profile_id uuid,first_name text,last_name text,document_number text,phone text,license_number text,license_category text,license_expiration date);
CREATE TABLE public.dispatches(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),dispatch_number text DEFAULT 'R-TEST',driver_id uuid,driver_name text,vehicle_plate text,status text DEFAULT 'PROGRAMADO',scheduled_departure timestamptz,site_id uuid,contract_id uuid,tercero_doc text,tercero_conductor text,tercero_telefono text);
CREATE TABLE public.dispatch_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),dispatch_id uuid REFERENCES dispatches,created_at timestamptz DEFAULT now(),event_type text,description text,created_by text);
CREATE TABLE public.hhee_people(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text,name text,document_number text,position text,profile_id uuid,driver_id uuid,active boolean DEFAULT true);
CREATE TABLE public.route_auxiliaries(dispatch_id uuid,person_id uuid);
CREATE TABLE public.suppliers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_name text,tax_id text,is_active boolean DEFAULT true);
CREATE TABLE public.transport_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contract_id uuid);
CREATE TABLE public.dispatch_requests(dispatch_id uuid,transport_request_id uuid);
CREATE TABLE public.contract_user_assignments(contract_id uuid,user_id uuid,active boolean DEFAULT true);
CREATE TABLE public.notif_reglas(evento text PRIMARY KEY,categoria text,descripcion text,severidad text,permisos text[],al_solicitante boolean,activo boolean DEFAULT true);
CREATE TABLE public.notifications(id bigint GENERATED ALWAYS AS IDENTITY,evento text,categoria text,severidad text,titulo text,cuerpo text,link text,permisos text[],target_user uuid,dedupe_key text);
CREATE UNIQUE INDEX notifications_dedupe_idx ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE FUNCTION public.contract_root_id(id uuid) RETURNS uuid LANGUAGE sql AS $$SELECT id$$;
CREATE FUNCTION public.delivery_can_read(id uuid) RETURNS boolean LANGUAGE sql AS $$SELECT has_tms_read_permission('torre-control') AND EXISTS(SELECT 1 FROM dispatches d WHERE d.id=$1 AND can_access_site(d.site_id))$$;
CREATE FUNCTION public.delivery_tracking_rows(ids uuid[]) RETURNS jsonb LANGUAGE sql AS $$SELECT '[]'::jsonb$$;
CREATE FUNCTION public.set_route_auxiliaries(id uuid,people uuid[]) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
 IF EXISTS(SELECT 1 FROM unnest(people) x WHERE NOT EXISTS(SELECT 1 FROM hhee_people p WHERE p.id=x AND p.active)) THEN RETURN '{"success":false,"error":"Auxiliar inválido"}'; END IF;
 INSERT INTO route_auxiliaries SELECT id,unnest(people); RETURN '{"success":true}'; END$$;
CREATE FUNCTION public.schedule_dispatch(p_driver_id uuid,p_vehicle_plate text,p_departure timestamptz,p_estimated_km numeric,p_freight_cost numeric,p_contract_id uuid,p_document_type text,p_requests jsonb) RETURNS uuid LANGUAGE plpgsql AS $$DECLARE v uuid; BEGIN
 INSERT INTO dispatches(driver_id,vehicle_plate,scheduled_departure,site_id,contract_id,driver_name) VALUES(p_driver_id,p_vehicle_plate,p_departure,primary_site_id(),p_contract_id,'Conductor Prueba') RETURNING id INTO v; RETURN v; END$$;
CREATE FUNCTION public.schedule_dispatch_tercero(p_carrier_id uuid,p_plate text,p_conductor text,p_telefono text,p_doc text,p_departure timestamptz,p_estimated_km numeric,p_freight_cost numeric,p_contract_id uuid,p_requests jsonb) RETURNS uuid LANGUAGE plpgsql AS $$DECLARE v uuid; BEGIN
 v:=schedule_dispatch(NULL,p_plate,p_departure,p_estimated_km,p_freight_cost,p_contract_id,'GR',p_requests);
 UPDATE dispatches SET tercero_doc=p_doc,tercero_conductor=p_conductor,tercero_telefono=p_telefono WHERE id=v; RETURN v; END$$;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT SELECT ON profiles,roles TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;
