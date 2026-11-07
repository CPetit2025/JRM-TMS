ALTER FUNCTION public.uuid_generate_v4() SET search_path = pg_catalog;
REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
INSERT INTO public.roles(name,permissions) VALUES ('Administrador','["almacen-lectura","almacen-etiquetado","almacen-picking","almacen-packing","almacen-carga","almacen-supervisor"]'::jsonb) ON CONFLICT(name) DO NOTHING;
INSERT INTO public.sites(code,name,is_active) VALUES ('PRINCIPAL','Sede principal',true) ON CONFLICT(code) DO NOTHING;
