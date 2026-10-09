-- El FIFO ya normaliza el ingreso de un traspaso emparejado con el peso de su salida.
-- El kardex debe usar ese mismo peso para no crear TN por diferencias entre hojas del ERP.
-- Conserva intactos los movimientos originales y los pesos de traspasos sin pareja.
BEGIN;
DO $$
DECLARE v_definition text; v_original text:='m.cantidad, m.peso_kg AS kg, m.numrel, m.docrel';
 v_corrected text:='m.cantidad, CASE WHEN m.kind = ''TRASPASO_ENT'' THEN COALESCE(l.kg_in, m.peso_kg) ELSE m.peso_kg END AS kg, m.numrel, m.docrel';
BEGIN
 v_definition:=pg_get_functiondef('public.apt_kardex(jsonb,text,boolean,integer,integer)'::regprocedure);
 IF strpos(v_definition,v_original)>0 THEN
  EXECUTE replace(v_definition,v_original,v_corrected);
 ELSIF strpos(v_definition,v_corrected)=0 THEN
  RAISE EXCEPTION 'La definición de apt_kardex cambió: revisar antes de normalizar los pesos';
 END IF;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
