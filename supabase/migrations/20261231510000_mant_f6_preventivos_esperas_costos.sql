-- Mantenimiento fase 6 (20-11-2026): preventivos y correctivos.
-- * Vencimiento original: la OT de un plan guarda al crearse el vencimiento del plan (fecha, km, horas) y no cambia al
--   reprogramar ni al editar el plan. Al cerrar se registra el cumplimiento A_TIEMPO / TARDE contra ese vencimiento y
--   con la lectura del fin técnico (finished_at), no del cierre (lo hace complete_maintenance_order en la fase 7).
-- * Esperas con motivo (REPUESTO, AUTORIZACION, TALLER, VERIFICACION) con inicio y fin, sin superposición por OT.
--   Se abren y cierran con work_order_wait_start / work_order_wait_end (transition_work_order, fase 7, las cierra
--   solas al reanudar, terminar o cancelar, y abre la de VERIFICACION al terminar).
-- * Costos por etapa sin IGV en PEN: cada línea guarda estimado, cotizado, autorizado, facturado y pagado; IGV, moneda
--   original y tipo de cambio aparte. amount = costo real de la línea = facturado, o autorizado si aún no hay factura
--   (nunca la suma de ambos); estimado y cotizado no son costo real. Una línea registrada solo con amount (repuestos
--   del almacén, costos anteriores) se toma como facturada.
-- Producción no coincide con las migraciones: columnas nuevas con IF NOT EXISTS; las existentes verificadas en vivo.
BEGIN;

-- ------------------------------------------------------------
-- 1. Vencimiento original y cumplimiento del preventivo
-- ------------------------------------------------------------
ALTER TABLE public.maintenance_work_orders
  ADD COLUMN IF NOT EXISTS due_date date,
  ADD COLUMN IF NOT EXISTS due_km numeric,
  ADD COLUMN IF NOT EXISTS due_hours numeric,
  ADD COLUMN IF NOT EXISTS executed_odometer numeric,
  ADD COLUMN IF NOT EXISTS executed_hours numeric,
  ADD COLUMN IF NOT EXISTS preventive_compliance text;
DO $$ BEGIN
  ALTER TABLE public.maintenance_work_orders ADD CONSTRAINT maintenance_work_orders_preventive_compliance_check
    CHECK (preventive_compliance IN ('A_TIEMPO', 'TARDE'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMENT ON COLUMN public.maintenance_work_orders.due_date IS 'Vencimiento original del plan al crear la OT; no cambia al reprogramar';
COMMENT ON COLUMN public.maintenance_work_orders.preventive_compliance IS 'A_TIEMPO si el fin técnico ocurrió antes de vencer por fecha, km u horas (lo primero)';

CREATE OR REPLACE FUNCTION public.work_order_plan_due()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p public.maintenance_plans%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- El vencimiento original es inmutable; el cumplimiento y la lectura de ejecución solo los fija el servidor
    IF OLD.due_date IS NOT NULL OR OLD.due_km IS NOT NULL OR OLD.due_hours IS NOT NULL THEN
      NEW.due_date := OLD.due_date; NEW.due_km := OLD.due_km; NEW.due_hours := OLD.due_hours;
    END IF;
    IF current_user IN ('authenticated', 'anon') THEN
      NEW.preventive_compliance := OLD.preventive_compliance;
      NEW.executed_odometer := OLD.executed_odometer; NEW.executed_hours := OLD.executed_hours;
    END IF;
  ELSE
    NEW.preventive_compliance := NULL; NEW.executed_odometer := NULL; NEW.executed_hours := NULL;
  END IF;
  IF NEW.plan_id IS NOT NULL AND NEW.due_date IS NULL AND NEW.due_km IS NULL AND NEW.due_hours IS NULL THEN
    SELECT * INTO p FROM public.maintenance_plans WHERE id = NEW.plan_id;
    NEW.due_date  := p.next_due_date;
    NEW.due_km    := p.next_due_km;
    NEW.due_hours := CASE WHEN p.frequency_hours IS NOT NULL THEN COALESCE(p.last_performed_hours, 0) + p.frequency_hours END;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.work_order_plan_due() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_work_order_plan_due ON public.maintenance_work_orders;
CREATE TRIGGER trg_work_order_plan_due BEFORE INSERT OR UPDATE ON public.maintenance_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.work_order_plan_due();

-- OT abiertas de planes: su plan aún no se recalculó, así que su vencimiento vigente es el original.
-- Las cerradas perdieron el original al recalcularse el plan: quedan sin vencimiento (fuera del cumplimiento).
UPDATE public.maintenance_work_orders wo
SET due_date = p.next_due_date, due_km = p.next_due_km,
    due_hours = CASE WHEN p.frequency_hours IS NOT NULL THEN COALESCE(p.last_performed_hours, 0) + p.frequency_hours END
FROM public.maintenance_plans p
WHERE p.id = wo.plan_id AND wo.status NOT IN ('CERRADA', 'CANCELADA')
  AND wo.due_date IS NULL AND wo.due_km IS NULL AND wo.due_hours IS NULL;

-- ------------------------------------------------------------
-- 2. Esperas de la OT
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.maintenance_work_order_waits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES public.maintenance_work_orders(id) ON DELETE CASCADE,
  reason        text NOT NULL CHECK (reason IN ('REPUESTO', 'AUTORIZACION', 'TALLER', 'VERIFICACION')),
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  notes         text,
  created_by    uuid DEFAULT auth.uid(),
  ended_by      uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX IF NOT EXISTS maintenance_work_order_waits_wo ON public.maintenance_work_order_waits(work_order_id, started_at);
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_work_order_waits_una_abierta ON public.maintenance_work_order_waits(work_order_id) WHERE ended_at IS NULL;

CREATE OR REPLACE FUNCTION public.guard_work_order_wait_overlap()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.maintenance_work_orders WHERE id = NEW.work_order_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.maintenance_work_order_waits w
             WHERE w.work_order_id = NEW.work_order_id AND w.id <> NEW.id
               AND tstzrange(w.started_at, COALESCE(w.ended_at, 'infinity'), '[)')
                && tstzrange(NEW.started_at, COALESCE(NEW.ended_at, 'infinity'), '[)')) THEN
    RAISE EXCEPTION 'La espera se superpone con otra de la misma OT' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_work_order_wait_overlap() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_guard_work_order_wait_overlap ON public.maintenance_work_order_waits;
CREATE TRIGGER trg_guard_work_order_wait_overlap BEFORE INSERT OR UPDATE ON public.maintenance_work_order_waits
  FOR EACH ROW EXECUTE FUNCTION public.guard_work_order_wait_overlap();

ALTER TABLE public.maintenance_work_order_waits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.maintenance_work_order_waits FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.maintenance_work_order_waits TO authenticated;
DROP POLICY IF EXISTS security_active_account ON public.maintenance_work_order_waits;
CREATE POLICY security_active_account ON public.maintenance_work_order_waits
 AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS maintenance_work_order_waits_read ON public.maintenance_work_order_waits;
CREATE POLICY maintenance_work_order_waits_read ON public.maintenance_work_order_waits FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.maintenance_work_orders wo WHERE wo.id = work_order_id
                 AND public.can_access_site(wo.site_id) AND public.has_cmms_read_permission('ot')));

-- Abre una espera. Si la OT está EN_PROCESO pasa a EN_ESPERA; en otros estados abiertos (p. ej. esperando
-- autorización antes de iniciar) solo se registra el tiempo.
CREATE OR REPLACE FUNCTION public.work_order_wait_start(p_work_order_id uuid, p_reason text, p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_wo public.maintenance_work_orders%ROWTYPE; v_reason text := upper(btrim(COALESCE(p_reason, '')));
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_cmms_permission('ot') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para gestionar OT');
  END IF;
  SELECT * INTO v_wo FROM public.maintenance_work_orders WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'OT no encontrada'); END IF;
  IF auth.uid() IS NOT NULL AND NOT public.can_access_site(v_wo.site_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT fuera de su sede');
  END IF;
  IF v_wo.status IN ('CERRADA', 'CANCELADA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'La OT está ' || v_wo.status);
  END IF;
  IF v_reason NOT IN ('REPUESTO', 'AUTORIZACION', 'TALLER', 'VERIFICACION') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Motivo de espera inválido (REPUESTO, AUTORIZACION, TALLER o VERIFICACION)');
  END IF;
  IF EXISTS (SELECT 1 FROM public.maintenance_work_order_waits WHERE work_order_id = v_wo.id AND ended_at IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'La OT ya tiene una espera abierta: ciérrela antes de abrir otra');
  END IF;
  INSERT INTO public.maintenance_work_order_waits (work_order_id, reason, notes, created_by)
  VALUES (v_wo.id, v_reason, NULLIF(btrim(p_notes), ''), auth.uid());
  IF v_wo.status = 'EN_PROCESO' THEN
    UPDATE public.maintenance_work_orders SET status = 'EN_ESPERA',
      notes = concat_ws(E'\n', notes, to_char(now() AT TIME ZONE 'America/Lima', 'DD/MM HH24:MI') || ' EN_ESPERA (' || v_reason || ')' || COALESCE(': ' || NULLIF(btrim(p_notes), ''), ''))
    WHERE id = v_wo.id;
  END IF;
  INSERT INTO public.maintenance_work_order_events (work_order_id, evento, detalle, metadata, created_by)
  VALUES (v_wo.id, 'ESPERA_INICIO', v_reason || COALESCE(' · ' || NULLIF(btrim(p_notes), ''), ''), jsonb_build_object('reason', v_reason), auth.uid());
  RETURN jsonb_build_object('success', true, 'message', 'Espera por ' || v_reason || ' registrada');
END $$;
REVOKE ALL ON FUNCTION public.work_order_wait_start(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.work_order_wait_start(uuid, text, text) TO authenticated;

-- Cierra la espera abierta (uso interno y RPC). Devuelve el motivo cerrado o NULL.
CREATE OR REPLACE FUNCTION public.work_order_wait_close(p_work_order_id uuid, p_actor uuid DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_reason text;
BEGIN
  UPDATE public.maintenance_work_order_waits SET ended_at = now(), ended_by = COALESCE(auth.uid(), p_actor)
  WHERE work_order_id = p_work_order_id AND ended_at IS NULL
  RETURNING reason INTO v_reason;
  IF v_reason IS NOT NULL THEN
    INSERT INTO public.maintenance_work_order_events (work_order_id, evento, detalle, metadata, created_by)
    VALUES (p_work_order_id, 'ESPERA_FIN', v_reason, jsonb_build_object('reason', v_reason), COALESCE(auth.uid(), p_actor));
  END IF;
  RETURN v_reason;
END $$;
REVOKE ALL ON FUNCTION public.work_order_wait_close(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.work_order_wait_end(p_work_order_id uuid, p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_wo public.maintenance_work_orders%ROWTYPE; v_reason text;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_cmms_permission('ot') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para gestionar OT');
  END IF;
  SELECT * INTO v_wo FROM public.maintenance_work_orders WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'OT no encontrada'); END IF;
  IF auth.uid() IS NOT NULL AND NOT public.can_access_site(v_wo.site_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT fuera de su sede');
  END IF;
  IF EXISTS (SELECT 1 FROM public.maintenance_work_order_waits WHERE work_order_id = v_wo.id AND ended_at IS NULL AND reason = 'VERIFICACION') THEN
    RETURN jsonb_build_object('success', false, 'error', 'La espera de verificación termina cuando el Jefe de Distribución valida la OT');
  END IF;
  v_reason := public.work_order_wait_close(v_wo.id, auth.uid());
  IF v_reason IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'La OT no tiene una espera abierta'); END IF;
  IF v_wo.status = 'EN_ESPERA' THEN
    UPDATE public.maintenance_work_orders SET status = 'EN_PROCESO',
      notes = concat_ws(E'\n', notes, to_char(now() AT TIME ZONE 'America/Lima', 'DD/MM HH24:MI') || ' Reanudada tras ' || v_reason || COALESCE(': ' || NULLIF(btrim(p_notes), ''), ''))
    WHERE id = v_wo.id;
  END IF;
  RETURN jsonb_build_object('success', true, 'message', 'Espera por ' || v_reason || ' cerrada');
END $$;
REVOKE ALL ON FUNCTION public.work_order_wait_end(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.work_order_wait_end(uuid, text) TO authenticated;

-- Las OT que hoy están EN_ESPERA quedan con su espera abierta (motivo no informado antes: TALLER)
INSERT INTO public.maintenance_work_order_waits (work_order_id, reason, started_at, notes)
SELECT wo.id, 'TALLER', COALESCE(wo.updated_at, now()), 'Espera anterior a la fase 6 (motivo no registrado)'
FROM public.maintenance_work_orders wo
WHERE wo.status = 'EN_ESPERA' AND NOT EXISTS (SELECT 1 FROM public.maintenance_work_order_waits w WHERE w.work_order_id = wo.id AND w.ended_at IS NULL);

-- ------------------------------------------------------------
-- 3. Costos por etapa (sin IGV, PEN)
-- ------------------------------------------------------------
ALTER TABLE public.work_order_costs
  ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'FACTURADO',
  ADD COLUMN IF NOT EXISTS estimated_amount numeric,
  ADD COLUMN IF NOT EXISTS quoted_amount numeric,
  ADD COLUMN IF NOT EXISTS authorized_amount numeric,
  ADD COLUMN IF NOT EXISTS invoiced_amount numeric,
  ADD COLUMN IF NOT EXISTS paid_amount numeric,
  ADD COLUMN IF NOT EXISTS igv_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'PEN',
  ADD COLUMN IF NOT EXISTS original_amount numeric,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric;
DO $$ BEGIN
  ALTER TABLE public.work_order_costs ADD CONSTRAINT work_order_costs_stage_check
    CHECK (stage IN ('ESTIMADO', 'COTIZADO', 'AUTORIZADO', 'FACTURADO', 'PAGADO'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.work_order_costs ADD CONSTRAINT work_order_costs_stage_amounts_check
    CHECK (COALESCE(estimated_amount, 0) >= 0 AND COALESCE(quoted_amount, 0) >= 0 AND COALESCE(authorized_amount, 0) >= 0
       AND COALESCE(invoiced_amount, 0) >= 0 AND COALESCE(paid_amount, 0) >= 0 AND igv_amount >= 0
       AND currency ~ '^[A-Z]{3}$' AND (exchange_rate IS NULL OR exchange_rate > 0) AND (original_amount IS NULL OR original_amount >= 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMENT ON COLUMN public.work_order_costs.amount IS 'Costo real sin IGV en PEN: facturado, o autorizado si aún no hay factura (no suma etapas)';

CREATE OR REPLACE FUNCTION public.work_order_cost_stages()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF COALESCE(NEW.estimated_amount, NEW.quoted_amount, NEW.authorized_amount, NEW.invoiced_amount, NEW.paid_amount) IS NULL THEN
    NEW.invoiced_amount := NEW.amount;   -- registro directo: costo real conocido
  END IF;
  IF NEW.paid_amount IS NOT NULL AND (NEW.invoiced_amount IS NULL OR NEW.paid_amount > NEW.invoiced_amount) THEN
    RAISE EXCEPTION 'El pago requiere la factura y no puede superar el monto facturado sin IGV' USING ERRCODE = '22023';
  END IF;
  NEW.currency := upper(btrim(COALESCE(NEW.currency, 'PEN')));
  IF NEW.currency <> 'PEN' AND (NEW.original_amount IS NULL OR NEW.exchange_rate IS NULL) THEN
    RAISE EXCEPTION 'Un costo en % requiere el monto original y el tipo de cambio a soles', NEW.currency USING ERRCODE = '22023';
  END IF;
  NEW.stage := CASE WHEN NEW.paid_amount IS NOT NULL THEN 'PAGADO' WHEN NEW.invoiced_amount IS NOT NULL THEN 'FACTURADO'
                    WHEN NEW.authorized_amount IS NOT NULL THEN 'AUTORIZADO' WHEN NEW.quoted_amount IS NOT NULL THEN 'COTIZADO'
                    ELSE 'ESTIMADO' END;
  NEW.amount := COALESCE(NEW.invoiced_amount, NEW.authorized_amount, 0);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_a_work_order_cost_stages ON public.work_order_costs;
-- Nombre ordenado antes de trg_guard_work_order_cost_budget: la guarda de presupuesto ve el monto ya calculado
CREATE TRIGGER trg_a_work_order_cost_stages BEFORE INSERT OR UPDATE ON public.work_order_costs
  FOR EACH ROW EXECUTE FUNCTION public.work_order_cost_stages();

-- Líneas existentes: costo real ya registrado = facturado (sin pasar por las guardas de OT cerradas)
ALTER TABLE public.work_order_costs DISABLE TRIGGER USER;
UPDATE public.work_order_costs SET invoiced_amount = amount, stage = 'FACTURADO'
WHERE invoiced_amount IS NULL AND COALESCE(estimated_amount, quoted_amount, authorized_amount, paid_amount) IS NULL;
ALTER TABLE public.work_order_costs ENABLE TRIGGER USER;

NOTIFY pgrst, 'reload schema';
COMMIT;
