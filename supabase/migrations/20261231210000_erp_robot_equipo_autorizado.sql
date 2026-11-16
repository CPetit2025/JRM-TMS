-- «Actualizar ahora» del ERP: solo la PC autorizada toma las solicitudes, para que dos PC no se crucen
-- (una PC sin acceso al ERP tomaba la solicitud, fallaba y la PC que sí funcionaba no la atendía).
-- El robot nuevo envía el nombre del equipo; el robot antiguo (sin equipo) ya no toma solicitudes.
-- Cambiar de PC: UPDATE public.erp_robot_config SET equipo = '<NOMBRE-PC>';

CREATE TABLE IF NOT EXISTS public.erp_robot_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  equipo text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.erp_robot_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.erp_robot_config;
CREATE POLICY security_active_account ON public.erp_robot_config AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.erp_robot_config FROM PUBLIC, anon, authenticated;
INSERT INTO public.erp_robot_config (equipo) VALUES ('CHI-DES-001') ON CONFLICT (id) DO NOTHING;

-- Robot antiguo: ya no toma solicitudes
CREATE OR REPLACE FUNCTION public.erp_robot_start()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT NULL::jsonb $$;
REVOKE ALL ON FUNCTION public.erp_robot_start() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_robot_start() TO authenticated;

CREATE OR REPLACE FUNCTION public.erp_robot_start(p_equipo text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE v_id bigint;
BEGIN
  IF NOT public.apt_can_load() THEN RAISE EXCEPTION 'No tiene permiso para actualizar los datos del ERP' USING ERRCODE = '42501'; END IF;
  IF upper(trim(coalesce(p_equipo, ''))) IS DISTINCT FROM (SELECT upper(trim(equipo)) FROM public.erp_robot_config) THEN
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
