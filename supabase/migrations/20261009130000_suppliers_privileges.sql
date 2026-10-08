-- C55 (incidente del despliegue de proveedores): los privilegios por defecto de Supabase dieron TRUNCATE,
-- TRIGGER, REFERENCES y DELETE a authenticated sobre las tablas nuevas. Solo se permiten lectura, alta y edición.
REVOKE TRUNCATE, TRIGGER, REFERENCES, DELETE ON public.suppliers, public.supplier_locations FROM anon, authenticated;
REVOKE ALL ON public.suppliers, public.supplier_locations FROM anon;
