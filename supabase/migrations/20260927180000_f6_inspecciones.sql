-- 20260927180000_f6_inspecciones.sql
-- FASE 6 — Inspecciones y checklist.
--
-- * Plantillas por tipo de inspección (PREOPERACIONAL, POSTOPERACIONAL, PERIODICA, SEGURIDAD,
--   INSPECCION_TECNICA) y por tipo de activo; preguntas con criticidad, tipo de respuesta y
--   evidencia fotográfica obligatoria.
-- * submit_inspection: única entrada (web y App) con validaciones, lectura de odómetro/horómetro
--   por fuente autorizada, firma, ubicación y resultado global. Respuesta crítica ⇒ falla CRITICA
--   (sin duplicar, F3) ⇒ bloqueo por motor (F2).
-- * El checklist pre-ruta de la App (incluidos los APK instalados) queda registrado como
--   inspección PREOPERACIONAL sobre la plantilla del sistema APP_PRE_RUTA; driver_checklists se
--   conserva como registro del despacho enlazado a la inspección.
-- * RLS: fuera las políticas "todo visible" y "cualquiera inserta"; escritura solo por RPC.

BEGIN;

-- ------------------------------------------------------------
-- 1. Plantillas y preguntas
-- ------------------------------------------------------------
ALTER TABLE public.checklist_templates
  ADD COLUMN IF NOT EXISTS code text,
  ADD COLUMN IF NOT EXISTS asset_types text[],
  ADD COLUMN IF NOT EXISTS requires_signature boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS requires_odometer boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS description text;

UPDATE public.checklist_templates SET type = CASE upper(type)
  WHEN 'PRE_TRIP' THEN 'PREOPERACIONAL' WHEN 'POST_TRIP' THEN 'POSTOPERACIONAL'
  WHEN 'MAINTENANCE' THEN 'PERIODICA' ELSE upper(type) END;
ALTER TABLE public.checklist_templates DROP CONSTRAINT IF EXISTS checklist_templates_type_check;
ALTER TABLE public.checklist_templates ADD CONSTRAINT checklist_templates_type_check
  CHECK (type IN ('PREOPERACIONAL', 'POSTOPERACIONAL', 'PERIODICA', 'SEGURIDAD', 'INSPECCION_TECNICA'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_checklist_templates_code ON public.checklist_templates (code) WHERE code IS NOT NULL;

-- Tipos legados (PRE_TRIP, POST_TRIP, MAINTENANCE) se normalizan al vocabulario canónico
CREATE OR REPLACE FUNCTION public.normalize_checklist_template()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.type := CASE upper(trim(NEW.type))
    WHEN 'PRE_TRIP' THEN 'PREOPERACIONAL' WHEN 'POST_TRIP' THEN 'POSTOPERACIONAL'
    WHEN 'MAINTENANCE' THEN 'PERIODICA' WHEN 'SAFETY' THEN 'SEGURIDAD' ELSE upper(trim(NEW.type)) END;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_normalize_checklist_template ON public.checklist_templates;
CREATE TRIGGER trg_normalize_checklist_template
BEFORE INSERT OR UPDATE ON public.checklist_templates
FOR EACH ROW EXECUTE FUNCTION public.normalize_checklist_template();

ALTER TABLE public.checklist_items
  ADD COLUMN IF NOT EXISTS code text,
  ADD COLUMN IF NOT EXISTS requires_photo boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS help_text text;
UPDATE public.checklist_items SET response_type = upper(COALESCE(response_type, 'YES_NO'));
ALTER TABLE public.checklist_items DROP CONSTRAINT IF EXISTS checklist_items_response_type_check;
ALTER TABLE public.checklist_items ADD CONSTRAINT checklist_items_response_type_check
  CHECK (response_type IN ('YES_NO', 'PASS_FAIL', 'OK_MAL', 'NUMERIC', 'TEXT'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_checklist_items_code ON public.checklist_items (template_id, code) WHERE code IS NOT NULL;

-- Respuesta negativa normalizada (una sola definición para triggers y RPC)
CREATE OR REPLACE FUNCTION public.is_failing_response(p_response text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT upper(trim(COALESCE(p_response, ''))) IN ('NO', 'FALLO', 'FAIL', 'MALO', 'MAL', 'NOK', 'NO_OK');
$$;

-- ------------------------------------------------------------
-- 2. Inspecciones
-- ------------------------------------------------------------
ALTER TABLE public.inspections
  ADD COLUMN IF NOT EXISTS inspection_type text,
  ADD COLUMN IF NOT EXISTS dispatch_id uuid REFERENCES public.dispatches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS odometer numeric(12,2),
  ADD COLUMN IF NOT EXISTS hours numeric(10,2),
  ADD COLUMN IF NOT EXISTS signature_url text,
  ADD COLUMN IF NOT EXISTS location_lat numeric(10,6),
  ADD COLUMN IF NOT EXISTS location_lon numeric(10,6),
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'WEB',
  ADD COLUMN IF NOT EXISTS site_id uuid REFERENCES public.sites(id),
  ADD COLUMN IF NOT EXISTS failed_items int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS critical_failures int NOT NULL DEFAULT 0;

ALTER TABLE public.inspections DROP CONSTRAINT IF EXISTS inspections_global_result_check;
ALTER TABLE public.inspections ADD CONSTRAINT inspections_global_result_check
  CHECK (global_result IS NULL OR global_result IN ('PASSED', 'WARNING', 'FAILED'));

ALTER TABLE public.driver_checklists ADD COLUMN IF NOT EXISTS inspection_id uuid REFERENCES public.inspections(id) ON DELETE SET NULL;

-- Falla automática por respuesta crítica (reemplaza la de F3 con la definición común de negativo)
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
  IF COALESCE(v_item.is_critical, false) AND public.is_failing_response(NEW.response) THEN
    SELECT * INTO v_inspection FROM public.inspections WHERE id = NEW.inspection_id;
    INSERT INTO public.maintenance_requests (
      vehicle_plate, driver_id, dispatch_id, description, severity, status, source, source_ref_id,
      odometer_at_report, horometer, photo_url, notes, reported_at, reported_by
    ) VALUES (
      v_inspection.vehicle_plate, v_inspection.driver_id, v_inspection.dispatch_id,
      'Fallo crítico en inspección: ' || v_item.text || COALESCE(' - ' || NULLIF(NEW.observation, ''), ''),
      'CRITICA', 'REPORTADA', 'INSPECCION', NEW.id,
      v_inspection.odometer, v_inspection.hours, NEW.photo_url,
      'Generado por inspección ' || v_inspection.id, now(), v_inspection.created_by
    )
    ON CONFLICT DO NOTHING;
    UPDATE public.inspections SET global_result = 'FAILED' WHERE id = NEW.inspection_id;
  END IF;
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- 3. Entrada única de inspecciones
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_inspection(
  p_vehicle_plate text,
  p_template_id   uuid,
  p_answers       jsonb,
  p_odometer      numeric DEFAULT NULL,
  p_hours         numeric DEFAULT NULL,
  p_signature_url text    DEFAULT NULL,
  p_dispatch_id   uuid    DEFAULT NULL,
  p_notes         text    DEFAULT NULL,
  p_location      jsonb   DEFAULT NULL,
  p_source        text    DEFAULT 'WEB'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vehicle   public.vehicles%ROWTYPE;
  v_tpl       public.checklist_templates%ROWTYPE;
  v_item      public.checklist_items%ROWTYPE;
  v_answer    jsonb;
  v_driver    uuid;
  v_insp      uuid;
  v_failed    int := 0;
  v_critical  int := 0;
  v_missing   text[] := '{}';
  v_reading   jsonb;
  v_result    text;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT (public.has_tms_permission('checklist') OR public.has_cmms_permission('flota')
                                     OR public.has_cmms_permission('ot') OR public.has_cmms_permission('fallas')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para registrar inspecciones');
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE plate = upper(trim(p_vehicle_plate));
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unidad no registrada');
  END IF;
  SELECT * INTO v_tpl FROM public.checklist_templates WHERE id = p_template_id AND COALESCE(active, true);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Plantilla inexistente o inactiva');
  END IF;
  IF v_tpl.asset_types IS NOT NULL AND cardinality(v_tpl.asset_types) > 0 AND NOT (v_vehicle.type = ANY (v_tpl.asset_types)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'La plantilla no aplica a ' || v_vehicle.type);
  END IF;
  IF v_tpl.requires_signature AND NULLIF(trim(p_signature_url), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'La inspección requiere firma');
  END IF;

  -- Todas las preguntas respondidas y evidencias obligatorias presentes
  FOR v_item IN SELECT * FROM public.checklist_items WHERE template_id = v_tpl.id ORDER BY position LOOP
    SELECT a INTO v_answer FROM jsonb_array_elements(COALESCE(p_answers, '[]'::jsonb)) a
    WHERE a->>'item_id' = v_item.id::text OR (v_item.code IS NOT NULL AND a->>'code' = v_item.code) LIMIT 1;
    IF v_answer IS NULL OR NULLIF(trim(v_answer->>'response'), '') IS NULL THEN
      v_missing := v_missing || v_item.text;
    ELSIF v_item.requires_photo AND NULLIF(trim(v_answer->>'photo_url'), '') IS NULL THEN
      v_missing := v_missing || (v_item.text || ' (foto)');
    END IF;
  END LOOP;
  IF cardinality(v_missing) > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Faltan respuestas: ' || array_to_string(v_missing, ', '));
  END IF;

  -- Lecturas por la fuente autorizada (monotónicas)
  IF v_tpl.requires_odometer AND p_odometer IS NULL AND p_hours IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Registre odómetro u horómetro');
  END IF;
  IF p_odometer < COALESCE(v_vehicle.current_odometer, 0) OR p_hours < COALESCE(v_vehicle.current_hours, 0) THEN
    RETURN jsonb_build_object('success', false, 'error', 'La lectura es menor a la registrada (odómetro '
      || COALESCE(v_vehicle.current_odometer, 0) || ', horómetro ' || COALESCE(v_vehicle.current_hours, 0) || ')');
  END IF;
  IF p_odometer > COALESCE(v_vehicle.current_odometer, 0) OR p_hours > COALESCE(v_vehicle.current_hours, 0) THEN
    v_reading := public.register_asset_reading(v_vehicle.plate,
      CASE WHEN p_odometer > COALESCE(v_vehicle.current_odometer, 0) THEN p_odometer END,
      CASE WHEN p_hours > COALESCE(v_vehicle.current_hours, 0) THEN p_hours END,
      'INSPECCION', 'Inspección ' || v_tpl.name);
    IF NOT COALESCE((v_reading->>'success')::boolean, false) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Lectura no registrada: ' || COALESCE(v_reading->>'error', ''));
    END IF;
  END IF;

  SELECT id INTO v_driver FROM public.drivers WHERE profile_id = auth.uid() LIMIT 1;

  INSERT INTO public.inspections (
    vehicle_plate, driver_id, template_id, date, inspection_type, dispatch_id, odometer, hours,
    signature_url, location_lat, location_lon, notes, source, site_id, created_by, global_result
  ) VALUES (
    v_vehicle.plate, v_driver, v_tpl.id, now(), v_tpl.type, p_dispatch_id, p_odometer, p_hours,
    p_signature_url, NULLIF(p_location->>'lat', '')::numeric, NULLIF(p_location->>'lon', '')::numeric,
    p_notes, upper(COALESCE(p_source, 'WEB')), v_vehicle.site_id, auth.uid(), 'PASSED'
  ) RETURNING id INTO v_insp;

  FOR v_item IN SELECT * FROM public.checklist_items WHERE template_id = v_tpl.id ORDER BY position LOOP
    SELECT a INTO v_answer FROM jsonb_array_elements(p_answers) a
    WHERE a->>'item_id' = v_item.id::text OR (v_item.code IS NOT NULL AND a->>'code' = v_item.code) LIMIT 1;
    INSERT INTO public.inspection_results (inspection_id, item_id, response, observation, photo_url)
    VALUES (v_insp, v_item.id, upper(trim(v_answer->>'response')), NULLIF(v_answer->>'observation', ''), NULLIF(v_answer->>'photo_url', ''));
    IF public.is_failing_response(v_answer->>'response') THEN
      v_failed := v_failed + 1;
      IF v_item.is_critical THEN v_critical := v_critical + 1; END IF;
    END IF;
  END LOOP;

  v_result := CASE WHEN v_critical > 0 THEN 'FAILED' WHEN v_failed > 0 THEN 'WARNING' ELSE 'PASSED' END;
  UPDATE public.inspections SET global_result = v_result, failed_items = v_failed, critical_failures = v_critical
  WHERE id = v_insp;

  RETURN jsonb_build_object('success', true, 'inspection_id', v_insp, 'global_result', v_result,
    'failed_items', v_failed, 'critical_failures', v_critical,
    'requests_created', (SELECT count(*) FROM public.maintenance_requests r
                         JOIN public.inspection_results ir ON ir.id = r.source_ref_id
                         WHERE r.source = 'INSPECCION' AND ir.inspection_id = v_insp),
    'vehicle_status', (SELECT status FROM public.vehicles WHERE id = v_vehicle.id));
END;
$$;

REVOKE ALL ON FUNCTION public.submit_inspection(text, uuid, jsonb, numeric, numeric, text, uuid, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_inspection(text, uuid, jsonb, numeric, numeric, text, uuid, text, jsonb, text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 4. Plantilla del sistema para el checklist pre-ruta de la App
-- ------------------------------------------------------------
INSERT INTO public.checklist_templates (name, type, code, requires_odometer, requires_signature, description)
VALUES ('Checklist pre-ruta (App conductor)', 'PREOPERACIONAL', 'APP_PRE_RUTA', true, false,
        'Plantilla del sistema usada por la App del conductor antes de iniciar ruta')
ON CONFLICT (code) WHERE code IS NOT NULL DO NOTHING;

INSERT INTO public.checklist_items (template_id, code, text, is_critical, response_type, position)
SELECT t.id, x.code, x.text, x.critical, 'OK_MAL', x.pos
FROM public.checklist_templates t,
     (VALUES ('llantas', 'Estado de llantas y presión', true, 1),
             ('aceite', 'Niveles de aceite y agua', false, 2),
             ('luces', 'Luces, direccionales y focos', true, 3),
             ('frenos', 'Sistema de frenos (aire/líquido)', true, 4),
             ('combustible', 'Tanque de combustible lleno', false, 5)) AS x(code, text, critical, pos)
WHERE t.code = 'APP_PRE_RUTA'
ON CONFLICT (template_id, code) WHERE code IS NOT NULL DO NOTHING;

-- El checklist pre-ruta (App nueva y APK instalados) se registra además como inspección canónica
CREATE OR REPLACE FUNCTION public.submit_pre_route_checklist(
  p_dispatch_id uuid, p_vehicle_plate text, p_driver_id uuid, p_odometer numeric,
  p_checklist_data jsonb, p_location jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dispatch  public.dispatches%ROWTYPE;
  v_tpl       uuid;
  v_answers   jsonb;
  v_insp      jsonb;
  v_checklist uuid;
BEGIN
  SELECT * INTO v_dispatch FROM public.dispatches WHERE id = p_dispatch_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Despacho no encontrado');
  END IF;
  IF v_dispatch.driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'Despacho no asignado a este conductor');
  END IF;
  IF auth.uid() IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.drivers WHERE id = p_driver_id AND profile_id = auth.uid())
     AND NOT public.has_tms_permission('despacho') THEN
    RETURN jsonb_build_object('success', false, 'message', 'No puede registrar el checklist de otro conductor');
  END IF;
  IF v_dispatch.status NOT IN ('PROGRAMADO', 'EN_CURSO') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Despacho en estado inválido para checklist pre-ruta');
  END IF;
  IF v_dispatch.vehicle_plate IS DISTINCT FROM upper(trim(p_vehicle_plate)) THEN
    RETURN jsonb_build_object('success', false, 'message', 'La placa enviada no coincide con la asignada al despacho');
  END IF;
  IF p_odometer IS NULL OR p_odometer < 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Lectura de odómetro inválida.');
  END IF;

  -- Inspección canónica (plantilla APP_PRE_RUTA): OK/MAL por código de punto
  SELECT id INTO v_tpl FROM public.checklist_templates WHERE code = 'APP_PRE_RUTA';
  SELECT jsonb_agg(jsonb_build_object('code', i.code,
           'response', COALESCE(NULLIF(upper(p_checklist_data->>i.code), ''), 'OK'),
           'observation', p_checklist_data->>(i.code || '_obs'),
           'photo_url', p_checklist_data->>'photo_url'))
  INTO v_answers
  FROM public.checklist_items i WHERE i.template_id = v_tpl;

  v_insp := public.submit_inspection(p_vehicle_plate, v_tpl, v_answers, p_odometer, NULL, NULL, p_dispatch_id,
                                     p_checklist_data->>'observaciones', p_location, 'APP');
  IF NOT COALESCE((v_insp->>'success')::boolean, false) THEN
    RETURN jsonb_build_object('success', false, 'message', v_insp->>'error');
  END IF;

  -- Registro del despacho (usado por el flujo de ruta), enlazado a la inspección
  -- photo_url es obligatoria para validate_driver_checklist (la versión anterior no la enviaba y todo
  -- checklist de la App era rechazado con "Falta fotografía verificable")
  INSERT INTO public.driver_checklists (dispatch_id, driver_id, vehicle_plate, checklist_data, photo_url, location_lat, location_lon, inspection_id)
  VALUES (p_dispatch_id, p_driver_id, upper(trim(p_vehicle_plate)), p_checklist_data, p_checklist_data->>'photo_url',
          NULLIF(p_location->>'lat', '')::numeric, NULLIF(p_location->>'lon', '')::numeric, (v_insp->>'inspection_id')::uuid)
  RETURNING id INTO v_checklist;

  UPDATE public.dispatches SET start_odometer = p_odometer, departure_time = COALESCE(departure_time, now())
  WHERE id = p_dispatch_id;

  -- Una falla crítica bloquea la unidad (F2/F3): la ruta no se inicia
  IF COALESCE((v_insp->>'critical_failures')::int, 0) > 0 THEN
    RETURN jsonb_build_object('success', true, 'can_start', false,
      'message', 'Checklist registrado con falla crítica: la unidad quedó bloqueada y mantenimiento fue notificado. No inicie la ruta.',
      'inspection_id', v_insp->>'inspection_id', 'global_result', v_insp->>'global_result',
      'critical_failures', v_insp->'critical_failures', 'vehicle_status', v_insp->>'vehicle_status');
  END IF;

  IF v_dispatch.status = 'PROGRAMADO' THEN
    PERFORM public.transition_dispatch_status(p_dispatch_id, 'EN_CURSO', 'Iniciado por checklist pre-ruta', p_driver_id);
  END IF;

  RETURN jsonb_build_object('success', true, 'can_start', true, 'message', 'Checklist procesado',
    'inspection_id', v_insp->>'inspection_id', 'global_result', v_insp->>'global_result',
    'critical_failures', v_insp->'critical_failures', 'vehicle_status', v_insp->>'vehicle_status');
END;
$$;

REVOKE ALL ON FUNCTION public.submit_pre_route_checklist(uuid, text, uuid, numeric, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_pre_route_checklist(uuid, text, uuid, numeric, jsonb, jsonb) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 5. Vista de inspecciones
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_inspections
WITH (security_invoker = true) AS
SELECT i.id, i.date, i.vehicle_plate, v.type AS vehicle_type, i.inspection_type, t.name AS template_name,
       i.global_result, i.failed_items, i.critical_failures, i.odometer, i.hours, i.signature_url,
       i.source, i.dispatch_id, i.notes, i.site_id,
       NULLIF(trim(concat_ws(' ', d.first_name, d.last_name)), '') AS driver_name,
       NULLIF(trim(concat_ws(' ', p.first_name, p.last_name)), '') AS inspector_name,
       (SELECT count(*) FROM public.maintenance_requests r JOIN public.inspection_results ir ON ir.id = r.source_ref_id
        WHERE r.source = 'INSPECCION' AND ir.inspection_id = i.id) AS requests_created
FROM public.inspections i
JOIN public.vehicles v ON v.plate = i.vehicle_plate
LEFT JOIN public.checklist_templates t ON t.id = i.template_id
LEFT JOIN public.drivers d ON d.id = i.driver_id
LEFT JOIN public.profiles p ON p.id = i.created_by;

GRANT SELECT ON public.vw_inspections TO authenticated, service_role;

-- ------------------------------------------------------------
-- 6. RLS
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Admin gestiona items" ON public.checklist_items;
DROP POLICY IF EXISTS "Items visibles para todos" ON public.checklist_items;
DROP POLICY IF EXISTS "Admin gestiona templates" ON public.checklist_templates;
DROP POLICY IF EXISTS "Templates visibles para todos" ON public.checklist_templates;
DROP POLICY IF EXISTS "Admin ve todas inspecciones" ON public.inspections;
DROP POLICY IF EXISTS "Conductores crean inspecciones" ON public.inspections;
DROP POLICY IF EXISTS "Conductores ven sus inspecciones" ON public.inspections;
DROP POLICY IF EXISTS "Admin ve todos resultados" ON public.inspection_results;
DROP POLICY IF EXISTS "Conductores crean resultados" ON public.inspection_results;
DROP POLICY IF EXISTS "Conductores ven sus resultados" ON public.inspection_results;

CREATE POLICY tpl_read ON public.checklist_templates FOR SELECT TO authenticated
  USING (public.has_tms_read_permission('checklist') OR public.has_cmms_read_permission('flota') OR public.has_cmms_read_permission('ot'));
CREATE POLICY tpl_write ON public.checklist_templates FOR ALL TO authenticated
  USING (public.has_cmms_permission('flota') AND code IS DISTINCT FROM 'APP_PRE_RUTA')
  WITH CHECK (public.has_cmms_permission('flota') AND code IS DISTINCT FROM 'APP_PRE_RUTA');
CREATE POLICY item_read ON public.checklist_items FOR SELECT TO authenticated
  USING (public.has_tms_read_permission('checklist') OR public.has_cmms_read_permission('flota') OR public.has_cmms_read_permission('ot'));
CREATE POLICY item_write ON public.checklist_items FOR ALL TO authenticated
  USING (public.has_cmms_permission('flota')) WITH CHECK (public.has_cmms_permission('flota'));

CREATE POLICY insp_read ON public.inspections FOR SELECT TO authenticated USING (
  public.is_tms_admin()
  OR (public.can_access_site(site_id) AND (public.has_cmms_read_permission('flota') OR public.has_cmms_read_permission('fallas')))
  OR driver_id IN (SELECT id FROM public.drivers WHERE profile_id = auth.uid()));
CREATE POLICY insp_result_read ON public.inspection_results FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.inspections i WHERE i.id = inspection_results.inspection_id));

UPDATE public.inspections i SET site_id = v.site_id FROM public.vehicles v WHERE v.plate = i.vehicle_plate AND i.site_id IS NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
