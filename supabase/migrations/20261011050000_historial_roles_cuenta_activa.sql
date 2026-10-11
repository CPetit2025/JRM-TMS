-- Corrige 20261011030000: toda tabla pública lleva la barrera restrictiva de cuenta activa (C55). Un usuario
-- desactivado no lee el historial de roles aunque conserve el permiso «permisos».
BEGIN;
DROP POLICY IF EXISTS security_active_account ON public.role_permission_changes;
CREATE POLICY security_active_account ON public.role_permission_changes AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
COMMIT;
