-- Portal público: el registro de solicitudes (calendario) y la ruta del día muestran el cliente o el proveedor de
-- cada servicio. Entregas: cliente de la OT o el elegido en la solicitud (transport_requests.client_id). Recojos y
-- traslados: proveedor (supplier_id). Se reescribe la función sobre su definición vigente (alcance y PIN intactos).
BEGIN;
DO $portal$
DECLARE source text; changed text;
BEGIN
 SELECT pg_get_functiondef('public.get_public_tracking_portal_info(uuid,text,date,date)'::regprocedure) INTO source;
 IF position('supplier_name' IN source)>0 THEN RETURN; END IF;
 -- 1. Registro de solicitudes
 changed:=replace(source,'''client_name'',cl.business_name,',
  '''client_name'',COALESCE(cl.business_name,(SELECT xc.business_name FROM public.clients xc WHERE xc.id=t.client_id)),'
  '''supplier_name'',(SELECT xs.business_name FROM public.suppliers xs WHERE xs.id=NULLIF(to_jsonb(t)->>''supplier_id'','''')::uuid),');
 IF changed=source THEN RAISE EXCEPTION 'No se pudo agregar cliente/proveedor al registro del portal'; END IF;
 source:=changed;
 -- 2. Paradas de la ruta
 changed:=replace(source,'cl.business_name AS client_name,',
  'COALESCE(cl.business_name,(SELECT xc.business_name FROM public.clients xc WHERE xc.id=t.client_id)) AS client_name,'
  '(SELECT xs.business_name FROM public.suppliers xs WHERE xs.id=NULLIF(to_jsonb(t)->>''supplier_id'','''')::uuid) AS supplier_name,'
  't.request_type AS req_type,to_jsonb(t)->>''attention_mode'' AS req_mode,');
 IF changed=source THEN RAISE EXCEPTION 'No se pudo agregar cliente/proveedor a las paradas del portal'; END IF;
 source:=changed;
 changed:=replace(source,'''sequence_order'',sequence_order,''client_name'',client_name,',
  '''sequence_order'',sequence_order,''client_name'',client_name,''supplier_name'',supplier_name,''request_type'',req_type,''attention_mode'',req_mode,');
 IF changed=source THEN RAISE EXCEPTION 'No se pudo publicar cliente/proveedor de la ruta del portal'; END IF;
 EXECUTE changed;
END $portal$;
NOTIFY pgrst, 'reload schema';
COMMIT;
