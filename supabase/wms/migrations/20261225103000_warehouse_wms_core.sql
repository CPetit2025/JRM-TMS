-- JRM Warehouse Portal: operational WMS records. Auth/users and dispatch remain shared with TMS.
-- This migration is intentionally staged with the feature and must not be applied before release readiness.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='45s';

CREATE TABLE public.wh_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 task_code text NOT NULL UNIQUE,
 transport_request_id uuid NOT NULL UNIQUE REFERENCES public.transport_requests(id),
 site_id uuid NOT NULL REFERENCES public.sites(id),
 contract_id uuid REFERENCES public.contracts(id),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PICKING','PAUSED','PACKING','READY_FOR_LOAD','PARTIAL','LOADED','RECONCILED','CANCELLED')),
 request_status text NOT NULL DEFAULT 'PENDIENTE', dispatch_id uuid REFERENCES public.dispatches(id),
 assigned_picker uuid REFERENCES public.profiles(id), assigned_packer uuid REFERENCES public.profiles(id),
 created_by uuid REFERENCES public.profiles(id), updated_by uuid REFERENCES public.profiles(id),
 load_override_reason text, load_override_by uuid REFERENCES public.profiles(id), load_override_at timestamptz,
 paused_reason text, cancelled_reason text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 loaded_at timestamptz, reconciled_at timestamptz
);
CREATE INDEX wh_tasks_site_status_created_idx ON public.wh_tasks(site_id,status,created_at DESC);
CREATE INDEX wh_tasks_dispatch_idx ON public.wh_tasks(dispatch_id) WHERE dispatch_id IS NOT NULL;
CREATE INDEX wh_tasks_load_override_by_idx ON public.wh_tasks(load_override_by) WHERE load_override_by IS NOT NULL;
CREATE TABLE public.wh_task_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid NOT NULL REFERENCES public.wh_tasks(id),
 transport_request_item_id uuid, contract_id uuid REFERENCES public.contracts(id),
 product_code text, description text NOT NULL, lot text, requested_qty numeric(14,3), picked_qty numeric(14,3) NOT NULL DEFAULT 0,
 packed_qty numeric(14,3) NOT NULL DEFAULT 0, loaded_qty numeric(14,3) NOT NULL DEFAULT 0,
 remaining_qty numeric(14,3) GENERATED ALWAYS AS (greatest(coalesce(requested_qty,0)-loaded_qty,0)) STORED,
 overpicked_qty numeric(14,3) GENERATED ALWAYS AS (greatest(picked_qty-coalesce(requested_qty,picked_qty),0)) STORED,
 unit text, weight_kg numeric(14,3), source text NOT NULL DEFAULT 'REQUEST',
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id,transport_request_item_id)
);
CREATE TABLE public.wh_packages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), package_code text NOT NULL UNIQUE,
 source_system text NOT NULL DEFAULT 'ERP', source_document_no text NOT NULL, source_contract_code text, source_lot text NOT NULL DEFAULT '',
 source_product_code text NOT NULL, source_unit text NOT NULL DEFAULT '', source_warehouse text NOT NULL,
 source_date date NOT NULL, source_movement_key text NOT NULL, source_label_version integer NOT NULL DEFAULT 1, source_key text NOT NULL UNIQUE,
 transport_request_id uuid REFERENCES public.transport_requests(id), contract_id uuid REFERENCES public.contracts(id), site_id uuid NOT NULL REFERENCES public.sites(id),
 description text NOT NULL, quantity numeric(14,3) NOT NULL CHECK(quantity>0), unit text, weight_kg numeric(14,3),
 sequence_no integer NOT NULL DEFAULT 1, sequence_total integer NOT NULL DEFAULT 1,
 source_qty_snapshot numeric(14,3), source_expected_total numeric(14,3), source_expected_count integer,
 quantity_mismatch boolean GENERATED ALWAYS AS (source_qty_snapshot IS NOT NULL AND (source_qty_snapshot<>quantity OR (source_expected_count IS NOT NULL AND (sequence_no>source_expected_count OR sequence_total<>source_expected_count)))) STORED,
 status text NOT NULL DEFAULT 'AVAILABLE' CHECK(status IN ('AVAILABLE','RESERVED','PICKED','PACKED','LOADED','VOID')),
 task_id uuid REFERENCES public.wh_tasks(id), task_line_id uuid REFERENCES public.wh_task_lines(id) ON DELETE SET NULL, lpn_id uuid, dispatch_id uuid REFERENCES public.dispatches(id), location_id uuid,
 label_print_count integer NOT NULL DEFAULT 0, void_reason text, created_by uuid REFERENCES public.profiles(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wh_packages_site_status_idx ON public.wh_packages(site_id,status,created_at DESC);
CREATE INDEX wh_packages_doc_lot_product_idx ON public.wh_packages(source_document_no,source_lot,source_product_code);
CREATE INDEX wh_packages_task_line_idx ON public.wh_packages(task_line_id) WHERE task_line_id IS NOT NULL;
CREATE INDEX wh_packages_dispatch_idx ON public.wh_packages(dispatch_id,source_product_code,source_lot) WHERE dispatch_id IS NOT NULL;
CREATE INDEX wh_packages_receipt_key_idx ON public.wh_packages(source_movement_key,sequence_no) WHERE status<>'VOID';
CREATE TABLE public.wh_lpns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lpn_code text NOT NULL UNIQUE, site_id uuid NOT NULL REFERENCES public.sites(id),
 task_id uuid REFERENCES public.wh_tasks(id), status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED','LOADED','VOID')),
 package_count integer NOT NULL DEFAULT 0, quantity numeric(14,3) NOT NULL DEFAULT 0, weight_kg numeric(14,3) NOT NULL DEFAULT 0,
 print_count integer NOT NULL DEFAULT 0,
 closed_by uuid REFERENCES public.profiles(id), closed_at timestamptz, void_reason text, created_by uuid REFERENCES public.profiles(id), created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.wh_packages ADD CONSTRAINT wh_packages_lpn_fk FOREIGN KEY(lpn_id) REFERENCES public.wh_lpns(id);
CREATE TABLE public.wh_locations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id uuid NOT NULL REFERENCES public.sites(id), code text NOT NULL, label text NOT NULL,
 zone text, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(site_id,code)
);
ALTER TABLE public.wh_packages ADD CONSTRAINT wh_packages_location_fk FOREIGN KEY(location_id) REFERENCES public.wh_locations(id);
CREATE TABLE public.wh_scan_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, site_id uuid NOT NULL REFERENCES public.sites(id), task_id uuid REFERENCES public.wh_tasks(id),
 package_id uuid REFERENCES public.wh_packages(id), lpn_id uuid REFERENCES public.wh_lpns(id), event_type text NOT NULL,
 scanned_code text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb, operator_id uuid NOT NULL REFERENCES public.profiles(id),
 client_event_id uuid NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(), recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(site_id,client_event_id)
);
CREATE INDEX wh_scan_events_task_time_idx ON public.wh_scan_events(task_id,occurred_at DESC);
CREATE TABLE public.wh_reconciliation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id uuid NOT NULL REFERENCES public.sites(id), task_id uuid REFERENCES public.wh_tasks(id),
 package_code text NOT NULL, erp_qty numeric(14,3), physical_qty numeric(14,3), variance numeric(14,3) GENERATED ALWAYS AS (COALESCE(physical_qty,0)-COALESCE(erp_qty,0)) STORED,
 status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','MATCH','SHORT','OVER','RESOLVED','VOID')),
 resolution text, resolved_by uuid REFERENCES public.profiles(id), resolved_at timestamptz, source_batch text,
 source_document_no text, source_reference_no text, source_lot text, source_product_code text, source_date date, dispatch_id uuid REFERENCES public.dispatches(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(site_id,package_code,source_batch)
);
CREATE INDEX wh_reconciliation_dispatch_idx ON public.wh_reconciliation(dispatch_id) WHERE dispatch_id IS NOT NULL;
CREATE TABLE public.wh_receipt_validations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_movement_key text NOT NULL, site_id uuid NOT NULL REFERENCES public.sites(id),
 erp_quantity numeric(14,3) NOT NULL CHECK(erp_quantity>=0), physical_quantity numeric(14,3) NOT NULL CHECK(physical_quantity>=0),
 variance numeric(14,3) GENERATED ALWAYS AS (physical_quantity-erp_quantity) STORED,
 variance_reason text, manual_customer_name text, validated_by uuid NOT NULL REFERENCES public.profiles(id), validated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wh_receipt_validations_latest_idx ON public.wh_receipt_validations(source_movement_key,validated_at DESC);
CREATE TABLE public.wh_pack_sizes (
 product_code text PRIMARY KEY, units_per_package numeric(14,3) NOT NULL CHECK(units_per_package>0), unit text, updated_by uuid REFERENCES public.profiles(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.wh_operator_badges (
 profile_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE, badge_code text NOT NULL UNIQUE,
 pin_hash text NOT NULL, active boolean NOT NULL DEFAULT true, created_by uuid REFERENCES public.profiles(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

-- Treat the new warehouse permissions as scoped access to the pre-existing APT APIs only.
CREATE OR REPLACE FUNCTION public.has_tms_permission(p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id=p.role_id
  WHERE p.id=auth.uid() AND p.is_active=true AND (r.name='Administrador' OR r.permissions ? p_permission OR r.permissions ? (p_permission||':write')
   OR (p_permission='apt' AND r.permissions ?| ARRAY['almacen-lectura','almacen-etiquetado','almacen-picking','almacen-packing','almacen-carga','almacen-supervisor'])
   OR (p_permission='apt-carga' AND r.permissions ?| ARRAY['almacen-carga','almacen-supervisor'])))
$$;
CREATE OR REPLACE FUNCTION public.has_tms_read_permission(p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id=p.role_id
  WHERE p.id=auth.uid() AND p.is_active=true AND (r.name='Administrador' OR r.permissions ? p_permission OR r.permissions ? (p_permission||':read') OR r.permissions ? (p_permission||':write')
   OR (p_permission='apt' AND r.permissions ?| ARRAY['almacen-lectura','almacen-etiquetado','almacen-picking','almacen-packing','almacen-carga','almacen-supervisor'])
   OR (p_permission='apt-carga' AND r.permissions ?| ARRAY['almacen-carga','almacen-supervisor'])))
$$;
REVOKE ALL ON FUNCTION public.has_tms_permission(text),public.has_tms_read_permission(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.has_tms_permission(text),public.has_tms_read_permission(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.wh_has_permission(p_codes text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND public.is_active_tms_user() AND EXISTS(
   SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id=p.role_id
   WHERE p.id=auth.uid() AND (r.name='Administrador' OR EXISTS(SELECT 1 FROM unnest(p_codes) c WHERE public.has_tms_permission(c))))
$$;
REVOKE ALL ON FUNCTION public.wh_has_permission(text[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.wh_has_permission(text[]) TO authenticated;
DROP POLICY IF EXISTS warehouse_transport_requests_read ON public.transport_requests;
CREATE POLICY warehouse_transport_requests_read ON public.transport_requests FOR SELECT TO authenticated
 USING(public.can_access_site(site_id) AND public.wh_has_permission(ARRAY['almacen-lectura','almacen-supervisor','almacen-picking','almacen-packing','almacen-carga','almacen-etiquetado']));
CREATE OR REPLACE FUNCTION public.wh_receipt_candidates(p_query text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q text:=trim(coalesce(p_query,'')); result jsonb;
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para consultar recepciones APT' USING ERRCODE='42501'; END IF;
 IF length(q)<2 THEN RAISE EXCEPTION 'Ingrese dos o más caracteres para buscar'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.fecha DESC,x.document_no,x.product_code),'[]'::jsonb) INTO result FROM (
  WITH receipts AS (
   SELECT encode(extensions.digest(convert_to(jsonb_build_array(m.fecha::text,m.numero,coalesce(m.lote,''),m.producto,coalesce(m.unidad,''),m.bodega,coalesce(m.glosa,''),coalesce(m.razon_social,''),coalesce(m.ot,m.contrato,nullif(m.num_rel,''),m.lote))::text,'UTF8'),'sha256'),'hex') AS receipt_key,
    m.numero AS document_no,m.fecha,m.lote,m.producto AS product_code,m.glosa AS description,m.unidad AS unit,m.bodega,
    coalesce(m.ot,m.contrato,nullif(m.num_rel,''),m.lote) AS contract_code,m.razon_social,
    round(sum(abs(m.cantidad)),3) AS quantity,round(sum(abs(m.peso_kg)),3) AS weight_kg
   FROM public.inv_movements m WHERE m.active AND m.side='E' AND public.apt_almacen(m.bodega) IS NOT NULL
   GROUP BY m.fecha,m.numero,m.lote,m.producto,m.unidad,m.bodega,m.glosa,m.ot,m.contrato,m.num_rel,m.razon_social
  )
  SELECT r.*,c.id AS contract_id,
   coalesce(nullif(r.razon_social,''),public.inv_ot_cliente(public.inv_ot(r.contract_code)),v.manual_customer_name) AS customer_name,
   CASE WHEN nullif(r.razon_social,'') IS NOT NULL OR nullif(public.inv_ot_cliente(public.inv_ot(r.contract_code)),'') IS NOT NULL THEN 'ERP/OT'
    WHEN nullif(v.manual_customer_name,'') IS NOT NULL THEN 'MANUAL' ELSE NULL END AS customer_source,
   v.physical_quantity, v.variance, v.variance_reason,
   CASE WHEN v.id IS NULL THEN 'PENDING' WHEN v.erp_quantity<>r.quantity THEN 'STALE' ELSE 'VALIDATED' END AS validation_status,
   coalesce(p.label_count,0) AS label_count,coalesce(p.labeled_qty,0) AS labeled_qty,
   CASE WHEN coalesce(p.label_count,0)=0 THEN 'NOT_LABELED'
    WHEN p.labeled_qty=coalesce(v.physical_quantity,r.quantity) AND p.expected_count=p.label_count THEN 'MATCH' ELSE 'DIFFERENCE' END AS label_status
  FROM receipts r LEFT JOIN public.contracts c ON regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(r.contract_code),'[^A-Z0-9]','','g'),'^OT','')
  LEFT JOIN LATERAL (SELECT rv.* FROM public.wh_receipt_validations rv WHERE rv.source_movement_key=r.receipt_key ORDER BY rv.validated_at DESC,rv.id DESC LIMIT 1) v ON true
  LEFT JOIN LATERAL (SELECT count(*)::integer AS label_count,round(sum(quantity),3) AS labeled_qty,max(source_expected_count) AS expected_count
   FROM public.wh_packages WHERE source_movement_key=r.receipt_key AND status<>'VOID') p ON true
  WHERE r.document_no ILIKE '%'||q||'%' OR coalesce(r.lote,'') ILIKE '%'||q||'%' OR r.product_code ILIKE '%'||q||'%'
   OR coalesce(r.description,'') ILIKE '%'||q||'%' OR coalesce(r.contract_code,'') ILIKE '%'||q||'%'
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
 IF v_site IS NULL OR NOT public.can_access_site(v_site) OR p_physical_quantity IS NULL OR p_physical_quantity<0 OR nullif(trim(p_receipt_key),'') IS NULL THEN
  RAISE EXCEPTION 'Cantidad física o ingreso IPT inválido';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_receipt_key,0));
 SELECT encode(extensions.digest(convert_to(jsonb_build_array(m.fecha::text,m.numero,coalesce(m.lote,''),m.producto,coalesce(m.unidad,''),m.bodega,coalesce(m.glosa,''),coalesce(m.razon_social,''),coalesce(m.ot,m.contrato,nullif(m.num_rel,''),m.lote))::text,'UTF8'),'sha256'),'hex') AS receipt_key,
  m.numero AS document_no,m.fecha,m.lote,m.producto AS product_code,m.glosa AS description,m.unidad AS unit,m.bodega,
  coalesce(m.ot,m.contrato,nullif(m.num_rel,''),m.lote) AS contract_code,m.razon_social,
  round(sum(abs(m.cantidad)),3) AS quantity
 INTO v_receipt
 FROM public.inv_movements m WHERE m.active AND m.side='E' AND public.apt_almacen(m.bodega) IS NOT NULL
 GROUP BY m.fecha,m.numero,m.lote,m.producto,m.unidad,m.bodega,m.glosa,m.ot,m.contrato,m.num_rel,m.razon_social
 HAVING encode(extensions.digest(convert_to(jsonb_build_array(m.fecha::text,m.numero,coalesce(m.lote,''),m.producto,coalesce(m.unidad,''),m.bodega,coalesce(m.glosa,''),coalesce(m.razon_social,''),coalesce(m.ot,m.contrato,nullif(m.num_rel,''),m.lote))::text,'UTF8'),'sha256'),'hex')=p_receipt_key
 LIMIT 1;
 IF NOT FOUND OR v_receipt.quantity<=0 THEN RAISE EXCEPTION 'El IPT no existe en el actualizable APT vigente'; END IF;
 IF EXISTS(SELECT 1 FROM public.wh_packages WHERE source_movement_key=p_receipt_key AND status<>'VOID') THEN RAISE EXCEPTION 'La recepción ya tiene etiquetas; no se puede volver a validar sin anularlas'; END IF;
 v_customer:=coalesce(nullif(v_receipt.razon_social,''),nullif(public.inv_ot_cliente(public.inv_ot(v_receipt.contract_code)),''));
 IF v_customer IS NULL AND v_manual IS NULL THEN RAISE EXCEPTION 'No se encontró el cliente por OT, contrato o lote. Registre el nombre del cliente para continuar'; END IF;
 IF p_physical_quantity<>v_receipt.quantity AND v_reason IS NULL THEN RAISE EXCEPTION 'Registre el motivo de la diferencia entre el ERP y el conteo físico'; END IF;
 INSERT INTO public.wh_receipt_validations(source_movement_key,site_id,erp_quantity,physical_quantity,variance_reason,manual_customer_name,validated_by)
 VALUES(p_receipt_key,v_site,v_receipt.quantity,p_physical_quantity,v_reason,CASE WHEN v_customer IS NULL THEN v_manual END,auth.uid());
 INSERT INTO public.wh_scan_events(site_id,event_type,scanned_code,payload,operator_id,client_event_id)
 VALUES(v_site,'RECEIPT_VALIDATED',v_receipt.document_no,jsonb_build_object('receipt_key',p_receipt_key,'erp_quantity',v_receipt.quantity,
  'physical_quantity',p_physical_quantity,'variance_reason',v_reason,'customer_source',CASE WHEN v_customer IS NULL THEN 'MANUAL' ELSE 'ERP/OT' END),auth.uid(),gen_random_uuid());
 RETURN jsonb_build_object('receipt_key',p_receipt_key,'document_no',v_receipt.document_no,'erp_quantity',v_receipt.quantity,
  'physical_quantity',p_physical_quantity,'variance',p_physical_quantity-v_receipt.quantity,'customer_name',coalesce(v_customer,v_manual),
  'customer_source',CASE WHEN v_customer IS NULL THEN 'MANUAL' ELSE 'ERP/OT' END,'validated',true);
END $$;

CREATE OR REPLACE FUNCTION public.wh_touch_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
CREATE TRIGGER wh_tasks_touch BEFORE UPDATE ON public.wh_tasks FOR EACH ROW EXECUTE FUNCTION public.wh_touch_updated_at();
CREATE TRIGGER wh_packages_touch BEFORE UPDATE ON public.wh_packages FOR EACH ROW EXECUTE FUNCTION public.wh_touch_updated_at();
CREATE OR REPLACE FUNCTION public.wh_reject_scan_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN RAISE EXCEPTION 'Las lecturas de almacén son inmutables'; END $$;
CREATE TRIGGER wh_scan_immutable BEFORE UPDATE OR DELETE ON public.wh_scan_events FOR EACH ROW EXECUTE FUNCTION public.wh_reject_scan_mutation();
CREATE TRIGGER wh_receipt_validation_immutable BEFORE UPDATE OR DELETE ON public.wh_receipt_validations FOR EACH ROW EXECUTE FUNCTION public.wh_reject_scan_mutation();

ALTER TABLE public.wh_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wh_task_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wh_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wh_lpns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wh_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wh_scan_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wh_reconciliation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wh_receipt_validations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wh_pack_sizes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wh_operator_badges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wh_tasks FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.wh_task_lines FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.wh_packages FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.wh_lpns FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.wh_locations FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.wh_scan_events FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.wh_reconciliation FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.wh_receipt_validations FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.wh_pack_sizes FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.wh_operator_badges FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.wh_tasks,public.wh_task_lines,public.wh_packages,public.wh_lpns,public.wh_locations,public.wh_scan_events,public.wh_reconciliation,public.wh_receipt_validations,public.wh_pack_sizes TO authenticated;
CREATE POLICY security_active_account ON public.wh_tasks AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
CREATE POLICY security_active_account ON public.wh_task_lines AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
CREATE POLICY security_active_account ON public.wh_packages AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
CREATE POLICY security_active_account ON public.wh_lpns AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
CREATE POLICY security_active_account ON public.wh_locations AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
CREATE POLICY security_active_account ON public.wh_scan_events AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
CREATE POLICY security_active_account ON public.wh_reconciliation AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
CREATE POLICY security_active_account ON public.wh_receipt_validations AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
CREATE POLICY security_active_account ON public.wh_pack_sizes AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
CREATE POLICY security_active_account ON public.wh_operator_badges AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
CREATE POLICY wh_tasks_read ON public.wh_tasks FOR SELECT TO authenticated USING(public.can_access_site(site_id) AND public.wh_has_permission(ARRAY['almacen-lectura','almacen-supervisor','almacen-picking','almacen-packing','almacen-carga','almacen-etiquetado','apt']));
CREATE POLICY wh_task_lines_read ON public.wh_task_lines FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.wh_tasks t WHERE t.id=task_id AND public.can_access_site(t.site_id) AND public.wh_has_permission(ARRAY['almacen-lectura','almacen-supervisor','almacen-picking','almacen-packing','almacen-carga'])));
CREATE POLICY wh_packages_read ON public.wh_packages FOR SELECT TO authenticated USING(public.can_access_site(site_id) AND public.wh_has_permission(ARRAY['almacen-lectura','almacen-supervisor','almacen-picking','almacen-packing','almacen-carga','almacen-etiquetado']));
CREATE POLICY wh_lpns_read ON public.wh_lpns FOR SELECT TO authenticated USING(public.can_access_site(site_id) AND public.wh_has_permission(ARRAY['almacen-lectura','almacen-supervisor','almacen-packing','almacen-carga']));
CREATE POLICY wh_locations_read ON public.wh_locations FOR SELECT TO authenticated USING(public.can_access_site(site_id) AND public.wh_has_permission(ARRAY['almacen-lectura','almacen-supervisor']));
CREATE POLICY wh_scans_read ON public.wh_scan_events FOR SELECT TO authenticated USING(public.can_access_site(site_id) AND public.wh_has_permission(ARRAY['almacen-supervisor','almacen-lectura']));
CREATE POLICY wh_reconciliation_read ON public.wh_reconciliation FOR SELECT TO authenticated USING(public.can_access_site(site_id) AND public.wh_has_permission(ARRAY['almacen-supervisor','almacen-carga','almacen-lectura','apt-carga']));
CREATE POLICY wh_receipt_validations_read ON public.wh_receipt_validations FOR SELECT TO authenticated USING(public.can_access_site(site_id) AND public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor','almacen-lectura']));
CREATE POLICY wh_pack_sizes_read ON public.wh_pack_sizes FOR SELECT TO authenticated USING(public.wh_has_permission(ARRAY['almacen-lectura','almacen-etiquetado','almacen-supervisor']));

-- Warehouse-produced packing lists remain visible in the existing dispatch document center.
CREATE OR REPLACE FUNCTION public.can_view_dispatch_documents(p_dispatch_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.dispatches d WHERE d.id=p_dispatch_id AND
   ((public.has_tms_read_permission('documentario') OR public.can_view_driver_evidence() OR public.wh_has_permission(ARRAY['almacen-packing','almacen-supervisor']))
    AND (d.site_id IS NULL OR public.can_access_site(d.site_id)))
   OR EXISTS(SELECT 1 FROM public.dispatches d JOIN public.drivers dr ON dr.id=d.driver_id WHERE d.id=p_dispatch_id AND dr.profile_id=auth.uid()))
$$;
DROP POLICY IF EXISTS dispatch_documents_obj_insert ON storage.objects;
CREATE POLICY dispatch_documents_obj_insert ON storage.objects FOR INSERT TO authenticated
 WITH CHECK(bucket_id='dispatch_documents' AND (public.has_tms_permission('documentario') OR public.wh_has_permission(ARRAY['almacen-packing','almacen-supervisor'])) AND public.dispatch_document_folder(name) IS NOT NULL);

CREATE OR REPLACE FUNCTION public.wh_register_packing_list(p_dispatch_id uuid,p_request_id uuid,p_file_path text,p_file_name text,p_size_bytes bigint,p_notes text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid; v_site uuid;
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-packing','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para registrar packing list' USING ERRCODE='42501'; END IF;
 SELECT site_id INTO v_site FROM public.dispatches WHERE id=p_dispatch_id;
 IF v_site IS NULL OR NOT public.can_access_site(v_site) OR public.dispatch_document_folder(p_file_path) IS DISTINCT FROM p_dispatch_id OR NOT EXISTS(SELECT 1 FROM public.dispatch_requests WHERE dispatch_id=p_dispatch_id AND transport_request_id=p_request_id) THEN RAISE EXCEPTION 'Despacho, solicitud o archivo no corresponde'; END IF;
 INSERT INTO public.dispatch_documents(dispatch_id,transport_request_id,doc_type,file_path,file_name,mime_type,size_bytes,notes,uploaded_by)
 VALUES(p_dispatch_id,p_request_id,'PACKING_LIST',p_file_path,p_file_name,'application/pdf',p_size_bytes,coalesce(nullif(trim(p_notes),''),'Packing List generado por Portal WMS'),auth.uid()) RETURNING id INTO v_id;
 RETURN jsonb_build_object('success',true,'id',v_id);
END $$;

CREATE OR REPLACE FUNCTION public.wh_task_status_for_request(p_status text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT CASE upper(coalesce(p_status,'')) WHEN 'PENDIENTE' THEN 'PENDING' WHEN 'PENDIENTE DE APROBACIÓN' THEN 'PENDING' WHEN 'PENDIENTE DE APROBACION' THEN 'PENDING' WHEN 'APROBADA' THEN 'PENDING' WHEN 'REPROGRAMADA' THEN 'PENDING' WHEN 'OBSERVADA' THEN 'PAUSED' WHEN 'RECHAZADA' THEN 'CANCELLED' WHEN 'CANCELADA' THEN 'CANCELLED' ELSE NULL END
$$;
CREATE OR REPLACE FUNCTION public.wh_sync_transport_request() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
END $$;
CREATE TRIGGER wh_transport_request_sync AFTER INSERT OR UPDATE OF status,request_type ON public.transport_requests FOR EACH ROW EXECUTE FUNCTION public.wh_sync_transport_request();
REVOKE ALL ON FUNCTION public.wh_sync_transport_request() FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.wh_sync_request_components() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
END $$;
CREATE TRIGGER wh_request_components_sync AFTER INSERT OR UPDATE OR DELETE ON public.transport_request_components FOR EACH ROW EXECUTE FUNCTION public.wh_sync_request_components();
REVOKE ALL ON FUNCTION public.wh_sync_request_components() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.wh_sync_dispatch_request() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
END $$;
CREATE TRIGGER wh_dispatch_request_sync AFTER INSERT OR UPDATE OR DELETE ON public.dispatch_requests
 FOR EACH ROW EXECUTE FUNCTION public.wh_sync_dispatch_request();
REVOKE ALL ON FUNCTION public.wh_sync_dispatch_request() FROM PUBLIC,anon,authenticated;
-- Bring existing operational requests into WMS without duplicating one task per request.
INSERT INTO public.wh_tasks(task_code,transport_request_id,site_id,contract_id,created_by,request_status,dispatch_id)
SELECT 'WH-'||r.request_number,r.id,r.site_id,r.contract_id,r.created_by,r.status,
 (SELECT dr.dispatch_id FROM public.dispatch_requests dr WHERE dr.transport_request_id=r.id ORDER BY dr.created_at DESC LIMIT 1)
FROM public.transport_requests r
WHERE r.status NOT IN ('CANCELADA','RECHAZADA')
 AND upper(coalesce(r.request_type,'DESPACHO')) NOT IN ('RECOJO','TRASLADO')
ON CONFLICT(transport_request_id) DO NOTHING;
-- Las líneas se incorporan desde paquetes APT al iniciar picking; las solicitudes no tienen detalle de producto en este esquema.

CREATE OR REPLACE FUNCTION public.wh_task_action(p_task_id uuid,p_action text,p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
END $$;

CREATE OR REPLACE FUNCTION public.wh_block_dispatch_without_wh_load() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
END $$;
CREATE TRIGGER wh_dispatch_load_guard BEFORE UPDATE OF status ON public.dispatches FOR EACH ROW EXECUTE FUNCTION public.wh_block_dispatch_without_wh_load();
REVOKE ALL ON FUNCTION public.wh_block_dispatch_without_wh_load() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.wh_record_scan(p_task_id uuid,p_code text,p_event text,p_client_event_id uuid,p_payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
END $$;

CREATE OR REPLACE FUNCTION public.wh_create_lpn(p_task_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
END $$;
CREATE OR REPLACE FUNCTION public.wh_add_package_to_lpn(p_lpn_id uuid,p_package_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
END $$;
CREATE OR REPLACE FUNCTION public.wh_close_lpn(p_lpn_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE l public.wh_lpns%ROWTYPE;
BEGIN
 PERFORM public.security_assert_active_session(); IF NOT public.wh_has_permission(ARRAY['almacen-packing','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso de packing'; END IF;
 SELECT * INTO l FROM public.wh_lpns WHERE id=p_lpn_id FOR UPDATE;
 IF NOT FOUND OR NOT public.can_access_site(l.site_id) OR l.status<>'OPEN' OR l.package_count=0 THEN RAISE EXCEPTION 'LPN no disponible o vacío'; END IF;
 UPDATE public.wh_lpns SET status='CLOSED',closed_by=auth.uid(),closed_at=now() WHERE id=l.id;
 INSERT INTO public.wh_scan_events(site_id,task_id,lpn_id,event_type,scanned_code,payload,operator_id,client_event_id)
 VALUES(l.site_id,l.task_id,l.id,'LPN_CLOSE',l.lpn_code,jsonb_build_object('package_count',l.package_count,'quantity',l.quantity,'weight_kg',l.weight_kg),auth.uid(),gen_random_uuid());
 RETURN jsonb_build_object('success',true,'lpn',l.lpn_code,'packages',l.package_count,'quantity',l.quantity,'weight_kg',l.weight_kg);
END $$;

CREATE OR REPLACE FUNCTION public.wh_reconcile_batch(p_rows jsonb,p_source_batch text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
END $$;
CREATE OR REPLACE FUNCTION public.wh_reconcile_apt_outflows(p_from date,p_until date,p_source_batch text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
END $$;
CREATE OR REPLACE FUNCTION public.wh_resolve_reconciliation(p_id uuid,p_resolution text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.wh_reconciliation%ROWTYPE;
BEGIN
 PERFORM public.security_assert_active_session(); IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) OR nullif(trim(p_resolution),'') IS NULL THEN RAISE EXCEPTION 'Resolución requiere supervisión y motivo'; END IF;
 UPDATE public.wh_reconciliation SET status='RESOLVED',resolution=trim(p_resolution),resolved_by=auth.uid(),resolved_at=now() WHERE id=p_id AND public.can_access_site(site_id) AND status IN ('OPEN','SHORT','OVER') RETURNING * INTO r;
 IF NOT FOUND THEN RAISE EXCEPTION 'Diferencia no disponible'; END IF; RETURN jsonb_build_object('id',r.id,'status',r.status);
END $$;
CREATE OR REPLACE FUNCTION public.wh_reprint_lpn_label(p_lpn_code text,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
END $$;

CREATE OR REPLACE FUNCTION public.wh_pack_size_upsert(p_product_code text,p_units_per_package numeric,p_unit text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) OR nullif(trim(p_product_code),'') IS NULL OR p_units_per_package<=0 THEN
  RAISE EXCEPTION 'Solo supervisión puede guardar un tamaño de paquete válido' USING ERRCODE='42501';
 END IF;
 INSERT INTO public.wh_pack_sizes(product_code,units_per_package,unit,updated_by)
 VALUES(upper(trim(p_product_code)),p_units_per_package,nullif(upper(trim(coalesce(p_unit,''))),''),auth.uid())
 ON CONFLICT(product_code) DO UPDATE SET units_per_package=excluded.units_per_package,unit=excluded.unit,updated_by=excluded.updated_by,updated_at=now();
 RETURN jsonb_build_object('product_code',upper(trim(p_product_code)),'units_per_package',p_units_per_package);
END $$;
CREATE OR REPLACE FUNCTION public.wh_pack_size_delete(p_product_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM public.security_assert_active_session();
 IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) OR nullif(trim(p_product_code),'') IS NULL THEN RAISE EXCEPTION 'Solo supervisión puede eliminar un embalaje'; END IF;
 DELETE FROM public.wh_pack_sizes WHERE product_code=upper(trim(p_product_code));
 IF NOT FOUND THEN RAISE EXCEPTION 'No existe la configuración de embalaje'; END IF;
 RETURN jsonb_build_object('product_code',upper(trim(p_product_code)),'deleted',true);
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
 SELECT r.* INTO v_receipt FROM (
  SELECT encode(extensions.digest(convert_to(jsonb_build_array(m.fecha::text,m.numero,coalesce(m.lote,''),m.producto,coalesce(m.unidad,''),m.bodega,coalesce(m.glosa,''),coalesce(m.razon_social,''),coalesce(m.ot,m.contrato,nullif(m.num_rel,''),m.lote))::text,'UTF8'),'sha256'),'hex') AS receipt_key,
   m.numero AS document_no,m.fecha,m.lote,m.producto AS product_code,m.glosa AS description,m.unidad AS unit,m.bodega,
   coalesce(m.ot,m.contrato,nullif(m.num_rel,''),m.lote) AS contract_code,c.id AS contract_id,round(sum(abs(m.cantidad)),3) AS quantity,round(sum(abs(m.peso_kg)),3) AS weight_kg
  FROM public.inv_movements m LEFT JOIN public.contracts c ON regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(coalesce(m.ot,m.contrato,nullif(m.num_rel,''),m.lote)),'[^A-Z0-9]','','g'),'^OT','')
  WHERE m.active AND m.side='E' AND public.apt_almacen(m.bodega) IS NOT NULL
  GROUP BY m.fecha,m.numero,m.lote,m.producto,m.unidad,m.bodega,m.glosa,m.ot,m.contrato,m.num_rel,c.id
 ) r WHERE r.receipt_key=p_receipt_key;
 IF NOT FOUND OR v_receipt.quantity<=0 THEN RAISE EXCEPTION 'El ingreso APT no existe o ya no está activo; actualice las entradas del ERP'; END IF;
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
CREATE OR REPLACE FUNCTION public.wh_print_labels(p_package_codes text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
END $$;

CREATE OR REPLACE FUNCTION public.wh_reprint_label(p_package_code text,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p public.wh_packages%ROWTYPE;
BEGIN
 PERFORM public.security_assert_active_session(); IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) OR nullif(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Reimpresión requiere permiso y motivo'; END IF;
 SELECT * INTO p FROM public.wh_packages WHERE package_code=trim(p_package_code) FOR UPDATE;
 IF NOT FOUND OR NOT public.can_access_site(p.site_id) OR p.status='VOID' THEN RAISE EXCEPTION 'Etiqueta no disponible'; END IF;
 UPDATE public.wh_packages SET label_print_count=label_print_count+1 WHERE id=p.id;
 INSERT INTO public.wh_scan_events(site_id,task_id,package_id,event_type,scanned_code,payload,operator_id,client_event_id)
  VALUES(p.site_id,p.task_id,p.id,'LABEL_REPRINT',p.package_code,jsonb_build_object('reason',trim(p_reason),'previous_print_count',p.label_print_count),auth.uid(),gen_random_uuid());
 RETURN jsonb_build_object('package_code',p.package_code,'print_count',p.label_print_count+1);
END $$;
CREATE OR REPLACE FUNCTION public.wh_void_package(p_package_code text,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
END $$;

-- All state changes go through the audited RPC layer; clients cannot directly mutate operational tables.
REVOKE ALL ON FUNCTION public.wh_task_action(uuid,text,text),public.wh_record_scan(uuid,text,text,uuid,jsonb),public.wh_create_lpn(uuid),public.wh_add_package_to_lpn(uuid,text),public.wh_close_lpn(uuid),public.wh_reconcile_batch(jsonb,text),public.wh_reconcile_apt_outflows(date,date,text),public.wh_resolve_reconciliation(uuid,text),public.wh_label_package(text,integer,numeric),public.wh_validate_receipt(text,numeric,text,text),public.wh_pack_size_upsert(text,numeric,text),public.wh_pack_size_delete(text),public.wh_print_labels(text[]),public.wh_reprint_label(text,text),public.wh_reprint_lpn_label(text,text),public.wh_void_package(text,text),public.wh_register_packing_list(uuid,uuid,text,text,bigint,text),public.wh_receipt_candidates(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.wh_task_action(uuid,text,text),public.wh_record_scan(uuid,text,text,uuid,jsonb),public.wh_create_lpn(uuid),public.wh_add_package_to_lpn(uuid,text),public.wh_close_lpn(uuid),public.wh_reconcile_batch(jsonb,text),public.wh_reconcile_apt_outflows(date,date,text),public.wh_resolve_reconciliation(uuid,text),public.wh_label_package(text,integer,numeric),public.wh_validate_receipt(text,numeric,text,text),public.wh_pack_size_upsert(text,numeric,text),public.wh_pack_size_delete(text),public.wh_print_labels(text[]),public.wh_reprint_label(text,text),public.wh_reprint_lpn_label(text,text),public.wh_void_package(text,text),public.wh_register_packing_list(uuid,uuid,text,text,bigint,text),public.wh_receipt_candidates(text) TO authenticated;
COMMIT;
