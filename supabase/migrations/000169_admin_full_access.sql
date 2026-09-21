BEGIN;

-- Keep the role listing aligned with the Administrator's server-side bypass.
UPDATE public.roles SET permissions = '[
  "dashboard", "clientes", "ot", "contratos-servicios", "solicitudes",
  "torre-control", "despacho", "monitoreo", "operaciones-live",
  "operaciones-revision", "servicios-realizados", "operaciones-kpis", "reportes",
  "mantenimiento-dashboard", "mantenimiento-flota", "mantenimiento-vencimientos",
  "mantenimiento-fallas", "mantenimiento-ot", "mantenimiento-planes",
  "caja", "caja-fondos", "caja-gastos", "caja-liquidaciones",
  "maestros-trabajadores", "flota", "tarifas", "productos",
  "usuarios", "permisos", "configuracion"
]'::jsonb WHERE name = 'Administrador';

-- Some modules had RLS enabled with no policy at all. Every current public
-- table gets an administrative policy without changing ordinary user policies.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT n.nspname, c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tms_admin_full_access ON %I.%I', t.nspname, t.relname);
    EXECUTE format('CREATE POLICY tms_admin_full_access ON %I.%I FOR ALL TO authenticated USING (public.is_tms_admin()) WITH CHECK (public.is_tms_admin())', t.nspname, t.relname);
  END LOOP;
END $$;

DROP POLICY IF EXISTS tms_admin_full_access ON storage.objects;
CREATE POLICY tms_admin_full_access ON storage.objects FOR ALL TO authenticated
  USING (public.is_tms_admin()) WITH CHECK (public.is_tms_admin());
DROP POLICY IF EXISTS tms_admin_full_access ON storage.buckets;
CREATE POLICY tms_admin_full_access ON storage.buckets FOR ALL TO authenticated
  USING (public.is_tms_admin()) WITH CHECK (public.is_tms_admin());

-- The contract service screen still calls these RPCs. Restore access only for
-- authorized contract staff and validate the financial changes inside SQL.
CREATE OR REPLACE FUNCTION public.register_contract_service(
  p_contract_id uuid, p_service_type varchar, p_description text,
  p_amount_pen numeric, p_service_date date, p_plate varchar DEFAULT NULL,
  p_driver_name varchar DEFAULT NULL, p_hours numeric DEFAULT NULL,
  p_provider_ruc varchar DEFAULT NULL, p_provider_name varchar DEFAULT NULL,
  p_category varchar DEFAULT 'Contrato', p_referral_guide text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_budget_id uuid;
BEGIN
  IF NOT (public.has_tms_permission('clientes') OR public.has_tms_permission('contratos-servicios')) THEN
    RAISE EXCEPTION 'Sin permiso para registrar servicios de contrato';
  END IF;
  IF p_contract_id IS NULL OR p_service_type IS NULL OR p_amount_pen IS NULL OR p_amount_pen < 0 THEN
    RAISE EXCEPTION 'Datos de servicio inválidos';
  END IF;
  SELECT id INTO v_budget_id FROM public.contract_budgets
    WHERE contract_id = p_contract_id AND concept = 'PARTIDA_TRANSPORTE' FOR UPDATE;
  IF v_budget_id IS NULL THEN RAISE EXCEPTION 'Partida de transporte no encontrada'; END IF;
  INSERT INTO public.contract_services (
    contract_id, service_type, description, amount_pen, service_date,
    plate, driver_name, hours, provider_ruc, provider_name, category,
    referral_guide, created_by
  ) VALUES (
    p_contract_id, p_service_type, p_description, p_amount_pen,
    coalesce(p_service_date, current_date), p_plate, p_driver_name, p_hours,
    p_provider_ruc, p_provider_name, p_category, p_referral_guide, auth.uid()
  );
  UPDATE public.contract_budgets SET consumed_pen = consumed_pen + p_amount_pen,
    updated_at = now() WHERE id = v_budget_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.register_contract_service(uuid,varchar,text,numeric,date,varchar,varchar,numeric,varchar,varchar,varchar,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_contract_service(uuid,varchar,text,numeric,date,varchar,varchar,numeric,varchar,varchar,varchar,text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.update_contract_service_amount(p_service_id uuid, p_new_amount numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_old_amount numeric;
DECLARE v_contract_id uuid;
BEGIN
  IF NOT (public.has_tms_permission('clientes') OR public.has_tms_permission('contratos-servicios')) THEN
    RAISE EXCEPTION 'Sin permiso para editar servicios de contrato';
  END IF;
  IF p_new_amount IS NULL OR p_new_amount < 0 THEN
    RAISE EXCEPTION 'Monto inválido';
  END IF;
  SELECT amount_pen, contract_id INTO v_old_amount, v_contract_id
    FROM public.contract_services WHERE id = p_service_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El servicio no existe'; END IF;
  UPDATE public.contract_services SET amount_pen = p_new_amount WHERE id = p_service_id;
  UPDATE public.contract_budgets SET consumed_pen = consumed_pen + p_new_amount - v_old_amount,
    updated_at = now() WHERE contract_id = v_contract_id AND concept = 'PARTIDA_TRANSPORTE';
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.update_contract_service_amount(uuid,numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_contract_service_amount(uuid,numeric) TO authenticated;

COMMIT;
