BEGIN;
SET LOCAL lock_timeout = '60s';

ALTER TABLE public.route_forklifts
  ADD COLUMN IF NOT EXISTS service_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS service_ended_at timestamptz;
DO $$ BEGIN
  ALTER TABLE public.route_forklifts ADD CONSTRAINT route_forklifts_service_time_pair
    CHECK ((service_started_at IS NULL) = (service_ended_at IS NULL)
      AND (service_ended_at IS NULL OR service_ended_at > service_started_at));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Dispatch roles can use the personnel roster as part of scheduling; the earlier policy
-- accidentally narrowed the established read access to the new supplier-master permission.
DROP POLICY IF EXISTS supplier_personnel_logistics_read ON public.supplier_personnel;
CREATE POLICY supplier_personnel_logistics_read ON public.supplier_personnel FOR SELECT TO authenticated
 USING (EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id=supplier_id
   AND s.category IN ('TRANSPORTE','MONTACARGA','SERVICIOS')
   AND (public.has_tms_read_permission('proveedores-logisticos') OR public.has_tms_read_permission('tarifas')
     OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('documentario'))));
DROP POLICY IF EXISTS suppliers_logistics_read ON public.suppliers;
CREATE POLICY suppliers_logistics_read ON public.suppliers FOR SELECT TO authenticated
 USING (category IN ('TRANSPORTE','MONTACARGA','SERVICIOS')
   AND (public.has_tms_read_permission('proveedores-logisticos') OR public.has_tms_read_permission('tarifas')
     OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('documentario')));

CREATE OR REPLACE FUNCTION public.settle_route_forklift_times(p_dispatch_id uuid,p_started_at timestamptz,p_ended_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f public.route_forklifts%ROWTYPE; v_hours numeric; v_amount numeric;
BEGIN
 IF NOT (public.has_tms_permission('documentario') OR public.has_tms_permission('despacho') OR public.has_tms_permission('caja-liquidaciones')) THEN
  RETURN jsonb_build_object('success',false,'error','Sin permiso para liquidar el servicio de montacarga');
 END IF;
 IF p_started_at IS NULL OR p_ended_at IS NULL OR p_ended_at<=p_started_at OR p_ended_at-p_started_at>interval '168 hours' THEN
  RETURN jsonb_build_object('success',false,'error','Ingrese un inicio y fin válidos dentro de un máximo de 168 horas');
 END IF;
 SELECT * INTO f FROM public.route_forklifts WHERE dispatch_id=p_dispatch_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','La ruta no tiene servicio de montacarga'); END IF;
 IF f.hourly_rate IS NULL OR f.hourly_rate<=0 THEN RETURN jsonb_build_object('success',false,'error','El servicio no tiene una tarifa por hora válida'); END IF;
 IF NOT public.delivery_can_read(p_dispatch_id) THEN RETURN jsonb_build_object('success',false,'error','Ruta no disponible'); END IF;
 v_hours:=round(extract(epoch FROM (p_ended_at-p_started_at))/3600,2);
 v_amount:=round(v_hours*f.hourly_rate,2);
 UPDATE public.route_forklifts SET service_started_at=p_started_at,service_ended_at=p_ended_at,
   final_hours=v_hours,final_amount=v_amount,settled_at=now() WHERE dispatch_id=p_dispatch_id;
 RETURN jsonb_build_object('success',true,'started_at',p_started_at,'ended_at',p_ended_at,'hours',v_hours,'amount',v_amount);
END $$;
REVOKE ALL ON FUNCTION public.settle_route_forklift_times(uuid,timestamptz,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.settle_route_forklift_times(uuid,timestamptz,timestamptz) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
