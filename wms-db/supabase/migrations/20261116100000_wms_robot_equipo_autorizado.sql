-- Robot de ingresos WMS: una sola PC autorizada toma los turnos de carga, para que dos PC no se crucen
-- (una PC sin acceso al ERP tomaba cada turno, fallaba y dejaba sin carga a la que sí funcionaba).
-- El robot nuevo envía el nombre del equipo; el robot antiguo (sin equipo) ya no recibe turnos.
-- Cambiar de PC: UPDATE public.wh_receipt_robot_config SET equipo = '<NOMBRE-PC>';

CREATE TABLE IF NOT EXISTS public.wh_receipt_robot_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  equipo text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.wh_receipt_robot_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wh_receipt_robot_config FROM anon, authenticated;
INSERT INTO public.wh_receipt_robot_config (equipo) VALUES ('CHI-DES-001') ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.wh_receipt_robot_runs ADD COLUMN IF NOT EXISTS equipo text;

-- Robot antiguo: ya no toma turnos (devuelve "no toca")
CREATE OR REPLACE FUNCTION public.wh_receipt_robot_start()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT NULL::jsonb $$;
REVOKE ALL ON FUNCTION public.wh_receipt_robot_start() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_receipt_robot_start() TO authenticated;

CREATE OR REPLACE FUNCTION public.wh_receipt_robot_start(p_equipo text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE v_id bigint; v_kind text;
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-carga','almacen-supervisor']) THEN
  RAISE EXCEPTION 'Sin permiso para actualizar ingresos WMS' USING ERRCODE='42501';
 END IF;
 IF upper(trim(coalesce(p_equipo,''))) IS DISTINCT FROM
    (SELECT upper(trim(equipo)) FROM public.wh_receipt_robot_config) THEN
  RETURN NULL;  -- otra PC: no es la autorizada
 END IF;
 PERFORM pg_advisory_xact_lock(hashtext('wms-receipt-robot'));
 UPDATE public.wh_receipt_robot_runs SET status='ERROR', finished_at=now(),
  message='El robot no informó el resultado en 30 minutos (PC apagada o ejecución cortada).'
  WHERE status='RUNNING' AND started_at<=now()-interval '30 minutes';
 IF EXISTS (SELECT 1 FROM public.wh_receipt_robot_runs WHERE status='RUNNING') THEN RETURN NULL; END IF;
 UPDATE public.wh_receipt_robot_runs SET status='RUNNING', started_at=now(), equipo=p_equipo
  WHERE id=(SELECT id FROM public.wh_receipt_robot_runs WHERE status='PENDING' ORDER BY id LIMIT 1)
  RETURNING id, kind INTO v_id, v_kind;
 IF v_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.wh_receipt_robot_runs
   WHERE kind='AUTO' AND started_at>now()-interval '4 minutes 30 seconds') THEN
  INSERT INTO public.wh_receipt_robot_runs(kind,status,started_at,equipo) VALUES ('AUTO','RUNNING',now(),p_equipo)
   RETURNING id, kind INTO v_id, v_kind;
 END IF;
 RETURN CASE WHEN v_id IS NULL THEN NULL ELSE jsonb_build_object('id',v_id,'kind',v_kind) END;
END $function$;
REVOKE ALL ON FUNCTION public.wh_receipt_robot_start(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_receipt_robot_start(text) TO authenticated;
