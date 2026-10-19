-- Distribution pilot: explicit area activation + role and membership, including Gerencia.
-- Amounts are management estimates, never payroll settlement. Legacy data stays unclassified.
BEGIN;
ALTER TABLE public.hhee_areas ADD COLUMN module_enabled boolean NOT NULL DEFAULT false;
INSERT INTO public.hhee_areas(site_id,name,module_enabled)
 SELECT id,'Distribución',true FROM public.sites WHERE code='PRINCIPAL'
 ON CONFLICT(site_id,name) DO UPDATE SET module_enabled=true;
ALTER TABLE public.hhee_people
 ADD COLUMN base_hour_cost numeric(14,4) CHECK(base_hour_cost BETWEEN 0 AND 999999),
 ADD COLUMN remuneration_concepts jsonb NOT NULL DEFAULT '[]',
 ADD COLUMN monthly_hours numeric(8,2) NOT NULL DEFAULT 240 CHECK(monthly_hours>0 AND monthly_hours<=744);
CREATE FUNCTION public.hhee_base_rate(p_concepts jsonb,p_hours numeric) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
#variable_conflict use_variable
DECLARE v_item jsonb; v_total numeric:=0; v_any boolean:=false; v_names text[]:='{}'; v_name text; v_amount numeric;
BEGIN
 IF p_hours IS NULL OR p_hours<=0 OR p_hours>744 OR p_hours::text IN('NaN','Infinity','-Infinity')
  OR p_hours<>round(p_hours,2)
  OR jsonb_typeof(p_concepts) IS DISTINCT FROM 'array' OR jsonb_array_length(p_concepts)>20 THEN
  RAISE EXCEPTION 'Revise conceptos remunerativos (máximo 20) y las horas mensuales de referencia.';
 END IF;
 FOR v_item IN SELECT value FROM jsonb_array_elements(p_concepts) LOOP
  v_name:=btrim(v_item->>'name');
  IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' OR jsonb_typeof(v_item->'name') IS DISTINCT FROM 'string'
   OR length(v_name) NOT BETWEEN 2 AND 100 OR lower(v_name)=ANY(v_names)
   OR jsonb_typeof(v_item->'amount') IS DISTINCT FROM 'number' OR jsonb_typeof(v_item->'computable') IS DISTINCT FROM 'boolean' THEN
   RAISE EXCEPTION 'Cada concepto debe tener nombre único, importe mensual y condición computable explícita.';
  END IF;
  v_names:=array_append(v_names,lower(v_name)); v_amount:=(v_item->>'amount')::numeric;
  IF v_amount<0 OR v_amount>9999999 OR v_amount<>round(v_amount,2) THEN RAISE EXCEPTION 'Revise el importe mensual de los conceptos (dos decimales).'; END IF;
  IF (v_item->>'computable')::boolean THEN v_total:=v_total+v_amount; v_any:=true; END IF;
 END LOOP;
 IF NOT v_any THEN RETURN NULL; END IF;
 IF round(v_total/p_hours,4)>999999 THEN RAISE EXCEPTION 'La tarifa base excede el rango permitido.'; END IF;
 RETURN round(v_total/p_hours,4);
END $$;
REVOKE ALL ON FUNCTION public.hhee_base_rate(jsonb,numeric) FROM PUBLIC,anon,authenticated;
ALTER TABLE public.hhee_people ADD CONSTRAINT hhee_people_derived_rate
 CHECK(base_hour_cost IS NOT DISTINCT FROM public.hhee_base_rate(remuneration_concepts,monthly_hours));
-- Do not reinterpret the old integral HHEE tariff as the ordinary base hourly cost.
ALTER TABLE public.hhee_lines
 ADD COLUMN normal_minutes integer CHECK(normal_minutes BETWEEN 0 AND 960),
 ADD COLUMN minutes_25 integer CHECK(minutes_25 BETWEEN 0 AND 960),
 ADD COLUMN minutes_35 integer CHECK(minutes_35 BETWEEN 0 AND 960),
 ADD COLUMN minutes_100 integer CHECK(minutes_100 BETWEEN 0 AND 960),
 ADD COLUMN base_hour_cost numeric(14,4) CHECK(base_hour_cost BETWEEN 0 AND 999999),
 ADD COLUMN rate_basis jsonb,
 ADD COLUMN normal_estimated_cost numeric(16,2) CHECK(normal_estimated_cost>=0),
 ADD COLUMN cost_source text CHECK(cost_source IN('RRHH_APROX','TARIFA_BASE','PENDIENTE')),
 ADD CONSTRAINT hhee_lines_categories CHECK(
  (minutes_25 IS NULL AND minutes_35 IS NULL AND minutes_100 IS NULL) OR
  (minutes_25 IS NOT NULL AND minutes_35 IS NOT NULL AND minutes_100 IS NOT NULL
    AND reported_minutes IS NOT NULL AND minutes_25+minutes_35+minutes_100=reported_minutes));
COMMENT ON COLUMN public.hhee_lines.validated_cost IS 'Approximate HHEE cost associated with HR-validated attendance. Not a final/payroll cost.';
COMMENT ON COLUMN public.hhee_lines.normal_minutes IS 'Ordinary hours for context; excluded from overtime totals. Enter only once per person and operational day.';

CREATE OR REPLACE FUNCTION public.hhee_can(p_area uuid,p_cap text DEFAULT 'read') RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT public.is_active_tms_user() AND EXISTS(
  SELECT 1 FROM public.hhee_areas a WHERE a.id=p_area AND public.can_access_site(a.site_id) AND
   CASE WHEN p_cap='config' THEN public.is_tms_admin() OR public.has_tms_permission('hhee-config')
   ELSE a.module_enabled AND (public.is_tms_admin() OR (
    EXISTS(SELECT 1 FROM public.hhee_memberships m WHERE m.user_id=auth.uid() AND m.area_id=a.id) AND
    CASE p_cap WHEN 'read' THEN public.has_tms_read_permission('hhee') OR public.has_tms_read_permission('hhee-solicitar')
      OR public.has_tms_read_permission('hhee-aprobar') OR public.has_tms_read_permission('hhee-validar')
      OR public.has_tms_read_permission('hhee-costos') OR public.has_tms_read_permission('hhee-gerencia')
      OR public.has_tms_read_permission('hhee-excepciones')
    WHEN 'request' THEN a.active AND public.has_tms_permission('hhee-solicitar')
    WHEN 'approve' THEN public.has_tms_permission('hhee-aprobar')
    WHEN 'validate' THEN public.has_tms_permission('hhee-validar')
    WHEN 'exception' THEN public.has_tms_permission('hhee-excepciones') ELSE false END)) END);
$$;
CREATE OR REPLACE FUNCTION public.hhee_context() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_variable
DECLARE config boolean; any_area boolean;
BEGIN
 SELECT EXISTS(SELECT 1 FROM public.hhee_areas WHERE public.hhee_can(id)) INTO any_area;
 config:=public.is_active_tms_user() AND (public.is_tms_admin() OR public.has_tms_permission('hhee-config'));
 IF NOT any_area AND NOT config THEN RETURN jsonb_build_object('success',false,'error','No tiene acceso a HHEE. Solicite permiso y asignación de área.'); END IF;
 RETURN jsonb_build_object('success',true,'user_id',auth.uid(),'config',config,'individual_costs',public.hhee_cost_access(),
  'executive_costs',public.hhee_cost_access() OR public.has_tms_read_permission('hhee-gerencia'),
  'areas',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'site_id',a.site_id,'site_name',s.name,'active',a.active,'module_enabled',a.module_enabled,
    'can_read',public.hhee_can(a.id),'can_request',public.hhee_can(a.id,'request'),'can_approve',public.hhee_can(a.id,'approve'),
    'can_validate',public.hhee_can(a.id,'validate'),'can_exception',public.hhee_can(a.id,'exception')) ORDER BY s.name,a.name)
    FROM public.hhee_areas a JOIN public.sites s ON s.id=a.site_id WHERE public.hhee_can(a.id) OR public.hhee_can(a.id,'config')), '[]'),
  'causes',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.name) FROM public.hhee_causes c),'[]'),
  'people',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'code',p.code,'name',p.name,'area_id',p.area_id,'active',p.active,
    'base_hour_cost',CASE WHEN public.hhee_cost_access() THEN p.base_hour_cost END,
    'remuneration_concepts',CASE WHEN public.hhee_cost_access() THEN p.remuneration_concepts END,
    'monthly_hours',CASE WHEN public.hhee_cost_access() THEN p.monthly_hours END,
    'estimated_hour_cost',NULL,'profile_id',p.profile_id) ORDER BY p.name)
    FROM public.hhee_people p JOIN public.hhee_areas pa ON pa.id=p.area_id WHERE public.hhee_can(p.area_id) OR (pa.module_enabled AND public.hhee_can(p.area_id,'config'))), '[]'),
  'settings',(SELECT to_jsonb(t) - CASE WHEN config OR public.has_tms_read_permission('hhee-gerencia') THEN ARRAY[]::text[] ELSE ARRAY['report_to','report_cc'] END FROM public.hhee_settings t WHERE id=1),
  'sites',CASE WHEN config THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name) FROM public.sites WHERE public.can_access_site(id) AND is_active),'[]') ELSE '[]'::jsonb END,
  'users',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',COALESCE(NULLIF(concat_ws(' ',to_jsonb(p)->>'first_name',to_jsonb(p)->>'last_name'),''),p.id::text))) FROM public.profiles p WHERE p.is_active AND (config OR EXISTS(SELECT 1 FROM public.hhee_memberships m WHERE m.user_id=p.id AND (public.hhee_can(m.area_id,'approve') OR public.hhee_can(m.area_id,'validate'))))),'[]'),
  'memberships',CASE WHEN config THEN COALESCE((SELECT jsonb_agg(to_jsonb(m)) FROM public.hhee_memberships m WHERE public.hhee_can(m.area_id,'config')),'[]') ELSE '[]'::jsonb END);
END $$;

CREATE OR REPLACE FUNCTION public.hhee_mutate(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_variable
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
   INSERT INTO public.hhee_areas(id,site_id,name,active,module_enabled) VALUES(COALESCE(area,gen_random_uuid()),(p->>'site_id')::uuid,btrim(p->>'name'),COALESCE((p->>'active')::boolean,true),COALESCE((p->>'module_enabled')::boolean,false))
   ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,active=EXCLUDED.active,module_enabled=CASE WHEN p ? 'module_enabled' THEN EXCLUDED.module_enabled ELSE public.hhee_areas.module_enabled END RETURNING id INTO area;
  ELSIF cmd IN('person','people_import') THEN
   IF cmd='people_import' AND (jsonb_typeof(p->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'rows') NOT BETWEEN 1 AND 300) THEN RAISE EXCEPTION 'Importe entre 1 y 300 trabajadores por archivo.'; END IF;
   FOR item IN SELECT value FROM jsonb_array_elements(CASE WHEN cmd='person' THEN jsonb_build_array(p) ELSE p->'rows' END) LOOP
    area:=(item->>'area_id')::uuid;
    IF NOT public.hhee_can(area,'config') THEN RAISE EXCEPTION 'Área fuera de su alcance.'; END IF;
    v_code:=upper(btrim(item->>'code'));
    SELECT * INTO person FROM public.hhee_people WHERE public.hhee_people.code=v_code FOR UPDATE;
    IF FOUND AND NOT public.hhee_can(person.area_id,'config') THEN RAISE EXCEPTION 'Código de trabajador fuera de su alcance.'; END IF;
    IF person.id IS NOT NULL THEN
     INSERT INTO public.hhee_audit(actor,event,reason,private_data) VALUES(auth.uid(),'FICHA REMUNERATIVA PREVIA','Actualización de trabajador HHEE',jsonb_build_object('person',to_jsonb(person)));
    END IF;
    INSERT INTO public.hhee_people(code,name,area_id,active,base_hour_cost,profile_id,remuneration_concepts,monthly_hours)
    VALUES(v_code,btrim(item->>'name'),area,COALESCE((item->>'active')::boolean,true),public.hhee_base_rate(COALESCE(item->'remuneration_concepts',person.remuneration_concepts,'[]'::jsonb),COALESCE(NULLIF(item->>'monthly_hours','')::numeric,person.monthly_hours,240)),CASE WHEN item ? 'profile_id' THEN NULLIF(item->>'profile_id','')::uuid ELSE person.profile_id END,
     COALESCE(item->'remuneration_concepts',person.remuneration_concepts,'[]'::jsonb),COALESCE(NULLIF(item->>'monthly_hours','')::numeric,person.monthly_hours,240))
    ON CONFLICT ON CONSTRAINT hhee_people_code_key DO UPDATE SET name=EXCLUDED.name,area_id=EXCLUDED.area_id,active=EXCLUDED.active,
      base_hour_cost=EXCLUDED.base_hour_cost,profile_id=EXCLUDED.profile_id,remuneration_concepts=EXCLUDED.remuneration_concepts,monthly_hours=EXCLUDED.monthly_hours;
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
  prior:=jsonb_build_object('request',to_jsonb(r),'lines',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM public.hhee_lines x WHERE x.request_id=rid),'[]'));
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
   VALUES(rid,person.id,person.name,person.code,start_at,end_at,COALESCE((item->>'planned_break')::int,0),n,NULL);
  END LOOP;
  INSERT INTO public.hhee_audit(request_id,actor,event,reason,private_data) VALUES(rid,auth.uid(),'BORRADOR GUARDADO','Solicitud y personal previstos',prior);
 ELSE
  IF cmd IN('action_save','action_update') THEN
   aid:=NULLIF(p->>'id','')::uuid;
   IF cmd='action_save' THEN
    area:=(p->>'area_id')::uuid;
    IF NOT public.hhee_can(area) OR NOT (public.hhee_can(area,'approve') OR public.hhee_can(area,'validate') OR public.hhee_can(area,'config')) THEN RAISE EXCEPTION 'No tiene permiso para definir acciones del área.'; END IF;
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
   prior:=jsonb_build_object('request',to_jsonb(r),'lines',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM public.hhee_lines x WHERE x.request_id=rid),'[]'));
   IF cmd='submit' THEN
    IF r.created_by<>auth.uid() OR NOT public.hhee_can(r.area_id,'request') OR r.state<>'BORRADOR' THEN RAISE EXCEPTION 'Solo el solicitante puede presentar su borrador.'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.hhee_lines WHERE request_id=rid) THEN RAISE EXCEPTION 'La solicitud no tiene personal.'; END IF;
    -- Cost remains pending until HR provides the category breakdown and rate or its own estimate.
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

CREATE OR REPLACE FUNCTION public.hhee_attendance(p jsonb,p_apply boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_variable
DECLARE item jsonb; r public.hhee_requests; l public.hhee_lines; s timestamptz; e timestamptz; mins int; recognized int;
 amount numeric; h text; result_rows jsonb:='[]'; errors jsonb:='[]'; normalized jsonb:='[]'; rec jsonb;
 seen text[]:='{}'; changed uuid[]:='{}'; key text; row_no int:=1; err text; op uuid; cached jsonb; oldhash text;
 v_normal int; v_25 int; v_35 int; v_100 int; v_base numeric; v_source text; v_normal_cost numeric; v_basis jsonb;
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
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(cached->'rows') x LEFT JOIN public.hhee_requests q
     ON q.sequence=substring(x->>'request_code' FROM '^HE-([0-9]+)$')::bigint
     WHERE q.id IS NULL OR NOT public.hhee_can(q.area_id,'validate')) THEN RAISE EXCEPTION 'El acceso RR. HH. a la importación fue revocado.'; END IF;
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
   v_normal:=NULLIF(item->>'normal_minutes','')::int;
   v_25:=NULLIF(item->>'minutes_25','')::int;
   v_35:=NULLIF(item->>'minutes_35','')::int;
   v_100:=NULLIF(item->>'minutes_100','')::int;
   IF v_normal NOT BETWEEN 0 AND 960 THEN RAISE EXCEPTION 'Horas normales fuera del rango permitido.'; END IF;
   IF num_nonnulls(v_25,v_35,v_100) NOT IN(0,3) OR
     (v_25 IS NOT NULL AND (v_25 NOT BETWEEN 0 AND 960 OR v_35 NOT BETWEEN 0 AND 960 OR v_100 NOT BETWEEN 0 AND 960
       OR v_25+v_35+v_100<>recognized)) THEN
    RAISE EXCEPTION 'Complete las tres categorías: 25%% + 35%% + 100%% debe sumar las HHEE reconocidas.';
   END IF;
   -- Ordinary hours are context, not overtime. Avoid counting the same working day twice.
   IF v_normal>0 AND (EXISTS(SELECT 1 FROM public.hhee_lines x JOIN public.hhee_requests q ON q.id=x.request_id
      WHERE x.person_id=l.person_id AND x.id<>l.id AND q.work_date=r.work_date AND x.normal_minutes>0)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(normalized) x WHERE x->>'person_id'=l.person_id::text
      AND (x->>'work_date')::date=r.work_date AND (x->>'normal_minutes')::int>0)) THEN
    RAISE EXCEPTION 'Las horas normales del trabajador ya se registraron en otra solicitud de esta fecha; no las duplique.';
   END IF;
   -- Keep the historical tariff snapshot on reimport unless HR explicitly supplies another one.
   SELECT CASE WHEN l.rate_basis IS NOT NULL AND NOT COALESCE((p->>'refresh_rates')::boolean,false) THEN l.base_hour_cost ELSE x.base_hour_cost END,
    CASE WHEN l.rate_basis IS NOT NULL AND NOT COALESCE((p->>'refresh_rates')::boolean,false) THEN l.rate_basis ELSE jsonb_build_object('concepts',x.remuneration_concepts,'monthly_hours',x.monthly_hours) END
     INTO v_base,v_basis FROM public.hhee_people x WHERE x.id=l.person_id;
   IF v_base<0 OR v_base>999999 OR v_base::text IN('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Tarifa base fuera del rango permitido.'; END IF;
   IF NULLIF(item->>'base_hour_cost','') IS NOT NULL THEN RAISE EXCEPTION 'La tarifa se calcula desde la ficha remunerativa del trabajador, no desde el archivo de asistencia.'; END IF;
   IF v_25 IS NOT NULL AND amount IS NOT NULL THEN RAISE EXCEPTION 'Para horas desglosadas, el costo se calcula desde la ficha del trabajador. Quite el costo manual.'; END IF;
   v_source:='PENDIENTE';
   IF amount IS NOT NULL THEN v_source:='RRHH_APROX';
   ELSIF v_base IS NOT NULL AND v_25 IS NOT NULL THEN
    amount:=round(v_base*(v_25*1.25+v_35*1.35+v_100*2)/60,2); v_source:='TARIFA_BASE';
   END IF;
   v_normal_cost:=CASE WHEN v_normal IS NOT NULL AND v_base IS NOT NULL THEN round(v_normal/60.0*v_base,2) END;
   IF amount>99999999 OR amount::text IN('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Costo aproximado fuera del rango permitido.'; END IF;
   IF mins>0 AND (EXISTS(SELECT 1 FROM public.hhee_lines x WHERE x.person_id=l.person_id AND x.id<>l.id AND x.actual_minutes>0 AND x.actual_start<e AND x.actual_end>s)
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(normalized) x WHERE x->>'person_id'=l.person_id::text AND (x->>'start')::timestamptz<e AND (x->>'end')::timestamptz>s AND (x->>'minutes')::int>0))
   THEN RAISE EXCEPTION 'Intervalo trabajado superpuesto con otro registro del trabajador.'; END IF;
   h:=md5(jsonb_build_array(s,e,COALESCE((item->>'break_minutes')::int,0),recognized,amount,COALESCE((item->>'consent')::boolean,false),item->>'result',item->>'evidence',v_normal,v_25,v_35,v_100,v_base,v_source,v_basis)::text);
   IF l.attendance_hash IS DISTINCT FROM h THEN
    IF r.state='VALIDADA' THEN RAISE EXCEPTION 'Registro validado: RR. HH. debe reabrirlo antes de corregirlo.'; END IF;
    IF l.actual_minutes IS NOT NULL AND length(btrim(COALESCE(p->>'correction_reason','')))<15 THEN RAISE EXCEPTION 'La modificación de asistencia requiere un motivo de al menos 15 caracteres.'; END IF;
   END IF;
   rec:=jsonb_build_object('line_id',l.id,'request_id',r.id,'person_id',l.person_id,'start',s,'end',e,'minutes',mins,'recognized',recognized,'cost',amount,'normal_minutes',v_normal,'minutes_25',v_25,'minutes_35',v_35,'minutes_100',v_100,
    'base_hour_cost',v_base,'rate_basis',v_basis,'cost_source',v_source,'normal_cost',v_normal_cost,'work_date',r.work_date,'hash',h,'changed',l.attendance_hash IS DISTINCT FROM h,'row',row_no,'data',item);
   normalized:=normalized||jsonb_build_array(rec);
   result_rows:=result_rows||jsonb_build_array(jsonb_build_object('row',row_no,'request_code',item->>'request_code','person_code',l.person_code,'person_name',l.person_name,
    'version',r.version,'planned',l.planned_minutes,'approved',l.approved_minutes,'actual',mins,'recognized',recognized,'cost',amount,'normal_minutes',v_normal,'minutes_25',v_25,'minutes_35',v_35,'minutes_100',v_100,'cost_source',v_source,'normal_cost',v_normal_cost,'base_hour_cost',v_base,'duplicate',l.attendance_hash=h,
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
   normal_minutes=(rec->>'normal_minutes')::int,minutes_25=(rec->>'minutes_25')::int,minutes_35=(rec->>'minutes_35')::int,minutes_100=(rec->>'minutes_100')::int,
   base_hour_cost=(rec->>'base_hour_cost')::numeric,rate_basis=rec->'rate_basis',normal_estimated_cost=(rec->>'normal_cost')::numeric,cost_source=rec->>'cost_source',
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

CREATE OR REPLACE FUNCTION public.hhee_read(p jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_variable
DECLARE d date:=COALESCE(NULLIF(p->>'from','')::date,date_trunc('month',now() AT TIME ZONE 'America/Lima')::date);
 u date:=COALESCE(NULLIF(p->>'to','')::date,(now() AT TIME ZONE 'America/Lima')::date);
 area uuid:=NULLIF(p->>'area_id','')::uuid; site uuid:=NULLIF(p->>'site_id','')::uuid;
 cost_access boolean; aggregate_cost boolean; rows_data jsonb; actions_data jsonb; action_counts jsonb; allowed uuid[]; rec_days int; rec_events int;
BEGIN
 IF NOT public.is_active_tms_user() OR NOT EXISTS(SELECT 1 FROM public.hhee_areas WHERE public.hhee_can(id)) THEN
  RETURN jsonb_build_object('success',false,'error','Sin acceso a HHEE.'); END IF;
 IF u<d OR u-d>366 THEN RETURN jsonb_build_object('success',false,'error','Seleccione hasta 366 días.'); END IF;
 cost_access:=public.hhee_cost_access(); aggregate_cost:=cost_access OR public.has_tms_read_permission('hhee-gerencia');
 SELECT COALESCE(array_agg(id),'{}'::uuid[]) INTO allowed FROM public.hhee_areas a
 WHERE public.hhee_can(a.id) AND (area IS NULL OR a.id=area) AND (site IS NULL OR a.site_id=site);
 SELECT recurrence_days,recurrence_events INTO rec_days,rec_events FROM public.hhee_settings WHERE id=1;
 -- Aggregate actual events once per day, then compute rolling recurrence once per area/cause/day.
 -- Counts include earlier days outside the displayed period, regardless of request-state/search filters.
 WITH daily AS MATERIALIZED(
  SELECT x.area_id,COALESCE(x.confirmed_cause_id,x.cause_id) cause_id,x.work_date,count(*) event_count
  FROM public.hhee_requests x WHERE x.area_id=ANY(allowed) AND x.work_date BETWEEN d-rec_days+1 AND u
   AND x.state IN('EJECUTADA','VALIDADA')
   AND (NULLIF(p->>'cause_id','') IS NULL OR COALESCE(x.confirmed_cause_id,x.cause_id)=(p->>'cause_id')::uuid)
   AND EXISTS(SELECT 1 FROM public.hhee_lines xl WHERE xl.request_id=x.id AND xl.actual_minutes>0)
  GROUP BY x.area_id,COALESCE(x.confirmed_cause_id,x.cause_id),x.work_date
 ), rolling AS MATERIALIZED(
  SELECT area_id,cause_id,work_date,sum(event_count) OVER(PARTITION BY area_id,cause_id ORDER BY work_date::timestamp
   RANGE BETWEEN ((rec_days-1)*interval '1 day') PRECEDING AND CURRENT ROW) event_count FROM daily
 ), base AS (
  SELECT r.*,a.name area_name,a.site_id,s.name site_name,c.name cause_name,o.name origin_area_name,
    public.hhee_needs_exception(r.id) needs_exception,
    COALESCE(z.event_count>=rec_events,false) recurrent
  FROM public.hhee_requests r JOIN public.hhee_areas a ON a.id=r.area_id JOIN public.sites s ON s.id=a.site_id
  JOIN public.hhee_causes c ON c.id=COALESCE(r.confirmed_cause_id,r.cause_id) LEFT JOIN public.hhee_areas o ON o.id=r.origin_area_id
  LEFT JOIN rolling z ON z.area_id=r.area_id AND z.cause_id=COALESCE(r.confirmed_cause_id,r.cause_id) AND z.work_date=r.work_date
  WHERE r.area_id=ANY(allowed) AND r.work_date BETWEEN d AND u
    AND (area IS NULL OR r.area_id=area) AND (site IS NULL OR a.site_id=site)
    AND (NULLIF(p->>'cause_id','') IS NULL OR COALESCE(r.confirmed_cause_id,r.cause_id)=(p->>'cause_id')::uuid)
    AND (NULLIF(p->>'state','') IS NULL OR r.state=p->>'state')
    AND (NULLIF(btrim(p->>'search'),'') IS NULL OR (r.activity||' '||COALESCE(r.reference_code,'')||' HE-'||lpad(r.sequence::text,6,'0')) ILIKE '%'||left(btrim(p->>'search'),100)||'%')
 ), enriched AS (
 SELECT b.*,COALESCE(l.planned,0) planned_minutes,COALESCE(l.approved,0) approved_minutes,COALESCE(l.actual,0) actual_minutes,
  l.validated validated_minutes,l.normal_minutes,l.minutes_25,l.minutes_35,l.minutes_100,l.unclassified_minutes,
  CASE WHEN aggregate_cost THEN l.normal_cost END normal_estimated_cost,CASE WHEN aggregate_cost THEN l.cost END validated_cost,
  CASE WHEN aggregate_cost THEN l.estimated END estimated_cost,l.pending_cost,l.workers,
  b.approval='APROBADA' AND b.approved_at<=l.first_actual AND NOT EXISTS(SELECT 1 FROM public.hhee_lines z WHERE z.request_id=b.id AND z.actual_minutes>COALESCE(z.approved_minutes,0)) prior_approval
 FROM base b LEFT JOIN LATERAL(SELECT sum(planned_minutes) planned,sum(approved_minutes) approved,sum(actual_minutes) actual,
   sum(normal_minutes) normal_minutes,sum(minutes_25) minutes_25,sum(minutes_35) minutes_35,sum(minutes_100) minutes_100,
   COALESCE(sum(validated_minutes) FILTER(WHERE minutes_25 IS NULL),0) unclassified_minutes,sum(normal_estimated_cost) normal_cost,
   sum(validated_minutes) validated,sum(validated_cost) cost,sum(estimated_cost) estimated,count(*) FILTER(WHERE validated_minutes IS NOT NULL AND validated_cost IS NULL) pending_cost,
   count(*) workers,min(actual_start) FILTER(WHERE actual_minutes>0) first_actual FROM public.hhee_lines WHERE request_id=b.id) l ON true
 ), metrics AS (
 SELECT COALESCE(sum(normal_minutes) FILTER(WHERE state='VALIDADA'),0) normal_minutes,
  COALESCE(sum(minutes_25) FILTER(WHERE state='VALIDADA'),0) minutes_25,COALESCE(sum(minutes_35) FILTER(WHERE state='VALIDADA'),0) minutes_35,
  COALESCE(sum(minutes_100) FILTER(WHERE state='VALIDADA'),0) minutes_100,COALESCE(sum(unclassified_minutes) FILTER(WHERE state='VALIDADA'),0) unclassified_minutes,
  CASE WHEN aggregate_cost THEN sum(normal_estimated_cost) FILTER(WHERE state='VALIDADA') END normal_estimated_cost,
  count(*) total_requests,COALESCE(sum(validated_minutes) FILTER(WHERE state='VALIDADA'),0) validated_minutes,
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
 INTO action_counts FROM public.hhee_actions x JOIN public.hhee_areas a ON a.id=x.area_id WHERE x.area_id=ANY(allowed)
 AND (area IS NULL OR x.area_id=area) AND (site IS NULL OR a.site_id=site)
 AND (NULLIF(p->>'cause_id','') IS NULL OR x.cause_id=(p->>'cause_id')::uuid)
 AND (x.due_date BETWEEN d AND u OR x.state<>'VERIFICADA');
 SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.due_date),'[]') INTO actions_data FROM (
  SELECT x.*,a.name area_name,c.name cause_name,COALESCE(NULLIF(concat_ws(' ',to_jsonb(pr)->>'first_name',to_jsonb(pr)->>'last_name'),''),pr.id::text) assigned_name
  FROM public.hhee_actions x JOIN public.hhee_areas a ON a.id=x.area_id JOIN public.hhee_causes c ON c.id=x.cause_id JOIN public.profiles pr ON pr.id=x.assigned_to
  WHERE x.area_id=ANY(allowed) AND (area IS NULL OR x.area_id=area) AND (site IS NULL OR a.site_id=site)
   AND (NULLIF(p->>'cause_id','') IS NULL OR x.cause_id=(p->>'cause_id')::uuid)
   AND (x.due_date BETWEEN d AND u OR x.state<>'VERIFICADA') ORDER BY x.due_date LIMIT 500
 ) t;
 RETURN rows_data||action_counts||jsonb_build_object('success',true,'from',d,'to',u,'generated_at',now(),'actions',actions_data,'row_limit',500,'cost_visible',aggregate_cost);
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
 RETURN jsonb_build_object('success',false,'error','Revise los filtros.');
END $$;

CREATE OR REPLACE FUNCTION public.hhee_detail(p_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_variable
DECLARE r public.hhee_requests; allow_cost boolean;
BEGIN
 SELECT * INTO r FROM public.hhee_requests WHERE id=p_id;
 IF NOT FOUND OR NOT public.hhee_can(r.area_id) THEN RETURN jsonb_build_object('success',false,'error','Solicitud fuera de su alcance.'); END IF;
 allow_cost:=public.hhee_cost_access();
 RETURN jsonb_build_object('success',true,'request',to_jsonb(r)||jsonb_build_object('origin_area_name',(SELECT name FROM public.hhee_areas WHERE id=r.origin_area_id)),'needs_exception',public.hhee_needs_exception(r.id),
  'lines',COALESCE((SELECT jsonb_agg(CASE WHEN allow_cost THEN to_jsonb(l) ELSE to_jsonb(l)-ARRAY['estimated_cost','validated_cost','reported_cost','base_hour_cost','rate_basis','normal_estimated_cost','cost_source'] END ORDER BY l.person_name) FROM public.hhee_lines l WHERE request_id=r.id),'[]'),
  'audit',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC) FROM
    (SELECT a.id,a.event,a.reason,a.created_at,COALESCE(NULLIF(concat_ws(' ',to_jsonb(pr)->>'first_name',to_jsonb(pr)->>'last_name'),''),a.actor::text) actor_name,CASE WHEN allow_cost THEN a.private_data ELSE NULL END private_data FROM public.hhee_audit a JOIN public.profiles pr ON pr.id=a.actor WHERE a.request_id=r.id ORDER BY a.created_at DESC LIMIT 100) t),'[]'));
END $$;
-- Preserve private RPC-only access; replacements retain their previous ACLs.
REVOKE ALL ON FUNCTION public.hhee_can(uuid,text) FROM PUBLIC,anon,authenticated;
COMMIT;
