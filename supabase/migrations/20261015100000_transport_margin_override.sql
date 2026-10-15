-- Margen operativo de la partida de transporte ampliable por casuística (por defecto 80 % operación / 20 % utilidad).
-- El Administrador del sistema o el Jefe de Distribución pueden ampliarlo para una OT (toda su familia: madre,
-- subcontratos y errores) o para un cliente (todas sus OT), con motivo, vencimiento opcional e historial.
-- Prioridad: OT > cliente > 80 %. Vencido o revocado, vuelve al margen anterior sin tocar gastos históricos.
CREATE TABLE IF NOT EXISTS public.transport_margin_overrides (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope         text NOT NULL CHECK (scope IN ('OT', 'CLIENTE')),
  contract_id   uuid REFERENCES public.contracts(id) ON DELETE CASCADE,
  client_id     uuid REFERENCES public.clients(id) ON DELETE CASCADE,
  operating_pct numeric(5,2) NOT NULL CHECK (operating_pct > 80 AND operating_pct <= 100),
  reason        text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  valid_until   date,
  active        boolean NOT NULL DEFAULT true,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_by    uuid,
  revoked_at    timestamptz,
  revoke_reason text,
  CHECK ((scope = 'OT' AND contract_id IS NOT NULL AND client_id IS NULL) OR (scope = 'CLIENTE' AND client_id IS NOT NULL AND contract_id IS NULL))
);
CREATE INDEX IF NOT EXISTS transport_margin_overrides_contract_idx ON public.transport_margin_overrides(contract_id);
CREATE INDEX IF NOT EXISTS transport_margin_overrides_client_idx ON public.transport_margin_overrides(client_id);
CREATE UNIQUE INDEX IF NOT EXISTS transport_margin_one_active_ot ON public.transport_margin_overrides(contract_id) WHERE active AND scope = 'OT';
CREATE UNIQUE INDEX IF NOT EXISTS transport_margin_one_active_client ON public.transport_margin_overrides(client_id) WHERE active AND scope = 'CLIENTE';
ALTER TABLE public.transport_margin_overrides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.transport_margin_overrides;
CREATE POLICY security_active_account ON public.transport_margin_overrides AS RESTRICTIVE FOR ALL TO authenticated
 USING((SELECT public.is_active_tms_user())) WITH CHECK((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.transport_margin_overrides FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.can_manage_transport_margin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.is_tms_admin() OR EXISTS (SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
    WHERE p.id = auth.uid() AND p.is_active
      AND lower(btrim(r.name)) IN ('administrador', 'jefe de distribución', 'jefe de distribucion'));
$$;
REVOKE ALL ON FUNCTION public.can_manage_transport_margin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_transport_margin() TO authenticated;

-- Margen vigente de la OT raíz: ampliación de la OT, luego la del cliente, si no 80 %
CREATE OR REPLACE FUNCTION public.transport_margin_override_for(p_contract uuid)
RETURNS public.transport_margin_overrides LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH root AS (SELECT c.id, c.client_id FROM public.contracts c WHERE c.id = COALESCE(public.contract_root_id(p_contract), p_contract))
  SELECT o.* FROM public.transport_margin_overrides o, root
  WHERE o.active AND (o.valid_until IS NULL OR o.valid_until >= (now() AT TIME ZONE 'America/Lima')::date)
    AND ((o.scope = 'OT' AND o.contract_id = root.id) OR (o.scope = 'CLIENTE' AND o.client_id = root.client_id))
  ORDER BY CASE o.scope WHEN 'OT' THEN 1 ELSE 2 END LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.transport_margin_override_for(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.transport_operating_pct(p_contract uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT o.operating_pct FROM public.transport_margin_override_for(p_contract) o WHERE o.id IS NOT NULL), 80);
$$;
REVOKE ALL ON FUNCTION public.transport_operating_pct(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transport_operating_pct(uuid) TO authenticated, service_role;

-- Mismo redondeo que transport_operating_budget (al 80 % da exactamente lo mismo)
CREATE OR REPLACE FUNCTION public.transport_operating_limit(p_gross numeric, p_contract uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(p_gross, 0) - round(COALESCE(p_gross, 0) * (100 - public.transport_operating_pct(p_contract)) / 100, 2);
$$;
REVOKE ALL ON FUNCTION public.transport_operating_limit(numeric, uuid) FROM PUBLIC, anon, authenticated;

-- El saldo de la partida usa el margen vigente de la OT raíz
DO $patch$
DECLARE sig regprocedure := 'public.transport_budget_balance()'::regprocedure; def text;
  o_lim text := 'public.transport_operating_budget(NEW.allocated_pen)';
  n_lim text := 'public.transport_operating_limit(NEW.allocated_pen,NEW.contract_id)';
  n_msg text := '''Saldo insuficiente: se supera el margen operativo de la partida (% %% operativo); la utilidad está protegida'',public.transport_operating_pct(NEW.contract_id)';
BEGIN
  def := pg_get_functiondef(sig);
  IF position('transport_operating_limit' IN def) > 0 THEN RETURN; END IF;
  IF position(o_lim IN def) = 0 THEN RAISE EXCEPTION 'Saldo de partida no reconocido: revisar antes de migrar'; END IF;
  def := replace(def, o_lim, n_lim);
  def := replace(def, '''Saldo insuficiente: solo se dispone del 80%% de la partida consolidada; el 20%% de utilidad está protegido''', n_msg);
  def := replace(def, '''Saldo insuficiente: solo se dispone del 80%% de la partida; el 20%% de utilidad está protegido''', n_msg);
  EXECUTE def;
END $patch$;

-- Mensajes de saldo del armado de ruta: sin el 80 % fijo
DO $msgs$
DECLARE f record; def text;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosrc LIKE '%Solo se dispone del 80\%\%%' LOOP
    def := replace(pg_get_functiondef(f.sig), 'Solo se dispone del 80%%', 'Supera el margen operativo de la partida');
    EXECUTE def;
  END LOOP;
END $msgs$;

-- Recalcula el saldo guardado de las OT raíz afectadas (sin tocar reservas ni consumos)
CREATE OR REPLACE FUNCTION public.transport_margin_refresh(p_contract uuid, p_client uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN SELECT b.id FROM public.contract_budgets b JOIN public.contracts c ON c.id = b.contract_id
    WHERE b.concept = 'PARTIDA_TRANSPORTE' AND c.parent_contract_id IS NULL
      AND ((p_contract IS NOT NULL AND c.id = public.contract_root_id(p_contract)) OR (p_client IS NOT NULL AND c.client_id = p_client)) LOOP
    BEGIN
      UPDATE public.contract_budgets SET allocated_pen = allocated_pen, updated_at = now() WHERE id = r.id;
      n := n + 1;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Partida % sin recalcular: %', r.id, SQLERRM;
    END;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.transport_margin_refresh(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_transport_margin(p_contract uuid, p_scope text, p_pct numeric, p_reason text, p_valid_until date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_root uuid; v_client uuid; v_scope text := upper(btrim(COALESCE(p_scope, ''))); v_id uuid; v_reason text := btrim(COALESCE(p_reason, ''));
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin sesión activa'); END IF;
  IF NOT public.can_manage_transport_margin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el Administrador del sistema o el Jefe de Distribución pueden ampliar el margen'); END IF;
  IF v_scope NOT IN ('OT', 'CLIENTE') THEN RETURN jsonb_build_object('success', false, 'error', 'Indique si la ampliación es para la OT o para el cliente'); END IF;
  IF p_pct IS NULL OR p_pct <= 80 OR p_pct > 100 THEN RETURN jsonb_build_object('success', false, 'error', 'El margen operativo debe ser mayor a 80 % y como máximo 100 %'); END IF;
  IF length(v_reason) NOT BETWEEN 10 AND 500 THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo de la ampliación (mínimo 10 caracteres)'); END IF;
  IF p_valid_until IS NOT NULL AND p_valid_until < (now() AT TIME ZONE 'America/Lima')::date THEN
    RETURN jsonb_build_object('success', false, 'error', 'La fecha de vencimiento no puede ser anterior a hoy'); END IF;
  v_root := COALESCE(public.contract_root_id(p_contract), p_contract);
  SELECT c.client_id INTO v_client FROM public.contracts c WHERE c.id = v_root;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'OT no encontrada'); END IF;
  IF v_scope = 'CLIENTE' AND v_client IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'La OT no tiene cliente: amplíe el margen solo para la OT'); END IF;
  -- Reemplaza la ampliación vigente del mismo alcance (queda en el historial)
  UPDATE public.transport_margin_overrides SET active = false, revoked_by = auth.uid(), revoked_at = now(), revoke_reason = 'Reemplazada por una nueva ampliación'
   WHERE active AND ((v_scope = 'OT' AND scope = 'OT' AND contract_id = v_root) OR (v_scope = 'CLIENTE' AND scope = 'CLIENTE' AND client_id = v_client));
  INSERT INTO public.transport_margin_overrides(scope, contract_id, client_id, operating_pct, reason, valid_until, created_by)
  VALUES (v_scope, CASE WHEN v_scope = 'OT' THEN v_root END, CASE WHEN v_scope = 'CLIENTE' THEN v_client END, round(p_pct, 2), v_reason, p_valid_until, auth.uid())
  RETURNING id INTO v_id;
  PERFORM public.transport_margin_refresh(CASE WHEN v_scope = 'OT' THEN v_root END, CASE WHEN v_scope = 'CLIENTE' THEN v_client END);
  RETURN jsonb_build_object('success', true, 'id', v_id, 'operating_pct', public.transport_operating_pct(v_root));
END $$;
REVOKE ALL ON FUNCTION public.set_transport_margin(uuid, text, numeric, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_transport_margin(uuid, text, numeric, text, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.revoke_transport_margin(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o public.transport_margin_overrides; v_reason text := btrim(COALESCE(p_reason, ''));
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin sesión activa'); END IF;
  IF NOT public.can_manage_transport_margin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el Administrador del sistema o el Jefe de Distribución pueden revocar el margen'); END IF;
  IF length(v_reason) NOT BETWEEN 10 AND 500 THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo (mínimo 10 caracteres)'); END IF;
  UPDATE public.transport_margin_overrides SET active = false, revoked_by = auth.uid(), revoked_at = now(), revoke_reason = v_reason
   WHERE id = p_id AND active RETURNING * INTO o;
  IF o.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'La ampliación ya no está vigente'); END IF;
  PERFORM public.transport_margin_refresh(o.contract_id, o.client_id);
  RETURN jsonb_build_object('success', true);
END $$;
REVOKE ALL ON FUNCTION public.revoke_transport_margin(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_transport_margin(uuid, text) TO authenticated;

-- Margen vigente e historial de una OT (y de su cliente) para la ficha de la OT
CREATE OR REPLACE FUNCTION public.get_transport_margin(p_contract uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_root uuid; v_client uuid; v_client_name text; v_cur public.transport_margin_overrides; v_hist jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin sesión activa'); END IF;
  v_root := COALESCE(public.contract_root_id(p_contract), p_contract);
  SELECT c.client_id, cl.business_name INTO v_client, v_client_name FROM public.contracts c LEFT JOIN public.clients cl ON cl.id = c.client_id WHERE c.id = v_root;
  v_cur := public.transport_margin_override_for(v_root);
  SELECT COALESCE(jsonb_agg(x ORDER BY x.created_at DESC), '[]'::jsonb) INTO v_hist FROM (
    SELECT o.id, o.scope, o.operating_pct, o.reason, o.valid_until, o.active, o.created_at, o.revoked_at, o.revoke_reason,
      (o.active AND (o.valid_until IS NULL OR o.valid_until >= (now() AT TIME ZONE 'America/Lima')::date)) AS vigente,
      (SELECT COALESCE(NULLIF(btrim(concat_ws(' ', to_jsonb(pr)->>'first_name', to_jsonb(pr)->>'last_name')), ''), to_jsonb(pr)->>'full_name', to_jsonb(pr)->>'email') FROM public.profiles pr WHERE pr.id = o.created_by) AS created_by_name,
      (SELECT COALESCE(NULLIF(btrim(concat_ws(' ', to_jsonb(pr)->>'first_name', to_jsonb(pr)->>'last_name')), ''), to_jsonb(pr)->>'full_name', to_jsonb(pr)->>'email') FROM public.profiles pr WHERE pr.id = o.revoked_by) AS revoked_by_name
    FROM public.transport_margin_overrides o
    WHERE (o.scope = 'OT' AND o.contract_id = v_root) OR (o.scope = 'CLIENTE' AND o.client_id = v_client)
    ORDER BY o.created_at DESC LIMIT 20) x;
  RETURN jsonb_build_object('success', true, 'root_id', v_root, 'client_id', v_client, 'client_name', v_client_name,
    'operating_pct', COALESCE(v_cur.operating_pct, 80), 'source', COALESCE(v_cur.scope, 'DEFAULT'),
    'current', CASE WHEN v_cur.id IS NOT NULL THEN jsonb_build_object('id', v_cur.id, 'scope', v_cur.scope, 'operating_pct', v_cur.operating_pct,
      'reason', v_cur.reason, 'valid_until', v_cur.valid_until) END,
    'can_manage', public.can_manage_transport_margin(), 'history', v_hist);
END $$;
REVOKE ALL ON FUNCTION public.get_transport_margin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_transport_margin(uuid) TO authenticated;

-- Vencimientos: cada día (00:10 Lima) se desactivan las ampliaciones vencidas y se recalcula el saldo
CREATE OR REPLACE FUNCTION public.transport_margin_expire() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o record; n integer := 0;
BEGIN
  FOR o IN UPDATE public.transport_margin_overrides SET active = false, revoked_at = now(), revoke_reason = 'Vencida'
    WHERE active AND valid_until < (now() AT TIME ZONE 'America/Lima')::date RETURNING contract_id, client_id LOOP
    PERFORM public.transport_margin_refresh(o.contract_id, o.client_id); n := n + 1;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.transport_margin_expire() FROM PUBLIC, anon, authenticated;
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'transport-margin-expire';
    PERFORM cron.schedule('transport-margin-expire', '10 5 * * *', 'SELECT public.transport_margin_expire();');
  END IF;
END $cron$;
NOTIFY pgrst, 'reload schema';
