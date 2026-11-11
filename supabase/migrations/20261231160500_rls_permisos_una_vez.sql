-- Lista de /solicitudes (transport_requests con proveedor, cliente, componentes y OT anidados): 2,4 s por llamada.
-- Las políticas RLS evaluaban is_tms_admin / has_tms_*permission / is_contract_administrator por cada fila de cada
-- tabla anidada. Envolverlas en (SELECT ...) las vuelve InitPlan: una evaluación por consulta. Misma condición.
-- can_access_site(site_id) y has_assigned_* dependen de la fila y se dejan igual.

ALTER POLICY tms_admin_full_access ON public.transport_requests USING ((SELECT public.is_tms_admin()));
ALTER POLICY tms_admin_full_access ON public.contracts USING ((SELECT public.is_tms_admin()));
ALTER POLICY tms_admin_full_access ON public.clients USING ((SELECT public.is_tms_admin()));

ALTER POLICY requests_read_site ON public.transport_requests USING (
  (public.can_access_site(site_id) AND ((SELECT public.has_tms_read_permission('solicitudes')) OR (SELECT public.has_tms_read_permission('despacho'))))
  OR EXISTS (SELECT 1 FROM public.dispatch_requests dr JOIN public.dispatches d ON d.id = dr.dispatch_id
     JOIN public.drivers driver ON driver.id = d.driver_id
     WHERE dr.transport_request_id = transport_requests.id AND driver.profile_id = (SELECT auth.uid())));
ALTER POLICY requests_write_site ON public.transport_requests USING (
  public.can_access_site(site_id) AND ((SELECT public.has_tms_permission('solicitudes')) OR (SELECT public.has_tms_permission('despacho'))));
ALTER POLICY portfolio_request ON public.transport_requests USING (
  (NOT (SELECT public.is_contract_administrator())) OR public.has_assigned_contract(contract_id) OR public.has_assigned_request(id, false));

ALTER POLICY contracts_read ON public.contracts USING (
  public.can_access_site(site_id) AND ((SELECT public.has_tms_read_permission('ot')) OR (SELECT public.has_tms_read_permission('clientes'))
    OR (SELECT public.has_tms_read_permission('contratos-servicios')) OR (SELECT public.has_tms_read_permission('solicitudes'))
    OR (SELECT public.has_tms_read_permission('despacho')) OR (SELECT public.has_tms_read_permission('dashboard'))
    OR (SELECT public.has_tms_read_permission('operaciones-kpis'))));
ALTER POLICY contracts_write ON public.contracts USING (
  public.can_access_site(site_id) AND ((SELECT public.has_tms_permission('ot')) OR (SELECT public.has_tms_permission('clientes'))));
ALTER POLICY portfolio_contract_read ON public.contracts USING ((NOT (SELECT public.is_contract_administrator())) OR public.has_assigned_contract(id));

ALTER POLICY clients_read_secure ON public.clients USING (
  (SELECT public.has_tms_permission('clientes')) OR (SELECT public.has_tms_permission('despacho')) OR (SELECT public.has_tms_permission('solicitudes')));
ALTER POLICY clients_write_secure ON public.clients USING ((SELECT public.has_tms_permission('clientes')));

ALTER POLICY suppliers_logistics_read ON public.suppliers USING (
  category = ANY (ARRAY['TRANSPORTE', 'MONTACARGA', 'SERVICIOS']) AND ((SELECT public.has_tms_read_permission('proveedores-logisticos'))
    OR (SELECT public.has_tms_read_permission('tarifas')) OR (SELECT public.has_tms_read_permission('despacho'))
    OR (SELECT public.has_tms_read_permission('documentario'))));

ALTER POLICY portfolio_component ON public.transport_request_components USING (
  (NOT (SELECT public.is_contract_administrator())) OR public.has_assigned_request(request_id));
ALTER POLICY request_components_read ON public.transport_request_components USING (
  EXISTS (SELECT 1 FROM public.transport_requests r WHERE r.id = transport_request_components.request_id
    AND public.can_access_site(r.site_id) AND ((SELECT public.has_tms_read_permission('solicitudes')) OR (SELECT public.has_tms_read_permission('despacho')))));
