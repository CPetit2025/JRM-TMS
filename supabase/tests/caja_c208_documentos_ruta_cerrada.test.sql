-- C208: la liquidación documentaria admite viajes con la ruta cerrada (LIQUIDADO) y se bloquea con cierre final vigente.
BEGIN;
DO $$
DECLARE f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.settlement_upload_document(uuid,uuid,text,text,text[],text[],uuid)','public.delivery_review(uuid,uuid,uuid,text,text)',
   'public.settlement_mark_settled(uuid,uuid,text)'] LOOP
  IF position('dispatch_final_closures' IN pg_get_functiondef(f::regprocedure)) = 0 THEN
   RAISE EXCEPTION 'CAJA C208 FAIL: % no respeta el cierre final', f;
  END IF;
 END LOOP;
 IF position('''LIQUIDADO''' IN pg_get_functiondef('public.settlement_upload_document(uuid,uuid,text,text,text[],text[],uuid)'::regprocedure)) > 0 THEN
  RAISE EXCEPTION 'CAJA C208 FAIL: la carga de documentos sigue rechazando la ruta cerrada';
 END IF;
 RAISE EXCEPTION 'CAJA C208 PASS: documentos de la ruta cerrada hasta el cierre final';
END $$;
ROLLBACK;
