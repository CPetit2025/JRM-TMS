-- Referencias de compra en recojo/punto a punto; entrega vinculada a OT madre.
BEGIN;
DO $policy$ BEGIN
 IF to_regclass('public.transport_lead_time_settings') IS NOT NULL THEN
  UPDATE public.transport_lead_time_settings SET settings=jsonb_set(settings,'{enabled}','false'::jsonb);
 END IF;
END $policy$;
DO $test$
DECLARE actor uuid; site uuid; supplier uuid; req uuid; kind text; reference text;
  payload jsonb; rejected boolean; before_count bigint;
BEGIN
 FOR actor IN SELECT p.id FROM public.profiles p JOIN auth.users u ON u.id=p.id WHERE p.is_active LOOP
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
  EXIT WHEN public.is_tms_admin(); actor:=NULL;
 END LOOP;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C93 FAIL: falta administrador activo'; END IF;
 SELECT s.id INTO site FROM public.sites s WHERE public.can_access_site(s.id) ORDER BY s.id LIMIT 1;
 IF site IS NULL THEN RAISE EXCEPTION 'CAJA C93 FAIL: falta sede autorizada'; END IF;
 INSERT INTO public.suppliers(tax_id,business_name) VALUES(
   (floor(random()*90000000000)+10000000000)::bigint::text,'ZZ C93 PROVEEDOR') RETURNING id INTO supplier;
 FOREACH kind IN ARRAY ARRAY['RECOJO','TRASLADO'] LOOP
  FOREACH reference IN ARRAY ARRAY['OC','OS','RQ'] LOOP
   payload:=jsonb_build_object('department','OT (Administración de Contratos)','request_type',kind,
    'attention_mode','TRANSPORTE_JRM','site_id',site,'required_date',current_date+7,
    'cargo_description','ZZ C93','pickup_address','Origen prueba','pickup_district','CHILCA',
    'delivery_address','Destino prueba','delivery_district','CALLAO','service_cost',1,
    'reference_type',reference,'reference_number','  000123  ','supplier_id',supplier,'reference_supplier_id',supplier);
   req:=public.save_transport_request(NULL,payload,'[]');
   PERFORM public.apply_request_supplier(req,payload);
   IF NOT EXISTS(SELECT 1 FROM public.transport_requests WHERE id=req AND contract_id IS NULL
      AND reference_type=reference AND reference_number='000123' AND supplier_id=supplier AND site_id=site) THEN
    RAISE EXCEPTION 'CAJA C93 FAIL: no conserva referencia/proveedor sin OT';
   END IF;
   rejected:=false;
   BEGIN PERFORM public.save_transport_request(NULL,payload-'reference_number','[]');
   EXCEPTION WHEN raise_exception THEN rejected:=SQLERRM LIKE 'Seleccione OC%'; END;
   IF NOT rejected THEN RAISE EXCEPTION 'CAJA C93 FAIL: permite referencia sin número'; END IF;
  END LOOP;
 END LOOP;
 rejected:=false;
 BEGIN PERFORM public.save_transport_request(NULL,payload||jsonb_build_object('request_type','DESPACHO'),'[]');
 EXCEPTION WHEN raise_exception THEN rejected:=SQLERRM LIKE 'Seleccione una OT madre%'; END;
 IF NOT rejected THEN RAISE EXCEPTION 'CAJA C93 FAIL: entrega permite omitir madre'; END IF;
 SELECT count(*) INTO before_count FROM public.transport_requests;
 rejected:=false;
 BEGIN PERFORM public.save_transport_request_full(NULL,payload-'supplier_id','[]','[]');
 EXCEPTION WHEN raise_exception THEN rejected:=SQLERRM LIKE 'Seleccione el proveedor%'; END;
 IF NOT rejected OR (SELECT count(*) FROM public.transport_requests)<>before_count THEN
  RAISE EXCEPTION 'CAJA C93 FAIL: proveedor omitido o guardado parcial';
 END IF;
 IF has_function_privilege('anon','public.save_transport_request_full(uuid,jsonb,jsonb,jsonb)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C93 FAIL: acceso anónimo';
 END IF;
 RAISE EXCEPTION 'CAJA C93 PASS: OC/OS/RQ sin OT para recojo y punto a punto, entrega con madre, proveedor y transacción protegidos';
END $test$;
ROLLBACK;
