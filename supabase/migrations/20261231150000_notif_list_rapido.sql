-- notif_list tardaba ~2,4 s por llamada (la consulta con más carga de la base: la campana la pide en cada pestaña):
-- evaluaba notif_can_see_event (permisos del usuario) en cada una de las ~10 mil notificaciones de 30 días.
-- Solo hay unas decenas de combinaciones (evento, permisos, destinatario): se evalúa una vez por combinación
-- (MATERIALIZED evita que el planificador vuelva a llamarla por fila). Mismas reglas de visibilidad; ~57 ms.
CREATE OR REPLACE FUNCTION public.notif_list(p_categoria text DEFAULT NULL::text, p_limit integer DEFAULT 50)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_items jsonb; v_counts jsonb; v_unread int; v_muted text[];
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Sesión no válida'); END IF;
  PERFORM public.notif_refresh(false);
  SELECT COALESCE(array_agg(categoria), '{}') INTO v_muted FROM public.notif_prefs WHERE user_id = v_uid AND silenciada;

  DROP TABLE IF EXISTS pg_temp.nx;
  CREATE TEMP TABLE nx ON COMMIT DROP AS
  WITH vis AS MATERIALIZED (
    SELECT s.evento, s.permisos, s.target_user FROM (
      SELECT DISTINCT evento, permisos, target_user FROM public.notifications WHERE created_at > now() - interval '30 days') s
    WHERE public.notif_can_see_event(s.evento, s.permisos, s.target_user))
  SELECT n.*, EXISTS (SELECT 1 FROM public.notification_reads r WHERE r.user_id = v_uid AND r.notification_id = n.id) AS leida
  FROM public.notifications n
  JOIN vis ON vis.evento = n.evento AND vis.permisos IS NOT DISTINCT FROM n.permisos AND vis.target_user IS NOT DISTINCT FROM n.target_user
  WHERE n.created_at > now() - interval '30 days' AND NOT (n.categoria = ANY (v_muted))
  ORDER BY n.created_at DESC LIMIT 300;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'created_at', created_at, 'evento', evento, 'categoria', categoria, 'severidad', severidad,
           'titulo', titulo, 'cuerpo', cuerpo, 'link', link, 'leida', leida, 'para_mi', target_user = v_uid) ORDER BY created_at DESC), '[]')
  INTO v_items FROM (SELECT * FROM nx WHERE p_categoria IS NULL OR categoria = p_categoria ORDER BY created_at DESC LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)) z;
  SELECT COALESCE(jsonb_object_agg(categoria, n), '{}') INTO v_counts FROM (SELECT categoria, count(*) FILTER (WHERE NOT leida) AS n FROM nx GROUP BY categoria) z;
  SELECT count(*) FILTER (WHERE NOT leida) INTO v_unread FROM nx;
  RETURN jsonb_build_object('success', true, 'items', v_items, 'no_leidas', v_unread, 'por_categoria', v_counts, 'silenciadas', to_jsonb(v_muted));
END $function$;
