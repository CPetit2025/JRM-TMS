-- Conservar segundos reales de app/geocerca; acreditar solo minutos completos por tramo.
BEGIN;
CREATE OR REPLACE FUNCTION public.gp_plan_measure(p jsonb,s timestamptz,e timestamptz,bs timestamptz DEFAULT NULL,be timestamptz DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE normal tstzmultirange:='{}'; extra tstzmultirange; meal tstzmultirange:='{}'; x jsonb; d date; sh jsonb;
 a timestamptz; b timestamptz; part tstzrange; piece tstzrange; parts jsonb:='[]'; mins int; worked int; rest boolean;
BEGIN
 IF s IS NULL OR e IS NULL OR e<=s OR e-s>interval '16 hours' THEN RAISE EXCEPTION 'Turno inválido: inicio/fin, máximo 16 horas'; END IF;
 IF (bs IS NULL)<>(be IS NULL) OR (bs IS NOT NULL AND (be<=bs)) THEN RAISE EXCEPTION 'Refrigerio inválido'; END IF;
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
   mins:=floor(extract(epoch FROM upper(piece)-lower(piece))/60)::int;
   parts:=parts||jsonb_build_array(jsonb_build_object('start',lower(piece),'end',upper(piece),'date',d,'minutes',mins,'rest',rest));
  END LOOP;
 END LOOP;
 SELECT COALESCE(sum((value->>'minutes')::int),0) INTO mins FROM jsonb_array_elements(parts);
 SELECT floor(COALESCE(sum(extract(epoch FROM upper(z)-lower(z))/60),0))::int INTO worked FROM unnest(tstzmultirange(tstzrange(s,e,'[)'))-meal) z;
 RETURN jsonb_build_object('parts',parts,'minutes',mins,'worked_minutes',worked,'ordinary_minutes',worked-mins);
END $$;
CREATE OR REPLACE FUNCTION public.gp_plan_build(person uuid,l jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s timestamptz:=(l->>'start')::timestamp AT TIME ZONE 'America/Lima'; e timestamptz:=(l->>'end')::timestamp AT TIME ZONE 'America/Lima';
 bs timestamptz:=NULLIF(l->>'meal_start','')::timestamp AT TIME ZONE 'America/Lima'; be timestamptz:=NULLIF(l->>'meal_end','')::timestamp AT TIME ZONE 'America/Lima';
 p jsonb; shifts jsonb; d date; sh jsonb; pending boolean:=COALESCE((l->>'meal_pending')::boolean,false);
BEGIN
 IF e<=s OR e-s>interval '16 hours' OR date_trunc('minute',s)<>s OR date_trunc('minute',e)<>e OR (bs IS NOT NULL AND (date_trunc('minute',bs)<>bs OR date_trunc('minute',be)<>be)) THEN RAISE EXCEPTION 'Turno de máximo 16 horas'; END IF;
 IF (bs IS NULL)<>(be IS NULL) OR (bs IS NOT NULL AND (bs<s OR be>e OR be<=bs)) THEN RAISE EXCEPTION 'Ubique el refrigerio dentro del turno'; END IF;
 IF NOT pending AND bs IS NULL AND length(btrim(COALESCE(l->>'no_meal_reason','')))<5 THEN RAISE EXCEPTION 'Indique el refrigerio o el motivo de no tenerlo en este tramo'; END IF;
 IF NOT pending AND COALESCE((l->>'meal_required')::boolean,true) AND (bs IS NULL OR be-bs<>interval '60 minutes') THEN RAISE EXCEPTION 'El turno completo requiere ubicar los 60 minutos de refrigerio'; END IF;
 FOR d IN SELECT generate_series((s AT TIME ZONE 'America/Lima')::date-1,(e AT TIME ZONE 'America/Lima')::date+1,interval '1 day')::date LOOP
  sh:=public.gp_shift(person,d); shifts:=COALESCE(shifts,'[]')||jsonb_build_array(jsonb_build_object('date',d,'shift',sh));
 END LOOP;
 p:=jsonb_build_object('start',s,'end',e,'meal_start',bs,'meal_end',be,'no_meal_reason',l->>'no_meal_reason','meal_pending',pending,'meal_required',COALESCE((l->>'meal_required')::boolean,true),'shifts',shifts);
 RETURN p||public.gp_plan_measure(p,s,e,bs,be);
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
