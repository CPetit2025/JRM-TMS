-- 00004_seed_admin_role.sql

-- Add permissions column if it doesn't exist to allow granular access control later
ALTER TABLE roles 
ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '[]'::jsonb;

-- Insert or update the "Administrador de Contrato" role
INSERT INTO roles (id, name, description, permissions)
VALUES (
    uuid_generate_v4(),
    'Administrador de Contrato',
    'Rol responsable de registrar clientes, generar OTs y administrar presupuestos',
    '["clientes.crear", "ot.crear", "ot.ver"]'::jsonb
)
ON CONFLICT (name) DO UPDATE 
SET permissions = '["clientes.crear", "ot.crear", "ot.ver"]'::jsonb;
