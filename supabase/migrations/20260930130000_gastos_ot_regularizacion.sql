-- ============================================================
-- CONTRATOS — Regularización de gastos de OT, subcontrato o error (montacargas, grúa, estiba, otros)
-- ============================================================
--  * El gasto queda en el historial de la OT (contract_services) con el contrato exacto (OT, subcontrato o error).
--  * Descuenta la partida de transporte: la del propio contrato si tiene, si no la del contrato madre más cercano
--    que la tenga (los subcontratos y errores normalmente no tienen partida propia). Antes fallaba con
--    "Partida de transporte no encontrada".
--  * Se guarda qué partida se consumió (budget_contract_id) para que editar o anular el gasto ajuste esa misma.
--  * Un gasto manual se puede anular con motivo: devuelve el monto a la partida y queda en el historial como ANULADO.
BEGIN;

ALTER TABLE public.contract_services
  ADD COLUMN IF NOT EXISTS budget_contract_id uuid REFERENCES public.contracts(id),
  ADD COLUMN IF NOT EXISTS void_reason text,
  ADD COLUMN IF NOT EXISTS voided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS voided_at timestamptz;

-- Contrato cuya partida de transporte se consume: el propio o el ancestro más cercano que tenga partida
CREATE OR REPLACE FUNCTION public.contract_budget_owner(p_contract_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH RECURSIVE up AS (
    SELECT c.id, c.parent_contract_id, 0 AS depth FROM public.contracts c WHERE c.id = p_contract_id
    UNION ALL
    SELECT c.id, c.parent_contract_id, up.depth + 1 FROM public.contracts c JOIN up ON c.id = up.parent_contract_id WHERE up.depth < 16
  )
  SELECT up.id FROM up
  WHERE EXISTS (SELECT 1 FROM public.contract_budgets b WHERE b.contract_id = up.id AND b.concept = 'PARTIDA_TRANSPORTE')
  ORDER BY up.depth LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.register_contract_service(
  p_contract_id uuid, p_service_type varchar, p_description text,
  p_amount_pen numeric, p_service_date date, p_plate varchar DEFAULT NULL,
  p_driver_name varchar DEFAULT NULL, p_hours numeric DEFAULT NULL,
  p_provider_ruc varchar DEFAULT NULL, p_provider_name varchar DEFAULT NULL,
  p_category varchar DEFAULT 'Contrato', p_referral_guide text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b public.contract_budgets%ROWTYPE; v_owner uuid;
BEGIN
  IF NOT (public.has_tms_permission('clientes') OR public.has_tms_permission('contratos-servicios')) THEN
    RAISE EXCEPTION 'Sin permiso para registrar servicios de contrato';
  END IF;
  IF p_contract_id IS NULL OR p_service_type IS NULL OR p_amount_pen IS NULL OR p_amount_pen < 0 THEN
    RAISE EXCEPTION 'Datos de servicio inválidos';
  END IF;
  IF public.is_contract_administrator() AND NOT public.has_assigned_contract(p_contract_id, true) THEN
    RAISE EXCEPTION 'OT no asignada';
  END IF;
  v_owner := public.contract_budget_owner(p_contract_id);
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'La OT no tiene partida de transporte: asígnela en el contrato madre antes de registrar gastos';
  END IF;
  SELECT * INTO b FROM public.contract_budgets WHERE contract_id = v_owner AND concept = 'PARTIDA_TRANSPORTE' FOR UPDATE;
  -- Sin saldo no se consume (el Administrador puede registrar históricos que exceden, queda visible en negativo)
  IF p_amount_pen > COALESCE(b.balance_pen, 0) AND NOT public.is_tms_admin() THEN
    RAISE EXCEPTION 'Saldo insuficiente en la partida de transporte: disponible S/ %, requerido S/ %. Amplíe la partida.',
      COALESCE(b.balance_pen, 0), p_amount_pen;
  END IF;
  INSERT INTO public.contract_services (
    contract_id, service_type, description, amount_pen, service_date,
    plate, driver_name, hours, provider_ruc, provider_name, category,
    referral_guide, created_by, budget_contract_id
  ) VALUES (
    p_contract_id, p_service_type, p_description, p_amount_pen,
    COALESCE(p_service_date, current_date), p_plate, p_driver_name, p_hours,
    p_provider_ruc, p_provider_name, p_category, p_referral_guide, auth.uid(), v_owner
  );
  UPDATE public.contract_budgets SET consumed_pen = consumed_pen + p_amount_pen, updated_at = now() WHERE id = b.id;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.update_contract_service_amount(p_service_id uuid, p_new_amount numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s        record;
  b        public.contract_budgets%ROWTYPE;
  v_open   boolean := false;
  v_delta  numeric;
BEGIN
  IF NOT (public.has_tms_permission('clientes') OR public.has_tms_permission('contratos-servicios')) THEN
    RAISE EXCEPTION 'Sin permiso para editar servicios de contrato';
  END IF;
  IF p_new_amount IS NULL OR p_new_amount < 0 THEN
    RAISE EXCEPTION 'Monto inválido';
  END IF;
  SELECT id, amount_pen, contract_id, service_type, dispatch_id, status,
         COALESCE(budget_contract_id, contract_id) AS owner INTO s
    FROM public.contract_services WHERE id = p_service_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El servicio no existe'; END IF;
  IF COALESCE(s.status, '') = 'ANULADO' THEN RAISE EXCEPTION 'El servicio está anulado'; END IF;
  IF public.is_contract_administrator() AND NOT public.has_assigned_contract(s.contract_id, true) THEN
    RAISE EXCEPTION 'OT no asignada';
  END IF;
  v_delta := p_new_amount - s.amount_pen;
  SELECT * INTO b FROM public.contract_budgets WHERE contract_id = s.owner AND concept = 'PARTIDA_TRANSPORTE' FOR UPDATE;
  IF v_delta > 0 AND v_delta > COALESCE(b.balance_pen, 0) AND NOT public.is_tms_admin() THEN
    RAISE EXCEPTION 'Saldo insuficiente en la partida de transporte: disponible S/ %', COALESCE(b.balance_pen, 0);
  END IF;
  -- El FLETE de un despacho aún abierto está reservado (no consumido): se ajusta la reserva y el flete del despacho
  IF s.service_type = 'FLETE' AND s.dispatch_id IS NOT NULL THEN
    SELECT status NOT IN ('LIQUIDADO', 'CERRADO', 'CANCELADO') INTO v_open FROM public.dispatches WHERE id = s.dispatch_id;
  END IF;
  UPDATE public.contract_services SET amount_pen = p_new_amount WHERE id = p_service_id;
  IF COALESCE(v_open, false) THEN
    UPDATE public.dispatches SET freight_cost = p_new_amount WHERE id = s.dispatch_id;
    UPDATE public.contract_budgets SET reserved_pen = GREATEST(reserved_pen + v_delta, 0), updated_at = now() WHERE id = b.id;
  ELSE
    UPDATE public.contract_budgets SET consumed_pen = consumed_pen + v_delta, updated_at = now() WHERE id = b.id;
  END IF;
  RETURN true;
END $$;

-- Anular un gasto registrado a mano: devuelve el monto a la partida que consumió y queda en el historial
CREATE OR REPLACE FUNCTION public.void_contract_service(p_service_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s record;
BEGIN
  IF NOT (public.has_tms_permission('clientes') OR public.has_tms_permission('contratos-servicios')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para anular gastos de contrato');
  END IF;
  IF NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo de la anulación');
  END IF;
  SELECT id, amount_pen, contract_id, dispatch_id, status, COALESCE(budget_contract_id, contract_id) AS owner INTO s
    FROM public.contract_services WHERE id = p_service_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'El gasto no existe'); END IF;
  IF public.is_contract_administrator() AND NOT public.has_assigned_contract(s.contract_id, true) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT no asignada');
  END IF;
  IF COALESCE(s.status, '') = 'ANULADO' THEN RETURN jsonb_build_object('success', false, 'error', 'El gasto ya está anulado'); END IF;
  IF s.dispatch_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Este costo viene de un despacho: se corrige desde Despacho o Caja');
  END IF;
  IF COALESCE(s.status, '') IN ('FACTURADO', 'PAGADO') AND NOT public.is_tms_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'El gasto ya está ' || s.status || '; solo el Administrador lo anula');
  END IF;
  UPDATE public.contract_budgets SET consumed_pen = GREATEST(consumed_pen - s.amount_pen, 0), updated_at = now()
  WHERE contract_id = s.owner AND concept = 'PARTIDA_TRANSPORTE';
  UPDATE public.contract_services SET status = 'ANULADO', void_reason = trim(p_reason), voided_by = auth.uid(), voided_at = now()
  WHERE id = p_service_id;
  RETURN jsonb_build_object('success', true);
END $$;

REVOKE ALL ON FUNCTION public.contract_budget_owner(uuid), public.void_contract_service(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.contract_budget_owner(uuid), public.void_contract_service(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_contract_service(uuid,varchar,text,numeric,date,varchar,varchar,numeric,varchar,varchar,varchar,text),
  public.update_contract_service_amount(uuid,numeric) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
