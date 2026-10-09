-- Portal público: el registro de solicitudes muestra el distrito, y la guía de remisión que sube el conductor
-- (app o enlace) se puede ver apenas se recibe, sin esperar la validación de Transporte. Una guía observada o
-- rechazada no se muestra. Se reescriben las funciones sobre su definición vigente (alcance y pgcrypto intactos).
BEGIN;
DO $portal$
DECLARE source text; changed text;
BEGIN
 SELECT pg_get_functiondef('public.get_public_tracking_portal_info(uuid,text,date,date)'::regprocedure) INTO source;
 changed:=replace(source,'''pickup_address'',t.pickup_address,''delivery_address'',t.delivery_address,''status'',t.status) x',
  '''pickup_address'',t.pickup_address,''delivery_address'',t.delivery_address,''pickup_district'',to_jsonb(t)->>''pickup_district'',''delivery_district'',to_jsonb(t)->>''delivery_district'',''status'',t.status) x');
 IF changed=source THEN RAISE EXCEPTION 'No se pudo agregar el distrito al portal'; END IF;
 source:=changed;
 changed:=replace(source,'''signed_photos'',CASE WHEN conformity_state=''VALIDADA'' THEN','''signed_photos'',CASE WHEN conformity_state IN (''RECIBIDA'',''VALIDADA'') THEN');
 IF changed=source THEN RAISE EXCEPTION 'No se pudo habilitar la guía recibida en el portal'; END IF;
 EXECUTE changed;

 SELECT pg_get_functiondef('public.get_public_tracking_document(uuid,text,text,uuid,uuid,integer)'::regprocedure) INTO source;
 changed:=replace(source,'c.state=''VALIDADA''','c.state IN (''RECIBIDA'',''VALIDADA'')');
 IF changed=source THEN RAISE EXCEPTION 'No se pudo habilitar la guía recibida en los documentos del portal'; END IF;
 EXECUTE changed;
END $portal$;
COMMIT;
