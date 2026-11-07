BEGIN;
-- Una asignación pendiente tampoco puede saltarse mediante programación manual.
DO $$ DECLARE ddl text; old text:='a1.state=''CONFIRMED'' AND a1.dispatch_id IS NULL'; BEGIN
 SELECT pg_get_functiondef('schedule_route_resources(jsonb)'::regprocedure) INTO ddl;
 IF position(old IN ddl)=0 THEN RAISE EXCEPTION 'Cambió la guarda de programación; revise antes de aplicar'; END IF;
 EXECUTE replace(replace(ddl,old,'a1.state IN (''DRAFT'',''APPROVED'',''CONFIRMED'') AND a1.dispatch_id IS NULL'),
 'Seleccione la unidad confirmada de Compras para conservar su trazabilidad','Confirme y seleccione la unidad de Compras para conservar su trazabilidad');
END $$;
CREATE OR REPLACE FUNCTION outsourcing_additional_unit(p_request uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM outsourcing_booking_context c JOIN transport_outsourcing_assignments a ON a.id=c.assignment_id JOIN transport_outsourcing o ON o.id=a.outsourcing_id
 WHERE c.pid=pg_backend_pid() AND c.xid=txid_current() AND o.request_id=p_request AND a.service='FLETE' AND a.state='CONFIRMED' AND a.dispatch_id IS NULL AND a.spec_revision=o.revision AND outsourcing_can_read(p_request)
 AND EXISTS(SELECT 1 FROM transport_outsourcing_assignments prior JOIN dispatches d ON d.id=prior.dispatch_id WHERE prior.outsourcing_id=o.id AND prior.service='FLETE' AND prior.id<>a.id AND prior.state IN ('CONFIRMED','COMPLETED') AND d.status NOT IN ('CANCELADO','ANULADO')))
$$;
REVOKE ALL ON FUNCTION outsourcing_additional_unit(uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
