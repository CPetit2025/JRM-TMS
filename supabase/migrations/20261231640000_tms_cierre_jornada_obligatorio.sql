-- Cierre de jornada obligatorio: el conductor no puede registrar el odómetro de inicio (checklist del día) si su
-- jornada anterior quedó sin odómetro de cierre. Puede cerrarla al día siguiente con la lectura actual del tablero o,
-- si no tiene acceso a la unidad, declarar el motivo (queda registrado para revisión).
-- Solo cuentan las jornadas desde la puesta en marcha (23-11-2026) y de los últimos 7 días.
BEGIN;
SET LOCAL lock_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.unit_odometer_close_waivers (
  driver_id      uuid NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  vehicle_plate  text NOT NULL,
  operation_date date NOT NULL,
  reason         text NOT NULL CHECK (length(btrim(reason)) >= 10),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (driver_id, vehicle_plate, operation_date)
);
ALTER TABLE public.unit_odometer_close_waivers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.unit_odometer_close_waivers;
CREATE POLICY security_active_account ON public.unit_odometer_close_waivers AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.unit_odometer_close_waivers FROM PUBLIC, anon, authenticated;

-- Desde cuándo se exige (las pruebas lo adelantan dentro de su transacción)
CREATE OR REPLACE FUNCTION public.unit_odometer_close_required_since() RETURNS date LANGUAGE sql IMMUTABLE AS $f$SELECT DATE '2026-11-23'$f$;
GRANT EXECUTE ON FUNCTION public.unit_odometer_close_required_since() TO authenticated;

-- Última jornada del conductor antes de p_before con inicio y sin cierre ni motivo declarado
CREATE OR REPLACE FUNCTION public.driver_pending_workday_close(p_driver uuid, p_before date)
RETURNS TABLE(operation_date date, vehicle_plate text, start_odometer numeric, unit_revision uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.operation_date, i.vehicle_plate, i.odometer, i.unit_revision
  FROM (SELECT o.* FROM public.unit_odometer_readings o
        WHERE o.driver_id = p_driver AND o.kind = 'INICIO' AND o.operation_date < p_before
          AND o.operation_date >= GREATEST(public.unit_odometer_close_required_since(), p_before - 7)
        ORDER BY o.operation_date DESC, o.captured_at DESC LIMIT 1) i
  WHERE NOT EXISTS (SELECT 1 FROM public.unit_odometer_readings c WHERE c.driver_id = p_driver AND c.vehicle_plate = i.vehicle_plate
                      AND c.operation_date = i.operation_date AND c.kind = 'CIERRE')
    AND NOT EXISTS (SELECT 1 FROM public.unit_odometer_close_waivers w WHERE w.driver_id = p_driver AND w.vehicle_plate = i.vehicle_plate
                      AND w.operation_date = i.operation_date);
$$;
REVOKE ALL ON FUNCTION public.driver_pending_workday_close(uuid, date) FROM PUBLIC, anon, authenticated;

-- El odómetro de inicio (checklist) exige la jornada anterior cerrada
CREATE OR REPLACE FUNCTION public.unit_odometer_require_previous_close() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p record;
BEGIN
  IF NEW.kind <> 'INICIO' OR NEW.driver_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO p FROM public.driver_pending_workday_close(NEW.driver_id, NEW.operation_date);
  IF p.operation_date IS NOT NULL THEN
    RAISE EXCEPTION 'Primero cierre la jornada del % (unidad %): en el app, Inicio → Cerrar jornada', to_char(p.operation_date, 'DD/MM'), p.vehicle_plate;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS unit_odometer_require_previous_close ON public.unit_odometer_readings;
CREATE TRIGGER unit_odometer_require_previous_close BEFORE INSERT ON public.unit_odometer_readings
  FOR EACH ROW EXECUTE FUNCTION public.unit_odometer_require_previous_close();

-- Jornada pendiente del conductor de la sesión (para el aviso del app)
CREATE OR REPLACE FUNCTION public.get_driver_pending_close() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE dr public.drivers; p record;
BEGIN
  dr := public.unit_odometer_session_driver();
  IF dr.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Sin conductor activo'); END IF;
  SELECT * INTO p FROM public.driver_pending_workday_close(dr.id, (now() AT TIME ZONE 'America/Lima')::date);
  RETURN jsonb_build_object('success', true, 'pending', CASE WHEN p.operation_date IS NOT NULL THEN
    jsonb_build_object('operation_date', p.operation_date, 'unit', p.vehicle_plate, 'start_odometer', p.start_odometer) END);
END $$;
REVOKE ALL ON FUNCTION public.get_driver_pending_close() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_driver_pending_close() TO authenticated;

-- Cierra la jornada pendiente: con el odómetro actual del tablero o, sin acceso a la unidad, con el motivo
CREATE OR REPLACE FUNCTION public.close_driver_pending_workday(p_operation uuid, p_odometer text, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE dr public.drivers; p record; rec public.unit_odometer_readings;
BEGIN
  dr := public.unit_odometer_session_driver();
  IF dr.id IS NULL OR p_operation IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Sin conductor activo'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('driver-preuse:' || dr.id::text, 0));
  IF EXISTS (SELECT 1 FROM public.unit_odometer_readings WHERE operation_id = p_operation) THEN
    RETURN jsonb_build_object('success', true, 'duplicate', true); END IF;
  SELECT * INTO p FROM public.driver_pending_workday_close(dr.id, (now() AT TIME ZONE 'America/Lima')::date);
  IF p.operation_date IS NULL THEN RETURN jsonb_build_object('success', true, 'pending', false); END IF;
  IF NULLIF(btrim(COALESCE(p_odometer, '')), '') IS NOT NULL THEN
    rec := public.unit_odometer_record(p_operation, p.vehicle_plate, dr.id, p.operation_date, 'CIERRE', p_odometer, NULL, now(), auth.uid(), p.unit_revision);
    RETURN jsonb_build_object('success', true, 'plate', p.vehicle_plate, 'operation_date', p.operation_date, 'odometer', rec.odometer, 'flag', rec.flag,
      'km', CASE WHEN rec.odometer >= p.start_odometer THEN rec.odometer - p.start_odometer END);
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'Ingrese el odómetro o explique por qué no puede leerlo (mínimo 10 caracteres)'; END IF;
  INSERT INTO public.unit_odometer_close_waivers(driver_id, vehicle_plate, operation_date, reason, created_by)
  VALUES (dr.id, p.vehicle_plate, p.operation_date, btrim(p_reason), auth.uid()) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('success', true, 'plate', p.vehicle_plate, 'operation_date', p.operation_date, 'waived', true);
EXCEPTION WHEN raise_exception THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.close_driver_pending_workday(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_driver_pending_workday(uuid, text, text) TO authenticated;

COMMIT;
