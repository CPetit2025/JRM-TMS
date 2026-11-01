-- Proveedor propio de cada referencia OS/OC/RQ y costos en el reporte por unidad.
BEGIN;

ALTER TABLE public.transport_requests
  ADD COLUMN IF NOT EXISTS reference_supplier_id uuid REFERENCES public.suppliers(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS transport_requests_reference_supplier_idx
  ON public.transport_requests(reference_supplier_id) WHERE reference_supplier_id IS NOT NULL;
COMMENT ON COLUMN public.transport_requests.reference_supplier_id IS
  'Proveedor asociado al documento OS/OC/RQ; independiente del proveedor de origen supplier_id.';

-- Mantiene el guardado transaccional existente y agrega la validación del proveedor de referencia.
CREATE OR REPLACE FUNCTION public.apply_request_supplier(p_request_id uuid, p_payload jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r public.transport_requests;
  v_supplier uuid;
  v_location uuid;
  v_type text;
  v_number text;
  v_reference_supplier uuid;
BEGIN
  SELECT * INTO r FROM public.transport_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Solicitud inexistente'; END IF;
  v_supplier := NULLIF(p_payload->>'supplier_id', '')::uuid;
  v_location := NULLIF(p_payload->>'supplier_location_id', '')::uuid;
  v_type := NULLIF(upper(btrim(p_payload->>'reference_type')), '');
  v_number := NULLIF(btrim(p_payload->>'reference_number'), '');
  v_reference_supplier := CASE WHEN p_payload ? 'reference_supplier_id'
    THEN NULLIF(p_payload->>'reference_supplier_id', '')::uuid ELSE r.reference_supplier_id END;

  IF r.request_type IN ('RECOJO','TRASLADO') AND COALESCE(to_jsonb(r)->>'attention_mode', '') <> 'RECOJO_CLIENTE' AND v_supplier IS NULL THEN
    RAISE EXCEPTION 'Seleccione el proveedor del recojo o traslado';
  END IF;
  IF v_supplier IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.suppliers WHERE id = v_supplier AND is_active) THEN
    RAISE EXCEPTION 'Proveedor inexistente o inactivo';
  END IF;
  IF v_location IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.supplier_locations WHERE id = v_location AND supplier_id = v_supplier) THEN
    RAISE EXCEPTION 'El punto de recojo no pertenece al proveedor';
  END IF;
  IF v_type IS NOT NULL AND v_type NOT IN ('OC','RQ','OS') THEN RAISE EXCEPTION 'Documento de referencia inválido'; END IF;
  IF v_type IS NOT NULL AND v_number IS NULL THEN RAISE EXCEPTION 'Ingrese el número del documento %', v_type; END IF;
  IF v_type IS NULL THEN
    v_number := NULL;
    v_reference_supplier := NULL;
  END IF;
  IF v_type IS NOT NULL AND v_reference_supplier IS NULL THEN
    RAISE EXCEPTION 'Seleccione el proveedor de la referencia %', v_type;
  END IF;
  IF v_reference_supplier IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.suppliers WHERE id = v_reference_supplier AND is_active
  ) THEN RAISE EXCEPTION 'Proveedor de referencia inexistente o inactivo'; END IF;

  UPDATE public.transport_requests
    SET supplier_id = v_supplier, supplier_location_id = v_location, reference_type = v_type,
        reference_number = v_number, reference_supplier_id = v_reference_supplier
    WHERE id = p_request_id;
END $$;
REVOKE ALL ON FUNCTION public.apply_request_supplier(uuid,jsonb) FROM PUBLIC, anon, authenticated;

-- Agrega proveedor y origen a cada parada; conserva el payload y los permisos del reporte existente.
DO $patch$
DECLARE sig regprocedure := 'public.unit_daily_report(text,date,date)'::regprocedure; def text;
  old_stop text := '''type'', s.request_type, ''ot'', s.ot, ''ref_type'', s.ref_type, ''ref_number'', s.ref_number, ''client'', s.client, ''destination'', s.destination, ''km_leg'', s.leg_actual_km';
  new_stop text := '''type'', s.request_type, ''ot'', s.ot, ''ref_type'', s.ref_type, ''ref_number'', s.ref_number, ''reference_supplier'', s.reference_supplier, ''client'', s.client, ''origin'', s.origin, ''destination'', s.destination, ''km_leg'', s.leg_actual_km, ''km_source'', CASE WHEN s.leg_gps_complete IS TRUE THEN ''GPS_COMPLETO'' WHEN s.leg_actual_km IS NOT NULL THEN ''GPS_PARCIAL'' ELSE ''SIN_DATO'' END';
  old_select text := 'c.code AS ot, COALESCE(cl.business_name, cl2.business_name) AS client,';
  new_select text := 'c.code AS ot, COALESCE(cl.business_name, cl2.business_name) AS client, dr.leg_gps_complete, sp.business_name AS reference_supplier,';
  old_join text := 'LEFT JOIN public.contracts c ON c.id = r.contract_id';
  new_join text := 'LEFT JOIN public.contracts c ON c.id = r.contract_id LEFT JOIN public.suppliers sp ON sp.id = r.reference_supplier_id';
  old_dest text := 'NULLIF(concat_ws('', '', NULLIF(btrim(r.delivery_address), ''''), NULLIF(btrim(to_jsonb(r)->>''delivery_district''), '''')), '''') AS destination,';
  new_dest text := 'NULLIF(concat_ws('', '', NULLIF(btrim(r.pickup_address), ''''), NULLIF(btrim(to_jsonb(r)->>''pickup_district''), ''''), NULLIF(btrim(to_jsonb(r)->>''pickup_province''), ''''), NULLIF(btrim(to_jsonb(r)->>''pickup_department''), '''')), '''') AS origin, NULLIF(concat_ws('', '', NULLIF(btrim(r.delivery_address), ''''), NULLIF(btrim(to_jsonb(r)->>''delivery_district''), ''''), NULLIF(btrim(to_jsonb(r)->>''delivery_province''), ''''), NULLIF(btrim(to_jsonb(r)->>''delivery_department''), '''')), '''') AS destination,';
  old_disp text := 'NULLIF((to_jsonb(d)->>''actual_distance_km'')::numeric, 0) AS km_real, NULLIF((to_jsonb(d)->>''estimated_distance_km'')::numeric, 0) AS km_est';
  new_disp text := 'NULLIF((to_jsonb(d)->>''actual_distance_km'')::numeric, 0) AS km_real, NULLIF((to_jsonb(d)->>''estimated_distance_km'')::numeric, 0) AS km_est, COALESCE((SELECT sum(a.amount_pen) FROM public.cost_allocations a WHERE a.dispatch_id=d.id AND a.status<>''ANULADO''),0) AS cost_total, COALESCE((SELECT sum(a.amount_pen) FROM public.cost_allocations a WHERE a.dispatch_id=d.id AND a.status=''APLICADO''),0) AS cost_applied, COALESCE((SELECT sum(a.amount_pen) FROM public.cost_allocations a WHERE a.dispatch_id=d.id AND a.status=''PENDIENTE''),0) AS cost_pending, COALESCE((SELECT jsonb_agg(jsonb_build_object(''kind'',a.kind,''amount_pen'',a.amount_pen,''basis'',a.basis,''status'',a.status,''request_number'',tr.request_number,''ot'',ct.code,''expense_type'',COALESCE(a.detail->>''expense_type'',e.expense_type::text),''fuel_gallons'',CASE WHEN a.status<>''ANULADO'' THEN round(e.fuel_gallons*COALESCE((a.detail->>''share'')::numeric,1),3) END,''fuel_odometer'',e.fuel_odometer,''estimated'',COALESCE((a.detail->>''estimado'')::boolean,false)) ORDER BY a.created_at,a.kind) FROM public.cost_allocations a LEFT JOIN public.dispatch_expenses e ON e.id=a.expense_id LEFT JOIN public.transport_requests tr ON tr.id=a.request_id LEFT JOIN public.contracts ct ON ct.id=tr.contract_id WHERE a.dispatch_id=d.id),''[]''::jsonb) AS costs';
  old_disp_json text := '''departure'', disp.scheduled_departure, ''km_gps'', disp.km_gps, ''km_real'', disp.km_real, ''km_est'', disp.km_est,';
  new_disp_json text := '''departure'', disp.scheduled_departure, ''km_gps'', disp.km_gps, ''km_real'', disp.km_real, ''km_est'', disp.km_est, ''cost_total'', disp.cost_total, ''cost_applied'', disp.cost_applied, ''cost_pending'', disp.cost_pending, ''costs'', disp.costs,';
  old_day text := '(SELECT round(sum(x.km_est), 1) FROM disp x WHERE x.day = d.day) AS km_est,';
  new_day text := '(SELECT round(sum(x.km_est), 1) FROM disp x WHERE x.day = d.day) AS km_est, (SELECT round(sum(x.cost_total),2) FROM disp x WHERE x.day=d.day) AS cost_total, (SELECT round(sum(x.cost_applied),2) FROM disp x WHERE x.day=d.day) AS cost_applied, (SELECT round(sum(x.cost_pending),2) FROM disp x WHERE x.day=d.day) AS cost_pending,';
  old_result_day text := '''odo_start'', f.odo_start, ''odo_end'', f.odo_end, ''end_source'', f.end_source, ''km_odo'', f.km_odo, ''km_gps'', f.km_gps, ''km_real'', f.km_real, ''km_est'', f.km_est,';
  new_result_day text := '''odo_start'', f.odo_start, ''odo_end'', f.odo_end, ''end_source'', f.end_source, ''km_odo'', f.km_odo, ''km_gps'', f.km_gps, ''km_real'', f.km_real, ''km_est'', f.km_est, ''cost_total'',f.cost_total,''cost_applied'',f.cost_applied,''cost_pending'',f.cost_pending,';
  old_tot text := '''km_real'', round(COALESCE(sum(f.km_real), 0), 1), ''km_est'', round(COALESCE(sum(f.km_est), 0), 1),';
  new_tot text := '''km_real'', round(COALESCE(sum(f.km_real), 0), 1), ''km_est'', round(COALESCE(sum(f.km_est), 0), 1), ''cost_total'',round(COALESCE(sum(f.cost_total),0),2),''cost_applied'',round(COALESCE(sum(f.cost_applied),0),2),''cost_pending'',round(COALESCE(sum(f.cost_pending),0),2),';
BEGIN
  def := pg_get_functiondef(sig);
  IF position(new_stop IN def) > 0 AND position(new_disp IN def) > 0 THEN RETURN; END IF;
  IF position(old_stop IN def) = 0 OR position(old_select IN def) = 0 OR position(old_join IN def) = 0 OR position(old_dest IN def) = 0
    OR position(old_disp IN def) = 0 OR position(old_disp_json IN def) = 0 OR position(old_day IN def) = 0
    OR position(old_result_day IN def) = 0 OR position(old_tot IN def) = 0 THEN
    RAISE EXCEPTION 'Definición actual de unit_daily_report no reconocida; revisar antes de migrar';
  END IF;
  def := replace(def, old_stop, new_stop);
  def := replace(def, old_select, new_select);
  def := replace(def, old_join, new_join);
  def := replace(def, old_dest, new_dest);
  def := replace(def, old_disp, new_disp);
  def := replace(def, old_disp_json, new_disp_json);
  def := replace(def, old_day, new_day);
  def := replace(def, old_result_day, new_result_day);
  def := replace(def, old_tot, new_tot);
  EXECUTE def;
END $patch$;

NOTIFY pgrst, 'reload schema';
COMMIT;
