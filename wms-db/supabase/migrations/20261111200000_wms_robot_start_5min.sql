-- Completa 20261111190000: wh_receipt_robot_start también decidía la ejecución automática cada 30 min.
-- Ahora cada 5 min, igual que wh_receipt_robot_due. Sin cambios en permisos.
CREATE OR REPLACE FUNCTION public.wh_receipt_robot_start()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
   WHERE kind='AUTO' AND started_at>now()-interval '4 minutes 30 seconds') THEN
  INSERT INTO public.wh_receipt_robot_runs(kind,status,started_at) VALUES ('AUTO','RUNNING',now()) RETURNING id, kind INTO v_id, v_kind;
 END IF;
 RETURN CASE WHEN v_id IS NULL THEN NULL ELSE jsonb_build_object('id',v_id,'kind',v_kind) END;
END $function$;
