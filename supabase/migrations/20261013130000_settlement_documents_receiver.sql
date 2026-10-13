-- Incidente C96: en producción delivery_submit_core exige quién recibió la entrega. La guía cargada en liquidación
-- registra el receptor indicado por Documentos o, si no se indica, «Según guía firmada».
DO $patch$
DECLARE sig regprocedure:='public.settlement_upload_document(uuid,uuid,text,text,text[],text[],uuid)'::regprocedure; def text; changed text;
BEGIN
 def:=pg_get_functiondef(sig);
 changed:=replace(def,$o$public.delivery_submit_core(p_dispatch,p_request,p_files,NULL,$o$,$n$public.delivery_submit_core(p_dispatch,p_request,p_files,'Según guía firmada (Documentos)',$n$);
 IF changed=def THEN RAISE EXCEPTION 'Motor no reconocido: %',sig; END IF;
 EXECUTE changed;
END $patch$;
