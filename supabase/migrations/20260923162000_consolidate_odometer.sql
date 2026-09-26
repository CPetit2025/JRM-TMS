BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'vehicles'
          AND column_name = 'odometer'
    ) THEN
        ALTER TABLE public.vehicles RENAME COLUMN odometer TO odometer_legacy;
    END IF;
END $$;

COMMENT ON COLUMN public.vehicles.current_mileage IS 'Acumulado GPS - solo referencia, NO usar para mantenimiento';
COMMENT ON COLUMN public.vehicles.current_odometer IS 'FUENTE DE VERDAD - Odómetro físico capturado por conductor en checklist';

COMMIT;
