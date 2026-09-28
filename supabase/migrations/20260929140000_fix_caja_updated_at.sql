-- Producción no tiene vehicles.updated_at: caja_fuel_odometer_log (C1) fallaba en toda carga de combustible con
-- odómetro (app del conductor y Caja web). caja_driver_overdue_trips (C2) se vuelve tolerante a dispatches.updated_at.
-- Detectado por las pruebas de caja del despliegue automático.
BEGIN;

CREATE OR REPLACE FUNCTION public.caja_fuel_odometer_log()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_current numeric;
BEGIN
  IF NEW.expense_type <> 'COMBUSTIBLE' OR NEW.fuel_odometer IS NULL OR NEW.vehicle_plate IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(current_odometer, 0) INTO v_current FROM public.vehicles WHERE plate = NEW.vehicle_plate FOR UPDATE;
  INSERT INTO public.vehicle_odometer_logs (vehicle_plate, driver_id, dispatch_id, odometer_value, photo_url, source_event, status, notes, created_by)
  VALUES (NEW.vehicle_plate, NEW.driver_id, NEW.dispatch_id, NEW.fuel_odometer, NEW.receipt_url, 'COMBUSTIBLE',
          CASE WHEN NEW.fuel_odometer < v_current THEN 'REQUIERE_AUDITORIA' ELSE 'VALIDADO' END,
          CASE WHEN NEW.fuel_odometer < v_current THEN 'Carga de combustible con odómetro menor al actual (' || v_current || ')' END,
          COALESCE(auth.uid(), NEW.created_by));
  IF NEW.fuel_odometer >= v_current THEN
    UPDATE public.vehicles SET current_odometer = NEW.fuel_odometer WHERE plate = NEW.vehicle_plate;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.caja_driver_overdue_trips(p_driver_id uuid)
RETURNS TABLE (dispatch_id uuid, dispatch_number text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.id, d.dispatch_number::text FROM public.dispatches d
  WHERE d.driver_id = p_driver_id
    AND NOT public.caja_trip_is_settled(d.id)
    AND EXISTS (SELECT 1 FROM public.trip_advances a WHERE a.dispatch_id = d.id AND a.status = 'ENTREGADO')
    AND d.status NOT IN ('PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO', 'CANCELADO')
    AND COALESCE(NULLIF(to_jsonb(d)->>'returned_at', ''), NULLIF(to_jsonb(d)->>'arrival_time', ''),
                 NULLIF(to_jsonb(d)->>'updated_at', ''), d.created_at::text)::timestamptz
        < now() - make_interval(hours => (SELECT settlement_due_hours FROM public.caja_settings WHERE id));
$$;

COMMIT;
