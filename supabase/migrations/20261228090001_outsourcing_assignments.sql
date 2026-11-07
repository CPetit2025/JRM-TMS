-- Recursos por servicio: adjudicación independiente, sin generar reservas fuera del programador nativo.
BEGIN;
CREATE TABLE public.transport_outsourcing_assignments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 outsourcing_id uuid NOT NULL REFERENCES transport_outsourcing(id) ON DELETE RESTRICT,
 service text NOT NULL CHECK(service IN ('FLETE','MONTACARGAS','GRUA','STOCKA','ESTIBA','OTROS')),
 supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
 quantity numeric NOT NULL CHECK(quantity>0 AND quantity<=100000),
 resource jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(resource)='object' AND octet_length(resource::text)<=30000),
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK(isfinite(starts_at) AND isfinite(ends_at) AND ends_at>starts_at AND ends_at<=starts_at+interval '90 days'),
 quoted_amount numeric(14,2) NOT NULL CHECK(quoted_amount>0 AND quoted_amount<=100000000), confirmed_amount numeric(14,2) CHECK(confirmed_amount>0 AND confirmed_amount<=100000000),
 currency text NOT NULL DEFAULT 'PEN' CHECK(currency IN ('PEN','USD')), exchange_rate numeric NOT NULL DEFAULT 1 CHECK(exchange_rate>0 AND exchange_rate<=1000),
 amount_pen numeric(14,2) GENERATED ALWAYS AS (round(coalesce(confirmed_amount,quoted_amount)*exchange_rate,2)) STORED,
 terms text NOT NULL CHECK(length(btrim(terms))>=5 AND length(terms)<=3000),
 state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','APPROVED','CONFIRMED','CANCELLED','COMPLETED')),
 version integer NOT NULL DEFAULT 1, spec_revision integer NOT NULL,
 approved_by uuid REFERENCES auth.users(id), confirmed_by uuid REFERENCES auth.users(id),
 dispatch_id uuid REFERENCES dispatches(id) ON DELETE RESTRICT,
 created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outsourcing_assignments_parent ON transport_outsourcing_assignments(outsourcing_id,service);
CREATE INDEX outsourcing_assignments_dispatch ON transport_outsourcing_assignments(dispatch_id) WHERE dispatch_id IS NOT NULL;
CREATE INDEX outsourcing_assignments_availability ON transport_outsourcing_assignments(starts_at,ends_at) WHERE state='CONFIRMED';
ALTER TABLE transport_outsourcing_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_assignments ON transport_outsourcing_assignments FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM transport_outsourcing o WHERE o.id=outsourcing_id AND outsourcing_can_read(o.request_id)));
CREATE POLICY active_account ON transport_outsourcing_assignments AS RESTRICTIVE FOR ALL TO authenticated USING(is_active_tms_user()) WITH CHECK(is_active_tms_user());
REVOKE ALL ON transport_outsourcing_assignments FROM anon,authenticated;
GRANT SELECT ON transport_outsourcing_assignments TO authenticated;

CREATE FUNCTION outsourcing_required(p jsonb) RETURNS TABLE(service text,quantity numeric,required_at text)
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT 'FLETE',CASE WHEN p->>'unit_count' ~ '^[0-9]+$' THEN greatest(1,(p->>'unit_count')::numeric) ELSE 1 END,p->>'required_at' WHERE coalesce(p->>'transport_required','true')<>'false'
 UNION ALL SELECT s->>'kind',CASE WHEN coalesce(s->'details'->>(CASE WHEN s->>'kind'='ESTIBA' THEN 'workers' ELSE 'quantity' END),'') ~ '^[0-9]+(\.[0-9]+)?$'
 THEN greatest(1,(s->'details'->>(CASE WHEN s->>'kind'='ESTIBA' THEN 'workers' ELSE 'quantity' END))::numeric) ELSE 1 END,coalesce(nullif(s->'details'->>'at',''),p->>'required_at')
 FROM jsonb_array_elements(coalesce(p->'services','[]')) s WHERE s->>'kind' IN ('MONTACARGAS','GRUA','STOCKA','ESTIBA','OTROS')
$$;
CREATE FUNCTION outsourcing_assignment_event(p_id uuid,p_action text,p_note text,p_snapshot jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 INSERT INTO transport_outsourcing_events(outsourcing_id,stage,actor_id,actor_name,note,snapshot)
 SELECT id,stage,auth.uid(),coalesce((SELECT concat_ws(' ',first_name,last_name) FROM profiles WHERE id=auth.uid()),auth.uid()::text),p_note,p_snapshot||jsonb_build_object('action',p_action) FROM transport_outsourcing WHERE id=p_id
$$;
CREATE FUNCTION outsourcing_assignment_context(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o transport_outsourcing;
BEGIN
 SELECT * INTO o FROM transport_outsourcing WHERE id=p_id;
 IF NOT FOUND OR NOT outsourcing_can_read(o.request_id) THEN RAISE EXCEPTION 'Sin acceso a la solicitud'; END IF;
 RETURN jsonb_build_object('outsourcing',to_jsonb(o),'requirements',(SELECT jsonb_agg(to_jsonb(r)) FROM outsourcing_required(o.specification) r),
 'assignments',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('supplier_name',s.business_name) ORDER BY a.created_at),'[]') FROM transport_outsourcing_assignments a JOIN suppliers s ON s.id=a.supplier_id WHERE a.outsourcing_id=p_id),
 'suppliers',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.business_name),'[]') FROM suppliers s WHERE s.is_active AND s.category IN ('TRANSPORTE','GRUA','MONTACARGA','ESTIBA','SERVICIOS','OTROS')),
 'vehicles',(SELECT coalesce(jsonb_agg(to_jsonb(v)),'[]') FROM supplier_vehicles v WHERE v.is_active),
 'personnel',(SELECT coalesce(jsonb_agg(to_jsonb(v)),'[]') FROM supplier_personnel v WHERE v.is_active));
END $$;
CREATE FUNCTION outsourcing_management_queue(p jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF NOT is_active_tms_user() THEN RAISE EXCEPTION 'Sin acceso'; END IF;
 WITH entries AS (
 SELECT o.id,o.number,o.request_id,o.stage,o.review_status,o.specification,r.service,r.quantity,r.required_at,
 t.request_number,c.code AS contract_code,cl.business_name AS client,
 coalesce(a.assigned,0) AS assigned,coalesce(a.confirmed,0) AS confirmed,coalesce(a.finished,0) AS finished,
 greatest(0,r.quantity-coalesce(a.assigned,0)) AS remaining,a.suppliers,a.costs,
 CASE WHEN o.review_status='CANCELLED' THEN 'CANCELADA' WHEN o.review_status='OBSERVED' THEN 'OBSERVADA'
 WHEN a.finished>=r.quantity THEN 'FINALIZADA' WHEN a.confirmed>=r.quantity THEN 'CONFIRMADA'
 WHEN a.assigned>=r.quantity THEN 'ASIGNADA' WHEN a.assigned>0 THEN 'PARCIAL' WHEN o.stage>1 THEN 'EN GESTIÓN' ELSE 'PENDIENTE' END AS state
 FROM transport_outsourcing o JOIN transport_requests t ON t.id=o.request_id
 LEFT JOIN contracts c ON c.id=t.contract_id LEFT JOIN clients cl ON cl.id=coalesce(nullif(to_jsonb(t)->>'client_id','')::uuid,c.client_id)
 CROSS JOIN LATERAL outsourcing_required(o.specification) r
 LEFT JOIN LATERAL (
 SELECT sum(a.quantity) AS assigned,sum(a.quantity) FILTER(WHERE a.state IN ('CONFIRMED','COMPLETED')) AS confirmed,sum(a.quantity) FILTER(WHERE a.state='COMPLETED') AS finished,
 string_agg(DISTINCT s.business_name,', ') AS suppliers,
 (SELECT jsonb_agg(x) FROM (SELECT currency,sum(coalesce(confirmed_amount,quoted_amount)) amount,bool_and(state IN ('CONFIRMED','COMPLETED')) confirmed FROM transport_outsourcing_assignments WHERE outsourcing_id=o.id AND service=r.service AND state<>'CANCELLED' AND spec_revision=o.revision GROUP BY currency) x) AS costs
 FROM transport_outsourcing_assignments a JOIN suppliers s ON s.id=a.supplier_id WHERE a.outsourcing_id=o.id AND a.service=r.service AND a.state<>'CANCELLED' AND a.spec_revision=o.revision) a ON true
 WHERE outsourcing_can_read(o.request_id)
 ), filtered AS (
 SELECT * FROM entries e WHERE (coalesce(p->>'service','')='' OR e.service=p->>'service') AND (coalesce(p->>'state','')='' OR e.state=p->>'state')
 AND (coalesce(p->>'from','')='' OR left(e.required_at,10)>=p->>'from') AND (coalesce(p->>'to','')='' OR left(e.required_at,10)<=p->>'to')
 AND (coalesce(p->>'supplier','')='' OR EXISTS(SELECT 1 FROM transport_outsourcing_assignments a WHERE a.outsourcing_id=e.id AND a.service=e.service AND a.supplier_id::text=p->>'supplier' AND a.state<>'CANCELLED'))
 AND concat_ws(' ',e.number,e.request_number,e.contract_code,e.client,e.suppliers,e.specification->>'delivery') ILIKE '%'||left(coalesce(p->>'search',''),200)||'%'
 ) SELECT jsonb_build_object('total',(SELECT count(*) FROM filtered),'items',coalesce(jsonb_agg(to_jsonb(page)),'[]')) INTO result
 FROM (SELECT * FROM filtered ORDER BY required_at NULLS LAST,number,service LIMIT least(100,greatest(1,coalesce((p->>'limit')::integer,25))) OFFSET greatest(0,coalesce((p->>'offset')::integer,0))) page;
 RETURN result;
END $$;

CREATE FUNCTION outsourcing_assignment_save(p_parent uuid,p_service text,p jsonb,p_id uuid DEFAULT NULL,p_version integer DEFAULT NULL,p_reason text DEFAULT '') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o transport_outsourcing; a transport_outsourcing_assignments; required numeric; used numeric; v uuid; s suppliers;
BEGIN
 SELECT * INTO o FROM transport_outsourcing WHERE id=p_parent FOR UPDATE;
 IF NOT FOUND OR NOT outsourcing_can_read(o.request_id) OR NOT has_tms_permission('compras-tercerizaciones') THEN RAISE EXCEPTION 'Sin permiso para gestionar recursos'; END IF;
 IF o.review_status<>'ACTIVE' OR o.stage=0 OR o.stage>=6 THEN RAISE EXCEPTION 'Envíe la ficha vigente a Compras; no debe estar observada, cancelada ni cerrada'; END IF;
 IF length(btrim(p_reason))<5 THEN RAISE EXCEPTION 'Indique el motivo de la asignación o cambio (mínimo 5 caracteres)'; END IF;
 SELECT * INTO a FROM transport_outsourcing_assignments WHERE id=p_id FOR UPDATE;
 IF p_id IS NOT NULL AND (a.id IS NULL OR a.outsourcing_id<>o.id OR a.service<>p_service OR a.version IS DISTINCT FROM p_version) THEN RAISE EXCEPTION 'La asignación cambió; actualice la bandeja'; END IF;
 IF a.dispatch_id IS NOT NULL THEN RAISE EXCEPTION 'Recurso vinculado al despacho %. Cancele o rectifique primero la programación con autorización; no se modificará silenciosamente',a.dispatch_id; END IF;
 IF a.state IN ('CANCELLED','COMPLETED') THEN RAISE EXCEPTION 'Asignación cerrada; registre una nueva'; END IF;
 SELECT r.quantity INTO required FROM outsourcing_required(o.specification) r WHERE r.service=p_service;
 IF required IS NULL THEN RAISE EXCEPTION 'Servicio no solicitado en la ficha vigente'; END IF;
 SELECT * INTO s FROM suppliers WHERE id=(p->>'supplier_id')::uuid AND is_active;
 IF NOT FOUND OR NOT s.category=ANY(CASE p_service WHEN 'FLETE' THEN ARRAY['TRANSPORTE'] WHEN 'GRUA' THEN ARRAY['GRUA','SERVICIOS'] WHEN 'MONTACARGAS' THEN ARRAY['MONTACARGA','SERVICIOS'] WHEN 'ESTIBA' THEN ARRAY['ESTIBA','SERVICIOS'] ELSE ARRAY['TRANSPORTE','GRUA','MONTACARGA','ESTIBA','SERVICIOS'] END) THEN RAISE EXCEPTION 'Proveedor inactivo o categoría incompatible'; END IF;
 SELECT coalesce(sum(quantity),0) INTO used FROM transport_outsourcing_assignments WHERE outsourcing_id=o.id AND service=p_service AND state<>'CANCELLED' AND spec_revision=o.revision AND id IS DISTINCT FROM p_id;
 IF used+(p->>'quantity')::numeric>required THEN RAISE EXCEPTION 'La cantidad supera el requerimiento: solicitado %, asignado %, disponible %',required,used,greatest(0,required-used); END IF;
 IF p_service IN ('FLETE','GRUA','MONTACARGAS','STOCKA') AND (p->>'quantity')::numeric<>1 THEN RAISE EXCEPTION 'Registre una ficha por unidad o equipo'; END IF;
 IF p_service='ESTIBA' AND (p->>'quantity')::numeric<>trunc((p->>'quantity')::numeric) THEN RAISE EXCEPTION 'Cantidad de trabajadores entera requerida'; END IF;
 IF p->>'currency'='PEN' AND (p->>'exchange_rate')::numeric<>1 THEN RAISE EXCEPTION 'El tipo de cambio PEN debe ser 1'; END IF;
 IF p_id IS NULL THEN
 INSERT INTO transport_outsourcing_assignments(outsourcing_id,service,supplier_id,quantity,resource,starts_at,ends_at,quoted_amount,confirmed_amount,currency,exchange_rate,terms,spec_revision)
 VALUES(o.id,p_service,s.id,(p->>'quantity')::numeric,p->'resource',(p->>'starts_at')::timestamptz,(p->>'ends_at')::timestamptz,(p->>'quoted_amount')::numeric,nullif(p->>'confirmed_amount','')::numeric,p->>'currency',(p->>'exchange_rate')::numeric,p->>'terms',o.revision) RETURNING id INTO v;
 ELSE
 UPDATE transport_outsourcing_assignments SET supplier_id=s.id,quantity=(p->>'quantity')::numeric,resource=p->'resource',starts_at=(p->>'starts_at')::timestamptz,ends_at=(p->>'ends_at')::timestamptz,
 quoted_amount=(p->>'quoted_amount')::numeric,confirmed_amount=nullif(p->>'confirmed_amount','')::numeric,currency=p->>'currency',exchange_rate=(p->>'exchange_rate')::numeric,terms=p->>'terms',
 state='DRAFT',approved_by=NULL,confirmed_by=NULL,spec_revision=o.revision,version=version+1,updated_at=now() WHERE id=p_id RETURNING id INTO v;
 END IF;
 PERFORM outsourcing_assignment_event(o.id,'RESOURCE_SAVED',p_reason,jsonb_build_object('before',to_jsonb(a),'after',(SELECT to_jsonb(x) FROM transport_outsourcing_assignments x WHERE id=v)));
 RETURN v;
END $$;

CREATE FUNCTION outsourcing_assignment_validate(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a transport_outsourcing_assignments; o transport_outsourcing; k text; r jsonb; details jsonb; key text;
BEGIN
 SELECT * INTO STRICT a FROM transport_outsourcing_assignments WHERE id=p_id;
 SELECT * INTO STRICT o FROM transport_outsourcing WHERE id=a.outsourcing_id;
 r:=a.resource;
 SELECT value->'details' INTO details FROM jsonb_array_elements(o.specification->'services') WHERE value->>'kind'=a.service;
 IF NOT EXISTS(SELECT 1 FROM suppliers WHERE id=a.supplier_id AND is_active) THEN RAISE EXCEPTION 'Proveedor inactivo'; END IF;
 IF a.service='FLETE' THEN
 FOREACH k IN ARRAY ARRAY['plate','unit_type','capacity_t','length_m','width_m','height_m','driver','document','phone','license','license_category','license_expiration','vehicle_documents','driver_documents','origin','destination'] LOOP
 IF length(btrim(coalesce(r->>k,'')))=0 THEN RAISE EXCEPTION 'Transporte: complete %',k; END IF; END LOOP;
 IF lower(r->>'unit_type')<>lower(CASE WHEN o.specification->>'unit_type'='Otros' THEN o.specification->>'unit_other' ELSE o.specification->>'unit_type' END) THEN RAISE EXCEPTION 'El tipo de unidad no coincide con el requerimiento'; END IF;
 IF r->>'plate' !~ '^[A-Za-z0-9-]{5,10}$' THEN RAISE EXCEPTION 'Placa inválida'; END IF;
 IF (r->>'license_expiration')::date<(a.starts_at AT TIME ZONE 'America/Lima')::date THEN RAISE EXCEPTION 'Licencia vencida para la fecha de atención'; END IF;
 FOREACH k IN ARRAY ARRAY['capacity_t','length_m','width_m','height_m'] LOOP
 IF coalesce(nullif(r->>k,'')::numeric,0)<=0 OR (r->>k)::numeric<coalesce(nullif(o.specification->>k,'')::numeric,0) THEN RAISE EXCEPTION 'La unidad no cumple el mínimo requerido de %',k; END IF; END LOOP;
 IF coalesce(nullif(r->>'cargo_weight_kg','')::numeric,0)<=0 OR (r->>'cargo_weight_kg')::numeric>(r->>'capacity_t')::numeric*1000 THEN RAISE EXCEPTION 'Declare el peso asignado a esta unidad dentro de su capacidad'; END IF;
 IF coalesce(nullif(r->>'volume_m3','')::numeric,0)<0 OR coalesce(nullif(r->>'volume_m3','')::numeric,0)>(r->>'length_m')::numeric*(r->>'width_m')::numeric*(r->>'height_m')::numeric THEN RAISE EXCEPTION 'El volumen asignado excede el espacio útil'; END IF;
 IF coalesce((SELECT sum(nullif(resource->>'cargo_weight_kg','')::numeric) FROM transport_outsourcing_assignments WHERE outsourcing_id=o.id AND service='FLETE' AND id<>a.id AND state<>'CANCELLED' AND spec_revision=o.revision),0)+(r->>'cargo_weight_kg')::numeric>coalesce(nullif(o.specification->>'cargo_weight_kg','')::numeric,0)*1.01 THEN RAISE EXCEPTION 'El peso repartido supera la carga total de la solicitud'; END IF;
 IF EXISTS(SELECT 1 FROM vehicles v JOIN carriers c ON c.id=v.carrier_id WHERE regexp_replace(upper(v.plate),'[^A-Z0-9]','','g')=regexp_replace(upper(r->>'plate'),'[^A-Z0-9]','','g') AND upper(to_jsonb(c)->>'type')='PROPIO') THEN RAISE EXCEPTION 'La placa pertenece a la flota propia'; END IF;
 ELSIF a.service IN ('GRUA','MONTACARGAS','STOCKA') THEN
 FOREACH k IN ARRAY ARRAY['equipment','capacity','operator','operator_document','certificates','location'] LOOP
 IF length(btrim(coalesce(r->>k,'')))=0 THEN RAISE EXCEPTION 'Equipo: complete %',k; END IF; END LOOP;
 IF coalesce(nullif(r->>'capacity','')::numeric,0)<=0 OR (r->>'capacity')::numeric<coalesce(nullif(details->>'capacity','')::numeric,0) THEN RAISE EXCEPTION 'Capacidad insuficiente'; END IF;
 IF a.service='MONTACARGAS' AND coalesce(nullif(r->>'height','')::numeric,0)<coalesce(nullif(details->>'height','')::numeric,0) THEN RAISE EXCEPTION 'Altura de elevación insuficiente'; END IF;
 IF a.service='GRUA' AND (coalesce(nullif(r->>'reach','')::numeric,0)<coalesce(nullif(details->>'reach','')::numeric,0) OR length(btrim(coalesce(r->>'maneuver_review','')))<10) THEN RAISE EXCEPTION 'Grúa: alcance y evaluación documentada de maniobra obligatorios; la capacidad nominal no demuestra viabilidad'; END IF;
 ELSIF a.service='ESTIBA' THEN
 FOREACH k IN ARRAY ARRAY['responsible','activity','location','safety'] LOOP IF length(btrim(coalesce(r->>k,'')))=0 THEN RAISE EXCEPTION 'Estiba: complete %',k; END IF; END LOOP;
 ELSE IF length(btrim(coalesce(r->>'description','')))<5 THEN RAISE EXCEPTION 'Describa el recurso y sus características'; END IF;
 END IF;
 IF r->>'documents_verified' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Confirme la revisión documental interna (no implica validación externa)'; END IF;
 -- Identidad global del equipo/conductor, con bloqueo transaccional para confirmaciones concurrentes.
 FOR key IN SELECT DISTINCT x FROM unnest(ARRAY[CASE WHEN a.service='FLETE' THEN 'PLATE:'||regexp_replace(upper(r->>'plate'),'[^A-Z0-9]','','g') ELSE 'EQUIPMENT:'||a.supplier_id||':'||upper(r->>'equipment') END,'PERSON:'||upper(coalesce(r->>'document',r->>'operator_document'))]) x WHERE x IS NOT NULL ORDER BY x LOOP
 PERFORM pg_advisory_xact_lock(hashtextextended(key,0));
 IF EXISTS(SELECT 1 FROM transport_outsourcing_assignments b WHERE b.id<>a.id AND b.state='CONFIRMED' AND tstzrange(b.starts_at,b.ends_at,'[)')&&tstzrange(a.starts_at,a.ends_at,'[)') AND (
 key='PLATE:'||regexp_replace(upper(b.resource->>'plate'),'[^A-Z0-9]','','g') OR key='EQUIPMENT:'||b.supplier_id||':'||upper(b.resource->>'equipment') OR key='PERSON:'||upper(coalesce(b.resource->>'document',b.resource->>'operator_document')))) THEN RAISE EXCEPTION 'Recurso o persona comprometido en el mismo horario: %',key; END IF;
 END LOOP;
 IF a.service='FLETE' AND EXISTS(SELECT 1 FROM dispatches d WHERE d.status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO') AND d.id IS DISTINCT FROM a.dispatch_id AND (regexp_replace(upper(d.vehicle_plate),'[^A-Z0-9]','','g')=regexp_replace(upper(r->>'plate'),'[^A-Z0-9]','','g') OR to_jsonb(d)->>'tercero_doc'=r->>'document')) THEN RAISE EXCEPTION 'Unidad o conductor con despacho activo'; END IF;
END $$;
CREATE FUNCTION outsourcing_assignment_action(p_id uuid,p_version integer,p_action text,p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a transport_outsourcing_assignments; o transport_outsourcing; next_state text;
BEGIN
 SELECT o1.* INTO o FROM transport_outsourcing o1 JOIN transport_outsourcing_assignments a1 ON a1.outsourcing_id=o1.id WHERE a1.id=p_id FOR UPDATE OF o1;
 SELECT * INTO a FROM transport_outsourcing_assignments WHERE id=p_id FOR UPDATE;
 IF a.id IS NULL OR NOT outsourcing_can_read(o.request_id) THEN RAISE EXCEPTION 'Sin acceso'; END IF;
 IF a.version<>p_version THEN RAISE EXCEPTION 'La asignación cambió; actualice'; END IF;
 IF length(btrim(p_note))<5 THEN RAISE EXCEPTION 'Registre un sustento de al menos 5 caracteres'; END IF;
 IF NOT has_tms_permission(CASE WHEN p_action='APPROVE' THEN 'compras-aprobar' WHEN p_action='COMPLETE' THEN 'cierre-economico' ELSE 'compras-tercerizaciones' END) THEN RAISE EXCEPTION 'Sin permiso para esta acción'; END IF;
 IF p_action<>'CANCEL' AND (o.review_status<>'ACTIVE' OR a.spec_revision<>o.revision) THEN RAISE EXCEPTION 'La ficha técnica ya no está vigente'; END IF;
 IF p_action='APPROVE' AND a.state='DRAFT' THEN PERFORM outsourcing_assignment_validate(a.id);next_state:='APPROVED';
 ELSIF p_action='CONFIRM' AND a.state='APPROVED' THEN
 IF a.confirmed_amount IS NULL THEN RAISE EXCEPTION 'Registre el costo confirmado antes de confirmar'; END IF;
 PERFORM outsourcing_assignment_validate(a.id);next_state:='CONFIRMED';
 ELSIF p_action='CANCEL' AND a.state NOT IN ('CANCELLED','COMPLETED') THEN
 IF a.dispatch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dispatches WHERE id=a.dispatch_id AND status IN ('CANCELADO','ANULADO')) THEN RAISE EXCEPTION 'Cancele primero el despacho vinculado mediante su flujo operativo y presupuestal'; END IF;
 next_state:='CANCELLED';
 ELSIF p_action='COMPLETE' AND a.state='CONFIRMED' THEN
 IF a.dispatch_id IS NULL OR NOT EXISTS(SELECT 1 FROM dispatches WHERE id=a.dispatch_id AND status IN ('RETORNO_COMPLETADO','CIERRE_OPERATIVO','LIQUIDADO','CERRADO')) OR economic_closure_status(a.dispatch_id) IS DISTINCT FROM 'CERRADO' THEN RAISE EXCEPTION 'Finalice la operación y el cierre económico del despacho'; END IF;
 next_state:='COMPLETED';
 ELSE RAISE EXCEPTION 'Transición inválida'; END IF;
 UPDATE transport_outsourcing_assignments SET state=next_state,version=version+1,updated_at=now(),approved_by=CASE WHEN next_state='APPROVED' THEN auth.uid() ELSE approved_by END,confirmed_by=CASE WHEN next_state='CONFIRMED' THEN auth.uid() ELSE confirmed_by END WHERE id=a.id;
 PERFORM outsourcing_assignment_event(o.id,'RESOURCE_'||p_action,p_note,jsonb_build_object('assignment_id',a.id,'before',to_jsonb(a),'after',(SELECT to_jsonb(x) FROM transport_outsourcing_assignments x WHERE id=a.id)));
END $$;
-- Cambios de ficha invalidan borradores y recursos no programados; jamás alteran rutas silenciosamente.
CREATE FUNCTION outsourcing_assignment_revision_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a transport_outsourcing_assignments;
BEGIN
 IF NEW.revision<>OLD.revision OR NEW.review_status<>OLD.review_status THEN
 IF EXISTS(SELECT 1 FROM transport_outsourcing_assignments WHERE outsourcing_id=OLD.id AND dispatch_id IS NOT NULL AND state NOT IN ('CANCELLED','COMPLETED')) THEN RAISE EXCEPTION 'Existen recursos programados: rectifique o cancele primero los despachos vinculados'; END IF;
 FOR a IN SELECT * FROM transport_outsourcing_assignments WHERE outsourcing_id=OLD.id AND state NOT IN ('CANCELLED','COMPLETED') FOR UPDATE LOOP
 UPDATE transport_outsourcing_assignments SET state='CANCELLED',version=version+1,updated_at=now() WHERE id=a.id;
 PERFORM outsourcing_assignment_event(OLD.id,'RESOURCE_INVALIDATED','Ficha observada, cancelada o revisada',to_jsonb(a));
 END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER outsourcing_assignment_revision BEFORE UPDATE OF revision,review_status ON transport_outsourcing FOR EACH ROW EXECUTE FUNCTION outsourcing_assignment_revision_guard();

REVOKE ALL ON FUNCTION outsourcing_required(jsonb),outsourcing_assignment_event(uuid,text,text,jsonb),outsourcing_assignment_validate(uuid),outsourcing_assignment_revision_guard() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION outsourcing_management_queue(jsonb),outsourcing_assignment_context(uuid),outsourcing_assignment_save(uuid,text,jsonb,uuid,integer,text),outsourcing_assignment_action(uuid,integer,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION outsourcing_management_queue(jsonb),outsourcing_assignment_context(uuid),outsourcing_assignment_save(uuid,text,jsonb,uuid,integer,text),outsourcing_assignment_action(uuid,integer,text,text) TO authenticated;
COMMIT;
