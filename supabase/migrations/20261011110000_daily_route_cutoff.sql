BEGIN;
-- Administrative resource release is separate from delivery conformity and financial settlement.
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS daily_cutoff_at timestamptz,
 ADD COLUMN IF NOT EXISTS operational_closed_at timestamptz,
 ADD COLUMN IF NOT EXISTS operational_previous_status text;

CREATE FUNCTION public.dispatch_operating_day(p_row jsonb) RETURNS date
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT (COALESCE(NULLIF(p_row->>'departure_time','')::timestamptz,
   NULLIF(p_row->>'tercero_salida_at','')::timestamptz,
   NULLIF(p_row->>'scheduled_departure','')::timestamptz) AT TIME ZONE 'America/Lima')::date;
$$;
CREATE FUNCTION public.dispatch_cutoff_at(p_row jsonb) RETURNS timestamptz
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT (public.dispatch_operating_day(p_row)+1)::timestamp AT TIME ZONE 'America/Lima';
$$;

-- Extend only single-column status constraints, preserving all other integrity checks.
DO $constraints$
DECLARE r record; status_col smallint;
BEGIN
 SELECT attnum INTO status_col FROM pg_attribute WHERE attrelid='public.dispatches'::regclass AND attname='status';
 FOR r IN SELECT conname,pg_get_expr(conbin,conrelid) expr FROM pg_constraint
 WHERE conrelid='public.dispatches'::regclass AND contype='c' AND conkey=ARRAY[status_col] LOOP
   EXECUTE format('ALTER TABLE public.dispatches DROP CONSTRAINT %I',r.conname);
   EXECUTE format('ALTER TABLE public.dispatches ADD CONSTRAINT %I CHECK ((%s) OR status=''CIERRE_OPERATIVO'')',r.conname,r.expr);
 END LOOP;
END $constraints$;

CREATE FUNCTION public.dispatch_daily_clock_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.operational_closed_at IS NOT NULL THEN
   NEW.daily_cutoff_at:=OLD.daily_cutoff_at;
   NEW.operational_closed_at:=OLD.operational_closed_at;
   NEW.operational_previous_status:=OLD.operational_previous_status;
   IF NEW.status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO','RETORNO_COMPLETADO','ENTREGADO') THEN
     RAISE EXCEPTION 'La ruta tiene cierre operativo; programe una nueva ruta para otro día';
   END IF;
 ELSE
   NEW.daily_cutoff_at:=public.dispatch_cutoff_at(to_jsonb(NEW));
   NEW.operational_closed_at:=NULL; NEW.operational_previous_status:=NULL;
   IF NEW.status='CIERRE_OPERATIVO' THEN
     IF TG_OP='INSERT' OR OLD.status NOT IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO','RETORNO_COMPLETADO','ENTREGADO') THEN
       RAISE EXCEPTION 'Estado de origen no válido para el corte diario'; END IF;
     NEW.daily_cutoff_at:=public.dispatch_cutoff_at(to_jsonb(OLD));
     IF NEW.daily_cutoff_at IS NULL OR now()<NEW.daily_cutoff_at THEN
       RAISE EXCEPTION 'El corte operativo se realiza a las 00:00 de Lima'; END IF;
     NEW.operational_closed_at:=NEW.daily_cutoff_at;
     NEW.operational_previous_status:=OLD.status;
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dispatch_daily_clock_guard BEFORE INSERT OR UPDATE ON public.dispatches
FOR EACH ROW EXECUTE FUNCTION public.dispatch_daily_clock_guard();
-- Atomic column-only backfill preserves each user trigger's original enable mode.
-- ALTER takes an exclusive lock; no concurrent request can bypass guards.
DO $backfill$
DECLARE names text[]; modes text[]; i int;
BEGIN
 SELECT array_agg(tgname ORDER BY tgname),array_agg(tgenabled::text ORDER BY tgname)
 INTO names,modes FROM pg_trigger WHERE tgrelid='public.dispatches'::regclass AND NOT tgisinternal AND tgenabled<>'D';
 FOR i IN 1..COALESCE(cardinality(names),0) LOOP
   EXECUTE format('ALTER TABLE public.dispatches DISABLE TRIGGER %I',names[i]);
 END LOOP;
 UPDATE public.dispatches SET daily_cutoff_at=public.dispatch_cutoff_at(to_jsonb(dispatches))
 WHERE daily_cutoff_at IS DISTINCT FROM public.dispatch_cutoff_at(to_jsonb(dispatches));
 FOR i IN 1..COALESCE(cardinality(names),0) LOOP
   EXECUTE format('ALTER TABLE public.dispatches ENABLE %s TRIGGER %I',
     CASE modes[i] WHEN 'A' THEN 'ALWAYS' WHEN 'R' THEN 'REPLICA' ELSE '' END,names[i]);
 END LOOP;
END $backfill$;
CREATE INDEX dispatch_daily_cutoff_due_idx ON public.dispatches(daily_cutoff_at)
 WHERE status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO','RETORNO_COMPLETADO','ENTREGADO');

CREATE FUNCTION public.dispatch_daily_release_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pending int; driver_profile uuid; responsible uuid;
BEGIN
 IF NEW.status<>'CIERRE_OPERATIVO' OR OLD.status='CIERRE_OPERATIVO' THEN RETURN NEW; END IF;
 SELECT count(*) INTO pending FROM public.dispatch_requests dr LEFT JOIN public.delivery_conformities c
 ON c.dispatch_id=dr.dispatch_id AND c.request_id=dr.transport_request_id
 WHERE dr.dispatch_id=NEW.id AND public.delivery_required(dr.dispatch_id,dr.transport_request_id) AND c.state IS DISTINCT FROM 'VALIDADA';
 -- Release occupancy, without overriding maintenance or a newer route's vehicle state.
 UPDATE public.vehicles SET status='DISPONIBLE' WHERE plate=NEW.vehicle_plate
 AND status IN ('ASIGNADA','EN_OPERACION','EN_RUTA') AND NOT EXISTS(
   SELECT 1 FROM public.dispatches d WHERE d.id<>NEW.id AND d.vehicle_plate=NEW.vehicle_plate
   AND d.status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO'));
 INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by)
 VALUES(NEW.id,'CORTE_DIARIO','Corte operativo a las 00:00 de Lima. Unidad y conductor liberados; '||pending||
   ' guía(s) pendiente(s). No confirma entrega, retorno ni cierre financiero. Estado anterior: '||OLD.status,'system');
 SELECT profile_id INTO driver_profile FROM public.drivers WHERE id=NEW.driver_id;
 FOR responsible IN SELECT DISTINCT x FROM unnest(ARRAY[driver_profile,NULLIF(to_jsonb(NEW)->>'created_by','')::uuid]) x
 WHERE x IS NOT NULL AND EXISTS(SELECT 1 FROM public.profiles WHERE id=x AND is_active) LOOP
   INSERT INTO public.notifications(evento,categoria,severidad,titulo,cuerpo,link,permisos,target_user,dedupe_key)
   VALUES('RUTA_CORTE_DIARIO','DESPACHO',CASE WHEN pending>0 THEN 'warning' ELSE 'info' END,
     'Cierre operativo diario: '||NEW.dispatch_number,
     'Unidad liberada a las 00:00 de Lima. Guías pendientes: '||pending||'. El cierre documental y financiero sigue separado.',
     CASE WHEN responsible=driver_profile THEN '/app/ruta?trip_id='||NEW.id ELSE '/torre-control?despacho='||NEW.id||'&fecha='||public.dispatch_operating_day(to_jsonb(NEW)) END,
     '{}',responsible,'corte-diario:'||NEW.id||':'||responsible) ON CONFLICT DO NOTHING;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER dispatch_daily_release_event AFTER UPDATE OF status ON public.dispatches
FOR EACH ROW EXECUTE FUNCTION public.dispatch_daily_release_event();

CREATE FUNCTION public.close_daily_dispatch_operations(p_dispatch uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; n int:=0;
BEGIN
 FOR d IN SELECT id FROM public.dispatches WHERE status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO','RETORNO_COMPLETADO','ENTREGADO')
 AND daily_cutoff_at<=now() AND (p_dispatch IS NULL OR id=p_dispatch) ORDER BY daily_cutoff_at,id LIMIT 500 FOR UPDATE SKIP LOCKED LOOP
   UPDATE public.dispatches SET status='CIERRE_OPERATIVO' WHERE id=d.id;
   n:=n+1;
 END LOOP;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.dispatch_operating_day(jsonb),public.dispatch_cutoff_at(jsonb),
 public.dispatch_daily_clock_guard(),public.dispatch_daily_release_event(),public.close_daily_dispatch_operations(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.close_daily_dispatch_operations(uuid) TO service_role;

-- Existing engines retain their authorization, reservation and conformity checks.
DO $engines$
DECLARE source text; changed text; signature text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['public.check_driver_eligibility(uuid)','public.check_asset_eligibility(text,text)'] LOOP
   IF to_regprocedure(signature) IS NULL THEN CONTINUE; END IF;
   source:=pg_get_functiondef(to_regprocedure(signature));
   changed:=replace(source,'''CANCELADO'', ''RETORNO_COMPLETADO''','''CANCELADO'', ''RETORNO_COMPLETADO'', ''CIERRE_OPERATIVO''');
   changed:=replace(changed,'''CANCELADO'',''RETORNO_COMPLETADO''','''CANCELADO'',''RETORNO_COMPLETADO'',''CIERRE_OPERATIVO''');
   IF changed=source THEN RAISE EXCEPTION 'Elegibilidad incompatible: %',signature; END IF;
   EXECUTE changed;
 END LOOP;
 source:=pg_get_functiondef('public.close_dispatch_route(uuid)'::regprocedure);
 changed:=replace(source,'''RETORNO_COMPLETADO'', ''ENTREGADO''','''RETORNO_COMPLETADO'', ''ENTREGADO'', ''CIERRE_OPERATIVO''');
 changed:=replace(changed,'IF v_dispatch.vehicle_plate IS NOT NULL',
   'IF v_dispatch.vehicle_plate IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.dispatches current_route WHERE current_route.id<>p_dispatch_id AND current_route.vehicle_plate=v_dispatch.vehicle_plate AND current_route.status IN (''PROGRAMADO'',''EN_CURSO'',''EN RUTA'',''ESPERANDO_AUTORIZACION'',''RETORNO''))');
 IF changed=source OR position('''CIERRE_OPERATIVO''' IN changed)=0 THEN RAISE EXCEPTION 'Cierre financiero incompatible'; END IF;
 EXECUTE changed;
 source:=pg_get_functiondef('public.transition_dispatch_status(uuid,text,text,uuid)'::regprocedure);
 changed:=replace(source,'IF p_new_status IN (''CERRADO'', ''CANCELADO'') AND v_dispatch.vehicle_plate IS NOT NULL',
   'IF p_new_status IN (''CERRADO'', ''CANCELADO'') AND v_dispatch.vehicle_plate IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.dispatches current_route WHERE current_route.id<>p_dispatch_id AND current_route.vehicle_plate=v_dispatch.vehicle_plate AND current_route.status IN (''PROGRAMADO'',''EN_CURSO'',''EN RUTA'',''ESPERANDO_AUTORIZACION'',''RETORNO''))');
 IF changed=source THEN RAISE EXCEPTION 'Liberación al cierre final incompatible'; END IF;
 EXECUTE changed;
 source:=pg_get_functiondef('public.delivery_submit_driver(uuid,uuid,text[],text,text,text,uuid,timestamptz)'::regprocedure);
 changed:=replace(source,'IF COALESCE(correction,false) THEN',
   'IF COALESCE(correction,false) OR EXISTS(SELECT 1 FROM public.dispatches WHERE id=p_dispatch AND status=''CIERRE_OPERATIVO'') THEN');
 IF changed=source THEN RAISE EXCEPTION 'Envío documental de conductor incompatible'; END IF;
 EXECUTE changed;
 source:=pg_get_functiondef('public.delivery_issue_access_core(uuid)'::regprocedure);
 changed:=replace(source,'''PROGRAMADO'',''EN_CURSO'',''EN RUTA'')','''PROGRAMADO'',''EN_CURSO'',''EN RUTA'',''CIERRE_OPERATIVO'')');
 IF changed=source THEN RAISE EXCEPTION 'Emisión de acceso incompatible'; END IF;
 EXECUTE changed;
 source:=pg_get_functiondef('public.get_driver_portal_summary()'::regprocedure);
 changed:=replace(source,'''RETORNO_COMPLETADO'',''CANCELADO''','''RETORNO_COMPLETADO'',''CANCELADO'',''CIERRE_OPERATIVO''');
 IF changed=source THEN RAISE EXCEPTION 'Historial del conductor incompatible'; END IF;
 EXECUTE changed;
 source:=pg_get_functiondef('public.get_tower_dispatches(date,uuid,text)'::regprocedure);
 changed:=replace(source,'d.status IN (''ENTREGADO'',''RETORNO_COMPLETADO'')','d.status IN (''ENTREGADO'',''RETORNO_COMPLETADO'',''CIERRE_OPERATIVO'')');
 IF changed=source THEN RAISE EXCEPTION 'Bandeja de cierre incompatible'; END IF;
 EXECUTE changed;
END $engines$;

ALTER FUNCTION public.active_route_context(uuid) RENAME TO active_route_context_before_daily_cutoff;
REVOKE ALL ON FUNCTION public.active_route_context_before_daily_cutoff(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.active_route_context(p_dispatch uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; d jsonb; day date; cutoff timestamptz; requests jsonb;
BEGIN
 result:=public.active_route_context_before_daily_cutoff(p_dispatch);
 SELECT to_jsonb(x) INTO d FROM public.dispatches x WHERE id=p_dispatch;
 day:=public.dispatch_operating_day(d); cutoff:=public.dispatch_cutoff_at(d);
 IF day IS NULL OR cutoff<=now() OR (d->>'status'<>'PROGRAMADO' AND day<>(now() AT TIME ZONE 'America/Lima')::date) THEN
   RAISE EXCEPTION 'Solo se incorporan adicionales durante el mismo día operativo de la ruta, antes de las 00:00 de Lima'; END IF;
 SELECT COALESCE(jsonb_agg(r),'[]') INTO requests FROM jsonb_array_elements(result->'requests') r
 WHERE COALESCE((NULLIF(r->>'required_at','')::timestamptz AT TIME ZONE 'America/Lima')::date,NULLIF(r->>'required_date','')::date)=day;
 RETURN result||jsonb_build_object('requests',requests,'dispatch',(result->'dispatch')||jsonb_build_object('operating_day',day,'cutoff_at',cutoff));
END $$;
REVOKE ALL ON FUNCTION public.active_route_context(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.active_route_context(uuid) TO authenticated;
DO $addition$
DECLARE source text; changed text;
BEGIN
 source:=pg_get_functiondef('public.add_active_route_service(uuid,uuid,uuid,text,uuid,numeric,numeric,numeric,numeric,timestamptz,text)'::regprocedure);
 changed:=replace(source,'capacity:=NULLIF(context->>''capacity_kg'','''')::numeric;',
   'IF (p_expected_at AT TIME ZONE ''America/Lima'')::date<>public.dispatch_operating_day(to_jsonb(d)) OR COALESCE((NULLIF(to_jsonb(t)->>''required_at'','''')::timestamptz AT TIME ZONE ''America/Lima'')::date,NULLIF(to_jsonb(t)->>''required_date'','''')::date) IS DISTINCT FROM public.dispatch_operating_day(to_jsonb(d)) THEN RAISE EXCEPTION ''El adicional y su atención prevista deben corresponder al mismo día de la ruta (Lima)''; END IF; capacity:=NULLIF(context->>''capacity_kg'','''')::numeric;');
 IF changed=source THEN RAISE EXCEPTION 'Motor de incorporación incompatible'; END IF;
 EXECUTE changed;
END $addition$;

-- PLATFORM_CRON_BEGIN: pg_cron is provisioned by Supabase; the local PostgreSQL harness tests the job directly.
CREATE EXTENSION IF NOT EXISTS pg_cron;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='cierre-operativo-rutas') THEN PERFORM cron.unschedule('cierre-operativo-rutas'); END IF; END $$;
SELECT cron.schedule('dispatch-midnight-lima','* * * * *',$job$SELECT public.close_daily_dispatch_operations();$job$);
-- PLATFORM_CRON_END
NOTIFY pgrst,'reload schema';
COMMIT;
