-- Corrige C55 ("search_path privilegiado inseguro"): las funciones SECURITY DEFINER del número de despacho
-- (20261009070000) deben fijar search_path = public, pg_temp como el resto de funciones privilegiadas.
ALTER FUNCTION public.dispatch_assign_number() SET search_path = public, pg_temp;
ALTER FUNCTION public.dispatch_number_in_text(text, uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.contract_service_dispatch_number() SET search_path = public, pg_temp;

-- Las funciones de disparador no se llaman como RPC
REVOKE ALL ON FUNCTION public.dispatch_assign_number() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.contract_service_dispatch_number() FROM PUBLIC, anon, authenticated;
