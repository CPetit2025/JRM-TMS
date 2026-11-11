-- Por defecto todo usuario del WMS trabaja en la sede PRINCIPAL. Sin esta asignación, can_access_site() devolvía falso
-- y la validación de recepción fallaba con «Cantidad física o ingreso IPT inválido» (usuario nuevo de almacén, 11/11).
-- Misma regla que el TMS (profiles_assign_primary_site): al activarse un perfil (no conductor) se le asigna PRINCIPAL
-- si aún no tiene sede. Se completa a los usuarios activos existentes.
CREATE OR REPLACE FUNCTION public.assign_primary_site_to_staff()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.is_active = true AND coalesce(to_jsonb(NEW) ->> 'employee_type', '') <> 'CONDUCTOR' AND
     EXISTS (SELECT 1 FROM auth.users WHERE id = NEW.id) AND
     NOT EXISTS (SELECT 1 FROM public.user_site_access WHERE user_id = NEW.id) THEN
    INSERT INTO public.user_site_access(user_id, site_id)
    SELECT NEW.id, id FROM public.sites WHERE code = 'PRINCIPAL'
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.assign_primary_site_to_staff() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_assign_primary_site ON public.profiles;
CREATE TRIGGER profiles_assign_primary_site AFTER INSERT OR UPDATE OF is_active ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.assign_primary_site_to_staff();

INSERT INTO public.user_site_access(user_id, site_id)
SELECT p.id, s.id FROM public.profiles p JOIN auth.users u ON u.id = p.id CROSS JOIN public.sites s
WHERE s.code = 'PRINCIPAL' AND p.is_active AND coalesce(to_jsonb(p) ->> 'employee_type', '') <> 'CONDUCTOR'
  AND NOT EXISTS (SELECT 1 FROM public.user_site_access a WHERE a.user_id = p.id)
ON CONFLICT DO NOTHING;
