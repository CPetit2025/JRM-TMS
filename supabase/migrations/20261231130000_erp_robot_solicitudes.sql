-- Banner de actualización y «Actualizar ahora» del ERP (stock y contratos).
-- El robot de la PC del ERP sigue corriendo a sus horas fijas (07, 10, 13, 16 y 19 h); esto solo agrega ejecuciones
-- manuales: la web deja una solicitud y una tarea del robot que pregunta cada minuto la toma (igual que los ingresos WMS).
--  · erp_robot_request: la pide un usuario que puede cargar el ERP (apt_can_load).
--  · erp_robot_due: pregunta sin sesión (anon) y responde solo verdadero/falso.
--  · erp_robot_start / erp_robot_finish: el robot, con su cuenta, toma la solicitud e informa el resultado.
--  · data_update_status: lo que muestra el banner (fechas de las cargas activas, carga en curso y última solicitud).
BEGIN;
CREATE TABLE IF NOT EXISTS public.erp_robot_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL DEFAULT 'MANUAL' CHECK (kind IN ('MANUAL')),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','OK','ERROR')),
  requested_by uuid DEFAULT auth.uid(),
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  message text
);
ALTER TABLE public.erp_robot_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.erp_robot_runs;
CREATE POLICY security_active_account ON public.erp_robot_runs AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.erp_robot_runs FROM PUBLIC, anon, authenticated;
CREATE INDEX IF NOT EXISTS erp_robot_runs_open_idx ON public.erp_robot_runs(status) WHERE status IN ('PENDING','RUNNING');

CREATE OR REPLACE FUNCTION public.erp_robot_request() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.erp_robot_runs;
BEGIN
  IF NOT public.apt_can_load() THEN RAISE EXCEPTION 'No tiene permiso para actualizar los datos del ERP' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('erp-robot'));
  SELECT * INTO r FROM public.erp_robot_runs
   WHERE status = 'PENDING' OR (status = 'RUNNING' AND started_at > now() - interval '60 minutes') ORDER BY id DESC LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('id', r.id, 'status', r.status, 'existing', true); END IF;
  INSERT INTO public.erp_robot_runs DEFAULT VALUES RETURNING * INTO r;
  RETURN jsonb_build_object('id', r.id, 'status', r.status, 'existing', false);
END $$;

-- Sin sesión, cada minuto: hay solicitud pendiente, ninguna en curso y ninguna carga horaria cargando ahora.
CREATE OR REPLACE FUNCTION public.erp_robot_due() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.erp_robot_runs WHERE status = 'PENDING')
    AND NOT EXISTS (SELECT 1 FROM public.erp_robot_runs WHERE status = 'RUNNING' AND started_at > now() - interval '60 minutes')
    AND NOT EXISTS (SELECT 1 FROM public.erp_imports WHERE status = 'CARGANDO' AND created_at > now() - interval '30 minutes');
$$;

CREATE OR REPLACE FUNCTION public.erp_robot_start() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id bigint;
BEGIN
  IF NOT public.apt_can_load() THEN RAISE EXCEPTION 'No tiene permiso para actualizar los datos del ERP' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('erp-robot'));
  UPDATE public.erp_robot_runs SET status = 'ERROR', finished_at = now(),
    message = 'El robot no informó el resultado en 60 minutos (PC apagada o ejecución cortada).'
   WHERE status = 'RUNNING' AND started_at <= now() - interval '60 minutes';
  IF EXISTS (SELECT 1 FROM public.erp_robot_runs WHERE status = 'RUNNING') THEN RETURN NULL; END IF;
  UPDATE public.erp_robot_runs SET status = 'RUNNING', started_at = now()
   WHERE id = (SELECT id FROM public.erp_robot_runs WHERE status = 'PENDING' ORDER BY id LIMIT 1)
   RETURNING id INTO v_id;
  RETURN CASE WHEN v_id IS NULL THEN NULL ELSE jsonb_build_object('id', v_id) END;
END $$;

CREATE OR REPLACE FUNCTION public.erp_robot_finish(p_id bigint, p_ok boolean, p_message text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apt_can_load() THEN RAISE EXCEPTION 'No tiene permiso para actualizar los datos del ERP' USING ERRCODE = '42501'; END IF;
  UPDATE public.erp_robot_runs SET status = CASE WHEN p_ok THEN 'OK' ELSE 'ERROR' END, finished_at = now(),
    message = left(nullif(btrim(p_message), ''), 1000)
   WHERE id = p_id AND status = 'RUNNING';
END $$;

-- Estado para el banner: cuándo quedó activa cada carga, si hay una cargando y la última solicitud manual.
CREATE OR REPLACE FUNCTION public.data_update_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.is_active_tms_user() THEN RAISE EXCEPTION 'Sin acceso' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object(
    'now', now(),
    'erp', jsonb_build_object(
      'stock_at', (SELECT max(coalesce(applied_at, created_at)) FROM public.erp_imports WHERE kind = 'STOCK' AND status = 'ACTIVA'),
      'contratos_at', (SELECT max(coalesce(applied_at, created_at)) FROM public.erp_imports WHERE kind = 'CONTRATOS' AND status = 'ACTIVA'),
      'loading_since', (SELECT min(created_at) FROM public.erp_imports WHERE status = 'CARGANDO' AND created_at > now() - interval '1 day'),
      'request', (SELECT jsonb_build_object('status', status, 'requested_at', requested_at, 'started_at', started_at, 'finished_at', finished_at, 'message', message)
                    FROM public.erp_robot_runs ORDER BY id DESC LIMIT 1),
      'can_request', public.apt_can_load()));
END $$;

REVOKE ALL ON FUNCTION public.erp_robot_request(), public.erp_robot_start(), public.erp_robot_finish(bigint, boolean, text), public.data_update_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_robot_request(), public.erp_robot_start(), public.erp_robot_finish(bigint, boolean, text), public.data_update_status() TO authenticated, service_role;
-- Abierta a anon a propósito: devuelve solo verdadero/falso, sin datos.
REVOKE ALL ON FUNCTION public.erp_robot_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.erp_robot_due() TO anon, authenticated, service_role;
COMMIT;
