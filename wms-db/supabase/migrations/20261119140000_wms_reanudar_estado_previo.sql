-- Reanudar devuelve la tarea al estado en que se pausó (PICKING, PACKING o READY_FOR_LOAD), según el último evento
-- TASK_PAUSE (registra «from» desde la fase 2.3). Sin ese evento, vuelve a PICKING como antes.
DO $m$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('wms_private.wh_task_action(uuid, text, text)'::regprocedure);
  IF position('ELSIF v_action=''RESUME'' THEN v_to:=''PICKING'';' IN def) = 0
     OR position('(t.status=''PAUSED'' AND v_to IN (''PICKING'',''CANCELLED'') AND v_action<>''REOPEN_PICKING'')' IN def) = 0 THEN
    RAISE EXCEPTION 'wh_task_action cambió: revisar esta migración';
  END IF;
  def := replace(def, 'ELSIF v_action=''RESUME'' THEN v_to:=''PICKING'';',
    'ELSIF v_action=''RESUME'' THEN v_to:=coalesce((SELECT e.payload->>''from'' FROM public.wh_scan_events e WHERE e.task_id=p_task_id AND e.event_type=''TASK_PAUSE'' AND e.payload->>''from'' IN (''PICKING'',''PACKING'',''READY_FOR_LOAD'') ORDER BY e.occurred_at DESC, e.recorded_at DESC LIMIT 1),''PICKING'');');
  def := replace(def, '(t.status=''PAUSED'' AND v_to IN (''PICKING'',''CANCELLED'') AND v_action<>''REOPEN_PICKING'')',
    '(t.status=''PAUSED'' AND (v_to IN (''PICKING'',''CANCELLED'') OR (v_action=''RESUME'' AND v_to IN (''PACKING'',''READY_FOR_LOAD''))) AND v_action<>''REOPEN_PICKING'')');
  EXECUTE def;
END $m$;
