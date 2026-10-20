-- Isolated compatibility fixture: operational payload is stubbed; all identity, scope, sessions and notification logic are real migrations.
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
ALTER TABLE public.contracts ADD COLUMN parent_contract_id uuid, ADD COLUMN site_id uuid, ADD COLUMN client_id uuid;
CREATE TABLE public.clients(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,site_id uuid);
CREATE TABLE public.tracking_portal_links(
 token uuid PRIMARY KEY DEFAULT gen_random_uuid(),site_id uuid NOT NULL REFERENCES sites,contract_ids uuid[] NOT NULL DEFAULT '{}',client_ids uuid[] NOT NULL DEFAULT '{}',
 pin_hash text NOT NULL,label text,created_by uuid NOT NULL REFERENCES profiles,created_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz,rotated_at timestamptz,
 attempt_window timestamptz NOT NULL DEFAULT now(),attempts int NOT NULL DEFAULT 0
);
REVOKE ALL ON public.tracking_portal_links FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.portal_pin_generate() RETURNS text LANGUAGE sql AS $$SELECT 'A7K2'::text$$;
CREATE FUNCTION public.generate_tracking_portal_link(p_scope jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_token uuid;v_site uuid:=(p_scope->>'site_id')::uuid;
BEGIN
 IF NOT public.has_tms_permission('despacho') OR NOT public.can_access_site(v_site) THEN RAISE EXCEPTION 'Sin permiso'; END IF;
 INSERT INTO public.tracking_portal_links(site_id,pin_hash,created_by,label) VALUES(v_site,extensions.crypt('A7K2',extensions.gen_salt('bf',4)),auth.uid(),'Prueba seguimiento') RETURNING token INTO v_token;
 RETURN jsonb_build_object('token',v_token,'pin','A7K2');
END $$;
CREATE FUNCTION public.get_public_tracking_portal_info(p_token uuid,p_pin text,p_from date,p_to date) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE link public.tracking_portal_links;
BEGIN
 SELECT * INTO link FROM public.tracking_portal_links WHERE token=p_token FOR UPDATE;
 IF link.token IS NULL OR link.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('error','Acceso revocado'); END IF;
 IF extensions.crypt(upper(trim(p_pin)),link.pin_hash)<>link.pin_hash THEN RETURN jsonb_build_object('error','Código de acceso incorrecto'); END IF;
 RETURN jsonb_build_object('mode','permanent','rows','[]'::jsonb,'requests','[]'::jsonb,'label',link.label);
END $$;
CREATE FUNCTION public.tracking_portal_contract_family(p_ids uuid[]) RETURNS uuid[] LANGUAGE sql STABLE AS $$
 WITH RECURSIVE family(id) AS (
 SELECT c.id FROM public.contracts c WHERE c.id=ANY(p_ids)
 UNION SELECT c.id FROM public.contracts c JOIN family f ON c.parent_contract_id=f.id
 ) SELECT CASE WHEN COALESCE(cardinality(p_ids),0)=0 THEN NULL ELSE COALESCE((SELECT array_agg(id) FROM family),'{}'::uuid[]) END;
$$;
CREATE TABLE public.notifications(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,created_at timestamptz DEFAULT now(),evento text NOT NULL,categoria text NOT NULL,severidad text NOT NULL DEFAULT 'info',titulo text NOT NULL,cuerpo text,link text,permisos text[] NOT NULL DEFAULT '{}',target_user uuid,dedupe_key text);
CREATE UNIQUE INDEX notifications_dedupe_idx ON public.notifications(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE FUNCTION public.notif_can_see_event(p_evento text,p_permisos text[],p_target uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
 RETURN public.is_active_tms_user() AND (public.is_tms_admin() OR p_target=auth.uid() OR p_permisos && ARRAY['seguimiento']);
END $$;
REVOKE ALL ON public.notifications FROM PUBLIC,anon,authenticated;
