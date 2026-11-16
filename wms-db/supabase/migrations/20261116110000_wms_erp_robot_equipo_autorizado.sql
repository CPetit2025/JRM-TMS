-- «Actualizar ahora» del ERP en el WMS: solo la PC autorizada toma las solicitudes (la misma PC del robot de
-- ingresos, wh_receipt_robot_config). El robot antiguo (sin equipo) ya no toma solicitudes.

CREATE OR REPLACE FUNCTION public.erp_robot_start()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT NULL::jsonb $$;
REVOKE ALL ON FUNCTION public.erp_robot_start() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_robot_start() TO authenticated;

CREATE OR REPLACE FUNCTION public.erp_robot_start(p_equipo text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE v_id bigint;
BEGIN
  PERFORM public.erp_robot_assert();
  IF upper(trim(coalesce(p_equipo, ''))) IS DISTINCT FROM (SELECT upper(trim(equipo)) FROM public.wh_receipt_robot_config) THEN
    RETURN NULL;  -- otra PC: no es la autorizada
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('erp-robot'));
  UPDATE public.erp_robot_runs SET status = 'ERROR', finished_at = now(),
    message = 'El robot no informó el resultado en 60 minutos (PC apagada o ejecución cortada).'
   WHERE status = 'RUNNING' AND started_at <= now() - interval '60 minutes';
  IF EXISTS (SELECT 1 FROM public.erp_robot_runs WHERE status = 'RUNNING') THEN RETURN NULL; END IF;
  UPDATE public.erp_robot_runs SET status = 'RUNNING', started_at = now()
   WHERE id = (SELECT id FROM public.erp_robot_runs WHERE status = 'PENDING' ORDER BY id LIMIT 1)
   RETURNING id INTO v_id;
  RETURN CASE WHEN v_id IS NULL THEN NULL ELSE jsonb_build_object('id', v_id) END;
END $function$;
REVOKE ALL ON FUNCTION public.erp_robot_start(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_robot_start(text) TO authenticated;
