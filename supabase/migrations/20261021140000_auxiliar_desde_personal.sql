-- ============================================================
-- Armar ruta: el auxiliar se elige de Personal (HHEE) y entra en la solicitud automática de la ruta
-- ============================================================
-- La lista de auxiliares sale de las fichas activas de /hhee/personal (no de los usuarios del sistema), así que
-- puede ir de auxiliar alguien sin usuario. Con «Incluir conductores disponibles» se suman los conductores (fichas
-- enlazadas a Flota) que no conducen ni acompañan otra ruta activa. El auxiliar queda en la ruta
-- (route_auxiliaries, tabla propia para no tocar dispatches ni sus validaciones); si además tiene usuario, también
-- en la tripulación (dispatch_crew AUXILIAR).
BEGIN;
SET LOCAL lock_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.route_auxiliaries (
  dispatch_id uuid PRIMARY KEY REFERENCES public.dispatches(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES public.hhee_people(id),
  assigned_by uuid REFERENCES public.profiles(id),
  assigned_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS route_auxiliaries_person_idx ON public.route_auxiliaries (person_id);
CREATE INDEX IF NOT EXISTS route_auxiliaries_assigned_by_idx ON public.route_auxiliaries (assigned_by);
ALTER TABLE public.route_auxiliaries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.route_auxiliaries;
CREATE POLICY security_active_account ON public.route_auxiliaries AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.route_auxiliaries FROM PUBLIC, anon, authenticated;

-- Ruta activa que ocupa a una ficha de personal (conduce, va de auxiliar o en la tripulación), sin contar p_except
CREATE OR REPLACE FUNCTION public.route_person_busy(p_person uuid, p_except uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(to_jsonb(x)->>'dispatch_number', left(x.id::text, 8)) FROM public.dispatches x, public.hhee_people p
  WHERE p.id = p_person AND x.id IS DISTINCT FROM p_except
    AND x.status IN ('PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO')
    AND ((p.driver_id IS NOT NULL AND x.driver_id = p.driver_id)
      OR EXISTS (SELECT 1 FROM public.route_auxiliaries a WHERE a.dispatch_id = x.id AND a.person_id = p.id)
      OR (p.profile_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.dispatch_crew c WHERE c.dispatch_id = x.id AND c.profile_id = p.profile_id AND c.removed_at IS NULL)))
  ORDER BY x.id LIMIT 1;
$$;

-- Candidatos a auxiliar: fichas activas de Personal (HHEE)
CREATE OR REPLACE FUNCTION public.list_route_assistants(p_dispatch_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.has_tms_read_permission('despacho') THEN RETURN '[]'::jsonb; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('person_id', p.id, 'profile_id', p.profile_id, 'driver_id', p.driver_id, 'name', p.name,
      'code', p.code, 'position', p.position, 'area', a.name, 'kind', CASE WHEN p.driver_id IS NOT NULL THEN 'CONDUCTOR' ELSE 'AUXILIAR' END,
      'busy', public.route_person_busy(p.id, p_dispatch_id)) ORDER BY p.name)
    FROM public.hhee_people p LEFT JOIN public.hhee_areas a ON a.id = p.area_id
    WHERE p.active), '[]'::jsonb);
END $$;

-- Asigna (o quita, con p_person NULL) el auxiliar de una ruta programada
CREATE OR REPLACE FUNCTION public.set_route_auxiliary(p_dispatch uuid, p_person uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d record; p public.hhee_people; v_busy text; v_old uuid;
BEGIN
  IF NOT public.has_tms_permission('despacho') THEN RETURN jsonb_build_object('success', false, 'error', 'Solo quien programa rutas asigna el auxiliar'); END IF;
  SELECT x.id, x.status, x.site_id, x.driver_id INTO d FROM public.dispatches x WHERE x.id = p_dispatch;
  IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN RETURN jsonb_build_object('success', false, 'error', 'Despacho inexistente'); END IF;
  IF d.status <> 'PROGRAMADO' THEN RETURN jsonb_build_object('success', false, 'error', 'El auxiliar se asigna mientras la ruta está programada'); END IF;
  IF p_person IS NOT NULL THEN
    SELECT * INTO p FROM public.hhee_people WHERE id = p_person;
    IF p.id IS NULL OR NOT p.active THEN RETURN jsonb_build_object('success', false, 'error', 'La persona no está activa en Personal'); END IF;
    IF p.driver_id IS NOT NULL AND p.driver_id = d.driver_id THEN RETURN jsonb_build_object('success', false, 'error', 'El conductor de la ruta no puede ir también de auxiliar'); END IF;
    v_busy := public.route_person_busy(p.id, p_dispatch);
    IF v_busy IS NOT NULL THEN RETURN jsonb_build_object('success', false, 'error', format('%s ya está en la ruta %s', p.name, v_busy)); END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('route-aux-' || p_dispatch::text, 0));
  SELECT person_id INTO v_old FROM public.route_auxiliaries WHERE dispatch_id = p_dispatch;
  IF p_person IS NULL THEN DELETE FROM public.route_auxiliaries WHERE dispatch_id = p_dispatch;
  ELSE
    INSERT INTO public.route_auxiliaries (dispatch_id, person_id, assigned_by) VALUES (p_dispatch, p_person, auth.uid())
    ON CONFLICT (dispatch_id) DO UPDATE SET person_id = EXCLUDED.person_id, assigned_by = EXCLUDED.assigned_by, assigned_at = now();
  END IF;
  -- Tripulación: el auxiliar con usuario también figura como AUXILIAR (se quita al anterior)
  IF v_old IS DISTINCT FROM p_person THEN
    UPDATE public.dispatch_crew c SET removed_at = now(), removed_by = auth.uid()
    WHERE c.dispatch_id = p_dispatch AND c.removed_at IS NULL AND c.crew_role = 'AUXILIAR'
      AND c.profile_id IN (SELECT profile_id FROM public.hhee_people WHERE id = v_old AND profile_id IS NOT NULL);
  END IF;
  IF p.profile_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.dispatch_crew c WHERE c.dispatch_id = p_dispatch AND c.profile_id = p.profile_id AND c.removed_at IS NULL) THEN
    INSERT INTO public.dispatch_crew (dispatch_id, profile_id, crew_role, assigned_by) VALUES (p_dispatch, p.profile_id, 'AUXILIAR', auth.uid());
  END IF;
  RETURN jsonb_build_object('success', true, 'person_id', p_person);
END $$;

-- Rutas del día de un conductor: también las que acompaña como auxiliar elegido de Personal
CREATE OR REPLACE FUNCTION public.hhee_driver_routes(p_driver uuid, p_date date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', d.id, 'number', COALESCE(j->>'dispatch_number', j->>'legacy_dispatch_number'),
      'plate', d.vehicle_plate, 'status', j->>'status', 'departure', COALESCE(j->>'scheduled_departure', j->>'departure_time', j->>'scheduled_date'))
    ORDER BY COALESCE(j->>'scheduled_departure', j->>'departure_time', j->>'scheduled_date', j->>'created_at')), '[]'::jsonb)
  FROM public.dispatches d, LATERAL to_jsonb(d) j
  WHERE (d.driver_id = p_driver OR EXISTS (SELECT 1 FROM public.dispatch_crew c JOIN public.drivers dr ON dr.profile_id = c.profile_id
          WHERE dr.id = p_driver AND c.dispatch_id = d.id AND c.removed_at IS NULL)
       OR EXISTS (SELECT 1 FROM public.route_auxiliaries a JOIN public.hhee_people hp ON hp.id = a.person_id WHERE a.dispatch_id = d.id AND hp.driver_id = p_driver))
    AND d.vehicle_plate IS NOT NULL
    AND upper(COALESCE(j->>'status', '')) NOT IN ('CANCELADO', 'CANCELADA', 'ANULADO', 'ANULADA', 'BORRADOR')
    AND public.fe_jdate(j, ARRAY['scheduled_departure', 'scheduled_date', 'dispatch_date', 'departure_date', 'departure_time', 'started_at', 'created_at']) = p_date;
$$;

-- Solicitud automática: incluye al auxiliar de Personal (con o sin usuario)
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
           UNION ALL SELECT NULL, NULL, (SELECT a.person_id FROM public.route_auxiliaries a WHERE a.dispatch_id = p_dispatch), 1
           UNION ALL SELECT NULL, x.profile_id, NULL, 2 FROM public.dispatch_crew x WHERE x.dispatch_id = p_dispatch AND x.removed_at IS NULL AND x.crew_role IN ('AUXILIAR', 'AYUDANTE')
           ORDER BY ord LOOP
    CONTINUE WHEN c.ord = 1 AND c.person_id IS NULL;
    v_person := COALESCE(c.person_id, public.hhee_person_for(c.driver_id, c.profile_id, v_area));
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

REVOKE ALL ON FUNCTION public.route_person_busy(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_route_auxiliary(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_route_auxiliary(uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.list_route_assistants(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_route_assistants(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
