-- Un servicio de transporte de una OT no se programa sin costo, sea flota propia o tercero.
-- Se valida al final de la transacción (programar la ruta, agregar un servicio a una ruta activa o cambiar el flete), con la
-- ruta en PROGRAMADO o en curso. No aplica a: recojo por el cliente (Nota de Salida, sin transporte JRM) ni recojo con flota
-- propia, que por regla vigente no se valoriza. No se modifican rutas existentes: solo se impide crear o dejar una en 0.
BEGIN;

CREATE OR REPLACE FUNCTION public.dispatch_ot_freight_check(p_dispatch_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; v_own boolean; v_missing text; v_zero text;
BEGIN
 SELECT x.id, x.status, COALESCE(x.freight_cost, 0) AS freight_cost,
   COALESCE(to_jsonb(x)->>'modalidad', CASE WHEN NULLIF(to_jsonb(x)->>'carrier_id', '') IS NOT NULL THEN 'TERCERO' ELSE 'PROPIA' END) AS modalidad
 INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
 IF NOT FOUND OR d.status NOT IN ('PROGRAMADO','EN_CURSO','EN RUTA') THEN RETURN; END IF;
 v_own := d.modalidad <> 'TERCERO';
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

CREATE OR REPLACE FUNCTION public.dispatch_ot_freight_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME = 'dispatches' THEN PERFORM public.dispatch_ot_freight_check(NEW.id);
 ELSE PERFORM public.dispatch_ot_freight_check(NEW.dispatch_id); END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.dispatch_ot_freight_guard() FROM PUBLIC,anon,authenticated;

-- Diferidas al final de la transacción: la programación inserta la ruta, sus paradas y su flete en varios pasos.
DROP TRIGGER IF EXISTS dispatch_ot_freight_guard ON public.dispatches;
CREATE CONSTRAINT TRIGGER dispatch_ot_freight_guard AFTER INSERT OR UPDATE OF freight_cost ON public.dispatches
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.dispatch_ot_freight_guard();
DROP TRIGGER IF EXISTS dispatch_request_ot_freight_guard ON public.dispatch_requests;
CREATE CONSTRAINT TRIGGER dispatch_request_ot_freight_guard AFTER INSERT ON public.dispatch_requests
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.dispatch_ot_freight_guard();
DROP TRIGGER IF EXISTS dispatch_request_freight_ot_guard ON public.dispatch_request_freight;
CREATE CONSTRAINT TRIGGER dispatch_request_freight_ot_guard AFTER INSERT OR UPDATE OF amount_pen ON public.dispatch_request_freight
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.dispatch_ot_freight_guard();

COMMIT;
