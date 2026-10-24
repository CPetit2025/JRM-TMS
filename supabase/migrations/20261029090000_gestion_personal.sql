-- Gestión de Personal: horario versionado, asistencia declarada por excepción, permisos y HHEE validadas.
-- Reutiliza hhee_people (enlaces existentes con Flota/Maestros); no crea un segundo padrón.
BEGIN;
SET LOCAL lock_timeout = '30s';

CREATE TABLE public.gp_schedules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), person_id uuid NOT NULL REFERENCES public.hhee_people(id),
 valid_from date NOT NULL, valid_to date, mode text NOT NULL CHECK (mode IN ('FIJO','ROTATIVO')),
 week jsonb NOT NULL CHECK (jsonb_typeof(week) = 'array' AND jsonb_array_length(week) = 7),
 created_by uuid NOT NULL REFERENCES public.profiles(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (valid_to IS NULL OR valid_to >= valid_from), UNIQUE(person_id, valid_from)
);
CREATE INDEX gp_schedules_person_idx ON public.gp_schedules(person_id, valid_from DESC);
CREATE TABLE public.gp_shift_days (
 person_id uuid NOT NULL REFERENCES public.hhee_people(id), work_date date NOT NULL,
 shift jsonb NOT NULL, reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 5 AND 1000),
 updated_by uuid NOT NULL REFERENCES public.profiles(id), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(person_id,work_date)
);
CREATE TABLE public.gp_attendance_days (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), area_id uuid NOT NULL REFERENCES public.hhee_areas(id),
 work_date date NOT NULL, revision integer NOT NULL DEFAULT 1,
 confirmed_by uuid NOT NULL REFERENCES public.profiles(id), confirmed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(area_id,work_date)
);
CREATE TABLE public.gp_attendance_lines (
 day_id uuid NOT NULL REFERENCES public.gp_attendance_days(id), person_id uuid NOT NULL REFERENCES public.hhee_people(id),
 person_name text NOT NULL, person_code text NOT NULL, shift jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('ASISTENCIA_DECLARADA','AUSENTE','DESCANSO','PERMISO')),
 note text, PRIMARY KEY(day_id,person_id)
);
CREATE TABLE public.gp_permits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), person_id uuid NOT NULL REFERENCES public.hhee_people(id),
 area_id uuid NOT NULL REFERENCES public.hhee_areas(id), work_date date NOT NULL,
 minutes integer NOT NULL CHECK(minutes BETWEEN 1 AND 1440), kind text NOT NULL CHECK(kind IN ('PERMISO','REGULARIZACION')),
 compensation boolean NOT NULL DEFAULT false, reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 5 AND 1000),
 status text NOT NULL DEFAULT 'PENDIENTE' CHECK(status IN ('PENDIENTE','APROBADO','APLICADO','RECHAZADO','ANULADO')),
 shift_snapshot jsonb NOT NULL, created_by uuid NOT NULL REFERENCES public.profiles(id), created_at timestamptz NOT NULL DEFAULT now(),
 decided_by uuid REFERENCES public.profiles(id), decided_at timestamptz, decision_reason text,
 revision integer NOT NULL DEFAULT 1, rest_id uuid REFERENCES public.hhee_comp_rests(id)
);
CREATE TABLE public.gp_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, area_id uuid NOT NULL REFERENCES public.hhee_areas(id),
 person_id uuid REFERENCES public.hhee_people(id), actor uuid NOT NULL REFERENCES public.profiles(id),
 event text NOT NULL, detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.hhee_lines ADD COLUMN IF NOT EXISTS gp_validated_at timestamptz,
 ADD COLUMN IF NOT EXISTS gp_validated_by uuid REFERENCES public.profiles(id);

CREATE INDEX gp_permits_person_day_status ON public.gp_permits(person_id,work_date,status);
CREATE INDEX gp_permits_area_day ON public.gp_permits(area_id,work_date);
CREATE INDEX gp_events_area_time ON public.gp_events(area_id,created_at DESC);

CREATE INDEX gp_schedules_created_by_fk_idx ON public.gp_schedules(created_by);
CREATE INDEX gp_shift_days_updated_by_fk_idx ON public.gp_shift_days(updated_by);
CREATE INDEX gp_attendance_days_confirmed_by_fk_idx ON public.gp_attendance_days(confirmed_by);
CREATE INDEX gp_attendance_lines_person_id_fk_idx ON public.gp_attendance_lines(person_id);
CREATE INDEX gp_permits_created_by_fk_idx ON public.gp_permits(created_by);
CREATE INDEX gp_permits_decided_by_fk_idx ON public.gp_permits(decided_by);
CREATE INDEX gp_permits_rest_id_fk_idx ON public.gp_permits(rest_id);
CREATE INDEX gp_events_person_id_fk_idx ON public.gp_events(person_id);
CREATE INDEX gp_events_actor_fk_idx ON public.gp_events(actor);
CREATE INDEX hhee_lines_gp_validated_by_fk_idx ON public.hhee_lines(gp_validated_by);

ALTER TABLE public.gp_schedules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gp_schedules FROM PUBLIC,anon,authenticated;
CREATE POLICY security_active_account ON public.gp_schedules AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
ALTER TABLE public.gp_shift_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gp_shift_days FROM PUBLIC,anon,authenticated;
CREATE POLICY security_active_account ON public.gp_shift_days AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
ALTER TABLE public.gp_attendance_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gp_attendance_days FROM PUBLIC,anon,authenticated;
CREATE POLICY security_active_account ON public.gp_attendance_days AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
ALTER TABLE public.gp_attendance_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gp_attendance_lines FROM PUBLIC,anon,authenticated;
CREATE POLICY security_active_account ON public.gp_attendance_lines AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
ALTER TABLE public.gp_permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gp_permits FROM PUBLIC,anon,authenticated;
CREATE POLICY security_active_account ON public.gp_permits AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
ALTER TABLE public.gp_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gp_events FROM PUBLIC,anon,authenticated;
CREATE POLICY security_active_account ON public.gp_events AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON SEQUENCE public.gp_events_id_seq FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.gp_approve(p_area uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT public.hhee_can(p_area,'approve') AND EXISTS(SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id=p.role_id
  WHERE p.id=auth.uid() AND p.is_active AND r.name IN ('Administrador','Jefe de Distribución'));
$$;

-- La definición completa de un turno es explícita: no se infiere asistencia ni se inventan horarios.
CREATE FUNCTION public.gp_checked_shift(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
#variable_conflict use_column
DECLARE s integer; e integer; b integer;
BEGIN
 IF p->>'kind' = 'DESCANSO' THEN RETURN jsonb_build_object('kind','DESCANSO','minutes',0); END IF;
 IF p->>'kind' IS DISTINCT FROM 'TRABAJO' OR COALESCE(p->>'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  OR COALESCE(p->>'end','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN RAISE EXCEPTION 'Complete inicio y fin del turno'; END IF;
 s := split_part(p->>'start',':',1)::int*60+split_part(p->>'start',':',2)::int;
 e := split_part(p->>'end',':',1)::int*60+split_part(p->>'end',':',2)::int;
 b := COALESCE((p->>'break_minutes')::int,0);
 IF e <= s THEN e:=e+1440; END IF;
 IF e-s > 960 OR b < 0 OR b >= e-s THEN RAISE EXCEPTION 'Turno inválido: máximo 16 horas y descanso menor al intervalo'; END IF;
 RETURN jsonb_build_object('kind','TRABAJO','start',p->>'start','end',p->>'end','next_day',e>=1440,'break_minutes',b,'minutes',e-s-b);
END $$;

CREATE FUNCTION public.gp_shift(p_person uuid,p_date date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_column
DECLARE s jsonb; mode text;
BEGIN
 SELECT x.shift INTO s FROM public.gp_shift_days x WHERE person_id=p_person AND work_date=p_date;
 IF FOUND THEN RETURN s || jsonb_build_object('source','EXCEPCION'); END IF;
 SELECT x.week->(extract(isodow FROM p_date)::int-1),x.mode INTO s,mode FROM public.gp_schedules x
 WHERE x.person_id=p_person AND x.valid_from<=p_date AND (x.valid_to IS NULL OR x.valid_to>=p_date) ORDER BY x.valid_from DESC LIMIT 1;
 IF NOT FOUND OR mode='ROTATIVO' THEN RETURN jsonb_build_object('kind','SIN_HORARIO','minutes',NULL); END IF;
 RETURN s || jsonb_build_object('source','FIJO');
END $$;

CREATE FUNCTION public.gp_schedule_save(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_column
DECLARE person public.hhee_people; d date:=(p->>'from')::date; s jsonb; w jsonb:='[]'; old public.gp_schedules;
BEGIN
 SELECT * INTO person FROM public.hhee_people WHERE id=(p->>'person_id')::uuid FOR UPDATE;
 IF person.id IS NULL OR NOT (public.hhee_can(person.area_id,'request') OR public.gp_approve(person.area_id)) THEN RAISE EXCEPTION 'Sin permiso para programar'; END IF;
 IF d IS NULL OR p->>'mode' NOT IN ('FIJO','ROTATIVO') THEN RAISE EXCEPTION 'Fecha y modalidad requeridas'; END IF;
 IF EXISTS(SELECT 1 FROM public.gp_attendance_days a JOIN public.gp_attendance_lines l ON l.day_id=a.id WHERE l.person_id=person.id AND a.work_date>=d) THEN
  RAISE EXCEPTION 'La vigencia afectaría asistencia confirmada. Use una fecha posterior'; END IF;
 IF EXISTS(SELECT 1 FROM public.gp_permits WHERE person_id=person.id AND work_date>=d AND status IN ('PENDIENTE','APROBADO','APLICADO')) THEN
  RAISE EXCEPTION 'La vigencia afectaría permisos existentes. Resuélvalos antes de cambiar el horario'; END IF;
 IF jsonb_typeof(p->'week') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'week')<>7 THEN RAISE EXCEPTION 'Defina los siete días de la semana'; END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(p->'week') LOOP w:=w||jsonb_build_array(public.gp_checked_shift(s)); END LOOP;
 SELECT * INTO old FROM public.gp_schedules WHERE person_id=person.id ORDER BY valid_from DESC LIMIT 1;
 IF old.id IS NOT NULL THEN
  IF old.valid_from>=d THEN RAISE EXCEPTION 'La nueva vigencia debe ser posterior al último horario'; END IF;
  UPDATE public.gp_schedules SET valid_to=d-1 WHERE id=old.id;
 END IF;
 INSERT INTO public.gp_schedules(person_id,valid_from,mode,week,created_by) VALUES(person.id,d,p->>'mode',w,auth.uid());
 INSERT INTO public.gp_events(area_id,person_id,actor,event,detail) VALUES(person.area_id,person.id,auth.uid(),'HORARIO',p);
 RETURN jsonb_build_object('success',true);
END $$;

CREATE FUNCTION public.gp_shift_day_save(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_column
DECLARE person public.hhee_people; d date:=(p->>'date')::date; s jsonb:=public.gp_checked_shift(p->'shift');
BEGIN
 SELECT * INTO person FROM public.hhee_people WHERE id=(p->>'person_id')::uuid FOR UPDATE;
 IF person.id IS NULL OR NOT (public.hhee_can(person.area_id,'request') OR public.gp_approve(person.area_id)) THEN RAISE EXCEPTION 'Sin permiso'; END IF;
 IF d IS NULL OR length(btrim(COALESCE(p->>'reason','')))<5 THEN RAISE EXCEPTION 'Fecha y motivo requeridos'; END IF;
 IF EXISTS(SELECT 1 FROM public.gp_attendance_days a JOIN public.gp_attendance_lines l ON l.day_id=a.id WHERE l.person_id=person.id AND a.work_date=d) THEN RAISE EXCEPTION 'El día ya tiene asistencia confirmada'; END IF;
 IF EXISTS(SELECT 1 FROM public.gp_permits WHERE person_id=person.id AND work_date=d AND status IN ('PENDIENTE','APROBADO','APLICADO')) THEN RAISE EXCEPTION 'Hay permisos asociados al turno; resuélvalos antes de cambiarlo'; END IF;
 INSERT INTO public.gp_shift_days(person_id,work_date,shift,reason,updated_by) VALUES(person.id,d,s,p->>'reason',auth.uid())
 ON CONFLICT(person_id,work_date) DO UPDATE SET shift=excluded.shift,reason=excluded.reason,updated_by=excluded.updated_by,updated_at=now();
 INSERT INTO public.gp_events(area_id,person_id,actor,event,detail) VALUES(person.area_id,person.id,auth.uid(),'TURNO_DIARIO',p);
 RETURN jsonb_build_object('success',true);
END $$;

-- Solo las horas cerradas, reconocidas y destinadas a compensación alimentan la bolsa.
-- Los descansos históricos se conservan; no se inventan validaciones para justificar saldos anteriores.
CREATE OR REPLACE FUNCTION public.hhee_comp_balance_of(p_person uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('earned',e.m,'taken',t.m,'reserved',r.m,'balance',e.m-t.m-r.m,'legacy_unvalidated',u.m)
 FROM (SELECT COALESCE(sum(l.validated_minutes),0)::int m FROM public.hhee_lines l JOIN public.hhee_requests h ON h.id=l.request_id
  WHERE l.person_id=p_person AND l.compensation AND l.gp_validated_at IS NOT NULL AND h.approval='APROBADA' AND h.state<>'CANCELADA') e,
 (SELECT COALESCE(sum(minutes),0)::int m FROM public.hhee_comp_rests WHERE person_id=p_person AND cancelled_at IS NULL) t,
 (SELECT COALESCE(sum(minutes),0)::int m FROM public.gp_permits WHERE person_id=p_person AND compensation AND status='APROBADO') r,
 (SELECT COALESCE(sum(l.actual_minutes),0)::int m FROM public.hhee_lines l JOIN public.hhee_requests h ON h.id=l.request_id
  WHERE l.person_id=p_person AND l.compensation AND l.actual_end IS NOT NULL AND l.gp_validated_at IS NULL AND h.approval='APROBADA' AND h.state<>'CANCELADA') u;
$$;

CREATE FUNCTION public.gp_permit(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_column
DECLARE person public.hhee_people; x public.gp_permits; s jsonb; m int; used int; balance int;
 d date; a text:=p->>'action'; target text; reason text:=btrim(COALESCE(p->>'reason','')); rest uuid;
BEGIN
 IF a='CREATE' THEN
  SELECT * INTO person FROM public.hhee_people WHERE id=(p->>'person_id')::uuid FOR UPDATE;
 ELSE
  -- Todas las operaciones que consumen o reservan saldo toman primero el bloqueo de la persona.
  SELECT * INTO x FROM public.gp_permits WHERE id=(p->>'id')::uuid;
  SELECT * INTO person FROM public.hhee_people WHERE id=x.person_id FOR UPDATE;
  SELECT * INTO x FROM public.gp_permits WHERE id=x.id FOR UPDATE;
 END IF;
 IF person.id IS NULL OR NOT (public.hhee_can(person.area_id,'request') OR public.gp_approve(person.area_id)) THEN RAISE EXCEPTION 'Sin permiso'; END IF;
 IF a='CREATE' THEN
  d:=(p->>'date')::date; m:=(p->>'minutes')::int; s:=public.gp_shift(person.id,d);
  IF s->>'kind'<>'TRABAJO' OR m IS NULL OR m<1 OR m>(s->>'minutes')::int OR length(reason)<5 OR p->>'kind' NOT IN ('PERMISO','REGULARIZACION') THEN RAISE EXCEPTION 'Revise el horario, las horas y el motivo'; END IF;
  SELECT COALESCE(sum(minutes),0) INTO used FROM public.gp_permits WHERE person_id=person.id AND work_date=d AND status IN ('PENDIENTE','APROBADO','APLICADO');
  IF used+m>(s->>'minutes')::int THEN RAISE EXCEPTION 'Los permisos del día superan el turno'; END IF;
  INSERT INTO public.gp_permits(person_id,area_id,work_date,minutes,kind,compensation,reason,shift_snapshot,created_by)
  VALUES(person.id,person.area_id,d,m,p->>'kind',COALESCE((p->>'compensation')::boolean,false),reason,s,auth.uid()) RETURNING * INTO x;
 ELSE
  IF NOT public.gp_approve(x.area_id) THEN RAISE EXCEPTION 'Solo Administrador o Jefe de Distribución puede decidir'; END IF;
  IF x.revision IS DISTINCT FROM (p->>'revision')::int THEN RAISE EXCEPTION 'El permiso cambió; recargue'; END IF;
  IF length(reason)<5 THEN RAISE EXCEPTION 'Registre el motivo de la decisión'; END IF;
  IF a='APPROVE' AND x.status='PENDIENTE' THEN
   IF x.compensation THEN
    balance:=(public.hhee_comp_balance_of(person.id)->>'balance')::int;
    IF x.minutes>balance THEN RAISE EXCEPTION 'Saldo insuficiente: % min disponibles',balance; END IF;
   END IF;
   target:='APROBADO';
  ELSIF a='REJECT' AND x.status='PENDIENTE' THEN target:='RECHAZADO';
  ELSIF a='APPLY' AND x.status='APROBADO' THEN
   IF x.work_date>(now() AT TIME ZONE 'America/Lima')::date THEN RAISE EXCEPTION 'No se puede aplicar un permiso futuro'; END IF;
   IF x.compensation THEN
    INSERT INTO public.hhee_comp_rests(person_id,rest_date,minutes,note,created_by) VALUES(person.id,x.work_date,x.minutes,'Permiso '||x.id,auth.uid()) RETURNING id INTO rest;
   END IF;
   target:='APLICADO';
  ELSIF a='CANCEL' AND x.status IN ('PENDIENTE','APROBADO','APLICADO') THEN
   IF x.rest_id IS NOT NULL THEN UPDATE public.hhee_comp_rests SET cancelled_at=now(),cancelled_by=auth.uid() WHERE id=x.rest_id AND cancelled_at IS NULL; END IF;
   target:='ANULADO';
  ELSE RAISE EXCEPTION 'Transición de permiso no válida'; END IF;
  UPDATE public.gp_permits SET status=target,revision=revision+1,decided_by=auth.uid(),decided_at=now(),decision_reason=reason,rest_id=COALESCE(rest,x.rest_id) WHERE id=x.id RETURNING * INTO x;
 END IF;
 INSERT INTO public.gp_events(area_id,person_id,actor,event,detail) VALUES(x.area_id,person.id,auth.uid(),'PERMISO_'||a,to_jsonb(x));
 RETURN jsonb_build_object('success',true,'permit',to_jsonb(x),'balance',public.hhee_comp_balance_of(person.id));
END $$;

-- Conserva la declaración original y deriva el permiso vigente sin reescribir su historia.
CREATE FUNCTION public.gp_attendance_status(p_person uuid,p_day date,p_shift jsonb,p_recorded text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN p_shift->>'kind'='DESCANSO' THEN 'DESCANSO'
  WHEN COALESCE((SELECT sum(minutes) FROM public.gp_permits WHERE person_id=p_person AND work_date=p_day AND status IN ('APROBADO','APLICADO')),0)>=(p_shift->>'minutes')::int THEN 'PERMISO'
  WHEN p_recorded='PERMISO' THEN 'REVISAR' ELSE p_recorded END;
$$;

CREATE FUNCTION public.gp_day(p_area uuid,p_date date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_column
DECLARE day public.gp_attendance_days; rows jsonb;
BEGIN
 IF NOT public.hhee_can(p_area,'read') THEN RAISE EXCEPTION 'Sin acceso'; END IF;
 SELECT * INTO day FROM public.gp_attendance_days WHERE area_id=p_area AND work_date=p_date;
 IF day.id IS NOT NULL THEN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('person_id',l.person_id,'name',l.person_name,'code',l.person_code,'shift',l.shift,'status',public.gp_attendance_status(l.person_id,p_date,l.shift,l.status),'recorded_status',l.status,'note',l.note,
   'permit_minutes',COALESCE((SELECT sum(minutes) FROM public.gp_permits WHERE person_id=l.person_id AND work_date=p_date AND status IN ('APROBADO','APLICADO')),0)) ORDER BY l.person_name),'[]') INTO rows
  FROM public.gp_attendance_lines l WHERE day_id=day.id;
 ELSE
  SELECT COALESCE(jsonb_agg(jsonb_build_object('person_id',h.id,'name',h.name,'code',h.code,'shift',public.gp_shift(h.id,p_date),'status','PENDIENTE','note',NULL,
   'permit_minutes',COALESCE((SELECT sum(minutes) FROM public.gp_permits WHERE person_id=h.id AND work_date=p_date AND status IN ('APROBADO','APLICADO')),0)) ORDER BY h.name),'[]') INTO rows
  FROM public.hhee_people h WHERE h.area_id=p_area AND h.active;
 END IF;
 RETURN jsonb_build_object('success',true,'day',CASE WHEN day.id IS NULL THEN NULL ELSE to_jsonb(day) END,'rows',rows,'can_confirm',public.hhee_can(p_area,'request') OR public.gp_approve(p_area),'can_correct',public.gp_approve(p_area));
END $$;

CREATE FUNCTION public.gp_day_confirm(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_column
DECLARE area uuid:=(p->>'area_id')::uuid; d date:=(p->>'date')::date; day public.gp_attendance_days;
 h record; s jsonb; status text; absent jsonb; allowed int; seen uuid[]:='{}';
BEGIN
 IF NOT (public.hhee_can(area,'request') OR public.gp_approve(area)) THEN RAISE EXCEPTION 'Sin permiso'; END IF;
 IF d IS NULL OR d>(now() AT TIME ZONE 'America/Lima')::date THEN RAISE EXCEPTION 'Solo se confirma asistencia de hoy o días anteriores'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('gp-day'),hashtext(area::text||d::text));
 SELECT * INTO day FROM public.gp_attendance_days WHERE area_id=area AND work_date=d FOR UPDATE;
 IF COALESCE(day.revision,0) IS DISTINCT FROM (p->>'revision')::int THEN RAISE EXCEPTION 'La asistencia cambió; recargue'; END IF;
 IF day.id IS NOT NULL AND (NOT public.gp_approve(area) OR length(btrim(COALESCE(p->>'reason','')))<5) THEN RAISE EXCEPTION 'La corrección requiere aprobador y motivo'; END IF;
 IF jsonb_typeof(p->'absences') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Lista de ausentes requerida (puede estar vacía)'; END IF;
 FOR absent IN SELECT value FROM jsonb_array_elements(p->'absences') LOOP
  IF (absent->>'person_id')::uuid=ANY(seen) OR length(btrim(COALESCE(absent->>'note','')))<5 THEN RAISE EXCEPTION 'Ausencia duplicada o sin motivo'; END IF;
  seen:=seen||(absent->>'person_id')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.hhee_people WHERE id=(absent->>'person_id')::uuid AND area_id=area) THEN RAISE EXCEPTION 'Ausente fuera del área'; END IF;
 END LOOP;
 IF day.id IS NULL THEN INSERT INTO public.gp_attendance_days(area_id,work_date,confirmed_by) VALUES(area,d,auth.uid()) RETURNING * INTO day;
 ELSE UPDATE public.gp_attendance_days SET revision=revision+1,confirmed_by=auth.uid(),confirmed_at=now() WHERE id=day.id RETURNING * INTO day; END IF;
 -- En correcciones se reutiliza el padrón y horario congelados, incluso si cambió el estado del colaborador.
 FOR h IN SELECT h.id,h.name,h.code,COALESCE(l.shift,public.gp_shift(h.id,d)) AS shift FROM public.hhee_people h
  LEFT JOIN public.gp_attendance_lines l ON l.person_id=h.id AND l.day_id=day.id
  WHERE (h.area_id=area AND h.active AND day.revision=1) OR l.day_id=day.id ORDER BY h.id LOOP
  PERFORM 1 FROM public.hhee_people WHERE id=h.id FOR UPDATE;
 s:=COALESCE((SELECT shift FROM public.gp_attendance_lines WHERE day_id=day.id AND person_id=h.id),public.gp_shift(h.id,d));
  IF s->>'kind'='SIN_HORARIO' THEN RAISE EXCEPTION 'Falta programar horario para %',h.name; END IF;
  SELECT value INTO absent FROM jsonb_array_elements(p->'absences') WHERE (value->>'person_id')::uuid=h.id;
  SELECT COALESCE(sum(minutes),0) INTO allowed FROM public.gp_permits WHERE person_id=h.id AND work_date=d AND status IN ('APROBADO','APLICADO');
  IF s->>'kind'='DESCANSO' THEN
   IF absent IS NOT NULL THEN RAISE EXCEPTION '% tiene descanso, no corresponde marcar falta',h.name; END IF;
   status:='DESCANSO';
  ELSIF allowed>=(s->>'minutes')::int THEN status:='PERMISO';
  ELSIF absent IS NOT NULL THEN status:='AUSENTE'; ELSE status:='ASISTENCIA_DECLARADA'; END IF;
  INSERT INTO public.gp_attendance_lines(day_id,person_id,person_name,person_code,shift,status,note) VALUES(day.id,h.id,h.name,h.code,s,status,absent->>'note')
  ON CONFLICT(day_id,person_id) DO UPDATE SET status=excluded.status,note=excluded.note;
 END LOOP;
 IF EXISTS(SELECT 1 FROM unnest(seen) id WHERE NOT EXISTS(SELECT 1 FROM public.gp_attendance_lines WHERE day_id=day.id AND person_id=id)) THEN RAISE EXCEPTION 'La lista incluye personal no programado'; END IF;
 INSERT INTO public.gp_events(area_id,actor,event,detail) VALUES(area,auth.uid(),'ASISTENCIA_CONFIRMADA',p||jsonb_build_object('revision',day.revision));
 RETURN public.gp_day(area,d);
END $$;

CREATE FUNCTION public.gp_overtime_validate(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_column
DECLARE r public.hhee_requests; l record; reason text:=btrim(COALESCE(p->>'reason',''));
BEGIN
 SELECT * INTO r FROM public.hhee_requests WHERE id=(p->>'id')::uuid FOR UPDATE;
 IF r.id IS NULL OR NOT public.gp_approve(r.area_id) THEN RAISE EXCEPTION 'Solo Administrador o Jefe de Distribución puede validar'; END IF;
 IF r.approval<>'APROBADA' OR r.state='CANCELADA' OR length(reason)<5 THEN RAISE EXCEPTION 'La solicitud debe estar aprobada y tener sustento de validación'; END IF;
 IF r.version IS DISTINCT FROM (p->>'version')::int THEN RAISE EXCEPTION 'La solicitud cambió; recargue'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.hhee_lines WHERE request_id=r.id) OR EXISTS(SELECT 1 FROM public.hhee_lines WHERE request_id=r.id AND (actual_end IS NULL OR actual_minutes IS NULL)) THEN RAISE EXCEPTION 'Cierre todas las líneas antes de validar'; END IF;
 IF EXISTS(SELECT 1 FROM public.hhee_lines WHERE request_id=r.id AND gp_validated_at IS NOT NULL) THEN RAISE EXCEPTION 'Las horas ya están validadas'; END IF;
 FOR l IN SELECT person_id FROM public.hhee_lines WHERE request_id=r.id ORDER BY person_id LOOP
  PERFORM 1 FROM public.hhee_people WHERE id=l.person_id FOR UPDATE;
 END LOOP;
 UPDATE public.hhee_lines SET validated_minutes=actual_minutes,gp_validated_at=now(),gp_validated_by=auth.uid() WHERE request_id=r.id;
 UPDATE public.hhee_requests SET state='VALIDADA',validated_by=auth.uid(),validated_at=now(),validation_reason=reason,version=version+1 WHERE id=r.id;
 INSERT INTO public.hhee_audit(request_id,actor,event,reason) VALUES(r.id,auth.uid(),'HORAS_VALIDADAS',reason);
 INSERT INTO public.gp_events(area_id,actor,event,detail) VALUES(r.area_id,auth.uid(),'HHEE_VALIDADAS',jsonb_build_object('id',r.id,'reason',reason));
 RETURN jsonb_build_object('success',true);
END $$;

-- Una validación no se invalida cambiando a pago, reeditando líneas o anulando la solicitud por otra RPC.
CREATE FUNCTION public.gp_protect_validated() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='hhee_lines' THEN
  IF OLD.gp_validated_at IS NOT NULL THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'No se eliminan horas validadas'; END IF;
   IF (to_jsonb(NEW)-ARRAY['geo_state','geo_at','geo_entered_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['geo_state','geo_at','geo_entered_at']) THEN RAISE EXCEPTION 'Las horas validadas son inmutables; requieren regularización auditada'; END IF;
  END IF;
 ELSE
  IF NEW.approval='APROBADA' AND OLD.approval IS DISTINCT FROM 'APROBADA' AND NOT public.gp_approve(NEW.area_id) THEN RAISE EXCEPTION 'Solo Administrador o Jefe de Distribución aprueba HHEE'; END IF;
  IF NEW.state='CANCELADA' AND EXISTS(SELECT 1 FROM public.hhee_lines WHERE request_id=OLD.id AND gp_validated_at IS NOT NULL) THEN RAISE EXCEPTION 'No se anulan solicitudes con horas validadas'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER gp_lines_validated BEFORE UPDATE OR DELETE ON public.hhee_lines FOR EACH ROW EXECUTE FUNCTION public.gp_protect_validated();
CREATE TRIGGER gp_requests_validated BEFORE UPDATE ON public.hhee_requests FOR EACH ROW EXECUTE FUNCTION public.gp_protect_validated();

CREATE FUNCTION public.gp_overview(p jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_column
DECLARE v_area uuid:=NULLIF(p->>'area_id','')::uuid; f date:=COALESCE(NULLIF(p->>'from','')::date,date_trunc('month',now() AT TIME ZONE 'America/Lima')::date);
 t date:=COALESCE(NULLIF(p->>'to','')::date,(now() AT TIME ZONE 'America/Lima')::date); out jsonb;
BEGIN
 IF t<f OR t-f>366 THEN RAISE EXCEPTION 'Rango inválido: hasta 366 días'; END IF;
 IF NOT public.is_active_tms_user() THEN RAISE EXCEPTION 'Sin acceso'; END IF;
 SELECT jsonb_build_object('success',true,
  'permits',COALESCE((SELECT jsonb_agg(to_jsonb(q)||jsonb_build_object('person',h.name,'code',h.code,'can_approve',public.gp_approve(q.area_id)) ORDER BY q.created_at DESC)
   FROM public.gp_permits q JOIN public.hhee_people h ON h.id=q.person_id WHERE q.work_date BETWEEN f AND t AND (v_area IS NULL OR q.area_id=v_area) AND public.hhee_can(q.area_id,'read')),'[]'),
  'balances',COALESCE((SELECT jsonb_agg(jsonb_build_object('person_id',h.id,'person',h.name,'code',h.code,'area_id',h.area_id,'balance',public.hhee_comp_balance_of(h.id)) ORDER BY h.name)
   FROM public.hhee_people h WHERE (v_area IS NULL OR h.area_id=v_area) AND public.hhee_can(h.area_id,'read')),'[]'),
  'schedules',COALESCE((SELECT jsonb_agg(to_jsonb(s)||jsonb_build_object('person',h.name) ORDER BY s.valid_from DESC)
   FROM public.gp_schedules s JOIN public.hhee_people h ON h.id=s.person_id WHERE (v_area IS NULL OR h.area_id=v_area) AND public.hhee_can(h.area_id,'read')),'[]'),
  'attendance',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT d.work_date,d.area_id,a.name AS area,public.gp_attendance_status(l.person_id,d.work_date,l.shift,l.status) AS status,count(*) AS people
   FROM public.gp_attendance_days d JOIN public.gp_attendance_lines l ON l.day_id=d.id JOIN public.hhee_areas a ON a.id=d.area_id
   WHERE d.work_date BETWEEN f AND t AND (v_area IS NULL OR d.area_id=v_area) AND public.hhee_can(d.area_id,'read') GROUP BY 1,2,3,4 ORDER BY 1 DESC) x),'[]'),
  'overtime',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT r.area_id,a.name AS area,c.name AS cause,
   CASE WHEN r.auto_dispatch_id IS NULL THEN 'PLANIFICADA' ELSE 'OPERATIVA' END AS source,
   sum(l.planned_minutes) AS authorized_minutes,sum(l.actual_minutes) FILTER(WHERE l.actual_end IS NOT NULL) AS executed_minutes,
   sum(l.validated_minutes) FILTER(WHERE l.gp_validated_at IS NOT NULL) AS validated_minutes,
   sum(l.validated_minutes) FILTER(WHERE l.gp_validated_at IS NOT NULL AND l.compensation) AS compensation_minutes,
   count(*) FILTER(WHERE l.actual_end IS NULL) AS open_lines,count(*) FILTER(WHERE l.actual_end IS NOT NULL AND l.gp_validated_at IS NULL) AS awaiting_validation
   FROM public.hhee_requests r JOIN public.hhee_lines l ON l.request_id=r.id JOIN public.hhee_areas a ON a.id=r.area_id JOIN public.hhee_causes c ON c.id=r.cause_id
   WHERE r.work_date BETWEEN f AND t AND r.approval='APROBADA' AND r.state<>'CANCELADA' AND (v_area IS NULL OR r.area_id=v_area) AND public.hhee_can(r.area_id,'read') GROUP BY 1,2,3,4) x),'[]'),
  'events',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT e.event,e.detail,e.created_at,public.hhee_flow_name(e.actor) AS actor FROM public.gp_events e
   WHERE e.created_at >= (f::timestamp AT TIME ZONE 'America/Lima') AND e.created_at < ((t+1)::timestamp AT TIME ZONE 'America/Lima')
   AND (v_area IS NULL OR e.area_id=v_area) AND public.hhee_can(e.area_id,'read') ORDER BY e.created_at DESC LIMIT 100) x),'[]')
 ) INTO out;
 RETURN out;
END $$;

-- Todas las escrituras se hacen por RPC con permisos de área. Las funciones auxiliares no son endpoints públicos.
ALTER FUNCTION public.hhee_flow_detail(uuid) RENAME TO hhee_flow_detail_before_personal;
REVOKE ALL ON FUNCTION public.hhee_flow_detail_before_personal(uuid) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.hhee_flow_detail(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; valid boolean;
BEGIN
 result:=public.hhee_flow_detail_before_personal(p_id);
 IF result->>'success' IS DISTINCT FROM 'true' THEN RETURN result; END IF;
 SELECT count(*)>0 AND bool_and(gp_validated_at IS NOT NULL) INTO valid FROM public.hhee_lines WHERE request_id=p_id;
 RETURN result||jsonb_build_object('execution_validated',valid,'can_validate',public.gp_approve((SELECT area_id FROM public.hhee_requests WHERE id=p_id)));
END $$;
REVOKE ALL ON FUNCTION public.hhee_flow_detail(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.hhee_flow_detail(uuid) TO authenticated;

-- Compatibilidad de las pantallas anteriores: la bolsa y su detalle usan el mismo origen validado.
CREATE OR REPLACE FUNCTION public.hhee_comp_list(p_person uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a uuid;
BEGIN
 SELECT area_id INTO a FROM public.hhee_people WHERE id=p_person;
 IF a IS NULL OR NOT public.hhee_can(a,'read') THEN RAISE EXCEPTION 'Sin acceso'; END IF;
 RETURN jsonb_build_object('success',true,'balance',public.hhee_comp_balance_of(p_person),
  'earned',COALESCE((SELECT jsonb_agg(jsonb_build_object('folio','HE-'||lpad(r.sequence::text,5,'0'),'work_date',r.work_date,'minutes',l.validated_minutes,'route',l.dispatch_number) ORDER BY r.work_date DESC)
   FROM public.hhee_lines l JOIN public.hhee_requests r ON r.id=l.request_id WHERE l.person_id=p_person AND l.compensation AND l.gp_validated_at IS NOT NULL AND r.state<>'CANCELADA' AND r.approval='APROBADA'),'[]'),
  'rests',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',x.id,'rest_date',x.rest_date,'minutes',x.minutes,'note',x.note,'by',public.hhee_flow_name(x.created_by),'cancelled',x.cancelled_at IS NOT NULL) ORDER BY x.rest_date DESC)
   FROM public.hhee_comp_rests x WHERE x.person_id=p_person),'[]'));
END $$;

CREATE OR REPLACE FUNCTION public.hhee_comp_rest_cancel(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE x public.hhee_comp_rests; area uuid;
BEGIN
 SELECT * INTO x FROM public.hhee_comp_rests WHERE id=p_id;
 SELECT area_id INTO area FROM public.hhee_people WHERE id=x.person_id FOR UPDATE;
 IF x.id IS NULL OR NOT public.gp_approve(area) THEN RAISE EXCEPTION 'Solo Administrador o Jefe de Distribución puede anular'; END IF;
 IF EXISTS(SELECT 1 FROM public.gp_permits WHERE rest_id=p_id) THEN RAISE EXCEPTION 'Anule el permiso asociado desde Permisos y compensaciones'; END IF;
 UPDATE public.hhee_comp_rests SET cancelled_at=now(),cancelled_by=auth.uid() WHERE id=p_id AND cancelled_at IS NULL;
 RETURN jsonb_build_object('success',true);
END $$;

CREATE OR REPLACE FUNCTION public.hhee_comp_rest_save(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'Registre el permiso en Permisos y compensaciones: requiere aprobación y aplicación';
END $$;

-- Un cierre no puede acreditarse dos veces ni cambiar de destino después de validado.
DO $guard$ DECLARE definition text; BEGIN
 definition:=pg_get_functiondef('public.hhee_line_set_compensation(uuid,boolean)'::regprocedure);
 definition:=replace(definition,'IF r.state = ''CANCELADA''',E'IF NOT public.gp_approve(r.area_id) THEN RAISE EXCEPTION ''Solo Administrador o Jefe de Distribución decide el destino''; END IF;\n  IF r.state = ''CANCELADA''');
 EXECUTE definition;
END $guard$;

-- Horario real de cada integrante para las solicitudes automáticas existentes. Sin programación no se inventa un turno.
CREATE FUNCTION public.gp_overtime_start(p_person uuid,p_day date,p_dispatch uuid) RETURNS timestamptz
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s jsonb; j jsonb; departure timestamptz; base date:=p_day;
BEGIN
 SELECT to_jsonb(d) INTO j FROM public.dispatches d WHERE id=p_dispatch;
 departure:=COALESCE(NULLIF(j->>'started_at','')::timestamptz,NULLIF(j->>'departed_at','')::timestamptz,NULLIF(j->>'scheduled_departure','')::timestamptz);
 IF departure IS NULL THEN RETURN NULL; END IF;
 s:=public.gp_shift(p_person,p_day-1);
 IF (departure AT TIME ZONE 'America/Lima')::date<p_day AND COALESCE((s->>'next_day')::boolean,false) THEN base:=p_day-1;
 ELSE s:=public.gp_shift(p_person,p_day); END IF;
 IF s->>'kind'='SIN_HORARIO' THEN RETURN NULL; END IF;
 IF s->>'kind'='DESCANSO' OR public.hhee_pe_holiday(base) IS NOT NULL THEN RETURN greatest(departure,base::timestamp AT TIME ZONE 'America/Lima'); END IF;
 RETURN greatest(departure,((base+CASE WHEN (s->>'next_day')::boolean THEN 1 ELSE 0 END)+(s->>'end')::time) AT TIME ZONE 'America/Lima');
END $$;

CREATE OR REPLACE FUNCTION public.hhee_route_overtime_start(p_dispatch uuid,p_day date) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT min(public.gp_overtime_start(h.id,p_day,p_dispatch)) FROM public.hhee_people h
 WHERE h.active AND (h.driver_id=(SELECT d.driver_id FROM public.dispatches d WHERE d.id=p_dispatch)
  OR h.id IN (SELECT x.person_id FROM public.route_auxiliaries x WHERE x.dispatch_id=p_dispatch)
  OR h.profile_id IN (SELECT x.profile_id FROM public.dispatch_crew x WHERE x.dispatch_id=p_dispatch AND x.removed_at IS NULL AND x.crew_role IN ('AUXILIAR','AYUDANTE')));
$$;

CREATE OR REPLACE FUNCTION public.hhee_route_request_for(p_dispatch uuid, p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d public.dispatches; j jsonb; v_day date := (p_now AT TIME ZONE 'America/Lima')::date; v_start timestamptz; v_end timestamptz;
  v_area uuid; v_cause uuid; v_creator uuid; r public.hhee_requests; v_person uuid; v_people uuid[] := '{}'; v_rest boolean; v_min int; v_split jsonb;
  v_rate numeric; m25 int; m35 int; m100 int; v_num text; c record; v_p public.hhee_people; v_n int := 0; v_append boolean := false;
BEGIN
  SELECT * INTO d FROM public.dispatches WHERE id = p_dispatch;
  IF d.id IS NULL OR d.driver_id IS NULL OR d.vehicle_plate IS NULL OR d.vehicle_plate = 'EXTERNO' THEN RETURN jsonb_build_object('created', false, 'reason', 'sin conductor propio'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('gp-route'),hashtext(p_dispatch::text));
  SELECT * INTO r FROM public.hhee_requests WHERE auto_dispatch_id=p_dispatch AND state<>'CANCELADA' ORDER BY created_at LIMIT 1 FOR UPDATE;
  v_append:=r.id IS NOT NULL;
  IF v_append AND r.state<>'BORRADOR' THEN RETURN jsonb_build_object('created',false,'reason','ya presentada; ajuste manual con reaprobación'); END IF;
  j := to_jsonb(d); v_num := COALESCE(j->>'dispatch_number', j->>'legacy_dispatch_number', left(p_dispatch::text, 8));
  v_start := public.hhee_route_overtime_start(p_dispatch, v_day);
  IF v_start IS NULL OR p_now < v_start THEN RETURN jsonb_build_object('created', false, 'reason', 'dentro del horario'); END IF;
  -- Fin estimado: la siguiente hora en punto (mínimo 30 min); el supervisor lo ajusta y el cierre real lo corrige
  v_end := GREATEST(date_trunc('hour', p_now) + interval '1 hour', v_start + interval '30 minutes');
  v_rest := extract(isodow FROM v_day) = 7;
  -- Área: la del conductor si ya tiene ficha; si no, la de la sede de la ruta o Distribución
  SELECT area_id INTO v_area FROM public.hhee_people WHERE driver_id = d.driver_id AND active;
  IF v_area IS NULL THEN
    SELECT a.id INTO v_area FROM public.hhee_areas a WHERE a.module_enabled AND a.active
    ORDER BY (a.site_id = (j->>'site_id')::uuid) DESC NULLS LAST, (a.name = 'Distribución') DESC, a.name LIMIT 1;
  END IF;
  IF v_area IS NULL THEN RETURN jsonb_build_object('created', false, 'reason', 'sin área de HHEE habilitada'); END IF;
  SELECT id INTO v_cause FROM public.hhee_causes WHERE name = 'Ruta extendida fuera del horario';
  v_creator := COALESCE(NULLIF(j->>'created_by', '')::uuid, NULLIF(j->>'scheduled_by', '')::uuid);
  IF v_creator IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_creator) THEN
    SELECT m.user_id INTO v_creator FROM public.hhee_memberships m JOIN public.profiles p ON p.id = m.user_id WHERE m.area_id = v_area AND p.is_active ORDER BY m.user_id LIMIT 1;
  END IF;
  IF v_creator IS NULL THEN RETURN jsonb_build_object('created', false, 'reason', 'sin supervisor'); END IF;

  IF NOT v_append THEN
  INSERT INTO public.hhee_requests (area_id, cause_id, work_date, activity, justification, alternatives, expected_result, reference_type, created_by, auto_dispatch_id)
  VALUES (v_area, v_cause, v_day, left(format('PENDIENTE · Ruta %s · %s', v_num, d.vehicle_plate), 300), 'PENDIENTE: el supervisor completa por qué se necesitan',
    'PENDIENTE', 'PENDIENTE', 'SIN_REFERENCIA', v_creator, p_dispatch) RETURNING * INTO r;
  END IF;

  -- Conductor y tripulación que viaja (auxiliar / ayudante)
  FOR c IN SELECT d.driver_id AS driver_id, NULL::uuid AS profile_id, NULL::uuid AS person_id, 0 AS ord
           UNION ALL SELECT NULL, NULL, a.person_id, 1 FROM public.route_auxiliaries a WHERE a.dispatch_id = p_dispatch
           UNION ALL SELECT NULL, x.profile_id, NULL, 2 FROM public.dispatch_crew x WHERE x.dispatch_id = p_dispatch AND x.removed_at IS NULL AND x.crew_role IN ('AUXILIAR', 'AYUDANTE')
           ORDER BY ord LOOP
    CONTINUE WHEN c.ord = 1 AND c.person_id IS NULL;
    v_person := COALESCE(c.person_id, public.hhee_person_for(c.driver_id, c.profile_id, v_area));
    CONTINUE WHEN v_person IS NULL OR v_person = ANY (v_people);
    CONTINUE WHEN EXISTS(SELECT 1 FROM public.hhee_lines WHERE request_id=r.id AND person_id=v_person);
    -- Quien ya tiene horas extras ese día en otra solicitud no se duplica
    CONTINUE WHEN public.hhee_person_day_conflict(v_person, v_day, r.id) IS NOT NULL;
    SELECT * INTO v_p FROM public.hhee_people WHERE id = v_person;
    CONTINUE WHEN NOT v_p.active;
    v_people := v_people || v_person;
    v_start:=public.gp_overtime_start(v_person,v_day,p_dispatch);
    CONTINUE WHEN v_start IS NULL OR p_now<v_start;
    v_rest:=public.gp_shift(v_person,v_day)->>'kind'='DESCANSO';
    v_min := (extract(epoch FROM v_end - v_start) / 60)::int;
    CONTINUE WHEN v_min<1 OR v_min>960;
    v_split := public.hhee_flow_split(v_person, v_day, v_min, v_rest, r.id);
    m25 := (v_split->>'m25')::int; m35 := (v_split->>'m35')::int; m100 := (v_split->>'m100')::int;
    v_rate := public.hhee_flow_rate(v_person);
    INSERT INTO public.hhee_lines (request_id, person_id, person_name, person_code, planned_start, planned_end, planned_break, planned_minutes,
      plan_minutes_25, plan_minutes_35, plan_minutes_100, plan_rate, plan_cost, estimated_cost, rest_day,
      driver_dispatch_id, dispatch_number, vehicle_plate, plate_source)
    VALUES (r.id, v_person, v_p.name, v_p.code, v_start, v_end, 0, v_min, m25, m35, m100, v_rate,
      public.hhee_flow_cost(v_rate, m25, m35, m100), public.hhee_flow_cost(v_rate, m25, m35, m100), v_rest,
      CASE WHEN v_p.driver_id IS NOT NULL THEN p_dispatch END, CASE WHEN v_p.driver_id IS NOT NULL THEN v_num END,
      CASE WHEN v_p.driver_id IS NOT NULL THEN d.vehicle_plate END, CASE WHEN v_p.driver_id IS NOT NULL THEN 'RUTA' END);
    v_n := v_n + 1;
  END LOOP;
  IF v_n = 0 THEN IF NOT v_append THEN DELETE FROM public.hhee_requests WHERE id = r.id; END IF; RETURN jsonb_build_object('created', false, 'reason', 'sin trabajadores'); END IF;

  IF v_append THEN UPDATE public.hhee_requests SET version=version+1,updated_at=now() WHERE id=r.id; END IF;
  INSERT INTO public.hhee_audit (request_id, actor, event, reason)
  VALUES (r.id, v_creator, CASE WHEN v_append THEN 'TRIPULACION_AGREGADA_POR_RUTA' ELSE 'GENERADA_POR_RUTA' END, format('Ruta %s en curso fuera del horario (%s)', v_num, to_char(v_start AT TIME ZONE 'America/Lima', 'HH24:MI')));
  BEGIN
    INSERT INTO public.notifications (evento, categoria, severidad, titulo, cuerpo, link, target_user, dedupe_key)
    VALUES ('HHEE_RUTA', 'hhee', 'warning', format('Horas extras de la ruta %s', v_num),
      format('La ruta %s (%s) sigue en curso fuera del horario. Complete la actividad, el porqué y la alternativa, y preséntela para aprobación.', v_num, d.vehicle_plate),
      '/hhee/solicitudes?id=' || r.id, v_creator, 'hhee-ruta-' || r.id);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN jsonb_build_object('created',NOT v_append,'updated',v_append,'id',r.id,'workers',v_n);
END $$;

-- Revisa borradores para incorporar tripulantes cuyo turno acaba más tarde.
CREATE OR REPLACE FUNCTION public.hhee_auto_route_requests(p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE x record; res jsonb; v_created int := 0;
BEGIN
  IF NOT COALESCE((SELECT auto_route_requests FROM public.hhee_settings WHERE id = 1), true) THEN RETURN jsonb_build_object('created', 0, 'disabled', true); END IF;
  FOR x IN SELECT d.id FROM public.dispatches d
           WHERE d.status IN ('EN_CURSO', 'EN RUTA', 'RETORNO') AND d.driver_id IS NOT NULL AND d.vehicle_plate IS NOT NULL AND d.vehicle_plate <> 'EXTERNO'
             AND NOT EXISTS (SELECT 1 FROM public.hhee_requests r WHERE r.auto_dispatch_id = d.id AND r.state NOT IN ('CANCELADA','BORRADOR')) LOOP
    BEGIN
      res := public.hhee_route_request_for(x.id, p_now);
      IF (res->>'created')::boolean THEN v_created := v_created + 1; END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
  RETURN jsonb_build_object('created', v_created);
END $$;

REVOKE ALL ON FUNCTION public.gp_attendance_status(uuid,date,jsonb,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.gp_overtime_start(uuid,date,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.gp_approve(uuid),public.gp_checked_shift(jsonb),public.gp_shift(uuid,date),public.gp_protect_validated() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.gp_schedule_save(jsonb),public.gp_shift_day_save(jsonb),public.gp_permit(jsonb),public.gp_day(uuid,date),public.gp_day_confirm(jsonb),public.gp_overtime_validate(jsonb),public.gp_overview(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.gp_schedule_save(jsonb),public.gp_shift_day_save(jsonb),public.gp_permit(jsonb),public.gp_day(uuid,date),public.gp_day_confirm(jsonb),public.gp_overtime_validate(jsonb),public.gp_overview(jsonb) TO authenticated;
COMMIT;
