-- Contratos con el ERP como fuente de verificación (Actualizable + Stock):
-- 1. Garantía de ventas como tipo de documento hijo de la OT madre, sin partida propia; al registrarla se genera
--    siempre un Error de contrato vinculado, que es el que lleva el transporte y su costo.
-- 2. OT activa: último despacho (ERP o TMS) dentro del umbral (90 días por defecto). Eventos configurables la reactivan
--    (garantía, subcontrato o error nuevos, solicitud en el TMS); un contrato nuevo sin despachos cuenta por su fecha.
--    Es solo una marca y un filtro: no bloquea solicitudes ni libera partidas (reglas comerciales pendientes).
-- 3. Corrección del cliente según el RUC del ERP: si el cliente no existe se registra; se corrigen la OT, su familia y las
--    solicitudes abiertas; las cerradas o en ruta conservan su cliente y solo el Administrador puede aplicarla a ellas.
--    Queda un historial con el valor anterior (reversible) y se avisa al responsable de la OT.
-- 4. Referencia por lote para la lista de Contratos y Registro de Servicios, y alta asistida desde el ERP.
-- Producción no coincide con las migraciones: el RUC del cliente se lee como tax_id o ruc (to_jsonb) y las columnas
-- opcionales de despachos también.
BEGIN;

-- ── Garantía ───────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS garantia_id uuid REFERENCES public.contracts(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.contracts.garantia_id IS 'En un Error de contrato: la garantía que lo originó';
CREATE INDEX IF NOT EXISTS contracts_garantia_idx ON public.contracts (garantia_id) WHERE garantia_id IS NOT NULL;

-- Clave de documento: mayúsculas, sin espacios extra y sin ceros a la izquierda en el correlativo (15304-E01 = 15304-E001)
CREATE OR REPLACE FUNCTION public.erp_doc_key(p text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT regexp_replace(public.erp_key(p), '^([0-9]+)-([A-Z])0*([0-9]+)$', '\1-\2\3');
$$;

-- Siguiente correlativo de Error de la OT, sin chocar con el TMS ni con el ERP
CREATE OR REPLACE FUNCTION public.contract_next_error_code(p_root uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_code text; v_n integer;
BEGIN
  SELECT c.code::text INTO v_code FROM public.contracts c WHERE c.id = p_root;
  IF v_code IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(max(n), 0) INTO v_n FROM (
    SELECT substring(public.erp_key(c.code) FROM '-E([0-9]+)$')::integer AS n FROM public.contracts c WHERE c.parent_contract_id = p_root
    UNION ALL
    SELECT substring(public.erp_key(l.nro_documento) FROM '-E([0-9]+)$')::integer FROM public.erp_contract_lines l
     WHERE l.import_id = public.erp_active_import('CONTRATOS') AND l.ot = public.erp_key(v_code)) z;
  LOOP
    v_n := v_n + 1;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.contracts c WHERE public.erp_doc_key(c.code) = public.erp_doc_key(v_code || '-E' || v_n));
  END LOOP;
  RETURN v_code || '-E' || lpad(v_n::text, 3, '0');
END $$;
REVOKE ALL ON FUNCTION public.contract_next_error_code(uuid) FROM PUBLIC, anon, authenticated;

-- Alta de contratos: admite GARANTIA (hija de la madre) y genera su Error de contrato en la misma operación
CREATE OR REPLACE FUNCTION public.create_contract(p_payload jsonb, p_budget_pen numeric DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_code    text := trim(COALESCE(p_payload->>'code', ''));
  v_type    text := upper(COALESCE(NULLIF(trim(p_payload->>'type'), ''), 'CONTRATO'));
  v_parent  uuid;
  v_client  uuid;
  v_site    uuid;
  v_id      uuid;
  v_budget  numeric;
  v_weight  numeric;
  v_volume  numeric;
  v_ca      boolean := public.is_contract_administrator();
  v_col     text;
  v_err_id  uuid;
  v_err     text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Sin sesión'); END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Datos del contrato inválidos');
  END IF;
  IF NOT (public.is_tms_admin() OR v_ca OR public.has_tms_permission('ot') OR public.has_tms_permission('clientes')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para registrar contratos u OT');
  END IF;

  BEGIN
    v_parent := NULLIF(p_payload->>'parent_contract_id', '')::uuid;
    v_client := NULLIF(p_payload->>'client_id', '')::uuid;
    v_site   := NULLIF(p_payload->>'site_id', '')::uuid;
    v_budget := COALESCE(p_budget_pen, 0);
    v_weight := COALESCE(NULLIF(p_payload->>'total_weight_kg', '')::numeric, 0);
    v_volume := COALESCE(NULLIF(p_payload->>'total_volume_m3', '')::numeric, 0);
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object('success', false, 'error', 'Revise los montos, pesos y selecciones del formulario');
  END;

  IF v_type NOT IN ('CONTRATO', 'OT_INDEPENDIENTE', 'SUBCONTRATO', 'ERROR', 'GARANTIA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Tipo de contrato inválido');
  END IF;
  IF length(v_code) NOT BETWEEN 1 AND 100 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique el código del contrato');
  END IF;
  IF v_budget < 0 OR v_budget > 999999999999.99 OR v_weight < 0 OR v_volume < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'La partida, el peso y el volumen no pueden ser negativos');
  END IF;
  -- La garantía no tiene partida propia: su transporte va por el Error de contrato que se genera con ella
  IF v_type = 'GARANTIA' AND v_budget > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'La garantía no lleva partida propia: el costo va por su Error de contrato');
  END IF;

  IF v_type IN ('SUBCONTRATO', 'ERROR', 'GARANTIA') THEN
    IF v_parent IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Seleccione el contrato madre'); END IF;
    SELECT c.site_id INTO v_site FROM public.contracts c WHERE c.id = v_parent;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'El contrato madre no existe'); END IF;
    IF v_ca AND NOT public.has_assigned_contract(v_parent, true) THEN
      RETURN jsonb_build_object('success', false, 'error', 'El contrato madre no está asignado a usted');
    END IF;
  ELSE
    v_parent := NULL;
    -- Sede: la indicada, la principal si el usuario tiene acceso, o la primera sede a la que tenga acceso
    IF v_site IS NULL THEN
      v_site := public.primary_site_id();
      IF v_site IS NULL OR NOT public.can_access_site(v_site) THEN
        SELECT a.site_id INTO v_site FROM public.user_site_access a WHERE a.user_id = auth.uid() ORDER BY a.site_id LIMIT 1;
      END IF;
    END IF;
  END IF;
  IF v_site IS NULL OR NOT public.can_access_site(v_site) THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene acceso a la sede del contrato; pida al administrador que le asigne la sede');
  END IF;
  IF EXISTS (SELECT 1 FROM public.contracts c WHERE c.code = v_code) THEN
    RETURN jsonb_build_object('success', false, 'error', format('El código "%s" ya está en uso. No se permiten duplicados.', v_code));
  END IF;

  BEGIN
    INSERT INTO public.contracts (code, type, parent_contract_id, site_id, client_id, status)
    VALUES (v_code, v_type::public.contract_type, v_parent, v_site, v_client, 'ACTIVO')
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN unique_violation THEN
      RETURN jsonb_build_object('success', false, 'error', format('El código "%s" ya está en uso. No se permiten duplicados.', v_code));
    WHEN foreign_key_violation THEN
      RETURN jsonb_build_object('success', false, 'error', 'El cliente o el contrato madre seleccionado ya no existe');
  END;

  -- Datos opcionales: solo las columnas que existen en esta base
  FOREACH v_col IN ARRAY ARRAY['total_weight_kg', 'total_volume_m3'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contracts' AND column_name = v_col) THEN
      EXECUTE format('UPDATE public.contracts SET %I = $1 WHERE id = $2', v_col)
        USING CASE v_col WHEN 'total_weight_kg' THEN v_weight ELSE v_volume END, v_id;
    END IF;
  END LOOP;
  FOREACH v_col IN ARRAY ARRAY['destination_department', 'destination_province', 'destination_district', 'destination_address'] LOOP
    IF NULLIF(trim(p_payload->>v_col), '') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'contracts' AND column_name = v_col) THEN
      EXECUTE format('UPDATE public.contracts SET %I = $1 WHERE id = $2', v_col) USING trim(p_payload->>v_col), v_id;
    END IF;
  END LOOP;

  -- Partida de transporte: se fija aunque otro proceso ya haya creado la fila en cero
  IF v_budget > 0 THEN
    UPDATE public.contract_budgets SET allocated_pen = v_budget WHERE contract_id = v_id AND concept = 'PARTIDA_TRANSPORTE';
    IF NOT FOUND THEN
      INSERT INTO public.contract_budgets (contract_id, concept, allocated_pen) VALUES (v_id, 'PARTIDA_TRANSPORTE', v_budget);
    END IF;
  END IF;

  -- Garantía: sin partida propia (consume la de la familia, como subcontratos y errores; si un disparador de la base creó
  -- una fila vacía, se quita) y siempre con su Error de contrato (siguiente correlativo libre en el TMS y en el ERP)
  IF v_type = 'GARANTIA' THEN
    DELETE FROM public.contract_budgets WHERE contract_id = v_id AND COALESCE(allocated_pen, 0) = 0
      AND COALESCE(reserved_pen, 0) = 0 AND COALESCE(consumed_pen, 0) = 0;
    v_err := public.contract_next_error_code(v_parent);
    INSERT INTO public.contracts (code, type, parent_contract_id, site_id, client_id, status, garantia_id)
    VALUES (v_err, 'ERROR'::public.contract_type, v_parent, v_site, NULL, 'ACTIVO', v_id)
    RETURNING id INTO v_err_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'id', v_id, 'code', v_code, 'site_id', v_site,
    'error_generado', CASE WHEN v_err_id IS NOT NULL THEN jsonb_build_object('id', v_err_id, 'code', v_err) END);
END $function$;

-- ── Configuración: umbral de OT activa y eventos que la reactivan ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.erp_contract_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  umbral_dias integer NOT NULL DEFAULT 90 CHECK (umbral_dias BETWEEN 7 AND 730),
  reactivan text[] NOT NULL DEFAULT ARRAY['GARANTIA', 'SUBCONTRATO', 'ERROR', 'SOLICITUD_TMS']
    CHECK (reactivan <@ ARRAY['GARANTIA', 'SUBCONTRATO', 'ERROR', 'SOLICITUD_TMS']),
  corte_max_horas integer NOT NULL DEFAULT 48 CHECK (corte_max_horas BETWEEN 1 AND 720),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
INSERT INTO public.erp_contract_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.erp_contract_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.erp_contract_settings;
CREATE POLICY security_active_account ON public.erp_contract_settings AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.erp_contract_settings FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.erp_contratos_config_json()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('umbral_dias', COALESCE(s.umbral_dias, 90),
    'reactivan', to_jsonb(COALESCE(s.reactivan, ARRAY['GARANTIA', 'SUBCONTRATO', 'ERROR', 'SOLICITUD_TMS'])),
    'corte_max_horas', COALESCE(s.corte_max_horas, 48), 'updated_at', s.updated_at,
    'corte_contratos', i.cut_at,
    'desactualizado', i.cut_at IS NULL OR i.cut_at < now() - make_interval(hours => COALESCE(s.corte_max_horas, 48)),
    'puede_editar', public.is_tms_admin(),
    'eventos', jsonb_build_array(
      jsonb_build_object('id', 'GARANTIA', 'label', 'Garantía nueva (ERP o TMS)'),
      jsonb_build_object('id', 'SUBCONTRATO', 'label', 'Subcontrato nuevo en el ERP'),
      jsonb_build_object('id', 'ERROR', 'label', 'Error de contrato nuevo en el ERP'),
      jsonb_build_object('id', 'SOLICITUD_TMS', 'label', 'Solicitud de transporte en el TMS')))
  FROM (SELECT 1) one
  LEFT JOIN public.erp_contract_settings s ON s.id = 1
  LEFT JOIN public.erp_imports i ON i.id = public.erp_active_import('CONTRATOS');
$$;

CREATE OR REPLACE FUNCTION public.erp_contratos_config_set(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_umbral integer; v_horas integer; v_ev text[];
BEGIN
  IF NOT public.is_tms_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'Solo el Administrador cambia el umbral'); END IF;
  BEGIN
    v_umbral := COALESCE((p->>'umbral_dias')::integer, 90);
    v_horas := COALESCE((p->>'corte_max_horas')::integer, 48);
    v_ev := COALESCE(ARRAY(SELECT jsonb_array_elements_text(p->'reactivan')), '{}'::text[]);
  EXCEPTION WHEN others THEN RETURN jsonb_build_object('success', false, 'error', 'Valores inválidos');
  END;
  IF v_umbral NOT BETWEEN 7 AND 730 THEN RETURN jsonb_build_object('success', false, 'error', 'El umbral va de 7 a 730 días'); END IF;
  IF v_horas NOT BETWEEN 1 AND 720 THEN RETURN jsonb_build_object('success', false, 'error', 'La antigüedad del corte va de 1 a 720 horas'); END IF;
  IF NOT (v_ev <@ ARRAY['GARANTIA', 'SUBCONTRATO', 'ERROR', 'SOLICITUD_TMS']) THEN RETURN jsonb_build_object('success', false, 'error', 'Evento no reconocido'); END IF;
  INSERT INTO public.erp_contract_settings (id, umbral_dias, reactivan, corte_max_horas, updated_at, updated_by)
  VALUES (1, v_umbral, v_ev, v_horas, now(), auth.uid())
  ON CONFLICT (id) DO UPDATE SET umbral_dias = EXCLUDED.umbral_dias, reactivan = EXCLUDED.reactivan,
    corte_max_horas = EXCLUDED.corte_max_horas, updated_at = now(), updated_by = auth.uid();
  RETURN jsonb_build_object('success', true, 'config', public.erp_contratos_config_json());
END $$;

-- ── Actividad de la OT ─────────────────────────────────────────────────────────────────────────────────────
-- Último despacho = el más reciente entre el ERP y las rutas del TMS. Motivo en orden: despacho, garantía, subcontrato,
-- error, solicitud del TMS (los habilitados) y contrato nuevo sin despachos (por su fecha de contrato).
CREATE OR REPLACE FUNCTION public.erp_ot_actividad(p_ots text[])
RETURNS TABLE (ot text, ult_despacho_erp date, ult_despacho_tms date, ultimo_despacho date, fecha_contrato date, pendiente boolean,
  activa boolean, motivo text, motivo_fecha date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH cfg AS (
    SELECT COALESCE((SELECT s.umbral_dias FROM public.erp_contract_settings s WHERE s.id = 1), 90) AS umbral,
      COALESCE((SELECT s.reactivan FROM public.erp_contract_settings s WHERE s.id = 1), ARRAY['GARANTIA', 'SUBCONTRATO', 'ERROR', 'SOLICITUD_TMS']) AS reactivan,
      (now() AT TIME ZONE 'America/Lima')::date AS hoy),
  o AS (SELECT DISTINCT x AS ot FROM unnest(COALESCE(p_ots, '{}'::text[])) x WHERE x IS NOT NULL),
  e AS (
    SELECT l.ot, max(l.fecha_ult_despacho) AS ult_erp,
      min(l.fecha_contrato) FILTER (WHERE l.tipo_documento = 'CONTRATO DE VENTAS') AS fecha_contrato,
      max(l.fecha_contrato) FILTER (WHERE l.tipo_documento = 'GARANTIA DE VENTAS') AS f_gar,
      max(l.fecha_contrato) FILTER (WHERE l.tipo_documento = 'SUBCONTRATO DE VENTAS') AS f_sub,
      max(l.fecha_contrato) FILTER (WHERE l.tipo_documento = 'ERROR DE CONTRATO') AS f_err,
      bool_or(l.cant_pendiente > 0 AND NOT l.cantidades_ausentes) AS pendiente
    FROM public.erp_contract_lines l
    WHERE l.import_id = public.erp_active_import('CONTRATOS') AND l.ot IN (SELECT o.ot FROM o) GROUP BY l.ot),
  fam AS (
    SELECT o.ot, c.id, c.type::text AS tipo, c.created_at
    FROM o JOIN public.contracts r ON r.code = o.ot AND r.parent_contract_id IS NULL
    JOIN public.contracts c ON c.id = r.id OR c.parent_contract_id = r.id),
  req AS (
    SELECT fam.ot, tr.id, tr.status::text AS status, tr.created_at FROM fam JOIN public.transport_requests tr ON tr.contract_id = fam.id
    UNION
    SELECT fam.ot, tr.id, tr.status::text, tr.created_at FROM fam JOIN public.transport_request_components tc ON tc.component_contract_id = fam.id
      JOIN public.transport_requests tr ON tr.id = tc.request_id),
  t AS (
    SELECT req.ot, max((COALESCE((to_jsonb(d)->>'scheduled_date')::timestamptz, d.created_at) AT TIME ZONE 'America/Lima')::date) AS ult_tms
    FROM req JOIN public.dispatch_requests dr ON dr.transport_request_id = req.id JOIN public.dispatches d ON d.id = dr.dispatch_id
    WHERE COALESCE(d.status, '') NOT IN ('CANCELADO', 'CANCELADA', 'ANULADO', 'ANULADA') GROUP BY req.ot),
  s AS (
    SELECT req.ot, max((req.created_at AT TIME ZONE 'America/Lima')::date) AS f_sol FROM req
    WHERE COALESCE(req.status, '') NOT IN ('CANCELADA', 'ANULADA', 'RECHAZADA', 'BORRADOR') GROUP BY req.ot),
  g AS (SELECT fam.ot, max((fam.created_at AT TIME ZONE 'America/Lima')::date) AS f_gar_tms FROM fam WHERE fam.tipo = 'GARANTIA' GROUP BY fam.ot),
  m AS (
    SELECT o.ot, e.ult_erp, t.ult_tms, greatest(e.ult_erp, t.ult_tms) AS ultimo, e.fecha_contrato, COALESCE(e.pendiente, false) AS pendiente,
      greatest(e.f_gar, g.f_gar_tms) AS f_gar, e.f_sub, e.f_err, s.f_sol, cfg.hoy - cfg.umbral AS desde, cfg.reactivan
    FROM o CROSS JOIN cfg LEFT JOIN e ON e.ot = o.ot LEFT JOIN t ON t.ot = o.ot LEFT JOIN s ON s.ot = o.ot LEFT JOIN g ON g.ot = o.ot)
  SELECT m.ot, m.ult_erp, m.ult_tms, m.ultimo, m.fecha_contrato, m.pendiente, r.motivo IS NOT NULL, r.motivo, r.fecha
  FROM m LEFT JOIN LATERAL (
    SELECT v.motivo, v.fecha FROM (VALUES
      (1, 'DESPACHO', m.ultimo, true),
      (2, 'GARANTIA', m.f_gar, 'GARANTIA' = ANY (m.reactivan)),
      (3, 'SUBCONTRATO', m.f_sub, 'SUBCONTRATO' = ANY (m.reactivan)),
      (4, 'ERROR', m.f_err, 'ERROR' = ANY (m.reactivan)),
      (5, 'SOLICITUD_TMS', m.f_sol, 'SOLICITUD_TMS' = ANY (m.reactivan)),
      (6, 'CONTRATO_NUEVO', CASE WHEN m.ultimo IS NULL THEN m.fecha_contrato END, true)) v(orden, motivo, fecha, habilitado)
    WHERE v.habilitado AND v.fecha >= m.desde ORDER BY v.orden LIMIT 1) r ON true;
$$;
REVOKE ALL ON FUNCTION public.erp_ot_actividad(text[]) FROM PUBLIC, anon, authenticated;

-- ── Referencia por lote para la lista de Contratos ─────────────────────────────────────────────────────────
-- Por código del TMS: documento del ERP (misma numeración), cliente y RUC, avance (solo con una unidad, sin conversiones),
-- stock listo (lote = documento, mismo producto y unidad, con pendiente), actividad y diferencias.
CREATE OR REPLACE FUNCTION public.erp_ref_contratos(p_codes text[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); v_s uuid := public.erp_active_import('STOCK');
  v_ca boolean := public.is_contract_administrator() AND NOT public.is_tms_admin(); v_out jsonb;
BEGIN
  IF NOT public.erp_ref_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a la referencia del ERP'); END IF;
  IF v_c IS NULL THEN RETURN jsonb_build_object('success', true, 'sin_datos', true, 'config', public.erp_contratos_config_json(), 'filas', '{}'::jsonb); END IF;
  WITH i AS (SELECT DISTINCT btrim(x) AS codigo FROM unnest(COALESCE(p_codes, '{}'::text[])) x WHERE NULLIF(btrim(x), '') IS NOT NULL LIMIT 5000),
  t AS (
    SELECT i.codigo, c.id, c.type::text AS tipo_tms, c.parent_contract_id IS NULL AS raiz, c.garantia_id,
      public.erp_doc_key(c.code) AS dk, split_part(public.erp_key(c.code), '-', 1) AS ot,
      public.client_tax_id_norm(COALESCE(to_jsonb(cl)->>'tax_id', to_jsonb(cl)->>'ruc')) AS ruc_tms, cl.business_name::text AS cliente_tms
    FROM i JOIN public.contracts c ON c.code = i.codigo LEFT JOIN public.clients cl ON cl.id = c.client_id
    WHERE public.can_access_site(c.site_id) AND (NOT v_ca OR public.has_assigned_contract(c.id))),
  l AS (
    SELECT l.ot, public.erp_doc_key(l.nro_documento) AS dk, public.erp_key(l.nro_documento) AS dkraw, l.tipo_documento, l.cliente,
      public.client_tax_id_norm(l.ruc) AS ruc, l.cant_contrato, l.cant_despachada, l.cant_pendiente, l.cantidades_ausentes,
      public.erp_key(l.cod_producto) AS pk, public.erp_key(COALESCE(l.unidad_erp, l.unidad)) AS u
    FROM public.erp_contract_lines l WHERE l.import_id = v_c AND l.ot IN (SELECT DISTINCT t.ot FROM t)),
  d AS (
    SELECT l.dk, max(l.dkraw) AS documento, max(l.tipo_documento) AS tipo_erp, max(l.cliente) AS cliente_erp, max(l.ruc) AS ruc_erp,
      count(DISTINCT l.ruc) AS n_ruc, count(*) AS lineas, count(*) FILTER (WHERE l.cantidades_ausentes) AS incompletas,
      count(DISTINCT l.u) FILTER (WHERE NOT l.cantidades_ausentes) AS unidades, min(l.u) FILTER (WHERE NOT l.cantidades_ausentes) AS unidad,
      sum(l.cant_contrato) FILTER (WHERE NOT l.cantidades_ausentes) AS contratado,
      sum(l.cant_despachada) FILTER (WHERE NOT l.cantidades_ausentes) AS despachado,
      sum(l.cant_pendiente) FILTER (WHERE NOT l.cantidades_ausentes) AS pendiente
    FROM l WHERE l.dk IN (SELECT t.dk FROM t) GROUP BY l.dk),
  sp AS (
    SELECT q.dk, sum(s.stock) AS stock
    FROM (SELECT DISTINCT l.dk, l.dkraw, l.pk, l.u FROM l WHERE l.cant_pendiente > 0 AND NOT l.cantidades_ausentes AND l.dk IN (SELECT t.dk FROM t)) q
    JOIN public.erp_stock_lots s ON s.import_id = v_s AND public.erp_key(s.lote_raw) = q.dkraw AND public.erp_key(s.cod_producto) = q.pk
      AND public.erp_key(s.unidad) = q.u AND s.stock > 0
    GROUP BY q.dk),
  tk AS (SELECT DISTINCT public.erp_doc_key(c.code) AS k FROM public.contracts c WHERE c.code IS NOT NULL),
  h AS (
    SELECT l.ot, array_agg(DISTINCT l.dkraw ORDER BY l.dkraw) AS docs FROM l
    WHERE l.tipo_documento IS DISTINCT FROM 'CONTRATO DE VENTAS' AND l.dk NOT IN (SELECT tk.k FROM tk WHERE tk.k IS NOT NULL) GROUP BY l.ot),
  a AS (SELECT * FROM public.erp_ot_actividad((SELECT array_agg(DISTINCT t.ot) FROM t))),
  ge AS (SELECT e.garantia_id, max(e.code::text) AS error_code FROM public.contracts e WHERE e.garantia_id IN (SELECT t.id FROM t) GROUP BY e.garantia_id),
  eg AS (SELECT t.id, g.code::text AS garantia_code FROM t JOIN public.contracts g ON g.id = t.garantia_id),
  r AS (
    SELECT t.codigo, t.tipo_tms, t.raiz, d.dk IS NOT NULL AS en_erp, d.documento, d.tipo_erp, d.cliente_erp, d.ruc_erp,
      COALESCE(d.n_ruc = 1 AND length(d.ruc_erp) = 11 AND public.is_valid_ruc(d.ruc_erp), false) AS ruc_valido,
      t.cliente_tms, t.ruc_tms, d.lineas, d.incompletas, d.unidades, d.unidad, d.contratado, d.despachado, d.pendiente, sp.stock AS stock_listo,
      a.ultimo_despacho, a.ult_despacho_erp, a.ult_despacho_tms, a.activa, a.motivo, a.motivo_fecha, a.fecha_contrato,
      CASE WHEN t.raiz THEN COALESCE(h.docs, '{}'::text[]) ELSE '{}'::text[] END AS hijos_sin_alta, ge.error_code, eg.garantia_code
    FROM t LEFT JOIN d ON d.dk = t.dk LEFT JOIN sp ON sp.dk = t.dk LEFT JOIN a ON a.ot = t.ot LEFT JOIN h ON h.ot = t.ot
      LEFT JOIN ge ON ge.garantia_id = t.id LEFT JOIN eg ON eg.id = t.id)
  SELECT jsonb_build_object('success', true, 'config', public.erp_contratos_config_json(),
    'cortes', (SELECT jsonb_object_agg(kind, cut_at) FROM public.erp_imports WHERE id IN (v_c, v_s)),
    'filas', COALESCE(jsonb_object_agg(r.codigo, jsonb_build_object(
      'aplica', r.en_erp OR r.tipo_tms <> 'OT_INDEPENDIENTE', 'en_erp', r.en_erp, 'documento', r.documento, 'tipo_erp', r.tipo_erp,
      'cliente_erp', r.cliente_erp, 'ruc_erp', r.ruc_erp, 'ruc_valido', r.ruc_valido, 'cliente_tms', r.cliente_tms,
      'cliente_coincide', CASE WHEN r.en_erp AND r.ruc_valido THEN r.ruc_tms IS NOT DISTINCT FROM r.ruc_erp END,
      'lineas', r.lineas, 'incompletas', r.incompletas, 'unidades', r.unidades, 'unidad', CASE WHEN r.unidades = 1 THEN r.unidad END,
      'contratado', CASE WHEN r.unidades = 1 THEN r.contratado END, 'despachado', CASE WHEN r.unidades = 1 THEN r.despachado END,
      'pendiente', CASE WHEN r.unidades = 1 THEN r.pendiente END,
      'avance', CASE WHEN r.unidades = 1 AND r.contratado > 0 THEN round(r.despachado / r.contratado, 4) END,
      'estado_erp', CASE WHEN NOT r.en_erp THEN NULL WHEN r.lineas = r.incompletas THEN 'SIN DATOS' WHEN r.pendiente <= 0 THEN 'COMPLETO'
        WHEN r.despachado > 0 THEN 'PARCIAL' ELSE 'SIN DESPACHO' END,
      'stock_listo', r.stock_listo, 'ultimo_despacho', r.ultimo_despacho, 'ultimo_despacho_erp', r.ult_despacho_erp,
      'ultimo_despacho_tms', r.ult_despacho_tms, 'fecha_contrato', r.fecha_contrato,
      'activa', r.activa, 'motivo', r.motivo, 'motivo_fecha', r.motivo_fecha,
      'hijos_sin_alta', to_jsonb(r.hijos_sin_alta), 'garantia_error', r.error_code, 'error_de_garantia', r.garantia_code,
      'diferencias', to_jsonb(array_remove(ARRAY[
        CASE WHEN NOT r.en_erp AND r.tipo_tms <> 'OT_INDEPENDIENTE' THEN 'NO_EN_ERP' END,
        CASE WHEN r.en_erp AND r.ruc_valido AND r.ruc_tms IS DISTINCT FROM r.ruc_erp THEN 'CLIENTE_DISTINTO' END,
        CASE WHEN r.en_erp AND NOT r.ruc_valido THEN 'RUC_INVALIDO' END,
        CASE WHEN cardinality(r.hijos_sin_alta) > 0 THEN 'HIJOS_SIN_ALTA' END,
        CASE WHEN r.tipo_tms = 'GARANTIA' AND r.error_code IS NULL THEN 'GARANTIA_SIN_ERROR' END]::text[], NULL)))), '{}'::jsonb))
  INTO v_out FROM r;
  RETURN v_out;
END $$;

-- ── Alta asistida ──────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.erp_tipo_tms(p_tipo text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE upper(btrim(COALESCE(p_tipo, ''))) WHEN 'CONTRATO DE VENTAS' THEN 'CONTRATO' WHEN 'SUBCONTRATO DE VENTAS' THEN 'SUBCONTRATO'
    WHEN 'ERROR DE CONTRATO' THEN 'ERROR' WHEN 'GARANTIA DE VENTAS' THEN 'GARANTIA' END;
$$;

-- Un documento del ERP para prellenar el alta: tipo, madre, cliente (por RUC) y si ya existe en el TMS
CREATE OR REPLACE FUNCTION public.erp_ref_documento(p_codigo text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); v_k text := public.erp_doc_key(p_codigo); v_ot text := split_part(public.erp_key(p_codigo), '-', 1);
  d record; v_cli record; v_madre uuid; v_ya uuid; v_ca boolean := public.is_contract_administrator() AND NOT public.is_tms_admin();
BEGIN
  IF NOT (public.is_tms_admin() OR public.is_contract_administrator() OR public.has_tms_permission('ot')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso de Contratos y OTs');
  END IF;
  IF v_k IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el código'); END IF;
  IF v_c IS NULL THEN RETURN jsonb_build_object('success', true, 'sin_datos', true); END IF;
  SELECT c.id INTO v_madre FROM public.contracts c WHERE c.code = v_ot AND c.parent_contract_id IS NULL;
  IF v_ca AND (v_madre IS NULL OR NOT public.has_assigned_contract(v_madre)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'La OT no está en su cartera');
  END IF;
  SELECT c.id INTO v_ya FROM public.contracts c WHERE public.erp_doc_key(c.code) = v_k LIMIT 1;
  SELECT max(public.erp_key(l.nro_documento)) AS documento, max(l.tipo_documento) AS tipo_documento, max(l.cliente) AS cliente,
    max(public.client_tax_id_norm(l.ruc)) AS ruc, count(DISTINCT public.client_tax_id_norm(l.ruc)) AS n_ruc, min(l.fecha_contrato) AS fecha_contrato,
    count(*) AS lineas
  INTO d FROM public.erp_contract_lines l WHERE l.import_id = v_c AND l.ot = v_ot AND public.erp_doc_key(l.nro_documento) = v_k;
  IF d.lineas = 0 THEN RETURN jsonb_build_object('success', true, 'en_erp', false, 'ya_en_tms', v_ya IS NOT NULL, 'madre_id', v_madre); END IF;
  SELECT cl.id, cl.business_name::text AS nombre INTO v_cli FROM public.clients cl
   WHERE public.client_tax_id_norm(COALESCE(to_jsonb(cl)->>'tax_id', to_jsonb(cl)->>'ruc')) = d.ruc
   ORDER BY COALESCE((to_jsonb(cl)->>'is_active')::boolean, true) DESC LIMIT 1;
  RETURN jsonb_build_object('success', true, 'en_erp', true, 'documento', d.documento, 'ot', v_ot, 'tipo_erp', d.tipo_documento,
    'tipo', public.erp_tipo_tms(d.tipo_documento), 'cliente', d.cliente, 'ruc', d.ruc,
    'ruc_valido', d.n_ruc = 1 AND length(d.ruc) = 11 AND public.is_valid_ruc(d.ruc), 'client_id', v_cli.id, 'client_name', v_cli.nombre,
    'fecha_contrato', d.fecha_contrato, 'madre_id', v_madre, 'ya_en_tms', v_ya IS NOT NULL,
    'sufijo', CASE WHEN d.documento LIKE '%-%' THEN split_part(d.documento, '-', 2) END);
END $$;

-- Documentos del ERP sin alta en el TMS (por defecto solo de OT activas)
CREATE OR REPLACE FUNCTION public.erp_ref_sin_alta(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); v_out jsonb;
  v_ca boolean := public.is_contract_administrator() AND NOT public.is_tms_admin();
  v_tipo text := NULLIF(upper(btrim(COALESCE(p->>'tipo', ''))), '');
  v_activas boolean := COALESCE((p->>'solo_activas')::boolean, true);
  v_q text := NULLIF(public.erp_key(p->>'q'), '');
  v_lim integer := least(greatest(COALESCE((p->>'limit')::integer, 50), 1), 500);
  v_off integer := greatest(COALESCE((p->>'offset')::integer, 0), 0);
BEGIN
  IF NOT (public.is_tms_admin() OR public.is_contract_administrator() OR public.has_tms_permission('ot')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso de Contratos y OTs');
  END IF;
  IF v_c IS NULL THEN RETURN jsonb_build_object('success', true, 'sin_datos', true, 'total', 0, 'filas', '[]'::jsonb); END IF;
  WITH tk AS (SELECT DISTINCT public.erp_doc_key(c.code) AS k FROM public.contracts c WHERE c.code IS NOT NULL),
  madres AS (SELECT c.code::text AS ot, c.id FROM public.contracts c WHERE c.parent_contract_id IS NULL AND public.can_access_site(c.site_id)
             AND (NOT v_ca OR public.has_assigned_contract(c.id))),
  d AS (
    SELECT public.erp_doc_key(l.nro_documento) AS dk, max(public.erp_key(l.nro_documento)) AS documento, max(l.ot) AS ot,
      max(l.tipo_documento) AS tipo_erp, max(l.cliente) AS cliente, max(public.client_tax_id_norm(l.ruc)) AS ruc, min(l.fecha_contrato) AS fecha_contrato,
      max(l.fecha_ult_despacho) AS ult_despacho, bool_or(l.cant_pendiente > 0 AND NOT l.cantidades_ausentes) AS pendiente
    FROM public.erp_contract_lines l WHERE l.import_id = v_c GROUP BY 1),
  f AS (
    SELECT d.*, public.erp_tipo_tms(d.tipo_erp) AS tipo, m.id AS madre_id
    FROM d LEFT JOIN madres m ON m.ot = d.ot
    WHERE d.dk NOT IN (SELECT tk.k FROM tk WHERE tk.k IS NOT NULL)
      AND (NOT v_ca OR m.id IS NOT NULL)
      AND (v_tipo IS NULL OR public.erp_tipo_tms(d.tipo_erp) = v_tipo)
      AND (v_q IS NULL OR d.documento LIKE '%' || v_q || '%' OR upper(d.cliente) LIKE '%' || v_q || '%')),
  a AS (SELECT * FROM public.erp_ot_actividad((SELECT array_agg(DISTINCT f.ot) FROM f))),
  x AS (SELECT f.*, a.activa, a.motivo, a.ultimo_despacho FROM f LEFT JOIN a ON a.ot = f.ot WHERE NOT v_activas OR a.activa)
  SELECT jsonb_build_object('success', true, 'total', (SELECT count(*) FROM x),
    'por_tipo', (SELECT COALESCE(jsonb_object_agg(tipo, n), '{}'::jsonb) FROM (SELECT x.tipo, count(*) AS n FROM x GROUP BY x.tipo) z),
    'filas', COALESCE((SELECT jsonb_agg(to_jsonb(y)) FROM (
       SELECT x.documento, x.ot, x.tipo, x.tipo_erp, x.cliente, x.ruc, x.fecha_contrato, x.ult_despacho, x.pendiente, x.activa, x.motivo,
         x.ultimo_despacho, x.madre_id IS NOT NULL AS madre_en_tms
       FROM x ORDER BY x.activa DESC NULLS LAST, x.ultimo_despacho DESC NULLS LAST, x.documento LIMIT v_lim OFFSET v_off) y), '[]'::jsonb))
  INTO v_out;
  RETURN v_out;
END $$;

-- ── Validación de guías por lote (Registro de Servicios) ───────────────────────────────────────────────────
-- p_items: [{id, ot, guias: [...]}] → por id: total, en el ERP, de otra OT y no encontradas
CREATE OR REPLACE FUNCTION public.erp_ref_guias_lote(p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET enable_nestloop = off AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); v_out jsonb;
BEGIN
  IF NOT public.erp_ref_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a la referencia del ERP'); END IF;
  IF v_c IS NULL THEN RETURN jsonb_build_object('success', true, 'sin_datos', true, 'items', '{}'::jsonb); END IF;
  WITH i AS (
    SELECT it->>'id' AS id, split_part(public.erp_key(it->>'ot'), '-', 1) AS ot, public.apt_guia_key(g) AS guia_key
    FROM (SELECT it FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END) it LIMIT 2000) z
    CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(it->'guias') = 'array' THEN it->'guias' ELSE '[]'::jsonb END) g
    WHERE NULLIF(btrim(g), '') IS NOT NULL),
  e AS (SELECT * FROM public.erp_ref_guias_erp(v_c, (SELECT array_agg(DISTINCT i.guia_key) FROM i)))
  SELECT jsonb_build_object('success', true, 'items', COALESCE(jsonb_object_agg(q.id, jsonb_build_object('total', q.total, 'en_erp', q.en_erp,
      'otra_ot', q.otra_ot, 'no_erp', q.no_erp)), '{}'::jsonb))
  INTO v_out
  FROM (SELECT i.id, count(DISTINCT i.guia_key) AS total, count(DISTINCT i.guia_key) FILTER (WHERE e.guia_key IS NOT NULL) AS en_erp,
          count(DISTINCT i.guia_key) FILTER (WHERE e.guia_key IS NOT NULL AND i.ot IS NOT NULL AND NOT (i.ot = ANY (string_to_array(e.ots, ', ')))) AS otra_ot,
          count(DISTINCT i.guia_key) FILTER (WHERE e.guia_key IS NULL) AS no_erp
        FROM i LEFT JOIN e ON e.guia_key = i.guia_key GROUP BY i.id) q;
  RETURN v_out;
END $$;

-- ── Corrección del cliente según el ERP ────────────────────────────────────────────────────────────────────
-- Solicitudes abiertas: aún no salen a ruta. Las demás (en ruta, entregadas, cerradas, canceladas) conservan su cliente.
CREATE OR REPLACE FUNCTION public.erp_request_open(p_status text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT upper(btrim(COALESCE(p_status, ''))) IN ('BORRADOR', 'PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'PENDIENTE_APROBACION', 'APROBADA', 'APROBADO',
    'ASIGNADA', 'REPROGRAMADA', 'OBSERVADA');
$$;

CREATE TABLE IF NOT EXISTS public.contract_client_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
  contract_code text NOT NULL,
  old_client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  old_client_name text,
  new_client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  new_client_name text,
  ruc_erp text NOT NULL,
  cliente_erp text,
  client_created boolean NOT NULL DEFAULT false,
  import_id uuid,
  corte timestamptz,
  open_request_ids uuid[] NOT NULL DEFAULT '{}',
  kept_request_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  closed_applied_at timestamptz,
  closed_applied_by uuid,
  closed_applied integer,
  closed_motivo text,
  reverted_at timestamptz,
  reverted_by uuid,
  revert_motivo text
);
CREATE INDEX IF NOT EXISTS contract_client_corrections_contract_idx ON public.contract_client_corrections (contract_id, created_at DESC);
ALTER TABLE public.contract_client_corrections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.contract_client_corrections;
CREATE POLICY security_active_account ON public.contract_client_corrections AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.contract_client_corrections FROM PUBLIC, anon, authenticated;

-- Propagación del cliente a la familia y a sus solicitudes. Con jrm.cliente_erp = 'abiertas' solo a las abiertas;
-- con 'ninguna', a ninguna solicitud (la corrección o la reversión las actualiza una por una).
CREATE OR REPLACE FUNCTION public.contracts_propagate_client()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_scope text := COALESCE(current_setting('jrm.cliente_erp', true), '');
BEGIN
  IF NEW.client_id IS NOT NULL THEN
    UPDATE public.contracts SET client_id = NEW.client_id
     WHERE parent_contract_id = NEW.id AND client_id IS DISTINCT FROM NEW.client_id;
    IF to_regclass('public.transport_requests') IS NOT NULL AND v_scope <> 'ninguna' THEN
      UPDATE public.transport_requests SET client_id = NEW.client_id
       WHERE contract_id = NEW.id AND client_id IS DISTINCT FROM NEW.client_id
         AND (v_scope <> 'abiertas' OR public.erp_request_open(status::text));
    END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.contracts_propagate_client() FROM PUBLIC, anon, authenticated;

-- Invariante del cliente de la OT (se valida al confirmar). La corrección desde el ERP queda autorizada en su transacción.
CREATE OR REPLACE FUNCTION public.enforce_contract_client()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record;
BEGIN
  SELECT c.id, c.code::text AS code, c.client_id, c.parent_contract_id INTO r FROM public.contracts c WHERE c.id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF r.client_id IS NULL THEN
    IF TG_OP = 'UPDATE' AND OLD.client_id IS NOT NULL THEN
      RAISE EXCEPTION 'No se puede quitar el cliente de la OT %', r.code USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF r.parent_contract_id IS NULL THEN
        RAISE EXCEPTION 'La OT % necesita un cliente: selecciónelo por RUC o razón social', r.code USING ERRCODE = '23514';
      ELSE
        RAISE EXCEPTION 'La OT madre de % no tiene cliente: asígnelo primero en Contratos y OTs', r.code USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND OLD.client_id IS NOT NULL AND r.client_id IS DISTINCT FROM OLD.client_id
        AND r.parent_contract_id IS NULL AND auth.uid() IS NOT NULL AND NOT public.is_tms_admin()
        AND COALESCE(current_setting('jrm.cliente_erp_ok', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Solo el Administrador puede cambiar el cliente ya asignado a la OT %', r.code USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.enforce_contract_client() FROM PUBLIC, anon, authenticated;

-- Cliente por RUC; si no existe y p_crear, se registra con la razón social del ERP (RUC válido según SUNAT)
CREATE OR REPLACE FUNCTION public.erp_cliente_por_ruc(p_ruc text, p_nombre text, p_crear boolean DEFAULT true)
RETURNS TABLE (id uuid, creado boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tax text := public.client_tax_id_norm(p_ruc); v_name text := left(NULLIF(btrim(COALESCE(p_nombre, '')), ''), 255);
  v_id uuid; v_data jsonb; v_cols text;
BEGIN
  IF v_tax IS NULL OR length(v_tax) <> 11 OR NOT public.is_valid_ruc(v_tax) THEN RETURN; END IF;
  SELECT c.id INTO v_id FROM public.clients c
   WHERE public.client_tax_id_norm(COALESCE(to_jsonb(c)->>'tax_id', to_jsonb(c)->>'ruc')) = v_tax
   ORDER BY COALESCE((to_jsonb(c)->>'is_active')::boolean, true) DESC LIMIT 1;
  IF v_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.clients c WHERE c.id = v_id AND (to_jsonb(c)->>'is_active') = 'false') THEN
      EXECUTE 'UPDATE public.clients SET is_active = true WHERE id = $1' USING v_id;
    END IF;
    id := v_id; creado := false; RETURN NEXT; RETURN;
  END IF;
  IF NOT p_crear OR v_name IS NULL THEN RETURN; END IF;
  v_data := jsonb_build_object('business_name', v_name, 'tax_id', v_tax, 'ruc', v_tax, 'is_active', true, 'status', 'ACTIVE',
    'country_code', 'PE', 'observations', 'Registrado automáticamente desde el ERP');
  SELECT string_agg(quote_ident(k), ',') INTO v_cols FROM jsonb_object_keys(v_data) k
   WHERE EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = k);
  EXECUTE format('INSERT INTO public.clients(%s) SELECT %s FROM jsonb_populate_record(NULL::public.clients, $1) RETURNING id', v_cols, v_cols)
    INTO v_id USING v_data;
  id := v_id; creado := true; RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.erp_cliente_por_ruc(text, text, boolean) FROM PUBLIC, anon, authenticated;

-- Alta asistida: cliente del documento del ERP, registrándolo si no existe
CREATE OR REPLACE FUNCTION public.erp_cliente_desde_erp(p_codigo text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_doc jsonb := public.erp_ref_documento(p_codigo); v_id uuid; v_new boolean;
BEGIN
  IF COALESCE((v_doc->>'success')::boolean, false) IS NOT TRUE THEN RETURN v_doc; END IF;
  IF NOT COALESCE((v_doc->>'en_erp')::boolean, false) THEN RETURN jsonb_build_object('success', false, 'error', 'El documento no está en el ERP'); END IF;
  IF NOT COALESCE((v_doc->>'ruc_valido')::boolean, false) THEN
    RETURN jsonb_build_object('success', false, 'error', format('El RUC del ERP (%s) no es válido: registre el cliente a mano', COALESCE(v_doc->>'ruc', '—')));
  END IF;
  SELECT x.id, x.creado INTO v_id, v_new FROM public.erp_cliente_por_ruc(v_doc->>'ruc', v_doc->>'cliente', true) x;
  IF v_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'No se pudo registrar el cliente del ERP'); END IF;
  RETURN jsonb_build_object('success', true, 'client_id', v_id, 'creado', v_new, 'cliente', v_doc->>'cliente', 'ruc', v_doc->>'ruc');
END $$;

INSERT INTO public.notif_reglas (evento, categoria, descripcion, severidad, permisos, al_solicitante)
VALUES ('OT_CLIENTE_CORREGIDO', 'CUMPLIMIENTO', 'Cliente de una OT corregido según el RUC del ERP', 'warn', ARRAY['ot', 'clientes'], true)
ON CONFLICT (evento) DO NOTHING;

-- Corrige el cliente de las OT madre cuyo RUC en el TMS difiere del ERP (o no tienen). p_simular solo cuenta.
CREATE OR REPLACE FUNCTION public.erp_contratos_sincronizar_clientes(p_simular boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); v_cut timestamptz; r record; v_client uuid; v_new boolean;
  v_open uuid[]; v_kept uuid[]; v_id uuid; v_resp uuid; v_name text;
  n_rev integer := 0; n_fix integer := 0; n_new integer := 0; n_bad integer := 0; n_skip integer := 0; n_err integer := 0;
  v_det jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT (public.apt_can_load() OR public.is_tms_admin()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso: requiere carga del ERP o Administrador');
  END IF;
  IF v_c IS NULL THEN RETURN jsonb_build_object('success', true, 'sin_datos', true); END IF;
  SELECT i.cut_at INTO v_cut FROM public.erp_imports i WHERE i.id = v_c;
  FOR r IN
    WITH e AS (
      SELECT l.ot, max(l.cliente) AS cliente, min(public.client_tax_id_norm(l.ruc)) AS ruc, count(DISTINCT public.client_tax_id_norm(l.ruc)) AS n
      FROM public.erp_contract_lines l WHERE l.import_id = v_c GROUP BY l.ot)
    SELECT c.id, c.code::text AS code, c.client_id, cl.business_name::text AS cliente_tms, e.cliente, e.ruc, e.n,
      public.client_tax_id_norm(COALESCE(to_jsonb(cl)->>'tax_id', to_jsonb(cl)->>'ruc')) AS ruc_tms
    FROM public.contracts c JOIN e ON e.ot = c.code::text LEFT JOIN public.clients cl ON cl.id = c.client_id
    WHERE c.parent_contract_id IS NULL
    ORDER BY c.code
  LOOP
    n_rev := n_rev + 1;
    CONTINUE WHEN r.ruc_tms IS NOT DISTINCT FROM r.ruc;
    IF r.n <> 1 OR r.ruc IS NULL OR length(r.ruc) <> 11 OR NOT public.is_valid_ruc(r.ruc) THEN n_bad := n_bad + 1; CONTINUE; END IF;
    -- Una corrección revertida no se vuelve a aplicar mientras el ERP siga con el mismo RUC
    IF EXISTS (SELECT 1 FROM public.contract_client_corrections k WHERE k.contract_id = r.id AND k.reverted_at IS NOT NULL AND k.ruc_erp = r.ruc) THEN
      n_skip := n_skip + 1; CONTINUE;
    END IF;
    IF p_simular THEN
      n_fix := n_fix + 1;
      IF jsonb_array_length(v_det) < 200 THEN
        v_det := v_det || jsonb_build_object('ot', r.code, 'cliente_tms', r.cliente_tms, 'cliente_erp', r.cliente, 'ruc', r.ruc);
      END IF;
      CONTINUE;
    END IF;
    BEGIN
      SELECT x.id, x.creado INTO v_client, v_new FROM public.erp_cliente_por_ruc(r.ruc, r.cliente, true) x;
      IF v_client IS NULL THEN n_bad := n_bad + 1; CONTINUE; END IF;
      SELECT array_agg(tr.id) FILTER (WHERE public.erp_request_open(tr.status::text)), array_agg(tr.id) FILTER (WHERE NOT public.erp_request_open(tr.status::text))
        INTO v_open, v_kept
        FROM public.transport_requests tr JOIN public.contracts c ON c.id = tr.contract_id
       WHERE (c.id = r.id OR c.parent_contract_id = r.id) AND tr.client_id IS DISTINCT FROM v_client;
      PERFORM set_config('jrm.cliente_erp_ok', 'on', true);
      PERFORM set_config('jrm.cliente_erp', 'abiertas', true);
      UPDATE public.contracts SET client_id = v_client WHERE id = r.id;
      PERFORM set_config('jrm.cliente_erp', '', true);
      SELECT cl.business_name::text INTO v_name FROM public.clients cl WHERE cl.id = v_client;
      INSERT INTO public.contract_client_corrections (contract_id, contract_code, old_client_id, old_client_name, new_client_id, new_client_name,
        ruc_erp, cliente_erp, client_created, import_id, corte, open_request_ids, kept_request_ids, created_by)
      VALUES (r.id, r.code, r.client_id, r.cliente_tms, v_client, v_name, r.ruc, r.cliente, v_new, v_c, v_cut,
        COALESCE(v_open, '{}'::uuid[]), COALESCE(v_kept, '{}'::uuid[]), auth.uid())
      RETURNING contract_client_corrections.id INTO v_id;
      SELECT a.user_id INTO v_resp FROM public.contract_user_assignments a WHERE a.contract_id = r.id AND a.active
       ORDER BY (a.role = 'ADMIN_CONTRATO') DESC, a.assigned_at DESC LIMIT 1;
      PERFORM public.notif_emit('OT_CLIENTE_CORREGIDO', 'ot-cliente:' || v_id,
        format('OT %s: cliente corregido según el ERP', r.code),
        format('%s → %s (RUC %s)%s. %s solicitud(es) abiertas corregidas; %s en ruta o cerradas conservan el cliente anterior.',
          COALESCE(r.cliente_tms, 'Sin cliente'), COALESCE(v_name, r.cliente), r.ruc, CASE WHEN v_new THEN ', cliente registrado desde el ERP' ELSE '' END,
          COALESCE(cardinality(v_open), 0), COALESCE(cardinality(v_kept), 0)),
        '/contratos?ot=' || r.code, v_resp);
      n_fix := n_fix + 1; IF v_new THEN n_new := n_new + 1; END IF;
      IF jsonb_array_length(v_det) < 200 THEN
        v_det := v_det || jsonb_build_object('ot', r.code, 'cliente_tms', r.cliente_tms, 'cliente_erp', COALESCE(v_name, r.cliente), 'ruc', r.ruc,
          'cliente_creado', v_new, 'abiertas', COALESCE(cardinality(v_open), 0), 'conservadas', COALESCE(cardinality(v_kept), 0));
      END IF;
    EXCEPTION WHEN others THEN
      n_err := n_err + 1;
      IF jsonb_array_length(v_det) < 200 THEN v_det := v_det || jsonb_build_object('ot', r.code, 'error', SQLERRM); END IF;
    END;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'simulacion', p_simular, 'revisadas', n_rev, 'corregidas', n_fix, 'clientes_creados', n_new,
    'ruc_invalido', n_bad, 'omitidas_revertidas', n_skip, 'errores', n_err, 'corte', v_cut, 'detalle', v_det);
END $$;

-- Historial de correcciones (Administrador, Contratos y OTs, Clientes; el Administrador de Contratos, las de su cartera)
CREATE OR REPLACE FUNCTION public.erp_cliente_correcciones(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ca boolean := public.is_contract_administrator() AND NOT public.is_tms_admin(); v_out jsonb;
  v_ot text := NULLIF(btrim(COALESCE(p->>'ot', '')), ''); v_lim integer := least(greatest(COALESCE((p->>'limit')::integer, 50), 1), 500);
BEGIN
  IF NOT (public.is_tms_admin() OR public.is_contract_administrator() OR public.has_tms_permission('ot') OR public.has_tms_permission('clientes')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso');
  END IF;
  SELECT jsonb_build_object('success', true, 'puede_administrar', public.is_tms_admin(), 'filas', COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC), '[]'::jsonb))
  INTO v_out FROM (
    SELECT k.id, k.contract_id, k.contract_code AS ot, k.old_client_name, k.new_client_name, k.ruc_erp, k.cliente_erp, k.client_created, k.corte,
      cardinality(k.open_request_ids) AS abiertas, cardinality(k.kept_request_ids) AS conservadas, k.created_at,
      k.closed_applied_at, k.closed_applied, k.closed_motivo, k.reverted_at, k.revert_motivo,
      (SELECT concat_ws(' ', pr.first_name, pr.last_name) FROM public.profiles pr WHERE pr.id = k.created_by) AS creado_por
    FROM public.contract_client_corrections k
    WHERE (v_ot IS NULL OR k.contract_code = v_ot) AND (NOT v_ca OR public.has_assigned_contract(k.contract_id))
    ORDER BY k.created_at DESC LIMIT v_lim) x;
  RETURN v_out;
END $$;

-- Administrador: aplicar la corrección también a las solicitudes en ruta o cerradas que conservaron el cliente anterior
CREATE OR REPLACE FUNCTION public.erp_cliente_correccion_aplicar_cerradas(p_id uuid, p_motivo text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE k record; v_n integer;
BEGIN
  IF NOT public.is_tms_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'Solo el Administrador del sistema'); END IF;
  IF length(btrim(COALESCE(p_motivo, ''))) < 5 THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo (mínimo 5 caracteres)'); END IF;
  SELECT * INTO k FROM public.contract_client_corrections WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Corrección no encontrada'); END IF;
  IF k.reverted_at IS NOT NULL THEN RETURN jsonb_build_object('success', false, 'error', 'La corrección fue revertida'); END IF;
  IF k.closed_applied_at IS NOT NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Ya se aplicó a las solicitudes cerradas'); END IF;
  UPDATE public.transport_requests SET client_id = k.new_client_id
   WHERE id = ANY (k.kept_request_ids) AND client_id IS DISTINCT FROM k.new_client_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE public.contract_client_corrections SET closed_applied_at = now(), closed_applied_by = auth.uid(), closed_applied = v_n,
    closed_motivo = btrim(p_motivo) WHERE id = p_id;
  RETURN jsonb_build_object('success', true, 'actualizadas', v_n);
END $$;

-- Administrador: revertir la corrección (OT, familia y las solicitudes que se corrigieron vuelven al cliente anterior)
CREATE OR REPLACE FUNCTION public.erp_cliente_correccion_revertir(p_id uuid, p_motivo text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE k record; v_n integer;
BEGIN
  IF NOT public.is_tms_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'Solo el Administrador del sistema'); END IF;
  IF length(btrim(COALESCE(p_motivo, ''))) < 5 THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo (mínimo 5 caracteres)'); END IF;
  SELECT * INTO k FROM public.contract_client_corrections WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Corrección no encontrada'); END IF;
  IF k.reverted_at IS NOT NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Ya fue revertida'); END IF;
  IF k.old_client_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'La OT no tenía cliente antes de la corrección: no hay a cuál volver'); END IF;
  IF EXISTS (SELECT 1 FROM public.contract_client_corrections x WHERE x.contract_id = k.contract_id AND x.created_at > k.created_at AND x.reverted_at IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Hay una corrección posterior de la misma OT: reviértala primero');
  END IF;
  PERFORM set_config('jrm.cliente_erp', 'ninguna', true);
  UPDATE public.contracts SET client_id = k.old_client_id WHERE id = k.contract_id;
  PERFORM set_config('jrm.cliente_erp', '', true);
  UPDATE public.transport_requests tr SET client_id = k.old_client_id
   WHERE tr.client_id IS DISTINCT FROM k.old_client_id
     AND (tr.id = ANY (k.open_request_ids) OR (k.closed_applied_at IS NOT NULL AND tr.id = ANY (k.kept_request_ids))
          OR (public.erp_request_open(tr.status::text) AND tr.contract_id IN (SELECT c.id FROM public.contracts c WHERE c.id = k.contract_id OR c.parent_contract_id = k.contract_id)));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE public.contract_client_corrections SET reverted_at = now(), reverted_by = auth.uid(), revert_motivo = btrim(p_motivo) WHERE id = p_id;
  RETURN jsonb_build_object('success', true, 'solicitudes', v_n);
END $$;

REVOKE ALL ON FUNCTION public.erp_contratos_config_json(), public.erp_contratos_config_set(jsonb), public.erp_ref_contratos(text[]),
  public.erp_ref_documento(text), public.erp_ref_sin_alta(jsonb), public.erp_ref_guias_lote(jsonb), public.erp_cliente_desde_erp(text),
  public.erp_contratos_sincronizar_clientes(boolean), public.erp_cliente_correcciones(jsonb),
  public.erp_cliente_correccion_aplicar_cerradas(uuid, text), public.erp_cliente_correccion_revertir(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_contratos_config_json(), public.erp_contratos_config_set(jsonb), public.erp_ref_contratos(text[]),
  public.erp_ref_documento(text), public.erp_ref_sin_alta(jsonb), public.erp_ref_guias_lote(jsonb), public.erp_cliente_desde_erp(text),
  public.erp_contratos_sincronizar_clientes(boolean), public.erp_cliente_correcciones(jsonb),
  public.erp_cliente_correccion_aplicar_cerradas(uuid, text), public.erp_cliente_correccion_revertir(uuid, text) TO authenticated;

COMMIT;
