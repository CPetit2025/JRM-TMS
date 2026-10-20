-- ============================================================
-- Rutas: auxiliar en Armar ruta y solicitud automática de horas extras de la tripulación
-- ============================================================
-- 1. Auxiliar opcional de la ruta (dispatch_crew, función AUXILIAR). Puede ser un auxiliar o un conductor
--    disponible: list_route_assistants() marca a quien ya conduce o acompaña otra ruta activa y set_dispatch_crew
--    rechaza a un conductor que conduce otra ruta activa.
-- 2. Horario ordinario: lunes a viernes hasta las 17:30, sábado hasta las 13:30 (hhee_settings). Domingo y feriado:
--    todo el tiempo de ruta, al 100 %. No se puede anticipar quién hará horas extras: cada 10 minutos (pg_cron) las
--    rutas de flota propia que siguen en curso pasado el horario generan UNA solicitud en borrador con el conductor y
--    la tripulación (auxiliar / ayudante), la placa de la ruta, inicio al fin del horario (o la salida, en domingo y
--    feriado) y fin estimado. El supervisor que programó la ruta recibe el aviso, completa actividad, por qué,
--    alternativa y resultado (vienen marcados «PENDIENTE») y la presenta; no se puede presentar sin completarlos.
-- 3. Quien no tiene ficha de personal recibe una (costo pendiente). Otras horas extras siguen siendo manuales.
BEGIN;
SET LOCAL lock_timeout = '60s';

ALTER TABLE public.hhee_settings
  ADD COLUMN IF NOT EXISTS shift_end_weekday time NOT NULL DEFAULT '17:30',
  ADD COLUMN IF NOT EXISTS shift_end_saturday time NOT NULL DEFAULT '13:30',
  ADD COLUMN IF NOT EXISTS auto_route_requests boolean NOT NULL DEFAULT true;
INSERT INTO public.hhee_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.hhee_requests ADD COLUMN IF NOT EXISTS auto_dispatch_id uuid REFERENCES public.dispatches(id);
CREATE INDEX IF NOT EXISTS hhee_requests_auto_dispatch_idx ON public.hhee_requests (auto_dispatch_id);
CREATE UNIQUE INDEX IF NOT EXISTS hhee_requests_auto_dispatch_uidx ON public.hhee_requests (auto_dispatch_id)
  WHERE auto_dispatch_id IS NOT NULL AND state <> 'CANCELADA';

INSERT INTO public.hhee_causes (name) VALUES ('Ruta extendida fuera del horario') ON CONFLICT (name) DO NOTHING;

-- ------------------------------------------------------------
-- 1. Auxiliar de la ruta
-- ------------------------------------------------------------
-- Candidatos: auxiliares / ayudantes y conductores activos; «busy» indica la ruta activa que ya tienen
CREATE OR REPLACE FUNCTION public.list_route_assistants(p_dispatch_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.has_tms_read_permission('despacho') THEN RETURN '[]'::jsonb; END IF;
  RETURN COALESCE((SELECT jsonb_agg(x ORDER BY x->>'kind' DESC, x->>'name') FROM (
    SELECT jsonb_build_object('profile_id', p.id, 'name', trim(concat_ws(' ', to_jsonb(p)->>'first_name', to_jsonb(p)->>'last_name')),
      'kind', CASE WHEN dr.id IS NOT NULL THEN 'CONDUCTOR' ELSE 'AUXILIAR' END, 'employee_type', to_jsonb(p)->>'employee_type',
      'busy', COALESCE(
        (SELECT x.dispatch_number FROM public.dispatches x WHERE dr.id IS NOT NULL AND x.driver_id = dr.id AND x.id IS DISTINCT FROM p_dispatch_id
           AND x.status IN ('PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO') LIMIT 1),
        (SELECT x.dispatch_number FROM public.dispatch_crew c JOIN public.dispatches x ON x.id = c.dispatch_id
          WHERE c.profile_id = p.id AND c.removed_at IS NULL AND c.dispatch_id IS DISTINCT FROM p_dispatch_id
            AND x.status IN ('PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO') LIMIT 1))) AS x
    FROM public.profiles p
    LEFT JOIN LATERAL (SELECT d.id FROM public.drivers d WHERE d.profile_id = p.id AND COALESCE((to_jsonb(d)->>'is_active')::boolean, true) LIMIT 1) dr ON true
    WHERE COALESCE(p.is_active, true)
      AND (dr.id IS NOT NULL OR COALESCE(to_jsonb(p)->>'employee_type', '') IN ('Auxiliar de Transporte', 'Auxiliar de Despacho', 'Ayudante', 'Estibador'))
  ) t), '[]'::jsonb);
END $$;

-- La tripulación admite conductores, salvo el de la propia ruta o uno que conduce otra ruta activa
CREATE OR REPLACE FUNCTION public.set_dispatch_crew(p_dispatch_id uuid, p_crew jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d       record;
  v_item  jsonb;
  v_prof  uuid;
  v_role  text;
  v_busy  text;
  v_name  text;
  v_ids   uuid[] := '{}';
BEGIN
  IF NOT public.has_tms_permission('despacho') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el Supervisor de Transporte asigna la tripulación');
  END IF;
  SELECT x.id, x.status, x.site_id, x.driver_id INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id FOR UPDATE;
  IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Despacho inexistente');
  END IF;
  IF d.status <> 'PROGRAMADO' THEN
    RETURN jsonb_build_object('success', false, 'error', 'La tripulación se asigna mientras el despacho está programado');
  END IF;
  IF p_crew IS NULL OR jsonb_typeof(p_crew) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Tripulación inválida');
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_crew) LOOP
    v_prof := NULLIF(v_item->>'profile_id', '')::uuid;
    v_role := upper(COALESCE(NULLIF(v_item->>'crew_role', ''), 'AYUDANTE'));
    IF v_role NOT IN ('AYUDANTE', 'AUXILIAR', 'ESTIBADOR', 'MONTACARGUISTA', 'OPERADOR_GRUA', 'OTRO') THEN
      RETURN jsonb_build_object('success', false, 'error', 'Función de tripulación inválida: ' || v_role);
    END IF;
    SELECT trim(concat_ws(' ', to_jsonb(p)->>'first_name', to_jsonb(p)->>'last_name')) INTO v_name
    FROM public.profiles p WHERE p.id = v_prof AND COALESCE(p.is_active, true);
    IF v_name IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Trabajador inexistente o inactivo'); END IF;
    IF EXISTS (SELECT 1 FROM public.drivers dr WHERE dr.id = d.driver_id AND dr.profile_id = v_prof) THEN
      RETURN jsonb_build_object('success', false, 'error', v_name || ' es el conductor del despacho');
    END IF;
    SELECT x.dispatch_number INTO v_busy FROM public.drivers dr JOIN public.dispatches x ON x.driver_id = dr.id
    WHERE dr.profile_id = v_prof AND x.id <> p_dispatch_id
      AND x.status IN ('PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO') LIMIT 1;
    IF v_busy IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', v_name || ' conduce la ruta ' || v_busy);
    END IF;
    SELECT x.dispatch_number INTO v_busy FROM public.dispatch_crew c JOIN public.dispatches x ON x.id = c.dispatch_id
    WHERE c.profile_id = v_prof AND c.removed_at IS NULL AND c.dispatch_id <> p_dispatch_id
      AND x.status IN ('PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO') LIMIT 1;
    IF v_busy IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', v_name || ' ya está asignado al despacho ' || v_busy);
    END IF;
    v_ids := v_ids || v_prof;
    UPDATE public.dispatch_crew SET crew_role = v_role
    WHERE dispatch_id = p_dispatch_id AND profile_id = v_prof AND removed_at IS NULL;
    IF NOT FOUND THEN
      INSERT INTO public.dispatch_crew (dispatch_id, profile_id, crew_role, assigned_by) VALUES (p_dispatch_id, v_prof, v_role, auth.uid());
    END IF;
  END LOOP;

  UPDATE public.dispatch_crew SET removed_at = now(), removed_by = auth.uid()
  WHERE dispatch_id = p_dispatch_id AND removed_at IS NULL AND NOT (profile_id = ANY (v_ids));
  RETURN jsonb_build_object('success', true, 'crew', cardinality(v_ids));
END $$;

-- Rutas del día de un conductor: las que conduce y las que acompaña como tripulación
CREATE OR REPLACE FUNCTION public.hhee_driver_routes(p_driver uuid, p_date date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', d.id, 'number', COALESCE(j->>'dispatch_number', j->>'legacy_dispatch_number'),
      'plate', d.vehicle_plate, 'status', j->>'status', 'departure', COALESCE(j->>'scheduled_departure', j->>'departure_time', j->>'scheduled_date'))
    ORDER BY COALESCE(j->>'scheduled_departure', j->>'departure_time', j->>'scheduled_date', j->>'created_at')), '[]'::jsonb)
  FROM public.dispatches d, LATERAL to_jsonb(d) j
  WHERE (d.driver_id = p_driver OR EXISTS (SELECT 1 FROM public.dispatch_crew c JOIN public.drivers dr ON dr.profile_id = c.profile_id
          WHERE dr.id = p_driver AND c.dispatch_id = d.id AND c.removed_at IS NULL))
    AND d.vehicle_plate IS NOT NULL
    AND upper(COALESCE(j->>'status', '')) NOT IN ('CANCELADO', 'CANCELADA', 'ANULADO', 'ANULADA', 'BORRADOR')
    AND public.fe_jdate(j, ARRAY['scheduled_departure', 'scheduled_date', 'dispatch_date', 'departure_date', 'departure_time', 'started_at', 'created_at']) = p_date;
$$;

-- ------------------------------------------------------------
-- 2. Solicitud automática de horas extras de la ruta
-- ------------------------------------------------------------
-- Ficha de personal de un conductor o de un trabajador (se crea si no existe; costo pendiente)
CREATE OR REPLACE FUNCTION public.hhee_person_for(p_driver uuid, p_profile uuid, p_area uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid; m jsonb; v_code text; v_pos text;
BEGIN
  IF p_driver IS NULL AND p_profile IS NOT NULL THEN SELECT id INTO p_driver FROM public.drivers WHERE profile_id = p_profile ORDER BY id LIMIT 1; END IF;
  IF p_driver IS NOT NULL THEN SELECT id INTO v_id FROM public.hhee_people WHERE driver_id = p_driver; END IF;
  IF v_id IS NULL AND p_profile IS NOT NULL THEN SELECT id INTO v_id FROM public.hhee_people WHERE profile_id = p_profile ORDER BY active DESC, id LIMIT 1; END IF;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  m := CASE WHEN p_driver IS NOT NULL THEN public.hhee_driver_master(p_driver) ELSE public.hhee_profile_master(p_profile) END;
  IF NOT (length(m->>'name') BETWEEN 3 AND 160) THEN RETURN NULL; END IF;
  v_code := COALESCE(CASE WHEN length(m->>'doc') BETWEEN 6 AND 20 THEN m->>'doc' END, 'P-' || upper(left(replace(COALESCE(p_profile, p_driver)::text, '-', ''), 12)));
  IF EXISTS (SELECT 1 FROM public.hhee_people WHERE code = v_code) THEN v_code := left('R-' || v_code, 50); END IF;
  v_pos := CASE WHEN p_driver IS NOT NULL THEN 'Conductor' ELSE NULLIF(left((SELECT to_jsonb(p)->>'employee_type' FROM public.profiles p WHERE p.id = p_profile), 100), '') END;
  INSERT INTO public.hhee_people (code, name, document_number, position, area_id, active, daily_hours, monthly_hours, divisor_confirmed, remuneration_concepts, driver_id, profile_id)
  VALUES (v_code, m->>'name', CASE WHEN length(m->>'doc') BETWEEN 6 AND 20 AND NOT EXISTS (SELECT 1 FROM public.hhee_people x WHERE x.document_number = m->>'doc') THEN m->>'doc' END,
    v_pos, p_area, true, 8, 240, false, '[]'::jsonb, p_driver, p_profile)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Inicio de las horas extras de la ruta en la fecha (fin del horario; domingo y feriado: la salida de la ruta)
CREATE OR REPLACE FUNCTION public.hhee_route_overtime_start(p_dispatch uuid, p_day date) RETURNS timestamptz
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.hhee_settings; j jsonb; v_dow int := extract(isodow FROM p_day);
BEGIN
  SELECT * INTO s FROM public.hhee_settings WHERE id = 1;
  IF v_dow = 7 OR public.hhee_pe_holiday(p_day) IS NOT NULL THEN
    SELECT to_jsonb(d) INTO j FROM public.dispatches d WHERE d.id = p_dispatch;
    RETURN GREATEST((p_day::timestamp AT TIME ZONE 'America/Lima'),
      COALESCE(NULLIF(j->>'started_at', '')::timestamptz, NULLIF(j->>'departed_at', '')::timestamptz, NULLIF(j->>'departure_time', '')::timestamptz,
               NULLIF(j->>'scheduled_departure', '')::timestamptz, p_day::timestamp AT TIME ZONE 'America/Lima'));
  END IF;
  RETURN (p_day + CASE WHEN v_dow = 6 THEN COALESCE(s.shift_end_saturday, '13:30') ELSE COALESCE(s.shift_end_weekday, '17:30') END) AT TIME ZONE 'America/Lima';
END $$;

-- Genera (una sola vez) la solicitud en borrador de una ruta que sigue en curso fuera del horario
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
  FOR c IN SELECT d.driver_id AS driver_id, NULL::uuid AS profile_id, 0 AS ord
           UNION ALL SELECT NULL, x.profile_id, 1 FROM public.dispatch_crew x WHERE x.dispatch_id = p_dispatch AND x.removed_at IS NULL AND x.crew_role IN ('AUXILIAR', 'AYUDANTE')
           ORDER BY ord LOOP
    v_person := public.hhee_person_for(c.driver_id, c.profile_id, v_area);
    CONTINUE WHEN v_person IS NULL OR v_person = ANY (v_people);
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

-- Cada 10 minutos: rutas de flota propia en curso fuera del horario
CREATE OR REPLACE FUNCTION public.hhee_auto_route_requests(p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE x record; res jsonb; v_created int := 0;
BEGIN
  IF NOT COALESCE((SELECT auto_route_requests FROM public.hhee_settings WHERE id = 1), true) THEN RETURN jsonb_build_object('created', 0, 'disabled', true); END IF;
  FOR x IN SELECT d.id FROM public.dispatches d
           WHERE d.status IN ('EN_CURSO', 'EN RUTA', 'RETORNO') AND d.driver_id IS NOT NULL AND d.vehicle_plate IS NOT NULL AND d.vehicle_plate <> 'EXTERNO'
             AND NOT EXISTS (SELECT 1 FROM public.hhee_requests r WHERE r.auto_dispatch_id = d.id AND r.state <> 'CANCELADA') LOOP
    BEGIN
      res := public.hhee_route_request_for(x.id, p_now);
      IF (res->>'created')::boolean THEN v_created := v_created + 1; END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
  RETURN jsonb_build_object('created', v_created);
END $$;

-- El supervisor no puede presentar una solicitud de ruta sin completar los textos
CREATE OR REPLACE FUNCTION public.hhee_flow_submit(p_id uuid, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.hhee_requests;
BEGIN
  SELECT * INTO r FROM public.hhee_requests WHERE id = p_id FOR UPDATE;
  IF r.id IS NULL OR NOT public.hhee_can(r.area_id, 'request') OR (r.created_by <> auth.uid() AND NOT public.is_tms_admin()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solicitud no encontrada'); END IF;
  IF r.state <> 'BORRADOR' THEN RETURN jsonb_build_object('success', false, 'error', 'La solicitud ya fue presentada'); END IF;
  IF r.version IS DISTINCT FROM p_version THEN RETURN jsonb_build_object('success', false, 'error', 'La solicitud cambió; recargue'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.hhee_lines WHERE request_id = p_id) THEN RETURN jsonb_build_object('success', false, 'error', 'Agregue trabajadores'); END IF;
  -- Las generadas por la ruta llegan con textos «PENDIENTE»: el supervisor los completa antes de presentar
  IF r.activity LIKE 'PENDIENTE%' OR r.justification LIKE 'PENDIENTE%' OR r.alternatives LIKE 'PENDIENTE%' OR r.expected_result LIKE 'PENDIENTE%' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Complete la actividad, por qué se necesitan, la alternativa evaluada y el resultado esperado');
  END IF;
  UPDATE public.hhee_requests SET state = 'SOLICITADA', approval = 'PENDIENTE', submitted_at = now(), version = version + 1, updated_at = now()
  WHERE id = p_id RETURNING * INTO r;
  INSERT INTO public.hhee_audit (request_id, actor, event) VALUES (p_id, auth.uid(), 'PRESENTADA');
  RETURN jsonb_build_object('success', true, 'id', p_id, 'version', r.version);
END $$;

-- Fila de la lista: indica si la generó una ruta
CREATE OR REPLACE FUNCTION public.hhee_flow_row(r public.hhee_requests, p_costs boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('id', r.id, 'sequence', r.sequence, 'version', r.version, 'work_date', r.work_date, 'area_id', r.area_id,
    'area', (SELECT name FROM public.hhee_areas WHERE id = r.area_id), 'cause_id', r.cause_id, 'cause', (SELECT name FROM public.hhee_causes WHERE id = r.cause_id),
    'activity', r.activity, 'state', r.state, 'approval', r.approval, 'created_by', r.created_by, 'requester', public.hhee_flow_name(r.created_by),
    'approver', public.hhee_flow_name(r.approved_by), 'approved_at', r.approved_at, 'submitted_at', r.submitted_at, 'created_at', r.created_at,
    'approval_reason', r.approval_reason, 'auto_dispatch_id', r.auto_dispatch_id,
    'auto_dispatch_number', (SELECT COALESCE(to_jsonb(x)->>'dispatch_number', to_jsonb(x)->>'legacy_dispatch_number') FROM public.dispatches x WHERE x.id = r.auto_dispatch_id), 'revisions', (SELECT count(*) FROM public.hhee_authorizations WHERE request_id = r.id),
    'can_edit', public.hhee_can(r.area_id, 'request') AND (r.created_by = auth.uid() OR public.is_tms_admin())
      AND ((r.state = 'BORRADOR') OR (r.state = 'SOLICITADA' AND r.approval = 'APROBADA')),
    'can_decide', public.hhee_can(r.area_id, 'approve') AND r.state = 'SOLICITADA' AND r.approval = 'PENDIENTE'
      AND (r.created_by <> auth.uid() OR public.is_tms_admin()))
  || (SELECT t - CASE WHEN p_costs THEN ARRAY[]::text[] ELSE ARRAY['cost'] END FROM public.hhee_flow_totals(r.id) t);
$$;

REVOKE ALL ON FUNCTION public.hhee_person_for(uuid, uuid, uuid), public.hhee_route_overtime_start(uuid, date),
  public.hhee_route_request_for(uuid, timestamptz), public.hhee_auto_route_requests(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_route_assistants(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_route_assistants(uuid) TO authenticated;

-- PLATFORM_CRON_BEGIN: pg_cron lo provee Supabase; el arnés local prueba la función directamente.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'hhee-rutas-fuera-de-horario';
    PERFORM cron.schedule('hhee-rutas-fuera-de-horario', '*/10 * * * *', $cron$SELECT public.hhee_auto_route_requests()$cron$);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
