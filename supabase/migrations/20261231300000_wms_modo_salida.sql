-- Decisión 10 (19-11-2026): la salida de un despacho APT sin liberación del WMS se bloquea, pero es configurable.
-- Parámetro system_settings.wms_release_gate_mode: BLOQUEAR (por defecto, comportamiento actual) o ALERTAR (la salida
-- pasa y queda registrada como alerta). Cada cambio de modo queda en un historial con usuario, hora y motivo.
-- Las excepciones del supervisor siguen igual en ambos modos.

INSERT INTO public.system_settings(key, value, description, updated_at)
VALUES ('wms_release_gate_mode', 'BLOQUEAR', 'Salida de despachos APT sin liberación del WMS: BLOQUEAR o ALERTAR (solo avisa y registra).', now())
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.wms_release_gate_mode_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode text NOT NULL CHECK (mode IN ('BLOQUEAR','ALERTAR')),
  previous_mode text,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 10),
  changed_by uuid NOT NULL REFERENCES public.profiles(id),
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wms_release_gate_mode_log_changed_by_idx ON public.wms_release_gate_mode_log(changed_by);
ALTER TABLE public.wms_release_gate_mode_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wms_release_gate_mode_log FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS security_active_account ON public.wms_release_gate_mode_log;
CREATE POLICY security_active_account ON public.wms_release_gate_mode_log AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));

-- Salidas que pasaron sin liberación en modo ALERTAR (una por solicitud y despacho)
CREATE TABLE IF NOT EXISTS public.wms_release_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transport_request_id uuid NOT NULL REFERENCES public.transport_requests(id) ON DELETE CASCADE,
  dispatch_id uuid REFERENCES public.dispatches(id) ON DELETE CASCADE,
  wms_state text NOT NULL,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wms_release_alerts_request_idx ON public.wms_release_alerts(transport_request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wms_release_alerts_dispatch_idx ON public.wms_release_alerts(dispatch_id);
CREATE INDEX IF NOT EXISTS wms_release_alerts_created_by_idx ON public.wms_release_alerts(created_by);
ALTER TABLE public.wms_release_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wms_release_alerts FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS security_active_account ON public.wms_release_alerts;
CREATE POLICY security_active_account ON public.wms_release_alerts AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));

CREATE OR REPLACE FUNCTION public.wms_release_mode()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN (SELECT value FROM public.system_settings WHERE key = 'wms_release_gate_mode') = 'ALERTAR' THEN 'ALERTAR' ELSE 'BLOQUEAR' END
$$;
REVOKE ALL ON FUNCTION public.wms_release_mode() FROM PUBLIC, anon, authenticated;

-- Mismo cuerpo que 20261231180000 más «mode» y «alert»; «blocked» solo en modo BLOQUEAR.
CREATE OR REPLACE FUNCTION public.wms_release_gate(p_request uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record; s record; o record; v_beat timestamptz; v_state text; v_alert boolean; v_mode text := public.wms_release_mode();
BEGIN
  SELECT t.id, t.request_number, t.request_type, t.contract_id, t.pickup_address INTO r FROM public.transport_requests t WHERE t.id = p_request;
  IF NOT FOUND OR NOT public.wms_release_in_scope(r.request_type, r.contract_id, r.pickup_address) THEN
    RETURN jsonb_build_object('id', p_request, 'request_number', r.request_number, 'required', false, 'blocked', false, 'alert', false, 'mode', v_mode);
  END IF;
  SELECT x.reason, x.created_at, x.created_by INTO o FROM public.request_wms_release_overrides x
   WHERE x.transport_request_id = p_request ORDER BY x.created_at DESC LIMIT 1;
  SELECT x.status, x.released_at, x.task_code, x.reported_at INTO s FROM public.request_wms_status x WHERE x.transport_request_id = p_request;
  SELECT nullif(value, '')::timestamptz INTO v_beat FROM public.system_settings WHERE key = 'wms_status_last_report';
  v_state := CASE WHEN s.status = 'LIBERADO' THEN 'LIBERADO'
                  WHEN v_beat IS NULL OR v_beat < now() - interval '15 minutes' THEN 'SIN_RESPUESTA'
                  ELSE coalesce(s.status, 'PENDIENTE') END;
  v_alert := v_state <> 'LIBERADO' AND o.reason IS NULL;
  RETURN jsonb_build_object('id', p_request, 'request_number', r.request_number, 'required', true, 'state', v_state,
    'label', CASE v_state WHEN 'LIBERADO' THEN 'Liberada' WHEN 'SIN_RESPUESTA' THEN 'Sin respuesta del WMS'
      WHEN 'PENDIENTE' THEN 'Pendiente de picking' WHEN 'EN_PICKING' THEN 'En picking' WHEN 'EN_AUDITORIA' THEN 'En auditoría'
      WHEN 'OBSERVADO' THEN 'Observada en auditoría' WHEN 'PAUSADO' THEN 'Pausada en el WMS' WHEN 'CANCELADO' THEN 'Cancelada en el WMS'
      ELSE v_state END,
    'task_code', s.task_code, 'released_at', s.released_at, 'reported_at', s.reported_at,
    'override', CASE WHEN o.reason IS NOT NULL THEN jsonb_build_object('reason', o.reason, 'at', o.created_at,
      'by', coalesce((SELECT nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '') FROM public.profiles p WHERE p.id = o.created_by), 'Sistema')) END,
    'mode', v_mode, 'alert', v_alert, 'blocked', v_alert AND v_mode = 'BLOQUEAR');
END $$;
REVOKE ALL ON FUNCTION public.wms_release_gate(uuid) FROM PUBLIC, anon, authenticated;

-- Bloquea (BLOQUEAR) o registra la alerta (ALERTAR). Volátil porque escribe la alerta.
DROP FUNCTION IF EXISTS public.wms_release_assert(uuid[]);
CREATE FUNCTION public.wms_release_assert(p_requests uuid[], p_dispatch uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_msg text;
BEGIN
  SELECT string_agg(format('La solicitud %s aún no fue liberada por el almacén (picking y auditoría en el WMS); no puede salir. Estado WMS: %s.',
           g->>'request_number', g->>'label'), ' ' ORDER BY g->>'request_number')
    INTO v_msg
  FROM (SELECT DISTINCT unnest(p_requests) AS id) x CROSS JOIN LATERAL public.wms_release_gate(x.id) g
  WHERE x.id IS NOT NULL AND (g->>'blocked')::boolean;
  IF v_msg IS NOT NULL THEN
    RAISE EXCEPTION '%', v_msg USING ERRCODE = 'P0001', HINT = 'wms_release_check';
  END IF;
  INSERT INTO public.wms_release_alerts(transport_request_id, dispatch_id, wms_state, created_by)
  SELECT x.id, p_dispatch, g->>'state', auth.uid()
  FROM (SELECT DISTINCT unnest(p_requests) AS id) x CROSS JOIN LATERAL public.wms_release_gate(x.id) g
  WHERE x.id IS NOT NULL AND (g->>'alert')::boolean
    AND NOT EXISTS (SELECT 1 FROM public.wms_release_alerts a WHERE a.transport_request_id = x.id AND a.dispatch_id IS NOT DISTINCT FROM p_dispatch);
END $$;
REVOKE ALL ON FUNCTION public.wms_release_assert(uuid[], uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.wms_release_departure_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status IN ('EN_CURSO', 'EN RUTA', 'EN_RUTA', 'EN_TRANSITO') AND NEW.status IS DISTINCT FROM OLD.status
     AND (OLD.status = 'PROGRAMADO'
       OR (OLD.status = 'EN_CURSO' AND to_jsonb(NEW) ->> 'modalidad' IS DISTINCT FROM 'TERCERO')) THEN
    PERFORM public.wms_release_assert(ARRAY(SELECT dr.transport_request_id FROM public.dispatch_requests dr WHERE dr.dispatch_id = NEW.id), NEW.id);
  END IF;
  RETURN NEW;
END $$;

-- Cambiar el modo: Supervisor de Despacho o administrador, con motivo; queda en el historial
CREATE OR REPLACE FUNCTION public.wms_release_set_mode(p_mode text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_mode text := upper(btrim(coalesce(p_mode, ''))); v_prev text := public.wms_release_mode();
BEGIN
  IF NOT public.is_active_tms_user() OR NOT public.has_tms_permission('despacho-aprobacion') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el Supervisor de Despacho o un administrador cambia el modo de salida');
  END IF;
  IF v_mode NOT IN ('BLOQUEAR','ALERTAR') THEN RETURN jsonb_build_object('success', false, 'error', 'Modo no válido'); END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 10 THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo del cambio (mínimo 10 caracteres)'); END IF;
  IF v_mode = v_prev THEN RETURN jsonb_build_object('success', false, 'error', 'El modo ya es ' || v_mode); END IF;
  UPDATE public.system_settings SET value = v_mode, updated_at = now() WHERE key = 'wms_release_gate_mode';
  INSERT INTO public.wms_release_gate_mode_log(mode, previous_mode, reason, changed_by) VALUES (v_mode, v_prev, btrim(p_reason), auth.uid());
  RETURN jsonb_build_object('success', true, 'mode', v_mode);
END $$;
REVOKE ALL ON FUNCTION public.wms_release_set_mode(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wms_release_set_mode(text, text) TO authenticated;

-- Modo vigente, historial y alertas recientes para la UI
CREATE OR REPLACE FUNCTION public.wms_release_mode_info()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.is_active_tms_user() OR NOT (public.has_tms_read_permission('solicitudes') OR public.has_tms_read_permission('despacho')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso');
  END IF;
  RETURN jsonb_build_object('success', true, 'mode', public.wms_release_mode(), 'can_change', public.has_tms_permission('despacho-aprobacion'),
    'log', coalesce((SELECT jsonb_agg(jsonb_build_object('mode', l.mode, 'previous_mode', l.previous_mode, 'reason', l.reason, 'at', l.changed_at,
        'by', (SELECT nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '') FROM public.profiles p WHERE p.id = l.changed_by)) ORDER BY l.changed_at DESC)
      FROM (SELECT * FROM public.wms_release_gate_mode_log ORDER BY changed_at DESC LIMIT 20) l), '[]'::jsonb),
    'alerts_30d', (SELECT count(*) FROM public.wms_release_alerts WHERE created_at > now() - interval '30 days'));
END $$;
REVOKE ALL ON FUNCTION public.wms_release_mode_info() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wms_release_mode_info() TO authenticated;
