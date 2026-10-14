-- Envío de la guía desde el app: la falta de un punto GPS de los 45 s previos a la captura ya no bloquea la guía.
-- Caso real: cola de puntos trabada en el teléfono, sin señal o sin permiso de ubicación → «Se requiere GPS de la
-- captura» y la entrega quedaba bloqueada. Ahora se usa el último punto del despacho (o ninguno) para la llegada y el
-- tramo queda como «GPS incompleto» (leg_gps_complete = false), sin perder la trazabilidad de que faltó el GPS.
DO $patch$
DECLARE sig regprocedure:='public.delivery_submit_driver(uuid,uuid,text[],text,text,text,uuid,timestamptz)'::regprocedure;
 def text; changed text;
 old_gps text:=$o$ IF point.id IS NULL OR point.recorded_at<p_captured-interval '45 seconds' THEN RAISE EXCEPTION 'Se requiere GPS de la captura; sincronice los puntos pendientes'; END IF;$o$;
 new_gps text:=$n$ IF point.id IS NULL OR point.recorded_at<p_captured-interval '45 seconds' THEN
  -- Sin GPS reciente: último punto del despacho (si existe); el tramo queda «GPS incompleto»
  SELECT * INTO point FROM public.route_track_points WHERE dispatch_id=p_dispatch
   AND recorded_at<=p_captured+interval '5 seconds' ORDER BY recorded_at DESC LIMIT 1;
 END IF;$n$;
 old_km text:=$o$  INTO km,complete FROM public.route_track_points WHERE dispatch_id=p_dispatch AND leg_order=seq AND recorded_at<=p_captured+interval '5 seconds';$o$;
 new_km text:=$n$  INTO km,complete FROM public.route_track_points WHERE dispatch_id=p_dispatch AND leg_order=seq AND recorded_at<=p_captured+interval '5 seconds';
 complete:=COALESCE(complete,false) AND point.id IS NOT NULL AND point.recorded_at>=p_captured-interval '45 seconds';$n$;
 old_odo text:=$o$p_captured,point.cumulative_m/1000,p_photos[1]);$o$;
 new_odo text:=$n$p_captured,COALESCE(point.cumulative_m,(SELECT max(t.cumulative_m) FROM public.route_track_points t WHERE t.dispatch_id=p_dispatch),0)/1000,p_photos[1]);$n$;
BEGIN
 def:=pg_get_functiondef(sig);
 IF position('Sin GPS reciente' IN def)>0 THEN RETURN; END IF;
 IF position(old_gps IN def)=0 OR position(old_km IN def)=0 OR position(old_odo IN def)=0 THEN
  RAISE EXCEPTION 'Envío de guías del conductor no reconocido: revisar antes de migrar'; END IF;
 changed:=replace(replace(replace(def,old_gps,new_gps),old_km,new_km),old_odo,new_odo);
 EXECUTE changed;
END $patch$;
