-- Personal report reminders/results belong to their recipient, even when the
-- historical rule also grants a supervisory permission. Operational team alerts
-- retain their existing permission-based routing.
BEGIN;
CREATE OR REPLACE FUNCTION public.notif_can_see_event(p_evento text,p_permisos text[],p_target uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND is_active) THEN RETURN false; END IF;
 IF p_evento IN ('DESEMPENO_INFORME','DESEMPENO_INFORME_ATRASADO','DESEMPENO_INFORME_REVISADO',
  'CONDUCTOR_DESEMPENO','SOPORTE_INFORME','SOPORTE_INFORME_ATRASADO','SOPORTE_INFORME_REVISADO','FALLA_ASIGNADA') THEN
  RETURN COALESCE(p_target=auth.uid(),false);
 END IF;
 RETURN COALESCE(public.notif_can_see(p_permisos,p_target),false);
END $$;
REVOKE ALL ON FUNCTION public.notif_can_see_event(text,text[],uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.notif_can_see_event(text,text[],uuid) TO authenticated,service_role;

-- An additional restrictive policy protects table/realtime access regardless
-- of other existing permissive policies, including administrator access.
CREATE POLICY notifications_responsible_scope ON public.notifications AS RESTRICTIVE
 FOR SELECT TO authenticated USING(public.notif_can_see_event(evento,permisos,target_user));

-- The security-definer RPCs must enforce the same rule rather than bypassing RLS.
DO $patch$
DECLARE signature text; source text; guarded text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['public.notif_list(text,integer)','public.notif_mark_read(bigint[])'] LOOP
  SELECT pg_get_functiondef(signature::regprocedure) INTO source;
  guarded:=replace(replace(source,
   'public.notif_can_see(n.permisos, n.target_user)','public.notif_can_see_event(n.evento,n.permisos,n.target_user)'),
   'public.notif_can_see(x.permisos, x.target_user)','public.notif_can_see_event(x.evento,x.permisos,x.target_user)');
  IF guarded=source OR position('public.notif_can_see_event(' IN guarded)=0 THEN
   RAISE EXCEPTION 'La función de notificaciones % cambió: revisar destinatarios antes de migrar',signature;
  END IF;
  EXECUTE guarded;
 END LOOP;
END $patch$;
NOTIFY pgrst,'reload schema';
COMMIT;
