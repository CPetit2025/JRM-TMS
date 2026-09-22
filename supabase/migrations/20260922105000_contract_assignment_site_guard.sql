CREATE OR REPLACE FUNCTION public.validate_contract_assignment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_role text;
DECLARE v_site uuid;
BEGIN
  SELECT c.site_id INTO v_site FROM public.contracts c WHERE c.id = NEW.contract_id
    AND c.parent_contract_id IS NULL AND c.type IN ('CONTRATO','OT_INDEPENDIENTE');
  IF v_site IS NULL THEN RAISE EXCEPTION 'Solo se asignan OT raíz'; END IF;
  IF NEW.active THEN
    SELECT r.name INTO v_role FROM public.profiles p JOIN public.roles r ON r.id=p.role_id
      WHERE p.id=NEW.user_id AND p.is_active;
    IF v_role IS NULL OR (NEW.role = 'ADMIN_CONTRATO' AND v_role <> 'Administrador de Contratos') THEN
      RAISE EXCEPTION 'El responsable debe tener un perfil activo y el rol apropiado';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.user_site_access usa
      WHERE usa.user_id=NEW.user_id AND usa.site_id=v_site) THEN
      RAISE EXCEPTION 'El responsable no tiene acceso a la sede de la OT';
    END IF;
  END IF;
  RETURN NEW;
END $$;
