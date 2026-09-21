-- Release catalog and bounded AI usage. Run before deploying the matching web build.
CREATE TABLE public.app_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL CHECK (platform IN ('web', 'android')),
  channel text NOT NULL DEFAULT 'stable',
  version text NOT NULL,
  build_number integer,
  web_build_id text,
  release_date timestamptz NOT NULL DEFAULT now(),
  release_notes text NOT NULL DEFAULT '',
  mandatory boolean NOT NULL DEFAULT false,
  mandatory_after timestamptz,
  minimum_supported_version text,
  minimum_supported_build integer,
  installer_url text,
  artifact_sha256 text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, channel, version),
  CHECK (platform <> 'android' OR build_number IS NOT NULL),
  CHECK (platform <> 'android' OR status <> 'published' OR
    (installer_url ~ '^https://' AND artifact_sha256 IS NOT NULL)),
  CHECK (artifact_sha256 IS NULL OR artifact_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE INDEX app_versions_latest ON public.app_versions(platform, channel, release_date DESC)
  WHERE status = 'published';
ALTER TABLE public.app_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_versions FROM anon, authenticated;
GRANT SELECT ON public.app_versions TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.app_versions TO authenticated;
CREATE POLICY app_versions_published ON public.app_versions FOR SELECT TO anon, authenticated
  USING (status = 'published');
CREATE POLICY app_versions_admin ON public.app_versions FOR ALL TO authenticated
  USING (public.is_tms_admin()) WITH CHECK (public.is_tms_admin());

CREATE TABLE public.app_update_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  release_id uuid REFERENCES public.app_versions(id) ON DELETE SET NULL,
  installed_version text NOT NULL,
  event text NOT NULL CHECK (event IN ('offered', 'downloaded', 'deferred', 'install_started', 'installed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX app_update_events_user_time ON public.app_update_events(user_id, created_at DESC);
ALTER TABLE public.app_update_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_update_events FROM anon, authenticated;
GRANT SELECT, INSERT ON public.app_update_events TO authenticated;
CREATE POLICY app_update_events_read ON public.app_update_events FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_tms_admin());
CREATE POLICY app_update_events_insert ON public.app_update_events FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE TABLE public.ai_request_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('copilot', 'ocr')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_request_log_limit ON public.ai_request_log(user_id, scope, created_at DESC);
ALTER TABLE public.ai_request_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_request_log FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.reserve_ai_request(p_scope text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid := auth.uid(); v_minute_limit integer; v_daily_limit integer;
BEGIN
  IF v_user IS NULL OR p_scope NOT IN ('copilot', 'ocr') OR NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = v_user AND is_active = true
  ) THEN RETURN false; END IF;
  v_minute_limit := CASE WHEN p_scope = 'copilot' THEN 5 ELSE 3 END;
  v_daily_limit := CASE WHEN p_scope = 'copilot' THEN 50 ELSE 30 END;
  PERFORM pg_advisory_xact_lock(hashtext(v_user::text || ':' || p_scope));
  IF (SELECT count(*) FROM public.ai_request_log WHERE user_id = v_user AND scope = p_scope
      AND created_at > now() - interval '1 minute') >= v_minute_limit THEN RETURN false; END IF;
  IF (SELECT count(*) FROM public.ai_request_log WHERE user_id = v_user AND scope = p_scope
      AND created_at > now() - interval '1 day') >= v_daily_limit THEN RETURN false; END IF;
  INSERT INTO public.ai_request_log(user_id, scope) VALUES (v_user, p_scope);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.reserve_ai_request(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reserve_ai_request(text) TO authenticated;

CREATE TABLE public.ai_query_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('copilot', 'ocr')),
  model text NOT NULL,
  tool_names text[] NOT NULL DEFAULT '{}',
  context_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('completed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_query_audit_user_time ON public.ai_query_audit(user_id, created_at DESC);
ALTER TABLE public.ai_query_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_query_audit FROM anon, authenticated;
GRANT SELECT ON public.ai_query_audit TO authenticated;
CREATE POLICY ai_query_audit_read ON public.ai_query_audit FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_tms_admin());

-- Prepare a separate record for future confirmed actions. Clients cannot write it directly.
CREATE TABLE public.ai_action_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  action_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'confirmed', 'cancelled', 'expired', 'failed')),
  idempotency_key uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  confirmed_by uuid REFERENCES auth.users(id),
  confirmed_at timestamptz,
  result_ref jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes')
);
ALTER TABLE public.ai_action_proposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_action_proposals FROM anon, authenticated;
GRANT SELECT ON public.ai_action_proposals TO authenticated;
CREATE POLICY ai_action_proposals_read ON public.ai_action_proposals FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_tms_admin());
