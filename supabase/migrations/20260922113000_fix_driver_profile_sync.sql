BEGIN;

CREATE OR REPLACE FUNCTION public.sync_profile_to_driver()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.drivers d
  SET first_name = NEW.first_name,
      last_name = NEW.last_name,
      document_number = NEW.document_number,
      phone = NEW.phone,
      is_active = NEW.is_active
  WHERE d.profile_id = NEW.id
    AND (d.first_name, d.last_name, d.document_number, d.phone, d.is_active)
      IS DISTINCT FROM
        (NEW.first_name, NEW.last_name, NEW.document_number, NEW.phone, NEW.is_active);

  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
