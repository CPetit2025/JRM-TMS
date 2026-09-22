-- Contract administrators own a portfolio of root OTs. Existing OTs are deliberately
-- left unassigned: only a system administrator can establish their real owner.
ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id);

CREATE TABLE public.contract_user_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('ADMIN_CONTRATO','BACKUP','SUPERVISOR','CONSULTOR')),
  active boolean NOT NULL DEFAULT true,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  assigned_by uuid REFERENCES public.profiles(id),
  ended_by uuid REFERENCES public.profiles(id),
  reason text,
  CONSTRAINT assignment_period CHECK ((active AND ended_at IS NULL) OR
    (NOT active AND ended_at IS NOT NULL AND ended_at >= assigned_at))
);
CREATE UNIQUE INDEX assignment_one_primary ON public.contract_user_assignments(contract_id)
  WHERE active AND role = 'ADMIN_CONTRATO';
CREATE UNIQUE INDEX assignment_one_active_role ON public.contract_user_assignments(contract_id,user_id,role)
  WHERE active;
CREATE INDEX assignment_user_active ON public.contract_user_assignments(user_id,contract_id)
  WHERE active;

CREATE OR REPLACE FUNCTION public.is_contract_administrator()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
    WHERE p.id = auth.uid() AND p.is_active AND r.name = 'Administrador de Contratos');
$$;
CREATE OR REPLACE FUNCTION public.contract_root_id(p_contract_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  WITH RECURSIVE ancestors AS (
    SELECT id,parent_contract_id,0 AS depth FROM public.contracts WHERE id = p_contract_id
    UNION ALL
    SELECT c.id,c.parent_contract_id,a.depth + 1 FROM public.contracts c
      JOIN ancestors a ON c.id = a.parent_contract_id WHERE a.depth < 16
  )
  SELECT id FROM ancestors WHERE parent_contract_id IS NULL ORDER BY depth DESC LIMIT 1;
$$;
CREATE OR REPLACE FUNCTION public.has_assigned_contract(p_contract_id uuid, p_write boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.contract_user_assignments a
    JOIN public.contracts root ON root.id = a.contract_id
    WHERE a.contract_id = public.contract_root_id(p_contract_id)
      AND a.user_id = auth.uid() AND a.active
      AND (NOT p_write OR a.role IN ('ADMIN_CONTRATO','BACKUP'))
      AND public.can_access_site(root.site_id));
$$;
CREATE OR REPLACE FUNCTION public.has_assigned_request(p_request_id uuid, p_write boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.transport_requests r WHERE r.id = p_request_id
    AND public.has_assigned_contract(r.contract_id,p_write));
$$;
CREATE OR REPLACE FUNCTION public.has_assigned_dispatch(p_dispatch_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.dispatches d WHERE d.id = p_dispatch_id
    AND (public.has_assigned_contract(d.contract_id) OR EXISTS (
      SELECT 1 FROM public.dispatch_requests dr
      JOIN public.transport_requests r ON r.id = dr.transport_request_id
      WHERE dr.dispatch_id = d.id AND public.has_assigned_contract(r.contract_id))));
$$;
CREATE OR REPLACE FUNCTION public.has_assigned_expense(p_contract_id uuid, p_request_id uuid, p_trip_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.has_assigned_contract(p_contract_id) OR
    public.has_assigned_request(p_request_id) OR public.has_assigned_dispatch(p_trip_id);
$$;
REVOKE ALL ON FUNCTION public.is_contract_administrator(),public.contract_root_id(uuid),
  public.has_assigned_contract(uuid,boolean),public.has_assigned_request(uuid,boolean),
  public.has_assigned_dispatch(uuid),public.has_assigned_expense(uuid,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.is_contract_administrator(),public.contract_root_id(uuid),
  public.has_assigned_contract(uuid,boolean),public.has_assigned_request(uuid,boolean),
  public.has_assigned_dispatch(uuid),public.has_assigned_expense(uuid,uuid,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.validate_contract_assignment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_role text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.contracts c WHERE c.id = NEW.contract_id
    AND c.parent_contract_id IS NULL AND c.type IN ('CONTRATO','OT_INDEPENDIENTE')) THEN
    RAISE EXCEPTION 'Solo se asignan OT raíz';
  END IF;
  IF NEW.active THEN
    SELECT r.name INTO v_role FROM public.profiles p JOIN public.roles r ON r.id=p.role_id
      WHERE p.id=NEW.user_id AND p.is_active;
    IF v_role IS NULL OR (NEW.role = 'ADMIN_CONTRATO' AND v_role <> 'Administrador de Contratos') THEN
      RAISE EXCEPTION 'El responsable debe tener un perfil activo y el rol apropiado';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_contract_assignment BEFORE INSERT OR UPDATE OF contract_id,user_id,role,active
  ON public.contract_user_assignments FOR EACH ROW EXECUTE FUNCTION public.validate_contract_assignment();

CREATE OR REPLACE FUNCTION public.track_new_contract()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := auth.uid();
  ELSIF public.is_contract_administrator() AND
    (NEW.parent_contract_id IS DISTINCT FROM OLD.parent_contract_id OR
     NEW.type IS DISTINCT FROM OLD.type OR NEW.site_id IS DISTINCT FROM OLD.site_id OR
     NEW.created_by IS DISTINCT FROM OLD.created_by) THEN
    RAISE EXCEPTION 'No se puede cambiar la identidad o jerarquía de la OT';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER track_new_contract BEFORE INSERT OR UPDATE ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION public.track_new_contract();

CREATE OR REPLACE FUNCTION public.assign_new_contract_creator()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.parent_contract_id IS NULL AND NEW.type IN ('CONTRATO','OT_INDEPENDIENTE')
     AND public.is_contract_administrator() THEN
    INSERT INTO public.contract_user_assignments(contract_id,user_id,role,assigned_by,reason)
      VALUES (NEW.id,auth.uid(),'ADMIN_CONTRATO',auth.uid(),'Creador de la OT');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER assign_new_contract_creator AFTER INSERT ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION public.assign_new_contract_creator();

-- A root OT and its first assignment must be created in one transaction. A
-- direct INSERT ... RETURNING cannot see the AFTER INSERT assignment through RLS.
CREATE OR REPLACE FUNCTION public.create_portfolio_contract(p_payload jsonb,p_budget_pen numeric DEFAULT 0)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
DECLARE v_site uuid;
DECLARE v_code text;
DECLARE v_type text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_contract_administrator() OR
     NOT public.has_tms_permission('ot') OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' THEN
    RAISE EXCEPTION 'Sin permiso para crear OT';
  END IF;
  v_code := trim(coalesce(p_payload->>'code',''));
  v_type := p_payload->>'type';
  v_site := coalesce(nullif(p_payload->>'site_id','')::uuid,public.primary_site_id());
  IF length(v_code) NOT BETWEEN 1 AND 100 OR v_type NOT IN ('CONTRATO','OT_INDEPENDIENTE') OR
     NOT public.can_access_site(v_site) OR coalesce(p_budget_pen,0)<0 OR
     coalesce(p_budget_pen,0)>999999999999.99 OR
     coalesce(nullif(p_payload->>'total_weight_kg','')::numeric,0)<0 OR
     coalesce(nullif(p_payload->>'total_volume_m3','')::numeric,0)<0 THEN
    RAISE EXCEPTION 'Datos de OT inválidos';
  END IF;
  INSERT INTO public.contracts(code,type,site_id,client_id,status,total_weight_kg,
    total_volume_m3,destination_department,destination_province,destination_district,destination_address)
  VALUES(v_code,v_type::public.contract_type,v_site,
    nullif(p_payload->>'client_id','')::uuid,'ACTIVO',
    coalesce(nullif(p_payload->>'total_weight_kg','')::numeric,0),
    coalesce(nullif(p_payload->>'total_volume_m3','')::numeric,0),
    nullif(p_payload->>'destination_department',''),
    nullif(p_payload->>'destination_province',''),
    nullif(p_payload->>'destination_district',''),
    nullif(p_payload->>'destination_address','')) RETURNING id INTO v_id;
  IF coalesce(p_budget_pen,0)>0 THEN
    INSERT INTO public.contract_budgets(contract_id,allocated_pen)
      VALUES(v_id,p_budget_pen);
  END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.create_portfolio_contract(jsonb,numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_portfolio_contract(jsonb,numeric) TO authenticated;

ALTER TABLE public.contract_user_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contract_user_assignments FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.contract_user_assignments TO authenticated;
CREATE POLICY assignment_read ON public.contract_user_assignments FOR SELECT TO authenticated
  USING (public.is_tms_admin() OR user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.reassign_contract_administrator(
  p_contract_id uuid,p_user_id uuid,p_reason text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_assignment_id uuid;
BEGIN
  IF NOT public.is_tms_admin() THEN RAISE EXCEPTION 'Solo el Administrador del Sistema puede reasignar OT'; END IF;
  PERFORM 1 FROM public.contracts c WHERE c.id=p_contract_id
    AND c.parent_contract_id IS NULL AND c.type IN ('CONTRATO','OT_INDEPENDIENTE') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OT raíz no encontrada'; END IF;
  IF p_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.profiles p
    JOIN public.roles r ON r.id=p.role_id WHERE p.id=p_user_id AND p.is_active
      AND r.name='Administrador de Contratos') THEN
    RAISE EXCEPTION 'El nuevo responsable debe ser Administrador de Contratos activo';
  END IF;
  SELECT id INTO v_assignment_id FROM public.contract_user_assignments
    WHERE contract_id=p_contract_id AND user_id=p_user_id
      AND role='ADMIN_CONTRATO' AND active;
  IF v_assignment_id IS NOT NULL THEN RETURN v_assignment_id; END IF;
  UPDATE public.contract_user_assignments SET active=false,ended_at=now(),ended_by=auth.uid()
    WHERE contract_id=p_contract_id AND role='ADMIN_CONTRATO' AND active;
  IF p_user_id IS NOT NULL THEN
    INSERT INTO public.contract_user_assignments(contract_id,user_id,role,assigned_by,reason)
      VALUES(p_contract_id,p_user_id,'ADMIN_CONTRATO',auth.uid(),nullif(trim(p_reason),''))
      RETURNING id INTO v_assignment_id;
  END IF;
  RETURN v_assignment_id;
END $$;
REVOKE ALL ON FUNCTION public.reassign_contract_administrator(uuid,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.reassign_contract_administrator(uuid,uuid,text) TO authenticated;

-- Restrictive policies intersect with every existing permissive policy, including
-- the legacy FOR ALL policies. Other roles keep their existing module checks.
CREATE POLICY portfolio_contract_read ON public.contracts AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT public.is_contract_administrator() OR public.has_assigned_contract(id));
CREATE POLICY portfolio_contract_insert ON public.contracts AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_contract_administrator() OR
    (parent_contract_id IS NOT NULL AND public.has_assigned_contract(parent_contract_id,true)));
CREATE POLICY portfolio_contract_update ON public.contracts AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_contract_administrator() OR public.has_assigned_contract(id,true))
  WITH CHECK (NOT public.is_contract_administrator() OR public.has_assigned_contract(id,true));
CREATE POLICY portfolio_contract_delete ON public.contracts AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_contract_administrator() OR public.has_assigned_contract(id,true));

-- Every child derives its authorization from the root OT.
CREATE POLICY portfolio_budget ON public.contract_budgets AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT public.is_contract_administrator() OR public.has_assigned_contract(contract_id,true))
  WITH CHECK (NOT public.is_contract_administrator() OR public.has_assigned_contract(contract_id,true));
CREATE POLICY portfolio_service ON public.contract_services AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT public.is_contract_administrator() OR public.has_assigned_contract(contract_id,true))
  WITH CHECK (NOT public.is_contract_administrator() OR public.has_assigned_contract(contract_id,true));
CREATE POLICY portfolio_request ON public.transport_requests AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT public.is_contract_administrator() OR public.has_assigned_contract(contract_id))
  WITH CHECK (NOT public.is_contract_administrator() OR public.has_assigned_contract(contract_id,true));
CREATE POLICY portfolio_component ON public.transport_request_components AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT public.is_contract_administrator() OR public.has_assigned_request(request_id));
CREATE POLICY portfolio_request_event ON public.transport_request_events AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT public.is_contract_administrator() OR public.has_assigned_request(request_id));
CREATE POLICY portfolio_request_item ON public.transport_request_items AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT public.is_contract_administrator() OR public.has_assigned_request(transport_request_id))
  WITH CHECK (NOT public.is_contract_administrator() OR public.has_assigned_request(transport_request_id,true));
REVOKE INSERT,UPDATE,DELETE ON public.transport_request_items FROM authenticated;
DROP POLICY IF EXISTS "Permitir lectura de items a usuarios autenticados" ON public.transport_request_items;
DROP POLICY IF EXISTS "Permitir insercion de items a usuarios autenticados" ON public.transport_request_items;
DROP POLICY IF EXISTS "Permitir actualizacion de items a usuarios autenticados" ON public.transport_request_items;
DROP POLICY IF EXISTS "Permitir eliminacion de items a usuarios autenticados" ON public.transport_request_items;
CREATE POLICY request_items_read ON public.transport_request_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.transport_requests r WHERE r.id=transport_request_id));
CREATE POLICY portfolio_dispatch ON public.dispatches AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT public.is_contract_administrator() OR public.has_assigned_dispatch(id))
  WITH CHECK (NOT public.is_contract_administrator() OR public.has_assigned_dispatch(id));
CREATE POLICY portfolio_dispatch_request ON public.dispatch_requests AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT public.is_contract_administrator() OR public.has_assigned_request(transport_request_id))
  WITH CHECK (NOT public.is_contract_administrator() OR public.has_assigned_request(transport_request_id,true));
CREATE POLICY portfolio_dispatch_event ON public.dispatch_events AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT public.is_contract_administrator() OR public.has_assigned_dispatch(dispatch_id))
  WITH CHECK (NOT public.is_contract_administrator() OR public.has_assigned_dispatch(dispatch_id));
CREATE POLICY portfolio_cash_fund ON public.cash_funds AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT public.is_contract_administrator() OR public.has_assigned_contract(contract_id) OR public.has_assigned_dispatch(trip_id))
  WITH CHECK (NOT public.is_contract_administrator() OR public.has_assigned_contract(contract_id,true));
CREATE POLICY portfolio_document_liquidation ON public.document_liquidations AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT public.is_contract_administrator() OR public.has_assigned_dispatch(dispatch_id))
  WITH CHECK (NOT public.is_contract_administrator() OR public.has_assigned_dispatch(dispatch_id));
CREATE POLICY portfolio_expense_liquidation ON public.expense_liquidations AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT public.is_contract_administrator() OR public.has_assigned_dispatch(dispatch_id))
  WITH CHECK (NOT public.is_contract_administrator() OR public.has_assigned_dispatch(dispatch_id));
CREATE POLICY portfolio_route_stop ON public.route_stops_log AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT public.is_contract_administrator() OR public.has_assigned_request(transport_request_id))
  WITH CHECK (NOT public.is_contract_administrator() OR public.has_assigned_request(transport_request_id,true));
CREATE POLICY portfolio_route_point ON public.route_track_points AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT public.is_contract_administrator() OR public.has_assigned_dispatch(dispatch_id))
  WITH CHECK (NOT public.is_contract_administrator() OR public.has_assigned_dispatch(dispatch_id));
CREATE POLICY portfolio_driver_checklist ON public.driver_checklists AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT public.is_contract_administrator() OR public.has_assigned_dispatch(dispatch_id))
  WITH CHECK (NOT public.is_contract_administrator() OR public.has_assigned_dispatch(dispatch_id));

-- These former MVP policies exposed financial and dispatch documents to every
-- authenticated account, including users with no module permissions.
DROP POLICY IF EXISTS "Enable all for authenticated on cash_funds" ON public.cash_funds;
CREATE POLICY cash_funds_finance_read ON public.cash_funds FOR SELECT TO authenticated
  USING (public.has_tms_read_permission('caja') OR
    public.has_tms_read_permission('caja-fondos') OR
    public.has_tms_read_permission('caja-gastos') OR
    public.has_tms_read_permission('caja-liquidaciones'));
CREATE POLICY cash_funds_finance_write ON public.cash_funds FOR ALL TO authenticated
  USING (public.has_tms_permission('caja-fondos') OR public.has_tms_permission('caja-liquidaciones'))
  WITH CHECK (public.has_tms_permission('caja-fondos') OR public.has_tms_permission('caja-liquidaciones'));
DROP POLICY IF EXISTS "Permitir lectura y escritura a documents" ON public.document_liquidations;
CREATE POLICY document_liquidations_staff ON public.document_liquidations FOR ALL TO authenticated
  USING (public.has_tms_permission('despacho') OR public.has_tms_permission('caja-liquidaciones'))
  WITH CHECK (public.has_tms_permission('despacho') OR public.has_tms_permission('caja-liquidaciones'));
DROP POLICY IF EXISTS "Permitir lectura y escritura a expenses" ON public.expense_liquidations;
CREATE POLICY expense_liquidations_finance ON public.expense_liquidations FOR ALL TO authenticated
  USING (public.has_tms_permission('caja-liquidaciones'))
  WITH CHECK (public.has_tms_permission('caja-liquidaciones'));
DROP POLICY IF EXISTS "Enable all for authenticated on cash_settlements" ON public.cash_settlements;
CREATE POLICY cash_settlements_finance ON public.cash_settlements FOR ALL TO authenticated
  USING (public.has_tms_permission('caja-liquidaciones'))
  WITH CHECK (public.has_tms_permission('caja-liquidaciones'));
DROP POLICY IF EXISTS "Enable all for authenticated on expense_audit_logs" ON public.expense_audit_logs;
CREATE POLICY expense_audit_read ON public.expense_audit_logs FOR SELECT TO authenticated
  USING (public.has_tms_read_permission('caja-gastos') OR
    public.has_tms_read_permission('caja-liquidaciones') OR
    (public.is_contract_administrator() AND record_type='EXPENSE' AND EXISTS
      (SELECT 1 FROM public.expense_records e WHERE e.id=record_id)));
CREATE POLICY expense_audit_finance_insert ON public.expense_audit_logs FOR INSERT TO authenticated
  WITH CHECK (public.has_tms_permission('caja-gastos') OR public.has_tms_permission('caja-liquidaciones'));

DROP POLICY IF EXISTS "Enable all for authenticated on expense_records" ON public.expense_records;
CREATE POLICY expenses_portfolio_read ON public.expense_records FOR SELECT TO authenticated
  USING (public.is_tms_admin() OR
    (public.is_contract_administrator() AND public.has_assigned_expense(contract_id,transport_request_id,trip_id)) OR
    (NOT public.is_contract_administrator() AND (public.has_tms_read_permission('caja') OR
      public.has_tms_read_permission('caja-gastos') OR public.has_tms_read_permission('caja-liquidaciones'))));
CREATE POLICY expenses_finance_write ON public.expense_records FOR ALL TO authenticated
  USING (public.is_tms_admin() OR (NOT public.is_contract_administrator() AND
    (public.has_tms_permission('caja-gastos') OR public.has_tms_permission('caja-liquidaciones'))))
  WITH CHECK (public.is_tms_admin() OR (NOT public.is_contract_administrator() AND
    (public.has_tms_permission('caja-gastos') OR public.has_tms_permission('caja-liquidaciones'))));

-- The shared client directory is independent of contract ownership. Preserve
-- current global writes for the legacy `clientes` permission, with explicit
-- operations so a future `clientes:read` grant remains read-only.
DROP POLICY IF EXISTS clients_read ON public.clients;
DROP POLICY IF EXISTS clients_write ON public.clients;
CREATE POLICY clients_read ON public.clients FOR SELECT TO authenticated
  USING (public.has_tms_read_permission('clientes') OR
    public.has_tms_read_permission('solicitudes') OR public.has_tms_read_permission('despacho'));
CREATE POLICY clients_insert ON public.clients FOR INSERT TO authenticated
  WITH CHECK (public.has_tms_permission('clientes'));
CREATE POLICY clients_update ON public.clients FOR UPDATE TO authenticated
  USING (public.has_tms_permission('clientes')) WITH CHECK (public.has_tms_permission('clientes'));
CREATE POLICY clients_delete ON public.clients FOR DELETE TO authenticated
  USING (public.has_tms_permission('clientes'));

-- The former owner-executed view bypassed the row policies above.
ALTER VIEW public.vw_contracts_dashboard SET (security_invoker = true);
UPDATE public.roles SET permissions = permissions || '["torre-control:read"]'::jsonb
  WHERE name='Administrador de Contratos' AND NOT permissions ? 'torre-control:read';
NOTIFY pgrst, 'reload schema';
