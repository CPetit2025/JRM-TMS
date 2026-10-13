-- Liquidación documental por servicio: se puede completar desde que la ruta sale (no solo con cierre operativo).
-- Una unidad con varias entregas puede liquidar el servicio ya atendido mientras sigue en ruta. La bandeja
-- «Liquidación pendiente» sigue mostrando solo rutas cerradas.
DO $patch$
DECLARE sig regprocedure:='public.settlement_upload_document(uuid,uuid,text,text,text[],text[],uuid)'::regprocedure; def text; changed text;
BEGIN
 def:=pg_get_functiondef(sig);
 changed:=replace(def,
  $o$IF d->>'status' NOT IN ('CIERRE_OPERATIVO','RETORNO_COMPLETADO','ENTREGADO') THEN
  RAISE EXCEPTION 'Solo se completan documentos de servicios en liquidación pendiente (estado %)',d->>'status'; END IF;$o$,
  $n$IF d->>'status' IN ('PROGRAMADO','CANCELADO','LIQUIDADO','CERRADO') THEN
  RAISE EXCEPTION 'Los documentos de liquidación pendiente se completan cuando la ruta ya salió y no está liquidada (estado %)',d->>'status'; END IF;$n$);
 IF changed=def THEN RAISE EXCEPTION 'Motor no reconocido: %',sig; END IF;
 EXECUTE changed;
END $patch$;
