-- ============================================================
-- CAJA DE TRANSPORTE — C5: anticipos por motivo (con o sin viaje)
-- ============================================================
-- Hasta C4 todo anticipo pertenecía a un viaje. Ahora cada anticipo tiene un MOTIVO (catálogo configurable
-- en /caja/tarifario) que define si exige ruta, a qué se carga (VIAJE, UNIDAD o AREA), evidencia, quién
-- aprueba, monto máximo, plazo de rendición y si es una emergencia. Los anticipos sin viaje se rinden y
-- liquidan por sí mismos; su costo va al TCO de la unidad (o al área), no a la rentabilidad de un viaje.
-- Emergencias en ruta (neumático, mecánica) se pueden pedir aunque haya rendiciones vencidas: pasan a
-- aprobación marcadas. (docs/caja/05-c5-anticipos-por-motivo.md)
BEGIN;

-- ------------------------------------------------------------
-- 1. Catálogo de motivos
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.advance_reasons (
  code                 text PRIMARY KEY CHECK (code ~ '^[A-Z_]+$'),
  label                text NOT NULL,
  description          text,
  requires_trip        boolean NOT NULL DEFAULT false,
  charge_to            text NOT NULL CHECK (charge_to IN ('VIAJE', 'UNIDAD', 'AREA')),
  evidence_required    boolean NOT NULL DEFAULT false,
  approval_by          text NOT NULL DEFAULT 'CAJA' CHECK (approval_by IN ('CAJA', 'JEFE')),
  max_amount           numeric(12,2) CHECK (max_amount IS NULL OR max_amount > 0),
  settlement_due_hours int CHECK (settlement_due_hours IS NULL OR settlement_due_hours > 0),
  is_emergency         boolean NOT NULL DEFAULT false,
  creates_failure      boolean NOT NULL DEFAULT false,
  default_expense_type text REFERENCES public.expense_categories(code),
  sort_order           int NOT NULL DEFAULT 100,
  is_active            boolean NOT NULL DEFAULT true,
  CONSTRAINT advance_reasons_trip_check CHECK (requires_trip = (charge_to = 'VIAJE')),
  CONSTRAINT advance_reasons_failure_check CHECK (NOT creates_failure OR charge_to = 'UNIDAD')
);
INSERT INTO public.advance_reasons (code, label, description, requires_trip, charge_to, evidence_required, approval_by,
  max_amount, settlement_due_hours, is_emergency, creates_failure, default_expense_type, sort_order) VALUES
  ('VIATICOS_RUTA', 'Viáticos de ruta', 'Combustible, peajes, alimentación y hospedaje del viaje', true, 'VIAJE', false, 'CAJA',
   NULL, NULL, false, false, NULL, 10),
  ('NEUMATICO', 'Neumático: reparación o cambio', 'Pinchazo, parchado o cambio de neumático de la unidad', false, 'UNIDAD', true, 'JEFE',
   800, 24, true, true, 'LLANTAS_PARCHADO', 20),
  ('MECANICA_EMERGENCIA', 'Mecánica de emergencia / auxilio / grúa', 'Avería que impide continuar: repuesto, mecánico o grúa', false, 'UNIDAD', true, 'JEFE',
   1500, 24, true, true, 'REPUESTOS', 30),
  ('TRAMITE_UNIDAD', 'Trámites de la unidad', 'SOAT, revisión técnica, papeletas u otros documentos de la unidad', false, 'UNIDAD', true, 'CAJA',
   600, 72, false, false, 'OTROS', 40),
  ('OTROS', 'Otros', 'Otro motivo: describa para qué es', false, 'AREA', false, 'JEFE',
   300, 48, false, false, 'OTROS', 90)
ON CONFLICT (code) DO NOTHING;

-- ------------------------------------------------------------
-- 2. Anticipos: motivo, unidad, evidencia, aprobación y plazo
-- ------------------------------------------------------------
ALTER TABLE public.trip_advances ALTER COLUMN dispatch_id DROP NOT NULL;
ALTER TABLE public.trip_advances
  ADD COLUMN IF NOT EXISTS reason_code            text NOT NULL DEFAULT 'VIATICOS_RUTA' REFERENCES public.advance_reasons(code),
  ADD COLUMN IF NOT EXISTS vehicle_plate          text,
  ADD COLUMN IF NOT EXISTS evidence_url           text,
  ADD COLUMN IF NOT EXISTS context_dispatch_id    uuid REFERENCES public.dispatches(id),  -- viaje en curso cuando se pidió (referencia)
  ADD COLUMN IF NOT EXISTS maintenance_request_id uuid,                                     -- falla creada o vinculada
  ADD COLUMN IF NOT EXISTS needs_approval         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at            timestamptz,
  ADD COLUMN IF NOT EXISTS approval_comment       text,
  ADD COLUMN IF NOT EXISTS due_at                 timestamptz,                              -- plazo de rendición (anticipos sin viaje)
  ADD COLUMN IF NOT EXISTS overdue_flag           text;                                     -- rendiciones vencidas al pedir una emergencia
CREATE INDEX IF NOT EXISTS trip_advances_reason_idx ON public.trip_advances (reason_code, status);

-- ------------------------------------------------------------
-- 3. Liquidación de un anticipo sin viaje (misma tabla que la del viaje)
-- ------------------------------------------------------------
ALTER TABLE public.trip_settlements ALTER COLUMN dispatch_id DROP NOT NULL;
ALTER TABLE public.trip_settlements ADD COLUMN IF NOT EXISTS advance_id uuid UNIQUE REFERENCES public.trip_advances(id);
ALTER TABLE public.trip_settlements DROP CONSTRAINT IF EXISTS trip_settlements_target_check;
ALTER TABLE public.trip_settlements ADD CONSTRAINT trip_settlements_target_check CHECK ((dispatch_id IS NULL) <> (advance_id IS NULL));

CREATE OR REPLACE FUNCTION public.caja_advance_is_settled(p_advance_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.trip_settlements WHERE advance_id = p_advance_id AND status = 'CERRADA');
$$;

-- ------------------------------------------------------------
-- 4. Gastos rendidos contra un anticipo sin viaje
-- ------------------------------------------------------------
ALTER TABLE public.dispatch_expenses ADD COLUMN IF NOT EXISTS advance_id uuid REFERENCES public.trip_advances(id);
CREATE INDEX IF NOT EXISTS dispatch_expenses_advance_idx ON public.dispatch_expenses (advance_id) WHERE advance_id IS NOT NULL;
ALTER TABLE public.dispatch_expenses DROP CONSTRAINT IF EXISTS dispatch_expenses_asset_check;
ALTER TABLE public.dispatch_expenses ADD CONSTRAINT dispatch_expenses_asset_check
  CHECK (dispatch_id IS NOT NULL OR vehicle_plate IS NOT NULL OR advance_id IS NOT NULL) NOT VALID;

-- Regla de captura: un gasto sin viaje ni unidad solo existe como rendición de un anticipo (área)
CREATE OR REPLACE FUNCTION public.caja_expense_normalize()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d   record;
  dup record;
BEGIN
  NEW.expense_type    := upper(trim(NEW.expense_type));
  NEW.document_type   := NULLIF(upper(trim(NEW.document_type)), '');
  NEW.document_series := NULLIF(upper(trim(NEW.document_series)), '');
  NEW.document_number := NULLIF(trim(NEW.document_number), '');
  NEW.provider_ruc    := NULLIF(regexp_replace(COALESCE(NEW.provider_ruc, ''), '[^0-9]', '', 'g'), '');
  NEW.provider_name   := NULLIF(trim(NEW.provider_name), '');
  NEW.vehicle_plate   := NULLIF(upper(trim(NEW.vehicle_plate)), '');
  NEW.expense_date    := COALESCE(NEW.expense_date, (now() AT TIME ZONE 'America/Lima')::date);
  NEW.updated_at      := now();

  IF NEW.fuel_station_id IS NOT NULL AND NEW.provider_ruc IS NULL THEN
    SELECT ruc, COALESCE(NEW.provider_name, name) INTO NEW.provider_ruc, NEW.provider_name FROM public.fuel_stations WHERE id = NEW.fuel_station_id;
  END IF;

  -- Validaciones de captura (las RPC de revisión y los procesos de datos no las repiten sobre registros antiguos)
  IF NOT public.caja_in_review() THEN
    IF NEW.amount IS NULL OR NEW.amount <= 0 THEN
      RAISE EXCEPTION 'El importe del gasto debe ser mayor a 0';
    END IF;
    IF NEW.expense_type = 'COMBUSTIBLE' AND (NEW.fuel_gallons IS NOT NULL AND NEW.fuel_gallons <= 0) THEN
      RAISE EXCEPTION 'La cantidad de galones debe ser mayor a 0';
    END IF;
    IF NEW.expense_date > (now() AT TIME ZONE 'America/Lima')::date + 1 THEN
      RAISE EXCEPTION 'La fecha del gasto no puede ser futura';
    END IF;
  END IF;

  -- C5: un anticipo liquidado no admite gastos nuevos ni cambios
  IF NEW.advance_id IS NOT NULL AND public.caja_advance_is_settled(NEW.advance_id) AND NOT public.caja_in_review() THEN
    RAISE EXCEPTION 'El anticipo ya fue liquidado: no admite gastos nuevos ni cambios';
  END IF;

  IF NEW.dispatch_id IS NOT NULL THEN
    SELECT id, vehicle_plate, site_id, driver_id INTO d FROM public.dispatches WHERE id = NEW.dispatch_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Despacho no encontrado'; END IF;
    NEW.vehicle_plate := COALESCE(NEW.vehicle_plate, upper(d.vehicle_plate));
    NEW.site_id := d.site_id;
    IF TG_OP = 'INSERT' THEN NEW.driver_id := COALESCE(NEW.driver_id, d.driver_id); END IF;
    IF public.caja_trip_is_settled(NEW.dispatch_id) AND NOT public.caja_in_review() THEN
      RAISE EXCEPTION 'El viaje ya fue liquidado: no admite gastos nuevos ni cambios';
    END IF;
  ELSIF NEW.vehicle_plate IS NOT NULL THEN
    SELECT site_id INTO NEW.site_id FROM public.vehicles WHERE plate = NEW.vehicle_plate;
    IF NOT FOUND THEN RAISE EXCEPTION 'Placa no registrada: %', NEW.vehicle_plate; END IF;
  ELSIF NEW.advance_id IS NOT NULL THEN
    NEW.site_id := NULL;  -- C5: gasto de un anticipo cargado a un área (sin viaje ni unidad)
  ELSE
    RAISE EXCEPTION 'Indique el despacho o la placa de la unidad';
  END IF;

  IF NOT public.caja_in_review() AND NEW.provider_ruc IS NOT NULL AND NEW.document_type IS NOT NULL
     AND NEW.document_series IS NOT NULL AND NEW.document_number IS NOT NULL THEN
    SELECT o.expense_date, o.status INTO dup FROM public.dispatch_expenses o
    WHERE o.id <> NEW.id AND o.status <> 'RECHAZADO' AND o.provider_ruc = NEW.provider_ruc AND o.document_type = NEW.document_type
      AND upper(o.document_series) = NEW.document_series AND ltrim(o.document_number, '0') = ltrim(NEW.document_number, '0')
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Comprobante duplicado: % %-% del RUC % ya fue registrado el % (%)',
        NEW.document_type, NEW.document_series, NEW.document_number, NEW.provider_ruc, to_char(dup.expense_date, 'DD/MM/YYYY'), dup.status;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_by := COALESCE(NEW.created_by, auth.uid());
    IF NOT public.caja_in_review() THEN
      NEW.status := 'PENDIENTE';
      NEW.approved_amount := NULL; NEW.review_comment := NULL; NEW.reviewed_by := NULL; NEW.reviewed_at := NULL;
      NEW.first_approved_by := NULL; NEW.first_approved_at := NULL;
    END IF;
    NEW.original_amount := NEW.amount;
  ELSIF NOT public.caja_in_review() THEN
    -- Corrección directa (conductor o registrador): solo mientras esté pendiente u observado
    IF OLD.status NOT IN ('PENDIENTE', 'OBSERVADO') THEN
      RAISE EXCEPTION 'El gasto ya fue revisado (%): no se puede modificar', OLD.status;
    END IF;
    NEW.status := CASE WHEN OLD.status = 'OBSERVADO' THEN 'PENDIENTE' ELSE OLD.status END;
    NEW.created_by := OLD.created_by; NEW.created_at := OLD.created_at; NEW.driver_id := OLD.driver_id;
    NEW.dispatch_id := OLD.dispatch_id; NEW.source := OLD.source;
    NEW.approved_amount := OLD.approved_amount; NEW.reviewed_by := OLD.reviewed_by; NEW.reviewed_at := OLD.reviewed_at;
    NEW.review_comment := OLD.review_comment;
    -- Un cambio de importe invalida la pre-aprobación
    IF NEW.amount <> OLD.amount OR OLD.status = 'OBSERVADO' THEN
      NEW.first_approved_by := NULL; NEW.first_approved_at := NULL;
    ELSE
      NEW.first_approved_by := OLD.first_approved_by; NEW.first_approved_at := OLD.first_approved_at;
    END IF;
    NEW.original_amount := NEW.amount;
  END IF;

  NEW.alerts := public.caja_compute_expense_alerts(NEW);
  RETURN NEW;
END $$;
-- ------------------------------------------------------------
-- 5. Rendiciones vencidas: viajes y anticipos sin viaje
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.caja_driver_overdue_advances(p_driver_id uuid)
RETURNS TABLE (advance_id uuid, code text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.id, a.code FROM public.trip_advances a
  WHERE a.driver_id = p_driver_id AND a.dispatch_id IS NULL AND a.status = 'ENTREGADO'
    AND a.due_at < now() AND NOT public.caja_advance_is_settled(a.id);
$$;

-- Texto con todo lo vencido del conductor (NULL si está al día); excluye el viaje indicado
CREATE OR REPLACE FUNCTION public.caja_driver_overdue_label(p_driver_id uuid, p_exclude_dispatch uuid DEFAULT NULL)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT NULLIF(concat_ws(', ',
    (SELECT string_agg(dispatch_number, ', ') FROM public.caja_driver_overdue_trips(p_driver_id)
      WHERE p_exclude_dispatch IS NULL OR dispatch_id <> p_exclude_dispatch),
    (SELECT string_agg(code, ', ') FROM public.caja_driver_overdue_advances(p_driver_id))), '');
$$;

-- ------------------------------------------------------------
-- 6. Solicitud desde la app (con o sin viaje)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_advance_from_app(
  p_reason_code text, p_amount numeric, p_reason text, p_dispatch_id uuid DEFAULT NULL, p_vehicle_plate text DEFAULT NULL,
  p_evidence_url text DEFAULT NULL, p_breakdown jsonb DEFAULT '{}'::jsonb, p_odometer numeric DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r        public.advance_reasons%ROWTYPE;
  v_driver uuid;
  d        record;
  v_trip   uuid;
  v_ctx    uuid;
  v_plate  text;
  v_over   text;
  v_flag   text;
  v_need   boolean;
  v_id     uuid;
  v_code   text;
  v_mr     uuid;
  v_res    jsonb;
BEGIN
  SELECT * INTO r FROM public.advance_reasons WHERE code = upper(trim(p_reason_code)) AND is_active;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Motivo de anticipo no disponible'); END IF;
  SELECT id INTO v_driver FROM public.drivers WHERE profile_id = auth.uid() AND is_active ORDER BY id LIMIT 1;
  IF v_driver IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Solo puede solicitar anticipos un conductor activo'); END IF;

  IF p_dispatch_id IS NOT NULL THEN
    SELECT x.id, x.status, x.vehicle_plate INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id AND x.driver_id = v_driver;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Solo puede solicitar anticipos para un viaje asignado a usted'); END IF;
  END IF;

  IF r.requires_trip THEN
    IF p_dispatch_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Este motivo requiere una ruta asignada');
    END IF;
    IF d.status NOT IN ('PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO') THEN
      RETURN jsonb_build_object('success', false, 'error', 'El viaje ya no está en curso (' || d.status || ')');
    END IF;
    IF public.caja_trip_is_settled(p_dispatch_id) THEN RETURN jsonb_build_object('success', false, 'error', 'El viaje ya fue liquidado'); END IF;
    IF EXISTS (SELECT 1 FROM public.trip_advances WHERE dispatch_id = p_dispatch_id AND status = 'SOLICITADO') THEN
      RETURN jsonb_build_object('success', false, 'error', 'Ya tiene una solicitud pendiente para este viaje: espere la respuesta de Caja');
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each_text(COALESCE(p_breakdown, '{}'::jsonb))
               WHERE key NOT IN ('COMBUSTIBLE', 'PEAJE', 'ALIMENTACION', 'HOSPEDAJE', 'OTROS') OR value !~ '^[0-9]+(\.[0-9]+)?$') THEN
      RETURN jsonb_build_object('success', false, 'error', 'Desglose inválido');
    END IF;
    v_trip := p_dispatch_id;
    v_plate := NULLIF(upper(trim(d.vehicle_plate)), '');
  ELSE
    v_ctx := p_dispatch_id;
    IF r.charge_to = 'UNIDAD' THEN
      v_plate := NULLIF(upper(trim(p_vehicle_plate)), '');
      IF v_plate IS NULL AND p_dispatch_id IS NOT NULL THEN v_plate := NULLIF(upper(trim(d.vehicle_plate)), ''); END IF;
      IF v_plate IS NULL THEN
        SELECT upper(x.vehicle_plate) INTO v_plate FROM public.dispatches x
        WHERE x.driver_id = v_driver AND x.vehicle_plate IS NOT NULL ORDER BY x.created_at DESC LIMIT 1;
      END IF;
      IF v_plate IS NULL OR NOT EXISTS (SELECT 1 FROM public.vehicles WHERE plate = v_plate) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Indique la placa de la unidad');
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM public.trip_advances WHERE driver_id = v_driver AND reason_code = r.code AND dispatch_id IS NULL AND status = 'SOLICITADO') THEN
      RETURN jsonb_build_object('success', false, 'error', 'Ya tiene una solicitud pendiente por este motivo: espere la respuesta');
    END IF;
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('success', false, 'error', 'Ingrese un monto mayor a 0'); END IF;
  IF NULLIF(trim(p_reason), '') IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Indique para qué necesita el anticipo'); END IF;
  IF r.evidence_required AND NULLIF(trim(p_evidence_url), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Adjunte una foto o documento de evidencia');
  END IF;
  -- La evidencia debe ser un archivo propio del conductor (bucket driver_evidence: <usuario>/...)
  IF NULLIF(trim(p_evidence_url), '') IS NOT NULL AND split_part(trim(p_evidence_url), '/', 1) <> auth.uid()::text THEN
    RETURN jsonb_build_object('success', false, 'error', 'Evidencia no válida');
  END IF;

  v_over := public.caja_driver_overdue_label(v_driver, v_trip);
  IF v_over IS NOT NULL THEN
    IF NOT r.is_emergency THEN
      RETURN jsonb_build_object('success', false, 'error', 'Tiene rendiciones vencidas (' || v_over || '). Rinda sus gastos antes de pedir otro anticipo.');
    END IF;
    v_flag := v_over;
  END IF;
  v_need := r.approval_by = 'JEFE' OR (r.max_amount IS NOT NULL AND p_amount > r.max_amount) OR v_flag IS NOT NULL;

  INSERT INTO public.trip_advances (dispatch_id, driver_id, amount, breakdown, reason, source, reason_code, vehicle_plate,
    evidence_url, context_dispatch_id, needs_approval, overdue_flag)
  VALUES (v_trip, v_driver, round(p_amount, 2), CASE WHEN r.requires_trip THEN COALESCE(p_breakdown, '{}'::jsonb) ELSE '{}'::jsonb END,
    trim(p_reason), 'APP', r.code, v_plate, NULLIF(trim(p_evidence_url), ''), v_ctx, v_need, v_flag)
  RETURNING id, code INTO v_id, v_code;

  -- Emergencias de la unidad: se reporta la falla a Mantenimiento (si falla el reporte, el anticipo sigue)
  IF r.creates_failure THEN
    BEGIN
      v_res := public.submit_maintenance_request_v2(v_plate, v_driver, v_ctx,
        r.label || ': ' || trim(p_reason) || ' (anticipo ' || v_code || ')', 'ALTA',
        COALESCE(p_odometer, (SELECT current_odometer FROM public.vehicles WHERE plate = v_plate), 0),
        NULLIF(trim(p_evidence_url), ''), NULL, NULL, NULL, NULL, NULL);
      v_mr := NULLIF(v_res->>'request_id', '')::uuid;
      IF v_mr IS NOT NULL THEN UPDATE public.trip_advances SET maintenance_request_id = v_mr WHERE id = v_id; END IF;
    EXCEPTION WHEN OTHERS THEN
      v_mr := NULL;
    END;
  END IF;

  RETURN jsonb_build_object('success', true, 'advance_id', v_id, 'code', v_code, 'needs_approval', v_need,
    'maintenance_request_id', v_mr, 'overdue', v_flag);
END $$;

-- Compatibilidad: la tarjeta de anticipos del viaje (C4) sigue usando esta firma
CREATE OR REPLACE FUNCTION public.request_trip_advance_from_app(
  p_dispatch_id uuid, p_amount numeric, p_reason text, p_breakdown jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.request_advance_from_app('VIATICOS_RUTA', p_amount, p_reason, p_dispatch_id, NULL, NULL, p_breakdown, NULL);
$$;

-- Caja registra un anticipo sin viaje (p. ej. una emergencia informada por teléfono)
CREATE OR REPLACE FUNCTION public.request_unit_advance(
  p_driver_id uuid, p_reason_code text, p_amount numeric, p_reason text, p_vehicle_plate text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r      public.advance_reasons%ROWTYPE;
  v_plate text := NULLIF(upper(trim(p_vehicle_plate)), '');
  v_over text;
  v_id   uuid;
  v_code text;
BEGIN
  IF NOT public.has_tms_permission('caja-anticipos') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para solicitar anticipos');
  END IF;
  SELECT * INTO r FROM public.advance_reasons WHERE code = upper(trim(p_reason_code)) AND is_active;
  IF NOT FOUND OR r.requires_trip THEN
    RETURN jsonb_build_object('success', false, 'error', 'Elija un motivo sin viaje (los viáticos se piden desde el viaje)');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.drivers WHERE id = p_driver_id AND is_active) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Conductor no encontrado');
  END IF;
  IF r.charge_to = 'UNIDAD' AND (v_plate IS NULL OR NOT EXISTS (SELECT 1 FROM public.vehicles WHERE plate = v_plate)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique la placa de la unidad');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('success', false, 'error', 'El monto debe ser mayor a 0'); END IF;
  IF NULLIF(trim(p_reason), '') IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Indique para qué es el anticipo'); END IF;
  v_over := public.caja_driver_overdue_label(p_driver_id);
  INSERT INTO public.trip_advances (driver_id, amount, reason, source, reason_code, vehicle_plate, needs_approval, overdue_flag)
  VALUES (p_driver_id, round(p_amount, 2), trim(p_reason), 'CAJA', r.code, CASE WHEN r.charge_to = 'UNIDAD' THEN v_plate END,
    r.approval_by = 'JEFE' OR (r.max_amount IS NOT NULL AND p_amount > r.max_amount) OR v_over IS NOT NULL, v_over)
  RETURNING id, code INTO v_id, v_code;
  RETURN jsonb_build_object('success', true, 'advance_id', v_id, 'code', v_code);
END $$;

-- ------------------------------------------------------------
-- 7. Aprobación (Jefe de Distribución / Administrador: permiso caja-aprobacion)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.review_advance_request(p_advance_id uuid, p_decision text, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a     public.trip_advances%ROWTYPE;
  v_dec text := upper(trim(p_decision));
BEGIN
  IF NOT public.has_tms_permission('caja-aprobacion') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el Jefe de Distribución o el Administrador aprueban anticipos');
  END IF;
  SELECT * INTO a FROM public.trip_advances WHERE id = p_advance_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Anticipo no encontrado'); END IF;
  IF a.status <> 'SOLICITADO' THEN RETURN jsonb_build_object('success', false, 'error', 'El anticipo ya está ' || lower(a.status)); END IF;
  IF NOT a.needs_approval OR a.approved_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'El anticipo no está pendiente de aprobación');
  END IF;
  IF EXISTS (SELECT 1 FROM public.drivers WHERE id = a.driver_id AND profile_id = auth.uid()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'No puede aprobar un anticipo propio');
  END IF;
  IF v_dec = 'APROBAR' THEN
    UPDATE public.trip_advances SET approved_by = auth.uid(), approved_at = now(), approval_comment = NULLIF(trim(p_comment), '') WHERE id = a.id;
  ELSIF v_dec = 'RECHAZAR' THEN
    IF NULLIF(trim(p_comment), '') IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo del rechazo'); END IF;
    UPDATE public.trip_advances SET status = 'ANULADO', cancelled_by = auth.uid(), cancel_reason = 'Rechazado: ' || trim(p_comment),
      approval_comment = trim(p_comment) WHERE id = a.id;
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'Decisión inválida');
  END IF;
  RETURN jsonb_build_object('success', true);
END $$;

-- ------------------------------------------------------------
-- 8. Entrega: exige la aprobación cuando corresponde; las emergencias no se bloquean por vencidos
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.deliver_trip_advance(
  p_advance_id uuid, p_box_id uuid, p_payment_method text, p_reference text DEFAULT NULL, p_override_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a        public.trip_advances%ROWTYPE;
  r        public.advance_reasons%ROWTYPE;
  v_over   text;
  v_mov    uuid;
  v_site   uuid;
BEGIN
  IF NOT public.has_tms_permission('caja-anticipos') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para entregar anticipos');
  END IF;
  SELECT * INTO a FROM public.trip_advances WHERE id = p_advance_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Anticipo no encontrado'); END IF;
  SELECT * INTO r FROM public.advance_reasons WHERE code = a.reason_code;
  IF a.status <> 'SOLICITADO' THEN RETURN jsonb_build_object('success', false, 'error', 'El anticipo ya está ' || lower(a.status)); END IF;
  IF a.needs_approval AND a.approved_at IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Este anticipo requiere la aprobación del Jefe de Distribución antes de entregarse');
  END IF;
  IF EXISTS (SELECT 1 FROM public.drivers WHERE id = a.driver_id AND profile_id = auth.uid()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'No puede entregarse un anticipo a sí mismo');
  END IF;
  SELECT site_id INTO v_site FROM public.cash_boxes WHERE id = p_box_id AND is_active;
  IF v_site IS NULL OR NOT public.can_access_site(v_site) THEN RETURN jsonb_build_object('success', false, 'error', 'Seleccione una caja activa'); END IF;
  IF NULLIF(trim(p_payment_method), '') IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Indique la forma de entrega'); END IF;
  v_over := public.caja_driver_overdue_label(a.driver_id, a.dispatch_id);
  -- Una emergencia aprobada se entrega aunque haya vencidos: el aprobador ya los vio (overdue_flag)
  IF v_over IS NOT NULL AND NOT (r.is_emergency AND a.approved_at IS NOT NULL) THEN
    IF NOT public.is_tms_admin() OR NULLIF(trim(p_override_reason), '') IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'El conductor tiene rendiciones vencidas (' || v_over || '). Solo el Administrador puede autorizar, indicando el motivo.', 'overdue', v_over);
    END IF;
  END IF;
  v_mov := public.caja_post_movement(p_box_id, 'ANTICIPO', -1::smallint, a.amount, upper(p_payment_method), p_reference,
    'Anticipo ' || a.code || CASE WHEN a.dispatch_id IS NULL THEN ' · ' || r.label ELSE '' END, a.driver_id, a.dispatch_id, a.id);
  UPDATE public.trip_advances SET status = 'ENTREGADO', box_id = p_box_id, payment_method = upper(p_payment_method),
    reference = NULLIF(trim(p_reference), ''), delivered_by = auth.uid(), delivered_at = now(), movement_id = v_mov,
    override_reason = CASE WHEN v_over IS NOT NULL AND NOT (r.is_emergency AND a.approved_at IS NOT NULL) THEN trim(p_override_reason) END,
    due_at = CASE WHEN a.dispatch_id IS NULL THEN now() + make_interval(hours => COALESCE(r.settlement_due_hours,
      (SELECT settlement_due_hours FROM public.caja_settings WHERE id))) END
  WHERE id = a.id;
  RETURN jsonb_build_object('success', true, 'movement_id', v_mov);
END $$;

-- ------------------------------------------------------------
-- 9. Rendición de gastos contra un anticipo sin viaje
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_advance_expense(
  p_advance_id uuid, p_expense_type text, p_amount numeric, p_receipt_url text DEFAULT NULL, p_description text DEFAULT NULL,
  p_provider_ruc text DEFAULT NULL, p_document_type text DEFAULT NULL, p_document_series text DEFAULT NULL,
  p_document_number text DEFAULT NULL, p_expense_date date DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a      public.trip_advances%ROWTYPE;
  c      public.expense_categories%ROWTYPE;
  v_own  boolean;
  v_id   uuid;
BEGIN
  SELECT * INTO a FROM public.trip_advances WHERE id = p_advance_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Anticipo no encontrado'); END IF;
  v_own := EXISTS (SELECT 1 FROM public.drivers WHERE id = a.driver_id AND profile_id = auth.uid());
  IF NOT v_own AND NOT public.has_tms_permission('caja-gastos') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el conductor del anticipo o Caja registran su rendición');
  END IF;
  IF a.dispatch_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Los gastos de un anticipo de viaje se registran en el viaje');
  END IF;
  IF a.status <> 'ENTREGADO' THEN RETURN jsonb_build_object('success', false, 'error', 'El anticipo no está entregado (' || lower(a.status) || ')'); END IF;
  SELECT * INTO c FROM public.expense_categories WHERE code = upper(trim(p_expense_type)) AND is_active;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Categoría de gasto no válida'); END IF;
  IF c.requires_receipt AND NULLIF(trim(p_receipt_url), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Adjunte la foto del comprobante');
  END IF;
  IF v_own AND NULLIF(trim(p_receipt_url), '') IS NOT NULL AND split_part(trim(p_receipt_url), '/', 1) <> auth.uid()::text THEN
    RETURN jsonb_build_object('success', false, 'error', 'Comprobante no válido');
  END IF;
  INSERT INTO public.dispatch_expenses (advance_id, driver_id, vehicle_plate, expense_type, amount, receipt_url, description,
    provider_ruc, document_type, document_series, document_number, expense_date, paid_by, source, created_by)
  VALUES (a.id, a.driver_id, a.vehicle_plate, c.code, p_amount, NULLIF(trim(p_receipt_url), ''),
    COALESCE(NULLIF(trim(p_description), ''), 'Rendición del anticipo ' || a.code),
    p_provider_ruc, p_document_type, p_document_series, p_document_number, p_expense_date, 'CONDUCTOR',
    CASE WHEN v_own THEN 'APP' ELSE 'WEB' END, auth.uid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', true, 'expense_id', v_id);
END $$;

-- ------------------------------------------------------------
-- 10. Liquidación de un anticipo sin viaje
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.preview_advance_settlement(p_advance_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a        public.trip_advances%ROWTYPE;
  s        record;
  v_block  text[] := '{}';
BEGIN
  SELECT * INTO a FROM public.trip_advances WHERE id = p_advance_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Anticipo no encontrado'); END IF;
  IF NOT (public.has_caja_read_access() OR EXISTS (SELECT 1 FROM public.drivers WHERE id = a.driver_id AND profile_id = auth.uid())) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a la liquidación');
  END IF;
  IF a.dispatch_id IS NOT NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Este anticipo se liquida con su viaje'); END IF;
  SELECT
    COALESCE(sum(COALESCE(approved_amount, amount)) FILTER (WHERE status = 'APROBADO' AND paid_by = 'CONDUCTOR'), 0) AS driver_exp,
    COALESCE(sum(COALESCE(approved_amount, amount)) FILTER (WHERE status = 'APROBADO' AND paid_by <> 'CONDUCTOR'), 0) AS company_exp,
    COALESCE(sum(amount) FILTER (WHERE status = 'RECHAZADO'), 0) AS rejected,
    COALESCE(sum(amount) FILTER (WHERE status <> 'RECHAZADO'), 0) AS declared,
    count(*) FILTER (WHERE status = 'PENDIENTE') AS pending,
    count(*) FILTER (WHERE status = 'OBSERVADO') AS observed
  INTO s FROM public.dispatch_expenses WHERE advance_id = p_advance_id;
  IF a.status NOT IN ('ENTREGADO', 'RENDIDO') THEN v_block := v_block || ('El anticipo no fue entregado (' || lower(a.status) || ')'); END IF;
  IF s.pending > 0 THEN v_block := v_block || (s.pending || ' gasto(s) pendiente(s) de aprobación'); END IF;
  IF s.observed > 0 THEN v_block := v_block || (s.observed || ' gasto(s) observado(s) sin corregir'); END IF;
  RETURN jsonb_build_object('success', true,
    'advances_total', CASE WHEN a.status IN ('ENTREGADO', 'RENDIDO') THEN a.amount ELSE 0 END,
    'driver_expenses', s.driver_exp, 'company_expenses', s.company_exp, 'rejected_total', s.rejected, 'declared_total', s.declared,
    'balance', CASE WHEN a.status IN ('ENTREGADO', 'RENDIDO') THEN a.amount ELSE 0 END - s.driver_exp,
    'suggested_resolution', CASE WHEN a.amount - s.driver_exp > 0 THEN 'DEVOLUCION' WHEN a.amount - s.driver_exp < 0 THEN 'REEMBOLSO' ELSE 'SIN_SALDO' END,
    'settled', public.caja_advance_is_settled(p_advance_id), 'blocking', to_jsonb(v_block));
END $$;

CREATE OR REPLACE FUNCTION public.close_advance_settlement(
  p_advance_id uuid, p_resolution text, p_box_id uuid DEFAULT NULL, p_payment_method text DEFAULT NULL,
  p_reference text DEFAULT NULL, p_notes text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a        public.trip_advances%ROWTYPE;
  p        jsonb;
  v_res    text := upper(trim(p_resolution));
  v_bal    numeric;
  v_sid    uuid;
  v_mov    uuid;
  v_site   uuid;
BEGIN
  IF NOT public.has_tms_permission('caja-liquidaciones') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para liquidar anticipos');
  END IF;
  SELECT * INTO a FROM public.trip_advances WHERE id = p_advance_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Anticipo no encontrado'); END IF;
  IF EXISTS (SELECT 1 FROM public.drivers WHERE id = a.driver_id AND profile_id = auth.uid()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'No puede liquidar un anticipo propio');
  END IF;
  p := public.preview_advance_settlement(p_advance_id);
  IF NOT (p->>'success')::boolean THEN RETURN p; END IF;
  IF (p->>'settled')::boolean THEN RETURN jsonb_build_object('success', false, 'error', 'El anticipo ya está liquidado'); END IF;
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

  INSERT INTO public.trip_settlements (advance_id, driver_id, advances_total, driver_expenses, company_expenses, rejected_total, declared_total,
    balance, resolution, box_id, status, notes, closed_by, closed_at)
  VALUES (a.id, a.driver_id, (p->>'advances_total')::numeric, (p->>'driver_expenses')::numeric, (p->>'company_expenses')::numeric,
    (p->>'rejected_total')::numeric, (p->>'declared_total')::numeric, v_bal, v_res, CASE WHEN v_res IN ('DEVOLUCION', 'REEMBOLSO') THEN p_box_id END,
    'CERRADA', NULLIF(trim(p_notes), ''), auth.uid(), now())
  ON CONFLICT (advance_id) DO UPDATE SET driver_id = EXCLUDED.driver_id, advances_total = EXCLUDED.advances_total,
    driver_expenses = EXCLUDED.driver_expenses, company_expenses = EXCLUDED.company_expenses, rejected_total = EXCLUDED.rejected_total,
    declared_total = EXCLUDED.declared_total, balance = EXCLUDED.balance, resolution = EXCLUDED.resolution, box_id = EXCLUDED.box_id,
    movement_id = NULL, status = 'CERRADA', notes = EXCLUDED.notes, closed_by = EXCLUDED.closed_by, closed_at = EXCLUDED.closed_at,
    driver_ack_at = NULL, driver_ack_by = NULL
  RETURNING id INTO v_sid;

  IF v_res = 'DEVOLUCION' THEN
    v_mov := public.caja_post_movement(p_box_id, 'DEVOLUCION', 1::smallint, v_bal, upper(p_payment_method), p_reference,
      'Devolución del saldo del anticipo ' || a.code, a.driver_id, NULL, a.id, NULL, v_sid);
  ELSIF v_res = 'REEMBOLSO' THEN
    v_mov := public.caja_post_movement(p_box_id, 'REEMBOLSO', -1::smallint, abs(v_bal), upper(p_payment_method), p_reference,
      'Reembolso al conductor del anticipo ' || a.code, a.driver_id, NULL, a.id, NULL, v_sid);
  END IF;
  UPDATE public.trip_settlements SET movement_id = v_mov WHERE id = v_sid;
  UPDATE public.trip_advances SET status = 'RENDIDO' WHERE id = a.id AND status = 'ENTREGADO';
  RETURN jsonb_build_object('success', true, 'settlement_id', v_sid, 'balance', v_bal, 'resolution', v_res);
END $$;

CREATE OR REPLACE FUNCTION public.reopen_advance_settlement(p_advance_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.trip_settlements%ROWTYPE;
BEGIN
  IF NOT public.is_tms_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'Solo el Administrador reabre una liquidación'); END IF;
  IF NULLIF(trim(p_reason), '') IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo de la reapertura'); END IF;
  SELECT * INTO s FROM public.trip_settlements WHERE advance_id = p_advance_id AND status = 'CERRADA' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'El anticipo no tiene una liquidación cerrada'); END IF;
  IF s.movement_id IS NOT NULL THEN
    PERFORM public.caja_reverse_movement(s.movement_id, 'Reapertura de ' || s.code || ': ' || trim(p_reason));
  END IF;
  UPDATE public.trip_settlements SET status = 'REABIERTA', reopened_by = auth.uid(), reopened_at = now(), reopen_reason = trim(p_reason)
  WHERE id = s.id;
  UPDATE public.trip_advances SET status = 'ENTREGADO' WHERE id = p_advance_id AND status = 'RENDIDO';
  RETURN jsonb_build_object('success', true);
END $$;

CREATE OR REPLACE FUNCTION public.acknowledge_advance_settlement(p_advance_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.trip_settlements s SET driver_ack_at = now(), driver_ack_by = auth.uid()
  WHERE s.advance_id = p_advance_id AND s.status = 'CERRADA' AND s.driver_ack_at IS NULL
    AND EXISTS (SELECT 1 FROM public.drivers dr WHERE dr.id = s.driver_id AND dr.profile_id = auth.uid());
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'No hay una liquidación suya pendiente de conformidad'); END IF;
  RETURN jsonb_build_object('success', true);
END $$;

-- ------------------------------------------------------------
-- 11. Vistas
-- ------------------------------------------------------------
-- Anticipos con motivo, rendición y estado (fuente de /caja/anticipos y de la app del conductor)
CREATE OR REPLACE VIEW public.vw_caja_advances WITH (security_invoker = true) AS
WITH exp AS (
  SELECT advance_id,
         count(*) AS expenses_count,
         count(*) FILTER (WHERE status IN ('PENDIENTE', 'OBSERVADO')) AS expenses_open,
         COALESCE(sum(amount) FILTER (WHERE status <> 'RECHAZADO'), 0) AS rendered,
         COALESCE(sum(COALESCE(approved_amount, amount)) FILTER (WHERE status = 'APROBADO'), 0) AS rendered_approved
  FROM public.dispatch_expenses WHERE advance_id IS NOT NULL GROUP BY advance_id
)
SELECT a.id, a.code, a.status, a.source, a.amount, a.breakdown, a.reason, a.reason_code, r.label AS reason_label, r.charge_to,
       r.is_emergency, r.default_expense_type, a.driver_id, p.full_name AS driver_name, a.dispatch_id,
       COALESCE(t.dispatch_number, ctx.dispatch_number) AS dispatch_number, a.context_dispatch_id,
       COALESCE(a.vehicle_plate, t.vehicle_plate) AS vehicle_plate, a.evidence_url, a.maintenance_request_id,
       a.needs_approval, a.approved_by, a.approved_at, a.approval_comment, a.overdue_flag,
       (a.status = 'SOLICITADO' AND a.needs_approval AND a.approved_at IS NULL) AS awaiting_approval,
       a.requested_at, a.delivered_at, a.payment_method, a.reference, a.override_reason, a.cancel_reason, a.due_at, t.status AS dispatch_status,
       (a.dispatch_id IS NULL AND a.status = 'ENTREGADO' AND a.due_at < now()) AS overdue,
       COALESCE(e.expenses_count, 0) AS expenses_count, COALESCE(e.expenses_open, 0) AS expenses_open,
       COALESCE(e.rendered, 0) AS rendered, COALESCE(e.rendered_approved, 0) AS rendered_approved,
       s.code AS settlement_code, s.status AS settlement_status, s.resolution, s.balance AS settlement_balance, s.closed_at, s.driver_ack_at
FROM public.trip_advances a
JOIN public.advance_reasons r ON r.code = a.reason_code
LEFT JOIN public.vw_caja_people p ON p.id = a.driver_id AND p.kind = 'CONDUCTOR'
LEFT JOIN public.vw_caja_trips t ON t.id = a.dispatch_id
LEFT JOIN public.vw_caja_trips ctx ON ctx.id = a.context_dispatch_id
LEFT JOIN exp e ON e.advance_id = a.id
LEFT JOIN public.trip_settlements s ON s.advance_id = a.id;

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
       max(m.at) AS last_movement_at,
       (SELECT count(*) FROM public.caja_driver_overdue_advances(m.driver_id)) AS overdue_advances
FROM mov m
LEFT JOIN public.vw_caja_people p ON p.id = m.driver_id AND p.kind = 'CONDUCTOR'
GROUP BY m.driver_id;

-- ------------------------------------------------------------
-- 12. RLS y permisos
-- ------------------------------------------------------------
ALTER TABLE public.advance_reasons ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.advance_reasons FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.advance_reasons TO authenticated;
DROP POLICY IF EXISTS advance_reasons_read ON public.advance_reasons;
DROP POLICY IF EXISTS advance_reasons_insert ON public.advance_reasons;
DROP POLICY IF EXISTS advance_reasons_update ON public.advance_reasons;
CREATE POLICY advance_reasons_read ON public.advance_reasons FOR SELECT TO authenticated USING (true);
CREATE POLICY advance_reasons_insert ON public.advance_reasons FOR INSERT TO authenticated WITH CHECK (public.has_tms_permission('caja-tarifario'));
CREATE POLICY advance_reasons_update ON public.advance_reasons FOR UPDATE TO authenticated
  USING (public.has_tms_permission('caja-tarifario')) WITH CHECK (public.has_tms_permission('caja-tarifario'));

-- Los anticipos y liquidaciones sin viaje son visibles para Caja (no tienen sede de despacho)
DROP POLICY IF EXISTS trip_advances_read ON public.trip_advances;
CREATE POLICY trip_advances_read ON public.trip_advances FOR SELECT TO authenticated
  USING ((public.has_caja_read_access() AND (dispatch_id IS NULL
            OR EXISTS (SELECT 1 FROM public.dispatches d WHERE d.id = dispatch_id AND public.can_access_site(d.site_id))))
    OR EXISTS (SELECT 1 FROM public.drivers dr WHERE dr.id = driver_id AND dr.profile_id = auth.uid()));
DROP POLICY IF EXISTS trip_settlements_read ON public.trip_settlements;
CREATE POLICY trip_settlements_read ON public.trip_settlements FOR SELECT TO authenticated
  USING ((public.has_caja_read_access() AND (dispatch_id IS NULL
            OR EXISTS (SELECT 1 FROM public.dispatches d WHERE d.id = dispatch_id AND public.can_access_site(d.site_id))))
    OR EXISTS (SELECT 1 FROM public.drivers dr WHERE dr.id = driver_id AND dr.profile_id = auth.uid()));

GRANT SELECT ON public.vw_caja_advances, public.vw_driver_cash_account TO authenticated;

REVOKE ALL ON FUNCTION public.caja_advance_is_settled(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.caja_driver_overdue_advances(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.caja_driver_overdue_label(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_advance_from_app(text, numeric, text, uuid, text, text, jsonb, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_trip_advance_from_app(uuid, numeric, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_unit_advance(uuid, text, numeric, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.review_advance_request(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.deliver_trip_advance(uuid, uuid, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.register_advance_expense(uuid, text, numeric, text, text, text, text, text, text, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.preview_advance_settlement(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.close_advance_settlement(uuid, text, uuid, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reopen_advance_settlement(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.acknowledge_advance_settlement(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.caja_advance_is_settled(uuid), public.caja_driver_overdue_advances(uuid),
  public.caja_driver_overdue_label(uuid, uuid),
  public.request_advance_from_app(text, numeric, text, uuid, text, text, jsonb, numeric),
  public.request_trip_advance_from_app(uuid, numeric, text, jsonb), public.request_unit_advance(uuid, text, numeric, text, text),
  public.review_advance_request(uuid, text, text), public.deliver_trip_advance(uuid, uuid, text, text, text),
  public.register_advance_expense(uuid, text, numeric, text, text, text, text, text, text, date),
  public.preview_advance_settlement(uuid), public.close_advance_settlement(uuid, text, uuid, text, text, text),
  public.reopen_advance_settlement(uuid, text), public.acknowledge_advance_settlement(uuid)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
