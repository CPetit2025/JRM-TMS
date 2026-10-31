-- Cierre económico: en una ruta de flota propia con reparto por servicio, el flete de un servicio que se programó en S/ 0
-- (p. ej. recojo con flota propia, que no se valoriza) queda en S/ 0 y aprobado sin pedir confirmación, aunque la ruta aún
-- no esté cerrada en Torre de Control. Solo cambia la lectura de los ítems (no se escriben datos).
-- Reescrita completa desde 20261111120000_cierre_economico_parcial.
BEGIN;

CREATE OR REPLACE FUNCTION public.economic_route_items(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; s record; v_items jsonb; v_freight jsonb := '[]'::jsonb; v_carrier text; v_agreed numeric; v_own boolean;
BEGIN
 SELECT x.id, COALESCE(x.freight_cost, 0) AS freight_cost, to_jsonb(x)->>'modalidad' AS modalidad, NULLIF(to_jsonb(x)->>'carrier_id','')::uuid AS carrier_id
 INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
 IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;
 v_own := COALESCE(d.modalidad, CASE WHEN d.carrier_id IS NOT NULL THEN 'TERCERO' ELSE 'PROPIA' END) <> 'TERCERO';
 SELECT * INTO s FROM public.dispatch_freight_stages WHERE dispatch_id = p_dispatch_id;
 IF d.modalidad = 'TERCERO' AND d.carrier_id IS NOT NULL THEN
  SELECT to_jsonb(c)->>'business_name' INTO v_carrier FROM public.carriers c WHERE c.id = d.carrier_id;
 END IF;
 v_carrier := COALESCE(v_carrier, CASE WHEN d.modalidad = 'TERCERO' THEN 'Transportista tercero' ELSE 'JRM (flota propia)' END);

 IF EXISTS (SELECT 1 FROM public.dispatch_request_freight WHERE dispatch_id = p_dispatch_id) THEN
  -- Flota propia sin flete (p. ej. recojo con flota propia, que no se valoriza): queda en S/ 0 sin pedir confirmación
  SELECT COALESCE(jsonb_agg(CASE WHEN v_own AND COALESCE(st.agreed_pen, f.amount_pen, 0) = 0 AND COALESCE(st.final_pen, 0) = 0
       AND COALESCE(st.econ_status, '') NOT IN ('OBSERVADO','EN_REVISION') THEN x.item || jsonb_build_object('final_pen', 0, 'status', 'APROBADO', 'auto', true,
       'reason', 'Flota propia sin flete: no se valoriza', 'validated_by', 'Automático') ELSE x.item END ORDER BY t.request_number), '[]'::jsonb)
  INTO v_freight
  FROM public.dispatch_request_freight f JOIN public.transport_requests t ON t.id = f.request_id
  LEFT JOIN public.dispatch_request_freight_stages st ON st.dispatch_id = f.dispatch_id AND st.request_id = f.request_id
  CROSS JOIN LATERAL (SELECT jsonb_build_object('key', 'F:' || f.request_id, 'kind', 'FLETE', 'id', f.request_id, 'concept', 'FLETE',
     'request_number', t.request_number, 'contract_id', f.contract_id, 'contract_code', (SELECT c.code FROM public.contracts c WHERE c.id = f.contract_id),
     'origin', 'PROGRAMACION', 'supplier', v_carrier,
     'referential_pen', COALESCE(public.request_referential_freight(t.id), 0),
     'agreed_pen', COALESCE(st.agreed_pen, f.amount_pen), 'final_pen', st.final_pen, 'extras_pen', NULL,
     'billing_unit', NULL, 'executed_qty', NULL, 'billable_qty', NULL, 'reason', s.final_reason,
     'validated_at', CASE WHEN st.final_pen IS NOT NULL THEN s.final_at END,
     'validated_by', CASE WHEN st.final_pen IS NOT NULL THEN public.economic_user_name(s.final_by) END,
     'applied_pen', COALESCE(st.final_applied_pen, f.amount_pen), 'observation', st.econ_observation,
     'approved_at', st.econ_approved_at, 'approved_by', public.economic_user_name(st.econ_approved_by),
     'status', public.economic_item_status(st.econ_status, st.final_pen)) AS item) x
  WHERE f.dispatch_id = p_dispatch_id AND f.status <> 'LIBERADO';
 ELSE
  v_agreed := COALESCE(s.agreed_pen, d.freight_cost);
  IF v_agreed > 0 OR d.freight_cost > 0 OR s.final_pen IS NOT NULL THEN
   v_freight := jsonb_build_array(jsonb_build_object('key', 'F:' || p_dispatch_id, 'kind', 'FLETE', 'id', NULL, 'concept', 'FLETE',
    'request_number', (SELECT string_agg(t.request_number::text, ', ' ORDER BY t.request_number) FROM public.dispatch_requests dr
       JOIN public.transport_requests t ON t.id = dr.transport_request_id WHERE dr.dispatch_id = p_dispatch_id),
    'contract_id', (SELECT x.contract_id FROM public.dispatches x WHERE x.id = p_dispatch_id),
    'contract_code', (SELECT c.code FROM public.dispatches x JOIN public.contracts c ON c.id = x.contract_id WHERE x.id = p_dispatch_id),
    'origin', 'PROGRAMACION', 'supplier', v_carrier,
    'referential_pen', (SELECT COALESCE(sum(COALESCE(public.request_referential_freight(t.id), 0)), 0)
       FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id WHERE dr.dispatch_id = p_dispatch_id),
    'agreed_pen', v_agreed, 'final_pen', s.final_pen, 'extras_pen', s.extras_pen,
    'billing_unit', NULL, 'executed_qty', NULL, 'billable_qty', NULL, 'reason', s.final_reason,
    'validated_at', s.final_at, 'validated_by', public.economic_user_name(s.final_by),
    'applied_pen', COALESCE(s.final_applied_pen, d.freight_cost), 'observation', s.econ_observation,
    'approved_at', s.econ_approved_at, 'approved_by', public.economic_user_name(s.econ_approved_by),
    'status', public.economic_item_status(s.econ_status, s.final_pen)));
  END IF;
 END IF;

 SELECT COALESCE(jsonb_agg(jsonb_build_object('key', 'S:' || u.id, 'kind', 'SERVICIO', 'id', u.id, 'concept', u.concept,
    'request_number', t.request_number, 'contract_id', u.contract_id, 'contract_code', (SELECT c.code FROM public.contracts c WHERE c.id = u.contract_id),
    'origin', u.origin, 'supplier', COALESCE(sp.business_name, u.provider_name),
    'referential_pen', COALESCE(u.estimated_pen, 0), 'agreed_pen', COALESCE(u.planned_pen, u.estimated_pen, 0), 'final_pen', u.final_pen,
    'extras_pen', u.final_extras_pen, 'billing_unit', u.billing_unit, 'executed_qty', u.final_executed_qty, 'billable_qty', u.final_billable_qty,
    'reason', u.final_reason, 'validated_at', u.final_validated_at, 'validated_by', public.economic_user_name(u.final_validated_by),
    'applied_pen', CASE WHEN u.status = 'CONSUMIDO' THEN u.actual_pen END, 'caja_pen', u.caja_pen, 'observation', u.econ_observation,
    'approved_at', u.econ_approved_at, 'approved_by', public.economic_user_name(u.econ_approved_by),
    'status', public.economic_item_status(u.econ_status, CASE WHEN u.final_validated_at IS NOT NULL THEN u.final_pen END))
    ORDER BY t.request_number, u.concept), '[]'::jsonb)
 INTO v_items
 FROM public.transport_unloading_costs u JOIN public.transport_requests t ON t.id = u.transport_request_id
 LEFT JOIN public.suppliers sp ON sp.id = u.supplier_id
 WHERE u.dispatch_id = p_dispatch_id AND u.status IN ('PLANIFICADO','CONSUMIDO');
 RETURN v_freight || v_items;
END $$;
REVOKE ALL ON FUNCTION public.economic_route_items(uuid) FROM PUBLIC,anon,authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
