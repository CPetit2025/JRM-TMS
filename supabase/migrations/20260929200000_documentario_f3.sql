-- ============================================================
-- DESPACHO F3 — Asistente Documentario: guías de remisión, packing list y Nota de Despacho
-- ============================================================
-- Reglas del negocio (docs/despacho/03-f3-asistente-documentario.md):
--  * Cuando Transporte programa la ruta, el Asistente Documentario carga por parada la(s) guía(s) de remisión
--    (PDF; varias por parada: PT, suministros, otros) y el packing list (PDF o Excel).
--  * Recojo por el cliente (despacho EXTERNO / Nota de Salida): se carga la Nota de Despacho; el cliente trae su guía.
--  * El despacho no sale (no deja PROGRAMADO salvo para cancelarse) hasta que el Asistente confirma los documentos.
--  * Si después de confirmar cambian la placa, el conductor o las paradas → "Requiere reemisión" y se vuelve a
--    bloquear la salida hasta que el Asistente confirme de nuevo.
--  * Se registra quién y cuándo cargó, anuló y confirmó.
--  * Solo exige documentos a los despachos programados desde esta versión (docs_required lo marca
--    schedule_dispatch); los despachos ya existentes siguen como antes.
-- Además se corrige schedule_dispatch: el saldo que valida incluye la reserva que las solicitudes ya tienen
-- desde su aprobación (F2), que se libera al programarlas.
BEGIN;

-- ------------------------------------------------------------
-- 1. Estado documentario del despacho
-- ------------------------------------------------------------
ALTER TABLE public.dispatches
  ADD COLUMN IF NOT EXISTS docs_required       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS docs_ready_at       timestamptz,
  ADD COLUMN IF NOT EXISTS docs_ready_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS docs_reissue        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS docs_reissue_reason text,
  ADD COLUMN IF NOT EXISTS docs_reissue_at     timestamptz;

CREATE TABLE IF NOT EXISTS public.dispatch_documents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id          uuid NOT NULL REFERENCES public.dispatches(id) ON DELETE CASCADE,
  transport_request_id uuid REFERENCES public.transport_requests(id) ON DELETE SET NULL,
  doc_type             text NOT NULL CHECK (doc_type IN ('GUIA_REMISION', 'PACKING_LIST', 'NOTA_DESPACHO', 'OTRO')),
  cargo_type           text CHECK (cargo_type IN ('PT', 'SUMINISTROS', 'OTROS')),
  document_number      text,
  file_path            text NOT NULL,
  file_name            text,
  mime_type            text,
  size_bytes           bigint,
  notes                text,
  uploaded_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  uploaded_at          timestamptz NOT NULL DEFAULT now(),
  voided_at            timestamptz,
  voided_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  void_reason          text
);
CREATE INDEX IF NOT EXISTS dispatch_documents_dispatch_idx ON public.dispatch_documents(dispatch_id) WHERE voided_at IS NULL;
-- Una guía no se registra dos veces (serie-número) mientras esté vigente
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_documents_guide_number_key ON public.dispatch_documents(upper(document_number))
  WHERE voided_at IS NULL AND doc_type = 'GUIA_REMISION';

-- ------------------------------------------------------------
-- 2. Rol y permisos
-- ------------------------------------------------------------
-- Quien hoy programa despachos conserva la carga documentaria (no se bloquea la operación actual)
UPDATE public.roles SET permissions = (SELECT jsonb_agg(DISTINCT p) FROM jsonb_array_elements(COALESCE(permissions, '[]'::jsonb) || '["documentario"]'::jsonb) p)
WHERE (permissions ? 'despacho' OR permissions ? 'despacho:write') AND NOT permissions ? 'documentario';
INSERT INTO public.roles (name, permissions)
SELECT 'Asistente Documentario', '["dashboard","documentario","despacho:read","torre-control:read"]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.roles WHERE name = 'Asistente Documentario');

-- Quién ve los documentos de un despacho: staff de la sede o el conductor del viaje
CREATE OR REPLACE FUNCTION public.can_view_dispatch_documents(p_dispatch_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.dispatches d WHERE d.id = p_dispatch_id AND (
      ((public.has_tms_read_permission('documentario') OR public.can_view_driver_evidence())
        AND (d.site_id IS NULL OR public.can_access_site(d.site_id)))
      OR EXISTS (SELECT 1 FROM public.drivers dr WHERE dr.id = d.driver_id AND dr.profile_id = auth.uid())));
$$;

-- Ruta de storage "<dispatch_id>/..." → dispatch_id (NULL si no es un uuid)
CREATE OR REPLACE FUNCTION public.dispatch_document_folder(p_name text)
RETURNS uuid LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  RETURN split_part(p_name, '/', 1)::uuid;
EXCEPTION WHEN others THEN RETURN NULL;
END $$;

ALTER TABLE public.dispatch_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dispatch_documents_read ON public.dispatch_documents;
CREATE POLICY dispatch_documents_read ON public.dispatch_documents FOR SELECT TO authenticated
  USING (public.can_view_dispatch_documents(dispatch_id));
REVOKE ALL ON public.dispatch_documents FROM anon;
GRANT SELECT ON public.dispatch_documents TO authenticated;

-- ------------------------------------------------------------
-- 3. Bucket privado de documentos (PDF, Excel e imágenes escaneadas)
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('dispatch_documents', 'dispatch_documents', false, 15 * 1024 * 1024, ARRAY[
  'application/pdf', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv', 'image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS dispatch_documents_obj_read ON storage.objects;
CREATE POLICY dispatch_documents_obj_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'dispatch_documents' AND public.can_view_dispatch_documents(public.dispatch_document_folder(name)));
DROP POLICY IF EXISTS dispatch_documents_obj_insert ON storage.objects;
CREATE POLICY dispatch_documents_obj_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'dispatch_documents' AND public.has_tms_permission('documentario')
    AND public.dispatch_document_folder(name) IS NOT NULL);

-- ------------------------------------------------------------
-- 4. Registro, anulación y confirmación de documentos
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_dispatch_document(
  p_dispatch_id uuid, p_request_id uuid, p_doc_type text, p_cargo_type text, p_document_number text,
  p_file_path text, p_file_name text, p_mime_type text, p_size_bytes bigint, p_notes text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d        record;
  v_pickup boolean;
  v_type   text := upper(COALESCE(p_doc_type, ''));
  v_number text := NULLIF(upper(trim(COALESCE(p_document_number, ''))), '');
  v_id     uuid;
BEGIN
  IF NOT public.has_tms_permission('documentario') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el Asistente Documentario carga documentos del despacho');
  END IF;
  SELECT id, status, site_id, vehicle_plate INTO d FROM public.dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Despacho inexistente');
  END IF;
  IF d.status <> 'PROGRAMADO' AND v_type <> 'OTRO' THEN
    RETURN jsonb_build_object('success', false, 'error', 'El despacho ya salió (' || d.status || '): solo se pueden adjuntar documentos de tipo "Otro"');
  END IF;
  v_pickup := COALESCE(d.vehicle_plate, '') = 'EXTERNO';
  IF v_type NOT IN ('GUIA_REMISION', 'PACKING_LIST', 'NOTA_DESPACHO', 'OTRO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Tipo de documento inválido');
  END IF;
  IF v_type = 'GUIA_REMISION' AND v_pickup THEN
    RETURN jsonb_build_object('success', false, 'error', 'Recojo por el cliente: cargue la Nota de Despacho (el cliente trae su guía)');
  END IF;
  IF v_type = 'NOTA_DESPACHO' AND NOT v_pickup THEN
    RETURN jsonb_build_object('success', false, 'error', 'La Nota de Despacho es solo para recojos del cliente; este envío requiere guía de remisión');
  END IF;
  IF v_type IN ('GUIA_REMISION', 'NOTA_DESPACHO') AND v_number IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique la serie y número del documento');
  END IF;
  IF v_type IN ('GUIA_REMISION', 'NOTA_DESPACHO') AND COALESCE(p_mime_type, '') <> 'application/pdf' THEN
    RETURN jsonb_build_object('success', false, 'error', 'La guía y la Nota de Despacho se cargan en PDF');
  END IF;
  IF v_type = 'GUIA_REMISION' AND EXISTS (SELECT 1 FROM public.dispatch_documents
      WHERE doc_type = 'GUIA_REMISION' AND voided_at IS NULL AND upper(document_number) = v_number) THEN
    RETURN jsonb_build_object('success', false, 'error', 'La guía ' || v_number || ' ya está registrada');
  END IF;
  IF p_request_id IS NULL AND v_type IN ('GUIA_REMISION', 'NOTA_DESPACHO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Seleccione la parada (solicitud) del documento');
  END IF;
  IF p_request_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.dispatch_requests
      WHERE dispatch_id = p_dispatch_id AND transport_request_id = p_request_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'La solicitud no pertenece a este despacho');
  END IF;
  IF public.dispatch_document_folder(p_file_path) IS DISTINCT FROM p_dispatch_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Archivo inválido para este despacho');
  END IF;

  INSERT INTO public.dispatch_documents (dispatch_id, transport_request_id, doc_type, cargo_type, document_number,
    file_path, file_name, mime_type, size_bytes, notes, uploaded_by)
  VALUES (p_dispatch_id, p_request_id, v_type, NULLIF(upper(COALESCE(p_cargo_type, '')), ''), v_number,
    p_file_path, p_file_name, p_mime_type, p_size_bytes, NULLIF(trim(COALESCE(p_notes, '')), ''), auth.uid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', true, 'id', v_id);
END $$;

CREATE OR REPLACE FUNCTION public.void_dispatch_document(p_document_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE doc record;
BEGIN
  IF NOT public.has_tms_permission('documentario') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el Asistente Documentario anula documentos');
  END IF;
  IF NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo de la anulación');
  END IF;
  SELECT x.id, x.doc_type, x.voided_at, d.id AS dispatch_id, d.status, d.site_id INTO doc
  FROM public.dispatch_documents x JOIN public.dispatches d ON d.id = x.dispatch_id WHERE x.id = p_document_id FOR UPDATE OF x;
  IF NOT FOUND OR (doc.site_id IS NOT NULL AND NOT public.can_access_site(doc.site_id)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Documento inexistente');
  END IF;
  IF doc.voided_at IS NOT NULL THEN RETURN jsonb_build_object('success', false, 'error', 'El documento ya está anulado'); END IF;
  IF doc.status <> 'PROGRAMADO' THEN
    RETURN jsonb_build_object('success', false, 'error', 'El despacho ya salió: los documentos no se anulan');
  END IF;
  UPDATE public.dispatch_documents SET voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason) WHERE id = p_document_id;
  -- Anular una guía o nota confirmada obliga a confirmar de nuevo
  IF doc.doc_type IN ('GUIA_REMISION', 'NOTA_DESPACHO') THEN
    UPDATE public.dispatches SET docs_ready_at = NULL, docs_ready_by = NULL WHERE id = doc.dispatch_id AND docs_ready_at IS NOT NULL;
  END IF;
  RETURN jsonb_build_object('success', true);
END $$;

-- Paradas del despacho sin guía (o sin Nota de Despacho en recojos)
CREATE OR REPLACE FUNCTION public.dispatch_documents_missing(p_dispatch_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT string_agg(COALESCE(t.request_number, r.transport_request_id::text), ', ' ORDER BY (to_jsonb(r)->>'sequence_order')::int NULLS LAST, t.request_number)
  FROM public.dispatch_requests r
  JOIN public.dispatches d ON d.id = r.dispatch_id
  LEFT JOIN public.transport_requests t ON t.id = r.transport_request_id
  WHERE r.dispatch_id = p_dispatch_id AND NOT EXISTS (
    SELECT 1 FROM public.dispatch_documents x WHERE x.dispatch_id = r.dispatch_id AND x.transport_request_id = r.transport_request_id
      AND x.voided_at IS NULL
      AND x.doc_type = CASE WHEN COALESCE(d.vehicle_plate, '') = 'EXTERNO' THEN 'NOTA_DESPACHO' ELSE 'GUIA_REMISION' END);
$$;

CREATE OR REPLACE FUNCTION public.confirm_dispatch_documents(p_dispatch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d record; v_missing text;
BEGIN
  IF NOT public.has_tms_permission('documentario') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el Asistente Documentario confirma los documentos');
  END IF;
  SELECT id, status, site_id, vehicle_plate INTO d FROM public.dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Despacho inexistente');
  END IF;
  IF d.status <> 'PROGRAMADO' THEN
    RETURN jsonb_build_object('success', false, 'error', 'El despacho ya no está programado (' || d.status || ')');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.dispatch_requests WHERE dispatch_id = p_dispatch_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'El despacho no tiene paradas');
  END IF;
  v_missing := public.dispatch_documents_missing(p_dispatch_id);
  IF v_missing IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error',
      CASE WHEN COALESCE(d.vehicle_plate, '') = 'EXTERNO' THEN 'Falta la Nota de Despacho de: ' ELSE 'Falta la guía de remisión (PDF) de: ' END || v_missing);
  END IF;
  UPDATE public.dispatches SET docs_ready_at = now(), docs_ready_by = auth.uid(),
    docs_reissue = false, docs_reissue_reason = NULL, docs_reissue_at = NULL
  WHERE id = p_dispatch_id;
  INSERT INTO public.dispatch_events (dispatch_id, event_type, description, created_by)
  SELECT p_dispatch_id, 'DOCUMENTOS', 'Documentos confirmados por el Asistente Documentario', auth.uid()
  WHERE to_regclass('public.dispatch_events') IS NOT NULL;
  RETURN jsonb_build_object('success', true);
END $$;

-- ------------------------------------------------------------
-- 5. Reemisión: cambios de placa, conductor o paradas después de confirmar
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_docs_detect_changes()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.docs_ready_at IS NOT NULL AND NEW.status = 'PROGRAMADO' AND (
     NEW.vehicle_plate IS DISTINCT FROM OLD.vehicle_plate OR NEW.driver_id IS DISTINCT FROM OLD.driver_id) THEN
    NEW.docs_reissue := true;
    NEW.docs_reissue_at := now();
    NEW.docs_reissue_reason := concat_ws('; ',
      CASE WHEN NEW.vehicle_plate IS DISTINCT FROM OLD.vehicle_plate THEN 'Cambió la placa ' || COALESCE(OLD.vehicle_plate, '—') || ' → ' || COALESCE(NEW.vehicle_plate, '—') END,
      CASE WHEN NEW.driver_id IS DISTINCT FROM OLD.driver_id THEN 'Cambió el conductor' END);
  END IF;
  -- Salida del almacén: exige documentos confirmados y vigentes (cancelar sigue permitido)
  IF NEW.docs_required AND OLD.status = 'PROGRAMADO' AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status NOT IN ('PROGRAMADO', 'CANCELADO') THEN
    IF NEW.docs_reissue THEN
      RAISE EXCEPTION 'Documentos por reemitir (%): el Asistente Documentario debe actualizar y confirmar las guías antes de la salida',
        COALESCE(NEW.docs_reissue_reason, 'cambios en el despacho');
    ELSIF NEW.docs_ready_at IS NULL THEN
      RAISE EXCEPTION 'Documentos pendientes: el Asistente Documentario debe cargar % y confirmarlos antes de la salida',
        CASE WHEN COALESCE(NEW.vehicle_plate, '') = 'EXTERNO' THEN 'la Nota de Despacho' ELSE 'la guía de remisión' END;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS dispatch_docs_detect_changes ON public.dispatches;
CREATE TRIGGER dispatch_docs_detect_changes BEFORE UPDATE ON public.dispatches
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_docs_detect_changes();

CREATE OR REPLACE FUNCTION public.dispatch_docs_stops_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_dispatch uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.dispatch_id ELSE NEW.dispatch_id END;
BEGIN
  UPDATE public.dispatches SET docs_reissue = true, docs_reissue_at = now(),
    docs_reissue_reason = CASE WHEN TG_OP = 'DELETE' THEN 'Se retiró una parada' ELSE 'Se agregó una parada' END
  WHERE id = v_dispatch AND docs_ready_at IS NOT NULL AND status = 'PROGRAMADO';
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS dispatch_docs_stops_changed ON public.dispatch_requests;
CREATE TRIGGER dispatch_docs_stops_changed AFTER INSERT OR DELETE ON public.dispatch_requests
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_docs_stops_changed();

-- ------------------------------------------------------------
-- 6. Bandeja del Asistente Documentario (ordenada por salida)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_documentary_queue(p_include_departed boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (public.has_tms_read_permission('documentario') OR public.can_view_driver_evidence()) THEN
    RAISE EXCEPTION 'Sin permiso para ver la bandeja documentaria';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(q ORDER BY q.scheduled_departure NULLS LAST, q.dispatch_number)
    FROM (
      SELECT d.id, d.dispatch_number, d.status, d.vehicle_plate, d.driver_name, d.scheduled_departure,
             d.docs_required, d.docs_ready_at, d.docs_reissue, d.docs_reissue_reason,
             (COALESCE(d.vehicle_plate, '') = 'EXTERNO') AS is_pickup,
             (SELECT COALESCE(NULLIF(trim(concat_ws(' ', to_jsonb(p)->>'first_name', to_jsonb(p)->>'last_name')), ''), to_jsonb(p)->>'email') FROM public.profiles p WHERE p.id = d.docs_ready_by) AS docs_ready_by_name,
             CASE WHEN d.status <> 'PROGRAMADO' THEN 'SALIO'
                  WHEN d.docs_reissue THEN 'REEMISION'
                  WHEN d.docs_ready_at IS NOT NULL THEN 'LISTO'
                  ELSE 'PENDIENTE' END AS doc_status,
             public.dispatch_documents_missing(d.id) AS missing,
             (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'request_id', t.id, 'request_number', t.request_number, 'sequence', (to_jsonb(r)->>'sequence_order')::int,
                'delivery', concat_ws(' · ', to_jsonb(t)->>'delivery_address', to_jsonb(t)->>'delivery_district'),
                'cargo', to_jsonb(t)->>'cargo_description', 'client', to_jsonb(t)->>'requester_name')
                ORDER BY (to_jsonb(r)->>'sequence_order')::int NULLS LAST, t.request_number), '[]'::jsonb)
              FROM public.dispatch_requests r JOIN public.transport_requests t ON t.id = r.transport_request_id
              WHERE r.dispatch_id = d.id) AS stops,
             (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'id', x.id, 'request_id', x.transport_request_id, 'doc_type', x.doc_type, 'cargo_type', x.cargo_type,
                'document_number', x.document_number, 'file_path', x.file_path, 'file_name', x.file_name,
                'mime_type', x.mime_type, 'uploaded_at', x.uploaded_at,
                'uploaded_by', (SELECT COALESCE(NULLIF(trim(concat_ws(' ', to_jsonb(p)->>'first_name', to_jsonb(p)->>'last_name')), ''), to_jsonb(p)->>'email') FROM public.profiles p WHERE p.id = x.uploaded_by))
                ORDER BY x.uploaded_at), '[]'::jsonb)
              FROM public.dispatch_documents x WHERE x.dispatch_id = d.id AND x.voided_at IS NULL) AS documents
      FROM public.dispatches d
      WHERE (d.site_id IS NULL OR public.can_access_site(d.site_id))
        AND (d.status = 'PROGRAMADO' OR (p_include_departed AND d.docs_required
             AND d.status NOT IN ('CANCELADO') AND COALESCE(d.scheduled_departure, now()) > now() - interval '7 days'))
    ) q), '[]'::jsonb);
END $$;

-- ------------------------------------------------------------
-- 7. Programar: marca el despacho como sujeto a documentos y valida el saldo incluyendo la reserva de F2
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.schedule_dispatch(
  p_driver_id uuid, p_vehicle_plate text, p_departure timestamptz,
  p_estimated_km numeric, p_freight_cost numeric, p_contract_id uuid,
  p_document_type text, p_requests jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_dispatch_id uuid;
DECLARE v_driver_name text;
DECLARE v_number text;
DECLARE v_budget public.contract_budgets%ROWTYPE;
DECLARE v_request jsonb;
DECLARE v_request_id uuid;
DECLARE v_order integer := 0;
DECLARE v_request_reserved numeric := 0;
BEGIN
  IF NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Sin permiso para programar despachos'; END IF;

  IF p_departure IS NULL OR p_document_type NOT IN ('GR','NOTA_SALIDA')
    OR p_requests IS NULL OR jsonb_typeof(p_requests) <> 'array' OR jsonb_array_length(p_requests) = 0
    OR coalesce(p_freight_cost, 0) < 0 THEN
    RAISE EXCEPTION 'Datos de programación incompletos';
  END IF;

  IF p_document_type <> 'NOTA_SALIDA' THEN
    SELECT trim(first_name || ' ' || last_name) INTO v_driver_name FROM public.drivers
    WHERE id = p_driver_id AND is_active = true AND profile_id IS NOT NULL;
    IF v_driver_name IS NULL OR p_vehicle_plate IS NULL OR p_vehicle_plate = '' THEN
      RAISE EXCEPTION 'Conductor o unidad no disponible';
    END IF;
  ELSE
    v_driver_name := 'CLIENTE';
    p_driver_id := NULL;
    p_vehicle_plate := 'EXTERNO';
  END IF;

  -- Bloqueo pre-ordenado de las solicitudes (evita deadlocks) y su reserva vigente desde la aprobación
  FOR v_request_id IN (
      SELECT (value->>'id')::uuid AS req_id
      FROM jsonb_array_elements(p_requests)
      ORDER BY req_id
  ) LOOP
      PERFORM 1 FROM public.transport_requests
      WHERE id = v_request_id AND status IN ('APROBADA','REPROGRAMADA') FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Solicitud no aprobada, ya asignada o inexistente'; END IF;
  END LOOP;
  SELECT COALESCE(sum((to_jsonb(t)->>'reserved_pen')::numeric), 0) INTO v_request_reserved
  FROM public.transport_requests t
  WHERE t.id IN (SELECT (value->>'id')::uuid FROM jsonb_array_elements(p_requests))
    AND t.contract_id IS NOT DISTINCT FROM p_contract_id;

  IF coalesce(p_freight_cost, 0) > 0 AND p_contract_id IS NOT NULL
    AND p_document_type <> 'NOTA_SALIDA' THEN
    SELECT * INTO v_budget FROM public.contract_budgets
    WHERE contract_id = p_contract_id AND concept = 'PARTIDA_TRANSPORTE' FOR UPDATE;
    -- La reserva de las solicitudes se libera al asignarlas: cuenta como saldo disponible para su flete
    IF v_budget.id IS NULL OR v_budget.balance_pen + v_request_reserved < p_freight_cost THEN
      RAISE EXCEPTION 'Presupuesto de transporte insuficiente';
    END IF;
  END IF;

  v_number := 'DESP-' || to_char(now(), 'YYYYMMDD') || '-'
    || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  INSERT INTO public.dispatches(dispatch_number, driver_id, driver_name, vehicle_plate,
    scheduled_departure, status, estimated_distance_km, freight_cost, contract_id, docs_required)
  VALUES(v_number, p_driver_id, v_driver_name, p_vehicle_plate,
    p_departure, 'PROGRAMADO', coalesce(p_estimated_km, 0), coalesce(p_freight_cost, 0), p_contract_id, true)
  RETURNING id INTO v_dispatch_id;

  FOR v_request IN SELECT value FROM jsonb_array_elements(p_requests)
  LOOP
    v_order := v_order + 1;
    v_request_id := (v_request->>'id')::uuid;

    IF p_contract_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.transport_requests
      WHERE id = v_request_id AND contract_id IS DISTINCT FROM p_contract_id) THEN
      RAISE EXCEPTION 'Las solicitudes deben pertenecer al mismo contrato';
    END IF;

    INSERT INTO public.dispatch_requests(dispatch_id, transport_request_id, status,
      document_type, document_number, leg_planned_km, sequence_order)
    VALUES(v_dispatch_id, v_request_id, 'PROGRAMADO', p_document_type,
      nullif(v_request->>'document_number', ''),
      nullif(v_request->>'leg_planned_km', '')::numeric, v_order);

    -- Libera la reserva de la aprobación (trigger de F2)
    UPDATE public.transport_requests SET status = 'ASIGNADA' WHERE id = v_request_id;
  END LOOP;

  -- El flete del despacho toma el lugar de la reserva de las solicitudes
  IF coalesce(p_freight_cost, 0) > 0 AND p_contract_id IS NOT NULL
    AND p_document_type <> 'NOTA_SALIDA' THEN
    UPDATE public.contract_budgets SET reserved_pen = reserved_pen + p_freight_cost,
      updated_at = now() WHERE id = v_budget.id;
    INSERT INTO public.contract_services(contract_id, service_type, description,
      amount_pen, service_date, plate, driver_name, category, created_by, dispatch_id)
    VALUES(p_contract_id, 'FLETE', 'Flete del despacho ' || v_number,
      p_freight_cost, p_departure::date, p_vehicle_plate, v_driver_name,
      'Contrato', auth.uid(), v_dispatch_id);
  END IF;

  RETURN v_dispatch_id;
END $$;

-- ------------------------------------------------------------
-- 8. Documentos en la galería de evidencias del despacho
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_dispatch_evidence(p_dispatch_id uuid)
RETURNS TABLE (kind text, label text, path text, taken_at timestamptz, ref_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d record;
BEGIN
  SELECT x.id, x.site_id, to_jsonb(x) AS j INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
  IF NOT FOUND OR NOT public.can_view_driver_evidence() OR NOT public.can_access_site(d.site_id) THEN RETURN; END IF;

  RETURN QUERY
  SELECT 'DOCUMENTO'::text,
         CASE x.doc_type WHEN 'GUIA_REMISION' THEN 'Guía ' WHEN 'PACKING_LIST' THEN 'Packing list ' WHEN 'NOTA_DESPACHO' THEN 'Nota de Despacho ' ELSE 'Documento ' END
           || COALESCE(x.document_number, '') || COALESCE(' · ' || t.request_number, ''),
         'dispatch_documents/' || x.file_path, x.uploaded_at, x.id
  FROM public.dispatch_documents x LEFT JOIN public.transport_requests t ON t.id = x.transport_request_id
  WHERE x.dispatch_id = p_dispatch_id AND x.voided_at IS NULL
  UNION ALL
  SELECT 'ENTREGA'::text, COALESCE('Entrega · ' || (tr.j->>'requester_name'), 'Parada ' || COALESCE(s.j->>'stop_type', '')),
         s.j->>'photo_url', NULLIF(COALESCE(s.j->>'arrival_time', s.j->>'created_at'), '')::timestamptz, s.id
  FROM (SELECT r.id, to_jsonb(r) AS j FROM public.route_stops_log r WHERE r.dispatch_id = p_dispatch_id) s
  LEFT JOIN LATERAL (SELECT to_jsonb(t) AS j FROM public.transport_requests t WHERE t.id::text = s.j->>'transport_request_id') tr ON true
  WHERE NULLIF(s.j->>'photo_url', '') IS NOT NULL
  UNION ALL
  SELECT 'CHECKLIST', 'Checklist de la unidad', c.j->>'photo_url', NULLIF(c.j->>'created_at', '')::timestamptz, c.id
  FROM (SELECT k.id, to_jsonb(k) AS j FROM public.driver_checklists k WHERE k.dispatch_id = p_dispatch_id) c
  WHERE NULLIF(c.j->>'photo_url', '') IS NOT NULL
  UNION ALL
  SELECT 'GUIA', 'Guía / documento de cierre', COALESCE(g.value->>'path', g.value #>> '{}'), NULL::timestamptz, NULL::uuid
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.j->'liquidation_data'->'guias') = 'array' THEN d.j->'liquidation_data'->'guias' ELSE '[]'::jsonb END) g
  UNION ALL
  SELECT 'ODOMETRO', 'Odómetro · ' || COALESCE(o.j->>'source_event', ''), o.j->>'photo_url', NULLIF(o.j->>'created_at', '')::timestamptz, o.id
  FROM (SELECT v.id, to_jsonb(v) AS j FROM public.vehicle_odometer_logs v WHERE v.dispatch_id = p_dispatch_id) o
  WHERE NULLIF(o.j->>'photo_url', '') IS NOT NULL
  UNION ALL
  SELECT 'FALLA', 'Falla · ' || left(COALESCE(m.j->>'description', ''), 60), p.value #>> '{}', NULLIF(m.j->>'reported_at', '')::timestamptz, m.id
  FROM (SELECT r.id, to_jsonb(r) AS j FROM public.maintenance_requests r WHERE r.dispatch_id = p_dispatch_id) m
  CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(m.j->'photo_url', m.j->'audio_url')
    || CASE WHEN jsonb_typeof(m.j->'evidence') = 'array' THEN m.j->'evidence' ELSE '[]'::jsonb END) p
  WHERE NULLIF(p.value #>> '{}', '') IS NOT NULL
  UNION ALL
  SELECT 'GASTO', 'Gasto · ' || e.expense_type || ' S/ ' || e.amount, e.receipt_url, e.created_at, e.id
  FROM public.dispatch_expenses e WHERE e.dispatch_id = p_dispatch_id AND NULLIF(e.receipt_url, '') IS NOT NULL
  UNION ALL
  SELECT 'ANTICIPO', 'Anticipo ' || a.code, a.evidence_url, a.requested_at, a.id
  FROM public.trip_advances a WHERE (a.dispatch_id = p_dispatch_id OR a.context_dispatch_id = p_dispatch_id) AND NULLIF(a.evidence_url, '') IS NOT NULL;
END $$;

-- ------------------------------------------------------------
-- 9. Permisos de ejecución
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.can_view_dispatch_documents(uuid), public.dispatch_document_folder(text),
  public.register_dispatch_document(uuid, uuid, text, text, text, text, text, text, bigint, text),
  public.void_dispatch_document(uuid, text), public.dispatch_documents_missing(uuid),
  public.confirm_dispatch_documents(uuid), public.get_documentary_queue(boolean),
  public.dispatch_docs_detect_changes(), public.dispatch_docs_stops_changed() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_dispatch_documents(uuid), public.dispatch_document_folder(text),
  public.register_dispatch_document(uuid, uuid, text, text, text, text, text, text, bigint, text),
  public.void_dispatch_document(uuid, text), public.dispatch_documents_missing(uuid),
  public.confirm_dispatch_documents(uuid), public.get_documentary_queue(boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.schedule_dispatch(uuid,text,timestamptz,numeric,numeric,uuid,text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.schedule_dispatch(uuid,text,timestamptz,numeric,numeric,uuid,text,jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_dispatch_evidence(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dispatch_evidence(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
