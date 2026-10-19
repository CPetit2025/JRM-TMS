-- ============================================================
-- Seguimiento de transporte para usuarios del TMS (sin código)
-- ============================================================
-- El portal «Planificación y Seguimiento de Transporte» se comparte con clientes por enlace + código (PIN).
-- Quien ya inició sesión en el TMS (cuenta activa, con acceso a la sede) lo abre desde el menú sin código:
-- cada sede tiene un enlace interno de alcance «toda la sede» cuyo código se guarda aquí y nunca sale de la base.
-- La vista reutiliza el mismo cálculo del portal (get_public_tracking_portal_view) y la presencia («personas
-- viendo») muestra el nombre del usuario. Si alguien revoca o cambia el código del enlace interno desde Torre de
-- Control, se crea uno nuevo automáticamente.
BEGIN;
SET LOCAL lock_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.tracking_portal_internal (
  site_id    uuid PRIMARY KEY,
  token      uuid NOT NULL,
  pin        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.tracking_portal_internal ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.tracking_portal_internal;
CREATE POLICY security_active_account ON public.tracking_portal_internal AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
-- Sin políticas permisivas ni privilegios: solo las funciones de abajo leen el código
REVOKE ALL ON public.tracking_portal_internal FROM PUBLIC, anon, authenticated;
-- El servidor web (llave de servicio) la lee para abrir guías y Packing List desde el seguimiento interno
GRANT SELECT ON public.tracking_portal_internal TO service_role;

-- Sedes que el usuario puede ver en el seguimiento
CREATE OR REPLACE FUNCTION public.tracking_internal_sites()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('error', 'Inicie sesión para ver el seguimiento'); END IF;
  RETURN jsonb_build_object('success', true, 'sites', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) ORDER BY s.name)
    FROM public.sites s WHERE s.is_active AND public.can_access_site(s.id)), '[]'::jsonb));
END $$;

-- Enlace interno de la sede (lo crea si falta, fue revocado o su código ya no coincide)
CREATE OR REPLACE FUNCTION public.tracking_internal_link(p_site uuid, p_renew boolean DEFAULT false)
RETURNS public.tracking_portal_internal LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.tracking_portal_internal; v_pin text; v_tok uuid;
BEGIN
  SELECT * INTO r FROM public.tracking_portal_internal WHERE site_id = p_site FOR UPDATE;
  IF r.site_id IS NOT NULL AND NOT p_renew
     AND EXISTS (SELECT 1 FROM public.tracking_portal_links l WHERE l.token = r.token AND l.revoked_at IS NULL) THEN
    RETURN r;
  END IF;
  -- El anterior (si existía) queda revocado: solo hay un enlace interno vigente por sede
  IF r.site_id IS NOT NULL THEN
    UPDATE public.tracking_portal_links SET revoked_at = now() WHERE token = r.token AND revoked_at IS NULL;
  END IF;
  v_pin := public.portal_pin_generate();
  INSERT INTO public.tracking_portal_links (site_id, contract_ids, client_ids, label, pin_hash, created_by)
  VALUES (p_site, '{}', '{}', 'Acceso interno del TMS (sin código)', extensions.crypt(v_pin, extensions.gen_salt('bf', 8)), auth.uid())
  RETURNING token INTO v_tok;
  INSERT INTO public.tracking_portal_internal (site_id, token, pin) VALUES (p_site, v_tok, v_pin)
  ON CONFLICT (site_id) DO UPDATE SET token = EXCLUDED.token, pin = EXCLUDED.pin, created_at = now()
  RETURNING * INTO r;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.tracking_internal_link(uuid, boolean) FROM PUBLIC, anon, authenticated;

-- Vista del portal para el usuario del TMS: mismo calendario, ruta del día y presencia, sin código
CREATE OR REPLACE FUNCTION public.get_internal_tracking_view(p_site uuid, p_from date, p_to date, p_viewer uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l public.tracking_portal_internal; v_name text; v_viewer uuid := p_viewer; r jsonb; s jsonb; v_try int := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('error', 'Inicie sesión para ver el seguimiento'); END IF;
  IF p_site IS NULL OR NOT public.can_access_site(p_site)
     OR NOT EXISTS (SELECT 1 FROM public.sites WHERE id = p_site AND is_active) THEN
    RETURN jsonb_build_object('error', 'Sin acceso a esta sede');
  END IF;
  SELECT NULLIF(btrim(concat_ws(' ', first_name, last_name)), '') INTO v_name FROM public.profiles WHERE id = auth.uid();
  v_name := COALESCE(v_name, split_part((SELECT email FROM public.profiles WHERE id = auth.uid()), '@', 1), 'Usuario TMS');
  IF v_name !~ '[[:alpha:]]' OR length(v_name) < 3 THEN v_name := 'Usuario TMS'; END IF;
  LOOP
    v_try := v_try + 1;
    l := public.tracking_internal_link(p_site, v_try > 1);
    -- La sesión de presencia sigue si es de este enlace y del mismo nombre; si no, se abre una nueva
    IF v_viewer IS NULL OR NOT EXISTS (SELECT 1 FROM public.tracking_portal_viewers w WHERE w.id = v_viewer AND w.portal_token = l.token
                                       AND w.name = public.tracking_portal_viewer_name(v_name)) THEN
      s := public.tracking_portal_sign_in(l.token, l.pin, v_name);
      v_viewer := NULLIF(s->>'viewer_id', '')::uuid;
    END IF;
    IF v_viewer IS NOT NULL THEN
      r := public.get_public_tracking_portal_view(l.token, l.pin, v_viewer, p_from, p_to);
    ELSE
      r := s;
    END IF;
    -- Código cambiado o enlace revocado desde Torre de Control: un enlace interno nuevo (una sola vez)
    EXIT WHEN v_try >= 2 OR r IS NULL OR NOT (r ? 'error')
      OR NOT (r->>'error' ~* 'código de acceso incorrecto|acceso revocado|acceso vencido');
    v_viewer := NULL;
  END LOOP;
  IF r IS NULL OR r ? 'error' THEN RETURN COALESCE(r, jsonb_build_object('error', 'No se pudo abrir el seguimiento')); END IF;
  RETURN r || jsonb_build_object('internal', true, 'site_id', p_site, 'viewer_id', v_viewer,
    'label', (SELECT name FROM public.sites WHERE id = p_site));
END $$;

-- Cerrar la sesión de presencia al salir de la pantalla
CREATE OR REPLACE FUNCTION public.internal_tracking_sign_out(p_site uuid, p_viewer uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_tms_user() THEN RETURN; END IF;
  UPDATE public.tracking_portal_viewers w SET signed_out_at = now()
  FROM public.tracking_portal_internal i
  WHERE i.site_id = p_site AND w.portal_token = i.token AND w.id = p_viewer AND w.signed_out_at IS NULL;
END $$;

REVOKE ALL ON FUNCTION public.tracking_internal_sites(), public.get_internal_tracking_view(uuid, date, date, uuid),
  public.internal_tracking_sign_out(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tracking_internal_sites(), public.get_internal_tracking_view(uuid, date, date, uuid),
  public.internal_tracking_sign_out(uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
