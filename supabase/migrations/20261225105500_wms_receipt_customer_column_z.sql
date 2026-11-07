-- Resolve WMS receipt customers through the matching TMS OT and its parent contract.
BEGIN;
-- WMS receipt inbox: show every receipt with any unprinted labels and resolve customer by lot/OT.
BEGIN;

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
   CASE WHEN v.id IS NULL THEN 'PENDING' WHEN v.erp_quantity<>r.quantity THEN 'STALE' ELSE 'VALIDATED' END AS validation_status,
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
   WHERE coalesce(nullif(src.j->>'active','')::boolean,true)
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
      'customer_name',coalesce(customer.customer_name,'Cliente por registrar')
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

REVOKE ALL ON FUNCTION public.wh_receipt_candidates(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.wh_receipt_candidates(text) TO authenticated;
NOTIFY pgrst,'reload schema';


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
 IF p_physical_quantity<>v_receipt.quantity AND v_reason IS NULL THEN RAISE EXCEPTION 'Registre el motivo de la diferencia entre el ERP y el conteo físico'; END IF;
 INSERT INTO public.wh_receipt_validations(source_movement_key,site_id,erp_quantity,physical_quantity,variance_reason,manual_customer_name,validated_by)
 VALUES(p_receipt_key,v_site,v_receipt.quantity,p_physical_quantity,v_reason,CASE WHEN v_customer IS NULL THEN v_manual END,auth.uid());
 INSERT INTO public.wh_scan_events(site_id,event_type,scanned_code,payload,operator_id,client_event_id)
 VALUES(v_site,'RECEIPT_VALIDATED',v_receipt.document_no,jsonb_build_object('receipt_key',p_receipt_key,'erp_quantity',v_receipt.quantity,'physical_quantity',p_physical_quantity,'variance_reason',v_reason),auth.uid(),gen_random_uuid());
 RETURN jsonb_build_object('receipt_key',p_receipt_key,'document_no',v_receipt.document_no,'erp_quantity',v_receipt.quantity,'physical_quantity',p_physical_quantity,
  'variance',p_physical_quantity-v_receipt.quantity,'customer_name',coalesce(v_customer,v_manual),'customer_source',CASE WHEN nullif(v_receipt.customer_name,'') IS NOT NULL THEN 'EXCEL' WHEN v_customer IS NULL THEN 'MANUAL' ELSE 'ERP/OT' END,'validated',true);
END $$;

NOTIFY pgrst,'reload schema';
COMMIT;
