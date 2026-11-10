-- Banner de actualización del WMS y «Actualizar ahora» del ERP desde el WMS.
--  · wh_public_update_status: fechas y estados de las cargas (ERP e ingresos), sin datos de negocio. Abierta a anon para
--    que el banner del TMS muestre los ingresos WMS sin sesión WMS.
--  · erp_robot_*: misma cola de solicitudes que en el TMS. El robot del ERP (PC) pregunta a las dos bases cada minuto
--    y hace una sola carga completa (TMS y WMS). Las cargas a horas fijas no cambian.
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
REVOKE ALL ON public.erp_robot_runs FROM PUBLIC, anon, authenticated;
CREATE INDEX IF NOT EXISTS erp_robot_runs_open_idx ON public.erp_robot_runs(status) WHERE status IN ('PENDING','RUNNING');

-- Quien carga el ERP en el WMS: carga o supervisión, con cuenta activa.
CREATE OR REPLACE FUNCTION public.erp_robot_assert() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-carga','almacen-supervisor']) THEN
    RAISE EXCEPTION 'No tiene permiso para actualizar los datos del ERP' USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.erp_robot_assert() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.erp_robot_request() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.erp_robot_runs;
BEGIN
  PERFORM public.erp_robot_assert();
  PERFORM pg_advisory_xact_lock(hashtext('erp-robot'));
  SELECT * INTO r FROM public.erp_robot_runs
   WHERE status = 'PENDING' OR (status = 'RUNNING' AND started_at > now() - interval '60 minutes') ORDER BY id DESC LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('id', r.id, 'status', r.status, 'existing', true); END IF;
  INSERT INTO public.erp_robot_runs DEFAULT VALUES RETURNING * INTO r;
  RETURN jsonb_build_object('id', r.id, 'status', r.status, 'existing', false);
END $$;

CREATE OR REPLACE FUNCTION public.erp_robot_due() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (EXISTS (SELECT 1 FROM public.erp_robot_runs WHERE status = 'PENDING')
     AND NOT EXISTS (SELECT 1 FROM public.erp_robot_runs WHERE status = 'RUNNING' AND started_at > now() - interval '60 minutes')
     AND NOT EXISTS (SELECT 1 FROM public.erp_imports WHERE status = 'CARGANDO' AND created_at > now() - interval '30 minutes'))
    OR EXISTS (SELECT 1 FROM public.erp_robot_runs WHERE status = 'RUNNING' AND started_at <= now() - interval '60 minutes');
$$;

CREATE OR REPLACE FUNCTION public.erp_robot_start() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id bigint;
BEGIN
  PERFORM public.erp_robot_assert();
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
  PERFORM public.erp_robot_assert();
  UPDATE public.erp_robot_runs SET status = CASE WHEN p_ok THEN 'OK' ELSE 'ERROR' END, finished_at = now(),
    message = left(nullif(btrim(p_message), ''), 1000)
   WHERE id = p_id AND status = 'RUNNING';
END $$;

-- Solo fechas, estados y el mensaje del último error de cada robot: sin datos de inventario ni de clientes.
CREATE OR REPLACE FUNCTION public.wh_public_update_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'now', now(),
    'erp', jsonb_build_object(
      'stock_at', (SELECT max(coalesce(applied_at, created_at)) FROM public.erp_imports WHERE kind = 'STOCK' AND status = 'ACTIVA'),
      'contratos_at', (SELECT max(coalesce(applied_at, created_at)) FROM public.erp_imports WHERE kind = 'CONTRATOS' AND status = 'ACTIVA'),
      'loading_since', (SELECT min(c.created_at) FROM public.erp_imports c WHERE c.status = 'CARGANDO' AND c.created_at > now() - interval '1 day'
                          AND NOT EXISTS (SELECT 1 FROM public.erp_imports a WHERE a.kind = c.kind AND a.status = 'ACTIVA' AND a.created_at > c.created_at)),
      'request', (SELECT jsonb_build_object('status', status, 'requested_at', requested_at, 'started_at', started_at, 'finished_at', finished_at, 'message', message)
                    FROM public.erp_robot_runs ORDER BY id DESC LIMIT 1)),
    'ingresos', jsonb_build_object(
      'last_ok_at', (SELECT max(finished_at) FROM public.wh_receipt_robot_runs WHERE status = 'OK'),
      'last_error_at', (SELECT max(finished_at) FROM public.wh_receipt_robot_runs WHERE status = 'ERROR'),
      'last_error', (SELECT message FROM public.wh_receipt_robot_runs WHERE status = 'ERROR' ORDER BY finished_at DESC NULLS LAST LIMIT 1),
      'running_since', (SELECT min(started_at) FROM public.wh_receipt_robot_runs WHERE status = 'RUNNING' AND started_at > now() - interval '30 minutes'),
      'pending', EXISTS (SELECT 1 FROM public.wh_receipt_robot_runs WHERE status = 'PENDING'),
      'last_auto_at', (SELECT max(started_at) FROM public.wh_receipt_robot_runs WHERE kind = 'AUTO')));
$$;

REVOKE ALL ON FUNCTION public.erp_robot_request(), public.erp_robot_start(), public.erp_robot_finish(bigint, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_robot_request(), public.erp_robot_start(), public.erp_robot_finish(bigint, boolean, text) TO authenticated, service_role;
-- Abiertas a anon a propósito: erp_robot_due responde sí/no; wh_public_update_status, solo fechas y estados.
REVOKE ALL ON FUNCTION public.erp_robot_due(), public.wh_public_update_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.erp_robot_due(), public.wh_public_update_status() TO anon, authenticated, service_role;
COMMIT;
