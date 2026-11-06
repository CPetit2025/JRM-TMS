-- Fuente exclusiva de ingresos para recepción/etiquetado WMS. No escribe inv_movements ni recalcula Inventario multi-almacén.
BEGIN;
CREATE TABLE public.wh_receipt_import_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), file_name text NOT NULL, file_hash text NOT NULL UNIQUE,
 row_count integer NOT NULL CHECK(row_count>=0), imported_by uuid NOT NULL REFERENCES public.profiles(id),
 imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.wh_receipt_sources (
 source_key text PRIMARY KEY, site_id uuid NOT NULL REFERENCES public.sites(id), document_no text NOT NULL,
 source_date date NOT NULL, warehouse text NOT NULL, ruc text, customer_name text, product_code text NOT NULL,
 description text, quantity numeric(14,3) NOT NULL CHECK(quantity>=0), unit text, lot text, origin_doc text,
 origin_number text, delivery_date date, contract_code text, ref_doc_type text, ref_correlation text,
 ref_number text, ref_date date, comment text, unit_weight numeric(14,3), total_weight numeric(14,3),
 cost_center text, source_import_hash text NOT NULL REFERENCES public.wh_receipt_import_runs(file_hash),
 active boolean NOT NULL DEFAULT true, imported_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wh_receipt_sources_lookup_idx ON public.wh_receipt_sources(document_no,source_date DESC);
CREATE INDEX wh_receipt_sources_lot_idx ON public.wh_receipt_sources(lot,contract_code) WHERE active;
ALTER TABLE public.wh_receipt_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wh_receipt_import_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wh_receipt_sources,public.wh_receipt_import_runs FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.wh_import_receipt_snapshot(p_file_name text,p_file_hash text,p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_site uuid:=public.primary_site_id(); v_count integer; v_inserted integer;
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-carga','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para actualizar ingresos WMS' USING ERRCODE='42501'; END IF;
 IF v_site IS NULL OR NOT public.can_access_site(v_site) OR nullif(trim(p_file_name),'') IS NULL OR p_file_hash !~ '^[a-f0-9]{64}$'
   OR jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows)<1 OR jsonb_array_length(p_rows)>20000 THEN
   RAISE EXCEPTION 'Archivo de ingresos WMS inválido o vacío';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('wms-receipts:'||p_file_hash,0));
 INSERT INTO public.wh_receipt_import_runs(file_name,file_hash,row_count,imported_by)
 VALUES(trim(p_file_name),p_file_hash,jsonb_array_length(p_rows),auth.uid()) ON CONFLICT(file_hash) DO NOTHING;
 IF NOT FOUND THEN RETURN jsonb_build_object('success',true,'duplicate',true,'rows',0); END IF;
 INSERT INTO public.wh_receipt_sources(source_key,site_id,document_no,source_date,warehouse,ruc,customer_name,product_code,description,quantity,unit,lot,
  origin_doc,origin_number,delivery_date,contract_code,ref_doc_type,ref_correlation,ref_number,ref_date,comment,unit_weight,total_weight,cost_center,source_import_hash)
 SELECT r.source_key,v_site,trim(r.document_no),r.source_date,trim(r.warehouse),nullif(trim(r.ruc),''),nullif(trim(r.customer_name),''),trim(r.product_code),
  nullif(trim(r.description),''),r.quantity,nullif(trim(r.unit),''),nullif(trim(r.lot),''),nullif(trim(r.origin_doc),''),nullif(trim(r.origin_number),''),
  r.delivery_date,nullif(trim(r.contract_code),''),nullif(trim(r.ref_doc_type),''),nullif(trim(r.ref_correlation),''),nullif(trim(r.ref_number),''),r.ref_date,
  nullif(trim(r.comment),''),r.unit_weight,r.total_weight,nullif(trim(r.cost_center),''),p_file_hash
 FROM jsonb_to_recordset(p_rows) AS r(source_key text,document_no text,source_date date,warehouse text,ruc text,customer_name text,product_code text,
  description text,quantity numeric,unit text,lot text,origin_doc text,origin_number text,delivery_date date,contract_code text,ref_doc_type text,
  ref_correlation text,ref_number text,ref_date date,comment text,unit_weight numeric,total_weight numeric,cost_center text)
 WHERE nullif(trim(r.source_key),'') IS NOT NULL AND nullif(trim(r.document_no),'') IS NOT NULL AND r.source_date IS NOT NULL
  AND nullif(trim(r.warehouse),'') IS NOT NULL AND nullif(trim(r.product_code),'') IS NOT NULL AND r.quantity>=0
 ON CONFLICT(source_key) DO UPDATE SET document_no=excluded.document_no,source_date=excluded.source_date,warehouse=excluded.warehouse,ruc=excluded.ruc,
  customer_name=excluded.customer_name,product_code=excluded.product_code,description=excluded.description,quantity=excluded.quantity,unit=excluded.unit,lot=excluded.lot,
  origin_doc=excluded.origin_doc,origin_number=excluded.origin_number,delivery_date=excluded.delivery_date,contract_code=excluded.contract_code,
  ref_doc_type=excluded.ref_doc_type,ref_correlation=excluded.ref_correlation,ref_number=excluded.ref_number,ref_date=excluded.ref_date,comment=excluded.comment,
  unit_weight=excluded.unit_weight,total_weight=excluded.total_weight,cost_center=excluded.cost_center,source_import_hash=excluded.source_import_hash,
  active=true,updated_at=now();
 GET DIAGNOSTICS v_inserted=ROW_COUNT;
 IF v_inserted<>jsonb_array_length(p_rows) THEN RAISE EXCEPTION 'El archivo contiene filas inválidas (%/%); no se aplicó la importación',v_inserted,jsonb_array_length(p_rows); END IF;
 RETURN jsonb_build_object('success',true,'duplicate',false,'rows',v_inserted,'file_hash',p_file_hash);
END $$;

CREATE OR REPLACE FUNCTION public.wh_receipt_candidates(p_query text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q text:=trim(coalesce(p_query,'')); result jsonb;
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para consultar recepciones APT' USING ERRCODE='42501'; END IF;
 IF length(q)>0 AND length(q)<2 THEN RAISE EXCEPTION 'Ingrese dos o más caracteres para buscar'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.fecha DESC,x.document_no,x.product_code),'[]'::jsonb) INTO result FROM (
  SELECT r.*,c.id AS contract_id,
   coalesce(nullif(r.customer_name,''),public.inv_ot_cliente(public.inv_ot(r.contract_code)),v.manual_customer_name) AS customer_name,
   CASE WHEN nullif(r.customer_name,'') IS NOT NULL OR nullif(public.inv_ot_cliente(public.inv_ot(r.contract_code)),'') IS NOT NULL THEN 'ERP/OT'
    WHEN nullif(v.manual_customer_name,'') IS NOT NULL THEN 'MANUAL' ELSE NULL END AS customer_source,
   v.physical_quantity,v.variance,v.variance_reason,
   CASE WHEN v.id IS NULL THEN 'PENDING' WHEN v.erp_quantity<>r.quantity THEN 'STALE' ELSE 'VALIDATED' END AS validation_status,
   coalesce(p.label_count,0) AS label_count,coalesce(p.labeled_qty,0) AS labeled_qty,
   CASE WHEN coalesce(p.label_count,0)=0 THEN 'NOT_LABELED' WHEN p.labeled_qty=coalesce(v.physical_quantity,r.quantity) AND p.expected_count=p.label_count THEN 'MATCH' ELSE 'DIFFERENCE' END AS label_status
  FROM (SELECT s.source_key AS receipt_key,s.document_no,s.source_date AS fecha,s.lot AS lote,s.product_code,s.description,s.unit,s.warehouse AS bodega,
    coalesce(nullif(s.contract_code,''),nullif(s.origin_number,''),s.lot) AS contract_code,s.customer_name,s.quantity,s.total_weight AS weight_kg
   FROM public.wh_receipt_sources s WHERE s.active) r
  LEFT JOIN public.contracts c ON regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(r.contract_code),'[^A-Z0-9]','','g'),'^OT','')
  LEFT JOIN LATERAL (SELECT rv.* FROM public.wh_receipt_validations rv WHERE rv.source_movement_key=r.receipt_key ORDER BY rv.validated_at DESC,rv.id DESC LIMIT 1) v ON true
  LEFT JOIN LATERAL (SELECT count(*)::integer AS label_count,round(sum(quantity),3) AS labeled_qty,max(source_expected_count) AS expected_count FROM public.wh_packages WHERE source_movement_key=r.receipt_key AND status<>'VOID') p ON true
  WHERE (q='' AND coalesce(p.label_count,0)=0) OR (q<>'' AND (r.document_no ILIKE '%'||q||'%' OR coalesce(r.lote,'') ILIKE '%'||q||'%' OR r.product_code ILIKE '%'||q||'%'
   OR coalesce(r.description,'') ILIKE '%'||q||'%' OR coalesce(r.contract_code,'') ILIKE '%'||q||'%'))
  ORDER BY (r.document_no=q) DESC,r.fecha DESC,r.document_no,r.product_code LIMIT 500
 ) x;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.wh_validate_receipt(p_receipt_key text,p_physical_quantity numeric,p_variance_reason text DEFAULT NULL,p_manual_customer_name text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_site uuid:=public.primary_site_id(); v_receipt record; v_customer text; v_reason text:=nullif(trim(p_variance_reason),''); v_manual text:=nullif(trim(p_manual_customer_name),'');
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para validar la recepción APT' USING ERRCODE='42501'; END IF;
 IF v_site IS NULL OR NOT public.can_access_site(v_site) OR p_physical_quantity IS NULL OR p_physical_quantity<0 OR nullif(trim(p_receipt_key),'') IS NULL THEN RAISE EXCEPTION 'Cantidad física o ingreso IPT inválido'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_receipt_key,0));
 SELECT s.source_key AS receipt_key,s.document_no,s.source_date AS fecha,s.lot AS lote,s.product_code,s.description,s.unit,s.warehouse AS bodega,
  coalesce(nullif(s.contract_code,''),nullif(s.origin_number,''),s.lot) AS contract_code,s.customer_name,s.quantity
 INTO v_receipt FROM public.wh_receipt_sources s WHERE s.source_key=p_receipt_key AND s.active;
 IF NOT FOUND OR v_receipt.quantity<=0 THEN RAISE EXCEPTION 'El IPT no existe en el actualizable WMS vigente'; END IF;
 IF EXISTS(SELECT 1 FROM public.wh_packages WHERE source_movement_key=p_receipt_key AND status<>'VOID') THEN RAISE EXCEPTION 'La recepción ya tiene etiquetas; no se puede volver a validar sin anularlas'; END IF;
 v_customer:=coalesce(nullif(v_receipt.customer_name,''),nullif(public.inv_ot_cliente(public.inv_ot(v_receipt.contract_code),''),''));
 IF v_customer IS NULL AND v_manual IS NULL THEN RAISE EXCEPTION 'No se encontró el cliente por OT/contrato; registre el nombre manualmente'; END IF;
 IF p_physical_quantity<>v_receipt.quantity AND v_reason IS NULL THEN RAISE EXCEPTION 'Registre el motivo de la diferencia entre el ERP y el conteo físico'; END IF;
 INSERT INTO public.wh_receipt_validations(source_movement_key,site_id,erp_quantity,physical_quantity,variance_reason,manual_customer_name,validated_by)
 VALUES(p_receipt_key,v_site,v_receipt.quantity,p_physical_quantity,v_reason,CASE WHEN v_customer IS NULL THEN v_manual END,auth.uid());
 INSERT INTO public.wh_scan_events(site_id,event_type,scanned_code,payload,operator_id,client_event_id)
 VALUES(v_site,'RECEIPT_VALIDATED',v_receipt.document_no,jsonb_build_object('receipt_key',p_receipt_key,'erp_quantity',v_receipt.quantity,'physical_quantity',p_physical_quantity,'variance_reason',v_reason),auth.uid(),gen_random_uuid());
 RETURN jsonb_build_object('receipt_key',p_receipt_key,'document_no',v_receipt.document_no,'erp_quantity',v_receipt.quantity,'physical_quantity',p_physical_quantity,
  'variance',p_physical_quantity-v_receipt.quantity,'customer_name',coalesce(v_customer,v_manual),'customer_source',CASE WHEN v_customer IS NULL THEN 'MANUAL' ELSE 'ERP/OT' END,'validated',true);
END $$;

CREATE OR REPLACE FUNCTION public.wh_label_package(p_receipt_key text,p_package_count integer,p_units_per_package numeric DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_site uuid:=public.primary_site_id(); v_i int; v_key text; v_id uuid; v_codes jsonb:='[]'::jsonb; v_code text;
 v_total numeric; v_qty numeric; v_remaining numeric; v_weight numeric; v_receipt record; v_validation record; v_version integer;
BEGIN
 PERFORM public.security_assert_active_session(); IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso de etiquetado' USING ERRCODE='42501'; END IF;
 IF v_site IS NULL OR NOT public.can_access_site(v_site) OR p_package_count NOT BETWEEN 1 AND 100 OR nullif(trim(p_receipt_key),'') IS NULL OR
    (p_units_per_package IS NOT NULL AND p_units_per_package<=0) THEN RAISE EXCEPTION 'Datos de etiqueta inválidos'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_receipt_key,0));
 SELECT s.source_key AS receipt_key,s.document_no,s.source_date AS fecha,s.lot AS lote,s.product_code,s.description,s.unit,s.warehouse AS bodega,
   coalesce(nullif(s.contract_code,''),nullif(s.origin_number,''),s.lot) AS contract_code,c.id AS contract_id,s.quantity,s.total_weight AS weight_kg
  FROM public.wh_receipt_sources s LEFT JOIN public.contracts c
   ON regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(coalesce(nullif(s.contract_code,''),nullif(s.origin_number,''),s.lot)),'[^A-Z0-9]','','g'),'^OT','')
  WHERE s.source_key=p_receipt_key AND s.active SELECT * INTO v_validation FROM public.wh_receipt_validations WHERE source_movement_key=p_receipt_key ORDER BY validated_at DESC,id DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'Confirme la cantidad física del ingreso antes de generar etiquetas'; END IF;
 IF v_validation.erp_quantity<>v_receipt.quantity THEN RAISE EXCEPTION 'El IPT cambió en el actualizable APT; valide de nuevo antes de etiquetar'; END IF;
 v_total:=v_validation.physical_quantity; v_remaining:=v_total; v_weight:=v_receipt.weight_kg;
 IF v_total<=0 THEN RAISE EXCEPTION 'El conteo físico es cero; no hay bultos para etiquetar'; END IF;
 IF p_units_per_package IS NOT NULL AND ceil(v_total/p_units_per_package)::integer<>p_package_count THEN RAISE EXCEPTION 'El número de paquetes no coincide con la capacidad estándar'; END IF;
 SELECT max(source_label_version) INTO v_version FROM public.wh_packages WHERE source_movement_key=p_receipt_key AND status<>'VOID';
 IF v_version IS NOT NULL AND EXISTS(SELECT 1 FROM public.wh_packages WHERE source_movement_key=p_receipt_key AND status='VOID' AND source_label_version=v_version) THEN RAISE EXCEPTION 'Hay etiquetas anuladas y activas en la misma versión; anule primero todas las etiquetas activas'; END IF;
 IF v_version IS NULL THEN
  IF EXISTS(SELECT 1 FROM public.wh_packages WHERE source_movement_key=p_receipt_key AND status='VOID') AND NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN RAISE EXCEPTION 'Solo supervisión puede generar una nueva versión de etiquetas anuladas'; END IF;
  SELECT coalesce(max(source_label_version),0)+1 INTO v_version FROM public.wh_packages WHERE source_movement_key=p_receipt_key;
 END IF;
 FOR v_i IN 1..p_package_count LOOP
  v_key:=p_receipt_key||':'||v_version::text||':'||v_i::text; v_id:=gen_random_uuid();
  v_qty:=CASE WHEN p_units_per_package IS NULL THEN
   CASE WHEN v_i=p_package_count THEN v_remaining ELSE round(v_total/p_package_count,3) END
   ELSE least(p_units_per_package,v_remaining) END;
  IF v_qty<=0 THEN RAISE EXCEPTION 'La división produce un paquete vacío'; END IF;
  INSERT INTO public.wh_packages(id,package_code,source_document_no,source_contract_code,source_lot,source_product_code,source_unit,source_warehouse,source_date,source_movement_key,source_label_version,source_key,site_id,contract_id,description,quantity,unit,weight_kg,sequence_no,sequence_total,source_qty_snapshot,source_expected_total,source_expected_count,created_by)
  VALUES(v_id,'PKG-'||to_char(v_receipt.fecha,'YYMMDD')||'-'||upper(substr(replace(v_id::text,'-',''),1,8)),v_receipt.document_no,v_receipt.contract_code,coalesce(v_receipt.lote,''),v_receipt.product_code,coalesce(v_receipt.unit,''),v_receipt.bodega,v_receipt.fecha,p_receipt_key,v_version,v_key,v_site,v_receipt.contract_id,v_receipt.description,v_qty,nullif(v_receipt.unit,''),CASE WHEN v_weight IS NOT NULL AND v_receipt.quantity>0 THEN round(v_weight*v_qty/v_receipt.quantity,3) END,v_i,p_package_count,v_qty,v_total,p_package_count,auth.uid())
  ON CONFLICT(source_key) DO UPDATE SET source_qty_snapshot=excluded.source_qty_snapshot,source_expected_total=excluded.source_expected_total,source_expected_count=excluded.source_expected_count,
    quantity=CASE WHEN wh_packages.status='AVAILABLE' AND wh_packages.label_print_count=0 THEN excluded.quantity ELSE wh_packages.quantity END,
    sequence_total=CASE WHEN wh_packages.status='AVAILABLE' AND wh_packages.label_print_count=0 THEN excluded.sequence_total ELSE wh_packages.sequence_total END,
    source_contract_code=excluded.source_contract_code,source_warehouse=excluded.source_warehouse,source_date=excluded.source_date,description=excluded.description,updated_at=now();
  SELECT package_code INTO v_code FROM public.wh_packages WHERE source_key=v_key AND status<>'VOID';
  IF v_code IS NULL THEN RAISE EXCEPTION 'No fue posible recuperar la etiqueta del ingreso'; END IF;
  v_codes:=v_codes||jsonb_build_array(v_code);
  v_remaining:=v_remaining-v_qty;
 END LOOP;
 IF v_remaining<>0 THEN RAISE EXCEPTION 'La división no conserva la cantidad total del ingreso'; END IF;
 UPDATE public.wh_packages SET source_expected_total=v_total,source_expected_count=p_package_count,updated_at=now()
  WHERE source_movement_key=p_receipt_key AND site_id=v_site AND status<>'VOID';
 RETURN jsonb_build_object('package_codes',v_codes,'count',jsonb_array_length(v_codes));
END $$;


REVOKE ALL ON FUNCTION public.wh_import_receipt_snapshot(text,text,jsonb),public.wh_receipt_candidates(text),public.wh_validate_receipt(text,numeric,text,text),public.wh_label_package(text,integer,numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.wh_import_receipt_snapshot(text,text,jsonb),public.wh_receipt_candidates(text),public.wh_validate_receipt(text,numeric,text,text),public.wh_label_package(text,integer,numeric) TO authenticated;
COMMIT;
