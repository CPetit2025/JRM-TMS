-- CAJA C109 — Entrega «Rechazada en destino» (total y parcial) y llegada registrada por el Copiloto con ubicación.
-- Siempre se revierte.
BEGIN;
DO $test$
DECLARE admin_id uuid; actor uuid; driver uuid; carrier uuid; site uuid; ot uuid := gen_random_uuid(); ra uuid; rb uuid; rc uuid; trip uuid;
  r jsonb; op uuid := gen_random_uuid(); pa text; pb text; bad boolean; pass int := 0; fails text[] := '{}';
  addr text := 'Av. Prueba C109 1234, Lurín';
BEGIN
 -- Permisos
 IF has_function_privilege('anon','public.delivery_reject_driver(uuid,uuid,text,text,text,text[],numeric,numeric,numeric,uuid,timestamptz)','EXECUTE')
  OR has_function_privilege('anon','public.delivery_rejection_decide(uuid,uuid,text,text,timestamptz,text)','EXECUTE')
  OR has_function_privilege('anon','public.delivery_arrive_at(uuid,uuid,numeric,numeric,numeric,text)','EXECUTE')
  OR has_function_privilege('anon','public.delivery_arrive_undo(uuid,uuid)','EXECUTE')
  OR has_function_privilege('authenticated','public.get_active_trip_context_before_delivery_status()','EXECUTE')
  OR has_function_privilege('authenticated','public.delivery_rejection_notify(uuid)','EXECUTE')
  OR has_table_privilege('authenticated','public.delivery_rejections','SELECT')
  OR NOT has_function_privilege('authenticated','public.delivery_reject_driver(uuid,uuid,text,text,text,text[],numeric,numeric,numeric,uuid,timestamptz)','EXECUTE')
  OR NOT has_function_privilege('authenticated','public.get_active_trip_context()','EXECUTE')
  -- Las fotos de guía, Packing List y rechazo quedan protegidas contra borrado
  OR position('packing_photos' IN pg_get_functiondef('public.delivery_photo_mutable(text)'::regprocedure))=0
  OR position('delivery_rejections' IN pg_get_functiondef('public.delivery_photo_mutable(text)'::regprocedure))=0
 THEN fails := fails || 'T1 permisos'::text; ELSE pass := pass + 1; END IF;

 -- Datos: OT, tres solicitudes (dos en la ruta, una de otra fecha a la misma dirección), conductor y ruta en curso
 FOR admin_id IN SELECT id FROM public.profiles WHERE is_active LOOP
   PERFORM set_config('request.jwt.claim.sub',admin_id::text,true); EXIT WHEN public.is_tms_admin(); admin_id:=NULL;
 END LOOP;
 SELECT id INTO actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users) AND id IS DISTINCT FROM admin_id
   AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) LIMIT 1;
 SELECT carrier_id,site_id INTO carrier,site FROM public.vehicles WHERE carrier_id IS NOT NULL AND site_id IS NOT NULL LIMIT 1;
 IF admin_id IS NULL OR actor IS NULL OR site IS NULL THEN RAISE EXCEPTION 'CAJA C109 FAIL: faltan administrador, perfil disponible o sede'; END IF;
 PERFORM set_config('request.jwt.claims',json_build_object('sub',admin_id,'role','authenticated')::text,true);
 UPDATE public.profiles SET is_active=true WHERE id=actor;
 INSERT INTO public.drivers(carrier_id,profile_id,first_name,last_name,document_number,license_number,is_active)
 VALUES(carrier,actor,'Conductor','Prueba C109','ZZ-C109-DNI','ZZ-C109-LIC',true) RETURNING id INTO driver;
 INSERT INTO public.contracts(id,code,site_id) VALUES(ot,'ZZ-C109',site);
 INSERT INTO public.transport_requests(request_number,status,site_id,requester_name,department,request_type,cargo_description,pickup_address,pickup_district,delivery_address,delivery_district,required_date,contract_id)
 VALUES('ZZ-C109-A','EN TRANSITO',site,'Prueba C109','Logística','RECOJO','Carga','Planta','LURIN',addr,'LURIN',current_date,ot) RETURNING id INTO ra;
 INSERT INTO public.transport_requests(request_number,status,site_id,requester_name,department,request_type,cargo_description,pickup_address,pickup_district,delivery_address,delivery_district,required_date,contract_id)
 VALUES('ZZ-C109-B','EN TRANSITO',site,'Prueba C109','Logística','RECOJO','Carga','Planta','LURIN','Jr. Destino C109 B 55, Chilca','CHILCA',current_date,ot) RETURNING id INTO rb;
 INSERT INTO public.transport_requests(request_number,status,site_id,requester_name,department,request_type,cargo_description,pickup_address,pickup_district,delivery_address,delivery_district,required_date,contract_id)
 VALUES('ZZ-C109-C','APROBADA',site,'Prueba C109','Logística','RECOJO','Carga','Planta','LURIN',upper(addr),'LURIN',current_date+1,ot) RETURNING id INTO rc;
 INSERT INTO public.dispatches(dispatch_number,vehicle_plate,driver_id,driver_name,status,site_id,scheduled_departure)
 VALUES('ZZ-C109','ZZC109',driver,'Conductor Prueba C109','EN RUTA',site,now()) RETURNING id INTO trip;
 INSERT INTO public.dispatch_requests(dispatch_id,transport_request_id,status,sequence_order) VALUES(trip,ra,'EN_CURSO',1),(trip,rb,'EN_CURSO',2);
 pa := actor::text||'/'||trip::text||'/'||ra::text||'/c109-r0.jpg'; pb := actor::text||'/'||trip::text||'/'||rb::text||'/c109-r0.jpg';
 INSERT INTO storage.objects(bucket_id,name) VALUES('driver_evidence',pa),('driver_evidence',pb);

 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);

 -- T2: llegada automática (geocerca) solo con GPS preciso; el conductor la deshace; la manual no se deshace
 bad:=false; BEGIN PERFORM public.delivery_arrive_at(trip,ra,-12.2,-76.9,150,'AUTO_GEOCERCA'); EXCEPTION WHEN OTHERS THEN bad:=true; END;
 r := public.delivery_arrive_at(trip,ra,-12.2,-76.9,20,'AUTO_GEOCERCA');
 bad := bad AND r->>'source'='AUTO_GEOCERCA' AND (public.delivery_get(trip,ra)->>'arrival_source')='AUTO_GEOCERCA';
 bad := bad AND (public.delivery_arrive_undo(trip,ra)->>'success')::boolean;
 IF bad AND public.delivery_get(trip,ra)->>'arrived_at' IS NULL
    AND EXISTS(SELECT 1 FROM public.dispatch_events WHERE dispatch_id=trip AND event_type='LLEGADA_DESHECHA')
 THEN pass:=pass+1; ELSE fails:=fails||('T2 llegada automática: '||COALESCE(r::text,'∅')); END IF;
 r := public.delivery_arrive_at(trip,ra,-12.20001,-76.90001,12,'MANUAL');
 bad:=false; BEGIN PERFORM public.delivery_arrive_undo(trip,ra); EXCEPTION WHEN OTHERS THEN bad:=true; END;
 IF bad AND (public.delivery_arrive_at(trip,ra,-12.3,-76.8,5,'COPILOTO')->>'already')::boolean
    AND (SELECT arrival_source FROM public.delivery_conformities WHERE dispatch_id=trip AND request_id=ra)='MANUAL'
 THEN pass:=pass+1; ELSE fails:=fails||'T3 llegada manual'::text; END IF;

 -- T4: validaciones del rechazo (motivo, detalle, fotos de la propia entrega)
 bad:=true;
 BEGIN PERFORM public.delivery_reject_driver(trip,ra,'TOTAL','OTRO',NULL,ARRAY[pa],-12.2,-76.9,10,gen_random_uuid(),now()); bad:=false; EXCEPTION WHEN OTHERS THEN NULL; END;
 BEGIN PERFORM public.delivery_reject_driver(trip,ra,'TOTAL','MERCADERIA_DANADA',NULL,'{}'::text[],-12.2,-76.9,10,gen_random_uuid(),now()); bad:=false; EXCEPTION WHEN OTHERS THEN NULL; END;
 BEGIN PERFORM public.delivery_reject_driver(trip,ra,'TOTAL','MERCADERIA_DANADA',NULL,ARRAY[pb],-12.2,-76.9,10,gen_random_uuid(),now()); bad:=false; EXCEPTION WHEN OTHERS THEN NULL; END;
 BEGIN PERFORM public.delivery_reject_driver(trip,rb,'PARCIAL','MERCADERIA_DANADA','',ARRAY[pb],-12.2,-76.9,10,gen_random_uuid(),now()); bad:=false; EXCEPTION WHEN OTHERS THEN NULL; END;
 IF bad THEN pass:=pass+1; ELSE fails:=fails||'T4 validaciones'::text; END IF;

 -- T5: rechazo total del primer punto: parada cerrada sin guía, aviso, la ruta sigue con el segundo punto
 r := public.delivery_reject_driver(trip,ra,'TOTAL','MERCADERIA_DANADA','Cajas aplastadas',ARRAY[pa],-12.2,-76.9,10,op,now());
 bad:=false; BEGIN PERFORM public.delivery_submit_driver(trip,ra,ARRAY[pa],'Cliente',NULL,NULL,gen_random_uuid(),now()); EXCEPTION WHEN OTHERS THEN bad:=SQLERRM LIKE 'Entrega rechazada en destino%'; END;
 IF (r->>'success')::boolean AND NOT (r->>'route_closed')::boolean AND bad
    AND (public.delivery_reject_driver(trip,ra,'TOTAL','MERCADERIA_DANADA','Cajas aplastadas',ARRAY[pa],-12.2,-76.9,10,op,now())->>'duplicate')::boolean
    AND public.delivery_get(trip,ra)->>'state'='RECHAZO_DESTINO' AND public.delivery_rejected(trip,ra) AND NOT public.delivery_open_required(trip,ra)
    AND (SELECT status FROM public.dispatches WHERE id=trip)='EN RUTA'
    AND EXISTS(SELECT 1 FROM public.dispatch_events WHERE dispatch_id=trip AND event_type='INCIDENCIA' AND description LIKE 'Entrega rechazada en destino (total)%')
    AND EXISTS(SELECT 1 FROM public.notifications WHERE dedupe_key='rechazo-'||(r->>'rejection_id'))
 THEN pass:=pass+1; ELSE fails:=fails||('T5 rechazo total: '||COALESCE(r::text,'∅')); END IF;
 r := public.get_active_trip_context();
 IF (SELECT x->>'conformity' FROM jsonb_array_elements(r#>'{trip,stops}') x WHERE x->>'transport_request_id'=ra::text)='RECHAZO_DESTINO'
    AND (r#>>'{pending,stops}')::int=1
    AND (SELECT x->'destination'->>'samples' FROM jsonb_array_elements(r#>'{trip,stops}') x WHERE x->>'transport_request_id'=ra::text)::int>=1
 THEN pass:=pass+1; ELSE fails:=fails||('T6 contexto del viaje: '||COALESCE((r->'trip')::text,'∅')); END IF;

 -- T7: punto del destino aprendido para otra solicitud a la misma dirección (otra escritura)
 r := public.delivery_destination_point(rc);
 IF r IS NOT NULL AND abs((r->>'lat')::numeric+12.20001)<0.0001 AND (r->>'radius_m')::int=150 AND public.delivery_destination_point(rb) IS NULL
 THEN pass:=pass+1; ELSE fails:=fails||('T7 punto aprendido: '||COALESCE(r::text,'∅')); END IF;

 -- T8: rechazo parcial del segundo punto (la guía sigue) y luego total: la ruta se cierra sola
 r := public.delivery_reject_driver(trip,rb,'PARCIAL','PEDIDO_INCORRECTO','Faltaron 2 cajas del producto X',ARRAY[pb],-12.4,-76.7,15,gen_random_uuid(),now());
 IF NOT ((r->>'success')::boolean AND public.delivery_open_required(trip,rb) AND (SELECT status FROM public.dispatches WHERE id=trip)='EN RUTA') THEN
   fails:=fails||'T8 parcial'::text;
 ELSE
   r := public.delivery_reject_driver(trip,rb,'TOTAL','CLIENTE_AUSENTE','Local cerrado',ARRAY[pb],-12.4,-76.7,15,gen_random_uuid(),now());
   IF (SELECT count(*) FROM public.delivery_rejections WHERE dispatch_id=trip AND request_id=rb)=1 AND (r->>'route_closed')::boolean
      AND (SELECT status FROM public.dispatches WHERE id=trip)='RETORNO_COMPLETADO'
   THEN pass:=pass+1; ELSE fails:=fails||('T8 parcial a total y cierre: '||COALESCE(r::text,'∅')||' '||(SELECT status FROM public.dispatches WHERE id=trip)); END IF;
 END IF;

 -- T9: liquidación con la evidencia del rechazo: falta la decisión; el conductor no decide
 r := public.settlement_checklist(trip,ra);
 bad:=false; BEGIN PERFORM public.delivery_rejection_decide(trip,ra,'ANULAR','El conductor intenta decidir'); EXCEPTION WHEN OTHERS THEN bad:=true; END;
 IF r->>'kind'='RECHAZO' AND NOT (r->>'complete')::boolean AND r->'missing'='["DECISION_RECHAZO"]'::jsonb AND bad
 THEN pass:=pass+1; ELSE fails:=fails||('T9 liquidación: '||COALESCE(r::text,'∅')); END IF;

 -- T10: Despacho decide (motivo obligatorio): reprogramar una y anular la otra
 PERFORM set_config('request.jwt.claim.sub',admin_id::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',admin_id,'role','authenticated')::text,true);
 bad:=false; BEGIN PERFORM public.delivery_rejection_decide(trip,ra,'REPROGRAMAR','corto',now()+interval '1 day'); EXCEPTION WHEN OTHERS THEN bad:=true; END;
 r := public.delivery_rejection_decide(trip,ra,'REPROGRAMAR','Cliente pide reenvío con mercadería nueva',
   ((current_date+2)::timestamp+time '09:00') AT TIME ZONE 'America/Lima');
 IF bad AND (public.delivery_get(trip,ra)->>'can_review') IS NOT NULL
    AND (SELECT status FROM public.transport_requests WHERE id=ra)='REPROGRAMADA' AND (SELECT required_date FROM public.transport_requests WHERE id=ra)=current_date+2
    AND (public.settlement_checklist(trip,ra)->>'complete')::boolean
    AND (public.delivery_rejection_decide(trip,rb,'ANULAR','Cliente desiste del pedido por cierre del local')->>'request_status')='CANCELADA'
    AND NOT (public.delivery_get(trip,ra)->>'can_decide')::boolean
 THEN pass:=pass+1; ELSE fails:=fails||('T10 decisión: '||COALESCE(r::text,'∅')); END IF;
 bad:=false; BEGIN PERFORM public.delivery_rejection_decide(trip,ra,'ANULAR','Segunda decisión no permitida'); EXCEPTION WHEN OTHERS THEN bad:=true; END;
 IF bad AND (SELECT x->>'state' FROM jsonb_array_elements(public.delivery_rows_core(trip,false)) x WHERE x->>'request_id'=ra::text)='RECHAZADO_DESTINO'
 THEN pass:=pass+1; ELSE fails:=fails||'T11 resuelto y estado en Torre'::text; END IF;

 IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C109 FAIL (%/11): %', pass, array_to_string(fails, ' | '); END IF;
 RAISE EXCEPTION 'CAJA C109 PASS (11/11) rechazo en destino (total y parcial, aviso, decisión, liquidación) y llegada del Copiloto con ubicación';
END $test$;
ROLLBACK;
