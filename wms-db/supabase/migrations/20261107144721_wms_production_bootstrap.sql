DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public') THEN RAISE EXCEPTION 'WMS bootstrap requires an empty public schema'; END IF; END $$;
-- Standalone WMS schema: no TMS migrations or staging operational data.
SET check_function_bodies=off; SET search_path=public,extensions,pg_temp;
CREATE OR REPLACE FUNCTION public.uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';

CREATE OR REPLACE FUNCTION public.apt_almacen(p_bodega text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN upper(btrim(p_bodega)) ~ '^647-04\s' THEN '647'
              WHEN upper(btrim(p_bodega)) ~ '^540-04' THEN '540'
              WHEN upper(btrim(p_bodega)) ~ '^ST-VENTAS' THEN 'ST' END;
$function$
;

CREATE OR REPLACE FUNCTION public.apt_ot_raiz(p_lote text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT substring(upper(btrim(p_lote)) FROM '^([0-9]{3,})(?:$|[^0-9])');
$function$
;

CREATE OR REPLACE FUNCTION public.can_access_site(p_site_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p_site_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_active = true
  ) AND (public.is_tms_admin() OR EXISTS (
    SELECT 1 FROM public.user_site_access a
    WHERE a.user_id = auth.uid() AND a.site_id = p_site_id
  ));
$function$
;

CREATE OR REPLACE FUNCTION public.dispatch_document_folder(p_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN split_part(p_name, '/', 1)::uuid;
EXCEPTION WHEN others THEN RETURN NULL;
END $function$
;

CREATE OR REPLACE FUNCTION public.erp_active_import(p_kind text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT id FROM public.erp_imports WHERE kind = p_kind AND status = 'ACTIVA';
$function$
;

CREATE OR REPLACE FUNCTION public.erp_doc_key(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT regexp_replace(public.erp_key(p), '^([0-9]+)-([A-Z])0*([0-9]+)$', '\1-\2\3');
$function$
;

CREATE OR REPLACE FUNCTION public.erp_key(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT NULLIF(regexp_replace(upper(btrim(COALESCE(p, ''))), '\s+', ' ', 'g'), '');
$function$
;

CREATE OR REPLACE FUNCTION public.has_tms_permission(p_permission text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT EXISTS(SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id=p.role_id
  WHERE p.id=auth.uid() AND p.is_active=true AND (r.name='Administrador' OR r.permissions ? p_permission OR r.permissions ? (p_permission||':write')
   OR (p_permission='apt' AND r.permissions ?| ARRAY['almacen-lectura','almacen-etiquetado','almacen-picking','almacen-packing','almacen-carga','almacen-supervisor'])
   OR (p_permission='apt-carga' AND r.permissions ?| ARRAY['almacen-carga','almacen-supervisor'])))
$function$
;

CREATE OR REPLACE FUNCTION public.inv_kg(p_peso numeric, p_qty numeric, p_unit numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(NULLIF(p_peso, 0), abs(p_qty) * NULLIF(p_unit, 0), 0);
$function$
;

CREATE OR REPLACE FUNCTION public.inv_ot(p_lote text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT substring(p_lote FROM '^([0-9]{5,6})(?:-[A-Z][0-9]{3})?$');
$function$
;

CREATE OR REPLACE FUNCTION public.inv_ot_cliente(p_raiz text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    (SELECT m.razon_social FROM public.inv_movements_v m
     WHERE m.active AND m.clase = 'DESPACHO' AND m.razon_social IS NOT NULL AND upper(btrim(m.lote)) LIKE p_raiz || '%' AND public.apt_ot_raiz(m.lote) = p_raiz
     GROUP BY m.razon_social ORDER BY sum(public.inv_kg(m.peso_kg, m.cantidad, m.peso_unit)) DESC, count(*) DESC LIMIT 1),
    (SELECT cl.business_name FROM public.contracts c JOIN public.clients cl ON cl.id = c.client_id
     WHERE upper(c.code) = p_raiz OR public.apt_ot_raiz(c.code) = p_raiz ORDER BY (upper(c.code) = p_raiz) DESC LIMIT 1),
    (SELECT max(btrim(l.cliente)) FROM public.erp_contract_lines l
     WHERE l.import_id = public.erp_active_import('CONTRATOS') AND l.ot = p_raiz AND NULLIF(btrim(l.cliente), '') IS NOT NULL));
$function$
;

CREATE OR REPLACE FUNCTION public.is_active_tms_user()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND is_active=true);
$function$
;

CREATE OR REPLACE FUNCTION public.is_tms_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
    WHERE p.id = auth.uid() AND p.is_active = true AND r.name = 'Administrador'
  );
$function$
;

CREATE OR REPLACE FUNCTION public.primary_site_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT id FROM public.sites WHERE code = 'PRINCIPAL' LIMIT 1;
$function$
;

CREATE OR REPLACE FUNCTION public.security_assert_active_session()
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF current_setting('role',true) IN ('anon','authenticated') AND NOT public.is_active_tms_user() THEN
   RAISE EXCEPTION 'Sesión operativa no autorizada' USING ERRCODE='42501';
 END IF;
END $function$
;

CREATE OR REPLACE FUNCTION public.uuid_generate_v4()
 RETURNS uuid
 LANGUAGE sql
 PARALLEL SAFE
AS $function$SELECT gen_random_uuid()$function$
;

CREATE OR REPLACE FUNCTION public.wh_add_package_to_lpn(p_lpn_id uuid, p_package_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE l public.wh_lpns%ROWTYPE; p public.wh_packages%ROWTYPE;
BEGIN
 PERFORM public.security_assert_active_session(); IF NOT public.wh_has_permission(ARRAY['almacen-packing','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso de packing'; END IF;
 SELECT * INTO l FROM public.wh_lpns WHERE id=p_lpn_id FOR UPDATE; SELECT * INTO p FROM public.wh_packages WHERE package_code=trim(p_package_code) FOR UPDATE;
 IF l.id IS NULL OR p.id IS NULL OR l.site_id<>p.site_id OR NOT public.can_access_site(l.site_id) THEN RAISE EXCEPTION 'LPN o paquete no disponible'; END IF;
 IF l.status<>'OPEN' OR p.status NOT IN ('PICKED','PACKED') OR p.task_id IS DISTINCT FROM l.task_id OR p.lpn_id IS NOT NULL THEN RAISE EXCEPTION 'No se puede agregar ese paquete a este LPN'; END IF;
 UPDATE public.wh_packages SET status='PACKED',lpn_id=l.id WHERE id=p.id;
 IF p.status='PICKED' AND p.task_line_id IS NOT NULL THEN UPDATE public.wh_task_lines SET packed_qty=packed_qty+p.quantity WHERE id=p.task_line_id; END IF;
 UPDATE public.wh_lpns SET package_count=package_count+1,quantity=quantity+p.quantity,weight_kg=weight_kg+coalesce(p.weight_kg,0) WHERE id=l.id;
 INSERT INTO public.wh_scan_events(site_id,task_id,package_id,lpn_id,event_type,scanned_code,operator_id,client_event_id)
 VALUES(l.site_id,l.task_id,p.id,l.id,'LPN_ADD',trim(p_package_code),auth.uid(),gen_random_uuid());
 RETURN jsonb_build_object('success',true,'lpn',l.lpn_code,'package',p.package_code);
END $function$
;

CREATE OR REPLACE FUNCTION public.wh_assign_task(p_task_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  t public.wh_tasks%ROWTYPE;
BEGIN
  PERFORM public.security_assert_active_session();
  SELECT * INTO t FROM public.wh_tasks WHERE id=p_task_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN
    RAISE EXCEPTION 'Tarea no disponible';
  END IF;
  IF NOT public.wh_has_permission(ARRAY['almacen-picking','almacen-supervisor']) THEN
    RAISE EXCEPTION 'Sin permiso para asignar tareas';
  END IF;
  IF t.status IN ('LOADED','RECONCILED','CANCELLED') THEN
    RAISE EXCEPTION 'No se puede asignar una tarea cerrada';
  END IF;
  IF t.assigned_picker IS NOT NULL
     AND t.assigned_picker <> auth.uid()
     AND NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN
    RAISE EXCEPTION 'La tarea ya está asignada a otro operador';
  END IF;

  UPDATE public.wh_tasks
  SET assigned_picker=auth.uid(),updated_by=auth.uid()
  WHERE id=t.id;

  RETURN jsonb_build_object('task_id',t.id,'assigned_picker',auth.uid(),'assigned',true);
END
$function$
;

CREATE OR REPLACE FUNCTION public.wh_block_dispatch_without_wh_load()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF upper(coalesce(NEW.status,'')) IN ('EN RUTA','EN_RUTA','EN_CURSO','EN TRANSITO','EN_TRANSITO') AND NEW.status IS DISTINCT FROM OLD.status AND EXISTS(
  SELECT 1 FROM public.wh_tasks t JOIN public.transport_requests r ON r.id=t.transport_request_id
   WHERE t.dispatch_id=NEW.id AND upper(coalesce(r.request_type,'DESPACHO')) NOT IN ('RECOJO','TRASLADO')
   AND t.status NOT IN ('LOADED','RECONCILED','CANCELLED')
   AND NOT (t.status='PARTIAL' AND nullif(trim(t.load_override_reason),'') IS NOT NULL AND t.load_override_at IS NOT NULL AND EXISTS(
    SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id=p.role_id WHERE p.id=t.load_override_by AND p.is_active=true
     AND (r.name='Administrador' OR r.permissions ? 'almacen-supervisor')))
 ) THEN RAISE EXCEPTION 'No se puede iniciar la ruta: complete la carga WMS o registre una excepción parcial autorizada por supervisión'; END IF;
 RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION public.wh_close_lpn(p_lpn_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE l public.wh_lpns%ROWTYPE;
BEGIN
 PERFORM public.security_assert_active_session(); IF NOT public.wh_has_permission(ARRAY['almacen-packing','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso de packing'; END IF;
 SELECT * INTO l FROM public.wh_lpns WHERE id=p_lpn_id FOR UPDATE;
 IF NOT FOUND OR NOT public.can_access_site(l.site_id) OR l.status<>'OPEN' OR l.package_count=0 THEN RAISE EXCEPTION 'LPN no disponible o vacío'; END IF;
 UPDATE public.wh_lpns SET status='CLOSED',closed_by=auth.uid(),closed_at=now() WHERE id=l.id;
 INSERT INTO public.wh_scan_events(site_id,task_id,lpn_id,event_type,scanned_code,payload,operator_id,client_event_id)
 VALUES(l.site_id,l.task_id,l.id,'LPN_CLOSE',l.lpn_code,jsonb_build_object('package_count',l.package_count,'quantity',l.quantity,'weight_kg',l.weight_kg),auth.uid(),gen_random_uuid());
 RETURN jsonb_build_object('success',true,'lpn',l.lpn_code,'packages',l.package_count,'quantity',l.quantity,'weight_kg',l.weight_kg);
END $function$
;

CREATE OR REPLACE FUNCTION public.wh_create_lpn(p_task_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_site uuid; v_id uuid; v_code text;
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-packing','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso de packing' USING ERRCODE='42501'; END IF;
 v_site:=public.primary_site_id();
 IF p_task_id IS NOT NULL THEN SELECT site_id INTO v_site FROM public.wh_tasks WHERE id=p_task_id AND status IN ('PICKING','PACKING'); END IF;
 IF v_site IS NULL OR NOT public.can_access_site(v_site) THEN RAISE EXCEPTION 'No hay sede operativa asignada'; END IF;
 v_id:=gen_random_uuid(); v_code:='LPN-'||to_char(now(),'YYMMDD')||'-'||upper(substr(replace(v_id::text,'-',''),1,8));
 INSERT INTO public.wh_lpns(id,lpn_code,site_id,task_id,created_by) VALUES(v_id,v_code,v_site,p_task_id,auth.uid());
 RETURN jsonb_build_object('id',v_id,'code',v_code,'status','OPEN');
END $function$
;

CREATE OR REPLACE FUNCTION public.wh_has_permission(p_codes text[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT auth.uid() IS NOT NULL AND public.is_active_tms_user() AND EXISTS(
   SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id=p.role_id
   WHERE p.id=auth.uid() AND (r.name='Administrador' OR EXISTS(SELECT 1 FROM unnest(p_codes) c WHERE public.has_tms_permission(c))))
$function$
;

CREATE OR REPLACE FUNCTION public.wh_import_receipt_snapshot(p_file_name text, p_file_hash text, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    OR nullif(trim(e->>'product_code'),'') IS NULL OR coalesce((e->>'quantity')::numeric,0)<=0) THEN
   RAISE EXCEPTION 'Cada fila requiere IPT, fecha, bodega, producto y cantidad positiva'; END IF;
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
  AND nullif(trim(r.warehouse),'') IS NOT NULL AND nullif(trim(r.product_code),'') IS NOT NULL AND r.quantity>0
 ON CONFLICT(source_key) DO UPDATE SET document_no=excluded.document_no,source_date=excluded.source_date,warehouse=excluded.warehouse,ruc=excluded.ruc,
  customer_name=excluded.customer_name,product_code=excluded.product_code,description=excluded.description,quantity=excluded.quantity,unit=excluded.unit,lot=excluded.lot,
  origin_doc=excluded.origin_doc,origin_number=excluded.origin_number,delivery_date=excluded.delivery_date,contract_code=excluded.contract_code,
  ref_doc_type=excluded.ref_doc_type,ref_correlation=excluded.ref_correlation,ref_number=excluded.ref_number,ref_date=excluded.ref_date,comment=excluded.comment,
  unit_weight=excluded.unit_weight,total_weight=excluded.total_weight,cost_center=excluded.cost_center,source_import_hash=excluded.source_import_hash,
  active=true,updated_at=now();
 GET DIAGNOSTICS v_inserted=ROW_COUNT;
 IF v_inserted<>jsonb_array_length(p_rows) THEN RAISE EXCEPTION 'El archivo contiene filas inválidas (%/%); no se aplicó la importación',v_inserted,jsonb_array_length(p_rows); END IF;
 RETURN jsonb_build_object('success',true,'duplicate',false,'rows',v_inserted,'file_hash',p_file_hash);
END $function$
;

CREATE OR REPLACE FUNCTION public.wh_label_package(p_receipt_key text, p_package_count integer, p_units_per_package numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_site uuid:=public.primary_site_id(); v_i int; v_key text; v_id uuid; v_codes jsonb:='[]'::jsonb; v_code text;
 v_total numeric; v_qty numeric; v_remaining numeric; v_weight numeric; v_receipt record; v_validation record; v_version integer;
BEGIN
 PERFORM public.security_assert_active_session(); IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso de etiquetado' USING ERRCODE='42501'; END IF;
 IF v_site IS NULL OR NOT public.can_access_site(v_site) OR p_package_count NOT BETWEEN 1 AND 100 OR nullif(trim(p_receipt_key),'') IS NULL OR
    (p_units_per_package IS NOT NULL AND p_units_per_package<=0) THEN RAISE EXCEPTION 'Datos de etiqueta inválidos'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_receipt_key,0));
 SELECT s.source_key AS receipt_key,s.document_no,s.source_date AS fecha,s.lot AS lote,s.product_code,s.description,s.unit,s.warehouse AS bodega,
   coalesce(nullif(s.contract_code,''),nullif(s.origin_number,''),s.lot) AS contract_code,c.id AS contract_id,s.quantity,s.total_weight AS weight_kg
 INTO v_receipt FROM public.wh_receipt_sources s LEFT JOIN public.contracts c
   ON regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(coalesce(nullif(s.contract_code,''),nullif(s.origin_number,''),s.lot)),'[^A-Z0-9]','','g'),'^OT','')
  WHERE s.source_key=p_receipt_key AND s.active;
 IF NOT FOUND OR v_receipt.quantity<=0 THEN RAISE EXCEPTION 'El ingreso APT no existe o ya no está activo; actualice la fuente WMS'; END IF;
 SELECT * INTO v_validation FROM public.wh_receipt_validations WHERE source_movement_key=p_receipt_key ORDER BY validated_at DESC,id DESC LIMIT 1;
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
END $function$
;

CREATE OR REPLACE FUNCTION public.wh_pack_size_delete(p_product_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) OR nullif(trim(p_product_code),'') IS NULL THEN RAISE EXCEPTION 'Solo supervisión puede eliminar un embalaje'; END IF;
 DELETE FROM public.wh_pack_sizes WHERE product_code=upper(trim(p_product_code));
 IF NOT FOUND THEN RAISE EXCEPTION 'No existe la configuración de embalaje'; END IF;
 RETURN jsonb_build_object('product_code',upper(trim(p_product_code)),'deleted',true);
END $function$
;

CREATE OR REPLACE FUNCTION public.wh_pack_size_upsert(p_product_code text, p_units_per_package numeric, p_unit text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) OR nullif(trim(p_product_code),'') IS NULL OR p_units_per_package<=0 THEN
  RAISE EXCEPTION 'Solo supervisión puede guardar un tamaño de paquete válido' USING ERRCODE='42501';
 END IF;
 INSERT INTO public.wh_pack_sizes(product_code,units_per_package,unit,updated_by)
 VALUES(upper(trim(p_product_code)),p_units_per_package,nullif(upper(trim(coalesce(p_unit,''))),''),auth.uid())
 ON CONFLICT(product_code) DO UPDATE SET units_per_package=excluded.units_per_package,unit=excluded.unit,updated_by=excluded.updated_by,updated_at=now();
 RETURN jsonb_build_object('product_code',upper(trim(p_product_code)),'units_per_package',p_units_per_package);
END $function$
;

CREATE OR REPLACE FUNCTION public.wh_print_labels(p_package_codes text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_site uuid:=public.primary_site_id(); v_code text; v_count integer:=0; p public.wh_packages%ROWTYPE;
BEGIN
 PERFORM public.security_assert_active_session(); IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para imprimir etiquetas' USING ERRCODE='42501'; END IF;
 IF coalesce(cardinality(p_package_codes),0) NOT BETWEEN 1 AND 100 OR v_site IS NULL OR NOT public.can_access_site(v_site) THEN RAISE EXCEPTION 'Lote de etiquetas inválido'; END IF;
 IF cardinality(ARRAY(SELECT DISTINCT trim(code) FROM unnest(p_package_codes) AS u(code)))<>cardinality(p_package_codes) THEN RAISE EXCEPTION 'El lote contiene códigos duplicados'; END IF;
 FOREACH v_code IN ARRAY p_package_codes LOOP
  SELECT * INTO p FROM public.wh_packages WHERE package_code=trim(v_code) AND site_id=v_site FOR UPDATE;
  IF NOT FOUND OR p.status='VOID' THEN RAISE EXCEPTION 'Etiqueta no disponible: %',v_code; END IF;
  UPDATE public.wh_packages SET label_print_count=label_print_count+1 WHERE id=p.id;
  INSERT INTO public.wh_scan_events(site_id,task_id,package_id,event_type,scanned_code,payload,operator_id,client_event_id)
   VALUES(p.site_id,p.task_id,p.id,'LABEL_PRINT',p.package_code,jsonb_build_object('print_count',p.label_print_count+1),auth.uid(),gen_random_uuid());
  v_count:=v_count+1;
 END LOOP;
 RETURN jsonb_build_object('printed',v_count);
END $function$
;

CREATE OR REPLACE FUNCTION public.wh_receipt_candidates(p_query text)
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
END $function$
;

CREATE OR REPLACE FUNCTION public.wh_receipt_control_customers(p_source_movement_keys text[])
 RETURNS TABLE(source_movement_key text, customer_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_site uuid := public.primary_site_id();
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) THEN
    RAISE EXCEPTION 'Sin permiso para consultar clientes de recepción' USING ERRCODE='42501';
  END IF;
  IF coalesce(cardinality(p_source_movement_keys),0) NOT BETWEEN 1 AND 100 OR
     v_site IS NULL OR NOT public.can_access_site(v_site) THEN
    RAISE EXCEPTION 'Consulta de clientes de recepción inválida';
  END IF;

  RETURN QUERY
  WITH package_keys AS (
    SELECT DISTINCT ON (wp.source_movement_key)
      wp.source_movement_key,
      wp.source_contract_code,
      wp.source_lot
    FROM public.wh_packages wp
    WHERE wp.source_movement_key=ANY(p_source_movement_keys)
      AND wp.site_id=v_site
      AND wp.source_system='ERP'
      AND wp.status<>'VOID'
      AND wp.label_print_count>0
    ORDER BY wp.source_movement_key,wp.sequence_no
  )
  SELECT pk.source_movement_key::text,
         coalesce(
           nullif(rs.customer_name,'')::text,
           nullif(public.inv_ot_cliente(public.inv_ot(coalesce(nullif(rs.contract_code,''),nullif(rs.origin_number,''),pk.source_contract_code))),'')::text,
           nullif(rv.manual_customer_name,'')::text
         )::text AS customer_name
  FROM package_keys pk
  LEFT JOIN public.wh_receipt_sources rs
    ON rs.source_key=pk.source_movement_key
   AND rs.site_id=v_site
   AND rs.active
  LEFT JOIN LATERAL (
    SELECT validation.manual_customer_name
    FROM public.wh_receipt_validations validation
    WHERE validation.source_movement_key=pk.source_movement_key
      AND validation.site_id=v_site
    ORDER BY validation.validated_at DESC,validation.id DESC
    LIMIT 1
  ) rv ON true
  WHERE public.can_access_site(v_site)
  ORDER BY pk.source_movement_key;
END
$function$
;

CREATE OR REPLACE FUNCTION public.wh_receipt_control_operators(p_source_movement_keys text[])
 RETURNS TABLE(source_movement_key text, validated_by uuid, validated_at timestamp with time zone, first_name text, last_name text, username text, customer_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_site uuid := public.primary_site_id();
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) THEN
    RAISE EXCEPTION 'Sin permiso para consultar responsables de recepción' USING ERRCODE='42501';
  END IF;
  IF coalesce(cardinality(p_source_movement_keys),0) NOT BETWEEN 1 AND 100 OR
     v_site IS NULL OR NOT public.can_access_site(v_site) THEN
    RAISE EXCEPTION 'Consulta de responsables de recepción inválida';
  END IF;

  RETURN QUERY
  SELECT rv.source_movement_key::text,
         rv.validated_by::uuid,
         rv.validated_at::timestamptz,
         p.first_name::text,
         p.last_name::text,
         p.username::text,
         coalesce(
           nullif(s.customer_name,'')::text,
           lookup.lot_customer::text,
           lookup.contract_customer::text,
           nullif(rv.manual_customer_name,'')::text
         )::text AS customer_name
  FROM public.wh_receipt_validations rv
  JOIN (
    SELECT DISTINCT ON (wp.source_movement_key)
      wp.source_movement_key,wp.site_id,wp.source_document_no,wp.source_contract_code,wp.source_lot,wp.source_product_code
    FROM public.wh_packages wp
    WHERE wp.source_movement_key=ANY(p_source_movement_keys)
      AND wp.site_id=v_site AND wp.source_system='ERP'
      AND wp.status<>'VOID' AND wp.label_print_count>0
    ORDER BY wp.source_movement_key,wp.sequence_no
  ) wp ON wp.source_movement_key=rv.source_movement_key AND wp.site_id=rv.site_id
  LEFT JOIN public.profiles p ON p.id=rv.validated_by
  LEFT JOIN LATERAL (
    SELECT rs.customer_name,rs.contract_code,rs.lot
    FROM public.wh_receipt_sources rs
    WHERE rs.active
      AND rs.document_no=wp.source_document_no
      AND rs.product_code=wp.source_product_code
      AND coalesce(rs.lot,'')=wp.source_lot
    ORDER BY rs.updated_at DESC
    LIMIT 1
  ) s ON true
  LEFT JOIN LATERAL (
    SELECT
      nullif(public.inv_ot_cliente(nullif(public.apt_ot_raiz(coalesce(s.lot,wp.source_lot)),'')),'')::text AS lot_customer,
      nullif(public.inv_ot_cliente(nullif(public.inv_ot(coalesce(s.contract_code,wp.source_contract_code)),'')),'')::text AS contract_customer
  ) lookup ON true
  WHERE rv.source_movement_key=ANY(p_source_movement_keys)
    AND rv.site_id=v_site
    AND public.can_access_site(rv.site_id)
  GROUP BY rv.source_movement_key,rv.validated_by,rv.validated_at,p.first_name,p.last_name,p.username,
           s.customer_name,lookup.lot_customer,lookup.contract_customer,rv.manual_customer_name
  ORDER BY rv.validated_at DESC;
END
$function$
;

CREATE OR REPLACE FUNCTION public.wh_reconcile_apt_outflows(p_from date, p_until date, p_source_batch text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_site uuid:=public.primary_site_id(); v_rows integer;
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-carga','almacen-supervisor','apt-carga']) THEN RAISE EXCEPTION 'Sin permiso para conciliar salidas APT' USING ERRCODE='42501'; END IF;
 IF v_site IS NULL OR NOT public.can_access_site(v_site) OR p_from IS NULL OR p_until IS NULL OR p_until<p_from OR p_until-p_from>366 OR nullif(trim(p_source_batch),'') IS NULL THEN
  RAISE EXCEPTION 'Indique un rango válido de hasta 366 días y el identificador de la carga';
 END IF;
 WITH movements AS (
  SELECT encode(extensions.digest(convert_to(jsonb_build_array(m.fecha::text,m.numero,coalesce(m.ref_numero,''),coalesce(m.num_rel,''),coalesce(m.lote,''),m.producto,coalesce(m.unidad,''),m.bodega,coalesce(m.ot,m.contrato,''))::text,'UTF8'),'sha256'),'hex') AS movement_key,
   m.fecha,m.numero,m.ref_numero,m.num_rel,m.lote,m.producto,m.bodega,coalesce(m.ot,m.contrato) AS contract_code,round(sum(abs(m.cantidad)),3) AS erp_qty
  FROM public.inv_movements m WHERE m.active AND m.side='S' AND public.apt_almacen(m.bodega) IS NOT NULL AND m.fecha BETWEEN p_from AND p_until
  GROUP BY m.fecha,m.numero,m.ref_numero,m.num_rel,m.lote,m.producto,m.bodega,m.unidad,m.ot,m.contrato
 ), matched AS (
  SELECT m.*,x.dispatch_id,x.task_id,x.physical_qty,x.task_status FROM movements m
  LEFT JOIN LATERAL (
   SELECT d.id AS dispatch_id,t.id AS task_id,t.status AS task_status,
    (SELECT round(coalesce(sum(p.quantity),0),3) FROM public.wh_packages p WHERE p.task_id=t.id AND p.dispatch_id=d.id AND p.status='LOADED'
      AND upper(p.source_product_code)=upper(m.producto) AND (m.lote IS NULL OR p.source_lot=m.lote)
      AND (nullif(m.contract_code,'') IS NULL OR regexp_replace(regexp_replace(upper(coalesce(p.source_contract_code,'')),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(m.contract_code),'[^A-Z0-9]','','g'),'^OT','') OR EXISTS(SELECT 1 FROM public.contracts pc WHERE pc.id=p.contract_id AND regexp_replace(regexp_replace(upper(pc.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(m.contract_code),'[^A-Z0-9]','','g'),'^OT','')))) AS physical_qty
   FROM public.dispatch_documents dd JOIN public.dispatches d ON d.id=dd.dispatch_id
   JOIN public.dispatch_requests dr ON dr.dispatch_id=d.id AND dr.transport_request_id=dd.transport_request_id
   JOIN public.wh_tasks t ON t.transport_request_id=dr.transport_request_id AND t.dispatch_id=d.id
   WHERE dd.doc_type='GUIA_REMISION' AND dd.voided_at IS NULL AND upper(regexp_replace(coalesce(dd.document_number,''),'[^A-Z0-9]','','g')) IN (upper(regexp_replace(coalesce(m.ref_numero,''),'[^A-Z0-9]','','g')),upper(regexp_replace(coalesce(m.num_rel,''),'[^A-Z0-9]','','g')),upper(regexp_replace(m.numero,'[^A-Z0-9]','','g')))
    AND public.can_access_site(t.site_id) AND t.site_id=v_site
   ORDER BY dd.uploaded_at DESC LIMIT 1
  ) x ON true
 )
 INSERT INTO public.wh_reconciliation(site_id,task_id,package_code,erp_qty,physical_qty,status,source_batch,source_document_no,source_reference_no,source_lot,source_product_code,source_date,dispatch_id)
 SELECT v_site,m.task_id,'ERP-'||substr(m.movement_key,1,24),m.erp_qty,m.physical_qty,
  CASE WHEN m.task_id IS NULL THEN 'OPEN' WHEN m.physical_qty=m.erp_qty THEN 'MATCH' WHEN coalesce(m.physical_qty,0)<m.erp_qty THEN 'SHORT' ELSE 'OVER' END,
  trim(p_source_batch),m.numero,coalesce(nullif(m.ref_numero,''),nullif(m.num_rel,''),m.numero),coalesce(m.lote,''),m.producto,m.fecha,m.dispatch_id
 FROM matched m
 ON CONFLICT(site_id,package_code,source_batch) DO UPDATE SET task_id=excluded.task_id,erp_qty=excluded.erp_qty,physical_qty=excluded.physical_qty,
  status=excluded.status,source_document_no=excluded.source_document_no,source_lot=excluded.source_lot,source_product_code=excluded.source_product_code,
  source_reference_no=excluded.source_reference_no,source_date=excluded.source_date,dispatch_id=excluded.dispatch_id,resolution=NULL,resolved_by=NULL,resolved_at=NULL;
 GET DIAGNOSTICS v_rows=ROW_COUNT;
 RETURN jsonb_build_object('rows',v_rows,'from',p_from,'until',p_until,'source_batch',trim(p_source_batch));
END $function$
;

CREATE OR REPLACE FUNCTION public.wh_reconcile_batch(p_rows jsonb, p_source_batch text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r jsonb; v_site uuid; v_count int:=0; v_status text; v_erp numeric; v_physical numeric;
BEGIN
 PERFORM public.security_assert_active_session(); IF NOT public.wh_has_permission(ARRAY['almacen-carga','almacen-supervisor','apt-carga']) THEN RAISE EXCEPTION 'Sin permiso de conciliación' USING ERRCODE='42501'; END IF;
 v_site:=public.primary_site_id(); IF v_site IS NULL OR NOT public.can_access_site(v_site) OR nullif(trim(p_source_batch),'') IS NULL OR coalesce(jsonb_typeof(p_rows),'null')<>'array' THEN RAISE EXCEPTION 'Carga de conciliación inválida'; END IF;
 IF jsonb_array_length(p_rows)>10000 THEN RAISE EXCEPTION 'La conciliación excede el límite de 10,000 filas'; END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  IF nullif(trim(coalesce(r->>'package_code','')),'') IS NULL THEN RAISE EXCEPTION 'Cada conteo debe tener código de paquete'; END IF;
  v_erp:=nullif(r->>'erp_qty','')::numeric; v_physical:=nullif(r->>'physical_qty','')::numeric;
  IF v_erp<0 OR v_physical<0 THEN RAISE EXCEPTION 'Las cantidades de conciliación no pueden ser negativas'; END IF;
  v_status:=CASE WHEN v_erp IS NULL OR v_physical IS NULL THEN 'OPEN' WHEN v_erp=v_physical THEN 'MATCH' WHEN v_physical<v_erp THEN 'SHORT' ELSE 'OVER' END;
  INSERT INTO public.wh_reconciliation(site_id,task_id,package_code,erp_qty,physical_qty,status,source_batch)
  VALUES(v_site,nullif(r->>'task_id','')::uuid,trim(r->>'package_code'),v_erp,v_physical,v_status,p_source_batch)
  ON CONFLICT(site_id,package_code,source_batch) DO UPDATE SET erp_qty=excluded.erp_qty,physical_qty=excluded.physical_qty,status=excluded.status;
  v_count:=v_count+1;
 END LOOP;
 RETURN jsonb_build_object('rows',v_count,'source_batch',p_source_batch);
END $function$
;

CREATE OR REPLACE FUNCTION public.wh_record_scan(p_task_id uuid, p_code text, p_event text, p_client_event_id uuid, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t public.wh_tasks%ROWTYPE; p public.wh_packages%ROWTYPE; l public.wh_lpns%ROWTYPE; v_perm text; v_line public.wh_task_lines%ROWTYPE; v_count integer;
BEGIN
 PERFORM public.security_assert_active_session();
 SELECT * INTO t FROM public.wh_tasks WHERE id=p_task_id;
 IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
 v_perm:=CASE upper(p_event) WHEN 'PICK' THEN 'almacen-picking' WHEN 'PACK' THEN 'almacen-packing' WHEN 'LOAD' THEN 'almacen-carga' ELSE 'almacen-supervisor' END;
 IF NOT public.wh_has_permission(ARRAY[v_perm,'almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para registrar esta lectura' USING ERRCODE='42501'; END IF;
 IF nullif(trim(p_code),'') IS NULL OR p_client_event_id IS NULL THEN RAISE EXCEPTION 'Lea un código válido; se requiere identificador de operación'; END IF;
 IF upper(p_event)='PICK' AND t.request_status NOT IN ('APROBADA','APROBADO','ASIGNADA') THEN RAISE EXCEPTION 'La solicitud aún no está aprobada para iniciar el picking'; END IF;
 IF upper(p_event)='LOAD' AND t.dispatch_id IS NULL THEN RAISE EXCEPTION 'Programe la solicitud en un despacho antes de confirmar carga'; END IF;
 IF EXISTS(SELECT 1 FROM public.wh_scan_events WHERE site_id=t.site_id AND client_event_id=p_client_event_id AND scanned_code=trim(p_code)
   AND event_type IN (upper(p_event),CASE WHEN upper(p_event)='LOAD' THEN 'LOAD_LPN' ELSE upper(p_event) END) AND task_id=t.id) THEN
  RETURN jsonb_build_object('success',true,'duplicate_retry',true,'code',trim(p_code),'event',upper(p_event));
 ELSIF EXISTS(SELECT 1 FROM public.wh_scan_events WHERE site_id=t.site_id AND client_event_id=p_client_event_id) THEN RAISE EXCEPTION 'El identificador de lectura ya se usó para otra operación'; END IF;
 IF upper(p_event)='LOAD' THEN
  SELECT * INTO l FROM public.wh_lpns WHERE lpn_code=trim(p_code) FOR UPDATE;
  IF FOUND THEN
   IF l.task_id IS DISTINCT FROM t.id OR l.site_id<>t.site_id OR l.status<>'CLOSED' OR t.status<>'READY_FOR_LOAD' THEN RAISE EXCEPTION 'LPN no está cerrado para esta tarea'; END IF;
   SELECT count(*)::integer INTO v_count FROM public.wh_packages WHERE lpn_id=l.id AND task_id=t.id AND status='PACKED';
   IF v_count=0 THEN RAISE EXCEPTION 'El LPN no contiene paquetes listos para cargar'; END IF;
   WITH moved AS (
    UPDATE public.wh_packages SET status='LOADED',dispatch_id=t.dispatch_id
     WHERE lpn_id=l.id AND task_id=t.id AND status='PACKED' RETURNING task_line_id,quantity
   ), totals AS (
    SELECT task_line_id,sum(quantity) AS qty FROM moved WHERE task_line_id IS NOT NULL GROUP BY task_line_id
   )
   UPDATE public.wh_task_lines tl SET loaded_qty=loaded_qty+x.qty FROM totals x WHERE tl.id=x.task_line_id;
   UPDATE public.wh_lpns SET status='LOADED' WHERE id=l.id;
   INSERT INTO public.wh_scan_events(site_id,task_id,lpn_id,event_type,scanned_code,payload,operator_id,client_event_id)
    VALUES(t.site_id,t.id,l.id,'LOAD_LPN',l.lpn_code,jsonb_build_object('package_count',v_count),auth.uid(),p_client_event_id);
   RETURN jsonb_build_object('success',true,'lpn',l.lpn_code,'packages_loaded',v_count);
  END IF;
 END IF;
 SELECT * INTO p FROM public.wh_packages WHERE package_code=trim(p_code) AND site_id=t.site_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Código no pertenece a este almacén'; END IF;
 IF upper(p_event)='PICK' THEN
   IF p.status NOT IN ('AVAILABLE','RESERVED') OR t.status NOT IN ('PENDING','PICKING') THEN RAISE EXCEPTION 'Paquete no disponible para picking'; END IF;
   IF p.contract_id IS NOT NULL AND p.contract_id<>t.contract_id AND NOT EXISTS(SELECT 1 FROM public.transport_request_components c WHERE c.request_id=t.transport_request_id AND c.component_contract_id=p.contract_id) THEN
    RAISE EXCEPTION 'El paquete pertenece a otra OT o contrato que no está incluido en la solicitud';
   END IF;
   IF nullif(trim(p.source_contract_code),'') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.contracts c WHERE c.id=t.contract_id AND regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(p.source_contract_code),'[^A-Z0-9]','','g'),'^OT','')) AND NOT EXISTS(SELECT 1 FROM public.transport_request_components rc JOIN public.contracts c ON c.id=rc.component_contract_id WHERE rc.request_id=t.transport_request_id AND regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(p.source_contract_code),'[^A-Z0-9]','','g'),'^OT','')) THEN
    RAISE EXCEPTION 'La OT/contrato del ingreso APT no está incluida en la solicitud';
   END IF;
   SELECT * INTO v_line FROM public.wh_task_lines WHERE task_id=t.id AND upper(coalesce(product_code,''))=upper(p.source_product_code)
    AND (contract_id IS NULL OR contract_id=t.contract_id OR p.contract_id IS NULL OR contract_id=p.contract_id) ORDER BY created_at LIMIT 1 FOR UPDATE;
   IF FOUND THEN
     IF v_line.requested_qty IS NOT NULL AND v_line.picked_qty+p.quantity>v_line.requested_qty THEN RAISE EXCEPTION 'La cantidad recogida superaría lo solicitado'; END IF;
     UPDATE public.wh_task_lines SET picked_qty=picked_qty+p.quantity WHERE id=v_line.id;
   ELSE
     IF NOT (public.wh_has_permission(ARRAY['almacen-supervisor']) AND coalesce((p_payload->>'confirmed_unrequested_stock')::boolean,false)) THEN
      RAISE EXCEPTION 'El producto no está en el detalle de solicitud. La supervisión debe confirmar el material alternativo antes de recogerlo';
     END IF;
     INSERT INTO public.wh_task_lines(task_id,contract_id,product_code,description,requested_qty,picked_qty,unit,weight_kg,source)
     VALUES(t.id,p.contract_id,p.source_product_code,p.description,NULL,p.quantity,p.unit,p.weight_kg,'SUPERVISOR_CONFIRMED_STOCK') RETURNING id INTO v_line.id;
   END IF;
   IF p.task_id IS NOT NULL AND p.task_id<>t.id THEN RAISE EXCEPTION 'Paquete ya reservado para otra tarea'; END IF;
   UPDATE public.wh_packages SET status='PICKED',task_id=t.id,task_line_id=v_line.id WHERE id=p.id;
   UPDATE public.wh_tasks SET status='PICKING',assigned_picker=coalesce(assigned_picker,auth.uid()),updated_by=auth.uid() WHERE id=t.id AND status='PENDING';
 ELSIF upper(p_event)='PACK' THEN
   IF p.task_id IS DISTINCT FROM t.id OR p.status<>'PICKED' OR t.status NOT IN ('PICKING','PACKING') THEN RAISE EXCEPTION 'Paquete no corresponde a tarea o no está recogido'; END IF;
   UPDATE public.wh_packages SET status='PACKED' WHERE id=p.id;
   UPDATE public.wh_task_lines SET packed_qty=packed_qty+p.quantity WHERE id=p.task_line_id;
   SELECT * INTO l FROM public.wh_lpns WHERE task_id=t.id AND status='OPEN' ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
   IF FOUND THEN
    UPDATE public.wh_packages SET lpn_id=l.id WHERE id=p.id;
    UPDATE public.wh_lpns SET package_count=package_count+1,quantity=quantity+p.quantity,weight_kg=weight_kg+coalesce(p.weight_kg,0) WHERE id=l.id;
   END IF;
   UPDATE public.wh_tasks SET status='PACKING',assigned_packer=coalesce(assigned_packer,auth.uid()),updated_by=auth.uid() WHERE id=t.id AND status='PICKING';
 ELSIF upper(p_event)='LOAD' THEN
   IF p.task_id IS DISTINCT FROM t.id OR p.status<>'PACKED' OR t.status<>'READY_FOR_LOAD' THEN RAISE EXCEPTION 'Paquete no está listo para cargar'; END IF;
   UPDATE public.wh_packages SET status='LOADED',dispatch_id=t.dispatch_id WHERE id=p.id;
   UPDATE public.wh_task_lines SET loaded_qty=loaded_qty+p.quantity WHERE id=p.task_line_id;
 ELSE RAISE EXCEPTION 'Tipo de lectura no reconocido'; END IF;
 INSERT INTO public.wh_scan_events(site_id,task_id,package_id,lpn_id,event_type,scanned_code,payload,operator_id,client_event_id)
 VALUES(t.site_id,t.id,p.id,CASE WHEN upper(p_event)='PACK' AND l.id IS NOT NULL THEN l.id ELSE NULL END,upper(p_event),trim(p_code),coalesce(p_payload,'{}'),auth.uid(),p_client_event_id)
 ON CONFLICT(site_id,client_event_id) DO NOTHING;
 RETURN jsonb_build_object('success',true,'package',p.package_code,'event',upper(p_event));
END $function$
;

CREATE OR REPLACE FUNCTION public.wh_register_packing_list(p_dispatch_id uuid, p_request_id uuid, p_file_path text, p_file_name text, p_size_bytes bigint, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_id uuid; v_site uuid;
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-packing','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para registrar packing list' USING ERRCODE='42501'; END IF;
 SELECT site_id INTO v_site FROM public.dispatches WHERE id=p_dispatch_id;
 IF v_site IS NULL OR NOT public.can_access_site(v_site) OR public.dispatch_document_folder(p_file_path) IS DISTINCT FROM p_dispatch_id OR NOT EXISTS(SELECT 1 FROM public.dispatch_requests WHERE dispatch_id=p_dispatch_id AND transport_request_id=p_request_id) THEN RAISE EXCEPTION 'Despacho, solicitud o archivo no corresponde'; END IF;
 INSERT INTO public.dispatch_documents(dispatch_id,transport_request_id,doc_type,file_path,file_name,mime_type,size_bytes,notes,uploaded_by)
 VALUES(p_dispatch_id,p_request_id,'PACKING_LIST',p_file_path,p_file_name,'application/pdf',p_size_bytes,coalesce(nullif(trim(p_notes),''),'Packing List generado por Portal WMS'),auth.uid()) RETURNING id INTO v_id;
 RETURN jsonb_build_object('success',true,'id',v_id);
END $function$
;

CREATE OR REPLACE FUNCTION public.wh_reject_scan_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$ BEGIN RAISE EXCEPTION 'Las lecturas de almacén son inmutables'; END $function$
;

CREATE OR REPLACE FUNCTION public.wh_reprint_label(p_package_code text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE p public.wh_packages%ROWTYPE;
BEGIN
 PERFORM public.security_assert_active_session(); IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) OR nullif(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Reimpresión requiere permiso y motivo'; END IF;
 SELECT * INTO p FROM public.wh_packages WHERE package_code=trim(p_package_code) FOR UPDATE;
 IF NOT FOUND OR NOT public.can_access_site(p.site_id) OR p.status='VOID' THEN RAISE EXCEPTION 'Etiqueta no disponible'; END IF;
 UPDATE public.wh_packages SET label_print_count=label_print_count+1 WHERE id=p.id;
 INSERT INTO public.wh_scan_events(site_id,task_id,package_id,event_type,scanned_code,payload,operator_id,client_event_id)
  VALUES(p.site_id,p.task_id,p.id,'LABEL_REPRINT',p.package_code,jsonb_build_object('reason',trim(p_reason),'previous_print_count',p.label_print_count),auth.uid(),gen_random_uuid());
 RETURN jsonb_build_object('package_code',p.package_code,'print_count',p.label_print_count+1);
END $function$
;

CREATE OR REPLACE FUNCTION public.wh_reprint_lpn_label(p_lpn_code text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE l public.wh_lpns%ROWTYPE;
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-packing','almacen-supervisor']) OR nullif(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Reimpresión de LPN requiere permiso y motivo' USING ERRCODE='42501'; END IF;
 SELECT * INTO l FROM public.wh_lpns WHERE lpn_code=trim(p_lpn_code) FOR UPDATE;
 IF NOT FOUND OR NOT public.can_access_site(l.site_id) OR l.status IN ('VOID','OPEN') THEN RAISE EXCEPTION 'LPN no disponible para reimpresión'; END IF;
 UPDATE public.wh_lpns SET print_count=print_count+1 WHERE id=l.id;
 INSERT INTO public.wh_scan_events(site_id,task_id,lpn_id,event_type,scanned_code,payload,operator_id,client_event_id)
 VALUES(l.site_id,l.task_id,l.id,'LPN_REPRINT',l.lpn_code,jsonb_build_object('reason',trim(p_reason),'previous_print_count',l.print_count),auth.uid(),gen_random_uuid());
 RETURN jsonb_build_object('lpn_code',l.lpn_code,'print_count',l.print_count+1);
END $function$
;

CREATE OR REPLACE FUNCTION public.wh_resolve_reconciliation(p_id uuid, p_resolution text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r public.wh_reconciliation%ROWTYPE;
BEGIN
 PERFORM public.security_assert_active_session(); IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) OR nullif(trim(p_resolution),'') IS NULL THEN RAISE EXCEPTION 'Resolución requiere supervisión y motivo'; END IF;
 UPDATE public.wh_reconciliation SET status='RESOLVED',resolution=trim(p_resolution),resolved_by=auth.uid(),resolved_at=now() WHERE id=p_id AND public.can_access_site(site_id) AND status IN ('OPEN','SHORT','OVER') RETURNING * INTO r;
 IF NOT FOUND THEN RAISE EXCEPTION 'Diferencia no disponible'; END IF; RETURN jsonb_build_object('id',r.id,'status',r.status);
END $function$
;

CREATE OR REPLACE FUNCTION public.wh_sync_dispatch_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_request uuid; v_old_dispatch uuid;
BEGIN
 v_request:=CASE WHEN TG_OP='DELETE' THEN OLD.transport_request_id ELSE NEW.transport_request_id END;
 v_old_dispatch:=CASE WHEN TG_OP='DELETE' THEN OLD.dispatch_id ELSE NEW.dispatch_id END;
 UPDATE public.wh_tasks t SET dispatch_id=(SELECT dr.dispatch_id FROM public.dispatch_requests dr WHERE dr.transport_request_id=v_request ORDER BY dr.created_at DESC LIMIT 1),
  status=CASE WHEN t.status='PARTIAL' AND v_old_dispatch IS DISTINCT FROM (SELECT dr.dispatch_id FROM public.dispatch_requests dr WHERE dr.transport_request_id=v_request ORDER BY dr.created_at DESC LIMIT 1) THEN 'PENDING' ELSE t.status END,
  load_override_reason=CASE WHEN t.status='PARTIAL' THEN NULL ELSE t.load_override_reason END,
  load_override_by=CASE WHEN t.status='PARTIAL' THEN NULL ELSE t.load_override_by END,
  load_override_at=CASE WHEN t.status='PARTIAL' THEN NULL ELSE t.load_override_at END,updated_by=auth.uid()
 WHERE t.transport_request_id=v_request;
 RETURN NULL;
END $function$
;

CREATE OR REPLACE FUNCTION public.wh_sync_request_components()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_request uuid; r public.transport_requests%ROWTYPE;
BEGIN
 v_request:=CASE WHEN TG_OP='DELETE' THEN OLD.request_id ELSE NEW.request_id END;
 SELECT * INTO r FROM public.transport_requests WHERE id=v_request;
 IF FOUND THEN
  IF upper(coalesce(r.request_type,'DESPACHO')) NOT IN ('RECOJO','TRASLADO') THEN
  INSERT INTO public.wh_tasks(task_code,transport_request_id,site_id,contract_id,created_by,request_status,dispatch_id)
  SELECT 'WH-'||r.request_number,r.id,r.site_id,r.contract_id,r.created_by,r.status,
   (SELECT dr.dispatch_id FROM public.dispatch_requests dr WHERE dr.transport_request_id=r.id ORDER BY dr.created_at DESC LIMIT 1)
  ON CONFLICT(transport_request_id) DO NOTHING;
  END IF;
 END IF;
 RETURN NULL;
END $function$
;

CREATE OR REPLACE FUNCTION public.wh_sync_transport_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_site uuid; v_state text; v_id uuid;
BEGIN
 IF upper(coalesce(NEW.request_type,'DESPACHO')) IN ('RECOJO','TRASLADO') THEN RETURN NEW; END IF;
 v_state:=public.wh_task_status_for_request(NEW.status);
 v_site:=NEW.site_id;
 INSERT INTO public.wh_tasks(task_code,transport_request_id,site_id,contract_id,created_by,request_status,dispatch_id)
  SELECT 'WH-'||NEW.request_number,NEW.id,v_site,NEW.contract_id,auth.uid(),NEW.status,
   (SELECT dr.dispatch_id FROM public.dispatch_requests dr WHERE dr.transport_request_id=NEW.id ORDER BY dr.created_at DESC LIMIT 1)
 ON CONFLICT(transport_request_id) DO NOTHING;
 SELECT id INTO v_id FROM public.wh_tasks WHERE transport_request_id=NEW.id;
 IF v_id IS NOT NULL THEN
  UPDATE public.wh_tasks SET request_status=NEW.status,updated_by=auth.uid(),
   status=CASE WHEN status IN ('LOADED','RECONCILED') THEN status WHEN v_state='PAUSED' THEN 'PAUSED' WHEN v_state='CANCELLED' THEN 'CANCELLED' WHEN v_state='PENDING' AND status='PAUSED' THEN 'PENDING' ELSE status END,
   paused_reason=CASE WHEN v_state='PAUSED' THEN 'Solicitud observada' WHEN v_state='PENDING' THEN NULL ELSE paused_reason END,
   cancelled_reason=CASE WHEN v_state='CANCELLED' THEN 'Solicitud cancelada o rechazada' ELSE cancelled_reason END
  WHERE id=v_id AND (TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status);
 END IF;
 IF v_state='CANCELLED' THEN
  UPDATE public.wh_packages SET status='AVAILABLE',task_id=NULL,lpn_id=NULL
   WHERE task_id IN (SELECT id FROM public.wh_tasks WHERE transport_request_id=NEW.id) AND status NOT IN ('VOID','LOADED');
  UPDATE public.wh_lpns SET status='VOID',void_reason='Solicitud de transporte cancelada o rechazada'
   WHERE task_id IN (SELECT id FROM public.wh_tasks WHERE transport_request_id=NEW.id) AND status IN ('OPEN','CLOSED');
  INSERT INTO public.wh_scan_events(site_id,task_id,event_type,scanned_code,payload,operator_id,client_event_id)
   SELECT site_id,id,'REQUEST_CANCELLED',task_code,jsonb_build_object('request_status',NEW.status),auth.uid(),gen_random_uuid() FROM public.wh_tasks WHERE id=v_id;
 END IF;
 RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION public.wh_task_action(p_task_id uuid, p_action text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t public.wh_tasks%ROWTYPE; v_action text:=upper(p_action); v_to text; v_n int; v_open numeric;
BEGIN
 PERFORM public.security_assert_active_session();
 SELECT * INTO t FROM public.wh_tasks WHERE id=p_task_id FOR UPDATE;
 IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
 IF v_action IN ('START_PICKING','PICK') THEN v_to:='PICKING';
 ELSIF v_action='START_PACKING' THEN v_to:='PACKING';
 ELSIF v_action='READY_FOR_LOAD' THEN v_to:='READY_FOR_LOAD';
 ELSIF v_action='LOAD' THEN v_to:='LOADED';
 ELSIF v_action='LOAD_PARTIAL' THEN v_to:='PARTIAL';
 ELSIF v_action='PAUSE' THEN v_to:='PAUSED';
 ELSIF v_action='RESUME' THEN v_to:='PICKING';
 ELSIF v_action='CANCEL' THEN v_to:='CANCELLED';
 ELSE RAISE EXCEPTION 'Acción de tarea no reconocida'; END IF;
 IF v_action IN ('START_PICKING','PICK','RESUME') AND NOT public.wh_has_permission(ARRAY['almacen-picking','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso de picking' USING ERRCODE='42501'; END IF;
 IF v_action='START_PACKING' AND NOT public.wh_has_permission(ARRAY['almacen-packing','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso de packing' USING ERRCODE='42501'; END IF;
 IF v_action IN ('READY_FOR_LOAD','LOAD') AND NOT public.wh_has_permission(ARRAY['almacen-carga','almacen-supervisor','apt-carga']) THEN RAISE EXCEPTION 'Sin permiso de carga' USING ERRCODE='42501'; END IF;
 IF v_action='LOAD_PARTIAL' AND NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN RAISE EXCEPTION 'La excepción de carga parcial es exclusiva de supervisión' USING ERRCODE='42501'; END IF;
 IF v_action IN ('PAUSE','CANCEL') AND NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN RAISE EXCEPTION 'Acción exclusiva de supervisión' USING ERRCODE='42501'; END IF;
 IF v_action IN ('PAUSE','CANCEL') AND nullif(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Registre el motivo'; END IF;
 IF v_action='LOAD_PARTIAL' AND nullif(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Registre el motivo de la excepción de carga parcial'; END IF;
 IF v_action IN ('START_PICKING','PICK','RESUME') AND t.request_status NOT IN ('APROBADA','APROBADO','ASIGNADA') THEN RAISE EXCEPTION 'La solicitud aún no está aprobada para iniciar el picking'; END IF;
 IF NOT ((t.status IN ('PENDING','PARTIAL') AND v_to='PICKING') OR (t.status='PENDING' AND v_to='CANCELLED') OR
   (t.status='PICKING' AND v_to IN ('PACKING','PAUSED','CANCELLED')) OR (t.status='PAUSED' AND v_to IN ('PICKING','CANCELLED')) OR
   (t.status='PACKING' AND v_to IN ('READY_FOR_LOAD','PAUSED','CANCELLED')) OR
   (t.status='READY_FOR_LOAD' AND v_to IN ('LOADED','PARTIAL','PAUSED','CANCELLED'))) THEN RAISE EXCEPTION 'Transición no permitida: % → %',t.status,v_to; END IF;
 IF v_to='READY_FOR_LOAD' THEN
  SELECT count(*) INTO v_n FROM public.wh_packages p WHERE p.task_id=t.id AND p.status<>'VOID';
  IF v_n=0 OR EXISTS(SELECT 1 FROM public.wh_packages p WHERE p.task_id=t.id AND p.status NOT IN ('PACKED','LOADED','VOID')) THEN RAISE EXCEPTION 'No se puede liberar la carga: faltan paquetes empacados'; END IF;
  IF EXISTS(SELECT 1 FROM public.wh_packages p LEFT JOIN public.wh_lpns l ON l.id=p.lpn_id WHERE p.task_id=t.id AND p.status='PACKED' AND (p.lpn_id IS NULL OR l.status NOT IN ('CLOSED','LOADED'))) THEN RAISE EXCEPTION 'Asigne todos los paquetes empacados a LPN cerrados antes de liberar la carga'; END IF;
 END IF;
 IF v_to='LOADED' AND (EXISTS(SELECT 1 FROM public.wh_packages p WHERE p.task_id=t.id AND p.status NOT IN ('LOADED','VOID')) OR NOT EXISTS(SELECT 1 FROM public.wh_packages p WHERE p.task_id=t.id AND p.status='LOADED')) THEN RAISE EXCEPTION 'No se puede confirmar salida: escanee todos los paquetes cargados'; END IF;
 IF v_to IN ('LOADED','PARTIAL') THEN
  SELECT coalesce(sum(remaining_qty),0) INTO v_open FROM public.wh_task_lines WHERE task_id=t.id;
  IF v_to='PARTIAL' AND (NOT EXISTS(SELECT 1 FROM public.wh_packages WHERE task_id=t.id AND status='LOADED') OR v_open<=0) THEN RAISE EXCEPTION 'La excepción parcial requiere paquetes cargados y un saldo pendiente'; END IF;
  IF v_to='LOADED' AND v_open>0 THEN RAISE EXCEPTION 'Queda saldo solicitado; la supervisión debe registrar el despacho parcial con motivo'; END IF;
 END IF;
 UPDATE public.wh_tasks SET status=v_to,updated_by=auth.uid(),paused_reason=CASE WHEN v_to='PAUSED' THEN trim(p_reason) ELSE NULL END,
  cancelled_reason=CASE WHEN v_to='CANCELLED' THEN trim(p_reason) ELSE cancelled_reason END,
  loaded_at=CASE WHEN v_to IN ('LOADED','PARTIAL') THEN now() ELSE loaded_at END,
  load_override_reason=CASE WHEN v_action='LOAD_PARTIAL' THEN trim(p_reason) WHEN v_to='PICKING' THEN NULL ELSE load_override_reason END,
  load_override_by=CASE WHEN v_action='LOAD_PARTIAL' THEN auth.uid() WHEN v_to='PICKING' THEN NULL ELSE load_override_by END,
  load_override_at=CASE WHEN v_action='LOAD_PARTIAL' THEN now() WHEN v_to='PICKING' THEN NULL ELSE load_override_at END WHERE id=t.id;
 UPDATE public.wh_packages SET status='AVAILABLE',task_id=NULL,lpn_id=NULL,task_line_id=NULL WHERE task_id=t.id AND status NOT IN ('VOID','LOADED') AND v_to='CANCELLED';
 IF v_to='CANCELLED' THEN
  UPDATE public.wh_task_lines SET picked_qty=0,packed_qty=0 WHERE task_id=t.id AND loaded_qty=0;
  UPDATE public.wh_lpns SET status='VOID',void_reason=trim(p_reason) WHERE task_id=t.id AND status IN ('OPEN','CLOSED');
  INSERT INTO public.wh_scan_events(site_id,task_id,event_type,scanned_code,payload,operator_id,client_event_id)
   VALUES(t.site_id,t.id,'TASK_CANCELLED',t.task_code,jsonb_build_object('reason',trim(p_reason),'lpn_disassembled',true),auth.uid(),gen_random_uuid());
 END IF;
 RETURN jsonb_build_object('id',t.id,'status',v_to,'remaining_qty',coalesce(v_open,0),'partial_override',v_action='LOAD_PARTIAL');
END $function$
;

CREATE OR REPLACE FUNCTION public.wh_task_status_for_request(p_status text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT CASE upper(coalesce(p_status,'')) WHEN 'PENDIENTE' THEN 'PENDING' WHEN 'PENDIENTE DE APROBACIÓN' THEN 'PENDING' WHEN 'PENDIENTE DE APROBACION' THEN 'PENDING' WHEN 'APROBADA' THEN 'PENDING' WHEN 'REPROGRAMADA' THEN 'PENDING' WHEN 'OBSERVADA' THEN 'PAUSED' WHEN 'RECHAZADA' THEN 'CANCELLED' WHEN 'CANCELADA' THEN 'CANCELLED' ELSE NULL END
$function$
;

CREATE OR REPLACE FUNCTION public.wh_touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$ BEGIN NEW.updated_at=now(); RETURN NEW; END $function$
;

CREATE OR REPLACE FUNCTION public.wh_validate_receipt(p_receipt_key text, p_physical_quantity numeric, p_variance_reason text DEFAULT NULL::text, p_manual_customer_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$
;

CREATE OR REPLACE FUNCTION public.wh_void_package(p_package_code text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE p public.wh_packages%ROWTYPE;
BEGIN
 PERFORM public.security_assert_active_session(); IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) OR nullif(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Anulación requiere supervisión y motivo'; END IF;
 SELECT * INTO p FROM public.wh_packages WHERE package_code=trim(p_package_code) FOR UPDATE;
 IF NOT FOUND OR NOT public.can_access_site(p.site_id) OR p.status IN ('LOADED','VOID') THEN RAISE EXCEPTION 'Paquete no se puede anular'; END IF;
 IF p.task_line_id IS NOT NULL AND p.task_id IS NOT NULL THEN
  UPDATE public.wh_task_lines SET
   picked_qty=greatest(0,picked_qty-CASE WHEN p.status IN ('PICKED','PACKED') THEN p.quantity ELSE 0 END),
   packed_qty=greatest(0,packed_qty-CASE WHEN p.status='PACKED' THEN p.quantity ELSE 0 END)
   WHERE id=p.task_line_id AND task_id=p.task_id;
 END IF;
 IF p.lpn_id IS NOT NULL THEN
  UPDATE public.wh_packages SET lpn_id=NULL WHERE lpn_id=p.lpn_id AND id<>p.id AND status='PACKED';
  UPDATE public.wh_lpns SET status='VOID',void_reason=trim(p_reason),package_count=0,quantity=0,weight_kg=0 WHERE id=p.lpn_id AND status IN ('OPEN','CLOSED');
 END IF;
 UPDATE public.wh_packages SET status='VOID',void_reason=trim(p_reason),lpn_id=NULL WHERE id=p.id;
 INSERT INTO public.wh_scan_events(site_id,task_id,package_id,event_type,scanned_code,payload,operator_id,client_event_id)
  VALUES(p.site_id,p.task_id,p.id,'PACKAGE_VOID',p.package_code,jsonb_build_object('reason',trim(p_reason)),auth.uid(),gen_random_uuid());
 RETURN jsonb_build_object('package_code',p.package_code,'status','VOID');
END $function$
;

CREATE TYPE public."contract_type" AS ENUM ('CONTRATO','SUBCONTRATO','OT_INDEPENDIENTE','ERROR','GARANTIA');

CREATE SEQUENCE public."inv_movements_id_seq" AS bigint;

CREATE TABLE public."app_versions" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "platform" text NOT NULL,
 "channel" text DEFAULT 'stable'::text NOT NULL,
 "version" text NOT NULL,
 "build_number" integer,
 "web_build_id" text,
 "release_date" timestamp with time zone DEFAULT now() NOT NULL,
 "release_notes" text DEFAULT ''::text NOT NULL,
 "mandatory" boolean DEFAULT false NOT NULL,
 "mandatory_after" timestamp with time zone,
 "minimum_supported_version" text,
 "minimum_supported_build" integer,
 "installer_url" text,
 "artifact_sha256" text,
 "status" text DEFAULT 'draft'::text NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."carriers" (
 "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
 "type" character varying(20) NOT NULL,
 "business_name" character varying(255) NOT NULL,
 "ruc" character varying(20) NOT NULL,
 "contact_name" character varying(150),
 "phone" character varying(50),
 "email" character varying(150),
 "address" text,
 "status" character varying(20) DEFAULT 'ACTIVE'::character varying,
 "created_at" timestamp with time zone DEFAULT now(),
 "updated_at" timestamp with time zone DEFAULT now(),
 "supplier_id" uuid
);

CREATE TABLE public."clients" (
 "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
 "business_name" character varying(255) NOT NULL,
 "ruc" character varying(20) NOT NULL,
 "commercial_name" character varying(255),
 "contact_name" character varying(150),
 "phone" character varying(50),
 "email" character varying(150),
 "address" text,
 "city" character varying(100),
 "department" character varying(100),
 "status" character varying(20) DEFAULT 'ACTIVE'::character varying,
 "observations" text,
 "created_at" timestamp with time zone DEFAULT now(),
 "updated_at" timestamp with time zone DEFAULT now(),
 "sunat_verified_at" timestamp with time zone,
 "sunat_status" text,
 "country_code" text,
 "country_name" text
);

CREATE TABLE public."contracts" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "code" character varying(100) NOT NULL,
 "type" contract_type DEFAULT 'CONTRATO'::contract_type NOT NULL,
 "client_id" uuid,
 "status" character varying(50) DEFAULT 'ACTIVO'::character varying,
 "is_new" boolean DEFAULT true,
 "created_at" timestamp with time zone DEFAULT now(),
 "updated_at" timestamp with time zone DEFAULT now(),
 "parent_contract_id" uuid,
 "total_weight_kg" numeric(10,2) DEFAULT 0,
 "total_volume_m3" numeric(10,2) DEFAULT 0,
 "destination_department" character varying(100),
 "destination_province" character varying(100),
 "destination_district" character varying(100),
 "destination_address" character varying(255),
 "site_id" uuid DEFAULT primary_site_id() NOT NULL,
 "subcontract_id" uuid,
 "created_by" uuid,
 "garantia_id" uuid
);

CREATE TABLE public."cost_centers" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "code" character varying(50) NOT NULL,
 "name" character varying(100) NOT NULL,
 "type" character varying(50) NOT NULL,
 "description" text,
 "is_active" boolean DEFAULT true,
 "created_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE public."dispatch_documents" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "dispatch_id" uuid NOT NULL,
 "transport_request_id" uuid,
 "doc_type" text NOT NULL,
 "cargo_type" text,
 "document_number" text,
 "file_path" text NOT NULL,
 "file_name" text,
 "mime_type" text,
 "size_bytes" bigint,
 "notes" text,
 "uploaded_by" uuid,
 "uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
 "voided_at" timestamp with time zone,
 "voided_by" uuid,
 "void_reason" text,
 "auditor_name" text,
 "auditor_signed_date" date,
 "auditor_signature_confirmed" boolean DEFAULT false NOT NULL,
 "category" text
);

CREATE TABLE public."dispatch_requests" (
 "dispatch_id" uuid NOT NULL,
 "transport_request_id" uuid NOT NULL,
 "sequence_order" integer,
 "status" character varying(50) DEFAULT 'PROGRAMADO'::character varying,
 "created_at" timestamp with time zone DEFAULT now(),
 "leg_actual_km" numeric(12,3),
 "leg_gps_complete" boolean,
 "arrival_lat" numeric(10,7),
 "arrival_lon" numeric(10,7),
 "document_type" character varying(20) DEFAULT 'GR'::character varying,
 "document_number" character varying(50),
 "stop_odometer" numeric(12,1),
 "stop_odometer_photo" text,
 "stop_odometer_at" timestamp with time zone,
 "stop_odometer_flag" text,
 "leg_odometer_km" numeric(12,3),
 "leg_km_source" text
);

CREATE TABLE public."dispatches" (
 "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
 "dispatch_number" character varying(50) NOT NULL,
 "scheduled_date" timestamp with time zone NOT NULL,
 "status" character varying(50) DEFAULT 'PROGRAMADO'::character varying,
 "created_by" uuid,
 "created_at" timestamp with time zone DEFAULT now(),
 "updated_at" timestamp with time zone DEFAULT now(),
 "estimated_distance_km" numeric(10,2) DEFAULT 0,
 "driver_id" uuid,
 "start_lat" numeric(10,7),
 "start_lon" numeric(10,7),
 "actual_distance_km" numeric(12,3) DEFAULT 0 NOT NULL,
 "last_lat" numeric(10,7),
 "last_lon" numeric(10,7),
 "last_gps_at" timestamp with time zone,
 "gps_coverage_complete" boolean,
 "vehicle_plate" text,
 "return_actual_km" numeric(12,3),
 "return_gps_complete" boolean,
 "returned_at" timestamp with time zone,
 "estimated_km" numeric(10,2),
 "estimated_cost" numeric(10,2),
 "freight_cost" numeric(10,2) DEFAULT 0.00,
 "contract_id" uuid,
 "tracking_token" uuid,
 "tracking_pin" text,
 "tracking_expires_at" timestamp with time zone,
 "driver_name" text,
 "scheduled_departure" timestamp with time zone,
 "site_id" uuid DEFAULT primary_site_id() NOT NULL,
 "end_odometer" numeric(10,2),
 "arrival_time" timestamp with time zone,
 "liquidation_data" jsonb,
 "start_odometer" numeric,
 "docs_required" boolean DEFAULT false NOT NULL,
 "docs_ready_at" timestamp with time zone,
 "docs_ready_by" uuid,
 "docs_reissue" boolean DEFAULT false NOT NULL,
 "docs_reissue_reason" text,
 "docs_reissue_at" timestamp with time zone,
 "freight_breakdown" jsonb,
 "modalidad" text DEFAULT 'PROPIA'::text NOT NULL,
 "carrier_id" uuid,
 "tercero_conductor" text,
 "tercero_telefono" text,
 "tercero_doc" text,
 "tercero_salida_at" timestamp with time zone,
 "tercero_entrega_at" timestamp with time zone,
 "cost_center_id" uuid,
 "legacy_dispatch_number" text,
 "daily_cutoff_at" timestamp with time zone,
 "operational_closed_at" timestamp with time zone,
 "operational_previous_status" text,
 "tercero_license_number" text,
 "tercero_license_expiration" date,
 "programming_notes" text,
 "actual_distance_source" text
);

CREATE TABLE public."drivers" (
 "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
 "carrier_id" uuid NOT NULL,
 "profile_id" uuid,
 "document_id" character varying(20) NOT NULL,
 "first_name" character varying(100) NOT NULL,
 "last_name" character varying(100) NOT NULL,
 "phone" character varying(50),
 "license_number" character varying(50) NOT NULL,
 "license_category" character varying(20),
 "license_expiration" date,
 "status" character varying(20) DEFAULT 'ACTIVE'::character varying,
 "created_at" timestamp with time zone DEFAULT now(),
 "updated_at" timestamp with time zone DEFAULT now(),
 "is_active" boolean DEFAULT true NOT NULL,
 "pin" character varying(20),
 "document_number" character varying(20)
);

CREATE TABLE public."erp_contract_lines" (
 "import_id" uuid NOT NULL,
 "nro_documento" text NOT NULL,
 "secuencia" integer NOT NULL,
 "ot" text NOT NULL,
 "tipo_documento" text,
 "correlativo" bigint,
 "fecha_contrato" date,
 "fecha_vcto" date,
 "vigencia" text,
 "ruc" text,
 "cliente" text,
 "cod_producto" text NOT NULL,
 "producto" text,
 "color" text,
 "unidad" text,
 "cant_contrato" numeric(20,6) DEFAULT 0 NOT NULL,
 "cant_despachada" numeric(20,6) DEFAULT 0 NOT NULL,
 "cant_reemplazada" numeric(20,6) DEFAULT 0 NOT NULL,
 "cant_pendiente" numeric(20,6) DEFAULT 0 NOT NULL,
 "estado" text,
 "nro_guias" integer DEFAULT 0 NOT NULL,
 "fecha_ult_despacho" date,
 "tipo_producto" text,
 "tipo" text,
 "familia" text,
 "subfamilia" text,
 "peso_unit" numeric(20,6),
 "unidad_erp" text,
 "linea" integer,
 "cantidades_ausentes" boolean DEFAULT false NOT NULL,
 "cantidades_ausentes_campos" text[] DEFAULT '{}'::text[] NOT NULL
);

CREATE TABLE public."erp_imports" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "kind" text NOT NULL,
 "status" text DEFAULT 'CARGANDO'::text NOT NULL,
 "file_name" text NOT NULL,
 "cut_at" timestamp with time zone,
 "expected" integer NOT NULL,
 "rows_loaded" integer DEFAULT 0 NOT NULL,
 "summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
 "created_by" uuid,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "applied_at" timestamp with time zone,
 "rule_version" integer
);

CREATE TABLE public."inv_movements" (
 "id" bigint DEFAULT nextval('inv_movements_id_seq'::regclass) NOT NULL,
 "upload_id" uuid NOT NULL,
 "side" text NOT NULL,
 "active" boolean DEFAULT false NOT NULL,
 "linea" integer NOT NULL,
 "tipodocto" text NOT NULL,
 "clase" text DEFAULT 'OTRO'::text NOT NULL,
 "bodega" text NOT NULL,
 "numero" text NOT NULL,
 "fecha" date NOT NULL,
 "cod_legal" text,
 "razon_social" text,
 "producto" text NOT NULL,
 "glosa" text,
 "cantidad" numeric(20,6) NOT NULL,
 "unidad" text,
 "doc_rel" text,
 "num_rel" text,
 "fecha_entrega" date,
 "contrato" text,
 "ref_tipo" text,
 "ref_correlativo" text,
 "ref_numero" text,
 "ref_fecha" date,
 "lote_raw" text,
 "lote" text,
 "ot" text,
 "comentario" text,
 "peso_unit" numeric(20,6),
 "peso_kg" numeric(20,6),
 "ccosto" text
);

CREATE TABLE public."inv_uploads" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "side" text NOT NULL,
 "file_name" text NOT NULL,
 "status" text DEFAULT 'CARGANDO'::text NOT NULL,
 "cutoff" date,
 "desde" date,
 "hasta" date,
 "rows_total" integer DEFAULT 0 NOT NULL,
 "rows_valid" integer DEFAULT 0 NOT NULL,
 "excluded" jsonb DEFAULT '{}'::jsonb NOT NULL,
 "replaced" integer,
 "created_by" uuid,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "applied_at" timestamp with time zone
);

CREATE TABLE public."profiles" (
 "id" uuid NOT NULL,
 "email" character varying(255) NOT NULL,
 "first_name" character varying(100),
 "last_name" character varying(100),
 "document_id" character varying(20),
 "role_id" uuid,
 "is_active" boolean DEFAULT true,
 "created_at" timestamp with time zone DEFAULT now(),
 "updated_at" timestamp with time zone DEFAULT now(),
 "requires_password_change" boolean DEFAULT true,
 "password_changed_at" timestamp with time zone,
 "employee_type" character varying(50),
 "license_type" character varying(20),
 "license_expiration" date,
 "document_number" character varying(20),
 "phone" character varying(50),
 "username" character varying(255),
 "area" text
);

CREATE TABLE public."roles" (
 "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
 "name" character varying(50) NOT NULL,
 "description" text,
 "created_at" timestamp with time zone DEFAULT now(),
 "permissions" jsonb DEFAULT '[]'::jsonb
);

CREATE TABLE public."sites" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "code" text NOT NULL,
 "name" text NOT NULL,
 "is_active" boolean DEFAULT true NOT NULL
);

CREATE TABLE public."supplier_locations" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "supplier_id" uuid NOT NULL,
 "name" text NOT NULL,
 "address" text NOT NULL,
 "department" text,
 "province" text,
 "district" text,
 "contact_name" text,
 "contact_phone" text,
 "is_active" boolean DEFAULT true NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."suppliers" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "tax_id" text NOT NULL,
 "business_name" text NOT NULL,
 "category" text DEFAULT 'MATERIA_PRIMA'::text NOT NULL,
 "contact_name" text,
 "contact_phone" text,
 "contact_email" text,
 "notes" text,
 "is_active" boolean DEFAULT true NOT NULL,
 "created_by" uuid DEFAULT auth.uid(),
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."transport_request_components" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "request_id" uuid NOT NULL,
 "component_contract_id" uuid NOT NULL,
 "requested_weight_kg" numeric(12,2),
 "requested_volume_m3" numeric(12,2),
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."transport_requests" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "request_number" character varying(50) NOT NULL,
 "requester_name" character varying(200),
 "pickup_address" text,
 "delivery_address" text,
 "request_type" character varying(50) DEFAULT 'DESPACHO'::character varying,
 "status" character varying(50) DEFAULT 'PENDIENTE'::character varying,
 "required_date" date,
 "created_at" timestamp with time zone DEFAULT now(),
 "updated_at" timestamp with time zone DEFAULT now(),
 "time_window" character varying(100),
 "service_cost" numeric(10,2) DEFAULT 0.00,
 "service_balance" numeric(10,2) DEFAULT 0.00,
 "budget_amount" numeric(10,2) DEFAULT 0.00,
 "cost_per_km" numeric(10,2) DEFAULT 0.00,
 "liquidation_notes" text,
 "pickup_department" text,
 "pickup_province" text,
 "pickup_district" text,
 "delivery_department" text,
 "delivery_province" text,
 "delivery_district" text,
 "contract_id" uuid,
 "estimated_volume" numeric(10,2) DEFAULT 0,
 "purchase_order" character varying(100),
 "site_id" uuid DEFAULT primary_site_id() NOT NULL,
 "created_by" uuid,
 "budget_shortfall" numeric(15,2) DEFAULT 0 NOT NULL,
 "budget_observation" text,
 "reserved_pen" numeric(15,2) DEFAULT 0 NOT NULL,
 "approved_at" timestamp with time zone,
 "approved_by" uuid,
 "unloading_estimate_pen" numeric(15,2) DEFAULT 0 NOT NULL,
 "unloading_required" boolean,
 "cost_breakdown" jsonb,
 "cost_source" text,
 "cost_override_reason" text,
 "attention_mode" text,
 "cost_center_id" uuid,
 "operational_approved_pen" numeric DEFAULT 0 NOT NULL,
 "pickup_customer" text,
 "pickup_contact" text,
 "pickup_phone" text,
 "required_at" timestamp with time zone,
 "delivery_zone" text,
 "lead_time_policy" jsonb,
 "supplier_id" uuid,
 "supplier_location_id" uuid,
 "reference_type" text,
 "reference_number" text,
 "client_id" uuid,
 "reference_supplier_id" uuid
);

CREATE TABLE public."user_site_access" (
 "user_id" uuid NOT NULL,
 "site_id" uuid NOT NULL
);

CREATE TABLE public."wh_locations" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "site_id" uuid NOT NULL,
 "code" text NOT NULL,
 "label" text NOT NULL,
 "zone" text,
 "active" boolean DEFAULT true NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."wh_lpns" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "lpn_code" text NOT NULL,
 "site_id" uuid NOT NULL,
 "task_id" uuid,
 "status" text DEFAULT 'OPEN'::text NOT NULL,
 "package_count" integer DEFAULT 0 NOT NULL,
 "quantity" numeric(14,3) DEFAULT 0 NOT NULL,
 "weight_kg" numeric(14,3) DEFAULT 0 NOT NULL,
 "print_count" integer DEFAULT 0 NOT NULL,
 "closed_by" uuid,
 "closed_at" timestamp with time zone,
 "void_reason" text,
 "created_by" uuid,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."wh_operator_badges" (
 "profile_id" uuid NOT NULL,
 "badge_code" text NOT NULL,
 "pin_hash" text NOT NULL,
 "active" boolean DEFAULT true NOT NULL,
 "created_by" uuid,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."wh_pack_sizes" (
 "product_code" text NOT NULL,
 "units_per_package" numeric(14,3) NOT NULL,
 "unit" text,
 "updated_by" uuid,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."wh_packages" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "package_code" text NOT NULL,
 "source_system" text DEFAULT 'ERP'::text NOT NULL,
 "source_document_no" text NOT NULL,
 "source_contract_code" text,
 "source_lot" text DEFAULT ''::text NOT NULL,
 "source_product_code" text NOT NULL,
 "source_unit" text DEFAULT ''::text NOT NULL,
 "source_warehouse" text NOT NULL,
 "source_date" date NOT NULL,
 "source_movement_key" text NOT NULL,
 "source_label_version" integer DEFAULT 1 NOT NULL,
 "source_key" text NOT NULL,
 "transport_request_id" uuid,
 "contract_id" uuid,
 "site_id" uuid NOT NULL,
 "description" text NOT NULL,
 "quantity" numeric(14,3) NOT NULL,
 "unit" text,
 "weight_kg" numeric(14,3),
 "sequence_no" integer DEFAULT 1 NOT NULL,
 "sequence_total" integer DEFAULT 1 NOT NULL,
 "source_qty_snapshot" numeric(14,3),
 "source_expected_total" numeric(14,3),
 "source_expected_count" integer,
 "quantity_mismatch" boolean GENERATED ALWAYS AS (((source_qty_snapshot IS NOT NULL) AND ((source_qty_snapshot <> quantity) OR ((source_expected_count IS NOT NULL) AND ((sequence_no > source_expected_count) OR (sequence_total <> source_expected_count)))))) STORED,
 "status" text DEFAULT 'AVAILABLE'::text NOT NULL,
 "task_id" uuid,
 "task_line_id" uuid,
 "lpn_id" uuid,
 "dispatch_id" uuid,
 "location_id" uuid,
 "label_print_count" integer DEFAULT 0 NOT NULL,
 "void_reason" text,
 "created_by" uuid,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."wh_receipt_import_runs" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "file_name" text NOT NULL,
 "file_hash" text NOT NULL,
 "row_count" integer NOT NULL,
 "imported_by" uuid NOT NULL,
 "imported_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."wh_receipt_sources" (
 "source_key" text NOT NULL,
 "site_id" uuid NOT NULL,
 "document_no" text NOT NULL,
 "source_date" date NOT NULL,
 "warehouse" text NOT NULL,
 "ruc" text,
 "customer_name" text,
 "product_code" text NOT NULL,
 "description" text,
 "quantity" numeric(14,3) NOT NULL,
 "unit" text,
 "lot" text,
 "origin_doc" text,
 "origin_number" text,
 "delivery_date" date,
 "contract_code" text,
 "ref_doc_type" text,
 "ref_correlation" text,
 "ref_number" text,
 "ref_date" date,
 "comment" text,
 "unit_weight" numeric(14,3),
 "total_weight" numeric(14,3),
 "cost_center" text,
 "source_import_hash" text NOT NULL,
 "active" boolean DEFAULT true NOT NULL,
 "imported_at" timestamp with time zone DEFAULT now() NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."wh_receipt_validations" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "source_movement_key" text NOT NULL,
 "site_id" uuid NOT NULL,
 "erp_quantity" numeric(14,3) NOT NULL,
 "physical_quantity" numeric(14,3) NOT NULL,
 "variance" numeric(14,3) GENERATED ALWAYS AS ((physical_quantity - erp_quantity)) STORED,
 "variance_reason" text,
 "manual_customer_name" text,
 "validated_by" uuid NOT NULL,
 "validated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."wh_reconciliation" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "site_id" uuid NOT NULL,
 "task_id" uuid,
 "package_code" text NOT NULL,
 "erp_qty" numeric(14,3),
 "physical_qty" numeric(14,3),
 "variance" numeric(14,3) GENERATED ALWAYS AS ((COALESCE(physical_qty, (0)::numeric) - COALESCE(erp_qty, (0)::numeric))) STORED,
 "status" text DEFAULT 'OPEN'::text NOT NULL,
 "resolution" text,
 "resolved_by" uuid,
 "resolved_at" timestamp with time zone,
 "source_batch" text,
 "source_document_no" text,
 "source_reference_no" text,
 "source_lot" text,
 "source_product_code" text,
 "source_date" date,
 "dispatch_id" uuid,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."wh_scan_events" (
 "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
 "site_id" uuid NOT NULL,
 "task_id" uuid,
 "package_id" uuid,
 "lpn_id" uuid,
 "event_type" text NOT NULL,
 "scanned_code" text NOT NULL,
 "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
 "operator_id" uuid NOT NULL,
 "client_event_id" uuid NOT NULL,
 "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
 "recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."wh_task_lines" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "task_id" uuid NOT NULL,
 "transport_request_item_id" uuid,
 "contract_id" uuid,
 "product_code" text,
 "description" text NOT NULL,
 "lot" text,
 "requested_qty" numeric(14,3),
 "picked_qty" numeric(14,3) DEFAULT 0 NOT NULL,
 "packed_qty" numeric(14,3) DEFAULT 0 NOT NULL,
 "loaded_qty" numeric(14,3) DEFAULT 0 NOT NULL,
 "remaining_qty" numeric(14,3) GENERATED ALWAYS AS (GREATEST((COALESCE(requested_qty, (0)::numeric) - loaded_qty), (0)::numeric)) STORED,
 "overpicked_qty" numeric(14,3) GENERATED ALWAYS AS (GREATEST((picked_qty - COALESCE(requested_qty, picked_qty)), (0)::numeric)) STORED,
 "unit" text,
 "weight_kg" numeric(14,3),
 "source" text DEFAULT 'REQUEST'::text NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."wh_tasks" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "task_code" text NOT NULL,
 "transport_request_id" uuid NOT NULL,
 "site_id" uuid NOT NULL,
 "contract_id" uuid,
 "status" text DEFAULT 'PENDING'::text NOT NULL,
 "request_status" text DEFAULT 'PENDIENTE'::text NOT NULL,
 "dispatch_id" uuid,
 "assigned_picker" uuid,
 "assigned_packer" uuid,
 "created_by" uuid,
 "updated_by" uuid,
 "load_override_reason" text,
 "load_override_by" uuid,
 "load_override_at" timestamp with time zone,
 "paused_reason" text,
 "cancelled_reason" text,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
 "loaded_at" timestamp with time zone,
 "reconciled_at" timestamp with time zone
);

ALTER TABLE public."app_versions" ADD CONSTRAINT "app_versions_pkey" PRIMARY KEY (id);

ALTER TABLE public."carriers" ADD CONSTRAINT "carriers_pkey" PRIMARY KEY (id);

ALTER TABLE public."clients" ADD CONSTRAINT "clients_pkey" PRIMARY KEY (id);

ALTER TABLE public."contracts" ADD CONSTRAINT "contracts_pkey" PRIMARY KEY (id);

ALTER TABLE public."cost_centers" ADD CONSTRAINT "cost_centers_pkey" PRIMARY KEY (id);

ALTER TABLE public."dispatch_documents" ADD CONSTRAINT "dispatch_documents_pkey" PRIMARY KEY (id);

ALTER TABLE public."dispatch_requests" ADD CONSTRAINT "dispatch_requests_pkey" PRIMARY KEY (dispatch_id, transport_request_id);

ALTER TABLE public."dispatches" ADD CONSTRAINT "dispatches_pkey" PRIMARY KEY (id);

ALTER TABLE public."drivers" ADD CONSTRAINT "drivers_pkey" PRIMARY KEY (id);

ALTER TABLE public."erp_contract_lines" ADD CONSTRAINT "erp_contract_lines_pkey" PRIMARY KEY (import_id, nro_documento, secuencia);

ALTER TABLE public."erp_imports" ADD CONSTRAINT "erp_imports_pkey" PRIMARY KEY (id);

ALTER TABLE public."inv_movements" ADD CONSTRAINT "inv_movements_pkey" PRIMARY KEY (id);

ALTER TABLE public."inv_uploads" ADD CONSTRAINT "inv_uploads_pkey" PRIMARY KEY (id);

ALTER TABLE public."profiles" ADD CONSTRAINT "profiles_pkey" PRIMARY KEY (id);

ALTER TABLE public."roles" ADD CONSTRAINT "roles_pkey" PRIMARY KEY (id);

ALTER TABLE public."sites" ADD CONSTRAINT "sites_pkey" PRIMARY KEY (id);

ALTER TABLE public."supplier_locations" ADD CONSTRAINT "supplier_locations_pkey" PRIMARY KEY (id);

ALTER TABLE public."suppliers" ADD CONSTRAINT "suppliers_pkey" PRIMARY KEY (id);

ALTER TABLE public."transport_request_components" ADD CONSTRAINT "transport_request_components_pkey" PRIMARY KEY (id);

ALTER TABLE public."transport_requests" ADD CONSTRAINT "transport_requests_pkey" PRIMARY KEY (id);

ALTER TABLE public."user_site_access" ADD CONSTRAINT "user_site_access_pkey" PRIMARY KEY (user_id, site_id);

ALTER TABLE public."wh_locations" ADD CONSTRAINT "wh_locations_pkey" PRIMARY KEY (id);

ALTER TABLE public."wh_lpns" ADD CONSTRAINT "wh_lpns_pkey" PRIMARY KEY (id);

ALTER TABLE public."wh_operator_badges" ADD CONSTRAINT "wh_operator_badges_pkey" PRIMARY KEY (profile_id);

ALTER TABLE public."wh_pack_sizes" ADD CONSTRAINT "wh_pack_sizes_pkey" PRIMARY KEY (product_code);

ALTER TABLE public."wh_packages" ADD CONSTRAINT "wh_packages_pkey" PRIMARY KEY (id);

ALTER TABLE public."wh_receipt_import_runs" ADD CONSTRAINT "wh_receipt_import_runs_pkey" PRIMARY KEY (id);

ALTER TABLE public."wh_receipt_sources" ADD CONSTRAINT "wh_receipt_sources_pkey" PRIMARY KEY (source_key);

ALTER TABLE public."wh_receipt_validations" ADD CONSTRAINT "wh_receipt_validations_pkey" PRIMARY KEY (id);

ALTER TABLE public."wh_reconciliation" ADD CONSTRAINT "wh_reconciliation_pkey" PRIMARY KEY (id);

ALTER TABLE public."wh_scan_events" ADD CONSTRAINT "wh_scan_events_pkey" PRIMARY KEY (id);

ALTER TABLE public."wh_task_lines" ADD CONSTRAINT "wh_task_lines_pkey" PRIMARY KEY (id);

ALTER TABLE public."wh_tasks" ADD CONSTRAINT "wh_tasks_pkey" PRIMARY KEY (id);

ALTER TABLE public."app_versions" ADD CONSTRAINT "app_versions_platform_channel_version_key" UNIQUE (platform, channel, version);

ALTER TABLE public."carriers" ADD CONSTRAINT "carriers_ruc_key" UNIQUE (ruc);

ALTER TABLE public."clients" ADD CONSTRAINT "clients_ruc_key" UNIQUE (ruc);

ALTER TABLE public."contracts" ADD CONSTRAINT "contracts_code_key" UNIQUE (code);

ALTER TABLE public."cost_centers" ADD CONSTRAINT "cost_centers_code_key" UNIQUE (code);

ALTER TABLE public."dispatches" ADD CONSTRAINT "dispatches_dispatch_number_key" UNIQUE (dispatch_number);

ALTER TABLE public."dispatches" ADD CONSTRAINT "dispatches_tracking_token_key" UNIQUE (tracking_token);

ALTER TABLE public."drivers" ADD CONSTRAINT "drivers_document_id_key" UNIQUE (document_id);

ALTER TABLE public."roles" ADD CONSTRAINT "roles_name_key" UNIQUE (name);

ALTER TABLE public."sites" ADD CONSTRAINT "sites_code_key" UNIQUE (code);

ALTER TABLE public."transport_request_components" ADD CONSTRAINT "transport_request_components_request_id_component_contract__key" UNIQUE (request_id, component_contract_id);

ALTER TABLE public."transport_requests" ADD CONSTRAINT "transport_requests_request_number_key" UNIQUE (request_number);

ALTER TABLE public."wh_locations" ADD CONSTRAINT "wh_locations_site_id_code_key" UNIQUE (site_id, code);

ALTER TABLE public."wh_lpns" ADD CONSTRAINT "wh_lpns_lpn_code_key" UNIQUE (lpn_code);

ALTER TABLE public."wh_operator_badges" ADD CONSTRAINT "wh_operator_badges_badge_code_key" UNIQUE (badge_code);

ALTER TABLE public."wh_packages" ADD CONSTRAINT "wh_packages_package_code_key" UNIQUE (package_code);

ALTER TABLE public."wh_packages" ADD CONSTRAINT "wh_packages_source_key_key" UNIQUE (source_key);

ALTER TABLE public."wh_receipt_import_runs" ADD CONSTRAINT "wh_receipt_import_runs_file_hash_key" UNIQUE (file_hash);

ALTER TABLE public."wh_reconciliation" ADD CONSTRAINT "wh_reconciliation_site_id_package_code_source_batch_key" UNIQUE (site_id, package_code, source_batch);

ALTER TABLE public."wh_scan_events" ADD CONSTRAINT "wh_scan_events_site_id_client_event_id_key" UNIQUE (site_id, client_event_id);

ALTER TABLE public."wh_task_lines" ADD CONSTRAINT "wh_task_lines_task_id_transport_request_item_id_key" UNIQUE (task_id, transport_request_item_id);

ALTER TABLE public."wh_tasks" ADD CONSTRAINT "wh_tasks_task_code_key" UNIQUE (task_code);

ALTER TABLE public."wh_tasks" ADD CONSTRAINT "wh_tasks_transport_request_id_key" UNIQUE (transport_request_id);

ALTER TABLE public."app_versions" ADD CONSTRAINT "app_versions_artifact_sha256_check" CHECK (((artifact_sha256 IS NULL) OR (artifact_sha256 ~ '^[0-9a-f]{64}$'::text)));

ALTER TABLE public."app_versions" ADD CONSTRAINT "app_versions_check" CHECK (((platform <> 'android'::text) OR (build_number IS NOT NULL)));

ALTER TABLE public."app_versions" ADD CONSTRAINT "app_versions_check1" CHECK (((platform <> 'android'::text) OR (status <> 'published'::text) OR ((installer_url ~ '^https://'::text) AND (artifact_sha256 IS NOT NULL))));

ALTER TABLE public."app_versions" ADD CONSTRAINT "app_versions_platform_check" CHECK ((platform = ANY (ARRAY['web'::text, 'android'::text])));

ALTER TABLE public."app_versions" ADD CONSTRAINT "app_versions_status_check" CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'retired'::text])));

ALTER TABLE public."dispatch_documents" ADD CONSTRAINT "dispatch_documents_cargo_type_check" CHECK ((cargo_type = ANY (ARRAY['PT'::text, 'SUMINISTROS'::text, 'OTROS'::text])));

ALTER TABLE public."dispatch_documents" ADD CONSTRAINT "dispatch_documents_category_check" CHECK (((category IS NULL) OR (category = ANY (ARRAY['CONFORMIDAD'::text, 'EVIDENCIA'::text, 'COMPROBANTE'::text, 'OTROS'::text])))) NOT VALID;

ALTER TABLE public."dispatch_documents" ADD CONSTRAINT "dispatch_documents_doc_type_check" CHECK ((doc_type = ANY (ARRAY['GUIA_REMISION'::text, 'PACKING_LIST'::text, 'NOTA_DESPACHO'::text, 'OTRO'::text])));

ALTER TABLE public."dispatch_requests" ADD CONSTRAINT "dispatch_requests_leg_km_source_check" CHECK (((leg_km_source IS NULL) OR (leg_km_source = ANY (ARRAY['GPS_COMPLETO'::text, 'ODOMETRO'::text, 'GPS_PARCIAL'::text]))));

ALTER TABLE public."dispatch_requests" ADD CONSTRAINT "dispatch_requests_stop_odometer_flag_check" CHECK (((stop_odometer_flag IS NULL) OR (stop_odometer_flag = 'SALTO'::text)));

ALTER TABLE public."dispatches" ADD CONSTRAINT "dispatches_actual_distance_source_check" CHECK (((actual_distance_source IS NULL) OR (actual_distance_source = ANY (ARRAY['GPS'::text, 'ODOMETRO'::text]))));

ALTER TABLE public."dispatches" ADD CONSTRAINT "dispatches_modalidad_chk" CHECK ((modalidad = ANY (ARRAY['PROPIA'::text, 'TERCERO'::text])));

ALTER TABLE public."erp_imports" ADD CONSTRAINT "erp_imports_expected_check" CHECK ((expected > 0));

ALTER TABLE public."erp_imports" ADD CONSTRAINT "erp_imports_kind_check" CHECK ((kind = ANY (ARRAY['CONTRATOS'::text, 'STOCK'::text])));

ALTER TABLE public."erp_imports" ADD CONSTRAINT "erp_imports_status_check" CHECK ((status = ANY (ARRAY['CARGANDO'::text, 'ACTIVA'::text, 'REEMPLAZADA'::text])));

ALTER TABLE public."inv_movements" ADD CONSTRAINT "inv_movements_cantidad_check" CHECK ((cantidad <> (0)::numeric));

ALTER TABLE public."inv_movements" ADD CONSTRAINT "inv_movements_side_check" CHECK ((side = ANY (ARRAY['E'::text, 'S'::text])));

ALTER TABLE public."inv_uploads" ADD CONSTRAINT "inv_uploads_file_name_check" CHECK (((length(file_name) >= 1) AND (length(file_name) <= 300)));

ALTER TABLE public."inv_uploads" ADD CONSTRAINT "inv_uploads_side_check" CHECK ((side = ANY (ARRAY['E'::text, 'S'::text, 'STOCK'::text])));

ALTER TABLE public."inv_uploads" ADD CONSTRAINT "inv_uploads_status_check" CHECK ((status = ANY (ARRAY['CARGANDO'::text, 'APLICADA'::text, 'DESCARTADA'::text])));

ALTER TABLE public."supplier_locations" ADD CONSTRAINT "supplier_locations_present" CHECK (((btrim(name) <> ''::text) AND (btrim(address) <> ''::text)));

ALTER TABLE public."suppliers" ADD CONSTRAINT "suppliers_category_check" CHECK ((category = ANY (ARRAY['MATERIA_PRIMA'::text, 'INSUMOS'::text, 'PRODUCCION'::text, 'PROYECTOS'::text, 'SERVICIOS'::text, 'OTROS'::text, 'TRANSPORTE'::text, 'MONTACARGA'::text, 'GRUA'::text, 'ESTIBA'::text]))) NOT VALID;

ALTER TABLE public."suppliers" ADD CONSTRAINT "suppliers_name_present" CHECK ((btrim(business_name) <> ''::text));

ALTER TABLE public."suppliers" ADD CONSTRAINT "suppliers_tax_id_format" CHECK ((tax_id ~ '^[0-9]{11}$'::text));

ALTER TABLE public."transport_request_components" ADD CONSTRAINT "transport_request_components_requested_volume_m3_check" CHECK ((requested_volume_m3 >= (0)::numeric));

ALTER TABLE public."transport_request_components" ADD CONSTRAINT "transport_request_components_requested_weight_kg_check" CHECK ((requested_weight_kg >= (0)::numeric));

ALTER TABLE public."transport_requests" ADD CONSTRAINT "transport_requests_attention_mode_check" CHECK ((attention_mode = ANY (ARRAY['TRANSPORTE_JRM'::text, 'RECOJO_CLIENTE'::text])));

ALTER TABLE public."transport_requests" ADD CONSTRAINT "transport_requests_delivery_zone_check" CHECK ((delivery_zone = ANY (ARRAY['LIMA'::text, 'PROVINCIA'::text, 'EXTERIOR'::text])));

ALTER TABLE public."transport_requests" ADD CONSTRAINT "transport_requests_reference_type_check" CHECK (((reference_type IS NULL) OR (reference_type = ANY (ARRAY['OC'::text, 'RQ'::text, 'OS'::text]))));

ALTER TABLE public."wh_lpns" ADD CONSTRAINT "wh_lpns_status_check" CHECK ((status = ANY (ARRAY['OPEN'::text, 'CLOSED'::text, 'LOADED'::text, 'VOID'::text])));

ALTER TABLE public."wh_pack_sizes" ADD CONSTRAINT "wh_pack_sizes_units_per_package_check" CHECK ((units_per_package > (0)::numeric));

ALTER TABLE public."wh_packages" ADD CONSTRAINT "wh_packages_quantity_check" CHECK ((quantity > (0)::numeric));

ALTER TABLE public."wh_packages" ADD CONSTRAINT "wh_packages_status_check" CHECK ((status = ANY (ARRAY['AVAILABLE'::text, 'RESERVED'::text, 'PICKED'::text, 'PACKED'::text, 'LOADED'::text, 'VOID'::text])));

ALTER TABLE public."wh_receipt_import_runs" ADD CONSTRAINT "wh_receipt_import_runs_row_count_check" CHECK ((row_count >= 0));

ALTER TABLE public."wh_receipt_sources" ADD CONSTRAINT "wh_receipt_sources_quantity_check" CHECK ((quantity >= (0)::numeric));

ALTER TABLE public."wh_receipt_validations" ADD CONSTRAINT "wh_receipt_validations_erp_quantity_check" CHECK ((erp_quantity >= (0)::numeric));

ALTER TABLE public."wh_receipt_validations" ADD CONSTRAINT "wh_receipt_validations_physical_quantity_check" CHECK ((physical_quantity >= (0)::numeric));

ALTER TABLE public."wh_reconciliation" ADD CONSTRAINT "wh_reconciliation_status_check" CHECK ((status = ANY (ARRAY['OPEN'::text, 'MATCH'::text, 'SHORT'::text, 'OVER'::text, 'RESOLVED'::text, 'VOID'::text])));

ALTER TABLE public."wh_tasks" ADD CONSTRAINT "wh_tasks_status_check" CHECK ((status = ANY (ARRAY['PENDING'::text, 'PICKING'::text, 'PAUSED'::text, 'PACKING'::text, 'READY_FOR_LOAD'::text, 'PARTIAL'::text, 'LOADED'::text, 'RECONCILED'::text, 'CANCELLED'::text])));

ALTER TABLE public."carriers" ADD CONSTRAINT "carriers_supplier_id_fkey" FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL;

ALTER TABLE public."contracts" ADD CONSTRAINT "contracts_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;

ALTER TABLE public."contracts" ADD CONSTRAINT "contracts_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);

ALTER TABLE public."contracts" ADD CONSTRAINT "contracts_garantia_id_fkey" FOREIGN KEY (garantia_id) REFERENCES contracts(id) ON DELETE SET NULL;

ALTER TABLE public."contracts" ADD CONSTRAINT "contracts_parent_contract_id_fkey" FOREIGN KEY (parent_contract_id) REFERENCES contracts(id) ON DELETE CASCADE;

ALTER TABLE public."contracts" ADD CONSTRAINT "contracts_site_id_fkey" FOREIGN KEY (site_id) REFERENCES sites(id);

ALTER TABLE public."contracts" ADD CONSTRAINT "contracts_subcontract_id_fkey" FOREIGN KEY (subcontract_id) REFERENCES contracts(id);

ALTER TABLE public."dispatch_documents" ADD CONSTRAINT "dispatch_documents_dispatch_id_fkey" FOREIGN KEY (dispatch_id) REFERENCES dispatches(id) ON DELETE CASCADE;

ALTER TABLE public."dispatch_documents" ADD CONSTRAINT "dispatch_documents_transport_request_id_fkey" FOREIGN KEY (transport_request_id) REFERENCES transport_requests(id) ON DELETE SET NULL;

ALTER TABLE public."dispatch_documents" ADD CONSTRAINT "dispatch_documents_uploaded_by_fkey" FOREIGN KEY (uploaded_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public."dispatch_documents" ADD CONSTRAINT "dispatch_documents_voided_by_fkey" FOREIGN KEY (voided_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public."dispatch_requests" ADD CONSTRAINT "dispatch_requests_dispatch_id_fkey" FOREIGN KEY (dispatch_id) REFERENCES dispatches(id) ON DELETE CASCADE;

ALTER TABLE public."dispatch_requests" ADD CONSTRAINT "dispatch_requests_transport_request_id_fkey" FOREIGN KEY (transport_request_id) REFERENCES transport_requests(id) ON DELETE CASCADE;

ALTER TABLE public."dispatches" ADD CONSTRAINT "dispatches_contract_id_fkey" FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE SET NULL;

ALTER TABLE public."dispatches" ADD CONSTRAINT "dispatches_cost_center_id_fkey" FOREIGN KEY (cost_center_id) REFERENCES cost_centers(id);

ALTER TABLE public."dispatches" ADD CONSTRAINT "dispatches_created_by_fkey" FOREIGN KEY (created_by) REFERENCES profiles(id);

ALTER TABLE public."dispatches" ADD CONSTRAINT "dispatches_docs_ready_by_fkey" FOREIGN KEY (docs_ready_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public."dispatches" ADD CONSTRAINT "dispatches_driver_id_fkey" FOREIGN KEY (driver_id) REFERENCES drivers(id);

ALTER TABLE public."dispatches" ADD CONSTRAINT "dispatches_site_id_fkey" FOREIGN KEY (site_id) REFERENCES sites(id);

ALTER TABLE public."drivers" ADD CONSTRAINT "drivers_carrier_id_fkey" FOREIGN KEY (carrier_id) REFERENCES carriers(id);

ALTER TABLE public."drivers" ADD CONSTRAINT "drivers_profile_id_fkey" FOREIGN KEY (profile_id) REFERENCES profiles(id);

ALTER TABLE public."erp_contract_lines" ADD CONSTRAINT "erp_contract_lines_import_id_fkey" FOREIGN KEY (import_id) REFERENCES erp_imports(id) ON DELETE CASCADE;

ALTER TABLE public."inv_movements" ADD CONSTRAINT "inv_movements_upload_id_fkey" FOREIGN KEY (upload_id) REFERENCES inv_uploads(id) ON DELETE CASCADE;

ALTER TABLE public."profiles" ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public."profiles" ADD CONSTRAINT "profiles_role_id_fkey" FOREIGN KEY (role_id) REFERENCES roles(id);

ALTER TABLE public."supplier_locations" ADD CONSTRAINT "supplier_locations_supplier_id_fkey" FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE;

ALTER TABLE public."transport_request_components" ADD CONSTRAINT "transport_request_components_component_contract_id_fkey" FOREIGN KEY (component_contract_id) REFERENCES contracts(id) ON DELETE RESTRICT;

ALTER TABLE public."transport_request_components" ADD CONSTRAINT "transport_request_components_request_id_fkey" FOREIGN KEY (request_id) REFERENCES transport_requests(id) ON DELETE CASCADE;

ALTER TABLE public."transport_requests" ADD CONSTRAINT "transport_requests_approved_by_fkey" FOREIGN KEY (approved_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public."transport_requests" ADD CONSTRAINT "transport_requests_client_id_fkey" FOREIGN KEY (client_id) REFERENCES clients(id);

ALTER TABLE public."transport_requests" ADD CONSTRAINT "transport_requests_contract_id_fkey" FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE SET NULL;

ALTER TABLE public."transport_requests" ADD CONSTRAINT "transport_requests_cost_center_id_fkey" FOREIGN KEY (cost_center_id) REFERENCES cost_centers(id);

ALTER TABLE public."transport_requests" ADD CONSTRAINT "transport_requests_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);

ALTER TABLE public."transport_requests" ADD CONSTRAINT "transport_requests_reference_supplier_id_fkey" FOREIGN KEY (reference_supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT;

ALTER TABLE public."transport_requests" ADD CONSTRAINT "transport_requests_site_id_fkey" FOREIGN KEY (site_id) REFERENCES sites(id);

ALTER TABLE public."transport_requests" ADD CONSTRAINT "transport_requests_supplier_id_fkey" FOREIGN KEY (supplier_id) REFERENCES suppliers(id);

ALTER TABLE public."transport_requests" ADD CONSTRAINT "transport_requests_supplier_location_id_fkey" FOREIGN KEY (supplier_location_id) REFERENCES supplier_locations(id);

ALTER TABLE public."user_site_access" ADD CONSTRAINT "user_site_access_site_id_fkey" FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE;

ALTER TABLE public."user_site_access" ADD CONSTRAINT "user_site_access_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public."wh_locations" ADD CONSTRAINT "wh_locations_site_id_fkey" FOREIGN KEY (site_id) REFERENCES sites(id);

ALTER TABLE public."wh_lpns" ADD CONSTRAINT "wh_lpns_closed_by_fkey" FOREIGN KEY (closed_by) REFERENCES profiles(id);

ALTER TABLE public."wh_lpns" ADD CONSTRAINT "wh_lpns_created_by_fkey" FOREIGN KEY (created_by) REFERENCES profiles(id);

ALTER TABLE public."wh_lpns" ADD CONSTRAINT "wh_lpns_site_id_fkey" FOREIGN KEY (site_id) REFERENCES sites(id);

ALTER TABLE public."wh_lpns" ADD CONSTRAINT "wh_lpns_task_id_fkey" FOREIGN KEY (task_id) REFERENCES wh_tasks(id);

ALTER TABLE public."wh_operator_badges" ADD CONSTRAINT "wh_operator_badges_created_by_fkey" FOREIGN KEY (created_by) REFERENCES profiles(id);

ALTER TABLE public."wh_operator_badges" ADD CONSTRAINT "wh_operator_badges_profile_id_fkey" FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;

ALTER TABLE public."wh_pack_sizes" ADD CONSTRAINT "wh_pack_sizes_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES profiles(id);

ALTER TABLE public."wh_packages" ADD CONSTRAINT "wh_packages_contract_id_fkey" FOREIGN KEY (contract_id) REFERENCES contracts(id);

ALTER TABLE public."wh_packages" ADD CONSTRAINT "wh_packages_created_by_fkey" FOREIGN KEY (created_by) REFERENCES profiles(id);

ALTER TABLE public."wh_packages" ADD CONSTRAINT "wh_packages_dispatch_id_fkey" FOREIGN KEY (dispatch_id) REFERENCES dispatches(id);

ALTER TABLE public."wh_packages" ADD CONSTRAINT "wh_packages_location_fk" FOREIGN KEY (location_id) REFERENCES wh_locations(id);

ALTER TABLE public."wh_packages" ADD CONSTRAINT "wh_packages_lpn_fk" FOREIGN KEY (lpn_id) REFERENCES wh_lpns(id);

ALTER TABLE public."wh_packages" ADD CONSTRAINT "wh_packages_site_id_fkey" FOREIGN KEY (site_id) REFERENCES sites(id);

ALTER TABLE public."wh_packages" ADD CONSTRAINT "wh_packages_task_id_fkey" FOREIGN KEY (task_id) REFERENCES wh_tasks(id);

ALTER TABLE public."wh_packages" ADD CONSTRAINT "wh_packages_task_line_id_fkey" FOREIGN KEY (task_line_id) REFERENCES wh_task_lines(id) ON DELETE SET NULL;

ALTER TABLE public."wh_packages" ADD CONSTRAINT "wh_packages_transport_request_id_fkey" FOREIGN KEY (transport_request_id) REFERENCES transport_requests(id);

ALTER TABLE public."wh_receipt_import_runs" ADD CONSTRAINT "wh_receipt_import_runs_imported_by_fkey" FOREIGN KEY (imported_by) REFERENCES profiles(id);

ALTER TABLE public."wh_receipt_sources" ADD CONSTRAINT "wh_receipt_sources_site_id_fkey" FOREIGN KEY (site_id) REFERENCES sites(id);

ALTER TABLE public."wh_receipt_sources" ADD CONSTRAINT "wh_receipt_sources_source_import_hash_fkey" FOREIGN KEY (source_import_hash) REFERENCES wh_receipt_import_runs(file_hash);

ALTER TABLE public."wh_receipt_validations" ADD CONSTRAINT "wh_receipt_validations_site_id_fkey" FOREIGN KEY (site_id) REFERENCES sites(id);

ALTER TABLE public."wh_receipt_validations" ADD CONSTRAINT "wh_receipt_validations_validated_by_fkey" FOREIGN KEY (validated_by) REFERENCES profiles(id);

ALTER TABLE public."wh_reconciliation" ADD CONSTRAINT "wh_reconciliation_dispatch_id_fkey" FOREIGN KEY (dispatch_id) REFERENCES dispatches(id);

ALTER TABLE public."wh_reconciliation" ADD CONSTRAINT "wh_reconciliation_resolved_by_fkey" FOREIGN KEY (resolved_by) REFERENCES profiles(id);

ALTER TABLE public."wh_reconciliation" ADD CONSTRAINT "wh_reconciliation_site_id_fkey" FOREIGN KEY (site_id) REFERENCES sites(id);

ALTER TABLE public."wh_reconciliation" ADD CONSTRAINT "wh_reconciliation_task_id_fkey" FOREIGN KEY (task_id) REFERENCES wh_tasks(id);

ALTER TABLE public."wh_scan_events" ADD CONSTRAINT "wh_scan_events_lpn_id_fkey" FOREIGN KEY (lpn_id) REFERENCES wh_lpns(id);

ALTER TABLE public."wh_scan_events" ADD CONSTRAINT "wh_scan_events_operator_id_fkey" FOREIGN KEY (operator_id) REFERENCES profiles(id);

ALTER TABLE public."wh_scan_events" ADD CONSTRAINT "wh_scan_events_package_id_fkey" FOREIGN KEY (package_id) REFERENCES wh_packages(id);

ALTER TABLE public."wh_scan_events" ADD CONSTRAINT "wh_scan_events_site_id_fkey" FOREIGN KEY (site_id) REFERENCES sites(id);

ALTER TABLE public."wh_scan_events" ADD CONSTRAINT "wh_scan_events_task_id_fkey" FOREIGN KEY (task_id) REFERENCES wh_tasks(id);

ALTER TABLE public."wh_task_lines" ADD CONSTRAINT "wh_task_lines_contract_id_fkey" FOREIGN KEY (contract_id) REFERENCES contracts(id);

ALTER TABLE public."wh_task_lines" ADD CONSTRAINT "wh_task_lines_task_id_fkey" FOREIGN KEY (task_id) REFERENCES wh_tasks(id);

ALTER TABLE public."wh_tasks" ADD CONSTRAINT "wh_tasks_assigned_packer_fkey" FOREIGN KEY (assigned_packer) REFERENCES profiles(id);

ALTER TABLE public."wh_tasks" ADD CONSTRAINT "wh_tasks_assigned_picker_fkey" FOREIGN KEY (assigned_picker) REFERENCES profiles(id);

ALTER TABLE public."wh_tasks" ADD CONSTRAINT "wh_tasks_contract_id_fkey" FOREIGN KEY (contract_id) REFERENCES contracts(id);

ALTER TABLE public."wh_tasks" ADD CONSTRAINT "wh_tasks_created_by_fkey" FOREIGN KEY (created_by) REFERENCES profiles(id);

ALTER TABLE public."wh_tasks" ADD CONSTRAINT "wh_tasks_dispatch_id_fkey" FOREIGN KEY (dispatch_id) REFERENCES dispatches(id);

ALTER TABLE public."wh_tasks" ADD CONSTRAINT "wh_tasks_load_override_by_fkey" FOREIGN KEY (load_override_by) REFERENCES profiles(id);

ALTER TABLE public."wh_tasks" ADD CONSTRAINT "wh_tasks_site_id_fkey" FOREIGN KEY (site_id) REFERENCES sites(id);

ALTER TABLE public."wh_tasks" ADD CONSTRAINT "wh_tasks_transport_request_id_fkey" FOREIGN KEY (transport_request_id) REFERENCES transport_requests(id);

ALTER TABLE public."wh_tasks" ADD CONSTRAINT "wh_tasks_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES profiles(id);

CREATE INDEX wh_reconciliation_dispatch_idx ON public.wh_reconciliation USING btree (dispatch_id) WHERE (dispatch_id IS NOT NULL);

CREATE INDEX supplier_locations_supplier_idx ON public.supplier_locations USING btree (supplier_id);

CREATE INDEX wh_packages_task_line_idx ON public.wh_packages USING btree (task_line_id) WHERE (task_line_id IS NOT NULL);

CREATE INDEX suppliers_name_idx ON public.suppliers USING btree (lower(business_name));

CREATE INDEX app_versions_latest ON public.app_versions USING btree (platform, channel, release_date DESC) WHERE (status = 'published'::text);

CREATE INDEX security_fk_drivers_b8ca22343d ON public.drivers USING btree (profile_id);

CREATE INDEX wh_packages_site_status_idx ON public.wh_packages USING btree (site_id, status, created_at DESC);

CREATE INDEX contracts_garantia_fk_idx ON public.contracts USING btree (garantia_id);

CREATE UNIQUE INDEX carriers_supplier_id_unique ON public.carriers USING btree (supplier_id) WHERE (supplier_id IS NOT NULL);

CREATE INDEX idx_contracts_parent_id ON public.contracts USING btree (parent_contract_id);

CREATE INDEX inv_movements_producto_idx ON public.inv_movements USING btree (producto) WHERE active;

CREATE INDEX tracking_portal_request_site_required ON public.transport_requests USING btree (site_id, required_date);

CREATE INDEX security_fk_transport_requests_2ef88a3fbe ON public.transport_requests USING btree (cost_center_id);

CREATE INDEX inv_movements_upload_idx ON public.inv_movements USING btree (upload_id);

CREATE INDEX security_fk_dispatches_4f07d0f027 ON public.dispatches USING btree (docs_ready_by);

CREATE INDEX wh_scan_events_task_time_idx ON public.wh_scan_events USING btree (task_id, occurred_at DESC);

CREATE INDEX transport_requests_reference_supplier_idx ON public.transport_requests USING btree (reference_supplier_id);

CREATE INDEX security_fk_transport_requests_5873ca6253 ON public.transport_requests USING btree (created_by);

CREATE UNIQUE INDEX roles_name_case_insensitive ON public.roles USING btree (lower(btrim((name)::text)));

CREATE INDEX security_fk_contracts_7116e87781 ON public.contracts USING btree (created_by);

CREATE INDEX security_fk_contracts_d2ac5085f5 ON public.contracts USING btree (client_id);

CREATE INDEX security_fk_transport_requests_e48c1ec0e1 ON public.transport_requests USING btree (contract_id);

CREATE INDEX wh_packages_doc_lot_product_idx ON public.wh_packages USING btree (source_document_no, source_lot, source_product_code);

CREATE INDEX erp_ref_contract_doc_key_idx ON public.contracts USING btree (erp_doc_key((code)::text));

CREATE INDEX dispatches_tercero_idx ON public.dispatches USING btree (carrier_id) WHERE (modalidad = 'TERCERO'::text);

CREATE INDEX wh_receipt_sources_lookup_idx ON public.wh_receipt_sources USING btree (document_no, source_date DESC);

CREATE INDEX idx_dispatches_driver_id ON public.dispatches USING btree (driver_id);

CREATE INDEX security_fk_dispatches_621d17b6ce ON public.dispatches USING btree (contract_id);

CREATE INDEX wh_receipt_sources_lot_idx ON public.wh_receipt_sources USING btree (lot, contract_code) WHERE active;

CREATE INDEX carriers_supplier_fk_idx ON public.carriers USING btree (supplier_id);

CREATE UNIQUE INDEX dispatch_one_active_vehicle ON public.dispatches USING btree (vehicle_plate) WHERE ((vehicle_plate IS NOT NULL) AND (vehicle_plate <> 'EXTERNO'::text) AND ((status)::text = ANY ((ARRAY['PROGRAMADO'::character varying, 'EN_CURSO'::character varying, 'EN RUTA'::character varying, 'ESPERANDO_AUTORIZACION'::character varying, 'RETORNO'::character varying])::text[])));

CREATE INDEX idx_dispatch_requests_transport_request ON public.dispatch_requests USING btree (transport_request_id);

CREATE INDEX inv_movements_numero_idx ON public.inv_movements USING btree (numero) WHERE active;

CREATE INDEX inv_movements_lote_idx ON public.inv_movements USING btree (lote) WHERE active;

CREATE INDEX inv_movements_ot_idx ON public.inv_movements USING btree (ot) WHERE active;

CREATE INDEX wh_tasks_site_status_created_idx ON public.wh_tasks USING btree (site_id, status, created_at DESC);

CREATE INDEX dispatches_site ON public.dispatches USING btree (site_id);

CREATE INDEX transport_requests_site ON public.transport_requests USING btree (site_id);

CREATE UNIQUE INDEX erp_imports_one_active ON public.erp_imports USING btree (kind) WHERE (status = 'ACTIVA'::text);

CREATE INDEX erp_contract_lines_ot_idx ON public.erp_contract_lines USING btree (import_id, ot);

CREATE INDEX security_fk_user_site_access_8e74f55f16 ON public.user_site_access USING btree (site_id);

CREATE INDEX inv_movements_key_idx ON public.inv_movements USING btree (bodega, producto, lote) WHERE active;

CREATE INDEX dispatch_daily_cutoff_due_idx ON public.dispatches USING btree (daily_cutoff_at) WHERE ((status)::text = ANY ((ARRAY['PROGRAMADO'::character varying, 'EN_CURSO'::character varying, 'EN RUTA'::character varying, 'ESPERANDO_AUTORIZACION'::character varying, 'RETORNO'::character varying, 'RETORNO_COMPLETADO'::character varying, 'ENTREGADO'::character varying])::text[]));

CREATE INDEX wh_packages_dispatch_idx ON public.wh_packages USING btree (dispatch_id, source_product_code, source_lot) WHERE (dispatch_id IS NOT NULL);

CREATE INDEX wh_packages_receipt_key_idx ON public.wh_packages USING btree (source_movement_key, sequence_no) WHERE (status <> 'VOID'::text);

CREATE INDEX inv_movements_side_fecha_idx ON public.inv_movements USING btree (side, fecha) WHERE active;

CREATE UNIQUE INDEX dispatch_one_active_driver ON public.dispatches USING btree (driver_id) WHERE ((driver_id IS NOT NULL) AND ((status)::text = ANY ((ARRAY['PROGRAMADO'::character varying, 'EN_CURSO'::character varying, 'EN RUTA'::character varying, 'ESPERANDO_AUTORIZACION'::character varying, 'RETORNO'::character varying])::text[])));

CREATE INDEX security_fk_dispatch_documents_a33973962a ON public.dispatch_documents USING btree (dispatch_id);

CREATE INDEX inv_uploads_side_status_idx ON public.inv_uploads USING btree (side, status, applied_at DESC);

CREATE INDEX idx_dispatch_requests_dispatch_id ON public.dispatch_requests USING btree (dispatch_id);

CREATE INDEX dispatch_documents_dispatch_idx ON public.dispatch_documents USING btree (dispatch_id) WHERE (voided_at IS NULL);

CREATE INDEX security_fk_dispatch_documents_172de4f624 ON public.dispatch_documents USING btree (uploaded_by);

CREATE INDEX transport_requests_required_at_idx ON public.transport_requests USING btree (required_at) WHERE (required_at IS NOT NULL);

CREATE INDEX security_fk_dispatches_a6ed0e920d ON public.dispatches USING btree (cost_center_id);

CREATE INDEX dispatches_legacy_number_idx ON public.dispatches USING btree (legacy_dispatch_number) WHERE (legacy_dispatch_number IS NOT NULL);

CREATE INDEX inv_movements_ref_numero_idx ON public.inv_movements USING btree (ref_numero) WHERE active;

CREATE INDEX gps_monitor_driver_routes ON public.dispatches USING btree (driver_id, scheduled_departure DESC) WHERE ((status)::text = ANY ((ARRAY['PROGRAMADO'::character varying, 'EN_CURSO'::character varying, 'EN RUTA'::character varying, 'ESPERANDO_AUTORIZACION'::character varying, 'RETORNO'::character varying, 'RETORNO_COMPLETADO'::character varying, 'ENTREGADO'::character varying])::text[]));

CREATE INDEX inv_movements_num_rel_idx ON public.inv_movements USING btree (num_rel) WHERE active;

CREATE INDEX wh_tasks_load_override_by_idx ON public.wh_tasks USING btree (load_override_by) WHERE (load_override_by IS NOT NULL);

CREATE INDEX transport_requests_created_at_idx ON public.transport_requests USING btree (created_at);

CREATE INDEX security_fk_transport_requests_e2affd6fdc ON public.transport_requests USING btree (approved_by);

CREATE INDEX security_fk_dispatches_6b7397693d ON public.dispatches USING btree (created_by);

CREATE INDEX idx_dispatches_vehicle_plate ON public.dispatches USING btree (vehicle_plate);

CREATE INDEX wh_tasks_dispatch_idx ON public.wh_tasks USING btree (dispatch_id) WHERE (dispatch_id IS NOT NULL);

CREATE INDEX security_fk_profiles_d35460da8e ON public.profiles USING btree (role_id);

CREATE INDEX transport_requests_client_idx ON public.transport_requests USING btree (client_id);

CREATE UNIQUE INDEX drivers_document_number_unique ON public.drivers USING btree (document_number) WHERE (document_number IS NOT NULL);

CREATE INDEX tracking_portal_request_site_created ON public.transport_requests USING btree (site_id, created_at);

CREATE INDEX wh_receipt_validations_latest_idx ON public.wh_receipt_validations USING btree (source_movement_key, validated_at DESC);

CREATE INDEX security_fk_drivers_554a7e4734 ON public.drivers USING btree (carrier_id);

CREATE UNIQUE INDEX dispatch_documents_guide_number_key ON public.dispatch_documents USING btree (upper(document_number)) WHERE ((voided_at IS NULL) AND (doc_type = 'GUIA_REMISION'::text));

CREATE INDEX security_fk_dispatch_documents_c6fd2fa113 ON public.dispatch_documents USING btree (voided_by);

CREATE INDEX security_fk_dispatch_documents_ca08d36fde ON public.dispatch_documents USING btree (transport_request_id);

CREATE INDEX transport_requests_supplier_idx ON public.transport_requests USING btree (supplier_id);

CREATE INDEX contracts_site ON public.contracts USING btree (site_id);

CREATE INDEX transport_request_components_contract_idx ON public.transport_request_components USING btree (component_contract_id, request_id);

CREATE INDEX security_fk_contracts_0ba1c05149 ON public.contracts USING btree (subcontract_id);

CREATE INDEX erp_contract_lines_doc_sku_idx ON public.erp_contract_lines USING btree (import_id, nro_documento, cod_producto);

CREATE INDEX transport_requests_supplier_location_idx ON public.transport_requests USING btree (supplier_location_id);

CREATE INDEX tracking_portal_dispatch_site_time ON public.dispatches USING btree (site_id, scheduled_departure);

CREATE UNIQUE INDEX suppliers_tax_id_key ON public.suppliers USING btree (tax_id);

CREATE VIEW public.inv_movements_v WITH (security_invoker=true) AS  SELECT id,
    upload_id,
    side,
    active,
    linea,
    tipodocto,
    clase,
    bodega,
    numero,
    fecha,
    cod_legal,
    razon_social,
    producto,
    glosa,
    cantidad,
    unidad,
    doc_rel,
    num_rel,
    fecha_entrega,
    contrato,
    ref_tipo,
    ref_correlativo,
    ref_numero,
    ref_fecha,
    lote_raw,
    lote,
    ot,
    comentario,
    peso_unit,
    peso_kg,
    ccosto
   FROM inv_movements
  WHERE COALESCE(current_setting('inv.scope'::text, true), ''::text) = ''::text OR bodega ~~ current_setting('inv.scope'::text, true);

CREATE TRIGGER wh_tasks_touch BEFORE UPDATE ON wh_tasks FOR EACH ROW EXECUTE FUNCTION wh_touch_updated_at();

CREATE TRIGGER wh_packages_touch BEFORE UPDATE ON wh_packages FOR EACH ROW EXECUTE FUNCTION wh_touch_updated_at();

CREATE TRIGGER wh_scan_immutable BEFORE DELETE OR UPDATE ON wh_scan_events FOR EACH ROW EXECUTE FUNCTION wh_reject_scan_mutation();

CREATE TRIGGER wh_receipt_validation_immutable BEFORE DELETE OR UPDATE ON wh_receipt_validations FOR EACH ROW EXECUTE FUNCTION wh_reject_scan_mutation();

ALTER TABLE public."app_versions" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."app_versions" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."app_versions" TO service_role;
GRANT SELECT ON public."app_versions" TO authenticated;

ALTER TABLE public."carriers" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."carriers" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."carriers" TO service_role;
GRANT SELECT ON public."carriers" TO authenticated;

ALTER TABLE public."clients" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."clients" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."clients" TO service_role;
GRANT SELECT ON public."clients" TO authenticated;

ALTER TABLE public."contracts" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."contracts" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."contracts" TO service_role;
GRANT SELECT ON public."contracts" TO authenticated;

ALTER TABLE public."cost_centers" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."cost_centers" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."cost_centers" TO service_role;
GRANT SELECT ON public."cost_centers" TO authenticated;

ALTER TABLE public."dispatch_documents" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."dispatch_documents" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."dispatch_documents" TO service_role;
GRANT SELECT ON public."dispatch_documents" TO authenticated;

ALTER TABLE public."dispatch_requests" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."dispatch_requests" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."dispatch_requests" TO service_role;
GRANT SELECT ON public."dispatch_requests" TO authenticated;

ALTER TABLE public."dispatches" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."dispatches" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."dispatches" TO service_role;
GRANT SELECT ON public."dispatches" TO authenticated;

ALTER TABLE public."drivers" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."drivers" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."drivers" TO service_role;
GRANT SELECT ON public."drivers" TO authenticated;

ALTER TABLE public."erp_contract_lines" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."erp_contract_lines" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."erp_contract_lines" TO service_role;
GRANT SELECT ON public."erp_contract_lines" TO authenticated;

ALTER TABLE public."erp_imports" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."erp_imports" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."erp_imports" TO service_role;
GRANT SELECT ON public."erp_imports" TO authenticated;

ALTER TABLE public."inv_movements" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."inv_movements" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."inv_movements" TO service_role;
GRANT SELECT ON public."inv_movements" TO authenticated;

ALTER TABLE public."inv_uploads" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."inv_uploads" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."inv_uploads" TO service_role;
GRANT SELECT ON public."inv_uploads" TO authenticated;

ALTER TABLE public."profiles" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."profiles" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."profiles" TO service_role;
GRANT SELECT ON public."profiles" TO authenticated;

ALTER TABLE public."roles" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."roles" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."roles" TO service_role;
GRANT SELECT ON public."roles" TO authenticated;

ALTER TABLE public."sites" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."sites" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."sites" TO service_role;
GRANT SELECT ON public."sites" TO authenticated;

ALTER TABLE public."supplier_locations" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."supplier_locations" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."supplier_locations" TO service_role;
GRANT SELECT ON public."supplier_locations" TO authenticated;

ALTER TABLE public."suppliers" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."suppliers" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."suppliers" TO service_role;
GRANT SELECT ON public."suppliers" TO authenticated;

ALTER TABLE public."transport_request_components" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."transport_request_components" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."transport_request_components" TO service_role;
GRANT SELECT ON public."transport_request_components" TO authenticated;

ALTER TABLE public."transport_requests" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."transport_requests" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."transport_requests" TO service_role;
GRANT SELECT ON public."transport_requests" TO authenticated;

ALTER TABLE public."user_site_access" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."user_site_access" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."user_site_access" TO service_role;
GRANT SELECT ON public."user_site_access" TO authenticated;

ALTER TABLE public."wh_locations" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."wh_locations" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."wh_locations" TO service_role;
GRANT SELECT ON public."wh_locations" TO authenticated;

ALTER TABLE public."wh_lpns" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."wh_lpns" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."wh_lpns" TO service_role;
GRANT SELECT ON public."wh_lpns" TO authenticated;

ALTER TABLE public."wh_operator_badges" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."wh_operator_badges" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."wh_operator_badges" TO service_role;
GRANT SELECT ON public."wh_operator_badges" TO authenticated;

ALTER TABLE public."wh_pack_sizes" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."wh_pack_sizes" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."wh_pack_sizes" TO service_role;
GRANT SELECT ON public."wh_pack_sizes" TO authenticated;

ALTER TABLE public."wh_packages" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."wh_packages" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."wh_packages" TO service_role;
GRANT SELECT ON public."wh_packages" TO authenticated;

ALTER TABLE public."wh_receipt_import_runs" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."wh_receipt_import_runs" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."wh_receipt_import_runs" TO service_role;
GRANT SELECT ON public."wh_receipt_import_runs" TO authenticated;

ALTER TABLE public."wh_receipt_sources" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."wh_receipt_sources" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."wh_receipt_sources" TO service_role;
GRANT SELECT ON public."wh_receipt_sources" TO authenticated;

ALTER TABLE public."wh_receipt_validations" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."wh_receipt_validations" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."wh_receipt_validations" TO service_role;
GRANT SELECT ON public."wh_receipt_validations" TO authenticated;

ALTER TABLE public."wh_reconciliation" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."wh_reconciliation" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."wh_reconciliation" TO service_role;
GRANT SELECT ON public."wh_reconciliation" TO authenticated;

ALTER TABLE public."wh_scan_events" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."wh_scan_events" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."wh_scan_events" TO service_role;
GRANT SELECT ON public."wh_scan_events" TO authenticated;

ALTER TABLE public."wh_task_lines" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."wh_task_lines" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."wh_task_lines" TO service_role;
GRANT SELECT ON public."wh_task_lines" TO authenticated;

ALTER TABLE public."wh_tasks" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."wh_tasks" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."wh_tasks" TO service_role;
GRANT SELECT ON public."wh_tasks" TO authenticated;

CREATE POLICY "app_versions_admin" ON public."app_versions" AS PERMISSIVE FOR ALL TO "authenticated" USING (is_tms_admin()) WITH CHECK (is_tms_admin());

CREATE POLICY "app_versions_published" ON public."app_versions" AS PERMISSIVE FOR SELECT TO "anon","authenticated" USING ((status = 'published'::text));

CREATE POLICY "profiles_admin_delete" ON public."profiles" AS PERMISSIVE FOR DELETE TO "authenticated" USING (is_tms_admin());

CREATE POLICY "profiles_admin_insert" ON public."profiles" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (is_tms_admin());

CREATE POLICY "profiles_admin_update" ON public."profiles" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (is_tms_admin()) WITH CHECK (is_tms_admin());

CREATE POLICY "profiles_read" ON public."profiles" AS PERMISSIVE FOR SELECT TO "authenticated" USING (((id = auth.uid()) OR is_tms_admin()));

CREATE POLICY "tms_admin_full_access" ON public."profiles" AS PERMISSIVE FOR ALL TO "authenticated" USING (is_tms_admin()) WITH CHECK (is_tms_admin());

CREATE POLICY "roles_admin_write" ON public."roles" AS PERMISSIVE FOR ALL TO "authenticated" USING (is_tms_admin()) WITH CHECK (is_tms_admin());

CREATE POLICY "roles_read" ON public."roles" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);

CREATE POLICY "security_active_account" ON public."roles" AS RESTRICTIVE FOR ALL TO "authenticated" USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));

CREATE POLICY "tms_admin_full_access" ON public."roles" AS PERMISSIVE FOR ALL TO "authenticated" USING (is_tms_admin()) WITH CHECK (is_tms_admin());

CREATE POLICY "security_active_account" ON public."sites" AS RESTRICTIVE FOR ALL TO "authenticated" USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));

CREATE POLICY "sites_admin" ON public."sites" AS PERMISSIVE FOR ALL TO "authenticated" USING (is_tms_admin()) WITH CHECK (is_tms_admin());

CREATE POLICY "sites_read" ON public."sites" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((can_access_site(id) OR is_tms_admin()));

CREATE POLICY "security_active_account" ON public."user_site_access" AS RESTRICTIVE FOR ALL TO "authenticated" USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));

CREATE POLICY "user_site_access_admin" ON public."user_site_access" AS PERMISSIVE FOR ALL TO "authenticated" USING (is_tms_admin()) WITH CHECK (is_tms_admin());

CREATE POLICY "user_site_access_read" ON public."user_site_access" AS PERMISSIVE FOR SELECT TO "authenticated" USING (((user_id = auth.uid()) OR is_tms_admin()));

CREATE POLICY "security_active_account" ON public."wh_locations" AS RESTRICTIVE FOR ALL TO "authenticated" USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));

CREATE POLICY "wh_locations_read" ON public."wh_locations" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((can_access_site(site_id) AND wh_has_permission(ARRAY['almacen-lectura'::text, 'almacen-supervisor'::text])));

CREATE POLICY "security_active_account" ON public."wh_lpns" AS RESTRICTIVE FOR ALL TO "authenticated" USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));

CREATE POLICY "wh_lpns_read" ON public."wh_lpns" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((can_access_site(site_id) AND wh_has_permission(ARRAY['almacen-lectura'::text, 'almacen-supervisor'::text, 'almacen-packing'::text, 'almacen-carga'::text])));

CREATE POLICY "security_active_account" ON public."wh_operator_badges" AS RESTRICTIVE FOR ALL TO "authenticated" USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));

CREATE POLICY "security_active_account" ON public."wh_pack_sizes" AS RESTRICTIVE FOR ALL TO "authenticated" USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));

CREATE POLICY "wh_pack_sizes_read" ON public."wh_pack_sizes" AS PERMISSIVE FOR SELECT TO "authenticated" USING (wh_has_permission(ARRAY['almacen-lectura'::text, 'almacen-etiquetado'::text, 'almacen-supervisor'::text]));

CREATE POLICY "security_active_account" ON public."wh_packages" AS RESTRICTIVE FOR ALL TO "authenticated" USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));

CREATE POLICY "wh_packages_read" ON public."wh_packages" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((can_access_site(site_id) AND wh_has_permission(ARRAY['almacen-lectura'::text, 'almacen-supervisor'::text, 'almacen-picking'::text, 'almacen-packing'::text, 'almacen-carga'::text, 'almacen-etiquetado'::text])));

CREATE POLICY "security_active_account" ON public."wh_receipt_validations" AS RESTRICTIVE FOR ALL TO "authenticated" USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));

CREATE POLICY "wh_receipt_validations_read" ON public."wh_receipt_validations" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((can_access_site(site_id) AND wh_has_permission(ARRAY['almacen-etiquetado'::text, 'almacen-supervisor'::text, 'almacen-lectura'::text])));

CREATE POLICY "security_active_account" ON public."wh_reconciliation" AS RESTRICTIVE FOR ALL TO "authenticated" USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));

CREATE POLICY "wh_reconciliation_read" ON public."wh_reconciliation" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((can_access_site(site_id) AND wh_has_permission(ARRAY['almacen-supervisor'::text, 'almacen-carga'::text, 'almacen-lectura'::text, 'apt-carga'::text])));

CREATE POLICY "security_active_account" ON public."wh_scan_events" AS RESTRICTIVE FOR ALL TO "authenticated" USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));

CREATE POLICY "wh_scans_read" ON public."wh_scan_events" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((can_access_site(site_id) AND wh_has_permission(ARRAY['almacen-supervisor'::text, 'almacen-lectura'::text])));

CREATE POLICY "security_active_account" ON public."wh_task_lines" AS RESTRICTIVE FOR ALL TO "authenticated" USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));

CREATE POLICY "wh_task_lines_read" ON public."wh_task_lines" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM wh_tasks t
  WHERE ((t.id = wh_task_lines.task_id) AND can_access_site(t.site_id) AND wh_has_permission(ARRAY['almacen-lectura'::text, 'almacen-supervisor'::text, 'almacen-picking'::text, 'almacen-packing'::text, 'almacen-carga'::text])))));

CREATE POLICY "security_active_account" ON public."wh_tasks" AS RESTRICTIVE FOR ALL TO "authenticated" USING (( SELECT is_active_tms_user() AS is_active_tms_user)) WITH CHECK (( SELECT is_active_tms_user() AS is_active_tms_user));

CREATE POLICY "wh_tasks_read" ON public."wh_tasks" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((can_access_site(site_id) AND wh_has_permission(ARRAY['almacen-lectura'::text, 'almacen-supervisor'::text, 'almacen-picking'::text, 'almacen-packing'::text, 'almacen-carga'::text, 'almacen-etiquetado'::text, 'apt'::text])));

GRANT SELECT ON public.app_versions TO anon;
REVOKE ALL ON public.inv_movements_v FROM PUBLIC,anon,authenticated;

CREATE POLICY wms_reference_read ON public."carriers" FOR SELECT TO authenticated USING (public.is_active_tms_user());

CREATE POLICY wms_reference_read ON public."clients" FOR SELECT TO authenticated USING (public.is_active_tms_user());

CREATE POLICY wms_reference_read ON public."contracts" FOR SELECT TO authenticated USING (public.is_active_tms_user());

CREATE POLICY wms_reference_read ON public."cost_centers" FOR SELECT TO authenticated USING (public.is_active_tms_user());

CREATE POLICY wms_reference_read ON public."dispatch_documents" FOR SELECT TO authenticated USING (public.is_active_tms_user());

CREATE POLICY wms_reference_read ON public."dispatch_requests" FOR SELECT TO authenticated USING (public.is_active_tms_user());

CREATE POLICY wms_reference_read ON public."dispatches" FOR SELECT TO authenticated USING (public.is_active_tms_user());

CREATE POLICY wms_reference_read ON public."drivers" FOR SELECT TO authenticated USING (public.is_active_tms_user());

CREATE POLICY wms_reference_read ON public."erp_contract_lines" FOR SELECT TO authenticated USING (public.is_active_tms_user());

CREATE POLICY wms_reference_read ON public."erp_imports" FOR SELECT TO authenticated USING (public.is_active_tms_user());

CREATE POLICY wms_reference_read ON public."inv_movements" FOR SELECT TO authenticated USING (public.is_active_tms_user());

CREATE POLICY wms_reference_read ON public."inv_uploads" FOR SELECT TO authenticated USING (public.is_active_tms_user());

CREATE POLICY wms_reference_read ON public."supplier_locations" FOR SELECT TO authenticated USING (public.is_active_tms_user());

CREATE POLICY wms_reference_read ON public."suppliers" FOR SELECT TO authenticated USING (public.is_active_tms_user());

CREATE POLICY wms_reference_read ON public."transport_request_components" FOR SELECT TO authenticated USING (public.is_active_tms_user());

CREATE POLICY wms_reference_read ON public."transport_requests" FOR SELECT TO authenticated USING (public.is_active_tms_user());

CREATE POLICY wh_receipt_sources_read ON public.wh_receipt_sources FOR SELECT TO authenticated USING (public.can_access_site(site_id) AND public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']));
CREATE POLICY wh_receipt_import_runs_read ON public.wh_receipt_import_runs FOR SELECT TO authenticated USING (public.wh_has_permission(ARRAY['almacen-carga','almacen-supervisor']));

REVOKE ALL ON FUNCTION public."apt_almacen"(p_bodega text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."apt_almacen"(p_bodega text) TO service_role;

REVOKE ALL ON FUNCTION public."apt_ot_raiz"(p_lote text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."apt_ot_raiz"(p_lote text) TO service_role;

REVOKE ALL ON FUNCTION public."can_access_site"(p_site_id uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."can_access_site"(p_site_id uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public."can_access_site"(p_site_id uuid) TO authenticated;

REVOKE ALL ON FUNCTION public."dispatch_document_folder"(p_name text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."dispatch_document_folder"(p_name text) TO service_role;

REVOKE ALL ON FUNCTION public."erp_active_import"(p_kind text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."erp_active_import"(p_kind text) TO service_role;

REVOKE ALL ON FUNCTION public."erp_doc_key"(p text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."erp_doc_key"(p text) TO service_role;

REVOKE ALL ON FUNCTION public."erp_key"(p text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."erp_key"(p text) TO service_role;

REVOKE ALL ON FUNCTION public."has_tms_permission"(p_permission text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."has_tms_permission"(p_permission text) TO service_role;

GRANT EXECUTE ON FUNCTION public."has_tms_permission"(p_permission text) TO authenticated;

REVOKE ALL ON FUNCTION public."inv_kg"(p_peso numeric, p_qty numeric, p_unit numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."inv_kg"(p_peso numeric, p_qty numeric, p_unit numeric) TO service_role;

REVOKE ALL ON FUNCTION public."inv_ot"(p_lote text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."inv_ot"(p_lote text) TO service_role;

REVOKE ALL ON FUNCTION public."inv_ot_cliente"(p_raiz text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."inv_ot_cliente"(p_raiz text) TO service_role;

REVOKE ALL ON FUNCTION public."is_active_tms_user"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."is_active_tms_user"() TO service_role;

GRANT EXECUTE ON FUNCTION public."is_active_tms_user"() TO authenticated;

REVOKE ALL ON FUNCTION public."is_tms_admin"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."is_tms_admin"() TO service_role;

GRANT EXECUTE ON FUNCTION public."is_tms_admin"() TO authenticated;

REVOKE ALL ON FUNCTION public."primary_site_id"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."primary_site_id"() TO service_role;

GRANT EXECUTE ON FUNCTION public."primary_site_id"() TO authenticated;

REVOKE ALL ON FUNCTION public."security_assert_active_session"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."security_assert_active_session"() TO service_role;

REVOKE ALL ON FUNCTION public."uuid_generate_v4"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."uuid_generate_v4"() TO service_role;

REVOKE ALL ON FUNCTION public."wh_add_package_to_lpn"(p_lpn_id uuid, p_package_code text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_add_package_to_lpn"(p_lpn_id uuid, p_package_code text) TO service_role;

GRANT EXECUTE ON FUNCTION public."wh_add_package_to_lpn"(p_lpn_id uuid, p_package_code text) TO authenticated;

REVOKE ALL ON FUNCTION public."wh_assign_task"(p_task_id uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_assign_task"(p_task_id uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public."wh_assign_task"(p_task_id uuid) TO authenticated;

REVOKE ALL ON FUNCTION public."wh_block_dispatch_without_wh_load"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_block_dispatch_without_wh_load"() TO service_role;

REVOKE ALL ON FUNCTION public."wh_close_lpn"(p_lpn_id uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_close_lpn"(p_lpn_id uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public."wh_close_lpn"(p_lpn_id uuid) TO authenticated;

REVOKE ALL ON FUNCTION public."wh_create_lpn"(p_task_id uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_create_lpn"(p_task_id uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public."wh_create_lpn"(p_task_id uuid) TO authenticated;

REVOKE ALL ON FUNCTION public."wh_has_permission"(p_codes text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_has_permission"(p_codes text[]) TO service_role;

GRANT EXECUTE ON FUNCTION public."wh_has_permission"(p_codes text[]) TO authenticated;

REVOKE ALL ON FUNCTION public."wh_import_receipt_snapshot"(p_file_name text, p_file_hash text, p_rows jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_import_receipt_snapshot"(p_file_name text, p_file_hash text, p_rows jsonb) TO service_role;

GRANT EXECUTE ON FUNCTION public."wh_import_receipt_snapshot"(p_file_name text, p_file_hash text, p_rows jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public."wh_label_package"(p_receipt_key text, p_package_count integer, p_units_per_package numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_label_package"(p_receipt_key text, p_package_count integer, p_units_per_package numeric) TO service_role;

GRANT EXECUTE ON FUNCTION public."wh_label_package"(p_receipt_key text, p_package_count integer, p_units_per_package numeric) TO authenticated;

REVOKE ALL ON FUNCTION public."wh_pack_size_delete"(p_product_code text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_pack_size_delete"(p_product_code text) TO service_role;

GRANT EXECUTE ON FUNCTION public."wh_pack_size_delete"(p_product_code text) TO authenticated;

REVOKE ALL ON FUNCTION public."wh_pack_size_upsert"(p_product_code text, p_units_per_package numeric, p_unit text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_pack_size_upsert"(p_product_code text, p_units_per_package numeric, p_unit text) TO service_role;

GRANT EXECUTE ON FUNCTION public."wh_pack_size_upsert"(p_product_code text, p_units_per_package numeric, p_unit text) TO authenticated;

REVOKE ALL ON FUNCTION public."wh_print_labels"(p_package_codes text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_print_labels"(p_package_codes text[]) TO service_role;

GRANT EXECUTE ON FUNCTION public."wh_print_labels"(p_package_codes text[]) TO authenticated;

REVOKE ALL ON FUNCTION public."wh_receipt_candidates"(p_query text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_receipt_candidates"(p_query text) TO service_role;

GRANT EXECUTE ON FUNCTION public."wh_receipt_candidates"(p_query text) TO authenticated;

REVOKE ALL ON FUNCTION public."wh_receipt_control_customers"(p_source_movement_keys text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_receipt_control_customers"(p_source_movement_keys text[]) TO service_role;

GRANT EXECUTE ON FUNCTION public."wh_receipt_control_customers"(p_source_movement_keys text[]) TO authenticated;

REVOKE ALL ON FUNCTION public."wh_receipt_control_operators"(p_source_movement_keys text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_receipt_control_operators"(p_source_movement_keys text[]) TO service_role;

GRANT EXECUTE ON FUNCTION public."wh_receipt_control_operators"(p_source_movement_keys text[]) TO authenticated;

REVOKE ALL ON FUNCTION public."wh_reconcile_apt_outflows"(p_from date, p_until date, p_source_batch text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_reconcile_apt_outflows"(p_from date, p_until date, p_source_batch text) TO service_role;

GRANT EXECUTE ON FUNCTION public."wh_reconcile_apt_outflows"(p_from date, p_until date, p_source_batch text) TO authenticated;

REVOKE ALL ON FUNCTION public."wh_reconcile_batch"(p_rows jsonb, p_source_batch text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_reconcile_batch"(p_rows jsonb, p_source_batch text) TO service_role;

GRANT EXECUTE ON FUNCTION public."wh_reconcile_batch"(p_rows jsonb, p_source_batch text) TO authenticated;

REVOKE ALL ON FUNCTION public."wh_record_scan"(p_task_id uuid, p_code text, p_event text, p_client_event_id uuid, p_payload jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_record_scan"(p_task_id uuid, p_code text, p_event text, p_client_event_id uuid, p_payload jsonb) TO service_role;

GRANT EXECUTE ON FUNCTION public."wh_record_scan"(p_task_id uuid, p_code text, p_event text, p_client_event_id uuid, p_payload jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public."wh_register_packing_list"(p_dispatch_id uuid, p_request_id uuid, p_file_path text, p_file_name text, p_size_bytes bigint, p_notes text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_register_packing_list"(p_dispatch_id uuid, p_request_id uuid, p_file_path text, p_file_name text, p_size_bytes bigint, p_notes text) TO service_role;

GRANT EXECUTE ON FUNCTION public."wh_register_packing_list"(p_dispatch_id uuid, p_request_id uuid, p_file_path text, p_file_name text, p_size_bytes bigint, p_notes text) TO authenticated;

REVOKE ALL ON FUNCTION public."wh_reject_scan_mutation"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_reject_scan_mutation"() TO service_role;

REVOKE ALL ON FUNCTION public."wh_reprint_label"(p_package_code text, p_reason text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_reprint_label"(p_package_code text, p_reason text) TO service_role;

GRANT EXECUTE ON FUNCTION public."wh_reprint_label"(p_package_code text, p_reason text) TO authenticated;

REVOKE ALL ON FUNCTION public."wh_reprint_lpn_label"(p_lpn_code text, p_reason text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_reprint_lpn_label"(p_lpn_code text, p_reason text) TO service_role;

GRANT EXECUTE ON FUNCTION public."wh_reprint_lpn_label"(p_lpn_code text, p_reason text) TO authenticated;

REVOKE ALL ON FUNCTION public."wh_resolve_reconciliation"(p_id uuid, p_resolution text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_resolve_reconciliation"(p_id uuid, p_resolution text) TO service_role;

GRANT EXECUTE ON FUNCTION public."wh_resolve_reconciliation"(p_id uuid, p_resolution text) TO authenticated;

REVOKE ALL ON FUNCTION public."wh_sync_dispatch_request"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_sync_dispatch_request"() TO service_role;

REVOKE ALL ON FUNCTION public."wh_sync_request_components"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_sync_request_components"() TO service_role;

REVOKE ALL ON FUNCTION public."wh_sync_transport_request"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_sync_transport_request"() TO service_role;

REVOKE ALL ON FUNCTION public."wh_task_action"(p_task_id uuid, p_action text, p_reason text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_task_action"(p_task_id uuid, p_action text, p_reason text) TO service_role;

GRANT EXECUTE ON FUNCTION public."wh_task_action"(p_task_id uuid, p_action text, p_reason text) TO authenticated;

REVOKE ALL ON FUNCTION public."wh_task_status_for_request"(p_status text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_task_status_for_request"(p_status text) TO service_role;

REVOKE ALL ON FUNCTION public."wh_touch_updated_at"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_touch_updated_at"() TO service_role;

REVOKE ALL ON FUNCTION public."wh_validate_receipt"(p_receipt_key text, p_physical_quantity numeric, p_variance_reason text, p_manual_customer_name text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_validate_receipt"(p_receipt_key text, p_physical_quantity numeric, p_variance_reason text, p_manual_customer_name text) TO service_role;

GRANT EXECUTE ON FUNCTION public."wh_validate_receipt"(p_receipt_key text, p_physical_quantity numeric, p_variance_reason text, p_manual_customer_name text) TO authenticated;

REVOKE ALL ON FUNCTION public."wh_void_package"(p_package_code text, p_reason text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."wh_void_package"(p_package_code text, p_reason text) TO service_role;

GRANT EXECUTE ON FUNCTION public."wh_void_package"(p_package_code text, p_reason text) TO authenticated;

NOTIFY pgrst,'reload schema';

ALTER TABLE public.wh_receipt_sources ADD COLUMN document_type text, ADD COLUMN color text, ADD COLUMN source_updated_at timestamptz;
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
    OR nullif(trim(e->>'product_code'),'') IS NULL OR coalesce((e->>'quantity')::numeric,0)<=0) THEN
   RAISE EXCEPTION 'Cada fila requiere IPT, fecha, bodega, producto y cantidad positiva'; END IF;
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
  FROM (SELECT s.source_key AS receipt_key,s.document_no,s.source_date AS fecha,s.document_type,s.color,s.source_updated_at,s.lot AS lote,s.product_code,s.description,s.unit,s.warehouse AS bodega,
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
 v_customer:=coalesce(nullif(v_receipt.customer_name,''),nullif(public.inv_ot_cliente(public.inv_ot(v_receipt.contract_code)),''));
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
 INTO v_receipt FROM public.wh_receipt_sources s LEFT JOIN public.contracts c
   ON regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(coalesce(nullif(s.contract_code,''),nullif(s.origin_number,''),s.lot)),'[^A-Z0-9]','','g'),'^OT','')
  WHERE s.source_key=p_receipt_key AND s.active;
 IF NOT FOUND OR v_receipt.quantity<=0 THEN RAISE EXCEPTION 'El ingreso APT no existe o ya no está activo; actualice la fuente WMS'; END IF;
 SELECT * INTO v_validation FROM public.wh_receipt_validations WHERE source_movement_key=p_receipt_key ORDER BY validated_at DESC,id DESC LIMIT 1;
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
-- Resolve WMS receipt customers through the matching TMS OT and its parent contract.

-- WMS receipt inbox: show every receipt with any unprinted labels and resolve customer by lot/OT.

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


CREATE OR REPLACE FUNCTION public.wh_receipt_control_operators(p_source_movement_keys text[])
RETURNS TABLE (
  source_movement_key text,
  validated_by uuid,
  validated_at timestamptz,
  first_name text,
  last_name text,
  username text,
  customer_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_site uuid := public.primary_site_id();
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) THEN
    RAISE EXCEPTION 'Sin permiso para consultar responsables de recepción' USING ERRCODE='42501';
  END IF;
  IF coalesce(cardinality(p_source_movement_keys),0) NOT BETWEEN 1 AND 100 OR
     v_site IS NULL OR NOT public.can_access_site(v_site) THEN
    RAISE EXCEPTION 'Consulta de responsables de recepción inválida';
  END IF;

  RETURN QUERY
  SELECT rv.source_movement_key::text,
         rv.validated_by::uuid,
         rv.validated_at::timestamptz,
         p.first_name::text,
         p.last_name::text,
         p.username::text,
         coalesce(
           nullif(s.customer_name,'')::text,
           lookup.lot_customer::text,
           lookup.contract_customer::text,
           nullif(rv.manual_customer_name,'')::text
         )::text AS customer_name
  FROM public.wh_receipt_validations rv
  JOIN (
    SELECT DISTINCT ON (wp.source_movement_key)
      wp.source_movement_key,wp.site_id,wp.source_document_no,wp.source_contract_code,wp.source_lot,wp.source_product_code
    FROM public.wh_packages wp
    WHERE wp.source_movement_key=ANY(p_source_movement_keys)
      AND wp.site_id=v_site AND wp.source_system='ERP'
      AND wp.status<>'VOID' AND wp.label_print_count>0
    ORDER BY wp.source_movement_key,wp.sequence_no
  ) wp ON wp.source_movement_key=rv.source_movement_key AND wp.site_id=rv.site_id
  LEFT JOIN public.profiles p ON p.id=rv.validated_by
  LEFT JOIN LATERAL (
    SELECT rs.customer_name,rs.contract_code,rs.lot
    FROM public.wh_receipt_sources rs
    WHERE rs.active
      AND rs.document_no=wp.source_document_no
      AND rs.product_code=wp.source_product_code
      AND coalesce(rs.lot,'')=wp.source_lot
    ORDER BY rs.updated_at DESC
    LIMIT 1
  ) s ON true
  LEFT JOIN LATERAL (
    SELECT
      nullif(public.inv_ot_cliente(nullif(public.apt_ot_raiz(coalesce(s.lot,wp.source_lot)),'')),'')::text AS lot_customer,
      nullif(public.inv_ot_cliente(nullif(public.inv_ot(coalesce(s.contract_code,wp.source_contract_code)),'')),'')::text AS contract_customer
  ) lookup ON true
  WHERE rv.source_movement_key=ANY(p_source_movement_keys)
    AND rv.site_id=v_site
    AND public.can_access_site(rv.site_id)
  GROUP BY rv.source_movement_key,rv.validated_by,rv.validated_at,p.first_name,p.last_name,p.username,
           s.customer_name,lookup.lot_customer,lookup.contract_customer,rv.manual_customer_name
  ORDER BY rv.validated_at DESC;
END
$$;

CREATE OR REPLACE FUNCTION public.wh_receipt_control_customers(p_source_movement_keys text[])
RETURNS TABLE (source_movement_key text, customer_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_site uuid := public.primary_site_id();
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) THEN
    RAISE EXCEPTION 'Sin permiso para consultar clientes de recepción' USING ERRCODE='42501';
  END IF;
  IF coalesce(cardinality(p_source_movement_keys),0) NOT BETWEEN 1 AND 100 OR
     v_site IS NULL OR NOT public.can_access_site(v_site) THEN
    RAISE EXCEPTION 'Consulta de clientes de recepción inválida';
  END IF;

  RETURN QUERY
  WITH package_keys AS (
    SELECT DISTINCT ON (wp.source_movement_key)
      wp.source_movement_key,
      wp.source_contract_code,
      wp.source_lot
    FROM public.wh_packages wp
    WHERE wp.source_movement_key=ANY(p_source_movement_keys)
      AND wp.site_id=v_site
      AND wp.source_system='ERP'
      AND wp.status<>'VOID'
      AND wp.label_print_count>0
    ORDER BY wp.source_movement_key,wp.sequence_no
  )
  SELECT pk.source_movement_key::text,
         coalesce(
           nullif(rs.customer_name,'')::text,
           nullif(public.inv_ot_cliente(public.inv_ot(coalesce(nullif(rs.contract_code,''),nullif(rs.origin_number,''),pk.source_contract_code))),'')::text,
           nullif(rv.manual_customer_name,'')::text
         )::text AS customer_name
  FROM package_keys pk
  LEFT JOIN public.wh_receipt_sources rs
    ON rs.source_key=pk.source_movement_key
   AND rs.site_id=v_site
   AND rs.active
  LEFT JOIN LATERAL (
    SELECT validation.manual_customer_name
    FROM public.wh_receipt_validations validation
    WHERE validation.source_movement_key=pk.source_movement_key
      AND validation.site_id=v_site
    ORDER BY validation.validated_at DESC,validation.id DESC
    LIMIT 1
  ) rv ON true
  WHERE public.can_access_site(v_site)
  ORDER BY pk.source_movement_key;
END
$$;

REVOKE ALL ON FUNCTION public.wh_receipt_control_operators(text[]),public.wh_receipt_control_customers(text[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.wh_receipt_control_operators(text[]),public.wh_receipt_control_customers(text[]) TO authenticated;
NOTIFY pgrst,'reload schema';

