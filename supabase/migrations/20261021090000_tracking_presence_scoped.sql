-- Shared presence: site-authorized staff and public viewers with equivalent scope.
-- Public identities are declared, not verified. No PIN/token/profile ID is returned in presence.
BEGIN;
ALTER TABLE public.tracking_portal_viewers
 ADD COLUMN presence_id uuid NOT NULL DEFAULT gen_random_uuid(),
 ADD COLUMN profile_id uuid REFERENCES public.profiles(id),
 ADD COLUMN client_session uuid,
 ADD COLUMN entry_id uuid,
 ADD COLUMN last_entry_at timestamptz;
CREATE UNIQUE INDEX tracking_viewer_presence_public_id ON public.tracking_portal_viewers(presence_id);
CREATE UNIQUE INDEX tracking_viewer_client_session ON public.tracking_portal_viewers(portal_token,client_session) WHERE client_session IS NOT NULL;
CREATE UNIQUE INDEX tracking_viewer_profile ON public.tracking_portal_viewers(portal_token,profile_id) WHERE profile_id IS NOT NULL;
CREATE INDEX tracking_viewer_profile_idx ON public.tracking_portal_viewers(profile_id);
CREATE TABLE public.tracking_presence_entries(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),viewer_id uuid NOT NULL REFERENCES public.tracking_portal_viewers(id),
 site_id uuid NOT NULL REFERENCES public.sites(id),portal_token uuid NOT NULL,
 profile_id uuid REFERENCES public.profiles(id),name text NOT NULL,
 access_type text NOT NULL CHECK(access_type IN('TMS','PUBLICO')),entered_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tracking_presence_site_time ON public.tracking_presence_entries(site_id,entered_at DESC);
CREATE INDEX tracking_presence_viewer_idx ON public.tracking_presence_entries(viewer_id);
CREATE INDEX tracking_presence_profile_idx ON public.tracking_presence_entries(profile_id);
ALTER TABLE public.tracking_presence_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_active_account ON public.tracking_presence_entries AS RESTRICTIVE FOR ALL TO authenticated
 USING((SELECT public.is_active_tms_user())) WITH CHECK((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.tracking_presence_entries FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.tracking_presence_profile_site(p_profile uuid,p_site uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id=p.role_id JOIN public.sites s ON s.id=p_site
  WHERE p.id=p_profile AND p.is_active AND s.is_active AND (r.name='Administrador' OR EXISTS(SELECT 1 FROM public.user_site_access a WHERE a.user_id=p.id AND a.site_id=s.id)));
$$;
CREATE FUNCTION public.tracking_presence_equivalent(p_left uuid,p_right uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.tracking_portal_links a JOIN public.tracking_portal_links b ON b.site_id=a.site_id
  WHERE a.token=p_left AND b.token=p_right AND a.revoked_at IS NULL AND b.revoked_at IS NULL
  AND (a.token=b.token OR (
   a.client_ids @> b.client_ids AND b.client_ids @> a.client_ids
   AND COALESCE(public.tracking_portal_contract_family(a.contract_ids),'{}'::uuid[]) @> COALESCE(public.tracking_portal_contract_family(b.contract_ids),'{}'::uuid[])
   AND COALESCE(public.tracking_portal_contract_family(b.contract_ids),'{}'::uuid[]) @> COALESCE(public.tracking_portal_contract_family(a.contract_ids),'{}'::uuid[])
   AND (cardinality(a.contract_ids)=0)=(cardinality(b.contract_ids)=0))));
$$;
-- One entry per continuous active episode, not per poll or tab. All entry points lock this row.
CREATE FUNCTION public.tracking_presence_touch(p_viewer uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_variable
DECLARE v public.tracking_portal_viewers;v_link public.tracking_portal_links;v_entry uuid;v_target uuid;v_kind text;
BEGIN
 SELECT * INTO v FROM public.tracking_portal_viewers WHERE id=p_viewer FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT * INTO v_link FROM public.tracking_portal_links WHERE token=v.portal_token AND revoked_at IS NULL;
 IF v_link.token IS NOT NULL AND EXISTS(SELECT 1 FROM public.sites WHERE id=v_link.site_id AND is_active)
  AND (v.entry_id IS NULL OR v.last_seen_at<now()-interval '60 seconds') THEN
  v_kind:=CASE WHEN v.profile_id IS NULL THEN 'PUBLICO' ELSE 'TMS' END;
  INSERT INTO public.tracking_presence_entries(viewer_id,site_id,portal_token,profile_id,name,access_type)
   VALUES(v.id,v_link.site_id,v.portal_token,v.profile_id,v.name,v_kind) RETURNING id INTO v_entry;
  UPDATE public.tracking_portal_viewers SET entry_id=v_entry,last_entry_at=now() WHERE id=v.id;
  -- Public visitors notify only the creator of their own link. Staff notify responsible
  -- creators of active public links for this site; never all users or the entrant themself.
  FOR v_target IN
   SELECT DISTINCT l.created_by FROM public.tracking_portal_links l
   WHERE l.site_id=v_link.site_id AND l.revoked_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.tracking_portal_internal i WHERE i.token=l.token)
    AND (v.profile_id IS NOT NULL OR l.token=v.portal_token)
    AND l.created_by IS DISTINCT FROM v.profile_id
    AND public.tracking_presence_profile_site(l.created_by,l.site_id)
  LOOP
   INSERT INTO public.notifications(evento,categoria,severidad,titulo,cuerpo,link,permisos,target_user,dedupe_key)
    VALUES('TRACKING_PORTAL_ENTRY','TRANSPORTE','info','Ingreso al seguimiento de transporte',
     v.name||CASE WHEN v.profile_id IS NULL THEN ' ingresó mediante un acceso compartido (nombre declarado).' ELSE ' ingresó con su cuenta del TMS.' END,
     '/seguimiento','{}',v_target,'tracking-entry:'||v_entry::text||':'||v_target::text)
    ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
  END LOOP;
 END IF;
 UPDATE public.tracking_portal_viewers SET last_seen_at=now(),signed_out_at=NULL WHERE id=v.id;
END $$;
-- Private: caller has already validated the PIN/session or the authenticated site access.
CREATE FUNCTION public.tracking_presence_payload(p_viewer uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_variable
DECLARE v public.tracking_portal_viewers;v_site uuid;v_list jsonb;v_events jsonb;v_count int;
BEGIN
 SELECT * INTO v FROM public.tracking_portal_viewers WHERE id=p_viewer;
 SELECT site_id INTO v_site FROM public.tracking_portal_links WHERE token=v.portal_token AND revoked_at IS NULL;
 IF v_site IS NULL THEN
  RETURN jsonb_build_object('viewers',jsonb_build_array(jsonb_build_object('id',v.presence_id,'name',v.name,'me',true,'since',v.signed_in_at,'access_type','PUBLICO','identity_verified',false)),
   'active_count',1,'presence_events','[]'::jsonb);
 END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.me DESC,x.name,x.id),'[]'),count(*) INTO v_list,v_count FROM(
  SELECT w.presence_id id,w.name,(w.id=v.id OR (v.profile_id IS NOT NULL AND w.profile_id=v.profile_id)) me,
   COALESCE(w.last_entry_at,w.signed_in_at) since,
   CASE WHEN w.profile_id IS NULL THEN 'PUBLICO' ELSE 'TMS' END access_type,w.profile_id IS NOT NULL identity_verified
  FROM public.tracking_portal_viewers w JOIN public.tracking_portal_links l ON l.token=w.portal_token
  WHERE l.site_id=v_site AND l.revoked_at IS NULL AND w.signed_out_at IS NULL AND w.last_seen_at>now()-interval '60 seconds'
   AND ((w.profile_id IS NOT NULL AND public.tracking_presence_profile_site(w.profile_id,v_site)) OR
    (w.profile_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.tracking_portal_internal i WHERE i.token=w.portal_token)))
   AND (v.profile_id IS NOT NULL OR w.profile_id IS NOT NULL OR public.tracking_presence_equivalent(v.portal_token,w.portal_token))
 ) x;
 v_events:='[]';
 IF v.profile_id=auth.uid() AND public.is_active_tms_user() AND public.can_access_site(v_site) THEN
  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.entered_at,x.id),'[]') INTO v_events FROM(
   SELECT e.id,e.name,e.access_type,e.profile_id IS NOT NULL identity_verified,e.entered_at,COALESCE(e.profile_id=auth.uid(),false) me
   FROM public.tracking_presence_entries e JOIN public.tracking_portal_links l ON l.token=e.portal_token
   WHERE e.site_id=v_site AND l.revoked_at IS NULL AND e.entered_at>now()-interval '60 seconds'
    AND (e.profile_id IS NULL OR public.tracking_presence_profile_site(e.profile_id,v_site)) ORDER BY e.entered_at DESC,e.id DESC LIMIT 100
  ) x;
 END IF;
 RETURN jsonb_build_object('viewers',v_list,'active_count',v_count,'presence_events',v_events);
END $$;
CREATE FUNCTION public.tracking_portal_sign_in_session(p_token uuid,p_pin text,p_name text,p_session uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_variable
DECLARE v_name text:=public.tracking_portal_viewer_name(p_name);v_r jsonb;v_id uuid;v_existing public.tracking_portal_viewers;
BEGIN
 IF v_name IS NULL OR length(v_name) NOT BETWEEN 3 AND 80 OR v_name !~ '[[:alpha:]]' THEN RETURN jsonb_build_object('error','Ingrese su nombre y apellido (3 a 80 caracteres)'); END IF;
 IF p_session IS NULL THEN RETURN jsonb_build_object('error','Actualice la página para iniciar una sesión segura.'); END IF;
 PERFORM set_config('jrm.tracking_viewer','sign-in',true);
 v_r:=public.get_public_tracking_portal_info(p_token,p_pin,(now() AT TIME ZONE 'America/Lima')::date,(now() AT TIME ZONE 'America/Lima')::date);
 PERFORM set_config('jrm.tracking_viewer','',true);
 IF v_r IS NULL OR v_r ? 'error' THEN RETURN COALESCE(v_r,jsonb_build_object('error','Código de acceso incorrecto')); END IF;
 IF EXISTS(SELECT 1 FROM public.tracking_portal_links l JOIN public.sites s ON s.id=l.site_id WHERE l.token=p_token AND NOT s.is_active) THEN RETURN jsonb_build_object('error','Sede no disponible'); END IF;
 IF EXISTS(SELECT 1 FROM public.tracking_portal_internal WHERE token=p_token) THEN RETURN jsonb_build_object('error','Use su cuenta del TMS para acceder al seguimiento interno.'); END IF;
 PERFORM pg_advisory_xact_lock(hashtext('tracking-public-session'),hashtext(p_token::text||p_session::text));
 SELECT * INTO v_existing FROM public.tracking_portal_viewers WHERE portal_token=p_token AND client_session=p_session FOR UPDATE;
 IF v_existing.signed_out_at IS NOT NULL THEN RETURN jsonb_build_object('error','Acceso vencido: inicie una nueva sesión después de salir.'); END IF;
 IF v_existing.id IS NOT NULL AND lower(v_existing.name)<>lower(v_name) THEN RETURN jsonb_build_object('error','Inicie una nueva sesión para cambiar el nombre declarado.'); END IF;
 v_id:=v_existing.id;
 IF v_id IS NULL THEN
  INSERT INTO public.tracking_portal_viewers(portal_token,name,client_session) VALUES(p_token,v_name,p_session) RETURNING id INTO v_id;
 END IF;
 PERFORM public.tracking_presence_touch(v_id);
 RETURN jsonb_build_object('success',true,'viewer_id',v_id,'name',v_name);
END $$;
CREATE OR REPLACE FUNCTION public.tracking_portal_sign_in(p_token uuid,p_pin text,p_name text) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT public.tracking_portal_sign_in_session(p_token,p_pin,p_name,gen_random_uuid());
$$;
CREATE OR REPLACE FUNCTION public.get_public_tracking_portal_view(p_token uuid,p_pin text,p_viewer uuid,p_from date,p_to date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_variable
DECLARE v public.tracking_portal_viewers;v_r jsonb;v_site uuid;
BEGIN
 SELECT * INTO v FROM public.tracking_portal_viewers WHERE id=p_viewer AND portal_token=p_token FOR UPDATE;
 IF v.id IS NULL OR v.signed_out_at IS NOT NULL OR v.last_seen_at<now()-interval '12 hours' THEN RETURN jsonb_build_object('error','Acceso vencido: ingrese su nombre y el código nuevamente'); END IF;
 SELECT site_id INTO v_site FROM public.tracking_portal_links WHERE token=p_token;
 IF v.profile_id IS NOT NULL AND (v.profile_id IS DISTINCT FROM auth.uid() OR NOT public.is_active_tms_user() OR NOT public.can_access_site(v_site)) THEN RETURN jsonb_build_object('error','Acceso vencido: inicie sesión en el TMS'); END IF;
 IF v_site IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.sites WHERE id=v_site AND is_active) THEN RETURN jsonb_build_object('error','Sede no disponible'); END IF;
 PERFORM set_config('jrm.tracking_viewer',v.id::text,true);
 v_r:=public.get_public_tracking_portal_info(p_token,p_pin,p_from,p_to);
 PERFORM set_config('jrm.tracking_viewer','',true);
 IF v_r IS NULL OR v_r ? 'error' THEN RETURN v_r; END IF;
 PERFORM public.tracking_presence_touch(v.id);
 RETURN v_r||public.tracking_presence_payload(v.id)||jsonb_build_object('viewer',jsonb_build_object('id',v.presence_id,'name',v.name,'access_type',CASE WHEN v.profile_id IS NULL THEN 'PUBLICO' ELSE 'TMS' END,'identity_verified',v.profile_id IS NOT NULL));
END $$;
-- Read-only fast path for ordinary polls. Serialize only first creation/renewal;
-- a concurrent renewal reuses the new link rather than revoking it again.
CREATE OR REPLACE FUNCTION public.tracking_internal_link(p_site uuid,p_renew boolean DEFAULT false)
RETURNS public.tracking_portal_internal LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_variable
DECLARE v_r public.tracking_portal_internal;v_old_token uuid;v_pin text;v_token uuid;
BEGIN
 SELECT * INTO v_r FROM public.tracking_portal_internal WHERE site_id=p_site;
 IF v_r.site_id IS NOT NULL AND NOT p_renew AND EXISTS(SELECT 1 FROM public.tracking_portal_links l WHERE l.token=v_r.token AND l.revoked_at IS NULL) THEN RETURN v_r; END IF;
 v_old_token:=v_r.token;
 PERFORM pg_advisory_xact_lock(hashtext('tracking-internal-site'),hashtext(p_site::text));
 SELECT * INTO v_r FROM public.tracking_portal_internal WHERE site_id=p_site FOR UPDATE;
 IF v_r.site_id IS NOT NULL AND (NOT p_renew OR v_r.token IS DISTINCT FROM v_old_token)
  AND EXISTS(SELECT 1 FROM public.tracking_portal_links l WHERE l.token=v_r.token AND l.revoked_at IS NULL) THEN RETURN v_r; END IF;
 IF v_r.site_id IS NOT NULL THEN UPDATE public.tracking_portal_links SET revoked_at=now() WHERE token=v_r.token AND revoked_at IS NULL; END IF;
 v_pin:=public.portal_pin_generate();
 INSERT INTO public.tracking_portal_links(site_id,contract_ids,client_ids,label,pin_hash,created_by)
 VALUES(p_site,'{}','{}','Acceso interno del TMS (sin código)',extensions.crypt(v_pin,extensions.gen_salt('bf',8)),auth.uid()) RETURNING token INTO v_token;
 INSERT INTO public.tracking_portal_internal(site_id,token,pin) VALUES(p_site,v_token,v_pin)
 ON CONFLICT(site_id) DO UPDATE SET token=EXCLUDED.token,pin=EXCLUDED.pin,created_at=now() RETURNING * INTO v_r;
 RETURN v_r;
END $$;
REVOKE ALL ON FUNCTION public.tracking_internal_link(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.get_internal_tracking_view(p_site uuid,p_from date,p_to date,p_viewer uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_variable
DECLARE v_link public.tracking_portal_internal;v_name text;v_viewer uuid;v_r jsonb;v_try int:=0;
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('error','Inicie sesión para ver el seguimiento'); END IF;
 IF p_site IS NULL OR NOT public.can_access_site(p_site) OR NOT EXISTS(SELECT 1 FROM public.sites WHERE id=p_site AND is_active) THEN RETURN jsonb_build_object('error','Sin acceso a esta sede'); END IF;
 SELECT COALESCE(NULLIF(btrim(concat_ws(' ',to_jsonb(p)->>'first_name',to_jsonb(p)->>'last_name')), ''),NULLIF(btrim(to_jsonb(p)->>'full_name'),''),'Usuario TMS') INTO v_name FROM public.profiles p WHERE p.id=auth.uid();
 IF length(v_name)<3 OR v_name !~ '[[:alpha:]]' THEN v_name:='Usuario TMS'; END IF;v_name:=left(v_name,80);
 PERFORM pg_advisory_xact_lock(hashtext('tracking-internal-session'),hashtext(p_site::text||auth.uid()::text));
 LOOP
  v_try:=v_try+1;v_link:=public.tracking_internal_link(p_site,v_try>1);
  SELECT id INTO v_viewer FROM public.tracking_portal_viewers WHERE portal_token=v_link.token AND profile_id=auth.uid() FOR UPDATE;
  IF v_viewer IS NULL THEN INSERT INTO public.tracking_portal_viewers(portal_token,name,profile_id) VALUES(v_link.token,v_name,auth.uid()) RETURNING id INTO v_viewer;
  ELSE UPDATE public.tracking_portal_viewers SET signed_out_at=NULL,name=v_name,
   entry_id=CASE WHEN last_seen_at<now()-interval '12 hours' THEN NULL ELSE entry_id END,
   last_seen_at=CASE WHEN last_seen_at<now()-interval '12 hours' THEN now() ELSE last_seen_at END
   WHERE id=v_viewer; END IF;
  v_r:=public.get_public_tracking_portal_view(v_link.token,v_link.pin,v_viewer,p_from,p_to);
  EXIT WHEN v_try>=2 OR v_r IS NULL OR NOT(v_r ? 'error') OR NOT(v_r->>'error' ~* 'código de acceso incorrecto|acceso revocado|acceso vencido');
 END LOOP;
 IF v_r IS NULL OR v_r ? 'error' THEN RETURN COALESCE(v_r,jsonb_build_object('error','No se pudo abrir el seguimiento')); END IF;
 RETURN v_r||jsonb_build_object('internal',true,'site_id',p_site,'viewer_id',v_viewer,'label',(SELECT name FROM public.sites WHERE id=p_site));
END $$;
CREATE OR REPLACE FUNCTION public.internal_tracking_sign_out(p_site uuid,p_viewer uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_variable
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_active_tms_user() OR NOT public.can_access_site(p_site) THEN RETURN; END IF;
 UPDATE public.tracking_portal_viewers w SET signed_out_at=now() FROM public.tracking_portal_internal i
 WHERE i.site_id=p_site AND w.portal_token=i.token AND w.id=p_viewer AND w.profile_id=auth.uid();
END $$;
CREATE OR REPLACE FUNCTION public.tracking_portal_sign_out(p_token uuid,p_viewer uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_variable
BEGIN
 UPDATE public.tracking_portal_viewers SET signed_out_at=now() WHERE id=p_viewer AND portal_token=p_token AND signed_out_at IS NULL
  AND (profile_id IS NULL OR (profile_id=auth.uid() AND public.is_active_tms_user() AND EXISTS(SELECT 1 FROM public.tracking_portal_links l WHERE l.token=p_token AND public.can_access_site(l.site_id))));
 RETURN jsonb_build_object('success',true);
END $$;
-- Targeted portal alerts stay private, including when an administrator views the bell.
DO $guard$
DECLARE v_def text;v_pos int;
BEGIN
 v_def:=pg_get_functiondef('public.notif_can_see_event(text,text[],uuid)'::regprocedure);
 IF position('TRACKING_PORTAL_ENTRY' IN v_def)>0 THEN RAISE EXCEPTION 'Revise la política de ingreso al portal antes de migrar.'; END IF;
 v_pos:=position(E'BEGIN\n' IN v_def);
 IF v_pos=0 THEN RAISE EXCEPTION 'No se reconoce la política de notificaciones.'; END IF;
 EXECUTE substr(v_def,1,v_pos+4)||E'\n IF p_evento=''TRACKING_PORTAL_ENTRY'' THEN RETURN public.is_active_tms_user() AND COALESCE(p_target=auth.uid(),false); END IF;\n'||substr(v_def,v_pos+5);
END $guard$;
REVOKE ALL ON FUNCTION public.tracking_presence_profile_site(uuid,uuid),public.tracking_presence_equivalent(uuid,uuid),public.tracking_presence_touch(uuid),public.tracking_presence_payload(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.tracking_portal_sign_in_session(uuid,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tracking_portal_sign_in_session(uuid,text,text,uuid) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
