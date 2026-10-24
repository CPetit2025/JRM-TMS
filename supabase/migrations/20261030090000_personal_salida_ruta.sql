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
-- Configuración por selección explícita; todo el lote se guarda o se revierte.
CREATE FUNCTION public.gp_schedule_batch(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE person uuid; n int:=0;
BEGIN
 IF jsonb_typeof(p->'people') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'people') NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Seleccione entre 1 y 500 colaboradores'; END IF;
 IF (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(p->'people'))<>jsonb_array_length(p->'people') THEN RAISE EXCEPTION 'Hay colaboradores repetidos'; END IF;
 FOR person IN SELECT value::uuid FROM jsonb_array_elements_text(p->'people') ORDER BY value::uuid LOOP
  IF NOT EXISTS(SELECT 1 FROM public.hhee_people WHERE id=person AND active) THEN RAISE EXCEPTION 'Colaborador inexistente o inactivo'; END IF;
  PERFORM public.gp_schedule_save((p-'people')||jsonb_build_object('person_id',person));
  n:=n+1;
 END LOOP;
 RETURN jsonb_build_object('success',true,'updated',n);
END $$;
REVOKE ALL ON FUNCTION public.gp_schedule_batch(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.gp_schedule_batch(jsonb) TO authenticated;

COMMIT;
