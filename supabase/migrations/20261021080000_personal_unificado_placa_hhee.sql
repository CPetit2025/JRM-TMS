-- ============================================================
-- Personal unificado por DNI y placa de la ruta en las HHEE de conductores
-- ============================================================
-- 1. Una persona = un DNI. La ficha de Personal (HHEE) se enlaza con el conductor de Flota (drivers) o con el
--    trabajador de Maestros (profiles) que tenga el mismo DNI, y de ahí toma nombre y DNI: Flota manda para los
--    conductores y Maestros para el resto. Si se corrige el nombre o el DNI en Flota / Maestros, la ficha se actualiza
--    sola. La remuneración sigue solo en HHEE (privada). hhee_people_unify: diagnóstico, enlace y alta de fichas
--    para conductores que no la tienen.
-- 2. Horas extras de un conductor: la placa sale de su ruta asignada ese día (despacho). Con varias rutas se elige
--    una; sin ruta (o si usó otra unidad) se indica la placa a mano con motivo. Queda en el informe y el consolidado.
-- Producción no coincide con las migraciones: drivers, dispatches y profiles se leen con to_jsonb (columnas opcionales:
-- document_number / document_id, is_active, fechas del despacho).
BEGIN;
SET LOCAL lock_timeout = '60s';

ALTER TABLE public.hhee_people ADD COLUMN IF NOT EXISTS driver_id uuid REFERENCES public.drivers(id);
CREATE UNIQUE INDEX IF NOT EXISTS hhee_people_driver_uidx ON public.hhee_people (driver_id) WHERE driver_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hhee_people_driver_idx ON public.hhee_people (driver_id);

ALTER TABLE public.hhee_lines
  ADD COLUMN IF NOT EXISTS driver_dispatch_id uuid REFERENCES public.dispatches(id),
  ADD COLUMN IF NOT EXISTS dispatch_number text,
  ADD COLUMN IF NOT EXISTS vehicle_plate text CHECK (vehicle_plate IS NULL OR length(vehicle_plate) <= 20),
  ADD COLUMN IF NOT EXISTS plate_source text CHECK (plate_source IS NULL OR plate_source IN ('RUTA', 'MANUAL')),
  ADD COLUMN IF NOT EXISTS plate_reason text CHECK (plate_reason IS NULL OR length(plate_reason) <= 300);
CREATE INDEX IF NOT EXISTS hhee_lines_dispatch_idx ON public.hhee_lines (driver_dispatch_id);

-- DNI normalizado (sin espacios, puntos ni guiones)
CREATE OR REPLACE FUNCTION public.hhee_norm_doc(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT NULLIF(regexp_replace(upper(COALESCE(p, '')), '[^0-9A-Z]', '', 'g'), '');
$$;

-- Datos maestros de un conductor (Flota) y de un trabajador (Maestros)
CREATE OR REPLACE FUNCTION public.hhee_driver_master(p_driver uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('name', NULLIF(btrim(regexp_replace(concat_ws(' ', j->>'first_name', j->>'last_name'), '\s+', ' ', 'g')), ''),
    'doc', public.hhee_norm_doc(COALESCE(j->>'document_number', j->>'document_id')), 'profile_id', j->>'profile_id',
    'active', COALESCE((j->>'is_active')::boolean, true))
  FROM public.drivers d, LATERAL to_jsonb(d) j WHERE d.id = p_driver;
$$;
CREATE OR REPLACE FUNCTION public.hhee_profile_master(p_profile uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('name', COALESCE(NULLIF(btrim(regexp_replace(concat_ws(' ', j->>'first_name', j->>'last_name'), '\s+', ' ', 'g')), ''), NULLIF(btrim(j->>'full_name'), '')),
    'doc', public.hhee_norm_doc(j->>'document_number'))
  FROM public.profiles p, LATERAL to_jsonb(p) j WHERE p.id = p_profile;
$$;

-- Enlace por DNI y datos maestros en cada alta o edición de la ficha (también en la importación Excel)
CREATE OR REPLACE FUNCTION public.hhee_people_master_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_doc text := public.hhee_norm_doc(NEW.document_number); v_ids uuid[]; m jsonb;
BEGIN
  IF NEW.driver_id IS NULL AND v_doc IS NOT NULL THEN
    SELECT array_agg(d.id) INTO v_ids FROM public.drivers d, LATERAL to_jsonb(d) j
    WHERE public.hhee_norm_doc(COALESCE(j->>'document_number', j->>'document_id')) = v_doc
      AND NOT EXISTS (SELECT 1 FROM public.hhee_people x WHERE x.driver_id = d.id AND x.id <> NEW.id);
    IF cardinality(v_ids) = 1 THEN NEW.driver_id := v_ids[1]; END IF;
  END IF;
  IF NEW.driver_id IS NOT NULL THEN
    m := public.hhee_driver_master(NEW.driver_id);
    IF NEW.profile_id IS NULL AND m->>'profile_id' IS NOT NULL THEN NEW.profile_id := (m->>'profile_id')::uuid; END IF;
  ELSIF NEW.profile_id IS NULL AND v_doc IS NOT NULL THEN
    SELECT array_agg(p.id) INTO v_ids FROM public.profiles p WHERE public.hhee_norm_doc(to_jsonb(p)->>'document_number') = v_doc;
    IF cardinality(v_ids) = 1 THEN NEW.profile_id := v_ids[1]; END IF;
  END IF;
  IF m IS NULL AND NEW.profile_id IS NOT NULL THEN m := public.hhee_profile_master(NEW.profile_id); END IF;
  -- Flota (o Maestros) manda en nombre y DNI cuando tiene el dato
  IF length(m->>'name') BETWEEN 3 AND 160 THEN NEW.name := m->>'name'; END IF;
  IF length(m->>'doc') BETWEEN 6 AND 20 AND NOT EXISTS (SELECT 1 FROM public.hhee_people x WHERE x.document_number = m->>'doc' AND x.id <> NEW.id) THEN
    NEW.document_number := m->>'doc'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hhee_people_master ON public.hhee_people;
CREATE TRIGGER hhee_people_master BEFORE INSERT OR UPDATE ON public.hhee_people FOR EACH ROW EXECUTE FUNCTION public.hhee_people_master_trg();

-- Cambios en Flota o Maestros llegan a la ficha. Nunca bloquean la edición del conductor o del usuario.
CREATE OR REPLACE FUNCTION public.hhee_people_follow_driver_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END; n jsonb := to_jsonb(NEW);
BEGIN
  IF o IS NULL OR (o->>'first_name', o->>'last_name', o->>'document_number', o->>'document_id', o->>'profile_id')
     IS DISTINCT FROM (n->>'first_name', n->>'last_name', n->>'document_number', n->>'document_id', n->>'profile_id') THEN
    BEGIN
      UPDATE public.hhee_people SET updated_at = now() WHERE driver_id = NEW.id
        OR (driver_id IS NULL AND public.hhee_norm_doc(document_number) = public.hhee_norm_doc(COALESCE(n->>'document_number', n->>'document_id')));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hhee_people_follow_driver ON public.drivers;
CREATE TRIGGER hhee_people_follow_driver AFTER INSERT OR UPDATE ON public.drivers FOR EACH ROW EXECUTE FUNCTION public.hhee_people_follow_driver_trg();

CREATE OR REPLACE FUNCTION public.hhee_people_follow_profile_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o jsonb := to_jsonb(OLD); n jsonb := to_jsonb(NEW);
BEGIN
  IF (o->>'first_name', o->>'last_name', o->>'full_name', o->>'document_number') IS DISTINCT FROM (n->>'first_name', n->>'last_name', n->>'full_name', n->>'document_number') THEN
    BEGIN
      UPDATE public.hhee_people SET updated_at = now() WHERE profile_id = NEW.id AND driver_id IS NULL;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hhee_people_follow_profile ON public.profiles;
CREATE TRIGGER hhee_people_follow_profile AFTER UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.hhee_people_follow_profile_trg();

-- Ficha pública: indica de dónde salen nombre y DNI
CREATE OR REPLACE FUNCTION public.hhee_flow_person_json(p public.hhee_people, p_remuneration boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name, 'document_number', p.document_number,
    'position', p.position, 'area_id', p.area_id, 'area_name', (SELECT name FROM public.hhee_areas WHERE id = p.area_id),
    'active', p.active, 'daily_hours', p.daily_hours, 'monthly_hours', p.monthly_hours, 'divisor_confirmed', p.divisor_confirmed,
    'effective_from', p.effective_from, 'rate_ready', p.divisor_confirmed AND p.base_hour_cost IS NOT NULL, 'updated_at', p.updated_at,
    'driver_id', p.driver_id, 'master', CASE WHEN p.driver_id IS NOT NULL THEN 'FLOTA' WHEN p.profile_id IS NOT NULL THEN 'MAESTROS' END)
  || CASE WHEN p_remuneration THEN jsonb_build_object('base_hour_cost', p.base_hour_cost, 'remuneration_concepts', p.remuneration_concepts)
     ELSE '{}'::jsonb END;
$$;

-- Unificar: diagnóstico por DNI (report), enlace y actualización desde Flota / Maestros (link) y fichas para
-- conductores activos sin ficha (create_drivers, en el área indicada; remuneración pendiente)
CREATE OR REPLACE FUNCTION public.hhee_people_unify(p jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_action text := COALESCE(p->>'action', 'report'); v_area uuid := NULLIF(p->>'area_id', '')::uuid; v_n int := 0; v_before int; v_after int;
  v_rows jsonb; v_counts jsonb;
BEGIN
  IF NOT (public.hhee_flow_caps()->>'people')::boolean THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para administrar el personal'); END IF;
  IF v_action = 'link' THEN
    SELECT count(*) INTO v_before FROM public.hhee_people WHERE driver_id IS NOT NULL OR profile_id IS NOT NULL;
    UPDATE public.hhee_people SET updated_at = now() WHERE public.hhee_can(area_id, 'config');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    SELECT count(*) INTO v_after FROM public.hhee_people WHERE driver_id IS NOT NULL OR profile_id IS NOT NULL;
    RETURN jsonb_build_object('success', true, 'reviewed', v_n, 'linked_new', v_after - v_before);
  ELSIF v_action = 'create_drivers' THEN
    IF v_area IS NULL OR NOT public.hhee_can(v_area, 'config') THEN RETURN jsonb_build_object('success', false, 'error', 'Elija un área autorizada'); END IF;
    INSERT INTO public.hhee_people (code, name, document_number, position, area_id, active, daily_hours, monthly_hours, divisor_confirmed, remuneration_concepts, driver_id)
    SELECT CASE WHEN EXISTS (SELECT 1 FROM public.hhee_people x WHERE x.code = m.doc) THEN left('C-' || m.doc, 50) ELSE m.doc END,
      m.name, m.doc, 'Conductor', v_area, true, 8, 240, false, '[]'::jsonb, m.id
    FROM (SELECT d.id, x->>'name' AS name, x->>'doc' AS doc FROM public.drivers d, LATERAL public.hhee_driver_master(d.id) x
          WHERE (x->>'active')::boolean AND length(x->>'doc') BETWEEN 6 AND 20 AND length(x->>'name') BETWEEN 3 AND 160) m
    WHERE NOT EXISTS (SELECT 1 FROM public.hhee_people x WHERE x.driver_id = m.id OR public.hhee_norm_doc(x.document_number) = m.doc)
      AND NOT EXISTS (SELECT 1 FROM public.hhee_people x WHERE x.code = m.doc AND EXISTS (SELECT 1 FROM public.hhee_people y WHERE y.code = left('C-' || m.doc, 50)));
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN jsonb_build_object('success', true, 'created', v_n);
  ELSIF v_action <> 'report' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Acción inválida');
  END IF;

  WITH dr AS (
    SELECT d.id, x->>'name' AS name, x->>'doc' AS doc, (x->>'active')::boolean AS active FROM public.drivers d, LATERAL public.hhee_driver_master(d.id) x
  ), hp AS (
    SELECT p.id, p.code, p.name, p.document_number, public.hhee_norm_doc(p.document_number) AS doc, p.driver_id, p.profile_id, p.active,
      (SELECT name FROM public.hhee_areas WHERE id = p.area_id) AS area
    FROM public.hhee_people p WHERE public.hhee_can(p.area_id, 'config') OR public.hhee_can(p.area_id, 'read')
  ), issues AS (
    -- Ficha con DNI de un conductor pero sin enlace (DNI repetido en Flota o ya enlazado a otra ficha)
    SELECT 'COINCIDE_SIN_ENLACE' AS kind, hp.doc, hp.id AS person_id, hp.code, hp.name, hp.area, dr.id AS driver_id, dr.name AS driver_name
    FROM hp JOIN dr ON dr.doc = hp.doc WHERE hp.driver_id IS NULL
    UNION ALL
    SELECT 'NOMBRE_DISTINTO', hp.doc, hp.id, hp.code, hp.name, hp.area, dr.id, dr.name
    FROM hp JOIN dr ON dr.id = hp.driver_id WHERE lower(hp.name) <> lower(COALESCE(dr.name, hp.name))
    UNION ALL
    SELECT 'SIN_DNI', NULL, hp.id, hp.code, hp.name, hp.area, NULL, NULL FROM hp WHERE hp.doc IS NULL AND hp.active
    UNION ALL
    SELECT 'CONDUCTOR_SIN_FICHA', dr.doc, NULL, NULL, NULL, NULL, dr.id, dr.name FROM dr
    WHERE dr.active AND NOT EXISTS (SELECT 1 FROM hp WHERE hp.driver_id = dr.id OR hp.doc = dr.doc)
    UNION ALL
    SELECT 'DNI_REPETIDO_FLOTA', dr.doc, NULL, NULL, NULL, NULL, dr.id, dr.name FROM dr
    WHERE dr.doc IS NOT NULL AND (SELECT count(*) FROM dr d2 WHERE d2.doc = dr.doc) > 1
  )
  SELECT jsonb_build_object(
      'people', (SELECT count(*) FROM hp), 'linked_driver', (SELECT count(*) FROM hp WHERE driver_id IS NOT NULL),
      'linked_profile', (SELECT count(*) FROM hp WHERE driver_id IS NULL AND profile_id IS NOT NULL),
      'drivers_active', (SELECT count(*) FROM dr WHERE active),
      'by_kind', COALESCE((SELECT jsonb_object_agg(kind, n) FROM (SELECT kind, count(*) n FROM issues GROUP BY 1) k), '{}'::jsonb)),
    COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.kind, COALESCE(i.name, i.driver_name)) FROM (SELECT * FROM issues LIMIT 1000) i), '[]'::jsonb)
  INTO v_counts, v_rows;
  RETURN jsonb_build_object('success', true, 'summary', v_counts, 'rows', v_rows);
END $$;

-- Rutas (despachos) de un conductor en una fecha, para tomar la placa
CREATE OR REPLACE FUNCTION public.hhee_driver_routes(p_driver uuid, p_date date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', d.id, 'number', COALESCE(j->>'dispatch_number', j->>'legacy_dispatch_number'),
      'plate', d.vehicle_plate, 'status', j->>'status', 'departure', COALESCE(j->>'scheduled_departure', j->>'departure_time', j->>'scheduled_date'))
    ORDER BY COALESCE(j->>'scheduled_departure', j->>'departure_time', j->>'scheduled_date', j->>'created_at')), '[]'::jsonb)
  FROM public.dispatches d, LATERAL to_jsonb(d) j
  WHERE d.driver_id = p_driver AND d.vehicle_plate IS NOT NULL
    AND upper(COALESCE(j->>'status', '')) NOT IN ('CANCELADO', 'CANCELADA', 'ANULADO', 'ANULADA', 'BORRADOR')
    AND public.fe_jdate(j, ARRAY['scheduled_departure', 'scheduled_date', 'dispatch_date', 'departure_date', 'departure_time', 'started_at', 'created_at']) = p_date;
$$;

-- Enlazar ya las fichas existentes por DNI y tomar los datos de Flota / Maestros
UPDATE public.hhee_people SET updated_at = now();

-- Guardar solicitud: además del cálculo legal, la placa de la ruta del conductor
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

-- Informe y detalle: placa, ruta y origen (ruta asignada o indicada a mano con motivo)
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
        'vehicle_plate', l.vehicle_plate, 'dispatch_number', l.dispatch_number, 'plate_source', l.plate_source, 'plate_reason', l.plate_reason,
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
        'dispatch_id', l.driver_dispatch_id, 'vehicle_plate', l.vehicle_plate, 'dispatch_number', l.dispatch_number, 'plate_source', l.plate_source, 'plate_reason', l.plate_reason,
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

-- Vista previa: rutas del conductor ese día para elegir la placa
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
      out := out || (jsonb_build_object('person_id', v_person.id, 'minutes', v_min, 'driver', v_person.driver_id IS NOT NULL,
        'routes', CASE WHEN v_person.driver_id IS NOT NULL THEN public.hhee_driver_routes(v_person.driver_id, v_date) END) || v_split);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'holiday', public.hhee_pe_holiday(v_date), 'isodow', extract(isodow FROM v_date)::int, 'lines', out);
END $$;

REVOKE ALL ON FUNCTION public.hhee_driver_master(uuid), public.hhee_profile_master(uuid), public.hhee_driver_routes(uuid, date),
  public.hhee_people_master_trg(), public.hhee_people_follow_driver_trg(), public.hhee_people_follow_profile_trg() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hhee_norm_doc(text), public.hhee_people_unify(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hhee_people_unify(jsonb), public.hhee_norm_doc(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
