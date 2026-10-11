-- Cierre operativo de rutas de flota propia, separado de la liquidación documentaria.
-- * La ruta se cierra sola cuando el conductor envía la guía del último punto asignado, o a las 00:00 (Lima)
--   si es de un día anterior. Queda en RETORNO_COMPLETADO: la unidad y el conductor quedan libres.
-- * La liquidación documentaria sigue pendiente: el Supervisor de Transporte valida las guías y la ruta se
--   liquida (close_dispatch_route) como hasta ahora. El conductor puede subir guías que falten de esa ruta.
-- * «Agregar servicio» solo en rutas del día o futuras; las de días anteriores ya se cerraron a las 00:00.
-- Los terceros y el recojo por el cliente no cambian.
BEGIN;

-- 1. Liberación de la unidad propia al terminar la operación (también al registrar la llegada a base).
CREATE FUNCTION public.dispatch_release_own_unit_core(p_dispatch uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.dispatches%ROWTYPE; v_prev text; v_new text; v_elig jsonb;
BEGIN
 SELECT * INTO d FROM public.dispatches WHERE id=p_dispatch;
 IF d.id IS NULL OR d.vehicle_plate IS NULL OR d.vehicle_plate='EXTERNO' OR COALESCE(to_jsonb(d)->>'modalidad','PROPIA')='TERCERO'
  OR EXISTS(SELECT 1 FROM public.dispatches x WHERE x.vehicle_plate=d.vehicle_plate AND x.id<>d.id
   AND x.status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO')) THEN RETURN NULL; END IF;
 SELECT status INTO v_prev FROM public.vehicles WHERE plate=d.vehicle_plate FOR UPDATE;
 IF v_prev IS NULL OR v_prev NOT IN ('ASIGNADA','EN_OPERACION') THEN RETURN NULL; END IF;
 BEGIN
  v_elig:=public.check_asset_eligibility(d.vehicle_plate,'RELEASE');
 EXCEPTION WHEN OTHERS THEN
  v_elig:=jsonb_build_object('status','NO_APTO','motives',jsonb_build_array(SQLERRM));
 END;
 v_new:=CASE WHEN v_elig->>'status'='NO_APTO' THEN 'OBSERVADA' ELSE 'DISPONIBLE' END;
 UPDATE public.vehicles SET status=v_new WHERE plate=d.vehicle_plate;
 INSERT INTO public.vehicle_history_logs(vehicle_plate,changed_by,field_changed,old_value,new_value,change_reason)
 VALUES(d.vehicle_plate,auth.uid(),'status',v_prev,v_new,'Cierre operativo del despacho '||COALESCE(d.dispatch_number,d.id::text)
  ||CASE WHEN v_new='OBSERVADA' THEN ' | No elegible: '||COALESCE((SELECT string_agg(value,'; ') FROM jsonb_array_elements_text(v_elig->'motives')),'sin detalle') ELSE '' END);
 RETURN v_new;
END $$;
CREATE FUNCTION public.dispatch_release_own_unit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM public.dispatch_release_own_unit_core(NEW.id);
 RETURN NULL;
END $$;
CREATE TRIGGER dispatch_release_own_unit AFTER UPDATE OF status ON public.dispatches FOR EACH ROW
 WHEN (NEW.status='RETORNO_COMPLETADO' AND OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION public.dispatch_release_own_unit();

-- 2. El cierre operativo no exige las guías validadas (eso es la liquidación). Solo lo puede hacer este cierre.
DO $patch$
DECLARE v_def text; anchor text:='''CERRADO'') AND OLD.status IS DISTINCT FROM NEW.status AND EXISTS(';
BEGIN
 v_def:=pg_get_functiondef('public.delivery_guard_advance()'::regprocedure);
 IF position('jrm.cierre_operativo' IN v_def)>0 THEN RETURN; END IF;
 IF position(anchor IN v_def)=0 THEN RAISE EXCEPTION 'Guarda de entregas no reconocida: revisar antes de migrar'; END IF;
 EXECUTE replace(v_def,anchor,'''CERRADO'') AND OLD.status IS DISTINCT FROM NEW.status AND NOT (NEW.status=''RETORNO_COMPLETADO'' AND COALESCE(current_setting(''jrm.cierre_operativo'',true),'''')=''on'') AND EXISTS(');
END $patch$;

CREATE FUNCTION public.dispatch_operational_close(p_dispatch uuid,p_source text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.dispatches%ROWTYPE;
BEGIN
 SELECT * INTO d FROM public.dispatches WHERE id=p_dispatch FOR UPDATE;
 IF d.id IS NULL OR d.vehicle_plate IS NULL OR d.vehicle_plate='EXTERNO' OR COALESCE(to_jsonb(d)->>'modalidad','PROPIA')='TERCERO'
  OR d.status NOT IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO') THEN RETURN false; END IF;
 PERFORM set_config('jrm.cierre_operativo','on',true);
 UPDATE public.dispatches SET status='RETORNO_COMPLETADO' WHERE id=p_dispatch;
 PERFORM set_config('jrm.cierre_operativo','off',true);
 INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by,created_at)
 VALUES(p_dispatch,'CIERRE_OPERATIVO',CASE WHEN p_source='CONDUCTOR' THEN 'El conductor completó todos los puntos' ELSE 'Cierre automático de las 00:00' END
  ||' ('||d.status||' → RETORNO_COMPLETADO). Unidad y conductor liberados; liquidación documentaria pendiente',COALESCE(auth.uid()::text,'system'),now());
 RETURN true;
END $$;

-- 3. El conductor completa la ruta al enviar la guía de cada punto asignado.
CREATE FUNCTION public.dispatch_close_when_points_done() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.dispatches x WHERE x.id=NEW.dispatch_id AND x.status IN ('EN_CURSO','EN RUTA'))
  AND NOT EXISTS(SELECT 1 FROM public.dispatch_requests dr LEFT JOIN public.delivery_conformities c
   ON c.dispatch_id=dr.dispatch_id AND c.request_id=dr.transport_request_id
   WHERE dr.dispatch_id=NEW.dispatch_id AND COALESCE(dr.status,'') NOT IN ('CANCELADO','RETIRADO')
    AND public.delivery_required(dr.dispatch_id,dr.transport_request_id) AND COALESCE(c.state,'PENDIENTE') NOT IN ('RECIBIDA','VALIDADA')) THEN
  PERFORM public.dispatch_operational_close(NEW.dispatch_id,'CONDUCTOR');
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER dispatch_close_when_points_done AFTER INSERT OR UPDATE OF state ON public.delivery_conformities FOR EACH ROW
 WHEN (NEW.state IN ('RECIBIDA','VALIDADA')) EXECUTE FUNCTION public.dispatch_close_when_points_done();

-- 4. A las 00:00 (Lima) se cierran las rutas propias de días anteriores.
CREATE FUNCTION public.dispatch_midnight_close() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record; n integer:=0;
BEGIN
 FOR r IN SELECT d.id FROM public.dispatches d
  WHERE d.status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO')
   AND d.vehicle_plate IS NOT NULL AND d.vehicle_plate<>'EXTERNO' AND COALESCE(to_jsonb(d)->>'modalidad','PROPIA')<>'TERCERO'
   AND (COALESCE(d.scheduled_departure,d.created_at) AT TIME ZONE 'America/Lima')::date<(now() AT TIME ZONE 'America/Lima')::date
  ORDER BY d.scheduled_departure
 LOOP
  BEGIN
   IF public.dispatch_operational_close(r.id,'SISTEMA') THEN n:=n+1; END IF;
  EXCEPTION WHEN OTHERS THEN
   INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by,created_at)
   VALUES(r.id,'CIERRE_OPERATIVO_ERROR','No se pudo cerrar a las 00:00: '||SQLERRM,'system',now());
  END;
 END LOOP;
 RETURN n;
END $$;

-- 5. Guías que faltan de una ruta ya cerrada: el conductor las sube sin GPS de tramo (como una corrección).
DO $patch$
DECLARE v_def text; anchor text:='SELECT state IN (''OBSERVADA'',''RECHAZADA'') INTO correction FROM public.delivery_conformities WHERE dispatch_id=p_dispatch AND request_id=p_request;';
BEGIN
 v_def:=pg_get_functiondef('public.delivery_submit_driver(uuid,uuid,text[],text,text,text,uuid,timestamptz)'::regprocedure);
 IF position('Ruta cerrada: guía pendiente' IN v_def)>0 THEN RETURN; END IF;
 IF position(anchor IN v_def)=0 THEN RAISE EXCEPTION 'Envío de guías del conductor no reconocido: revisar antes de migrar'; END IF;
 EXECUTE replace(v_def,anchor,anchor||E'\n -- Ruta cerrada: guía pendiente de la liquidación documentaria\n IF EXISTS(SELECT 1 FROM public.dispatches x WHERE x.id=p_dispatch AND x.status=''RETORNO_COMPLETADO'') THEN correction:=true; END IF;');
END $patch$;

-- 6. «Agregar servicio» solo en rutas del día o futuras.
DO $patch$
DECLARE v_def text; anchor text:='IF d.status NOT IN (''PROGRAMADO'',''EN_CURSO'',''EN RUTA'') OR d.vehicle_plate=''EXTERNO'' THEN';
BEGIN
 v_def:=pg_get_functiondef('public.active_route_context(uuid)'::regprocedure);
 IF position('día anterior' IN v_def)>0 THEN RETURN; END IF;
 IF position(anchor IN v_def)=0 THEN RAISE EXCEPTION 'Contexto de ruta activa no reconocido: revisar antes de migrar'; END IF;
 EXECUTE replace(v_def,anchor,'IF (COALESCE(d.scheduled_departure,d.created_at) AT TIME ZONE ''America/Lima'')::date<(now() AT TIME ZONE ''America/Lima'')::date THEN
   RAISE EXCEPTION ''La ruta es de un día anterior: la unidad se liberó a las 00:00 y solo queda su liquidación documentaria''; END IF;
 '||anchor);
END $patch$;

REVOKE ALL ON FUNCTION public.dispatch_release_own_unit(),public.dispatch_release_own_unit_core(uuid),public.dispatch_operational_close(uuid,text),
 public.dispatch_close_when_points_done(),public.dispatch_midnight_close() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_operational_close(uuid,text),public.dispatch_midnight_close() TO service_role;

-- Rutas que ya llegaron a base y esperan su liquidación: su unidad queda libre desde ahora.
DO $backfill$
DECLARE r record;
BEGIN
 FOR r IN SELECT id FROM public.dispatches WHERE status='RETORNO_COMPLETADO' LOOP
  PERFORM public.dispatch_release_own_unit_core(r.id);
 END LOOP;
END $backfill$;

DO $cron$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
  BEGIN PERFORM cron.unschedule('cierre-operativo-rutas'); EXCEPTION WHEN OTHERS THEN NULL; END;
  -- 05:00 UTC = 00:00 en Lima (sin horario de verano)
  PERFORM cron.schedule('cierre-operativo-rutas','0 5 * * *',$job$SELECT public.dispatch_midnight_close()$job$);
 END IF;
END $cron$;
COMMIT;
