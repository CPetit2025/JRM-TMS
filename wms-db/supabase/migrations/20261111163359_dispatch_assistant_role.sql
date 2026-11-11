-- Perfil operativo independiente de Auditor de Despacho.
-- almacen-lectura habilita Stock ERP e Inventario APT para consultar existencias.
INSERT INTO public.roles(name, description, permissions)
VALUES ('Asistente de Despacho',
  'Picking, preparación del Packing List, carga de despacho y consulta del stock disponible. La auditoría y liberación corresponden al Auditor de Despacho.',
  '["almacen-lectura","almacen-picking","almacen-packing","almacen-carga"]'::jsonb)
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description, permissions = EXCLUDED.permissions;
