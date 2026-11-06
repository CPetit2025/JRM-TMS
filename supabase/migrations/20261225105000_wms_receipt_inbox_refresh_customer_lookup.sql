-- WMS receipt inbox: show every receipt with any unprinted labels and resolve customer by lot/OT.
BEGIN;

CREATE OR REPLACE FUNCTION public.wh_receipt_candidates(p_query text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q text:=trim(coalesce(p_query,'')); result jsonb;
BEGIN
 PERFORM public.security_assert_active_session();
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
   SELECT s.source_key AS receipt_key,s.document_no,s.source_date AS fecha,(to_jsonb(s)->>'document_type') AS document_type,s.color,s.source_updated_at,
    s.lot AS lote,s.product_code,s.description,s.unit,s.warehouse AS bodega,
    coalesce(nullif(s.contract_code,''),nullif(s.origin_number,''),s.lot) AS contract_code,
    s.customer_name,s.quantity,s.total_weight AS weight_kg
   FROM public.wh_receipt_sources s WHERE s.active
  ) r
  LEFT JOIN public.contracts c
   ON regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')
    =regexp_replace(regexp_replace(upper(r.contract_code),'[^A-Z0-9]','','g'),'^OT','')
  LEFT JOIN LATERAL (
   SELECT rv.* FROM public.wh_receipt_validations rv
   WHERE rv.source_movement_key=r.receipt_key ORDER BY rv.validated_at DESC,rv.id DESC LIMIT 1
  ) v ON true
  LEFT JOIN LATERAL (
   SELECT nullif(public.inv_ot_cliente(nullif(public.apt_ot_raiz(r.lote),'')),'') AS lot_customer,
    nullif(public.inv_ot_cliente(nullif(public.inv_ot(r.contract_code),'')),'') AS contract_customer
  ) lookup ON true
  LEFT JOIN LATERAL (
   SELECT coalesce(nullif(r.customer_name,''),lookup.lot_customer,lookup.contract_customer,nullif(v.manual_customer_name,'')) AS customer_name,
    CASE WHEN nullif(r.customer_name,'') IS NOT NULL OR lookup.lot_customer IS NOT NULL OR lookup.contract_customer IS NOT NULL
      THEN 'ERP/OT' WHEN nullif(v.manual_customer_name,'') IS NOT NULL THEN 'MANUAL' ELSE NULL END AS customer_source
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

COMMIT;
