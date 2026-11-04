-- Extensión compatible del CMMS: clasificación de fallas, OT agrupadas e informes técnicos versionados.
-- No reemplaza las fuentes existentes ni altera inspecciones, alquileres o reportes de flota.
BEGIN;

-- Identidad y evaluación estructurada del incidente. El código usa el UUID ya asignado,
-- por lo que es determinista, globalmente único e idempotente para datos históricos.
ALTER TABLE public.maintenance_requests
  ADD COLUMN IF NOT EXISTS incident_code text,
  ADD COLUMN IF NOT EXISTS affected_system text,
  ADD COLUMN IF NOT EXISTS affected_component text,
  ADD COLUMN IF NOT EXISTS technical_assessment text,
  ADD COLUMN IF NOT EXISTS recommended_action text;

UPDATE public.maintenance_requests
SET incident_code = 'FAL-' || upper(substr(replace(id::text, '-', ''), 1, 10))
WHERE incident_code IS NULL OR btrim(incident_code) = '';

ALTER TABLE public.maintenance_requests ALTER COLUMN incident_code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_requests_incident_code
  ON public.maintenance_requests (incident_code);
CREATE INDEX IF NOT EXISTS idx_maintenance_requests_system
  ON public.maintenance_requests (affected_system, status, reported_at DESC);

CREATE OR REPLACE FUNCTION public.set_maintenance_incident_code()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.incident_code IS NULL OR btrim(NEW.incident_code) = '' THEN
    NEW.incident_code := 'FAL-' || upper(substr(replace(NEW.id::text, '-', ''), 1, 10));
  END IF;
  NEW.affected_system := NULLIF(btrim(NEW.affected_system), '');
  NEW.affected_component := NULLIF(btrim(NEW.affected_component), '');
  NEW.technical_assessment := NULLIF(btrim(NEW.technical_assessment), '');
  NEW.recommended_action := NULLIF(btrim(NEW.recommended_action), '');
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_set_maintenance_incident_code ON public.maintenance_requests;
CREATE TRIGGER trg_set_maintenance_incident_code
BEFORE INSERT OR UPDATE OF incident_code, affected_system, affected_component, technical_assessment, recommended_action
ON public.maintenance_requests
FOR EACH ROW EXECUTE FUNCTION public.set_maintenance_incident_code();

-- Complementa el historial que ya registra estados y asignaciones desde Soporte Mecánico.
-- Solo registra los campos de evaluación cuando realmente cambian.
ALTER TABLE public.maintenance_request_events
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Se crea antes de las RPC que registran decisiones presupuestales.
CREATE TABLE IF NOT EXISTS public.maintenance_work_order_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_order_id uuid NOT NULL REFERENCES public.maintenance_work_orders(id) ON DELETE RESTRICT,
  evento text NOT NULL,
  estado_anterior text,
  estado_nuevo text,
  detalle text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE public.maintenance_work_order_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.maintenance_work_order_events TO authenticated, service_role;
CREATE INDEX IF NOT EXISTS idx_maintenance_work_order_events_order
  ON public.maintenance_work_order_events (work_order_id, created_at DESC);
ALTER TABLE public.maintenance_work_order_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS maintenance_wo_events_read ON public.maintenance_work_order_events;
CREATE POLICY maintenance_wo_events_read ON public.maintenance_work_order_events FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.maintenance_work_orders wo WHERE wo.id = work_order_id
          AND public.can_access_site(wo.site_id) AND public.has_cmms_read_permission('ot'))
);
CREATE POLICY security_active_account ON public.maintenance_work_order_events AS RESTRICTIVE FOR ALL TO authenticated
USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
GRANT SELECT ON public.maintenance_work_order_events TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.audit_maintenance_request_assessment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_changes jsonb := '{}'::jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_changes := jsonb_build_object(
      'incident_code', NEW.incident_code,
      'affected_system', NEW.affected_system,
      'affected_component', NEW.affected_component
    );
  ELSE
    IF NEW.affected_system IS DISTINCT FROM OLD.affected_system THEN
      v_changes := v_changes || jsonb_build_object('affected_system', jsonb_build_object('before', OLD.affected_system, 'after', NEW.affected_system));
    END IF;
    IF NEW.affected_component IS DISTINCT FROM OLD.affected_component THEN
      v_changes := v_changes || jsonb_build_object('affected_component', jsonb_build_object('before', OLD.affected_component, 'after', NEW.affected_component));
    END IF;
    IF NEW.technical_assessment IS DISTINCT FROM OLD.technical_assessment THEN
      v_changes := v_changes || jsonb_build_object('technical_assessment', jsonb_build_object('before', OLD.technical_assessment, 'after', NEW.technical_assessment));
    END IF;
    IF NEW.recommended_action IS DISTINCT FROM OLD.recommended_action THEN
      v_changes := v_changes || jsonb_build_object('recommended_action', jsonb_build_object('before', OLD.recommended_action, 'after', NEW.recommended_action));
    END IF;
    IF NEW.severity IS DISTINCT FROM OLD.severity THEN
      v_changes := v_changes || jsonb_build_object('severity', jsonb_build_object('before', OLD.severity, 'after', NEW.severity));
    END IF;
  END IF;

  IF v_changes <> '{}'::jsonb THEN
    INSERT INTO public.maintenance_request_events (request_id, evento, estado_nuevo, at, by, detalle, metadata)
    VALUES (NEW.id, 'EVALUACION_TECNICA', NEW.status, now(), auth.uid(),
      'Se actualizaron datos técnicos de ' || COALESCE(NEW.incident_code, NEW.id::text), v_changes);
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_audit_maintenance_request_assessment_insert ON public.maintenance_requests;
CREATE TRIGGER trg_audit_maintenance_request_assessment_insert
AFTER INSERT ON public.maintenance_requests
FOR EACH ROW EXECUTE FUNCTION public.audit_maintenance_request_assessment();
DROP TRIGGER IF EXISTS trg_audit_maintenance_request_assessment_update ON public.maintenance_requests;
CREATE TRIGGER trg_audit_maintenance_request_assessment_update
AFTER UPDATE OF affected_system, affected_component, technical_assessment, recommended_action, severity
ON public.maintenance_requests
FOR EACH ROW EXECUTE FUNCTION public.audit_maintenance_request_assessment();

-- Una sola intervención puede resolver varias fallas compatibles de la misma unidad.
-- Se conserva maintenance_requests.work_order_id como relación canónica muchos-a-uno.
CREATE OR REPLACE FUNCTION public.link_maintenance_request_to_work_order(
  p_request_id uuid,
  p_work_order_id uuid,
  p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request public.maintenance_requests%ROWTYPE;
  v_order public.maintenance_work_orders%ROWTYPE;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT (public.has_cmms_permission('fallas') AND public.has_cmms_permission('ot')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Se requieren permisos de fallas y OT');
  END IF;

  SELECT * INTO v_request FROM public.maintenance_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Falla no encontrada'); END IF;
  SELECT * INTO v_order FROM public.maintenance_work_orders WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'OT no encontrada'); END IF;
  IF v_request.vehicle_plate <> (SELECT plate FROM public.vehicles WHERE id = v_order.vehicle_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'La falla y la OT deben corresponder a la misma unidad');
  END IF;
  IF auth.uid() IS NOT NULL AND (NOT public.can_access_site(v_request.site_id) OR NOT public.can_access_site(v_order.site_id)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'La falla o la OT está fuera de su sede');
  END IF;
  IF v_request.work_order_id = p_work_order_id AND v_request.status = 'CONVERTIDA_OT' THEN
    RETURN jsonb_build_object('success', true, 'work_order_id', p_work_order_id, 'already_linked', true);
  END IF;
  IF v_request.work_order_id IS NOT NULL AND v_request.work_order_id <> p_work_order_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'La falla ya está vinculada a otra OT');
  END IF;
  IF v_request.status NOT IN ('REPORTADA', 'VALIDADA', 'DIAGNOSTICADA', 'PROGRAMADA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'La falla no está disponible para vincular');
  END IF;
  IF v_order.status IN ('CERRADA', 'CANCELADA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'No se pueden agregar fallas a una OT cerrada o cancelada');
  END IF;

  UPDATE public.maintenance_requests
  SET status = 'CONVERTIDA_OT', work_order_id = p_work_order_id,
      assigned_to = COALESCE(assigned_to, v_order.responsible_id, auth.uid()),
      notes = CASE WHEN NULLIF(btrim(p_notes), '') IS NULL THEN notes
                   ELSE concat_ws(E'\n', notes, 'Vinculada a OT ' || v_order.ot_code || ': ' || btrim(p_notes)) END
  WHERE id = p_request_id;
  RETURN jsonb_build_object('success', true, 'work_order_id', p_work_order_id, 'already_linked', false);
END;
$$;
REVOKE ALL ON FUNCTION public.link_maintenance_request_to_work_order(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_maintenance_request_to_work_order(uuid, uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_work_order_from_requests(
  p_request_ids uuid[],
  p_user_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids uuid[];
  v_first uuid;
  v_work_order_id uuid;
  v_request_id uuid;
  v_plate text;
  v_link_result jsonb;
BEGIN
  SELECT array_agg(id ORDER BY id) INTO v_ids
  FROM (SELECT DISTINCT unnest(p_request_ids) AS id) selected;
  IF COALESCE(array_length(v_ids, 1), 0) = 0 THEN RAISE EXCEPTION 'Seleccione al menos una falla'; END IF;
  IF auth.uid() IS NOT NULL AND NOT (public.has_cmms_permission('fallas') AND public.has_cmms_permission('ot')) THEN
    RAISE EXCEPTION 'Se requieren permisos de fallas y OT' USING ERRCODE = '42501';
  END IF;

  SELECT vehicle_plate INTO v_plate FROM public.maintenance_requests WHERE id = v_ids[1] FOR UPDATE;
  IF v_plate IS NULL THEN RAISE EXCEPTION 'Falla no encontrada'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.maintenance_requests r
    WHERE r.id = ANY(v_ids) AND (r.vehicle_plate <> v_plate OR r.status NOT IN ('REPORTADA', 'VALIDADA', 'DIAGNOSTICADA', 'PROGRAMADA'))
  ) THEN RAISE EXCEPTION 'Las fallas deben estar abiertas y pertenecer a la misma unidad'; END IF;

  v_first := v_ids[1];
  v_work_order_id := public.convert_request_to_wo(v_first, COALESCE(p_user_id, auth.uid()));
  FOREACH v_request_id IN ARRAY v_ids LOOP
    IF v_request_id <> v_first THEN
      v_link_result := public.link_maintenance_request_to_work_order(v_request_id, v_work_order_id, 'Agrupada en la misma intervención');
      IF NOT COALESCE((v_link_result ->> 'success')::boolean, false) THEN
        RAISE EXCEPTION 'No se pudo vincular la falla %: %', v_request_id, v_link_result ->> 'error';
      END IF;
    END IF;
  END LOOP;
  RETURN v_work_order_id;
END;
$$;
REVOKE ALL ON FUNCTION public.create_work_order_from_requests(uuid[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_work_order_from_requests(uuid[], uuid) TO authenticated, service_role;

-- Presupuesto solicitado/aprobado y costo real quedan separados. No se define un umbral
-- monetario: la aprobación la realiza el perfil supervisor configurado por el negocio.
CREATE TABLE IF NOT EXISTS public.maintenance_work_order_budget_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES public.maintenance_work_orders(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  budget_amount numeric(14,2) NOT NULL CHECK (budget_amount >= 0),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  status text NOT NULL DEFAULT 'PENDIENTE' CHECK (status IN ('PENDIENTE', 'APROBADA', 'RECHAZADA', 'SUPERADA')),
  requested_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_notes text,
  CONSTRAINT maintenance_work_order_budget_version_uq UNIQUE (work_order_id, version)
);
REVOKE ALL ON TABLE public.maintenance_work_order_budget_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.maintenance_work_order_budget_requests TO authenticated, service_role;
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_order_budget_pending
  ON public.maintenance_work_order_budget_requests (work_order_id) WHERE status = 'PENDIENTE';
CREATE INDEX IF NOT EXISTS idx_work_order_budget_history
  ON public.maintenance_work_order_budget_requests (work_order_id, version DESC);
ALTER TABLE public.maintenance_work_order_budget_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS maintenance_wo_budget_read ON public.maintenance_work_order_budget_requests;
CREATE POLICY maintenance_wo_budget_read ON public.maintenance_work_order_budget_requests FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.maintenance_work_orders wo WHERE wo.id = work_order_id
          AND public.can_access_site(wo.site_id) AND public.has_cmms_read_permission('ot'))
);
CREATE POLICY security_active_account ON public.maintenance_work_order_budget_requests AS RESTRICTIVE FOR ALL TO authenticated
USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));

CREATE OR REPLACE FUNCTION public.request_work_order_budget(
  p_work_order_id uuid,
  p_budget_amount numeric,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.maintenance_work_orders%ROWTYPE;
  v_current numeric;
  v_actual numeric;
  v_version integer;
  v_id uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_cmms_permission('ot') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para solicitar presupuesto de OT');
  END IF;
  SELECT * INTO v_order FROM public.maintenance_work_orders WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'OT no encontrada'); END IF;
  IF auth.uid() IS NOT NULL AND NOT public.can_access_site(v_order.site_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT fuera de su sede');
  END IF;
  IF v_order.status IN ('CERRADA', 'CANCELADA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'No se cambia el presupuesto de una OT finalizada');
  END IF;
  IF p_budget_amount IS NULL OR p_budget_amount < 0 OR NULLIF(btrim(p_reason), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique un monto válido y el sustento');
  END IF;
  IF EXISTS (SELECT 1 FROM public.maintenance_work_order_budget_requests WHERE work_order_id = p_work_order_id AND status = 'PENDIENTE') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Ya existe una solicitud de presupuesto pendiente');
  END IF;
  SELECT budget_amount INTO v_current FROM public.maintenance_work_order_budget_requests
  WHERE work_order_id = p_work_order_id AND status = 'APROBADA' ORDER BY version DESC LIMIT 1;
  SELECT COALESCE(total_cost, 0) INTO v_actual FROM public.maintenance_work_orders WHERE id = p_work_order_id;
  IF p_budget_amount < v_actual THEN
    RETURN jsonb_build_object('success', false, 'error', 'El presupuesto no puede ser menor al costo real ya registrado');
  END IF;
  IF v_current IS NOT NULL AND p_budget_amount <= v_current THEN
    RETURN jsonb_build_object('success', false, 'error', 'La ampliación debe superar el presupuesto vigente');
  END IF;
  SELECT COALESCE(max(version), 0) + 1 INTO v_version FROM public.maintenance_work_order_budget_requests WHERE work_order_id = p_work_order_id;
  INSERT INTO public.maintenance_work_order_budget_requests (work_order_id, version, budget_amount, reason, requested_by)
  VALUES (p_work_order_id, v_version, round(p_budget_amount, 2), btrim(p_reason), auth.uid()) RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', true, 'id', v_id, 'version', v_version, 'status', 'PENDIENTE');
END;
$$;
REVOKE ALL ON FUNCTION public.request_work_order_budget(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_work_order_budget(uuid, numeric, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.decide_work_order_budget(
  p_request_id uuid,
  p_decision text,
  p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request public.maintenance_work_order_budget_requests%ROWTYPE;
  v_order public.maintenance_work_orders%ROWTYPE;
  v_decision text := upper(btrim(p_decision));
BEGIN
  IF auth.uid() IS NOT NULL AND NOT (public.is_tms_admin() OR public.has_tms_permission('mantenimiento-dashboard')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo Supervisión de Flota o Administración pueden aprobar presupuestos');
  END IF;
  SELECT * INTO v_request FROM public.maintenance_work_order_budget_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR v_request.status <> 'PENDIENTE' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solicitud de presupuesto inexistente o ya decidida');
  END IF;
  SELECT * INTO v_order FROM public.maintenance_work_orders WHERE id = v_request.work_order_id FOR UPDATE;
  IF auth.uid() IS NOT NULL AND NOT public.can_access_site(v_order.site_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT fuera de su sede');
  END IF;
  IF auth.uid() IS NOT NULL AND NOT public.is_tms_admin() AND v_request.requested_by = auth.uid() THEN
    RETURN jsonb_build_object('success', false, 'error', 'La persona solicitante no puede aprobar su propia solicitud');
  END IF;
  IF v_decision NOT IN ('APROBADA', 'RECHAZADA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Decisión inválida');
  END IF;
  IF v_decision = 'RECHAZADA' AND NULLIF(btrim(p_notes), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'El rechazo requiere sustento');
  END IF;
  IF v_decision = 'APROBADA' AND v_request.budget_amount < COALESCE(v_order.total_cost, 0) THEN
    RETURN jsonb_build_object('success', false, 'error', 'El costo real ya supera el monto solicitado');
  END IF;
  IF v_decision = 'APROBADA' THEN
    UPDATE public.maintenance_work_order_budget_requests SET status = 'SUPERADA'
    WHERE work_order_id = v_order.id AND status = 'APROBADA';
  END IF;
  UPDATE public.maintenance_work_order_budget_requests SET
    status = v_decision, decided_by = auth.uid(), decided_at = now(), decision_notes = NULLIF(btrim(p_notes), '')
  WHERE id = v_request.id;
  INSERT INTO public.maintenance_work_order_events (work_order_id, evento, detalle, metadata, created_by)
  VALUES (v_order.id, 'PRESUPUESTO_' || v_decision,
    'Versión ' || v_request.version || ' · S/ ' || to_char(v_request.budget_amount, 'FM999,999,990.00') || COALESCE(' · ' || NULLIF(btrim(p_notes), ''), ''),
    jsonb_build_object('budget_request_id', v_request.id, 'version', v_request.version, 'amount', v_request.budget_amount), auth.uid());
  RETURN jsonb_build_object('success', true, 'status', v_decision, 'version', v_request.version);
END;
$$;
REVOKE ALL ON FUNCTION public.decide_work_order_budget(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_work_order_budget(uuid, text, text) TO authenticated, service_role;

CREATE OR REPLACE VIEW public.vw_work_order_budget_status
WITH (security_invoker = true) AS
SELECT wo.id AS work_order_id, wo.ot_code, wo.status AS work_order_status, wo.vehicle_id, wo.site_id,
  COALESCE(actual.total_cost, 0) AS actual_cost,
  approved.budget_amount AS approved_budget,
  approved.version AS approved_version,
  approved.decided_at AS approved_at,
  pending.id AS pending_request_id,
  pending.budget_amount AS pending_budget,
  pending.reason AS pending_reason,
  CASE WHEN approved.budget_amount IS NOT NULL THEN approved.budget_amount - COALESCE(actual.total_cost, 0) END AS remaining_budget,
  approved.budget_amount IS NOT NULL AND COALESCE(actual.total_cost, 0) > approved.budget_amount AS over_budget
FROM public.maintenance_work_orders wo
LEFT JOIN LATERAL (SELECT COALESCE(sum(c.amount), 0) AS total_cost FROM public.work_order_costs c WHERE c.work_order_id = wo.id) actual ON true
LEFT JOIN LATERAL (SELECT b.budget_amount, b.version, b.decided_at FROM public.maintenance_work_order_budget_requests b
                   WHERE b.work_order_id = wo.id AND b.status = 'APROBADA' ORDER BY b.version DESC LIMIT 1) approved ON true
LEFT JOIN LATERAL (SELECT b.id, b.budget_amount, b.reason FROM public.maintenance_work_order_budget_requests b
                   WHERE b.work_order_id = wo.id AND b.status = 'PENDIENTE' ORDER BY b.version DESC LIMIT 1) pending ON true;
GRANT SELECT ON public.vw_work_order_budget_status TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_work_order_budget_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_budget numeric;
BEGIN
  IF NEW.status = 'APROBADA' AND OLD.status IS DISTINCT FROM 'APROBADA' AND auth.uid() IS NOT NULL THEN
    SELECT budget_amount INTO v_budget FROM public.maintenance_work_order_budget_requests
    WHERE work_order_id = NEW.id AND status = 'APROBADA' ORDER BY version DESC LIMIT 1;
    IF v_budget IS NULL THEN RAISE EXCEPTION 'La OT requiere un presupuesto aprobado antes de autorizarse'; END IF;
    IF COALESCE(NEW.total_cost, 0) > v_budget THEN RAISE EXCEPTION 'El costo real ya supera el presupuesto aprobado'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_work_order_budget_approval ON public.maintenance_work_orders;
CREATE TRIGGER trg_guard_work_order_budget_approval
BEFORE UPDATE OF status ON public.maintenance_work_orders
FOR EACH ROW EXECUTE FUNCTION public.guard_work_order_budget_approval();

CREATE OR REPLACE FUNCTION public.guard_work_order_cost_budget()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_work_order_id uuid;
  v_budget numeric;
  v_actual numeric;
  v_exclude_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN v_work_order_id := OLD.work_order_id; ELSE v_work_order_id := NEW.work_order_id; END IF;
  SELECT budget_amount INTO v_budget FROM public.maintenance_work_order_budget_requests
  WHERE work_order_id = v_work_order_id AND status = 'APROBADA' ORDER BY version DESC LIMIT 1;
  IF v_budget IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN v_exclude_id := OLD.id; END IF;
  SELECT COALESCE(sum(c.amount), 0) INTO v_actual FROM public.work_order_costs c
  WHERE c.work_order_id = v_work_order_id AND (v_exclude_id IS NULL OR c.id <> v_exclude_id);
  IF TG_OP <> 'DELETE' THEN v_actual := v_actual + NEW.amount; END IF;
  IF v_actual > v_budget THEN
    RAISE EXCEPTION 'El costo propuesto (S/ %) supera el presupuesto aprobado (S/ %). Solicite una ampliación y aprobación.', round(v_actual, 2), round(v_budget, 2);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_work_order_cost_budget ON public.work_order_costs;
CREATE TRIGGER trg_guard_work_order_cost_budget
BEFORE INSERT OR UPDATE OR DELETE ON public.work_order_costs
FOR EACH ROW EXECUTE FUNCTION public.guard_work_order_cost_budget();

-- Bitácora propia para cambios de OT; las escrituras proceden de triggers y de acciones servidor.
CREATE OR REPLACE FUNCTION public.audit_maintenance_work_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_event text; v_detail text; v_before text; v_after text; v_meta jsonb := '{}'::jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.maintenance_work_order_events (work_order_id, evento, estado_nuevo, detalle, metadata, created_by)
    VALUES (NEW.id, 'CREADA', NEW.status, NEW.description, jsonb_build_object('order_type', NEW.order_type, 'source_type', NEW.source_type), auth.uid());
    RETURN NULL;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_event := 'ESTADO'; v_before := OLD.status; v_after := NEW.status; v_detail := NEW.notes;
  ELSIF NEW.responsible_id IS DISTINCT FROM OLD.responsible_id OR NEW.mechanic_id IS DISTINCT FROM OLD.mechanic_id OR NEW.provider_id IS DISTINCT FROM OLD.provider_id THEN
    v_event := 'ASIGNACION'; v_detail := 'Se actualizaron responsables, mecánico o proveedor';
    v_meta := jsonb_build_object('responsible_before', OLD.responsible_id, 'responsible_after', NEW.responsible_id,
      'mechanic_before', OLD.mechanic_id, 'mechanic_after', NEW.mechanic_id, 'provider_before', OLD.provider_id, 'provider_after', NEW.provider_id);
  ELSIF NEW.diagnostic IS DISTINCT FROM OLD.diagnostic OR NEW.tasks IS DISTINCT FROM OLD.tasks OR NEW.activities_performed IS DISTINCT FROM OLD.activities_performed THEN
    v_event := 'TRABAJO_TECNICO'; v_detail := 'Se actualizaron diagnóstico, tareas o actividades realizadas';
  ELSIF NEW.start_date IS DISTINCT FROM OLD.start_date OR NEW.estimated_end_date IS DISTINCT FROM OLD.estimated_end_date THEN
    v_event := 'PROGRAMACION'; v_detail := 'Se actualizó la programación';
  END IF;
  IF v_event IS NOT NULL THEN
    INSERT INTO public.maintenance_work_order_events (work_order_id, evento, estado_anterior, estado_nuevo, detalle, metadata, created_by)
    VALUES (NEW.id, v_event, v_before, v_after, v_detail, v_meta, auth.uid());
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_audit_maintenance_work_order ON public.maintenance_work_orders;
CREATE TRIGGER trg_audit_maintenance_work_order
AFTER INSERT OR UPDATE ON public.maintenance_work_orders
FOR EACH ROW EXECUTE FUNCTION public.audit_maintenance_work_order();

-- Informes PDF inmutables y versionados. Los archivos viven en el bucket privado evidence,
-- en la ruta ot/<uuid>/..., compatible con la política de almacenamiento ya desplegada.
CREATE TABLE IF NOT EXISTS public.maintenance_work_order_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES public.maintenance_work_orders(id) ON DELETE RESTRICT,
  report_type text NOT NULL CHECK (report_type IN ('PREVIO', 'CIERRE')),
  version integer NOT NULL CHECK (version > 0),
  storage_bucket text NOT NULL DEFAULT 'evidence' CHECK (storage_bucket = 'evidence'),
  storage_path text NOT NULL,
  content_snapshot jsonb NOT NULL,
  sha256 text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maintenance_work_order_reports_version_uq UNIQUE (work_order_id, report_type, version),
  CONSTRAINT maintenance_work_order_reports_path_uq UNIQUE (storage_bucket, storage_path)
);
REVOKE ALL ON TABLE public.maintenance_work_order_reports FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.maintenance_work_order_reports TO authenticated, service_role;
CREATE INDEX IF NOT EXISTS idx_maintenance_work_order_reports_order
  ON public.maintenance_work_order_reports (work_order_id, report_type, version DESC);
ALTER TABLE public.maintenance_work_order_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS maintenance_wo_reports_read ON public.maintenance_work_order_reports;
CREATE POLICY maintenance_wo_reports_read ON public.maintenance_work_order_reports FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.maintenance_work_orders wo WHERE wo.id = work_order_id
          AND public.can_access_site(wo.site_id) AND public.has_cmms_read_permission('ot'))
);
CREATE POLICY security_active_account ON public.maintenance_work_order_reports AS RESTRICTIVE FOR ALL TO authenticated
USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));

CREATE OR REPLACE FUNCTION public.register_maintenance_work_order_report(
  p_work_order_id uuid,
  p_report_type text,
  p_storage_path text,
  p_content_snapshot jsonb,
  p_sha256 text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.maintenance_work_orders%ROWTYPE;
  v_version integer;
  v_type text := upper(btrim(p_report_type));
  v_path text := btrim(p_storage_path);
  v_id uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_cmms_permission('ot') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para emitir informes de OT');
  END IF;
  SELECT * INTO v_order FROM public.maintenance_work_orders WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'OT no encontrada'); END IF;
  IF auth.uid() IS NOT NULL AND NOT public.can_access_site(v_order.site_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT fuera de su sede');
  END IF;
  IF v_type NOT IN ('PREVIO', 'CIERRE') THEN RETURN jsonb_build_object('success', false, 'error', 'Tipo de informe inválido'); END IF;
  IF v_path !~ ('^ot/' || p_work_order_id::text || '/reports/' || v_type || '/[^/]+[.]pdf$') THEN
    RETURN jsonb_build_object('success', false, 'error', 'La ruta del archivo no corresponde a esta OT');
  END IF;
  IF p_content_snapshot IS NULL OR octet_length(p_content_snapshot::text) > 100000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Contenido del informe inválido');
  END IF;
  IF v_type = 'CIERRE' AND v_order.status <> 'CERRADA' THEN
    RETURN jsonb_build_object('success', false, 'error', 'El informe de cierre solo se emite para una OT cerrada');
  END IF;
  IF v_type = 'PREVIO' AND v_order.status IN ('CERRADA', 'CANCELADA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'No se emite informe previo para una OT finalizada');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_work_order_id::text || ':' || v_type, 0));
  SELECT COALESCE(max(version), 0) + 1 INTO v_version
  FROM public.maintenance_work_order_reports WHERE work_order_id = p_work_order_id AND report_type = v_type;
  INSERT INTO public.maintenance_work_order_reports (
    work_order_id, report_type, version, storage_path, content_snapshot, sha256, created_by
  ) VALUES (p_work_order_id, v_type, v_version, v_path, p_content_snapshot, NULLIF(p_sha256, ''), auth.uid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', true, 'id', v_id, 'version', v_version, 'storage_path', v_path);
END;
$$;
REVOKE ALL ON FUNCTION public.register_maintenance_work_order_report(uuid, text, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_maintenance_work_order_report(uuid, text, text, jsonb, text) TO authenticated, service_role;

-- Trazabilidad de costos y acceso al informe versionado en la ruta privada de evidencia.
CREATE OR REPLACE FUNCTION public.audit_work_order_budget_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO public.maintenance_work_order_events (work_order_id, evento, detalle, metadata, created_by)
  VALUES (COALESCE(NEW.work_order_id, OLD.work_order_id), 'COSTO_' || TG_OP,
    CASE WHEN TG_OP = 'DELETE' THEN 'Se retiró una línea de costo'
         WHEN TG_OP = 'INSERT' THEN 'Se agregó una línea de costo'
         ELSE 'Se modificó una línea de costo' END,
    jsonb_build_object('cost_id', COALESCE(NEW.id, OLD.id), 'amount_before', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.amount END,
      'amount_after', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.amount END), auth.uid());
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_audit_work_order_budget_change ON public.work_order_costs;
CREATE TRIGGER trg_audit_work_order_budget_change AFTER INSERT OR UPDATE OR DELETE ON public.work_order_costs
FOR EACH ROW EXECUTE FUNCTION public.audit_work_order_budget_change();

DROP POLICY IF EXISTS maintenance_evidence_report_read ON storage.objects;
CREATE POLICY maintenance_evidence_report_read ON storage.objects FOR SELECT TO authenticated USING (
  bucket_id = 'evidence' AND split_part(name, '/', 1) = 'ot'
  AND public.security_maintenance_object_site(bucket_id, name, owner_id)
  AND EXISTS (SELECT 1 FROM public.maintenance_work_order_reports r
              WHERE r.storage_bucket = bucket_id AND r.storage_path = name
                AND public.can_access_site((SELECT wo.site_id FROM public.maintenance_work_orders wo WHERE wo.id = r.work_order_id))
                AND public.has_cmms_read_permission('ot'))
);

-- Extiende la vista existente al final para conservar el contrato de columnas vigente.
CREATE OR REPLACE VIEW public.vw_maintenance_backlog
WITH (security_invoker = true) AS
SELECT
  r.id,
  r.vehicle_plate,
  v.type                  AS vehicle_type,
  v.criticality           AS vehicle_criticality,
  v.status                AS vehicle_status,
  r.description,
  r.severity,
  r.status,
  r.source,
  r.reported_at,
  r.odometer_at_report,
  r.horometer             AS hours_at_report,
  r.photo_url,
  r.driver_id,
  NULLIF(trim(concat_ws(' ', d.first_name, d.last_name)), '') AS driver_name,
  r.dispatch_id,
  r.assigned_to           AS responsible_id,
  NULLIF(trim(concat_ws(' ', p.first_name, p.last_name)), '') AS responsible_name,
  r.diagnosis,
  r.scheduled_for,
  r.work_order_id,
  wo.ot_code              AS work_order_code,
  wo.status               AS work_order_status,
  r.site_id,
  ((now() AT TIME ZONE 'America/Lima')::date - (r.reported_at AT TIME ZONE 'America/Lima')::date) AS age_days,
  CASE
    WHEN (now() AT TIME ZONE 'America/Lima')::date - (r.reported_at AT TIME ZONE 'America/Lima')::date <= 2  THEN '0-2 días'
    WHEN (now() AT TIME ZONE 'America/Lima')::date - (r.reported_at AT TIME ZONE 'America/Lima')::date <= 7  THEN '3-7 días'
    WHEN (now() AT TIME ZONE 'America/Lima')::date - (r.reported_at AT TIME ZONE 'America/Lima')::date <= 30 THEN '8-30 días'
    ELSE '+30 días' END   AS age_bucket,
  CASE WHEN r.severity = 'CRITICA' THEN 'BLOQUEA_ACTIVO'
       WHEN r.severity = 'ALTA' THEN 'RIESGO_OPERATIVO'
       ELSE 'SIN_IMPACTO_INMEDIATO' END AS impact,
  (CASE r.severity WHEN 'CRITICA' THEN 100 WHEN 'ALTA' THEN 60 WHEN 'MEDIA' THEN 30 ELSE 10 END
   + CASE v.criticality WHEN 'ALTA' THEN 20 WHEN 'MEDIA' THEN 10 ELSE 0 END
   + LEAST((now() AT TIME ZONE 'America/Lima')::date - (r.reported_at AT TIME ZONE 'America/Lima')::date, 30)) AS priority_score,
  r.incident_code,
  r.affected_system,
  r.affected_component,
  r.technical_assessment,
  r.recommended_action
FROM public.maintenance_requests r
JOIN public.vehicles v ON v.plate = r.vehicle_plate
LEFT JOIN public.drivers d ON d.id = r.driver_id
LEFT JOIN public.profiles p ON p.id = r.assigned_to
LEFT JOIN public.maintenance_work_orders wo ON wo.id = r.work_order_id
WHERE r.status NOT IN ('CERRADA', 'DESCARTADA');
GRANT SELECT ON public.vw_maintenance_backlog TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
