DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.suppliers'::regclass AND polname='suppliers_logistics_read')
   OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.suppliers'::regclass AND polname='suppliers_logistics_insert')
   OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.supplier_personnel'::regclass AND polname='supplier_personnel_logistics_write')
   OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.supplier_vehicles'::regclass AND polname='supplier_vehicles_logistics_write') THEN
  RAISE EXCEPTION 'CAJA C134 FAIL: permisos del maestro logístico incompletos';
 END IF;
 IF to_regclass('public.supplier_locations') IS NULL OR to_regclass('public.supplier_personnel') IS NULL
   OR to_regclass('public.supplier_vehicles') IS NULL THEN
  RAISE EXCEPTION 'CAJA C134 FAIL: tablas del proveedor logístico incompletas';
 END IF;
 RAISE EXCEPTION 'CAJA C134 PASS: directorio logístico separado y RLS para empresa, personal, placas y puntos';
END $$;
