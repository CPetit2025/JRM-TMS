-- ============================================================
-- Seguimiento interno: nombre del usuario sin depender de columnas opcionales del perfil
-- ============================================================
-- Incidente del despliegue de 20261021020000: en producción public.profiles no tiene la columna «email»
-- (C123 falló con 42703). Se redefine get_internal_tracking_view leyendo nombre y correo con to_jsonb(p).
BEGIN;
SET LOCAL lock_timeout = '60s';

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
  -- Producción no tiene todas las columnas del perfil del repositorio (p. ej. email): se leen como opcionales
  SELECT COALESCE(NULLIF(btrim(concat_ws(' ', to_jsonb(p)->>'first_name', to_jsonb(p)->>'last_name')), ''),
                  NULLIF(btrim(to_jsonb(p)->>'full_name'), ''), NULLIF(split_part(to_jsonb(p)->>'email', '@', 1), ''))
    INTO v_name FROM public.profiles p WHERE p.id = auth.uid();
  v_name := COALESCE(v_name, 'Usuario TMS');
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

GRANT EXECUTE ON FUNCTION public.get_internal_tracking_view(uuid, date, date, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.get_internal_tracking_view(uuid, date, date, uuid) FROM PUBLIC, anon;

NOTIFY pgrst, 'reload schema';
COMMIT;
