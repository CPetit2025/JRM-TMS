-- Compatibilidad con la columna departure_time que utiliza producción.
-- No modifica horarios, saldos ni validaciones de colaboradores.
BEGIN;
CREATE OR REPLACE FUNCTION public.gp_overtime_start(p_person uuid,p_day date,p_dispatch uuid) RETURNS timestamptz
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s jsonb; j jsonb; departure timestamptz; base date:=p_day;
BEGIN
 SELECT to_jsonb(d) INTO j FROM public.dispatches d WHERE id=p_dispatch;
 departure:=COALESCE(NULLIF(j->>'started_at','')::timestamptz,NULLIF(j->>'departed_at','')::timestamptz,NULLIF(j->>'departure_time','')::timestamptz,NULLIF(j->>'scheduled_departure','')::timestamptz);
 IF departure IS NULL THEN RETURN NULL; END IF;
 s:=public.gp_shift(p_person,p_day-1);
 IF (departure AT TIME ZONE 'America/Lima')::date<p_day AND COALESCE((s->>'next_day')::boolean,false) THEN base:=p_day-1;
 ELSE s:=public.gp_shift(p_person,p_day); END IF;
 IF s->>'kind'='SIN_HORARIO' THEN RETURN NULL; END IF;
 IF s->>'kind'='DESCANSO' OR public.hhee_pe_holiday(base) IS NOT NULL THEN RETURN greatest(departure,base::timestamp AT TIME ZONE 'America/Lima'); END IF;
 RETURN greatest(departure,((base+CASE WHEN (s->>'next_day')::boolean THEN 1 ELSE 0 END)+(s->>'end')::time) AT TIME ZONE 'America/Lima');
END $$;
COMMIT;
