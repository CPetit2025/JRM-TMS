-- Apply exclusively to an isolated WMS database through the WMS pipeline.
-- Additive schema; previously issued package codes and quantities are preserved.
BEGIN;
REVOKE ALL ON public.wh_receipt_import_runs FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.wh_receipt_sources FROM PUBLIC,anon,authenticated;
CREATE POLICY security_active_account ON public.wh_receipt_import_runs AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
CREATE POLICY security_active_account ON public.wh_receipt_sources AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
CREATE SEQUENCE IF NOT EXISTS public.wh_package_label_number;
ALTER TABLE public.wh_receipt_validations ADD COLUMN IF NOT EXISTS resolved_customer_name text;
ALTER TABLE public.wh_receipt_validations ADD COLUMN IF NOT EXISTS source_snapshot jsonb;
CREATE OR REPLACE FUNCTION public.wh_receipt_fingerprint(s public.wh_receipt_sources) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_array(s.source_key,s.site_id,s.document_no,s.quantity,s.product_code,s.lot,s.unit,s.warehouse,s.source_date,s.contract_code,s.origin_number,s.customer_name,s.description,s.total_weight,s.active)
$$;
ALTER TABLE public.wh_packages ADD COLUMN IF NOT EXISTS source_customer_name text;
ALTER TABLE public.wh_packages ADD COLUMN IF NOT EXISTS receipt_validation_id uuid REFERENCES public.wh_receipt_validations(id);

CREATE OR REPLACE FUNCTION public.wh_label_packages(p_receipt_key text,p_quantities numeric[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_site uuid:=public.primary_site_id(); s public.wh_receipt_sources%ROWTYPE;
 v public.wh_receipt_validations%ROWTYPE; quantities numeric[]; result jsonb; codes jsonb;
 n integer; i integer; version integer; package_id uuid; label_number text; customer text; contract_id uuid;
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor'])
   OR v_site IS NULL OR NOT public.can_access_site(v_site) THEN RAISE EXCEPTION 'Sin permiso de etiquetado' USING ERRCODE='42501'; END IF;
 IF nullif(trim(p_receipt_key),'') IS NULL OR coalesce(cardinality(p_quantities),0) NOT BETWEEN 1 AND 100
   OR array_ndims(p_quantities)<>1 OR array_lower(p_quantities,1)<>1 THEN RAISE EXCEPTION 'Distribución de paquetes inválida'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(p_quantities) q WHERE q IS NULL OR q<=0 OR q::text IN ('NaN','Infinity','-Infinity') OR q<>round(q,3)) THEN
   RAISE EXCEPTION 'Cada paquete requiere una cantidad positiva de hasta tres decimales'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_receipt_key,0));
 SELECT * INTO s FROM public.wh_receipt_sources WHERE source_key=p_receipt_key AND site_id=v_site AND active;
 IF NOT FOUND THEN RAISE EXCEPTION 'Ingreso no disponible en este almacén'; END IF;
 SELECT * INTO v FROM public.wh_receipt_validations WHERE source_movement_key=p_receipt_key AND site_id=v_site ORDER BY validated_at DESC,id DESC LIMIT 1;
 IF NOT FOUND OR v.erp_quantity<>s.quantity OR v.source_snapshot IS DISTINCT FROM public.wh_receipt_fingerprint(s) THEN RAISE EXCEPTION 'Confirme la cantidad física vigente antes de generar etiquetas'; END IF;
 IF v.physical_quantity<=0 OR (SELECT sum(q) FROM unnest(p_quantities) q)<>v.physical_quantity THEN
   RAISE EXCEPTION 'La distribución debe conservar exactamente la cantidad física validada'; END IF;
 SELECT array_agg(quantity ORDER BY sequence_no),max(source_label_version) INTO quantities,version
 FROM public.wh_packages WHERE source_movement_key=p_receipt_key AND site_id=v_site AND status<>'VOID';
 IF quantities IS NOT NULL THEN
   IF quantities<>p_quantities OR EXISTS(SELECT 1 FROM public.wh_packages WHERE source_movement_key=p_receipt_key AND source_label_version=version AND status='VOID') THEN
     RAISE EXCEPTION 'Ya existen etiquetas para otra distribución; no se modificarán los bultos emitidos'; END IF;
 ELSE
   IF EXISTS(SELECT 1 FROM public.wh_packages WHERE source_movement_key=p_receipt_key) AND NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN
     RAISE EXCEPTION 'Solo supervisión puede regenerar etiquetas anuladas'; END IF;
   SELECT coalesce(max(source_label_version),0)+1 INTO version FROM public.wh_packages WHERE source_movement_key=p_receipt_key;
   customer:=coalesce(nullif(v.resolved_customer_name,''),nullif(s.customer_name,''),nullif(v.manual_customer_name,''));
   SELECT c.id INTO contract_id FROM public.contracts c WHERE c.code=coalesce(nullif(s.contract_code,''),nullif(s.origin_number,''),s.lot) ORDER BY c.id LIMIT 1;
   n:=cardinality(p_quantities);
   FOR i IN 1..n LOOP
     package_id:=gen_random_uuid();
     label_number:=nextval('public.wh_package_label_number')::text;
     INSERT INTO public.wh_packages(id,package_code,source_document_no,source_contract_code,source_lot,source_product_code,
       source_unit,source_warehouse,source_date,source_movement_key,source_label_version,source_key,site_id,contract_id,
       description,quantity,unit,weight_kg,sequence_no,sequence_total,source_qty_snapshot,source_expected_total,source_expected_count,
       created_by,source_customer_name,receipt_validation_id)
     VALUES(package_id,'LPN-'||to_char(now() AT TIME ZONE 'America/Lima','YYYYMMDD')||'-'||lpad(label_number,greatest(6,length(label_number)),'0'),s.document_no,
       coalesce(nullif(s.contract_code,''),nullif(s.origin_number,''),s.lot),coalesce(s.lot,''),s.product_code,coalesce(s.unit,''),s.warehouse,
       s.source_date,p_receipt_key,version,p_receipt_key||':'||version||':'||i,v_site,contract_id,
       coalesce(s.description,s.product_code),p_quantities[i],s.unit,
       CASE WHEN s.total_weight IS NOT NULL AND s.quantity>0 THEN round(s.total_weight*p_quantities[i]/s.quantity,3) END,
       i,n,p_quantities[i],v.physical_quantity,n,auth.uid(),customer,v.id);
   END LOOP;
   INSERT INTO public.wh_scan_events(site_id,event_type,scanned_code,payload,operator_id,client_event_id)
   VALUES(v_site,'LABELS_GENERATED',s.document_no,jsonb_build_object('receipt_key',p_receipt_key,'quantities',p_quantities,'validation_id',v.id),auth.uid(),gen_random_uuid());
 END IF;
 SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object('contract_code',p.source_contract_code,'customer_name',p.source_customer_name) ORDER BY p.sequence_no),
   jsonb_agg(p.package_code ORDER BY p.sequence_no) INTO result,codes
 FROM public.wh_packages p WHERE p.source_movement_key=p_receipt_key AND p.site_id=v_site AND p.status<>'VOID';
 RETURN jsonb_build_object('labels',result,'package_codes',codes,'count',jsonb_array_length(codes));
END $$;

-- Preserve the old RPC signature while making every generation path immutable and idempotent.
CREATE OR REPLACE FUNCTION public.wh_label_package(p_receipt_key text,p_package_count integer,p_units_per_package numeric DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE total numeric; remaining numeric; amounts numeric[]:='{}'; amount numeric; i integer;
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso de etiquetado' USING ERRCODE='42501'; END IF;
 IF p_package_count IS NULL OR p_package_count NOT BETWEEN 1 AND 100 OR (p_units_per_package IS NOT NULL AND (p_units_per_package<=0 OR p_units_per_package::text IN ('NaN','Infinity','-Infinity'))) THEN RAISE EXCEPTION 'Distribución inválida'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_receipt_key,0));
 SELECT physical_quantity INTO total FROM public.wh_receipt_validations WHERE source_movement_key=p_receipt_key AND site_id=public.primary_site_id() ORDER BY validated_at DESC,id DESC LIMIT 1;
 IF total IS NULL OR total<=0 THEN RAISE EXCEPTION 'Confirme la cantidad física antes de generar etiquetas'; END IF;
 IF p_units_per_package IS NOT NULL AND ceil(total/p_units_per_package)<>p_package_count THEN RAISE EXCEPTION 'El número de paquetes no coincide con la capacidad'; END IF;
 remaining:=total;
 FOR i IN 1..p_package_count LOOP
   amount:=CASE WHEN p_units_per_package IS NOT NULL THEN least(p_units_per_package,remaining) WHEN i=p_package_count THEN remaining ELSE round(total/p_package_count,3) END;
   amounts:=array_append(amounts,amount); remaining:=remaining-amount;
 END LOOP;
 RETURN public.wh_label_packages(p_receipt_key,amounts);
END $$;

CREATE OR REPLACE FUNCTION public.wh_preserve_labeled_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(OLD.source_key,0));
 IF (NEW.source_key,NEW.site_id,NEW.document_no,NEW.quantity,NEW.product_code,NEW.lot,NEW.warehouse,NEW.source_date,NEW.contract_code,NEW.origin_number,NEW.customer_name,NEW.description,NEW.total_weight,NEW.unit,NEW.active)
   IS DISTINCT FROM (OLD.source_key,OLD.site_id,OLD.document_no,OLD.quantity,OLD.product_code,OLD.lot,OLD.warehouse,OLD.source_date,OLD.contract_code,OLD.origin_number,OLD.customer_name,OLD.description,OLD.total_weight,OLD.unit,OLD.active)
   AND EXISTS(SELECT 1 FROM public.wh_packages WHERE source_movement_key=OLD.source_key AND status<>'VOID') THEN
   RAISE EXCEPTION 'IPT % ya tiene etiquetas: concilie el cambio con supervisión antes de reimportar',OLD.document_no;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wh_preserve_labeled_source BEFORE UPDATE ON public.wh_receipt_sources FOR EACH ROW EXECUTE FUNCTION public.wh_preserve_labeled_source();

GRANT SELECT ON public.wh_receipt_import_runs TO authenticated;
CREATE POLICY wh_receipt_import_history ON public.wh_receipt_import_runs FOR SELECT TO authenticated USING (
 public.wh_has_permission(ARRAY['almacen-carga','almacen-supervisor']) AND (imported_by=auth.uid() OR EXISTS(
 SELECT 1 FROM public.wh_receipt_sources s WHERE s.source_import_hash=file_hash AND public.can_access_site(s.site_id))));
-- The history policy queries source lineage through its own scoped read policy.
GRANT SELECT ON public.wh_receipt_sources TO authenticated;
CREATE POLICY wh_receipt_sources_history ON public.wh_receipt_sources FOR SELECT TO authenticated USING (
 public.can_access_site(site_id) AND public.wh_has_permission(ARRAY['almacen-carga','almacen-etiquetado','almacen-supervisor']));
REVOKE ALL ON FUNCTION public.wh_label_packages(text,numeric[]),public.wh_preserve_labeled_source() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.wh_label_packages(text,numeric[]) TO authenticated;
CREATE OR REPLACE FUNCTION public.wh_validate_receipt(p_receipt_key text,p_physical_quantity numeric,p_variance_reason text DEFAULT NULL,p_manual_customer_name text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_site uuid:=public.primary_site_id(); v_receipt record; v_customer text; v_reason text:=nullif(trim(p_variance_reason),''); v_manual text:=nullif(trim(p_manual_customer_name),'');
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para validar la recepción APT' USING ERRCODE='42501'; END IF;
 IF v_site IS NULL OR NOT public.can_access_site(v_site) OR p_physical_quantity IS NULL OR p_physical_quantity<0 OR p_physical_quantity::text IN ('NaN','Infinity','-Infinity') OR p_physical_quantity<>round(p_physical_quantity,3) OR nullif(trim(p_receipt_key),'') IS NULL THEN RAISE EXCEPTION 'Cantidad física o ingreso IPT inválido'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_receipt_key,0));
 SELECT s.source_key AS receipt_key,s.document_no,s.source_date AS fecha,s.lot AS lote,s.product_code,s.description,s.unit,s.warehouse AS bodega,
  coalesce(nullif(s.contract_code,''),nullif(s.origin_number,''),s.lot) AS contract_code,s.customer_name,s.quantity
 INTO v_receipt FROM public.wh_receipt_sources s WHERE s.source_key=p_receipt_key AND s.active AND s.site_id=v_site;
 IF NOT FOUND OR v_receipt.quantity<=0 THEN RAISE EXCEPTION 'El IPT no existe en el actualizable WMS vigente'; END IF;
 IF EXISTS(SELECT 1 FROM public.wh_packages WHERE source_movement_key=p_receipt_key AND status<>'VOID') THEN RAISE EXCEPTION 'La recepción ya tiene etiquetas; no se puede volver a validar sin anularlas'; END IF;
 WITH RECURSIVE matches AS (
  SELECT c.id,c.code,c.client_id,c.parent_contract_id,
   CASE
    WHEN regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(v_receipt.contract_code),'[^A-Z0-9]','','g'),'^OT','') THEN 1
    WHEN regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(v_receipt.lote),'[^A-Z0-9]','','g'),'^OT','') THEN 2
    WHEN regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(public.inv_ot(v_receipt.contract_code)),'[^A-Z0-9]','','g'),'^OT','') THEN 3
    WHEN regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(public.inv_ot(v_receipt.lote)),'[^A-Z0-9]','','g'),'^OT','') THEN 4
    WHEN regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(public.apt_ot_raiz(v_receipt.lote)),'[^A-Z0-9]','','g'),'^OT','') THEN 5
    ELSE 6 END AS match_priority
  FROM public.contracts c
  WHERE regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','') IN (
    regexp_replace(regexp_replace(upper(v_receipt.contract_code),'[^A-Z0-9]','','g'),'^OT',''),
    regexp_replace(regexp_replace(upper(v_receipt.lote),'[^A-Z0-9]','','g'),'^OT',''),
    regexp_replace(regexp_replace(upper(public.inv_ot(v_receipt.contract_code)),'[^A-Z0-9]','','g'),'^OT',''),
    regexp_replace(regexp_replace(upper(public.inv_ot(v_receipt.lote)),'[^A-Z0-9]','','g'),'^OT',''),
    regexp_replace(regexp_replace(upper(public.apt_ot_raiz(v_receipt.lote)),'[^A-Z0-9]','','g'),'^OT','')
  )
  OR (
    coalesce(nullif(public.apt_ot_raiz(v_receipt.lote),''),nullif(public.inv_ot(v_receipt.lote),''),nullif(public.apt_ot_raiz(v_receipt.contract_code),''),nullif(public.inv_ot(v_receipt.contract_code),'')) IS NOT NULL
    AND public.apt_ot_raiz(c.code::text)=coalesce(nullif(public.apt_ot_raiz(v_receipt.lote),''),nullif(public.inv_ot(v_receipt.lote),''),nullif(public.apt_ot_raiz(v_receipt.contract_code),''),nullif(public.inv_ot(v_receipt.contract_code),''))
  )
 ),
 ancestors AS (
  SELECT m.id,m.client_id,m.parent_contract_id,m.match_priority,0 AS depth FROM matches m
  UNION ALL
  SELECT parent.id,parent.client_id,parent.parent_contract_id,a.match_priority,a.depth+1
  FROM public.contracts parent JOIN ancestors a ON parent.id=a.parent_contract_id
  WHERE a.depth<20
 )
 SELECT nullif(cl.business_name,'') INTO v_customer
 FROM ancestors a JOIN public.clients cl ON cl.id=a.client_id
 WHERE nullif(cl.business_name,'') IS NOT NULL
 ORDER BY a.match_priority,a.depth,a.id
 LIMIT 1;
 v_customer:=coalesce(nullif(v_receipt.customer_name,''),v_customer,nullif(public.inv_ot_cliente(nullif(public.apt_ot_raiz(v_receipt.lote),'')),''),nullif(public.inv_ot_cliente(nullif(public.inv_ot(v_receipt.contract_code),'')),''));
 IF v_customer IS NULL AND v_manual IS NULL THEN RAISE EXCEPTION 'No se encontró el cliente por OT/contrato; registre el nombre manualmente'; END IF;
 IF v_reason IS NULL AND EXISTS(SELECT 1 FROM (SELECT physical_quantity FROM public.wh_receipt_validations WHERE source_movement_key=p_receipt_key AND site_id=v_site ORDER BY validated_at DESC,id DESC LIMIT 1) previous WHERE previous.physical_quantity<>p_physical_quantity) THEN RAISE EXCEPTION 'Registre el motivo del cambio de cantidad física'; END IF;
 IF p_physical_quantity<>v_receipt.quantity AND v_reason IS NULL THEN RAISE EXCEPTION 'Registre el motivo de la diferencia entre el ERP y el conteo físico'; END IF;
 INSERT INTO public.wh_receipt_validations(source_movement_key,site_id,erp_quantity,physical_quantity,variance_reason,manual_customer_name,validated_by,resolved_customer_name,source_snapshot)
 VALUES(p_receipt_key,v_site,v_receipt.quantity,p_physical_quantity,v_reason,CASE WHEN v_customer IS NULL THEN v_manual END,auth.uid(),coalesce(v_customer,v_manual),(SELECT public.wh_receipt_fingerprint(src) FROM public.wh_receipt_sources src WHERE src.source_key=p_receipt_key AND src.site_id=v_site));
 INSERT INTO public.wh_scan_events(site_id,event_type,scanned_code,payload,operator_id,client_event_id)
 VALUES(v_site,'RECEIPT_VALIDATED',v_receipt.document_no,jsonb_build_object('receipt_key',p_receipt_key,'erp_quantity',v_receipt.quantity,'physical_quantity',p_physical_quantity,'variance_reason',v_reason),auth.uid(),gen_random_uuid());
 RETURN jsonb_build_object('receipt_key',p_receipt_key,'document_no',v_receipt.document_no,'erp_quantity',v_receipt.quantity,'physical_quantity',p_physical_quantity,
  'variance',p_physical_quantity-v_receipt.quantity,'customer_name',coalesce(v_customer,v_manual),'customer_source',CASE WHEN nullif(v_receipt.customer_name,'') IS NOT NULL THEN 'EXCEL' WHEN v_customer IS NULL THEN 'MANUAL' ELSE 'ERP/OT' END,'validated',true);
END $$;
CREATE OR REPLACE FUNCTION public.wh_confirm_label_print(p_package_codes text[],p_reason text,p_event_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_site uuid:=public.primary_site_id(); codes text[]; payload jsonb; previous jsonb; p public.wh_packages%ROWTYPE;
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) OR NOT public.can_access_site(v_site) THEN RAISE EXCEPTION 'Sin permiso para confirmar impresión' USING ERRCODE='42501'; END IF;
 IF p_event_id IS NULL OR coalesce(cardinality(p_package_codes),0) NOT BETWEEN 1 AND 100 OR EXISTS(SELECT 1 FROM unnest(p_package_codes) c WHERE nullif(trim(c),'') IS NULL) THEN RAISE EXCEPTION 'Confirmación de impresión inválida'; END IF;
 SELECT array_agg(trim(c) ORDER BY trim(c)) INTO codes FROM unnest(p_package_codes) c;
 IF cardinality(codes)<>(SELECT count(DISTINCT c) FROM unnest(codes) c) THEN RAISE EXCEPTION 'El lote contiene códigos duplicados'; END IF;
 payload:=jsonb_build_object('codes',codes,'reason',nullif(trim(p_reason),''));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_event_id::text,0));
 SELECT e.payload INTO previous FROM public.wh_scan_events e WHERE e.site_id=v_site AND e.client_event_id=p_event_id;
 IF FOUND THEN
   IF previous<>payload THEN RAISE EXCEPTION 'Identificador de confirmación reutilizado para otra operación'; END IF;
   RETURN jsonb_build_object('confirmed',cardinality(codes),'duplicate',true);
 END IF;
 -- Consistent lock order prevents two batches locking their package rows in opposite order.
 FOR p IN SELECT * FROM public.wh_packages WHERE package_code=ANY(codes) AND site_id=v_site ORDER BY package_code FOR UPDATE LOOP
   IF p.status='VOID' THEN RAISE EXCEPTION 'Etiqueta anulada'; END IF;
   IF p.label_print_count>0 AND nullif(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'La reimpresión requiere motivo'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.wh_packages WHERE package_code=ANY(codes) AND site_id=v_site)<>cardinality(codes) THEN RAISE EXCEPTION 'Etiqueta no disponible en este almacén'; END IF;
 FOR p IN SELECT * FROM public.wh_packages WHERE package_code=ANY(codes) AND site_id=v_site ORDER BY package_code LOOP
   UPDATE public.wh_packages SET label_print_count=label_print_count+1 WHERE id=p.id;
   INSERT INTO public.wh_scan_events(site_id,task_id,package_id,event_type,scanned_code,payload,operator_id,client_event_id)
   VALUES(v_site,p.task_id,p.id,CASE WHEN p.label_print_count>0 THEN 'LABEL_REPRINT' ELSE 'LABEL_PRINT' END,p.package_code,
     jsonb_build_object('reason',nullif(trim(p_reason),''),'confirmation_id',p_event_id,'previous_print_count',p.label_print_count),auth.uid(),gen_random_uuid());
 END LOOP;
 INSERT INTO public.wh_scan_events(site_id,event_type,scanned_code,payload,operator_id,client_event_id)
 VALUES(v_site,'LABEL_PRINT_CONFIRMED',p_event_id::text,payload,auth.uid(),p_event_id);
 RETURN jsonb_build_object('confirmed',cardinality(codes),'duplicate',false);
END $$;
REVOKE ALL ON FUNCTION public.wh_confirm_label_print(text[],text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.wh_confirm_label_print(text[],text,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.wh_receipt_candidates(p_query text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q text:=trim(coalesce(p_query,'')); result jsonb; missing_source_columns text[];
BEGIN
 PERFORM public.security_assert_active_session();
 SELECT array_agg(required.column_name ORDER BY required.column_name)
 INTO missing_source_columns
 FROM unnest(ARRAY['source_key','document_no','source_date','product_code','quantity']) AS required(column_name)
 WHERE NOT EXISTS (
   SELECT 1 FROM information_schema.columns c
   WHERE c.table_schema='public' AND c.table_name='wh_receipt_sources' AND c.column_name=required.column_name
 );
 IF cardinality(missing_source_columns)>0 THEN
   RAISE EXCEPTION 'Faltan columnas requeridas en wh_receipt_sources: %',array_to_string(missing_source_columns,', ');
 END IF;
 IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) THEN
  RAISE EXCEPTION 'Sin permiso para consultar recepciones APT' USING ERRCODE='42501';
 END IF;
 IF length(q)>0 AND length(q)<2 THEN RAISE EXCEPTION 'Ingrese dos o más caracteres para buscar'; END IF;

 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.fecha DESC,x.document_no,x.product_code),'[]'::jsonb)
 INTO result
 FROM (
  SELECT r.*,c.id AS contract_id,customer.customer_name,customer.customer_source,
   v.physical_quantity,v.variance,v.variance_reason,
   CASE WHEN v.id IS NULL THEN 'PENDING' WHEN v.erp_quantity<>r.quantity OR v.source_snapshot IS DISTINCT FROM (SELECT public.wh_receipt_fingerprint(ss) FROM public.wh_receipt_sources ss WHERE ss.source_key=r.receipt_key) THEN 'STALE' ELSE 'VALIDATED' END AS validation_status,
   coalesce(p.label_count,0) AS label_count,coalesce(p.labeled_qty,0) AS labeled_qty,
   coalesce(p.unprinted_count,0) AS unprinted_count,
   coalesce(p.pending_labels,'[]'::jsonb) AS pending_labels,
   CASE
    WHEN coalesce(p.label_count,0)=0 THEN 'NOT_LABELED'
    WHEN coalesce(p.unprinted_count,0)>0 THEN 'PENDING_PRINT'
    WHEN p.labeled_qty=coalesce(v.physical_quantity,r.quantity) AND p.expected_count=p.label_count THEN 'MATCH'
    ELSE 'DIFFERENCE'
   END AS label_status
  FROM (
   SELECT src.j->>'source_key' AS receipt_key,
    src.j->>'document_no' AS document_no,
    nullif(src.j->>'source_date','')::date AS fecha,
    src.j->>'document_type' AS document_type,
    src.j->>'color' AS color,
    nullif(src.j->>'source_updated_at','')::timestamptz AS source_updated_at,
    src.j->>'lot' AS lote,
    src.j->>'product_code' AS product_code,
    src.j->>'description' AS description,
    src.j->>'unit' AS unit,
    src.j->>'warehouse' AS bodega,
    coalesce(nullif(src.j->>'contract_code',''),nullif(src.j->>'origin_number',''),src.j->>'lot') AS contract_code,
    src.j->>'customer_name' AS customer_name,
    nullif(src.j->>'quantity','')::numeric AS quantity,
    nullif(src.j->>'total_weight','')::numeric AS weight_kg
   FROM public.wh_receipt_sources s
   CROSS JOIN LATERAL (SELECT to_jsonb(s) AS j) src
   WHERE coalesce(nullif(src.j->>'active','')::boolean,true) AND s.site_id=public.primary_site_id() AND public.can_access_site(s.site_id)
  ) r
  LEFT JOIN LATERAL (
   WITH RECURSIVE matches AS (
    SELECT c.id,c.code,c.client_id,c.parent_contract_id,
     CASE
      WHEN regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(r.contract_code),'[^A-Z0-9]','','g'),'^OT','') THEN 1
      WHEN regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(r.lote),'[^A-Z0-9]','','g'),'^OT','') THEN 2
      WHEN regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(public.inv_ot(r.contract_code)),'[^A-Z0-9]','','g'),'^OT','') THEN 3
      WHEN regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(public.inv_ot(r.lote)),'[^A-Z0-9]','','g'),'^OT','') THEN 4
      WHEN regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(public.apt_ot_raiz(r.lote)),'[^A-Z0-9]','','g'),'^OT','') THEN 5
      ELSE 6 END AS match_priority
    FROM public.contracts c
    WHERE regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','') IN (
      regexp_replace(regexp_replace(upper(r.contract_code),'[^A-Z0-9]','','g'),'^OT',''),
      regexp_replace(regexp_replace(upper(r.lote),'[^A-Z0-9]','','g'),'^OT',''),
      regexp_replace(regexp_replace(upper(public.inv_ot(r.contract_code)),'[^A-Z0-9]','','g'),'^OT',''),
      regexp_replace(regexp_replace(upper(public.inv_ot(r.lote)),'[^A-Z0-9]','','g'),'^OT',''),
      regexp_replace(regexp_replace(upper(public.apt_ot_raiz(r.lote)),'[^A-Z0-9]','','g'),'^OT','')
    )
    OR (
      coalesce(nullif(public.apt_ot_raiz(r.lote),''),nullif(public.inv_ot(r.lote),''),nullif(public.apt_ot_raiz(r.contract_code),''),nullif(public.inv_ot(r.contract_code),'')) IS NOT NULL
      AND public.apt_ot_raiz(c.code::text)=coalesce(nullif(public.apt_ot_raiz(r.lote),''),nullif(public.inv_ot(r.lote),''),nullif(public.apt_ot_raiz(r.contract_code),''),nullif(public.inv_ot(r.contract_code),''))
    )
   ),
   ancestors AS (
    SELECT m.id,m.client_id,m.parent_contract_id,m.match_priority,0 AS depth FROM matches m
    UNION ALL
    SELECT parent.id,parent.client_id,parent.parent_contract_id,a.match_priority,a.depth+1
    FROM public.contracts parent JOIN ancestors a ON parent.id=a.parent_contract_id
    WHERE a.depth<20
   )
   SELECT a.id,nullif(cl.business_name,'') AS customer_name
   FROM ancestors a JOIN public.clients cl ON cl.id=a.client_id
   WHERE nullif(cl.business_name,'') IS NOT NULL
   ORDER BY a.match_priority,a.depth,a.id
   LIMIT 1
  ) c ON true
  LEFT JOIN LATERAL (
   SELECT rv.* FROM public.wh_receipt_validations rv
   WHERE rv.source_movement_key=r.receipt_key ORDER BY rv.validated_at DESC,rv.id DESC LIMIT 1
  ) v ON true
  LEFT JOIN LATERAL (
   SELECT nullif(public.inv_ot_cliente(nullif(public.apt_ot_raiz(r.lote),'')),'') AS lot_customer,
    nullif(public.inv_ot_cliente(nullif(public.inv_ot(r.contract_code),'')),'') AS contract_customer
  ) lookup ON true
  LEFT JOIN LATERAL (
   SELECT coalesce(nullif(r.customer_name,''),nullif(c.customer_name,''),lookup.lot_customer,lookup.contract_customer,nullif(v.manual_customer_name,'')) AS customer_name,
    CASE WHEN nullif(r.customer_name,'') IS NOT NULL THEN 'EXCEL'
      WHEN nullif(c.customer_name,'') IS NOT NULL OR lookup.lot_customer IS NOT NULL OR lookup.contract_customer IS NOT NULL THEN 'ERP/OT'
      WHEN nullif(v.manual_customer_name,'') IS NOT NULL THEN 'MANUAL' ELSE NULL END AS customer_source
  ) customer ON true
  LEFT JOIN LATERAL (
   SELECT count(*)::integer AS label_count,round(sum(wp.quantity),3) AS labeled_qty,
    max(wp.source_expected_count) AS expected_count,
    count(*) FILTER (WHERE wp.label_print_count=0)::integer AS unprinted_count,
    jsonb_agg(jsonb_build_object(
      'package_code',wp.package_code,
      'source_document_no',wp.source_document_no,
      'source_lot',wp.source_lot,
      'source_product_code',wp.source_product_code,
      'description',wp.description,
      'quantity',wp.quantity,
      'weight_kg',wp.weight_kg,
      'unit',wp.unit,
      'sequence_no',wp.sequence_no,
      'sequence_total',wp.sequence_total,
      'source_warehouse',wp.source_warehouse,
      'source_date',wp.source_date,
      'contract_code',wp.source_contract_code,
      'customer_name',coalesce(wp.source_customer_name,customer.customer_name,'Cliente por registrar')
    ) ORDER BY wp.sequence_no) FILTER (WHERE wp.label_print_count=0) AS pending_labels
   FROM public.wh_packages wp
   WHERE wp.source_movement_key=r.receipt_key AND wp.status<>'VOID'
  ) p ON true
  WHERE
   ((q='' AND (coalesce(p.label_count,0)=0 OR coalesce(p.unprinted_count,0)>0))
    OR (q<>'' AND (r.document_no ILIKE '%'||q||'%' OR coalesce(r.lote,'') ILIKE '%'||q||'%'
      OR r.product_code ILIKE '%'||q||'%' OR coalesce(r.description,'') ILIKE '%'||q||'%'
      OR coalesce(r.contract_code,'') ILIKE '%'||q||'%' OR coalesce(customer.customer_name,'') ILIKE '%'||q||'%')))
  ORDER BY (r.document_no=q) DESC,r.fecha DESC,r.document_no,r.product_code
  LIMIT 5000
 ) x;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.wh_print_labels(p_package_codes text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p public.wh_packages%ROWTYPE; pending text[]:='{}'; seen integer:=0;
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso de impresión' USING ERRCODE='42501'; END IF;
 IF coalesce(cardinality(p_package_codes),0) NOT BETWEEN 1 AND 100 OR cardinality(p_package_codes)<>(SELECT count(DISTINCT c) FROM unnest(p_package_codes) c) THEN RAISE EXCEPTION 'Lote inválido'; END IF;
 FOR p IN SELECT * FROM public.wh_packages WHERE package_code=ANY(p_package_codes) AND site_id=public.primary_site_id() AND status<>'VOID' ORDER BY package_code FOR UPDATE LOOP
  seen:=seen+1; IF p.label_print_count=0 THEN pending:=array_append(pending,p.package_code); END IF;
 END LOOP;
 IF seen<>cardinality(p_package_codes) OR NOT public.can_access_site(public.primary_site_id()) THEN RAISE EXCEPTION 'Etiqueta no disponible'; END IF;
 IF cardinality(pending)=0 THEN RETURN jsonb_build_object('printed',0,'duplicate',true); END IF;
 PERFORM public.wh_confirm_label_print(pending,NULL,gen_random_uuid());
 RETURN jsonb_build_object('printed',cardinality(pending));
END $$;

CREATE OR REPLACE FUNCTION public.wh_record_import_attempt(p_attempt_id uuid,p_file_name text,p_file_hash text,p_import_hash text,p_status text,p_rows_read integer,p_error text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_site uuid:=public.primary_site_id(); v_payload jsonb; previous jsonb; accepted integer:=0;
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-carga','almacen-supervisor']) OR NOT public.can_access_site(v_site) THEN RAISE EXCEPTION 'Sin permiso para auditar importaciones' USING ERRCODE='42501'; END IF;
 IF p_attempt_id IS NULL OR nullif(trim(p_file_name),'') IS NULL OR length(p_file_name)>255 OR p_status NOT IN ('ACCEPTED','DUPLICATE','REJECTED') OR p_status IS NULL
   OR (p_file_hash IS NOT NULL AND p_file_hash !~ '^[a-f0-9]{64}$') OR (p_rows_read IS NOT NULL AND p_rows_read<0) THEN RAISE EXCEPTION 'Intento de importación inválido'; END IF;
 IF p_status IN ('ACCEPTED','DUPLICATE') THEN
   SELECT row_count INTO accepted FROM public.wh_receipt_import_runs WHERE file_hash=p_import_hash;
   IF NOT FOUND THEN RAISE EXCEPTION 'No existe la importación confirmada'; END IF;
   IF p_status='DUPLICATE' THEN accepted:=0; END IF;
 ELSIF nullif(trim(p_error),'') IS NULL THEN RAISE EXCEPTION 'El rechazo requiere motivo'; END IF;
 v_payload:=jsonb_build_object('file_name',trim(p_file_name),'file_hash',p_file_hash,'import_hash',p_import_hash,'status',p_status,
   'rows_read',p_rows_read,'rows_accepted',accepted,'rows_rejected',CASE WHEN p_status='REJECTED' THEN p_rows_read ELSE 0 END,'reason',left(p_error,1000));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_attempt_id::text,0));
 SELECT payload INTO previous FROM public.wh_scan_events WHERE site_id=v_site AND client_event_id=p_attempt_id;
 IF FOUND THEN
  IF previous<>v_payload THEN RAISE EXCEPTION 'Identificador de intento reutilizado'; END IF;
  RETURN jsonb_build_object('recorded',true,'duplicate',true);
 END IF;
 INSERT INTO public.wh_scan_events(site_id,event_type,scanned_code,payload,operator_id,client_event_id)
 VALUES(v_site,'IMPORT_'||p_status,trim(p_file_name),v_payload,auth.uid(),p_attempt_id);
 RETURN jsonb_build_object('recorded',true);
END $$;
REVOKE ALL ON FUNCTION public.wh_record_import_attempt(uuid,text,text,text,text,integer,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.wh_record_import_attempt(uuid,text,text,text,text,integer,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.wh_import_receipt_snapshot(p_file_name text,p_file_hash text,p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_site uuid:=public.primary_site_id(); v_inserted integer;
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-carga','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para actualizar ingresos WMS' USING ERRCODE='42501'; END IF;
 IF v_site IS NULL OR NOT public.can_access_site(v_site) OR nullif(trim(p_file_name),'') IS NULL OR p_file_hash IS NULL OR p_file_hash !~ '^[a-f0-9]{64}$'
   OR p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows)<1 OR jsonb_array_length(p_rows)>20000 THEN
   RAISE EXCEPTION 'Archivo de ingresos WMS inválido o vacío';
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) e GROUP BY e->>'source_key' HAVING count(*)>1) THEN
   RAISE EXCEPTION 'El archivo contiene claves de ingreso repetidas'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) e
   WHERE nullif(trim(e->>'source_key'),'') IS NULL OR nullif(trim(e->>'document_no'),'') IS NULL
    OR nullif(trim(e->>'source_date'),'') IS NULL OR nullif(trim(e->>'warehouse'),'') IS NULL
    OR nullif(trim(e->>'product_code'),'') IS NULL OR coalesce((e->>'quantity')::numeric,0)<=0 OR (e->>'quantity')::numeric::text IN ('NaN','Infinity','-Infinity') OR (e->>'quantity')::numeric<>round((e->>'quantity')::numeric,3)) THEN
   RAISE EXCEPTION 'Cada fila requiere IPT, fecha, bodega, producto y cantidad positiva'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) e JOIN public.wh_receipt_sources s ON s.source_key=e->>'source_key' WHERE s.site_id<>v_site) THEN RAISE EXCEPTION 'La clave de ingreso pertenece a otro almacén'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('wms-receipt-import:'||v_site::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('wms-receipts:'||p_file_hash,0));
 INSERT INTO public.wh_receipt_import_runs(file_name,file_hash,row_count,imported_by)
 VALUES(trim(p_file_name),p_file_hash,jsonb_array_length(p_rows),auth.uid()) ON CONFLICT(file_hash) DO NOTHING;
 IF NOT FOUND THEN RETURN jsonb_build_object('success',true,'duplicate',true,'rows',0); END IF;
 INSERT INTO public.wh_receipt_sources(source_key,site_id,document_no,source_date,document_type,warehouse,ruc,customer_name,product_code,description,color,quantity,unit,lot,
  origin_doc,origin_number,delivery_date,contract_code,ref_doc_type,ref_correlation,ref_number,ref_date,comment,unit_weight,total_weight,cost_center,source_updated_at,source_import_hash)
 SELECT r.source_key,v_site,trim(r.document_no),r.source_date,nullif(trim(r.document_type),''),trim(r.warehouse),nullif(trim(r.ruc),''),nullif(trim(r.customer_name),''),trim(r.product_code),
  nullif(trim(r.description),''),nullif(trim(r.color),''),r.quantity,nullif(trim(r.unit),''),nullif(trim(r.lot),''),nullif(trim(r.origin_doc),''),nullif(trim(r.origin_number),''),
  r.delivery_date,nullif(trim(r.contract_code),''),nullif(trim(r.ref_doc_type),''),nullif(trim(r.ref_correlation),''),nullif(trim(r.ref_number),''),r.ref_date,
  nullif(trim(r.comment),''),r.unit_weight,r.total_weight,nullif(trim(r.cost_center),''),r.source_updated_at,p_file_hash
 FROM jsonb_to_recordset(p_rows) AS r(source_key text,document_no text,source_date date,document_type text,warehouse text,ruc text,customer_name text,product_code text,
  description text,color text,quantity numeric,unit text,lot text,origin_doc text,origin_number text,delivery_date date,contract_code text,ref_doc_type text,
  ref_correlation text,ref_number text,ref_date date,comment text,unit_weight numeric,total_weight numeric,cost_center text,source_updated_at timestamptz)
 WHERE nullif(trim(r.source_key),'') IS NOT NULL AND nullif(trim(r.document_no),'') IS NOT NULL AND r.source_date IS NOT NULL
  AND nullif(trim(r.warehouse),'') IS NOT NULL AND nullif(trim(r.product_code),'') IS NOT NULL AND r.quantity>0
 ON CONFLICT(source_key) DO UPDATE SET document_no=excluded.document_no,source_date=excluded.source_date,document_type=excluded.document_type,warehouse=excluded.warehouse,ruc=excluded.ruc,
  customer_name=excluded.customer_name,product_code=excluded.product_code,description=excluded.description,color=excluded.color,quantity=excluded.quantity,unit=excluded.unit,lot=excluded.lot,
  origin_doc=excluded.origin_doc,origin_number=excluded.origin_number,delivery_date=excluded.delivery_date,contract_code=excluded.contract_code,
  ref_doc_type=excluded.ref_doc_type,ref_correlation=excluded.ref_correlation,ref_number=excluded.ref_number,ref_date=excluded.ref_date,comment=excluded.comment,
  unit_weight=excluded.unit_weight,total_weight=excluded.total_weight,cost_center=excluded.cost_center,source_updated_at=excluded.source_updated_at,source_import_hash=excluded.source_import_hash,
  active=true,updated_at=now();
 GET DIAGNOSTICS v_inserted=ROW_COUNT;
 IF v_inserted<>jsonb_array_length(p_rows) THEN RAISE EXCEPTION 'El archivo contiene filas inválidas (%/%); no se aplicó la importación',v_inserted,jsonb_array_length(p_rows); END IF;
 RETURN jsonb_build_object('success',true,'duplicate',false,'rows',v_inserted,'file_hash',p_file_hash);
END $$;
COMMIT;
