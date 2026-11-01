-- Liquidación documentaria después de cerrar la ruta (decisión del 01/11/2026): un viaje LIQUIDADO (ruta cerrada y
-- partida ejecutada) admite completar documentos y validar la guía del conductor, para llegar al cierre final sin
-- excepción. Con cierre final vigente (dispatch_final_closures) no se cambia nada: primero se reabre en Torre de Control.
-- Parches guardados: si ya están aplicados no hacen nada; si la función cambió, la migración falla con mensaje.
BEGIN;
SET LOCAL lock_timeout = '60s';

DO $patch$
DECLARE def text;
 v_final text := 'IF EXISTS (SELECT 1 FROM public.dispatch_final_closures WHERE dispatch_id = p_dispatch) THEN
    RAISE EXCEPTION ''El servicio tiene cierre final: reábralo en Torre de Control para cambiar su documentación''; END IF;
  ';
BEGIN
 -- Carga de documentos de liquidación (estado restringido en 20261013190000)
 def := pg_get_functiondef('public.settlement_upload_document(uuid,uuid,text,text,text[],text[],uuid)'::regprocedure);
 IF position('dispatch_final_closures' IN def) = 0 THEN
  IF position('IF d->>''status'' IN (''PROGRAMADO'',''CANCELADO'',''LIQUIDADO'',''CERRADO'') THEN' IN def) = 0 THEN
   RAISE EXCEPTION 'settlement_upload_document cambió: revisar el parche de documentos con la ruta cerrada';
  END IF;
  def := replace(def, 'IF d->>''status'' IN (''PROGRAMADO'',''CANCELADO'',''LIQUIDADO'',''CERRADO'') THEN',
   v_final || 'IF d->>''status'' IN (''PROGRAMADO'',''CANCELADO'',''CERRADO'') THEN');
  def := replace(def, 'cuando la ruta ya salió y no está liquidada', 'cuando la ruta ya salió');
  EXECUTE def;
 END IF;

 -- Validación de la guía del conductor por el Supervisor de Transporte
 def := pg_get_functiondef('public.delivery_review(uuid,uuid,uuid,text,text)'::regprocedure);
 IF position('dispatch_final_closures' IN def) = 0 THEN
  IF position('IF d->>''status'' IN (''LIQUIDADO'',''CERRADO'',''CANCELADO'') THEN RAISE EXCEPTION ''Servicio cerrado''; END IF;' IN def) = 0 THEN
   RAISE EXCEPTION 'delivery_review cambió: revisar el parche de documentos con la ruta cerrada';
  END IF;
  EXECUTE replace(def, 'IF d->>''status'' IN (''LIQUIDADO'',''CERRADO'',''CANCELADO'') THEN RAISE EXCEPTION ''Servicio cerrado''; END IF;',
   v_final || 'IF d->>''status'' IN (''CERRADO'',''CANCELADO'') THEN RAISE EXCEPTION ''Servicio cerrado''; END IF;');
 END IF;

 -- Dar por liquidado (ya admitía LIQUIDADO): tampoco con cierre final vigente
 def := pg_get_functiondef('public.settlement_mark_settled(uuid,uuid,text)'::regprocedure);
 IF position('dispatch_final_closures' IN def) = 0 THEN
  IF position('IF d->>''status'' IN (''PROGRAMADO'',''CANCELADO'') THEN' IN def) = 0 THEN
   RAISE EXCEPTION 'settlement_mark_settled cambió: revisar el parche de documentos con la ruta cerrada';
  END IF;
  EXECUTE replace(def, 'IF d->>''status'' IN (''PROGRAMADO'',''CANCELADO'') THEN', v_final || 'IF d->>''status'' IN (''PROGRAMADO'',''CANCELADO'') THEN');
 END IF;
END $patch$;

NOTIFY pgrst, 'reload schema';
COMMIT;
