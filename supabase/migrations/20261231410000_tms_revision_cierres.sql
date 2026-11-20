-- Fase 3a de Transporte (decisión 4 del 20-11-2026): al cerrar un viaje, ninguna solicitud queda sin resolver.
-- Las que no tienen entrega se pasan a una bandeja de revisión; el Supervisor de Transporte las resuelve como
-- entregada (solo con la guía validada, como el avance normal), reprogramada (vuelve a programarse, el día comprometido original no cambia) o anulada.
-- Saneamiento: las solicitudes ASIGNADA o EN TRANSITO en viajes ya cerrados entran a la bandeja (ninguna tiene conformidad validada).

CREATE TABLE IF NOT EXISTS public.transport_request_reviews (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES public.transport_requests(id) ON DELETE CASCADE,
  dispatch_id uuid NOT NULL REFERENCES public.dispatches(id) ON DELETE CASCADE,
  site_id uuid,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'PENDIENTE' CHECK (status IN ('PENDIENTE','RESUELTA')),
  resolution text CHECK (resolution IS NULL OR resolution IN ('ENTREGADA','REPROGRAMADA','ANULADA')),
  note text,
  resolved_by uuid REFERENCES public.profiles(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, dispatch_id)
);
CREATE INDEX IF NOT EXISTS transport_request_reviews_dispatch_idx ON public.transport_request_reviews(dispatch_id);
CREATE INDEX IF NOT EXISTS transport_request_reviews_resolved_by_idx ON public.transport_request_reviews(resolved_by);
CREATE INDEX IF NOT EXISTS transport_request_reviews_pending_idx ON public.transport_request_reviews(status) WHERE status = 'PENDIENTE';
ALTER TABLE public.transport_request_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.transport_request_reviews FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.transport_request_reviews TO authenticated;
DROP POLICY IF EXISTS transport_request_reviews_read ON public.transport_request_reviews;
CREATE POLICY transport_request_reviews_read ON public.transport_request_reviews FOR SELECT TO authenticated
  USING (public.can_access_site(site_id) AND (public.has_tms_permission('despacho') OR public.delivery_can_review(dispatch_id)));
DROP POLICY IF EXISTS security_active_account ON public.transport_request_reviews;
CREATE POLICY security_active_account ON public.transport_request_reviews AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));

-- Pasa a la bandeja las solicitudes del viaje que no están entregadas ni anuladas
CREATE OR REPLACE FUNCTION public.transport_request_reviews_enqueue(p_dispatch uuid, p_reason text)
RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH ins AS (
    INSERT INTO public.transport_request_reviews(request_id, dispatch_id, site_id, reason)
    SELECT t.id, r.dispatch_id, coalesce(t.site_id, d.site_id), p_reason
    FROM public.dispatch_requests r JOIN public.transport_requests t ON t.id = r.transport_request_id JOIN public.dispatches d ON d.id = r.dispatch_id
    WHERE r.dispatch_id = p_dispatch AND upper(coalesce(t.status, '')) NOT IN ('ENTREGADA', 'CANCELADA', 'RECHAZADA', 'REPROGRAMADA')
    ON CONFLICT (request_id, dispatch_id) DO NOTHING RETURNING 1)
  SELECT count(*)::int FROM ins
$$;
REVOKE ALL ON FUNCTION public.transport_request_reviews_enqueue(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.dispatch_close_enqueue_reviews()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.transport_request_reviews_enqueue(NEW.id, 'Viaje cerrado sin entrega registrada');
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS dispatch_close_enqueue_reviews ON public.dispatches;
CREATE TRIGGER dispatch_close_enqueue_reviews AFTER UPDATE OF status ON public.dispatches
  FOR EACH ROW WHEN (NEW.status = 'CIERRE_OPERATIVO' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.dispatch_close_enqueue_reviews();

-- Si la entrega se valida después (conformidad), la revisión pendiente se resuelve sola
CREATE OR REPLACE FUNCTION public.transport_request_reviews_autoresolve()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.transport_request_reviews SET status = 'RESUELTA', resolution = 'ENTREGADA', note = coalesce(note, 'Entrega registrada después del cierre'),
    resolved_at = now(), resolved_by = auth.uid()
  WHERE request_id = NEW.id AND status = 'PENDIENTE';
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS transport_request_reviews_autoresolve ON public.transport_requests;
CREATE TRIGGER transport_request_reviews_autoresolve AFTER UPDATE OF status ON public.transport_requests
  FOR EACH ROW WHEN (NEW.status = 'ENTREGADA' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.transport_request_reviews_autoresolve();

-- Bandeja (con el contexto que necesita el Supervisor para decidir)
CREATE OR REPLACE FUNCTION public.transport_request_reviews_list(p_status text DEFAULT 'PENDIENTE')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.security_assert_active_session();
  RETURN coalesce((SELECT jsonb_agg(x ORDER BY x.cerrado DESC NULLS LAST, x.id) FROM (
    SELECT v.id, v.status, v.resolution, v.note, v.reason, v.created_at, v.resolved_at, public.kpi_eq_nombre(v.resolved_by) AS resolvio,
      t.id AS request_id, t.request_number, t.request_type, t.status AS request_status, t.delivery_address, t.committed_date,
      (t.required_date AT TIME ZONE 'America/Lima')::date AS required_date, t.estimated_weight,
      d.id AS dispatch_id, d.dispatch_number, d.vehicle_plate, d.driver_name, d.modalidad, d.operational_closed_at AS cerrado,
      (SELECT c.state FROM public.delivery_conformities c WHERE c.dispatch_id = v.dispatch_id AND c.request_id = v.request_id) AS conformidad,
      (SELECT c.arrived_at FROM public.delivery_conformities c WHERE c.dispatch_id = v.dispatch_id AND c.request_id = v.request_id) AS llegada,
      public.delivery_can_review(v.dispatch_id) AS puede_resolver
    FROM public.transport_request_reviews v JOIN public.transport_requests t ON t.id = v.request_id JOIN public.dispatches d ON d.id = v.dispatch_id
    WHERE public.can_access_site(v.site_id) AND (public.has_tms_permission('despacho') OR public.delivery_can_review(v.dispatch_id))
      AND (p_status IS NULL OR v.status = p_status)
    LIMIT 500) x), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.transport_request_reviews_list(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transport_request_reviews_list(text) TO authenticated;

-- Resolver: ENTREGADA (motivo obligatorio, sin conformidad), REPROGRAMADA (nueva fecha y causa) o ANULADA (motivo)
CREATE OR REPLACE FUNCTION public.transport_request_review_resolve(p_id bigint, p_resolution text, p_note text,
  p_required_at timestamptz DEFAULT NULL, p_causa text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v public.transport_request_reviews%ROWTYPE; v_res text := upper(btrim(coalesce(p_resolution, ''))); v_note text := nullif(btrim(p_note), ''); v_prev date;
BEGIN
  PERFORM public.security_assert_active_session();
  SELECT * INTO v FROM public.transport_request_reviews WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(v.site_id) THEN RAISE EXCEPTION 'Revisión no disponible'; END IF;
  IF NOT public.delivery_can_review(v.dispatch_id) THEN RAISE EXCEPTION 'Solo el Supervisor de Transporte resuelve la revisión' USING ERRCODE = '42501'; END IF;
  IF v.status <> 'PENDIENTE' THEN RAISE EXCEPTION 'La revisión ya fue resuelta'; END IF;
  IF v_res NOT IN ('ENTREGADA','REPROGRAMADA','ANULADA') THEN RAISE EXCEPTION 'Elija entregada, reprogramada o anulada'; END IF;
  IF length(coalesce(v_note, '')) < 10 THEN RAISE EXCEPTION 'Explique la resolución (al menos 10 caracteres)'; END IF;
  IF v_res = 'ENTREGADA' THEN
    -- Misma regla que el avance normal (delivery_guard_advance): sin guía aprobada no hay entrega
    IF NOT EXISTS (SELECT 1 FROM public.delivery_conformities c WHERE c.dispatch_id = v.dispatch_id AND c.request_id = v.request_id AND c.state = 'VALIDADA') THEN
      RAISE EXCEPTION 'Para darla por entregada, valide primero la guía firmada en Documentos de Despacho';
    END IF;
    UPDATE public.transport_requests SET status = 'ENTREGADA', updated_at = now() WHERE id = v.request_id;
  ELSIF v_res = 'REPROGRAMADA' THEN
    -- El viaje ya cerró sin atender la parada: la solicitud vuelve a programarse (el día comprometido original no cambia)
    IF p_required_at IS NULL OR p_required_at < now() - interval '1 day' THEN RAISE EXCEPTION 'Indique la nueva fecha y hora de atención'; END IF;
    IF upper(btrim(coalesce(p_causa, ''))) NOT IN ('CLIENTE','ALMACEN_SIN_STOCK','PRODUCCION','SIN_UNIDAD','SIN_CONDUCTOR','VIA_CLIMA','DOCUMENTOS','OTRO') THEN
      RAISE EXCEPTION 'Indique la causa de la reprogramación'; END IF;
    SELECT (required_date AT TIME ZONE 'America/Lima')::date INTO v_prev FROM public.transport_requests WHERE id = v.request_id;
    UPDATE public.transport_requests SET status = 'REPROGRAMADA', required_date = (p_required_at AT TIME ZONE 'America/Lima')::date, required_at = p_required_at, updated_at = now() WHERE id = v.request_id;
    INSERT INTO public.kpi_reprogramaciones(request_id, causa, detalle, fecha_anterior, fecha_nueva, by)
    VALUES (v.request_id, upper(btrim(p_causa)), v_note, v_prev, (p_required_at AT TIME ZONE 'America/Lima')::date, auth.uid());
  ELSE
    UPDATE public.transport_requests SET status = 'CANCELADA', updated_at = now() WHERE id = v.request_id;
  END IF;
  IF v_res <> 'ENTREGADA' THEN
    UPDATE public.dispatch_requests SET status = 'NO_ATENDIDO' WHERE dispatch_id = v.dispatch_id AND transport_request_id = v.request_id;
  END IF;
  UPDATE public.transport_request_reviews SET status = 'RESUELTA', resolution = v_res, note = v_note, resolved_by = auth.uid(), resolved_at = now() WHERE id = v.id;
  INSERT INTO public.transport_request_events(request_id, actor_id, action, previous_state, next_state)
  VALUES (v.request_id, auth.uid(), 'UPDATED', jsonb_build_object('revision_cierre', v.id), jsonb_build_object('resolucion', v_res, 'motivo', v_note));
  RETURN jsonb_build_object('success', true, 'id', v.id, 'resolution', v_res);
END $$;
REVOKE ALL ON FUNCTION public.transport_request_review_resolve(bigint, text, text, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transport_request_review_resolve(bigint, text, text, timestamptz, text) TO authenticated;

-- Saneamiento de los viajes ya cerrados
SELECT public.transport_request_reviews_enqueue(d.id, 'Saneamiento 20-11-2026: viaje cerrado sin entrega registrada')
FROM public.dispatches d WHERE d.status = 'CIERRE_OPERATIVO';
