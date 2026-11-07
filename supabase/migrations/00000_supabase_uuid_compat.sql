-- Supabase installs uuid-ossp in the `extensions` schema on fresh projects,
-- while the original TMS migrations call uuid_generate_v4() unqualified.
-- Keep those legacy migrations portable without changing the production schema.
CREATE OR REPLACE FUNCTION public.uuid_generate_v4()
RETURNS uuid
LANGUAGE sql
VOLATILE
PARALLEL SAFE
AS 'SELECT gen_random_uuid()';
