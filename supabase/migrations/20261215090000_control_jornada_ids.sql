-- Control de Jornada · Fase 3: unit_daily_report expone el id de cada ruta y de cada solicitud, para abrir desde la
-- jornada el detalle del despacho (documentos, evidencias y costos originales). Parche guardado.
BEGIN;
DO $patch$
DECLARE def text := pg_get_functiondef('public.unit_daily_report(text,date,date)'::regprocedure);
 o1 text := 'jsonb_build_object(''dispatch_number'', disp.dispatch_number,';
 o2 text := 'jsonb_build_object(''sequence'', s.sequence_order,';
BEGIN
 IF position('''request_id'', s.request_id' IN def) > 0 THEN RETURN; END IF;
 IF position(o1 IN def) = 0 OR position(o2 IN def) = 0 THEN RAISE EXCEPTION 'unit_daily_report cambió: revisar el parche de ids de la jornada'; END IF;
 EXECUTE replace(replace(def, o1, 'jsonb_build_object(''id'', disp.id, ''dispatch_number'', disp.dispatch_number,'),
   o2, 'jsonb_build_object(''request_id'', s.request_id, ''sequence'', s.sequence_order,');
END $patch$;
NOTIFY pgrst, 'reload schema';
COMMIT;
