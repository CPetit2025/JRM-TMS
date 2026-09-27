-- 20260927120000_f4_ordenes_trabajo.sql
-- FASE 4 — Gestor de Órdenes de Trabajo.
--
-- * Máquina de estados BORRADOR → APROBADA → PROGRAMADA → EN_PROCESO ⇄ EN_ESPERA → TERMINADA
--   → VALIDACION → CERRADA (CANCELADA desde estados no finales), solo vía RPC.
-- * Indisponibilidad real: downtime_start al iniciar (o desde la falla crítica que bloqueó la
--   unidad) y downtime_end al cerrar/cancelar; downtime_hours derivado.
-- * Libro único de costos: work_order_costs (MANO_OBRA, REPUESTOS, SERVICIOS, OTROS). Los
--   totales de la OT se derivan por trigger; una OT cerrada/cancelada no admite cambios de costo.
-- * Consumo de repuestos por RPC al usarse, con UNA sola ruta de descuento de stock
--   (antes se descontaba dos veces) y sin stock negativo.
-- * Cierre: exige TERMINADA/VALIDACION, cierra las fallas de origen, actualiza el plan y
--   libera la unidad solo si el motor no la declara NO_APTO (APTO_CON_OBSERVACION libera).
-- * Cierre de despacho: si la unidad no es elegible queda OBSERVADA (antes quedaba EN_OPERACION).
-- * RLS: se eliminan las políticas "todo permitido" de repuestos, movimientos y consumos.

BEGIN;

-- ------------------------------------------------------------
-- 1. Esquema de OT
-- ------------------------------------------------------------
ALTER TABLE public.maintenance_work_orders
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS validated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS validated_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_reason text,
  ADD COLUMN IF NOT EXISTS release_result jsonb;

ALTER TABLE public.maintenance_work_orders ALTER COLUMN downtime_hours TYPE numeric(10,2);
ALTER TABLE public.maintenance_work_orders ALTER COLUMN status SET DEFAULT 'BORRADOR';
ALTER TABLE public.maintenance_work_orders ALTER COLUMN priority SET DEFAULT 'NORMAL';

UPDATE public.maintenance_work_orders SET priority = 'NORMAL' WHERE priority IS NULL OR priority NOT IN ('BAJA', 'NORMAL', 'ALTA', 'CRITICA');
UPDATE public.maintenance_work_orders SET order_type = CASE WHEN type = 'PREVENTIVO' THEN 'PREVENTIVA' ELSE 'CORRECTIVA' END
WHERE order_type IS NULL;

ALTER TABLE public.maintenance_work_orders DROP CONSTRAINT IF EXISTS maintenance_work_orders_priority_check;
ALTER TABLE public.maintenance_work_orders ADD CONSTRAINT maintenance_work_orders_priority_check
  CHECK (priority IN ('BAJA', 'NORMAL', 'ALTA', 'CRITICA'));
ALTER TABLE public.maintenance_work_orders ALTER COLUMN order_type SET NOT NULL;

-- ------------------------------------------------------------
-- 2. Sellos de ciclo de vida + guard
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_update_ot_downtime ON public.maintenance_work_orders;
DROP FUNCTION IF EXISTS public.update_ot_downtime();

CREATE OR REPLACE FUNCTION public.work_order_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Diagnóstico canónico = diagnostic (diagnosis se mantiene sincronizado por compatibilidad)
  IF TG_OP = 'INSERT' THEN
    NEW.diagnostic := COALESCE(NEW.diagnostic, NEW.diagnosis);
  ELSIF NEW.diagnosis IS DISTINCT FROM OLD.diagnosis AND NEW.diagnostic IS NOT DISTINCT FROM OLD.diagnostic THEN
    NEW.diagnostic := NEW.diagnosis;
  END IF;
  NEW.diagnosis := NEW.diagnostic;

  NEW.order_type := COALESCE(NEW.order_type,
    CASE WHEN upper(COALESCE(NEW.type, '')) LIKE 'PREVENT%' THEN 'PREVENTIVA' ELSE 'CORRECTIVA' END);
  NEW.updated_at := now();

  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.status := 'BORRADOR';
      NEW.approved_by := NULL; NEW.approved_at := NULL;
      NEW.downtime_start := NULL; NEW.downtime_end := NULL;
      NEW.closed_at := NULL; NEW.closed_by := NULL;
    ELSIF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.downtime_start IS DISTINCT FROM OLD.downtime_start
       OR NEW.downtime_end IS DISTINCT FROM OLD.downtime_end
       OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
       OR NEW.labor_cost IS DISTINCT FROM OLD.labor_cost
       OR NEW.parts_cost IS DISTINCT FROM OLD.parts_cost
       OR NEW.services_cost IS DISTINCT FROM OLD.services_cost
       OR NEW.total_cost IS DISTINCT FROM OLD.total_cost THEN
      RAISE EXCEPTION 'Estado, aprobación, tiempos y costos de la OT solo cambian por RPC (transition_work_order, work_order_costs)'
        USING ERRCODE = '42501';
    ELSIF OLD.status IN ('CERRADA', 'CANCELADA') THEN
      RAISE EXCEPTION 'La OT % está % y no admite cambios', OLD.ot_code, OLD.status USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.downtime_start IS NOT NULL AND NEW.downtime_end IS NOT NULL THEN
    NEW.downtime_hours := round((extract(epoch FROM NEW.downtime_end - NEW.downtime_start) / 3600.0)::numeric, 2);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_work_order_lifecycle ON public.maintenance_work_orders;
CREATE TRIGGER trg_work_order_lifecycle
BEFORE INSERT OR UPDATE ON public.maintenance_work_orders
FOR EACH ROW EXECUTE FUNCTION public.work_order_lifecycle();

-- ------------------------------------------------------------
-- 3. Libro único de costos
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_update_wo_cost_self ON public.maintenance_work_orders;
DROP TRIGGER IF EXISTS trg_update_wo_cost_from_inventory ON public.inventory_transactions;
DROP FUNCTION IF EXISTS public.update_work_order_total_cost();

UPDATE public.work_order_costs SET cost_type = CASE upper(COALESCE(cost_type, 'OTROS'))
  WHEN 'REPUESTO' THEN 'REPUESTOS' WHEN 'SERVICIO' THEN 'SERVICIOS' WHEN 'LABOR' THEN 'MANO_OBRA'
  WHEN 'MANO DE OBRA' THEN 'MANO_OBRA' ELSE upper(COALESCE(cost_type, 'OTROS')) END;
ALTER TABLE public.work_order_costs DROP CONSTRAINT IF EXISTS work_order_costs_cost_type_check;
ALTER TABLE public.work_order_costs ADD CONSTRAINT work_order_costs_cost_type_check
  CHECK (cost_type IN ('MANO_OBRA', 'REPUESTOS', 'SERVICIOS', 'OTROS'));
ALTER TABLE public.work_order_costs ALTER COLUMN work_order_id SET NOT NULL;
ALTER TABLE public.work_order_costs DROP CONSTRAINT IF EXISTS work_order_costs_amount_check;
ALTER TABLE public.work_order_costs ADD CONSTRAINT work_order_costs_amount_check CHECK (amount >= 0);
ALTER TABLE public.work_order_costs DROP CONSTRAINT IF EXISTS work_order_costs_work_order_id_fkey;
ALTER TABLE public.work_order_costs ADD CONSTRAINT work_order_costs_work_order_id_fkey
  FOREIGN KEY (work_order_id) REFERENCES public.maintenance_work_orders(id) ON DELETE CASCADE;
ALTER TABLE public.work_order_costs ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_work_order_costs_wo ON public.work_order_costs(work_order_id);

CREATE OR REPLACE FUNCTION public.guard_work_order_costs()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_row    public.work_order_costs%ROWTYPE := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
BEGIN
  SELECT status INTO v_status FROM public.maintenance_work_orders WHERE id = v_row.work_order_id;
  IF v_status IN ('CERRADA', 'CANCELADA') THEN
    RAISE EXCEPTION 'La OT está % y no admite cambios de costo', v_status USING ERRCODE = '42501';
  END IF;
  -- Los repuestos afectan stock: solo entran por consume_work_order_part()
  IF current_user IN ('authenticated', 'anon')
     AND ((TG_OP <> 'INSERT' AND OLD.cost_type = 'REPUESTOS') OR (TG_OP <> 'DELETE' AND NEW.cost_type = 'REPUESTOS')) THEN
    RAISE EXCEPTION 'Los repuestos se registran con consume_work_order_part()' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := COALESCE(NEW.created_by, auth.uid());
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_work_order_costs ON public.work_order_costs;
CREATE TRIGGER trg_guard_work_order_costs
BEFORE INSERT OR UPDATE OR DELETE ON public.work_order_costs
FOR EACH ROW EXECUTE FUNCTION public.guard_work_order_costs();

CREATE OR REPLACE FUNCTION public.recalc_work_order_costs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wo uuid := COALESCE(NEW.work_order_id, OLD.work_order_id);
BEGIN
  UPDATE public.maintenance_work_orders wo SET
    labor_cost    = c.labor,
    parts_cost    = c.parts,
    services_cost = c.services,
    total_cost    = c.labor + c.parts + c.services + c.others
  FROM (
    SELECT COALESCE(sum(amount) FILTER (WHERE cost_type = 'MANO_OBRA'), 0) AS labor,
           COALESCE(sum(amount) FILTER (WHERE cost_type = 'REPUESTOS'), 0) AS parts,
           COALESCE(sum(amount) FILTER (WHERE cost_type = 'SERVICIOS'), 0) AS services,
           COALESCE(sum(amount) FILTER (WHERE cost_type = 'OTROS'), 0)     AS others
    FROM public.work_order_costs WHERE work_order_id = v_wo
  ) c
  WHERE wo.id = v_wo;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_recalc_work_order_costs ON public.work_order_costs;
CREATE TRIGGER trg_recalc_work_order_costs
AFTER INSERT OR UPDATE OR DELETE ON public.work_order_costs
FOR EACH ROW EXECUTE FUNCTION public.recalc_work_order_costs();

-- ------------------------------------------------------------
-- 4. Inventario: una sola ruta de stock, sin negativos
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_work_order_completion ON public.maintenance_work_orders;
DROP FUNCTION IF EXISTS public.process_work_order_completion();

ALTER TABLE public.inventory_transactions ALTER COLUMN quantity TYPE numeric(12,2);
ALTER TABLE public.inventory_transactions ALTER COLUMN date SET DEFAULT now();

CREATE OR REPLACE FUNCTION public.normalize_inventory_transaction()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.spare_part_id := COALESCE(NEW.spare_part_id, NEW.part_id);
  NEW.part_id := NEW.spare_part_id;
  NEW.type := COALESCE(NEW.type, CASE upper(NEW.transaction_type) WHEN 'IN' THEN 'INGRESO' WHEN 'OUT' THEN 'SALIDA'
                                                              WHEN 'ADJUST' THEN 'AJUSTE' ELSE upper(NEW.transaction_type) END);
  NEW.transaction_type := CASE NEW.type WHEN 'INGRESO' THEN 'IN' WHEN 'SALIDA' THEN 'OUT' ELSE 'ADJUST' END;
  NEW.work_order_reference := COALESCE(NEW.work_order_reference, NEW.reference_id);
  NEW.reference_id := COALESCE(NEW.reference_id, NEW.work_order_reference);
  NEW.created_by := COALESCE(NEW.created_by, auth.uid());
  IF NEW.spare_part_id IS NULL OR NEW.type IS NULL THEN
    RAISE EXCEPTION 'Movimiento de inventario sin repuesto o tipo';
  END IF;
  IF NEW.type IN ('INGRESO', 'SALIDA') AND NEW.quantity <= 0 THEN
    RAISE EXCEPTION 'La cantidad debe ser positiva';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_inventory_transaction ON public.inventory_transactions;
CREATE TRIGGER trg_normalize_inventory_transaction
BEFORE INSERT ON public.inventory_transactions
FOR EACH ROW EXECUTE FUNCTION public.normalize_inventory_transaction();

CREATE OR REPLACE FUNCTION public.update_stock_from_inventory_transaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stock numeric;
  v_delta numeric;
BEGIN
  SELECT COALESCE(current_stock, 0) INTO v_stock FROM public.spare_parts WHERE id = NEW.spare_part_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Repuesto inexistente: %', NEW.spare_part_id;
  END IF;
  v_delta := CASE NEW.type WHEN 'INGRESO' THEN NEW.quantity WHEN 'SALIDA' THEN -NEW.quantity ELSE NEW.quantity END;
  IF v_stock + v_delta < 0 THEN
    RAISE EXCEPTION 'Stock insuficiente: disponible %, solicitado %', v_stock, abs(v_delta) USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.spare_parts SET current_stock = v_stock + v_delta, updated_at = now() WHERE id = NEW.spare_part_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_inventory_transaction_stock ON public.inventory_transactions;
CREATE TRIGGER trigger_inventory_transaction_stock
AFTER INSERT ON public.inventory_transactions
FOR EACH ROW EXECUTE FUNCTION public.update_stock_from_inventory_transaction();

-- Movimientos inmutables: se corrigen con un AJUSTE, nunca editando o borrando
CREATE OR REPLACE FUNCTION public.forbid_inventory_transaction_changes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Los movimientos de inventario son inmutables; registre un AJUSTE' USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS trg_forbid_inventory_transaction_changes ON public.inventory_transactions;
CREATE TRIGGER trg_forbid_inventory_transaction_changes
BEFORE UPDATE OR DELETE ON public.inventory_transactions
FOR EACH ROW EXECUTE FUNCTION public.forbid_inventory_transaction_changes();

CREATE OR REPLACE FUNCTION public.consume_work_order_part(
  p_work_order_id uuid,
  p_spare_part_id uuid,
  p_quantity      numeric,
  p_notes         text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wo    public.maintenance_work_orders%ROWTYPE;
  v_part  public.spare_parts%ROWTYPE;
  v_cost  numeric;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_cmms_permission('ot') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para registrar consumos');
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cantidad inválida');
  END IF;

  SELECT * INTO v_wo FROM public.maintenance_work_orders WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT no encontrada');
  END IF;
  IF v_wo.status NOT IN ('APROBADA', 'PROGRAMADA', 'EN_PROCESO', 'EN_ESPERA', 'TERMINADA', 'VALIDACION') THEN
    RETURN jsonb_build_object('success', false, 'error', 'No se consumen repuestos en una OT ' || v_wo.status);
  END IF;
  IF auth.uid() IS NOT NULL AND NOT public.can_access_site(v_wo.site_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT fuera de su sede');
  END IF;

  SELECT * INTO v_part FROM public.spare_parts WHERE id = p_spare_part_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Repuesto no encontrado');
  END IF;
  v_cost := round(COALESCE(NULLIF(v_part.average_price_pen, 0), v_part.unit_price, 0) * p_quantity, 2);

  BEGIN
    INSERT INTO public.inventory_transactions (spare_part_id, type, quantity, total_cost, reference_document, work_order_reference, created_by)
    VALUES (p_spare_part_id, 'SALIDA', p_quantity, v_cost, 'OT ' || v_wo.ot_code, p_work_order_id, auth.uid());
  EXCEPTION WHEN raise_exception THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
  END;

  INSERT INTO public.work_order_spare_parts (work_order_id, spare_part_id, quantity, unit_cost)
  VALUES (p_work_order_id, p_spare_part_id, p_quantity, CASE WHEN p_quantity > 0 THEN round(v_cost / p_quantity, 4) ELSE 0 END);

  INSERT INTO public.work_order_costs (work_order_id, cost_type, amount, quantity, spare_part_id, description, created_by)
  VALUES (p_work_order_id, 'REPUESTOS', v_cost, p_quantity, p_spare_part_id,
          COALESCE(v_part.name, 'Repuesto') || COALESCE(' — ' || p_notes, ''), auth.uid());

  RETURN jsonb_build_object('success', true, 'amount', v_cost,
    'stock_remaining', (SELECT current_stock FROM public.spare_parts WHERE id = p_spare_part_id));
END;
$$;

REVOKE ALL ON FUNCTION public.consume_work_order_part(uuid, uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_work_order_part(uuid, uuid, numeric, text) TO authenticated, service_role;

-- RLS: fuera las políticas "todo permitido"
DROP POLICY IF EXISTS "Enable all for authenticated users on spare_parts" ON public.spare_parts;
DROP POLICY IF EXISTS "Enable all for authenticated on inventory_transactions" ON public.inventory_transactions;
DROP POLICY IF EXISTS "Enable all for authenticated users on inventory_transactions" ON public.inventory_transactions;
DROP POLICY IF EXISTS "Enable all for authenticated users on work_order_spare_parts" ON public.work_order_spare_parts;

ALTER TABLE public.inventory_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inv_tx_read ON public.inventory_transactions;
CREATE POLICY inv_tx_read ON public.inventory_transactions FOR SELECT TO authenticated USING (
  public.is_tms_admin() OR EXISTS (
    SELECT 1 FROM public.spare_parts sp
    WHERE sp.id = inventory_transactions.spare_part_id
      AND public.can_access_site(sp.site_id) AND public.has_cmms_read_permission('ot')));
DROP POLICY IF EXISTS inv_tx_admin ON public.inventory_transactions;
CREATE POLICY inv_tx_admin ON public.inventory_transactions FOR INSERT TO authenticated WITH CHECK (public.is_tms_admin());

ALTER TABLE public.work_order_spare_parts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wosp_read ON public.work_order_spare_parts;
CREATE POLICY wosp_read ON public.work_order_spare_parts FOR SELECT TO authenticated USING (
  public.is_tms_admin() OR EXISTS (
    SELECT 1 FROM public.maintenance_work_orders wo
    WHERE wo.id = work_order_spare_parts.work_order_id
      AND public.can_access_site(wo.site_id) AND public.has_cmms_read_permission('ot')));

ALTER TABLE public.work_order_costs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS woc_read ON public.work_order_costs;
CREATE POLICY woc_read ON public.work_order_costs FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.maintenance_work_orders wo
          WHERE wo.id = work_order_costs.work_order_id
            AND public.can_access_site(wo.site_id) AND public.has_cmms_read_permission('ot')));
DROP POLICY IF EXISTS woc_write ON public.work_order_costs;
CREATE POLICY woc_write ON public.work_order_costs FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.maintenance_work_orders wo
               WHERE wo.id = work_order_costs.work_order_id
                 AND public.can_access_site(wo.site_id) AND public.has_cmms_permission('ot')))
WITH CHECK (EXISTS (SELECT 1 FROM public.maintenance_work_orders wo
                    WHERE wo.id = work_order_costs.work_order_id
                      AND public.can_access_site(wo.site_id) AND public.has_cmms_permission('ot')));

-- ------------------------------------------------------------
-- 5. Transiciones de OT
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transition_work_order(
  p_work_order_id uuid,
  p_new_status    text,
  p_notes         text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wo       public.maintenance_work_orders%ROWTYPE;
  v_allowed  text[];
  v_vehicle  public.vehicles%ROWTYPE;
  v_start    timestamptz;
  v_vres     jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_cmms_permission('ot') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para gestionar OT');
  END IF;

  SELECT * INTO v_wo FROM public.maintenance_work_orders WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT no encontrada');
  END IF;
  IF auth.uid() IS NOT NULL AND NOT public.can_access_site(v_wo.site_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT fuera de su sede');
  END IF;
  IF p_new_status = 'CERRADA' THEN
    RETURN jsonb_build_object('success', false, 'error', 'El cierre se realiza con complete_maintenance_order()');
  END IF;

  v_allowed := CASE v_wo.status
    WHEN 'BORRADOR'   THEN ARRAY['APROBADA', 'CANCELADA']
    WHEN 'APROBADA'   THEN ARRAY['PROGRAMADA', 'EN_PROCESO', 'CANCELADA']
    WHEN 'PROGRAMADA' THEN ARRAY['EN_PROCESO', 'CANCELADA']
    WHEN 'EN_PROCESO' THEN ARRAY['EN_ESPERA', 'TERMINADA']
    WHEN 'EN_ESPERA'  THEN ARRAY['EN_PROCESO', 'CANCELADA']
    WHEN 'TERMINADA'  THEN ARRAY['VALIDACION', 'EN_PROCESO']
    WHEN 'VALIDACION' THEN ARRAY['EN_PROCESO']
    ELSE ARRAY[]::text[] END;

  IF NOT (p_new_status = ANY (v_allowed)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transición no permitida: ' || v_wo.status || ' → ' || COALESCE(p_new_status, 'NULL'));
  END IF;
  IF p_new_status = 'CANCELADA' AND NULLIF(trim(p_notes), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cancelar requiere un motivo');
  END IF;
  IF p_new_status = 'PROGRAMADA' AND v_wo.start_date IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Defina la fecha de inicio antes de programar');
  END IF;
  IF p_new_status = 'TERMINADA' AND NULLIF(trim(COALESCE(p_notes, v_wo.activities_performed)), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Registre las actividades realizadas');
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = v_wo.vehicle_id;

  -- Inicio de trabajos ⇒ la unidad sale de servicio y empieza la indisponibilidad
  IF p_new_status = 'EN_PROCESO' AND v_wo.downtime_start IS NULL THEN
    SELECT min(reported_at) INTO v_start FROM public.maintenance_requests
    WHERE work_order_id = v_wo.id AND severity = 'CRITICA';
    v_start := LEAST(COALESCE(v_start, now()), now());
    IF v_vehicle.status NOT IN ('MANTENIMIENTO', 'FUERA_DE_SERVICIO') THEN
      v_vres := public.transition_vehicle_status(v_vehicle.plate, 'MANTENIMIENTO',
                  'Inicio OT ' || v_wo.ot_code, auth.uid(), jsonb_build_object('work_order_id', v_wo.id));
    END IF;
  END IF;

  UPDATE public.maintenance_work_orders SET
    status               = p_new_status,
    approved_by          = CASE WHEN p_new_status = 'APROBADA' THEN auth.uid() ELSE approved_by END,
    approved_at          = CASE WHEN p_new_status = 'APROBADA' THEN now() ELSE approved_at END,
    validated_by         = CASE WHEN p_new_status = 'VALIDACION' THEN auth.uid() ELSE validated_by END,
    validated_at         = CASE WHEN p_new_status = 'VALIDACION' THEN now() ELSE validated_at END,
    downtime_start       = COALESCE(downtime_start, v_start),
    downtime_end         = CASE WHEN p_new_status = 'CANCELADA' AND downtime_start IS NOT NULL THEN now() ELSE downtime_end END,
    activities_performed = CASE WHEN p_new_status = 'TERMINADA' THEN COALESCE(NULLIF(trim(p_notes), ''), activities_performed) ELSE activities_performed END,
    cancel_reason        = CASE WHEN p_new_status = 'CANCELADA' THEN p_notes ELSE cancel_reason END,
    notes                = CASE WHEN p_notes IS NOT NULL AND p_new_status NOT IN ('TERMINADA', 'CANCELADA')
                                THEN concat_ws(E'\n', notes, to_char(now() AT TIME ZONE 'America/Lima', 'DD/MM HH24:MI') || ' ' || p_new_status || ': ' || p_notes)
                                ELSE notes END
  WHERE id = p_work_order_id;

  RETURN jsonb_build_object('success', true, 'previous_status', v_wo.status, 'new_status', p_new_status,
                            'vehicle_transition', v_vres);
END;
$$;

REVOKE ALL ON FUNCTION public.transition_work_order(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transition_work_order(uuid, text, text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 6. Cierre de OT
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.complete_maintenance_order(uuid, jsonb, text);
CREATE FUNCTION public.complete_maintenance_order(
  p_order_id      uuid,
  p_used_parts    jsonb DEFAULT '[]'::jsonb,
  p_closing_notes text  DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wo          public.maintenance_work_orders%ROWTYPE;
  v_vehicle     public.vehicles%ROWTYPE;
  v_part        jsonb;
  v_res         jsonb;
  v_eligibility jsonb;
  v_release     jsonb;
  v_message     text;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_cmms_permission('ot') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para cerrar OT');
  END IF;

  SELECT * INTO v_wo FROM public.maintenance_work_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Orden de trabajo no encontrada');
  END IF;
  IF auth.uid() IS NOT NULL AND NOT public.can_access_site(v_wo.site_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT fuera de su sede');
  END IF;
  IF v_wo.status NOT IN ('TERMINADA', 'VALIDACION') THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Solo se cierra una OT TERMINADA o en VALIDACION (estado actual: ' || v_wo.status || ')');
  END IF;

  -- Repuestos declarados al cierre (misma ruta única de stock)
  FOR v_part IN SELECT * FROM jsonb_array_elements(COALESCE(p_used_parts, '[]'::jsonb)) LOOP
    v_res := public.consume_work_order_part(p_order_id, (v_part->>'part_id')::uuid,
                                            (v_part->>'quantity')::numeric, 'Declarado al cierre');
    IF NOT (v_res->>'success')::boolean THEN
      RAISE EXCEPTION 'No se pudo registrar el repuesto %: %', v_part->>'part_id', v_res->>'error';
    END IF;
  END LOOP;

  UPDATE public.maintenance_work_orders SET
    status          = 'CERRADA',
    closed_at       = now(),
    closed_by       = auth.uid(),
    actual_end_date = COALESCE(actual_end_date, (now() AT TIME ZONE 'America/Lima')::date),
    downtime_end    = CASE WHEN downtime_start IS NOT NULL THEN now() ELSE downtime_end END,
    validated_by    = COALESCE(validated_by, auth.uid()),
    validated_at    = COALESCE(validated_at, now()),
    notes           = concat_ws(E'\n', notes, NULLIF('Cierre: ' || COALESCE(p_closing_notes, ''), 'Cierre: '))
  WHERE id = p_order_id;
  -- (trg_sync_requests_with_work_order cierra las fallas de origen)

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = v_wo.vehicle_id;

  IF v_wo.plan_id IS NOT NULL THEN
    UPDATE public.maintenance_plans SET
      last_performed_date     = (now() AT TIME ZONE 'America/Lima')::date,
      last_performed_km       = v_vehicle.current_odometer,
      last_performed_odometer = v_vehicle.current_odometer,
      last_performed_hours    = v_vehicle.current_hours
    WHERE id = v_wo.plan_id;
  END IF;

  -- Liberación: solo si el motor no declara NO_APTO
  v_eligibility := public.check_asset_eligibility(v_vehicle.plate, 'RELEASE');
  IF v_vehicle.status IN ('MANTENIMIENTO', 'BLOQUEADA', 'OBSERVADA') THEN
    IF v_eligibility->>'status' <> 'NO_APTO' THEN
      v_release := public.transition_vehicle_status(v_vehicle.plate, 'DISPONIBLE',
                     'Cierre OT ' || v_wo.ot_code, auth.uid(), jsonb_build_object('work_order_id', v_wo.id));
      v_message := CASE WHEN COALESCE((v_release->>'success')::boolean, false)
                        THEN 'OT cerrada. Unidad liberada (' || (v_eligibility->>'status') || ').'
                        ELSE 'OT cerrada. No se pudo liberar la unidad: ' || (v_release->>'error') END;
    ELSE
      v_message := 'OT cerrada. La unidad sigue NO_APTO: '
                   || (SELECT string_agg(value, '; ') FROM jsonb_array_elements_text(v_eligibility->'motives'));
    END IF;
  ELSE
    v_message := 'OT cerrada. Estado de la unidad sin cambios (' || v_vehicle.status || ').';
  END IF;

  UPDATE public.maintenance_work_orders
  SET release_result = jsonb_build_object('eligibility', v_eligibility, 'transition', v_release)
  WHERE id = p_order_id;

  RETURN jsonb_build_object('success', true, 'message', v_message,
                            'eligibility', v_eligibility, 'vehicle_transition', v_release);
END;
$$;

REVOKE ALL ON FUNCTION public.complete_maintenance_order(uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_maintenance_order(uuid, jsonb, text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 7. Cierre de despacho: unidad no elegible ⇒ OBSERVADA
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transition_dispatch_status(
  p_dispatch_id uuid, p_new_status text, p_reason text DEFAULT NULL, p_user_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dispatch       public.dispatches%ROWTYPE;
  v_current_status text;
  v_allowed        boolean := false;
  v_release        jsonb;
BEGIN
  SELECT * INTO v_dispatch FROM public.dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF v_dispatch.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Despacho inexistente');
  END IF;

  v_current_status := COALESCE(v_dispatch.status, 'PROGRAMADO');
  IF v_current_status = p_new_status THEN
    RETURN jsonb_build_object('success', true, 'previous_status', v_current_status, 'new_status', p_new_status,
                              'note', 'El estado ya era ' || p_new_status);
  END IF;

  IF p_new_status = 'CANCELADO' AND v_current_status NOT IN ('LIQUIDADO', 'CERRADO') THEN
    v_allowed := true;
  ELSIF v_current_status = 'PROGRAMADO' THEN
    v_allowed := p_new_status IN ('EN_CURSO', 'EN RUTA');
  ELSIF v_current_status IN ('EN_CURSO', 'EN RUTA') THEN
    v_allowed := p_new_status IN ('ESPERANDO_AUTORIZACION', 'RETORNO', 'ENTREGADO');
  ELSIF v_current_status = 'ESPERANDO_AUTORIZACION' THEN
    v_allowed := p_new_status = 'RETORNO';
  ELSIF v_current_status = 'RETORNO' THEN
    v_allowed := p_new_status = 'RETORNO_COMPLETADO';
  ELSIF v_current_status IN ('RETORNO_COMPLETADO', 'ENTREGADO') THEN
    v_allowed := p_new_status IN ('LIQUIDADO', 'CERRADO');
  ELSIF v_current_status = 'LIQUIDADO' THEN
    v_allowed := p_new_status = 'CERRADO';
  END IF;

  IF NOT v_allowed THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transición no permitida de ' || v_current_status || ' a ' || p_new_status);
  END IF;

  UPDATE public.dispatches SET status = p_new_status WHERE id = p_dispatch_id;

  INSERT INTO public.dispatch_events (dispatch_id, event_type, description, created_by)
  VALUES (p_dispatch_id, 'STATUS_CHANGE',
          'Cambio de estado: ' || v_current_status || ' -> ' || p_new_status || COALESCE('. Razón: ' || p_reason, ''),
          COALESCE(p_user_id::text, auth.uid()::text, 'system'));

  -- Liberación de la unidad por el motor; si no es elegible queda OBSERVADA
  IF p_new_status IN ('CERRADO', 'LIQUIDADO', 'CANCELADO') AND v_dispatch.vehicle_plate IS NOT NULL
     AND (SELECT status FROM public.vehicles WHERE plate = v_dispatch.vehicle_plate) IN ('ASIGNADA', 'EN_OPERACION') THEN
    v_release := public.transition_vehicle_status(v_dispatch.vehicle_plate, 'DISPONIBLE',
                   'Despacho finalizado (' || p_new_status || ')', COALESCE(p_user_id, auth.uid()),
                   jsonb_build_object('dispatch_id', p_dispatch_id));
    IF NOT COALESCE((v_release->>'success')::boolean, false) THEN
      v_release := public.transition_vehicle_status(v_dispatch.vehicle_plate, 'OBSERVADA',
                     'No elegible al cierre del despacho: ' || COALESCE(v_release->>'error', ''),
                     COALESCE(p_user_id, auth.uid()), jsonb_build_object('dispatch_id', p_dispatch_id));
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'previous_status', v_current_status, 'new_status', p_new_status,
                            'vehicle_transition', v_release);
END;
$$;

REVOKE ALL ON FUNCTION public.transition_dispatch_status(uuid, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transition_dispatch_status(uuid, text, text, uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 8. Vista del gestor de OT
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_work_orders
WITH (security_invoker = true) AS
SELECT
  wo.id, wo.ot_code, wo.status, wo.order_type, wo.source_type, wo.source_id, wo.priority,
  wo.description, wo.diagnostic, wo.activities_performed, wo.tasks, wo.evidence_urls, wo.notes,
  wo.vehicle_id, v.plate AS vehicle_plate, v.type AS vehicle_type, v.status AS vehicle_status,
  wo.plan_id, mp.name AS plan_name,
  wo.provider_id, prov.business_name AS provider_name,
  wo.responsible_id, NULLIF(trim(concat_ws(' ', pr.first_name, pr.last_name)), '') AS responsible_name,
  wo.mechanic_id, NULLIF(trim(concat_ws(' ', pm.first_name, pm.last_name)), '') AS mechanic_name,
  wo.approved_by, wo.approved_at, wo.validated_at, wo.closed_at, wo.cancel_reason,
  wo.start_date, wo.estimated_end_date, wo.actual_end_date,
  wo.downtime_start, wo.downtime_end,
  COALESCE(wo.downtime_hours,
           CASE WHEN wo.downtime_start IS NOT NULL
                THEN round((extract(epoch FROM now() - wo.downtime_start) / 3600.0)::numeric, 2) END) AS downtime_hours,
  COALESCE(wo.labor_cost, 0) AS labor_cost, COALESCE(wo.parts_cost, 0) AS parts_cost,
  COALESCE(wo.services_cost, 0) AS services_cost, COALESCE(wo.total_cost, 0) AS total_cost,
  (SELECT count(*) FROM public.maintenance_requests r WHERE r.work_order_id = wo.id) AS linked_requests,
  wo.release_result, wo.site_id, wo.created_at, wo.updated_at
FROM public.maintenance_work_orders wo
JOIN public.vehicles v ON v.id = wo.vehicle_id
LEFT JOIN public.maintenance_plans mp ON mp.id = wo.plan_id
LEFT JOIN public.maintenance_providers prov ON prov.id = wo.provider_id
LEFT JOIN public.profiles pr ON pr.id = wo.responsible_id
LEFT JOIN public.profiles pm ON pm.id = wo.mechanic_id;

GRANT SELECT ON public.vw_work_orders TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
