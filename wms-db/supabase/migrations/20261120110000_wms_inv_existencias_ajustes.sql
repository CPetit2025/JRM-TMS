-- Inventario · Fase 3: ubicación por paquete, bloqueo/cuarentena, existencias (físico, reservado, bloqueado, disponible),
-- conteo ciego y ajustes autorizados (decisiones del 20-11-2026: el Analista solicita, Jefatura autoriza; tolerancia 0).
--  · Un traslado de ubicación no cambia la existencia: solo mueve el paquete y deja el evento MOVE con origen y destino.
--  · Un paquete bloqueado o en cuarentena no se puede tomar en picking ni cargar (trigger), aunque esté físicamente.
--  · Disponible = físico − reservado (en una tarea) − bloqueado, sin restar dos veces: cada paquete cae en un solo grupo.
--  · Conteo ciego: mientras la campaña está EN_CONTEO, quien solo cuenta no ve el stock esperado ni la diferencia.
--  · Un ajuste nace de una diferencia de conteo; lo solicita Inventario y lo autoriza supervisión (nunca quien lo pidió).
--    El WMS no modifica el saldo del ERP: el ajuste autorizado queda pendiente de registro en el ERP con su referencia.

-- 1. Ubicaciones
CREATE UNIQUE INDEX IF NOT EXISTS wh_locations_site_code_key ON public.wh_locations(site_id, code);
CREATE INDEX IF NOT EXISTS wh_packages_location_idx ON public.wh_packages(location_id);
CREATE OR REPLACE FUNCTION public.wh_location_save(p_code text, p_label text, p_zone text DEFAULT NULL, p_active boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_code text := upper(btrim(coalesce(p_code, ''))); v_site uuid; v_id uuid;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-supervisor','almacen-inventario']) THEN RAISE EXCEPTION 'Solo supervisión o Inventario configuran ubicaciones' USING ERRCODE = '42501'; END IF;
  IF v_code !~ '^[A-Z0-9][A-Z0-9_.-]{0,29}$' THEN RAISE EXCEPTION 'Código no válido (letras, números, guion, punto; hasta 30)'; END IF;
  SELECT s.id INTO v_site FROM public.sites s WHERE public.can_access_site(s.id) ORDER BY (s.code = 'PRINCIPAL') DESC, s.code LIMIT 1;
  IF v_site IS NULL THEN RAISE EXCEPTION 'Sin sede disponible'; END IF;
  INSERT INTO public.wh_locations(site_id, code, label, zone, active) VALUES (v_site, v_code, coalesce(nullif(btrim(p_label), ''), v_code), nullif(upper(btrim(p_zone)), ''), coalesce(p_active, true))
  ON CONFLICT (site_id, code) DO UPDATE SET label = EXCLUDED.label, zone = EXCLUDED.zone, active = EXCLUDED.active
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'code', v_code);
END $$;

-- Ubicar o mover un paquete (o todos los de un LPN) escaneando su código
CREATE OR REPLACE FUNCTION public.wh_package_locate(p_code text, p_location_code text, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE loc public.wh_locations%ROWTYPE; v_ids uuid[]; v_n int;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-supervisor','almacen-inventario','almacen-etiquetado','almacen-carga','almacen-picking','almacen-packing']) THEN RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501'; END IF;
  SELECT array_agg(p.id) INTO v_ids FROM public.wh_packages p
  WHERE p.status <> 'VOID' AND p.status <> 'LOADED' AND public.can_access_site(p.site_id)
    AND (upper(p.package_code) = upper(btrim(p_code)) OR p.lpn_id = (SELECT l.id FROM public.wh_lpns l WHERE upper(l.lpn_code) = upper(btrim(p_code)) AND l.status <> 'VOID' LIMIT 1));
  IF v_ids IS NULL THEN RAISE EXCEPTION 'Código desconocido: no es un paquete ni un LPN vigente del almacén'; END IF;
  SELECT * INTO loc FROM public.wh_locations WHERE upper(code) = upper(btrim(p_location_code)) AND active AND public.can_access_site(site_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'Ubicación no disponible'; END IF;
  INSERT INTO public.wh_scan_events(site_id, package_id, event_type, scanned_code, payload, operator_id, client_event_id)
  SELECT p.site_id, p.id, 'MOVE', p.package_code, jsonb_build_object('from', (SELECT code FROM public.wh_locations WHERE id = p.location_id), 'to', loc.code, 'reason', nullif(btrim(p_reason), '')), auth.uid(), gen_random_uuid()
  FROM public.wh_packages p WHERE p.id = ANY (v_ids) AND p.location_id IS DISTINCT FROM loc.id;
  UPDATE public.wh_packages SET location_id = loc.id, updated_at = now() WHERE id = ANY (v_ids) AND location_id IS DISTINCT FROM loc.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('moved', v_n, 'packages', array_length(v_ids, 1), 'location', loc.code);
END $$;

-- 2. Bloqueo y cuarentena
ALTER TABLE public.wh_packages ADD COLUMN IF NOT EXISTS hold_status text, ADD COLUMN IF NOT EXISTS hold_reason text, ADD COLUMN IF NOT EXISTS hold_by uuid REFERENCES public.profiles(id), ADD COLUMN IF NOT EXISTS hold_at timestamptz;
ALTER TABLE public.wh_packages DROP CONSTRAINT IF EXISTS wh_packages_hold_status_check;
ALTER TABLE public.wh_packages ADD CONSTRAINT wh_packages_hold_status_check CHECK (hold_status IS NULL OR hold_status IN ('BLOQUEADO','CUARENTENA'));
CREATE INDEX IF NOT EXISTS wh_packages_hold_by_idx ON public.wh_packages(hold_by);
CREATE OR REPLACE FUNCTION wms_private.wh_packages_hold_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hold_status IS NOT NULL AND (NEW.status IN ('RESERVED','PICKED','PACKED','LOADED') AND NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION 'El paquete % está %: no se puede tomar ni cargar hasta liberarlo', NEW.package_code, lower(NEW.hold_status);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS wh_packages_hold_guard ON public.wh_packages;
CREATE TRIGGER wh_packages_hold_guard BEFORE UPDATE OF status ON public.wh_packages FOR EACH ROW EXECUTE FUNCTION wms_private.wh_packages_hold_guard();

CREATE OR REPLACE FUNCTION public.wh_package_hold(p_code text, p_status text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p public.wh_packages%ROWTYPE; v_status text := nullif(upper(btrim(coalesce(p_status, ''))), '');
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-supervisor','almacen-inventario']) THEN RAISE EXCEPTION 'Solo supervisión o Inventario bloquean o liberan' USING ERRCODE = '42501'; END IF;
  IF nullif(btrim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'Indique el motivo'; END IF;
  IF v_status IS NOT NULL AND v_status NOT IN ('BLOQUEADO','CUARENTENA') THEN RAISE EXCEPTION 'Estado no válido'; END IF;
  SELECT * INTO p FROM public.wh_packages WHERE upper(package_code) = upper(btrim(p_code)) AND status <> 'VOID' AND public.can_access_site(site_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Paquete desconocido'; END IF;
  IF v_status IS NOT NULL AND p.status IN ('PICKED','PACKED','LOADED') THEN RAISE EXCEPTION 'El paquete ya está en preparación o cargado: registre un hallazgo en Auditoría'; END IF;
  -- Un paquete en cuarentena por un retorno se libera solo con la verificación de su disposición
  IF v_status IS NULL AND p.source_kind = 'RETORNO' AND p.hold_status = 'CUARENTENA' THEN RAISE EXCEPTION 'Material retornado: se libera al verificar su disposición en Devoluciones'; END IF;
  UPDATE public.wh_packages SET hold_status = v_status, hold_reason = btrim(p_reason), hold_by = auth.uid(), hold_at = now(), updated_at = now() WHERE id = p.id;
  INSERT INTO public.wh_scan_events(site_id, package_id, event_type, scanned_code, payload, operator_id, client_event_id)
  VALUES (p.site_id, p.id, CASE WHEN v_status IS NULL THEN 'RELEASE' ELSE 'HOLD' END, p.package_code, jsonb_build_object('from', p.hold_status, 'to', v_status, 'reason', btrim(p_reason)), auth.uid(), gen_random_uuid());
  RETURN jsonb_build_object('package_code', p.package_code, 'hold_status', v_status);
END $$;

-- 3. Existencias del WMS por producto, lote, ubicación y condición
CREATE OR REPLACE FUNCTION public.wh_stock_query(p_search text DEFAULT NULL, p_location text DEFAULT NULL, p_view text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_q text := nullif(upper(btrim(p_search)), '');
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_any_warehouse_permission() THEN RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object('rows', coalesce((SELECT jsonb_agg(x ORDER BY x->>'producto', x->>'lote', x->>'ubicacion') FROM (
    SELECT jsonb_build_object('producto', p.source_product_code, 'descripcion', max(p.description), 'lote', p.source_lot, 'ot', max(p.source_contract_code),
      'bodega', p.source_warehouse, 'ubicacion', coalesce(l.code, 'SIN UBICACIÓN'), 'unidad', max(public.inv_unit_norm(coalesce(p.unit, p.source_unit))),
      'paquetes', count(*), 'fisico', sum(p.quantity),
      'reservado', coalesce(sum(p.quantity) FILTER (WHERE p.hold_status IS NULL AND (p.task_id IS NOT NULL OR p.status <> 'AVAILABLE')), 0),
      'bloqueado', coalesce(sum(p.quantity) FILTER (WHERE p.hold_status IS NOT NULL OR p.count_hold), 0),
      'disponible', coalesce(sum(p.quantity) FILTER (WHERE p.hold_status IS NULL AND NOT p.count_hold AND p.task_id IS NULL AND p.status = 'AVAILABLE'), 0),
      'cuarentena', count(*) FILTER (WHERE p.hold_status = 'CUARENTENA'), 'retorno', count(*) FILTER (WHERE p.source_kind = 'RETORNO'),
      'kg', sum(w.kg), 'sin_peso', count(*) FILTER (WHERE w.kg IS NULL), 'peso_estado', min(w.estado),
      'actualizado', max(p.updated_at)) x
    FROM public.wh_packages p LEFT JOIN public.wh_locations l ON l.id = p.location_id CROSS JOIN LATERAL public.wh_package_weight(p) w
    WHERE p.status NOT IN ('VOID','LOADED') AND public.can_access_site(p.site_id)
      AND (v_q IS NULL OR upper(p.source_product_code) LIKE '%' || v_q || '%' OR upper(p.source_lot) LIKE '%' || v_q || '%' OR upper(p.description) LIKE '%' || v_q || '%' OR upper(p.package_code) = v_q)
      AND (nullif(btrim(p_location), '') IS NULL OR l.code = upper(btrim(p_location)) OR (upper(btrim(p_location)) = 'SIN' AND l.id IS NULL))
      AND (nullif(p_view, '') IS NULL OR (p_view = 'BLOQUEADO' AND (p.hold_status IS NOT NULL OR p.count_hold)) OR (p_view = 'RETORNO' AND p.source_kind = 'RETORNO')
           OR (p_view = 'DISPONIBLE' AND p.hold_status IS NULL AND NOT p.count_hold AND p.task_id IS NULL AND p.status = 'AVAILABLE'))
    GROUP BY p.source_product_code, p.source_lot, p.source_warehouse, coalesce(l.code, 'SIN UBICACIÓN')
    LIMIT 1000) s), '[]'::jsonb),
    'regla', 'Disponible = físico − reservado (en tarea) − bloqueado (bloqueo, cuarentena o conteo); cada paquete cae en un solo grupo');
END $$;

-- 4. Conteo ciego: quien solo cuenta no ve el esperado ni la diferencia mientras la campaña está en conteo
ALTER FUNCTION public.wh_count_summary(uuid) RENAME TO wh_count_summary_full;
ALTER FUNCTION public.wh_count_expected_search(uuid, text) RENAME TO wh_count_expected_search_full;
REVOKE ALL ON FUNCTION public.wh_count_summary_full(uuid), public.wh_count_expected_search_full(uuid, text) FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE FUNCTION public.wh_count_blind(p_campaign uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.wh_count_campaigns c WHERE c.id = p_campaign AND c.status = 'EN_CONTEO')
     AND NOT public.wh_has_permission(ARRAY['almacen-supervisor','almacen-inventario'])
$$;
CREATE OR REPLACE FUNCTION public.wh_count_summary(p_campaign uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v jsonb := public.wh_count_summary_full(p_campaign);
BEGIN
  IF NOT public.wh_count_blind(p_campaign) THEN RETURN v; END IF;
  RETURN coalesce((SELECT jsonb_agg(e - 'expected' - 'diff' - 'result' || jsonb_build_object('expected', NULL, 'diff', NULL, 'result', 'CIEGO')) FROM jsonb_array_elements(v) e), '[]'::jsonb);
END $$;
CREATE OR REPLACE FUNCTION public.wh_count_expected_search(p_campaign uuid, p_search text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v jsonb := public.wh_count_expected_search_full(p_campaign, p_search);
BEGIN
  IF NOT public.wh_count_blind(p_campaign) THEN RETURN v; END IF;
  RETURN coalesce((SELECT jsonb_agg(e || jsonb_build_object('stock', NULL, 'counted', NULL, 'contract_qty', NULL)) FROM jsonb_array_elements(v) e), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.wh_count_blind(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wh_count_summary(uuid), public.wh_count_expected_search(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_count_summary(uuid), public.wh_count_expected_search(uuid, text) TO authenticated;

-- 5. Ajustes por diferencia de conteo
CREATE SEQUENCE IF NOT EXISTS public.wh_adjustments_seq;
CREATE TABLE IF NOT EXISTS public.wh_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE DEFAULT 'AJ-' || lpad(nextval('public.wh_adjustments_seq')::text, 6, '0'),
  site_id uuid NOT NULL REFERENCES public.sites(id),
  campaign_id uuid NOT NULL REFERENCES public.wh_count_campaigns(id),
  cod_producto text NOT NULL, lote_key text NOT NULL, ot text,
  expected_qty numeric NOT NULL, counted_qty numeric NOT NULL, diff_qty numeric NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 10),
  cause text,
  evidence_paths text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'SOLICITADO' CHECK (status IN ('SOLICITADO','AUTORIZADO','RECHAZADO','REGISTRADO_ERP')),
  requested_by uuid NOT NULL REFERENCES public.profiles(id), requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES public.profiles(id), decided_at timestamptz, decision_comment text,
  erp_ref text, erp_registered_by uuid REFERENCES public.profiles(id), erp_registered_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS wh_adjustments_one_live ON public.wh_adjustments(campaign_id, cod_producto, lote_key) WHERE status IN ('SOLICITADO','AUTORIZADO','REGISTRADO_ERP');
CREATE INDEX IF NOT EXISTS wh_adjustments_site_idx ON public.wh_adjustments(site_id);
CREATE INDEX IF NOT EXISTS wh_adjustments_requested_by_idx ON public.wh_adjustments(requested_by);
CREATE INDEX IF NOT EXISTS wh_adjustments_decided_by_idx ON public.wh_adjustments(decided_by);
CREATE INDEX IF NOT EXISTS wh_adjustments_erp_registered_by_idx ON public.wh_adjustments(erp_registered_by);
ALTER TABLE public.wh_adjustments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wh_adjustments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.wh_adjustments_seq FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS security_active_account ON public.wh_adjustments;
CREATE POLICY security_active_account ON public.wh_adjustments AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));

CREATE OR REPLACE FUNCTION public.wh_adjustment_request(p_campaign uuid, p_product text, p_lote_key text, p_reason text, p_cause text DEFAULT NULL, p_evidence_paths text[] DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c public.wh_count_campaigns%ROWTYPE; r jsonb; v_id uuid; v_code text;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-inventario','almacen-supervisor']) THEN RAISE EXCEPTION 'Solo Inventario solicita ajustes' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM public.wh_count_campaigns WHERE id = p_campaign AND public.can_access_site(site_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'Campaña no disponible'; END IF;
  IF c.status NOT IN ('EN_REVISION','CERRADA') THEN RAISE EXCEPTION 'El ajuste se solicita con la campaña en revisión o cerrada'; END IF;
  SELECT e INTO r FROM jsonb_array_elements(public.wh_count_summary_full(p_campaign)) e WHERE e->>'cod_producto' = p_product AND e->>'lote_key' = p_lote_key;
  IF r IS NULL THEN RAISE EXCEPTION 'Producto y lote no figuran en la campaña'; END IF;
  IF (r->>'diff')::numeric = 0 THEN RAISE EXCEPTION 'Sin diferencia: no corresponde ajuste'; END IF;
  INSERT INTO public.wh_adjustments(site_id, campaign_id, cod_producto, lote_key, ot, expected_qty, counted_qty, diff_qty, reason, cause, evidence_paths, requested_by)
  VALUES (c.site_id, c.id, p_product, p_lote_key, r->>'ot', (r->>'expected')::numeric, (r->>'counted')::numeric, (r->>'diff')::numeric, btrim(p_reason), nullif(btrim(p_cause), ''), coalesce(p_evidence_paths, '{}'), auth.uid())
  RETURNING id, code INTO v_id, v_code;
  RETURN jsonb_build_object('id', v_id, 'code', v_code);
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'Ya hay un ajuste vigente para ese producto y lote en la campaña';
END $$;

-- APPROVE / REJECT (supervisión, nunca quien solicitó) · ERP (registro en el ERP con su referencia)
CREATE OR REPLACE FUNCTION public.wh_adjustment_decide(p_id uuid, p_action text, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.wh_adjustments%ROWTYPE; v_action text := upper(btrim(p_action)); v_c text := nullif(btrim(p_comment), '');
BEGIN
  PERFORM public.security_assert_active_session();
  SELECT * INTO a FROM public.wh_adjustments WHERE id = p_id AND public.can_access_site(site_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ajuste no disponible'; END IF;
  IF v_action IN ('APPROVE','REJECT') THEN
    IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN RAISE EXCEPTION 'Solo Jefatura (supervisión) autoriza ajustes' USING ERRCODE = '42501'; END IF;
    IF a.status <> 'SOLICITADO' THEN RAISE EXCEPTION 'El ajuste ya fue decidido'; END IF;
    IF a.requested_by = auth.uid() THEN RAISE EXCEPTION 'Nadie autoriza el ajuste que solicitó'; END IF;
    IF v_action = 'REJECT' AND v_c IS NULL THEN RAISE EXCEPTION 'Indique el motivo del rechazo'; END IF;
    UPDATE public.wh_adjustments SET status = CASE WHEN v_action = 'APPROVE' THEN 'AUTORIZADO' ELSE 'RECHAZADO' END, decided_by = auth.uid(), decided_at = now(), decision_comment = v_c WHERE id = a.id;
  ELSIF v_action = 'ERP' THEN
    IF NOT public.wh_has_permission(ARRAY['almacen-inventario','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501'; END IF;
    IF a.status <> 'AUTORIZADO' THEN RAISE EXCEPTION 'Solo se registra en el ERP un ajuste autorizado'; END IF;
    IF v_c IS NULL THEN RAISE EXCEPTION 'Indique el documento del ERP'; END IF;
    UPDATE public.wh_adjustments SET status = 'REGISTRADO_ERP', erp_ref = v_c, erp_registered_by = auth.uid(), erp_registered_at = now() WHERE id = a.id;
  ELSE RAISE EXCEPTION 'Acción no reconocida';
  END IF;
  RETURN jsonb_build_object('id', a.id, 'status', (SELECT status FROM public.wh_adjustments WHERE id = a.id));
END $$;

CREATE OR REPLACE FUNCTION public.wh_adjustments_list(p_status text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-inventario','almacen-supervisor','almacen-lectura']) THEN RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object('adjustments', coalesce((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'code', a.code, 'campaign', c.code, 'bodega', c.bodega, 'producto', a.cod_producto,
      'lote', a.lote_key, 'ot', a.ot, 'esperado', a.expected_qty, 'contado', a.counted_qty, 'diferencia', a.diff_qty, 'motivo', a.reason, 'causa', a.cause, 'estado', a.status,
      'solicito', public.wh_profile_name(a.requested_by), 'solicito_id', a.requested_by, 'solicitado', a.requested_at, 'decidio', public.wh_profile_name(a.decided_by), 'decidido', a.decided_at,
      'comentario', a.decision_comment, 'erp_ref', a.erp_ref) ORDER BY a.requested_at DESC)
    FROM public.wh_adjustments a JOIN public.wh_count_campaigns c ON c.id = a.campaign_id
    WHERE public.can_access_site(a.site_id) AND (p_status IS NULL OR a.status = p_status)), '[]'::jsonb),
    'diferencias', coalesce((SELECT jsonb_agg(jsonb_build_object('campaign_id', c.id, 'campaign', c.code, 'bodega', c.bodega, 'estado_campana', c.status,
        'producto', e->>'cod_producto', 'lote', e->>'lote_key', 'ot', e->>'ot', 'descripcion', e->>'producto', 'esperado', (e->>'expected')::numeric, 'contado', (e->>'counted')::numeric,
        'diferencia', (e->>'diff')::numeric, 'resultado', e->>'result',
        'ajuste', (SELECT a.code FROM public.wh_adjustments a WHERE a.campaign_id = c.id AND a.cod_producto = e->>'cod_producto' AND a.lote_key = e->>'lote_key' AND a.status <> 'RECHAZADO' LIMIT 1)))
      FROM public.wh_count_campaigns c CROSS JOIN LATERAL jsonb_array_elements(public.wh_count_summary_full(c.id)) e
      WHERE public.can_access_site(c.site_id) AND c.status IN ('EN_REVISION','CERRADA') AND c.created_at > now() - interval '120 days' AND (e->>'diff')::numeric <> 0), '[]'::jsonb));
END $$;

REVOKE ALL ON FUNCTION public.wh_location_save(text, text, text, boolean), public.wh_package_locate(text, text, text), public.wh_package_hold(text, text, text),
  public.wh_stock_query(text, text, text), public.wh_adjustment_request(uuid, text, text, text, text, text[]), public.wh_adjustment_decide(uuid, text, text),
  public.wh_adjustments_list(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_location_save(text, text, text, boolean), public.wh_package_locate(text, text, text), public.wh_package_hold(text, text, text),
  public.wh_stock_query(text, text, text), public.wh_adjustment_request(uuid, text, text, text, text, text[]), public.wh_adjustment_decide(uuid, text, text),
  public.wh_adjustments_list(text) TO authenticated;
