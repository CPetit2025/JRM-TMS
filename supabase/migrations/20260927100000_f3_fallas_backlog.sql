-- 20260927100000_f3_fallas_backlog.sql
-- FASE 3 — Solicitudes, fallas y backlog como única fuente de verdad.
--
-- * maintenance_requests es la entidad única de anomalías (vehicle_failures se elimina:
--   estaba vacía y duplicaba el concepto).
-- * Vocabulario canónico: criticidad CRITICA/ALTA/MEDIA/BAJA; estados REPORTADA,
--   VALIDADA, DIAGNOSTICADA, PROGRAMADA, CONVERTIDA_OT, CERRADA, DESCARTADA.
--   Un trigger normaliza variantes heredadas (PENDIENTE, CRÍTICA, CRITICAL…).
-- * Orígenes: APP_CONDUCTOR, SUPERVISOR, INSPECCION, MANTENIMIENTO, COPILOTO_AI, TORRE_CONTROL.
-- * Falla CRÍTICA abierta ⇒ la unidad pasa a BLOQUEADA vía motor (F2).
-- * Estados solo cambian vía transition_maintenance_request / convert_request_to_wo;
--   al cerrar o cancelar la OT la solicitud se cierra o vuelve al backlog.
-- * Permisos alineados con las claves reales de roles (mantenimiento-fallas,
--   mantenimiento-ot, mantenimiento-flota). has_tms_permission('mantenimiento') no
--   coincidía con ningún rol: solo el Administrador pasaba.
-- * Corrige funciones rotas en producción: submit_maintenance_request (vehicles.updated_at
--   inexistente), submit_pre_route_checklist (dispatches.start_odometer inexistente),
--   ai_confirm_maintenance (estado PENDIENTE inválido para OT).

BEGIN;

-- ------------------------------------------------------------
-- 0. Permisos CMMS reutilizables
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_cmms_permission(p_area text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.is_tms_admin() OR public.has_tms_permission('mantenimiento-' || p_area);
$$;

CREATE OR REPLACE FUNCTION public.has_cmms_read_permission(p_area text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.is_tms_admin() OR public.has_tms_read_permission('mantenimiento-' || p_area);
$$;

REVOKE ALL ON FUNCTION public.has_cmms_permission(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.has_cmms_read_permission(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_cmms_permission(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_cmms_read_permission(text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 1. Esquema de maintenance_requests
-- ------------------------------------------------------------
ALTER TABLE public.maintenance_requests
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS source_ref_id uuid,
  ADD COLUMN IF NOT EXISTS site_id uuid REFERENCES public.sites(id),
  ADD COLUMN IF NOT EXISTS diagnosis text,
  ADD COLUMN IF NOT EXISTS scheduled_for date,
  ADD COLUMN IF NOT EXISTS validated_at timestamptz,
  ADD COLUMN IF NOT EXISTS validated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS discard_reason text;

-- Responsable = assigned_to y horómetro = horometer (columnas creadas en 20260924143000).
-- Se retiran las restricciones previas que exigían 'CRÍTICA' con tilde: la App envía 'CRITICA'
-- y todo reporte crítico era rechazado.
ALTER TABLE public.maintenance_requests DROP CONSTRAINT IF EXISTS chk_maintenance_requests_severity;
ALTER TABLE public.maintenance_requests DROP CONSTRAINT IF EXISTS chk_maintenance_requests_status;

-- Normalizar datos existentes antes de las restricciones
UPDATE public.maintenance_requests SET
  severity = CASE upper(translate(COALESCE(severity, 'MEDIA'), 'ÍíÁá', 'IiAa'))
               WHEN 'CRITICAL' THEN 'CRITICA' WHEN 'HIGH' THEN 'ALTA'
               WHEN 'MEDIUM' THEN 'MEDIA' WHEN 'LOW' THEN 'BAJA'
               ELSE upper(translate(COALESCE(severity, 'MEDIA'), 'ÍíÁá', 'IiAa')) END,
  status = CASE WHEN status IS NULL OR status IN ('PENDIENTE', 'PENDING') THEN 'REPORTADA'
                WHEN status IN ('RESUELTA', 'RESUELTO', 'COMPLETADA') THEN 'CERRADA'
                ELSE status END,
  source = COALESCE(source, CASE WHEN driver_id IS NOT NULL THEN 'APP_CONDUCTOR' ELSE 'SUPERVISOR' END);

UPDATE public.maintenance_requests mr SET site_id = v.site_id
FROM public.vehicles v WHERE v.plate = mr.vehicle_plate AND mr.site_id IS NULL;

ALTER TABLE public.maintenance_requests ALTER COLUMN status SET DEFAULT 'REPORTADA';
ALTER TABLE public.maintenance_requests ALTER COLUMN severity SET DEFAULT 'MEDIA';

ALTER TABLE public.maintenance_requests DROP CONSTRAINT IF EXISTS maintenance_requests_severity_check;
ALTER TABLE public.maintenance_requests ADD CONSTRAINT maintenance_requests_severity_check
  CHECK (severity IN ('CRITICA', 'ALTA', 'MEDIA', 'BAJA'));
ALTER TABLE public.maintenance_requests DROP CONSTRAINT IF EXISTS maintenance_requests_status_check;
ALTER TABLE public.maintenance_requests ADD CONSTRAINT maintenance_requests_status_check
  CHECK (status IN ('REPORTADA', 'VALIDADA', 'DIAGNOSTICADA', 'PROGRAMADA', 'CONVERTIDA_OT', 'CERRADA', 'DESCARTADA'));
ALTER TABLE public.maintenance_requests DROP CONSTRAINT IF EXISTS maintenance_requests_source_check;
ALTER TABLE public.maintenance_requests ADD CONSTRAINT maintenance_requests_source_check
  CHECK (source IN ('APP_CONDUCTOR', 'SUPERVISOR', 'INSPECCION', 'MANTENIMIENTO', 'COPILOTO_AI', 'TORRE_CONTROL'));

ALTER TABLE public.maintenance_requests DROP CONSTRAINT IF EXISTS maintenance_requests_vehicle_plate_fkey;
ALTER TABLE public.maintenance_requests ADD CONSTRAINT maintenance_requests_vehicle_plate_fkey
  FOREIGN KEY (vehicle_plate) REFERENCES public.vehicles(plate) ON UPDATE CASCADE;

-- Una anomalía de inspección genera una sola solicitud
CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_requests_source_ref
  ON public.maintenance_requests (source, source_ref_id) WHERE source_ref_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_maintenance_requests_open
  ON public.maintenance_requests (vehicle_plate, severity) WHERE status NOT IN ('CERRADA', 'DESCARTADA');
CREATE INDEX IF NOT EXISTS idx_maintenance_requests_work_order ON public.maintenance_requests (work_order_id);

-- ------------------------------------------------------------
-- 2. Normalización + guard de estado
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_maintenance_request()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_sev text;
BEGIN
  v_sev := upper(translate(COALESCE(NEW.severity, 'MEDIA'), 'ÍíÁá', 'IiAa'));
  NEW.severity := CASE v_sev WHEN 'CRITICAL' THEN 'CRITICA' WHEN 'HIGH' THEN 'ALTA'
                             WHEN 'MEDIUM' THEN 'MEDIA' WHEN 'LOW' THEN 'BAJA' ELSE v_sev END;
  IF NEW.status IS NULL OR NEW.status IN ('PENDIENTE', 'PENDING') THEN
    NEW.status := 'REPORTADA';
  END IF;
  NEW.vehicle_plate := upper(trim(NEW.vehicle_plate));
  IF NEW.site_id IS NULL THEN
    SELECT site_id INTO NEW.site_id FROM public.vehicles WHERE plate = NEW.vehicle_plate;
  END IF;
  NEW.reported_by := COALESCE(NEW.reported_by, auth.uid());
  NEW.source := COALESCE(NEW.source, CASE WHEN NEW.driver_id IS NOT NULL THEN 'APP_CONDUCTOR' ELSE 'SUPERVISOR' END);
  NEW.updated_at := now();

  -- Clientes directos (API): el ciclo de vida solo avanza por RPC
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.status := 'REPORTADA';
      NEW.work_order_id := NULL;
    ELSIF NEW.status IS DISTINCT FROM OLD.status OR NEW.work_order_id IS DISTINCT FROM OLD.work_order_id THEN
      RAISE EXCEPTION 'El estado de la solicitud solo cambia con transition_maintenance_request() o convert_request_to_wo()'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_maintenance_request ON public.maintenance_requests;
CREATE TRIGGER trg_normalize_maintenance_request
BEFORE INSERT OR UPDATE ON public.maintenance_requests
FOR EACH ROW EXECUTE FUNCTION public.normalize_maintenance_request();

-- ------------------------------------------------------------
-- 3. Falla crítica ⇒ bloqueo automático del activo (vía motor F2)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.block_vehicle_on_critical_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_status text;
BEGIN
  IF NEW.severity <> 'CRITICA' OR NEW.status IN ('CERRADA', 'DESCARTADA') THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.severity = 'CRITICA' THEN
    RETURN NULL;
  END IF;

  SELECT status INTO v_status FROM public.vehicles WHERE plate = NEW.vehicle_plate;
  IF v_status IN ('BLOQUEADA', 'FUERA_DE_SERVICIO') THEN
    RETURN NULL;
  END IF;

  v_result := public.transition_vehicle_status(
    NEW.vehicle_plate, 'BLOQUEADA',
    'Falla crítica ' || NEW.id || ': ' || left(NEW.description, 160), NEW.reported_by, '{}'::jsonb);

  IF NOT COALESCE((v_result->>'success')::boolean, false) THEN
    UPDATE public.maintenance_requests
    SET notes = concat_ws(' | ', notes, 'No se pudo bloquear la unidad: ' || (v_result->>'error'))
    WHERE id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_vehicle_on_critical_request ON public.maintenance_requests;
CREATE TRIGGER trg_block_vehicle_on_critical_request
AFTER INSERT OR UPDATE OF severity ON public.maintenance_requests
FOR EACH ROW EXECUTE FUNCTION public.block_vehicle_on_critical_request();

-- ------------------------------------------------------------
-- 4. Ciclo de vida
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transition_maintenance_request(
  p_request_id     uuid,
  p_new_status     text,
  p_notes          text DEFAULT NULL,
  p_responsible_id uuid DEFAULT NULL,
  p_scheduled_for  date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req     public.maintenance_requests%ROWTYPE;
  v_allowed text[];
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_cmms_permission('fallas') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para gestionar fallas');
  END IF;

  SELECT * INTO v_req FROM public.maintenance_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solicitud no encontrada');
  END IF;
  IF auth.uid() IS NOT NULL AND v_req.site_id IS NOT NULL AND NOT public.can_access_site(v_req.site_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solicitud fuera de su sede');
  END IF;

  v_allowed := CASE v_req.status
    WHEN 'REPORTADA'     THEN ARRAY['VALIDADA', 'DIAGNOSTICADA', 'PROGRAMADA', 'DESCARTADA']
    WHEN 'VALIDADA'      THEN ARRAY['DIAGNOSTICADA', 'PROGRAMADA', 'DESCARTADA']
    WHEN 'DIAGNOSTICADA' THEN ARRAY['PROGRAMADA', 'DESCARTADA']
    WHEN 'PROGRAMADA'    THEN ARRAY['DIAGNOSTICADA', 'DESCARTADA']
    ELSE ARRAY[]::text[] END;

  IF NOT (p_new_status = ANY (v_allowed)) THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Transición no permitida: ' || v_req.status || ' → ' || COALESCE(p_new_status, 'NULL')
      || CASE WHEN p_new_status IN ('CONVERTIDA_OT', 'CERRADA') THEN ' (use convert_request_to_wo / cierre de OT)' ELSE '' END);
  END IF;
  IF p_new_status = 'DESCARTADA' AND NULLIF(trim(p_notes), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Descartar requiere un motivo');
  END IF;
  IF p_new_status = 'DIAGNOSTICADA' AND NULLIF(trim(p_notes), '') IS NULL AND v_req.diagnosis IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Registre el diagnóstico');
  END IF;
  IF p_new_status = 'PROGRAMADA' AND COALESCE(p_scheduled_for, v_req.scheduled_for) IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique la fecha programada');
  END IF;

  UPDATE public.maintenance_requests SET
    status         = p_new_status,
    assigned_to    = COALESCE(p_responsible_id, assigned_to, auth.uid()),
    validated_at   = CASE WHEN p_new_status = 'VALIDADA' THEN now() ELSE validated_at END,
    validated_by   = CASE WHEN p_new_status = 'VALIDADA' THEN auth.uid() ELSE validated_by END,
    diagnosis      = CASE WHEN p_new_status = 'DIAGNOSTICADA' THEN COALESCE(NULLIF(trim(p_notes), ''), diagnosis) ELSE diagnosis END,
    scheduled_for  = COALESCE(p_scheduled_for, scheduled_for),
    discard_reason = CASE WHEN p_new_status = 'DESCARTADA' THEN p_notes ELSE discard_reason END,
    closed_at      = CASE WHEN p_new_status = 'DESCARTADA' THEN now() ELSE closed_at END,
    notes          = CASE WHEN p_notes IS NOT NULL AND p_new_status NOT IN ('DIAGNOSTICADA', 'DESCARTADA')
                          THEN concat_ws(' | ', notes, p_notes) ELSE notes END
  WHERE id = p_request_id;

  RETURN jsonb_build_object('success', true, 'previous_status', v_req.status, 'new_status', p_new_status);
END;
$$;

REVOKE ALL ON FUNCTION public.transition_maintenance_request(uuid, text, text, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transition_maintenance_request(uuid, text, text, uuid, date) TO authenticated, service_role;

-- Conversión controlada a OT
DROP FUNCTION IF EXISTS public.convert_request_to_wo(uuid, uuid);
CREATE FUNCTION public.convert_request_to_wo(p_request_id uuid, p_user_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req   public.maintenance_requests%ROWTYPE;
  v_wo_id uuid;
  v_code  text;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT (public.has_cmms_permission('fallas') AND public.has_cmms_permission('ot')) THEN
    RAISE EXCEPTION 'Sin permiso para convertir fallas en OT' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_req FROM public.maintenance_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Solicitud no encontrada';
  END IF;
  IF v_req.status = 'CONVERTIDA_OT' AND v_req.work_order_id IS NOT NULL THEN
    RETURN v_req.work_order_id;   -- idempotente
  END IF;
  IF v_req.status NOT IN ('REPORTADA', 'VALIDADA', 'DIAGNOSTICADA', 'PROGRAMADA') THEN
    RAISE EXCEPTION 'La solicitud en estado % no puede convertirse en OT', v_req.status;
  END IF;

  v_code := 'OT-' || to_char(now(), 'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  INSERT INTO public.maintenance_work_orders (
    ot_code, vehicle_plate, type, order_type, source_type, source_id, priority,
    description, diagnostic, status, start_date, responsible_id, site_id
  ) VALUES (
    v_code, v_req.vehicle_plate, 'CORRECTIVO',
    CASE WHEN v_req.severity = 'CRITICA' THEN 'EMERGENCIA' ELSE 'CORRECTIVA' END,
    'FALLA', v_req.id,
    CASE v_req.severity WHEN 'CRITICA' THEN 'CRITICA' WHEN 'ALTA' THEN 'ALTA' WHEN 'BAJA' THEN 'BAJA' ELSE 'NORMAL' END,
    v_req.description, v_req.diagnosis, 'BORRADOR', COALESCE(v_req.scheduled_for, CURRENT_DATE),
    COALESCE(v_req.assigned_to, p_user_id, auth.uid()), v_req.site_id
  ) RETURNING id INTO v_wo_id;

  UPDATE public.maintenance_requests
  SET status = 'CONVERTIDA_OT', work_order_id = v_wo_id,
      assigned_to = COALESCE(assigned_to, p_user_id, auth.uid())
  WHERE id = p_request_id;

  RETURN v_wo_id;
END;
$$;

REVOKE ALL ON FUNCTION public.convert_request_to_wo(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_request_to_wo(uuid, uuid) TO authenticated, service_role;

-- Cierre/cancelación de OT ⇒ cierre o retorno al backlog de la solicitud de origen
CREATE OR REPLACE FUNCTION public.sync_requests_with_work_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'CERRADA' AND OLD.status IS DISTINCT FROM 'CERRADA' THEN
    UPDATE public.maintenance_requests
    SET status = 'CERRADA', closed_at = now()
    WHERE work_order_id = NEW.id AND status = 'CONVERTIDA_OT';
  ELSIF NEW.status = 'CANCELADA' AND OLD.status IS DISTINCT FROM 'CANCELADA' THEN
    UPDATE public.maintenance_requests
    SET status = 'VALIDADA', work_order_id = NULL,
        notes = concat_ws(' | ', notes, 'OT ' || COALESCE(NEW.ot_code, NEW.id::text) || ' cancelada: vuelve al backlog')
    WHERE work_order_id = NEW.id AND status = 'CONVERTIDA_OT';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_requests_with_work_order ON public.maintenance_work_orders;
CREATE TRIGGER trg_sync_requests_with_work_order
AFTER UPDATE OF status ON public.maintenance_work_orders
FOR EACH ROW EXECUTE FUNCTION public.sync_requests_with_work_order();

-- ------------------------------------------------------------
-- 5. Backlog
-- ------------------------------------------------------------
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
   + LEAST((now() AT TIME ZONE 'America/Lima')::date - (r.reported_at AT TIME ZONE 'America/Lima')::date, 30)) AS priority_score
FROM public.maintenance_requests r
JOIN public.vehicles v ON v.plate = r.vehicle_plate
LEFT JOIN public.drivers d ON d.id = r.driver_id
LEFT JOIN public.profiles p ON p.id = r.assigned_to
LEFT JOIN public.maintenance_work_orders wo ON wo.id = r.work_order_id
WHERE r.status NOT IN ('CERRADA', 'DESCARTADA');

GRANT SELECT ON public.vw_maintenance_backlog TO authenticated, service_role;

-- ------------------------------------------------------------
-- 6. RLS de maintenance_requests
-- ------------------------------------------------------------
ALTER TABLE public.maintenance_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Conductores insertan sus reportes" ON public.maintenance_requests;
DROP POLICY IF EXISTS "Conductores ven sus propias solicitudes" ON public.maintenance_requests;
DROP POLICY IF EXISTS "Despacho ve criticas" ON public.maintenance_requests;
DROP POLICY IF EXISTS "Mantenimiento edita todas requests" ON public.maintenance_requests;
DROP POLICY IF EXISTS "Mantenimiento gestiona requests" ON public.maintenance_requests;
DROP POLICY IF EXISTS "Mantenimiento inserta todas requests" ON public.maintenance_requests;
DROP POLICY IF EXISTS "Mantenimiento ve todas" ON public.maintenance_requests;

CREATE POLICY mr_read ON public.maintenance_requests FOR SELECT TO authenticated USING (
  public.is_tms_admin()
  OR (public.can_access_site(site_id) AND public.has_cmms_read_permission('fallas'))
  OR driver_id IN (SELECT id FROM public.drivers WHERE profile_id = auth.uid())
  OR (severity = 'CRITICA' AND public.has_tms_read_permission('torre-control'))
);
CREATE POLICY mr_insert ON public.maintenance_requests FOR INSERT TO authenticated WITH CHECK (
  public.is_tms_admin()
  OR (public.can_access_site(site_id) AND public.has_cmms_permission('fallas'))
);
CREATE POLICY mr_update ON public.maintenance_requests FOR UPDATE TO authenticated
USING (public.is_tms_admin() OR (public.can_access_site(site_id) AND public.has_cmms_permission('fallas')))
WITH CHECK (public.is_tms_admin() OR (public.can_access_site(site_id) AND public.has_cmms_permission('fallas')));
CREATE POLICY mr_delete ON public.maintenance_requests FOR DELETE TO authenticated USING (public.is_tms_admin());

-- ------------------------------------------------------------
-- 7. Entradas corregidas
-- ------------------------------------------------------------
-- App conductor. v2 recibe todas las evidencias; la firma v1 se conserva para los APK instalados.
CREATE OR REPLACE FUNCTION public.submit_maintenance_request_v2(
  p_vehicle_plate text, p_driver_id uuid, p_dispatch_id uuid, p_description text,
  p_severity text, p_odometer numeric, p_photo_url text, p_location jsonb,
  p_audio_url text, p_can_continue boolean, p_horometer numeric, p_extra_photos jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request_id uuid;
  v_current    numeric;
  v_plate      text := upper(trim(p_vehicle_plate));
BEGIN
  IF p_odometer IS NULL OR p_odometer < 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'El odómetro no puede ser negativo');
  END IF;
  IF NULLIF(trim(p_description), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Describa la falla');
  END IF;
  -- El conductor solo reporta a su nombre (supervisores pueden reportar por otros)
  IF auth.uid() IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.drivers WHERE id = p_driver_id AND profile_id = auth.uid())
     AND NOT public.has_cmms_permission('fallas') THEN
    RETURN jsonb_build_object('success', false, 'message', 'No puede reportar en nombre de otro conductor');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.vehicles WHERE plate = v_plate) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Placa no registrada: ' || v_plate);
  END IF;

  INSERT INTO public.maintenance_requests (
    vehicle_plate, driver_id, dispatch_id, description, severity, status, source,
    photo_url, audio_url, evidence, can_continue, horometer,
    location_lat, location_lon, odometer_at_report, reported_by
  ) VALUES (
    v_plate, p_driver_id, p_dispatch_id, trim(p_description), p_severity, 'REPORTADA', 'APP_CONDUCTOR',
    p_photo_url, p_audio_url, p_extra_photos, p_can_continue, p_horometer,
    NULLIF(p_location->>'lat', '')::numeric, NULLIF(p_location->>'lon', '')::numeric,
    p_odometer, auth.uid()
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_request_id;

  IF v_request_id IS NULL THEN
    SELECT id INTO v_request_id FROM public.maintenance_requests
    WHERE vehicle_plate = v_plate AND md5(description) = md5(trim(p_description))
      AND (reported_at AT TIME ZONE 'America/Lima')::date = (now() AT TIME ZONE 'America/Lima')::date
    LIMIT 1;
    RETURN jsonb_build_object('success', true, 'duplicate', true, 'request_id', v_request_id,
                              'message', 'Esta falla ya fue reportada hoy para la unidad');
  END IF;

  INSERT INTO public.vehicle_odometer_logs (vehicle_plate, driver_id, dispatch_id, odometer_value, photo_url, source_event, status, created_by)
  VALUES (v_plate, p_driver_id, p_dispatch_id, p_odometer, p_photo_url, 'REPORTE_FALLA', 'VALIDADO', auth.uid());

  SELECT COALESCE(current_odometer, 0) INTO v_current FROM public.vehicles WHERE plate = v_plate;
  IF p_odometer >= v_current THEN
    UPDATE public.vehicles SET current_odometer = p_odometer WHERE plate = v_plate;
  END IF;

  RETURN jsonb_build_object('success', true, 'message', 'Falla reportada correctamente', 'request_id', v_request_id);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_maintenance_request_v2(text, uuid, uuid, text, text, numeric, text, jsonb, text, boolean, numeric, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_maintenance_request_v2(text, uuid, uuid, text, text, numeric, text, jsonb, text, boolean, numeric, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.submit_maintenance_request(
  p_vehicle_plate text, p_driver_id uuid, p_dispatch_id uuid, p_description text,
  p_severity text, p_odometer numeric, p_photo_url text DEFAULT NULL, p_location jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.submit_maintenance_request_v2(p_vehicle_plate, p_driver_id, p_dispatch_id, p_description,
    p_severity, p_odometer, p_photo_url, p_location, NULL, NULL, NULL, NULL);
$$;

REVOKE ALL ON FUNCTION public.submit_maintenance_request(text, uuid, uuid, text, text, numeric, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_maintenance_request(text, uuid, uuid, text, text, numeric, text, jsonb) TO authenticated, service_role;

-- Checklist pre-ruta: escribía dispatches.start_odometer (inexistente)
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS start_odometer numeric;

-- Inspecciones: una sola solicitud por respuesta crítica
CREATE OR REPLACE FUNCTION public.process_inspection_critical_failure()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item       public.checklist_items%ROWTYPE;
  v_inspection public.inspections%ROWTYPE;
BEGIN
  SELECT * INTO v_item FROM public.checklist_items WHERE id = NEW.item_id;
  IF COALESCE(v_item.is_critical, false) AND upper(NEW.response) IN ('NO', 'FALLO', 'FAIL', 'MALO') THEN
    SELECT * INTO v_inspection FROM public.inspections WHERE id = NEW.inspection_id;

    INSERT INTO public.maintenance_requests (
      vehicle_plate, driver_id, description, severity, status, source, source_ref_id, notes, reported_at
    ) VALUES (
      v_inspection.vehicle_plate, v_inspection.driver_id,
      'Fallo crítico en inspección: ' || v_item.text || COALESCE(' - ' || NEW.observation, ''),
      'CRITICA', 'REPORTADA', 'INSPECCION', NEW.id,
      'Generado por inspección ' || v_inspection.id, now()
    )
    ON CONFLICT DO NOTHING;

    UPDATE public.inspections SET global_result = 'FAILED' WHERE id = NEW.inspection_id;
  END IF;
  RETURN NEW;
END;
$$;

-- Copiloto AI: correctivo ⇒ solicitud en el backlog; preventivo ⇒ OT borrador
CREATE OR REPLACE FUNCTION public.ai_confirm_maintenance(p_proposal_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_proposal   public.ai_action_proposals;
  v_ref        jsonb;
  v_id         uuid;
  v_site       uuid;
  v_vehicle_id uuid;
  v_plate      text;
BEGIN
  SELECT * INTO v_proposal FROM public.ai_action_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF v_proposal.id IS NULL OR v_proposal.user_id <> auth.uid() THEN RAISE EXCEPTION 'Propuesta no encontrada'; END IF;
  IF v_proposal.status = 'confirmed' THEN RETURN v_proposal.result_ref; END IF;
  IF v_proposal.status <> 'proposed' OR v_proposal.expires_at <= now()
     OR v_proposal.action_type <> 'schedule_maintenance' THEN
    RAISE EXCEPTION 'Propuesta vencida o cancelada';
  END IF;
  IF NOT public.can_prepare_ai_maintenance() THEN RAISE EXCEPTION 'Permiso revocado'; END IF;

  v_plate := v_proposal.payload->>'vehicle_plate';
  SELECT id, site_id INTO v_vehicle_id, v_site FROM public.vehicles WHERE plate = v_plate FOR UPDATE;
  IF v_site IS NULL OR v_site <> (v_proposal.payload->>'site_id')::uuid OR NOT public.can_access_site(v_site) THEN
    RAISE EXCEPTION 'Unidad fuera del alcance autorizado';
  END IF;
  IF (v_proposal.payload->>'scheduled_date')::date < current_date THEN
    RAISE EXCEPTION 'La fecha propuesta ya pasó';
  END IF;

  IF v_proposal.payload->>'type' = 'PREVENTIVO' THEN
    INSERT INTO public.maintenance_work_orders (
      ot_code, vehicle_id, type, order_type, source_type, priority, description, status, start_date, responsible_id, site_id
    ) VALUES (
      'OT-AI-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
      v_vehicle_id, 'PREVENTIVO', 'PREVENTIVA', 'COPILOTO_AI', 'NORMAL',
      v_proposal.payload->>'reason', 'BORRADOR', (v_proposal.payload->>'scheduled_date')::date, auth.uid(), v_site
    ) RETURNING id INTO v_id;
    v_ref := jsonb_build_object('maintenance_order_id', v_id);
  ELSE
    INSERT INTO public.maintenance_requests (
      vehicle_plate, description, severity, status, source, scheduled_for, reported_by, site_id, notes
    ) VALUES (
      v_plate, v_proposal.payload->>'reason', 'MEDIA', 'REPORTADA', 'COPILOTO_AI',
      (v_proposal.payload->>'scheduled_date')::date, auth.uid(), v_site,
      'Propuesta del Copiloto AI confirmada por el usuario'
    ) RETURNING id INTO v_id;
    v_ref := jsonb_build_object('maintenance_request_id', v_id);
  END IF;

  UPDATE public.ai_action_proposals
  SET status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now(), result_ref = v_ref
  WHERE id = v_proposal.id;
  RETURN v_ref;
END;
$$;

-- ------------------------------------------------------------
-- 8. Permisos F2 alineados con las claves reales de roles
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_manage_fleet_status()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT auth.uid() IS NULL
      OR public.is_tms_admin()
      OR public.has_tms_permission('mantenimiento-flota')
      OR public.has_tms_permission('mantenimiento-ot')
      OR public.has_tms_permission('despacho');
$$;
REVOKE ALL ON FUNCTION public.can_manage_fleet_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_fleet_status() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.transition_vehicle_status(
  p_vehicle_plate text,
  p_new_status    text,
  p_reason        text,
  p_user_id       uuid,
  p_metadata      jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current     text;
  v_actor       uuid := COALESCE(auth.uid(), p_user_id);
  v_is_system   boolean := auth.uid() IS NULL;   -- service_role / procesos internos
  v_is_admin    boolean;
  v_is_manager  boolean;
  v_allowed     text[];
  v_eligibility jsonb;
BEGIN
  v_is_admin   := v_is_system OR public.is_tms_admin();
  v_is_manager := v_is_admin OR public.can_manage_fleet_status();

  IF p_new_status NOT IN ('DISPONIBLE', 'ASIGNADA', 'EN_OPERACION', 'OBSERVADA',
                          'MANTENIMIENTO', 'BLOQUEADA', 'FUERA_DE_SERVICIO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Estado no válido: ' || COALESCE(p_new_status, 'NULL'));
  END IF;

  -- Permisos
  IF NOT v_is_manager AND p_new_status NOT IN ('BLOQUEADA', 'OBSERVADA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso: solo puede reportar la unidad como OBSERVADA o BLOQUEADA');
  END IF;
  IF p_new_status = 'FUERA_DE_SERVICIO' AND NOT v_is_admin THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo un administrador puede dar de baja (FUERA_DE_SERVICIO)');
  END IF;

  SELECT status INTO v_current FROM public.vehicles WHERE plate = p_vehicle_plate FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehículo no encontrado: ' || p_vehicle_plate);
  END IF;

  IF v_current = p_new_status THEN
    RETURN jsonb_build_object('success', true, 'previous_status', v_current, 'new_status', p_new_status, 'unchanged', true);
  END IF;

  v_allowed := CASE v_current
    WHEN 'DISPONIBLE'        THEN ARRAY['ASIGNADA','EN_OPERACION','OBSERVADA','MANTENIMIENTO','BLOQUEADA','FUERA_DE_SERVICIO']
    WHEN 'ASIGNADA'          THEN ARRAY['EN_OPERACION','DISPONIBLE','OBSERVADA','MANTENIMIENTO','BLOQUEADA']
    WHEN 'EN_OPERACION'      THEN ARRAY['DISPONIBLE','ASIGNADA','OBSERVADA','MANTENIMIENTO','BLOQUEADA']
    WHEN 'OBSERVADA'         THEN ARRAY['DISPONIBLE','MANTENIMIENTO','BLOQUEADA','FUERA_DE_SERVICIO']
    WHEN 'MANTENIMIENTO'     THEN ARRAY['DISPONIBLE','OBSERVADA','BLOQUEADA','FUERA_DE_SERVICIO']
    WHEN 'BLOQUEADA'         THEN ARRAY['DISPONIBLE','MANTENIMIENTO','OBSERVADA','FUERA_DE_SERVICIO']
    WHEN 'FUERA_DE_SERVICIO' THEN ARRAY['DISPONIBLE','OBSERVADA','MANTENIMIENTO']
    ELSE ARRAY[]::text[] END;

  IF NOT (p_new_status = ANY (v_allowed)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transición no permitida: ' || v_current || ' → ' || p_new_status);
  END IF;

  -- Compuerta de elegibilidad: liberar o poner en operación exige que no sea NO_APTO
  IF p_new_status IN ('DISPONIBLE', 'ASIGNADA', 'EN_OPERACION') THEN
    v_eligibility := public.check_asset_eligibility(
      p_vehicle_plate,
      CASE WHEN p_new_status = 'DISPONIBLE' THEN 'RELEASE' ELSE 'OPERATION' END);
    IF v_eligibility->>'status' = 'NO_APTO' THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Unidad NO_APTO: ' || (SELECT string_agg(value, '; ') FROM jsonb_array_elements_text(v_eligibility->'motives')),
        'eligibility', v_eligibility);
    END IF;
  END IF;

  UPDATE public.vehicles SET status = p_new_status WHERE plate = p_vehicle_plate;

  INSERT INTO public.vehicle_history_logs (vehicle_plate, changed_by, field_changed, old_value, new_value, change_reason)
  VALUES (p_vehicle_plate, v_actor, 'status', v_current, p_new_status,
          NULLIF(concat_ws(' | ', p_reason,
                 CASE WHEN p_metadata IS NOT NULL AND p_metadata <> '{}'::jsonb THEN p_metadata::text END,
                 CASE WHEN v_eligibility IS NOT NULL THEN 'elegibilidad=' || (v_eligibility->>'status') END), ''));

  RETURN jsonb_build_object('success', true, 'previous_status', v_current, 'new_status', p_new_status,
                            'eligibility', v_eligibility);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_vehicle_administrative_block(
  p_vehicle_plate text,
  p_blocked       boolean,
  p_reason        text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vehicle public.vehicles%ROWTYPE;
  v_result  jsonb;
BEGIN
  IF auth.uid() IS NOT NULL
     AND NOT (public.is_tms_admin() OR public.has_cmms_permission('flota')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para bloqueos administrativos');
  END IF;
  IF p_blocked AND NULLIF(trim(p_reason), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'El bloqueo administrativo requiere un motivo');
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE plate = p_vehicle_plate FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehículo no encontrado: ' || p_vehicle_plate);
  END IF;

  UPDATE public.vehicles
  SET is_blocked = p_blocked,
      block_reason = CASE WHEN p_blocked THEN p_reason ELSE NULL END
  WHERE plate = p_vehicle_plate;

  INSERT INTO public.vehicle_history_logs (vehicle_plate, changed_by, field_changed, old_value, new_value, change_reason)
  VALUES (p_vehicle_plate, auth.uid(), 'is_blocked', COALESCE(v_vehicle.is_blocked, false)::text, p_blocked::text, p_reason);

  -- Bloquear también saca la unidad de servicio operativo
  IF p_blocked AND v_vehicle.status NOT IN ('BLOQUEADA', 'FUERA_DE_SERVICIO') THEN
    v_result := public.transition_vehicle_status(p_vehicle_plate, 'BLOQUEADA', 'Bloqueo administrativo: ' || p_reason);
  END IF;

  RETURN jsonb_build_object('success', true, 'is_blocked', p_blocked, 'transition', v_result);
END;
$$;

-- ------------------------------------------------------------
-- 9. Fuente única: se elimina vehicle_failures (vacía, sin funciones dependientes)
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.vehicle_failures) THEN
    RAISE EXCEPTION 'vehicle_failures tiene datos: migrarlos a maintenance_requests antes de eliminarla';
  END IF;
END $$;
DROP TABLE IF EXISTS public.vehicle_failures;

NOTIFY pgrst, 'reload schema';

COMMIT;
