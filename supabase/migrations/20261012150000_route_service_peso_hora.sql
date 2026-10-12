-- Agregar servicio a la ruta: solo se confirman el peso y la hora (mismo día operativo de la ruta).
-- Los servicios agregados no se valorizan (flete y km en 0); la capacidad disponible y el motivo pasan a ser
-- opcionales; la hora puede ser anterior al registro (el servicio se documenta después de atenderse) o posterior a la
-- solicitada, siempre dentro del mismo día.
DO $patch$
DECLARE sig regprocedure:='public.add_active_route_service(uuid,uuid,uuid,text,uuid,numeric,numeric,numeric,numeric,timestamptz,text)'::regprocedure;
 def text; changed text;
 old_check text:=$o$ OR p_cargo_kg IS NULL OR p_cargo_kg<=0 OR p_available_kg IS NULL OR p_available_kg<p_cargo_kg
 OR p_expected_at IS NULL OR p_expected_at<now() OR length(trim(COALESCE(p_reason,'')))<10
 OR length(trim(COALESCE(p_reason,'')))>500$o$;
 new_check text:=$n$ OR p_cargo_kg IS NULL OR p_cargo_kg<=0 OR p_available_kg<p_cargo_kg
 OR p_expected_at IS NULL OR length(trim(COALESCE(p_reason,'')))>500$n$;
 old_msg text:=$o$RAISE EXCEPTION 'Confirme costo, kilómetros, capacidad disponible, peso, hora y motivo (mínimo 10 caracteres)'; END IF;$o$;
 new_msg text:=$n$RAISE EXCEPTION 'Confirme el peso y la hora del servicio'; END IF;
 p_available_kg:=COALESCE(p_available_kg,p_cargo_kg); p_reason:=COALESCE(NULLIF(trim(p_reason),''),'Servicio agregado a la ruta');$n$;
 old_due text:=$o$IF due_at IS NULL OR p_expected_at>due_at THEN RAISE EXCEPTION 'La hora prevista supera la atención solicitada'; END IF;$o$;
 -- La hora puede ser posterior a la solicitada: solo se exige el mismo día (Lima) de la atención solicitada.
 new_due text:=$n$IF due_at IS NULL OR (p_expected_at AT TIME ZONE 'America/Lima')::date>(due_at AT TIME ZONE 'America/Lima')::date THEN RAISE EXCEPTION 'La atención prevista es posterior al día solicitado'; END IF;$n$;
BEGIN
 def:=pg_get_functiondef(sig);
 IF position(old_check IN def)=0 OR position(old_msg IN def)=0 OR position(old_due IN def)=0 THEN
   RAISE EXCEPTION 'Motor no reconocido: %',sig; END IF;
 changed:=replace(replace(replace(def,old_check,new_check),old_msg,new_msg),old_due,new_due);
 EXECUTE changed;
END $patch$;
