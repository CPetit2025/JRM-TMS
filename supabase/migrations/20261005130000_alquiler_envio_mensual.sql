-- ============================================================
-- Liquidación de alquiler seco: documento, envío por correo y recordatorio mensual
-- ============================================================
-- * vehicle_lease_contracts.send_to_email / cc_emails: a quién se envía la liquidación (correo del arrendador).
-- * lease_settlement_sends: registro de cada envío (fecha, destinatarios, medio, usuario). La liquidación aprobada es
--   inmutable, por eso el envío se guarda aparte y queda como historial.
-- * lease_settlement_document(id): todo lo que necesita la plantilla (liquidación, contrato, unidad, arrendador,
--   empresa, quién la elaboró y aprobó, firma y envíos) en una sola llamada.
-- * register_lease_settlement_send(id, para, cc, medio, nota): marca la liquidación como enviada.
-- * lease_envio_recordatorio(): el día 1 de cada mes avisa (campana) que hay que enviar la liquidación del mes
--   anterior de cada contrato activo; desde el día 3, si sigue sin enviarse, avisa a diario como atrasada.
--   Se programa con pg_cron todos los días a las 08:05 (Lima).
-- Producción no coincide con las migraciones: columnas opcionales con to_jsonb y tablas verificadas antes de usarse.
BEGIN;

ALTER TABLE public.vehicle_lease_contracts ADD COLUMN IF NOT EXISTS send_to_email text;
ALTER TABLE public.vehicle_lease_contracts ADD COLUMN IF NOT EXISTS cc_emails text;

CREATE TABLE IF NOT EXISTS public.lease_settlement_sends (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement_id uuid NOT NULL REFERENCES public.lease_settlements(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL DEFAULT now(),
  sent_to text NOT NULL,
  cc text,
  channel text NOT NULL DEFAULT 'CORREO',
  note text,
  sent_by uuid
);
CREATE INDEX IF NOT EXISTS lease_settlement_sends_idx ON public.lease_settlement_sends (settlement_id, sent_at DESC);
ALTER TABLE public.lease_settlement_sends ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lease_sends_read ON public.lease_settlement_sends;
CREATE POLICY lease_sends_read ON public.lease_settlement_sends FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.lease_settlements s WHERE s.id = settlement_id));   -- hereda la visibilidad de la liquidación
GRANT SELECT ON public.lease_settlement_sends TO authenticated;

-- ------------------------------------------------------------
-- Documento para la plantilla
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lease_person_name(p uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j jsonb;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  SELECT to_jsonb(pr) INTO j FROM public.profiles pr WHERE pr.id = p;
  RETURN COALESCE(NULLIF(btrim(concat_ws(' ', j ->> 'first_name', j ->> 'last_name')), ''), NULLIF(j ->> 'full_name', ''), j ->> 'email');
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.lease_person_name(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.lease_setting(p_key text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v text;
BEGIN
  IF to_regclass('public.system_settings') IS NULL THEN RETURN NULL; END IF;
  EXECUTE 'SELECT value::text FROM public.system_settings WHERE key = $1 LIMIT 1' INTO v USING p_key;
  RETURN NULLIF(btrim(v, ' "'), '');
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.lease_setting(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.lease_settlement_document(p_settlement_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.lease_settlements%ROWTYPE; c public.vehicle_lease_contracts%ROWTYPE; jv jsonb; jl jsonb;
BEGIN
  SELECT * INTO s FROM public.lease_settlements WHERE id = p_settlement_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Liquidación no encontrada'); END IF;
  SELECT * INTO c FROM public.vehicle_lease_contracts WHERE id = s.contract_id;
  IF auth.uid() IS NOT NULL AND NOT (public.can_access_site(c.site_id)
     AND (public.has_cmms_read_permission('flota') OR public.has_tms_read_permission('caja-liquidaciones'))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para ver esta liquidación');
  END IF;
  SELECT to_jsonb(v) INTO jv FROM public.vehicles v WHERE v.id = s.vehicle_id;
  SELECT to_jsonb(k) INTO jl FROM public.carriers k WHERE k.id = c.provider_id;
  RETURN jsonb_build_object('success', true,
    'settlement', to_jsonb(s) - 'detail', 'calc', s.detail,
    'contract', jsonb_build_object('id', c.id, 'code', c.contract_code, 'type', c.contract_type, 'rate_type', c.rate_type, 'rate_amount', c.rate_amount,
      'included_km', c.included_km, 'start_date', c.start_date, 'end_date', c.end_date, 'conditions', c.conditions,
      'send_to_email', c.send_to_email, 'cc_emails', c.cc_emails),
    'vehicle', jsonb_build_object('plate', jv ->> 'plate', 'brand', jv ->> 'brand', 'model', jv ->> 'model', 'type', jv ->> 'type', 'year', jv ->> 'year'),
    'lessor', jsonb_build_object('name', jl ->> 'business_name', 'ruc', NULLIF(jl ->> 'ruc', 'PEND-VALERIANI'), 'email', jl ->> 'email',
      'address', jl ->> 'address', 'contact', jl ->> 'contact_name', 'phone', jl ->> 'phone'),
    'company', jsonb_build_object('name', COALESCE(public.lease_setting('company_name'), 'ESTANTERÍAS METÁLICAS JRM S.A.C.'),
      'ruc', public.lease_setting('company_ruc'), 'address', public.lease_setting('company_address')),
    'created_by_name', public.lease_person_name(s.created_by), 'approved_by_name', public.lease_person_name(s.approved_by),
    'signature_url', CASE WHEN s.status = 'APROBADA' THEN public.lease_setting('admin_signature_url') END,
    'sends', COALESCE((SELECT jsonb_agg(jsonb_build_object('sent_at', x.sent_at, 'sent_to', x.sent_to, 'cc', x.cc, 'channel', x.channel,
                        'note', x.note, 'by', public.lease_person_name(x.sent_by)) ORDER BY x.sent_at DESC)
                      FROM public.lease_settlement_sends x WHERE x.settlement_id = s.id), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.lease_settlement_document(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lease_settlement_document(uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- Registrar envío
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_lease_settlement_send(p_settlement_id uuid, p_to text, p_cc text DEFAULT NULL,
  p_channel text DEFAULT 'CORREO', p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.lease_settlements%ROWTYPE; v_id bigint;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT (public.is_tms_admin() OR public.has_cmms_permission('flota')
     OR public.has_tms_read_permission('caja-liquidaciones')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para registrar el envío');
  END IF;
  SELECT * INTO s FROM public.lease_settlements WHERE id = p_settlement_id;
  IF NOT FOUND OR s.status = 'ANULADA' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Liquidación no encontrada o anulada');
  END IF;
  IF NULLIF(btrim(p_to), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique a quién se envió');
  END IF;
  INSERT INTO public.lease_settlement_sends (settlement_id, sent_to, cc, channel, note, sent_by)
  VALUES (s.id, btrim(p_to), NULLIF(btrim(p_cc), ''), upper(COALESCE(NULLIF(btrim(p_channel), ''), 'CORREO')), NULLIF(btrim(p_note), ''), auth.uid())
  RETURNING id INTO v_id;
  -- El correo usado queda como predeterminado del contrato si aún no tenía uno
  UPDATE public.vehicle_lease_contracts SET send_to_email = btrim(p_to), cc_emails = COALESCE(cc_emails, NULLIF(btrim(p_cc), ''))
  WHERE id = s.contract_id AND send_to_email IS NULL;
  RETURN jsonb_build_object('success', true, 'id', v_id);
END $$;
REVOKE ALL ON FUNCTION public.register_lease_settlement_send(uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_lease_settlement_send(uuid, text, text, text, text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- Recordatorio mensual (día 1) y atraso (desde el día 3)
-- ------------------------------------------------------------
INSERT INTO public.notif_reglas (evento, categoria, descripcion, severidad, permisos, al_solicitante) VALUES
  ('ALQUILER_ENVIO',          'MANTENIMIENTO', 'Día 1: enviar la liquidación de alquiler del mes anterior', 'warn', ARRAY['mantenimiento-flota', 'caja-liquidaciones'], false),
  ('ALQUILER_ENVIO_ATRASADO', 'MANTENIMIENTO', 'Liquidación de alquiler del mes anterior sin enviar',      'crit', ARRAY['mantenimiento-flota', 'caja-liquidaciones'], false)
ON CONFLICT (evento) DO NOTHING;

CREATE OR REPLACE FUNCTION public.lease_envio_recordatorio(p_hoy date DEFAULT NULL)
RETURNS int LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_hoy date := COALESCE(p_hoy, (now() AT TIME ZONE 'America/Lima')::date);
  v_ini date; v_fin date; v_mes text; r record; s record; v_estado text; n int := 0; v_link text;
  meses text[] := ARRAY['enero','febrero','marzo','abril','mayo','junio','julio','agosto','setiembre','octubre','noviembre','diciembre'];
BEGIN
  IF extract(day FROM v_hoy) = 2 THEN RETURN 0; END IF;
  v_ini := (date_trunc('month', v_hoy) - interval '1 month')::date;
  v_fin := (date_trunc('month', v_hoy) - interval '1 day')::date;
  v_mes := meses[extract(month FROM v_ini)::int] || ' ' || extract(year FROM v_ini);
  FOR r IN SELECT c.id, c.contract_code, v.plate, k.business_name
           FROM public.vehicle_lease_contracts c JOIN public.vehicles v ON v.id = c.vehicle_id
           LEFT JOIN public.carriers k ON k.id = c.provider_id
           WHERE c.status = 'ACTIVO' AND c.start_date <= v_fin AND (c.end_date IS NULL OR c.end_date >= v_ini) LOOP
    SELECT x.id, x.status, EXISTS (SELECT 1 FROM public.lease_settlement_sends e WHERE e.settlement_id = x.id) AS enviada INTO s
    FROM public.lease_settlements x
    WHERE x.contract_id = r.id AND x.status <> 'ANULADA' AND x.period_start <= v_fin AND x.period_end >= v_ini
    ORDER BY x.created_at DESC LIMIT 1;
    IF s.id IS NOT NULL AND s.enviada THEN CONTINUE; END IF;
    v_estado := CASE WHEN s.id IS NULL THEN 'Falta calcular y registrar la liquidación'
                     WHEN s.status = 'BORRADOR' THEN 'Registrada: falta aprobar y enviar'
                     ELSE 'Aprobada: falta enviar al arrendador' END;
    v_link := '/flota/liquidaciones-alquiler?contrato=' || r.id || '&periodo=' || to_char(v_ini, 'YYYY-MM');
    IF extract(day FROM v_hoy) = 1 THEN
      IF public.notif_emit('ALQUILER_ENVIO', 'alq-envio-' || r.id || '-' || to_char(v_ini, 'YYYYMM'),
           'Hoy se envía la liquidación de alquiler de ' || r.plate || ' (' || v_mes || ')',
           concat_ws(' · ', v_estado, r.business_name, r.contract_code), v_link) IS NOT NULL THEN n := n + 1; END IF;
    ELSE
      IF public.notif_emit('ALQUILER_ENVIO_ATRASADO', 'alq-envio-' || r.id || '-' || to_char(v_ini, 'YYYYMM') || '-' || to_char(v_hoy, 'DD'),
           'Liquidación de alquiler de ' || r.plate || ' (' || v_mes || ') sin enviar',
           concat_ws(' · ', v_estado, r.business_name, 'debió enviarse el 01/' || to_char(v_hoy, 'MM')), v_link) IS NOT NULL THEN n := n + 1; END IF;
    END IF;
  END LOOP;
  RETURN n;
EXCEPTION WHEN OTHERS THEN RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.lease_envio_recordatorio(date) FROM PUBLIC, anon, authenticated;

-- Todos los días 08:05 (Lima = UTC-5): el día 1 avisa y desde el día 3 recuerda las pendientes
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN PERFORM cron.unschedule('lease-envio-mensual'); EXCEPTION WHEN OTHERS THEN NULL; END;
    PERFORM cron.schedule('lease-envio-mensual', '5 13 * * *', $cron$SELECT public.lease_envio_recordatorio()$cron$);
  END IF;
END $$;

-- Aviso inmediato de lo que ya está pendiente (setiembre 2026)
SELECT public.lease_envio_recordatorio();

NOTIFY pgrst, 'reload schema';
COMMIT;
