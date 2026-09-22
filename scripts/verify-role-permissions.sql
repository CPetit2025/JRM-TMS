-- Transactional acceptance check for the contract application role.
-- Run with: npx supabase db query --linked --file scripts/verify-role-permissions.sql
BEGIN;

DO $$
DECLARE
  v_role_id uuid;
  v_user_id uuid;
  v_original_role_id uuid;
  v_denied boolean;
  v_expected constant jsonb :=
    '["dashboard", "clientes:read", "ot:write", "contratos-servicios:write", "solicitudes:write", "torre-control:read"]'::jsonb;
BEGIN
  SELECT id INTO v_role_id FROM public.roles
    WHERE name = 'Administrador de Contratos' AND permissions = v_expected;
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'El rol Administrador de Contratos no tiene la matriz esperada';
  END IF;

  SELECT id, role_id INTO v_user_id, v_original_role_id
    FROM public.profiles
    WHERE is_active AND coalesce(employee_type, '') <> 'CONDUCTOR'
    ORDER BY id LIMIT 1;
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Se requiere un usuario activo para validar permisos'; END IF;

  UPDATE public.profiles SET role_id = v_role_id WHERE id = v_user_id;
  PERFORM set_config('request.jwt.claim.sub', v_user_id::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  IF NOT public.is_contract_administrator() THEN RAISE EXCEPTION 'Identidad de rol no reconocida'; END IF;
  IF NOT public.has_tms_read_permission('clientes') OR public.has_tms_permission('clientes') THEN
    RAISE EXCEPTION 'Clientes debe ser lectura global sin escritura';
  END IF;
  IF NOT public.has_tms_permission('ot') OR NOT public.has_tms_permission('contratos-servicios')
     OR NOT public.has_tms_permission('solicitudes') THEN
    RAISE EXCEPTION 'La cartera, sus servicios y las solicitudes requieren escritura';
  END IF;
  IF NOT public.has_tms_read_permission('torre-control') OR public.has_tms_permission('torre-control') THEN
    RAISE EXCEPTION 'Torre de Control debe ser solo lectura';
  END IF;

  EXECUTE 'RESET ROLE';

  v_denied := false;
  BEGIN
    UPDATE public.roles SET name = 'Rol inseguro' WHERE id = v_role_id;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'No se puede renombrar el rol protegido%' THEN v_denied := true;
    ELSE RAISE; END IF;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'El rol protegido pudo renombrarse'; END IF;

  v_denied := false;
  BEGIN
    UPDATE public.roles SET permissions = permissions || '["clientes:write"]'::jsonb
      WHERE id = v_role_id;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'Los permisos del Administrador de Contratos%' THEN v_denied := true;
    ELSE RAISE; END IF;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'El rol protegido aceptó permisos inseguros'; END IF;

  v_denied := false;
  BEGIN
    DELETE FROM public.roles WHERE id = v_role_id;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'El rol Administrador de Contratos es un rol protegido%' THEN v_denied := true;
    ELSE RAISE; END IF;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'El rol protegido pudo eliminarse'; END IF;

  UPDATE public.profiles SET role_id = v_original_role_id WHERE id = v_user_id;
END $$;

ROLLBACK;
