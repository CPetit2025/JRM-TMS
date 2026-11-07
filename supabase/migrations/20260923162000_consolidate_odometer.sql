BEGIN;

-- Keep the legacy mileage mirror available for route closeout and older
-- reports while current_odometer remains the maintenance source of truth.
ALTER TABLE public.vehicles
  ADD COLUMN IF NOT EXISTS current_mileage numeric(12,2) NOT NULL DEFAULT 0;

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
