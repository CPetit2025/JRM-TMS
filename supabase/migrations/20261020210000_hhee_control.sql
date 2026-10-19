-- HHEE: operational authorization, worked facts, HR validation and executive reporting.
-- Private tables; all access is scoped by active account, site, area membership and capability.
BEGIN;
CREATE TABLE public.hhee_areas (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id uuid NOT NULL REFERENCES public.sites(id),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 2 AND 100), active boolean NOT NULL DEFAULT true,
 UNIQUE(site_id,name)
);
CREATE TABLE public.hhee_causes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE, active boolean NOT NULL DEFAULT true
);
INSERT INTO public.hhee_causes(name) VALUES ('Planificación'),('Urgencias o cambios de última hora'),('Productividad'),
 ('Capacidad o falta de personal'),('Falla de equipo'),('Disponibilidad de materiales o información'),
 ('Compromiso de entrega'),('Coordinación de transporte'),('Reproceso');
INSERT INTO public.hhee_areas(site_id,name) SELECT s.id,n FROM public.sites s CROSS JOIN
 unnest(ARRAY['Producción','PCP','Logística','Almacén','Mantenimiento','Calidad','Comercial','RR. HH.']) n
 WHERE s.code='PRINCIPAL';
CREATE TABLE public.hhee_memberships (
 user_id uuid NOT NULL REFERENCES public.profiles(id), area_id uuid NOT NULL REFERENCES public.hhee_areas(id),
 PRIMARY KEY(user_id,area_id)
);
CREATE INDEX hhee_memberships_area_idx ON public.hhee_memberships(area_id);
CREATE TABLE public.hhee_people (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE CHECK(length(code) BETWEEN 1 AND 50),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 3 AND 160), area_id uuid NOT NULL REFERENCES public.hhee_areas(id),
 active boolean NOT NULL DEFAULT true, estimated_hour_cost numeric(14,4) CHECK(estimated_hour_cost>=0),
 profile_id uuid REFERENCES public.profiles(id)
);
CREATE INDEX hhee_people_area_idx ON public.hhee_people(area_id);
CREATE INDEX hhee_people_profile_idx ON public.hhee_people(profile_id);
CREATE TABLE public.hhee_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 area_id uuid NOT NULL REFERENCES public.hhee_areas(id), cause_id uuid NOT NULL REFERENCES public.hhee_causes(id),
 origin_area_id uuid REFERENCES public.hhee_areas(id), work_date date NOT NULL,
 activity text NOT NULL CHECK(length(btrim(activity)) BETWEEN 5 AND 300),
 justification text NOT NULL CHECK(length(btrim(justification)) BETWEEN 10 AND 3000),
 alternatives text NOT NULL CHECK(length(btrim(alternatives)) BETWEEN 5 AND 2000),
 expected_result text NOT NULL CHECK(length(btrim(expected_result)) BETWEEN 5 AND 1000),
 result_unit text CHECK(length(result_unit)<=80), target numeric(16,4) CHECK(target>0), achieved numeric(16,4) CHECK(achieved>=0),
 reference_type text NOT NULL DEFAULT 'SIN_REFERENCIA' CHECK(reference_type IN('SIN_REFERENCIA','OT','OC','OS','RQ','MANTENIMIENTO')),
 reference_code text CHECK(length(reference_code)<=100), contract_id uuid REFERENCES public.contracts(id),
 emergency boolean NOT NULL DEFAULT false, emergency_reason text CHECK(length(emergency_reason)<=2000),
 state text NOT NULL DEFAULT 'BORRADOR' CHECK(state IN('BORRADOR','SOLICITADA','EJECUTADA','VALIDADA','CANCELADA')),
 approval text NOT NULL DEFAULT 'PENDIENTE' CHECK(approval IN('PENDIENTE','APROBADA','RECHAZADA')),
 created_by uuid NOT NULL REFERENCES public.profiles(id), created_at timestamptz NOT NULL DEFAULT now(),
 submitted_at timestamptz, approved_by uuid REFERENCES public.profiles(id), approved_at timestamptz, approval_reason text,
 executed_at timestamptz, result_text text CHECK(length(result_text)<=3000), evidence text CHECK(length(evidence)<=2000),
 confirmed_cause_id uuid REFERENCES public.hhee_causes(id),
 assessment text NOT NULL DEFAULT 'PENDIENTE' CHECK(assessment IN('PENDIENTE','JUSTIFICADA','MEJORABLE')),
 validated_by uuid REFERENCES public.profiles(id), validated_at timestamptz, validation_reason text,
 attendance_source text, attendance_reference text,
 version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(target IS NULL OR NULLIF(btrim(result_unit),'') IS NOT NULL),
 CHECK(NOT emergency OR COALESCE(length(btrim(emergency_reason)),0)>=10)
);
CREATE INDEX hhee_requests_area_date_idx ON public.hhee_requests(area_id,work_date DESC);
CREATE INDEX hhee_requests_cause_date_idx ON public.hhee_requests(cause_id,work_date);
CREATE INDEX hhee_requests_origin_idx ON public.hhee_requests(origin_area_id);
CREATE INDEX hhee_requests_contract_idx ON public.hhee_requests(contract_id);
CREATE INDEX hhee_requests_confirmed_idx ON public.hhee_requests(confirmed_cause_id);
CREATE INDEX hhee_requests_creator_idx ON public.hhee_requests(created_by);
CREATE INDEX hhee_requests_approver_idx ON public.hhee_requests(approved_by);
CREATE INDEX hhee_requests_validator_idx ON public.hhee_requests(validated_by);
CREATE TABLE public.hhee_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL REFERENCES public.hhee_requests(id),
 person_id uuid NOT NULL REFERENCES public.hhee_people(id), person_name text NOT NULL, person_code text NOT NULL,
 planned_start timestamptz NOT NULL, planned_end timestamptz NOT NULL, planned_break integer NOT NULL DEFAULT 0,
 planned_minutes integer NOT NULL CHECK(planned_minutes BETWEEN 1 AND 960),
 approved_minutes integer CHECK(approved_minutes BETWEEN 0 AND 960),
 actual_start timestamptz, actual_end timestamptz, actual_break integer, actual_minutes integer CHECK(actual_minutes BETWEEN 0 AND 960),
 validated_minutes integer CHECK(validated_minutes BETWEEN 0 AND 960),
 estimated_cost numeric(16,2) CHECK(estimated_cost>=0), validated_cost numeric(16,2) CHECK(validated_cost>=0),
 valuation_note text, consent boolean NOT NULL DEFAULT false,
 UNIQUE(request_id,person_id), CHECK(validated_minutes IS NULL OR validated_minutes<=actual_minutes)
);
CREATE INDEX hhee_lines_person_time_idx ON public.hhee_lines(person_id,actual_start,actual_end);
CREATE TABLE public.hhee_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), area_id uuid NOT NULL REFERENCES public.hhee_areas(id),
 request_id uuid REFERENCES public.hhee_requests(id), cause_id uuid NOT NULL REFERENCES public.hhee_causes(id),
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 5 AND 300), assigned_to uuid NOT NULL REFERENCES public.profiles(id),
 due_date date NOT NULL, state text NOT NULL DEFAULT 'ABIERTA' CHECK(state IN('ABIERTA','EN_CURSO','REALIZADA','VERIFICADA')),
 conclusion text, verification text, effective boolean, created_by uuid NOT NULL REFERENCES public.profiles(id),
 verified_by uuid REFERENCES public.profiles(id), created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 version integer NOT NULL DEFAULT 1
);
CREATE INDEX hhee_actions_area_due_idx ON public.hhee_actions(area_id,due_date);
CREATE INDEX hhee_actions_request_idx ON public.hhee_actions(request_id);
CREATE INDEX hhee_actions_cause_idx ON public.hhee_actions(cause_id);
CREATE INDEX hhee_actions_assigned_idx ON public.hhee_actions(assigned_to);
CREATE INDEX hhee_actions_created_idx ON public.hhee_actions(created_by);
CREATE INDEX hhee_actions_verified_idx ON public.hhee_actions(verified_by);
CREATE TABLE public.hhee_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, request_id uuid REFERENCES public.hhee_requests(id),
 action_id uuid REFERENCES public.hhee_actions(id), actor uuid NOT NULL REFERENCES public.profiles(id),
 event text NOT NULL, reason text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hhee_audit_request_idx ON public.hhee_audit(request_id,created_at);
CREATE INDEX hhee_audit_action_idx ON public.hhee_audit(action_id);
CREATE INDEX hhee_audit_actor_idx ON public.hhee_audit(actor);
CREATE TABLE public.hhee_receipts (
 operation_id uuid PRIMARY KEY, actor uuid NOT NULL REFERENCES public.profiles(id), payload_hash text NOT NULL,
 response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hhee_receipts_actor_idx ON public.hhee_receipts(actor);
CREATE TABLE public.hhee_settings (
 id integer PRIMARY KEY CHECK(id=1), recurrence_days integer NOT NULL DEFAULT 28 CHECK(recurrence_days BETWEEN 7 AND 180),
 recurrence_events integer NOT NULL DEFAULT 3 CHECK(recurrence_events BETWEEN 2 AND 30),
 approval_label text NOT NULL DEFAULT 'Responsable del área', report_day integer NOT NULL DEFAULT 1 CHECK(report_day BETWEEN 1 AND 7),
 report_time time NOT NULL DEFAULT '08:00', report_to text NOT NULL DEFAULT '', report_cc text NOT NULL DEFAULT ''
);
INSERT INTO public.hhee_settings(id) VALUES(1);
ALTER TABLE public.hhee_areas ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_active_account ON public.hhee_areas AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.hhee_areas FROM PUBLIC,anon,authenticated;
ALTER TABLE public.hhee_causes ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_active_account ON public.hhee_causes AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.hhee_causes FROM PUBLIC,anon,authenticated;
ALTER TABLE public.hhee_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_active_account ON public.hhee_memberships AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.hhee_memberships FROM PUBLIC,anon,authenticated;
ALTER TABLE public.hhee_people ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_active_account ON public.hhee_people AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.hhee_people FROM PUBLIC,anon,authenticated;
ALTER TABLE public.hhee_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_active_account ON public.hhee_requests AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.hhee_requests FROM PUBLIC,anon,authenticated;
ALTER TABLE public.hhee_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_active_account ON public.hhee_lines AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.hhee_lines FROM PUBLIC,anon,authenticated;
ALTER TABLE public.hhee_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_active_account ON public.hhee_actions AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.hhee_actions FROM PUBLIC,anon,authenticated;
ALTER TABLE public.hhee_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_active_account ON public.hhee_audit AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.hhee_audit FROM PUBLIC,anon,authenticated;
ALTER TABLE public.hhee_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_active_account ON public.hhee_receipts AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.hhee_receipts FROM PUBLIC,anon,authenticated;
ALTER TABLE public.hhee_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_active_account ON public.hhee_settings AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.hhee_settings FROM PUBLIC,anon,authenticated;
REVOKE ALL ON SEQUENCE public.hhee_requests_sequence_seq,public.hhee_audit_id_seq FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.hhee_cost_access() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT public.is_active_tms_user() AND (public.is_tms_admin() OR public.has_tms_permission('hhee-config') OR public.has_tms_permission('hhee-validar') OR public.has_tms_read_permission('hhee-costos'));
$$;
CREATE FUNCTION public.hhee_minutes(s timestamptz,e timestamptz,b integer) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
 IF s IS NULL OR e IS NULL OR e<=s OR e>s+interval '16 hours' OR b IS NULL OR b<0 THEN RAISE EXCEPTION 'Revise el intervalo: debe ser positivo y no exceder 16 horas.'; END IF;
 n:=floor(extract(epoch FROM e-s)/60)::integer-b;
 IF n NOT BETWEEN 1 AND 960 THEN RAISE EXCEPTION 'El descanso debe ser menor al intervalo registrado.'; END IF;
 RETURN n;
END $$;
CREATE FUNCTION public.hhee_local_time(v text) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
BEGIN
 IF v IS NULL OR v !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$' THEN RAISE EXCEPTION 'Ingrese fecha y hora de Lima con precisión de minutos.'; END IF;
 RETURN v::timestamp AT TIME ZONE 'America/Lima';
END $$;
ALTER TABLE public.hhee_requests ADD COLUMN exception_status text NOT NULL DEFAULT 'PENDIENTE' CHECK(exception_status IN('PENDIENTE','APROBADA','OBSERVADA')),
 ADD COLUMN exception_by uuid REFERENCES public.profiles(id), ADD COLUMN exception_at timestamptz, ADD COLUMN exception_note text;
CREATE INDEX hhee_requests_exception_by_idx ON public.hhee_requests(exception_by);
ALTER TABLE public.hhee_lines ADD COLUMN reported_minutes integer, ADD COLUMN reported_cost numeric(16,2) CHECK(reported_cost>=0),
 ADD COLUMN attendance_hash text, ADD COLUMN attendance_reference text;
ALTER TABLE public.hhee_audit ADD COLUMN private_data jsonb NOT NULL DEFAULT '{}';
UPDATE public.hhee_settings SET approval_label='Jefe del área';

CREATE FUNCTION public.hhee_needs_exception(p_request uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.hhee_requests r WHERE r.id=p_request AND (
   r.emergency OR (r.approval='APROBADA' AND r.approved_by=r.created_by) OR
   (r.state IN('EJECUTADA','VALIDADA') AND EXISTS(SELECT 1 FROM public.hhee_lines z WHERE z.request_id=r.id AND z.actual_minutes>0) AND (r.approval<>'APROBADA' OR EXISTS(
    SELECT 1 FROM public.hhee_lines l WHERE l.request_id=r.id AND l.actual_minutes>0 AND
      (r.approved_at>l.actual_start OR l.actual_minutes>COALESCE(l.approved_minutes,0)
       OR NOT l.consent OR (l.actual_start AT TIME ZONE 'America/Lima')::date<>r.work_date))))));
$$;
-- Gerencia reviews exceptions across its authorized sites; it does not receive individual cost rates.
CREATE FUNCTION public.hhee_can(p_area uuid,p_cap text DEFAULT 'read') RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT public.is_active_tms_user() AND EXISTS(SELECT 1 FROM public.hhee_areas a WHERE a.id=p_area AND public.can_access_site(a.site_id))
 AND (public.is_tms_admin() OR
   (p_cap IN('config','read') AND public.has_tms_permission('hhee-config')) OR
   (p_cap='exception' AND public.has_tms_permission('hhee-excepciones')) OR
   (p_cap='read' AND (public.has_tms_read_permission('hhee-gerencia') OR public.has_tms_read_permission('hhee-excepciones'))) OR
   (EXISTS(SELECT 1 FROM public.hhee_memberships m WHERE m.user_id=auth.uid() AND m.area_id=p_area) AND
     CASE p_cap WHEN 'read' THEN public.has_tms_read_permission('hhee') OR public.has_tms_read_permission('hhee-solicitar')
       OR public.has_tms_read_permission('hhee-aprobar') OR public.has_tms_read_permission('hhee-validar') OR public.has_tms_read_permission('hhee-costos')
     WHEN 'request' THEN public.has_tms_permission('hhee-solicitar')
     WHEN 'approve' THEN public.has_tms_permission('hhee-aprobar')
     WHEN 'validate' THEN public.has_tms_permission('hhee-validar') ELSE false END));
$$;
CREATE FUNCTION public.hhee_context() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE config boolean; any_area boolean;
BEGIN
 SELECT EXISTS(SELECT 1 FROM public.hhee_areas WHERE public.hhee_can(id)) INTO any_area;
 config:=public.is_active_tms_user() AND (public.is_tms_admin() OR public.has_tms_permission('hhee-config'));
 IF NOT any_area AND NOT config THEN RETURN jsonb_build_object('success',false,'error','No tiene acceso a HHEE. Solicite permiso y asignación de área.'); END IF;
 RETURN jsonb_build_object('success',true,'user_id',auth.uid(),'config',config,'individual_costs',public.hhee_cost_access(),
  'executive_costs',public.hhee_cost_access() OR public.has_tms_read_permission('hhee-gerencia'),
  'areas',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'site_id',a.site_id,'site_name',s.name,'active',a.active,
    'can_request',public.hhee_can(a.id,'request'),'can_approve',public.hhee_can(a.id,'approve'),
    'can_validate',public.hhee_can(a.id,'validate'),'can_exception',public.hhee_can(a.id,'exception')) ORDER BY s.name,a.name)
    FROM public.hhee_areas a JOIN public.sites s ON s.id=a.site_id WHERE public.hhee_can(a.id)), '[]'),
  'causes',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.name) FROM public.hhee_causes c),'[]'),
  'people',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'code',p.code,'name',p.name,'area_id',p.area_id,'active',p.active,
    'estimated_hour_cost',CASE WHEN config OR public.hhee_can(p.area_id,'validate') THEN p.estimated_hour_cost END,'profile_id',p.profile_id) ORDER BY p.name)
    FROM public.hhee_people p WHERE public.hhee_can(p.area_id)), '[]'),
  'settings',(SELECT to_jsonb(t) - CASE WHEN config OR public.has_tms_read_permission('hhee-gerencia') THEN ARRAY[]::text[] ELSE ARRAY['report_to','report_cc'] END FROM public.hhee_settings t WHERE id=1),
  'sites',CASE WHEN config THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name) FROM public.sites WHERE public.can_access_site(id) AND is_active),'[]') ELSE '[]'::jsonb END,
  'users',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',COALESCE(NULLIF(concat_ws(' ',to_jsonb(p)->>'first_name',to_jsonb(p)->>'last_name'),''),p.id::text))) FROM public.profiles p WHERE p.is_active AND (config OR EXISTS(SELECT 1 FROM public.hhee_memberships m WHERE m.user_id=p.id AND (public.hhee_can(m.area_id,'approve') OR public.hhee_can(m.area_id,'validate'))))),'[]'),
  'memberships',CASE WHEN config THEN COALESCE((SELECT jsonb_agg(to_jsonb(m)) FROM public.hhee_memberships m WHERE public.hhee_can(m.area_id,'config')),'[]') ELSE '[]'::jsonb END);
END $$;

CREATE FUNCTION public.hhee_reference_search(p_area uuid,p_q text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE site uuid;
BEGIN
 IF NOT public.hhee_can(p_area) THEN RETURN jsonb_build_object('success',false,'error','Sin acceso al área'); END IF;
 SELECT site_id INTO site FROM public.hhee_areas WHERE id=p_area;
 RETURN jsonb_build_object('success',true,'rows',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'code',code)) FROM
 (SELECT c.id,c.code FROM public.contracts c WHERE length(btrim(p_q))>=2 AND c.code ILIKE '%'||left(btrim(p_q),60)||'%'
 AND COALESCE(NULLIF(to_jsonb(c)->>'site_id','')::uuid,public.primary_site_id())=site ORDER BY c.code LIMIT 25) t),'[]'));
END $$;

CREATE FUNCTION public.hhee_mutate(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE op uuid; cmd text:=p->>'action'; rid uuid; aid uuid; area uuid; r public.hhee_requests; ac public.hhee_actions;
 person public.hhee_people; item jsonb; line public.hhee_lines; response jsonb; old_response jsonb; v_hash text;
 reason text:=btrim(COALESCE(p->>'reason','')); n integer; idx integer; start_at timestamptz; end_at timestamptz;
 v_code text; prior jsonb; msg text; cost_ok boolean; target_id uuid;
BEGIN
 IF NOT public.is_active_tms_user() THEN RAISE EXCEPTION 'Su cuenta no está activa.'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('hhee-write'),0);
 IF length(reason)>3000 THEN RAISE EXCEPTION 'El sustento no puede superar 3000 caracteres.'; END IF;
 op:=(p->>'operation_id')::uuid;
 IF op IS NULL THEN RAISE EXCEPTION 'Falta la identificación de la operación.'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('hhee-operation'),hashtext(op::text));
 v_hash:=md5(p::text);
 SELECT z.response,z.payload_hash INTO old_response,msg FROM public.hhee_receipts z WHERE z.operation_id=op AND z.actor=auth.uid();
 IF FOUND THEN
   IF msg<>v_hash THEN RAISE EXCEPTION 'La operación ya fue utilizada con otros datos.'; END IF;
   RETURN old_response;
 END IF;
 IF cmd IN('area','person','people_import','membership','settings') THEN
  IF NOT (public.is_tms_admin() OR public.has_tms_permission('hhee-config')) THEN RAISE EXCEPTION 'Se requiere permiso de configuración HHEE.'; END IF;
  IF cmd='area' THEN
   area:=NULLIF(p->>'id','')::uuid;
   IF NOT public.can_access_site((p->>'site_id')::uuid) THEN RAISE EXCEPTION 'Sede fuera de su alcance.'; END IF;
   IF area IS NOT NULL AND NOT public.hhee_can(area,'config') THEN RAISE EXCEPTION 'Área fuera de su alcance.'; END IF;
   INSERT INTO public.hhee_areas(id,site_id,name,active) VALUES(COALESCE(area,gen_random_uuid()),(p->>'site_id')::uuid,btrim(p->>'name'),COALESCE((p->>'active')::boolean,true))
   ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,active=EXCLUDED.active RETURNING id INTO area;
  ELSIF cmd IN('person','people_import') THEN
   IF cmd='people_import' AND (jsonb_typeof(p->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'rows') NOT BETWEEN 1 AND 300) THEN RAISE EXCEPTION 'Importe entre 1 y 300 trabajadores por archivo.'; END IF;
   FOR item IN SELECT value FROM jsonb_array_elements(CASE WHEN cmd='person' THEN jsonb_build_array(p) ELSE p->'rows' END) LOOP
    area:=(item->>'area_id')::uuid;
    IF NOT public.hhee_can(area,'config') THEN RAISE EXCEPTION 'Área fuera de su alcance.'; END IF;
    v_code:=upper(btrim(item->>'code'));
    SELECT * INTO person FROM public.hhee_people WHERE public.hhee_people.code=v_code FOR UPDATE;
    IF FOUND AND NOT public.hhee_can(person.area_id,'config') THEN RAISE EXCEPTION 'Código de trabajador fuera de su alcance.'; END IF;
    INSERT INTO public.hhee_people(code,name,area_id,active,estimated_hour_cost,profile_id)
    VALUES(v_code,btrim(item->>'name'),area,COALESCE((item->>'active')::boolean,true),NULLIF(item->>'estimated_hour_cost','')::numeric,NULLIF(item->>'profile_id','')::uuid)
    ON CONFLICT ON CONSTRAINT hhee_people_code_key DO UPDATE SET name=EXCLUDED.name,area_id=EXCLUDED.area_id,active=EXCLUDED.active,
      estimated_hour_cost=EXCLUDED.estimated_hour_cost,profile_id=EXCLUDED.profile_id;
   END LOOP;
  ELSIF cmd='membership' THEN
   area:=(p->>'area_id')::uuid;
   IF NOT public.hhee_can(area,'config') THEN RAISE EXCEPTION 'Área fuera de su alcance.'; END IF;
   IF (p->>'enabled')::boolean THEN INSERT INTO public.hhee_memberships(user_id,area_id) VALUES((p->>'user_id')::uuid,area) ON CONFLICT DO NOTHING;
   ELSE DELETE FROM public.hhee_memberships WHERE user_id=(p->>'user_id')::uuid AND area_id=area; END IF;
  ELSE
   IF length(COALESCE(p->>'report_to',''))>1000 OR length(COALESCE(p->>'report_cc',''))>1000
      OR (COALESCE(p->>'report_to','')||COALESCE(p->>'report_cc','')) ~ E'[\r\n]' THEN RAISE EXCEPTION 'Revise los destinatarios del reporte.'; END IF;
   UPDATE public.hhee_settings SET recurrence_days=(p->>'recurrence_days')::int,recurrence_events=(p->>'recurrence_events')::int,
    report_day=(p->>'report_day')::int,report_time=(p->>'report_time')::time,report_to=COALESCE(p->>'report_to',''),report_cc=COALESCE(p->>'report_cc','') WHERE id=1;
  END IF;
  INSERT INTO public.hhee_audit(actor,event,reason) VALUES(auth.uid(),'CONFIGURACIÓN: '||cmd,'Configuración del piloto HHEE');
 ELSIF cmd='save_request' THEN
  rid:=(p->>'id')::uuid; area:=(p->>'area_id')::uuid;
  IF rid IS NULL OR NOT public.hhee_can(area,'request') THEN RAISE EXCEPTION 'No tiene permiso para solicitar HHEE en esta área.'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.hhee_areas WHERE id=area AND active) THEN RAISE EXCEPTION 'El área está inactiva.'; END IF;
  SELECT * INTO r FROM public.hhee_requests WHERE id=rid FOR UPDATE;
  IF FOUND AND (r.created_by<>auth.uid() OR r.state<>'BORRADOR' OR r.version IS DISTINCT FROM (p->>'version')::int OR r.area_id<>area) THEN
    RAISE EXCEPTION 'La solicitud cambió, no es propia o ya fue presentada. Actualice el detalle.';
  END IF;
  IF jsonb_typeof(p->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'lines') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Incluya entre 1 y 100 trabajadores.'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.hhee_causes WHERE id=(p->>'cause_id')::uuid AND active) THEN RAISE EXCEPTION 'Seleccione una causa vigente.'; END IF;
  IF NULLIF(p->>'origin_area_id','') IS NOT NULL AND NOT public.hhee_can((p->>'origin_area_id')::uuid) THEN RAISE EXCEPTION 'Área de origen fuera de su alcance.'; END IF;
  target_id:=NULL;
  IF p->>'reference_type'='OT' THEN
   SELECT c.id INTO target_id FROM public.contracts c JOIN public.hhee_areas a ON a.id=area
    WHERE c.code=btrim(p->>'reference_code') AND COALESCE(NULLIF(to_jsonb(c)->>'site_id','')::uuid,public.primary_site_id())=a.site_id;
   IF target_id IS NULL THEN RAISE EXCEPTION 'La OT no existe en la sede del área.'; END IF;
  ELSIF COALESCE(p->>'reference_type','SIN_REFERENCIA')<>'SIN_REFERENCIA' AND NULLIF(btrim(p->>'reference_code'),'') IS NULL THEN RAISE EXCEPTION 'Indique el documento de referencia.'; END IF;
  IF (p->>'work_date')::date > (now() AT TIME ZONE 'America/Lima')::date+366 OR (p->>'work_date')::date < (now() AT TIME ZONE 'America/Lima')::date-366 THEN RAISE EXCEPTION 'Fecha fuera del período permitido de un año.'; END IF;
  INSERT INTO public.hhee_requests(id,area_id,cause_id,origin_area_id,work_date,activity,justification,alternatives,expected_result,result_unit,target,
    reference_type,reference_code,contract_id,emergency,emergency_reason,created_by)
  VALUES(rid,area,(p->>'cause_id')::uuid,NULLIF(p->>'origin_area_id','')::uuid,(p->>'work_date')::date,btrim(p->>'activity'),btrim(p->>'justification'),
    btrim(p->>'alternatives'),btrim(p->>'expected_result'),NULLIF(btrim(p->>'result_unit'),''),NULLIF(p->>'target','')::numeric,
    COALESCE(p->>'reference_type','SIN_REFERENCIA'),NULLIF(btrim(p->>'reference_code'),''),target_id,COALESCE((p->>'emergency')::boolean,false),NULLIF(btrim(p->>'emergency_reason'),''),auth.uid())
  ON CONFLICT(id) DO UPDATE SET cause_id=EXCLUDED.cause_id,origin_area_id=EXCLUDED.origin_area_id,work_date=EXCLUDED.work_date,activity=EXCLUDED.activity,
    justification=EXCLUDED.justification,alternatives=EXCLUDED.alternatives,expected_result=EXCLUDED.expected_result,result_unit=EXCLUDED.result_unit,target=EXCLUDED.target,
    reference_type=EXCLUDED.reference_type,reference_code=EXCLUDED.reference_code,contract_id=EXCLUDED.contract_id,
    emergency=EXCLUDED.emergency,emergency_reason=EXCLUDED.emergency_reason,version=public.hhee_requests.version+1,updated_at=now();
  DELETE FROM public.hhee_lines WHERE request_id=rid;
  FOR item IN SELECT value FROM jsonb_array_elements(p->'lines') LOOP
   SELECT * INTO person FROM public.hhee_people WHERE id=(item->>'person_id')::uuid AND active AND area_id=area;
   IF NOT FOUND THEN RAISE EXCEPTION 'Incluya solo trabajadores activos del área.'; END IF;
   start_at:=public.hhee_local_time(item->>'planned_start'); end_at:=public.hhee_local_time(item->>'planned_end');
   IF (start_at AT TIME ZONE 'America/Lima')::date<>(p->>'work_date')::date THEN RAISE EXCEPTION 'El inicio previsto debe corresponder a la fecha operativa.'; END IF;
   n:=public.hhee_minutes(start_at,end_at,COALESCE((item->>'planned_break')::int,0));
   INSERT INTO public.hhee_lines(request_id,person_id,person_name,person_code,planned_start,planned_end,planned_break,planned_minutes,estimated_cost)
   VALUES(rid,person.id,person.name,person.code,start_at,end_at,COALESCE((item->>'planned_break')::int,0),n,round(n/60.0*person.estimated_hour_cost,2));
  END LOOP;
  INSERT INTO public.hhee_audit(request_id,actor,event,reason) VALUES(rid,auth.uid(),'BORRADOR GUARDADO','Solicitud y personal previstos');
 ELSE
  IF cmd IN('action_save','action_update') THEN
   aid:=NULLIF(p->>'id','')::uuid;
   IF cmd='action_save' THEN
    area:=(p->>'area_id')::uuid;
    IF NOT (public.hhee_can(area,'approve') OR public.hhee_can(area,'validate') OR public.hhee_can(area,'config')) THEN RAISE EXCEPTION 'No tiene permiso para definir acciones del área.'; END IF;
    rid:=NULLIF(p->>'request_id','')::uuid;
    IF rid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.hhee_requests WHERE id=rid AND area_id=area) THEN RAISE EXCEPTION 'Solicitud fuera del área.'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.hhee_memberships m JOIN public.profiles x ON x.id=m.user_id WHERE x.is_active AND m.user_id=(p->>'assigned_to')::uuid AND m.area_id=area)
       AND NOT EXISTS(SELECT 1 FROM public.profiles x WHERE x.id=(p->>'assigned_to')::uuid AND x.is_active AND public.is_tms_admin() AND x.id=auth.uid()) THEN
      RAISE EXCEPTION 'Asigne un responsable activo con acceso al área.'; END IF;
    INSERT INTO public.hhee_actions(area_id,request_id,cause_id,title,assigned_to,due_date,created_by)
    VALUES(area,rid,(p->>'cause_id')::uuid,btrim(p->>'title'),(p->>'assigned_to')::uuid,(p->>'due_date')::date,auth.uid()) RETURNING id INTO aid;
   ELSE
    SELECT * INTO ac FROM public.hhee_actions WHERE id=aid FOR UPDATE;
    IF NOT FOUND OR NOT public.hhee_can(ac.area_id) OR ac.version IS DISTINCT FROM (p->>'version')::int THEN RAISE EXCEPTION 'La acción cambió o no es accesible.'; END IF;
    IF ac.state='VERIFICADA' THEN RAISE EXCEPTION 'La acción ya fue verificada; registre una nueva si la causa continúa.'; END IF;
    IF NOT (ac.assigned_to=auth.uid() OR public.hhee_can(ac.area_id,'approve') OR public.hhee_can(ac.area_id,'validate') OR public.hhee_can(ac.area_id,'config')) THEN RAISE EXCEPTION 'Solo el responsable o el supervisor puede actualizar esta acción.'; END IF;
    IF p->>'state'='VERIFICADA' THEN
     IF NOT (public.hhee_can(ac.area_id,'approve') OR public.hhee_can(ac.area_id,'validate')) OR ac.assigned_to=auth.uid() OR ac.state<>'REALIZADA' OR length(reason)<10 OR p->>'effective' IS NULL THEN RAISE EXCEPTION 'La verificación requiere otro responsable autorizado, una acción realizada y evaluación de efectividad.'; END IF;
     UPDATE public.hhee_actions SET state='VERIFICADA',verification=reason,effective=(p->>'effective')::boolean,verified_by=auth.uid(),version=version+1 WHERE id=aid;
    ELSE
     IF p->>'state' NOT IN('EN_CURSO','REALIZADA') OR (p->>'state'='REALIZADA' AND length(reason)<10) THEN RAISE EXCEPTION 'Indique avance o conclusión de la acción.'; END IF;
     UPDATE public.hhee_actions SET state=p->>'state',conclusion=reason,completed_at=CASE WHEN p->>'state'='REALIZADA' THEN now() END,version=version+1 WHERE id=aid;
    END IF;
   END IF;
   INSERT INTO public.hhee_audit(action_id,actor,event,reason) VALUES(aid,auth.uid(),cmd,COALESCE(NULLIF(reason,''),'Acción correctiva registrada'));
  ELSE
   rid:=(p->>'id')::uuid;
   SELECT * INTO r FROM public.hhee_requests WHERE id=rid FOR UPDATE;
   IF NOT FOUND OR NOT public.hhee_can(r.area_id) THEN RAISE EXCEPTION 'Solicitud no disponible en su alcance.'; END IF;
   IF r.version IS DISTINCT FROM (p->>'version')::int THEN RAISE EXCEPTION 'La solicitud fue actualizada. Recargue antes de continuar.'; END IF;
   prior:=jsonb_build_object('state',r.state,'approval',r.approval,'version',r.version);
   IF cmd='submit' THEN
    IF r.created_by<>auth.uid() OR NOT public.hhee_can(r.area_id,'request') OR r.state<>'BORRADOR' THEN RAISE EXCEPTION 'Solo el solicitante puede presentar su borrador.'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.hhee_lines WHERE request_id=rid) THEN RAISE EXCEPTION 'La solicitud no tiene personal.'; END IF;
    UPDATE public.hhee_lines l SET estimated_cost=round(l.planned_minutes/60.0*p.estimated_hour_cost,2) FROM public.hhee_people p WHERE l.request_id=rid AND p.id=l.person_id;
    UPDATE public.hhee_requests SET state='SOLICITADA',submitted_at=now() WHERE id=rid;
   ELSIF cmd='decide' THEN
    IF NOT public.hhee_can(r.area_id,'approve') OR r.state IN('BORRADOR','CANCELADA','VALIDADA') THEN RAISE EXCEPTION 'Se requiere aprobación del jefe del área para una solicitud presentada.'; END IF;
    IF length(reason)<10 THEN RAISE EXCEPTION 'Ingrese el sustento de la decisión.'; END IF;
    IF r.created_by=auth.uid() AND NOT (public.is_tms_admin() AND COALESCE((p->>'override')::boolean,false) AND length(reason)>=20) THEN RAISE EXCEPTION 'Solicite aprobación a otro responsable. La excepción administrativa requiere sustento y revisión gerencial.'; END IF;
    IF p->>'decision' NOT IN('APROBADA','RECHAZADA') THEN RAISE EXCEPTION 'Decisión no válida.'; END IF;
    IF p->>'decision'='APROBADA' THEN
     IF jsonb_typeof(p->'lines') IS DISTINCT FROM 'array' OR (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p->'lines'))<>jsonb_array_length(p->'lines') OR jsonb_array_length(p->'lines')<>(SELECT count(*) FROM public.hhee_lines WHERE request_id=rid) THEN RAISE EXCEPTION 'Revise las horas de cada trabajador.'; END IF;
     PERFORM pg_advisory_xact_lock(hashtext('hhee-approval'),hashtext(l.person_id::text)) FROM public.hhee_lines l WHERE l.request_id=rid ORDER BY l.person_id;
     FOR item IN SELECT value FROM jsonb_array_elements(p->'lines') LOOP
      SELECT * INTO line FROM public.hhee_lines WHERE request_id=rid AND id=(item->>'id')::uuid;
      IF NOT FOUND OR NULLIF(item->>'approved_minutes','') IS NULL OR (item->>'approved_minutes')::int NOT BETWEEN 0 AND line.planned_minutes THEN RAISE EXCEPTION 'La aprobación debe estar entre cero y las horas solicitadas.'; END IF;
      IF EXISTS(SELECT 1 FROM public.hhee_lines x JOIN public.hhee_requests y ON y.id=x.request_id WHERE x.person_id=line.person_id AND x.request_id<>rid
        AND y.approval='APROBADA' AND y.state<>'CANCELADA' AND COALESCE(x.approved_minutes,0)>0
        AND x.planned_start<line.planned_end AND x.planned_end>line.planned_start) AND (item->>'approved_minutes')::int>0 THEN RAISE EXCEPTION 'El trabajador ya tiene HHEE aprobadas en un intervalo superpuesto.'; END IF;
      UPDATE public.hhee_lines SET approved_minutes=(item->>'approved_minutes')::int WHERE id=line.id;
     END LOOP;
    ELSE UPDATE public.hhee_lines SET approved_minutes=0 WHERE request_id=rid; END IF;
    UPDATE public.hhee_requests SET approval=p->>'decision',approved_by=auth.uid(),approved_at=now(),approval_reason=reason,exception_status='PENDIENTE',exception_by=NULL,exception_at=NULL WHERE id=rid;
   ELSIF cmd='result' THEN
    IF NOT ((r.created_by=auth.uid() AND public.hhee_can(r.area_id,'request')) OR public.hhee_can(r.area_id,'approve') OR public.hhee_can(r.area_id,'validate')) OR r.state IN('BORRADOR','CANCELADA','VALIDADA') THEN RAISE EXCEPTION 'No puede registrar el resultado en este estado.'; END IF;
    IF length(btrim(p->>'result_text'))<10 THEN RAISE EXCEPTION 'Describa el resultado obtenido.'; END IF;
    UPDATE public.hhee_requests SET result_text=btrim(p->>'result_text'),evidence=NULLIF(btrim(p->>'evidence'),''),achieved=NULLIF(p->>'achieved','')::numeric WHERE id=rid;
   ELSIF cmd='validate' THEN
    IF NOT public.hhee_can(r.area_id,'validate') OR r.state<>'EJECUTADA' THEN RAISE EXCEPTION 'RR. HH. debe validar una ejecución importada.'; END IF;
    IF length(reason)<10 OR length(COALESCE(r.result_text,''))<10 OR NULLIF(r.attendance_reference,'') IS NULL THEN RAISE EXCEPTION 'Complete el resultado, el sustento de RR. HH. y la fuente de asistencia.'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.hhee_causes WHERE id=(p->>'confirmed_cause_id')::uuid AND active) THEN RAISE EXCEPTION 'Confirme la causa operativa.'; END IF;
    IF p->>'assessment' NOT IN('PENDIENTE','JUSTIFICADA','MEJORABLE') THEN RAISE EXCEPTION 'Seleccione la evaluación de necesidad.'; END IF;
    IF EXISTS(SELECT 1 FROM public.hhee_lines WHERE request_id=rid AND actual_minutes IS NULL) THEN RAISE EXCEPTION 'Importe la asistencia de todos los trabajadores antes de validar.'; END IF;
    UPDATE public.hhee_lines SET validated_minutes=COALESCE(reported_minutes,actual_minutes),validated_cost=reported_cost WHERE request_id=rid;
    UPDATE public.hhee_requests SET state='VALIDADA',validated_by=auth.uid(),validated_at=now(),validation_reason=reason,
      confirmed_cause_id=(p->>'confirmed_cause_id')::uuid,assessment=p->>'assessment' WHERE id=rid;
   ELSIF cmd='reopen' THEN
    IF NOT public.hhee_can(r.area_id,'validate') OR r.state<>'VALIDADA' OR length(reason)<15 THEN RAISE EXCEPTION 'La reapertura requiere permiso RR. HH. y un motivo detallado.'; END IF;
    INSERT INTO public.hhee_audit(request_id,actor,event,reason,private_data) SELECT rid,auth.uid(),'DATOS PREVIOS A REAPERTURA',reason,jsonb_build_object('lines',jsonb_agg(to_jsonb(l))) FROM public.hhee_lines l WHERE request_id=rid;
    UPDATE public.hhee_lines SET validated_minutes=NULL,validated_cost=NULL WHERE request_id=rid;
    UPDATE public.hhee_requests SET state='EJECUTADA',validated_by=NULL,validated_at=NULL,exception_status='PENDIENTE',exception_by=NULL,exception_at=NULL WHERE id=rid;
   ELSIF cmd='exception' THEN
    IF NOT public.hhee_can(r.area_id,'exception') OR NOT public.hhee_needs_exception(rid) OR r.created_by=auth.uid() OR length(reason)<15 THEN RAISE EXCEPTION 'Gerencia debe revisar la excepción con independencia y sustento.'; END IF;
    IF p->>'decision' NOT IN('APROBADA','OBSERVADA') THEN RAISE EXCEPTION 'Revisión gerencial no válida.'; END IF;
    UPDATE public.hhee_requests SET exception_status=p->>'decision',exception_by=auth.uid(),exception_at=now(),exception_note=reason WHERE id=rid;
   ELSIF cmd='cancel' THEN
    IF NOT ((r.created_by=auth.uid() AND public.hhee_can(r.area_id,'request')) OR public.hhee_can(r.area_id,'approve')) OR r.state NOT IN('BORRADOR','SOLICITADA') OR length(reason)<10
      OR EXISTS(SELECT 1 FROM public.hhee_lines WHERE request_id=rid AND actual_minutes IS NOT NULL) THEN RAISE EXCEPTION 'No se puede cancelar una ejecución ni ocultar horas trabajadas.'; END IF;
    UPDATE public.hhee_requests SET state='CANCELADA' WHERE id=rid;
   ELSE RAISE EXCEPTION 'Operación no reconocida.'; END IF;
   UPDATE public.hhee_requests SET version=version+1,updated_at=now() WHERE id=rid;
   INSERT INTO public.hhee_audit(request_id,actor,event,reason,private_data) VALUES(rid,auth.uid(),upper(cmd),NULLIF(reason,''),prior);
  END IF;
 END IF;
 response:=jsonb_build_object('success',true,'id',COALESCE(rid,aid,area));
 INSERT INTO public.hhee_receipts(operation_id,actor,payload_hash,response) VALUES(op,auth.uid(),v_hash,response);
 RETURN response;
EXCEPTION WHEN raise_exception THEN RETURN jsonb_build_object('success',false,'error',SQLERRM);
 WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range OR not_null_violation OR check_violation OR unique_violation OR foreign_key_violation THEN
 RETURN jsonb_build_object('success',false,'error','Revise los datos: códigos únicos, campos obligatorios, valores y referencias vigentes.');
END $$;

-- Preview and commit share exactly the same server validation. One file is one atomic transaction.
CREATE FUNCTION public.hhee_attendance(p jsonb,p_apply boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item jsonb; r public.hhee_requests; l public.hhee_lines; s timestamptz; e timestamptz; mins int; recognized int;
 amount numeric; h text; result_rows jsonb:='[]'; errors jsonb:='[]'; normalized jsonb:='[]'; rec jsonb;
 seen text[]:='{}'; changed uuid[]:='{}'; key text; row_no int:=1; err text; op uuid; cached jsonb; oldhash text;
BEGIN
 IF NOT public.is_active_tms_user() THEN RAISE EXCEPTION 'Cuenta inactiva.'; END IF;
 IF jsonb_typeof(p->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'rows') NOT BETWEEN 1 AND 500
 OR length(COALESCE(p->>'file_name','')) NOT BETWEEN 1 AND 200 OR COALESCE(p->>'file_hash','') !~ '^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'Seleccione un Excel válido con 1 a 500 filas y su identificación de origen.'; END IF;
 IF p_apply THEN
  PERFORM pg_advisory_xact_lock(hashtext('hhee-write'),0);
  op:=(p->>'operation_id')::uuid;
  IF op IS NULL THEN RAISE EXCEPTION 'Falta la identificación de la importación.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('hhee-operation'),hashtext(op::text));
  SELECT response,payload_hash INTO cached,oldhash FROM public.hhee_receipts WHERE operation_id=op AND actor=auth.uid();
  IF FOUND THEN
   IF oldhash<>md5(p::text) THEN RAISE EXCEPTION 'Identificador de operación reutilizado.'; END IF;
   RETURN cached;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('hhee-attendance'),0);
  -- Lock all participating requests before validating versions or changing any line.
  PERFORM 1 FROM public.hhee_requests q WHERE q.sequence IN
    (SELECT substring(value->>'request_code' FROM '^HE-([0-9]+)$')::bigint FROM jsonb_array_elements(p->'rows'))
    ORDER BY q.id FOR UPDATE;
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p->'rows') LOOP
  row_no:=row_no+1; err:=NULL;
  BEGIN
   SELECT * INTO r FROM public.hhee_requests WHERE sequence=substring(item->>'request_code' FROM '^HE-([0-9]+)$')::bigint;
   IF NOT FOUND OR NOT public.hhee_can(r.area_id,'validate') THEN RAISE EXCEPTION 'Solicitud inexistente o sin permiso RR. HH. en el área.'; END IF;
   SELECT * INTO l FROM public.hhee_lines WHERE request_id=r.id AND person_code=upper(btrim(item->>'person_code'));
   IF NOT FOUND THEN RAISE EXCEPTION 'El trabajador no está incluido en la solicitud.'; END IF;
   IF r.state IN('BORRADOR','CANCELADA') THEN RAISE EXCEPTION 'La solicitud debe estar presentada y no cancelada.'; END IF;
   IF p_apply AND r.version IS DISTINCT FROM (item->>'version')::int THEN RAISE EXCEPTION 'La solicitud cambió; vuelva a generar la vista previa.'; END IF;
   key:=l.id::text;
   IF key=ANY(seen) THEN RAISE EXCEPTION 'Trabajador y solicitud duplicados en el archivo.'; END IF;
   seen:=array_append(seen,key);
   s:=public.hhee_local_time(item->>'start'); e:=public.hhee_local_time(item->>'end');
   IF length(COALESCE(item->>'result',''))>3000 OR length(COALESCE(item->>'evidence',''))>2000 THEN RAISE EXCEPTION 'El resultado o sustento exceden su longitud permitida.'; END IF;
   mins:=CASE WHEN s=e AND COALESCE((item->>'break_minutes')::int,0)=0 THEN 0 ELSE public.hhee_minutes(s,e,COALESCE((item->>'break_minutes')::int,0)) END;
   IF abs((s AT TIME ZONE 'America/Lima')::date-r.work_date)>1 THEN RAISE EXCEPTION 'Asistencia fuera de la fecha operativa (tolerancia de un día).'; END IF;
   recognized:=COALESCE(NULLIF(item->>'recognized_minutes','')::int,mins);
   IF recognized NOT BETWEEN 0 AND mins THEN RAISE EXCEPTION 'Las horas reconocidas no pueden superar las registradas.'; END IF;
   amount:=NULLIF(item->>'cost','')::numeric;
   IF (mins=0 AND COALESCE(amount,0)>0) OR amount<0 OR amount>99999999 THEN RAISE EXCEPTION 'Costo fuera del rango permitido.'; END IF;
   IF mins>0 AND (EXISTS(SELECT 1 FROM public.hhee_lines x WHERE x.person_id=l.person_id AND x.id<>l.id AND x.actual_minutes>0 AND x.actual_start<e AND x.actual_end>s)
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(normalized) x WHERE x->>'person_id'=l.person_id::text AND (x->>'start')::timestamptz<e AND (x->>'end')::timestamptz>s AND (x->>'minutes')::int>0))
   THEN RAISE EXCEPTION 'Intervalo trabajado superpuesto con otro registro del trabajador.'; END IF;
   h:=md5(jsonb_build_array(s,e,COALESCE((item->>'break_minutes')::int,0),recognized,amount,COALESCE((item->>'consent')::boolean,false),item->>'result',item->>'evidence')::text);
   IF l.attendance_hash IS DISTINCT FROM h THEN
    IF r.state='VALIDADA' THEN RAISE EXCEPTION 'Registro validado: RR. HH. debe reabrirlo antes de corregirlo.'; END IF;
    IF l.actual_minutes IS NOT NULL AND length(btrim(COALESCE(p->>'correction_reason','')))<15 THEN RAISE EXCEPTION 'La modificación de asistencia requiere un motivo de al menos 15 caracteres.'; END IF;
   END IF;
   rec:=jsonb_build_object('line_id',l.id,'request_id',r.id,'person_id',l.person_id,'start',s,'end',e,'minutes',mins,'recognized',recognized,'cost',amount,'hash',h,'changed',l.attendance_hash IS DISTINCT FROM h,'row',row_no,'data',item);
   normalized:=normalized||jsonb_build_array(rec);
   result_rows:=result_rows||jsonb_build_array(jsonb_build_object('row',row_no,'request_code',item->>'request_code','person_code',l.person_code,'person_name',l.person_name,
    'version',r.version,'planned',l.planned_minutes,'approved',l.approved_minutes,'actual',mins,'recognized',recognized,'cost',amount,'duplicate',l.attendance_hash=h,
    'warning',CASE WHEN r.approval<>'APROBADA' OR r.approved_at>s OR mins>COALESCE(l.approved_minutes,0) OR recognized<>mins OR NOT COALESCE((item->>'consent')::boolean,false) THEN 'Excepción: revisión de Gerencia; se conservan las horas trabajadas.' END));
  EXCEPTION WHEN raise_exception THEN err:=SQLERRM;
   WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN err:='Revise fechas, números y códigos de la fila.';
  END;
  IF err IS NOT NULL THEN errors:=errors||jsonb_build_array(jsonb_build_object('row',row_no,'error',err)); END IF;
 END LOOP;
 IF NOT p_apply OR jsonb_array_length(errors)>0 THEN RETURN jsonb_build_object('success',true,'applied',false,'rows',result_rows,'errors',errors); END IF;
 FOR rec IN SELECT value FROM jsonb_array_elements(normalized) WHERE (value->>'changed')::boolean LOOP
  item:=rec->'data';
  INSERT INTO public.hhee_audit(request_id,actor,event,reason,private_data)
    SELECT request_id,auth.uid(),'ASISTENCIA RR. HH.',COALESCE(NULLIF(p->>'correction_reason',''),'Importación de asistencia y costo'),
     jsonb_build_object('before',to_jsonb(x),'file',p->>'file_name','sha256',p->>'file_hash','row',rec->'row') FROM public.hhee_lines x WHERE id=(rec->>'line_id')::uuid;
  UPDATE public.hhee_lines SET actual_start=(rec->>'start')::timestamptz,actual_end=(rec->>'end')::timestamptz,actual_break=COALESCE((item->>'break_minutes')::int,0),
   actual_minutes=(rec->>'minutes')::int,reported_minutes=(rec->>'recognized')::int,reported_cost=(rec->>'cost')::numeric,
   consent=COALESCE((item->>'consent')::boolean,false),attendance_hash=rec->>'hash',attendance_reference=(p->>'file_name')||' · SHA256 '||(p->>'file_hash')||' · fila '||(rec->>'row')
   WHERE id=(rec->>'line_id')::uuid;
  UPDATE public.hhee_requests SET result_text=COALESCE(NULLIF(btrim(item->>'result'),''),result_text),evidence=COALESCE(NULLIF(btrim(item->>'evidence'),''),evidence) WHERE id=(rec->>'request_id')::uuid;
  changed:=array_append(changed,(rec->>'request_id')::uuid);
 END LOOP;
 UPDATE public.hhee_requests SET state='EJECUTADA',executed_at=COALESCE(executed_at,now()),attendance_source='EXCEL_RRHH',
  attendance_reference=(p->>'file_name')||' · SHA256 '||(p->>'file_hash'),version=version+1,updated_at=now(),
  exception_status='PENDIENTE',exception_by=NULL,exception_at=NULL WHERE id=ANY(changed);
 cached:=jsonb_build_object('success',true,'applied',true,'changed',cardinality(changed),'rows',result_rows,'errors','[]'::jsonb);
 INSERT INTO public.hhee_receipts VALUES(op,auth.uid(),md5(p::text),cached,now());
 RETURN cached;
EXCEPTION WHEN raise_exception THEN RETURN jsonb_build_object('success',false,'error',SQLERRM);
 WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range OR check_violation THEN
 RETURN jsonb_build_object('success',false,'error','Revise los datos de la importación.');
END $$;

-- A single bounded, scoped dataset feeds the charts, tables and exported executive report.
CREATE FUNCTION public.hhee_read(p jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d date:=COALESCE(NULLIF(p->>'from','')::date,date_trunc('month',now() AT TIME ZONE 'America/Lima')::date);
 u date:=COALESCE(NULLIF(p->>'to','')::date,(now() AT TIME ZONE 'America/Lima')::date);
 area uuid:=NULLIF(p->>'area_id','')::uuid; site uuid:=NULLIF(p->>'site_id','')::uuid;
 cost_access boolean; aggregate_cost boolean; rows_data jsonb; actions_data jsonb; action_counts jsonb;
BEGIN
 IF NOT public.is_active_tms_user() OR NOT EXISTS(SELECT 1 FROM public.hhee_areas WHERE public.hhee_can(id)) THEN
  RETURN jsonb_build_object('success',false,'error','Sin acceso a HHEE.'); END IF;
 IF u<d OR u-d>366 THEN RETURN jsonb_build_object('success',false,'error','Seleccione hasta 366 días.'); END IF;
 cost_access:=public.hhee_cost_access(); aggregate_cost:=cost_access OR public.has_tms_read_permission('hhee-gerencia');
 WITH base AS (
  SELECT r.*,a.name area_name,a.site_id,s.name site_name,c.name cause_name,o.name origin_area_name,
    public.hhee_needs_exception(r.id) needs_exception,
    (SELECT count(*)>=cfg.recurrence_events FROM public.hhee_requests x
     WHERE x.area_id=r.area_id AND COALESCE(x.confirmed_cause_id,x.cause_id)=COALESCE(r.confirmed_cause_id,r.cause_id)
     AND x.state IN('EJECUTADA','VALIDADA') AND EXISTS(SELECT 1 FROM public.hhee_lines xl WHERE xl.request_id=x.id AND xl.actual_minutes>0) AND x.work_date BETWEEN r.work_date-cfg.recurrence_days+1 AND r.work_date) recurrent
  FROM public.hhee_requests r JOIN public.hhee_areas a ON a.id=r.area_id JOIN public.sites s ON s.id=a.site_id
  JOIN public.hhee_causes c ON c.id=COALESCE(r.confirmed_cause_id,r.cause_id) LEFT JOIN public.hhee_areas o ON o.id=r.origin_area_id CROSS JOIN public.hhee_settings cfg
  WHERE public.hhee_can(r.area_id) AND r.work_date BETWEEN d AND u
    AND (area IS NULL OR r.area_id=area) AND (site IS NULL OR a.site_id=site)
    AND (NULLIF(p->>'cause_id','') IS NULL OR COALESCE(r.confirmed_cause_id,r.cause_id)=(p->>'cause_id')::uuid)
    AND (NULLIF(p->>'state','') IS NULL OR r.state=p->>'state')
    AND (NULLIF(btrim(p->>'search'),'') IS NULL OR (r.activity||' '||COALESCE(r.reference_code,'')||' HE-'||lpad(r.sequence::text,6,'0')) ILIKE '%'||left(btrim(p->>'search'),100)||'%')
 ), enriched AS (
 SELECT b.*,COALESCE(l.planned,0) planned_minutes,COALESCE(l.approved,0) approved_minutes,COALESCE(l.actual,0) actual_minutes,
  l.validated validated_minutes,CASE WHEN aggregate_cost THEN l.cost END validated_cost,
  CASE WHEN aggregate_cost THEN l.estimated END estimated_cost,l.pending_cost,l.workers,
  b.approval='APROBADA' AND b.approved_at<=l.first_actual AND NOT EXISTS(SELECT 1 FROM public.hhee_lines z WHERE z.request_id=b.id AND z.actual_minutes>COALESCE(z.approved_minutes,0)) prior_approval
 FROM base b LEFT JOIN LATERAL(SELECT sum(planned_minutes) planned,sum(approved_minutes) approved,sum(actual_minutes) actual,
   sum(validated_minutes) validated,sum(validated_cost) cost,sum(estimated_cost) estimated,count(*) FILTER(WHERE validated_minutes IS NOT NULL AND validated_cost IS NULL) pending_cost,
   count(*) workers,min(actual_start) first_actual FROM public.hhee_lines WHERE request_id=b.id) l ON true
 ), metrics AS (
 SELECT count(*) total_requests,COALESCE(sum(validated_minutes) FILTER(WHERE state='VALIDADA'),0) validated_minutes,
  COALESCE(sum(actual_minutes) FILTER(WHERE state='EJECUTADA'),0) pending_minutes,
  CASE WHEN aggregate_cost THEN sum(validated_cost) FILTER(WHERE state='VALIDADA') END validated_cost,
  COALESCE(sum(pending_cost) FILTER(WHERE state='VALIDADA'),0) pending_cost,
  count(*) FILTER(WHERE state IN('EJECUTADA','VALIDADA') AND actual_minutes>0) executed_requests,
  count(*) FILTER(WHERE state IN('EJECUTADA','VALIDADA') AND actual_minutes>0 AND prior_approval) prior_requests,
  COALESCE(sum(validated_minutes) FILTER(WHERE state='VALIDADA' AND recurrent),0) recurrent_minutes,
  count(*) FILTER(WHERE needs_exception AND exception_status='PENDIENTE') pending_exceptions,
  COALESCE(sum(validated_minutes) FILTER(WHERE state='VALIDADA' AND assessment='JUSTIFICADA'),0) justified_minutes,
  COALESCE(sum(validated_minutes) FILTER(WHERE state='VALIDADA' AND assessment='MEJORABLE'),0) improvable_minutes,
  COALESCE(sum(validated_minutes) FILTER(WHERE state='VALIDADA' AND assessment='PENDIENTE'),0) unassessed_minutes
 FROM enriched
 )
 SELECT jsonb_build_object('metrics',(SELECT to_jsonb(m) FROM metrics m),
 'total',(SELECT count(*) FROM enriched),
 'rows',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.work_date DESC,t.sequence DESC) FROM
   (SELECT * FROM enriched ORDER BY work_date DESC,sequence DESC LIMIT 500) t),'[]'),
 'trend',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.day) FROM
  (SELECT work_date AS day,sum(validated_minutes)/60.0 hours,CASE WHEN aggregate_cost THEN sum(validated_cost) END cost FROM enriched WHERE state='VALIDADA' GROUP BY work_date) t),'[]'),
 'causes',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.hours DESC) FROM
  (SELECT COALESCE(confirmed_cause_id,cause_id) id,cause_name name,sum(validated_minutes)/60.0 hours,CASE WHEN aggregate_cost THEN sum(validated_cost) END cost,count(*) requests
  FROM enriched WHERE state='VALIDADA' GROUP BY COALESCE(confirmed_cause_id,cause_id),cause_name) t),'[]'),
 'areas',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.hours DESC) FROM
  (SELECT area_id id,area_name name,sum(validated_minutes)/60.0 hours,CASE WHEN aggregate_cost THEN sum(validated_cost) END cost,
   sum(pending_cost) pending_cost,count(*) requests,count(*) FILTER(WHERE target IS NOT NULL AND achieved>=target) targets_met,
   count(*) FILTER(WHERE target IS NOT NULL) targets_defined FROM enriched WHERE state='VALIDADA' GROUP BY area_id,area_name) t),'[]')
 ) INTO rows_data;
 SELECT jsonb_build_object('actions_total',count(*),'actions_overdue',count(*) FILTER(WHERE x.state IN('ABIERTA','EN_CURSO') AND x.due_date<(now() AT TIME ZONE 'America/Lima')::date))
 INTO action_counts FROM public.hhee_actions x JOIN public.hhee_areas a ON a.id=x.area_id WHERE public.hhee_can(x.area_id)
 AND (area IS NULL OR x.area_id=area) AND (site IS NULL OR a.site_id=site)
 AND (NULLIF(p->>'cause_id','') IS NULL OR x.cause_id=(p->>'cause_id')::uuid)
 AND (x.due_date BETWEEN d AND u OR x.state<>'VERIFICADA');
 SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.due_date),'[]') INTO actions_data FROM (
  SELECT x.*,a.name area_name,c.name cause_name,COALESCE(NULLIF(concat_ws(' ',to_jsonb(pr)->>'first_name',to_jsonb(pr)->>'last_name'),''),pr.id::text) assigned_name
  FROM public.hhee_actions x JOIN public.hhee_areas a ON a.id=x.area_id JOIN public.hhee_causes c ON c.id=x.cause_id JOIN public.profiles pr ON pr.id=x.assigned_to
  WHERE public.hhee_can(x.area_id) AND (area IS NULL OR x.area_id=area) AND (site IS NULL OR a.site_id=site)
   AND (NULLIF(p->>'cause_id','') IS NULL OR x.cause_id=(p->>'cause_id')::uuid)
   AND (x.due_date BETWEEN d AND u OR x.state<>'VERIFICADA') ORDER BY x.due_date LIMIT 500
 ) t;
 RETURN rows_data||action_counts||jsonb_build_object('success',true,'from',d,'to',u,'generated_at',now(),'actions',actions_data,'row_limit',500,'cost_visible',aggregate_cost);
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
 RETURN jsonb_build_object('success',false,'error','Revise los filtros.');
END $$;

CREATE FUNCTION public.hhee_detail(p_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.hhee_requests; allow_cost boolean;
BEGIN
 SELECT * INTO r FROM public.hhee_requests WHERE id=p_id;
 IF NOT FOUND OR NOT public.hhee_can(r.area_id) THEN RETURN jsonb_build_object('success',false,'error','Solicitud fuera de su alcance.'); END IF;
 allow_cost:=public.hhee_cost_access();
 RETURN jsonb_build_object('success',true,'request',to_jsonb(r)||jsonb_build_object('origin_area_name',(SELECT name FROM public.hhee_areas WHERE id=r.origin_area_id)),'needs_exception',public.hhee_needs_exception(r.id),
  'lines',COALESCE((SELECT jsonb_agg(CASE WHEN allow_cost THEN to_jsonb(l) ELSE to_jsonb(l)-ARRAY['estimated_cost','validated_cost','reported_cost'] END ORDER BY l.person_name) FROM public.hhee_lines l WHERE request_id=r.id),'[]'),
  'audit',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC) FROM
    (SELECT a.id,a.event,a.reason,a.created_at,COALESCE(NULLIF(concat_ws(' ',to_jsonb(pr)->>'first_name',to_jsonb(pr)->>'last_name'),''),a.actor::text) actor_name,CASE WHEN allow_cost THEN a.private_data ELSE NULL END private_data FROM public.hhee_audit a JOIN public.profiles pr ON pr.id=a.actor WHERE a.request_id=r.id ORDER BY a.created_at DESC LIMIT 100) t),'[]'));
END $$;
-- Private helper functions cannot be called to probe records outside the scoped RPCs.
REVOKE ALL ON FUNCTION public.hhee_can(uuid,text),public.hhee_cost_access(),public.hhee_minutes(timestamptz,timestamptz,integer),
 public.hhee_local_time(text),public.hhee_needs_exception(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.hhee_context(),public.hhee_reference_search(uuid,text),public.hhee_mutate(jsonb),
 public.hhee_attendance(jsonb,boolean),public.hhee_read(jsonb),public.hhee_detail(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.hhee_context(),public.hhee_reference_search(uuid,text),public.hhee_mutate(jsonb),
 public.hhee_attendance(jsonb,boolean),public.hhee_read(jsonb),public.hhee_detail(uuid) TO authenticated,service_role;
COMMIT;
