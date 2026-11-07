-- Compras usa las líneas económicas existentes: no mantiene un segundo libro presupuestal.
BEGIN;
CREATE TABLE public.transport_outsourcing (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 request_id uuid NOT NULL UNIQUE REFERENCES public.transport_requests(id) ON DELETE RESTRICT,
 dispatch_id uuid REFERENCES public.dispatches(id) ON DELETE RESTRICT,
 stage integer NOT NULL DEFAULT 0 CHECK(stage BETWEEN 0 AND 7),
 version integer NOT NULL DEFAULT 1,
 specification jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(specification)='object'),
 created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transport_outsourcing_dispatch_idx ON public.transport_outsourcing(dispatch_id);
CREATE INDEX transport_outsourcing_creator_idx ON public.transport_outsourcing(created_by);
CREATE TABLE public.transport_outsourcing_quotes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), outsourcing_id uuid NOT NULL REFERENCES public.transport_outsourcing(id),
 service text NOT NULL CHECK(service IN ('FLETE','MONTACARGAS','GRUA','STOCKA','ESTIBA','OTROS')),
 supplier_id uuid NOT NULL REFERENCES public.suppliers(id), amount_pen numeric(15,2) NOT NULL CHECK(amount_pen>0 AND amount_pen<=100000000),
 terms text NOT NULL CHECK(length(btrim(terms))>=5), evidence text NOT NULL,
 selected boolean NOT NULL DEFAULT false, created_by uuid NOT NULL REFERENCES auth.users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transport_outsourcing_quotes_parent_idx ON public.transport_outsourcing_quotes(outsourcing_id);
CREATE INDEX transport_outsourcing_quotes_supplier_idx ON public.transport_outsourcing_quotes(supplier_id);
CREATE INDEX transport_outsourcing_quotes_creator_idx ON public.transport_outsourcing_quotes(created_by);
CREATE UNIQUE INDEX transport_outsourcing_quote_selected ON public.transport_outsourcing_quotes(outsourcing_id,service) WHERE selected;
CREATE TABLE public.transport_outsourcing_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), outsourcing_id uuid NOT NULL REFERENCES public.transport_outsourcing(id),
 stage integer NOT NULL, actor_id uuid NOT NULL REFERENCES auth.users(id), actor_name text NOT NULL,
 note text NOT NULL, evidence text, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transport_outsourcing_events_parent_idx ON public.transport_outsourcing_events(outsourcing_id,created_at);
CREATE INDEX transport_outsourcing_events_actor_idx ON public.transport_outsourcing_events(actor_id);

-- Los RPC son la única puerta de escritura: estado, autorización y auditoría son atómicos.
-- El definer permite escribir el historial inmutable; cada operación aplica permisos y sede explícitos.
CREATE FUNCTION public.outsourcing_can_read(p_request uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND public.is_active_tms_user() AND EXISTS (
 SELECT 1 FROM public.transport_requests t WHERE t.id=p_request AND public.can_access_site(t.site_id)
 AND (public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('compras-tercerizaciones')
 OR public.has_tms_read_permission('compras-aprobar') OR public.has_tms_read_permission('control-presupuestal') OR public.has_tms_read_permission('cierre-economico')));
$$;
ALTER TABLE public.transport_outsourcing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transport_outsourcing_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transport_outsourcing_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_active_account ON public.transport_outsourcing AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.transport_outsourcing FROM PUBLIC, anon, authenticated;
CREATE POLICY security_active_account ON public.transport_outsourcing_quotes AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.transport_outsourcing_quotes FROM PUBLIC, anon, authenticated;
CREATE POLICY security_active_account ON public.transport_outsourcing_events AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.transport_outsourcing_events FROM PUBLIC, anon, authenticated;
CREATE POLICY outsourcing_read ON public.transport_outsourcing FOR SELECT TO authenticated USING(public.outsourcing_can_read(request_id));
CREATE POLICY outsourcing_quotes_read ON public.transport_outsourcing_quotes FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.transport_outsourcing o WHERE o.id=outsourcing_id));
CREATE POLICY outsourcing_events_read ON public.transport_outsourcing_events FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.transport_outsourcing o WHERE o.id=outsourcing_id));
REVOKE ALL ON public.transport_outsourcing, public.transport_outsourcing_quotes, public.transport_outsourcing_events FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.transport_outsourcing, public.transport_outsourcing_quotes, public.transport_outsourcing_events TO authenticated;

CREATE FUNCTION public.outsourcing_save(p_request uuid,p_spec jsonb,p_version integer DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.transport_outsourcing; v_id uuid;
BEGIN
 IF NOT public.outsourcing_can_read(p_request) OR NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Sin permiso para solicitar tercerización'; END IF;
 -- Serializa altas concurrentes y conserva una sola solicitud por requerimiento.
 PERFORM 1 FROM public.transport_requests WHERE id=p_request FOR UPDATE;
 SELECT * INTO o FROM public.transport_outsourcing WHERE request_id=p_request FOR UPDATE;
 IF o.id IS NOT NULL AND (o.stage<>0 OR o.version IS DISTINCT FROM p_version) THEN RAISE EXCEPTION 'La solicitud cambió; actualice antes de editar'; END IF;
 IF jsonb_typeof(p_spec) IS DISTINCT FROM 'object' OR octet_length(p_spec::text)>60000 THEN RAISE EXCEPTION 'Ficha técnica inválida'; END IF;
 IF jsonb_typeof(p_spec->'services') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Lista de servicios inválida'; END IF;
 IF o.id IS NULL THEN
  INSERT INTO public.transport_outsourcing(request_id,specification,created_by) VALUES(p_request,p_spec,auth.uid()) RETURNING id INTO v_id;
 ELSE
  UPDATE public.transport_outsourcing SET specification=p_spec,version=version+1,updated_at=now() WHERE id=o.id RETURNING id INTO v_id;
 END IF;
 INSERT INTO public.transport_outsourcing_events(outsourcing_id,stage,actor_id,actor_name,note,snapshot)
 VALUES(v_id,0,auth.uid(),coalesce((SELECT full_name FROM public.profiles WHERE id=auth.uid()),auth.uid()::text),'Ficha guardada',p_spec);
 RETURN v_id;
END $$;

CREATE FUNCTION public.outsourcing_transition(p_id uuid,p_version integer,p_next integer,p_note text,p_evidence text DEFAULT NULL,p_quotes uuid[] DEFAULT '{}',p_dispatch uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.transport_outsourcing; s jsonb; k text; e jsonb; q record; d public.dispatches; v_amount numeric; v_required text[] := ARRAY['FLETE'];
BEGIN
 SELECT * INTO o FROM public.transport_outsourcing WHERE id=p_id;
 IF o.id IS NOT NULL THEN
  PERFORM 1 FROM public.transport_requests WHERE id=o.request_id FOR UPDATE;
  SELECT * INTO o FROM public.transport_outsourcing WHERE id=p_id FOR UPDATE;
 END IF;
 IF o.id IS NULL OR NOT public.outsourcing_can_read(o.request_id) THEN RAISE EXCEPTION 'Sin acceso a la solicitud'; END IF;
 IF o.version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'La solicitud cambió; actualice antes de continuar'; END IF;
 IF p_next IS NULL OR p_next<>o.stage+1 OR p_next>7 THEN RAISE EXCEPTION 'Transición inválida'; END IF;
 IF length(btrim(coalesce(p_note,'')))<5 THEN RAISE EXCEPTION 'Registre un sustento de al menos 5 caracteres'; END IF;
 IF (p_next IN (1,6) AND NOT public.has_tms_permission('despacho'))
 OR (p_next IN (2,3,5) AND NOT public.has_tms_permission('compras-tercerizaciones'))
 OR (p_next=4 AND NOT public.has_tms_permission('compras-aprobar'))
 OR (p_next=7 AND NOT public.has_tms_permission('cierre-economico')) THEN RAISE EXCEPTION 'Sin permiso para esta etapa'; END IF;
 s:=o.specification;
 IF p_next=1 THEN
  IF NOT EXISTS(SELECT 1 FROM public.transport_requests WHERE id=o.request_id AND contract_id IS NOT NULL) THEN RAISE EXCEPTION 'Vincule una OT antes de enviar a Compras'; END IF;
  FOREACH k IN ARRAY ARRAY['required_at','pickup','delivery','responsible','priority','unit_type','cargo','packaging','special_conditions','loading_window','unloading_window','entry_requirements','documents','safety','access','intermediate_points'] LOOP
   IF length(btrim(coalesce(s->>k,'')))=0 THEN RAISE EXCEPTION 'Complete el campo: % (indique No aplica cuando corresponda)',k; END IF;
  END LOOP;
  IF NOT isfinite((s->>'required_at')::timestamptz) THEN RAISE EXCEPTION 'Fecha requerida inválida'; END IF;
  IF s->>'priority' NOT IN ('NORMAL','ALTA','URGENTE') THEN RAISE EXCEPTION 'Prioridad inválida'; END IF;
  FOREACH k IN ARRAY ARRAY['length_m','width_m','height_m','capacity_t','volume_m3','cargo_weight_kg','cargo_quantity','duration_hours'] LOOP
   IF (coalesce((s->>k)::numeric,0)<=0 OR (s->>k)::numeric>100000000) THEN RAISE EXCEPTION 'Indique un valor positivo: %',k; END IF;
  END LOOP;
  IF jsonb_typeof(s->'services') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Servicios inválidos'; END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(s->'services') LOOP
   IF e->>'kind' NOT IN ('MONTACARGAS','GRUA','STOCKA','ESTIBA','OTROS') OR e->>'kind' IS NULL OR length(btrim(coalesce(e->>'requirements','')))<5 THEN RAISE EXCEPTION 'Complete los requisitos de cada servicio complementario'; END IF;
   FOREACH k IN ARRAY CASE e->>'kind'
    WHEN 'MONTACARGAS' THEN ARRAY['capacity','height','hours'] WHEN 'GRUA' THEN ARRAY['capacity','reach','maneuver']
    WHEN 'STOCKA' THEN ARRAY['capacity','characteristics'] WHEN 'ESTIBA' THEN ARRAY['workers','schedule','activities'] ELSE ARRAY['resource'] END LOOP
    IF length(btrim(coalesce(e->'details'->>k,'')))=0 THEN RAISE EXCEPTION 'Complete % del servicio %',k,e->>'kind'; END IF;
    IF k IN ('capacity','height','hours','reach','workers') THEN
     IF (e->'details'->>k)::numeric<=0 OR (e->'details'->>k)::numeric>1000000 THEN RAISE EXCEPTION 'Valor inválido: %',k; END IF;
    END IF;
   END LOOP;
   IF (SELECT count(*) FROM jsonb_array_elements(s->'services') x WHERE x->>'kind'=e->>'kind')<>1 THEN RAISE EXCEPTION 'Servicio duplicado'; END IF;
  END LOOP;
 END IF;
 IF (p_next>=2 OR p_evidence IS NOT NULL) AND (p_evidence IS NULL OR NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='outsourcing' AND name=p_evidence AND split_part(name,'/',1)=p_id::text)) THEN RAISE EXCEPTION 'Adjunte evidencia de esta etapa'; END IF;
 IF p_next=3 THEN
  SELECT v_required || coalesce(array_agg(x->>'kind'),'{}') INTO v_required FROM jsonb_array_elements(s->'services') x;
  IF cardinality(p_quotes)<>cardinality(v_required) OR EXISTS(SELECT 1 FROM unnest(v_required) r WHERE
   (SELECT count(*) FROM public.transport_outsourcing_quotes WHERE outsourcing_id=p_id AND id=ANY(p_quotes) AND service=r)<>1) THEN RAISE EXCEPTION 'Seleccione una cotización por cada servicio requerido'; END IF;
  UPDATE public.transport_outsourcing_quotes SET selected=false WHERE outsourcing_id=p_id;
  UPDATE public.transport_outsourcing_quotes SET selected=true WHERE outsourcing_id=p_id AND id=ANY(p_quotes);
 END IF;
 IF p_next=5 THEN
  SELECT * INTO d FROM public.dispatches WHERE id=p_dispatch FOR UPDATE;
  IF d.id IS NULL OR NOT public.can_access_site(d.site_id) OR d.status<>'PROGRAMADO' OR NOT EXISTS(SELECT 1 FROM public.dispatch_requests WHERE dispatch_id=d.id AND transport_request_id=o.request_id) THEN RAISE EXCEPTION 'Vincule un despacho programado que contenga esta solicitud'; END IF;
  -- La programación ya reservó el presupuesto mediante sus reglas vigentes. No se vuelve a reservar aquí.
  FOR q IN SELECT CASE WHEN service='STOCKA' THEN 'OTROS' ELSE service END AS service, supplier_id, sum(amount_pen) AS amount_pen FROM public.transport_outsourcing_quotes WHERE outsourcing_id=p_id AND selected GROUP BY CASE WHEN service='STOCKA' THEN 'OTROS' ELSE service END,supplier_id LOOP
   IF NOT EXISTS(SELECT 1 FROM public.suppliers WHERE id=q.supplier_id AND is_active) THEN RAISE EXCEPTION 'Proveedor inactivo'; END IF;
   IF q.service='FLETE' THEN
    IF NOT EXISTS(SELECT 1 FROM public.carriers WHERE id=d.carrier_id AND supplier_id=q.supplier_id) THEN RAISE EXCEPTION 'El transportista programado no corresponde al adjudicado'; END IF;
    SELECT amount_pen INTO v_amount FROM public.dispatch_request_freight WHERE dispatch_id=d.id AND request_id=o.request_id AND status<>'LIBERADO';
    IF NOT FOUND THEN
     IF (SELECT count(*) FROM public.dispatch_requests WHERE dispatch_id=d.id)<>1 THEN RAISE EXCEPTION 'Distribuya el flete de la ruta por solicitud'; END IF;
     v_amount:=d.freight_cost;
    END IF;
   ELSE
    SELECT sum(planned_pen) INTO v_amount FROM public.transport_unloading_costs WHERE dispatch_id=d.id AND transport_request_id=o.request_id
     AND supplier_id=q.supplier_id AND concept=CASE WHEN q.service='STOCKA' THEN 'OTROS' ELSE q.service END AND status='PLANIFICADO';
   END IF;
   IF v_amount IS DISTINCT FROM q.amount_pen THEN RAISE EXCEPTION 'El costo programado de % debe coincidir con el adjudicado: S/ %',q.service,q.amount_pen; END IF;
  END LOOP;
  UPDATE public.transport_outsourcing SET dispatch_id=d.id WHERE id=p_id;
 END IF;
 IF p_next=6 AND NOT EXISTS(SELECT 1 FROM public.dispatches WHERE id=o.dispatch_id AND status IN ('RETORNO_COMPLETADO','CIERRE_OPERATIVO','LIQUIDADO','CERRADO')) THEN RAISE EXCEPTION 'Registre primero la ejecución en Torre de Control'; END IF;
 IF p_next=7 AND public.economic_closure_status(o.dispatch_id) IS DISTINCT FROM 'CERRADO' THEN RAISE EXCEPTION 'Complete primero el cierre económico del despacho'; END IF;
 UPDATE public.transport_outsourcing SET stage=p_next,version=version+1,updated_at=now() WHERE id=p_id;
 INSERT INTO public.transport_outsourcing_events(outsourcing_id,stage,actor_id,actor_name,note,evidence,snapshot)
 VALUES(p_id,p_next,auth.uid(),coalesce((SELECT full_name FROM public.profiles WHERE id=auth.uid()),auth.uid()::text),p_note,p_evidence,
 jsonb_build_object('specification',s,'quotes',(SELECT coalesce(jsonb_agg(to_jsonb(z)),'[]') FROM public.transport_outsourcing_quotes z WHERE outsourcing_id=p_id AND selected),'dispatch_id',CASE WHEN p_next=5 THEN d.id ELSE o.dispatch_id END));
END $$;

CREATE FUNCTION public.outsourcing_add_quote(p_id uuid,p_service text,p_supplier uuid,p_amount numeric,p_terms text,p_evidence text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.transport_outsourcing; v_id uuid;
BEGIN
 SELECT * INTO o FROM public.transport_outsourcing WHERE id=p_id FOR UPDATE;
 IF o.id IS NULL OR NOT public.outsourcing_can_read(o.request_id) OR NOT public.has_tms_permission('compras-tercerizaciones') OR o.stage<>2 THEN RAISE EXCEPTION 'Sin permiso o solicitud fuera de cotización'; END IF;
 IF p_service<>'FLETE' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(o.specification->'services') x WHERE x->>'kind'=p_service) THEN RAISE EXCEPTION 'Servicio no solicitado'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.suppliers WHERE id=p_supplier AND is_active AND category IN ('TRANSPORTE','SERVICIOS','MONTACARGA','GRUA','ESTIBA','OTROS')) THEN RAISE EXCEPTION 'Seleccione un proveedor logístico activo'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.suppliers WHERE id=p_supplier AND category=ANY(CASE p_service
  WHEN 'FLETE' THEN ARRAY['TRANSPORTE'] WHEN 'MONTACARGAS' THEN ARRAY['MONTACARGA','SERVICIOS'] WHEN 'GRUA' THEN ARRAY['GRUA','SERVICIOS']
  WHEN 'ESTIBA' THEN ARRAY['ESTIBA','SERVICIOS'] ELSE ARRAY['SERVICIOS','GRUA','ESTIBA','MONTACARGA','TRANSPORTE'] END)) THEN RAISE EXCEPTION 'El proveedor no presta el servicio solicitado'; END IF;
 IF NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='outsourcing' AND name=p_evidence AND split_part(name,'/',1)=p_id::text) THEN RAISE EXCEPTION 'Adjunte la cotización'; END IF;
 INSERT INTO public.transport_outsourcing_quotes(outsourcing_id,service,supplier_id,amount_pen,terms,evidence,created_by)
 VALUES(p_id,p_service,p_supplier,p_amount,p_terms,p_evidence,auth.uid()) RETURNING id INTO v_id;
 UPDATE public.transport_outsourcing SET version=version+1,updated_at=now() WHERE id=p_id;
 INSERT INTO public.transport_outsourcing_events(outsourcing_id,stage,actor_id,actor_name,note,evidence,snapshot)
 VALUES(p_id,2,auth.uid(),coalesce((SELECT full_name FROM public.profiles WHERE id=auth.uid()),auth.uid()::text),'Cotización registrada',p_evidence,jsonb_build_object('quote_id',v_id,'amount_pen',p_amount,'supplier_id',p_supplier,'service',p_service));
 RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.outsourcing_can_read(uuid),public.outsourcing_save(uuid,jsonb,integer),public.outsourcing_transition(uuid,integer,integer,text,text,uuid[],uuid),public.outsourcing_add_quote(uuid,text,uuid,numeric,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.outsourcing_can_read(uuid),public.outsourcing_save(uuid,jsonb,integer),public.outsourcing_transition(uuid,integer,integer,text,text,uuid[],uuid),public.outsourcing_add_quote(uuid,text,uuid,numeric,text,text) TO authenticated;

CREATE FUNCTION public.outsourcing_request_ot_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.transport_outsourcing WHERE request_id=OLD.id AND stage>0) THEN
  RAISE EXCEPTION 'La OT está vinculada a una tercerización enviada a Compras';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.outsourcing_request_ot_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER outsourcing_request_ot_guard BEFORE UPDATE OF contract_id ON public.transport_requests
 FOR EACH ROW WHEN (OLD.contract_id IS DISTINCT FROM NEW.contract_id) EXECUTE FUNCTION public.outsourcing_request_ot_guard();

CREATE FUNCTION public.outsourcing_queue() RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT to_jsonb(o) || jsonb_build_object('transport_requests', jsonb_build_object('request_number',t.request_number,'contract_id',t.contract_id,
 'contracts',jsonb_build_object('code',c.code)), 'client',cl.business_name)
 FROM public.transport_outsourcing o JOIN public.transport_requests t ON t.id=o.request_id
 LEFT JOIN public.contracts c ON c.id=t.contract_id LEFT JOIN public.clients cl ON cl.id=c.client_id
 WHERE public.outsourcing_can_read(o.request_id) ORDER BY o.updated_at DESC LIMIT 500;
$$;
CREATE FUNCTION public.outsourcing_options(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.transport_outsourcing;
BEGIN
 SELECT * INTO o FROM public.transport_outsourcing WHERE id=p_id;
 IF o.id IS NULL OR NOT public.outsourcing_can_read(o.request_id) THEN RAISE EXCEPTION 'Sin acceso'; END IF;
 RETURN jsonb_build_object('suppliers',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'business_name',s.business_name) ORDER BY s.business_name),'[]') FROM public.suppliers s
 WHERE s.is_active AND s.category IN ('TRANSPORTE','SERVICIOS','MONTACARGA','GRUA','ESTIBA','OTROS')),
 'dispatches',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'dispatch_number',d.dispatch_number)),'[]') FROM public.dispatches d
 WHERE public.can_access_site(d.site_id) AND EXISTS(SELECT 1 FROM public.dispatch_requests dr WHERE dr.dispatch_id=d.id AND dr.transport_request_id=o.request_id)));
END $$;
REVOKE ALL ON FUNCTION public.outsourcing_queue(),public.outsourcing_options(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.outsourcing_queue(),public.outsourcing_options(uuid) TO authenticated;

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES('outsourcing','outsourcing',false,10485760,ARRAY['application/pdf','image/png','image/jpeg']) ON CONFLICT(id) DO NOTHING;
CREATE POLICY outsourcing_files_read ON storage.objects FOR SELECT TO authenticated USING(bucket_id='outsourcing' AND EXISTS(SELECT 1 FROM public.transport_outsourcing o WHERE o.id::text=split_part(name,'/',1)));
CREATE POLICY outsourcing_files_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK(bucket_id='outsourcing' AND EXISTS(SELECT 1 FROM public.transport_outsourcing o WHERE o.id::text=split_part(name,'/',1)
 AND o.stage<7 AND (public.has_tms_permission('despacho') OR public.has_tms_permission('compras-tercerizaciones') OR public.has_tms_permission('compras-aprobar') OR public.has_tms_permission('cierre-economico'))));
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.transport_outsourcing;
 END IF;
END $$;
COMMIT;
