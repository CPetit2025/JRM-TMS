-- ============================================================
-- Servicios de contrato visibles para Contratos
-- ============================================================
-- La política de 000163 solo deja leer contract_services a Despacho y Clientes (escritura). El rol
-- Administrador de Contratos (permiso contratos-servicios) registraba servicios por RPC pero no los veía en
-- "Servicios de Contrato". Se agrega lectura por sede para quien ve contratos; la política RESTRICTIVE
-- portfolio_service sigue limitando al Administrador de Contratos a sus OT asignadas.
BEGIN;

DROP POLICY IF EXISTS contract_service_read_site ON public.contract_services;
CREATE POLICY contract_service_read_site ON public.contract_services FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.contracts c WHERE c.id = contract_id AND public.can_access_site(c.site_id) AND (
    public.has_tms_read_permission('contratos-servicios') OR public.has_tms_read_permission('clientes') OR
    public.has_tms_read_permission('ot') OR public.has_tms_read_permission('despacho'))));

NOTIFY pgrst, 'reload schema';
COMMIT;
