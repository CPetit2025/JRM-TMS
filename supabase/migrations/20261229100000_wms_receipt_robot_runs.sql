-- Robot de ingresos WMS (C:\WMS\entrada.xlsx): ejecuciones automáticas cada 30 minutos y solicitudes manuales
-- desde /almacen/apt/etiquetado. La página no puede ejecutar nada en la PC: deja una solicitud y el robot, que
-- consulta cada minuto, la toma. La base decide cuándo toca la automática para no depender del reloj de la PC.
BEGIN;
CREATE TABLE IF NOT EXISTS public.wh_receipt_robot_runs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 kind text NOT NULL CHECK (kind IN ('AUTO','MANUAL')),
 status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','OK','ERROR')),
 requested_by uuid REFERENCES public.profiles(id),
 requested_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz,
 finished_at timestamptz,
 message text
);
CREATE INDEX IF NOT EXISTS wh_receipt_robot_runs_open_idx ON public.wh_receipt_robot_runs(status, id) WHERE status IN ('PENDING','RUNNING');
CREATE INDEX IF NOT EXISTS wh_receipt_robot_runs_recent_idx ON public.wh_receipt_robot_runs(id DESC);
ALTER TABLE public.wh_receipt_robot_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.wh_receipt_robot_runs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.wh_receipt_robot_runs TO service_role;
GRANT SELECT ON TABLE public.wh_receipt_robot_runs TO authenticated;
DROP POLICY IF EXISTS security_active_account ON public.wh_receipt_robot_runs;
CREATE POLICY security_active_account ON public.wh_receipt_robot_runs AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS wh_receipt_robot_runs_read ON public.wh_receipt_robot_runs;
CREATE POLICY wh_receipt_robot_runs_read ON public.wh_receipt_robot_runs FOR SELECT TO authenticated
 USING (public.wh_has_permission(ARRAY['almacen-carga','almacen-supervisor','almacen-etiquetado','almacen-lectura']));

-- Botón «Actualizar ahora»: una sola solicitud abierta a la vez (si ya hay una, se devuelve esa).
CREATE OR REPLACE FUNCTION public.wh_receipt_robot_request() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.wh_receipt_robot_runs;
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-carga','almacen-supervisor']) THEN
  RAISE EXCEPTION 'Sin permiso para actualizar ingresos WMS' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtext('wms-receipt-robot'));
 SELECT * INTO r FROM public.wh_receipt_robot_runs
  WHERE status='PENDING' OR (status='RUNNING' AND started_at>now()-interval '30 minutes') ORDER BY id DESC LIMIT 1;
 IF FOUND THEN RETURN jsonb_build_object('id',r.id,'status',r.status,'existing',true); END IF;
 INSERT INTO public.wh_receipt_robot_runs(kind,requested_by) VALUES ('MANUAL',auth.uid()) RETURNING * INTO r;
 RETURN jsonb_build_object('id',r.id,'status',r.status,'existing',false);
END $$;

-- Robot, cada minuto: toma la solicitud manual pendiente o, si pasaron 30 minutos desde la última automática,
-- abre una automática. Devuelve el id a ejecutar o NULL. Nunca dos a la vez; una ejecución sin cierre en 30
-- minutos se da por fallida (la PC se apagó o se cortó el robot).
CREATE OR REPLACE FUNCTION public.wh_receipt_robot_start() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id bigint; v_kind text;
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-carga','almacen-supervisor']) THEN
  RAISE EXCEPTION 'Sin permiso para actualizar ingresos WMS' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtext('wms-receipt-robot'));
 UPDATE public.wh_receipt_robot_runs SET status='ERROR', finished_at=now(),
  message='El robot no informó el resultado en 30 minutos (PC apagada o ejecución cortada).'
  WHERE status='RUNNING' AND started_at<=now()-interval '30 minutes';
 IF EXISTS (SELECT 1 FROM public.wh_receipt_robot_runs WHERE status='RUNNING') THEN RETURN NULL; END IF;
 UPDATE public.wh_receipt_robot_runs SET status='RUNNING', started_at=now()
  WHERE id=(SELECT id FROM public.wh_receipt_robot_runs WHERE status='PENDING' ORDER BY id LIMIT 1)
  RETURNING id, kind INTO v_id, v_kind;
 IF v_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.wh_receipt_robot_runs
   WHERE kind='AUTO' AND started_at>now()-interval '29 minutes 30 seconds') THEN
  INSERT INTO public.wh_receipt_robot_runs(kind,status,started_at) VALUES ('AUTO','RUNNING',now()) RETURNING id, kind INTO v_id, v_kind;
 END IF;
 RETURN CASE WHEN v_id IS NULL THEN NULL ELSE jsonb_build_object('id',v_id,'kind',v_kind) END;
END $$;

CREATE OR REPLACE FUNCTION public.wh_receipt_robot_finish(p_id bigint, p_ok boolean, p_message text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-carga','almacen-supervisor']) THEN
  RAISE EXCEPTION 'Sin permiso para actualizar ingresos WMS' USING ERRCODE='42501';
 END IF;
 UPDATE public.wh_receipt_robot_runs SET status=CASE WHEN p_ok THEN 'OK' ELSE 'ERROR' END, finished_at=now(),
  message=left(nullif(trim(p_message),''),1000)
  WHERE id=p_id AND status='RUNNING';
END $$;

-- Consulta de cada minuto sin iniciar sesión: el robot solo entra a la cuenta cuando hay algo que hacer. Abierta a
-- anon a propósito: devuelve solo verdadero/falso, sin datos.
CREATE OR REPLACE FUNCTION public.wh_receipt_robot_due() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT NOT EXISTS (SELECT 1 FROM public.wh_receipt_robot_runs WHERE status='RUNNING' AND started_at>now()-interval '30 minutes')
  AND (EXISTS (SELECT 1 FROM public.wh_receipt_robot_runs WHERE status='PENDING')
   OR NOT EXISTS (SELECT 1 FROM public.wh_receipt_robot_runs WHERE kind='AUTO' AND started_at>now()-interval '29 minutes 30 seconds'));
$$;

REVOKE ALL ON FUNCTION public.wh_receipt_robot_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wh_receipt_robot_due() TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.wh_receipt_robot_request() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wh_receipt_robot_start() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wh_receipt_robot_finish(bigint, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wh_receipt_robot_request() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wh_receipt_robot_start() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wh_receipt_robot_finish(bigint, boolean, text) TO authenticated, service_role;
COMMIT;
