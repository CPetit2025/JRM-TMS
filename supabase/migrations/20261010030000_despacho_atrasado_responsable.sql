-- "Despacho atrasado" solo para el responsable del despacho (quien lo programó).
-- Antes se enviaba a todos los usuarios con permiso de Despacho, Torre de Control o Solicitudes.
-- * notif_dispatch_owner(): responsable = primer usuario del historial de estados (kpi_dispatch_log), luego el
--   autor del primer evento del despacho (dispatch_events.created_by o user_id) y, si existe, dispatches.created_by. Solo perfiles activos.
-- * Disparador BEFORE INSERT en notifications: el aviso nace asignado al responsable (no depende del texto de
--   notif_refresh, que en producción puede diferir del repositorio).
-- * notif_can_see_event(): con responsable, solo él lo ve (ni el administrador ni otros usuarios de Despacho).
--   Sin responsable conocido conserva el reparto por permiso para que el atraso no quede sin aviso.
BEGIN;

CREATE OR REPLACE FUNCTION public.notif_dispatch_owner(p_dispatch uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v uuid;
BEGIN
  IF p_dispatch IS NULL THEN RETURN NULL; END IF;
  IF to_regclass('public.kpi_dispatch_log') IS NOT NULL THEN
    EXECUTE $q$SELECT l.by FROM public.kpi_dispatch_log l JOIN public.profiles p ON p.id = l.by AND p.is_active
      WHERE l.dispatch_id = $1 ORDER BY l.at, l.id LIMIT 1$q$ INTO v USING p_dispatch;
    IF v IS NOT NULL THEN RETURN v; END IF;
  END IF;
  IF to_regclass('public.dispatch_events') IS NOT NULL THEN
    BEGIN
      EXECUTE $q$SELECT p.id FROM public.dispatch_events e JOIN public.profiles p ON p.id::text = COALESCE(to_jsonb(e) ->> 'created_by', to_jsonb(e) ->> 'user_id') AND p.is_active
        WHERE e.dispatch_id = $1 ORDER BY e.created_at LIMIT 1$q$ INTO v USING p_dispatch;
      IF v IS NOT NULL THEN RETURN v; END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  SELECT p.id INTO v FROM public.dispatches d JOIN public.profiles p ON p.id::text = to_jsonb(d) ->> 'created_by' AND p.is_active
  WHERE d.id = p_dispatch;
  RETURN v;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.notif_dispatch_owner(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notif_dispatch_owner(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.notif_trg_dispatch_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.evento = 'DESPACHO_ATRASADO' AND NEW.target_user IS NULL THEN
    NEW.target_user := public.notif_dispatch_owner(
      public.notif_uuid(substring(NEW.dedupe_key FROM '^desp-late-([0-9a-fA-F-]{36})')));
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.notif_trg_dispatch_owner() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS notif_trg_dispatch_owner ON public.notifications;
CREATE TRIGGER notif_trg_dispatch_owner BEFORE INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.notif_trg_dispatch_owner();

CREATE OR REPLACE FUNCTION public.notif_can_see_event(p_evento text,p_permisos text[],p_target uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND is_active) THEN RETURN false; END IF;
 IF p_evento IN ('DESEMPENO_INFORME','DESEMPENO_INFORME_ATRASADO','DESEMPENO_INFORME_REVISADO',
  'CONDUCTOR_DESEMPENO','SOPORTE_INFORME','SOPORTE_INFORME_ATRASADO','SOPORTE_INFORME_REVISADO','FALLA_ASIGNADA') THEN
  RETURN COALESCE(p_target=auth.uid(),false);
 END IF;
 IF p_evento = 'DESPACHO_ATRASADO' AND p_target IS NOT NULL THEN
  RETURN p_target = auth.uid();
 END IF;
 RETURN COALESCE(public.notif_can_see(p_permisos,p_target),false);
END $$;
REVOKE ALL ON FUNCTION public.notif_can_see_event(text,text[],uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.notif_can_see_event(text,text[],uuid) TO authenticated,service_role;

-- Avisos ya emitidos: se asignan a su responsable
UPDATE public.notifications n
   SET target_user = public.notif_dispatch_owner(public.notif_uuid(substring(n.dedupe_key FROM '^desp-late-([0-9a-fA-F-]{36})')))
 WHERE n.evento = 'DESPACHO_ATRASADO' AND n.target_user IS NULL;

UPDATE public.notif_reglas SET descripcion = 'Despacho atrasado: su fecha pasó y no se cerró (solo al responsable que lo programó)'
 WHERE evento = 'DESPACHO_ATRASADO';

NOTIFY pgrst, 'reload schema';
COMMIT;
