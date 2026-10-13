BEGIN;
-- This RPC synchronizes the driver's pre-use unit through the existing VOLATILE
-- fleet gateway. PostgREST runs STABLE RPCs in READ ONLY transactions, where even
-- a zero-row DELETE fails and hides the correctly assigned trip from the app.
ALTER FUNCTION public.get_active_trip_context() VOLATILE;
NOTIFY pgrst,'reload schema';
COMMIT;
