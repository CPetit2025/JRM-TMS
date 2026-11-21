-- Fase 4 de Transporte (decisiones 5, 6 y 10 del 20-11-2026).
-- Km del viaje: odómetro con foto obligatorio al iniciar y al volver (unidades propias). El km del viaje es la diferencia
-- de odómetro; el recorrido GPS del teléfono se guarda aparte como control y una diferencia relevante deja el viaje
-- observado. actual_distance_source registra la fuente (ODOMETRO o GPS).
-- Flete de terceros: factura del proveedor con base imponible, IGV y moneda por separado; la base en soles se calcula
-- con el tipo de cambio de la factura. No reemplaza el flete final (provisión): se muestran lado a lado, sin sumarse.
SET LOCAL lock_timeout = '60s';

-- ── Odómetro de salida y llegada ────────────────────────────────────────────────────
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS start_odometer_photo text;
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS start_odometer_at timestamptz;
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS end_odometer_photo text;
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS end_odometer_at timestamptz;
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS gps_distance_km numeric(12,3);
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS km_check text;
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatches_km_check_check') THEN
    ALTER TABLE public.dispatches ADD CONSTRAINT dispatches_km_check_check CHECK (km_check IS NULL OR km_check IN ('COINCIDE','OBSERVADO','SIN_GPS'));
  END IF;
END $c$;
COMMENT ON COLUMN public.dispatches.gps_distance_km IS 'Recorrido GPS del teléfono al cerrar el odómetro (control; el km del viaje es el odómetro).';
COMMENT ON COLUMN public.dispatches.km_check IS 'Control odómetro vs GPS: COINCIDE, OBSERVADO (diferencia > 5 km y > 10 %) o SIN_GPS.';

-- Unidad propia: la que lleva odómetro (terceros y EXTERNO no)
CREATE OR REPLACE FUNCTION public.dispatch_is_own_unit(d public.dispatches)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT d.vehicle_plate IS NOT NULL AND d.vehicle_plate <> 'EXTERNO' AND coalesce(to_jsonb(d)->>'modalidad', 'PROPIA') <> 'TERCERO'
$$;

-- Invariantes del km (se ejecuta después de dispatch_set_odometer_distance por el orden alfabético de los disparadores):
-- 1) una lectura de salida con foto solo cambia junto con su foto (el inicio de ruta no la reemplaza por la del preuso);
-- 2) con salida y llegada con foto, actual_distance_km es el odómetro y cualquier otro valor escrito (GPS) queda como control;
-- 3) al cerrar el viaje con km solo de GPS, se registra la fuente.
CREATE OR REPLACE FUNCTION public.dispatch_km_odometer()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_odo numeric; v_gps numeric;
BEGIN
  IF OLD.start_odometer_photo IS NOT NULL AND NEW.start_odometer_photo IS NOT DISTINCT FROM OLD.start_odometer_photo THEN
    NEW.start_odometer := OLD.start_odometer;
  END IF;
  IF NEW.start_odometer_photo IS NOT NULL AND NEW.end_odometer_photo IS NOT NULL AND NEW.start_odometer IS NOT NULL
     AND NEW.end_odometer IS NOT NULL AND NEW.end_odometer >= NEW.start_odometer THEN
    v_odo := round(NEW.end_odometer - NEW.start_odometer, 3);
    IF OLD.end_odometer_photo IS NULL THEN
      v_gps := NULLIF(OLD.actual_distance_km, 0);  -- producción: 0 por defecto = sin dato
    ELSIF NEW.actual_distance_km IS DISTINCT FROM OLD.actual_distance_km AND NEW.actual_distance_km IS DISTINCT FROM v_odo THEN
      v_gps := NULLIF(NEW.actual_distance_km, 0);
    ELSE
      v_gps := OLD.gps_distance_km;
    END IF;
    NEW.gps_distance_km := v_gps;
    NEW.actual_distance_km := v_odo;
    NEW.actual_distance_source := 'ODOMETRO';
    NEW.km_check := CASE WHEN v_gps IS NULL THEN 'SIN_GPS' WHEN abs(v_odo - v_gps) > greatest(5, 0.10 * v_odo) THEN 'OBSERVADO' ELSE 'COINCIDE' END;
  ELSIF NEW.actual_distance_source IS NULL AND NULLIF(NEW.actual_distance_km, 0) IS NOT NULL
     AND NEW.status IN ('RETORNO_COMPLETADO','CIERRE_OPERATIVO') AND NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.actual_distance_source := 'GPS';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.dispatch_km_odometer() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_dispatch_km_odometer ON public.dispatches;
CREATE TRIGGER zz_dispatch_km_odometer BEFORE UPDATE ON public.dispatches FOR EACH ROW EXECUTE FUNCTION public.dispatch_km_odometer();

-- Odómetro obligatorio para iniciar y para confirmar la llegada a base (solo sesiones de usuario: los procesos
-- automáticos, como el corte diario, y las pruebas no se frenan). Viajes iniciados antes de esta regla no exigen llegada.
CREATE OR REPLACE FUNCTION public.dispatch_odometer_required()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF coalesce(current_setting('role', true), '') NOT IN ('anon','authenticated') OR NOT public.dispatch_is_own_unit(NEW) THEN RETURN NEW; END IF;
  IF OLD.status = 'PROGRAMADO' AND NEW.status IN ('EN RUTA','EN_CURSO') AND NEW.start_odometer_photo IS NULL THEN
    RAISE EXCEPTION 'Registre el odómetro de salida con foto antes de iniciar la ruta';
  END IF;
  IF NEW.status = 'RETORNO_COMPLETADO' AND OLD.status IS DISTINCT FROM NEW.status AND NEW.start_odometer_photo IS NOT NULL AND NEW.end_odometer_photo IS NULL THEN
    RAISE EXCEPTION 'Registre el odómetro de llegada con foto antes de confirmar la llegada a base';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.dispatch_odometer_required() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS dispatch_odometer_required ON public.dispatches;
CREATE TRIGGER dispatch_odometer_required BEFORE UPDATE OF status ON public.dispatches FOR EACH ROW EXECUTE FUNCTION public.dispatch_odometer_required();

-- Registro desde la app: SALIDA (antes de iniciar o en ruta) o LLEGADA (en retorno o ya cerrado). Foto obligatoria.
CREATE OR REPLACE FUNCTION public.dispatch_record_odometer(p_dispatch uuid, p_kind text, p_value numeric, p_photo text, p_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d public.dispatches%ROWTYPE; v_kind text := upper(btrim(coalesce(p_kind, ''))); v numeric := round(p_value, 1);
  v_photo text := NULLIF(btrim(coalesce(p_photo, '')), ''); v_prev numeric; v_at timestamptz;
BEGIN
  SELECT * INTO d FROM public.dispatches WHERE id = p_dispatch FOR UPDATE;
  IF d.id IS NULL OR NOT EXISTS (SELECT 1 FROM public.drivers r WHERE r.id = d.driver_id AND r.profile_id = auth.uid() AND r.is_active) THEN
    RAISE EXCEPTION 'Solo el conductor del viaje registra el odómetro' USING ERRCODE = '42501'; END IF;
  IF NOT public.dispatch_is_own_unit(d) THEN RAISE EXCEPTION 'El odómetro se registra solo en unidades propias'; END IF;
  IF v_kind NOT IN ('SALIDA','LLEGADA') THEN RAISE EXCEPTION 'Indique si es la lectura de salida o de llegada'; END IF;
  IF v IS NULL OR v <= 0 OR v >= 5000000 THEN RAISE EXCEPTION 'Ingrese el odómetro (km) que marca el tablero'; END IF;
  IF v_photo IS NULL OR NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'driver_evidence' AND o.name = v_photo
      AND (storage.foldername(o.name))[1] = auth.uid()::text) THEN
    RAISE EXCEPTION 'Adjunte la foto del tablero con el odómetro'; END IF;
  v_at := public.route_event_time(p_dispatch, p_at);
  IF v_kind = 'SALIDA' THEN
    IF d.status NOT IN ('PROGRAMADO','EN RUTA','EN_CURSO') THEN RAISE EXCEPTION 'La lectura de salida se registra antes o durante la ruta'; END IF;
    IF d.end_odometer_photo IS NOT NULL THEN RAISE EXCEPTION 'El viaje ya tiene lectura de llegada'; END IF;
    -- No retrocede respecto de la última llegada registrada de la misma unidad
    SELECT x.end_odometer INTO v_prev FROM public.dispatches x WHERE x.vehicle_plate = d.vehicle_plate AND x.id <> d.id
      AND x.end_odometer_photo IS NOT NULL AND x.end_odometer_at <= v_at ORDER BY x.end_odometer_at DESC LIMIT 1;
    IF v_prev IS NOT NULL AND v < v_prev THEN RAISE EXCEPTION 'El odómetro (% km) es menor a la llegada del viaje anterior de la unidad (% km)', v, v_prev; END IF;
    UPDATE public.dispatches SET start_odometer = v, start_odometer_photo = v_photo, start_odometer_at = v_at WHERE id = d.id;
  ELSE
    IF d.status NOT IN ('EN RUTA','EN_CURSO','ESPERANDO_AUTORIZACION','RETORNO','RETORNO_COMPLETADO','CIERRE_OPERATIVO','ENTREGADO') THEN
      RAISE EXCEPTION 'La lectura de llegada se registra al volver de la ruta'; END IF;
    IF d.end_odometer_photo IS NOT NULL THEN RETURN jsonb_build_object('success', true, 'already', true); END IF;
    IF d.start_odometer IS NULL THEN RAISE EXCEPTION 'El viaje no tiene odómetro de salida'; END IF;
    IF v < d.start_odometer THEN RAISE EXCEPTION 'El odómetro de llegada (% km) es menor al de salida (% km)', v, d.start_odometer; END IF;
    IF v - d.start_odometer > 3000 THEN RAISE EXCEPTION 'Diferencia de % km entre salida y llegada: revise la lectura', v - d.start_odometer; END IF;
    -- liquidation_data.odometer_photo es la foto que exige dispatch_set_odometer_distance
    UPDATE public.dispatches SET end_odometer = v, end_odometer_photo = v_photo, end_odometer_at = v_at,
      liquidation_data = coalesce(liquidation_data, '{}'::jsonb) || jsonb_build_object('odometer_photo', v_photo) WHERE id = d.id;
  END IF;
  BEGIN UPDATE public.vehicles SET current_odometer = v WHERE plate = d.vehicle_plate AND coalesce(current_odometer, 0) < v;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Odómetro de % sin actualizar: %', d.vehicle_plate, SQLERRM; END;
  SELECT * INTO d FROM public.dispatches WHERE id = p_dispatch;
  RETURN jsonb_build_object('success', true, 'start_odometer', d.start_odometer, 'end_odometer', d.end_odometer,
    'km', CASE WHEN d.actual_distance_source = 'ODOMETRO' THEN d.actual_distance_km END, 'gps_km', d.gps_distance_km, 'km_check', d.km_check);
END $$;
REVOKE ALL ON FUNCTION public.dispatch_record_odometer(uuid, text, numeric, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatch_record_odometer(uuid, text, numeric, text, timestamptz) TO authenticated;

-- ── Factura del flete de terceros ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.dispatch_freight_invoices (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispatch_id uuid NOT NULL REFERENCES public.dispatches(id) ON DELETE CASCADE,
  site_id uuid,
  provider_ruc text NOT NULL CHECK (provider_ruc ~ '^[0-9]{11}$'),
  provider_name text,
  document_series text NOT NULL,
  document_number text NOT NULL,
  issue_date date NOT NULL,
  currency text NOT NULL CHECK (currency IN ('PEN','USD')),
  base_amount numeric(15,2) NOT NULL CHECK (base_amount > 0),
  igv_amount numeric(15,2) NOT NULL CHECK (igv_amount >= 0),
  total_amount numeric(15,2) GENERATED ALWAYS AS (base_amount + igv_amount) STORED,
  exchange_rate numeric(10,4) NOT NULL CHECK (exchange_rate > 0),
  base_pen numeric(15,2) GENERATED ALWAYS AS (round(base_amount * exchange_rate, 2)) STORED,
  voided_at timestamptz,
  void_reason text,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (currency <> 'PEN' OR exchange_rate = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_freight_invoices_doc_uq ON public.dispatch_freight_invoices(provider_ruc, upper(document_series), ltrim(document_number, '0')) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS dispatch_freight_invoices_dispatch_idx ON public.dispatch_freight_invoices(dispatch_id);
CREATE INDEX IF NOT EXISTS dispatch_freight_invoices_created_by_idx ON public.dispatch_freight_invoices(created_by);
ALTER TABLE public.dispatch_freight_invoices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dispatch_freight_invoices FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.dispatch_freight_invoices TO authenticated;
DROP POLICY IF EXISTS dispatch_freight_invoices_read ON public.dispatch_freight_invoices;
CREATE POLICY dispatch_freight_invoices_read ON public.dispatch_freight_invoices FOR SELECT TO authenticated
  USING (public.can_access_site(site_id) AND (public.has_tms_permission('despacho') OR public.has_tms_permission('contratos-servicios') OR public.has_tms_permission('cierre-economico')));
DROP POLICY IF EXISTS security_active_account ON public.dispatch_freight_invoices;
CREATE POLICY security_active_account ON public.dispatch_freight_invoices AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));

CREATE OR REPLACE FUNCTION public.dispatch_freight_invoice_save(p_dispatch uuid, p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d public.dispatches%ROWTYPE; v_cur text := upper(btrim(coalesce(p->>'currency', 'PEN'))); v_rate numeric; v_id bigint;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT (public.has_tms_permission('despacho') OR public.has_tms_permission('contratos-servicios') OR public.has_tms_permission('cierre-economico')) THEN
    RAISE EXCEPTION 'Sin permiso para registrar facturas de flete' USING ERRCODE = '42501'; END IF;
  SELECT * INTO d FROM public.dispatches WHERE id = p_dispatch;
  IF d.id IS NULL OR NOT public.can_access_site(d.site_id) THEN RAISE EXCEPTION 'Viaje no disponible'; END IF;
  IF public.dispatch_is_own_unit(d) THEN RAISE EXCEPTION 'La factura de flete aplica a viajes de terceros'; END IF;
  IF v_cur NOT IN ('PEN','USD') THEN RAISE EXCEPTION 'Moneda no válida'; END IF;
  v_rate := CASE WHEN v_cur = 'PEN' THEN 1 ELSE NULLIF(p->>'exchange_rate', '')::numeric END;
  IF v_rate IS NULL OR v_rate <= 0 OR v_rate > 20 THEN RAISE EXCEPTION 'Indique el tipo de cambio de la factura'; END IF;
  IF coalesce(NULLIF(p->>'issue_date', '')::date, current_date + 1) > (now() AT TIME ZONE 'America/Lima')::date THEN RAISE EXCEPTION 'Indique la fecha de emisión'; END IF;
  IF length(btrim(coalesce(p->>'document_series', ''))) = 0 OR length(btrim(coalesce(p->>'document_number', ''))) = 0 THEN RAISE EXCEPTION 'Indique serie y número de la factura'; END IF;
  INSERT INTO public.dispatch_freight_invoices(dispatch_id, site_id, provider_ruc, provider_name, document_series, document_number, issue_date, currency,
    base_amount, igv_amount, exchange_rate, created_by)
  VALUES (d.id, d.site_id, regexp_replace(coalesce(p->>'provider_ruc', ''), '[^0-9]', '', 'g'), NULLIF(left(btrim(coalesce(p->>'provider_name', '')), 200), ''),
    upper(btrim(p->>'document_series')), btrim(p->>'document_number'), (p->>'issue_date')::date, v_cur,
    round((p->>'base_amount')::numeric, 2), round(coalesce(NULLIF(p->>'igv_amount', '')::numeric, 0), 2), v_rate, auth.uid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', true, 'id', v_id);
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'La factura ya está registrada';
END $$;
REVOKE ALL ON FUNCTION public.dispatch_freight_invoice_save(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatch_freight_invoice_save(uuid, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.dispatch_freight_invoice_void(p_id bigint, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE i public.dispatch_freight_invoices%ROWTYPE;
BEGIN
  PERFORM public.security_assert_active_session();
  SELECT * INTO i FROM public.dispatch_freight_invoices WHERE id = p_id FOR UPDATE;
  IF i.id IS NULL OR NOT public.can_access_site(i.site_id) OR NOT (public.has_tms_permission('despacho') OR public.has_tms_permission('contratos-servicios')
    OR public.has_tms_permission('cierre-economico')) THEN RAISE EXCEPTION 'Factura no disponible' USING ERRCODE = '42501'; END IF;
  IF i.voided_at IS NOT NULL THEN RAISE EXCEPTION 'La factura ya fue anulada'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 5 THEN RAISE EXCEPTION 'Indique el motivo de la anulación'; END IF;
  UPDATE public.dispatch_freight_invoices SET voided_at = now(), void_reason = btrim(p_reason) WHERE id = p_id;
  RETURN jsonb_build_object('success', true);
END $$;
REVOKE ALL ON FUNCTION public.dispatch_freight_invoice_void(bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatch_freight_invoice_void(bigint, text) TO authenticated;

-- Estado del odómetro del viaje para la app y la oficina
CREATE OR REPLACE FUNCTION public.dispatch_odometer_state(p_dispatch uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d public.dispatches%ROWTYPE;
BEGIN
  IF NOT public.delivery_can_read(p_dispatch) THEN RAISE EXCEPTION 'Sin acceso al viaje' USING ERRCODE = '42501'; END IF;
  SELECT * INTO d FROM public.dispatches WHERE id = p_dispatch;
  RETURN jsonb_build_object('own_unit', public.dispatch_is_own_unit(d), 'status', d.status,
    'start_odometer', CASE WHEN d.start_odometer_photo IS NOT NULL THEN d.start_odometer END, 'start_at', d.start_odometer_at,
    'end_odometer', CASE WHEN d.end_odometer_photo IS NOT NULL THEN d.end_odometer END, 'end_at', d.end_odometer_at,
    'km', CASE WHEN d.actual_distance_source = 'ODOMETRO' THEN d.actual_distance_km END, 'gps_km', d.gps_distance_km, 'km_check', d.km_check);
END $$;
REVOKE ALL ON FUNCTION public.dispatch_odometer_state(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatch_odometer_state(uuid) TO authenticated;
