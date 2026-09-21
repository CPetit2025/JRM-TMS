BEGIN;

-- Supabase grants EXECUTE to anon through its default function privileges.
REVOKE ALL ON FUNCTION public.is_tms_admin() FROM anon;
REVOKE ALL ON FUNCTION public.has_tms_permission(text) FROM anon;
REVOKE ALL ON FUNCTION public.start_dispatch_route(uuid,numeric,numeric) FROM anon;
REVOKE ALL ON FUNCTION public.request_dispatch_return(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.schedule_dispatch(uuid,text,timestamptz,numeric,numeric,uuid,text,jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.close_dispatch_route(uuid) FROM anon;

COMMIT;
