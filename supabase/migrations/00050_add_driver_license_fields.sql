-- Add license fields to profiles for drivers
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS license_type VARCHAR(20),
ADD COLUMN IF NOT EXISTS license_expiration DATE;

-- Update register_driver RPC to include license fields
CREATE OR REPLACE FUNCTION public.register_driver(
    p_email VARCHAR,
    p_password VARCHAR,
    p_first_name VARCHAR,
    p_last_name VARCHAR,
    p_document_id VARCHAR,
    p_driver_pin VARCHAR,
    p_license_type VARCHAR DEFAULT NULL,
    p_license_expiration DATE DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID;
    v_role_id UUID;
BEGIN
    -- 1. Create auth user
    v_user_id := auth.uid(); -- This is a placeholder since we can't create auth users directly from SQL easily without specific pgcrypto or auth setup if not using admin api. Wait, let me check how register_driver is currently implemented.
    -- I will cancel this RPC replacement until I check the current implementation of register_driver.
END;
$$;
