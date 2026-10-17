-- ============================================================
-- Aprobación automática de solicitudes de transporte (Configuración)
-- ============================================================
-- Interruptor central, desactivado por defecto. Activo: al guardar una solicitud con OT que queda PENDIENTE (sin
-- observaciones), pasa a APROBADA con el mismo cambio de estado y registro que la aprobación del Supervisor de
-- Despacho, marcado como automático. Siguen pasando por aprobación manual:
--   · las observadas (partida, costos, referencia), que se corrigen antes;
--   · las de OC/OS/RQ sin OT, que requieren autorizar su monto (approve_reference_transport_request).
-- Lo cambian el Administrador o quien aprueba solicitudes (despacho-aprobacion); cada cambio queda en el historial.
-- No aprueba las solicitudes que ya estaban pendientes: aplica a las que se registran o editan después.
BEGIN;

CREATE TABLE IF NOT EXISTS public.transport_request_approval_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  auto_approve boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS public.transport_request_approval_settings_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  previous_value boolean NOT NULL,
  next_value boolean NOT NULL,
  actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transport_request_approval_settings_updated_by_idx ON public.transport_request_approval_settings(updated_by);
CREATE INDEX IF NOT EXISTS transport_request_approval_audit_actor_idx ON public.transport_request_approval_settings_audit(actor_id);
INSERT INTO public.transport_request_approval_settings(id) VALUES (true) ON CONFLICT DO NOTHING;

ALTER TABLE public.transport_request_approval_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transport_request_approval_settings_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.transport_request_approval_settings;
DROP POLICY IF EXISTS security_active_account ON public.transport_request_approval_settings_audit;
CREATE POLICY security_active_account ON public.transport_request_approval_settings AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
CREATE POLICY security_active_account ON public.transport_request_approval_settings_audit AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.transport_request_approval_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.transport_request_approval_settings_audit FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.transport_request_approval_settings, public.transport_request_approval_settings_audit TO service_role;

CREATE OR REPLACE FUNCTION public.transport_request_auto_approve_enabled() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT auto_approve FROM public.transport_request_approval_settings WHERE id), false);
$$;
REVOKE ALL ON FUNCTION public.transport_request_auto_approve_enabled() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transport_request_auto_approve_enabled() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.can_configure_request_auto_approval() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT auth.uid() IS NOT NULL AND public.is_active_tms_user()
     AND (public.is_tms_admin() OR public.has_tms_permission('despacho-aprobacion'));
$$;
REVOKE ALL ON FUNCTION public.can_configure_request_auto_approval() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_configure_request_auto_approval() TO authenticated, service_role;

-- Estado para Configuración y Solicitudes: cualquier usuario activo lo consulta; can_edit indica si puede cambiarlo
CREATE OR REPLACE FUNCTION public.get_request_auto_approval() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s record;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('success', false, 'error', 'Sesión no válida'); END IF;
  SELECT st.auto_approve, st.updated_at,
         NULLIF(btrim(concat_ws(' ', to_jsonb(p)->>'first_name', to_jsonb(p)->>'last_name')), '') AS updated_by_name
    INTO s FROM public.transport_request_approval_settings st LEFT JOIN public.profiles p ON p.id = st.updated_by WHERE st.id;
  RETURN jsonb_build_object('success', true, 'enabled', COALESCE(s.auto_approve, false), 'updated_at', s.updated_at,
    'updated_by_name', s.updated_by_name, 'can_edit', public.can_configure_request_auto_approval());
END $$;
REVOKE ALL ON FUNCTION public.get_request_auto_approval() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_request_auto_approval() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_request_auto_approval(p_enabled boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_old boolean;
BEGIN
  IF NOT public.can_configure_request_auto_approval() THEN
    RAISE EXCEPTION 'Solo el Administrador o quien aprueba solicitudes puede cambiar la aprobación automática';
  END IF;
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'Indique si la aprobación automática queda activa'; END IF;
  SELECT auto_approve INTO v_old FROM public.transport_request_approval_settings WHERE id FOR UPDATE;
  IF v_old IS NOT DISTINCT FROM p_enabled THEN RETURN public.get_request_auto_approval(); END IF;
  UPDATE public.transport_request_approval_settings SET auto_approve = p_enabled, updated_at = now(), updated_by = auth.uid() WHERE id;
  INSERT INTO public.transport_request_approval_settings_audit(previous_value, next_value, actor_id) VALUES (COALESCE(v_old, false), p_enabled, auth.uid());
  RETURN public.get_request_auto_approval();
END $$;
REVOKE ALL ON FUNCTION public.set_request_auto_approval(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_request_auto_approval(boolean) TO authenticated, service_role;

-- Paso interno: aprueba una solicitud recién guardada si corresponde. Mismo cambio que set_transport_request_status
-- (estado + evento), con el origen automático en el historial. No se expone a los usuarios.
CREATE OR REPLACE FUNCTION public.transport_request_try_auto_approve(p_request_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.transport_requests%ROWTYPE;
BEGIN
  IF NOT public.transport_request_auto_approve_enabled() THEN RETURN false; END IF;
  SELECT * INTO r FROM public.transport_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL OR r.contract_id IS NULL OR r.status NOT IN ('PENDIENTE', 'PENDIENTE DE APROBACIÓN') THEN RETURN false; END IF;
  UPDATE public.transport_requests SET status = 'APROBADA', updated_at = now() WHERE id = p_request_id;
  INSERT INTO public.transport_request_events(request_id, actor_id, action, previous_state, next_state)
  VALUES (p_request_id, auth.uid(), 'STATUS_CHANGED',
    jsonb_build_object('status', r.status, 'required_date', r.required_date),
    jsonb_build_object('status', 'APROBADA', 'required_date', r.required_date, 'origen', 'APROBACION_AUTOMATICA'));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.transport_request_try_auto_approve(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transport_request_try_auto_approve(uuid) TO service_role;

-- El guardado de la solicitud (nueva o editada) termina con la aprobación automática cuando está activa.
-- Se envuelve la versión instalada (producción puede diferir del repositorio) sin cambiar su firma.
DO $mig$
BEGIN
  IF to_regprocedure('public.save_transport_request_full(uuid,jsonb,jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'save_transport_request_full no está instalada';
  END IF;
  IF to_regprocedure('public.save_transport_request_full_before_auto_approval(uuid,jsonb,jsonb,jsonb)') IS NULL THEN
    ALTER FUNCTION public.save_transport_request_full(uuid, jsonb, jsonb, jsonb) RENAME TO save_transport_request_full_before_auto_approval;
  END IF;
END $mig$;
REVOKE ALL ON FUNCTION public.save_transport_request_full_before_auto_approval(uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_transport_request_full_before_auto_approval(uuid, jsonb, jsonb, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.save_transport_request_full(p_request_id uuid, p_payload jsonb, p_components jsonb, p_unloading jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_result jsonb; v_id uuid;
BEGIN
  v_result := public.save_transport_request_full_before_auto_approval(p_request_id, p_payload, p_components, p_unloading);
  v_id := COALESCE(NULLIF(v_result->>'id', ''), NULLIF(v_result->>'request_id', ''))::uuid;
  IF v_id IS NOT NULL AND public.transport_request_try_auto_approve(v_id) THEN
    v_result := COALESCE(v_result, '{}'::jsonb) || jsonb_build_object('status', 'APROBADA', 'auto_approved', true);
  END IF;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.save_transport_request_full(uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_transport_request_full(uuid, jsonb, jsonb, jsonb) TO authenticated, service_role;

COMMIT;
