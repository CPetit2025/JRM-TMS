-- ============================================================
-- HHEE: lista con trabajadores, placa y referencia; un trabajador no se repite en la misma fecha
-- ============================================================
-- 1. hhee_flow_row devuelve los trabajadores, las placas y la referencia (OT / OC / OS / RQ) de cada solicitud.
-- 2. Un trabajador no puede estar en dos solicitudes vigentes (no anuladas ni rechazadas) del mismo día: la vista
--    previa lo marca, el guardado lo rechaza y la solicitud automática de ruta no lo agrega otra vez.
BEGIN;
SET LOCAL lock_timeout = '60s';

-- Folio de otra solicitud vigente del mismo día en la que ya está el trabajador (NULL si no hay)
CREATE OR REPLACE FUNCTION public.hhee_person_day_conflict(p_person uuid, p_date date, p_except uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT 'HE-' || lpad(r.sequence::text, 5, '0') FROM public.hhee_requests r JOIN public.hhee_lines l ON l.request_id = r.id
  WHERE l.person_id = p_person AND r.work_date = p_date AND r.id IS DISTINCT FROM p_except
    AND r.state <> 'CANCELADA' AND r.approval <> 'RECHAZADA'
  ORDER BY r.sequence LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.hhee_flow_row(r public.hhee_requests, p_costs boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('id', r.id, 'sequence', r.sequence, 'version', r.version, 'work_date', r.work_date, 'area_id', r.area_id,
    'area', (SELECT name FROM public.hhee_areas WHERE id = r.area_id), 'cause_id', r.cause_id, 'cause', (SELECT name FROM public.hhee_causes WHERE id = r.cause_id),
    'activity', r.activity, 'state', r.state, 'approval', r.approval, 'created_by', r.created_by, 'requester', public.hhee_flow_name(r.created_by),
    'approver', public.hhee_flow_name(r.approved_by), 'approved_at', r.approved_at, 'submitted_at', r.submitted_at, 'created_at', r.created_at,
    'approval_reason', r.approval_reason, 'auto_dispatch_id', r.auto_dispatch_id,
    'reference_type', r.reference_type, 'reference_code', r.reference_code,
    'people', COALESCE((SELECT jsonb_agg(l.person_name ORDER BY l.person_name) FROM public.hhee_lines l WHERE l.request_id = r.id), '[]'::jsonb),
    'plates', COALESCE((SELECT jsonb_agg(DISTINCT l.vehicle_plate) FROM public.hhee_lines l WHERE l.request_id = r.id AND l.vehicle_plate IS NOT NULL), '[]'::jsonb),
    'auto_dispatch_number', (SELECT COALESCE(to_jsonb(x)->>'dispatch_number', to_jsonb(x)->>'legacy_dispatch_number') FROM public.dispatches x WHERE x.id = r.auto_dispatch_id), 'revisions', (SELECT count(*) FROM public.hhee_authorizations WHERE request_id = r.id),
    'can_edit', public.hhee_can(r.area_id, 'request') AND (r.created_by = auth.uid() OR public.is_tms_admin())
      AND ((r.state = 'BORRADOR') OR (r.state = 'SOLICITADA' AND r.approval = 'APROBADA')),
    'can_decide', public.hhee_can(r.area_id, 'approve') AND r.state = 'SOLICITADA' AND r.approval = 'PENDIENTE'
      AND (r.created_by <> auth.uid() OR public.is_tms_admin()))
  || (SELECT t - CASE WHEN p_costs THEN ARRAY[]::text[] ELSE ARRAY['cost'] END FROM public.hhee_flow_totals(r.id) t);
$$;

CREATE OR REPLACE FUNCTION public.hhee_flow_list(p jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_costs boolean := (public.hhee_flow_caps()->>'costs')::boolean; v_from date := NULLIF(p->>'from', '')::date; v_to date := NULLIF(p->>'to', '')::date;
  v_status text := COALESCE(p->>'status', ''); v_q text := lower(btrim(COALESCE(p->>'q', '')));
BEGIN
  IF NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso'); END IF;
  RETURN jsonb_build_object('success', true, 'rows', COALESCE((
    SELECT jsonb_agg(public.hhee_flow_row(r, v_costs) ORDER BY r.work_date DESC, r.sequence DESC)
    FROM (SELECT * FROM public.hhee_requests r
          WHERE public.hhee_can(r.area_id, 'read')
            AND (v_from IS NULL OR r.work_date >= v_from) AND (v_to IS NULL OR r.work_date <= v_to)
            AND (NULLIF(p->>'area_id', '') IS NULL OR r.area_id = (p->>'area_id')::uuid)
            AND (v_status = '' OR (v_status = 'pendientes' AND r.state = 'SOLICITADA' AND r.approval = 'PENDIENTE')
              OR (v_status = 'aprobadas' AND r.approval = 'APROBADA') OR (v_status = 'observadas' AND r.approval = 'OBSERVADA')
              OR (v_status = 'rechazadas' AND r.approval = 'RECHAZADA') OR (v_status = 'borradores' AND r.state = 'BORRADOR' AND r.approval = 'PENDIENTE')
              OR (v_status = 'mias' AND r.created_by = auth.uid()))
            AND (v_q = '' OR lower(concat_ws(' ', r.sequence::text, r.activity, r.reference_code)) LIKE '%' || v_q || '%'
              OR EXISTS (SELECT 1 FROM public.hhee_lines l WHERE l.request_id = r.id AND lower(concat_ws(' ', l.person_name, l.person_code, l.vehicle_plate)) LIKE '%' || v_q || '%'))
          ORDER BY r.work_date DESC, r.sequence DESC LIMIT 500) r), '[]'::jsonb),
    'pending', (SELECT count(*) FROM public.hhee_requests r WHERE r.state = 'SOLICITADA' AND r.approval = 'PENDIENTE' AND public.hhee_can(r.area_id, 'approve')));
END $$;

CREATE OR REPLACE FUNCTION public.hhee_flow_preview(p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_date date; v_id uuid := NULLIF(p->>'id', '')::uuid; l jsonb; v_person public.hhee_people; v_start timestamptz; v_end timestamptz;
  v_min int; v_split jsonb; out jsonb := '[]'::jsonb; v_seen uuid[] := '{}'; v_conflict text;
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
    ELSIF v_person.id = ANY (v_seen) THEN
      out := out || jsonb_build_object('person_id', v_person.id, 'error', 'Trabajador repetido en esta solicitud');
    ELSIF v_min IS NULL OR v_end <= v_start OR v_end - v_start > interval '16 hours' THEN
      out := out || jsonb_build_object('person_id', v_person.id, 'error', 'Horario inválido (máximo 16 h)');
    ELSIF v_min < 1 THEN
      out := out || jsonb_build_object('person_id', v_person.id, 'error', 'El descanso supera el horario');
    ELSIF (public.hhee_person_day_conflict(v_person.id, v_date, v_id)) IS NOT NULL THEN
      v_conflict := public.hhee_person_day_conflict(v_person.id, v_date, v_id);
      out := out || jsonb_build_object('person_id', v_person.id, 'error', format('Ya tiene horas extras el %s en %s: agréguelas en esa solicitud', to_char(v_date, 'DD/MM/YYYY'), v_conflict));
    ELSE
      v_seen := v_seen || v_person.id;
      v_split := public.hhee_flow_split(v_person.id, v_date, v_min, COALESCE((l->>'rest_day')::boolean, false), v_id);
      out := out || (jsonb_build_object('person_id', v_person.id, 'minutes', v_min, 'driver', v_person.driver_id IS NOT NULL,
        'routes', CASE WHEN v_person.driver_id IS NOT NULL THEN public.hhee_driver_routes(v_person.driver_id, v_date) END) || v_split);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'holiday', public.hhee_pe_holiday(v_date), 'isodow', extract(isodow FROM v_date)::int, 'lines', out);
END $$;

CREATE OR REPLACE FUNCTION public.hhee_flow_request_save(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid := NULLIF(p->>'id', '')::uuid; r public.hhee_requests; v_area uuid := NULLIF(p->>'area_id', '')::uuid;
  v_cause uuid := NULLIF(p->>'cause_id', '')::uuid; v_date date; l jsonb; v_person public.hhee_people; v_start timestamptz; v_end timestamptz;
  v_break int; m25 int; m35 int; m100 int; v_total int; v_rest boolean; v_split jsonb;
  v_routes jsonb; v_route jsonb; v_plate text; v_reason text; v_source text; v_disp uuid; v_dnum text; v_rate numeric; v_seen uuid[] := '{}'; v_ref text := COALESCE(NULLIF(p->>'reference_type', ''), 'SIN_REFERENCIA');
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
    -- Conductor: la placa sale de su ruta asignada ese día; sin ruta (o si cambió de unidad) se indica a mano con motivo
    v_route := NULL; v_plate := NULL; v_reason := NULL; v_source := NULL; v_disp := NULL; v_dnum := NULL;
    IF v_person.driver_id IS NOT NULL THEN
      v_routes := public.hhee_driver_routes(v_person.driver_id, v_date);
      v_reason := NULLIF(btrim(COALESCE(l->>'plate_reason', '')), '');
      IF NULLIF(l->>'dispatch_id', '') IS NOT NULL THEN
        SELECT x INTO v_route FROM jsonb_array_elements(v_routes) x WHERE x->>'id' = l->>'dispatch_id';
        IF v_route IS NULL THEN RAISE EXCEPTION 'La ruta elegida para % no es suya o no es del %', v_person.name, to_char(v_date, 'DD/MM/YYYY'); END IF;
        v_reason := NULL;
      ELSIF v_reason IS NOT NULL THEN
        IF length(v_reason) < 5 OR length(v_reason) > 300 THEN
          RAISE EXCEPTION 'Explique por qué % usa otra placa o no tiene ruta (5 a 300 caracteres)', v_person.name; END IF;
        v_plate := NULLIF(upper(btrim(COALESCE(l->>'vehicle_plate', ''))), '');
        IF length(v_plate) > 20 THEN RAISE EXCEPTION 'Placa inválida para %', v_person.name; END IF;
        v_source := 'MANUAL';
      ELSIF jsonb_array_length(v_routes) = 1 THEN v_route := v_routes->0;
      ELSIF jsonb_array_length(v_routes) > 1 THEN
        RAISE EXCEPTION '% tiene % rutas el %: elija la que corresponde a las horas extras', v_person.name, jsonb_array_length(v_routes), to_char(v_date, 'DD/MM/YYYY');
      ELSE
        RAISE EXCEPTION '% no tiene ruta asignada el %: indique la placa y el motivo', v_person.name, to_char(v_date, 'DD/MM/YYYY');
      END IF;
      IF v_route IS NOT NULL THEN
        v_disp := (v_route->>'id')::uuid; v_plate := v_route->>'plate'; v_dnum := v_route->>'number'; v_source := 'RUTA';
      END IF;
    END IF;
    IF public.hhee_person_day_conflict(v_person.id, v_date, r.id) IS NOT NULL THEN
      RAISE EXCEPTION '% ya tiene horas extras el % en %: agréguelas en esa solicitud', v_person.name, to_char(v_date, 'DD/MM/YYYY'), public.hhee_person_day_conflict(v_person.id, v_date, r.id); END IF;
    v_rate := public.hhee_flow_rate(v_person.id);
    INSERT INTO public.hhee_lines (request_id, person_id, person_name, person_code, planned_start, planned_end, planned_break, planned_minutes,
      plan_minutes_25, plan_minutes_35, plan_minutes_100, plan_rate, plan_cost, estimated_cost, rest_day,
      driver_dispatch_id, dispatch_number, vehicle_plate, plate_source, plate_reason)
    VALUES (r.id, v_person.id, v_person.name, v_person.code, v_start, v_end, v_break, v_total, m25, m35, m100, v_rate,
      public.hhee_flow_cost(v_rate, m25, m35, m100), public.hhee_flow_cost(v_rate, m25, m35, m100), v_rest,
      v_disp, v_dnum, v_plate, v_source, v_reason);
  END LOOP;

  INSERT INTO public.hhee_audit (request_id, actor, event, reason)
  VALUES (r.id, auth.uid(), CASE WHEN v_id IS NULL THEN 'SOLICITUD_REGISTRADA' WHEN v_was_approved THEN 'MODIFICADA_TRAS_APROBACION' ELSE 'SOLICITUD_CORREGIDA' END, NULL);
  RETURN jsonb_build_object('success', true, 'id', r.id, 'version', r.version, 'totals', public.hhee_flow_totals(r.id), 'reapproval', v_was_approved);
END $$;

CREATE OR REPLACE FUNCTION public.hhee_route_request_for(p_dispatch uuid, p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d public.dispatches; j jsonb; v_day date := (p_now AT TIME ZONE 'America/Lima')::date; v_start timestamptz; v_end timestamptz;
  v_area uuid; v_cause uuid; v_creator uuid; r public.hhee_requests; v_person uuid; v_people uuid[] := '{}'; v_rest boolean; v_min int; v_split jsonb;
  v_rate numeric; m25 int; m35 int; m100 int; v_num text; c record; v_p public.hhee_people; v_n int := 0;
BEGIN
  SELECT * INTO d FROM public.dispatches WHERE id = p_dispatch;
  IF d.id IS NULL OR d.driver_id IS NULL OR d.vehicle_plate IS NULL OR d.vehicle_plate = 'EXTERNO' THEN RETURN jsonb_build_object('created', false, 'reason', 'sin conductor propio'); END IF;
  IF EXISTS (SELECT 1 FROM public.hhee_requests WHERE auto_dispatch_id = p_dispatch AND state <> 'CANCELADA') THEN RETURN jsonb_build_object('created', false, 'reason', 'ya generada'); END IF;
  j := to_jsonb(d); v_num := COALESCE(j->>'dispatch_number', j->>'legacy_dispatch_number', left(p_dispatch::text, 8));
  v_start := public.hhee_route_overtime_start(p_dispatch, v_day);
  IF p_now < v_start THEN RETURN jsonb_build_object('created', false, 'reason', 'dentro del horario'); END IF;
  -- Fin estimado: la siguiente hora en punto (mínimo 30 min); el supervisor lo ajusta y el cierre real lo corrige
  v_end := GREATEST(date_trunc('hour', p_now) + interval '1 hour', v_start + interval '30 minutes');
  v_rest := extract(isodow FROM v_day) = 7;
  -- Área: la del conductor si ya tiene ficha; si no, la de la sede de la ruta o Distribución
  SELECT area_id INTO v_area FROM public.hhee_people WHERE driver_id = d.driver_id AND active;
  IF v_area IS NULL THEN
    SELECT a.id INTO v_area FROM public.hhee_areas a WHERE a.module_enabled AND a.active
    ORDER BY (a.site_id = (j->>'site_id')::uuid) DESC NULLS LAST, (a.name = 'Distribución') DESC, a.name LIMIT 1;
  END IF;
  IF v_area IS NULL THEN RETURN jsonb_build_object('created', false, 'reason', 'sin área de HHEE habilitada'); END IF;
  SELECT id INTO v_cause FROM public.hhee_causes WHERE name = 'Ruta extendida fuera del horario';
  v_creator := COALESCE(NULLIF(j->>'created_by', '')::uuid, NULLIF(j->>'scheduled_by', '')::uuid);
  IF v_creator IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_creator) THEN
    SELECT m.user_id INTO v_creator FROM public.hhee_memberships m JOIN public.profiles p ON p.id = m.user_id WHERE m.area_id = v_area AND p.is_active ORDER BY m.user_id LIMIT 1;
  END IF;
  IF v_creator IS NULL THEN RETURN jsonb_build_object('created', false, 'reason', 'sin supervisor'); END IF;

  INSERT INTO public.hhee_requests (area_id, cause_id, work_date, activity, justification, alternatives, expected_result, reference_type, created_by, auto_dispatch_id)
  VALUES (v_area, v_cause, v_day, left(format('PENDIENTE · Ruta %s · %s', v_num, d.vehicle_plate), 300), 'PENDIENTE: el supervisor completa por qué se necesitan',
    'PENDIENTE', 'PENDIENTE', 'SIN_REFERENCIA', v_creator, p_dispatch) RETURNING * INTO r;

  -- Conductor y tripulación que viaja (auxiliar / ayudante)
  FOR c IN SELECT d.driver_id AS driver_id, NULL::uuid AS profile_id, NULL::uuid AS person_id, 0 AS ord
           UNION ALL SELECT NULL, NULL, a.person_id, 1 FROM public.route_auxiliaries a WHERE a.dispatch_id = p_dispatch
           UNION ALL SELECT NULL, x.profile_id, NULL, 2 FROM public.dispatch_crew x WHERE x.dispatch_id = p_dispatch AND x.removed_at IS NULL AND x.crew_role IN ('AUXILIAR', 'AYUDANTE')
           ORDER BY ord LOOP
    CONTINUE WHEN c.ord = 1 AND c.person_id IS NULL;
    v_person := COALESCE(c.person_id, public.hhee_person_for(c.driver_id, c.profile_id, v_area));
    CONTINUE WHEN v_person IS NULL OR v_person = ANY (v_people);
    -- Quien ya tiene horas extras ese día en otra solicitud no se duplica
    CONTINUE WHEN public.hhee_person_day_conflict(v_person, v_day, r.id) IS NOT NULL;
    SELECT * INTO v_p FROM public.hhee_people WHERE id = v_person;
    CONTINUE WHEN NOT v_p.active;
    v_people := v_people || v_person;
    v_min := (extract(epoch FROM v_end - v_start) / 60)::int;
    v_split := public.hhee_flow_split(v_person, v_day, v_min, v_rest, r.id);
    m25 := (v_split->>'m25')::int; m35 := (v_split->>'m35')::int; m100 := (v_split->>'m100')::int;
    v_rate := public.hhee_flow_rate(v_person);
    INSERT INTO public.hhee_lines (request_id, person_id, person_name, person_code, planned_start, planned_end, planned_break, planned_minutes,
      plan_minutes_25, plan_minutes_35, plan_minutes_100, plan_rate, plan_cost, estimated_cost, rest_day,
      driver_dispatch_id, dispatch_number, vehicle_plate, plate_source)
    VALUES (r.id, v_person, v_p.name, v_p.code, v_start, v_end, 0, v_min, m25, m35, m100, v_rate,
      public.hhee_flow_cost(v_rate, m25, m35, m100), public.hhee_flow_cost(v_rate, m25, m35, m100), v_rest,
      CASE WHEN v_p.driver_id IS NOT NULL THEN p_dispatch END, CASE WHEN v_p.driver_id IS NOT NULL THEN v_num END,
      CASE WHEN v_p.driver_id IS NOT NULL THEN d.vehicle_plate END, CASE WHEN v_p.driver_id IS NOT NULL THEN 'RUTA' END);
    v_n := v_n + 1;
  END LOOP;
  IF v_n = 0 THEN DELETE FROM public.hhee_requests WHERE id = r.id; RETURN jsonb_build_object('created', false, 'reason', 'sin trabajadores'); END IF;

  INSERT INTO public.hhee_audit (request_id, actor, event, reason)
  VALUES (r.id, v_creator, 'GENERADA_POR_RUTA', format('Ruta %s en curso fuera del horario (%s)', v_num, to_char(v_start AT TIME ZONE 'America/Lima', 'HH24:MI')));
  BEGIN
    INSERT INTO public.notifications (evento, categoria, severidad, titulo, cuerpo, link, target_user, dedupe_key)
    VALUES ('HHEE_RUTA', 'hhee', 'warning', format('Horas extras de la ruta %s', v_num),
      format('La ruta %s (%s) sigue en curso fuera del horario. Complete la actividad, el porqué y la alternativa, y preséntela para aprobación.', v_num, d.vehicle_plate),
      '/hhee/solicitudes?id=' || r.id, v_creator, 'hhee-ruta-' || r.id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN jsonb_build_object('created', true, 'id', r.id, 'workers', v_n);
END $$;

REVOKE ALL ON FUNCTION public.hhee_person_day_conflict(uuid, date, uuid) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
