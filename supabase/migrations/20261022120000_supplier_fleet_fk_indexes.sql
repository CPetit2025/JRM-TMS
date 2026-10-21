-- Cubre las claves foráneas añadidas por el maestro de proveedores.
-- Los índices parciales de unicidad no cuentan como cobertura para la auditoría
-- global de FKs, por eso supplier_id en carriers requiere un índice completo.
CREATE INDEX IF NOT EXISTS carriers_supplier_fk_idx
 ON public.carriers(supplier_id);

CREATE INDEX IF NOT EXISTS supplier_vehicles_personnel_fk_idx
 ON public.supplier_vehicles(personnel_id);

CREATE INDEX IF NOT EXISTS route_forklifts_supplier_personnel_fk_idx
 ON public.route_forklifts(supplier_personnel_id);
