-- App connection is independent of route GPS and never affects distances or conformity.
BEGIN;
CREATE TABLE public.driver_app_presence(
 driver_id uuid PRIMARY KEY REFERENCES public.drivers(id) ON DELETE CASCADE,
 profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 last_seen_at timestamptz NOT NULL DEFAULT now(), disconnected_at timestamptz,
 gps_state text NOT NULL DEFAULT 'checking' CHECK(gps_state IN ('checking','active','denied','unavailable')),
 latitude numeric, longitude numeric, accuracy_m numeric, speed_mps numeric, recorded_at timestamptz,
 CHECK(latitude BETWEEN -90 AND 90), CHECK(longitude BETWEEN -180 AND 180),
 CHECK(accuracy_m BETWEEN 0 AND 2000), CHECK(speed_mps BETWEEN 0 AND 100)
);
ALTER TABLE public.driver_app_presence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.driver_app_presence FROM PUBLIC,anon,authenticated;
CREATE INDEX IF NOT EXISTS gps_monitor_driver_routes ON public.dispatches(driver_id,scheduled_departure DESC)
 WHERE status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO','RETORNO_COMPLETADO','ENTREGADO');
CREATE INDEX driver_app_presence_seen ON public.driver_app_presence(last_seen_at DESC);

CREATE FUNCTION public.driver_app_heartbeat(p_gps_state text DEFAULT 'checking',p_lat numeric DEFAULT NULL,p_lon numeric DEFAULT NULL,
 p_accuracy numeric DEFAULT NULL,p_speed_mps numeric DEFAULT NULL,p_recorded_at timestamptz DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_driver uuid;
BEGIN
 SELECT d.id INTO v_driver FROM public.drivers d JOIN public.profiles p ON p.id=d.profile_id
 WHERE d.profile_id=auth.uid() AND d.is_active AND p.is_active ORDER BY d.id LIMIT 1;
 IF v_driver IS NULL THEN RETURN jsonb_build_object('success',false,'error','Conductor activo no vinculado'); END IF;
 IF p_gps_state IS NULL OR p_gps_state NOT IN ('checking','active','denied','unavailable') OR
    ((p_lat IS NULL) IS DISTINCT FROM (p_lon IS NULL)) OR
    (p_lat IS NOT NULL AND (p_gps_state<>'active' OR p_lat NOT BETWEEN -90 AND 90 OR p_lon NOT BETWEEN -180 AND 180 OR
     p_accuracy IS NULL OR p_accuracy NOT BETWEEN 0 AND 2000 OR p_recorded_at IS NULL OR p_recorded_at>now()+interval '30 seconds' OR p_recorded_at<now()-interval '1 day')) OR
    (p_speed_mps IS NOT NULL AND p_speed_mps NOT BETWEEN 0 AND 100) THEN
   RAISE EXCEPTION 'Señal GPS no válida'; END IF;
 INSERT INTO public.driver_app_presence(driver_id,profile_id,last_seen_at,gps_state,latitude,longitude,accuracy_m,speed_mps,recorded_at)
 VALUES(v_driver,auth.uid(),now(),p_gps_state,p_lat,p_lon,p_accuracy,p_speed_mps,CASE WHEN p_lat IS NOT NULL THEN p_recorded_at END)
 ON CONFLICT(driver_id) DO UPDATE SET profile_id=EXCLUDED.profile_id,last_seen_at=now(),disconnected_at=NULL,gps_state=EXCLUDED.gps_state,
   latitude=CASE WHEN EXCLUDED.recorded_at>=COALESCE(driver_app_presence.recorded_at,'-infinity') THEN EXCLUDED.latitude ELSE driver_app_presence.latitude END,
   longitude=CASE WHEN EXCLUDED.recorded_at>=COALESCE(driver_app_presence.recorded_at,'-infinity') THEN EXCLUDED.longitude ELSE driver_app_presence.longitude END,
   accuracy_m=CASE WHEN EXCLUDED.recorded_at>=COALESCE(driver_app_presence.recorded_at,'-infinity') THEN EXCLUDED.accuracy_m ELSE driver_app_presence.accuracy_m END,
   speed_mps=CASE WHEN EXCLUDED.recorded_at>=COALESCE(driver_app_presence.recorded_at,'-infinity') THEN EXCLUDED.speed_mps ELSE driver_app_presence.speed_mps END,
   recorded_at=GREATEST(driver_app_presence.recorded_at,EXCLUDED.recorded_at);
 RETURN jsonb_build_object('success',true);
END $$;
CREATE FUNCTION public.driver_app_disconnect() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN UPDATE public.driver_app_presence SET disconnected_at=now() WHERE profile_id=auth.uid(); END $$;
REVOKE ALL ON FUNCTION public.driver_app_heartbeat(text,numeric,numeric,numeric,numeric,timestamptz),public.driver_app_disconnect() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.driver_app_heartbeat(text,numeric,numeric,numeric,numeric,timestamptz),public.driver_app_disconnect() TO authenticated;

-- A genuine driver upload from the native route tracker also refreshes presence.
-- Late offline samples do not move the displayed location backwards or enter the distance calculation twice.
-- Route samples can legitimately be seven days old; only current-day samples update this presence table.
CREATE FUNCTION public.driver_presence_route_point() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.recorded_at>=now()-interval '1 day' AND EXISTS(SELECT 1 FROM public.drivers d JOIN public.profiles p ON p.id=d.profile_id
   WHERE d.id=NEW.driver_id AND d.profile_id=auth.uid() AND d.is_active AND p.is_active) THEN
   PERFORM public.driver_app_heartbeat('active',NEW.latitude,NEW.longitude,NEW.accuracy_m,
     CASE WHEN NEW.speed_mps BETWEEN 0 AND 100 THEN NEW.speed_mps END,NEW.recorded_at);
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.driver_presence_route_point() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER driver_presence_route_point AFTER INSERT ON public.route_track_points FOR EACH ROW EXECUTE FUNCTION public.driver_presence_route_point();

CREATE FUNCTION public.get_driver_gps_monitor() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND is_active) OR NOT
   (public.is_tms_admin() OR public.has_tms_read_permission('monitoreo') OR public.has_tms_read_permission('torre-control')) THEN
   RAISE EXCEPTION 'Sin permiso para el monitor GPS'; END IF;
 WITH roster AS (
 SELECT dr.id AS driver_id,dr.profile_id,
   COALESCE(NULLIF(trim(concat_ws(' ',to_jsonb(dr)->>'first_name',to_jsonb(dr)->>'last_name')),''),
     NULLIF(trim(concat_ws(' ',to_jsonb(pr)->>'first_name',to_jsonb(pr)->>'last_name')),''),'Conductor') AS driver_name,
   d.id AS dispatch_id,d.dispatch_number,d.vehicle_plate,d.status AS route_status,d.site_id,
   CASE
    WHEN d.id IS NULL THEN 'SIN_RUTA'
    WHEN d.status='PROGRAMADO' AND d.docs_required AND (d.docs_ready_at IS NULL OR d.docs_reissue OR public.dispatch_documents_missing(d.id) IS NOT NULL) THEN 'ESPERANDO_DOCUMENTOS'
    WHEN d.status='PROGRAMADO' THEN 'RUTA_ASIGNADA'
    WHEN d.status='ESPERANDO_AUTORIZACION' THEN 'ESPERANDO_RETORNO'
    WHEN d.status='RETORNO' THEN 'RETORNO'
    WHEN d.status='RETORNO_COMPLETADO' THEN 'EN_BASE'
    WHEN d.status='ENTREGADO' THEN 'ENTREGADO'
    WHEN EXISTS(SELECT 1 FROM public.delivery_conformities c WHERE c.dispatch_id=d.id AND c.state IN ('OBSERVADA','RECHAZADA')) THEN 'GUIA_OBSERVADA'
    WHEN EXISTS(SELECT 1 FROM public.delivery_conformities c WHERE c.dispatch_id=d.id AND c.arrived_at IS NOT NULL AND c.state='PENDIENTE') THEN 'ESPERANDO_GUIA'
    WHEN EXISTS(SELECT 1 FROM public.delivery_conformities c WHERE c.dispatch_id=d.id AND c.state='RECIBIDA') THEN 'GUIA_EN_VALIDACION'
    ELSE 'EN_RUTA' END AS operational_status,
   a.last_seen_at,a.disconnected_at,a.gps_state,
   CASE WHEN a.recorded_at IS NOT NULL AND a.recorded_at>=COALESCE(d.last_gps_at,'-infinity') THEN a.latitude ELSE d.last_lat END AS latitude,
   CASE WHEN a.recorded_at IS NOT NULL AND a.recorded_at>=COALESCE(d.last_gps_at,'-infinity') THEN a.longitude ELSE d.last_lon END AS longitude,
   GREATEST(a.recorded_at,d.last_gps_at) AS gps_at,
   CASE WHEN a.recorded_at IS NOT NULL AND a.recorded_at>=COALESCE(d.last_gps_at,'-infinity') THEN a.accuracy_m END AS accuracy_m,
   CASE WHEN a.recorded_at IS NOT NULL AND a.recorded_at>=COALESCE(d.last_gps_at,'-infinity') THEN a.speed_mps*3.6 END AS speed_kmh
 FROM public.drivers dr JOIN public.profiles pr ON pr.id=dr.profile_id AND pr.is_active
 LEFT JOIN public.driver_app_presence a ON a.driver_id=dr.id AND a.profile_id=dr.profile_id
 LEFT JOIN LATERAL(SELECT x.* FROM public.dispatches x WHERE x.driver_id=dr.id
   AND x.status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO','RETORNO_COMPLETADO','ENTREGADO')
   ORDER BY CASE WHEN x.status IN ('EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO') THEN 0 WHEN x.status='PROGRAMADO' THEN 1 ELSE 2 END,
     x.scheduled_departure DESC NULLS LAST,x.id LIMIT 1) d ON true
 WHERE dr.is_active AND (d.id IS NOT NULL OR a.last_seen_at>=now()-interval '24 hours')
   AND (public.is_tms_admin() OR (d.site_id IS NOT NULL AND public.can_access_site(d.site_id)) OR
     (d.site_id IS NULL AND EXISTS(SELECT 1 FROM public.user_site_access u WHERE u.user_id=dr.profile_id AND public.can_access_site(u.site_id))))
 ), rows AS (
 SELECT jsonb_build_object('id','driver:'||driver_id,'driver_id',driver_id,'profile_id',profile_id,'driver',driver_name,
   'dispatch_id',dispatch_id,'dispatch_number',dispatch_number,'plate',vehicle_plate,'route_status',route_status,'operational_status',operational_status,
   'connected',COALESCE(last_seen_at>=now()-interval '90 seconds' AND disconnected_at IS NULL,false),
   'last_seen_at',last_seen_at,'gps_state',COALESCE(gps_state,CASE WHEN gps_at IS NOT NULL THEN 'active' ELSE 'unavailable' END),'lat',latitude,'lng',longitude,'gps_at',gps_at,
   'gps_fresh',COALESCE(gps_at>=now()-interval '2 minutes' AND COALESCE(gps_state,'active')='active',false),
   'accuracy_m',accuracy_m,'speed',speed_kmh) AS row FROM roster
 UNION ALL
 SELECT jsonb_build_object('id','dispatch:'||d.id,'driver_id',NULL,'profile_id',NULL,'driver',COALESCE(d.driver_name,'Proveedor'),
   'dispatch_id',d.id,'dispatch_number',d.dispatch_number,'plate',d.vehicle_plate,'route_status',d.status,'operational_status','EN_RUTA',
   'connected',false,'last_seen_at',NULL,'gps_state','unavailable','lat',d.last_lat,'lng',d.last_lon,'gps_at',d.last_gps_at,
   'gps_fresh',d.last_gps_at>=now()-interval '2 minutes','accuracy_m',NULL,'speed',NULL)
 FROM public.dispatches d WHERE d.driver_id IS NULL AND d.status IN ('EN_CURSO','EN RUTA','RETORNO') AND d.last_gps_at IS NOT NULL
   AND (public.is_tms_admin() OR public.can_access_site(d.site_id))
 ) SELECT COALESCE(jsonb_agg(row ORDER BY COALESCE((row->>'connected')::boolean,false) DESC,row->>'driver'),'[]'::jsonb) INTO result FROM rows;
 RETURN jsonb_build_object('as_of',now(),'drivers',result);
END $$;
REVOKE ALL ON FUNCTION public.get_driver_gps_monitor() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_driver_gps_monitor() TO authenticated;
COMMIT;
