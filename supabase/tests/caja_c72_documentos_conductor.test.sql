-- C72 Documentos a cargo del conductor:
-- T1 una ruta sin documentos confirmados puede salir (la salida no depende del Packing List ni de la guía).
-- T2 la programación propia y tercerizada ya no marca rutas con exigencia de documentos.
-- T3 el conductor adjunta el Packing List con la guía (app y enlace): funciones privadas, acción offline
--    instalada y fotos protegidas contra borrado.
BEGIN;
CREATE FUNCTION pg_temp.c72_can_depart(p_id uuid) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.dispatches SET status = 'EN_CURSO' WHERE id = p_id;
  RAISE EXCEPTION 'C72_SALIDA_PERMITIDA';
EXCEPTION WHEN OTHERS THEN RETURN NULLIF(SQLERRM, 'C72_SALIDA_PERMITIDA');
END $$;
DO $test$
DECLARE site uuid; d uuid; v_err text;
BEGIN
 SELECT id INTO site FROM public.sites LIMIT 1;
 INSERT INTO public.dispatches(dispatch_number,vehicle_plate,status,site_id,scheduled_departure,docs_required)
 VALUES('ZZ-C72','ZZC72'||substr(gen_random_uuid()::text,1,4),'PROGRAMADO',site,now(),true) RETURNING id INTO d;
 v_err:=pg_temp.c72_can_depart(d);
 IF v_err IS NOT NULL THEN RAISE EXCEPTION 'CAJA C72 FAIL (T1): la salida sigue condicionada: %', v_err; END IF;
 IF position('docs_required=false' IN pg_get_functiondef('public.schedule_dispatch(uuid,text,timestamptz,numeric,numeric,uuid,text,jsonb)'::regprocedure))=0
 OR position('docs_required=false' IN pg_get_functiondef('public.schedule_dispatch_tercero(uuid,text,text,text,text,timestamptz,numeric,numeric,uuid,jsonb)'::regprocedure))=0 THEN
  RAISE EXCEPTION 'CAJA C72 FAIL (T2): la programación aún exige documentos de salida';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='delivery_submissions' AND column_name='packing_photos')
 OR has_function_privilege('anon','public.delivery_set_packing(uuid,uuid,uuid,text[],text)','EXECUTE')
 OR has_function_privilege('authenticated','public.delivery_set_packing(uuid,uuid,uuid,text[],text)','EXECUTE')
 OR has_function_privilege('anon','public.delivery_public_set_packing(text,uuid,uuid,text[])','EXECUTE')
 OR has_function_privilege('authenticated','public.delivery_public_set_packing(text,uuid,uuid,text[])','EXECUTE')
 OR NOT has_function_privilege('service_role','public.delivery_public_set_packing(text,uuid,uuid,text[])','EXECUTE')
 OR position('delivery_set_packing' IN pg_get_functiondef('public.execute_driver_offline_action(uuid,text,jsonb)'::regprocedure))=0
 OR position('packing_photos' IN pg_get_functiondef('public.delivery_photo_mutable(text)'::regprocedure))=0
 OR position('packing_photos' IN pg_get_functiondef('public.get_public_tracking_portal_info(uuid,text,date,date)'::regprocedure))=0
 OR position('s.packing_photos ELSE s.photos' IN pg_get_functiondef('public.get_public_tracking_document(uuid,text,text,uuid,uuid,integer)'::regprocedure))=0 THEN
  RAISE EXCEPTION 'CAJA C72 FAIL (T3): Packing List del conductor sin instalar o expuesto';
 END IF;
 RAISE EXCEPTION 'CAJA C72 PASS (3/3) salida sin documentos; Packing List y guía a cargo del conductor';
END $test$;
ROLLBACK;
