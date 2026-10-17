-- «Solicitante de Transporte» se creó con "dashboard" sin nivel: los permisos usan siempre el formato módulo:read/write
-- (prueba C79). El Inicio solo se consulta, así que queda en lectura; el resto no cambia.
UPDATE public.roles
SET permissions = '["dashboard:read", "solicitudes:write", "torre-control:read"]'::jsonb
WHERE lower(btrim(name)) = 'solicitante de transporte' AND permissions ? 'dashboard';
