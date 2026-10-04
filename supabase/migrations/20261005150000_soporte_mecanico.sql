-- ============================================================
-- Soporte Mecánico: rol, capacidad de respuesta, avisos de fallas, KPI e informe mensual
-- ============================================================
-- * Rol "Soporte Mecánico" con el permiso nuevo mantenimiento-soporte (su desempeño e informe mensual) y lo necesario
--   para atender fallas y OT. Los supervisores (mantenimiento-dashboard) ven al equipo y revisan los informes.
-- * Aviso de falla nueva: reemplaza al disparador notif_falla (20261004140000) por uno que además indica quién la
--   reportó (conductor, Jefe de Distribución, supervisor…) y lo envía también a Soporte Mecánico. Usa la misma
--   clave de aviso, así que no se duplica.
-- * Capacidad de respuesta: maintenance_requests.first_response_at/by (primera atención: "Tomar" o el primer cambio
--   de estado) y maintenance_request_events (historial con hora y usuario de cada paso).
-- * SLA por criticidad (soporte_sla) y parámetros (soporte_parametros), editables.
-- * soporte_kpis(usuario, mes): tiempo de respuesta y de solución frente al SLA, reincidencia, backlog envejecido,
--   OT cerradas, horas fuera de servicio, puntualidad del informe mensual e índice de eficiencia 0–100.
-- * Informe mensual (soporte_informes): vence el día 3 del mes siguiente. Los días de atraso bajan el índice.
--   El supervisor lo revisa o lo observa.
-- * soporte_alertas() cada 15 minutos (pg_cron):
--     - falla sin atención fuera del SLA;
--     - día 1, recordatorio del informe al técnico;
--     - desde el día 4, aviso diario de atraso al técnico y a su supervisor.
-- Producción no coincide con las migraciones: maintenance_requests y maintenance_work_orders se leen con to_jsonb.
BEGIN;

-- ------------------------------------------------------------
-- 1. Rol
-- ------------------------------------------------------------
INSERT INTO public.roles (name, description, permissions)
VALUES ('Soporte Mecánico', 'Atiende fallas e incidencias mecánicas, ejecuta OT y presenta su informe mensual de desempeño',
        '["mantenimiento-soporte","mantenimiento-fallas","mantenimiento-ot","mantenimiento-flota:read","mantenimiento-planes:read","mantenimiento-vencimientos:read"]'::jsonb)
ON CONFLICT (name) DO UPDATE
SET permissions = (SELECT jsonb_agg(DISTINCT p) FROM jsonb_array_elements(COALESCE(public.roles.permissions, '[]'::jsonb) || EXCLUDED.permissions) p),
    description = COALESCE(public.roles.description, EXCLUDED.description);

CREATE OR REPLACE FUNCTION public.soporte_es_supervisor()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.is_tms_admin() OR public.has_tms_permission('mantenimiento-dashboard');
$$;
REVOKE ALL ON FUNCTION public.soporte_es_supervisor() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soporte_es_supervisor() TO authenticated;

-- Técnicos de soporte: usuarios activos cuyo rol tiene mantenimiento-soporte (sin el Administrador)
CREATE OR REPLACE FUNCTION public.soporte_tecnicos()
RETURNS TABLE (user_id uuid, nombre text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.id, COALESCE(public.lease_person_name(p.id), 'Usuario')
  FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
  WHERE p.is_active AND lower(r.name) NOT IN ('administrador', 'admin')
    AND jsonb_typeof(r.permissions) = 'array'
    AND (r.permissions ? 'mantenimiento-soporte' OR r.permissions ? 'mantenimiento-soporte:write' OR r.permissions ? 'mantenimiento-soporte:read');
$$;
REVOKE ALL ON FUNCTION public.soporte_tecnicos() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 2. Parámetros y SLA
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.soporte_sla (
  severidad text PRIMARY KEY CHECK (severidad IN ('CRITICA', 'ALTA', 'MEDIA', 'BAJA')),
  respuesta_horas numeric NOT NULL CHECK (respuesta_horas > 0),
  solucion_horas numeric NOT NULL CHECK (solucion_horas > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.soporte_sla (severidad, respuesta_horas, solucion_horas) VALUES
  ('CRITICA', 1, 24), ('ALTA', 4, 72), ('MEDIA', 24, 168), ('BAJA', 72, 360)
ON CONFLICT (severidad) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.soporte_parametros (
  clave text PRIMARY KEY,
  valor numeric NOT NULL,
  descripcion text NOT NULL
);
INSERT INTO public.soporte_parametros (clave, valor, descripcion) VALUES
  ('plazo_informe_dia', 3, 'Día del mes siguiente en que vence el informe mensual'),
  ('penalidad_dia_atraso', 15, 'Puntos que pierde la puntualidad del informe por cada día de atraso'),
  ('reincidencia_dias', 30, 'Días después del cierre en que una nueva falla de la misma unidad cuenta como reincidencia'),
  ('envejecida_dias', 7, 'Días abiertos a partir de los cuales una falla cuenta como envejecida')
ON CONFLICT (clave) DO NOTHING;

ALTER TABLE public.soporte_sla ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.soporte_parametros ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS soporte_sla_read ON public.soporte_sla;
CREATE POLICY soporte_sla_read ON public.soporte_sla FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS soporte_param_read ON public.soporte_parametros;
CREATE POLICY soporte_param_read ON public.soporte_parametros FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.soporte_sla, public.soporte_parametros TO authenticated;

CREATE OR REPLACE FUNCTION public.soporte_param(p_clave text, p_defecto numeric)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT valor FROM public.soporte_parametros WHERE clave = p_clave), p_defecto);
$$;
REVOKE ALL ON FUNCTION public.soporte_param(text, numeric) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.soporte_guardar_sla(p_sla jsonb, p_parametros jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE x jsonb; k text; v text;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.soporte_es_supervisor() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el supervisor de mantenimiento cambia los plazos');
  END IF;
  FOR x IN SELECT * FROM jsonb_array_elements(COALESCE(p_sla, '[]'::jsonb)) LOOP
    UPDATE public.soporte_sla SET respuesta_horas = (x ->> 'respuesta_horas')::numeric, solucion_horas = (x ->> 'solucion_horas')::numeric, updated_at = now()
    WHERE severidad = x ->> 'severidad';
  END LOOP;
  FOR k, v IN SELECT * FROM jsonb_each_text(COALESCE(p_parametros, '{}'::jsonb)) LOOP
    UPDATE public.soporte_parametros SET valor = v::numeric WHERE clave = k;
  END LOOP;
  RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.soporte_guardar_sla(jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soporte_guardar_sla(jsonb, jsonb) TO authenticated;

-- ------------------------------------------------------------
-- 3. Primera atención e historial de cada falla
-- ------------------------------------------------------------
ALTER TABLE public.maintenance_requests ADD COLUMN IF NOT EXISTS assigned_to uuid;
ALTER TABLE public.maintenance_requests ADD COLUMN IF NOT EXISTS first_response_at timestamptz;
ALTER TABLE public.maintenance_requests ADD COLUMN IF NOT EXISTS first_response_by uuid;

CREATE TABLE IF NOT EXISTS public.maintenance_request_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL,
  evento text NOT NULL,
  estado_anterior text,
  estado_nuevo text,
  at timestamptz NOT NULL DEFAULT now(),
  by uuid,
  detalle text
);
CREATE INDEX IF NOT EXISTS mr_events_request_idx ON public.maintenance_request_events (request_id, at);
CREATE INDEX IF NOT EXISTS mr_events_by_idx ON public.maintenance_request_events (by, at);
ALTER TABLE public.maintenance_request_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mr_events_read ON public.maintenance_request_events;
CREATE POLICY mr_events_read ON public.maintenance_request_events FOR SELECT TO authenticated
  USING (public.has_cmms_read_permission('fallas') OR public.has_tms_read_permission('mantenimiento-soporte'));
GRANT SELECT ON public.maintenance_request_events TO authenticated;

-- Quién reportó: "Conductor Juan Pérez", "Jefe de Distribución Ana Ruiz", "Supervisor"…
CREATE OR REPLACE FUNCTION public.soporte_reportante(j jsonb)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_drv jsonb; v_rol text; v_nom text;
BEGIN
  IF NULLIF(j ->> 'driver_id', '') IS NOT NULL THEN
    SELECT to_jsonb(d) INTO v_drv FROM public.drivers d WHERE d.id::text = j ->> 'driver_id';
    v_nom := COALESCE(NULLIF(btrim(v_drv ->> 'full_name'), ''), NULLIF(btrim(concat_ws(' ', v_drv ->> 'first_name', v_drv ->> 'last_name')), ''));
    RETURN 'Conductor' || COALESCE(' ' || v_nom, '');
  END IF;
  IF NULLIF(j ->> 'reported_by', '') IS NOT NULL THEN
    SELECT r.name INTO v_rol FROM public.profiles p LEFT JOIN public.roles r ON r.id = p.role_id WHERE p.id::text = j ->> 'reported_by';
    v_nom := public.lease_person_name((j ->> 'reported_by')::uuid);
    IF v_rol IS NOT NULL OR v_nom IS NOT NULL THEN RETURN concat_ws(' ', v_rol, v_nom); END IF;
  END IF;
  RETURN CASE upper(COALESCE(j ->> 'source', '')) WHEN 'APP_CONDUCTOR' THEN 'Conductor (app)' WHEN 'INSPECCION' THEN 'Inspección'
    WHEN 'TORRE_CONTROL' THEN 'Torre de Control' WHEN 'MANTENIMIENTO' THEN 'Mantenimiento' WHEN 'COPILOTO_AI' THEN 'Copiloto IA' ELSE 'Supervisor' END;
EXCEPTION WHEN OTHERS THEN RETURN 'Usuario';
END $$;
REVOKE ALL ON FUNCTION public.soporte_reportante(jsonb) FROM PUBLIC, anon, authenticated;

-- Antes de guardar: la primera salida de REPORTADA marca la primera atención
CREATE OR REPLACE FUNCTION public.soporte_trg_primera_atencion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.first_response_at IS NULL AND OLD.status = 'REPORTADA' AND NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.first_response_at := now();
    NEW.first_response_by := COALESCE(auth.uid(), NEW.assigned_to);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_soporte_primera_atencion ON public.maintenance_requests;
CREATE TRIGGER trg_soporte_primera_atencion BEFORE UPDATE ON public.maintenance_requests
FOR EACH ROW EXECUTE FUNCTION public.soporte_trg_primera_atencion();

-- Después de guardar: historial y avisos (nunca bloquea el reporte ni el cambio de estado)
CREATE OR REPLACE FUNCTION public.soporte_trg_eventos()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n jsonb := to_jsonb(NEW); o jsonb; sev text; plate text; v_por text; v_asig uuid;
BEGIN
  sev := upper(translate(COALESCE(n ->> 'severity', ''), 'ÍíÁá', 'IiAa'));
  plate := n ->> 'vehicle_plate';
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.maintenance_request_events (request_id, evento, estado_nuevo, at, by, detalle)
    VALUES (NEW.id, 'REPORTADA', n ->> 'status', COALESCE(NULLIF(n ->> 'reported_at', '')::timestamptz, now()),
            COALESCE(NULLIF(n ->> 'reported_by', '')::uuid, auth.uid()), left(n ->> 'description', 300));
    v_por := public.soporte_reportante(n || jsonb_build_object('reported_by', COALESCE(NULLIF(n ->> 'reported_by', ''), auth.uid()::text)));
    PERFORM public.notif_emit(CASE WHEN sev IN ('CRITICA', 'ALTA') THEN 'FALLA_CRITICA' ELSE 'FALLA_REPORTADA' END, 'fal-' || NEW.id,
      'Falla ' || CASE WHEN sev = 'CRITICA' THEN 'CRÍTICA' WHEN sev = '' THEN 'reportada' ELSE sev END || ' en ' || COALESCE(plate, 'unidad'),
      'Reportó: ' || v_por || ' · ' || left(COALESCE(n ->> 'description', ''), 180), '/mantenimiento/fallas');
    RETURN NULL;
  END IF;
  o := to_jsonb(OLD);
  IF n ->> 'status' IS DISTINCT FROM o ->> 'status' THEN
    INSERT INTO public.maintenance_request_events (request_id, evento, estado_anterior, estado_nuevo, by, detalle)
    VALUES (NEW.id, 'ESTADO', o ->> 'status', n ->> 'status', auth.uid(),
            CASE n ->> 'status' WHEN 'DIAGNOSTICADA' THEN left(n ->> 'diagnosis', 300) WHEN 'DESCARTADA' THEN left(n ->> 'discard_reason', 300) END);
  END IF;
  v_asig := NULLIF(n ->> 'assigned_to', '')::uuid;
  IF v_asig IS DISTINCT FROM NULLIF(o ->> 'assigned_to', '')::uuid AND v_asig IS NOT NULL THEN
    INSERT INTO public.maintenance_request_events (request_id, evento, estado_nuevo, by, detalle)
    VALUES (NEW.id, CASE WHEN v_asig = auth.uid() THEN 'TOMADA' ELSE 'ASIGNADA' END, n ->> 'status', auth.uid(), public.lease_person_name(v_asig));
    IF v_asig IS DISTINCT FROM auth.uid() THEN
      PERFORM public.notif_emit('FALLA_ASIGNADA', 'fal-asig-' || NEW.id || '-' || v_asig,
        'Se te asignó la falla ' || CASE WHEN sev = 'CRITICA' THEN 'CRÍTICA' ELSE lower(sev) END || ' de ' || COALESCE(plate, 'una unidad'),
        left(COALESCE(n ->> 'description', ''), 200), '/mantenimiento/fallas', v_asig);
    END IF;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_soporte_eventos ON public.maintenance_requests;
CREATE TRIGGER trg_soporte_eventos AFTER INSERT OR UPDATE ON public.maintenance_requests
FOR EACH ROW EXECUTE FUNCTION public.soporte_trg_eventos();

-- Este disparador reemplaza al aviso anterior de fallas (misma clave 'fal-<id>')
DROP TRIGGER IF EXISTS notif_falla ON public.maintenance_requests;

-- Historial previo: reporte, validación y cierre con las fechas que ya existen
INSERT INTO public.maintenance_request_events (request_id, evento, estado_nuevo, at, by, detalle)
SELECT m.id, 'REPORTADA', 'REPORTADA', COALESCE(NULLIF(to_jsonb(m) ->> 'reported_at', '')::timestamptz, m.created_at),
       NULLIF(to_jsonb(m) ->> 'reported_by', '')::uuid, 'histórico'
FROM public.maintenance_requests m
WHERE NOT EXISTS (SELECT 1 FROM public.maintenance_request_events e WHERE e.request_id = m.id);
INSERT INTO public.maintenance_request_events (request_id, evento, estado_anterior, estado_nuevo, at, by, detalle)
SELECT m.id, 'ESTADO', 'REPORTADA', 'VALIDADA', (to_jsonb(m) ->> 'validated_at')::timestamptz, NULLIF(to_jsonb(m) ->> 'validated_by', '')::uuid, 'histórico'
FROM public.maintenance_requests m
WHERE NULLIF(to_jsonb(m) ->> 'validated_at', '') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.maintenance_request_events e WHERE e.request_id = m.id AND e.estado_nuevo = 'VALIDADA');
UPDATE public.maintenance_requests m
SET first_response_at = (to_jsonb(m) ->> 'validated_at')::timestamptz,
    first_response_by = COALESCE(NULLIF(to_jsonb(m) ->> 'validated_by', '')::uuid, NULLIF(to_jsonb(m) ->> 'assigned_to', '')::uuid)
WHERE m.first_response_at IS NULL AND NULLIF(to_jsonb(m) ->> 'validated_at', '') IS NOT NULL;

-- ------------------------------------------------------------
-- 4. Avisos (reglas)
-- ------------------------------------------------------------
UPDATE public.notif_reglas SET permisos = (SELECT array_agg(DISTINCT x) FROM unnest(permisos || ARRAY['mantenimiento-soporte']) x), updated_at = now()
WHERE evento IN ('FALLA_CRITICA', 'FALLA_REPORTADA') AND NOT ('mantenimiento-soporte' = ANY (permisos));
UPDATE public.notif_reglas SET descripcion = 'Falla crítica o alta reportada (conductor, supervisor, Jefe de Distribución…)' WHERE evento = 'FALLA_CRITICA';
INSERT INTO public.notif_reglas (evento, categoria, descripcion, severidad, permisos, al_solicitante) VALUES
  ('FALLA_ASIGNADA',           'MANTENIMIENTO', 'Falla asignada al técnico',                                  'warn', '{}', true),
  ('FALLA_SIN_ATENCION',       'MANTENIMIENTO', 'Falla sin atención fuera del plazo de respuesta (SLA)',       'crit', ARRAY['mantenimiento-soporte', 'mantenimiento-fallas', 'mantenimiento-dashboard'], false),
  ('SOPORTE_INFORME',          'MANTENIMIENTO', 'Día 1: presentar el informe mensual de Soporte Mecánico',      'warn', '{}', true),
  ('SOPORTE_INFORME_ATRASADO', 'MANTENIMIENTO', 'Informe mensual de Soporte Mecánico atrasado',                 'crit', ARRAY['mantenimiento-dashboard'], true),
  ('SOPORTE_INFORME_REVISADO', 'MANTENIMIENTO', 'Informe mensual revisado u observado por el supervisor',       'info', '{}', true)
ON CONFLICT (evento) DO NOTHING;

-- ------------------------------------------------------------
-- 5. Tomar / asignar una falla
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.soporte_tomar_falla(p_request_id uuid, p_usuario uuid DEFAULT NULL, p_nota text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j jsonb; v_user uuid := COALESCE(p_usuario, auth.uid()); v_actual uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT (public.has_cmms_permission('fallas') OR public.has_tms_permission('mantenimiento-soporte')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para atender fallas');
  END IF;
  IF p_usuario IS NOT NULL AND p_usuario IS DISTINCT FROM auth.uid() AND auth.uid() IS NOT NULL AND NOT public.soporte_es_supervisor() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el supervisor asigna fallas a otra persona');
  END IF;
  SELECT to_jsonb(m) INTO j FROM public.maintenance_requests m WHERE m.id = p_request_id FOR UPDATE;
  IF j IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Falla no encontrada'); END IF;
  IF j ->> 'status' IN ('CERRADA', 'DESCARTADA') THEN RETURN jsonb_build_object('success', false, 'error', 'La falla ya está cerrada'); END IF;
  v_actual := NULLIF(j ->> 'assigned_to', '')::uuid;
  IF v_actual IS NOT NULL AND v_actual IS DISTINCT FROM v_user AND p_usuario IS NULL AND NOT public.soporte_es_supervisor() THEN
    RETURN jsonb_build_object('success', false, 'error', 'La atiende ' || COALESCE(public.lease_person_name(v_actual), 'otro técnico'));
  END IF;
  UPDATE public.maintenance_requests SET
    assigned_to = v_user,
    first_response_at = COALESCE(first_response_at, CASE WHEN p_usuario IS NULL OR p_usuario = auth.uid() THEN now() END),
    first_response_by = COALESCE(first_response_by, CASE WHEN p_usuario IS NULL OR p_usuario = auth.uid() THEN v_user END),
    notes = CASE WHEN NULLIF(btrim(p_nota), '') IS NOT NULL THEN concat_ws(' | ', notes, btrim(p_nota)) ELSE notes END
  WHERE id = p_request_id;
  RETURN jsonb_build_object('success', true, 'asignado', public.lease_person_name(v_user));
END $$;
REVOKE ALL ON FUNCTION public.soporte_tomar_falla(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soporte_tomar_falla(uuid, uuid, text) TO authenticated;

-- ------------------------------------------------------------
-- 6. Base de cálculo (lectura defensiva) y KPI
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.soporte_fallas_v AS
SELECT z.id, z.plate, z.sev, z.status, z.rep, z.resp, z.resp_by, z.asig, z.cerr, z.descr, z.j,
       COALESCE(z.resp_by, z.asig) AS tecnico,
       s.respuesta_horas AS sla_resp_h, s.solucion_horas AS sla_sol_h,
       CASE WHEN z.resp IS NOT NULL THEN extract(epoch FROM z.resp - z.rep) / 3600.0 END AS resp_h,
       CASE WHEN z.cerr IS NOT NULL AND z.status = 'CERRADA' THEN extract(epoch FROM z.cerr - z.rep) / 3600.0 END AS sol_h
FROM (
  SELECT m.id, to_jsonb(m) AS j,
         upper(COALESCE(to_jsonb(m) ->> 'vehicle_plate', '')) AS plate,
         upper(translate(COALESCE(to_jsonb(m) ->> 'severity', 'MEDIA'), 'ÍíÁá', 'IiAa')) AS sev,
         to_jsonb(m) ->> 'status' AS status,
         COALESCE(NULLIF(to_jsonb(m) ->> 'reported_at', '')::timestamptz, m.created_at) AS rep,
         m.first_response_at AS resp, m.first_response_by AS resp_by, m.assigned_to AS asig,
         NULLIF(to_jsonb(m) ->> 'closed_at', '')::timestamptz AS cerr,
         to_jsonb(m) ->> 'description' AS descr
  FROM public.maintenance_requests m
) z
LEFT JOIN public.soporte_sla s ON s.severidad = z.sev;
REVOKE ALL ON public.soporte_fallas_v FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.soporte_informes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  periodo date NOT NULL CHECK (extract(day FROM periodo) = 1),
  kpis jsonb NOT NULL DEFAULT '{}'::jsonb,
  logros text NOT NULL,
  problemas text,
  acciones text,
  estado text NOT NULL DEFAULT 'ENVIADO' CHECK (estado IN ('ENVIADO', 'OBSERVADO', 'REVISADO')),
  enviado_at timestamptz NOT NULL DEFAULT now(),
  actualizado_at timestamptz NOT NULL DEFAULT now(),
  dias_desde_cierre int NOT NULL DEFAULT 0,
  dias_atraso int NOT NULL DEFAULT 0,
  revisado_por uuid,
  revisado_at timestamptz,
  comentario text,
  UNIQUE (user_id, periodo)
);
ALTER TABLE public.soporte_informes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS soporte_informes_read ON public.soporte_informes;
CREATE POLICY soporte_informes_read ON public.soporte_informes FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.soporte_es_supervisor());
GRANT SELECT ON public.soporte_informes TO authenticated;

CREATE OR REPLACE FUNCTION public.soporte_kpis(p_usuario uuid DEFAULT NULL, p_mes date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid := COALESCE(p_usuario, auth.uid());
  v_hoy date := (now() AT TIME ZONE 'America/Lima')::date;
  v_ini date := date_trunc('month', COALESCE(p_mes, v_hoy))::date;
  v_fin date := (date_trunc('month', COALESCE(p_mes, v_hoy)) + interval '1 month - 1 day')::date;
  v_t0 timestamptz; v_t1 timestamptz;
  v_reinc_d numeric := public.soporte_param('reincidencia_dias', 30);
  v_env_d numeric := public.soporte_param('envejecida_dias', 7);
  v_plazo int := public.soporte_param('plazo_informe_dia', 3)::int;
  v_pen numeric := public.soporte_param('penalidad_dia_atraso', 15);
  m record; eq record; inf record; bk record; ot_c int := 0; ot_p int := 0; ot_h numeric;
  v_reinc int := 0; v_venc date; v_atraso int; c_resp numeric; c_sol numeric; c_reinc numeric; c_back numeric; c_inf numeric;
  v_idx numeric; v_peso numeric; v_detalle jsonb;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF v_user = auth.uid() AND NOT (public.has_tms_read_permission('mantenimiento-soporte') OR public.soporte_es_supervisor()) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Sin permiso de Soporte Mecánico');
    ELSIF v_user <> auth.uid() AND NOT public.soporte_es_supervisor() THEN
      RETURN jsonb_build_object('success', false, 'error', 'Solo el supervisor ve el desempeño de otra persona');
    END IF;
  END IF;
  v_t0 := v_ini::timestamp AT TIME ZONE 'America/Lima';
  v_t1 := (v_fin + 1)::timestamp AT TIME ZONE 'America/Lima';

  -- Fallas del técnico reportadas en el mes
  SELECT count(*) AS atendidas,
         count(*) FILTER (WHERE resp_h IS NOT NULL) AS con_resp,
         round(avg(resp_h)::numeric, 2) AS tr_prom,
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY resp_h))::numeric, 2) AS tr_med,
         count(*) FILTER (WHERE resp_h IS NOT NULL AND resp_h <= sla_resp_h) AS tr_ok,
         count(*) FILTER (WHERE sol_h IS NOT NULL) AS cerradas,
         round(avg(sol_h)::numeric, 2) AS ts_prom,
         count(*) FILTER (WHERE sol_h IS NOT NULL AND sol_h <= sla_sol_h) AS ts_ok,
         count(*) FILTER (WHERE status = 'DESCARTADA') AS descartadas,
         count(*) FILTER (WHERE sev = 'CRITICA') AS criticas
  INTO m FROM public.soporte_fallas_v WHERE tecnico = v_user AND rep >= v_t0 AND rep < v_t1;

  -- Reincidencia: otra falla de la misma unidad dentro de N días después del cierre
  SELECT count(*) INTO v_reinc FROM public.soporte_fallas_v f
  WHERE f.tecnico = v_user AND f.rep >= v_t0 AND f.rep < v_t1 AND f.sol_h IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.soporte_fallas_v g WHERE g.plate = f.plate AND g.id <> f.id AND g.rep > f.cerr AND g.rep <= f.cerr + make_interval(days => v_reinc_d::int));

  -- Equipo en el mes (todas las fallas)
  SELECT count(*) AS recibidas,
         count(*) FILTER (WHERE resp IS NULL AND status = 'REPORTADA') AS sin_atender,
         count(*) FILTER (WHERE resp IS NULL AND status = 'REPORTADA' AND now() > rep + make_interval(secs => sla_resp_h * 3600)) AS sin_atender_fuera_sla
  INTO eq FROM public.soporte_fallas_v WHERE rep >= v_t0 AND rep < v_t1;

  -- Backlog actual del técnico
  SELECT count(*) AS abiertas, count(*) FILTER (WHERE rep < now() - make_interval(days => v_env_d::int)) AS envejecidas
  INTO bk FROM public.soporte_fallas_v WHERE tecnico = v_user AND status NOT IN ('CERRADA', 'DESCARTADA');

  -- OT cerradas en el mes donde participó
  IF to_regclass('public.maintenance_work_orders') IS NOT NULL THEN
    SELECT count(*) AS cerradas,
           count(*) FILTER (WHERE upper(COALESCE(j ->> 'order_type', j ->> 'type', '')) LIKE 'PREVENT%') AS preventivas,
           round(avg(extract(epoch FROM NULLIF(j ->> 'downtime_end', '')::timestamptz - NULLIF(j ->> 'downtime_start', '')::timestamptz) / 3600.0)::numeric, 1) AS horas_fuera
    INTO ot_c, ot_p, ot_h
    FROM (SELECT to_jsonb(w) AS j FROM public.maintenance_work_orders w) w
    WHERE upper(COALESCE(j ->> 'status', '')) IN ('CERRADA', 'COMPLETADO', 'TERMINADA')
      AND COALESCE(NULLIF(j ->> 'closed_at', '')::timestamptz, NULLIF(j ->> 'actual_end_date', '')::timestamptz) >= v_t0
      AND COALESCE(NULLIF(j ->> 'closed_at', '')::timestamptz, NULLIF(j ->> 'actual_end_date', '')::timestamptz) < v_t1
      AND v_user::text IN (COALESCE(j ->> 'responsible_id', ''), COALESCE(j ->> 'mechanic_id', ''), COALESCE(j ->> 'closed_by', ''));
  END IF;

  -- Informe mensual del periodo (vence el día N del mes siguiente)
  SELECT * INTO inf FROM public.soporte_informes WHERE user_id = v_user AND periodo = v_ini;
  v_venc := (v_ini + interval '1 month')::date + (v_plazo - 1);
  v_atraso := CASE WHEN inf.id IS NOT NULL THEN inf.dias_atraso WHEN v_hoy > v_venc THEN v_hoy - v_venc END;

  -- Componentes del índice (0–100); los que no tienen datos no cuentan
  c_resp := CASE WHEN m.con_resp > 0 THEN round(100.0 * m.tr_ok / m.con_resp, 1) END;
  c_sol := CASE WHEN m.cerradas > 0 THEN round(100.0 * m.ts_ok / m.cerradas, 1) END;
  c_reinc := CASE WHEN m.cerradas > 0 THEN round(100.0 - 100.0 * v_reinc / m.cerradas, 1) END;
  c_back := CASE WHEN bk.abiertas > 0 THEN round(100.0 - 100.0 * bk.envejecidas / bk.abiertas, 1) WHEN m.atendidas > 0 THEN 100 END;
  c_inf := CASE WHEN v_atraso IS NOT NULL THEN GREATEST(0, 100 - v_pen * v_atraso) END;
  v_peso := COALESCE(CASE WHEN c_resp IS NOT NULL THEN 30 END, 0) + COALESCE(CASE WHEN c_sol IS NOT NULL THEN 30 END, 0)
          + COALESCE(CASE WHEN c_reinc IS NOT NULL THEN 15 END, 0) + COALESCE(CASE WHEN c_back IS NOT NULL THEN 10 END, 0)
          + COALESCE(CASE WHEN c_inf IS NOT NULL THEN 15 END, 0);
  v_idx := CASE WHEN v_peso > 0 THEN round((COALESCE(c_resp * 30, 0) + COALESCE(c_sol * 30, 0) + COALESCE(c_reinc * 15, 0)
                                           + COALESCE(c_back * 10, 0) + COALESCE(c_inf * 15, 0)) / v_peso, 0) END;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', f.id, 'placa', f.plate, 'criticidad', f.sev, 'estado', f.status, 'reportada', f.rep,
           'reporto', public.soporte_reportante(f.j), 'descripcion', left(f.descr, 160),
           'respuesta_h', round(f.resp_h::numeric, 2), 'sla_respuesta_h', f.sla_resp_h, 'respuesta_ok', f.resp_h <= f.sla_resp_h,
           'solucion_h', round(f.sol_h::numeric, 1), 'sla_solucion_h', f.sla_sol_h, 'solucion_ok', f.sol_h <= f.sla_sol_h) ORDER BY f.rep DESC), '[]')
  INTO v_detalle FROM (SELECT * FROM public.soporte_fallas_v WHERE tecnico = v_user AND rep >= v_t0 AND rep < v_t1 ORDER BY rep DESC LIMIT 200) f;

  RETURN jsonb_build_object('success', true, 'usuario', v_user, 'nombre', public.lease_person_name(v_user),
    'periodo', v_ini, 'periodo_fin', v_fin,
    'fallas', jsonb_build_object('atendidas', m.atendidas, 'criticas', m.criticas, 'cerradas', m.cerradas, 'descartadas', m.descartadas,
       'respuesta_prom_h', m.tr_prom, 'respuesta_mediana_h', m.tr_med, 'respuesta_en_sla_pct', c_resp,
       'solucion_prom_h', m.ts_prom, 'solucion_en_sla_pct', c_sol, 'reincidencias', v_reinc,
       'reincidencia_pct', CASE WHEN m.cerradas > 0 THEN round(100.0 * v_reinc / m.cerradas, 1) END),
    'backlog', jsonb_build_object('abiertas', bk.abiertas, 'envejecidas', bk.envejecidas, 'envejecida_dias', v_env_d),
    'equipo', jsonb_build_object('recibidas', eq.recibidas, 'sin_atender', eq.sin_atender, 'sin_atender_fuera_sla', eq.sin_atender_fuera_sla),
    'ot', jsonb_build_object('cerradas', COALESCE(ot_c, 0), 'preventivas', COALESCE(ot_p, 0), 'horas_fuera_servicio_prom', ot_h),
    'informe', jsonb_build_object('estado', COALESCE(inf.estado, CASE WHEN v_hoy > v_venc THEN 'ATRASADO' WHEN v_hoy > v_fin THEN 'PENDIENTE' ELSE 'MES_EN_CURSO' END),
       'vence', v_venc, 'enviado_at', inf.enviado_at, 'dias_desde_cierre', inf.dias_desde_cierre, 'dias_atraso', v_atraso, 'id', inf.id),
    'componentes', jsonb_build_object('respuesta', c_resp, 'solucion', c_sol, 'reincidencia', c_reinc, 'backlog', c_back, 'informe', c_inf),
    'pesos', jsonb_build_object('respuesta', 30, 'solucion', 30, 'reincidencia', 15, 'backlog', 10, 'informe', 15),
    'indice', v_idx,
    'calificacion', CASE WHEN v_idx IS NULL THEN 'SIN_DATOS' WHEN v_idx >= 90 THEN 'EXCELENTE' WHEN v_idx >= 75 THEN 'BUENO' WHEN v_idx >= 60 THEN 'REGULAR' ELSE 'BAJO' END,
    'sla', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.respuesta_horas) FROM public.soporte_sla s),
    'detalle', v_detalle);
END $$;
REVOKE ALL ON FUNCTION public.soporte_kpis(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soporte_kpis(uuid, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.soporte_equipo(p_mes date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t record; k jsonb; v_items jsonb := '[]'::jsonb; v_mes date := date_trunc('month', COALESCE(p_mes, (now() AT TIME ZONE 'America/Lima')::date))::date;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.soporte_es_supervisor() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el supervisor de mantenimiento ve al equipo');
  END IF;
  FOR t IN SELECT * FROM public.soporte_tecnicos() ORDER BY nombre LOOP
    k := public.soporte_kpis(t.user_id, v_mes);
    v_items := v_items || jsonb_build_array(k - 'detalle' - 'sla');
  END LOOP;
  RETURN jsonb_build_object('success', true, 'periodo', v_mes, 'tecnicos', v_items,
    'informes', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', i.id, 'user_id', i.user_id, 'nombre', public.lease_person_name(i.user_id),
        'periodo', i.periodo, 'estado', i.estado, 'enviado_at', i.enviado_at, 'dias_atraso', i.dias_atraso, 'logros', i.logros,
        'problemas', i.problemas, 'acciones', i.acciones, 'comentario', i.comentario, 'kpis', i.kpis - 'detalle' - 'sla') ORDER BY i.enviado_at DESC)
      FROM public.soporte_informes i WHERE i.periodo >= (v_mes - interval '2 months')::date), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.soporte_equipo(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soporte_equipo(date) TO authenticated;

-- ------------------------------------------------------------
-- 7. Informe mensual
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.soporte_enviar_informe(p_periodo date, p_logros text, p_problemas text DEFAULT NULL, p_acciones text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_hoy date := (now() AT TIME ZONE 'America/Lima')::date;
  v_per date := date_trunc('month', p_periodo)::date;
  v_sig date; v_plazo int := public.soporte_param('plazo_informe_dia', 3)::int; i record; v_id uuid; k jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_tms_permission('mantenimiento-soporte') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el personal de Soporte Mecánico presenta este informe');
  END IF;
  IF v_per >= date_trunc('month', v_hoy)::date THEN
    RETURN jsonb_build_object('success', false, 'error', 'El informe se presenta cuando el mes terminó');
  END IF;
  IF length(btrim(COALESCE(p_logros, ''))) < 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Describa los trabajos y logros del mes');
  END IF;
  v_sig := (v_per + interval '1 month')::date;
  SELECT * INTO i FROM public.soporte_informes WHERE user_id = auth.uid() AND periodo = v_per FOR UPDATE;
  IF i.id IS NOT NULL AND i.estado = 'REVISADO' THEN
    RETURN jsonb_build_object('success', false, 'error', 'El informe ya fue revisado');
  END IF;
  IF i.id IS NULL THEN
    INSERT INTO public.soporte_informes (user_id, periodo, logros, problemas, acciones, dias_desde_cierre, dias_atraso)
    VALUES (auth.uid(), v_per, btrim(p_logros), NULLIF(btrim(p_problemas), ''), NULLIF(btrim(p_acciones), ''),
            GREATEST(v_hoy - v_sig + 1, 0), GREATEST(v_hoy - (v_sig + v_plazo - 1), 0))
    RETURNING id INTO v_id;
  ELSE   -- corrección de un informe observado o aún no revisado: conserva la fecha de envío original
    UPDATE public.soporte_informes SET logros = btrim(p_logros), problemas = NULLIF(btrim(p_problemas), ''), acciones = NULLIF(btrim(p_acciones), ''),
      estado = 'ENVIADO', actualizado_at = now() WHERE id = i.id;
    v_id := i.id;
  END IF;
  k := public.soporte_kpis(auth.uid(), v_per);
  UPDATE public.soporte_informes SET kpis = k - 'sla' WHERE id = v_id;
  RETURN jsonb_build_object('success', true, 'id', v_id, 'indice', k -> 'indice', 'dias_atraso', (SELECT dias_atraso FROM public.soporte_informes WHERE id = v_id));
END $$;
REVOKE ALL ON FUNCTION public.soporte_enviar_informe(date, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soporte_enviar_informe(date, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.soporte_revisar_informe(p_id uuid, p_estado text, p_comentario text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE i record; meses text[] := ARRAY['enero','febrero','marzo','abril','mayo','junio','julio','agosto','setiembre','octubre','noviembre','diciembre'];
BEGIN
  IF auth.uid() IS NULL OR NOT public.soporte_es_supervisor() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el supervisor de mantenimiento revisa los informes');
  END IF;
  SELECT * INTO i FROM public.soporte_informes WHERE id = p_id FOR UPDATE;
  IF i.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Informe no encontrado'); END IF;
  IF i.user_id = auth.uid() THEN RETURN jsonb_build_object('success', false, 'error', 'No puede revisar su propio informe'); END IF;
  IF upper(p_estado) NOT IN ('REVISADO', 'OBSERVADO') THEN RETURN jsonb_build_object('success', false, 'error', 'Estado inválido'); END IF;
  IF upper(p_estado) = 'OBSERVADO' AND NULLIF(btrim(p_comentario), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique qué debe corregir');
  END IF;
  UPDATE public.soporte_informes SET estado = upper(p_estado), revisado_por = auth.uid(), revisado_at = now(), comentario = NULLIF(btrim(p_comentario), '')
  WHERE id = p_id;
  PERFORM public.notif_emit('SOPORTE_INFORME_REVISADO', 'sop-rev-' || p_id || '-' || extract(epoch FROM now())::bigint,
    'Tu informe de ' || meses[extract(month FROM i.periodo)::int] || ' fue ' || CASE WHEN upper(p_estado) = 'REVISADO' THEN 'revisado' ELSE 'observado' END,
    COALESCE(NULLIF(btrim(p_comentario), ''), 'Sin comentarios'), '/mantenimiento/soporte?tab=informe', i.user_id);
  RETURN jsonb_build_object('success', true);
END $$;
REVOKE ALL ON FUNCTION public.soporte_revisar_informe(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soporte_revisar_informe(uuid, text, text) TO authenticated;

-- ------------------------------------------------------------
-- 8. Alertas programadas
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.soporte_alertas(p_ahora timestamptz DEFAULT NULL)
RETURNS int LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ahora timestamptz := COALESCE(p_ahora, now());
  v_local timestamp := v_ahora AT TIME ZONE 'America/Lima';
  v_hoy date := v_local::date;
  v_dia int := extract(day FROM v_local)::int;
  v_plazo int := public.soporte_param('plazo_informe_dia', 3)::int;
  v_per date := (date_trunc('month', v_local) - interval '1 month')::date;
  v_mes text; f record; t record; n int := 0;
  meses text[] := ARRAY['enero','febrero','marzo','abril','mayo','junio','julio','agosto','setiembre','octubre','noviembre','diciembre'];
BEGIN
  v_mes := meses[extract(month FROM v_per)::int] || ' ' || extract(year FROM v_per);
  -- Fallas sin atención fuera del plazo de respuesta (últimos 30 días)
  FOR f IN SELECT * FROM public.soporte_fallas_v
           WHERE status = 'REPORTADA' AND resp IS NULL AND asig IS NULL AND rep > v_ahora - interval '30 days'
             AND v_ahora > rep + make_interval(secs => COALESCE(sla_resp_h, 24) * 3600) LOOP
    IF public.notif_emit('FALLA_SIN_ATENCION', 'fal-sla-' || f.id,
         'Falla ' || CASE WHEN f.sev = 'CRITICA' THEN 'CRÍTICA' ELSE f.sev END || ' en ' || f.plate || ' sin atención (plazo ' || trim(to_char(f.sla_resp_h, 'FM999990.##')) || ' h)',
         'Reportada ' || to_char(f.rep AT TIME ZONE 'America/Lima', 'DD/MM HH24:MI') || ' · ' || left(COALESCE(f.descr, ''), 150), '/mantenimiento/fallas') IS NOT NULL THEN
      n := n + 1;
    END IF;
  END LOOP;

  -- Informe mensual: día 1 (desde las 08:00) recordatorio; pasado el plazo, aviso diario de atraso
  IF extract(hour FROM v_local) >= 8 THEN
    FOR t IN SELECT * FROM public.soporte_tecnicos() LOOP
      CONTINUE WHEN EXISTS (SELECT 1 FROM public.soporte_informes i WHERE i.user_id = t.user_id AND i.periodo = v_per);
      IF v_dia <= v_plazo THEN
        IF public.notif_emit('SOPORTE_INFORME', 'sop-inf-' || t.user_id || '-' || to_char(v_per, 'YYYYMM'),
             'Presenta tu informe mensual de ' || v_mes,
             'Vence el ' || lpad(v_plazo::text, 2, '0') || '/' || to_char(v_per + interval '1 month', 'MM') || '. Los días de atraso bajan tu índice de eficiencia.',
             '/mantenimiento/soporte?tab=informe', t.user_id) IS NOT NULL THEN n := n + 1; END IF;
      ELSE
        IF public.notif_emit('SOPORTE_INFORME_ATRASADO', 'sop-inf-' || t.user_id || '-' || to_char(v_per, 'YYYYMM') || '-' || to_char(v_hoy, 'DD'),
             'Informe de ' || v_mes || ' de ' || t.nombre || ': ' || (v_dia - v_plazo) || ' día' || CASE WHEN v_dia - v_plazo = 1 THEN '' ELSE 's' END || ' de atraso',
             'Venció el ' || lpad(v_plazo::text, 2, '0') || '/' || to_char(v_hoy, 'MM') || '. Cada día de atraso descuenta ' || public.soporte_param('penalidad_dia_atraso', 15) || ' puntos de puntualidad.',
             '/mantenimiento/soporte?tab=informe', t.user_id) IS NOT NULL THEN n := n + 1; END IF;
      END IF;
    END LOOP;
  END IF;
  RETURN n;
EXCEPTION WHEN OTHERS THEN RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.soporte_alertas(timestamptz) FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN PERFORM cron.unschedule('soporte-alertas'); EXCEPTION WHEN OTHERS THEN NULL; END;
    PERFORM cron.schedule('soporte-alertas', '*/15 * * * *', $cron$SELECT public.soporte_alertas()$cron$);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
