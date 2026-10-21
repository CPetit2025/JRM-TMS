-- Aísla el maestro logístico del comercial y permite acceso explícito por rol.
-- Las reglas anteriores (Comercial/Despacho) continúan vigentes.
DROP POLICY IF EXISTS suppliers_logistics_read ON public.suppliers;
CREATE POLICY suppliers_logistics_read ON public.suppliers FOR SELECT TO authenticated
 USING (category IN ('TRANSPORTE','MONTACARGA','SERVICIOS')
   AND (public.has_tms_read_permission('proveedores-logisticos') OR public.has_tms_read_permission('tarifas')));
DROP POLICY IF EXISTS suppliers_logistics_insert ON public.suppliers;
CREATE POLICY suppliers_logistics_insert ON public.suppliers FOR INSERT TO authenticated
 WITH CHECK (category IN ('TRANSPORTE','MONTACARGA','SERVICIOS')
   AND (public.has_tms_permission('proveedores-logisticos') OR public.has_tms_permission('tarifas')));
DROP POLICY IF EXISTS suppliers_logistics_update ON public.suppliers;
CREATE POLICY suppliers_logistics_update ON public.suppliers FOR UPDATE TO authenticated
 USING (category IN ('TRANSPORTE','MONTACARGA','SERVICIOS')
   AND (public.has_tms_permission('proveedores-logisticos') OR public.has_tms_permission('tarifas')))
 WITH CHECK (category IN ('TRANSPORTE','MONTACARGA','SERVICIOS')
   AND (public.has_tms_permission('proveedores-logisticos') OR public.has_tms_permission('tarifas')));

DROP POLICY IF EXISTS supplier_locations_logistics_read ON public.supplier_locations;
CREATE POLICY supplier_locations_logistics_read ON public.supplier_locations FOR SELECT TO authenticated
 USING (EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id=supplier_id
   AND s.category IN ('TRANSPORTE','MONTACARGA','SERVICIOS')
   AND (public.has_tms_read_permission('proveedores-logisticos') OR public.has_tms_read_permission('tarifas'))));
DROP POLICY IF EXISTS supplier_locations_logistics_insert ON public.supplier_locations;
CREATE POLICY supplier_locations_logistics_insert ON public.supplier_locations FOR INSERT TO authenticated
 WITH CHECK (EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id=supplier_id
   AND s.category IN ('TRANSPORTE','MONTACARGA','SERVICIOS')
   AND (public.has_tms_permission('proveedores-logisticos') OR public.has_tms_permission('tarifas'))));
DROP POLICY IF EXISTS supplier_locations_logistics_update ON public.supplier_locations;
CREATE POLICY supplier_locations_logistics_update ON public.supplier_locations FOR UPDATE TO authenticated
 USING (EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id=supplier_id
   AND s.category IN ('TRANSPORTE','MONTACARGA','SERVICIOS')
   AND (public.has_tms_permission('proveedores-logisticos') OR public.has_tms_permission('tarifas'))))
 WITH CHECK (EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id=supplier_id
   AND s.category IN ('TRANSPORTE','MONTACARGA','SERVICIOS')
   AND (public.has_tms_permission('proveedores-logisticos') OR public.has_tms_permission('tarifas'))));

DROP POLICY IF EXISTS supplier_personnel_logistics_read ON public.supplier_personnel;
CREATE POLICY supplier_personnel_logistics_read ON public.supplier_personnel FOR SELECT TO authenticated
 USING (EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id=supplier_id
   AND s.category IN ('TRANSPORTE','MONTACARGA','SERVICIOS')
   AND (public.has_tms_read_permission('proveedores-logisticos') OR public.has_tms_read_permission('tarifas'))));
DROP POLICY IF EXISTS supplier_personnel_logistics_write ON public.supplier_personnel;
CREATE POLICY supplier_personnel_logistics_write ON public.supplier_personnel FOR ALL TO authenticated
 USING (EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id=supplier_id
   AND s.category IN ('TRANSPORTE','MONTACARGA','SERVICIOS')
   AND (public.has_tms_permission('proveedores-logisticos') OR public.has_tms_permission('tarifas'))))
 WITH CHECK (EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id=supplier_id
   AND s.category IN ('TRANSPORTE','MONTACARGA','SERVICIOS')
   AND (public.has_tms_permission('proveedores-logisticos') OR public.has_tms_permission('tarifas'))));

DROP POLICY IF EXISTS supplier_vehicles_logistics_read ON public.supplier_vehicles;
CREATE POLICY supplier_vehicles_logistics_read ON public.supplier_vehicles FOR SELECT TO authenticated
 USING (EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id=supplier_id
   AND s.category IN ('TRANSPORTE','MONTACARGA','SERVICIOS')
   AND (public.has_tms_read_permission('proveedores-logisticos') OR public.has_tms_read_permission('tarifas'))));
DROP POLICY IF EXISTS supplier_vehicles_logistics_write ON public.supplier_vehicles;
CREATE POLICY supplier_vehicles_logistics_write ON public.supplier_vehicles FOR ALL TO authenticated
 USING (EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id=supplier_id
   AND s.category IN ('TRANSPORTE','MONTACARGA','SERVICIOS')
   AND (public.has_tms_permission('proveedores-logisticos') OR public.has_tms_permission('tarifas'))))
 WITH CHECK (EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id=supplier_id
   AND s.category IN ('TRANSPORTE','MONTACARGA','SERVICIOS')
   AND (public.has_tms_permission('proveedores-logisticos') OR public.has_tms_permission('tarifas'))));
