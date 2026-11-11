-- Recepción por IPT (/almacen/etiquetado) y Centro WMS lentos.
-- 1) wh_receipt_candidates_all resolvía el cliente (cruce con contratos por expresiones regulares y dos llamadas a
--    inv_ot_cliente, que recorre los movimientos del ERP) una vez por ingreso: ~10 s. Ahora se resuelve una sola vez por
--    combinación distinta (OT/contrato, lote) y por raíz de OT, y sin búsqueda solo para los ingresos que siguen
--    pendientes de etiqueta. Mismo resultado, mismas columnas, mismo orden.
-- 2) Las políticas de lectura de wh_receipt_sources y wh_packages evaluaban can_access_site y wh_has_permission por
--    fila. Ahora el permiso se evalúa una vez y el acceso a sedes una vez por sede (la política sites_read de la tabla
--    sites es can_access_site(id), así que el conjunto de sedes es el mismo).

CREATE OR REPLACE FUNCTION public.wh_receipt_candidates_all(p_query text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

 WITH RECURSIVE r AS MATERIALIZED (
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
 ),
 -- Sin búsqueda solo se muestran ingresos sin bultos o con bultos sin imprimir: el cliente solo se resuelve para ellos.
 keys AS MATERIALIZED (
   SELECT DISTINCT r.contract_code,r.lote FROM r
   WHERE q<>''
    OR NOT EXISTS (SELECT 1 FROM public.wh_packages wp WHERE wp.source_movement_key=r.receipt_key AND wp.status<>'VOID')
    OR EXISTS (SELECT 1 FROM public.wh_packages wp WHERE wp.source_movement_key=r.receipt_key AND wp.status<>'VOID' AND wp.label_print_count=0)
 ),
 ot_customers AS MATERIALIZED (
   SELECT raiz,nullif(public.inv_ot_cliente(raiz),'') AS customer_name
   FROM (SELECT nullif(public.apt_ot_raiz(k.lote),'') AS raiz FROM keys k
         UNION SELECT nullif(public.inv_ot(k.contract_code),'') FROM keys k) t
   WHERE raiz IS NOT NULL
 ),
 -- Códigos de contrato y criterios del ingreso normalizados una sola vez (antes: expresiones regulares por contrato y
 -- por ingreso). Las comparaciones son las mismas.
 cn AS MATERIALIZED (
  SELECT c.id,c.client_id,c.parent_contract_id,
   regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','') AS norm,
   public.apt_ot_raiz(c.code::text) AS raiz
  FROM public.contracts c
 ),
 kn AS MATERIALIZED (
  SELECT k.contract_code,k.lote,
   regexp_replace(regexp_replace(upper(k.contract_code),'[^A-Z0-9]','','g'),'^OT','') AS n1,
   regexp_replace(regexp_replace(upper(k.lote),'[^A-Z0-9]','','g'),'^OT','') AS n2,
   regexp_replace(regexp_replace(upper(public.inv_ot(k.contract_code)),'[^A-Z0-9]','','g'),'^OT','') AS n3,
   regexp_replace(regexp_replace(upper(public.inv_ot(k.lote)),'[^A-Z0-9]','','g'),'^OT','') AS n4,
   regexp_replace(regexp_replace(upper(public.apt_ot_raiz(k.lote)),'[^A-Z0-9]','','g'),'^OT','') AS n5,
   coalesce(nullif(public.apt_ot_raiz(k.lote),''),nullif(public.inv_ot(k.lote),''),nullif(public.apt_ot_raiz(k.contract_code),''),nullif(public.inv_ot(k.contract_code),'')) AS raiz
  FROM keys k
 ),
 -- Cruce con contratos (y sus contratos padre) para todas las combinaciones a la vez; por combinación gana el mismo
 -- contrato que antes: menor prioridad de coincidencia, menor profundidad, menor id, con cliente con nombre.
 matches AS MATERIALIZED (
  SELECT k.contract_code,k.lote,c.id,c.client_id,c.parent_contract_id,
   CASE WHEN c.norm=k.n1 THEN 1 WHEN c.norm=k.n2 THEN 2 WHEN c.norm=k.n3 THEN 3 WHEN c.norm=k.n4 THEN 4 WHEN c.norm=k.n5 THEN 5 ELSE 6 END AS match_priority
  FROM kn k JOIN cn c ON c.norm IN (k.n1,k.n2,k.n3,k.n4,k.n5) OR (k.raiz IS NOT NULL AND c.raiz=k.raiz)
 ),
 ancestors AS (
  SELECT m.contract_code,m.lote,m.id,m.client_id,m.parent_contract_id,m.match_priority,0 AS depth FROM matches m
  UNION ALL
  SELECT a.contract_code,a.lote,parent.id,parent.client_id,parent.parent_contract_id,a.match_priority,a.depth+1
  FROM public.contracts parent JOIN ancestors a ON parent.id=a.parent_contract_id
  WHERE a.depth<20
 ),
 best AS MATERIALIZED (
  SELECT DISTINCT ON (a.contract_code,a.lote) a.contract_code,a.lote,a.id,nullif(cl.business_name,'') AS customer_name
  FROM ancestors a JOIN public.clients cl ON cl.id=a.client_id
  WHERE nullif(cl.business_name,'') IS NOT NULL
  ORDER BY a.contract_code,a.lote,a.match_priority,a.depth,a.id
 ),
 cust AS MATERIALIZED (
  SELECT k.contract_code,k.lote,b.id AS contract_id,b.customer_name AS contract_customer_name,
   o1.customer_name AS lot_customer,o2.customer_name AS contract_customer
  FROM keys k
  LEFT JOIN best b ON ARRAY[b.contract_code,b.lote]=ARRAY[k.contract_code,k.lote]
  LEFT JOIN ot_customers o1 ON o1.raiz=nullif(public.apt_ot_raiz(k.lote),'')
  LEFT JOIN ot_customers o2 ON o2.raiz=nullif(public.inv_ot(k.contract_code),'')
 )
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.fecha DESC,x.document_no,x.product_code),'[]'::jsonb)
 INTO result
 FROM (
  SELECT r.*,ck.contract_id,customer.customer_name,customer.customer_source,
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
  FROM r
  LEFT JOIN cust ck ON ARRAY[ck.contract_code,ck.lote]=ARRAY[r.contract_code,r.lote]
  LEFT JOIN LATERAL (
   SELECT rv.* FROM public.wh_receipt_validations rv
   WHERE rv.source_movement_key=r.receipt_key ORDER BY rv.validated_at DESC,rv.id DESC LIMIT 1
  ) v ON true
  LEFT JOIN LATERAL (
   SELECT coalesce(nullif(r.customer_name,''),nullif(ck.contract_customer_name,''),ck.lot_customer,ck.contract_customer,nullif(v.manual_customer_name,'')) AS customer_name,
    CASE WHEN nullif(r.customer_name,'') IS NOT NULL THEN 'EXCEL'
      WHEN nullif(ck.contract_customer_name,'') IS NOT NULL OR ck.lot_customer IS NOT NULL OR ck.contract_customer IS NOT NULL THEN 'ERP/OT'
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
END $function$;

DROP POLICY IF EXISTS wh_receipt_sources_read ON public.wh_receipt_sources;
CREATE POLICY wh_receipt_sources_read ON public.wh_receipt_sources FOR SELECT TO authenticated
 USING (site_id IN (SELECT s.id FROM public.sites s WHERE public.can_access_site(s.id))
   AND (SELECT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor'])));

DROP POLICY IF EXISTS wh_packages_read ON public.wh_packages;
CREATE POLICY wh_packages_read ON public.wh_packages FOR SELECT TO authenticated
 USING (site_id IN (SELECT s.id FROM public.sites s WHERE public.can_access_site(s.id))
   AND (SELECT public.wh_has_permission(ARRAY['almacen-lectura','almacen-supervisor','almacen-picking','almacen-packing','almacen-carga','almacen-etiquetado'])));
