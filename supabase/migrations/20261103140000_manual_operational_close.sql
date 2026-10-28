-- Cierre operativo manual con motivo y actor. La documentación, las entregas y Caja
-- siguen su circuito: no se simula retorno, recepción, validación ni pago.
BEGIN;
SET LOCAL lock_timeout='60s';

-- Estas columnas pertenecen al cierre diario; asegurar compatibilidad con instalaciones anteriores.
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS daily_cutoff_at timestamptz,
 ADD COLUMN IF NOT EXISTS operational_closed_at timestamptz,
 ADD COLUMN IF NOT EXISTS operational_previous_status text;

CREATE OR REPLACE FUNCTION public.dispatch_daily_clock_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_manual boolean := false;
BEGIN
 IF TG_OP='UPDATE' THEN
  v_manual := COALESCE(current_setting('jrm.cierre_operativo_manual',true),'')='on'
   AND auth.uid() IS NOT NULL AND public.is_active_tms_user()
   AND public.can_operate_dispatch(OLD.site_id) AND public.delivery_can_read(OLD.id);
 END IF;
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
       RAISE EXCEPTION 'Estado de origen no válido para el cierre operativo'; END IF;
     NEW.daily_cutoff_at:=public.dispatch_cutoff_at(to_jsonb(OLD));
     IF NOT v_manual AND (NEW.daily_cutoff_at IS NULL OR now()<NEW.daily_cutoff_at) THEN
       RAISE EXCEPTION 'El corte operativo se realiza a las 00:00 de Lima'; END IF;
     NEW.operational_closed_at:=CASE WHEN v_manual THEN now() ELSE NEW.daily_cutoff_at END;
     NEW.operational_previous_status:=OLD.status;
   END IF;
 END IF;
 RETURN NEW;
END $$;

-- La liberación conserva la elegibilidad y no modifica una unidad ocupada por otra ruta.
CREATE OR REPLACE FUNCTION public.dispatch_release_own_unit_core(p_dispatch uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.dispatches%ROWTYPE; v_prev text; v_new text; v_elig jsonb;
BEGIN
 SELECT * INTO d FROM public.dispatches WHERE id=p_dispatch;
 IF d.id IS NULL OR d.vehicle_plate IS NULL OR d.vehicle_plate='EXTERNO' OR COALESCE(to_jsonb(d)->>'modalidad','PROPIA')='TERCERO'
  OR EXISTS(SELECT 1 FROM public.dispatches x WHERE x.vehicle_plate=d.vehicle_plate AND x.id<>d.id
   AND x.status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO','ENTREGADO')) THEN RETURN NULL; END IF;
 SELECT status INTO v_prev FROM public.vehicles WHERE plate=d.vehicle_plate FOR UPDATE;
 IF v_prev IS NULL OR v_prev NOT IN ('ASIGNADA','EN_OPERACION','EN_RUTA') THEN RETURN NULL; END IF;
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

-- El evento de corte diario conserva su comportamiento; la operación manual escribe
-- su propia bitácora y no debe emitir un corte automático de las 00:00.
DO $patch$
DECLARE source text; anchor text := 'IF NEW.status<>''CIERRE_OPERATIVO'' OR OLD.status=''CIERRE_OPERATIVO'' THEN RETURN NEW; END IF;';
BEGIN
 source:=pg_get_functiondef('public.dispatch_daily_release_event()'::regprocedure);
 IF position('jrm.cierre_operativo_manual' IN source)>0 THEN RETURN; END IF;
 IF position(anchor IN source)=0 THEN RAISE EXCEPTION 'Liberación diaria no reconocida: revisar antes de migrar'; END IF;
 EXECUTE replace(source,anchor,anchor||E'\n IF COALESCE(current_setting(''jrm.cierre_operativo_manual'',true),'''')=''on'' THEN\n  PERFORM public.dispatch_release_own_unit_core(NEW.id);\n  RETURN NEW;\n END IF;');
END $patch$;

CREATE OR REPLACE FUNCTION public.manual_close_dispatch_operations(p_dispatch uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.dispatches%ROWTYPE; reason text := regexp_replace(COALESCE(p_reason,''),'^\s+|\s+$','','g'); prior_flag text;
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_active_tms_user() THEN RAISE EXCEPTION 'Sin sesión activa' USING ERRCODE='42501'; END IF;
 IF length(reason) NOT BETWEEN 10 AND 500 THEN RAISE EXCEPTION 'Explique el motivo del cierre entre 10 y 500 caracteres'; END IF;
 SELECT * INTO d FROM public.dispatches WHERE id=p_dispatch FOR UPDATE;
 IF d.id IS NULL OR d.site_id IS NULL OR NOT public.can_operate_dispatch(d.site_id) OR NOT public.delivery_can_read(d.id) THEN
  RAISE EXCEPTION 'Sin permiso para cerrar operativamente esta ruta' USING ERRCODE='42501';
 END IF;
 IF d.status IN ('CIERRE_OPERATIVO','RETORNO_COMPLETADO','LIQUIDADO','CERRADO') THEN
  RETURN jsonb_build_object('success',true,'already_closed',true,'status',d.status);
 END IF;
 IF d.status NOT IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO','ENTREGADO') THEN
  RAISE EXCEPTION 'Esta ruta no permite cierre operativo manual';
 END IF;
 prior_flag:=COALESCE(current_setting('jrm.cierre_operativo_manual',true),'off');
 PERFORM set_config('jrm.cierre_operativo_manual','on',true);
 BEGIN
  UPDATE public.dispatches SET status='CIERRE_OPERATIVO' WHERE id=p_dispatch;
  PERFORM set_config('jrm.cierre_operativo_manual',prior_flag,true);
 EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('jrm.cierre_operativo_manual',prior_flag,true);
  RAISE;
 END;
 INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by,created_by_user,created_at,payload)
 VALUES(p_dispatch,'CIERRE_OPERATIVO_MANUAL',
  'Cierre operativo manual registrado ('||d.status||' → CIERRE_OPERATIVO). Documentación y cierre financiero conservan su estado.',
  auth.uid()::text,auth.uid(),now(),jsonb_build_object('source','MANUAL','reason',reason,'previous_status',d.status,
   'status','CIERRE_OPERATIVO','actor_id',auth.uid(),'closed_at',now()));
 RETURN jsonb_build_object('success',true,'already_closed',false,'status','CIERRE_OPERATIVO');
END $$;
REVOKE ALL ON FUNCTION public.dispatch_daily_clock_guard(),public.dispatch_release_own_unit_core(uuid),public.dispatch_daily_release_event() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.manual_close_dispatch_operations(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.manual_close_dispatch_operations(uuid,text) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
