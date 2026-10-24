-- Turnos operativos: conserva una línea por persona y una fotografía de su jornada ordinaria.
BEGIN;
ALTER TABLE public.hhee_lines ADD COLUMN gp_plan jsonb, ADD COLUMN gp_actual_parts jsonb, ADD COLUMN gp_actual_meal jsonb;

CREATE FUNCTION public.gp_plan_measure(p jsonb,s timestamptz,e timestamptz,bs timestamptz DEFAULT NULL,be timestamptz DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE normal tstzmultirange:='{}'; extra tstzmultirange; meal tstzmultirange:='{}'; x jsonb; d date; sh jsonb;
 a timestamptz; b timestamptz; part tstzrange; piece tstzrange; parts jsonb:='[]'; mins int; worked int; rest boolean;
BEGIN
 IF s IS NULL OR e IS NULL OR e<=s OR e-s>interval '16 hours' OR date_trunc('minute',s)<>s OR date_trunc('minute',e)<>e THEN RAISE EXCEPTION 'Turno inválido: inicio/fin por minuto, máximo 16 horas'; END IF;
 IF (bs IS NULL)<>(be IS NULL) OR (bs IS NOT NULL AND (be<=bs OR date_trunc('minute',bs)<>bs OR date_trunc('minute',be)<>be)) THEN RAISE EXCEPTION 'Refrigerio inválido'; END IF;
 -- Para el cierre se recorta el refrigerio planificado al intervalo realmente ejecutado.
 IF bs IS NOT NULL AND least(be,e)>greatest(bs,s) THEN meal:=tstzmultirange(tstzrange(greatest(bs,s),least(be,e),'[)')); END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(p->'shifts') LOOP
  d:=(x->>'date')::date; sh:=x->'shift';
  IF sh->>'kind'='TRABAJO' AND public.hhee_pe_holiday(d) IS NULL THEN
   a:=(d+(sh->>'start')::time) AT TIME ZONE 'America/Lima';
   b:=((d+CASE WHEN COALESCE((sh->>'next_day')::boolean,false) THEN 1 ELSE 0 END)+(sh->>'end')::time) AT TIME ZONE 'America/Lima';
   normal:=normal+tstzmultirange(tstzrange(a,b,'[)'));
  END IF;
 END LOOP;
 extra:=tstzmultirange(tstzrange(s,e,'[)'))-normal-meal;
 FOR part IN SELECT unnest(extra) LOOP
  FOR d IN SELECT generate_series((lower(part) AT TIME ZONE 'America/Lima')::date,(upper(part) AT TIME ZONE 'America/Lima')::date,interval '1 day')::date LOOP
   piece:=part*tstzrange(d::timestamp AT TIME ZONE 'America/Lima',(d+1)::timestamp AT TIME ZONE 'America/Lima','[)');
   IF isempty(piece) THEN CONTINUE; END IF;
   SELECT value->'shift' INTO sh FROM jsonb_array_elements(p->'shifts') WHERE (value->>'date')::date=d;
   IF sh IS NULL OR sh->>'kind'='SIN_HORARIO' THEN RAISE EXCEPTION 'Falta jornada base para %',d; END IF;
   rest:=extract(isodow FROM d)=7 OR sh->>'kind'='DESCANSO' OR public.hhee_pe_holiday(d) IS NOT NULL;
   mins:=(extract(epoch FROM upper(piece)-lower(piece))/60)::int;
   parts:=parts||jsonb_build_array(jsonb_build_object('start',lower(piece),'end',upper(piece),'date',d,'minutes',mins,'rest',rest));
  END LOOP;
 END LOOP;
 SELECT COALESCE(sum((value->>'minutes')::int),0) INTO mins FROM jsonb_array_elements(parts);
 SELECT COALESCE(sum(extract(epoch FROM upper(z)-lower(z))/60),0)::int INTO worked FROM unnest(tstzmultirange(tstzrange(s,e,'[)'))-meal) z;
 RETURN jsonb_build_object('parts',parts,'minutes',mins,'worked_minutes',worked,'ordinary_minutes',worked-mins);
END $$;

CREATE FUNCTION public.gp_plan_build(person uuid,l jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s timestamptz:=(l->>'start')::timestamp AT TIME ZONE 'America/Lima'; e timestamptz:=(l->>'end')::timestamp AT TIME ZONE 'America/Lima';
 bs timestamptz:=NULLIF(l->>'meal_start','')::timestamp AT TIME ZONE 'America/Lima'; be timestamptz:=NULLIF(l->>'meal_end','')::timestamp AT TIME ZONE 'America/Lima';
 p jsonb; shifts jsonb; d date; sh jsonb; pending boolean:=COALESCE((l->>'meal_pending')::boolean,false);
BEGIN
 IF e<=s OR e-s>interval '16 hours' THEN RAISE EXCEPTION 'Turno de máximo 16 horas'; END IF;
 IF (bs IS NULL)<>(be IS NULL) OR (bs IS NOT NULL AND (bs<s OR be>e OR be<=bs)) THEN RAISE EXCEPTION 'Ubique el refrigerio dentro del turno'; END IF;
 IF NOT pending AND bs IS NULL AND length(btrim(COALESCE(l->>'no_meal_reason','')))<5 THEN RAISE EXCEPTION 'Indique el refrigerio o el motivo de no tenerlo en este tramo'; END IF;
 IF NOT pending AND COALESCE((l->>'meal_required')::boolean,true) AND (bs IS NULL OR be-bs<>interval '60 minutes') THEN RAISE EXCEPTION 'El turno completo requiere ubicar los 60 minutos de refrigerio'; END IF;
 FOR d IN SELECT generate_series((s AT TIME ZONE 'America/Lima')::date-1,(e AT TIME ZONE 'America/Lima')::date+1,interval '1 day')::date LOOP
  sh:=public.gp_shift(person,d); shifts:=COALESCE(shifts,'[]')||jsonb_build_array(jsonb_build_object('date',d,'shift',sh));
 END LOOP;
 p:=jsonb_build_object('start',s,'end',e,'meal_start',bs,'meal_end',be,'no_meal_reason',l->>'no_meal_reason','meal_pending',pending,'meal_required',COALESCE((l->>'meal_required')::boolean,true),'shifts',shifts);
 RETURN p||public.gp_plan_measure(p,s,e,bs,be);
END $$;

CREATE FUNCTION public.gp_parts_split(person uuid,parts jsonb,req uuid,actual boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE x record; prior int; v25 int:=0; v35 int:=0; v100 int:=0; first_minutes int; seq bigint;
BEGIN
 SELECT sequence INTO seq FROM public.hhee_requests WHERE id=req;
 FOR x IN SELECT (value->>'date')::date AS d,COALESCE(sum((value->>'minutes')::int) FILTER(WHERE NOT (value->>'rest')::boolean),0)::int AS ordinary,
   COALESCE(sum((value->>'minutes')::int) FILTER(WHERE (value->>'rest')::boolean),0)::int AS rested FROM jsonb_array_elements(parts) GROUP BY 1 ORDER BY 1 LOOP
  SELECT COALESCE(sum(CASE WHEN l.gp_plan IS NOT NULL THEN (SELECT COALESCE(sum((z->>'minutes')::int) FILTER(WHERE NOT (z->>'rest')::boolean),0) FROM jsonb_array_elements(CASE WHEN actual THEN COALESCE(l.gp_actual_parts,l.gp_plan->'parts') ELSE l.gp_plan->'parts' END) z WHERE (z->>'date')::date=x.d)
    WHEN r.work_date=x.d THEN greatest(COALESCE(CASE WHEN actual THEN l.actual_minutes END,l.planned_minutes,0)-COALESCE(CASE WHEN actual THEN l.exec_minutes_100 END,l.plan_minutes_100,0),0) ELSE 0 END),0)::int INTO prior
  FROM public.hhee_lines l JOIN public.hhee_requests r ON r.id=l.request_id WHERE l.person_id=person AND r.id IS DISTINCT FROM req AND r.state<>'CANCELADA' AND r.approval<>'RECHAZADA' AND (seq IS NULL OR r.sequence<seq);
  first_minutes:=least(x.ordinary,greatest(120-prior,0)); v25:=v25+first_minutes; v35:=v35+x.ordinary-first_minutes;v100:=v100+x.rested;
 END LOOP;
 RETURN jsonb_build_object('m25',v25,'m35',v35,'m100',v100);
END $$;

-- Intercepta las RPC existentes; conserva permisos, placas, revisiones y reaprobación.
ALTER FUNCTION public.hhee_flow_preview(jsonb) RENAME TO hhee_flow_preview_before_shifts;
ALTER FUNCTION public.hhee_flow_request_save(jsonb) RENAME TO hhee_flow_request_save_before_shifts;
REVOKE ALL ON FUNCTION public.hhee_flow_preview_before_shifts(jsonb),public.hhee_flow_request_save_before_shifts(jsonb) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.hhee_flow_preview(p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE transformed jsonb:='[]'; plans jsonb:='{}'; l jsonb; plan jsonb; result jsonb; out jsonb:='[]'; split jsonb; person uuid;
BEGIN
 FOR l IN SELECT value FROM jsonb_array_elements(p->'lines') LOOP
  IF COALESCE((l->>'work_plan')::boolean,false) THEN
   person:=(l->>'person_id')::uuid;
   IF NOT EXISTS(SELECT 1 FROM public.hhee_people WHERE id=person AND active AND (public.hhee_can(area_id,'request') OR public.gp_approve(area_id))) THEN RAISE EXCEPTION 'Trabajador no autorizado'; END IF;
   plan:=public.gp_plan_build(person,l); IF (plan->>'minutes')::int<1 THEN RAISE EXCEPTION 'El turno no contiene HHEE fuera de la jornada'; END IF;
   plans:=plans||jsonb_build_object(person::text,plan);
   l:=l||jsonb_build_object('break_minutes',(extract(epoch FROM (l->>'end')::timestamp-(l->>'start')::timestamp)/60)::int-(plan->>'minutes')::int);
  END IF;
  IF NOT COALESCE((l->>'work_plan')::boolean,false) AND EXISTS(SELECT 1 FROM public.hhee_people WHERE id=(l->>'person_id')::uuid AND (public.hhee_can(area_id,'request') OR public.gp_approve(area_id))) AND public.gp_shift((l->>'person_id')::uuid,((l->>'start')::timestamp)::date)->>'kind'='TRABAJO' THEN
   plan:=public.gp_plan_build((l->>'person_id')::uuid,l||jsonb_build_object('meal_pending',true));
   IF (plan->>'ordinary_minutes')::int>0 THEN RAISE EXCEPTION 'El intervalo incluye jornada ordinaria: active el cálculo por tramos'; END IF;
  END IF;
  transformed:=transformed||jsonb_build_array(l);
 END LOOP;
 result:=public.hhee_flow_preview_before_shifts(p||jsonb_build_object('lines',transformed));
 FOR l IN SELECT value FROM jsonb_array_elements(result->'lines') LOOP
  plan:=plans->(l->>'person_id');
  IF plan IS NOT NULL AND NOT l ? 'error' THEN split:=public.gp_parts_split((l->>'person_id')::uuid,plan->'parts',NULLIF(p->>'id','')::uuid); l:=l||split||jsonb_build_object('work_plan',plan); END IF;
  out:=out||jsonb_build_array(l);
 END LOOP;
 RETURN result||jsonb_build_object('lines',out);
END $$;

CREATE FUNCTION public.hhee_flow_request_save(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE transformed jsonb:='[]'; plans jsonb:='{}'; l jsonb; plan jsonb; result jsonb; line public.hhee_lines; person uuid; split jsonb; closed jsonb:='[]'; oldline jsonb;
BEGIN
 IF NULLIF(p->>'id','') IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.hhee_requests WHERE id=(p->>'id')::uuid AND public.hhee_can(area_id,'request') AND (created_by=auth.uid() OR public.is_tms_admin())) THEN RAISE EXCEPTION 'Sin permiso para modificar la solicitud'; END IF;
  PERFORM 1 FROM public.hhee_requests WHERE id=(p->>'id')::uuid FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.hhee_lines WHERE request_id=(p->>'id')::uuid AND gp_validated_at IS NOT NULL) THEN RAISE EXCEPTION 'La ejecución ya está validada'; END IF;
  IF EXISTS(SELECT 1 FROM public.hhee_lines l JOIN public.hhee_requests r ON r.id=l.request_id WHERE r.id=(p->>'id')::uuid AND actual_end IS NOT NULL AND r.approval='APROBADA') THEN RAISE EXCEPTION 'Hay ejecución cerrada: use la corrección por trabajador antes de validar'; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(saved_line)),'[]') INTO closed FROM public.hhee_lines saved_line WHERE request_id=(p->>'id')::uuid AND actual_end IS NOT NULL;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(closed) x WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'lines') z WHERE z->>'person_id'=x->>'person_id')) THEN RAISE EXCEPTION 'No se elimina un colaborador con ejecución registrada'; END IF;
 END IF;
 FOR person IN SELECT (value->>'person_id')::uuid FROM jsonb_array_elements(p->'lines') ORDER BY 1 LOOP
  PERFORM 1 FROM public.hhee_people WHERE id=person FOR UPDATE;
 END LOOP;
 FOR l IN SELECT value FROM jsonb_array_elements(p->'lines') LOOP
  person:=(l->>'person_id')::uuid;
  IF COALESCE((l->>'work_plan')::boolean,false) THEN
   IF NOT EXISTS(SELECT 1 FROM public.hhee_people WHERE id=person AND active AND public.hhee_can(area_id,'request')) THEN RAISE EXCEPTION 'Trabajador no autorizado'; END IF;
   IF COALESCE((l->>'meal_pending')::boolean,false) THEN RAISE EXCEPTION 'Confirme el refrigerio antes de guardar la planificación'; END IF;
   plan:=public.gp_plan_build(person,l); IF (plan->>'minutes')::int<1 THEN RAISE EXCEPTION 'El turno no contiene HHEE fuera de la jornada'; END IF;
   plans:=plans||jsonb_build_object(person::text,plan);
   l:=l||jsonb_build_object('break_minutes',(extract(epoch FROM (l->>'end')::timestamp-(l->>'start')::timestamp)/60)::int-(plan->>'minutes')::int);
  END IF;
  IF NOT COALESCE((l->>'work_plan')::boolean,false) AND EXISTS(SELECT 1 FROM public.hhee_people WHERE id=(l->>'person_id')::uuid AND (public.hhee_can(area_id,'request') OR public.gp_approve(area_id))) AND public.gp_shift((l->>'person_id')::uuid,((l->>'start')::timestamp)::date)->>'kind'='TRABAJO' THEN
   plan:=public.gp_plan_build((l->>'person_id')::uuid,l||jsonb_build_object('meal_pending',true));
   IF (plan->>'ordinary_minutes')::int>0 THEN RAISE EXCEPTION 'El intervalo incluye jornada ordinaria: active el cálculo por tramos'; END IF;
  END IF;
  transformed:=transformed||jsonb_build_array(l);
 END LOOP;
 result:=public.hhee_flow_request_save_before_shifts(p||jsonb_build_object('lines',transformed));
 IF result->>'success' IS DISTINCT FROM 'true' THEN RETURN result; END IF;
 FOR line IN SELECT * FROM public.hhee_lines WHERE request_id=(result->>'id')::uuid ORDER BY person_id LOOP
  plan:=plans->line.person_id::text;
  IF plan IS NOT NULL THEN
   split:=public.gp_parts_split(line.person_id,plan->'parts',line.request_id);
   UPDATE public.hhee_lines SET gp_plan=plan,planned_break=COALESCE((extract(epoch FROM (plan->>'meal_end')::timestamptz-(plan->>'meal_start')::timestamptz)/60)::int,0),
    plan_minutes_25=(split->>'m25')::int,plan_minutes_35=(split->>'m35')::int,plan_minutes_100=(split->>'m100')::int,
    plan_cost=public.hhee_flow_cost(plan_rate,(split->>'m25')::int,(split->>'m35')::int,(split->>'m100')::int),estimated_cost=public.hhee_flow_cost(plan_rate,(split->>'m25')::int,(split->>'m35')::int,(split->>'m100')::int)
   WHERE id=line.id;
  END IF;
 END LOOP;
 FOR oldline IN SELECT value FROM jsonb_array_elements(closed) LOOP
  UPDATE public.hhee_lines SET actual_start=(oldline->>'actual_start')::timestamptz,actual_end=(oldline->>'actual_end')::timestamptz,
   actual_break=(oldline->>'actual_break')::int,actual_minutes=(oldline->>'actual_minutes')::int,gp_actual_meal=NULLIF(oldline->'gp_actual_meal','null'::jsonb),
   closed_by=oldline->>'closed_by',closed_at=(oldline->>'closed_at')::timestamptz,close_reason=oldline->>'close_reason',
   exec_minutes_25=(oldline->>'exec_minutes_25')::int,exec_minutes_35=(oldline->>'exec_minutes_35')::int,exec_minutes_100=(oldline->>'exec_minutes_100')::int,exec_cost=(oldline->>'exec_cost')::numeric
   WHERE request_id=(result->>'id')::uuid AND person_id=(oldline->>'person_id')::uuid;
 END LOOP;
 RETURN result||jsonb_build_object('totals',public.hhee_flow_totals((result->>'id')::uuid));
END $$;

-- Serializa y rechaza solapamientos entre planes, incluso cruzando medianoche.
CREATE FUNCTION public.gp_plan_overlap_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM public.hhee_people WHERE id=NEW.person_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.hhee_lines l JOIN public.hhee_requests r ON r.id=l.request_id
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(l.gp_plan->'parts',jsonb_build_array(jsonb_build_object('start',l.planned_start,'end',l.planned_end)))) a
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(NEW.gp_plan->'parts',jsonb_build_array(jsonb_build_object('start',NEW.planned_start,'end',NEW.planned_end)))) b
  WHERE l.person_id=NEW.person_id AND l.id<>NEW.id AND r.state<>'CANCELADA' AND r.approval<>'RECHAZADA'
   AND (l.gp_plan IS NOT NULL OR NEW.gp_plan IS NOT NULL)
   AND tstzrange((a->>'start')::timestamptz,(a->>'end')::timestamptz,'[)') && tstzrange((b->>'start')::timestamptz,(b->>'end')::timestamptz,'[)'))
 THEN RAISE EXCEPTION 'La planificación se solapa con otra solicitud del colaborador'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gp_plan_overlap BEFORE INSERT OR UPDATE OF planned_start,planned_end,gp_plan ON public.hhee_lines FOR EACH ROW EXECUTE FUNCTION public.gp_plan_overlap_guard();

-- El cierre por conductor, geocerca o supervisor utiliza los mismos tramos congelados.
CREATE FUNCTION public.gp_plan_execution() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE measured jsonb; split jsonb;
BEGIN
 IF NEW.gp_plan IS NOT NULL AND NEW.actual_end IS NOT NULL AND (OLD.actual_end IS DISTINCT FROM NEW.actual_end OR OLD.actual_start IS DISTINCT FROM NEW.actual_start OR OLD.gp_plan IS DISTINCT FROM NEW.gp_plan OR OLD.gp_actual_meal IS DISTINCT FROM NEW.gp_actual_meal) THEN
  PERFORM 1 FROM public.hhee_people WHERE id=NEW.person_id FOR UPDATE;
  measured:=public.gp_plan_measure(NEW.gp_plan,COALESCE(NEW.actual_start,NEW.planned_start),NEW.actual_end,(CASE WHEN NEW.gp_actual_meal IS NOT NULL THEN NEW.gp_actual_meal->>'start' ELSE NEW.gp_plan->>'meal_start' END)::timestamptz,(CASE WHEN NEW.gp_actual_meal IS NOT NULL THEN NEW.gp_actual_meal->>'end' ELSE NEW.gp_plan->>'meal_end' END)::timestamptz);
  IF EXISTS(SELECT 1 FROM public.hhee_lines l JOIN public.hhee_requests r ON r.id=l.request_id
   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(l.gp_actual_parts,jsonb_build_array(jsonb_build_object('start',COALESCE(l.actual_start,l.planned_start),'end',l.actual_end)))) a
   CROSS JOIN LATERAL jsonb_array_elements(measured->'parts') b
   WHERE l.person_id=NEW.person_id AND l.id<>NEW.id AND l.actual_end IS NOT NULL AND r.state<>'CANCELADA' AND r.approval<>'RECHAZADA'
    AND tstzrange((a->>'start')::timestamptz,(a->>'end')::timestamptz,'[)') && tstzrange((b->>'start')::timestamptz,(b->>'end')::timestamptz,'[)'))
  THEN RAISE EXCEPTION 'La ejecución se solapa con otra ejecución del colaborador'; END IF;
  split:=public.gp_parts_split(NEW.person_id,measured->'parts',NEW.request_id,true);
  NEW.actual_break:=(extract(epoch FROM NEW.actual_end-COALESCE(NEW.actual_start,NEW.planned_start))/60)::int-(measured->>'worked_minutes')::int;
  NEW.actual_minutes:=(measured->>'minutes')::int; NEW.gp_actual_parts:=measured->'parts';
  NEW.exec_minutes_25:=(split->>'m25')::int;NEW.exec_minutes_35:=(split->>'m35')::int;NEW.exec_minutes_100:=(split->>'m100')::int;
  NEW.exec_cost:=CASE WHEN NEW.compensation THEN 0 ELSE public.hhee_flow_cost(NEW.plan_rate,NEW.exec_minutes_25,NEW.exec_minutes_35,NEW.exec_minutes_100) END;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gp_execution_parts BEFORE UPDATE ON public.hhee_lines FOR EACH ROW EXECUTE FUNCTION public.gp_plan_execution();

-- Fotografía visible en detalle e informes de aprobación: no se pierde al imprimir/exportar.

ALTER FUNCTION public.hhee_flow_detail(uuid) RENAME TO hhee_flow_detail_before_shifts;
REVOKE ALL ON FUNCTION public.hhee_flow_detail_before_shifts(uuid) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.hhee_flow_detail(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d jsonb; out jsonb:='[]'; l jsonb; plan jsonb; actual jsonb;
BEGIN
 d:=public.hhee_flow_detail_before_shifts(p_id); IF d->>'success' IS DISTINCT FROM 'true' THEN RETURN d; END IF;
 d:=jsonb_set(d,'{request,can_decide}',to_jsonb(COALESCE((d#>>'{request,can_decide}')::boolean,false) AND public.gp_approve((d#>>'{request,area_id}')::uuid)));
 FOR l IN SELECT value FROM jsonb_array_elements(d->'lines') LOOP
  SELECT gp_plan,gp_actual_parts INTO plan,actual FROM public.hhee_lines WHERE id=(l->>'id')::uuid;
  out:=out||jsonb_build_array(l||jsonb_build_object('work_plan',plan,'actual_parts',actual,'actual_start',(SELECT actual_start FROM public.hhee_lines WHERE id=(l->>'id')::uuid),'actual_meal',(SELECT gp_actual_meal FROM public.hhee_lines WHERE id=(l->>'id')::uuid)));
 END LOOP;
 RETURN d||jsonb_build_object('lines',out);
END $$;

ALTER FUNCTION public.hhee_flow_snapshot(uuid) RENAME TO hhee_flow_snapshot_before_shifts;
REVOKE ALL ON FUNCTION public.hhee_flow_snapshot_before_shifts(uuid) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.hhee_flow_snapshot(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d jsonb; l jsonb; out jsonb:='[]'; plan jsonb;
BEGIN
 d:=public.hhee_flow_snapshot_before_shifts(p_id);
 FOR l IN SELECT value FROM jsonb_array_elements(d->'lines') LOOP
  SELECT gp_plan INTO plan FROM public.hhee_lines WHERE request_id=p_id AND person_code=l->>'code';
  out:=out||jsonb_build_array(l||jsonb_build_object('work_plan',plan));
 END LOOP;
 RETURN d||jsonb_build_object('lines',out);
END $$;
REVOKE ALL ON FUNCTION public.hhee_flow_snapshot(uuid) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.gp_plan_close(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.hhee_requests; l public.hhee_lines; s timestamptz:=(p->>'start')::timestamp AT TIME ZONE 'America/Lima'; e timestamptz:=(p->>'end')::timestamp AT TIME ZONE 'America/Lima';
 bs timestamptz:=NULLIF(p->>'meal_start','')::timestamp AT TIME ZONE 'America/Lima';be timestamptz:=NULLIF(p->>'meal_end','')::timestamp AT TIME ZONE 'America/Lima';reason text:=btrim(COALESCE(p->>'reason',''));
BEGIN
 SELECT * INTO l FROM public.hhee_lines WHERE id=(p->>'line_id')::uuid;
 SELECT * INTO r FROM public.hhee_requests WHERE id=l.request_id FOR UPDATE;
 IF r.id IS NULL OR NOT (public.gp_approve(r.area_id) OR (r.created_by=auth.uid() AND public.hhee_can(r.area_id,'request'))) THEN RAISE EXCEPTION 'Sin permiso para registrar el cierre'; END IF;
 IF r.version IS DISTINCT FROM (p->>'version')::int THEN RAISE EXCEPTION 'La solicitud cambió; recargue'; END IF;
 PERFORM 1 FROM public.hhee_people WHERE id=l.person_id FOR UPDATE;
 SELECT * INTO l FROM public.hhee_lines WHERE id=l.id FOR UPDATE;
 IF l.gp_plan IS NULL OR l.gp_validated_at IS NOT NULL OR r.approval<>'APROBADA' OR r.state='CANCELADA' THEN RAISE EXCEPTION 'La planificación debe estar aprobada y sin validar'; END IF;
 IF e>now() OR length(reason)<5 THEN RAISE EXCEPTION 'Registre un cierre real no futuro y su motivo'; END IF;
 IF (bs IS NULL)<>(be IS NULL) OR (bs IS NOT NULL AND (bs<s OR be>e OR be<=bs)) THEN RAISE EXCEPTION 'Refrigerio fuera de la ejecución'; END IF;
 IF bs IS NULL AND length(btrim(COALESCE(p->>'no_meal_reason','')))<5 THEN RAISE EXCEPTION 'Indique el motivo de no tener refrigerio en este tramo'; END IF;
 UPDATE public.hhee_lines SET actual_start=s,actual_end=e,gp_actual_meal=jsonb_build_object('start',bs,'end',be,'reason',p->>'no_meal_reason'),closed_by='SUPERVISOR',closed_at=now(),close_reason=reason WHERE id=l.id;
 UPDATE public.hhee_requests SET version=version+1 WHERE id=r.id;
 INSERT INTO public.hhee_audit(request_id,actor,event,reason) VALUES(r.id,auth.uid(),'CIERRE_POR_TRAMOS',reason);
 RETURN jsonb_build_object('success',true);
END $$;
REVOKE ALL ON FUNCTION public.gp_plan_close(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.gp_plan_close(jsonb) TO authenticated;

-- Los borradores automáticos detectan ingreso anticipado además de extensión posterior.
CREATE OR REPLACE FUNCTION public.gp_overtime_start(p_person uuid,p_day date,p_dispatch uuid) RETURNS timestamptz
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s jsonb; j jsonb; departure timestamptz; start_time timestamptz;
BEGIN
 SELECT to_jsonb(d) INTO j FROM public.dispatches d WHERE id=p_dispatch;
 departure:=COALESCE(NULLIF(j->>'started_at','')::timestamptz,NULLIF(j->>'departed_at','')::timestamptz,NULLIF(j->>'departure_time','')::timestamptz,NULLIF(j->>'scheduled_departure','')::timestamptz);
 IF departure IS NULL THEN RETURN NULL; END IF;
 s:=public.gp_shift(p_person,p_day); IF s->>'kind'='SIN_HORARIO' THEN RETURN NULL; END IF;
 IF s->>'kind'='DESCANSO' OR public.hhee_pe_holiday(p_day) IS NOT NULL THEN RETURN greatest(departure,p_day::timestamp AT TIME ZONE 'America/Lima'); END IF;
 start_time:=(p_day+(s->>'start')::time) AT TIME ZONE 'America/Lima';
 IF departure<start_time AND (departure AT TIME ZONE 'America/Lima')::date=p_day THEN RETURN departure; END IF;
 RETURN greatest(departure,((p_day+CASE WHEN (s->>'next_day')::boolean THEN 1 ELSE 0 END)+(s->>'end')::time) AT TIME ZONE 'America/Lima');
END $$;
ALTER FUNCTION public.hhee_route_request_for(uuid,timestamptz) RENAME TO hhee_route_request_for_before_plans;
REVOKE ALL ON FUNCTION public.hhee_route_request_for_before_plans(uuid,timestamptz) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.hhee_route_request_for(p_dispatch uuid,p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; r public.hhee_requests; l public.hhee_lines; plan jsonb; split jsonb; finish timestamptz; changed int:=0; affected int;
BEGIN
 result:=public.hhee_route_request_for_before_plans(p_dispatch,p_now);
 SELECT * INTO r FROM public.hhee_requests WHERE auto_dispatch_id=p_dispatch AND state<>'CANCELADA' ORDER BY created_at LIMIT 1 FOR UPDATE;
 IF r.id IS NULL OR r.state<>'BORRADOR' THEN RETURN result; END IF;
 FOR l IN SELECT * FROM public.hhee_lines WHERE request_id=r.id AND actual_end IS NULL ORDER BY person_id FOR UPDATE LOOP
  CONTINUE WHEN l.gp_plan IS NOT NULL AND NOT COALESCE((l.gp_plan->>'meal_pending')::boolean,false);
  PERFORM 1 FROM public.hhee_people WHERE id=l.person_id FOR UPDATE;
  finish:=least(greatest(l.planned_end,date_trunc('hour',p_now)+interval '1 hour'),l.planned_start+interval '16 hours');
  plan:=public.gp_plan_build(l.person_id,jsonb_build_object('start',to_char(l.planned_start AT TIME ZONE 'America/Lima','YYYY-MM-DD"T"HH24:MI'),'end',to_char(finish AT TIME ZONE 'America/Lima','YYYY-MM-DD"T"HH24:MI'),'meal_pending',true,'meal_required',false));
  split:=public.gp_parts_split(l.person_id,plan->'parts',r.id);
  UPDATE public.hhee_lines SET gp_plan=plan,planned_end=finish,planned_break=0,planned_minutes=(plan->>'minutes')::int,
   plan_minutes_25=(split->>'m25')::int,plan_minutes_35=(split->>'m35')::int,plan_minutes_100=(split->>'m100')::int,
   plan_cost=public.hhee_flow_cost(plan_rate,(split->>'m25')::int,(split->>'m35')::int,(split->>'m100')::int),estimated_cost=public.hhee_flow_cost(plan_rate,(split->>'m25')::int,(split->>'m35')::int,(split->>'m100')::int)
  WHERE id=l.id AND (l.gp_plan IS NULL OR l.planned_end<finish);
  GET DIAGNOSTICS affected=ROW_COUNT;changed:=changed+affected;
 END LOOP;
 IF changed>0 THEN
  UPDATE public.hhee_requests SET version=version+1,updated_at=now() WHERE id=r.id;
  INSERT INTO public.hhee_audit(request_id,actor,event,reason) VALUES(r.id,r.created_by,'PROPUESTA_RUTA_POR_TRAMOS','Refrigerio pendiente de revisión del supervisor');
 END IF;
 RETURN result||jsonb_build_object('updated',changed>0,'id',r.id);
END $$;
REVOKE ALL ON FUNCTION public.hhee_route_request_for(uuid,timestamptz) FROM PUBLIC,anon,authenticated;

ALTER FUNCTION public.gp_overtime_validate(jsonb) RENAME TO gp_overtime_validate_before_plans;
REVOKE ALL ON FUNCTION public.gp_overtime_validate_before_plans(jsonb) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.gp_overtime_validate(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.hhee_requests;
BEGIN
 SELECT * INTO r FROM public.hhee_requests WHERE id=(p->>'id')::uuid FOR UPDATE;
 IF r.id IS NULL OR NOT public.gp_approve(r.area_id) THEN RAISE EXCEPTION 'Solo Administrador o Jefe de Distribución valida'; END IF;
 IF EXISTS(SELECT 1 FROM public.hhee_lines WHERE request_id=r.id AND gp_plan IS NOT NULL AND gp_actual_meal IS NULL) THEN RAISE EXCEPTION 'Revise la ejecución y el refrigerio real de cada turno antes de validar'; END IF;
 RETURN public.gp_overtime_validate_before_plans(p);
END $$;
REVOKE ALL ON FUNCTION public.gp_overtime_validate(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.gp_overtime_validate(jsonb) TO authenticated;

-- No se presenta ni acredita una propuesta automática con refrigerio pendiente de revisar.
CREATE FUNCTION public.gp_plan_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF (NEW.state='SOLICITADA' AND OLD.state='BORRADOR') OR NEW.state='VALIDADA' OR (NEW.approval='APROBADA' AND OLD.approval IS DISTINCT FROM 'APROBADA') THEN
  IF EXISTS(SELECT 1 FROM public.hhee_lines WHERE request_id=NEW.id AND COALESCE((gp_plan->>'meal_pending')::boolean,false) AND (NEW.state='SOLICITADA' OR gp_actual_meal IS NULL)) THEN RAISE EXCEPTION 'Revise el refrigerio de la planificación antes de presentar o validar'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gp_plan_request_review BEFORE UPDATE ON public.hhee_requests FOR EACH ROW EXECUTE FUNCTION public.gp_plan_request_guard();

REVOKE ALL ON FUNCTION public.gp_plan_measure(jsonb,timestamptz,timestamptz,timestamptz,timestamptz),public.gp_plan_build(uuid,jsonb),public.gp_parts_split(uuid,jsonb,uuid,boolean),public.gp_plan_execution(),public.gp_plan_overlap_guard(),public.gp_plan_request_guard() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.hhee_flow_preview(jsonb),public.hhee_flow_request_save(jsonb),public.hhee_flow_detail(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.hhee_flow_preview(jsonb),public.hhee_flow_request_save(jsonb),public.hhee_flow_detail(uuid) TO authenticated;
ALTER FUNCTION public.gp_overview(jsonb) RENAME TO gp_overview_before_parts;
REVOKE ALL ON FUNCTION public.gp_overview_before_parts(jsonb) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.gp_overview(p jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; parts jsonb; f date:=COALESCE(NULLIF(p->>'from','')::date,date_trunc('month',now() AT TIME ZONE 'America/Lima')::date);
 t date:=COALESCE(NULLIF(p->>'to','')::date,(now() AT TIME ZONE 'America/Lima')::date); a uuid:=NULLIF(p->>'area_id','')::uuid;
BEGIN
 result:=public.gp_overview_before_parts(p);
 SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.request_date,x.code,x.kind,x.start),'[]') INTO parts FROM (
  SELECT r.id AS request_id,'HE-'||lpad(r.sequence::text,5,'0') AS folio,r.work_date AS request_date,h.code,h.name AS person,
   aa.name AS area,c.name AS cause,CASE WHEN r.auto_dispatch_id IS NULL THEN 'PLANIFICADA' ELSE 'OPERATIVA' END AS source,
   q.kind,z->>'date' AS date,z->>'start' AS start,z->>'end' AS "end",(z->>'minutes')::int AS minutes,(z->>'rest')::boolean AS rest,
   l.gp_validated_at IS NOT NULL AS validated,l.compensation
  FROM public.hhee_requests r JOIN public.hhee_lines l ON l.request_id=r.id JOIN public.hhee_people h ON h.id=l.person_id
   JOIN public.hhee_areas aa ON aa.id=r.area_id JOIN public.hhee_causes c ON c.id=r.cause_id
   CROSS JOIN LATERAL (VALUES ('PLANIFICADO',l.gp_plan->'parts'),('EJECUTADO',l.gp_actual_parts)) q(kind,parts)
   CROSS JOIN LATERAL jsonb_array_elements(q.parts) z
  WHERE r.work_date BETWEEN f AND t AND r.state<>'CANCELADA' AND r.approval='APROBADA' AND (a IS NULL OR r.area_id=a) AND public.hhee_can(r.area_id,'read')
 ) x;
 RETURN result||jsonb_build_object('parts',parts);
END $$;
REVOKE ALL ON FUNCTION public.gp_overview(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.gp_overview(jsonb) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
