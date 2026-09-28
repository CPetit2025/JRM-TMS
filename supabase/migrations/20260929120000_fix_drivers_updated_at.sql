-- sync_profile_to_driver (20260923150000) escribe drivers.updated_at, columna que no existe en producción:
-- todo UPDATE de profiles que toca nombre, documento, teléfono, licencia o is_active fallaba
-- ("column updated_at of relation drivers does not exist"), incluida la edición de usuarios
-- en /usuarios (api/users/update) y la asignación del rol Jefe de Distribución.
ALTER TABLE public.drivers ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
