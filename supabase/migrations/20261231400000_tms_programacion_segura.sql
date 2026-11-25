-- Fase 2 de Transporte (decisiones del 20-11-2026): programación segura.
-- 1. Programar una unidad propia no apta (bloqueada, en mantenimiento, documentos vencidos) o con capacidad excedida se
--    impide en el servidor, no solo en pantalla. Sin excepción para sobrecarga.
-- 2. Fecha comprometida original inmutable: reprogramar ya no mejora la puntualidad (D1 se mide contra el día original).
-- 3. Las solicitudes se guardan como 'EN TRANSITO' (con espacio): dos guardas solo reconocían 'EN_TRANSITO'.

-- 1a. Validación de la unidad y el conductor (misma regla que la pantalla: check_dispatch_eligibility)
CREATE OR REPLACE FUNCTION public.dispatch_assert_eligible(p_vehicle_plate text, p_driver_id uuid, p_required_kg numeric DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r jsonb;
BEGIN
  r := CASE WHEN p_driver_id IS NULL THEN public.check_vehicle_eligibility(p_vehicle_plate, p_required_kg)
            ELSE public.check_dispatch_eligibility(p_vehicle_plate, p_driver_id, p_required_kg) END;
  IF NOT coalesce((r->>'eligible')::boolean, false) THEN
    RAISE EXCEPTION 'No se puede programar: %', (SELECT string_agg(x, '; ') FROM jsonb_array_elements_text(r->'blocking_reasons') x)
      USING ERRCODE = 'P0001';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.dispatch_assert_eligible(text, uuid, numeric) FROM PUBLIC, anon, authenticated;

-- Flota propia con placa real (el recojo por el cliente usa la placa 'EXTERNO' y no aplica)
CREATE OR REPLACE FUNCTION public.dispatch_eligibility_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF coalesce(NEW.modalidad, 'PROPIA') <> 'PROPIA' OR upper(btrim(coalesce(NEW.vehicle_plate, ''))) IN ('', 'EXTERNO') THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM public.dispatch_assert_eligible(NEW.vehicle_plate, NEW.driver_id, NULL);
  ELSIF NEW.vehicle_plate IS DISTINCT FROM OLD.vehicle_plate THEN
    -- Cambio de unidad en una ruta ya cargada: la nueva unidad debe soportar la carga declarada
    PERFORM public.dispatch_assert_eligible(NEW.vehicle_plate, NULL, (SELECT nullif(sum(t.estimated_weight), 0) FROM public.dispatch_requests r
      JOIN public.transport_requests t ON t.id = r.transport_request_id WHERE r.dispatch_id = NEW.id AND t.estimated_weight > 0));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS dispatch_eligibility_guard ON public.dispatches;
CREATE TRIGGER dispatch_eligibility_guard BEFORE INSERT OR UPDATE OF vehicle_plate ON public.dispatches
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_eligibility_guard();

-- 1b. Capacidad: el peso declarado de las solicitudes de la ruta no supera la capacidad registrada de la unidad propia
CREATE OR REPLACE FUNCTION public.dispatch_capacity_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d record; v_kg numeric; v_cap numeric;
BEGIN
  SELECT x.vehicle_plate, x.modalidad, x.status INTO d FROM public.dispatches x WHERE x.id = NEW.dispatch_id;
  IF coalesce(d.modalidad, 'PROPIA') <> 'PROPIA' OR upper(btrim(coalesce(d.vehicle_plate, ''))) IN ('', 'EXTERNO') OR d.status = 'CANCELADO' THEN RETURN NEW; END IF;
  SELECT COALESCE(v.weight_capacity, v.capacity_weight) INTO v_cap FROM public.vehicles v WHERE v.plate = d.vehicle_plate;
  IF v_cap IS NULL OR v_cap <= 0 THEN RETURN NEW; END IF;
  SELECT coalesce(sum(t.estimated_weight), 0) INTO v_kg FROM public.dispatch_requests r JOIN public.transport_requests t ON t.id = r.transport_request_id
  WHERE r.dispatch_id = NEW.dispatch_id AND t.estimated_weight > 0;
  IF v_kg > v_cap THEN
    RAISE EXCEPTION 'No se puede programar: capacidad excedida (% kg declarados para % kg de la unidad %)', round(v_kg), round(v_cap), d.vehicle_plate USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS dispatch_capacity_guard ON public.dispatch_requests;
CREATE CONSTRAINT TRIGGER dispatch_capacity_guard AFTER INSERT ON public.dispatch_requests
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION public.dispatch_capacity_guard();

-- 2. Fecha comprometida original: se fija al crear, se corrige solo antes de aprobar y nunca la cambia una reprogramación
ALTER TABLE public.transport_requests ADD COLUMN IF NOT EXISTS committed_date date;
-- Se fija en la primera aprobación y no se libera aunque la aprobación se revoque al editar
ALTER TABLE public.transport_requests ADD COLUMN IF NOT EXISTS committed_locked_at timestamptz;
-- Carga inicial de una columna nueva: sin disparar las guardas de negocio de la solicitud
ALTER TABLE public.transport_requests DISABLE TRIGGER USER;
UPDATE public.transport_requests t SET committed_date = coalesce(
  (SELECT k.fecha_anterior FROM public.kpi_reprogramaciones k WHERE k.request_id = t.id ORDER BY k.at, k.id LIMIT 1),
  (t.required_date AT TIME ZONE 'America/Lima')::date)
WHERE t.committed_date IS NULL;
UPDATE public.transport_requests SET committed_locked_at = coalesce(approved_at, updated_at, created_at)
WHERE committed_locked_at IS NULL AND (approved_at IS NOT NULL OR upper(coalesce(status, '')) NOT IN ('PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'OBSERVADA', 'RECHAZADA'));
ALTER TABLE public.transport_requests ENABLE TRIGGER USER;
COMMENT ON COLUMN public.transport_requests.committed_date IS 'Día comprometido original (hora de Lima). Inmutable desde la primera aprobación; la puntualidad se mide contra él.';

CREATE OR REPLACE FUNCTION public.transport_request_committed_date()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.committed_date := (NEW.required_date AT TIME ZONE 'America/Lima')::date;
    NEW.committed_locked_at := CASE WHEN NEW.approved_at IS NOT NULL THEN now() END;
  ELSIF OLD.committed_locked_at IS NULL THEN
    NEW.committed_date := (NEW.required_date AT TIME ZONE 'America/Lima')::date;
    NEW.committed_locked_at := CASE WHEN NEW.approved_at IS NOT NULL THEN now() END;
  ELSE
    NEW.committed_date := OLD.committed_date; NEW.committed_locked_at := OLD.committed_locked_at;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS transport_request_committed_date ON public.transport_requests;
CREATE TRIGGER transport_request_committed_date BEFORE INSERT OR UPDATE OF required_date, committed_date, committed_locked_at, status, approved_at ON public.transport_requests
  FOR EACH ROW EXECUTE FUNCTION public.transport_request_committed_date();

-- D1 (entrega a tiempo) contra el día comprometido original (decisión 8: solo el día)
DO $m$
DECLARE def text; a int; b int; seg text;
BEGIN
  def := pg_get_functiondef('public.kpi_eq_filas(text, date, date)'::regprocedure);
  a := position('ELSIF p_codigo = ''D1'' THEN' IN def);
  b := position('ELSIF p_codigo IN (''D2'',''D3'') THEN' IN def);
  IF a = 0 OR b <= a THEN RAISE EXCEPTION 'kpi_eq_filas cambió: revisar esta migración'; END IF;
  seg := substr(def, a, b - a);
  IF position('(t.required_date AT TIME ZONE ''America/Lima'')::date' IN seg) = 0 THEN RAISE EXCEPTION 'D1 cambió: revisar esta migración'; END IF;
  seg := replace(seg, '(t.required_date AT TIME ZONE ''America/Lima'')::date', 'COALESCE(t.committed_date, (t.required_date AT TIME ZONE ''America/Lima'')::date)');
  EXECUTE substr(def, 1, a - 1) || seg || substr(def, b);
END $m$;
UPDATE public.kpi_eq_def SET formula = 'Llegadas hasta el día comprometido original ÷ servicios con llegada o vencidos', updated_at = now(),
  nota_datos = coalesce(nota_datos || ' ', '') || 'Desde el 20-11-2026 se mide contra el día comprometido original: reprogramar no mejora el indicador.'
WHERE codigo = 'D1' AND position('comprometido original' IN coalesce(nota_datos, '')) = 0;

-- 3. 'EN TRANSITO' (como se guarda) también en las guardas de presupuesto y financiamiento por OT
DO $m$
DECLARE f text; def text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.transport_request_budget_sync()', 'public.request_ot_funding_guard()'] LOOP
    def := pg_get_functiondef(f::regprocedure);
    IF position('''EN_TRANSITO''' IN def) = 0 THEN RAISE EXCEPTION '% cambió: revisar esta migración', f; END IF;
    IF position('''EN TRANSITO''' IN def) = 0 THEN EXECUTE replace(def, '''EN_TRANSITO''', '''EN_TRANSITO'',''EN TRANSITO'''); END IF;
  END LOOP;
END $m$;
