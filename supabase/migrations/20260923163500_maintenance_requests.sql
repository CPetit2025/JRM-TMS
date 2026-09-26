BEGIN;

CREATE TABLE IF NOT EXISTS public.maintenance_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vehicle_plate TEXT NOT NULL REFERENCES public.vehicles(plate),
    driver_id UUID REFERENCES public.drivers(id),
    dispatch_id UUID REFERENCES public.dispatches(id),
    reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    description TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'MEDIA',
    status TEXT NOT NULL DEFAULT 'PENDIENTE',
    photo_url TEXT,
    audio_url TEXT,
    location_lat NUMERIC(10,6),
    location_lon NUMERIC(10,6),
    odometer_at_report NUMERIC(10,2),
    work_order_id UUID REFERENCES public.maintenance_work_orders(id),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.maintenance_requests ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'Conductores ven sus propias solicitudes' AND tablename = 'maintenance_requests'
    ) THEN
        CREATE POLICY "Conductores ven sus propias solicitudes" 
        ON public.maintenance_requests FOR SELECT 
        TO authenticated 
        USING (driver_id IN (SELECT id FROM public.drivers WHERE user_id = auth.uid()));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'Mantenimiento ve todas' AND tablename = 'maintenance_requests'
    ) THEN
        CREATE POLICY "Mantenimiento ve todas" 
        ON public.maintenance_requests FOR SELECT 
        TO authenticated 
        USING (has_tms_permission('mantenimiento'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'Despacho ve criticas' AND tablename = 'maintenance_requests'
    ) THEN
        CREATE POLICY "Despacho ve criticas" 
        ON public.maintenance_requests FOR SELECT 
        TO authenticated 
        USING (has_tms_permission('despacho') AND severity = 'CRITICA');
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.trigger_maintenance_request_severity()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.severity = 'CRITICA' THEN
        PERFORM public.transition_vehicle_status(NEW.vehicle_plate, 'BLOQUEADA', 'Solicitud de mantenimiento CRITICA: ' || NEW.description);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_maintenance_request_severity'
    ) THEN
        CREATE TRIGGER trg_maintenance_request_severity
        AFTER INSERT ON public.maintenance_requests
        FOR EACH ROW
        EXECUTE FUNCTION public.trigger_maintenance_request_severity();
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_maintenance_requests_plate ON public.maintenance_requests(vehicle_plate, status);
CREATE INDEX IF NOT EXISTS idx_maintenance_requests_dispatch ON public.maintenance_requests(dispatch_id);

COMMIT;
