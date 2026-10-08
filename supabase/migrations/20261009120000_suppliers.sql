-- Proveedores de materia prima, insumos, producción y proyectos (distintos de transportistas y talleres).
-- 1. Maestro suppliers + puntos de recojo (supplier_locations). Lectura para el personal autenticado; alta y
--    edición para Comercial y Logística (clientes, solicitudes, despacho, proveedores) y administradores.
-- 2. La solicitud de transporte guarda el proveedor, su punto de recojo y el documento de referencia
--    (OC, RQ u OS + número). Recojos y traslados punto a punto exigen proveedor; el documento es opcional.
-- 3. save_transport_request_full: guarda con save_transport_request_attention (sin cambios) y aplica
--    proveedor y documento en la misma transacción.
-- 4. request_service_types también devuelve proveedor y documento (y la OC/OS antigua) para Torre y Documentos.
-- 5. Trigger diferido que exige proveedor aunque se guarde por otra vía; save_supplier guarda proveedor y puntos juntos.

CREATE TABLE IF NOT EXISTS public.suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_id text NOT NULL,
  business_name text NOT NULL,
  category text NOT NULL DEFAULT 'MATERIA_PRIMA'
    CHECK (category IN ('MATERIA_PRIMA','INSUMOS','PRODUCCION','PROYECTOS','SERVICIOS','OTROS')),
  contact_name text, contact_phone text, contact_email text, notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suppliers_tax_id_format CHECK (tax_id ~ '^[0-9]{11}$'),
  CONSTRAINT suppliers_name_present CHECK (btrim(business_name) <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_tax_id_key ON public.suppliers (tax_id);
CREATE INDEX IF NOT EXISTS suppliers_name_idx ON public.suppliers (lower(business_name));

CREATE TABLE IF NOT EXISTS public.supplier_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  name text NOT NULL,
  address text NOT NULL,
  department text, province text, district text,
  contact_name text, contact_phone text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_locations_present CHECK (btrim(name) <> '' AND btrim(address) <> '')
);
CREATE INDEX IF NOT EXISTS supplier_locations_supplier_idx ON public.supplier_locations (supplier_id);

ALTER TABLE public.transport_requests
  ADD COLUMN IF NOT EXISTS supplier_id uuid REFERENCES public.suppliers(id),
  ADD COLUMN IF NOT EXISTS supplier_location_id uuid REFERENCES public.supplier_locations(id),
  ADD COLUMN IF NOT EXISTS reference_type text,
  ADD COLUMN IF NOT EXISTS reference_number text;
DO $$ BEGIN
  ALTER TABLE public.transport_requests ADD CONSTRAINT transport_requests_reference_type_check
    CHECK (reference_type IS NULL OR reference_type IN ('OC','RQ','OS'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS transport_requests_supplier_idx ON public.transport_requests (supplier_id);
CREATE INDEX IF NOT EXISTS transport_requests_supplier_location_idx ON public.transport_requests (supplier_location_id);
COMMENT ON COLUMN public.transport_requests.supplier_id IS 'Proveedor de origen (recojo y punto a punto)';
COMMENT ON COLUMN public.transport_requests.reference_type IS 'Documento de referencia: OC, RQ u OS (opcional)';

-- Permiso de alta/edición: Comercial y Logística
CREATE OR REPLACE FUNCTION public.can_manage_suppliers() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT auth.uid() IS NOT NULL AND (public.is_tms_admin() OR public.has_tms_permission('proveedores')
    OR public.has_tms_permission('clientes') OR public.has_tms_permission('solicitudes') OR public.has_tms_permission('despacho'))
$$;
REVOKE ALL ON FUNCTION public.can_manage_suppliers() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_suppliers() TO authenticated, service_role;

-- Lectura: usuarios con módulos que usan proveedores (Comercial, Logística, Torre y Documentos)
CREATE OR REPLACE FUNCTION public.can_read_suppliers() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT auth.uid() IS NOT NULL AND (public.is_tms_admin() OR public.has_tms_read_permission('proveedores')
    OR public.has_tms_read_permission('clientes') OR public.has_tms_read_permission('solicitudes')
    OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('torre-control')
    OR public.has_tms_read_permission('documentario') OR public.has_tms_read_permission('packing-list')
    OR public.has_tms_read_permission('planificacion'))
$$;
REVOKE ALL ON FUNCTION public.can_read_suppliers() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_read_suppliers() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.suppliers_touch() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN NEW.updated_at := now(); NEW.tax_id := btrim(NEW.tax_id); NEW.business_name := btrim(NEW.business_name); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS suppliers_touch ON public.suppliers;
CREATE TRIGGER suppliers_touch BEFORE INSERT OR UPDATE ON public.suppliers FOR EACH ROW EXECUTE FUNCTION public.suppliers_touch();

ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_locations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.suppliers, public.supplier_locations FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.suppliers, public.supplier_locations TO authenticated;
DROP POLICY IF EXISTS suppliers_read ON public.suppliers;
CREATE POLICY suppliers_read ON public.suppliers FOR SELECT TO authenticated USING ((SELECT public.can_read_suppliers()));
DROP POLICY IF EXISTS suppliers_insert ON public.suppliers;
CREATE POLICY suppliers_insert ON public.suppliers FOR INSERT TO authenticated WITH CHECK (public.can_manage_suppliers());
DROP POLICY IF EXISTS suppliers_update ON public.suppliers;
CREATE POLICY suppliers_update ON public.suppliers FOR UPDATE TO authenticated USING ((SELECT public.can_manage_suppliers())) WITH CHECK ((SELECT public.can_manage_suppliers()));
DROP POLICY IF EXISTS supplier_locations_read ON public.supplier_locations;
CREATE POLICY supplier_locations_read ON public.supplier_locations FOR SELECT TO authenticated USING ((SELECT public.can_read_suppliers()));
DROP POLICY IF EXISTS supplier_locations_insert ON public.supplier_locations;
CREATE POLICY supplier_locations_insert ON public.supplier_locations FOR INSERT TO authenticated WITH CHECK (public.can_manage_suppliers());
DROP POLICY IF EXISTS supplier_locations_update ON public.supplier_locations;
CREATE POLICY supplier_locations_update ON public.supplier_locations FOR UPDATE TO authenticated USING (public.can_manage_suppliers()) WITH CHECK (public.can_manage_suppliers());
DROP POLICY IF EXISTS security_active_account ON public.suppliers;
CREATE POLICY security_active_account ON public.suppliers AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.supplier_locations;
CREATE POLICY security_active_account ON public.supplier_locations AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));

-- Proveedor y documento de una solicitud (solo se llama desde save_transport_request_full)
CREATE OR REPLACE FUNCTION public.apply_request_supplier(p_request_id uuid, p_payload jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.transport_requests; v_supplier uuid; v_location uuid; v_type text; v_number text;
BEGIN
  SELECT * INTO r FROM public.transport_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Solicitud inexistente'; END IF;
  v_supplier := NULLIF(p_payload->>'supplier_id', '')::uuid;
  v_location := NULLIF(p_payload->>'supplier_location_id', '')::uuid;
  v_type := NULLIF(upper(btrim(p_payload->>'reference_type')), '');
  v_number := NULLIF(btrim(p_payload->>'reference_number'), '');
  IF r.request_type IN ('RECOJO','TRASLADO') AND COALESCE(to_jsonb(r)->>'attention_mode', '') <> 'RECOJO_CLIENTE' AND v_supplier IS NULL THEN
    RAISE EXCEPTION 'Seleccione el proveedor del recojo o traslado';
  END IF;
  IF v_supplier IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.suppliers WHERE id = v_supplier AND is_active) THEN
    RAISE EXCEPTION 'Proveedor inexistente o inactivo';
  END IF;
  IF v_location IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.supplier_locations WHERE id = v_location AND supplier_id = v_supplier) THEN
    RAISE EXCEPTION 'El punto de recojo no pertenece al proveedor';
  END IF;
  IF v_type IS NOT NULL AND v_type NOT IN ('OC','RQ','OS') THEN RAISE EXCEPTION 'Documento de referencia inválido'; END IF;
  IF v_type IS NOT NULL AND v_number IS NULL THEN RAISE EXCEPTION 'Ingrese el número del documento %', v_type; END IF;
  IF v_type IS NULL THEN v_number := NULL; END IF;
  UPDATE public.transport_requests
     SET supplier_id = v_supplier, supplier_location_id = v_location, reference_type = v_type, reference_number = v_number
   WHERE id = p_request_id;
END $$;
REVOKE ALL ON FUNCTION public.apply_request_supplier(uuid, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.save_transport_request_full(p_request_id uuid, p_payload jsonb, p_components jsonb, p_unloading jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_result jsonb;
BEGIN
  v_result := public.save_transport_request_attention(p_request_id, p_payload, p_components, p_unloading);
  PERFORM public.apply_request_supplier((v_result->>'id')::uuid, p_payload);
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.save_transport_request_full(uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_transport_request_full(uuid, jsonb, jsonb, jsonb) TO authenticated, service_role;

-- Invariante en la tabla (no solo en el RPC): un recojo o traslado nuevo, o uno al que se le cambia el tipo, la
-- modalidad o el proveedor, debe quedar con proveedor al confirmar la transacción. Es diferido porque
-- save_transport_request_full guarda primero la solicitud y luego aplica el proveedor; relee la fila vigente.
-- Las solicitudes antiguas sin proveedor siguen editables mientras no cambien esos campos.
CREATE OR REPLACE FUNCTION public.enforce_request_supplier() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.transport_requests;
BEGIN
  SELECT * INTO r FROM public.transport_requests WHERE id = NEW.id;
  IF FOUND AND r.request_type IN ('RECOJO','TRASLADO') AND COALESCE(to_jsonb(r)->>'attention_mode', '') <> 'RECOJO_CLIENTE'
     AND r.supplier_id IS NULL THEN
    RAISE EXCEPTION 'Seleccione el proveedor del recojo o traslado' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.enforce_request_supplier() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS transport_requests_supplier_insert ON public.transport_requests;
CREATE CONSTRAINT TRIGGER transport_requests_supplier_insert AFTER INSERT ON public.transport_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_request_supplier();
DROP TRIGGER IF EXISTS transport_requests_supplier_update ON public.transport_requests;
CREATE CONSTRAINT TRIGGER transport_requests_supplier_update AFTER UPDATE ON public.transport_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.request_type IS DISTINCT FROM NEW.request_type OR OLD.supplier_id IS DISTINCT FROM NEW.supplier_id
    OR to_jsonb(OLD)->>'attention_mode' IS DISTINCT FROM to_jsonb(NEW)->>'attention_mode')
  EXECUTE FUNCTION public.enforce_request_supplier();

-- Alta/edición de proveedor y sus puntos de recojo en una sola transacción. SECURITY INVOKER: aplica RLS.
CREATE OR REPLACE FUNCTION public.save_supplier(p_supplier jsonb, p_locations jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid := NULLIF(p_supplier->>'id', '')::uuid; l jsonb; v_loc uuid;
BEGIN
  IF v_id IS NULL THEN
    INSERT INTO public.suppliers (tax_id, business_name, category, contact_name, contact_phone, contact_email, notes, is_active)
    VALUES (p_supplier->>'tax_id', p_supplier->>'business_name', COALESCE(p_supplier->>'category', 'MATERIA_PRIMA'),
      NULLIF(p_supplier->>'contact_name', ''), NULLIF(p_supplier->>'contact_phone', ''), NULLIF(p_supplier->>'contact_email', ''),
      NULLIF(p_supplier->>'notes', ''), COALESCE((p_supplier->>'is_active')::boolean, true))
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.suppliers SET tax_id = p_supplier->>'tax_id', business_name = p_supplier->>'business_name',
      category = COALESCE(p_supplier->>'category', category), contact_name = NULLIF(p_supplier->>'contact_name', ''),
      contact_phone = NULLIF(p_supplier->>'contact_phone', ''), contact_email = NULLIF(p_supplier->>'contact_email', ''),
      notes = NULLIF(p_supplier->>'notes', ''), is_active = COALESCE((p_supplier->>'is_active')::boolean, is_active)
     WHERE id = v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Proveedor inexistente o sin permiso de edición'; END IF;
  END IF;
  FOR l IN SELECT * FROM jsonb_array_elements(COALESCE(p_locations, '[]'::jsonb)) LOOP
    v_loc := NULLIF(l->>'id', '')::uuid;
    IF v_loc IS NULL THEN
      INSERT INTO public.supplier_locations (supplier_id, name, address, department, province, district, contact_name, contact_phone, is_active)
      VALUES (v_id, btrim(l->>'name'), btrim(l->>'address'), NULLIF(l->>'department', ''), NULLIF(l->>'province', ''),
        NULLIF(l->>'district', ''), NULLIF(l->>'contact_name', ''), NULLIF(l->>'contact_phone', ''), COALESCE((l->>'is_active')::boolean, true));
    ELSE
      UPDATE public.supplier_locations SET name = btrim(l->>'name'), address = btrim(l->>'address'), department = NULLIF(l->>'department', ''),
        province = NULLIF(l->>'province', ''), district = NULLIF(l->>'district', ''), contact_name = NULLIF(l->>'contact_name', ''),
        contact_phone = NULLIF(l->>'contact_phone', ''), is_active = COALESCE((l->>'is_active')::boolean, is_active)
       WHERE id = v_loc AND supplier_id = v_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'El punto de recojo no pertenece al proveedor'; END IF;
    END IF;
  END LOOP;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.save_supplier(jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_supplier(jsonb, jsonb) TO authenticated, service_role;

-- Tipo de servicio + proveedor y documento para tablas que solo reciben request_id
CREATE OR REPLACE FUNCTION public.request_service_types(p_requests uuid[])
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', t.id, 'request_type', t.request_type,
           'attention_mode', to_jsonb(t)->>'attention_mode', 'contract_id', t.contract_id,
           'supplier_name', s.business_name, 'reference_type', t.reference_type, 'reference_number', t.reference_number,
           'purchase_order', t.purchase_order)), '[]'::jsonb)
    FROM public.transport_requests t
    LEFT JOIN public.suppliers s ON s.id = t.supplier_id
   WHERE auth.uid() IS NOT NULL
     AND cardinality(p_requests) <= 1000
     AND t.id = ANY(p_requests)
     AND (public.is_tms_admin() OR EXISTS (
       SELECT 1 FROM public.dispatch_requests r JOIN public.dispatches d ON d.id = r.dispatch_id
        WHERE r.transport_request_id = t.id AND public.can_access_site(d.site_id)
          AND (public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('torre-control')
            OR public.has_tms_read_permission('monitoreo') OR public.has_tms_read_permission('documentario')
            OR public.has_tms_read_permission('packing-list') OR public.has_tms_read_permission('planificacion')
            OR public.can_view_driver_evidence())))
$$;

NOTIFY pgrst, 'reload schema';
