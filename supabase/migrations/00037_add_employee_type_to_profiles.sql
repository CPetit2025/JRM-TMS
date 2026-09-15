-- Add employee_type to profiles
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS employee_type VARCHAR(50);
