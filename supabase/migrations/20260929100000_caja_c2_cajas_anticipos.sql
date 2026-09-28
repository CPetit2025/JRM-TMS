-- ============================================================
-- CAJA DE TRANSPORTE — C2: Cajas, anticipos, cuenta corriente y liquidación del viaje
-- ============================================================
-- Hallazgos corregidos (docs/caja/02-c2-cajas-anticipos.md):
--   * /caja/liquidaciones solo listaba viajes con liquidation_data del conductor: los gastos de viajes
--     sin retorno registrado nunca llegaban a revisarse.
--   * "Aprobar y liquidar" ponía dispatches.status = 'LIQUIDADO' directamente, saltándose la máquina de
--     estados; ese estado ya lo usa el cierre de ruta GPS. La liquidación financiera es otra entidad
--     (trip_settlements) y no toca el estado operativo.
--   * No existía el dinero entregado al conductor: cash_funds no se usaba y no había saldos.
-- Modelo:
--   cash_boxes / cash_movements: cada sol que entra o sale queda en un libro inmutable (se revierte, no se borra).
--   trip_advances: anticipo por viaje (solicitado → entregado → rendido).
--   dispatch_expenses.paid_by: CONDUCTOR (del anticipo), CAJA (vale de una caja) o EMPRESA (crédito/transferencia).
--   trip_settlements: cierre financiero del viaje con saldo (devolución, reembolso o descuento por planilla).
BEGIN;

-- ------------------------------------------------------------
-- 1. Permisos: anticipos (y el Jefe de Distribución los gestiona)
-- ------------------------------------------------------------
UPDATE public.roles
SET permissions = (SELECT jsonb_agg(DISTINCT p) FROM jsonb_array_elements(COALESCE(permissions, '[]'::jsonb) || '["caja-anticipos"]'::jsonb) p)
WHERE name = 'Jefe de Distribución';

CREATE OR REPLACE FUNCTION public.has_caja_read_access()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.has_tms_read_permission('caja') OR public.has_tms_read_permission('caja-gastos')
      OR public.has_tms_read_permission('caja-aprobacion') OR public.has_tms_read_permission('caja-liquidaciones')
      OR public.has_tms_read_permission('caja-fondos') OR public.has_tms_read_permission('caja-anticipos');
$$;

-- ------------------------------------------------------------
-- 2. Cajas y libro de movimientos
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cash_boxes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,
  name           text NOT NULL,
  box_type       text NOT NULL DEFAULT 'CAJA_CHICA' CHECK (box_type IN ('CAJA_CHICA', 'RUTA', 'BANCO', 'TARJETA')),
  site_id        uuid NOT NULL REFERENCES public.sites(id) DEFAULT public.primary_site_id(),
  currency       text NOT NULL DEFAULT 'PEN' CHECK (currency IN ('PEN', 'USD')),
  responsible_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  min_balance    numeric(12,2) NOT NULL DEFAULT 0 CHECK (min_balance >= 0),
  max_balance    numeric(12,2) CHECK (max_balance IS NULL OR max_balance > 0),
  -- En efectivo (caja chica/ruta) no se puede entregar más de lo que hay
  allow_negative boolean NOT NULL DEFAULT false,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid()
);

CREATE TABLE IF NOT EXISTS public.cash_movements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  box_id         uuid NOT NULL REFERENCES public.cash_boxes(id),
  movement_type  text NOT NULL CHECK (movement_type IN ('APERTURA', 'REPOSICION', 'RETIRO', 'ANTICIPO', 'GASTO',
                                                        'DEVOLUCION', 'REEMBOLSO', 'AJUSTE_ARQUEO', 'REVERSION')),
  direction      smallint NOT NULL CHECK (direction IN (1, -1)),
  amount         numeric(12,2) NOT NULL CHECK (amount > 0),
  payment_method text,
  reference      text,
  description    text,
  driver_id      uuid REFERENCES public.drivers(id) ON DELETE SET NULL,
  dispatch_id    uuid REFERENCES public.dispatches(id) ON DELETE SET NULL,
  advance_id     uuid,
  expense_id     uuid REFERENCES public.dispatch_expenses(id) ON DELETE SET NULL,
  settlement_id  uuid,
  reverses_id    uuid UNIQUE REFERENCES public.cash_movements(id),
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cash_movements_box_idx ON public.cash_movements (box_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cash_movements_driver_idx ON public.cash_movements (driver_id) WHERE driver_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cash_movements_expense_idx ON public.cash_movements (expense_id) WHERE expense_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.cash_box_closures (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  box_id          uuid NOT NULL REFERENCES public.cash_boxes(id),
  closure_date    date NOT NULL DEFAULT ((now() AT TIME ZONE 'America/Lima')::date),
  system_balance  numeric(12,2) NOT NULL,
  counted_balance numeric(12,2) NOT NULL CHECK (counted_balance >= 0),
  difference      numeric(12,2) NOT NULL,
  notes           text,
  movement_id     uuid REFERENCES public.cash_movements(id),
  closed_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (box_id, closure_date)
);

-- El libro es inmutable: una corrección es un movimiento de REVERSION
CREATE OR REPLACE FUNCTION public.caja_movement_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Los movimientos de caja no se modifican ni se eliminan: registre una reversión';
END $$;
DROP TRIGGER IF EXISTS trg_caja_movement_immutable ON public.cash_movements;
CREATE TRIGGER trg_caja_movement_immutable BEFORE UPDATE OR DELETE ON public.cash_movements
FOR EACH ROW EXECUTE FUNCTION public.caja_movement_immutable();
DROP TRIGGER IF EXISTS trg_caja_closure_immutable ON public.cash_box_closures;
CREATE TRIGGER trg_caja_closure_immutable BEFORE UPDATE OR DELETE ON public.cash_box_closures
FOR EACH ROW EXECUTE FUNCTION public.caja_movement_immutable();

CREATE OR REPLACE FUNCTION public.cash_box_balance(p_box_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(sum(direction * amount), 0) FROM public.cash_movements WHERE box_id = p_box_id;
$$;

-- Asiento en el libro (uso interno de las RPC); valida saldo en cajas de efectivo
CREATE OR REPLACE FUNCTION public.caja_post_movement(
  p_box_id uuid, p_type text, p_direction smallint, p_amount numeric, p_payment_method text DEFAULT NULL,
  p_reference text DEFAULT NULL, p_description text DEFAULT NULL, p_driver_id uuid DEFAULT NULL, p_dispatch_id uuid DEFAULT NULL,
  p_advance_id uuid DEFAULT NULL, p_expense_id uuid DEFAULT NULL, p_settlement_id uuid DEFAULT NULL, p_reverses_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b    public.cash_boxes%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT * INTO b FROM public.cash_boxes WHERE id = p_box_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Caja no encontrada'; END IF;
  IF NOT b.is_active AND p_reverses_id IS NULL THEN RAISE EXCEPTION 'La caja % está inactiva', b.name; END IF;
  IF p_direction = -1 AND NOT b.allow_negative AND p_reverses_id IS NULL
     AND public.cash_box_balance(p_box_id) - p_amount < 0 THEN
    RAISE EXCEPTION 'Saldo insuficiente en %: disponible S/ %, requerido S/ %', b.name, public.cash_box_balance(p_box_id), p_amount;
  END IF;
  INSERT INTO public.cash_movements (box_id, movement_type, direction, amount, payment_method, reference, description,
    driver_id, dispatch_id, advance_id, expense_id, settlement_id, reverses_id)
  VALUES (p_box_id, p_type, p_direction, round(p_amount, 2), p_payment_method, NULLIF(trim(p_reference), ''), NULLIF(trim(p_description), ''),
    p_driver_id, p_dispatch_id, p_advance_id, p_expense_id, p_settlement_id, p_reverses_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.caja_reverse_movement(p_movement_id uuid, p_reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE m public.cash_movements%ROWTYPE;
BEGIN
  SELECT * INTO m FROM public.cash_movements WHERE id = p_movement_id;
  IF NOT FOUND OR m.movement_type = 'REVERSION' THEN RAISE EXCEPTION 'Movimiento no reversible'; END IF;
  IF EXISTS (SELECT 1 FROM public.cash_movements WHERE reverses_id = m.id) THEN RAISE EXCEPTION 'El movimiento ya fue revertido'; END IF;
  RETURN public.caja_post_movement(m.box_id, 'REVERSION', (-m.direction)::smallint, m.amount, m.payment_method, m.reference,
    'Reversión: ' || COALESCE(p_reason, m.description, m.movement_type), m.driver_id, m.dispatch_id, m.advance_id, m.expense_id,
    m.settlement_id, m.id);
END $$;

-- Apertura, reposición y retiro manuales (Finanzas / responsable de la caja)
CREATE OR REPLACE FUNCTION public.register_cash_movement(
  p_box_id uuid, p_type text, p_amount numeric, p_payment_method text DEFAULT NULL, p_reference text DEFAULT NULL, p_description text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_type text := upper(trim(p_type));
  v_site uuid;
  v_id   uuid;
BEGIN
  IF NOT public.has_tms_permission('caja-fondos') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para registrar movimientos de caja');
  END IF;
  SELECT site_id INTO v_site FROM public.cash_boxes WHERE id = p_box_id;
  IF v_site IS NULL OR NOT public.can_access_site(v_site) THEN RETURN jsonb_build_object('success', false, 'error', 'Caja no disponible'); END IF;
  IF v_type NOT IN ('APERTURA', 'REPOSICION', 'RETIRO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Tipo de movimiento no válido: use apertura, reposición o retiro');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('success', false, 'error', 'El monto debe ser mayor a 0'); END IF;
  IF v_type = 'RETIRO' AND NULLIF(trim(p_description), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo del retiro');
  END IF;
  v_id := public.caja_post_movement(p_box_id, v_type, CASE WHEN v_type = 'RETIRO' THEN -1 ELSE 1 END::smallint, p_amount,
    p_payment_method, p_reference, p_description);
  RETURN jsonb_build_object('success', true, 'movement_id', v_id, 'balance', public.cash_box_balance(p_box_id));
END $$;

-- Arqueo: compara el saldo del sistema con el conteo físico y registra la diferencia
CREATE OR REPLACE FUNCTION public.close_cash_box(p_box_id uuid, p_counted numeric, p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b      public.cash_boxes%ROWTYPE;
  v_sys  numeric;
  v_diff numeric;
  v_mov  uuid;
  v_id   uuid;
BEGIN
  IF NOT public.has_tms_permission('caja-fondos') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para el arqueo de caja');
  END IF;
  SELECT * INTO b FROM public.cash_boxes WHERE id = p_box_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(b.site_id) THEN RETURN jsonb_build_object('success', false, 'error', 'Caja no disponible'); END IF;
  IF p_counted IS NULL OR p_counted < 0 THEN RETURN jsonb_build_object('success', false, 'error', 'Ingrese el monto contado'); END IF;
  IF EXISTS (SELECT 1 FROM public.cash_box_closures WHERE box_id = p_box_id AND closure_date = (now() AT TIME ZONE 'America/Lima')::date) THEN
    RETURN jsonb_build_object('success', false, 'error', 'La caja ya tiene arqueo de hoy');
  END IF;
  v_sys := public.cash_box_balance(p_box_id);
  v_diff := round(p_counted - v_sys, 2);
  IF v_diff <> 0 AND NULLIF(trim(p_notes), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Hay una diferencia de S/ ' || v_diff || ': explique el motivo');
  END IF;
  IF v_diff <> 0 THEN
    -- El ajuste cuadra el libro con el conteo (sin validar saldo: refleja lo que hay)
    INSERT INTO public.cash_movements (box_id, movement_type, direction, amount, description)
    VALUES (p_box_id, 'AJUSTE_ARQUEO', sign(v_diff)::smallint, abs(v_diff), 'Arqueo: ' || trim(p_notes)) RETURNING id INTO v_mov;
  END IF;
  INSERT INTO public.cash_box_closures (box_id, system_balance, counted_balance, difference, notes, movement_id)
  VALUES (p_box_id, v_sys, p_counted, v_diff, NULLIF(trim(p_notes), ''), v_mov) RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', true, 'system_balance', v_sys, 'difference', v_diff);
END $$;

-- ------------------------------------------------------------
-- 3. Anticipos por viaje
-- ------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.trip_advance_seq;
CREATE TABLE IF NOT EXISTS public.trip_advances (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE DEFAULT ('ANT-' || lpad(nextval('public.trip_advance_seq')::text, 6, '0')),
  dispatch_id    uuid NOT NULL REFERENCES public.dispatches(id),
  driver_id      uuid NOT NULL REFERENCES public.drivers(id),
  box_id         uuid REFERENCES public.cash_boxes(id),
  amount         numeric(12,2) NOT NULL CHECK (amount > 0),
  breakdown      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'SOLICITADO' CHECK (status IN ('SOLICITADO', 'ENTREGADO', 'RENDIDO', 'ANULADO')),
  payment_method text,
  reference      text,
  notes          text,
  requested_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  delivered_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  delivered_at   timestamptz,
  movement_id    uuid REFERENCES public.cash_movements(id),
  cancelled_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  cancel_reason  text,
  override_reason text
);
CREATE INDEX IF NOT EXISTS trip_advances_dispatch_idx ON public.trip_advances (dispatch_id);
CREATE INDEX IF NOT EXISTS trip_advances_driver_idx ON public.trip_advances (driver_id, status);
ALTER TABLE public.cash_movements DROP CONSTRAINT IF EXISTS cash_movements_advance_fk;
ALTER TABLE public.cash_movements ADD CONSTRAINT cash_movements_advance_fk FOREIGN KEY (advance_id) REFERENCES public.trip_advances(id);

-- ------------------------------------------------------------
-- 4. Gasto: quién lo pagó
-- ------------------------------------------------------------
ALTER TABLE public.dispatch_expenses
  ADD COLUMN IF NOT EXISTS paid_by     text NOT NULL DEFAULT 'CONDUCTOR',
  ADD COLUMN IF NOT EXISTS cash_box_id uuid REFERENCES public.cash_boxes(id);
-- Datos existentes: sin conductor ⇒ lo pagó la empresa (proceso de datos: no pasa por las reglas de edición)
DO $$ BEGIN
  PERFORM set_config('caja.review', 'on', true);
  UPDATE public.dispatch_expenses SET paid_by = 'EMPRESA' WHERE driver_id IS NULL AND paid_by = 'CONDUCTOR';
  PERFORM set_config('caja.review', '', true);
END $$;
ALTER TABLE public.dispatch_expenses DROP CONSTRAINT IF EXISTS dispatch_expenses_paid_by_check;
ALTER TABLE public.dispatch_expenses ADD CONSTRAINT dispatch_expenses_paid_by_check CHECK (
  paid_by IN ('CONDUCTOR', 'CAJA', 'EMPRESA')
  AND (paid_by <> 'CAJA' OR cash_box_id IS NOT NULL)
  AND (paid_by <> 'CONDUCTOR' OR driver_id IS NOT NULL));

-- ------------------------------------------------------------
-- 5. Liquidación financiera del viaje
-- ------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.trip_settlement_seq;
CREATE TABLE IF NOT EXISTS public.trip_settlements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL UNIQUE DEFAULT ('LIQ-' || lpad(nextval('public.trip_settlement_seq')::text, 6, '0')),
  dispatch_id       uuid NOT NULL UNIQUE REFERENCES public.dispatches(id),
  driver_id         uuid REFERENCES public.drivers(id),
  advances_total    numeric(12,2) NOT NULL DEFAULT 0,
  driver_expenses   numeric(12,2) NOT NULL DEFAULT 0,
  company_expenses  numeric(12,2) NOT NULL DEFAULT 0,
  rejected_total    numeric(12,2) NOT NULL DEFAULT 0,
  declared_total    numeric(12,2),
  balance           numeric(12,2) NOT NULL DEFAULT 0,  -- > 0: el conductor devuelve; < 0: la empresa reembolsa
  resolution        text NOT NULL CHECK (resolution IN ('DEVOLUCION', 'REEMBOLSO', 'DESCUENTO_PLANILLA', 'SIN_SALDO')),
  box_id            uuid REFERENCES public.cash_boxes(id),
  movement_id       uuid REFERENCES public.cash_movements(id),
  status            text NOT NULL DEFAULT 'CERRADA' CHECK (status IN ('CERRADA', 'REABIERTA')),
  notes             text,
  closed_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  closed_at         timestamptz,
  reopened_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reopened_at       timestamptz,
  reopen_reason     text,
  driver_ack_at     timestamptz,
  driver_ack_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
ALTER TABLE public.cash_movements DROP CONSTRAINT IF EXISTS cash_movements_settlement_fk;
ALTER TABLE public.cash_movements ADD CONSTRAINT cash_movements_settlement_fk FOREIGN KEY (settlement_id) REFERENCES public.trip_settlements(id);

CREATE OR REPLACE FUNCTION public.caja_trip_is_settled(p_dispatch_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.trip_settlements WHERE dispatch_id = p_dispatch_id AND status = 'CERRADA');
$$;

-- Estado financiero de cada viaje (fuente de /caja/liquidaciones y de la cuenta del conductor)
CREATE OR REPLACE VIEW public.vw_caja_trip_status WITH (security_invoker = true) AS
WITH adv AS (
  SELECT dispatch_id,
         sum(amount) FILTER (WHERE status IN ('ENTREGADO', 'RENDIDO')) AS delivered,
         sum(amount) FILTER (WHERE status = 'SOLICITADO') AS requested,
         count(*) FILTER (WHERE status = 'SOLICITADO') AS requested_count
  FROM public.trip_advances GROUP BY dispatch_id
), exp AS (
  SELECT dispatch_id,
         count(*) AS expenses_count,
         count(*) FILTER (WHERE status = 'PENDIENTE') AS pending_count,
         count(*) FILTER (WHERE status = 'OBSERVADO') AS observed_count,
         sum(amount) FILTER (WHERE status <> 'RECHAZADO') AS declared,
         sum(COALESCE(approved_amount, amount)) FILTER (WHERE status = 'APROBADO' AND paid_by = 'CONDUCTOR') AS driver_approved,
         sum(COALESCE(approved_amount, amount)) FILTER (WHERE status = 'APROBADO' AND paid_by <> 'CONDUCTOR') AS company_approved,
         sum(amount) FILTER (WHERE status IN ('PENDIENTE', 'OBSERVADO') AND paid_by = 'CONDUCTOR') AS driver_pending,
         sum(amount) FILTER (WHERE status = 'RECHAZADO') AS rejected,
         sum(COALESCE(approved_amount, amount)) FILTER (WHERE status = 'APROBADO' AND is_billable) AS billable
  FROM public.dispatch_expenses WHERE dispatch_id IS NOT NULL GROUP BY dispatch_id
)
SELECT t.id AS dispatch_id, t.dispatch_number, t.vehicle_plate, t.status AS dispatch_status, t.driver_id, t.site_id,
       t.departure_at, t.returned_at, t.created_at,
       COALESCE(a.delivered, 0) AS advances_delivered, COALESCE(a.requested, 0) AS advances_requested, COALESCE(a.requested_count, 0) AS advances_requested_count,
       COALESCE(e.expenses_count, 0) AS expenses_count, COALESCE(e.pending_count, 0) AS pending_count, COALESCE(e.observed_count, 0) AS observed_count,
       COALESCE(e.declared, 0) AS declared, COALESCE(e.driver_approved, 0) AS driver_approved, COALESCE(e.company_approved, 0) AS company_approved,
       COALESCE(e.driver_pending, 0) AS driver_pending, COALESCE(e.rejected, 0) AS rejected, COALESCE(e.billable, 0) AS billable,
       COALESCE(a.delivered, 0) - COALESCE(e.driver_approved, 0) AS balance,
       s.id AS settlement_id, s.code AS settlement_code, s.status AS settlement_status, s.resolution, s.closed_at, s.driver_ack_at,
       (t.status NOT IN ('PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO')) AS trip_finished,
       (COALESCE(s.status, '') <> 'CERRADA' AND COALESCE(a.delivered, 0) + COALESCE(e.expenses_count, 0) > 0
        AND COALESCE(t.returned_at, CASE WHEN t.status NOT IN ('PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO') THEN t.created_at END)
            < now() - make_interval(hours => (SELECT settlement_due_hours FROM public.caja_settings WHERE id))) AS overdue
FROM public.vw_caja_trips t
LEFT JOIN adv a ON a.dispatch_id = t.id
LEFT JOIN exp e ON e.dispatch_id = t.id
LEFT JOIN public.trip_settlements s ON s.dispatch_id = t.id;

-- Viajes con rendición vencida de un conductor (bloquea anticipos nuevos)
CREATE OR REPLACE FUNCTION public.caja_driver_overdue_trips(p_driver_id uuid)
RETURNS TABLE (dispatch_id uuid, dispatch_number text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.id, d.dispatch_number::text FROM public.dispatches d
  WHERE d.driver_id = p_driver_id
    AND NOT public.caja_trip_is_settled(d.id)
    AND EXISTS (SELECT 1 FROM public.trip_advances a WHERE a.dispatch_id = d.id AND a.status = 'ENTREGADO')
    AND d.status NOT IN ('PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO', 'CANCELADO')
    AND COALESCE(NULLIF(to_jsonb(d)->>'returned_at', ''), NULLIF(to_jsonb(d)->>'arrival_time', ''), d.updated_at::text)::timestamptz
        < now() - make_interval(hours => (SELECT settlement_due_hours FROM public.caja_settings WHERE id));
$$;

-- ------------------------------------------------------------
-- 6. RPC de anticipos
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_trip_advance(p_dispatch_id uuid, p_amount numeric, p_breakdown jsonb DEFAULT '{}'::jsonb, p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d    record;
  v_id uuid;
BEGIN
  IF NOT public.has_tms_permission('caja-anticipos') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para solicitar anticipos');
  END IF;
  SELECT id, driver_id, site_id, status INTO d FROM public.dispatches WHERE id = p_dispatch_id;
  IF NOT FOUND OR NOT public.can_access_site(d.site_id) THEN RETURN jsonb_build_object('success', false, 'error', 'Despacho no disponible'); END IF;
  IF d.driver_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'El despacho no tiene conductor asignado'); END IF;
  IF d.status = 'CANCELADO' THEN RETURN jsonb_build_object('success', false, 'error', 'El despacho está cancelado'); END IF;
  IF public.caja_trip_is_settled(p_dispatch_id) THEN RETURN jsonb_build_object('success', false, 'error', 'El viaje ya fue liquidado'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('success', false, 'error', 'El monto debe ser mayor a 0'); END IF;
  INSERT INTO public.trip_advances (dispatch_id, driver_id, amount, breakdown, notes)
  VALUES (p_dispatch_id, d.driver_id, round(p_amount, 2), COALESCE(p_breakdown, '{}'::jsonb), NULLIF(trim(p_notes), ''))
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', true, 'advance_id', v_id);
END $$;

CREATE OR REPLACE FUNCTION public.deliver_trip_advance(
  p_advance_id uuid, p_box_id uuid, p_payment_method text, p_reference text DEFAULT NULL, p_override_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a        public.trip_advances%ROWTYPE;
  v_over   text;
  v_mov    uuid;
  v_site   uuid;
BEGIN
  IF NOT public.has_tms_permission('caja-anticipos') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para entregar anticipos');
  END IF;
  SELECT * INTO a FROM public.trip_advances WHERE id = p_advance_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Anticipo no encontrado'); END IF;
  IF a.status <> 'SOLICITADO' THEN RETURN jsonb_build_object('success', false, 'error', 'El anticipo ya está ' || lower(a.status)); END IF;
  IF EXISTS (SELECT 1 FROM public.drivers WHERE id = a.driver_id AND profile_id = auth.uid()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'No puede entregarse un anticipo a sí mismo');
  END IF;
  SELECT site_id INTO v_site FROM public.cash_boxes WHERE id = p_box_id AND is_active;
  IF v_site IS NULL OR NOT public.can_access_site(v_site) THEN RETURN jsonb_build_object('success', false, 'error', 'Seleccione una caja activa'); END IF;
  IF NULLIF(trim(p_payment_method), '') IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Indique la forma de entrega'); END IF;
  SELECT string_agg(dispatch_number, ', ') INTO v_over FROM public.caja_driver_overdue_trips(a.driver_id) WHERE dispatch_id <> a.dispatch_id;
  IF v_over IS NOT NULL THEN
    IF NOT public.is_tms_admin() OR NULLIF(trim(p_override_reason), '') IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'El conductor tiene rendiciones vencidas (' || v_over || '). Solo el Administrador puede autorizar, indicando el motivo.', 'overdue', v_over);
    END IF;
  END IF;
  v_mov := public.caja_post_movement(p_box_id, 'ANTICIPO', -1::smallint, a.amount, upper(p_payment_method), p_reference,
    'Anticipo ' || a.code, a.driver_id, a.dispatch_id, a.id);
  UPDATE public.trip_advances SET status = 'ENTREGADO', box_id = p_box_id, payment_method = upper(p_payment_method),
    reference = NULLIF(trim(p_reference), ''), delivered_by = auth.uid(), delivered_at = now(), movement_id = v_mov,
    override_reason = CASE WHEN v_over IS NOT NULL THEN trim(p_override_reason) END
  WHERE id = a.id;
  RETURN jsonb_build_object('success', true, 'movement_id', v_mov);
END $$;

CREATE OR REPLACE FUNCTION public.cancel_trip_advance(p_advance_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.trip_advances%ROWTYPE;
BEGIN
  IF NOT public.has_tms_permission('caja-anticipos') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para anular anticipos');
  END IF;
  IF NULLIF(trim(p_reason), '') IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo de la anulación'); END IF;
  SELECT * INTO a FROM public.trip_advances WHERE id = p_advance_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Anticipo no encontrado'); END IF;
  IF a.status = 'SOLICITADO' THEN
    NULL;
  ELSIF a.status = 'ENTREGADO' AND public.is_tms_admin() THEN
    -- Entregado por error: se revierte el egreso (el dinero volvió a la caja)
    PERFORM public.caja_reverse_movement(a.movement_id, 'Anulación del anticipo ' || a.code || ': ' || trim(p_reason));
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'Un anticipo entregado se rinde en la liquidación; solo el Administrador lo anula');
  END IF;
  UPDATE public.trip_advances SET status = 'ANULADO', cancelled_by = auth.uid(), cancel_reason = trim(p_reason) WHERE id = a.id;
  RETURN jsonb_build_object('success', true);
END $$;

-- ------------------------------------------------------------
-- 7. Liquidación: vista previa, cierre, reapertura y conformidad del conductor
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.preview_trip_settlement(p_dispatch_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d        record;
  s        record;
  v_block  text[] := '{}';
BEGIN
  IF NOT (public.has_caja_read_access() OR EXISTS (SELECT 1 FROM public.dispatches x JOIN public.drivers dr ON dr.id = x.driver_id
                                                   WHERE x.id = p_dispatch_id AND dr.profile_id = auth.uid())) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a la liquidación');
  END IF;
  SELECT x.id, x.status, x.driver_id, x.site_id, x.liquidation_data INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Despacho no encontrado'); END IF;
  SELECT
    COALESCE((SELECT sum(amount) FROM public.trip_advances WHERE dispatch_id = p_dispatch_id AND status IN ('ENTREGADO', 'RENDIDO')), 0) AS advances,
    COALESCE((SELECT count(*) FROM public.trip_advances WHERE dispatch_id = p_dispatch_id AND status = 'SOLICITADO'), 0) AS advances_requested,
    COALESCE(sum(COALESCE(approved_amount, amount)) FILTER (WHERE status = 'APROBADO' AND paid_by = 'CONDUCTOR'), 0) AS driver_exp,
    COALESCE(sum(COALESCE(approved_amount, amount)) FILTER (WHERE status = 'APROBADO' AND paid_by <> 'CONDUCTOR'), 0) AS company_exp,
    COALESCE(sum(amount) FILTER (WHERE status = 'RECHAZADO'), 0) AS rejected,
    COALESCE(sum(amount) FILTER (WHERE status <> 'RECHAZADO'), 0) AS declared,
    count(*) FILTER (WHERE status = 'PENDIENTE') AS pending,
    count(*) FILTER (WHERE status = 'OBSERVADO') AS observed
  INTO s FROM public.dispatch_expenses WHERE dispatch_id = p_dispatch_id;
  IF d.status IN ('PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO') THEN
    v_block := v_block || ('El viaje sigue en curso (' || d.status || ')');
  END IF;
  IF s.pending > 0 THEN v_block := v_block || (s.pending || ' gasto(s) pendiente(s) de aprobación'); END IF;
  IF s.observed > 0 THEN v_block := v_block || (s.observed || ' gasto(s) observado(s) sin corregir'); END IF;
  IF s.advances_requested > 0 THEN v_block := v_block || (s.advances_requested || ' anticipo(s) solicitado(s) sin entregar ni anular'); END IF;
  RETURN jsonb_build_object('success', true,
    'advances_total', s.advances, 'driver_expenses', s.driver_exp, 'company_expenses', s.company_exp, 'rejected_total', s.rejected,
    'declared_total', s.declared, 'balance', s.advances - s.driver_exp,
    'suggested_resolution', CASE WHEN s.advances - s.driver_exp > 0 THEN 'DEVOLUCION' WHEN s.advances - s.driver_exp < 0 THEN 'REEMBOLSO' ELSE 'SIN_SALDO' END,
    'driver_declared', NULLIF(d.liquidation_data->>'total_expenses', '')::numeric,
    'settled', public.caja_trip_is_settled(p_dispatch_id), 'blocking', to_jsonb(v_block));
END $$;

CREATE OR REPLACE FUNCTION public.close_trip_settlement(
  p_dispatch_id uuid, p_resolution text, p_box_id uuid DEFAULT NULL, p_payment_method text DEFAULT NULL,
  p_reference text DEFAULT NULL, p_notes text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d        record;
  p        jsonb;
  v_res    text := upper(trim(p_resolution));
  v_bal    numeric;
  v_sid    uuid;
  v_mov    uuid;
  v_site   uuid;
BEGIN
  IF NOT public.has_tms_permission('caja-liquidaciones') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para liquidar viajes');
  END IF;
  SELECT x.id, x.driver_id, x.site_id, x.dispatch_number INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(d.site_id) THEN RETURN jsonb_build_object('success', false, 'error', 'Despacho no disponible'); END IF;
  IF EXISTS (SELECT 1 FROM public.drivers WHERE id = d.driver_id AND profile_id = auth.uid()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'No puede liquidar un viaje propio');
  END IF;
  p := public.preview_trip_settlement(p_dispatch_id);
  IF (p->>'settled')::boolean THEN RETURN jsonb_build_object('success', false, 'error', 'El viaje ya está liquidado'); END IF;
  IF jsonb_array_length(p->'blocking') > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'No se puede liquidar: ' || (SELECT string_agg(x, '; ') FROM jsonb_array_elements_text(p->'blocking') x));
  END IF;
  v_bal := (p->>'balance')::numeric;
  IF v_bal = 0 THEN v_res := 'SIN_SALDO';
  ELSIF v_bal > 0 AND v_res NOT IN ('DEVOLUCION', 'DESCUENTO_PLANILLA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'El conductor debe S/ ' || v_bal || ': elija devolución o descuento por planilla');
  ELSIF v_bal < 0 AND v_res <> 'REEMBOLSO' THEN
    RETURN jsonb_build_object('success', false, 'error', 'La empresa debe S/ ' || abs(v_bal) || ' al conductor: corresponde reembolso');
  END IF;
  IF v_res IN ('DEVOLUCION', 'REEMBOLSO') THEN
    SELECT site_id INTO v_site FROM public.cash_boxes WHERE id = p_box_id AND is_active;
    IF v_site IS NULL OR NOT public.can_access_site(v_site) THEN RETURN jsonb_build_object('success', false, 'error', 'Seleccione la caja donde se registra el saldo'); END IF;
    IF NULLIF(trim(p_payment_method), '') IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Indique la forma de pago del saldo'); END IF;
  END IF;
  IF v_res = 'DESCUENTO_PLANILLA' AND NULLIF(trim(p_notes), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique la autorización del descuento por planilla');
  END IF;

  INSERT INTO public.trip_settlements (dispatch_id, driver_id, advances_total, driver_expenses, company_expenses, rejected_total, declared_total,
    balance, resolution, box_id, status, notes, closed_by, closed_at)
  VALUES (p_dispatch_id, d.driver_id, (p->>'advances_total')::numeric, (p->>'driver_expenses')::numeric, (p->>'company_expenses')::numeric,
    (p->>'rejected_total')::numeric, (p->>'declared_total')::numeric, v_bal, v_res, CASE WHEN v_res IN ('DEVOLUCION', 'REEMBOLSO') THEN p_box_id END,
    'CERRADA', NULLIF(trim(p_notes), ''), auth.uid(), now())
  ON CONFLICT (dispatch_id) DO UPDATE SET driver_id = EXCLUDED.driver_id, advances_total = EXCLUDED.advances_total,
    driver_expenses = EXCLUDED.driver_expenses, company_expenses = EXCLUDED.company_expenses, rejected_total = EXCLUDED.rejected_total,
    declared_total = EXCLUDED.declared_total, balance = EXCLUDED.balance, resolution = EXCLUDED.resolution, box_id = EXCLUDED.box_id,
    movement_id = NULL, status = 'CERRADA', notes = EXCLUDED.notes, closed_by = EXCLUDED.closed_by, closed_at = EXCLUDED.closed_at,
    driver_ack_at = NULL, driver_ack_by = NULL
  RETURNING id INTO v_sid;

  IF v_res = 'DEVOLUCION' THEN
    v_mov := public.caja_post_movement(p_box_id, 'DEVOLUCION', 1::smallint, v_bal, upper(p_payment_method), p_reference,
      'Devolución del saldo del viaje ' || d.dispatch_number, d.driver_id, p_dispatch_id, NULL, NULL, v_sid);
  ELSIF v_res = 'REEMBOLSO' THEN
    v_mov := public.caja_post_movement(p_box_id, 'REEMBOLSO', -1::smallint, abs(v_bal), upper(p_payment_method), p_reference,
      'Reembolso al conductor del viaje ' || d.dispatch_number, d.driver_id, p_dispatch_id, NULL, NULL, v_sid);
  END IF;
  UPDATE public.trip_settlements SET movement_id = v_mov WHERE id = v_sid;
  UPDATE public.trip_advances SET status = 'RENDIDO' WHERE dispatch_id = p_dispatch_id AND status = 'ENTREGADO';
  RETURN jsonb_build_object('success', true, 'settlement_id', v_sid, 'balance', v_bal, 'resolution', v_res);
END $$;

CREATE OR REPLACE FUNCTION public.reopen_trip_settlement(p_dispatch_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.trip_settlements%ROWTYPE;
BEGIN
  IF NOT public.is_tms_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'Solo el Administrador reabre una liquidación'); END IF;
  IF NULLIF(trim(p_reason), '') IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo de la reapertura'); END IF;
  SELECT * INTO s FROM public.trip_settlements WHERE dispatch_id = p_dispatch_id AND status = 'CERRADA' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'El viaje no tiene una liquidación cerrada'); END IF;
  IF s.movement_id IS NOT NULL THEN
    PERFORM public.caja_reverse_movement(s.movement_id, 'Reapertura de ' || s.code || ': ' || trim(p_reason));
  END IF;
  UPDATE public.trip_settlements SET status = 'REABIERTA', reopened_by = auth.uid(), reopened_at = now(), reopen_reason = trim(p_reason)
  WHERE id = s.id;
  UPDATE public.trip_advances SET status = 'ENTREGADO' WHERE dispatch_id = p_dispatch_id AND status = 'RENDIDO';
  RETURN jsonb_build_object('success', true);
END $$;

-- El conductor firma su conformidad desde la app
CREATE OR REPLACE FUNCTION public.acknowledge_trip_settlement(p_dispatch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.trip_settlements s SET driver_ack_at = now(), driver_ack_by = auth.uid()
  WHERE s.dispatch_id = p_dispatch_id AND s.status = 'CERRADA' AND s.driver_ack_at IS NULL
    AND EXISTS (SELECT 1 FROM public.drivers dr WHERE dr.id = s.driver_id AND dr.profile_id = auth.uid());
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'No hay una liquidación suya pendiente de conformidad'); END IF;
  RETURN jsonb_build_object('success', true);
END $$;

-- ------------------------------------------------------------
-- 8. Gastos pagados con caja: el vale se asienta al aprobarse
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.caja_expense_cash_movement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_mov uuid;
BEGIN
  IF NEW.paid_by = 'CAJA' AND NEW.status = 'APROBADO' AND OLD.status IS DISTINCT FROM 'APROBADO' AND COALESCE(NEW.approved_amount, NEW.amount) > 0 THEN
    -- Sin validar saldo: el efectivo ya salió cuando se pagó el vale
    INSERT INTO public.cash_movements (box_id, movement_type, direction, amount, description, driver_id, dispatch_id, expense_id)
    VALUES (NEW.cash_box_id, 'GASTO', -1, COALESCE(NEW.approved_amount, NEW.amount), 'Gasto ' || NEW.expense_type || COALESCE(' ' || NEW.document_series || '-' || NEW.document_number, ''),
            NEW.driver_id, NEW.dispatch_id, NEW.id);
  ELSIF OLD.status = 'APROBADO' AND NEW.status <> 'APROBADO' THEN
    SELECT m.id INTO v_mov FROM public.cash_movements m
    WHERE m.expense_id = NEW.id AND m.movement_type = 'GASTO' AND NOT EXISTS (SELECT 1 FROM public.cash_movements r WHERE r.reverses_id = m.id)
    ORDER BY m.created_at DESC LIMIT 1;
    IF v_mov IS NOT NULL THEN PERFORM public.caja_reverse_movement(v_mov, 'Revisión del gasto revertida'); END IF;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_caja_expense_cash_movement ON public.dispatch_expenses;
CREATE TRIGGER trg_caja_expense_cash_movement AFTER UPDATE OF status ON public.dispatch_expenses
FOR EACH ROW EXECUTE FUNCTION public.caja_expense_cash_movement();

-- Reglas del pagador (se suman a las de C1)
CREATE OR REPLACE FUNCTION public.caja_expense_payer()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT public.caja_in_review() THEN
    NEW.paid_by := OLD.paid_by; NEW.cash_box_id := OLD.cash_box_id;
  END IF;
  IF NEW.paid_by = 'CONDUCTOR' AND NEW.driver_id IS NULL THEN NEW.paid_by := 'EMPRESA'; END IF;
  IF NEW.paid_by <> 'CAJA' THEN NEW.cash_box_id := NULL; END IF;
  IF NEW.paid_by = 'CAJA' AND TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM public.cash_boxes WHERE id = NEW.cash_box_id AND is_active) THEN
    RAISE EXCEPTION 'Seleccione una caja activa para el vale';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_caja_expense_payer ON public.dispatch_expenses;
-- Nombre posterior a trg_caja_expense_normalize: se ejecuta después (orden alfabético)
CREATE TRIGGER trg_caja_expense_payer BEFORE INSERT OR UPDATE ON public.dispatch_expenses
FOR EACH ROW EXECUTE FUNCTION public.caja_expense_payer();

-- ------------------------------------------------------------
-- 9. Cuenta corriente del conductor y saldos de caja
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_cash_box_balances WITH (security_invoker = true) AS
SELECT b.id AS box_id, b.code, b.name, b.box_type, b.site_id, b.currency, b.responsible_id, b.min_balance, b.max_balance, b.is_active, b.allow_negative,
       COALESCE(sum(m.direction * m.amount), 0) AS balance,
       COALESCE(sum(m.amount) FILTER (WHERE m.direction = 1 AND m.created_at >= date_trunc('day', now() AT TIME ZONE 'America/Lima') AT TIME ZONE 'America/Lima'), 0) AS today_in,
       COALESCE(sum(m.amount) FILTER (WHERE m.direction = -1 AND m.created_at >= date_trunc('day', now() AT TIME ZONE 'America/Lima') AT TIME ZONE 'America/Lima'), 0) AS today_out,
       max(m.created_at) AS last_movement_at,
       (SELECT COALESCE(sum(e.amount), 0) FROM public.dispatch_expenses e WHERE e.cash_box_id = b.id AND e.status IN ('PENDIENTE', 'OBSERVADO')) AS pending_vouchers,
       (SELECT max(c.closure_date) FROM public.cash_box_closures c WHERE c.box_id = b.id) AS last_closure_date
FROM public.cash_boxes b LEFT JOIN public.cash_movements m ON m.box_id = b.id
GROUP BY b.id;

CREATE OR REPLACE VIEW public.vw_driver_cash_account WITH (security_invoker = true) AS
WITH mov AS (
  SELECT a.driver_id, a.dispatch_id, 'ANTICIPO'::text AS kind, a.delivered_at AS at, a.amount AS debit, 0::numeric AS credit, a.code AS reference
  FROM public.trip_advances a WHERE a.status IN ('ENTREGADO', 'RENDIDO')
  UNION ALL
  SELECT e.driver_id, e.dispatch_id, 'GASTO', e.reviewed_at, 0, COALESCE(e.approved_amount, e.amount), e.expense_type
  FROM public.dispatch_expenses e WHERE e.status = 'APROBADO' AND e.paid_by = 'CONDUCTOR' AND e.driver_id IS NOT NULL
  UNION ALL
  SELECT s.driver_id, s.dispatch_id, s.resolution, s.closed_at,
         CASE WHEN s.resolution = 'REEMBOLSO' THEN abs(s.balance) ELSE 0 END,
         CASE WHEN s.resolution IN ('DEVOLUCION', 'DESCUENTO_PLANILLA') THEN s.balance ELSE 0 END, s.code
  FROM public.trip_settlements s WHERE s.status = 'CERRADA' AND s.resolution <> 'SIN_SALDO'
)
SELECT m.driver_id, max(p.full_name) AS driver_name,
       COALESCE(sum(m.debit), 0) AS total_debit, COALESCE(sum(m.credit), 0) AS total_credit,
       COALESCE(sum(m.debit - m.credit), 0) AS balance,  -- > 0: el conductor debe rendir/devolver; < 0: la empresa le debe
       (SELECT COALESCE(sum(e.amount), 0) FROM public.dispatch_expenses e WHERE e.driver_id = m.driver_id AND e.paid_by = 'CONDUCTOR' AND e.status IN ('PENDIENTE', 'OBSERVADO')) AS pending_expenses,
       (SELECT count(*) FROM public.caja_driver_overdue_trips(m.driver_id)) AS overdue_trips,
       (SELECT min(a.delivered_at) FROM public.trip_advances a WHERE a.driver_id = m.driver_id AND a.status = 'ENTREGADO') AS oldest_open_advance_at,
       max(m.at) AS last_movement_at
FROM mov m
LEFT JOIN public.vw_caja_people p ON p.id = m.driver_id AND p.kind = 'CONDUCTOR'
GROUP BY m.driver_id;

-- Detalle de movimientos del conductor (estado de cuenta)
CREATE OR REPLACE VIEW public.vw_driver_cash_ledger WITH (security_invoker = true) AS
SELECT a.driver_id, a.dispatch_id, 'ANTICIPO'::text AS kind, a.delivered_at AS at, a.amount AS debit, 0::numeric AS credit, a.code AS reference, a.id AS ref_id
FROM public.trip_advances a WHERE a.status IN ('ENTREGADO', 'RENDIDO')
UNION ALL
SELECT e.driver_id, e.dispatch_id, 'GASTO', e.reviewed_at, 0, COALESCE(e.approved_amount, e.amount), e.expense_type, e.id
FROM public.dispatch_expenses e WHERE e.status = 'APROBADO' AND e.paid_by = 'CONDUCTOR' AND e.driver_id IS NOT NULL
UNION ALL
SELECT s.driver_id, s.dispatch_id, s.resolution, s.closed_at,
       CASE WHEN s.resolution = 'REEMBOLSO' THEN abs(s.balance) ELSE 0 END,
       CASE WHEN s.resolution IN ('DEVOLUCION', 'DESCUENTO_PLANILLA') THEN s.balance ELSE 0 END, s.code, s.id
FROM public.trip_settlements s WHERE s.status = 'CERRADA' AND s.resolution <> 'SIN_SALDO';

-- ------------------------------------------------------------
-- 10. RLS
-- ------------------------------------------------------------
ALTER TABLE public.cash_boxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_box_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_advances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_settlements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_boxes, public.cash_movements, public.cash_box_closures, public.trip_advances, public.trip_settlements FROM anon, authenticated;
GRANT SELECT ON public.cash_movements, public.cash_box_closures, public.trip_advances, public.trip_settlements TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.cash_boxes TO authenticated;
GRANT USAGE ON SEQUENCE public.trip_advance_seq, public.trip_settlement_seq TO authenticated;

DROP POLICY IF EXISTS cash_boxes_read ON public.cash_boxes;
DROP POLICY IF EXISTS cash_boxes_write ON public.cash_boxes;
DROP POLICY IF EXISTS cash_boxes_update ON public.cash_boxes;
DROP POLICY IF EXISTS cash_movements_read ON public.cash_movements;
DROP POLICY IF EXISTS cash_box_closures_read ON public.cash_box_closures;
DROP POLICY IF EXISTS trip_advances_read ON public.trip_advances;
DROP POLICY IF EXISTS trip_settlements_read ON public.trip_settlements;
CREATE POLICY cash_boxes_read ON public.cash_boxes FOR SELECT TO authenticated
  USING (public.can_access_site(site_id) AND public.has_caja_read_access());
CREATE POLICY cash_boxes_write ON public.cash_boxes FOR INSERT TO authenticated
  WITH CHECK (public.can_access_site(site_id) AND public.has_tms_permission('caja-fondos'));
CREATE POLICY cash_boxes_update ON public.cash_boxes FOR UPDATE TO authenticated
  USING (public.can_access_site(site_id) AND public.has_tms_permission('caja-fondos'))
  WITH CHECK (public.can_access_site(site_id) AND public.has_tms_permission('caja-fondos'));
CREATE POLICY cash_movements_read ON public.cash_movements FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.cash_boxes b WHERE b.id = box_id)
    OR (movement_type IN ('ANTICIPO', 'DEVOLUCION', 'REEMBOLSO', 'REVERSION')
        AND EXISTS (SELECT 1 FROM public.drivers dr WHERE dr.id = driver_id AND dr.profile_id = auth.uid())));
CREATE POLICY cash_box_closures_read ON public.cash_box_closures FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.cash_boxes b WHERE b.id = box_id));
CREATE POLICY trip_advances_read ON public.trip_advances FOR SELECT TO authenticated
  USING ((public.has_caja_read_access() AND EXISTS (SELECT 1 FROM public.dispatches d WHERE d.id = dispatch_id AND public.can_access_site(d.site_id)))
    OR EXISTS (SELECT 1 FROM public.drivers dr WHERE dr.id = driver_id AND dr.profile_id = auth.uid()));
CREATE POLICY trip_settlements_read ON public.trip_settlements FOR SELECT TO authenticated
  USING ((public.has_caja_read_access() AND EXISTS (SELECT 1 FROM public.dispatches d WHERE d.id = dispatch_id AND public.can_access_site(d.site_id)))
    OR EXISTS (SELECT 1 FROM public.drivers dr WHERE dr.id = driver_id AND dr.profile_id = auth.uid()));
GRANT SELECT ON public.vw_caja_trip_status, public.vw_cash_box_balances, public.vw_driver_cash_account, public.vw_driver_cash_ledger TO authenticated;

-- cash_funds (prototipo sin uso): se conserva como histórico de solo lectura
REVOKE INSERT, UPDATE, DELETE ON public.cash_funds FROM authenticated;

-- ------------------------------------------------------------
-- 11. Permisos de ejecución
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.caja_post_movement(uuid, text, smallint, numeric, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.caja_reverse_movement(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.caja_driver_overdue_trips(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cash_box_balance(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.register_cash_movement(uuid, text, numeric, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.close_cash_box(uuid, numeric, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_trip_advance(uuid, numeric, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.deliver_trip_advance(uuid, uuid, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_trip_advance(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.preview_trip_settlement(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.close_trip_settlement(uuid, text, uuid, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reopen_trip_settlement(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.acknowledge_trip_settlement(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.caja_driver_overdue_trips(uuid), public.cash_box_balance(uuid),
  public.register_cash_movement(uuid, text, numeric, text, text, text), public.close_cash_box(uuid, numeric, text),
  public.request_trip_advance(uuid, numeric, jsonb, text), public.deliver_trip_advance(uuid, uuid, text, text, text),
  public.cancel_trip_advance(uuid, text), public.preview_trip_settlement(uuid),
  public.close_trip_settlement(uuid, text, uuid, text, text, text), public.reopen_trip_settlement(uuid, text),
  public.acknowledge_trip_settlement(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
