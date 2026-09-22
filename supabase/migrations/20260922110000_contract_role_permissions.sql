BEGIN;

-- The application and RLS use these names as security identities. Consolidate
-- the old singular seed before creating the canonical contract role.
DO $$
DECLARE
  v_legacy_id uuid;
  v_role_id uuid;
BEGIN
  SELECT id INTO v_legacy_id FROM public.roles
    WHERE name = 'Administrador de Contrato';
  SELECT id INTO v_role_id FROM public.roles
    WHERE name = 'Administrador de Contratos';

  IF v_legacy_id IS NOT NULL AND v_role_id IS NULL THEN
    UPDATE public.roles
      SET name = 'Administrador de Contratos'
      WHERE id = v_legacy_id;
  ELSIF v_legacy_id IS NOT NULL AND v_role_id IS NOT NULL THEN
    UPDATE public.profiles SET role_id = v_role_id WHERE role_id = v_legacy_id;
    DELETE FROM public.roles WHERE id = v_legacy_id;
  END IF;
END $$;

-- This is the only application role required for the assigned OT portfolio.
-- BACKUP, SUPERVISOR and CONSULTOR remain assignment roles per OT and must not
-- become global application roles with accidental access to every project.
INSERT INTO public.roles (id, name, description, permissions)
VALUES (
  gen_random_uuid(),
  'Administrador de Contratos',
  'Gestiona únicamente su cartera de OT y solicitudes; consulta clientes y Torre de Control.',
  '["dashboard", "clientes:read", "ot:write", "solicitudes:write", "torre-control:read"]'::jsonb
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  permissions = EXCLUDED.permissions;

-- Prevent case variants of security-sensitive role names.
CREATE UNIQUE INDEX IF NOT EXISTS roles_name_case_insensitive
  ON public.roles (lower(btrim(name)));

CREATE OR REPLACE FUNCTION public.guard_core_roles()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_contract_permissions constant jsonb :=
    '["dashboard", "clientes:read", "ot:write", "solicitudes:write", "torre-control:read"]'::jsonb;
BEGIN
  IF TG_OP = 'DELETE' AND OLD.name IN ('Administrador', 'Administrador de Contratos') THEN
    RAISE EXCEPTION 'El rol % es un rol protegido del sistema', OLD.name;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.name IN ('Administrador', 'Administrador de Contratos')
       AND NEW.name IS DISTINCT FROM OLD.name THEN
      RAISE EXCEPTION 'No se puede renombrar el rol protegido %', OLD.name;
    END IF;

    IF OLD.name = 'Administrador de Contratos'
       AND NEW.permissions IS DISTINCT FROM v_contract_permissions THEN
      RAISE EXCEPTION 'Los permisos del Administrador de Contratos se administran mediante una migración de seguridad';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS guard_core_roles ON public.roles;
CREATE TRIGGER guard_core_roles
  BEFORE UPDATE OR DELETE ON public.roles
  FOR EACH ROW EXECUTE FUNCTION public.guard_core_roles();

REVOKE ALL ON FUNCTION public.guard_core_roles() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
