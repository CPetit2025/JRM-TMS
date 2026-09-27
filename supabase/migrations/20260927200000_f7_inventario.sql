-- 20260927200000_f7_inventario.sql
-- FASE 7 — Repuestos e inventario.
--
-- * Catálogo: código único por sede, unidad, ubicación, mínimo/máximo, garantía (meses/km).
--   Stock y costo promedio solo cambian por movimientos (guard).
-- * Kardex único (inventory_transactions): INGRESO (costo promedio ponderado), SALIDA (consumo por
--   OT), AJUSTE (con motivo). Saldo posterior guardado en cada movimiento; bloqueo de fila del
--   repuesto (sin doble consumo) y sin stock negativo. Se elimina spare_part_movements (vacía).
-- * Reservas por OT: el disponible = stock − reservas activas de otras OT; el consumo descuenta la
--   reserva propia; al cerrar/cancelar la OT se liberan. Los preventivos reservan sus repuestos previstos.
-- * Stock mínimo ⇒ solicitud de reposición automática (no OC directa); se atiende con el ingreso.
-- * Garantía del repuesto instalado (fecha/km/proveedor/condiciones) para F10.

BEGIN;

-- ------------------------------------------------------------
-- 1. Catálogo
-- ------------------------------------------------------------
ALTER TABLE public.spare_parts ALTER COLUMN current_stock TYPE numeric(12,2);
ALTER TABLE public.spare_parts ALTER COLUMN minimum_stock TYPE numeric(12,2);
ALTER TABLE public.spare_parts
  ADD COLUMN IF NOT EXISTS maximum_stock numeric(12,2),
  ADD COLUMN IF NOT EXISTS unit text NOT NULL DEFAULT 'UNIDAD',
  ADD COLUMN IF NOT EXISTS location text,
  ADD COLUMN IF NOT EXISTS warranty_months int,
  ADD COLUMN IF NOT EXISTS warranty_km int,
  ADD COLUMN IF NOT EXISTS warranty_conditions text;

UPDATE public.spare_parts SET current_stock = COALESCE(current_stock, 0), minimum_stock = COALESCE(minimum_stock, 0),
  average_price_pen = COALESCE(average_price_pen, 0), internal_code = upper(trim(internal_code)), is_active = COALESCE(is_active, true);
ALTER TABLE public.spare_parts ALTER COLUMN current_stock SET DEFAULT 0;
ALTER TABLE public.spare_parts ALTER COLUMN current_stock SET NOT NULL;
ALTER TABLE public.spare_parts ALTER COLUMN minimum_stock SET DEFAULT 0;
ALTER TABLE public.spare_parts ALTER COLUMN average_price_pen SET DEFAULT 0;

ALTER TABLE public.spare_parts DROP CONSTRAINT IF EXISTS spare_parts_stock_check;
ALTER TABLE public.spare_parts ADD CONSTRAINT spare_parts_stock_check CHECK (
  current_stock >= 0 AND COALESCE(minimum_stock, 0) >= 0
  AND (maximum_stock IS NULL OR maximum_stock >= COALESCE(minimum_stock, 0))
  AND COALESCE(average_price_pen, 0) >= 0
  AND (warranty_months IS NULL OR warranty_months > 0) AND (warranty_km IS NULL OR warranty_km > 0));
CREATE UNIQUE INDEX IF NOT EXISTS uq_spare_parts_code_site ON public.spare_parts (site_id, upper(internal_code));

CREATE OR REPLACE FUNCTION public.guard_spare_part()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.internal_code := upper(trim(NEW.internal_code));
  NEW.updated_at := now();
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      -- El stock inicial entra como INGRESO en el kardex, no en el catálogo
      NEW.current_stock := 0;
      NEW.average_price_pen := 0;
    ELSIF NEW.current_stock IS DISTINCT FROM OLD.current_stock OR NEW.average_price_pen IS DISTINCT FROM OLD.average_price_pen THEN
      RAISE EXCEPTION 'Stock y costo promedio solo cambian con movimientos de inventario' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_spare_part ON public.spare_parts;
CREATE TRIGGER trg_guard_spare_part BEFORE INSERT OR UPDATE ON public.spare_parts
FOR EACH ROW EXECUTE FUNCTION public.guard_spare_part();

-- ------------------------------------------------------------
-- 2. Reservas y reposición
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.spare_part_reservations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spare_part_id  uuid NOT NULL REFERENCES public.spare_parts(id) ON DELETE CASCADE,
  work_order_id  uuid NOT NULL REFERENCES public.maintenance_work_orders(id) ON DELETE CASCADE,
  quantity       numeric(12,2) NOT NULL CHECK (quantity > 0),
  consumed       numeric(12,2) NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  status         text NOT NULL DEFAULT 'ACTIVA' CHECK (status IN ('ACTIVA', 'CONSUMIDA', 'LIBERADA')),
  created_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reservation_active ON public.spare_part_reservations (spare_part_id, work_order_id) WHERE status = 'ACTIVA';

CREATE TABLE IF NOT EXISTS public.spare_part_replenishment_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spare_part_id        uuid NOT NULL REFERENCES public.spare_parts(id) ON DELETE CASCADE,
  site_id              uuid REFERENCES public.sites(id),
  suggested_quantity   numeric(12,2) NOT NULL,
  available_at_request numeric(12,2) NOT NULL,
  status               text NOT NULL DEFAULT 'PENDIENTE' CHECK (status IN ('PENDIENTE', 'APROBADA', 'ATENDIDA', 'ANULADA')),
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at          timestamptz,
  resolved_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_replenishment_open ON public.spare_part_replenishment_requests (spare_part_id)
  WHERE status IN ('PENDIENTE', 'APROBADA');

CREATE OR REPLACE FUNCTION public.spare_part_available(p_part uuid, p_exclude_work_order uuid DEFAULT NULL)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT sp.current_stock - COALESCE((
    SELECT sum(r.quantity - r.consumed) FROM public.spare_part_reservations r
    WHERE r.spare_part_id = sp.id AND r.status = 'ACTIVA'
      AND (p_exclude_work_order IS NULL OR r.work_order_id <> p_exclude_work_order)), 0)
  FROM public.spare_parts sp WHERE sp.id = p_part;
$$;

CREATE OR REPLACE FUNCTION public.evaluate_part_replenishment(p_part uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_part      public.spare_parts%ROWTYPE;
  v_available numeric;
BEGIN
  SELECT * INTO v_part FROM public.spare_parts WHERE id = p_part;
  IF NOT FOUND OR NOT COALESCE(v_part.is_active, true) OR COALESCE(v_part.minimum_stock, 0) <= 0 THEN
    RETURN;
  END IF;
  v_available := public.spare_part_available(p_part);
  IF v_available < v_part.minimum_stock THEN
    INSERT INTO public.spare_part_replenishment_requests (spare_part_id, site_id, suggested_quantity, available_at_request, notes)
    VALUES (p_part, v_part.site_id,
            GREATEST(COALESCE(v_part.maximum_stock, v_part.minimum_stock * 2) - v_available, v_part.minimum_stock - v_available),
            v_available, 'Generada automáticamente: disponible bajo el mínimo')
    ON CONFLICT (spare_part_id) WHERE status IN ('PENDIENTE', 'APROBADA') DO NOTHING;
  ELSE
    UPDATE public.spare_part_replenishment_requests SET status = 'ATENDIDA', resolved_at = now(),
      notes = concat_ws(' | ', notes, 'Atendida por ingreso de stock')
    WHERE spare_part_id = p_part AND status IN ('PENDIENTE', 'APROBADA');
  END IF;
END;
$$;

-- ------------------------------------------------------------
-- 3. Kardex único con costo promedio ponderado
-- ------------------------------------------------------------
ALTER TABLE public.inventory_transactions
  ADD COLUMN IF NOT EXISTS unit_cost numeric(12,4),
  ADD COLUMN IF NOT EXISTS balance_after numeric(12,2),
  ADD COLUMN IF NOT EXISTS average_cost_after numeric(12,4),
  ADD COLUMN IF NOT EXISTS reason text,
  ADD COLUMN IF NOT EXISTS provider_id uuid REFERENCES public.maintenance_providers(id) ON DELETE SET NULL;

ALTER TABLE public.inventory_transactions DROP CONSTRAINT IF EXISTS inventory_transactions_type_check;
ALTER TABLE public.inventory_transactions ADD CONSTRAINT inventory_transactions_type_check CHECK (type IN ('INGRESO', 'SALIDA', 'AJUSTE'));
-- Espejo legado: admitir también ajustes
ALTER TABLE public.inventory_transactions DROP CONSTRAINT IF EXISTS inventory_transactions_transaction_type_check;
ALTER TABLE public.inventory_transactions ADD CONSTRAINT inventory_transactions_transaction_type_check CHECK (transaction_type IN ('IN', 'OUT', 'ADJUST'));

-- Un solo trigger BEFORE: normaliza, bloquea el repuesto, valida y actualiza stock/costo
DROP TRIGGER IF EXISTS trigger_inventory_transaction_stock ON public.inventory_transactions;
DROP TRIGGER IF EXISTS trg_normalize_inventory_transaction ON public.inventory_transactions;

CREATE OR REPLACE FUNCTION public.apply_inventory_transaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_part  public.spare_parts%ROWTYPE;
  v_delta numeric;
  v_avg   numeric;
BEGIN
  NEW.spare_part_id := COALESCE(NEW.spare_part_id, NEW.part_id);
  NEW.part_id := NEW.spare_part_id;
  NEW.type := COALESCE(NEW.type, CASE upper(NEW.transaction_type) WHEN 'IN' THEN 'INGRESO' WHEN 'OUT' THEN 'SALIDA'
                                                              WHEN 'ADJUST' THEN 'AJUSTE' ELSE upper(NEW.transaction_type) END);
  NEW.transaction_type := CASE NEW.type WHEN 'INGRESO' THEN 'IN' WHEN 'SALIDA' THEN 'OUT' ELSE 'ADJUST' END;
  NEW.work_order_reference := COALESCE(NEW.work_order_reference, NEW.reference_id);
  NEW.reference_id := COALESCE(NEW.reference_id, NEW.work_order_reference);
  NEW.created_by := COALESCE(NEW.created_by, auth.uid());
  NEW.date := COALESCE(NEW.date, now());

  IF NEW.spare_part_id IS NULL OR NEW.type IS NULL THEN
    RAISE EXCEPTION 'Movimiento de inventario sin repuesto o tipo';
  END IF;
  IF NEW.type IN ('INGRESO', 'SALIDA') AND NEW.quantity <= 0 THEN
    RAISE EXCEPTION 'La cantidad debe ser positiva';
  END IF;
  IF NEW.type = 'AJUSTE' AND (NEW.quantity = 0 OR NULLIF(trim(NEW.reason), '') IS NULL) THEN
    RAISE EXCEPTION 'El ajuste requiere cantidad distinta de cero y motivo';
  END IF;

  SELECT * INTO v_part FROM public.spare_parts WHERE id = NEW.spare_part_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Repuesto inexistente: %', NEW.spare_part_id;
  END IF;

  v_delta := CASE NEW.type WHEN 'INGRESO' THEN NEW.quantity WHEN 'SALIDA' THEN -NEW.quantity ELSE NEW.quantity END;
  IF v_part.current_stock + v_delta < 0 THEN
    RAISE EXCEPTION 'Stock insuficiente: disponible %, solicitado %', v_part.current_stock, abs(v_delta) USING ERRCODE = 'P0001';
  END IF;

  IF NEW.type = 'INGRESO' THEN
    IF NEW.unit_cost IS NULL OR NEW.unit_cost < 0 THEN
      RAISE EXCEPTION 'El ingreso requiere costo unitario';
    END IF;
    v_avg := round((v_part.current_stock * COALESCE(v_part.average_price_pen, 0) + NEW.quantity * NEW.unit_cost)
                   / NULLIF(v_part.current_stock + NEW.quantity, 0), 4);
    NEW.total_cost := round(NEW.quantity * NEW.unit_cost, 2);
  ELSE
    v_avg := COALESCE(v_part.average_price_pen, 0);
    NEW.unit_cost := COALESCE(NEW.unit_cost, v_avg);
    NEW.total_cost := COALESCE(NEW.total_cost, round(abs(NEW.quantity) * NEW.unit_cost, 2));
  END IF;

  UPDATE public.spare_parts SET
    current_stock     = v_part.current_stock + v_delta,
    average_price_pen = COALESCE(v_avg, average_price_pen),
    unit_price        = CASE WHEN NEW.type = 'INGRESO' THEN NEW.unit_cost ELSE unit_price END,
    updated_at        = now()
  WHERE id = v_part.id;

  NEW.balance_after := v_part.current_stock + v_delta;
  NEW.average_cost_after := COALESCE(v_avg, v_part.average_price_pen);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_apply_inventory_transaction
BEFORE INSERT ON public.inventory_transactions
FOR EACH ROW EXECUTE FUNCTION public.apply_inventory_transaction();

DROP FUNCTION IF EXISTS public.update_stock_from_inventory_transaction();
DROP FUNCTION IF EXISTS public.normalize_inventory_transaction();

CREATE OR REPLACE FUNCTION public.after_inventory_transaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.evaluate_part_replenishment(NEW.spare_part_id);
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_after_inventory_transaction ON public.inventory_transactions;
CREATE TRIGGER trg_after_inventory_transaction AFTER INSERT ON public.inventory_transactions
FOR EACH ROW EXECUTE FUNCTION public.after_inventory_transaction();

-- Movimientos manuales (ingresos y ajustes); las salidas se hacen por OT
CREATE OR REPLACE FUNCTION public.register_inventory_movement(
  p_spare_part_id uuid,
  p_type          text,
  p_quantity      numeric,
  p_unit_cost     numeric DEFAULT NULL,
  p_document      text    DEFAULT NULL,
  p_provider_id   uuid    DEFAULT NULL,
  p_reason        text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_site uuid;
  v_tx   public.inventory_transactions%ROWTYPE;
BEGIN
  SELECT site_id INTO v_site FROM public.spare_parts WHERE id = p_spare_part_id;
  IF v_site IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Repuesto inexistente');
  END IF;
  IF auth.uid() IS NOT NULL AND NOT (public.can_access_site(v_site) AND public.has_cmms_permission('ot')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para movimientos de inventario');
  END IF;
  IF upper(p_type) NOT IN ('INGRESO', 'AJUSTE') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo ingresos y ajustes; las salidas se registran en la OT');
  END IF;
  IF upper(p_type) = 'AJUSTE' AND auth.uid() IS NOT NULL AND NOT public.is_tms_admin() AND NOT public.has_cmms_permission('flota') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Los ajustes requieren permiso de supervisión');
  END IF;

  BEGIN
    INSERT INTO public.inventory_transactions (spare_part_id, type, quantity, unit_cost, reference_document, provider_id, reason, created_by)
    VALUES (p_spare_part_id, upper(p_type), p_quantity, p_unit_cost, p_document, p_provider_id, p_reason, auth.uid())
    RETURNING * INTO v_tx;
  EXCEPTION WHEN raise_exception THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
  END;
  RETURN jsonb_build_object('success', true, 'transaction_id', v_tx.id, 'balance_after', v_tx.balance_after,
                            'average_cost_after', v_tx.average_cost_after);
END;
$$;
REVOKE ALL ON FUNCTION public.register_inventory_movement(uuid, text, numeric, numeric, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_inventory_movement(uuid, text, numeric, numeric, text, uuid, text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 4. Garantías de repuestos instalados
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.part_warranties (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spare_part_id        uuid NOT NULL REFERENCES public.spare_parts(id) ON DELETE CASCADE,
  vehicle_id           uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  work_order_id        uuid REFERENCES public.maintenance_work_orders(id) ON DELETE SET NULL,
  provider_id          uuid REFERENCES public.maintenance_providers(id) ON DELETE SET NULL,
  installed_at         timestamptz NOT NULL DEFAULT now(),
  expires_at           date,
  odometer_at_install  numeric(12,2),
  km_limit             int,
  conditions           text,
  status               text NOT NULL DEFAULT 'ACTIVA' CHECK (status IN ('ACTIVA', 'RECLAMADA', 'ANULADA')),
  claimed_at           timestamptz,
  claim_notes          text,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_part_warranties_vehicle ON public.part_warranties (vehicle_id, status);

CREATE OR REPLACE VIEW public.vw_part_warranties
WITH (security_invoker = true) AS
SELECT w.*, sp.internal_code, sp.name AS part_name, v.plate AS vehicle_plate, prov.business_name AS provider_name,
  CASE WHEN w.km_limit IS NOT NULL THEN w.odometer_at_install + w.km_limit - COALESCE(v.current_odometer, 0) END AS km_remaining,
  CASE
    WHEN w.status <> 'ACTIVA' THEN w.status
    WHEN w.expires_at IS NOT NULL AND w.expires_at < (now() AT TIME ZONE 'America/Lima')::date THEN 'VENCIDA'
    WHEN w.km_limit IS NOT NULL AND COALESCE(v.current_odometer, 0) - COALESCE(w.odometer_at_install, 0) > w.km_limit THEN 'VENCIDA'
    ELSE 'VIGENTE' END AS warranty_status
FROM public.part_warranties w
JOIN public.spare_parts sp ON sp.id = w.spare_part_id
JOIN public.vehicles v ON v.id = w.vehicle_id
LEFT JOIN public.maintenance_providers prov ON prov.id = w.provider_id;
GRANT SELECT ON public.vw_part_warranties TO authenticated, service_role;

-- ------------------------------------------------------------
-- 5. Reservas y consumo por OT
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_work_order_part(p_work_order_id uuid, p_spare_part_id uuid, p_quantity numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wo        public.maintenance_work_orders%ROWTYPE;
  v_available numeric;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_cmms_permission('ot') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para reservar repuestos');
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cantidad inválida');
  END IF;
  SELECT * INTO v_wo FROM public.maintenance_work_orders WHERE id = p_work_order_id;
  IF NOT FOUND OR v_wo.status IN ('CERRADA', 'CANCELADA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT inexistente o cerrada');
  END IF;

  PERFORM 1 FROM public.spare_parts WHERE id = p_spare_part_id FOR UPDATE;   -- serializa reservas
  v_available := public.spare_part_available(p_spare_part_id);
  IF v_available IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Repuesto inexistente');
  END IF;
  IF v_available < p_quantity THEN
    RETURN jsonb_build_object('success', false, 'error', 'Disponible insuficiente para reservar: ' || v_available);
  END IF;

  INSERT INTO public.spare_part_reservations (spare_part_id, work_order_id, quantity, created_by)
  VALUES (p_spare_part_id, p_work_order_id, p_quantity, auth.uid())
  ON CONFLICT (spare_part_id, work_order_id) WHERE status = 'ACTIVA'
  DO UPDATE SET quantity = spare_part_reservations.quantity + EXCLUDED.quantity;

  PERFORM public.evaluate_part_replenishment(p_spare_part_id);
  RETURN jsonb_build_object('success', true, 'available_after', public.spare_part_available(p_spare_part_id));
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_work_order_part(uuid, uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reserve_work_order_part(uuid, uuid, numeric) TO authenticated, service_role;

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
  v_wo        public.maintenance_work_orders%ROWTYPE;
  v_part      public.spare_parts%ROWTYPE;
  v_vehicle   public.vehicles%ROWTYPE;
  v_tx        public.inventory_transactions%ROWTYPE;
  v_available numeric;
  v_res       public.spare_part_reservations%ROWTYPE;
  v_take      numeric;
  v_provider  uuid;
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

  SELECT * INTO v_part FROM public.spare_parts WHERE id = p_spare_part_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Repuesto no encontrado');
  END IF;
  -- Lo reservado por otras OT no está disponible para esta
  v_available := public.spare_part_available(p_spare_part_id, p_work_order_id);
  IF v_available < p_quantity THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Stock disponible insuficiente (disponible ' || v_available || ', stock ' || v_part.current_stock || ' con reservas de otras OT)');
  END IF;

  BEGIN
    INSERT INTO public.inventory_transactions (spare_part_id, type, quantity, reference_document, work_order_reference, created_by)
    VALUES (p_spare_part_id, 'SALIDA', p_quantity, 'OT ' || v_wo.ot_code, p_work_order_id, auth.uid())
    RETURNING * INTO v_tx;
  EXCEPTION WHEN raise_exception THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
  END;

  -- Descontar la reserva propia
  SELECT * INTO v_res FROM public.spare_part_reservations
  WHERE spare_part_id = p_spare_part_id AND work_order_id = p_work_order_id AND status = 'ACTIVA' FOR UPDATE;
  IF FOUND THEN
    v_take := LEAST(p_quantity, v_res.quantity - v_res.consumed);
    UPDATE public.spare_part_reservations SET consumed = consumed + v_take,
      status = CASE WHEN consumed + v_take >= quantity THEN 'CONSUMIDA' ELSE 'ACTIVA' END,
      closed_at = CASE WHEN consumed + v_take >= quantity THEN now() END
    WHERE id = v_res.id;
  END IF;

  INSERT INTO public.work_order_spare_parts (work_order_id, spare_part_id, quantity, unit_cost)
  VALUES (p_work_order_id, p_spare_part_id, p_quantity, v_tx.unit_cost);

  INSERT INTO public.work_order_costs (work_order_id, cost_type, amount, quantity, spare_part_id, description, created_by)
  VALUES (p_work_order_id, 'REPUESTOS', v_tx.total_cost, p_quantity, p_spare_part_id,
          COALESCE(v_part.name, 'Repuesto') || COALESCE(' — ' || p_notes, ''), auth.uid());

  -- Garantía del repuesto instalado
  IF v_part.warranty_months IS NOT NULL OR v_part.warranty_km IS NOT NULL THEN
    SELECT * INTO v_vehicle FROM public.vehicles WHERE id = v_wo.vehicle_id;
    SELECT provider_id INTO v_provider FROM public.inventory_transactions
    WHERE spare_part_id = p_spare_part_id AND type = 'INGRESO' AND provider_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 1;
    INSERT INTO public.part_warranties (spare_part_id, vehicle_id, work_order_id, provider_id, expires_at,
                                        odometer_at_install, km_limit, conditions)
    VALUES (p_spare_part_id, v_wo.vehicle_id, p_work_order_id, COALESCE(v_provider, v_wo.provider_id),
            CASE WHEN v_part.warranty_months IS NOT NULL
                 THEN ((now() AT TIME ZONE 'America/Lima')::date + make_interval(months => v_part.warranty_months))::date END,
            v_vehicle.current_odometer, v_part.warranty_km, v_part.warranty_conditions);
  END IF;

  RETURN jsonb_build_object('success', true, 'amount', v_tx.total_cost, 'unit_cost', v_tx.unit_cost,
    'stock_remaining', v_tx.balance_after, 'available_remaining', public.spare_part_available(p_spare_part_id));
END;
$$;
REVOKE ALL ON FUNCTION public.consume_work_order_part(uuid, uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_work_order_part(uuid, uuid, numeric, text) TO authenticated, service_role;

-- Cierre/cancelación de OT libera reservas pendientes; preventivos reservan sus repuestos previstos
CREATE OR REPLACE FUNCTION public.work_order_reservations_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_part   jsonb;
  v_res    jsonb;
  v_missed text[] := '{}';
  r        record;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.plan_id IS NOT NULL THEN
    FOR v_part IN SELECT * FROM jsonb_array_elements(COALESCE((SELECT expected_parts FROM public.maintenance_plans WHERE id = NEW.plan_id), '[]'::jsonb)) LOOP
      IF (v_part->>'part_id') IS NOT NULL THEN
        v_res := public.reserve_work_order_part(NEW.id, (v_part->>'part_id')::uuid, COALESCE((v_part->>'quantity')::numeric, 1));
        IF NOT COALESCE((v_res->>'success')::boolean, false) THEN
          v_missed := v_missed || COALESCE((SELECT internal_code FROM public.spare_parts WHERE id = (v_part->>'part_id')::uuid), v_part->>'part_id');
        END IF;
      END IF;
    END LOOP;
    IF cardinality(v_missed) > 0 THEN
      UPDATE public.maintenance_work_orders SET notes = concat_ws(E'\n', notes, 'Repuestos previstos sin disponible para reservar: ' || array_to_string(v_missed, ', '))
      WHERE id = NEW.id;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND NEW.status IN ('CERRADA', 'CANCELADA') AND OLD.status IS DISTINCT FROM NEW.status THEN
    FOR r IN UPDATE public.spare_part_reservations SET status = 'LIBERADA', closed_at = now()
             WHERE work_order_id = NEW.id AND status = 'ACTIVA' RETURNING spare_part_id LOOP
      PERFORM public.evaluate_part_replenishment(r.spare_part_id);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_work_order_reservations_sync ON public.maintenance_work_orders;
CREATE TRIGGER trg_work_order_reservations_sync AFTER INSERT OR UPDATE OF status ON public.maintenance_work_orders
FOR EACH ROW EXECUTE FUNCTION public.work_order_reservations_sync();

-- ------------------------------------------------------------
-- 6. Vistas: stock, kardex y consumo
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_spare_parts_stock
WITH (security_invoker = true) AS
SELECT sp.id, sp.internal_code, sp.name, sp.brand, sp.category, sp.compatibility, sp.unit, sp.location, sp.site_id,
  sp.current_stock, COALESCE(res.reserved, 0) AS reserved, sp.current_stock - COALESCE(res.reserved, 0) AS available,
  sp.minimum_stock, sp.maximum_stock, sp.average_price_pen, sp.unit_price,
  round(sp.current_stock * COALESCE(sp.average_price_pen, 0), 2) AS stock_value,
  sp.warranty_months, sp.warranty_km, sp.warranty_conditions, sp.is_active,
  CASE
    WHEN sp.current_stock - COALESCE(res.reserved, 0) <= 0 THEN 'SIN_STOCK'
    WHEN sp.current_stock - COALESCE(res.reserved, 0) < COALESCE(sp.minimum_stock, 0) THEN 'BAJO_MINIMO'
    WHEN sp.maximum_stock IS NOT NULL AND sp.current_stock > sp.maximum_stock THEN 'SOBRE_MAXIMO'
    ELSE 'OK' END AS stock_status,
  rr.id AS open_replenishment_id, rr.suggested_quantity AS replenishment_quantity, rr.status AS replenishment_status,
  (SELECT max(t.created_at) FROM public.inventory_transactions t WHERE t.spare_part_id = sp.id) AS last_movement_at
FROM public.spare_parts sp
LEFT JOIN (SELECT spare_part_id, sum(quantity - consumed) AS reserved FROM public.spare_part_reservations
           WHERE status = 'ACTIVA' GROUP BY spare_part_id) res ON res.spare_part_id = sp.id
LEFT JOIN public.spare_part_replenishment_requests rr ON rr.spare_part_id = sp.id AND rr.status IN ('PENDIENTE', 'APROBADA');
GRANT SELECT ON public.vw_spare_parts_stock TO authenticated, service_role;

CREATE OR REPLACE VIEW public.vw_inventory_kardex
WITH (security_invoker = true) AS
SELECT t.id, t.created_at, t.spare_part_id, sp.internal_code, sp.name AS part_name, sp.site_id,
  t.type, CASE WHEN t.type = 'SALIDA' THEN -t.quantity ELSE t.quantity END AS quantity_signed,
  t.unit_cost, t.total_cost, t.balance_after, t.average_cost_after, t.reference_document, t.reason,
  t.work_order_reference AS work_order_id, wo.ot_code, v.plate AS vehicle_plate,
  prov.business_name AS provider_name, NULLIF(trim(concat_ws(' ', p.first_name, p.last_name)), '') AS created_by_name
FROM public.inventory_transactions t
JOIN public.spare_parts sp ON sp.id = t.spare_part_id
LEFT JOIN public.maintenance_work_orders wo ON wo.id = t.work_order_reference
LEFT JOIN public.vehicles v ON v.id = wo.vehicle_id
LEFT JOIN public.maintenance_providers prov ON prov.id = t.provider_id
LEFT JOIN public.profiles p ON p.id = t.created_by;
GRANT SELECT ON public.vw_inventory_kardex TO authenticated, service_role;

CREATE OR REPLACE VIEW public.vw_parts_consumption
WITH (security_invoker = true) AS
SELECT date_trunc('month', t.created_at AT TIME ZONE 'America/Lima')::date AS month,
  v.plate AS vehicle_plate, v.type AS vehicle_type, sp.internal_code, sp.name AS part_name, sp.site_id,
  sum(t.quantity) AS quantity, sum(t.total_cost) AS cost, count(DISTINCT t.work_order_reference) AS work_orders
FROM public.inventory_transactions t
JOIN public.spare_parts sp ON sp.id = t.spare_part_id
JOIN public.maintenance_work_orders wo ON wo.id = t.work_order_reference
JOIN public.vehicles v ON v.id = wo.vehicle_id
WHERE t.type = 'SALIDA'
GROUP BY 1, 2, 3, 4, 5, 6;
GRANT SELECT ON public.vw_parts_consumption TO authenticated, service_role;

-- ------------------------------------------------------------
-- 7. RLS y limpieza
-- ------------------------------------------------------------
ALTER TABLE public.spare_part_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spare_part_replenishment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.part_warranties ENABLE ROW LEVEL SECURITY;

CREATE POLICY res_read ON public.spare_part_reservations FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.spare_parts sp WHERE sp.id = spare_part_id AND public.can_access_site(sp.site_id)
          AND public.has_cmms_read_permission('ot')));
CREATE POLICY repl_read ON public.spare_part_replenishment_requests FOR SELECT TO authenticated USING (
  public.can_access_site(site_id) AND public.has_cmms_read_permission('ot'));
CREATE POLICY repl_update ON public.spare_part_replenishment_requests FOR UPDATE TO authenticated
  USING (public.can_access_site(site_id) AND public.has_cmms_permission('ot'))
  WITH CHECK (public.can_access_site(site_id) AND public.has_cmms_permission('ot') AND status IN ('PENDIENTE', 'APROBADA', 'ANULADA'));
CREATE POLICY warranty_read ON public.part_warranties FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.vehicles v WHERE v.id = vehicle_id AND public.can_access_site(v.site_id)
          AND (public.has_cmms_read_permission('ot') OR public.has_cmms_read_permission('flota'))));
CREATE POLICY warranty_claim ON public.part_warranties FOR UPDATE TO authenticated
  USING (public.has_cmms_permission('ot')) WITH CHECK (public.has_cmms_permission('ot'));

-- Kardex paralelo sin datos ni uso (solo lo leía la IA)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.spare_part_movements) THEN
    RAISE EXCEPTION 'spare_part_movements tiene datos: migrarlos a inventory_transactions antes de eliminarla';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.ai_get_inventory_alerts(p_site_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE result jsonb;
BEGIN
  IF auth.uid() IS NULL OR cardinality(p_site_ids) = 0 OR cardinality(p_site_ids) > 20 OR
    EXISTS (SELECT 1 FROM unnest(p_site_ids) site WHERE NOT public.can_access_site(site)) OR
    NOT public.has_tms_read_permission('mantenimiento-ot') THEN
    RAISE EXCEPTION 'Sin permiso para inventario';
  END IF;
  SELECT jsonb_build_object(
    'partsInScope', count(*),
    'belowMinimumCount', count(*) FILTER (WHERE stock_status IN ('BAJO_MINIMO', 'SIN_STOCK')),
    'noMovement90DaysCount', count(*) FILTER (WHERE COALESCE(last_movement_at, now() - interval '1000 days') < now() - interval '90 days'),
    'openReplenishmentRequests', count(*) FILTER (WHERE open_replenishment_id IS NOT NULL),
    'stockValue', COALESCE(sum(stock_value), 0),
    'alertsSample', COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM (
      SELECT internal_code, name, current_stock, reserved, available, minimum_stock, stock_status, replenishment_quantity, last_movement_at
      FROM public.vw_spare_parts_stock
      WHERE site_id = ANY(p_site_ids) AND is_active AND stock_status IN ('BAJO_MINIMO', 'SIN_STOCK')
      ORDER BY available, internal_code LIMIT 60) a), '[]'::jsonb),
    'asOf', now()
  ) INTO result
  FROM public.vw_spare_parts_stock WHERE site_id = ANY(p_site_ids) AND is_active;
  RETURN result;
END;
$$;

DROP TABLE IF EXISTS public.spare_part_movements;

NOTIFY pgrst, 'reload schema';

COMMIT;
