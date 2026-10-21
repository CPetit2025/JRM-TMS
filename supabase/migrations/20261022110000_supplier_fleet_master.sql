BEGIN;
SET LOCAL lock_timeout='60s';

ALTER TABLE public.suppliers DROP CONSTRAINT IF EXISTS suppliers_category_check;
ALTER TABLE public.suppliers ADD CONSTRAINT suppliers_category_check
 CHECK (category IN ('MATERIA_PRIMA','INSUMOS','PRODUCCION','PROYECTOS','SERVICIOS','OTROS','TRANSPORTE','MONTACARGA'));

CREATE TABLE public.supplier_personnel (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE RESTRICT,
 full_name text NOT NULL, document_number text, position text, phone text, email text,
 license_number text, license_expiration date, notes text, is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT supplier_personnel_name_present CHECK (length(btrim(full_name)) BETWEEN 3 AND 200),
 CONSTRAINT supplier_personnel_document_length CHECK (document_number IS NULL OR length(document_number)<=30),
 CONSTRAINT supplier_personnel_license_length CHECK (license_number IS NULL OR length(license_number)<=100)
);
CREATE INDEX supplier_personnel_supplier_idx ON public.supplier_personnel(supplier_id,is_active);
CREATE UNIQUE INDEX supplier_personnel_document_unique ON public.supplier_personnel(supplier_id,document_number)
 WHERE document_number IS NOT NULL AND btrim(document_number)<>'';

CREATE TABLE public.supplier_vehicles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE RESTRICT,
 personnel_id uuid REFERENCES public.supplier_personnel(id) ON DELETE SET NULL,
 plate text NOT NULL, unit_type text NOT NULL DEFAULT 'CAMION', brand text, model text, year integer,
 capacity_tons numeric(10,2), soat_expiration date, technical_review_expiration date,
 is_active boolean NOT NULL DEFAULT true, notes text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT supplier_vehicles_plate_format CHECK (length(regexp_replace(upper(plate),'[^A-Z0-9]','','g')) BETWEEN 5 AND 10),
 CONSTRAINT supplier_vehicles_year_check CHECK (year IS NULL OR year BETWEEN 1950 AND 2100),
 CONSTRAINT supplier_vehicles_capacity_check CHECK (capacity_tons IS NULL OR capacity_tons>0)
);
CREATE UNIQUE INDEX supplier_vehicles_plate_unique ON public.supplier_vehicles(upper(regexp_replace(plate,'[^A-Za-z0-9]','','g')));
CREATE INDEX supplier_vehicles_supplier_idx ON public.supplier_vehicles(supplier_id,is_active);
CREATE FUNCTION public.enforce_supplier_vehicle_personnel() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.personnel_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.supplier_personnel p WHERE p.id=NEW.personnel_id AND p.supplier_id=NEW.supplier_id) THEN
  RAISE EXCEPTION 'El conductor base debe pertenecer a la misma empresa que la unidad';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.enforce_supplier_vehicle_personnel() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER supplier_vehicle_personnel_same_company BEFORE INSERT OR UPDATE OF supplier_id,personnel_id
 ON public.supplier_vehicles FOR EACH ROW EXECUTE FUNCTION public.enforce_supplier_vehicle_personnel();
DO $$ BEGIN
 ALTER TABLE public.route_forklifts ADD CONSTRAINT route_forklifts_supplier_personnel_fk
  FOREIGN KEY (supplier_personnel_id) REFERENCES public.supplier_personnel(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.supplier_personnel ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_vehicles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_personnel FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.supplier_vehicles FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.supplier_personnel TO authenticated;
GRANT SELECT,INSERT,UPDATE ON public.supplier_vehicles TO authenticated;
CREATE POLICY supplier_personnel_read ON public.supplier_personnel FOR SELECT TO authenticated USING (public.can_read_suppliers());
CREATE POLICY supplier_personnel_write ON public.supplier_personnel FOR ALL TO authenticated USING (public.can_manage_suppliers()) WITH CHECK (public.can_manage_suppliers());
CREATE POLICY supplier_vehicles_read ON public.supplier_vehicles FOR SELECT TO authenticated USING (public.can_read_suppliers());
CREATE POLICY supplier_vehicles_write ON public.supplier_vehicles FOR ALL TO authenticated USING (public.can_manage_suppliers()) WITH CHECK (public.can_manage_suppliers());
CREATE POLICY security_active_account ON public.supplier_personnel AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
CREATE POLICY security_active_account ON public.supplier_vehicles AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));

-- Transportistas conserva su identificador histórico de carriers, enlazado a la empresa maestra por RUC.
ALTER TABLE public.carriers ADD COLUMN IF NOT EXISTS supplier_id uuid REFERENCES public.suppliers(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS carriers_supplier_id_unique ON public.carriers(supplier_id) WHERE supplier_id IS NOT NULL;
UPDATE public.carriers c SET supplier_id=s.id
 FROM public.suppliers s WHERE s.category='TRANSPORTE'
 AND COALESCE(NULLIF(to_jsonb(c)->>'tax_id',''),NULLIF(to_jsonb(c)->>'ruc',''))=s.tax_id AND c.supplier_id IS NULL;

CREATE FUNCTION public.sync_supplier_transport_carrier() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_carrier uuid; v_row jsonb; v_cols text;
BEGIN
 IF NEW.category<>'TRANSPORTE' THEN RETURN NEW; END IF;
 SELECT id INTO v_carrier FROM public.carriers c
  WHERE COALESCE(NULLIF(to_jsonb(c)->>'tax_id',''),NULLIF(to_jsonb(c)->>'ruc',''))=NEW.tax_id
    AND COALESCE(to_jsonb(c)->>'type','TERCERO')<>'PROPIO' LIMIT 1;
 IF v_carrier IS NOT NULL THEN
  UPDATE public.carriers SET supplier_id=NEW.id,business_name=NEW.business_name
   WHERE id=v_carrier;
  RETURN NEW;
 END IF;
 v_row:=jsonb_build_object('supplier_id',NEW.id,'type','TERCERO','business_name',NEW.business_name,'tax_id',NEW.tax_id,'ruc',NEW.tax_id,
  'contact_name',NEW.contact_name,'contact_phone',NEW.contact_phone,'phone',NEW.contact_phone,'contact_email',NEW.contact_email,'email',NEW.contact_email,
  'address',NULL,'status','ACTIVE','is_active',NEW.is_active);
 SELECT string_agg(quote_ident(k),', ') INTO v_cols FROM jsonb_object_keys(v_row) k
  WHERE EXISTS(SELECT 1 FROM information_schema.columns i WHERE i.table_schema='public' AND i.table_name='carriers' AND i.column_name=k);
 EXECUTE format('INSERT INTO public.carriers(%1$s) SELECT %1$s FROM jsonb_populate_record(NULL::public.carriers,$1)',v_cols) USING v_row;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.sync_supplier_transport_carrier() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER suppliers_transport_carrier_sync AFTER INSERT OR UPDATE OF category,tax_id,business_name,contact_name,contact_phone,contact_email,is_active
 ON public.suppliers FOR EACH ROW EXECUTE FUNCTION public.sync_supplier_transport_carrier();

ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS tercero_license_number text;
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS tercero_license_expiration date;
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
   'license_number',x.license_number,'license_expiration',x.license_expiration,'phone',x.phone,'notes',x.notes) INTO f
   FROM public.route_forklifts x JOIN public.suppliers s ON s.id=x.supplier_id WHERE x.dispatch_id=v_id;
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
REVOKE ALL ON FUNCTION public.get_route_share_details(uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_route_share_details(uuid[]) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
