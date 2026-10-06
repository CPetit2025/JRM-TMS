-- FR-DT 007 v01: registro diario independiente de rutas. Fechas de operación en Lima.
CREATE TABLE public.driver_preuse_units (
 driver_id uuid PRIMARY KEY REFERENCES public.drivers(id), vehicle_plate text NOT NULL,
 revision uuid NOT NULL, operation_date date NOT NULL, selected_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.driver_preuse_unit_events (
 revision uuid PRIMARY KEY, event_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE, driver_id uuid NOT NULL REFERENCES public.drivers(id),
 vehicle_plate text NOT NULL, operation_date date NOT NULL, selected_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.driver_preuse_inspections (
 operation_id uuid PRIMARY KEY, record_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE, inspection_id uuid NOT NULL REFERENCES public.inspections(id),
 driver_id uuid NOT NULL REFERENCES public.drivers(id), submitted_by uuid NOT NULL REFERENCES public.profiles(id),
 vehicle_plate text NOT NULL, site_id uuid, unit_revision uuid NOT NULL REFERENCES public.driver_preuse_unit_events(revision),
 operation_date date NOT NULL, captured_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 driver_name text NOT NULL, license text NOT NULL, soat_expiration date NOT NULL, technical_review_expiration date NOT NULL,
 answers jsonb NOT NULL, vehicle_operational boolean NOT NULL, can_operate boolean NOT NULL,
 observation text NOT NULL DEFAULT '', inspector_name text NOT NULL, signature jsonb NOT NULL,
 CHECK(jsonb_array_length(answers)=34), CHECK(length(observation)<=1000), CHECK(length(inspector_name) BETWEEN 1 AND 120)
);
CREATE INDEX driver_preuse_last ON public.driver_preuse_inspections(driver_id,unit_revision,operation_date,captured_at DESC,record_sequence DESC);
CREATE INDEX driver_preuse_export ON public.driver_preuse_inspections(operation_date,site_id);
ALTER TABLE public.driver_preuse_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_preuse_unit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_preuse_inspections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.driver_preuse_units,public.driver_preuse_unit_events,public.driver_preuse_inspections FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.driver_preuse_format() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $format$
 SELECT '{"code": "FR-DT 007", "version": "01", "formatDate": "22.01.14", "title": "INSPECCIÓN DE PRE USO DE VEHÍCULOS LIVIANOS Y PESADOS", "items": [{"code": "i01", "text": "Sistema de Frenos"}, {"code": "i02", "text": "Sistema frenos de estacionamiento"}, {"code": "i03", "text": "Luces delanteras (Izquierda, Derecha)"}, {"code": "i04", "text": "Luces traseras (Izquierda, Derecha)"}, {"code": "i05", "text": "Luces de freno"}, {"code": "i06", "text": "Luces direccionales"}, {"code": "i07", "text": "Luz de retroceso"}, {"code": "i08", "text": "Luces de peligro"}, {"code": "i09", "text": "Nivel combustible"}, {"code": "i10", "text": "Nivel líquido de frenos / Sistema de frenos Aire."}, {"code": "i11", "text": "Nivel de aceite del motor"}, {"code": "i12", "text": "Nivel de agua en radiador"}, {"code": "i13", "text": "Batería/Bornes /Nivel de electrolito"}, {"code": "i14", "text": "Instrumentos del panel / tablero de control"}, {"code": "i15", "text": "Bocina"}, {"code": "i16", "text": "Espejos"}, {"code": "i17", "text": "Funcionamiento Alarma para dar Marcha Atrás"}, {"code": "i18", "text": "Parabrisas (Vidrio no está rajado ni quebrado)"}, {"code": "i19", "text": "Plumillas del parabrisas"}, {"code": "i20", "text": "Dispositivo de radio de comunicación"}, {"code": "i21", "text": "Defensa de la cabina/toldo"}, {"code": "i22", "text": "Asientos firmemente asegurados"}, {"code": "i23", "text": "Cinturones de seguridad en operación"}, {"code": "i24", "text": "Cuñas o Tacos para ruedas"}, {"code": "i25", "text": "Manija de Puertas"}, {"code": "i26", "text": "Llantas/Presión"}, {"code": "i27", "text": "Botiquín de primeros auxilios"}, {"code": "i28", "text": "Herramientas"}, {"code": "i29", "text": "Equipo de remolque"}, {"code": "i30", "text": "Conos de seguridad"}, {"code": "i31", "text": "Extintor"}, {"code": "i32", "text": "Llanta de repuesto"}, {"code": "i33", "text": "Ganchos de Faja"}, {"code": "i34", "text": "Fajas de Amarre"}]}'::jsonb;
$format$;

INSERT INTO public.checklist_templates(name,type,code,requires_odometer,requires_signature,description)
VALUES('FR-DT 007 · Inspección de pre uso de vehículos livianos y pesados','PREOPERACIONAL','FR_DT007',false,false,
 'Formato fijo v01. Registro diario del conductor, con o sin ruta. La firma y campos originales se conservan en el registro FR-DT 007.');
INSERT INTO public.checklist_items(template_id,code,text,is_critical,response_type,position,requires_photo)
SELECT t.id,i->>'code',i->>'text',(i->>'code') IN ('i01','i02','i03','i04','i05','i06','i07','i08','i10','i26'),'TEXT',ord,false
FROM public.checklist_templates t,jsonb_array_elements(public.driver_preuse_format()->'items') WITH ORDINALITY a(i,ord) WHERE t.code='FR_DT007';

-- M conserva su valor original y activa el mismo motor de fallas críticas de inspección.
CREATE OR REPLACE FUNCTION public.is_failing_response(p_response text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT upper(trim(COALESCE(p_response,''))) IN ('NO','FALLO','FAIL','MALO','MAL','M','NOK','NO_OK');
$$;

CREATE FUNCTION public.driver_preuse_fixed_template() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='checklist_templates' THEN
   IF (TG_OP<>'INSERT' AND OLD.code='FR_DT007') OR (TG_OP<>'DELETE' AND NEW.code='FR_DT007') THEN RAISE EXCEPTION 'El formato FR-DT 007 v01 no puede modificarse'; END IF;
 ELSE
   IF EXISTS(SELECT 1 FROM public.checklist_templates WHERE code='FR_DT007' AND id IN (
     CASE WHEN TG_OP<>'INSERT' THEN OLD.template_id END, CASE WHEN TG_OP<>'DELETE' THEN NEW.template_id END)) THEN
     RAISE EXCEPTION 'Los 34 ítems del formato FR-DT 007 v01 no pueden modificarse'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER driver_preuse_fixed_template BEFORE INSERT OR UPDATE OR DELETE ON public.checklist_templates FOR EACH ROW EXECUTE FUNCTION public.driver_preuse_fixed_template();
CREATE TRIGGER driver_preuse_fixed_items BEFORE INSERT OR UPDATE OR DELETE ON public.checklist_items FOR EACH ROW EXECUTE FUNCTION public.driver_preuse_fixed_template();

CREATE FUNCTION public.driver_preuse_select_core(p_driver uuid,p_plate text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE u public.driver_preuse_units; rev uuid; day date:=(now() AT TIME ZONE 'America/Lima')::date;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('driver-preuse:'||p_driver::text,0));
 SELECT * INTO u FROM public.driver_preuse_units WHERE driver_id=p_driver;
 IF u.driver_id IS NULL OR u.vehicle_plate IS DISTINCT FROM p_plate OR u.operation_date IS DISTINCT FROM day THEN
   rev:=gen_random_uuid();
   INSERT INTO public.driver_preuse_unit_events(revision,driver_id,vehicle_plate,operation_date) VALUES(rev,p_driver,p_plate,day);
   INSERT INTO public.driver_preuse_units(driver_id,vehicle_plate,revision,operation_date) VALUES(p_driver,p_plate,rev,day)
   ON CONFLICT(driver_id) DO UPDATE SET vehicle_plate=EXCLUDED.vehicle_plate,revision=EXCLUDED.revision,operation_date=EXCLUDED.operation_date,selected_at=now();
 END IF;
 RETURN (SELECT to_jsonb(x) FROM public.driver_preuse_units x WHERE driver_id=p_driver);
END $$;

CREATE FUNCTION public.select_driver_preuse_unit(p_plate text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE dr uuid; v public.vehicles; v_plate text:=upper(trim(p_plate));
BEGIN
 SELECT d.id INTO dr FROM public.drivers d JOIN public.profiles p ON p.id=d.profile_id WHERE d.profile_id=auth.uid() AND d.is_active AND p.is_active ORDER BY d.id LIMIT 1;
 IF dr IS NULL THEN RAISE EXCEPTION 'No existe un conductor activo asociado a la sesión'; END IF;
 SELECT * INTO v FROM public.vehicles WHERE vehicles.plate=v_plate;
 IF v.id IS NULL OR COALESCE(to_jsonb(v)->>'is_active','true')='false' OR v.type IN ('MONTACARGAS','APILADOR','TRANSPALETA','ELEVADOR') OR
   NOT (public.can_access_site(v.site_id) OR EXISTS(SELECT 1 FROM public.dispatches WHERE driver_id=dr AND vehicle_plate=v_plate AND status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO'))) THEN
   RAISE EXCEPTION 'Unidad no disponible para la sede o programación del conductor';
 END IF;
 RETURN public.driver_preuse_select_core(dr,v_plate);
END $$;

CREATE FUNCTION public.driver_preuse_assignment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.driver_id IS NOT NULL AND NEW.status IN ('PROGRAMADO','EN_CURSO','EN RUTA') AND
   COALESCE(to_jsonb(NEW)->>'modalidad','')<>'TERCERO' AND EXISTS(SELECT 1 FROM public.vehicles WHERE plate=NEW.vehicle_plate)
   AND EXISTS(SELECT 1 FROM public.drivers d JOIN public.profiles p ON p.id=d.profile_id WHERE d.id=NEW.driver_id AND d.is_active AND p.is_active) THEN
   IF TG_OP='INSERT' OR NEW.driver_id IS DISTINCT FROM OLD.driver_id OR NEW.vehicle_plate IS DISTINCT FROM OLD.vehicle_plate THEN
     PERFORM public.driver_preuse_select_core(NEW.driver_id,NEW.vehicle_plate);
   END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER driver_preuse_assignment AFTER INSERT OR UPDATE OF driver_id,vehicle_plate ON public.dispatches FOR EACH ROW EXECUTE FUNCTION public.driver_preuse_assignment();

CREATE FUNCTION public.driver_preuse_can_operate(p_driver uuid,p_plate text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.driver_preuse_inspections; eligibility jsonb;
BEGIN
 SELECT i.* INTO r FROM public.driver_preuse_units u JOIN public.driver_preuse_inspections i ON i.driver_id=u.driver_id AND i.unit_revision=u.revision
 WHERE u.driver_id=p_driver AND u.vehicle_plate=p_plate AND i.vehicle_plate=p_plate AND i.operation_date=(now() AT TIME ZONE 'America/Lima')::date
 ORDER BY i.captured_at DESC,i.record_sequence DESC LIMIT 1;
 IF r.operation_id IS NULL OR NOT r.can_operate OR NOT EXISTS(SELECT 1 FROM public.vehicles WHERE plate=p_plate AND COALESCE(status,'') NOT IN ('BLOQUEADA','INACTIVA','BAJA','EN_MANTENIMIENTO','MANTENIMIENTO')
 AND (public.can_access_site(site_id) OR EXISTS(SELECT 1 FROM public.dispatches WHERE driver_id=p_driver AND vehicle_plate=p_plate AND status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO')))) THEN RETURN false; END IF;
 IF to_regprocedure('public.check_asset_eligibility(text,text)') IS NOT NULL THEN
   EXECUTE 'SELECT public.check_asset_eligibility($1,$2)' INTO eligibility USING p_plate,'OPERATION';
   IF eligibility->>'status'='NO_APTO' THEN RETURN false; END IF;
 END IF; RETURN true;
END $$;

CREATE FUNCTION public.get_driver_preuse_context() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE dr public.drivers; u public.driver_preuse_units; last_check jsonb; v_route_plate text;
BEGIN
 SELECT d.* INTO dr FROM public.drivers d JOIN public.profiles p ON p.id=d.profile_id WHERE d.profile_id=auth.uid() AND d.is_active AND p.is_active ORDER BY d.id LIMIT 1;
 IF dr.id IS NULL THEN RAISE EXCEPTION 'No existe un conductor activo asociado a la sesión'; END IF;
 SELECT vehicle_plate INTO v_route_plate FROM public.dispatches WHERE driver_id=dr.id AND status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO','RETORNO_COMPLETADO') ORDER BY scheduled_departure DESC NULLS LAST LIMIT 1;
 SELECT * INTO u FROM public.driver_preuse_units WHERE driver_id=dr.id;
 SELECT to_jsonb(i) INTO last_check FROM public.driver_preuse_inspections i WHERE i.driver_id=dr.id AND i.unit_revision=u.revision
   AND i.operation_date=(now() AT TIME ZONE 'America/Lima')::date ORDER BY captured_at DESC,record_sequence DESC LIMIT 1;
 RETURN jsonb_build_object('operation_date',(now() AT TIME ZONE 'America/Lima')::date,
 'driver',jsonb_build_object('id',dr.id,'profile_id',dr.profile_id,'name',trim(concat_ws(' ',to_jsonb(dr)->>'first_name',to_jsonb(dr)->>'last_name')),
 'license',trim(concat_ws(' · ',to_jsonb(dr)->>'license_number',to_jsonb(dr)->>'license_category'))),
 'vehicles',COALESCE((SELECT jsonb_agg(jsonb_build_object('plate',v.plate,'soat_expiration',to_jsonb(v)->>'soat_expiration','technical_review_expiration',to_jsonb(v)->>'technical_review_expiration') ORDER BY v.plate)
   FROM public.vehicles v WHERE COALESCE(to_jsonb(v)->>'is_active','true')<>'false' AND COALESCE(v.type,'') NOT IN ('MONTACARGAS','APILADOR','TRANSPALETA','ELEVADOR')
   AND (public.can_access_site(v.site_id) OR v.plate=v_route_plate)), '[]'::jsonb),
 'unit',CASE WHEN u.driver_id IS NULL THEN NULL ELSE to_jsonb(u) END,'latest',last_check,'route_plate',v_route_plate,
 'pending',NOT public.driver_preuse_can_operate(dr.id,COALESCE(v_route_plate,u.vehicle_plate)));
END $$;

CREATE FUNCTION public.submit_driver_preuse(p_operation uuid,p_revision uuid,p_captured_at timestamptz,p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE dr public.drivers; ev public.driver_preuse_unit_events; prior public.driver_preuse_inspections; v public.vehicles;
 item jsonb; answer jsonb; template uuid; insp uuid; critical integer:=0; bad integer:=0; regular integer:=0; operative boolean;
 soat date; rt date; day date; signature jsonb; stroke jsonb; point jsonb; points integer:=0; full_name text;
BEGIN
 SELECT d.* INTO dr FROM public.drivers d JOIN public.profiles p ON p.id=d.profile_id WHERE d.profile_id=auth.uid() AND d.is_active AND p.is_active ORDER BY d.id LIMIT 1;
 IF dr.id IS NULL OR p_operation IS NULL OR p_revision IS NULL THEN RAISE EXCEPTION 'Sesión u operación de inspección no válida'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('driver-preuse:'||dr.id::text,0));
 SELECT * INTO prior FROM public.driver_preuse_inspections WHERE operation_id=p_operation;
 IF prior.operation_id IS NOT NULL THEN
   IF prior.submitted_by<>auth.uid() OR prior.unit_revision<>p_revision OR prior.captured_at IS DISTINCT FROM p_captured_at THEN RAISE EXCEPTION 'La operación pertenece a otro registro'; END IF;
   RETURN jsonb_build_object('success',true,'duplicate',true,'operation_id',p_operation,'can_operate',public.driver_preuse_can_operate(dr.id,prior.vehicle_plate));
 END IF;
 SELECT * INTO ev FROM public.driver_preuse_unit_events WHERE revision=p_revision AND driver_id=dr.id;
 IF ev.revision IS NULL OR p_captured_at IS NULL OR p_captured_at<ev.selected_at-interval '30 seconds' OR p_captured_at<now()-interval '3 days' OR p_captured_at>now()+interval '30 seconds' THEN
   RAISE EXCEPTION 'La fecha o unidad no corresponde a esta inspección. Confirma la unidad y registra el formato vigente'; END IF;
 day:=(p_captured_at AT TIME ZONE 'America/Lima')::date;
 IF day<>ev.operation_date THEN RAISE EXCEPTION 'Cambio de día: confirma la unidad para iniciar una nueva inspección'; END IF;
 SELECT * INTO v FROM public.vehicles WHERE plate=ev.vehicle_plate;
 IF v.id IS NULL THEN RAISE EXCEPTION 'Unidad inexistente'; END IF;
 IF p_data->>'format_code' IS DISTINCT FROM 'FR-DT 007' OR p_data->>'format_version' IS DISTINCT FROM '01' OR jsonb_typeof(p_data->'answers') IS DISTINCT FROM 'array'
   OR jsonb_array_length(p_data->'answers')<>34 OR (SELECT count(DISTINCT a->>'code') FROM jsonb_array_elements(p_data->'answers') a)<>34 THEN
   RAISE EXCEPTION 'Complete los 34 ítems del formato FR-DT 007 v01, sin cambiar sus datos'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(public.driver_preuse_format()->'items') LOOP
   SELECT a INTO answer FROM jsonb_array_elements(p_data->'answers') a WHERE a->>'code'=item->>'code';
   IF answer IS NULL OR COALESCE(answer->>'response','') NOT IN ('B','M','R','N/A') OR jsonb_typeof(answer->'comment') IS DISTINCT FROM 'string' OR length(answer->>'comment')>120 THEN
     RAISE EXCEPTION 'Respuesta o comentario no válido: %',item->>'text'; END IF;
   IF answer->>'response'='M' THEN bad:=bad+1; END IF;
   IF answer->>'response'='R' THEN regular:=regular+1; END IF;
 END LOOP;
 IF NULLIF(trim(p_data->>'license'),'') IS NULL OR length(p_data->>'license')>120 OR
   NULLIF(trim(p_data->>'inspector_name'),'') IS NULL OR length(p_data->>'inspector_name')>120 OR
   jsonb_typeof(p_data->'vehicle_operational') IS DISTINCT FROM 'boolean' OR length(COALESCE(p_data->>'observation',''))>1000 THEN
   RAISE EXCEPTION 'Complete Brevete (Clase/catg), Vehículo Operativo e Inspeccionado por'; END IF;
 BEGIN soat:=(p_data->>'soat_expiration')::date; rt:=(p_data->>'technical_review_expiration')::date;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Fechas de vencimiento SOAT y revisión técnica no válidas'; END;
 IF soat IS NULL OR rt IS NULL THEN RAISE EXCEPTION 'Complete las fechas de vencimiento SOAT y revisión técnica'; END IF;
 signature:=p_data->'signature';
 IF jsonb_typeof(signature) IS DISTINCT FROM 'array' OR jsonb_array_length(signature) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Registre la firma de quien inspecciona'; END IF;
 FOR stroke IN SELECT value FROM jsonb_array_elements(signature) LOOP
   IF jsonb_typeof(stroke) IS DISTINCT FROM 'array' OR jsonb_array_length(stroke)<2 THEN RAISE EXCEPTION 'Firma no válida'; END IF;
   FOR point IN SELECT value FROM jsonb_array_elements(stroke) LOOP
     IF jsonb_typeof(point->'x') IS DISTINCT FROM 'number' OR jsonb_typeof(point->'y') IS DISTINCT FROM 'number' OR
       (point->>'x')::numeric NOT BETWEEN 0 AND 1 OR (point->>'y')::numeric NOT BETWEEN 0 AND 1 THEN RAISE EXCEPTION 'Firma no válida'; END IF;
     points:=points+1;
   END LOOP;
 END LOOP;
 IF points NOT BETWEEN 4 AND 2000 THEN RAISE EXCEPTION 'Registre una firma válida'; END IF;
 operative:=(p_data->>'vehicle_operational')::boolean;
 full_name:=trim(concat_ws(' ',to_jsonb(dr)->>'first_name',to_jsonb(dr)->>'last_name'));
 SELECT id INTO template FROM public.checklist_templates WHERE code='FR_DT007';
 INSERT INTO public.inspections(vehicle_plate,driver_id,template_id,date,inspection_type,notes,source,site_id,created_by,global_result)
 VALUES(v.plate,dr.id,template,p_captured_at,'PREOPERACIONAL',COALESCE(p_data->>'observation',''),'APP',v.site_id,auth.uid(),'PASSED') RETURNING id INTO insp;
 INSERT INTO public.inspection_results(inspection_id,item_id,response,observation)
 SELECT insp,i.id,a->>'response',NULLIF(a->>'comment','') FROM public.checklist_items i JOIN jsonb_array_elements(p_data->'answers') a ON a->>'code'=i.code WHERE i.template_id=template;
 SELECT count(*) INTO critical FROM public.checklist_items i JOIN jsonb_array_elements(p_data->'answers') a ON a->>'code'=i.code WHERE i.template_id=template AND i.is_critical AND a->>'response'='M';
 UPDATE public.inspections SET global_result=CASE WHEN critical>0 THEN 'FAILED' WHEN bad>0 OR regular>0 OR NOT operative OR soat<day OR rt<day THEN 'WARNING' ELSE 'PASSED' END,failed_items=bad,critical_failures=critical WHERE id=insp;
 INSERT INTO public.driver_preuse_inspections(operation_id,inspection_id,driver_id,submitted_by,vehicle_plate,site_id,unit_revision,operation_date,captured_at,
 driver_name,license,soat_expiration,technical_review_expiration,answers,vehicle_operational,can_operate,observation,inspector_name,signature)
 VALUES(p_operation,insp,dr.id,auth.uid(),v.plate,v.site_id,p_revision,day,p_captured_at,full_name,trim(p_data->>'license'),soat,rt,
 p_data->'answers',operative,operative AND bad=0 AND soat>=day AND rt>=day,COALESCE(p_data->>'observation',''),trim(p_data->>'inspector_name'),signature);
 RETURN jsonb_build_object('success',true,'operation_id',p_operation,'can_operate',public.driver_preuse_can_operate(dr.id,v.plate),'critical_failures',critical);
END $$;

CREATE FUNCTION public.list_driver_preuse(p_from date,p_to date,p_search text DEFAULT '') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rows jsonb; total bigint;
BEGIN
 IF NOT (public.is_tms_admin() OR public.has_cmms_read_permission('flota') OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('documentario')) THEN RAISE EXCEPTION 'Solo personal autorizado consulta y exporta el formato FR-DT 007'; END IF;
 IF p_from IS NULL OR p_to IS NULL OR p_to<p_from OR p_to-p_from>366 THEN RAISE EXCEPTION 'Indique un rango de fechas válido (máximo un año)'; END IF;
 SELECT count(*) INTO total FROM public.driver_preuse_inspections i
 WHERE operation_date BETWEEN p_from AND p_to AND (public.is_tms_admin() OR public.can_access_site(site_id))
 AND (COALESCE(trim(p_search),'')='' OR concat_ws(' ',driver_name,vehicle_plate,license) ILIKE '%'||trim(p_search)||'%');
 IF total>2000 THEN RAISE EXCEPTION 'El rango reúne más de 2000 formatos; reduce las fechas o filtra conductor/placa'; END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY operation_date,captured_at,driver_name,vehicle_plate),'[]'::jsonb) INTO rows
 FROM public.driver_preuse_inspections i WHERE operation_date BETWEEN p_from AND p_to AND (public.is_tms_admin() OR public.can_access_site(site_id))
 AND (COALESCE(trim(p_search),'')='' OR concat_ws(' ',driver_name,vehicle_plate,license) ILIKE '%'||trim(p_search)||'%');
 RETURN rows;
END $$;

-- Conserva el indicador de checklist de los viajes, leyendo la inspección
-- vigente al momento real de salida; el registro continúa independiente de la ruta.
CREATE FUNCTION public.driver_preuse_departure_recorded(p_dispatch uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.dispatches; departure timestamptz; revision uuid; r public.driver_preuse_inspections;
BEGIN
 SELECT * INTO d FROM public.dispatches WHERE id=p_dispatch;
 departure:=NULLIF(to_jsonb(d)->>'departure_time','')::timestamptz;
 IF departure IS NULL THEN
  SELECT min(at) INTO departure FROM public.kpi_dispatch_log WHERE dispatch_id=p_dispatch AND estado_nuevo IN ('EN_CURSO','EN CURSO','EN RUTA','EN_RUTA');
 END IF;
 IF departure IS NULL THEN RETURN false; END IF;
 SELECT e.revision INTO revision FROM public.driver_preuse_unit_events e
 WHERE e.driver_id=d.driver_id AND e.selected_at<=departure
 ORDER BY e.selected_at DESC,e.event_sequence DESC LIMIT 1;
 SELECT i.* INTO r FROM public.driver_preuse_inspections i
 WHERE i.driver_id=d.driver_id AND i.vehicle_plate=d.vehicle_plate AND i.unit_revision=revision
 AND i.operation_date=(departure AT TIME ZONE 'America/Lima')::date AND i.captured_at<=departure
 ORDER BY i.captured_at DESC,i.record_sequence DESC LIMIT 1;
 RETURN r.operation_id IS NOT NULL AND r.can_operate;
END $$;
REVOKE ALL ON FUNCTION public.driver_preuse_departure_recorded(uuid) FROM PUBLIC,anon,authenticated;
DO $$
DECLARE fn regprocedure:=to_regprocedure('public.desempeno_calcular(text,uuid,date)'); body text;
 old_clause text:='EXISTS (SELECT 1 FROM public.driver_checklists c WHERE c.dispatch_id = v.id)';
BEGIN
 IF fn IS NOT NULL THEN
  body:=pg_get_functiondef(fn);
  IF strpos(body,old_clause)=0 THEN RAISE EXCEPTION 'No se encontró el cálculo de checklist para integrar FR-DT 007'; END IF;
  body:=replace(body,old_clause,'(public.driver_preuse_departure_recorded(v.id) OR '||old_clause||')');
  EXECUTE body;
 END IF;
END $$;

-- El formato legado de cinco puntos no puede habilitar operaciones ni iniciar una ruta.
CREATE OR REPLACE FUNCTION public.submit_pre_route_checklist(p_dispatch_id uuid,p_vehicle_plate text,p_driver_id uuid,p_odometer numeric,p_checklist_data jsonb,p_location jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('success',false,'message','Formato desactualizado: abre Checklist y registra los 34 ítems del FR-DT 007 para la unidad y el día de operación');
$$;

ALTER FUNCTION public.get_active_trip_context() RENAME TO get_active_trip_context_before_preuse;
CREATE FUNCTION public.get_active_trip_context() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r jsonb; c jsonb;
BEGIN
 r:=public.get_active_trip_context_before_preuse();
 IF r->'driver'->>'id' IS NOT NULL THEN c:=public.get_driver_preuse_context();
   r:=jsonb_set(r,'{pending}',COALESCE(r->'pending','{}'::jsonb)||jsonb_build_object('checklist',c->'pending'));
 END IF; RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.start_dispatch_route(p_dispatch_id uuid,p_lat numeric,p_lon numeric) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.dispatches;
BEGIN
 IF p_lat IS NULL OR p_lon IS NULL OR p_lat NOT BETWEEN -90 AND 90 OR p_lon NOT BETWEEN -180 AND 180 THEN RAISE EXCEPTION 'Coordenadas iniciales inválidas'; END IF;
 SELECT * INTO d FROM public.dispatches WHERE id=p_dispatch_id AND status IN ('PROGRAMADO','EN_CURSO') FOR UPDATE;
 IF d.driver_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.drivers dr JOIN public.profiles p ON p.id=dr.profile_id WHERE dr.id=d.driver_id AND dr.profile_id=auth.uid() AND dr.is_active AND p.is_active) THEN RAISE EXCEPTION 'Ruta no autorizada'; END IF;
 IF NOT public.driver_preuse_can_operate(d.driver_id,d.vehicle_plate) THEN RAISE EXCEPTION 'Complete el FR-DT 007 del día para la unidad actual antes de iniciar la ruta'; END IF;
 UPDATE public.dispatches SET status='EN RUTA',start_lat=p_lat,start_lon=p_lon,departure_time=CASE WHEN d.status='PROGRAMADO' THEN now() ELSE COALESCE(departure_time,now()) END WHERE id=p_dispatch_id;
 UPDATE public.dispatch_requests SET status='EN_CURSO' WHERE dispatch_id=p_dispatch_id AND status='PROGRAMADO';
 UPDATE public.transport_requests SET status='EN TRANSITO' WHERE id IN(SELECT transport_request_id FROM public.dispatch_requests WHERE dispatch_id=p_dispatch_id AND status='EN_CURSO');
END $$;

CREATE FUNCTION public.driver_preuse_driver_start_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.status IN ('EN_CURSO','EN RUTA') AND NEW.status IS DISTINCT FROM OLD.status AND EXISTS(
 SELECT 1 FROM public.drivers WHERE id=NEW.driver_id AND profile_id=auth.uid()) AND NOT public.driver_preuse_can_operate(NEW.driver_id,NEW.vehicle_plate) THEN
   RAISE EXCEPTION 'Complete el FR-DT 007 del día para la unidad actual antes de iniciar operaciones'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER driver_preuse_driver_start_guard BEFORE UPDATE OF status ON public.dispatches FOR EACH ROW EXECUTE FUNCTION public.driver_preuse_driver_start_guard();

REVOKE ALL ON FUNCTION public.driver_preuse_format(),public.driver_preuse_fixed_template(),public.driver_preuse_select_core(uuid,text),public.driver_preuse_assignment(),public.driver_preuse_can_operate(uuid,text),public.driver_preuse_driver_start_guard(),public.get_active_trip_context_before_preuse() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.select_driver_preuse_unit(text),public.get_driver_preuse_context(),public.submit_driver_preuse(uuid,uuid,timestamptz,jsonb),public.list_driver_preuse(date,date,text),public.get_active_trip_context() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.select_driver_preuse_unit(text),public.get_driver_preuse_context(),public.submit_driver_preuse(uuid,uuid,timestamptz,jsonb),public.list_driver_preuse(date,date,text),public.get_active_trip_context() TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.start_dispatch_route(uuid,numeric,numeric),public.submit_pre_route_checklist(uuid,text,uuid,numeric,jsonb,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.start_dispatch_route(uuid,numeric,numeric),public.submit_pre_route_checklist(uuid,text,uuid,numeric,jsonb,jsonb) TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
