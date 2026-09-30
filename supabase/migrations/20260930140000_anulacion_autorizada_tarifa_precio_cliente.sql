-- ============================================================
-- 1. Anulación de gastos de OT solo por el Administrador o el Jefe de Distribución
-- 2. Tarifario de Transporte: el monto cargado es el precio al cliente (con IGV); el costo JRM es el 80 %
-- ============================================================
--  * Solo anula quien tiene el rol Administrador o Jefe de Distribución. Otro usuario de Servicios de Contrato
--    puede anular si el Administrador o el Jefe de Distribución lo autoriza con su credencial; la verificación de
--    la credencial la hace el servidor (/api/contratos/anular-servicio) y aquí se registra quién lo pidió
--    (void_requested_by) y quién autorizó (voided_by).
--  * Las tarifas cargadas hasta hoy tienen en "costo" el precio al cliente con IGV. Se pasa ese valor a
--    client_price y el costo (rate) queda en el 80 % (20 % menos). Solo en tarifas sin precio al cliente registrado.
BEGIN;

-- ------------------------------------------------------------
-- 1. Anulación autorizada
-- ------------------------------------------------------------
ALTER TABLE public.contract_services
  ADD COLUMN IF NOT EXISTS void_requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.can_void_contract_service()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
    WHERE p.id = auth.uid() AND p.is_active AND r.name IN ('Administrador', 'Jefe de Distribución'));
$$;

DROP FUNCTION IF EXISTS public.void_contract_service(uuid, text);
CREATE OR REPLACE FUNCTION public.void_contract_service(p_service_id uuid, p_reason text, p_requested_by uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s record;
BEGIN
  IF NOT public.can_void_contract_service() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el Administrador o el Jefe de Distribución anulan gastos de contrato');
  END IF;
  IF NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo de la anulación');
  END IF;
  SELECT id, amount_pen, contract_id, dispatch_id, status, COALESCE(budget_contract_id, contract_id) AS owner INTO s
    FROM public.contract_services WHERE id = p_service_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'El gasto no existe'); END IF;
  IF COALESCE(s.status, '') = 'ANULADO' THEN RETURN jsonb_build_object('success', false, 'error', 'El gasto ya está anulado'); END IF;
  IF s.dispatch_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Este costo viene de un despacho: se corrige desde Despacho o Caja');
  END IF;
  IF COALESCE(s.status, '') IN ('FACTURADO', 'PAGADO') AND NOT public.is_tms_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'El gasto ya está ' || s.status || '; solo el Administrador lo anula');
  END IF;
  UPDATE public.contract_budgets SET consumed_pen = GREATEST(consumed_pen - s.amount_pen, 0), updated_at = now()
  WHERE contract_id = s.owner AND concept = 'PARTIDA_TRANSPORTE';
  UPDATE public.contract_services SET status = 'ANULADO', void_reason = trim(p_reason), voided_by = auth.uid(), voided_at = now(),
    void_requested_by = COALESCE(p_requested_by, auth.uid())
  WHERE id = p_service_id;
  RETURN jsonb_build_object('success', true);
END $$;

REVOKE ALL ON FUNCTION public.can_void_contract_service(), public.void_contract_service(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_void_contract_service(), public.void_contract_service(uuid, text, uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 2. Tarifas: precio al cliente (con IGV) y costo JRM al 80 %
-- ------------------------------------------------------------
-- El trigger de sellado exige distrito en fletes; tarifas antiguas sin distrito no deben frenar esta corrección
ALTER TABLE public.freight_rates DISABLE TRIGGER freight_rates_stamp;
UPDATE public.freight_rates
SET client_price = rate, rate = round(rate * 0.80, 2)
WHERE client_price IS NULL AND rate > 0;
ALTER TABLE public.freight_rates ENABLE TRIGGER freight_rates_stamp;

COMMENT ON COLUMN public.freight_rates.rate IS 'Costo JRM (S/): por defecto el 80 % del precio al cliente';
COMMENT ON COLUMN public.freight_rates.client_price IS 'Precio al cliente con IGV (S/)';

NOTIFY pgrst, 'reload schema';
COMMIT;
