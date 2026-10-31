-- Flete pactado obligatorio con tercero: una ruta con transportista tercero no se programa sin flete, tenga o no OT
-- (el proveedor siempre cobra). Se mantiene la regla de 20261114090000_flete_obligatorio_ot para flota propia: un servicio
-- de OT no queda sin costo; recojo con flota propia y recojo por el cliente no se valorizan. Reescritura completa de
-- dispatch_ot_freight_check; las guardas diferidas de esa migración no cambian. No se modifican rutas existentes.
BEGIN;

CREATE OR REPLACE FUNCTION public.dispatch_ot_freight_check(p_dispatch_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; v_own boolean; v_missing text; v_zero text; v_third text;
BEGIN
 SELECT x.id, x.status, COALESCE(x.freight_cost, 0) AS freight_cost,
   COALESCE(to_jsonb(x)->>'modalidad', CASE WHEN NULLIF(to_jsonb(x)->>'carrier_id', '') IS NOT NULL THEN 'TERCERO' ELSE 'PROPIA' END) AS modalidad
 INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
 IF NOT FOUND OR d.status NOT IN ('PROGRAMADO','EN_CURSO','EN RUTA') THEN RETURN; END IF;
 v_own := d.modalidad <> 'TERCERO';
 -- Tercero: el flete pactado con el proveedor es obligatorio (salvo recojo por el cliente, sin transporte JRM)
 IF NOT v_own AND d.freight_cost <= 0 THEN
  SELECT string_agg(t.request_number::text, ', ' ORDER BY t.request_number) INTO v_third
  FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id
  WHERE dr.dispatch_id = p_dispatch_id AND COALESCE(t.attention_mode, '') <> 'RECOJO_CLIENTE';
  IF v_third IS NOT NULL THEN
   RAISE EXCEPTION 'Indique el flete pactado con el proveedor: una ruta con tercero no puede programarse sin costo (%)', v_third
    USING ERRCODE = 'check_violation';
  END IF;
 END IF;
 -- Servicios de OT que deben llevar flete
 SELECT string_agg(t.request_number::text, ', ' ORDER BY t.request_number) INTO v_missing
 FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id
 WHERE dr.dispatch_id = p_dispatch_id AND t.contract_id IS NOT NULL AND COALESCE(t.attention_mode, '') <> 'RECOJO_CLIENTE'
   AND NOT (v_own AND t.request_type = 'RECOJO');
 IF v_missing IS NULL THEN RETURN; END IF;
 IF d.freight_cost <= 0 THEN
  RAISE EXCEPTION 'Un servicio de transporte de una OT no puede programarse sin costo (%). Indique el flete de la ruta, sea flota propia o tercero', v_missing
   USING ERRCODE = 'check_violation';
 END IF;
 -- Rutas con flete repartido por OT: ninguna OT con flete 0
 SELECT string_agg(t.request_number::text, ', ' ORDER BY t.request_number) INTO v_zero
 FROM public.dispatch_request_freight f JOIN public.transport_requests t ON t.id = f.request_id
 WHERE f.dispatch_id = p_dispatch_id AND f.status <> 'LIBERADO' AND f.contract_id IS NOT NULL AND COALESCE(f.amount_pen, 0) <= 0
   AND COALESCE(t.attention_mode, '') <> 'RECOJO_CLIENTE' AND NOT (v_own AND t.request_type = 'RECOJO');
 IF v_zero IS NOT NULL THEN
  RAISE EXCEPTION 'Cada servicio de OT debe llevar su flete: % sin costo en la distribución del flete', v_zero USING ERRCODE = 'check_violation';
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.dispatch_ot_freight_check(uuid) FROM PUBLIC,anon,authenticated;

COMMIT;
