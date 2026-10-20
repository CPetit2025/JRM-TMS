-- ============================================================
-- HHEE de rutas: cierre desde el app del conductor o por geocerca, ejecutado vs autorizado y compensación
-- ============================================================
-- 1. Al aprobarse, el conductor (y el auxiliar con app) recibe el aviso. En el app ve sus horas extras y las cierra a
--    mano; al cerrar las suyas se cierran las de toda la tripulación de esa solicitud (el auxiliar no cierra).
-- 2. Cierre automático por geocerca: con las horas extras abiertas, cada posición del conductor (puntos de la ruta,
--    posición del app y, ya cerrada la ruta, el servicio nativo) se compara con las bases (geocercas CEDI / depósito /
--    cochera). Cierra cuando la unidad SALE de una base en la que ENTRÓ después de iniciadas las horas extras; si ya
--    estaba dentro al empezar, salir no cierra (primero tiene que volver a entrar).
-- 3. Ejecutado: hora real de fin, minutos ejecutados y su reparto legal (25 / 35 / 100 %) por línea; lo autorizado
--    queda en el informe aprobado. El supervisor puede registrar el cierre si el app no lo hizo.
-- 4. Compensación (D.S. 007-2002-TR art. 10): cada línea puede pagarse o compensarse con descanso equivalente. Las
--    compensadas no tienen costo en dinero y alimentan la bolsa de horas del trabajador; los descansos tomados se
--    registran y se descuentan.
BEGIN;
SET LOCAL lock_timeout = '60s';

ALTER TABLE public.hhee_lines
  ADD COLUMN IF NOT EXISTS closed_by text CHECK (closed_by IS NULL OR closed_by IN ('CONDUCTOR', 'GEOCERCA', 'SUPERVISOR')),
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS close_reason text CHECK (close_reason IS NULL OR length(close_reason) <= 300),
  ADD COLUMN IF NOT EXISTS geo_state text CHECK (geo_state IS NULL OR geo_state IN ('IN', 'OUT')),
  ADD COLUMN IF NOT EXISTS geo_at timestamptz,
  ADD COLUMN IF NOT EXISTS geo_entered_at timestamptz,
  ADD COLUMN IF NOT EXISTS exec_minutes_25 integer CHECK (exec_minutes_25 BETWEEN 0 AND 960),
  ADD COLUMN IF NOT EXISTS exec_minutes_35 integer CHECK (exec_minutes_35 BETWEEN 0 AND 960),
  ADD COLUMN IF NOT EXISTS exec_minutes_100 integer CHECK (exec_minutes_100 BETWEEN 0 AND 960),
  ADD COLUMN IF NOT EXISTS exec_cost numeric(16,2) CHECK (exec_cost >= 0),
  ADD COLUMN IF NOT EXISTS compensation boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS hhee_lines_open_idx ON public.hhee_lines (person_id) WHERE actual_end IS NULL;

-- Descansos compensatorios tomados (se descuentan de la bolsa de horas)
CREATE TABLE IF NOT EXISTS public.hhee_comp_rests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES public.hhee_people(id),
  rest_date date NOT NULL,
  minutes integer NOT NULL CHECK (minutes BETWEEN 1 AND 1440),
  note text CHECK (note IS NULL OR length(note) <= 300),
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES public.profiles(id)
);
CREATE INDEX IF NOT EXISTS hhee_comp_rests_person_idx ON public.hhee_comp_rests (person_id);
CREATE INDEX IF NOT EXISTS hhee_comp_rests_created_by_idx ON public.hhee_comp_rests (created_by);
CREATE INDEX IF NOT EXISTS hhee_comp_rests_cancelled_by_idx ON public.hhee_comp_rests (cancelled_by);
ALTER TABLE public.hhee_comp_rests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.hhee_comp_rests;
CREATE POLICY security_active_account ON public.hhee_comp_rests AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.hhee_comp_rests FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- Bases (geocercas) y cierre
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hhee_in_base(p_lat numeric, p_lon numeric) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
-- Base = geocerca activa de tipo CEDI, depósito o cochera (o cuyo nombre lo diga). Sin geocercas: locales autorizados.
DECLARE v_has boolean := false; v_in boolean := false;
BEGIN
  IF p_lat IS NULL OR p_lon IS NULL THEN RETURN NULL; END IF;
  IF to_regclass('public.geofences') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) > 0, COALESCE(bool_or(public.point_inside_polygon($1, $2, coordinates)), false)
      FROM public.geofences WHERE is_active AND jsonb_typeof(coordinates) = 'array' AND jsonb_array_length(coordinates) >= 3
        AND (lower(type) IN ('cedi', 'depot', 'cochera') OR name ~* '(cedi|cochera|almac[eé]n|dep[oó]sito)')$q$
      INTO v_has, v_in USING p_lat::double precision, p_lon::double precision;
    IF v_has THEN RETURN v_in; END IF;
  END IF;
  RETURN EXISTS (SELECT 1 FROM public.authorized_locations WHERE is_active AND 6371 * 2 * asin(sqrt(
      power(sin(radians((p_lat - latitude)::double precision) / 2), 2) +
      cos(radians(latitude::double precision)) * cos(radians(p_lat::double precision)) *
      power(sin(radians((p_lon - longitude)::double precision) / 2), 2))) <= radius_km);
END $$;

-- Cierra las líneas abiertas de una solicitud: hora real de fin, minutos ejecutados, reparto legal y costo
CREATE OR REPLACE FUNCTION public.hhee_close_request_lines(p_request uuid, p_end timestamptz, p_by text, p_reason text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.hhee_requests; l record; v_end timestamptz; v_min int; v_split jsonb; v_n int := 0;
BEGIN
  SELECT * INTO r FROM public.hhee_requests WHERE id = p_request FOR UPDATE;
  IF r.id IS NULL OR r.state = 'CANCELADA' OR r.approval = 'RECHAZADA' THEN RETURN 0; END IF;
  FOR l IN SELECT * FROM public.hhee_lines WHERE request_id = p_request AND actual_end IS NULL FOR UPDATE LOOP
    v_end := GREATEST(p_end, l.planned_start + interval '1 minute');
    v_min := LEAST(960, GREATEST(0, (extract(epoch FROM v_end - l.planned_start) / 60)::int - COALESCE(l.planned_break, 0)));
    v_split := public.hhee_flow_split(l.person_id, r.work_date, v_min, l.rest_day, r.id);
    UPDATE public.hhee_lines SET actual_start = l.planned_start, actual_end = v_end, actual_break = COALESCE(l.planned_break, 0), actual_minutes = v_min,
      exec_minutes_25 = (v_split->>'m25')::int, exec_minutes_35 = (v_split->>'m35')::int, exec_minutes_100 = (v_split->>'m100')::int,
      exec_cost = CASE WHEN l.compensation THEN 0 ELSE public.hhee_flow_cost(l.plan_rate, (v_split->>'m25')::int, (v_split->>'m35')::int, (v_split->>'m100')::int) END,
      closed_by = p_by, closed_at = now(), close_reason = left(p_reason, 300)
    WHERE id = l.id;
    v_n := v_n + 1;
  END LOOP;
  IF v_n > 0 THEN
    INSERT INTO public.hhee_audit (request_id, actor, event, reason)
    VALUES (p_request, COALESCE(auth.uid(), r.created_by), 'HHEE_CERRADA',
      format('%s · fin %s%s', CASE p_by WHEN 'GEOCERCA' THEN 'Salida de la base (geocerca)' WHEN 'CONDUCTOR' THEN 'Cerrada por el conductor' ELSE 'Registrada por el supervisor' END,
        to_char(p_end AT TIME ZONE 'America/Lima', 'DD/MM HH24:MI'), CASE WHEN p_reason IS NOT NULL THEN ' · ' || p_reason ELSE '' END));
    BEGIN
      INSERT INTO public.notifications (evento, categoria, severidad, titulo, cuerpo, link, target_user, dedupe_key)
      VALUES ('HHEE_CERRADA', 'hhee', 'info', format('Horas extras cerradas · HE-%s', lpad(r.sequence::text, 5, '0')),
        format('Fin %s (%s).', to_char(p_end AT TIME ZONE 'America/Lima', 'DD/MM HH24:MI'), lower(p_by)), '/hhee/solicitudes?id=' || r.id, r.created_by, 'hhee-cerrada-' || r.id);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  RETURN v_n;
END $$;

-- Posición del conductor con horas extras abiertas: entrada y salida de la base
CREATE OR REPLACE FUNCTION public.hhee_geo_point(p_driver uuid, p_lat numeric, p_lon numeric, p_at timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l record; v_in boolean;
BEGIN
  IF p_driver IS NULL OR p_lat IS NULL OR p_lon IS NULL OR p_at IS NULL OR p_at > now() + interval '5 minutes' THEN RETURN; END IF;
  FOR l IN SELECT x.id, x.request_id, x.geo_state, x.geo_at, x.geo_entered_at FROM public.hhee_lines x
           JOIN public.hhee_people p ON p.id = x.person_id JOIN public.hhee_requests r ON r.id = x.request_id
           WHERE p.driver_id = p_driver AND x.actual_end IS NULL AND x.planned_start <= p_at AND r.state <> 'CANCELADA' AND r.approval <> 'RECHAZADA'
             AND r.work_date >= (p_at AT TIME ZONE 'America/Lima')::date - 1 LOOP
    CONTINUE WHEN l.geo_at IS NOT NULL AND p_at <= l.geo_at;
    v_in := public.hhee_in_base(p_lat, p_lon);
    CONTINUE WHEN v_in IS NULL;
    IF l.geo_state = 'IN' AND NOT v_in AND l.geo_entered_at IS NOT NULL THEN
      PERFORM public.hhee_close_request_lines(l.request_id, p_at, 'GEOCERCA', NULL);
    ELSE
      UPDATE public.hhee_lines SET geo_state = CASE WHEN v_in THEN 'IN' ELSE 'OUT' END, geo_at = p_at,
        geo_entered_at = CASE WHEN v_in AND l.geo_state = 'OUT' THEN p_at ELSE geo_entered_at END
      WHERE id = l.id;
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.hhee_driver_has_open(p_driver uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.hhee_lines x JOIN public.hhee_people p ON p.id = x.person_id
    WHERE p.driver_id = p_driver AND x.actual_end IS NULL AND x.planned_start <= now() + interval '5 minutes'
      AND EXISTS (SELECT 1 FROM public.hhee_requests r WHERE r.id = x.request_id AND r.state <> 'CANCELADA' AND r.approval <> 'RECHAZADA'
        AND r.work_date >= (now() AT TIME ZONE 'America/Lima')::date - 1));
$$;

-- Puntos de la ruta y posición del app alimentan la geocerca (nunca bloquean el registro del punto)
CREATE OR REPLACE FUNCTION public.hhee_geo_track_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  BEGIN
    IF public.hhee_driver_has_open(NEW.driver_id) THEN
      PERFORM public.hhee_geo_point(NEW.driver_id, NEW.latitude, NEW.longitude, NEW.recorded_at);
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hhee_geo_track ON public.route_track_points;
CREATE TRIGGER hhee_geo_track AFTER INSERT ON public.route_track_points FOR EACH ROW EXECUTE FUNCTION public.hhee_geo_track_trg();
DROP TRIGGER IF EXISTS hhee_geo_presence ON public.driver_app_presence;
CREATE TRIGGER hhee_geo_presence AFTER INSERT OR UPDATE OF recorded_at ON public.driver_app_presence FOR EACH ROW
  WHEN (NEW.latitude IS NOT NULL AND NEW.recorded_at IS NOT NULL) EXECUTE FUNCTION public.hhee_geo_track_trg();

-- Aviso al conductor (y a la tripulación con app) cuando se aprueban sus horas extras
CREATE OR REPLACE FUNCTION public.hhee_approved_notice_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  BEGIN
    INSERT INTO public.notifications (evento, categoria, severidad, titulo, cuerpo, link, target_user, dedupe_key)
    SELECT 'HHEE_APROBADA', 'hhee', 'success', 'Horas extras aprobadas',
      format('Desde las %s%s. Ciérralas en el app al terminar; se cierran solas al salir de la base.', to_char(min(l.planned_start) AT TIME ZONE 'America/Lima', 'HH24:MI'),
        CASE WHEN max(l.dispatch_number) IS NOT NULL THEN ' · ruta ' || max(l.dispatch_number) ELSE '' END),
      '/app/hhee', u.profile_id, 'hhee-aprobada-' || NEW.id || '-' || NEW.version || '-' || u.profile_id
    FROM public.hhee_lines l JOIN public.hhee_people p ON p.id = l.person_id
    JOIN LATERAL (SELECT COALESCE((SELECT d.profile_id FROM public.drivers d WHERE d.id = p.driver_id), p.profile_id) AS profile_id) u ON u.profile_id IS NOT NULL
    WHERE l.request_id = NEW.id AND l.actual_end IS NULL
    GROUP BY u.profile_id
    ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hhee_approved_notice ON public.hhee_requests;
CREATE TRIGGER hhee_approved_notice AFTER UPDATE OF approval ON public.hhee_requests FOR EACH ROW
  WHEN (NEW.approval = 'APROBADA' AND OLD.approval IS DISTINCT FROM 'APROBADA') EXECUTE FUNCTION public.hhee_approved_notice_trg();

-- ------------------------------------------------------------
-- App del conductor
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hhee_my_driver() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.id FROM public.drivers d WHERE d.profile_id = auth.uid() AND COALESCE((to_jsonb(d)->>'is_active')::boolean, true) ORDER BY d.id LIMIT 1;
$$;

-- Mis horas extras (últimos 3 días): estado, ruta, tripulación y si puedo cerrarlas
CREATE OR REPLACE FUNCTION public.hhee_driver_overtime() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_driver uuid := public.hhee_my_driver();
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Sin sesión'); END IF;
  RETURN jsonb_build_object('success', true, 'items', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('request_id', r.id, 'folio', 'HE-' || lpad(r.sequence::text, 5, '0'), 'work_date', r.work_date,
        'state', r.state, 'approval', r.approval, 'route', l.dispatch_number, 'plate', l.vehicle_plate,
        'start', l.planned_start, 'planned_end', l.planned_end, 'actual_end', l.actual_end, 'actual_minutes', l.actual_minutes, 'closed_by', l.closed_by,
        'compensation', l.compensation, 'geo_entered_at', l.geo_entered_at,
        'can_close', l.actual_end IS NULL AND v_driver IS NOT NULL AND p.driver_id = v_driver AND r.state <> 'CANCELADA' AND r.approval <> 'RECHAZADA'
          AND l.planned_start >= now() - interval '16 hours',
        'crew', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', o.person_name, 'closed', o.actual_end IS NOT NULL) ORDER BY o.person_name)
                 FROM public.hhee_lines o WHERE o.request_id = r.id AND o.id <> l.id), '[]'::jsonb))
      ORDER BY l.planned_start DESC)
    FROM public.hhee_lines l JOIN public.hhee_people p ON p.id = l.person_id JOIN public.hhee_requests r ON r.id = l.request_id
    WHERE (p.driver_id = v_driver OR p.profile_id = auth.uid()) AND r.state <> 'CANCELADA'
      AND r.work_date >= (now() AT TIME ZONE 'America/Lima')::date - 3), '[]'::jsonb));
END $$;

-- El conductor cierra sus horas extras y las de su tripulación en esa solicitud
CREATE OR REPLACE FUNCTION public.hhee_driver_close(p_request uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_driver uuid := public.hhee_my_driver(); v_n int;
BEGIN
  IF v_driver IS NULL OR NOT EXISTS (SELECT 1 FROM public.hhee_lines l JOIN public.hhee_people p ON p.id = l.person_id
      WHERE l.request_id = p_request AND p.driver_id = v_driver AND l.actual_end IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene horas extras abiertas en esta solicitud');
  END IF;
  IF (SELECT min(planned_start) FROM public.hhee_lines WHERE request_id = p_request) > now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Las horas extras aún no empiezan');
  END IF;
  IF (SELECT min(planned_start) FROM public.hhee_lines WHERE request_id = p_request) < now() - interval '16 hours' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Pasaron más de 16 horas desde el inicio: pide a tu supervisor que registre la hora real de fin');
  END IF;
  v_n := public.hhee_close_request_lines(p_request, now(), 'CONDUCTOR', NULL);
  RETURN jsonb_build_object('success', v_n > 0, 'closed', v_n, 'error', CASE WHEN v_n = 0 THEN 'La solicitud ya no admite cierre' END);
END $$;

-- Ruta para mantener el GPS nativo mientras las horas extras sigan abiertas (aunque la ruta ya cerró)
CREATE OR REPLACE FUNCTION public.hhee_driver_tracking_target() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('dispatch_id', (SELECT l.driver_dispatch_id FROM public.hhee_lines l JOIN public.hhee_people p ON p.id = l.person_id
    JOIN public.hhee_requests r ON r.id = l.request_id
    WHERE p.driver_id = public.hhee_my_driver() AND l.actual_end IS NULL AND l.driver_dispatch_id IS NOT NULL AND l.planned_start <= now() + interval '5 minutes'
      AND r.state <> 'CANCELADA' AND r.approval <> 'RECHAZADA' AND r.work_date >= (now() AT TIME ZONE 'America/Lima')::date - 1
    ORDER BY l.planned_start DESC LIMIT 1));
$$;

-- ------------------------------------------------------------
-- Web: cierre por el supervisor, pago o compensación, bolsa de horas y ejecutado vs autorizado
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hhee_flow_close(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.hhee_requests; v_end timestamptz; v_reason text := btrim(COALESCE(p->>'reason', '')); v_n int;
BEGIN
  SELECT * INTO r FROM public.hhee_requests WHERE id = NULLIF(p->>'id', '')::uuid;
  IF r.id IS NULL OR NOT (public.hhee_can(r.area_id, 'approve') OR (public.hhee_can(r.area_id, 'request') AND (r.created_by = auth.uid() OR public.is_tms_admin()))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para cerrar estas horas extras'); END IF;
  BEGIN v_end := (p->>'end')::timestamp AT TIME ZONE 'America/Lima'; EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('success', false, 'error', 'Hora de fin inválida'); END;
  IF v_end IS NULL OR v_end > now() + interval '5 minutes' THEN RETURN jsonb_build_object('success', false, 'error', 'La hora de fin no puede ser futura'); END IF;
  IF length(v_reason) < 5 THEN RETURN jsonb_build_object('success', false, 'error', 'Indique por qué se registra el cierre (mínimo 5 caracteres)'); END IF;
  v_n := public.hhee_close_request_lines(r.id, v_end, 'SUPERVISOR', v_reason);
  RETURN jsonb_build_object('success', v_n > 0, 'closed', v_n, 'error', CASE WHEN v_n = 0 THEN 'No hay horas extras abiertas en esta solicitud' END);
END $$;

CREATE OR REPLACE FUNCTION public.hhee_line_set_compensation(p_line uuid, p_compensation boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l public.hhee_lines; r public.hhee_requests;
BEGIN
  SELECT * INTO l FROM public.hhee_lines WHERE id = p_line FOR UPDATE;
  SELECT * INTO r FROM public.hhee_requests WHERE id = l.request_id;
  IF l.id IS NULL OR NOT (public.hhee_can(r.area_id, 'approve') OR (public.hhee_flow_caps()->>'people')::boolean) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el aprobador o quien administra el personal decide pago o compensación'); END IF;
  IF r.state = 'CANCELADA' OR r.approval = 'RECHAZADA' THEN RETURN jsonb_build_object('success', false, 'error', 'Solicitud anulada o rechazada'); END IF;
  UPDATE public.hhee_lines SET compensation = p_compensation,
    plan_cost = CASE WHEN p_compensation THEN 0 ELSE public.hhee_flow_cost(plan_rate, plan_minutes_25, plan_minutes_35, plan_minutes_100) END,
    estimated_cost = CASE WHEN p_compensation THEN 0 ELSE public.hhee_flow_cost(plan_rate, plan_minutes_25, plan_minutes_35, plan_minutes_100) END,
    exec_cost = CASE WHEN actual_end IS NULL THEN NULL WHEN p_compensation THEN 0 ELSE public.hhee_flow_cost(plan_rate, exec_minutes_25, exec_minutes_35, exec_minutes_100) END
  WHERE id = p_line;
  INSERT INTO public.hhee_audit (request_id, actor, event, reason)
  VALUES (r.id, auth.uid(), CASE WHEN p_compensation THEN 'COMPENSACION' ELSE 'PAGO' END, l.person_name);
  RETURN jsonb_build_object('success', true);
END $$;

-- Bolsa de horas: ejecutado a compensar (solicitudes aprobadas y cerradas) − descansos tomados
CREATE OR REPLACE FUNCTION public.hhee_comp_balance_of(p_person uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('earned', e.m, 'taken', t.m, 'balance', e.m - t.m)
  FROM (SELECT COALESCE(sum(l.actual_minutes), 0)::int m FROM public.hhee_lines l JOIN public.hhee_requests r ON r.id = l.request_id
        WHERE l.person_id = p_person AND l.compensation AND l.actual_end IS NOT NULL AND r.approval = 'APROBADA' AND r.state <> 'CANCELADA') e,
       (SELECT COALESCE(sum(minutes), 0)::int m FROM public.hhee_comp_rests WHERE person_id = p_person AND cancelled_at IS NULL) t;
$$;

CREATE OR REPLACE FUNCTION public.hhee_comp_list(p_person uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_area uuid;
BEGIN
  SELECT area_id INTO v_area FROM public.hhee_people WHERE id = p_person;
  IF v_area IS NULL OR NOT (public.hhee_can(v_area, 'config') OR public.hhee_can(v_area, 'read')) THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso'); END IF;
  RETURN jsonb_build_object('success', true, 'balance', public.hhee_comp_balance_of(p_person),
    'earned', COALESCE((SELECT jsonb_agg(jsonb_build_object('folio', 'HE-' || lpad(r.sequence::text, 5, '0'), 'work_date', r.work_date, 'minutes', l.actual_minutes,
        'route', l.dispatch_number) ORDER BY r.work_date DESC)
      FROM public.hhee_lines l JOIN public.hhee_requests r ON r.id = l.request_id
      WHERE l.person_id = p_person AND l.compensation AND l.actual_end IS NOT NULL AND r.approval = 'APROBADA' AND r.state <> 'CANCELADA'), '[]'::jsonb),
    'rests', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', x.id, 'rest_date', x.rest_date, 'minutes', x.minutes, 'note', x.note,
        'by', public.hhee_flow_name(x.created_by), 'cancelled', x.cancelled_at IS NOT NULL) ORDER BY x.rest_date DESC)
      FROM public.hhee_comp_rests x WHERE x.person_id = p_person), '[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION public.hhee_comp_rest_save(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_person public.hhee_people; v_min int; v_date date; v_bal int;
BEGIN
  SELECT * INTO v_person FROM public.hhee_people WHERE id = NULLIF(p->>'person_id', '')::uuid FOR UPDATE;
  IF v_person.id IS NULL OR NOT public.hhee_can(v_person.area_id, 'config') THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso'); END IF;
  BEGIN v_min := (p->>'minutes')::int; v_date := (p->>'rest_date')::date; EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('success', false, 'error', 'Revise la fecha y las horas'); END;
  IF v_date IS NULL OR v_min IS NULL OR v_min < 1 OR v_min > 1440 THEN RETURN jsonb_build_object('success', false, 'error', 'Indique la fecha y las horas de descanso (hasta 24 h)'); END IF;
  v_bal := (public.hhee_comp_balance_of(v_person.id)->>'balance')::int;
  IF v_min > v_bal THEN RETURN jsonb_build_object('success', false, 'error', format('El descanso supera la bolsa de horas disponible (%s min)', v_bal)); END IF;
  INSERT INTO public.hhee_comp_rests (person_id, rest_date, minutes, note, created_by)
  VALUES (v_person.id, v_date, v_min, NULLIF(left(btrim(COALESCE(p->>'note', '')), 300), ''), auth.uid());
  RETURN jsonb_build_object('success', true, 'balance', public.hhee_comp_balance_of(v_person.id));
END $$;

CREATE OR REPLACE FUNCTION public.hhee_comp_rest_cancel(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE x public.hhee_comp_rests;
BEGIN
  SELECT * INTO x FROM public.hhee_comp_rests WHERE id = p_id FOR UPDATE;
  IF x.id IS NULL OR NOT public.hhee_can((SELECT area_id FROM public.hhee_people WHERE id = x.person_id), 'config') THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso'); END IF;
  UPDATE public.hhee_comp_rests SET cancelled_at = now(), cancelled_by = auth.uid() WHERE id = p_id AND cancelled_at IS NULL;
  RETURN jsonb_build_object('success', true);
END $$;

-- Autorizado vs ejecutado en el período (panel gerencial)
CREATE OR REPLACE FUNCTION public.hhee_flow_exec_summary(p jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_from date := COALESCE(NULLIF(p->>'from', '')::date, date_trunc('month', (now() AT TIME ZONE 'America/Lima')::date)::date);
  v_to date := COALESCE(NULLIF(p->>'to', '')::date, (now() AT TIME ZONE 'America/Lima')::date); v_costs boolean := (public.hhee_flow_caps()->>'costs')::boolean; v jsonb;
BEGIN
  IF NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso'); END IF;
  SELECT jsonb_build_object('success', true,
    'authorized_minutes', COALESCE(sum(l.planned_minutes), 0), 'executed_minutes', COALESCE(sum(l.actual_minutes) FILTER (WHERE l.actual_end IS NOT NULL), 0),
    'closed_lines', count(*) FILTER (WHERE l.actual_end IS NOT NULL), 'open_lines', count(*) FILTER (WHERE l.actual_end IS NULL),
    'authorized_of_closed', COALESCE(sum(l.planned_minutes) FILTER (WHERE l.actual_end IS NOT NULL), 0),
    'compensation_minutes', COALESCE(sum(l.actual_minutes) FILTER (WHERE l.actual_end IS NOT NULL AND l.compensation), 0),
    'by_closure', jsonb_build_object('CONDUCTOR', count(*) FILTER (WHERE l.closed_by = 'CONDUCTOR'), 'GEOCERCA', count(*) FILTER (WHERE l.closed_by = 'GEOCERCA'),
      'SUPERVISOR', count(*) FILTER (WHERE l.closed_by = 'SUPERVISOR')),
    'executed_cost', CASE WHEN v_costs THEN round(COALESCE(sum(l.exec_cost) FILTER (WHERE l.actual_end IS NOT NULL), 0), 2) END)
  INTO v
  FROM public.hhee_lines l JOIN public.hhee_requests r ON r.id = l.request_id
  WHERE r.approval = 'APROBADA' AND r.state <> 'CANCELADA' AND r.work_date BETWEEN v_from AND v_to AND public.hhee_can(r.area_id, 'read')
    AND (NULLIF(p->>'area_id', '') IS NULL OR r.area_id = (p->>'area_id')::uuid);
  RETURN v;
END $$;

-- El servicio nativo sigue enviando posiciones mientras haya horas extras abiertas (geocerca de cierre)
CREATE OR REPLACE FUNCTION public.native_tracking_sync(p_token text, p_points jsonb DEFAULT '[]'::jsonb, p_client jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE dev record; pt jsonb; v_id uuid; accepted jsonb := '[]'::jsonb; rejected jsonb := '[]'::jsonb; last_pt jsonb; v_lat numeric;
BEGIN
  IF p_token IS NULL OR length(p_token) <> 64 THEN RETURN jsonb_build_object('success', false, 'error', 'Dispositivo no autorizado'); END IF;
  SELECT t.id, t.driver_id, t.profile_id INTO dev FROM public.driver_tracking_devices t
    JOIN public.drivers d ON d.id = t.driver_id AND d.is_active AND d.profile_id = t.profile_id
    JOIN public.profiles p ON p.id = t.profile_id AND p.is_active
   WHERE t.token_hash = public.tracking_token_hash(p_token) AND t.revoked_at IS NULL;
  IF dev.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Dispositivo no autorizado'); END IF;
  IF jsonb_typeof(p_points) IS DISTINCT FROM 'array' OR jsonb_array_length(p_points) > 500 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Lote de puntos no válido');
  END IF;
  -- Actúa como el conductor dueño del dispositivo: las reglas de los puntos y del aviso usan auth.uid()
  PERFORM set_config('request.jwt.claim.sub', dev.profile_id::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', dev.profile_id, 'role', 'authenticated')::text, true);
  UPDATE public.driver_tracking_devices SET last_used_at = now() WHERE id = dev.id;

  FOR pt IN SELECT value FROM jsonb_array_elements(p_points) ORDER BY value->>'recorded_at', value->>'id' LOOP
    BEGIN
      v_id := (pt->>'id')::uuid;
      INSERT INTO public.route_track_points(id, dispatch_id, driver_id, recorded_at, latitude, longitude, accuracy_m, speed_mps)
      VALUES (v_id, (pt->>'dispatch_id')::uuid, dev.driver_id, (pt->>'recorded_at')::timestamptz,
        (pt->>'latitude')::numeric, (pt->>'longitude')::numeric, (pt->>'accuracy_m')::numeric,
        CASE WHEN pt->>'speed_mps' IS NOT NULL AND (pt->>'speed_mps')::numeric BETWEEN 0 AND 100 THEN (pt->>'speed_mps')::numeric END);
      accepted := accepted || to_jsonb(v_id::text);
      last_pt := pt;
    EXCEPTION WHEN OTHERS THEN
      -- Ruta ya cerrada pero con horas extras abiertas: el punto solo sirve para la geocerca de cierre
      IF public.hhee_driver_has_open(dev.driver_id) AND (pt->>'latitude') IS NOT NULL THEN
        BEGIN
          PERFORM public.hhee_geo_point(dev.driver_id, (pt->>'latitude')::numeric, (pt->>'longitude')::numeric, (pt->>'recorded_at')::timestamptz);
          accepted := accepted || to_jsonb(COALESCE(pt->>'id', ''));
          last_pt := pt;
          CONTINUE;
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
      END IF;
      -- Rechazo permanente (fuera de orden, ruta cerrada, plazo, datos inválidos): el teléfono lo descarta
      rejected := rejected || to_jsonb(COALESCE(pt->>'id', ''));
    END;
  END LOOP;

  -- Aviso de conexión con el último punto aceptado (si no hay, solo la conexión y el estado del teléfono)
  BEGIN
    v_lat := (last_pt->>'latitude')::numeric;
    PERFORM public.driver_app_heartbeat(
      CASE WHEN COALESCE(p_client->>'gps_state', '') IN ('checking', 'active', 'denied', 'unavailable') THEN p_client->>'gps_state' ELSE 'active' END,
      v_lat, CASE WHEN v_lat IS NOT NULL THEN (last_pt->>'longitude')::numeric END,
      CASE WHEN v_lat IS NOT NULL THEN (last_pt->>'accuracy_m')::numeric END, NULL,
      CASE WHEN v_lat IS NOT NULL THEN (last_pt->>'recorded_at')::timestamptz END,
      COALESCE(p_client, '{}'::jsonb) || jsonb_build_object('native_tracking', true));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN jsonb_build_object('success', true, 'accepted', accepted, 'rejected', rejected);
END $$;

-- Detalle: ejecutado (fin real, minutos, reparto, quién cerró) y pago o compensación por línea
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
        'dispatch_id', l.driver_dispatch_id,
        'actual_end', l.actual_end, 'actual_minutes', l.actual_minutes, 'exec_minutes_25', l.exec_minutes_25, 'exec_minutes_35', l.exec_minutes_35,
        'exec_minutes_100', l.exec_minutes_100, 'closed_by', l.closed_by, 'closed_at', l.closed_at, 'close_reason', l.close_reason,
        'compensation', l.compensation, 'geo_entered_at', l.geo_entered_at, 'vehicle_plate', l.vehicle_plate, 'dispatch_number', l.dispatch_number, 'plate_source', l.plate_source, 'plate_reason', l.plate_reason,
        'break_minutes', l.planned_break, 'minutes', l.planned_minutes, 'minutes_25', l.plan_minutes_25, 'minutes_35', l.plan_minutes_35,
        'minutes_100', l.plan_minutes_100, 'approved_minutes', l.approved_minutes, 'rate_ready', l.plan_rate IS NOT NULL)
        || CASE WHEN v_costs THEN jsonb_build_object('cost', l.plan_cost, 'exec_cost', l.exec_cost) ELSE '{}'::jsonb END ORDER BY l.person_name)
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

-- Ficha: saldo de la bolsa de horas compensables
CREATE OR REPLACE FUNCTION public.hhee_flow_person_json(p public.hhee_people, p_remuneration boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name, 'document_number', p.document_number,
    'position', p.position, 'area_id', p.area_id, 'area_name', (SELECT name FROM public.hhee_areas WHERE id = p.area_id),
    'active', p.active, 'daily_hours', p.daily_hours, 'monthly_hours', p.monthly_hours, 'divisor_confirmed', p.divisor_confirmed,
    'effective_from', p.effective_from, 'rate_ready', p.divisor_confirmed AND p.base_hour_cost IS NOT NULL, 'updated_at', p.updated_at,
    'driver_id', p.driver_id, 'comp_balance', (public.hhee_comp_balance_of(p.id)->>'balance')::int, 'master', CASE WHEN p.driver_id IS NOT NULL THEN 'FLOTA' WHEN p.profile_id IS NOT NULL THEN 'MAESTROS' END)
  || CASE WHEN p_remuneration THEN jsonb_build_object('base_hour_cost', p.base_hour_cost, 'remuneration_concepts', p.remuneration_concepts)
     ELSE '{}'::jsonb END;
$$;

REVOKE ALL ON FUNCTION public.hhee_in_base(numeric, numeric), public.hhee_close_request_lines(uuid, timestamptz, text, text),
  public.hhee_geo_point(uuid, numeric, numeric, timestamptz), public.hhee_driver_has_open(uuid), public.hhee_geo_track_trg(),
  public.hhee_approved_notice_trg(), public.hhee_my_driver(), public.hhee_comp_balance_of(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hhee_driver_overtime(), public.hhee_driver_close(uuid), public.hhee_driver_tracking_target(), public.hhee_flow_close(jsonb),
  public.hhee_line_set_compensation(uuid, boolean), public.hhee_comp_list(uuid), public.hhee_comp_rest_save(jsonb), public.hhee_comp_rest_cancel(uuid),
  public.hhee_flow_exec_summary(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hhee_driver_overtime(), public.hhee_driver_close(uuid), public.hhee_driver_tracking_target(), public.hhee_flow_close(jsonb),
  public.hhee_line_set_compensation(uuid, boolean), public.hhee_comp_list(uuid), public.hhee_comp_rest_save(jsonb), public.hhee_comp_rest_cancel(uuid),
  public.hhee_flow_exec_summary(jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.native_tracking_sync(text, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.native_tracking_sync(text, jsonb, jsonb) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
