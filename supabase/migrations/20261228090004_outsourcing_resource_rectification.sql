BEGIN;
CREATE FUNCTION outsourcing_assignment_rectify(p_id uuid,p_version integer,p_resource jsonb,p_note text,p_acknowledge boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a transport_outsourcing_assignments; o transport_outsourcing; d dispatches;
BEGIN
 SELECT o1.* INTO o FROM transport_outsourcing o1 JOIN transport_outsourcing_assignments a1 ON a1.outsourcing_id=o1.id WHERE a1.id=p_id FOR UPDATE OF o1;
 SELECT * INTO a FROM transport_outsourcing_assignments WHERE id=p_id FOR UPDATE;
 IF a.id IS NULL OR NOT outsourcing_can_read(o.request_id) OR NOT has_tms_permission('compras-tercerizaciones') OR NOT has_tms_permission('despacho-aprobacion') THEN RAISE EXCEPTION 'Requiere autorización de Compras y Supervisor de Transporte'; END IF;
 IF a.version<>p_version THEN RAISE EXCEPTION 'La asignación cambió; actualice'; END IF;
 IF a.dispatch_id IS NULL OR a.state<>'CONFIRMED' THEN RAISE EXCEPTION 'La rectificación aplica a un recurso confirmado y programado'; END IF;
 SELECT * INTO d FROM dispatches WHERE id=a.dispatch_id FOR UPDATE;
 IF d.status<>'PROGRAMADO' THEN RAISE EXCEPTION 'El despacho ya inició; registre una incidencia mediante el control operativo'; END IF;
 IF p_acknowledge IS DISTINCT FROM true OR length(btrim(p_note))<10 THEN RAISE EXCEPTION 'Confirme el impacto sobre el despacho e indique motivo de al menos 10 caracteres'; END IF;
 IF jsonb_typeof(p_resource)<>'object' OR octet_length(p_resource::text)>30000 THEN RAISE EXCEPTION 'Ficha de recurso inválida'; END IF;
 -- Costo, proveedor, cantidad y período son inmutables aquí: cambian mediante cancelación/reprogramación nativa.
 UPDATE transport_outsourcing_assignments SET resource=p_resource,version=version+1,updated_at=now() WHERE id=a.id;
 PERFORM outsourcing_assignment_validate(a.id);
 IF a.service='FLETE' THEN
 UPDATE dispatches SET vehicle_plate=upper(p_resource->>'plate'),driver_name=p_resource->>'driver',tercero_conductor=p_resource->>'driver',tercero_doc=p_resource->>'document',tercero_telefono=p_resource->>'phone',tercero_license_number=p_resource->>'license',tercero_license_expiration=(p_resource->>'license_expiration')::date WHERE id=d.id;
 END IF;
 INSERT INTO dispatch_events(dispatch_id,event_type,description,created_by) VALUES(d.id,'RECURSO_RECTIFICADO',p_note||' · Asignación '||a.id,auth.uid()::text);
 PERFORM outsourcing_assignment_event(o.id,'RESOURCE_RECTIFIED',p_note,jsonb_build_object('dispatch_id',d.id,'before',to_jsonb(a),'after',(SELECT to_jsonb(x) FROM transport_outsourcing_assignments x WHERE id=a.id)));
END $$;
REVOKE ALL ON FUNCTION outsourcing_assignment_rectify(uuid,integer,jsonb,text,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION outsourcing_assignment_rectify(uuid,integer,jsonb,text,boolean) TO authenticated;
COMMIT;
