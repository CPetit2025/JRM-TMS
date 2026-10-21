BEGIN;

CREATE OR REPLACE FUNCTION public.hhee_flow_row(r public.hhee_requests, p_costs boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('id', r.id, 'sequence', r.sequence, 'version', r.version, 'work_date', r.work_date, 'area_id', r.area_id,
    'area', (SELECT name FROM public.hhee_areas WHERE id = r.area_id), 'cause_id', r.cause_id, 'cause', (SELECT name FROM public.hhee_causes WHERE id = r.cause_id),
    'activity', r.activity, 'state', r.state, 'approval', r.approval, 'created_by', r.created_by, 'requester', public.hhee_flow_name(r.created_by),
    'approver', public.hhee_flow_name(r.approved_by), 'approved_at', r.approved_at, 'submitted_at', r.submitted_at, 'created_at', r.created_at,
    'approval_reason', r.approval_reason, 'reference_type', r.reference_type, 'reference_code', r.reference_code,
    'people', COALESCE((SELECT jsonb_agg(l.person_name ORDER BY l.person_code, l.person_name) FROM public.hhee_lines l WHERE l.request_id = r.id), '[]'::jsonb),
    'plates', COALESCE((SELECT jsonb_agg(DISTINCT l.vehicle_plate ORDER BY l.vehicle_plate) FROM public.hhee_lines l WHERE l.request_id = r.id AND NULLIF(l.vehicle_plate, '') IS NOT NULL), '[]'::jsonb),
    'auto_dispatch_id', r.auto_dispatch_id,
    'auto_dispatch_number', (SELECT COALESCE(to_jsonb(x)->>'dispatch_number', to_jsonb(x)->>'legacy_dispatch_number') FROM public.dispatches x WHERE x.id = r.auto_dispatch_id),
    'revisions', (SELECT count(*) FROM public.hhee_authorizations WHERE request_id = r.id),
    'can_edit', public.hhee_can(r.area_id, 'request') AND (r.created_by = auth.uid() OR public.is_tms_admin())
      AND ((r.state = 'BORRADOR') OR (r.state = 'SOLICITADA' AND r.approval = 'APROBADA')),
    'can_decide', public.hhee_can(r.area_id, 'approve') AND r.state = 'SOLICITADA' AND r.approval = 'PENDIENTE'
      AND (r.created_by <> auth.uid() OR public.is_tms_admin()))
  || (SELECT t - CASE WHEN p_costs THEN ARRAY[]::text[] ELSE ARRAY['cost'] END FROM public.hhee_flow_totals(r.id) t);
$$;

CREATE OR REPLACE FUNCTION public.hhee_flow_preview(p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_date date; v_id uuid := NULLIF(p->>'id', '')::uuid; l jsonb; v_person public.hhee_people; v_start timestamptz; v_end timestamptz;
  v_min int; v_split jsonb; v_duplicate boolean; out jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso'); END IF;
  BEGIN v_date := (p->>'work_date')::date; EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('success', false, 'error', 'Fecha inválida'); END;
  IF v_date IS NULL OR jsonb_typeof(p->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'lines') > 50 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Datos incompletos'); END IF;
  FOR l IN SELECT value FROM jsonb_array_elements(p->'lines') LOOP
    v_person := NULL; v_start := NULL; v_end := NULL;
    SELECT * INTO v_person FROM public.hhee_people WHERE id = NULLIF(l->>'person_id', '')::uuid;
    BEGIN
      v_start := (l->>'start')::timestamp AT TIME ZONE 'America/Lima'; v_end := (l->>'end')::timestamp AT TIME ZONE 'America/Lima';
      v_min := (extract(epoch FROM v_end - v_start) / 60)::int - COALESCE(NULLIF(l->>'break_minutes', '')::int, 0);
    EXCEPTION WHEN OTHERS THEN v_min := NULL; END;
    IF v_person.id IS NULL OR NOT (public.hhee_can(v_person.area_id, 'request') OR public.hhee_can(v_person.area_id, 'approve')) THEN
      out := out || jsonb_build_object('person_id', l->>'person_id', 'error', 'Elija el trabajador');
    ELSIF v_min IS NULL OR v_end <= v_start OR v_end - v_start > interval '16 hours' THEN
      out := out || jsonb_build_object('person_id', v_person.id, 'error', 'Horario inválido (máximo 16 h)');
    ELSIF v_min < 1 THEN
      out := out || jsonb_build_object('person_id', v_person.id, 'error', 'El descanso supera el horario');
    ELSE
      SELECT EXISTS (SELECT 1 FROM public.hhee_lines x JOIN public.hhee_requests q ON q.id = x.request_id
        WHERE x.person_id = v_person.id AND q.work_date = v_date AND q.id IS DISTINCT FROM v_id
          AND q.state <> 'CANCELADA' AND q.approval <> 'RECHAZADA') INTO v_duplicate;
      v_split := public.hhee_flow_split(v_person.id, v_date, v_min, COALESCE((l->>'rest_day')::boolean, false), v_id);
      out := out || (jsonb_build_object('person_id', v_person.id, 'minutes', v_min, 'driver', v_person.driver_id IS NOT NULL, 'duplicate', v_duplicate,
        'routes', CASE WHEN v_person.driver_id IS NOT NULL THEN public.hhee_driver_routes(v_person.driver_id, v_date) END) || v_split);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'holiday', public.hhee_pe_holiday(v_date), 'isodow', extract(isodow FROM v_date)::int, 'lines', out);
END $$;

CREATE OR REPLACE FUNCTION public.hhee_prevent_duplicate_person_day() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_date date; v_key bigint;
BEGIN
  SELECT work_date INTO v_date FROM public.hhee_requests WHERE id = NEW.request_id;
  v_key := hashtextextended('hhee-person-day:' || NEW.person_id::text || ':' || v_date::text, 0);
  IF NOT pg_try_advisory_xact_lock(v_key) THEN RAISE EXCEPTION 'Hay una solicitud de HHEE en curso para este trabajador y fecha; vuelva a intentar.'; END IF;
  IF EXISTS (SELECT 1 FROM public.hhee_lines l JOIN public.hhee_requests r ON r.id = l.request_id
    WHERE l.person_id = NEW.person_id AND r.work_date = v_date AND r.id <> NEW.request_id
      AND r.state <> 'CANCELADA' AND r.approval <> 'RECHAZADA') THEN
    RAISE EXCEPTION 'Este trabajador ya tiene una solicitud de HHEE para esta fecha.';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hhee_lines_prevent_duplicate_person_day ON public.hhee_lines;
CREATE TRIGGER hhee_lines_prevent_duplicate_person_day BEFORE INSERT OR UPDATE OF request_id, person_id ON public.hhee_lines
FOR EACH ROW EXECUTE FUNCTION public.hhee_prevent_duplicate_person_day();
REVOKE ALL ON FUNCTION public.hhee_prevent_duplicate_person_day() FROM PUBLIC, anon, authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
