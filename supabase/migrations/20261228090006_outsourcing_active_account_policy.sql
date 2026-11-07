BEGIN;
-- Estándar C55: cuenta activa por sentencia (initplan) y privilegios mínimos explícitos.
ALTER TABLE public.transport_outsourcing_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY active_account ON public.transport_outsourcing_assignments;
CREATE POLICY security_active_account ON public.transport_outsourcing_assignments
 AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user()))
 WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.transport_outsourcing_assignments FROM anon,authenticated;
GRANT SELECT ON public.transport_outsourcing_assignments TO authenticated;

ALTER TABLE public.outsourcing_booking_context ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_active_account ON public.outsourcing_booking_context
 AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user()))
 WITH CHECK ((SELECT public.is_active_tms_user()));
-- No hay política permisiva ni privilegios de cliente sobre el contexto privado.
REVOKE ALL ON public.outsourcing_booking_context FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
