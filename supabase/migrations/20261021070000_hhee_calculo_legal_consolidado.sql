-- ============================================================
-- HHEE: cálculo automático según la legislación peruana, informe con datos del trabajador e informe consolidado
-- ============================================================
-- Base legal: TUO de la Ley de Jornada de Trabajo (D.S. 007-2002-TR) art. 10 y su reglamento (D.S. 008-2002-TR):
--   sobretiempo con recargo mínimo del 25 % por hora en las dos primeras horas del día y del 35 % en las restantes.
--   D. Leg. 713: el trabajo en el día de descanso semanal o en feriado sin descanso sustitutorio se paga con 100 %.
-- • Horas extras = horario − descanso. El reparto ya no lo escribe el usuario: hhee_flow_split lo calcula por
--   trabajador y por día, contando las horas que ya tiene ese día en solicitudes registradas antes (no anuladas ni
--   rechazadas). En feriado nacional (hhee_pe_holiday) o día de descanso del trabajador, todo va al 100 %.
-- • Al aprobar se recalcula el reparto (otra solicitud del día pudo anularse) y luego el costo.
-- • hhee_flow_preview: el formulario muestra el cálculo del servidor antes de guardar.
-- • hhee_flow_consolidated: versión vigente de varias autorizaciones para un único informe consolidado.
BEGIN;
SET LOCAL lock_timeout = '60s';

ALTER TABLE public.hhee_lines ADD COLUMN IF NOT EXISTS rest_day boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS hhee_lines_person_idx ON public.hhee_lines (person_id);

-- Feriados nacionales del Perú (Ley 31788 / D. Leg. 713 y modificatorias), con Jueves y Viernes Santo según la Pascua
CREATE OR REPLACE FUNCTION public.hhee_pe_holiday(p_date date) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE y int := extract(year FROM p_date); a int; b int; c int; d int; e int; f int; g int; h int; i int; k int; l int; m int; v_easter date;
BEGIN
  IF p_date IS NULL THEN RETURN NULL; END IF;
  a := y % 19; b := y / 100; c := y % 100; d := b / 4; e := b % 4; f := (b + 8) / 25; g := (b - f + 1) / 3;
  h := (19 * a + b - d - g + 15) % 30; i := c / 4; k := c % 4; l := (32 + 2 * e + 2 * i - h - k) % 7; m := (a + 11 * h + 22 * l) / 451;
  v_easter := make_date(y, (h + l - 7 * m + 114) / 31, ((h + l - 7 * m + 114) % 31) + 1);
  IF p_date = v_easter - 3 THEN RETURN 'Jueves Santo'; END IF;
  IF p_date = v_easter - 2 THEN RETURN 'Viernes Santo'; END IF;
  RETURN CASE to_char(p_date, 'MM-DD')
    WHEN '01-01' THEN 'Año Nuevo' WHEN '05-01' THEN 'Día del Trabajo' WHEN '06-07' THEN 'Batalla de Arica y Día de la Bandera'
    WHEN '06-29' THEN 'San Pedro y San Pablo' WHEN '07-23' THEN 'Día de la Fuerza Aérea del Perú' WHEN '07-28' THEN 'Fiestas Patrias'
    WHEN '07-29' THEN 'Fiestas Patrias' WHEN '08-06' THEN 'Batalla de Junín' WHEN '08-30' THEN 'Santa Rosa de Lima'
    WHEN '10-08' THEN 'Combate de Angamos' WHEN '11-01' THEN 'Todos los Santos' WHEN '12-08' THEN 'Inmaculada Concepción'
    WHEN '12-09' THEN 'Batalla de Ayacucho' WHEN '12-25' THEN 'Navidad' END;
END $$;

-- Reparto legal de las horas extras de un trabajador en un día. Cuenta lo que ya tiene ese día en solicitudes
-- registradas antes que p_request (o todas, si es nueva), no anuladas ni rechazadas.
CREATE OR REPLACE FUNCTION public.hhee_flow_split(p_person uuid, p_date date, p_minutes integer, p_rest boolean, p_request uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_seq bigint; v_prior int; v_holiday text := public.hhee_pe_holiday(p_date); v_25 int;
BEGIN
  IF COALESCE(p_minutes, 0) <= 0 THEN RETURN jsonb_build_object('m25', 0, 'm35', 0, 'm100', 0, 'prior', 0, 'holiday', v_holiday); END IF;
  IF p_rest OR v_holiday IS NOT NULL THEN
    RETURN jsonb_build_object('m25', 0, 'm35', 0, 'm100', p_minutes, 'prior', 0, 'holiday', v_holiday);
  END IF;
  SELECT sequence INTO v_seq FROM public.hhee_requests WHERE id = p_request;
  SELECT COALESCE(sum(CASE WHEN l.plan_minutes_25 IS NULL AND l.plan_minutes_35 IS NULL AND l.plan_minutes_100 IS NULL THEN COALESCE(l.planned_minutes, 0)
      ELSE COALESCE(l.plan_minutes_25, 0) + COALESCE(l.plan_minutes_35, 0) END), 0)::int INTO v_prior
  FROM public.hhee_lines l JOIN public.hhee_requests r ON r.id = l.request_id
  WHERE l.person_id = p_person AND r.work_date = p_date AND r.id IS DISTINCT FROM p_request
    AND r.state <> 'CANCELADA' AND r.approval <> 'RECHAZADA' AND NOT l.rest_day
    AND (v_seq IS NULL OR r.sequence < v_seq);
  v_25 := LEAST(p_minutes, GREATEST(0, 120 - v_prior));
  RETURN jsonb_build_object('m25', v_25, 'm35', p_minutes - v_25, 'm100', 0, 'prior', v_prior, 'holiday', v_holiday);
END $$;

CREATE OR REPLACE FUNCTION public.hhee_flow_resplit(p_request uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l record; v_split jsonb; v_date date;
BEGIN
  SELECT work_date INTO v_date FROM public.hhee_requests WHERE id = p_request;
  FOR l IN SELECT id, person_id, planned_minutes, rest_day FROM public.hhee_lines WHERE request_id = p_request AND plan_minutes_25 IS NOT NULL LOOP
    v_split := public.hhee_flow_split(l.person_id, v_date, l.planned_minutes, l.rest_day, p_request);
    UPDATE public.hhee_lines SET plan_minutes_25 = (v_split->>'m25')::int, plan_minutes_35 = (v_split->>'m35')::int, plan_minutes_100 = (v_split->>'m100')::int
    WHERE id = l.id;
  END LOOP;
END $$;

-- Guardar solicitud: el servidor calcula las horas por recargo
CREATE OR REPLACE FUNCTION public.hhee_flow_request_save(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid := NULLIF(p->>'id', '')::uuid; r public.hhee_requests; v_area uuid := NULLIF(p->>'area_id', '')::uuid;
  v_cause uuid := NULLIF(p->>'cause_id', '')::uuid; v_date date; l jsonb; v_person public.hhee_people; v_start timestamptz; v_end timestamptz;
  v_break int; m25 int; m35 int; m100 int; v_total int; v_rest boolean; v_split jsonb; v_rate numeric; v_seen uuid[] := '{}'; v_ref text := COALESCE(NULLIF(p->>'reference_type', ''), 'SIN_REFERENCIA');
  v_was_approved boolean := false;
BEGIN
  BEGIN v_date := (p->>'work_date')::date; EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('success', false, 'error', 'Fecha inválida'); END;
  IF v_area IS NULL OR NOT public.hhee_can(v_area, 'request') THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para solicitar HHEE en esta área'); END IF;
  IF v_cause IS NULL OR NOT EXISTS (SELECT 1 FROM public.hhee_causes WHERE id = v_cause AND active) THEN RETURN jsonb_build_object('success', false, 'error', 'Elija la causa'); END IF;
  IF v_date IS NULL OR v_date < current_date - 31 OR v_date > current_date + 60 THEN RETURN jsonb_build_object('success', false, 'error', 'La fecha debe estar entre 31 días atrás y 60 días adelante'); END IF;
  IF length(btrim(COALESCE(p->>'activity', ''))) NOT BETWEEN 5 AND 300 THEN RETURN jsonb_build_object('success', false, 'error', 'Describa la actividad (5 a 300 caracteres)'); END IF;
  IF length(btrim(COALESCE(p->>'justification', ''))) NOT BETWEEN 10 AND 3000 THEN RETURN jsonb_build_object('success', false, 'error', 'Explique por qué se necesitan las horas extras (mínimo 10 caracteres)'); END IF;
  IF length(btrim(COALESCE(p->>'alternatives', ''))) NOT BETWEEN 5 AND 2000 THEN RETURN jsonb_build_object('success', false, 'error', 'Indique la alternativa evaluada (mínimo 5 caracteres)'); END IF;
  IF length(btrim(COALESCE(p->>'expected_result', ''))) NOT BETWEEN 5 AND 1000 THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el resultado esperado (mínimo 5 caracteres)'); END IF;
  IF v_ref NOT IN ('SIN_REFERENCIA', 'OT', 'OC', 'OS', 'RQ', 'MANTENIMIENTO') THEN RETURN jsonb_build_object('success', false, 'error', 'Referencia inválida'); END IF;
  IF jsonb_typeof(p->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'lines') NOT BETWEEN 1 AND 50 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Agregue al menos un trabajador (máximo 50)'); END IF;

  IF v_id IS NOT NULL THEN
    SELECT * INTO r FROM public.hhee_requests WHERE id = v_id FOR UPDATE;
    IF r.id IS NULL OR NOT public.hhee_can(r.area_id, 'request') THEN RETURN jsonb_build_object('success', false, 'error', 'Solicitud no encontrada'); END IF;
    IF r.created_by <> auth.uid() AND NOT public.is_tms_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'Solo quien registró la solicitud puede corregirla'); END IF;
    IF r.state NOT IN ('BORRADOR', 'SOLICITADA') OR r.approval = 'RECHAZADA' OR (r.state = 'SOLICITADA' AND r.approval = 'PENDIENTE') THEN
      RETURN jsonb_build_object('success', false, 'error', 'La solicitud no se puede modificar en su estado actual'); END IF;
    IF (p->>'expected_version')::int IS DISTINCT FROM r.version THEN RETURN jsonb_build_object('success', false, 'error', 'La solicitud cambió; recargue antes de guardar'); END IF;
    v_was_approved := r.approval = 'APROBADA';
    UPDATE public.hhee_requests SET area_id = v_area, cause_id = v_cause, work_date = v_date, activity = btrim(p->>'activity'),
      justification = btrim(p->>'justification'), alternatives = btrim(p->>'alternatives'), expected_result = btrim(p->>'expected_result'),
      reference_type = v_ref, reference_code = NULLIF(btrim(COALESCE(p->>'reference_code', '')), ''), state = 'BORRADOR', approval = 'PENDIENTE',
      version = version + 1, updated_at = now()
    WHERE id = v_id RETURNING * INTO r;
    DELETE FROM public.hhee_lines WHERE request_id = v_id;
  ELSE
    INSERT INTO public.hhee_requests (area_id, cause_id, work_date, activity, justification, alternatives, expected_result, reference_type, reference_code, created_by)
    VALUES (v_area, v_cause, v_date, btrim(p->>'activity'), btrim(p->>'justification'), btrim(p->>'alternatives'), btrim(p->>'expected_result'),
      v_ref, NULLIF(btrim(COALESCE(p->>'reference_code', '')), ''), auth.uid()) RETURNING * INTO r;
  END IF;

  FOR l IN SELECT value FROM jsonb_array_elements(p->'lines') LOOP
    SELECT * INTO v_person FROM public.hhee_people WHERE id = NULLIF(l->>'person_id', '')::uuid;
    IF v_person.id IS NULL OR NOT v_person.active OR v_person.area_id <> v_area THEN RAISE EXCEPTION 'Trabajador no válido para el área de la solicitud'; END IF;
    IF v_person.id = ANY (v_seen) THEN RAISE EXCEPTION 'El trabajador % está repetido', v_person.name; END IF;
    v_seen := v_seen || v_person.id;
    BEGIN
      v_start := (l->>'start')::timestamp AT TIME ZONE 'America/Lima'; v_end := (l->>'end')::timestamp AT TIME ZONE 'America/Lima';
      v_break := COALESCE(NULLIF(l->>'break_minutes', '')::int, 0);
      v_rest := COALESCE((l->>'rest_day')::boolean, false);
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Revise el horario y las horas de %', v_person.name; END;
    IF v_start IS NULL OR v_end IS NULL OR v_end <= v_start OR v_end - v_start > interval '16 hours' THEN RAISE EXCEPTION 'Horario inválido para % (inicio antes del fin, máximo 16 h)', v_person.name; END IF;
    IF v_break < 0 THEN RAISE EXCEPTION 'Descanso inválido para %', v_person.name; END IF;
    -- Horas extras = horario − descanso; el reparto 25 / 35 / 100 % lo hace la ley (hhee_flow_split), no el usuario
    v_total := (extract(epoch FROM v_end - v_start) / 60)::int - v_break;
    IF v_total < 1 THEN RAISE EXCEPTION 'El descanso de % supera su horario', v_person.name; END IF;
    v_split := public.hhee_flow_split(v_person.id, v_date, v_total, v_rest, r.id);
    m25 := (v_split->>'m25')::int; m35 := (v_split->>'m35')::int; m100 := (v_split->>'m100')::int;
    v_rate := public.hhee_flow_rate(v_person.id);
    INSERT INTO public.hhee_lines (request_id, person_id, person_name, person_code, planned_start, planned_end, planned_break, planned_minutes,
      plan_minutes_25, plan_minutes_35, plan_minutes_100, plan_rate, plan_cost, estimated_cost, rest_day)
    VALUES (r.id, v_person.id, v_person.name, v_person.code, v_start, v_end, v_break, v_total, m25, m35, m100, v_rate,
      public.hhee_flow_cost(v_rate, m25, m35, m100), public.hhee_flow_cost(v_rate, m25, m35, m100), v_rest);
  END LOOP;

  INSERT INTO public.hhee_audit (request_id, actor, event, reason)
  VALUES (r.id, auth.uid(), CASE WHEN v_id IS NULL THEN 'SOLICITUD_REGISTRADA' WHEN v_was_approved THEN 'MODIFICADA_TRAS_APROBACION' ELSE 'SOLICITUD_CORREGIDA' END, NULL);
  RETURN jsonb_build_object('success', true, 'id', r.id, 'version', r.version, 'totals', public.hhee_flow_totals(r.id), 'reapproval', v_was_approved);
END $$;

-- Decisión: al aprobar se vuelve a repartir según ley y se recalcula el costo
CREATE OR REPLACE FUNCTION public.hhee_flow_decide(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.hhee_requests; v_id uuid := NULLIF(p->>'id', '')::uuid; v_decision text := upper(COALESCE(p->>'decision', ''));
  v_reason text := btrim(COALESCE(p->>'reason', '')); v_cost numeric; v_rev int; v_auth uuid;
BEGIN
  SELECT * INTO r FROM public.hhee_requests WHERE id = v_id FOR UPDATE;
  IF r.id IS NULL OR NOT public.hhee_can(r.area_id, 'approve') THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para aprobar en esta área'); END IF;
  IF v_decision NOT IN ('APROBADA', 'OBSERVADA', 'RECHAZADA') THEN RETURN jsonb_build_object('success', false, 'error', 'Decisión inválida'); END IF;
  IF r.state <> 'SOLICITADA' OR r.approval <> 'PENDIENTE' THEN RETURN jsonb_build_object('success', false, 'error', 'La solicitud no está pendiente de aprobación'); END IF;
  IF r.version IS DISTINCT FROM (p->>'expected_version')::int THEN RETURN jsonb_build_object('success', false, 'error', 'La solicitud cambió; recargue antes de decidir'); END IF;
  IF r.created_by = auth.uid() AND NOT public.is_tms_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'No puede aprobar su propia solicitud'); END IF;
  IF length(v_reason) < 5 THEN RETURN jsonb_build_object('success', false, 'error', 'Escriba el sustento de la decisión (mínimo 5 caracteres)'); END IF;
  IF v_decision = 'APROBADA' THEN
    -- Si la remuneración cambió mientras se revisaba, se actualiza la estimación y se pide confirmar el nuevo monto
    PERFORM public.hhee_flow_resplit(v_id);
    UPDATE public.hhee_lines l SET plan_rate = public.hhee_flow_rate(l.person_id),
      plan_cost = public.hhee_flow_cost(public.hhee_flow_rate(l.person_id), l.plan_minutes_25, l.plan_minutes_35, l.plan_minutes_100)
    WHERE l.request_id = v_id AND l.plan_minutes_25 IS NOT NULL;
    v_cost := (public.hhee_flow_totals(v_id)->>'cost')::numeric;
    IF p ? 'expected_cost' AND round(COALESCE(NULLIF(p->>'expected_cost', '')::numeric, 0), 2) <> v_cost THEN
      RETURN jsonb_build_object('success', false, 'stale_cost', true, 'cost', v_cost,
        'error', format('La remuneración de algún trabajador cambió: el costo aproximado ahora es S/ %s. Revise y vuelva a aprobar.', to_char(v_cost, 'FM999G999G990D00')));
    END IF;
    UPDATE public.hhee_lines SET approved_minutes = planned_minutes, estimated_cost = plan_cost WHERE request_id = v_id;
    UPDATE public.hhee_requests SET approval = 'APROBADA', approved_by = auth.uid(), approved_at = now(), approval_reason = v_reason,
      version = version + 1, updated_at = now() WHERE id = v_id RETURNING * INTO r;
    SELECT COALESCE(max(revision), 0) + 1 INTO v_rev FROM public.hhee_authorizations WHERE request_id = v_id;
    INSERT INTO public.hhee_authorizations (request_id, revision, approved_by, approved_at, snapshot)
    VALUES (v_id, v_rev, auth.uid(), r.approved_at, public.hhee_flow_snapshot(v_id) || jsonb_build_object('revision', v_rev)) RETURNING id INTO v_auth;
  ELSIF v_decision = 'OBSERVADA' THEN
    UPDATE public.hhee_requests SET state = 'BORRADOR', approval = 'OBSERVADA', approval_reason = v_reason, version = version + 1, updated_at = now()
    WHERE id = v_id RETURNING * INTO r;
  ELSE
    UPDATE public.hhee_requests SET approval = 'RECHAZADA', approved_by = auth.uid(), approved_at = now(), approval_reason = v_reason,
      version = version + 1, updated_at = now() WHERE id = v_id RETURNING * INTO r;
  END IF;
  INSERT INTO public.hhee_audit (request_id, actor, event, reason) VALUES (v_id, auth.uid(), v_decision, v_reason);
  RETURN jsonb_build_object('success', true, 'id', v_id, 'version', r.version, 'authorization_id', v_auth, 'revision', v_rev);
END $$;

CREATE OR REPLACE FUNCTION public.hhee_flow_snapshot(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'request', jsonb_build_object('id', r.id, 'sequence', r.sequence, 'work_date', r.work_date, 'activity', r.activity,
      'justification', r.justification, 'alternatives', r.alternatives, 'expected_result', r.expected_result,
      'reference_type', r.reference_type, 'reference_code', r.reference_code, 'created_at', r.created_at, 'submitted_at', r.submitted_at,
      'approved_at', r.approved_at, 'approval_reason', r.approval_reason),
    'area', a.name, 'site', (SELECT name FROM public.sites WHERE id = a.site_id), 'cause', c.name,
    'requester', public.hhee_flow_name(r.created_by), 'approver', public.hhee_flow_name(r.approved_by),
    'lines', COALESCE((SELECT jsonb_agg(jsonb_build_object('code', l.person_code, 'name', l.person_name,
        'position', (SELECT position FROM public.hhee_people WHERE id = l.person_id),
        'document_number', (SELECT document_number FROM public.hhee_people WHERE id = l.person_id), 'rest_day', l.rest_day,
        'start', l.planned_start, 'end', l.planned_end, 'break_minutes', l.planned_break, 'minutes', l.planned_minutes,
        'minutes_25', l.plan_minutes_25, 'minutes_35', l.plan_minutes_35, 'minutes_100', l.plan_minutes_100, 'cost', l.plan_cost)
      ORDER BY l.person_name) FROM public.hhee_lines l WHERE l.request_id = r.id), '[]'::jsonb),
    'totals', public.hhee_flow_totals(r.id), 'holiday', public.hhee_pe_holiday(r.work_date))
  FROM public.hhee_requests r JOIN public.hhee_areas a ON a.id = r.area_id JOIN public.hhee_causes c ON c.id = r.cause_id
  WHERE r.id = p_id;
$$;

CREATE OR REPLACE FUNCTION public.hhee_flow_detail(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.hhee_requests; v_costs boolean := (public.hhee_flow_caps()->>'costs')::boolean;
BEGIN
  SELECT * INTO r FROM public.hhee_requests WHERE id = p_id;
  IF r.id IS NULL OR NOT public.hhee_can(r.area_id, 'read') THEN RETURN jsonb_build_object('success', false, 'error', 'Solicitud no encontrada'); END IF;
  RETURN jsonb_build_object('success', true, 'cost_visible', v_costs, 'holiday', public.hhee_pe_holiday(r.work_date),
    'request', public.hhee_flow_row(r, v_costs) || jsonb_build_object('justification', r.justification, 'alternatives', r.alternatives,
      'expected_result', r.expected_result, 'reference_type', r.reference_type, 'reference_code', r.reference_code),
    'lines', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', l.id, 'person_id', l.person_id, 'name', l.person_name, 'code', l.person_code,
        'position', (SELECT position FROM public.hhee_people WHERE id = l.person_id), 'start', l.planned_start, 'end', l.planned_end,
        'document_number', (SELECT document_number FROM public.hhee_people WHERE id = l.person_id), 'rest_day', l.rest_day,
        'break_minutes', l.planned_break, 'minutes', l.planned_minutes, 'minutes_25', l.plan_minutes_25, 'minutes_35', l.plan_minutes_35,
        'minutes_100', l.plan_minutes_100, 'approved_minutes', l.approved_minutes, 'rate_ready', l.plan_rate IS NOT NULL)
        || CASE WHEN v_costs THEN jsonb_build_object('cost', l.plan_cost) ELSE '{}'::jsonb END ORDER BY l.person_name)
      FROM public.hhee_lines l WHERE l.request_id = p_id), '[]'::jsonb),
    'authorizations', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', x.id, 'revision', x.revision, 'approved_at', x.approved_at,
        'approver', public.hhee_flow_name(x.approved_by),
        'snapshot', CASE WHEN v_costs THEN x.snapshot
          ELSE jsonb_set(x.snapshot - 'totals', '{lines}', COALESCE((SELECT jsonb_agg(e - 'cost') FROM jsonb_array_elements(x.snapshot->'lines') e), '[]'::jsonb))
            || jsonb_build_object('totals', (x.snapshot->'totals') - 'cost') END) ORDER BY x.revision DESC)
      FROM public.hhee_authorizations x WHERE x.request_id = p_id), '[]'::jsonb),
    'events', COALESCE((SELECT jsonb_agg(jsonb_build_object('at', a.created_at, 'event', a.event, 'reason', a.reason, 'by', public.hhee_flow_name(a.actor)) ORDER BY a.created_at DESC)
      FROM public.hhee_audit a WHERE a.request_id = p_id), '[]'::jsonb));
END $$;

-- Vista previa del cálculo para el formulario (no guarda nada)
CREATE OR REPLACE FUNCTION public.hhee_flow_preview(p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_date date; v_id uuid := NULLIF(p->>'id', '')::uuid; l jsonb; v_person public.hhee_people; v_start timestamptz; v_end timestamptz;
  v_min int; v_split jsonb; out jsonb := '[]'::jsonb;
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
      v_split := public.hhee_flow_split(v_person.id, v_date, v_min, COALESCE((l->>'rest_day')::boolean, false), v_id);
      out := out || (jsonb_build_object('person_id', v_person.id, 'minutes', v_min) || v_split);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'holiday', public.hhee_pe_holiday(v_date), 'isodow', extract(isodow FROM v_date)::int, 'lines', out);
END $$;

-- Informe consolidado: versión vigente de cada autorización elegida (sin montos si no se ven costos)
CREATE OR REPLACE FUNCTION public.hhee_flow_consolidated(p_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_costs boolean := (public.hhee_flow_caps()->>'costs')::boolean; v_items jsonb;
BEGIN
  IF NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso'); END IF;
  IF p_ids IS NULL OR cardinality(p_ids) NOT BETWEEN 1 AND 100 THEN RETURN jsonb_build_object('success', false, 'error', 'Elija entre 1 y 100 solicitudes aprobadas'); END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('request_id', r.id, 'revision', x.revision,
      'snapshot', CASE WHEN v_costs THEN x.snapshot
        ELSE jsonb_set(x.snapshot - 'totals', '{lines}', COALESCE((SELECT jsonb_agg(e - 'cost') FROM jsonb_array_elements(x.snapshot->'lines') e), '[]'::jsonb))
          || jsonb_build_object('totals', (x.snapshot->'totals') - 'cost') END) ORDER BY r.work_date, r.sequence), '[]'::jsonb)
  INTO v_items
  FROM public.hhee_requests r
  JOIN LATERAL (SELECT * FROM public.hhee_authorizations a WHERE a.request_id = r.id ORDER BY a.revision DESC LIMIT 1) x ON true
  WHERE r.id = ANY (p_ids) AND r.approval = 'APROBADA' AND r.state <> 'CANCELADA' AND public.hhee_can(r.area_id, 'read');
  IF jsonb_array_length(v_items) = 0 THEN RETURN jsonb_build_object('success', false, 'error', 'Ninguna de las solicitudes elegidas está aprobada'); END IF;
  RETURN jsonb_build_object('success', true, 'cost_visible', v_costs, 'items', v_items, 'skipped', cardinality(p_ids) - jsonb_array_length(v_items));
END $$;

REVOKE ALL ON FUNCTION public.hhee_flow_split(uuid, date, integer, boolean, uuid), public.hhee_flow_resplit(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hhee_pe_holiday(date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.hhee_flow_preview(jsonb), public.hhee_flow_consolidated(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hhee_flow_preview(jsonb), public.hhee_flow_consolidated(uuid[]), public.hhee_pe_holiday(date) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
