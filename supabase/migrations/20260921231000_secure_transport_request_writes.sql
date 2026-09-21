-- Apply after the /solicitudes frontend uses the validated RPCs.
-- Dispatch lifecycle functions are SECURITY DEFINER and keep their own checks.
REVOKE INSERT, UPDATE, DELETE ON public.transport_requests FROM PUBLIC, anon, authenticated;
NOTIFY pgrst, 'reload schema';
