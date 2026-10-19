-- ============================================================
-- HHEE simple: Personal → Solicitud → Aprobación (informe PDF + correo) → Panel gerencial
-- ============================================================
-- 1. Personal: ficha con identificación, jornada de referencia (horas diarias y divisor mensual confirmado),
--    conceptos remunerativos (computables o no) y vigencia. La tarifa base = conceptos computables ÷ divisor
--    (hhee_base_rate). Cada cambio remunerativo queda en el historial; las solicitudes guardan la tarifa usada.
-- 2. Solicitud: el Supervisor de Transporte o Despacho registra actividad, causa, justificación y por trabajador
--    el horario, el descanso y las horas al 25 %, 35 % y 100 %. Se calcula el costo aproximado.
-- 3. Aprobación: el Jefe de Distribución o el Administrador aprueba, observa (vuelve a corregir) o rechaza. Al
--    aprobar se guarda una versión fija del informe (hhee_authorizations), base del PDF y del correo. Si se
--    cambian personas u horas después, la solicitud vuelve a borrador y requiere una nueva aprobación.
-- 4. Panel: horas y costo aproximado AUTORIZADOS (no son horas trabajadas ni costo de planilla).
-- Las funciones anteriores (asistencia RR. HH., validación, acciones) se conservan para el historial.
BEGIN;
SET LOCAL lock_timeout = '60s';

-- Ficha de personal
ALTER TABLE public.hhee_people
  ADD COLUMN IF NOT EXISTS document_number text CHECK (document_number IS NULL OR length(btrim(document_number)) BETWEEN 6 AND 20),
  ADD COLUMN IF NOT EXISTS position text CHECK (position IS NULL OR length(btrim(position)) <= 100),
  ADD COLUMN IF NOT EXISTS daily_hours numeric(4,2) NOT NULL DEFAULT 8 CHECK (daily_hours > 0 AND daily_hours <= 24),
  ADD COLUMN IF NOT EXISTS divisor_confirmed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS effective_from date,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS public.hhee_people_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   uuid NOT NULL REFERENCES public.hhee_people(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid REFERENCES public.profiles(id),
  effective_from date,
  monthly_hours numeric(8,2) NOT NULL,
  daily_hours numeric(4,2) NOT NULL,
  divisor_confirmed boolean NOT NULL,
  remuneration_concepts jsonb NOT NULL,
  base_hour_cost numeric(14,4)
);
CREATE INDEX IF NOT EXISTS hhee_people_history_person_idx ON public.hhee_people_history (person_id, recorded_at DESC);

-- Solicitud: horas por recargo y costo aproximado al momento de solicitar / aprobar
ALTER TABLE public.hhee_lines
  ADD COLUMN IF NOT EXISTS plan_minutes_25 integer CHECK (plan_minutes_25 BETWEEN 0 AND 960),
  ADD COLUMN IF NOT EXISTS plan_minutes_35 integer CHECK (plan_minutes_35 BETWEEN 0 AND 960),
  ADD COLUMN IF NOT EXISTS plan_minutes_100 integer CHECK (plan_minutes_100 BETWEEN 0 AND 960),
  ADD COLUMN IF NOT EXISTS plan_rate numeric(14,4) CHECK (plan_rate >= 0),
  ADD COLUMN IF NOT EXISTS plan_cost numeric(16,2) CHECK (plan_cost >= 0);

-- Estado «observada»: el aprobador la devuelve para corregir
ALTER TABLE public.hhee_requests DROP CONSTRAINT IF EXISTS hhee_requests_approval_check;
ALTER TABLE public.hhee_requests ADD CONSTRAINT hhee_requests_approval_check
  CHECK (approval IN ('PENDIENTE', 'APROBADA', 'OBSERVADA', 'RECHAZADA'));

-- Versiones del informe de autorización (fijas: base del PDF y del correo)
CREATE TABLE IF NOT EXISTS public.hhee_authorizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES public.hhee_requests(id),
  revision    integer NOT NULL CHECK (revision >= 1),
  approved_by uuid NOT NULL REFERENCES public.profiles(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  snapshot    jsonb NOT NULL,
  UNIQUE (request_id, revision)
);

ALTER TABLE public.hhee_people_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hhee_authorizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.hhee_people_history;
CREATE POLICY security_active_account ON public.hhee_people_history AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.hhee_authorizations;
CREATE POLICY security_active_account ON public.hhee_authorizations AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.hhee_people_history FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.hhee_authorizations FROM PUBLIC, anon, authenticated;

-- Nombre visible de un usuario (columnas del perfil opcionales en producción)
CREATE OR REPLACE FUNCTION public.hhee_flow_name(p_user uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(NULLIF(btrim(concat_ws(' ', to_jsonb(p)->>'first_name', to_jsonb(p)->>'last_name')), ''),
                  NULLIF(btrim(to_jsonb(p)->>'full_name'), ''), NULLIF(split_part(to_jsonb(p)->>'email', '@', 1), ''), 'Usuario')
  FROM public.profiles p WHERE p.id = p_user;
$$;

-- Capacidades del usuario en el módulo
CREATE OR REPLACE FUNCTION public.hhee_flow_caps() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'request', EXISTS (SELECT 1 FROM public.hhee_areas a WHERE public.hhee_can(a.id, 'request')),
    'approve', EXISTS (SELECT 1 FROM public.hhee_areas a WHERE public.hhee_can(a.id, 'approve')),
    'people', public.is_active_tms_user() AND (public.is_tms_admin() OR public.has_tms_permission('hhee-config')),
    'costs', public.is_active_tms_user() AND (public.is_tms_admin() OR public.has_tms_permission('hhee-costos')
      OR public.has_tms_permission('hhee-aprobar') OR public.has_tms_read_permission('hhee-gerencia')),
    'remuneration', public.is_active_tms_user() AND (public.is_tms_admin() OR public.has_tms_permission('hhee-config')
      OR public.has_tms_read_permission('hhee-costos')),
    'config', public.is_active_tms_user() AND (public.is_tms_admin() OR public.has_tms_permission('hhee-config')),
    'admin', public.is_tms_admin());
$$;

-- Tarifa vigente utilizable (solo con divisor confirmado)
CREATE OR REPLACE FUNCTION public.hhee_flow_rate(p_person uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN divisor_confirmed THEN base_hour_cost END FROM public.hhee_people WHERE id = p_person;
$$;
CREATE OR REPLACE FUNCTION public.hhee_flow_cost(p_rate numeric, p25 integer, p35 integer, p100 integer) RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p_rate IS NULL THEN NULL
    ELSE round(p_rate * (COALESCE(p25, 0) * 1.25 + COALESCE(p35, 0) * 1.35 + COALESCE(p100, 0) * 2.0) / 60.0, 2) END;
$$;

-- Ficha pública del trabajador (sin remuneración salvo permiso)
CREATE OR REPLACE FUNCTION public.hhee_flow_person_json(p public.hhee_people, p_remuneration boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name, 'document_number', p.document_number,
    'position', p.position, 'area_id', p.area_id, 'area_name', (SELECT name FROM public.hhee_areas WHERE id = p.area_id),
    'active', p.active, 'daily_hours', p.daily_hours, 'monthly_hours', p.monthly_hours, 'divisor_confirmed', p.divisor_confirmed,
    'effective_from', p.effective_from, 'rate_ready', p.divisor_confirmed AND p.base_hour_cost IS NOT NULL, 'updated_at', p.updated_at)
  || CASE WHEN p_remuneration THEN jsonb_build_object('base_hour_cost', p.base_hour_cost, 'remuneration_concepts', p.remuneration_concepts)
     ELSE '{}'::jsonb END;
$$;

CREATE OR REPLACE FUNCTION public.hhee_flow_context() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c jsonb := public.hhee_flow_caps(); s public.hhee_settings;
BEGIN
  IF NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a HHEE'); END IF;
  SELECT * INTO s FROM public.hhee_settings ORDER BY id LIMIT 1;
  RETURN jsonb_build_object('success', true, 'user_id', auth.uid(), 'caps', c,
    'areas', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'site_name', (SELECT name FROM public.sites WHERE id = a.site_id),
        'can_request', public.hhee_can(a.id, 'request'), 'can_approve', public.hhee_can(a.id, 'approve')) ORDER BY a.name)
      FROM public.hhee_areas a WHERE a.module_enabled AND (public.hhee_can(a.id, 'read') OR public.hhee_can(a.id, 'config'))), '[]'::jsonb),
    'causes', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name) ORDER BY name) FROM public.hhee_causes WHERE active), '[]'::jsonb),
    'people', COALESCE((SELECT jsonb_agg(public.hhee_flow_person_json(p, (c->>'remuneration')::boolean) ORDER BY p.active DESC, p.name)
      FROM public.hhee_people p WHERE public.hhee_can(p.area_id, 'read') OR public.hhee_can(p.area_id, 'config')), '[]'::jsonb),
    'settings', jsonb_build_object('recurrence_days', COALESCE(s.recurrence_days, 28), 'recurrence_events', COALESCE(s.recurrence_events, 3),
      'report_to', COALESCE(s.report_to, ''), 'report_cc', COALESCE(s.report_cc, '')));
END $$;

-- Alta / edición de personal
CREATE OR REPLACE FUNCTION public.hhee_flow_person_save(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid := NULLIF(p->>'id', '')::uuid; v_old public.hhee_people; v_area uuid := NULLIF(p->>'area_id', '')::uuid;
  v_code text := upper(btrim(COALESCE(p->>'code', ''))); v_name text := btrim(regexp_replace(COALESCE(p->>'name', ''), '\s+', ' ', 'g'));
  v_doc text := NULLIF(btrim(COALESCE(p->>'document_number', '')), ''); v_pos text := NULLIF(btrim(COALESCE(p->>'position', '')), '');
  v_concepts jsonb := COALESCE(p->'remuneration_concepts', '[]'::jsonb); v_monthly numeric; v_daily numeric;
  v_confirmed boolean := COALESCE((p->>'divisor_confirmed')::boolean, false); v_from date := NULLIF(p->>'effective_from', '')::date;
  v_rate numeric; v_row public.hhee_people; v_changed boolean;
BEGIN
  IF NOT (public.hhee_flow_caps()->>'people')::boolean THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para registrar personal'); END IF;
  IF v_area IS NULL OR NOT public.hhee_can(v_area, 'config') THEN RETURN jsonb_build_object('success', false, 'error', 'Elija un área autorizada'); END IF;
  IF v_code !~ '^[A-Z0-9][A-Z0-9._-]{0,49}$' THEN RETURN jsonb_build_object('success', false, 'error', 'Código inválido (letras, números, punto o guion)'); END IF;
  IF length(v_name) < 3 OR length(v_name) > 160 THEN RETURN jsonb_build_object('success', false, 'error', 'Ingrese nombres y apellidos'); END IF;
  IF v_doc IS NOT NULL AND v_doc !~ '^[0-9A-Za-z-]{6,20}$' THEN RETURN jsonb_build_object('success', false, 'error', 'Documento de identidad inválido'); END IF;
  BEGIN
    v_monthly := COALESCE(NULLIF(p->>'monthly_hours', '')::numeric, 240); v_daily := COALESCE(NULLIF(p->>'daily_hours', '')::numeric, 8);
  EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('success', false, 'error', 'Revise las horas de referencia'); END;
  IF v_daily <= 0 OR v_daily > 24 OR v_monthly <= 0 OR v_monthly > 744 THEN RETURN jsonb_build_object('success', false, 'error', 'Revise las horas diarias (hasta 24) y el divisor mensual (hasta 744)'); END IF;
  BEGIN
    v_rate := public.hhee_base_rate(v_concepts, round(v_monthly, 2));
  EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('success', false, 'error', SQLERRM); END;
  IF EXISTS (SELECT 1 FROM public.hhee_people x WHERE x.code = v_code AND x.id IS DISTINCT FROM v_id) THEN
    RETURN jsonb_build_object('success', false, 'error', format('El código %s ya está registrado', v_code)); END IF;
  IF v_doc IS NOT NULL AND EXISTS (SELECT 1 FROM public.hhee_people x WHERE x.document_number = v_doc AND x.id IS DISTINCT FROM v_id) THEN
    RETURN jsonb_build_object('success', false, 'error', format('El documento %s ya pertenece a otro trabajador', v_doc)); END IF;
  IF v_id IS NOT NULL THEN
    SELECT * INTO v_old FROM public.hhee_people WHERE id = v_id FOR UPDATE;
    IF v_old.id IS NULL OR NOT public.hhee_can(v_old.area_id, 'config') THEN RETURN jsonb_build_object('success', false, 'error', 'Trabajador no encontrado'); END IF;
    UPDATE public.hhee_people SET code = v_code, name = v_name, document_number = v_doc, position = v_pos, area_id = v_area,
      active = COALESCE((p->>'active')::boolean, active), daily_hours = round(v_daily, 2), monthly_hours = round(v_monthly, 2),
      divisor_confirmed = v_confirmed, effective_from = v_from, remuneration_concepts = v_concepts, base_hour_cost = v_rate, updated_at = now()
    WHERE id = v_id RETURNING * INTO v_row;
  ELSE
    INSERT INTO public.hhee_people (code, name, document_number, position, area_id, active, daily_hours, monthly_hours, divisor_confirmed,
      effective_from, remuneration_concepts, base_hour_cost)
    VALUES (v_code, v_name, v_doc, v_pos, v_area, COALESCE((p->>'active')::boolean, true), round(v_daily, 2), round(v_monthly, 2), v_confirmed,
      v_from, v_concepts, v_rate) RETURNING * INTO v_row;
  END IF;
  v_changed := v_old.id IS NULL OR v_old.remuneration_concepts IS DISTINCT FROM v_row.remuneration_concepts
    OR v_old.monthly_hours IS DISTINCT FROM v_row.monthly_hours OR v_old.daily_hours IS DISTINCT FROM v_row.daily_hours
    OR v_old.divisor_confirmed IS DISTINCT FROM v_row.divisor_confirmed OR v_old.effective_from IS DISTINCT FROM v_row.effective_from;
  IF v_changed THEN
    INSERT INTO public.hhee_people_history (person_id, recorded_by, effective_from, monthly_hours, daily_hours, divisor_confirmed, remuneration_concepts, base_hour_cost)
    VALUES (v_row.id, auth.uid(), v_row.effective_from, v_row.monthly_hours, v_row.daily_hours, v_row.divisor_confirmed, v_row.remuneration_concepts, v_row.base_hour_cost);
  END IF;
  RETURN jsonb_build_object('success', true, 'person', public.hhee_flow_person_json(v_row, true), 'history', v_changed);
END $$;

-- Importación desde Excel: una fila por trabajador; el código identifica al existente
CREATE OR REPLACE FUNCTION public.hhee_flow_people_import(p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r jsonb; i int := 0; res jsonb; out jsonb := '[]'::jsonb; ok int := 0; v_id uuid;
BEGIN
  IF NOT (public.hhee_flow_caps()->>'people')::boolean THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para registrar personal'); END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) > 500 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Envíe hasta 500 filas'); END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    i := i + 1;
    SELECT id INTO v_id FROM public.hhee_people WHERE code = upper(btrim(COALESCE(r->>'code', '')));
    BEGIN
      res := public.hhee_flow_person_save(r || CASE WHEN v_id IS NOT NULL THEN jsonb_build_object('id', v_id) ELSE '{}'::jsonb END);
    EXCEPTION WHEN OTHERS THEN res := jsonb_build_object('success', false, 'error', SQLERRM); END;
    IF (res->>'success')::boolean THEN ok := ok + 1; END IF;
    out := out || jsonb_build_object('row', i, 'code', r->>'code', 'ok', (res->>'success')::boolean, 'updated', v_id IS NOT NULL, 'error', res->>'error');
  END LOOP;
  RETURN jsonb_build_object('success', true, 'saved', ok, 'total', i, 'rows', out);
END $$;

CREATE OR REPLACE FUNCTION public.hhee_flow_person_history(p_person uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (public.hhee_flow_caps()->>'remuneration')::boolean
     OR NOT EXISTS (SELECT 1 FROM public.hhee_people WHERE id = p_person AND (public.hhee_can(area_id, 'config') OR public.hhee_can(area_id, 'read'))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para ver la remuneración');
  END IF;
  RETURN jsonb_build_object('success', true, 'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object('recorded_at', h.recorded_at,
      'recorded_by', public.hhee_flow_name(h.recorded_by), 'effective_from', h.effective_from, 'monthly_hours', h.monthly_hours,
      'daily_hours', h.daily_hours, 'divisor_confirmed', h.divisor_confirmed, 'remuneration_concepts', h.remuneration_concepts,
      'base_hour_cost', h.base_hour_cost) ORDER BY h.recorded_at DESC)
    FROM public.hhee_people_history h WHERE h.person_id = p_person), '[]'::jsonb));
END $$;

-- Totales de una solicitud (minutos por recargo y costo aproximado)
CREATE OR REPLACE FUNCTION public.hhee_flow_totals(p_request uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('workers', count(*), 'minutes', COALESCE(sum(planned_minutes), 0),
    'minutes_25', COALESCE(sum(plan_minutes_25), 0), 'minutes_35', COALESCE(sum(plan_minutes_35), 0), 'minutes_100', COALESCE(sum(plan_minutes_100), 0),
    'cost', round(COALESCE(sum(plan_cost), 0), 2), 'pending_cost', count(*) FILTER (WHERE plan_cost IS NULL))
  FROM public.hhee_lines WHERE request_id = p_request;
$$;

-- Guardar solicitud (nueva o corrección). Una solicitud aprobada que se modifica vuelve a borrador.
CREATE OR REPLACE FUNCTION public.hhee_flow_request_save(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid := NULLIF(p->>'id', '')::uuid; r public.hhee_requests; v_area uuid := NULLIF(p->>'area_id', '')::uuid;
  v_cause uuid := NULLIF(p->>'cause_id', '')::uuid; v_date date; l jsonb; v_person public.hhee_people; v_start timestamptz; v_end timestamptz;
  v_break int; m25 int; m35 int; m100 int; v_total int; v_rate numeric; v_seen uuid[] := '{}'; v_ref text := COALESCE(NULLIF(p->>'reference_type', ''), 'SIN_REFERENCIA');
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
      m25 := COALESCE(NULLIF(l->>'minutes_25', '')::int, 0); m35 := COALESCE(NULLIF(l->>'minutes_35', '')::int, 0); m100 := COALESCE(NULLIF(l->>'minutes_100', '')::int, 0);
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Revise el horario y las horas de %', v_person.name; END;
    IF v_start IS NULL OR v_end IS NULL OR v_end <= v_start OR v_end - v_start > interval '16 hours' THEN RAISE EXCEPTION 'Horario inválido para % (inicio antes del fin, máximo 16 h)', v_person.name; END IF;
    IF v_break < 0 OR m25 < 0 OR m35 < 0 OR m100 < 0 THEN RAISE EXCEPTION 'Valores negativos para %', v_person.name; END IF;
    v_total := m25 + m35 + m100;
    IF v_total < 1 OR v_total > 960 THEN RAISE EXCEPTION 'Indique las horas extras de %', v_person.name; END IF;
    IF v_total > extract(epoch FROM v_end - v_start) / 60 - v_break THEN
      RAISE EXCEPTION 'Las horas extras de % superan su horario menos el descanso', v_person.name; END IF;
    v_rate := public.hhee_flow_rate(v_person.id);
    INSERT INTO public.hhee_lines (request_id, person_id, person_name, person_code, planned_start, planned_end, planned_break, planned_minutes,
      plan_minutes_25, plan_minutes_35, plan_minutes_100, plan_rate, plan_cost, estimated_cost)
    VALUES (r.id, v_person.id, v_person.name, v_person.code, v_start, v_end, v_break, v_total, m25, m35, m100, v_rate,
      public.hhee_flow_cost(v_rate, m25, m35, m100), public.hhee_flow_cost(v_rate, m25, m35, m100));
  END LOOP;

  INSERT INTO public.hhee_audit (request_id, actor, event, reason)
  VALUES (r.id, auth.uid(), CASE WHEN v_id IS NULL THEN 'SOLICITUD_REGISTRADA' WHEN v_was_approved THEN 'MODIFICADA_TRAS_APROBACION' ELSE 'SOLICITUD_CORREGIDA' END, NULL);
  RETURN jsonb_build_object('success', true, 'id', r.id, 'version', r.version, 'totals', public.hhee_flow_totals(r.id), 'reapproval', v_was_approved);
END $$;

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
  UPDATE public.hhee_requests SET state = 'SOLICITADA', approval = 'PENDIENTE', submitted_at = now(), version = version + 1, updated_at = now()
  WHERE id = p_id RETURNING * INTO r;
  INSERT INTO public.hhee_audit (request_id, actor, event) VALUES (p_id, auth.uid(), 'PRESENTADA');
  RETURN jsonb_build_object('success', true, 'id', p_id, 'version', r.version);
END $$;

CREATE OR REPLACE FUNCTION public.hhee_flow_cancel(p_id uuid, p_version integer, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.hhee_requests;
BEGIN
  SELECT * INTO r FROM public.hhee_requests WHERE id = p_id FOR UPDATE;
  IF r.id IS NULL OR NOT public.hhee_can(r.area_id, 'request') OR (r.created_by <> auth.uid() AND NOT public.is_tms_admin()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solicitud no encontrada'); END IF;
  IF r.state NOT IN ('BORRADOR', 'SOLICITADA') OR r.approval IN ('APROBADA', 'RECHAZADA') THEN RETURN jsonb_build_object('success', false, 'error', 'Solo se anulan solicitudes no aprobadas'); END IF;
  IF r.version IS DISTINCT FROM p_version THEN RETURN jsonb_build_object('success', false, 'error', 'La solicitud cambió; recargue'); END IF;
  UPDATE public.hhee_requests SET state = 'CANCELADA', version = version + 1, updated_at = now() WHERE id = p_id;
  INSERT INTO public.hhee_audit (request_id, actor, event, reason) VALUES (p_id, auth.uid(), 'ANULADA', NULLIF(btrim(COALESCE(p_reason, '')), ''));
  RETURN jsonb_build_object('success', true, 'id', p_id);
END $$;

-- Informe fijo de la autorización (sin conceptos remunerativos)
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
        'start', l.planned_start, 'end', l.planned_end, 'break_minutes', l.planned_break, 'minutes', l.planned_minutes,
        'minutes_25', l.plan_minutes_25, 'minutes_35', l.plan_minutes_35, 'minutes_100', l.plan_minutes_100, 'cost', l.plan_cost)
      ORDER BY l.person_name) FROM public.hhee_lines l WHERE l.request_id = r.id), '[]'::jsonb),
    'totals', public.hhee_flow_totals(r.id))
  FROM public.hhee_requests r JOIN public.hhee_areas a ON a.id = r.area_id JOIN public.hhee_causes c ON c.id = r.cause_id
  WHERE r.id = p_id;
$$;

-- Decisión del Jefe de Distribución / Administrador
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

-- Fila de la lista de solicitudes
CREATE OR REPLACE FUNCTION public.hhee_flow_row(r public.hhee_requests, p_costs boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('id', r.id, 'sequence', r.sequence, 'version', r.version, 'work_date', r.work_date, 'area_id', r.area_id,
    'area', (SELECT name FROM public.hhee_areas WHERE id = r.area_id), 'cause_id', r.cause_id, 'cause', (SELECT name FROM public.hhee_causes WHERE id = r.cause_id),
    'activity', r.activity, 'state', r.state, 'approval', r.approval, 'created_by', r.created_by, 'requester', public.hhee_flow_name(r.created_by),
    'approver', public.hhee_flow_name(r.approved_by), 'approved_at', r.approved_at, 'submitted_at', r.submitted_at, 'created_at', r.created_at,
    'approval_reason', r.approval_reason, 'revisions', (SELECT count(*) FROM public.hhee_authorizations WHERE request_id = r.id),
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
              OR EXISTS (SELECT 1 FROM public.hhee_lines l WHERE l.request_id = r.id AND lower(l.person_name || ' ' || l.person_code) LIKE '%' || v_q || '%'))
          ORDER BY r.work_date DESC, r.sequence DESC LIMIT 500) r), '[]'::jsonb),
    'pending', (SELECT count(*) FROM public.hhee_requests r WHERE r.state = 'SOLICITADA' AND r.approval = 'PENDIENTE' AND public.hhee_can(r.area_id, 'approve')));
END $$;

CREATE OR REPLACE FUNCTION public.hhee_flow_detail(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.hhee_requests; v_costs boolean := (public.hhee_flow_caps()->>'costs')::boolean;
BEGIN
  SELECT * INTO r FROM public.hhee_requests WHERE id = p_id;
  IF r.id IS NULL OR NOT public.hhee_can(r.area_id, 'read') THEN RETURN jsonb_build_object('success', false, 'error', 'Solicitud no encontrada'); END IF;
  RETURN jsonb_build_object('success', true, 'cost_visible', v_costs,
    'request', public.hhee_flow_row(r, v_costs) || jsonb_build_object('justification', r.justification, 'alternatives', r.alternatives,
      'expected_result', r.expected_result, 'reference_type', r.reference_type, 'reference_code', r.reference_code),
    'lines', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', l.id, 'person_id', l.person_id, 'name', l.person_name, 'code', l.person_code,
        'position', (SELECT position FROM public.hhee_people WHERE id = l.person_id), 'start', l.planned_start, 'end', l.planned_end,
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

-- Panel gerencial: horas y costo aproximado AUTORIZADOS
CREATE OR REPLACE FUNCTION public.hhee_flow_dashboard(p jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_costs boolean := (public.hhee_flow_caps()->>'costs')::boolean; s public.hhee_settings;
  v_to date := COALESCE(NULLIF(p->>'to', '')::date, current_date); v_from date := COALESCE(NULLIF(p->>'from', '')::date, date_trunc('month', current_date)::date);
  v_area uuid := NULLIF(p->>'area_id', '')::uuid; v_cause uuid := NULLIF(p->>'cause_id', '')::uuid;
  v_sup uuid := NULLIF(p->>'supervisor_id', '')::uuid; v_person uuid := NULLIF(p->>'person_id', '')::uuid; v jsonb;
BEGIN
  IF NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso'); END IF;
  IF v_to < v_from OR v_to - v_from > 731 THEN RETURN jsonb_build_object('success', false, 'error', 'Elija un período de hasta 2 años'); END IF;
  SELECT * INTO s FROM public.hhee_settings ORDER BY id LIMIT 1;
  WITH req AS MATERIALIZED (
    SELECT r.* FROM public.hhee_requests r
    WHERE public.hhee_can(r.area_id, 'read') AND r.work_date BETWEEN v_from AND v_to AND r.state <> 'CANCELADA'
      AND (v_area IS NULL OR r.area_id = v_area) AND (v_cause IS NULL OR r.cause_id = v_cause) AND (v_sup IS NULL OR r.created_by = v_sup)
      AND (v_person IS NULL OR EXISTS (SELECT 1 FROM public.hhee_lines l WHERE l.request_id = r.id AND l.person_id = v_person))),
  ok AS MATERIALIZED (SELECT * FROM req WHERE approval = 'APROBADA'),
  ln AS MATERIALIZED (
    SELECT l.*, o.work_date, o.cause_id, o.created_by, o.area_id,
      COALESCE(l.approved_minutes, l.planned_minutes) AS mins,
      CASE WHEN l.plan_minutes_25 IS NULL THEN COALESCE(l.approved_minutes, l.planned_minutes) ELSE 0 END AS m_sin
    FROM public.hhee_lines l JOIN ok o ON o.id = l.request_id WHERE v_person IS NULL OR l.person_id = v_person),
  rec AS (
    SELECT l.person_id, count(DISTINCT l.work_date) AS dias FROM ln l
    WHERE l.work_date > v_to - COALESCE(s.recurrence_days, 28) GROUP BY 1)
  SELECT jsonb_build_object('success', true, 'from', v_from, 'to', v_to, 'cost_visible', v_costs,
    'recurrence_days', COALESCE(s.recurrence_days, 28), 'recurrence_events', COALESCE(s.recurrence_events, 3),
    'metrics', jsonb_build_object(
      'requests', (SELECT count(*) FROM req), 'approved', (SELECT count(*) FROM ok),
      'pending', (SELECT count(*) FROM req WHERE state = 'SOLICITADA' AND approval = 'PENDIENTE'),
      'observed', (SELECT count(*) FROM req WHERE approval = 'OBSERVADA'), 'rejected', (SELECT count(*) FROM req WHERE approval = 'RECHAZADA'),
      'hours', round(COALESCE((SELECT sum(mins) FROM ln), 0) / 60.0, 2),
      'hours_25', round(COALESCE((SELECT sum(plan_minutes_25) FROM ln), 0) / 60.0, 2),
      'hours_35', round(COALESCE((SELECT sum(plan_minutes_35) FROM ln), 0) / 60.0, 2),
      'hours_100', round(COALESCE((SELECT sum(plan_minutes_100) FROM ln), 0) / 60.0, 2),
      'hours_unclassified', round(COALESCE((SELECT sum(m_sin) FROM ln), 0) / 60.0, 2),
      'workers', (SELECT count(DISTINCT person_id) FROM ln),
      'cost', CASE WHEN v_costs THEN round(COALESCE((SELECT sum(COALESCE(plan_cost, estimated_cost)) FROM ln), 0), 2) END,
      'cost_pending_lines', (SELECT count(*) FROM ln WHERE COALESCE(plan_cost, estimated_cost) IS NULL),
      'approval_hours_avg', (SELECT round(avg(extract(epoch FROM approved_at - submitted_at) / 3600.0)::numeric, 1) FROM ok WHERE submitted_at IS NOT NULL),
      'recurrent_workers', (SELECT count(*) FROM rec WHERE dias >= COALESCE(s.recurrence_events, 3))),
    'trend', COALESCE((SELECT jsonb_agg(jsonb_build_object('day', d, 'hours', round(h / 60.0, 2), 'requests', n, 'cost', CASE WHEN v_costs THEN c END) ORDER BY d)
      FROM (SELECT work_date d, sum(mins) h, count(DISTINCT request_id) n, round(sum(COALESCE(plan_cost, estimated_cost)), 2) c FROM ln GROUP BY 1) t), '[]'::jsonb),
    'causes', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', x.cause_id, 'name', c.name, 'hours', round(x.h / 60.0, 2), 'requests', x.n, 'workers', x.w,
        'cost', CASE WHEN v_costs THEN x.c END) ORDER BY x.h DESC)
      FROM (SELECT cause_id, sum(mins) h, count(DISTINCT request_id) n, count(DISTINCT person_id) w, round(sum(COALESCE(plan_cost, estimated_cost)), 2) c FROM ln GROUP BY 1) x
      JOIN public.hhee_causes c ON c.id = x.cause_id), '[]'::jsonb),
    'supervisors', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', x.created_by, 'name', public.hhee_flow_name(x.created_by), 'hours', round(x.h / 60.0, 2),
        'requests', x.n, 'cost', CASE WHEN v_costs THEN x.c END) ORDER BY x.h DESC)
      FROM (SELECT created_by, sum(mins) h, count(DISTINCT request_id) n, round(sum(COALESCE(plan_cost, estimated_cost)), 2) c FROM ln GROUP BY 1) x), '[]'::jsonb),
    'people', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', x.person_id, 'name', x.name, 'code', x.code, 'hours', round(x.h / 60.0, 2), 'days', x.d,
        'recent_days', COALESCE(rc.dias, 0), 'recurrent', COALESCE(rc.dias, 0) >= COALESCE(s.recurrence_events, 3), 'cost', CASE WHEN v_costs THEN x.c END) ORDER BY x.h DESC)
      FROM (SELECT person_id, max(person_name) name, max(person_code) code, sum(mins) h, count(DISTINCT work_date) d, round(sum(COALESCE(plan_cost, estimated_cost)), 2) c
            FROM ln GROUP BY 1 ORDER BY sum(mins) DESC LIMIT 30) x LEFT JOIN rec rc ON rc.person_id = x.person_id), '[]'::jsonb),
    'weekdays', COALESCE((SELECT jsonb_agg(jsonb_build_object('dow', dw, 'hours', round(h / 60.0, 2)) ORDER BY dw)
      FROM (SELECT extract(isodow FROM work_date)::int dw, sum(mins) h FROM ln GROUP BY 1) w), '[]'::jsonb),
    'causes_by_month', COALESCE((SELECT jsonb_agg(jsonb_build_object('month', m, 'cause', c.name, 'hours', round(h / 60.0, 2)) ORDER BY m, c.name)
      FROM (SELECT to_char(work_date, 'YYYY-MM') m, cause_id, sum(mins) h FROM ln GROUP BY 1, 2) x JOIN public.hhee_causes c ON c.id = x.cause_id), '[]'::jsonb)
  ) INTO v;
  RETURN v;
END $$;

-- Permisos de las funciones
REVOKE ALL ON FUNCTION public.hhee_flow_name(uuid), public.hhee_flow_caps(), public.hhee_flow_rate(uuid), public.hhee_flow_cost(numeric, integer, integer, integer),
  public.hhee_flow_person_json(public.hhee_people, boolean), public.hhee_flow_totals(uuid), public.hhee_flow_snapshot(uuid),
  public.hhee_flow_row(public.hhee_requests, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hhee_flow_context(), public.hhee_flow_person_save(jsonb), public.hhee_flow_people_import(jsonb), public.hhee_flow_person_history(uuid),
  public.hhee_flow_request_save(jsonb), public.hhee_flow_submit(uuid, integer), public.hhee_flow_cancel(uuid, integer, text), public.hhee_flow_decide(jsonb),
  public.hhee_flow_list(jsonb), public.hhee_flow_detail(uuid), public.hhee_flow_dashboard(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hhee_flow_context(), public.hhee_flow_person_save(jsonb), public.hhee_flow_people_import(jsonb), public.hhee_flow_person_history(uuid),
  public.hhee_flow_request_save(jsonb), public.hhee_flow_submit(uuid, integer), public.hhee_flow_cancel(uuid, integer, text), public.hhee_flow_decide(jsonb),
  public.hhee_flow_list(jsonb), public.hhee_flow_detail(uuid), public.hhee_flow_dashboard(jsonb) TO authenticated;

-- Roles del flujo: Supervisor de Transporte y de Despacho solicitan; el Jefe de Distribución aprueba, ve costos,
-- el panel y registra personal (el Administrador ya tiene acceso total). Quedan como miembros del área Distribución.
UPDATE public.roles SET permissions = (SELECT jsonb_agg(DISTINCT x) FROM jsonb_array_elements(COALESCE(permissions, '[]'::jsonb) || '["hhee-solicitar:write", "hhee:read"]'::jsonb) x)
WHERE name IN ('Supervisor de Transporte', 'Supervisor de Despacho');
UPDATE public.roles SET permissions = (SELECT jsonb_agg(DISTINCT x) FROM jsonb_array_elements(COALESCE(permissions, '[]'::jsonb)
  || '["hhee-aprobar:write", "hhee-gerencia:read", "hhee-costos:read", "hhee-config:write", "hhee:read"]'::jsonb) x)
WHERE name = 'Jefe de Distribución';
INSERT INTO public.hhee_memberships (user_id, area_id)
SELECT p.id, a.id FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id
JOIN public.hhee_areas a ON a.module_enabled AND a.name = 'Distribución'
WHERE p.is_active AND ro.name IN ('Supervisor de Transporte', 'Supervisor de Despacho', 'Jefe de Distribución')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
COMMIT;
