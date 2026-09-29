-- ============================================================
-- BLOQUE 1 — Trazabilidad de novedades y RUC de clientes
-- ============================================================
--  * Novedades del despacho (dispatch_events): se registra quién las creó (usuario de la sesión), ya no el texto
--    fijo "Operador GPS". El nombre visible se guarda en created_by y el usuario en created_by_user.
--  * Clientes: el RUC nuevo o modificado debe ser válido (dígito verificador SUNAT) y no puede repetirse en otro
--    cliente. Se guarda cuándo se verificó en SUNAT y su estado/condición. Los datos ya existentes no se tocan.
-- Las columnas de clients se leen con to_jsonb (el esquema de producción difiere del repo: usa tax_id).
BEGIN;

-- ------------------------------------------------------------
-- 1. Autor real de las novedades
-- ------------------------------------------------------------
ALTER TABLE public.dispatch_events ADD COLUMN IF NOT EXISTS created_by_user uuid;

CREATE OR REPLACE FUNCTION public.profile_display_name(p_user uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(NULLIF(trim(concat_ws(' ', to_jsonb(p)->>'first_name', to_jsonb(p)->>'last_name')), ''),
                  to_jsonb(p)->>'email', p_user::text)
  FROM public.profiles p WHERE p.id = p_user;
$$;

CREATE OR REPLACE FUNCTION public.dispatch_event_author()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- Con sesión, el autor es siempre el usuario (no se puede escribir otro nombre desde la web)
  IF auth.uid() IS NOT NULL THEN
    NEW.created_by_user := auth.uid();
    NEW.created_by := COALESCE(public.profile_display_name(auth.uid()), auth.uid()::text);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS dispatch_event_author ON public.dispatch_events;
CREATE TRIGGER dispatch_event_author BEFORE INSERT ON public.dispatch_events
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_event_author();

-- Históricos que guardaron el id del usuario como texto: se muestra el nombre
UPDATE public.dispatch_events e SET created_by_user = p.id,
  created_by = COALESCE(public.profile_display_name(p.id), e.created_by)
FROM public.profiles p
WHERE p.id::text = lower(e.created_by) AND e.created_by_user IS NULL;

-- ------------------------------------------------------------
-- 2. RUC de clientes: válido y sin duplicados
-- ------------------------------------------------------------
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS sunat_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS sunat_status      text;

CREATE OR REPLACE FUNCTION public.client_tax_id_norm(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(regexp_replace(COALESCE(p_value, ''), '[^0-9]', '', 'g'), '');
$$;

CREATE OR REPLACE FUNCTION public.clients_tax_id_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_new  text := public.client_tax_id_norm(COALESCE(to_jsonb(NEW)->>'tax_id', to_jsonb(NEW)->>'ruc'));
  v_old  text;
  v_dup  text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_old := public.client_tax_id_norm(COALESCE(to_jsonb(OLD)->>'tax_id', to_jsonb(OLD)->>'ruc'));
    IF v_new IS NOT DISTINCT FROM v_old THEN RETURN NEW; END IF;  -- sin cambio de RUC: datos existentes intactos
  ELSIF EXISTS (SELECT 1 FROM public.clients c WHERE to_jsonb(c)->>'tax_id' = to_jsonb(NEW)->>'tax_id') THEN
    RETURN NEW;  -- importación con upsert (ON CONFLICT tax_id): actualiza el cliente existente
  END IF;
  IF v_new IS NULL THEN RAISE EXCEPTION 'Ingrese el RUC del cliente'; END IF;
  IF length(v_new) = 11 THEN
    IF NOT public.is_valid_ruc(v_new) THEN
      RAISE EXCEPTION 'RUC % inválido: no cumple el dígito verificador de SUNAT', v_new;
    END IF;
  ELSIF length(v_new) <> 8 THEN
    RAISE EXCEPTION 'El RUC debe tener 11 dígitos (o DNI de 8 para personas naturales sin RUC)';
  END IF;
  SELECT COALESCE(to_jsonb(c)->>'business_name', '—') INTO v_dup FROM public.clients c
  WHERE c.id IS DISTINCT FROM NEW.id
    AND public.client_tax_id_norm(COALESCE(to_jsonb(c)->>'tax_id', to_jsonb(c)->>'ruc')) = v_new
  LIMIT 1;
  IF v_dup IS NOT NULL THEN
    RAISE EXCEPTION 'Ya existe un cliente con el RUC %: %', v_new, v_dup;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS clients_tax_id_guard ON public.clients;
CREATE TRIGGER clients_tax_id_guard BEFORE INSERT OR UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.clients_tax_id_guard();

-- RUC ya registrados repetidos (para depurar; no se bloquean los existentes)
CREATE OR REPLACE FUNCTION public.list_duplicate_client_tax_ids()
RETURNS TABLE (tax_id text, clients text, total int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT n, string_agg(COALESCE(j->>'business_name', '—'), ' | ' ORDER BY j->>'business_name'), count(*)::int
  FROM (SELECT public.client_tax_id_norm(COALESCE(to_jsonb(c)->>'tax_id', to_jsonb(c)->>'ruc')) AS n, to_jsonb(c) AS j FROM public.clients c) x
  WHERE n IS NOT NULL AND (public.has_tms_read_permission('clientes') OR public.is_tms_admin())
  GROUP BY n HAVING count(*) > 1 ORDER BY 3 DESC;
$$;

REVOKE ALL ON FUNCTION public.profile_display_name(uuid), public.dispatch_event_author(), public.clients_tax_id_guard(),
  public.list_duplicate_client_tax_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_duplicate_client_tax_ids() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.profile_display_name(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
