-- Orden de roles y permisos
-- 1. Historial: cada alta, cambio o baja de un rol queda registrado (quién, cuándo, permisos antes y después).
-- 2. Roles base protegidos: el sistema tiene reglas que dependen de su nombre; no se renombran ni se eliminan.
-- 3. Formato único: un módulo con niveles sin sufijo («despacho») ya valía como escritura en la web y en la base;
--    pasa a «despacho:write». No cambia el acceso de nadie. Los interruptores («caja-aprobacion», «ia:read:caja») no
--    cambian. Si un rol tenía a la vez lectura y escritura del mismo módulo, queda la escritura (la que ya regía).
BEGIN;

-- 1. Historial de cambios de roles
CREATE TABLE IF NOT EXISTS public.role_permission_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role_id uuid,
  role_name text,
  action text NOT NULL CHECK (action IN ('ALTA', 'CAMBIO', 'BAJA')),
  old_name text,
  old_permissions jsonb,
  new_permissions jsonb,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS role_permission_changes_role_idx ON public.role_permission_changes (role_id, changed_at DESC);
ALTER TABLE public.role_permission_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.role_permission_changes FROM PUBLIC, anon;
GRANT SELECT ON public.role_permission_changes TO authenticated;
DROP POLICY IF EXISTS role_permission_changes_read ON public.role_permission_changes;
CREATE POLICY role_permission_changes_read ON public.role_permission_changes FOR SELECT TO authenticated
  USING (public.is_tms_admin() OR public.has_tms_read_permission('permisos'));

CREATE OR REPLACE FUNCTION public.log_role_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.role_permission_changes(role_id, role_name, action, new_permissions, changed_by)
    VALUES (NEW.id, NEW.name, 'ALTA', NEW.permissions, auth.uid());
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.permissions IS DISTINCT FROM OLD.permissions OR NEW.name IS DISTINCT FROM OLD.name THEN
      INSERT INTO public.role_permission_changes(role_id, role_name, action, old_name, old_permissions, new_permissions, changed_by)
      VALUES (NEW.id, NEW.name, 'CAMBIO', CASE WHEN NEW.name IS DISTINCT FROM OLD.name THEN OLD.name END,
              OLD.permissions, NEW.permissions, auth.uid());
    END IF;
  ELSE
    INSERT INTO public.role_permission_changes(role_id, role_name, action, old_permissions, changed_by)
    VALUES (OLD.id, OLD.name, 'BAJA', OLD.permissions, auth.uid());
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.log_role_change() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS roles_log_change ON public.roles;
CREATE TRIGGER roles_log_change AFTER INSERT OR UPDATE OR DELETE ON public.roles
  FOR EACH ROW EXECUTE FUNCTION public.log_role_change();

-- 2. Roles base protegidos
CREATE OR REPLACE FUNCTION public.is_base_role(p_name text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(btrim(COALESCE(p_name, ''))) = ANY (ARRAY['administrador', 'administrador de contratos', 'supervisor de despacho',
    'jefe de distribución', 'asistente documentario', 'auditor de despacho', 'supervisor de transporte', 'soporte mecánico', 'conductor'])
$$;

CREATE OR REPLACE FUNCTION public.protect_base_roles() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF public.is_base_role(OLD.name) AND (TG_OP = 'DELETE' OR NEW.name IS DISTINCT FROM OLD.name) THEN
    RAISE EXCEPTION 'El rol «%» es un rol base del sistema: se pueden cambiar sus permisos, pero no renombrarlo ni eliminarlo', OLD.name
      USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION public.protect_base_roles() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS roles_protect_base ON public.roles;
CREATE TRIGGER roles_protect_base BEFORE UPDATE OF name OR DELETE ON public.roles
  FOR EACH ROW EXECUTE FUNCTION public.protect_base_roles();

-- 3. Formato único «módulo:read» / «módulo:write» (módulos con niveles del catálogo)
CREATE OR REPLACE FUNCTION public.normalize_role_permissions(p jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  WITH levels(id) AS (SELECT unnest(ARRAY[
    'dashboard', 'reportes', 'clientes', 'proveedores', 'ot', 'solicitudes', 'contratos-servicios', 'torre-control', 'despacho',
    'despacho-aprobacion', 'documentario', 'monitoreo', 'planificacion', 'packing-list', 'apt', 'flota-eficiencia',
    'mantenimiento-dashboard', 'mantenimiento-flota', 'mantenimiento-vencimientos', 'mantenimiento-fallas', 'mantenimiento-soporte',
    'mantenimiento-ot', 'mantenimiento-planes', 'mantenimiento-finanzas', 'caja', 'caja-gastos', 'caja-anticipos',
    'caja-liquidaciones', 'caja-fondos', 'caja-combustible', 'caja-tarifario', 'maestros-trabajadores', 'tarifas', 'usuarios',
    'permisos', 'configuracion', 'flota', 'operaciones-live', 'operaciones-revision', 'operaciones-kpis'])),
  items AS (
    SELECT CASE WHEN v IN (SELECT id FROM levels) THEN v || ':write' ELSE v END AS v
      FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p) = 'array' THEN p ELSE '[]'::jsonb END) v)
  SELECT COALESCE(jsonb_agg(DISTINCT i.v ORDER BY i.v), '[]'::jsonb)
    FROM items i
   WHERE NOT (i.v LIKE '%:read' AND left(i.v, -5) IN (SELECT id FROM levels)
              AND EXISTS (SELECT 1 FROM items w WHERE w.v = left(i.v, -5) || ':write'))
$$;

UPDATE public.roles SET permissions = public.normalize_role_permissions(permissions)
 WHERE jsonb_typeof(permissions) = 'array'
   AND NOT (permissions @> public.normalize_role_permissions(permissions)
            AND public.normalize_role_permissions(permissions) @> permissions);

NOTIFY pgrst, 'reload schema';
COMMIT;
