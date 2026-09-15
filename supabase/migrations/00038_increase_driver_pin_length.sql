-- Increase driver pin length to allow 6 digits
ALTER TABLE public.drivers
ALTER COLUMN pin TYPE VARCHAR(20);
