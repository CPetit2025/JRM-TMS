-- 20260928090000_f9_cumplimiento.sql
-- FASE 9 — Cumplimiento vehicular.
--
-- * Documentos vehiculares como fuente única (SOAT, RT, póliza, tarjeta, permisos, certificados):
--   renovación desactiva el anterior; los campos soat/RT del vehículo quedan como espejo de solo
--   lectura; alimentan el motor de elegibilidad (F2).
-- * Documentos del conductor (licencia, licencias especiales, examen médico) alimentan
--   check_driver_eligibility (además, conductor inactivo = bloqueado).
-- * Multas y papeletas vinculadas a activo, conductor y viaje (el conductor se infiere del viaje
--   activo a la fecha), estados y responsabilidad; vencimiento automático diario (pg_cron).
-- * Siniestros e incidentes: daño ⇒ falla en el backlog (F3); costo neto al activo.
-- * Alertas documentarias unificadas y costos de cumplimiento por activo (TCO en F11).
-- * RLS: documentos ya no son "visibles para todos" ni escribibles solo por el administrador.

BEGIN;

-- ------------------------------------------------------------
-- 1. Documentos vehiculares
-- ------------------------------------------------------------
ALTER TABLE public.vehicle_documents DROP CONSTRAINT IF EXISTS vehicle_documents_document_type_check;
ALTER TABLE public.vehicle_documents ADD CONSTRAINT vehicle_documents_document_type_check CHECK (document_type IN
  ('SOAT', 'REVISION_TECNICA', 'POLIZA_SEGURO', 'TARJETA_PROPIEDAD', 'PERMISO_CIRCULACION',
   'CERTIFICADO_HABILITACION', 'CERTIFICADO_MATPEL', 'CERTIFICADO_GNV', 'OTRO'));
ALTER TABLE public.vehicle_documents
  ADD COLUMN IF NOT EXISTS issuer text,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.normalize_vehicle_document()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.document_type := upper(trim(NEW.document_type));
  IF NEW.vehicle_id IS NULL AND NEW.vehicle_plate IS NOT NULL THEN
    SELECT id INTO NEW.vehicle_id FROM public.vehicles WHERE plate = upper(trim(NEW.vehicle_plate));
  END IF;
  SELECT plate INTO NEW.vehicle_plate FROM public.vehicles WHERE id = NEW.vehicle_id;
  IF NEW.vehicle_id IS NULL THEN
    RAISE EXCEPTION 'Documento sin unidad válida';
  END IF;
  IF NEW.issue_date IS NOT NULL AND NEW.expiration_date < NEW.issue_date THEN
    RAISE EXCEPTION 'La fecha de vencimiento es anterior a la de emisión';
  END IF;
  NEW.is_active := COALESCE(NEW.is_active, true);
  NEW.created_by := COALESCE(NEW.created_by, auth.uid());
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_normalize_vehicle_document ON public.vehicle_documents;
CREATE TRIGGER trg_normalize_vehicle_document BEFORE INSERT OR UPDATE ON public.vehicle_documents
FOR EACH ROW EXECUTE FUNCTION public.normalize_vehicle_document();

-- Renovación: el documento vigente más reciente desactiva los anteriores del mismo tipo y
-- actualiza el espejo en el vehículo
CREATE OR REPLACE FUNCTION public.sync_vehicle_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vehicle uuid := COALESCE(NEW.vehicle_id, OLD.vehicle_id);
  v_type    text := COALESCE(NEW.document_type, OLD.document_type);
BEGIN
  IF TG_OP = 'INSERT' AND NEW.is_active THEN
    UPDATE public.vehicle_documents SET is_active = false
    WHERE vehicle_id = NEW.vehicle_id AND document_type = NEW.document_type AND id <> NEW.id
      AND is_active AND expiration_date <= NEW.expiration_date;
  END IF;
  IF v_type IN ('SOAT', 'REVISION_TECNICA') THEN
    UPDATE public.vehicles SET
      soat_expiration = CASE WHEN v_type = 'SOAT' THEN (SELECT max(expiration_date) FROM public.vehicle_documents
                              WHERE vehicle_id = v_vehicle AND document_type = 'SOAT' AND is_active) ELSE soat_expiration END,
      technical_review_expiration = CASE WHEN v_type = 'REVISION_TECNICA' THEN (SELECT max(expiration_date) FROM public.vehicle_documents
                              WHERE vehicle_id = v_vehicle AND document_type = 'REVISION_TECNICA' AND is_active) ELSE technical_review_expiration END
    WHERE id = v_vehicle;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_sync_vehicle_document ON public.vehicle_documents;
CREATE TRIGGER trg_sync_vehicle_document AFTER INSERT OR UPDATE OR DELETE ON public.vehicle_documents
FOR EACH ROW EXECUTE FUNCTION public.sync_vehicle_document();

-- Espejos soat/RT del vehículo: solo lectura para el cliente (se gestionan como documentos)
CREATE OR REPLACE FUNCTION public.guard_vehicle_document_mirror()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      -- Fechas iniciales cargadas en el alta se convierten en documentos
      RETURN NEW;
    ELSIF NEW.soat_expiration IS DISTINCT FROM OLD.soat_expiration
       OR NEW.technical_review_expiration IS DISTINCT FROM OLD.technical_review_expiration THEN
      RAISE EXCEPTION 'SOAT y revisión técnica se registran en Cumplimiento → Documentos' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_vehicle_document_mirror ON public.vehicles;
CREATE TRIGGER trg_guard_vehicle_document_mirror BEFORE INSERT OR UPDATE ON public.vehicles
FOR EACH ROW EXECUTE FUNCTION public.guard_vehicle_document_mirror();

CREATE OR REPLACE FUNCTION public.vehicle_initial_documents()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.soat_expiration IS NOT NULL THEN
    INSERT INTO public.vehicle_documents (vehicle_id, document_type, expiration_date, notes, created_by)
    VALUES (NEW.id, 'SOAT', NEW.soat_expiration, 'Registrado en el alta del activo', auth.uid());
  END IF;
  IF NEW.technical_review_expiration IS NOT NULL THEN
    INSERT INTO public.vehicle_documents (vehicle_id, document_type, expiration_date, notes, created_by)
    VALUES (NEW.id, 'REVISION_TECNICA', NEW.technical_review_expiration, 'Registrado en el alta del activo', auth.uid());
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_vehicle_initial_documents ON public.vehicles;
CREATE TRIGGER trg_vehicle_initial_documents AFTER INSERT ON public.vehicles
FOR EACH ROW EXECUTE FUNCTION public.vehicle_initial_documents();

-- Fechas existentes en vehículos ⇒ documentos (una sola fuente)
INSERT INTO public.vehicle_documents (vehicle_id, document_type, expiration_date, notes)
SELECT v.id, 'SOAT', v.soat_expiration, 'Migrado desde la ficha del vehículo' FROM public.vehicles v
WHERE v.soat_expiration IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.vehicle_documents d WHERE d.vehicle_id = v.id AND d.document_type = 'SOAT');
INSERT INTO public.vehicle_documents (vehicle_id, document_type, expiration_date, notes)
SELECT v.id, 'REVISION_TECNICA', v.technical_review_expiration, 'Migrado desde la ficha del vehículo' FROM public.vehicles v
WHERE v.technical_review_expiration IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.vehicle_documents d WHERE d.vehicle_id = v.id AND d.document_type = 'REVISION_TECNICA');

-- ------------------------------------------------------------
-- 2. Documentos del conductor y elegibilidad
-- ------------------------------------------------------------
ALTER TABLE public.driver_documents
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS issuer text,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
UPDATE public.driver_documents SET doc_type = upper(trim(doc_type));
ALTER TABLE public.driver_documents DROP CONSTRAINT IF EXISTS driver_documents_doc_type_check;
ALTER TABLE public.driver_documents ADD CONSTRAINT driver_documents_doc_type_check CHECK (doc_type IN
  ('LICENCIA', 'LICENCIA_ESPECIAL', 'EXAMEN_MEDICO', 'CERTIFICADO_MATPEL', 'SEGURO_VIDA', 'SCTR', 'OTRO'));
ALTER TABLE public.driver_documents ALTER COLUMN driver_id SET NOT NULL;
ALTER TABLE public.driver_documents ALTER COLUMN expiry_date SET NOT NULL;

CREATE OR REPLACE FUNCTION public.sync_driver_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_active THEN
    UPDATE public.driver_documents SET is_active = false, updated_at = now()
    WHERE driver_id = NEW.driver_id AND doc_type = NEW.doc_type AND id <> NEW.id AND is_active AND expiry_date <= NEW.expiry_date;
  END IF;
  IF NEW.doc_type = 'LICENCIA' THEN
    UPDATE public.drivers SET license_expiration = (SELECT max(expiry_date) FROM public.driver_documents
      WHERE driver_id = NEW.driver_id AND doc_type = 'LICENCIA' AND is_active),
      license_number = COALESCE(NULLIF(NEW.doc_number, ''), license_number),
      license_category = COALESCE(NULLIF(NEW.category, ''), license_category)
    WHERE id = NEW.driver_id;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_sync_driver_document ON public.driver_documents;
CREATE TRIGGER trg_sync_driver_document AFTER INSERT OR UPDATE ON public.driver_documents
FOR EACH ROW EXECUTE FUNCTION public.sync_driver_document();

CREATE OR REPLACE FUNCTION public.check_driver_eligibility(p_driver_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_driver   public.drivers%ROWTYPE;
  v_today    date := (now() AT TIME ZONE 'America/Lima')::date;
  v_lic      date;
  v_med      date;
  v_expired  text[];
  v_active   int;
  v_fines    int;
  v_blocking jsonb := '[]'::jsonb;
  v_obs      jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_driver FROM public.drivers WHERE id = p_driver_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('eligible', false, 'status', 'BLOQUEADO', 'blocking_reasons', jsonb_build_array('Conductor no encontrado'),
                              'observation_reasons', '[]'::jsonb, 'checks', '{}'::jsonb);
  END IF;
  IF NOT COALESCE(v_driver.is_active, true) THEN
    v_blocking := v_blocking || jsonb_build_array('Conductor inactivo');
  END IF;

  SELECT max(expiry_date) INTO v_lic FROM public.driver_documents WHERE driver_id = p_driver_id AND doc_type = 'LICENCIA' AND is_active;
  v_lic := COALESCE(v_lic, v_driver.license_expiration);
  IF v_lic IS NULL OR v_lic < v_today THEN
    v_blocking := v_blocking || jsonb_build_array('Licencia vencida o no registrada');
  ELSIF v_lic <= v_today + 30 THEN
    v_obs := v_obs || jsonb_build_array('Licencia vence el ' || to_char(v_lic, 'DD/MM/YYYY'));
  END IF;

  SELECT array_agg(doc_type) INTO v_expired FROM public.driver_documents
  WHERE driver_id = p_driver_id AND is_active AND doc_type IN ('LICENCIA_ESPECIAL', 'CERTIFICADO_MATPEL', 'SCTR') AND expiry_date < v_today;
  IF v_expired IS NOT NULL THEN
    v_blocking := v_blocking || jsonb_build_array('Documento vencido: ' || array_to_string(v_expired, ', '));
  END IF;

  SELECT max(expiry_date) INTO v_med FROM public.driver_documents WHERE driver_id = p_driver_id AND doc_type = 'EXAMEN_MEDICO' AND is_active;
  IF v_med IS NULL THEN
    v_obs := v_obs || jsonb_build_array('Examen médico no registrado');
  ELSIF v_med < v_today THEN
    v_obs := v_obs || jsonb_build_array('Examen médico vencido');
  END IF;

  SELECT count(*) INTO v_fines FROM public.traffic_fines
  WHERE driver_id = p_driver_id AND responsibility = 'CONDUCTOR' AND status IN ('PENDIENTE', 'VENCIDA');
  IF v_fines > 0 THEN
    v_obs := v_obs || jsonb_build_array(v_fines || ' multa(s) pendiente(s) a cargo del conductor');
  END IF;

  SELECT count(*) INTO v_active FROM public.dispatches
  WHERE driver_id = p_driver_id AND status NOT IN ('LIQUIDADO', 'CERRADO', 'CANCELADO', 'RETORNO_COMPLETADO');
  IF v_active > 0 THEN
    v_blocking := v_blocking || jsonb_build_array('Conductor tiene despacho activo');
  END IF;

  RETURN jsonb_build_object(
    'eligible', jsonb_array_length(v_blocking) = 0,
    'status', CASE WHEN jsonb_array_length(v_blocking) > 0 THEN 'BLOQUEADO'
                   WHEN jsonb_array_length(v_obs) > 0 THEN 'APTO_CON_OBSERVACION' ELSE 'APTO' END,
    'blocking_reasons', v_blocking,
    'observation_reasons', v_obs,
    'checks', jsonb_build_object('driver_active', COALESCE(v_driver.is_active, true),
      'licencia_ok', v_lic IS NOT NULL AND v_lic >= v_today, 'special_docs_ok', v_expired IS NULL,
      'examen_medico_ok', v_med IS NOT NULL AND v_med >= v_today, 'no_active_dispatch', v_active = 0));
END;
$$;

-- ------------------------------------------------------------
-- 3. Multas y papeletas
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.traffic_fines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fine_type          text NOT NULL DEFAULT 'PAPELETA' CHECK (fine_type IN ('PAPELETA', 'MULTA')),
  vehicle_id         uuid NOT NULL REFERENCES public.vehicles(id),
  vehicle_plate      text,
  driver_id          uuid REFERENCES public.drivers(id) ON DELETE SET NULL,
  dispatch_id        uuid REFERENCES public.dispatches(id) ON DELETE SET NULL,
  infraction_date    timestamptz NOT NULL,
  infraction_code    text,
  description        text,
  entity             text NOT NULL,
  ticket_number      text NOT NULL,
  amount             numeric(12,2) NOT NULL CHECK (amount >= 0),
  due_date           date,
  status             text NOT NULL DEFAULT 'PENDIENTE' CHECK (status IN ('PENDIENTE', 'EN_REVISION', 'APELACION', 'PAGADA', 'ANULADA', 'VENCIDA')),
  responsibility     text NOT NULL DEFAULT 'POR_DETERMINAR' CHECK (responsibility IN ('CONDUCTOR', 'EMPRESA', 'TERCERO', 'POR_DETERMINAR')),
  responsible_id     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  evidence_url       text,
  paid_amount        numeric(12,2),
  paid_at            date,
  payment_reference  text,
  notes              text,
  site_id            uuid REFERENCES public.sites(id),
  created_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_traffic_fines_ticket ON public.traffic_fines (upper(entity), upper(ticket_number));
CREATE INDEX IF NOT EXISTS idx_traffic_fines_vehicle ON public.traffic_fines (vehicle_id, status);
CREATE INDEX IF NOT EXISTS idx_traffic_fines_driver ON public.traffic_fines (driver_id, status);

CREATE OR REPLACE FUNCTION public.normalize_traffic_fine()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.entity := upper(trim(NEW.entity));
  NEW.ticket_number := upper(trim(NEW.ticket_number));
  SELECT plate, site_id INTO NEW.vehicle_plate, NEW.site_id FROM public.vehicles WHERE id = NEW.vehicle_id;
  -- Viaje y conductor se infieren del despacho de la unidad vigente a la fecha de la infracción
  IF NEW.dispatch_id IS NULL THEN
    SELECT id INTO NEW.dispatch_id FROM public.dispatches
    WHERE vehicle_plate = NEW.vehicle_plate AND NEW.infraction_date >= COALESCE(departure_time, scheduled_departure, created_at)
      AND (arrival_time IS NULL OR NEW.infraction_date <= arrival_time + interval '12 hours')
    ORDER BY COALESCE(departure_time, scheduled_departure, created_at) DESC LIMIT 1;
  END IF;
  IF NEW.driver_id IS NULL AND NEW.dispatch_id IS NOT NULL THEN
    SELECT driver_id INTO NEW.driver_id FROM public.dispatches WHERE id = NEW.dispatch_id;
  END IF;
  NEW.updated_at := now();
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := COALESCE(NEW.created_by, auth.uid());
    NEW.status := CASE WHEN NEW.due_date IS NOT NULL AND NEW.due_date < (now() AT TIME ZONE 'America/Lima')::date THEN 'VENCIDA' ELSE 'PENDIENTE' END;
  ELSIF current_user IN ('authenticated', 'anon') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'El estado de la multa cambia con transition_traffic_fine()' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_normalize_traffic_fine ON public.traffic_fines;
CREATE TRIGGER trg_normalize_traffic_fine BEFORE INSERT OR UPDATE ON public.traffic_fines
FOR EACH ROW EXECUTE FUNCTION public.normalize_traffic_fine();

CREATE OR REPLACE FUNCTION public.transition_traffic_fine(
  p_fine_id uuid, p_status text, p_notes text DEFAULT NULL,
  p_paid_amount numeric DEFAULT NULL, p_paid_at date DEFAULT NULL, p_payment_reference text DEFAULT NULL,
  p_responsibility text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f         public.traffic_fines%ROWTYPE;
  v_allowed text[];
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_cmms_permission('vencimientos') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para gestionar multas');
  END IF;
  SELECT * INTO f FROM public.traffic_fines WHERE id = p_fine_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Multa no encontrada');
  END IF;
  v_allowed := CASE f.status
    WHEN 'PENDIENTE'   THEN ARRAY['EN_REVISION', 'APELACION', 'PAGADA', 'ANULADA', 'VENCIDA']
    WHEN 'EN_REVISION' THEN ARRAY['PENDIENTE', 'APELACION', 'PAGADA', 'ANULADA']
    WHEN 'APELACION'   THEN ARRAY['PENDIENTE', 'PAGADA', 'ANULADA']
    WHEN 'VENCIDA'     THEN ARRAY['APELACION', 'PAGADA', 'ANULADA']
    ELSE ARRAY[]::text[] END;
  IF NOT (p_status = ANY (v_allowed)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transición no permitida: ' || f.status || ' → ' || COALESCE(p_status, 'NULL'));
  END IF;
  IF p_status = 'PAGADA' AND (p_paid_amount IS NULL OR p_paid_amount < 0 OR NULLIF(trim(p_payment_reference), '') IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Registre monto pagado y referencia del pago');
  END IF;
  IF p_status IN ('ANULADA', 'APELACION') AND NULLIF(trim(p_notes), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique el sustento');
  END IF;
  IF p_status = 'PAGADA' AND COALESCE(p_responsibility, f.responsibility) = 'POR_DETERMINAR' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Defina la responsabilidad antes de registrar el pago');
  END IF;

  UPDATE public.traffic_fines SET
    status = p_status,
    responsibility = COALESCE(p_responsibility, responsibility),
    paid_amount = CASE WHEN p_status = 'PAGADA' THEN p_paid_amount ELSE paid_amount END,
    paid_at = CASE WHEN p_status = 'PAGADA' THEN COALESCE(p_paid_at, (now() AT TIME ZONE 'America/Lima')::date) ELSE paid_at END,
    payment_reference = CASE WHEN p_status = 'PAGADA' THEN p_payment_reference ELSE payment_reference END,
    notes = CASE WHEN p_notes IS NOT NULL THEN concat_ws(E'\n', notes, to_char(now() AT TIME ZONE 'America/Lima', 'DD/MM') || ' ' || p_status || ': ' || p_notes) ELSE notes END
  WHERE id = p_fine_id;
  RETURN jsonb_build_object('success', true, 'previous_status', f.status, 'new_status', p_status);
END;
$$;
REVOKE ALL ON FUNCTION public.transition_traffic_fine(uuid, text, text, numeric, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transition_traffic_fine(uuid, text, text, numeric, date, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.expire_traffic_fines()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n int;
BEGIN
  UPDATE public.traffic_fines SET status = 'VENCIDA'
  WHERE status = 'PENDIENTE' AND due_date < (now() AT TIME ZONE 'America/Lima')::date;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.expire_traffic_fines() FROM PUBLIC, anon, authenticated;
SELECT cron.schedule('cmms-expire-traffic-fines', '10 11 * * *', $cron$SELECT public.expire_traffic_fines()$cron$);

-- ------------------------------------------------------------
-- 4. Siniestros e incidentes
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vehicle_incidents (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_type          text NOT NULL CHECK (incident_type IN ('ACCIDENTE', 'SINIESTRO', 'ROBO', 'DANO', 'INCIDENTE')),
  severity               text NOT NULL DEFAULT 'MEDIA' CHECK (severity IN ('CRITICA', 'ALTA', 'MEDIA', 'BAJA')),
  vehicle_id             uuid NOT NULL REFERENCES public.vehicles(id),
  vehicle_plate          text,
  driver_id              uuid REFERENCES public.drivers(id) ON DELETE SET NULL,
  dispatch_id            uuid REFERENCES public.dispatches(id) ON DELETE SET NULL,
  occurred_at            timestamptz NOT NULL,
  location               text,
  description            text NOT NULL,
  third_parties          text,
  police_report          text,
  insurance_claim_number text,
  estimated_cost         numeric(12,2) CHECK (estimated_cost >= 0),
  final_cost             numeric(12,2) CHECK (final_cost >= 0),
  insurance_coverage     numeric(12,2) NOT NULL DEFAULT 0 CHECK (insurance_coverage >= 0),
  responsibility         text NOT NULL DEFAULT 'POR_DETERMINAR' CHECK (responsibility IN ('CONDUCTOR', 'EMPRESA', 'TERCERO', 'POR_DETERMINAR')),
  status                 text NOT NULL DEFAULT 'REPORTADO' CHECK (status IN ('REPORTADO', 'EN_EVALUACION', 'EN_RECLAMO', 'CERRADO')),
  vehicle_damage         boolean NOT NULL DEFAULT false,
  maintenance_request_id uuid REFERENCES public.maintenance_requests(id) ON DELETE SET NULL,
  evidence_urls          jsonb NOT NULL DEFAULT '[]'::jsonb,
  site_id                uuid REFERENCES public.sites(id),
  created_by             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  closed_at              timestamptz
);
CREATE INDEX IF NOT EXISTS idx_vehicle_incidents_vehicle ON public.vehicle_incidents (vehicle_id, status);

CREATE OR REPLACE FUNCTION public.normalize_vehicle_incident()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  SELECT plate, site_id INTO NEW.vehicle_plate, NEW.site_id FROM public.vehicles WHERE id = NEW.vehicle_id;
  IF NEW.dispatch_id IS NULL THEN
    SELECT id INTO NEW.dispatch_id FROM public.dispatches
    WHERE vehicle_plate = NEW.vehicle_plate AND NEW.occurred_at >= COALESCE(departure_time, scheduled_departure, created_at)
      AND (arrival_time IS NULL OR NEW.occurred_at <= arrival_time + interval '12 hours')
    ORDER BY COALESCE(departure_time, scheduled_departure, created_at) DESC LIMIT 1;
  END IF;
  IF NEW.driver_id IS NULL AND NEW.dispatch_id IS NOT NULL THEN
    SELECT driver_id INTO NEW.driver_id FROM public.dispatches WHERE id = NEW.dispatch_id;
  END IF;
  IF NEW.status = 'CERRADO' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'CERRADO') THEN
    IF NEW.final_cost IS NULL OR NEW.responsibility = 'POR_DETERMINAR' THEN
      RAISE EXCEPTION 'Para cerrar el siniestro registre el costo final y la responsabilidad';
    END IF;
    NEW.closed_at := now();
  END IF;
  NEW.created_by := COALESCE(NEW.created_by, auth.uid());
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_normalize_vehicle_incident ON public.vehicle_incidents;
CREATE TRIGGER trg_normalize_vehicle_incident BEFORE INSERT OR UPDATE ON public.vehicle_incidents
FOR EACH ROW EXECUTE FUNCTION public.normalize_vehicle_incident();

-- Daño a la unidad ⇒ falla en el backlog (una sola vez); crítica ⇒ bloqueo por motor
CREATE OR REPLACE FUNCTION public.incident_to_maintenance_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_req uuid;
BEGIN
  IF NEW.vehicle_damage AND NEW.maintenance_request_id IS NULL THEN
    INSERT INTO public.maintenance_requests (vehicle_plate, driver_id, dispatch_id, description, severity, status, source, reported_at, reported_by, notes)
    VALUES (NEW.vehicle_plate, NEW.driver_id, NEW.dispatch_id,
            initcap(lower(NEW.incident_type)) || ': ' || left(NEW.description, 180), NEW.severity, 'REPORTADA', 'SUPERVISOR',
            NEW.occurred_at, NEW.created_by, 'Generada por siniestro/incidente ' || NEW.id)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_req;
    IF v_req IS NOT NULL THEN
      UPDATE public.vehicle_incidents SET maintenance_request_id = v_req WHERE id = NEW.id;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_incident_to_maintenance_request ON public.vehicle_incidents;
CREATE TRIGGER trg_incident_to_maintenance_request AFTER INSERT OR UPDATE OF vehicle_damage ON public.vehicle_incidents
FOR EACH ROW EXECUTE FUNCTION public.incident_to_maintenance_request();

-- ------------------------------------------------------------
-- 5. Alertas y costos de cumplimiento
-- ------------------------------------------------------------
DROP VIEW IF EXISTS public.vw_document_alerts;
CREATE VIEW public.vw_document_alerts
WITH (security_invoker = true) AS
SELECT d.id, d.vehicle_id, d.vehicle_plate, d.document_type, d.document_number, d.issuer, d.issue_date, d.expiration_date,
  d.file_url, d.is_active, d.created_at, d.updated_at, v.site_id,
  d.expiration_date - (now() AT TIME ZONE 'America/Lima')::date AS days_remaining,
  CASE WHEN d.expiration_date < (now() AT TIME ZONE 'America/Lima')::date THEN 'VENCIDO'
       WHEN d.expiration_date <= (now() AT TIME ZONE 'America/Lima')::date + 15 THEN 'POR_VENCER'
       WHEN d.expiration_date <= (now() AT TIME ZONE 'America/Lima')::date + 30 THEN 'PROXIMO'
       ELSE 'VIGENTE' END AS status
FROM public.vehicle_documents d
JOIN public.vehicles v ON v.id = d.vehicle_id
WHERE d.is_active;
GRANT SELECT ON public.vw_document_alerts TO authenticated, service_role;

CREATE OR REPLACE VIEW public.vw_compliance_alerts
WITH (security_invoker = true) AS
SELECT 'DOCUMENTO_VEHICULO' AS alert_type, a.status AS level, a.vehicle_plate AS subject, a.document_type AS detail,
       a.expiration_date AS due_date, a.days_remaining, a.site_id, a.id AS ref_id
FROM public.vw_document_alerts a WHERE a.status <> 'VIGENTE'
UNION ALL
SELECT 'DOCUMENTO_CONDUCTOR', CASE WHEN dd.expiry_date < (now() AT TIME ZONE 'America/Lima')::date THEN 'VENCIDO'
                                   WHEN dd.expiry_date <= (now() AT TIME ZONE 'America/Lima')::date + 15 THEN 'POR_VENCER' ELSE 'PROXIMO' END,
       concat_ws(' ', dr.first_name, dr.last_name), dd.doc_type, dd.expiry_date,
       dd.expiry_date - (now() AT TIME ZONE 'America/Lima')::date, NULL::uuid, dd.id
FROM public.driver_documents dd JOIN public.drivers dr ON dr.id = dd.driver_id
WHERE dd.is_active AND dd.expiry_date <= (now() AT TIME ZONE 'America/Lima')::date + 30
UNION ALL
SELECT 'MULTA', f.status, f.vehicle_plate, f.entity || ' ' || f.ticket_number || ' · S/ ' || f.amount, f.due_date,
       f.due_date - (now() AT TIME ZONE 'America/Lima')::date, f.site_id, f.id
FROM public.traffic_fines f WHERE f.status IN ('PENDIENTE', 'VENCIDA', 'EN_REVISION', 'APELACION')
UNION ALL
SELECT 'SINIESTRO', i.status, i.vehicle_plate, i.incident_type || ' · ' || left(i.description, 60), i.occurred_at::date,
       NULL::int, i.site_id, i.id
FROM public.vehicle_incidents i WHERE i.status <> 'CERRADO';
GRANT SELECT ON public.vw_compliance_alerts TO authenticated, service_role;

CREATE OR REPLACE VIEW public.vw_compliance_costs
WITH (security_invoker = true) AS
SELECT v.id AS vehicle_id, v.plate,
  COALESCE((SELECT sum(COALESCE(paid_amount, amount)) FROM public.traffic_fines f
            WHERE f.vehicle_id = v.id AND f.status = 'PAGADA' AND f.responsibility = 'EMPRESA'), 0) AS fines_company_cost,
  COALESCE((SELECT sum(COALESCE(paid_amount, amount)) FROM public.traffic_fines f
            WHERE f.vehicle_id = v.id AND f.status = 'PAGADA' AND f.responsibility = 'CONDUCTOR'), 0) AS fines_driver_charged,
  COALESCE((SELECT sum(amount) FROM public.traffic_fines f
            WHERE f.vehicle_id = v.id AND f.status IN ('PENDIENTE', 'VENCIDA', 'EN_REVISION', 'APELACION')), 0) AS fines_outstanding,
  COALESCE((SELECT sum(GREATEST(COALESCE(final_cost, estimated_cost, 0) - insurance_coverage, 0)) FROM public.vehicle_incidents i
            WHERE i.vehicle_id = v.id AND i.responsibility IN ('EMPRESA', 'CONDUCTOR', 'POR_DETERMINAR')), 0) AS incidents_net_cost
FROM public.vehicles v;
GRANT SELECT ON public.vw_compliance_costs TO authenticated, service_role;

-- ------------------------------------------------------------
-- 6. RLS
-- ------------------------------------------------------------
DROP POLICY IF EXISTS veh_docs_read ON public.vehicle_documents;
DROP POLICY IF EXISTS veh_docs_write ON public.vehicle_documents;
DROP POLICY IF EXISTS drv_docs_read ON public.driver_documents;
DROP POLICY IF EXISTS drv_docs_write ON public.driver_documents;

CREATE POLICY veh_docs_read ON public.vehicle_documents FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.vehicles v WHERE v.id = vehicle_id AND public.can_access_site(v.site_id)
          AND (public.has_cmms_read_permission('vencimientos') OR public.has_cmms_read_permission('flota'))));
CREATE POLICY veh_docs_write ON public.vehicle_documents FOR ALL TO authenticated
  USING (public.has_cmms_permission('vencimientos')) WITH CHECK (public.has_cmms_permission('vencimientos'));

CREATE POLICY drv_docs_read ON public.driver_documents FOR SELECT TO authenticated USING (
  public.has_cmms_read_permission('vencimientos') OR public.has_tms_read_permission('maestros-trabajadores')
  OR driver_id IN (SELECT id FROM public.drivers WHERE profile_id = auth.uid()));
CREATE POLICY drv_docs_write ON public.driver_documents FOR ALL TO authenticated
  USING (public.has_cmms_permission('vencimientos') OR public.has_tms_permission('maestros-trabajadores'))
  WITH CHECK (public.has_cmms_permission('vencimientos') OR public.has_tms_permission('maestros-trabajadores'));

ALTER TABLE public.traffic_fines ENABLE ROW LEVEL SECURITY;
CREATE POLICY fines_read ON public.traffic_fines FOR SELECT TO authenticated USING (
  (public.can_access_site(site_id) AND public.has_cmms_read_permission('vencimientos'))
  OR driver_id IN (SELECT id FROM public.drivers WHERE profile_id = auth.uid()));
CREATE POLICY fines_insert ON public.traffic_fines FOR INSERT TO authenticated WITH CHECK (public.has_cmms_permission('vencimientos'));
CREATE POLICY fines_update ON public.traffic_fines FOR UPDATE TO authenticated
  USING (public.can_access_site(site_id) AND public.has_cmms_permission('vencimientos'))
  WITH CHECK (public.can_access_site(site_id) AND public.has_cmms_permission('vencimientos'));

ALTER TABLE public.vehicle_incidents ENABLE ROW LEVEL SECURITY;
CREATE POLICY incidents_read ON public.vehicle_incidents FOR SELECT TO authenticated USING (
  (public.can_access_site(site_id) AND (public.has_cmms_read_permission('vencimientos') OR public.has_cmms_read_permission('flota')))
  OR driver_id IN (SELECT id FROM public.drivers WHERE profile_id = auth.uid()));
CREATE POLICY incidents_insert ON public.vehicle_incidents FOR INSERT TO authenticated
  WITH CHECK (public.has_cmms_permission('vencimientos') OR public.has_cmms_permission('flota'));
CREATE POLICY incidents_update ON public.vehicle_incidents FOR UPDATE TO authenticated
  USING (public.can_access_site(site_id) AND (public.has_cmms_permission('vencimientos') OR public.has_cmms_permission('flota')))
  WITH CHECK (public.can_access_site(site_id) AND (public.has_cmms_permission('vencimientos') OR public.has_cmms_permission('flota')));

-- ------------------------------------------------------------
-- 7. Flota 360°: multas, siniestros y costos de cumplimiento
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_fleet_360_view(p_plate text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v public.vehicles%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.vehicles WHERE plate = upper(trim(p_plate));
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'vehicle', to_jsonb(v) || jsonb_build_object(
      'carrier_name', (SELECT business_name FROM public.carriers WHERE id = v.carrier_id),
      'responsible_name', (SELECT NULLIF(trim(concat_ws(' ', first_name, last_name)), '') FROM public.profiles WHERE id = v.responsible_id)),
    'eligibility', public.check_asset_eligibility(v.plate, 'RELEASE'),
    'costs', (SELECT to_jsonb(t) FROM public.vehicle_tco_analytics t WHERE t.vehicle_id = v.id),
    'open_requests', COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.priority_score DESC)
                               FROM public.vw_maintenance_backlog b WHERE b.vehicle_plate = v.plate), '[]'::jsonb),
    'requests_history', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.reported_at DESC) FROM (
                               SELECT id, description, severity, status, source, reported_at, closed_at, photo_url
                               FROM public.maintenance_requests WHERE vehicle_plate = v.plate
                               ORDER BY reported_at DESC LIMIT 30) r), '[]'::jsonb),
    'work_orders', COALESCE((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.created_at DESC) FROM (
                               SELECT id, ot_code, status, order_type, priority, description, total_cost, downtime_hours,
                                      downtime_start, closed_at, created_at, evidence_urls
                               FROM public.vw_work_orders WHERE vehicle_id = v.id ORDER BY created_at DESC LIMIT 30) w), '[]'::jsonb),
    'preventive', COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM public.vw_maintenance_projections p WHERE p.vehicle_plate = v.plate), '[]'::jsonb),
    'inspections', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.date DESC) FROM (
                               SELECT i.id, i.date, i.global_result, t.name AS template_name, t.type AS template_type
                               FROM public.inspections i LEFT JOIN public.checklist_templates t ON t.id = i.template_id
                               WHERE i.vehicle_plate = v.plate ORDER BY i.date DESC LIMIT 20) i), '[]'::jsonb),
    'tires', COALESCE((SELECT jsonb_agg(to_jsonb(tr) ORDER BY tr.posicion_actual) FROM (
                               SELECT id, codigo_interno, marca, modelo, medida, posicion_actual, cocada_actual,
                                      cocada_original, total_km_travelled, estado, costo
                               FROM public.tires WHERE current_vehicle_plate = v.plate OR vehiculo_actual_id = v.id) tr), '[]'::jsonb),
    'documents', COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.expiration_date) FROM public.vw_document_alerts d
                           WHERE d.vehicle_plate = v.plate), '[]'::jsonb),
    'readings', COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.created_at DESC) FROM (
                               SELECT odometer_value, source_event, status, created_at, photo_url
                               FROM public.vehicle_odometer_logs WHERE vehicle_plate = v.plate
                               ORDER BY created_at DESC LIMIT 20) o), '[]'::jsonb),
    'dispatches', COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.created_at DESC) FROM (
                               SELECT id, dispatch_number, status, scheduled_departure, driver_name, actual_distance_km, created_at
                               FROM public.dispatches WHERE vehicle_plate = v.plate ORDER BY created_at DESC LIMIT 15) d), '[]'::jsonb),
    'history', COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.created_at DESC) FROM (
                               SELECT h.field_changed, h.old_value, h.new_value, h.change_reason, h.created_at,
                                      NULLIF(trim(concat_ws(' ', p.first_name, p.last_name)), '') AS changed_by_name
                               FROM public.vehicle_history_logs h LEFT JOIN public.profiles p ON p.id = h.changed_by
                               WHERE h.vehicle_plate = v.plate ORDER BY h.created_at DESC LIMIT 60) h), '[]'::jsonb),
    'fines', COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.infraction_date DESC) FROM (
                               SELECT f.id, f.fine_type, f.infraction_date, f.infraction_code, f.entity, f.ticket_number, f.amount,
                                      f.due_date, f.status, f.responsibility, NULLIF(trim(concat_ws(' ', d.first_name, d.last_name)), '') AS driver_name
                               FROM public.traffic_fines f LEFT JOIN public.drivers d ON d.id = f.driver_id
                               WHERE f.vehicle_id = v.id ORDER BY f.infraction_date DESC LIMIT 30) f), '[]'::jsonb),
    'incidents', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.occurred_at DESC) FROM (
                               SELECT id, incident_type, severity, occurred_at, description, status, responsibility,
                                      final_cost, estimated_cost, insurance_coverage
                               FROM public.vehicle_incidents WHERE vehicle_id = v.id ORDER BY occurred_at DESC LIMIT 20) i), '[]'::jsonb),
    'compliance_costs', (SELECT to_jsonb(c) FROM public.vw_compliance_costs c WHERE c.vehicle_id = v.id),
    'photos', COALESCE((SELECT jsonb_agg(url) FROM (
                               SELECT photo_url AS url FROM public.maintenance_requests WHERE vehicle_plate = v.plate AND photo_url IS NOT NULL
                               UNION ALL
                               SELECT jsonb_array_elements_text(evidence_urls) FROM public.maintenance_work_orders
                               WHERE vehicle_id = v.id AND jsonb_typeof(evidence_urls) = 'array') ph), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_fleet_360_view(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_fleet_360_view(text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
