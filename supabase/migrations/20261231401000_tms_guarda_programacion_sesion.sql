-- Incidente del despliegue de la fase 2 (20-11-2026): las guardas de programación también se aplicaban a procesos
-- internos y a las pruebas de caja, que insertan viajes como postgres/service_role (sin sesión de usuario) y ya están
-- fuera del RLS. Igual que security_assert_vehicle, la regla se aplica a las sesiones de usuario (anon/authenticated),
-- que es por donde programa la operación (pantalla, app y RPC).
CREATE OR REPLACE FUNCTION public.dispatch_eligibility_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF current_setting('role', true) NOT IN ('anon', 'authenticated') THEN RETURN NEW; END IF;
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

CREATE OR REPLACE FUNCTION public.dispatch_capacity_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d record; v_kg numeric; v_cap numeric;
BEGIN
  IF current_setting('role', true) NOT IN ('anon', 'authenticated') THEN RETURN NEW; END IF;
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
