BEGIN;

CREATE OR REPLACE FUNCTION public.guard_core_roles()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_contract_permissions constant jsonb :=
    '["dashboard", "clientes:read", "ot:write", "contratos-servicios:write", "solicitudes:write", "torre-control:read"]'::jsonb;
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

UPDATE public.roles SET
  description = 'Gestiona únicamente su cartera de OT, servicios y solicitudes; consulta clientes y Torre de Control.',
  permissions = '["dashboard", "clientes:read", "ot:write", "contratos-servicios:write", "solicitudes:write", "torre-control:read"]'::jsonb
WHERE name = 'Administrador de Contratos';

NOTIFY pgrst, 'reload schema';

COMMIT;
