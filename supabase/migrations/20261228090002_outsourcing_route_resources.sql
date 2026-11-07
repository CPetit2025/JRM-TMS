BEGIN;
-- Contexto privado; un cliente no puede habilitar la excepción para una segunda unidad modificando un GUC.
CREATE TABLE outsourcing_booking_context(pid integer NOT NULL,xid bigint NOT NULL,assignment_id uuid NOT NULL REFERENCES transport_outsourcing_assignments(id),PRIMARY KEY(pid,xid));
ALTER TABLE outsourcing_booking_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON outsourcing_booking_context FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION outsourcing_additional_unit(p_request uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM outsourcing_booking_context c JOIN transport_outsourcing_assignments a ON a.id=c.assignment_id JOIN transport_outsourcing o ON o.id=a.outsourcing_id
 WHERE c.pid=pg_backend_pid() AND c.xid=txid_current() AND o.request_id=p_request AND a.service='FLETE' AND a.state='CONFIRMED' AND a.dispatch_id IS NULL AND a.spec_revision=o.revision AND outsourcing_can_read(p_request))
$$;
REVOKE ALL ON FUNCTION outsourcing_additional_unit(uuid) FROM PUBLIC,anon,authenticated;
DO $$ DECLARE ddl text; old text:='status IN (''APROBADA'', ''REPROGRAMADA'')'; BEGIN
 SELECT pg_get_functiondef('schedule_dispatch_tercero_attention_legacy(uuid,text,text,text,text,timestamptz,numeric,numeric,uuid,jsonb)'::regprocedure) INTO ddl;
 IF position(old IN ddl)=0 THEN RAISE EXCEPTION 'La validación del programador cambió; revise la integración antes de aplicar'; END IF;
 EXECUTE replace(ddl,old,'(status IN (''APROBADA'', ''REPROGRAMADA'') OR (status=''ASIGNADA'' AND public.outsourcing_additional_unit(id)))');
END $$;
CREATE FUNCTION outsourcing_route_resources(p_requests uuid[] DEFAULT NULL,p_dispatch uuid DEFAULT NULL) RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT is_active_tms_user() THEN RAISE EXCEPTION 'Sin acceso'; END IF;
 RETURN QUERY SELECT to_jsonb(a)||jsonb_build_object('request_id',o.request_id,'request_number',t.request_number,'supplier_name',s.business_name,'carrier_id',c.id)
 FROM transport_outsourcing_assignments a JOIN transport_outsourcing o ON o.id=a.outsourcing_id JOIN transport_requests t ON t.id=o.request_id JOIN suppliers s ON s.id=a.supplier_id
 LEFT JOIN carriers c ON c.supplier_id=s.id
 WHERE outsourcing_can_read(o.request_id) AND ((p_dispatch IS NOT NULL AND a.dispatch_id=p_dispatch) OR (p_dispatch IS NULL AND a.state='CONFIRMED' AND a.dispatch_id IS NULL AND a.spec_revision=o.revision AND o.review_status='ACTIVE' AND s.is_active AND (p_requests IS NULL OR o.request_id=ANY(p_requests)))) ORDER BY a.starts_at,a.id;
END $$;
CREATE FUNCTION outsourcing_route_context(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a transport_outsourcing_assignments; o transport_outsourcing; result jsonb;
BEGIN
 SELECT * INTO a FROM transport_outsourcing_assignments WHERE id=p_id;
 SELECT * INTO o FROM transport_outsourcing WHERE id=a.outsourcing_id;
 IF a.id IS NULL OR NOT outsourcing_can_read(o.request_id) OR NOT has_tms_permission('despacho') OR a.state<>'CONFIRMED' OR a.dispatch_id IS NOT NULL OR a.spec_revision<>o.revision THEN RAISE EXCEPTION 'Recurso no disponible para programar'; END IF;
 SELECT to_jsonb(t)||jsonb_build_object('contracts',to_jsonb(c)||jsonb_build_object('clients',(SELECT to_jsonb(cl) FROM clients cl WHERE cl.id=c.client_id),'contract_budgets',(SELECT jsonb_agg(to_jsonb(b)) FROM contract_budgets b WHERE b.contract_id=c.id)),
 'estimated_weight',CASE WHEN a.service='FLETE' THEN (a.resource->>'cargo_weight_kg')::numeric ELSE nullif(to_jsonb(t)->>'estimated_weight','')::numeric END,'transport_request_items',CASE WHEN a.service='FLETE' THEN jsonb_build_array(jsonb_build_object('description','Carga asignada a '||(a.resource->>'plate'),'weight',(a.resource->>'cargo_weight_kg')::numeric,'volume_m3',coalesce(nullif(a.resource->>'volume_m3','')::numeric,0),'quantity',1)) ELSE (SELECT jsonb_agg(to_jsonb(i)) FROM transport_request_items i WHERE i.transport_request_id=t.id) END)
 INTO result FROM transport_requests t LEFT JOIN contracts c ON c.id=t.contract_id WHERE t.id=o.request_id;
 RETURN jsonb_build_object('request',result,'resource',(SELECT value FROM outsourcing_route_resources(ARRAY[o.request_id]) value WHERE value->>'id'=a.id::text));
END $$;
ALTER FUNCTION schedule_route_resources(jsonb) RENAME TO schedule_route_resources_before_outsourcing;
REVOKE ALL ON FUNCTION schedule_route_resources_before_outsourcing(jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION schedule_route_resources(p jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE aid uuid:=nullif(p->>'outsourcing_assignment_id','')::uuid; a transport_outsourcing_assignments; o transport_outsourcing; r jsonb; v uuid; carrier uuid; item jsonb; ids uuid[]:='{}'; costitems jsonb:='[]'; economic_result jsonb; l record; v_concept text; q numeric;
BEGIN
 IF NOT has_tms_permission('despacho') OR NOT is_active_tms_user() THEN RAISE EXCEPTION 'Sin permiso para programar'; END IF;
 IF aid IS NOT NULL THEN ids:=array_append(ids,aid); END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(coalesce(p->'outsourcing_support_ids','[]')) LOOP ids:=array_append(ids,(item#>>'{}')::uuid); END LOOP;
 IF cardinality(ids)<>(SELECT count(DISTINCT x) FROM unnest(ids) x) THEN RAISE EXCEPTION 'Recurso duplicado'; END IF;
 PERFORM 1 FROM transport_requests WHERE id IN(SELECT (value->>'id')::uuid FROM jsonb_array_elements(p->'p_requests')) ORDER BY id FOR UPDATE;
 -- Orden estable: padres, asignaciones y recursos. Conserva validaciones/ledger nativos.
 PERFORM 1 FROM transport_outsourcing WHERE id IN(SELECT outsourcing_id FROM transport_outsourcing_assignments WHERE id=ANY(ids)) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM transport_outsourcing_assignments WHERE id=ANY(ids) ORDER BY id FOR UPDATE;
 FOR a IN SELECT * FROM transport_outsourcing_assignments WHERE id=ANY(ids) ORDER BY id LOOP
 SELECT * INTO o FROM transport_outsourcing WHERE id=a.outsourcing_id;
 IF NOT outsourcing_can_read(o.request_id) OR a.state<>'CONFIRMED' OR a.dispatch_id IS NOT NULL OR a.spec_revision<>o.revision OR o.review_status<>'ACTIVE' THEN RAISE EXCEPTION 'Asignación no disponible o ya programada'; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'p_requests') j WHERE j->>'id'=o.request_id::text) THEN RAISE EXCEPTION 'El recurso no corresponde a las solicitudes seleccionadas'; END IF;
 IF (p->>'p_departure')::timestamptz<a.starts_at OR (p->>'p_departure')::timestamptz>=a.ends_at THEN RAISE EXCEPTION 'La salida debe estar dentro del horario confirmado del recurso'; END IF;
 PERFORM outsourcing_assignment_validate(a.id);
 IF a.id=aid THEN
 IF a.service<>'FLETE' OR jsonb_array_length(p->'p_requests')<>1 THEN RAISE EXCEPTION 'Programe cada unidad tercerizada con su solicitud original'; END IF;
 SELECT id INTO carrier FROM carriers WHERE supplier_id=a.supplier_id AND coalesce((to_jsonb(carriers)->>'is_active')::boolean,true) LIMIT 1;
 IF carrier IS NULL THEN RAISE EXCEPTION 'El proveedor no tiene transportista activo en el catálogo'; END IF;
 r:=a.resource;
 p:=p||jsonb_build_object('mode','TERCERO','p_carrier_id',carrier,'p_plate',upper(r->>'plate'),'p_conductor',r->>'driver','p_telefono',r->>'phone','p_doc',r->>'document',
 'p_tercero_license_number',r->>'license','p_tercero_license_expiration',r->>'license_expiration','p_supplier_vehicle_id',NULL,'p_supplier_personnel_id',NULL,'p_freight_cost',a.amount_pen,
 'freight_reason','Asignación confirmada de Compras '||a.id,'p_requests',jsonb_build_array((p->'p_requests'->0)||jsonb_build_object('freight_share_pen',a.amount_pen)));
 INSERT INTO outsourcing_booking_context VALUES(pg_backend_pid(),txid_current(),a.id);
 ELSIF a.service='FLETE' THEN RAISE EXCEPTION 'Seleccione una sola unidad de transporte por ruta';
 END IF;
 END LOOP;
 IF cardinality(ids)<>(SELECT count(*) FROM transport_outsourcing_assignments WHERE id=ANY(ids)) THEN RAISE EXCEPTION 'Recurso inexistente'; END IF;
 IF aid IS NULL AND EXISTS(SELECT 1 FROM transport_outsourcing_assignments a1 JOIN transport_outsourcing o1 ON o1.id=a1.outsourcing_id WHERE a1.service='FLETE' AND a1.state='CONFIRMED' AND a1.dispatch_id IS NULL AND a1.spec_revision=o1.revision AND EXISTS(SELECT 1 FROM jsonb_array_elements(p->'p_requests') j WHERE j->>'id'=o1.request_id::text)) THEN RAISE EXCEPTION 'Seleccione la unidad confirmada de Compras para conservar su trazabilidad'; END IF;
 -- Los acuerdos auxiliares se construyen en servidor, después de heredar las líneas referenciales.
 -- No aceptar un segundo acuerdo manual de un servicio gestionado.
 IF EXISTS(SELECT 1 FROM transport_outsourcing_assignments x JOIN transport_outsourcing ox ON ox.id=x.outsourcing_id WHERE x.id=ANY(ids) AND x.service<>'FLETE' AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p->'special_services'->'items','[]')) j WHERE j->>'transport_request_id'=ox.request_id::text OR EXISTS(SELECT 1 FROM transport_unloading_costs u WHERE u.id::text=j->>'id' AND u.transport_request_id=ox.request_id))) THEN RAISE EXCEPTION 'Los costos auxiliares confirmados se incorporan automáticamente; retire acuerdos manuales duplicados'; END IF;
 v:=schedule_route_resources_before_outsourcing(p);
 DELETE FROM outsourcing_booking_context WHERE pid=pg_backend_pid() AND xid=txid_current();
 FOR a IN SELECT * FROM transport_outsourcing_assignments WHERE id=ANY(ids) AND service<>'FLETE' ORDER BY id LOOP
 SELECT * INTO o FROM transport_outsourcing WHERE id=a.outsourcing_id;
 v_concept:=CASE WHEN a.service='STOCKA' THEN 'OTROS' ELSE a.service END;
 -- Un costo por proveedor y recurso; reutiliza primero la línea heredada aún sin acuerdo.
 SELECT u.id INTO l FROM transport_unloading_costs u WHERE u.dispatch_id=v AND u.transport_request_id=o.request_id AND u.concept=v_concept AND u.status IN ('ESTIMADO','PLANIFICADO') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(costitems) j WHERE j->>'id'=u.id::text) ORDER BY u.id LIMIT 1;
 costitems:=costitems||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('id',l.id,'transport_request_id',o.request_id,'concept',v_concept,'supplier_id',a.supplier_id,'billing_unit','SERVICIO','agreed_rate',a.amount_pen,'agreed_qty',1,'reason','Asignación de Compras '||a.id,'description',a.service||' · '||a.id)));
 END LOOP;
 IF jsonb_array_length(costitems)>0 THEN economic_result:=set_special_service_agreements(v,jsonb_build_object('items',costitems)); IF coalesce((economic_result->>'success')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION '%',coalesce(economic_result->>'error','No se registró el acuerdo económico'); END IF; END IF;
 UPDATE transport_outsourcing_assignments SET dispatch_id=v,version=version+1,updated_at=now() WHERE id=ANY(ids);
 FOR a IN SELECT * FROM transport_outsourcing_assignments WHERE id=ANY(ids) LOOP PERFORM outsourcing_assignment_event(a.outsourcing_id,'RESOURCE_SCHEDULED','Recurso incorporado al despacho',jsonb_build_object('assignment_id',a.id,'dispatch_id',v,'resource',a.resource,'amount_pen',a.amount_pen)); END LOOP;
 RETURN v;
END $$;
REVOKE ALL ON FUNCTION outsourcing_route_resources(uuid[],uuid),outsourcing_route_context(uuid),schedule_route_resources(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION outsourcing_route_resources(uuid[],uuid),outsourcing_route_context(uuid),schedule_route_resources(jsonb) TO authenticated;
COMMIT;
