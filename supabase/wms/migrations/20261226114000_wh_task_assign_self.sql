BEGIN;

CREATE OR REPLACE FUNCTION public.wh_assign_task(p_task_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  t public.wh_tasks%ROWTYPE;
BEGIN
  PERFORM public.security_assert_active_session();
  SELECT * INTO t FROM public.wh_tasks WHERE id=p_task_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN
    RAISE EXCEPTION 'Tarea no disponible';
  END IF;
  IF NOT public.wh_has_permission(ARRAY['almacen-picking','almacen-supervisor']) THEN
    RAISE EXCEPTION 'Sin permiso para asignar tareas';
  END IF;
  IF t.status IN ('LOADED','RECONCILED','CANCELLED') THEN
    RAISE EXCEPTION 'No se puede asignar una tarea cerrada';
  END IF;
  IF t.assigned_picker IS NOT NULL
     AND t.assigned_picker <> auth.uid()
     AND NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN
    RAISE EXCEPTION 'La tarea ya está asignada a otro operador';
  END IF;

  UPDATE public.wh_tasks
  SET assigned_picker=auth.uid(),updated_by=auth.uid()
  WHERE id=t.id;

  RETURN jsonb_build_object('task_id',t.id,'assigned_picker',auth.uid(),'assigned',true);
END
$$;

REVOKE ALL ON FUNCTION public.wh_assign_task(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.wh_assign_task(uuid) TO authenticated;

COMMIT;
