BEGIN;

UPDATE public.vehicles SET status = 'MANTENIMIENTO' WHERE status = 'EN_MANTENIMIENTO';
UPDATE public.vehicles SET status = 'FUERA_DE_SERVICIO' WHERE status = 'INACTIVA';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'vehicles_status_check'
    ) THEN
        ALTER TABLE public.vehicles
        ADD CONSTRAINT vehicles_status_check
        CHECK (status IN ('DISPONIBLE', 'ASIGNADA', 'EN_RUTA', 'OBSERVADA', 'MANTENIMIENTO', 'BLOQUEADA', 'FUERA_DE_SERVICIO'));
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.trigger_update_vehicle_status()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'EN_MANTENIMIENTO' THEN
        UPDATE public.vehicles SET status = 'MANTENIMIENTO' WHERE plate = NEW.vehicle_plate;
    ELSE
        UPDATE public.vehicles SET status = NEW.status WHERE plate = NEW.vehicle_plate;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
