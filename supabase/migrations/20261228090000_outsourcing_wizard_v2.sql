-- V2: JSON estructurado compatible con fichas previas; conserva las ocho etapas y el libro económico existente.
-- Necesidad: validación en servidor de campos nuevos, envío atómico, revisión/cancelación y reapertura por id.
BEGIN;
ALTER TABLE public.transport_outsourcing ADD COLUMN review_status text NOT NULL DEFAULT 'ACTIVE' CHECK(review_status IN ('ACTIVE','OBSERVED','CANCELLED'));
ALTER TABLE public.transport_outsourcing ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE public.transport_outsourcing_quotes ADD COLUMN spec_revision integer NOT NULL DEFAULT 1 CHECK(spec_revision>0);

CREATE FUNCTION public.outsourcing_v2_validate(p jsonb) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE errors text[]:='{}'; config jsonb:= '{"general":[{"key":"required_at","label":"Fecha y hora requerida","type":"datetime-local"},{"key":"pickup","label":"Lugar de recojo"},{"key":"delivery","label":"Lugar de entrega"},{"key":"responsible","label":"Responsable de la solicitud"}],"transport":[{"key":"unit_type","label":"Tipo de unidad","type":"select","options":["Camión","Plataforma","Tráiler","Furgón","Camión baranda","Otros"]},{"key":"unit_count","label":"Cantidad de unidades requeridas","type":"number","integer":true},{"key":"unit_other","label":"Especifique otro tipo de unidad","optional":true},{"key":"length_m","label":"Largo útil mínimo (m)","type":"number"},{"key":"width_m","label":"Ancho útil mínimo (m)","type":"number"},{"key":"height_m","label":"Alto útil mínimo (m)","type":"number"},{"key":"capacity_t","label":"Capacidad mínima por unidad (t)","type":"number"},{"key":"cargo_weight_kg","label":"Peso total de mercancía (kg)","type":"number"},{"key":"volume_m3","label":"Volumen requerido (m³)","type":"number"},{"key":"cargo_quantity","label":"Cantidad total de bultos","type":"number","integer":true},{"key":"cargo","label":"Descripción de la mercancía","type":"textarea"},{"key":"packaging","label":"Tipo de embalaje"},{"key":"special_conditions","label":"Permisos especiales, sujeción y protección (o No aplica)","type":"textarea"},{"key":"traffic_restrictions","label":"Restricciones de circulación (o No aplica)"},{"key":"technical_notes","label":"Observaciones técnicas","type":"textarea","optional":true}],"operation":[{"key":"loading_start","label":"Inicio de ventana de carga","type":"datetime-local"},{"key":"loading_end","label":"Fin de ventana de carga","type":"datetime-local"},{"key":"unloading_start","label":"Inicio de ventana de descarga","type":"datetime-local"},{"key":"unloading_end","label":"Fin de ventana de descarga","type":"datetime-local"},{"key":"loading_window","label":"Ventana horaria de carga / indicaciones"},{"key":"unloading_window","label":"Ventana horaria de descarga / indicaciones"},{"key":"duration_hours","label":"Tiempo estimado de operación (horas)","type":"number"},{"key":"schedule_restrictions","label":"Restricciones de horario (o No aplica)"},{"key":"attention_at","label":"Fecha y hora de atención adicional","type":"datetime-local","optional":true},{"key":"entry_requirements","label":"Requisitos de ingreso a planta u obra","type":"textarea"},{"key":"site_requirements","label":"Requisitos particulares de obra","optional":true},{"key":"access","label":"Condiciones de acceso","type":"textarea"},{"key":"destination_zone","label":"Ámbito del destino","type":"select","options":["Lima","Provincia","Otro"]},{"key":"destination_conditions","label":"Condiciones particulares del destino (o No aplica)","type":"textarea"},{"key":"max_access_height","label":"Altura máxima de acceso (m)","type":"number","optional":true},{"key":"dimension_restrictions","label":"Restricciones de dimensiones","optional":true},{"key":"maneuver_conditions","label":"Condiciones de maniobra","optional":true},{"key":"delivery_conditions","label":"Condiciones especiales del punto de entrega","optional":true},{"key":"documents","label":"Documentación obligatoria / requisitos generales","type":"textarea"},{"key":"documents_supplier","label":"Documentación del proveedor"},{"key":"documents_vehicle","label":"Documentación de la unidad"},{"key":"documents_driver","label":"Documentación del conductor"},{"key":"documents_operators","label":"Documentación de operadores (o No aplica)"},{"key":"documents_personnel","label":"Documentación de personal complementario (o No aplica)"},{"key":"safety","label":"EPP y condiciones de seguridad","type":"textarea"},{"key":"inductions","label":"Inducciones y requisitos especiales (o No aplica)"},{"key":"notes","label":"Observaciones e instrucciones especiales para Compras","type":"textarea","optional":true}],"services":{"MONTACARGAS":[{"key":"quantity","label":"Cantidad","type":"number","integer":true},{"key":"capacity","label":"Capacidad requerida (t)","type":"number","integer":false},{"key":"height","label":"Altura de elevación (m)","type":"number","integer":false},{"key":"type","label":"Tipo de montacargas","optional":true},{"key":"operation_place","label":"Lugar de operación","type":"select","options":["Carga","Descarga","Ambos"]},{"key":"at","label":"Fecha y hora","type":"datetime-local"},{"key":"hours","label":"Horas estimadas","type":"number","integer":false},{"key":"operator","label":"Operador","type":"select","options":["Incluido","Requerido por separado"]}],"GRUA":[{"key":"quantity","label":"Cantidad","type":"number","integer":true},{"key":"type","label":"Tipo de grúa","optional":false},{"key":"capacity","label":"Capacidad nominal (t)","type":"number","integer":false},{"key":"load_kg","label":"Peso de la carga a izar (kg)","type":"number","integer":false},{"key":"reach","label":"Alcance requerido (m)","type":"number","integer":false},{"key":"lift_height","label":"Altura de izaje (m), si corresponde","type":"number","integer":false,"optional":true},{"key":"maneuver","label":"Tipo y condiciones de maniobra","optional":false},{"key":"location","label":"Ubicación","optional":false},{"key":"at","label":"Fecha y hora","type":"datetime-local"},{"key":"hours","label":"Tiempo estimado (horas)","type":"number","integer":false},{"key":"operator","label":"Operador","type":"select","options":["Incluido","Requerido por separado"]},{"key":"accessories","label":"Accesorios de izaje","optional":false}],"STOCKA":[{"key":"type","label":"Tipo de stocka / transpaleta","optional":false},{"key":"quantity","label":"Cantidad","type":"number","integer":true},{"key":"capacity","label":"Capacidad (t)","type":"number","integer":false},{"key":"location","label":"Lugar de uso","optional":false},{"key":"hours","label":"Tiempo estimado (horas)","type":"number","integer":false},{"key":"characteristics","label":"Piso, acceso y características requeridas","optional":false}],"ESTIBA":[{"key":"workers","label":"Cantidad de trabajadores","type":"number","integer":true},{"key":"operation_place","label":"Lugar de operación","type":"select","options":["Carga","Descarga","Ambos"]},{"key":"location","label":"Lugar","optional":false},{"key":"at","label":"Fecha y hora","type":"datetime-local"},{"key":"schedule","label":"Horario","optional":false},{"key":"hours","label":"Duración estimada (horas)","type":"number","integer":false},{"key":"activities","label":"Actividades de estiba / desestiba","optional":false},{"key":"safety","label":"Requisitos de seguridad","optional":false}],"OTROS":[{"key":"resource","label":"Descripción del recurso","optional":false},{"key":"quantity","label":"Cantidad","type":"number","integer":false},{"key":"unit","label":"Unidad de medida","optional":false},{"key":"schedule","label":"Horario","optional":false}]}}'::jsonb; f jsonb; s jsonb; b jsonb; k text; v text; n numeric;
 qty numeric:=0; weight numeric:=0; volume numeric:=0; fields jsonb;
BEGIN
 IF p->>'schema_version' IS DISTINCT FROM '2' THEN RETURN ARRAY['Revise y complete la ficha en el asistente de cinco pasos antes de enviarla.']; END IF;
 IF jsonb_typeof(p->'services') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'packages') IS DISTINCT FROM 'array'
 OR jsonb_typeof(p->'intermediate_stops') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'attachments') IS DISTINCT FROM 'array' THEN RETURN ARRAY['Las listas de servicios, bultos, puntos o adjuntos son inválidas.']; END IF;
 fields:=(config->'general')||(config->'transport')||(config->'operation');
 FOR f IN SELECT value FROM jsonb_array_elements(fields) LOOP
  v:=btrim(coalesce(p->>(f->>'key'),''));
  IF v='' THEN
   IF coalesce((f->>'optional')::boolean,false) IS NOT TRUE THEN errors:=array_append(errors,'Complete '||(f->>'label')||'.'); END IF;
  ELSE
   IF f->>'type'='number' THEN
    BEGIN n:=v::numeric;
     IF n<=0 OR n>100000000 OR (coalesce((f->>'integer')::boolean,false) AND n<>trunc(n)) THEN errors:=array_append(errors,(f->>'label')||': valor positivo válido requerido (cantidades enteras).'); END IF;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN errors:=array_append(errors,(f->>'label')||': número inválido.'); END;
   ELSIF f->>'type'='datetime-local' THEN
    BEGIN IF NOT isfinite(v::timestamptz) OR v !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?-05:00$' THEN errors:=array_append(errors,(f->>'label')||': fecha inválida; use la zona horaria de Lima.'); END IF;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN errors:=array_append(errors,(f->>'label')||': fecha inválida.'); END;
   END IF;
   IF f ? 'options' AND NOT (f->'options' ? v) THEN errors:=array_append(errors,(f->>'label')||': opción inválida.'); END IF;
  END IF;
 END LOOP;
 IF p->>'unit_type'='Otros' AND length(btrim(coalesce(p->>'unit_other','')))=0 THEN errors:=array_append(errors,'Especifique el otro tipo de unidad.'); END IF;
 IF NOT p->>'priority'=ANY(ARRAY['NORMAL','ALTA','URGENTE']) THEN errors:=array_append(errors,'Seleccione una prioridad válida.'); END IF;
 IF jsonb_array_length(p->'intermediate_stops')=0 AND btrim(coalesce(p->>'intermediate_points',''))='' THEN errors:=array_append(errors,'Indique puntos intermedios o No aplica.'); END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(p->'intermediate_stops') LOOP
  IF length(btrim(coalesce(s->>'address','')))=0 THEN errors:=array_append(errors,'Complete la dirección de cada punto intermedio.'); END IF;
 END LOOP;
 IF jsonb_array_length(p->'packages')=0 THEN errors:=array_append(errors,'Registre al menos una fila de detalle de bultos.'); END IF;
 FOR b IN SELECT value FROM jsonb_array_elements(p->'packages') LOOP
  IF length(btrim(coalesce(b->>'kind','')))=0 THEN errors:=array_append(errors,'Indique el tipo de cada bulto.'); END IF;
  FOREACH k IN ARRAY ARRAY['quantity','length_m','width_m','height_m','weight_kg'] LOOP
   BEGIN n:=coalesce(nullif(b->>k,''),'0')::numeric;
    IF n<=0 OR n>100000000 OR (k='quantity' AND n<>trunc(n)) THEN errors:=array_append(errors,'Bultos: '||k||' debe ser positivo; las cantidades deben ser enteras.'); END IF;
   EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN errors:=array_append(errors,'Bultos: '||k||' no es un número válido.'); END;
  END LOOP;
 END LOOP;
 IF jsonb_array_length(p->'services')=0 AND p->>'services_confirmed' IS DISTINCT FROM 'true' THEN errors:=array_append(errors,'Confirme si requiere servicios complementarios.'); END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(p->'services') LOOP
  IF NOT (config->'services' ? (s->>'kind')) OR s->>'kind' IS NULL THEN errors:=array_append(errors,'Servicio complementario inválido.'); CONTINUE; END IF;
  FOR f IN SELECT value FROM jsonb_array_elements(config->'services'->(s->>'kind')) LOOP
   v:=btrim(coalesce(s->'details'->>(f->>'key'),''));
   IF v='' THEN
    IF coalesce((f->>'optional')::boolean,false) IS NOT TRUE THEN errors:=array_append(errors,(s->>'kind')||': complete '||(f->>'label')||'.'); END IF;
   ELSE
    IF f->>'type'='number' THEN
     BEGIN n:=v::numeric;
      IF n<=0 OR n>100000000 OR (coalesce((f->>'integer')::boolean,false) AND n<>trunc(n)) THEN errors:=array_append(errors,(s->>'kind')||': '||(f->>'label')||' debe ser positivo (cantidades enteras).'); END IF;
     EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN errors:=array_append(errors,(s->>'kind')||': número inválido en '||(f->>'label')); END;
    ELSIF f->>'type'='datetime-local' THEN
     BEGIN IF NOT isfinite(v::timestamptz) OR v !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?-05:00$' THEN errors:=array_append(errors,(s->>'kind')||': fecha inválida, use Lima.'); END IF;
     EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN errors:=array_append(errors,(s->>'kind')||': fecha inválida.'); END;
    END IF;
    IF f ? 'options' AND NOT (f->'options' ? v) THEN errors:=array_append(errors,(s->>'kind')||': opción inválida en '||(f->>'label')); END IF;
   END IF;
  END LOOP;
  IF length(btrim(coalesce(s->>'requirements','')))<5 THEN errors:=array_append(errors,(s->>'kind')||': complete los requisitos particulares (mínimo 5 caracteres).'); END IF;
 END LOOP;
 IF p->>'technical_access'='true' AND coalesce(nullif(p->>'max_access_height',''),nullif(p->>'dimension_restrictions',''),nullif(p->>'maneuver_conditions',''),nullif(p->>'delivery_conditions','')) IS NULL THEN errors:=array_append(errors,'Describa al menos una restricción técnica adicional de acceso.'); END IF;
 -- No convertir valores corruptos antes de devolver errores de formato.
 IF cardinality(errors)>0 THEN RETURN errors; END IF;
 SELECT coalesce(sum((x->>'quantity')::numeric),0),coalesce(sum((x->>'quantity')::numeric*(x->>'weight_kg')::numeric),0),
 coalesce(sum((x->>'quantity')::numeric*(x->>'length_m')::numeric*(x->>'width_m')::numeric*(x->>'height_m')::numeric),0)
 INTO qty,weight,volume FROM jsonb_array_elements(p->'packages') x;
 IF qty<>(p->>'cargo_quantity')::numeric THEN errors:=array_append(errors,'La cantidad consolidada no coincide con el detalle de bultos.'); END IF;
 IF abs(weight-(p->>'cargo_weight_kg')::numeric)>greatest(0.01,(p->>'cargo_weight_kg')::numeric*0.01) THEN errors:=array_append(errors,'El peso consolidado no coincide con el detalle de bultos (tolerancia 1 %).'); END IF;
 IF abs(volume-(p->>'volume_m3')::numeric)>greatest(0.001,(p->>'volume_m3')::numeric*0.01) THEN errors:=array_append(errors,'El volumen consolidado no coincide con el detalle de bultos (tolerancia 1 %).'); END IF;
 IF (p->>'cargo_weight_kg')::numeric>(p->>'capacity_t')::numeric*(p->>'unit_count')::numeric*1000 THEN errors:=array_append(errors,'El peso total supera la capacidad conjunta de las unidades.'); END IF;
 IF (p->>'loading_start')::timestamptz>=(p->>'loading_end')::timestamptz OR (p->>'unloading_start')::timestamptz>=(p->>'unloading_end')::timestamptz THEN errors:=array_append(errors,'El fin de cada ventana debe ser posterior al inicio.'); END IF;
 IF (p->>'unloading_start')::timestamptz<(p->>'loading_start')::timestamptz THEN errors:=array_append(errors,'La descarga no puede comenzar antes de la carga.'); END IF;
 IF (p->>'required_at')::timestamptz NOT BETWEEN (p->>'loading_start')::timestamptz AND (p->>'loading_end')::timestamptz THEN errors:=array_append(errors,'La fecha requerida debe estar dentro de la ventana de carga.'); END IF;
 IF nullif(p->>'max_access_height','') IS NOT NULL AND (p->>'height_m')::numeric>(p->>'max_access_height')::numeric THEN errors:=array_append(errors,'El alto útil excede la altura de acceso declarada; revise las dimensiones totales con el proveedor.'); END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(p->'services') WHERE value->>'kind'='GRUA' LOOP
  IF (s->'details'->>'load_kg')::numeric>(s->'details'->>'capacity')::numeric*1000 THEN errors:=array_append(errors,'El peso a izar supera la capacidad nominal de la grúa.'); END IF;
 END LOOP;
 FOR s IN SELECT value FROM jsonb_array_elements(p->'services') WHERE nullif(value->'details'->>'at','') IS NOT NULL LOOP
  IF (s->'details'->>'at')::timestamptz NOT BETWEEN (p->>(CASE WHEN s->'details'->>'operation_place'='Descarga' THEN 'unloading_start' ELSE 'loading_start' END))::timestamptz
   AND (p->>(CASE WHEN s->'details'->>'operation_place'='Carga' THEN 'loading_end' ELSE 'unloading_end' END))::timestamptz THEN errors:=array_append(errors,(s->>'kind')||': la atención debe estar dentro de las ventanas operativas de su lugar de operación.'); END IF;
 END LOOP;
 RETURN errors;
END $$;
REVOKE ALL ON FUNCTION public.outsourcing_v2_validate(jsonb) FROM PUBLIC,anon,authenticated;

ALTER FUNCTION public.outsourcing_save(uuid,jsonb,integer) RENAME TO outsourcing_save_v1;
ALTER FUNCTION public.outsourcing_transition(uuid,integer,integer,text,text,uuid[],uuid) RENAME TO outsourcing_transition_v1;
ALTER FUNCTION public.outsourcing_add_quote(uuid,text,uuid,numeric,text,text) RENAME TO outsourcing_add_quote_v1;
REVOKE ALL ON FUNCTION public.outsourcing_save_v1(uuid,jsonb,integer),public.outsourcing_transition_v1(uuid,integer,integer,text,text,uuid[],uuid),public.outsourcing_add_quote_v1(uuid,text,uuid,numeric,text,text) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.outsourcing_save(p_request uuid,p_spec jsonb,p_version integer DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.transport_outsourcing; v_id uuid; a jsonb; k text;
BEGIN
 IF NOT public.outsourcing_can_read(p_request) OR NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Sin permiso para editar'; END IF;
 PERFORM 1 FROM public.transport_requests WHERE id=p_request FOR UPDATE;
 SELECT * INTO o FROM public.transport_outsourcing WHERE request_id=p_request FOR UPDATE;
 IF o.review_status='CANCELLED' THEN RAISE EXCEPTION 'La solicitud está cancelada'; END IF;
 IF jsonb_typeof(p_spec->'services') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Lista de servicios inválida'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_spec->'services') s WHERE jsonb_typeof(s)<>'object' OR s->>'kind' IS NULL OR s->>'kind' NOT IN ('MONTACARGAS','GRUA','STOCKA','ESTIBA','OTROS')) THEN RAISE EXCEPTION 'Servicio complementario inválido'; END IF;
 FOREACH k IN ARRAY ARRAY['packages','intermediate_stops','attachments'] LOOP
  IF p_spec ? k THEN
   IF jsonb_typeof(p_spec->k) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Lista inválida: %',k; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_spec->k) x WHERE jsonb_typeof(x)<>'object') THEN RAISE EXCEPTION 'Registro inválido en %',k; END IF;
  END IF;
 END LOOP;
 v_id:=public.outsourcing_save_v1(p_request,p_spec,p_version);
 FOR a IN SELECT value FROM jsonb_array_elements(coalesce(p_spec->'attachments','[]'::jsonb)) LOOP
  IF split_part(a->>'path','/',1) IS DISTINCT FROM v_id::text OR NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='outsourcing' AND name=a->>'path') THEN RAISE EXCEPTION 'Adjunto inválido o no disponible'; END IF;
 END LOOP;
 RETURN v_id;
END $$;

CREATE FUNCTION public.outsourcing_transition(p_id uuid,p_version integer,p_next integer,p_note text,p_evidence text DEFAULT NULL,p_quotes uuid[] DEFAULT '{}',p_dispatch uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.transport_outsourcing; errors text[]; a jsonb;
BEGIN
 SELECT * INTO o FROM public.transport_outsourcing WHERE id=p_id;
 IF o.id IS NULL OR NOT public.outsourcing_can_read(o.request_id) THEN RAISE EXCEPTION 'Sin acceso'; END IF;
 PERFORM 1 FROM public.transport_requests WHERE id=o.request_id FOR UPDATE;
 SELECT * INTO o FROM public.transport_outsourcing WHERE id=p_id FOR UPDATE;
 IF o.review_status='CANCELLED' THEN RAISE EXCEPTION 'La solicitud está cancelada'; END IF;
 IF o.version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'La solicitud cambió; actualice antes de continuar'; END IF;
 IF p_next=1 THEN
  IF NOT EXISTS(SELECT 1 FROM public.transport_requests t LEFT JOIN public.contracts c ON c.id=t.contract_id LEFT JOIN public.clients cl ON cl.id=coalesce(nullif(to_jsonb(t)->>'client_id','')::uuid,c.client_id) WHERE t.id=o.request_id AND cl.id IS NOT NULL) THEN RAISE EXCEPTION 'Vincule un cliente real a la solicitud o a su OT antes de enviar'; END IF;
  errors:=public.outsourcing_v2_validate(o.specification);
  IF cardinality(errors)>0 THEN RAISE EXCEPTION '%',array_to_string(errors,' | '); END IF;
  FOR a IN SELECT value FROM jsonb_array_elements(o.specification->'attachments') LOOP
   IF split_part(a->>'path','/',1) IS DISTINCT FROM o.id::text OR NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='outsourcing' AND name=a->>'path') THEN RAISE EXCEPTION 'Adjunto inválido o no disponible'; END IF;
  END LOOP;
 END IF;
 IF p_next=3 AND EXISTS(SELECT 1 FROM public.transport_outsourcing_quotes WHERE id=ANY(p_quotes) AND (outsourcing_id<>p_id OR spec_revision<>o.revision)) THEN RAISE EXCEPTION 'Seleccione cotizaciones de la revisión técnica vigente'; END IF;
 PERFORM public.outsourcing_transition_v1(p_id,p_version,p_next,p_note,p_evidence,p_quotes,p_dispatch);
 IF p_next=1 THEN UPDATE public.transport_outsourcing SET review_status='ACTIVE' WHERE id=p_id; END IF;
END $$;

CREATE FUNCTION public.outsourcing_add_quote(p_id uuid,p_service text,p_supplier uuid,p_amount numeric,p_terms text,p_evidence text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.transport_outsourcing; q uuid;
BEGIN
 SELECT * INTO o FROM public.transport_outsourcing WHERE id=p_id FOR UPDATE;
 IF o.id IS NULL OR NOT public.outsourcing_can_read(o.request_id) OR NOT public.has_tms_permission('compras-tercerizaciones') THEN RAISE EXCEPTION 'Sin permiso para cotizar'; END IF;
 IF o.review_status IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'La solicitud no está activa'; END IF;
 q:=public.outsourcing_add_quote_v1(p_id,p_service,p_supplier,p_amount,p_terms,p_evidence);
 UPDATE public.transport_outsourcing_quotes SET spec_revision=o.revision WHERE id=q;
 RETURN q;
END $$;

INSERT INTO public.notif_reglas(evento,categoria,descripcion,severidad,permisos,al_solicitante)
 VALUES('TERCERIZACION_ENVIADA','DESPACHO','Requerimiento técnico recibido por Compras','info',ARRAY['compras-tercerizaciones'],false)
 ON CONFLICT(evento) DO NOTHING;
CREATE FUNCTION public.outsourcing_submit(p_request uuid,p_spec jsonb,p_version integer,p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid; o public.transport_outsourcing;
BEGIN
 v_id:=public.outsourcing_save(p_request,p_spec,p_version);
 SELECT * INTO o FROM public.transport_outsourcing WHERE id=v_id FOR UPDATE;
 PERFORM public.outsourcing_transition(v_id,o.version,1,p_note);
 -- Recepción real: la misma transacción publica en la bandeja de Compras y registra el historial.
 -- La campana utiliza las preferencias y reglas de notificación ya instaladas.
 PERFORM public.notif_emit('TERCERIZACION_ENVIADA','outsourcing:'||v_id::text||':revision:'||o.revision,'Solicitud de tercerización recibida','Hay un nuevo requerimiento técnico para gestionar.', '/despacho/tercerizaciones?solicitud='||v_id::text,NULL);
 SELECT * INTO o FROM public.transport_outsourcing WHERE id=v_id;
 RETURN to_jsonb(o);
END $$;

CREATE FUNCTION public.outsourcing_review(p_id uuid,p_version integer,p_action text,p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.transport_outsourcing; actor text;
BEGIN
 SELECT * INTO o FROM public.transport_outsourcing WHERE id=p_id;
 IF o.id IS NULL OR NOT public.outsourcing_can_read(o.request_id) THEN RAISE EXCEPTION 'Sin acceso'; END IF;
 PERFORM 1 FROM public.transport_requests WHERE id=o.request_id FOR UPDATE;
 SELECT * INTO o FROM public.transport_outsourcing WHERE id=p_id FOR UPDATE;
 IF o.version IS DISTINCT FROM p_version OR o.review_status='CANCELLED' THEN RAISE EXCEPTION 'La solicitud cambió o está cancelada'; END IF;
 IF length(btrim(coalesce(p_note,'')))<5 THEN RAISE EXCEPTION 'Registre el motivo (mínimo 5 caracteres)'; END IF;
 IF p_action='OBSERVE' THEN
  IF o.stage NOT BETWEEN 1 AND 3 OR NOT (CASE WHEN o.stage=3 THEN public.has_tms_permission('compras-aprobar') ELSE public.has_tms_permission('compras-tercerizaciones') END) THEN RAISE EXCEPTION 'Sin permiso para observar esta etapa'; END IF;
  UPDATE public.transport_outsourcing SET stage=0,review_status='OBSERVED',revision=revision+1,version=version+1,updated_at=now() WHERE id=p_id;
  UPDATE public.transport_outsourcing_quotes SET selected=false WHERE outsourcing_id=p_id;
 ELSIF p_action='CANCEL' THEN
  IF o.stage>=5 OR o.dispatch_id IS NOT NULL OR NOT (CASE WHEN o.stage=0 THEN public.has_tms_permission('despacho') WHEN o.stage<=2 THEN public.has_tms_permission('compras-tercerizaciones') ELSE public.has_tms_permission('compras-aprobar') END) THEN RAISE EXCEPTION 'Sin permiso para cancelar esta etapa; los servicios confirmados requieren gestionar primero su despacho'; END IF;
  UPDATE public.transport_outsourcing SET review_status='CANCELLED',version=version+1,updated_at=now() WHERE id=p_id;
 ELSE RAISE EXCEPTION 'Acción inválida'; END IF;
 SELECT coalesce(to_jsonb(p)->>'full_name',to_jsonb(p)->>'name',nullif(concat_ws(' ',to_jsonb(p)->>'first_name',to_jsonb(p)->>'last_name'),''),auth.uid()::text) INTO actor FROM public.profiles p WHERE p.id=auth.uid();
 INSERT INTO public.transport_outsourcing_events(outsourcing_id,stage,actor_id,actor_name,note,snapshot)
 VALUES(p_id,CASE WHEN p_action='OBSERVE' THEN 0 ELSE o.stage END,auth.uid(),coalesce(actor,auth.uid()::text),p_note,jsonb_build_object('action',p_action,'previous',to_jsonb(o),'revision',o.revision));
END $$;

CREATE OR REPLACE FUNCTION public.outsourcing_queue() RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT to_jsonb(o) || jsonb_build_object('transport_requests', jsonb_build_object('request_number',t.request_number,'contract_id',t.contract_id,
 'contracts',jsonb_build_object('code',c.code)), 'client',coalesce(rc.business_name,cl.business_name))
 FROM public.transport_outsourcing o JOIN public.transport_requests t ON t.id=o.request_id
 LEFT JOIN public.contracts c ON c.id=t.contract_id LEFT JOIN public.clients cl ON cl.id=c.client_id
 LEFT JOIN public.clients rc ON rc.id=nullif(to_jsonb(t)->>'client_id','')::uuid
 WHERE public.outsourcing_can_read(o.request_id) ORDER BY o.updated_at DESC LIMIT 500;
$$;
REVOKE ALL ON FUNCTION public.outsourcing_queue() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.outsourcing_queue() TO authenticated;

CREATE FUNCTION public.outsourcing_form_context(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.transport_outsourcing; context jsonb;
BEGIN
 SELECT * INTO o FROM public.transport_outsourcing WHERE id=p_id;
 IF o.id IS NULL OR NOT public.outsourcing_can_read(o.request_id) THEN RAISE EXCEPTION 'Sin acceso'; END IF;
 SELECT jsonb_build_object('id',t.id,'request_number',t.request_number,'requester_name',to_jsonb(t)->>'requester_name',
 'pickup_address',to_jsonb(t)->>'pickup_address','delivery_address',to_jsonb(t)->>'delivery_address','required_at',to_jsonb(t)->>'required_at','required_date',to_jsonb(t)->>'required_date','time_window',to_jsonb(t)->>'time_window',
 'contract_id',t.contract_id,'estimated_weight',to_jsonb(t)->'estimated_weight','status',t.status,
 'contracts',jsonb_build_object('id',c.id,'code',c.code,'clients',jsonb_build_object('business_name',cl.business_name)),
 'request_client',jsonb_build_object('business_name',coalesce(rc.business_name,cl.business_name)),
 'transport_request_items',(SELECT coalesce(jsonb_agg(jsonb_build_object('description',to_jsonb(i)->>'description','weight',i.weight,'volume_m3',i.volume_m3,'quantity',i.quantity)),'[]') FROM public.transport_request_items i WHERE i.transport_request_id=t.id))
 INTO context FROM public.transport_requests t LEFT JOIN public.contracts c ON c.id=t.contract_id LEFT JOIN public.clients cl ON cl.id=c.client_id
 LEFT JOIN public.clients rc ON rc.id=nullif(to_jsonb(t)->>'client_id','')::uuid WHERE t.id=o.request_id;
 RETURN jsonb_build_object('record',to_jsonb(o),'request',context,'observation',(SELECT note FROM public.transport_outsourcing_events e WHERE e.outsourcing_id=p_id AND e.snapshot->>'action'='OBSERVE' ORDER BY e.created_at DESC LIMIT 1));
END $$;

REVOKE ALL ON FUNCTION public.outsourcing_save(uuid,jsonb,integer),public.outsourcing_transition(uuid,integer,integer,text,text,uuid[],uuid),public.outsourcing_add_quote(uuid,text,uuid,numeric,text,text),public.outsourcing_submit(uuid,jsonb,integer,text),public.outsourcing_review(uuid,integer,text,text),public.outsourcing_form_context(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.outsourcing_save(uuid,jsonb,integer),public.outsourcing_transition(uuid,integer,integer,text,text,uuid[],uuid),public.outsourcing_add_quote(uuid,text,uuid,numeric,text,text),public.outsourcing_submit(uuid,jsonb,integer,text),public.outsourcing_review(uuid,integer,text,text),public.outsourcing_form_context(uuid) TO authenticated;
CREATE OR REPLACE FUNCTION public.outsourcing_request_ot_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.transport_outsourcing WHERE request_id=OLD.id AND (stage>0 OR review_status<>'ACTIVE')) THEN
  RAISE EXCEPTION 'La OT está vinculada a una tercerización enviada, observada o cancelada';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.outsourcing_request_ot_guard() FROM PUBLIC,anon,authenticated;
DROP POLICY outsourcing_files_insert ON storage.objects;
CREATE POLICY outsourcing_files_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK(bucket_id='outsourcing' AND EXISTS(SELECT 1 FROM public.transport_outsourcing o WHERE o.id::text=split_part(name,'/',1)
 AND o.stage<7 AND o.review_status<>'CANCELLED' AND (public.has_tms_permission('despacho') OR public.has_tms_permission('compras-tercerizaciones') OR public.has_tms_permission('compras-aprobar') OR public.has_tms_permission('cierre-economico'))));
-- Mantener intactos los adjuntos, revisiones y cotizaciones históricas; no se duplica ningún compromiso económico.
COMMIT;
