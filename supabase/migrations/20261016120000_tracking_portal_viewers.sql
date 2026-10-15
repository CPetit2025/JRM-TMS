-- Portal público «Planificación y Seguimiento de Transporte»: quien ingresa se identifica con su nombre antes del
-- código de acceso, y el portal muestra quiénes lo están viendo (en vivo, por enlace).
-- · tracking_portal_sign_in: valida nombre + código y registra a la persona (visitante del enlace).
-- · get_public_tracking_portal_view: datos del portal + presencia (las personas activas del mismo enlace).
-- · tracking_portal_sign_out: salida.
-- · Las sesiones abiertas sin nombre se cierran: el navegador ya no puede consultar el portal sin identificarse.
CREATE TABLE IF NOT EXISTS public.tracking_portal_viewers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_token  uuid NOT NULL,
  name          text NOT NULL CHECK (length(name) BETWEEN 3 AND 80),
  signed_in_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  signed_out_at timestamptz
);
CREATE INDEX IF NOT EXISTS tracking_portal_viewers_active_idx ON public.tracking_portal_viewers(portal_token, last_seen_at DESC);
ALTER TABLE public.tracking_portal_viewers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.tracking_portal_viewers;
CREATE POLICY security_active_account ON public.tracking_portal_viewers AS RESTRICTIVE FOR ALL TO authenticated
 USING((SELECT public.is_active_tms_user())) WITH CHECK((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.tracking_portal_viewers FROM PUBLIC, anon, authenticated;

-- El portal solo responde a los navegadores a través de una persona identificada (cierra las sesiones abiertas)
DO $patch$
DECLARE sig regprocedure := 'public.get_public_tracking_portal_info(uuid,text,date,date)'::regprocedure; def text;
  anchor text := 'SELECT * INTO link FROM public.tracking_portal_links WHERE token=p_token FOR UPDATE;';
  guard text := $g$-- Navegador sin persona identificada (nombre): debe volver a ingresar
 IF COALESCE(current_setting('jrm.tracking_viewer', true), '') = '' AND COALESCE(current_setting('role', true), '') IN ('anon', 'authenticated') THEN
  RETURN jsonb_build_object('error', 'Acceso vencido: actualice la página e ingrese su nombre y el código para continuar');
 END IF;
 $g$;
BEGIN
  def := pg_get_functiondef(sig);
  IF position('jrm.tracking_viewer' IN def) > 0 THEN RETURN; END IF;
  IF position(anchor IN def) = 0 THEN RAISE EXCEPTION 'Portal de seguimiento no reconocido: revisar antes de migrar'; END IF;
  EXECUTE replace(def, anchor, guard || anchor);
END $patch$;

CREATE OR REPLACE FUNCTION public.tracking_portal_viewer_name(p_name text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT NULLIF(btrim(regexp_replace(COALESCE(p_name, ''), '\s+', ' ', 'g')), '');
$$;

CREATE OR REPLACE FUNCTION public.tracking_portal_sign_in(p_token uuid, p_pin text, p_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_name text := public.tracking_portal_viewer_name(p_name); r jsonb; v_id uuid;
BEGIN
  IF v_name IS NULL OR length(v_name) < 3 OR length(v_name) > 80 OR v_name !~ '[[:alpha:]]' THEN
    RETURN jsonb_build_object('error', 'Ingrese su nombre y apellido (3 a 80 caracteres)'); END IF;
  PERFORM set_config('jrm.tracking_viewer', 'sign-in', true);
  r := public.get_public_tracking_portal_info(p_token, p_pin, (now() AT TIME ZONE 'America/Lima')::date, (now() AT TIME ZONE 'America/Lima')::date);
  PERFORM set_config('jrm.tracking_viewer', '', true);
  IF r IS NULL OR r ? 'error' THEN RETURN COALESCE(r, jsonb_build_object('error', 'Código de acceso incorrecto')); END IF;
  INSERT INTO public.tracking_portal_viewers(portal_token, name) VALUES (p_token, v_name) RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', true, 'viewer_id', v_id, 'name', v_name);
END $$;

CREATE OR REPLACE FUNCTION public.get_public_tracking_portal_view(p_token uuid, p_pin text, p_viewer uuid, p_from date, p_to date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v public.tracking_portal_viewers; r jsonb; v_list jsonb; v_count int;
BEGIN
  SELECT * INTO v FROM public.tracking_portal_viewers WHERE id = p_viewer AND portal_token = p_token;
  IF v.id IS NULL OR v.signed_out_at IS NOT NULL OR v.last_seen_at < now() - interval '12 hours' THEN
    RETURN jsonb_build_object('error', 'Acceso vencido: ingrese su nombre y el código nuevamente'); END IF;
  PERFORM set_config('jrm.tracking_viewer', v.id::text, true);
  r := public.get_public_tracking_portal_info(p_token, p_pin, p_from, p_to);
  PERFORM set_config('jrm.tracking_viewer', '', true);
  IF r IS NULL OR r ? 'error' THEN RETURN r; END IF;
  UPDATE public.tracking_portal_viewers SET last_seen_at = now() WHERE id = v.id;
  -- Presencia: personas con el portal abierto en los últimos 60 s (el portal se actualiza cada 15 s)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('name', x.name, 'me', x.me, 'since', x.since) ORDER BY x.me DESC, x.name), '[]'::jsonb), count(*)
    INTO v_list, v_count
  FROM (SELECT w.name, bool_or(w.id = v.id) AS me, min(w.signed_in_at) AS since FROM public.tracking_portal_viewers w
        WHERE w.portal_token = p_token AND w.signed_out_at IS NULL AND (w.last_seen_at > now() - interval '60 seconds' OR w.id = v.id)
        GROUP BY lower(w.name), w.name) x;
  RETURN r || jsonb_build_object('viewer', jsonb_build_object('name', v.name), 'viewers', v_list, 'active_count', v_count);
END $$;

CREATE OR REPLACE FUNCTION public.tracking_portal_sign_out(p_token uuid, p_viewer uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.tracking_portal_viewers SET signed_out_at = now() WHERE id = p_viewer AND portal_token = p_token AND signed_out_at IS NULL;
  RETURN jsonb_build_object('success', true);
END $$;

REVOKE ALL ON FUNCTION public.tracking_portal_sign_in(uuid, text, text), public.get_public_tracking_portal_view(uuid, text, uuid, date, date),
  public.tracking_portal_sign_out(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tracking_portal_sign_in(uuid, text, text), public.get_public_tracking_portal_view(uuid, text, uuid, date, date),
  public.tracking_portal_sign_out(uuid, uuid) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.tracking_portal_viewer_name(text) FROM PUBLIC, anon, authenticated;
NOTIFY pgrst, 'reload schema';
