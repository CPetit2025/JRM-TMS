-- ============================================================
-- CAJA DE TRANSPORTE — C4: el conductor solicita anticipos desde la app
-- ============================================================
-- Antes solo Caja (permiso caja-anticipos) podía solicitar un anticipo. Ahora el conductor lo pide
-- para su viaje desde la app con monto, desglose y motivo; la solicitud entra a /caja/anticipos y la
-- entrega o anulación sigue en Caja (deliver_trip_advance / cancel_trip_advance). (docs/caja/04-c4-anticipos-desde-app.md)
BEGIN;

ALTER TABLE public.trip_advances
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'CAJA',
  ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE public.trip_advances DROP CONSTRAINT IF EXISTS trip_advances_source_check;
ALTER TABLE public.trip_advances ADD CONSTRAINT trip_advances_source_check CHECK (source IN ('CAJA', 'APP'));

CREATE OR REPLACE FUNCTION public.request_trip_advance_from_app(
  p_dispatch_id uuid, p_amount numeric, p_reason text, p_breakdown jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d      record;
  v_over text;
  v_id   uuid;
  v_code text;
BEGIN
  SELECT x.id, x.driver_id, x.status INTO d FROM public.dispatches x
  WHERE x.id = p_dispatch_id
    AND EXISTS (SELECT 1 FROM public.drivers dr WHERE dr.id = x.driver_id AND dr.profile_id = auth.uid());
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Solo puede solicitar anticipos para un viaje asignado a usted'); END IF;
  IF d.status NOT IN ('PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'El viaje ya no está en curso (' || d.status || ')');
  END IF;
  IF public.caja_trip_is_settled(p_dispatch_id) THEN RETURN jsonb_build_object('success', false, 'error', 'El viaje ya fue liquidado'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('success', false, 'error', 'Ingrese un monto mayor a 0'); END IF;
  IF NULLIF(trim(p_reason), '') IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Indique para qué necesita el anticipo'); END IF;
  IF EXISTS (SELECT 1 FROM public.trip_advances WHERE dispatch_id = p_dispatch_id AND status = 'SOLICITADO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Ya tiene una solicitud pendiente para este viaje: espere la respuesta de Caja');
  END IF;
  SELECT string_agg(dispatch_number, ', ') INTO v_over FROM public.caja_driver_overdue_trips(d.driver_id) WHERE dispatch_id <> p_dispatch_id;
  IF v_over IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Tiene rendiciones vencidas (' || v_over || '). Rinda sus gastos antes de pedir otro anticipo.');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each_text(COALESCE(p_breakdown, '{}'::jsonb))
             WHERE key NOT IN ('COMBUSTIBLE', 'PEAJE', 'ALIMENTACION', 'HOSPEDAJE', 'OTROS') OR value !~ '^[0-9]+(\.[0-9]+)?$') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Desglose inválido');
  END IF;
  INSERT INTO public.trip_advances (dispatch_id, driver_id, amount, breakdown, reason, source)
  VALUES (p_dispatch_id, d.driver_id, round(p_amount, 2), COALESCE(p_breakdown, '{}'::jsonb), trim(p_reason), 'APP')
  RETURNING id, code INTO v_id, v_code;
  RETURN jsonb_build_object('success', true, 'advance_id', v_id, 'code', v_code);
END $$;

-- El conductor retira su propia solicitud mientras Caja no la haya entregado
CREATE OR REPLACE FUNCTION public.withdraw_trip_advance_request(p_advance_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.trip_advances a SET status = 'ANULADO', cancelled_by = auth.uid(), cancel_reason = 'Retirada por el conductor'
  WHERE a.id = p_advance_id AND a.status = 'SOLICITADO' AND a.source = 'APP'
    AND EXISTS (SELECT 1 FROM public.drivers dr WHERE dr.id = a.driver_id AND dr.profile_id = auth.uid());
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'No hay una solicitud suya pendiente con ese código'); END IF;
  RETURN jsonb_build_object('success', true);
END $$;

REVOKE ALL ON FUNCTION public.request_trip_advance_from_app(uuid, numeric, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.withdraw_trip_advance_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_trip_advance_from_app(uuid, numeric, text, jsonb), public.withdraw_trip_advance_request(uuid)
  TO authenticated, service_role;

-- Avisos en tiempo real: solicitudes nuevas para Caja y respuesta para el conductor (con RLS)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'trip_advances') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.trip_advances;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
