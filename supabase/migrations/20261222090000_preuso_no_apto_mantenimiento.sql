-- Checklist FR-DT 007: todo resultado No apto llega a Mantenimiento y detiene la unidad hasta su revisión.
-- * No apto mecánico (M en ítems no críticos o «Vehículo operativo: No») ⇒ una falla por inspección
--   (ALTA si el conductor la declaró no operativa, MEDIA si no) y la unidad pasa a OBSERVADA. Si ya hay una
--   falla de checklist abierta para la unidad, el nuevo registro se suma a ella en lugar de duplicarla.
-- * M en un ítem crítico: se conservan las fallas CRÍTICAS por ítem (bloquean la unidad); solo se enlazan al registro.
-- * Solo R (regular) ⇒ observación BAJA en la lista de fallas, sin detener la unidad.
-- * La falla abierta (ALTA/MEDIA) es un motivo del motor de elegibilidad: ni Programación ni otro conductor usan la unidad.
-- * Al cerrar o descartar la falla: la unidad vuelve a DISPONIBLE si el motor lo permite y el conductor queda
--   habilitado para reinspeccionar el mismo día sin autorización manual.
-- * Aviso PREUSO_NO_APTO a flota, Torre de Control y despacho; la Torre muestra la falla en el despacho.

ALTER TABLE public.maintenance_requests ADD COLUMN IF NOT EXISTS preuse_operation_id uuid
  REFERENCES public.driver_preuse_inspections(operation_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_maintenance_requests_preuse_open ON public.maintenance_requests (vehicle_plate)
  WHERE preuse_operation_id IS NOT NULL AND status NOT IN ('CERRADA', 'DESCARTADA');

INSERT INTO public.notif_reglas (evento, categoria, descripcion, severidad, permisos, al_solicitante)
VALUES ('PREUSO_NO_APTO', 'MANTENIMIENTO', 'Checklist pre-uso (FR-DT 007) No apto', 'crit',
        ARRAY['mantenimiento-flota', 'flota', 'torre-control', 'despacho'], false)
ON CONFLICT (evento) DO NOTHING;

-- Cambio de estado hecho por el sistema (el conductor no gestiona estados de la flota); deja el mismo historial.
CREATE OR REPLACE FUNCTION public.preuse_set_vehicle_status(p_plate text, p_from text[], p_to text, p_reason text, p_actor uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE cur text;
BEGIN
  SELECT status INTO cur FROM public.vehicles WHERE plate = p_plate FOR UPDATE;
  IF cur IS NULL OR NOT cur = ANY (p_from) THEN RETURN false; END IF;
  UPDATE public.vehicles SET status = p_to WHERE plate = p_plate;
  INSERT INTO public.vehicle_history_logs (vehicle_plate, changed_by, field_changed, old_value, new_value, change_reason)
  VALUES (p_plate, p_actor, 'status', cur, p_to, left(p_reason, 500));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.preuse_set_vehicle_status(text, text[], text, text, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.preuse_to_maintenance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  bad text; regular text; head text; detail text; sev text; open_id uuid; linked int;
  mech boolean := false;
  docs boolean := NEW.soat_expiration < NEW.operation_date OR NEW.technical_review_expiration < NEW.operation_date;
BEGIN
  SELECT string_agg((f->>'text') || COALESCE(' (' || NULLIF(btrim(a->>'comment'), '') || ')', ''), '; ' ORDER BY f->>'code') FILTER (WHERE a->>'response' = 'M'),
         string_agg((f->>'text') || COALESCE(' (' || NULLIF(btrim(a->>'comment'), '') || ')', ''), '; ' ORDER BY f->>'code') FILTER (WHERE a->>'response' = 'R')
    INTO bad, regular
  FROM jsonb_array_elements(public.driver_preuse_format()->'items') f
  JOIN jsonb_array_elements(NEW.answers) a ON a->>'code' = f->>'code';
  mech := bad IS NOT NULL OR NOT NEW.vehicle_operational;
  head := 'Checklist FR-DT 007 ' || COALESCE(NEW.record_sequence::text || ' ', '') || '· ' || NEW.driver_name || ' · '
          || to_char(NEW.captured_at AT TIME ZONE 'America/Lima', 'DD/MM/YYYY HH24:MI');
  detail := concat_ws(' · ', CASE WHEN NOT NEW.vehicle_operational THEN 'Vehículo declarado no operativo' END,
                      CASE WHEN bad IS NOT NULL THEN 'Malo: ' || bad END, 'Obs.: ' || NULLIF(btrim(NEW.observation), ''));

  -- Las fallas CRÍTICAS por ítem ya las creó la inspección (y bloquean la unidad): solo se enlazan
  UPDATE public.maintenance_requests SET preuse_operation_id = NEW.operation_id
  WHERE source = 'INSPECCION' AND source_ref_id IN (SELECT id FROM public.inspection_results WHERE inspection_id = NEW.inspection_id);
  GET DIAGNOSTICS linked = ROW_COUNT;

  IF mech AND linked = 0 THEN
    sev := CASE WHEN NOT NEW.vehicle_operational THEN 'ALTA' ELSE 'MEDIA' END;
    SELECT id INTO open_id FROM public.maintenance_requests
    WHERE vehicle_plate = NEW.vehicle_plate AND preuse_operation_id IS NOT NULL AND severity IN ('ALTA', 'MEDIA')
      AND status NOT IN ('CERRADA', 'DESCARTADA') ORDER BY reported_at DESC LIMIT 1 FOR UPDATE;
    IF open_id IS NOT NULL THEN
      UPDATE public.maintenance_requests SET notes = left(concat_ws(' | ', notes, 'Nuevo No apto: ' || head || ' · ' || detail), 2000),
        severity = CASE WHEN sev = 'ALTA' THEN 'ALTA' ELSE severity END
      WHERE id = open_id;
    ELSE
      INSERT INTO public.maintenance_requests (vehicle_plate, driver_id, description, severity, status, source, source_ref_id,
        preuse_operation_id, notes, reported_at, reported_by, site_id)
      VALUES (NEW.vehicle_plate, NEW.driver_id, left('No apto en checklist pre-uso: ' || detail, 1000), sev, 'REPORTADA', 'INSPECCION',
        NEW.operation_id, NEW.operation_id, head, NEW.captured_at, NEW.submitted_by, NEW.site_id)
      ON CONFLICT DO NOTHING;
    END IF;
    PERFORM public.preuse_set_vehicle_status(NEW.vehicle_plate, ARRAY['DISPONIBLE', 'ASIGNADA'], 'OBSERVADA', 'No apto en ' || head, NEW.submitted_by);
  ELSIF NOT mech AND regular IS NOT NULL THEN
    SELECT id INTO open_id FROM public.maintenance_requests
    WHERE vehicle_plate = NEW.vehicle_plate AND preuse_operation_id IS NOT NULL AND severity = 'BAJA'
      AND status NOT IN ('CERRADA', 'DESCARTADA') ORDER BY reported_at DESC LIMIT 1 FOR UPDATE;
    IF open_id IS NOT NULL THEN
      UPDATE public.maintenance_requests SET notes = left(concat_ws(' | ', notes, head || ' · Regular: ' || regular), 2000) WHERE id = open_id;
    ELSE
      INSERT INTO public.maintenance_requests (vehicle_plate, driver_id, description, severity, status, source, source_ref_id,
        preuse_operation_id, notes, reported_at, reported_by, site_id)
      VALUES (NEW.vehicle_plate, NEW.driver_id, left('Observaciones del checklist pre-uso (Regular): ' || regular, 1000), 'BAJA', 'REPORTADA', 'INSPECCION',
        NEW.operation_id, NEW.operation_id, head, NEW.captured_at, NEW.submitted_by, NEW.site_id)
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  IF NOT NEW.can_operate THEN
    PERFORM public.notif_emit('PREUSO_NO_APTO', 'preuso-' || NEW.operation_id, 'No apto en checklist: ' || NEW.vehicle_plate,
      NEW.driver_name || ' · ' || COALESCE(NULLIF(concat_ws(' · ', detail, CASE WHEN docs THEN 'SOAT o revisión técnica vencidos' END), ''), 'Revise el registro'),
      '/mantenimiento/checklists');
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- El registro del conductor nunca se pierde por un aviso o una falla derivada
  RAISE WARNING 'preuse_to_maintenance %: %', NEW.operation_id, SQLERRM;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.preuse_to_maintenance() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS preuse_to_maintenance ON public.driver_preuse_inspections;
CREATE TRIGGER preuse_to_maintenance AFTER INSERT ON public.driver_preuse_inspections
  FOR EACH ROW EXECUTE FUNCTION public.preuse_to_maintenance();

CREATE OR REPLACE FUNCTION public.preuse_request_closed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE i public.driver_preuse_inspections; latest public.driver_preuse_inspections; today date := (now() AT TIME ZONE 'America/Lima')::date;
BEGIN
  IF NEW.preuse_operation_id IS NULL OR NEW.severity = 'BAJA' OR NEW.status NOT IN ('CERRADA', 'DESCARTADA')
     OR OLD.status IN ('CERRADA', 'DESCARTADA') THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.maintenance_requests WHERE vehicle_plate = NEW.vehicle_plate AND id <> NEW.id
       AND preuse_operation_id IS NOT NULL AND severity <> 'BAJA' AND status NOT IN ('CERRADA', 'DESCARTADA'))
     AND public.check_asset_eligibility(NEW.vehicle_plate, 'RELEASE')->>'status' <> 'NO_APTO' THEN
    PERFORM public.preuse_set_vehicle_status(NEW.vehicle_plate, ARRAY['OBSERVADA'], 'DISPONIBLE',
      'Falla del checklist pre-uso ' || lower(NEW.status) || ' por mantenimiento', auth.uid());
  END IF;
  -- Reinspección del día habilitada sin autorización manual (queda registrado quién cerró la falla)
  SELECT * INTO i FROM public.driver_preuse_inspections WHERE operation_id = NEW.preuse_operation_id;
  SELECT * INTO latest FROM public.driver_preuse_inspections WHERE driver_id = i.driver_id AND operation_date = today
    AND public.preuse_plate_key(vehicle_plate) = public.preuse_plate_key(i.vehicle_plate)
  ORDER BY captured_at DESC, record_sequence DESC LIMIT 1;
  IF latest.operation_id IS NOT NULL AND NOT latest.can_operate AND auth.uid() IS NOT NULL THEN
    INSERT INTO public.driver_preuse_repeat_authorizations (driver_id, vehicle_key, operation_date, previous_operation, reason, authorized_by)
    VALUES (latest.driver_id, public.preuse_plate_key(latest.vehicle_plate), today, latest.operation_id,
            'Mantenimiento ' || lower(NEW.status) || ' la falla del checklist: reinspección habilitada', auth.uid())
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'preuse_request_closed %: %', NEW.id, SQLERRM;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.preuse_request_closed() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS preuse_request_closed ON public.maintenance_requests;
CREATE TRIGGER preuse_request_closed AFTER UPDATE OF status ON public.maintenance_requests
  FOR EACH ROW EXECUTE FUNCTION public.preuse_request_closed();

-- Motor de elegibilidad y Torre de Control
DO $patch$
DECLARE def text; changed text;
BEGIN
  def := pg_get_functiondef('public.check_asset_eligibility(text,text)'::regprocedure);
  changed := regexp_replace(def, '(falla\(s\) crítica\(s\) sin resolver''\);\s*END IF;)',
    '\1' || chr(10) || '  -- Checklist pre-uso No apto: la unidad espera la revisión de mantenimiento' || chr(10)
    || '  IF EXISTS (SELECT 1 FROM public.maintenance_requests WHERE vehicle_plate = p_plate AND preuse_operation_id IS NOT NULL' || chr(10)
    || '      AND severity IN (''ALTA'', ''MEDIA'') AND status NOT IN (''CERRADA'', ''DESCARTADA'', ''CONVERTIDA_OT'')) THEN' || chr(10)
    || '    v_motives := v_motives || jsonb_build_array(''Checklist pre-uso No apto: falla pendiente de revisión de mantenimiento'');' || chr(10)
    || '  END IF;');
  IF changed = def THEN RAISE EXCEPTION 'check_asset_eligibility: no se encontró el bloque de fallas críticas'; END IF;
  EXECUTE changed;

  def := pg_get_functiondef('public.get_tower_dispatches(date,uuid,text)'::regprocedure);
  changed := replace(def, 'AND (mr.status IN (''PENDIENTE'', ''OBSERVADO'') OR mr.severity IN (''ALTA'', ''CRITICA''))',
    'AND mr.status NOT IN (''CERRADA'', ''DESCARTADA'') AND (mr.severity IN (''ALTA'', ''CRITICA'') OR (mr.preuse_operation_id IS NOT NULL AND mr.severity <> ''BAJA''))');
  IF changed = def THEN RAISE EXCEPTION 'get_tower_dispatches: no se encontró el filtro de alertas de mantenimiento'; END IF;
  EXECUTE changed;
END $patch$;

NOTIFY pgrst, 'reload schema';
