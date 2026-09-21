-- Start with one explicit site. Reassign records and users before adding another site.
CREATE TABLE public.sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);
INSERT INTO public.sites(code, name) VALUES ('PRINCIPAL', 'Sede principal');
CREATE TABLE public.user_site_access (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, site_id)
);
INSERT INTO public.user_site_access(user_id, site_id)
SELECT p.id, s.id FROM public.profiles p
JOIN auth.users u ON u.id = p.id CROSS JOIN public.sites s
WHERE p.is_active = true AND coalesce(p.employee_type, '') <> 'CONDUCTOR' AND s.code = 'PRINCIPAL'
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.primary_site_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM public.sites WHERE code = 'PRINCIPAL' LIMIT 1;
$$;
CREATE OR REPLACE FUNCTION public.can_access_site(p_site_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_site_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_active = true
  ) AND (public.is_tms_admin() OR EXISTS (
    SELECT 1 FROM public.user_site_access a
    WHERE a.user_id = auth.uid() AND a.site_id = p_site_id
  ));
$$;
REVOKE ALL ON FUNCTION public.primary_site_id(), public.can_access_site(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.primary_site_id(), public.can_access_site(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.has_tms_read_permission(p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
    WHERE p.id = auth.uid() AND p.is_active = true AND
      (r.name = 'Administrador' OR r.permissions ? p_permission OR
       r.permissions ? (p_permission || ':read') OR
       r.permissions ? (p_permission || ':write'))
  );
$$;
REVOKE ALL ON FUNCTION public.has_tms_read_permission(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_tms_read_permission(text) TO authenticated;

ALTER TABLE public.sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_site_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sites, public.user_site_access FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sites, public.user_site_access TO authenticated;
CREATE POLICY sites_read ON public.sites FOR SELECT TO authenticated
  USING (public.can_access_site(id) OR public.is_tms_admin());
CREATE POLICY sites_admin ON public.sites FOR ALL TO authenticated
  USING (public.is_tms_admin()) WITH CHECK (public.is_tms_admin());
CREATE POLICY user_site_access_read ON public.user_site_access FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_tms_admin());
CREATE POLICY user_site_access_admin ON public.user_site_access FOR ALL TO authenticated
  USING (public.is_tms_admin()) WITH CHECK (public.is_tms_admin());

CREATE OR REPLACE FUNCTION public.assign_primary_site_to_staff()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.is_active = true AND coalesce(NEW.employee_type, '') <> 'CONDUCTOR' AND
     EXISTS (SELECT 1 FROM auth.users WHERE id = NEW.id) AND
     NOT EXISTS (SELECT 1 FROM public.user_site_access WHERE user_id = NEW.id) THEN
    INSERT INTO public.user_site_access(user_id, site_id)
    SELECT NEW.id, id FROM public.sites WHERE code = 'PRINCIPAL'
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER profiles_assign_primary_site
AFTER INSERT OR UPDATE OF is_active, employee_type ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.assign_primary_site_to_staff();

ALTER TABLE public.contracts ADD COLUMN site_id uuid REFERENCES public.sites(id) DEFAULT public.primary_site_id();
ALTER TABLE public.dispatches ADD COLUMN site_id uuid REFERENCES public.sites(id) DEFAULT public.primary_site_id();
ALTER TABLE public.transport_requests ADD COLUMN site_id uuid REFERENCES public.sites(id) DEFAULT public.primary_site_id();
ALTER TABLE public.vehicles ADD COLUMN site_id uuid REFERENCES public.sites(id) DEFAULT public.primary_site_id();
ALTER TABLE public.spare_parts ADD COLUMN site_id uuid REFERENCES public.sites(id) DEFAULT public.primary_site_id();
ALTER TABLE public.maintenance_plans ADD COLUMN site_id uuid REFERENCES public.sites(id) DEFAULT public.primary_site_id();
ALTER TABLE public.vehicle_failures ADD COLUMN site_id uuid REFERENCES public.sites(id) DEFAULT public.primary_site_id();
ALTER TABLE public.maintenance_work_orders ADD COLUMN site_id uuid REFERENCES public.sites(id) DEFAULT public.primary_site_id();
UPDATE public.contracts SET site_id = public.primary_site_id() WHERE site_id IS NULL;
UPDATE public.dispatches SET site_id = public.primary_site_id() WHERE site_id IS NULL;
UPDATE public.transport_requests SET site_id = public.primary_site_id() WHERE site_id IS NULL;
UPDATE public.vehicles SET site_id = public.primary_site_id() WHERE site_id IS NULL;
UPDATE public.spare_parts SET site_id = public.primary_site_id() WHERE site_id IS NULL;
UPDATE public.maintenance_plans SET site_id = public.primary_site_id() WHERE site_id IS NULL;
UPDATE public.vehicle_failures SET site_id = public.primary_site_id() WHERE site_id IS NULL;
UPDATE public.maintenance_work_orders SET site_id = public.primary_site_id() WHERE site_id IS NULL;
ALTER TABLE public.contracts ALTER COLUMN site_id SET NOT NULL;
ALTER TABLE public.dispatches ALTER COLUMN site_id SET NOT NULL;
ALTER TABLE public.transport_requests ALTER COLUMN site_id SET NOT NULL;
ALTER TABLE public.vehicles ALTER COLUMN site_id SET NOT NULL;
ALTER TABLE public.spare_parts ALTER COLUMN site_id SET NOT NULL;
ALTER TABLE public.maintenance_plans ALTER COLUMN site_id SET NOT NULL;
ALTER TABLE public.vehicle_failures ALTER COLUMN site_id SET NOT NULL;
ALTER TABLE public.maintenance_work_orders ALTER COLUMN site_id SET NOT NULL;

-- Remove the unrestricted policies on the data exposed to JRM IA.
DROP POLICY IF EXISTS "Enable all for authenticated users on contracts" ON public.contracts;
DROP POLICY IF EXISTS "Enable all for authenticated users on contract_budgets" ON public.contract_budgets;
DROP POLICY IF EXISTS "Enable all for authenticated on spare_parts" ON public.spare_parts;
DROP POLICY IF EXISTS "Enable all for authenticated on spare_part_movements" ON public.spare_part_movements;
DROP POLICY IF EXISTS "Enable all for authenticated users on maintenance_plans" ON public.maintenance_plans;
DROP POLICY IF EXISTS "Enable all for authenticated users on vehicle_failures" ON public.vehicle_failures;
DROP POLICY IF EXISTS "Enable all for authenticated users on maintenance_work_orders" ON public.maintenance_work_orders;
DROP POLICY IF EXISTS dispatch_read ON public.dispatches;
DROP POLICY IF EXISTS dispatch_staff_write ON public.dispatches;
DROP POLICY IF EXISTS transport_request_read ON public.transport_requests;
DROP POLICY IF EXISTS transport_request_staff_write ON public.transport_requests;
DROP POLICY IF EXISTS vehicles_read ON public.vehicles;
DROP POLICY IF EXISTS vehicles_staff_write ON public.vehicles;
DROP POLICY IF EXISTS contract_budget_read ON public.contract_budgets;
DROP POLICY IF EXISTS contract_budget_staff_write ON public.contract_budgets;

CREATE POLICY contracts_read ON public.contracts FOR SELECT TO authenticated
  USING (public.can_access_site(site_id) AND (
    public.has_tms_read_permission('ot') OR public.has_tms_read_permission('clientes') OR
    public.has_tms_read_permission('contratos-servicios') OR public.has_tms_read_permission('solicitudes') OR
    public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('dashboard') OR
    public.has_tms_read_permission('operaciones-kpis')));
CREATE POLICY contracts_write ON public.contracts FOR ALL TO authenticated
  USING (public.can_access_site(site_id) AND (public.has_tms_permission('ot') OR public.has_tms_permission('clientes')))
  WITH CHECK (public.can_access_site(site_id) AND (public.has_tms_permission('ot') OR public.has_tms_permission('clientes')));
CREATE POLICY contract_budgets_read_site ON public.contract_budgets FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.contracts c WHERE c.id = contract_id AND (
    public.has_tms_read_permission('dashboard') OR public.has_tms_read_permission('clientes') OR
    public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('contratos-servicios') OR
    public.has_tms_read_permission('ot') OR public.has_tms_read_permission('operaciones-kpis'))));
CREATE POLICY contract_budgets_write_site ON public.contract_budgets FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.contracts c WHERE c.id = contract_id AND (
    public.has_tms_permission('clientes') OR public.has_tms_permission('despacho') OR
    public.has_tms_permission('ot'))))
  WITH CHECK (EXISTS (SELECT 1 FROM public.contracts c WHERE c.id = contract_id AND (
    public.has_tms_permission('clientes') OR public.has_tms_permission('despacho') OR
    public.has_tms_permission('ot'))));

CREATE POLICY dispatches_read_site ON public.dispatches FOR SELECT TO authenticated
  USING ((public.can_access_site(site_id) AND (public.has_tms_read_permission('despacho') OR
    public.has_tms_read_permission('dashboard') OR public.has_tms_read_permission('operaciones-kpis') OR
    public.has_tms_read_permission('caja') OR public.has_tms_read_permission('torre-control') OR
    public.has_tms_read_permission('monitoreo'))) OR
    EXISTS (SELECT 1 FROM public.drivers d WHERE d.id = driver_id AND d.profile_id = auth.uid()));
CREATE POLICY dispatches_write_site ON public.dispatches FOR ALL TO authenticated
  USING (public.can_access_site(site_id) AND public.has_tms_permission('despacho'))
  WITH CHECK (public.can_access_site(site_id) AND public.has_tms_permission('despacho'));

-- The monitoring UI already records these events; make their schema and access explicit.
CREATE TABLE IF NOT EXISTS public.dispatch_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id uuid NOT NULL REFERENCES public.dispatches(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  description text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dispatch_events_dispatch_time
  ON public.dispatch_events(dispatch_id, created_at DESC);
ALTER TABLE public.dispatch_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dispatch_events FROM anon, authenticated;
GRANT SELECT, INSERT ON public.dispatch_events TO authenticated;
DO $$ DECLARE p record; BEGIN
  FOR p IN SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'dispatch_events'
      AND policyname <> 'tms_admin_full_access'
  LOOP EXECUTE format('DROP POLICY %I ON public.dispatch_events', p.policyname); END LOOP;
END $$;
CREATE POLICY dispatch_events_read_site ON public.dispatch_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.dispatches d WHERE d.id = dispatch_id AND
    (public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('torre-control') OR
     public.has_tms_read_permission('monitoreo'))));
CREATE POLICY dispatch_events_insert_site ON public.dispatch_events FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.dispatches d WHERE d.id = dispatch_id AND
    public.can_access_site(d.site_id) AND
    (public.has_tms_permission('monitoreo') OR public.has_tms_permission('despacho'))));
CREATE POLICY requests_read_site ON public.transport_requests FOR SELECT TO authenticated
  USING ((public.can_access_site(site_id) AND (public.has_tms_read_permission('solicitudes') OR
    public.has_tms_read_permission('despacho'))) OR EXISTS (
    SELECT 1 FROM public.dispatch_requests dr JOIN public.dispatches d ON d.id = dr.dispatch_id
    JOIN public.drivers driver ON driver.id = d.driver_id
    WHERE dr.transport_request_id = transport_requests.id AND driver.profile_id = auth.uid()));
CREATE POLICY requests_write_site ON public.transport_requests FOR ALL TO authenticated
  USING (public.can_access_site(site_id) AND (public.has_tms_permission('solicitudes') OR public.has_tms_permission('despacho')))
  WITH CHECK (public.can_access_site(site_id) AND (public.has_tms_permission('solicitudes') OR public.has_tms_permission('despacho')));
CREATE POLICY vehicles_read_site ON public.vehicles FOR SELECT TO authenticated
  USING (public.can_access_site(site_id) AND (public.has_tms_read_permission('flota') OR
    public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('mantenimiento-flota') OR
    public.has_tms_read_permission('mantenimiento-planes') OR
    public.has_tms_read_permission('mantenimiento-fallas') OR
    public.has_tms_read_permission('mantenimiento-ot')));
CREATE POLICY vehicles_write_site ON public.vehicles FOR ALL TO authenticated
  USING (public.can_access_site(site_id) AND (public.has_tms_permission('flota') OR public.has_tms_permission('mantenimiento-flota')))
  WITH CHECK (public.can_access_site(site_id) AND (public.has_tms_permission('flota') OR public.has_tms_permission('mantenimiento-flota')));

CREATE POLICY spare_parts_read_site ON public.spare_parts FOR SELECT TO authenticated
  USING (public.can_access_site(site_id) AND public.has_tms_read_permission('mantenimiento-ot'));
CREATE POLICY spare_parts_write_site ON public.spare_parts FOR ALL TO authenticated
  USING (public.can_access_site(site_id) AND public.has_tms_permission('mantenimiento-ot'))
  WITH CHECK (public.can_access_site(site_id) AND public.has_tms_permission('mantenimiento-ot'));
CREATE POLICY spare_part_movements_read_site ON public.spare_part_movements FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.spare_parts p WHERE p.id = spare_part_id));
CREATE POLICY spare_part_movements_write_site ON public.spare_part_movements FOR ALL TO authenticated
  USING (public.has_tms_permission('mantenimiento-ot') AND
    EXISTS (SELECT 1 FROM public.spare_parts p WHERE p.id = spare_part_id))
  WITH CHECK (public.has_tms_permission('mantenimiento-ot') AND
    EXISTS (SELECT 1 FROM public.spare_parts p WHERE p.id = spare_part_id));
CREATE POLICY maintenance_plans_read_site ON public.maintenance_plans FOR SELECT TO authenticated
  USING (public.can_access_site(site_id) AND (public.has_tms_read_permission('mantenimiento-planes') OR
    public.has_tms_read_permission('mantenimiento-flota')));
CREATE POLICY maintenance_plans_write_site ON public.maintenance_plans FOR ALL TO authenticated
  USING (public.can_access_site(site_id) AND (public.has_tms_permission('mantenimiento-planes') OR public.has_tms_permission('mantenimiento-flota')))
  WITH CHECK (public.can_access_site(site_id) AND (public.has_tms_permission('mantenimiento-planes') OR public.has_tms_permission('mantenimiento-flota')));
CREATE POLICY vehicle_failures_read_site ON public.vehicle_failures FOR SELECT TO authenticated
  USING (public.can_access_site(site_id) AND public.has_tms_read_permission('mantenimiento-fallas'));
CREATE POLICY vehicle_failures_write_site ON public.vehicle_failures FOR ALL TO authenticated
  USING (public.can_access_site(site_id) AND public.has_tms_permission('mantenimiento-fallas'))
  WITH CHECK (public.can_access_site(site_id) AND public.has_tms_permission('mantenimiento-fallas'));
CREATE POLICY maintenance_work_orders_read_site ON public.maintenance_work_orders FOR SELECT TO authenticated
  USING (public.can_access_site(site_id) AND public.has_tms_read_permission('mantenimiento-ot'));
CREATE POLICY maintenance_work_orders_write_site ON public.maintenance_work_orders FOR ALL TO authenticated
  USING (public.can_access_site(site_id) AND public.has_tms_permission('mantenimiento-ot'))
  WITH CHECK (public.can_access_site(site_id) AND public.has_tms_permission('mantenimiento-ot'));

CREATE INDEX contracts_site ON public.contracts(site_id);
CREATE INDEX dispatches_site ON public.dispatches(site_id);
CREATE INDEX transport_requests_site ON public.transport_requests(site_id);
CREATE INDEX vehicles_site ON public.vehicles(site_id);
CREATE INDEX spare_parts_site ON public.spare_parts(site_id);
CREATE INDEX maintenance_plans_site ON public.maintenance_plans(site_id);
CREATE INDEX vehicle_failures_site ON public.vehicle_failures(site_id);
CREATE INDEX maintenance_work_orders_site ON public.maintenance_work_orders(site_id);

CREATE OR REPLACE FUNCTION public.ai_get_operational_kpis(p_site_ids uuid[], p_since timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE result jsonb;
BEGIN
  IF auth.uid() IS NULL OR cardinality(p_site_ids) = 0 OR cardinality(p_site_ids) > 20 OR
    EXISTS (SELECT 1 FROM unnest(p_site_ids) site WHERE NOT public.can_access_site(site)) OR
    NOT (public.has_tms_read_permission('dashboard') OR public.has_tms_read_permission('operaciones-kpis')) THEN
    RAISE EXCEPTION 'Sin permiso para indicadores operacionales';
  END IF;
  SELECT jsonb_build_object(
    'dispatches', count(*),
    'pending', count(*) FILTER (WHERE status = 'PROGRAMADO'),
    'inProgress', count(*) FILTER (WHERE status IN ('EN_CURSO', 'EN RUTA', 'RETORNO')),
    'completed', count(*) FILTER (WHERE status IN ('LIQUIDADO', 'ENTREGADO')),
    'freightCostPen', coalesce(sum(freight_cost), 0),
    'actualDispatchedTons', NULL,
    'asOf', now()
  ) INTO result FROM public.dispatches
  WHERE site_id = ANY(p_site_ids) AND scheduled_departure >= greatest(p_since, now() - interval '90 days');
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.ai_get_operational_kpis(uuid[],timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_get_operational_kpis(uuid[],timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION public.ai_get_transport_costs(p_site_ids uuid[], p_since timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE result jsonb;
BEGIN
  IF auth.uid() IS NULL OR cardinality(p_site_ids) = 0 OR cardinality(p_site_ids) > 20 OR
    EXISTS (SELECT 1 FROM unnest(p_site_ids) site WHERE NOT public.can_access_site(site)) OR
    NOT (public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('caja')) THEN
    RAISE EXCEPTION 'Sin permiso para costos de transporte';
  END IF;
  WITH eligible AS (
    SELECT contract_id, freight_cost FROM public.dispatches
    WHERE site_id = ANY(p_site_ids)
      AND scheduled_departure >= greatest(p_since, now() - interval '90 days')
  ), grouped AS (
    SELECT contract_id, count(*) AS dispatch_count,
      coalesce(sum(freight_cost), 0) AS freight_pen
    FROM eligible GROUP BY contract_id
  )
  SELECT jsonb_build_object(
    'periodFreightPen', coalesce((SELECT sum(freight_cost) FROM eligible), 0),
    'dispatchCount', (SELECT count(*) FROM eligible),
    'contractCount', (SELECT count(*) FROM grouped),
    'byContract', coalesce((SELECT jsonb_agg(to_jsonb(g)) FROM (
      SELECT contract_id, dispatch_count, freight_pen FROM grouped
      ORDER BY freight_pen DESC LIMIT 30
    ) g), '[]'::jsonb),
    'asOf', now()
  ) INTO result;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.ai_get_transport_costs(uuid[],timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_get_transport_costs(uuid[],timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION public.ai_get_inventory_alerts(p_site_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE result jsonb;
BEGIN
  IF auth.uid() IS NULL OR cardinality(p_site_ids) = 0 OR cardinality(p_site_ids) > 20 OR
    EXISTS (SELECT 1 FROM unnest(p_site_ids) site WHERE NOT public.can_access_site(site)) OR
    NOT public.has_tms_read_permission('mantenimiento-ot') THEN
    RAISE EXCEPTION 'Sin permiso para inventario';
  END IF;
  WITH inventory AS (
    SELECT p.id, p.internal_code, p.name, p.current_stock, p.minimum_stock,
      p.created_at, (SELECT max(m.created_at) FROM public.spare_part_movements m
        WHERE m.spare_part_id = p.id) AS last_movement_at
    FROM public.spare_parts p
    WHERE p.site_id = ANY(p_site_ids) AND p.is_active = true
  )
  SELECT jsonb_build_object(
    'partsInScope', count(*),
    'criticalCount', count(*) FILTER (WHERE current_stock <= minimum_stock),
    'noMovementCount', count(*) FILTER (WHERE
      coalesce(last_movement_at, created_at) < now() - interval '90 days'),
    'alertCount', count(*) FILTER (WHERE current_stock <= minimum_stock OR
      coalesce(last_movement_at, created_at) < now() - interval '90 days'),
    'alertsSample', coalesce((SELECT jsonb_agg(to_jsonb(a)) FROM (
      SELECT id, internal_code, name, current_stock, minimum_stock, last_movement_at,
        (current_stock <= minimum_stock) AS critical,
        (coalesce(last_movement_at, created_at) < now() - interval '90 days') AS no_movement_90_days
      FROM inventory
      WHERE current_stock <= minimum_stock OR
        coalesce(last_movement_at, created_at) < now() - interval '90 days'
      ORDER BY (current_stock <= minimum_stock) DESC, internal_code LIMIT 60
    ) a), '[]'::jsonb),
    'asOf', now()
  ) INTO result FROM inventory;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.ai_get_inventory_alerts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_get_inventory_alerts(uuid[]) TO authenticated;
