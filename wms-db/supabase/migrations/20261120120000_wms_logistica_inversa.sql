-- Logística Inversa · Fases 4 a 6 (decisiones del 20-11-2026). Reglas:
--  · Un expediente por documento «GUIA DE RECOJO» de las bodegas en alcance (wh_return_scope), creado desde el libro del ERP;
--    el ERP ya contabilizó el ingreso: el expediente NUNCA incrementa existencias del ERP. Retornos no anunciados = expediente
--    PROVISIONAL con identificador temporal, bloqueado hasta regularizar.
--  · Recepción física por línea (parcial permitida), con método de peso; puede etiquetar el material como paquete WMS en
--    CUARENTENA (no disponible para despacho).
--  · Motivo (expediente), condición (fracción) y disposición (fracción) son campos separados.
--  · Inspección por fracción: la suma de fracciones no supera lo recibido; inspecciona el Analista (decisión 4), que no
--    puede ser quien recibió.
--  · Disposición: la propone Inventario y la autoriza supervisión (Jefatura), nunca quien la propuso; la ejecución de
--    REINCORPORAR se verifica por otra persona y recién entonces el paquete deja la cuarentena.
--  · Reproceso solo en el WMS: orden con ciclos, entradas (fracciones), insumos, recuperado, residuo, en proceso y diferencia;
--    el balance debe cuadrar o explicarse; verifica alguien distinto del ejecutor; un nuevo ciclo no cuenta como nuevo retorno.
--  · Cierre: todo recibido, cada fracción con resolución ejecutada (y verificada si reincorpora) y la suma conciliada.

ALTER TABLE public.wh_packages DROP CONSTRAINT IF EXISTS wh_packages_source_kind_check;
ALTER TABLE public.wh_packages ADD CONSTRAINT wh_packages_source_kind_check CHECK (source_kind IN ('IPT','INVENTARIO','RETORNO'));

CREATE SEQUENCE IF NOT EXISTS public.wh_returns_seq;
CREATE TABLE IF NOT EXISTS public.wh_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE DEFAULT 'DEV-' || lpad(nextval('public.wh_returns_seq')::text, 6, '0'),
  site_id uuid NOT NULL REFERENCES public.sites(id),
  source text NOT NULL CHECK (source IN ('ERP','NO_ANUNCIADO')),
  bodega text, tipodocto text, numero text, fecha date, ruc text, cliente text, ot text,
  motivo text CHECK (motivo IS NULL OR motivo IN ('SALDO_OBRA','DEVOLUCION','ERROR','CALIDAD','GARANTIA','REPROCESO','NO_ANUNCIADO','OTRO')),
  status text NOT NULL DEFAULT 'RECIBIDO_ERP' CHECK (status IN ('RECIBIDO_ERP','PROVISIONAL','EN_RECEPCION','PENDIENTE_INSPECCION','EN_DISPOSICION','EN_TRATAMIENTO','RESUELTO','CERRADO')),
  tms_request_number text, responsible uuid REFERENCES public.profiles(id), due_at timestamptz, notes text,
  created_by uuid REFERENCES public.profiles(id), created_at timestamptz NOT NULL DEFAULT now(),
  closed_by uuid REFERENCES public.profiles(id), closed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS wh_returns_erp_doc_key ON public.wh_returns(bodega, tipodocto, numero) WHERE source = 'ERP';
CREATE INDEX IF NOT EXISTS wh_returns_site_idx ON public.wh_returns(site_id);
CREATE INDEX IF NOT EXISTS wh_returns_responsible_idx ON public.wh_returns(responsible);
CREATE INDEX IF NOT EXISTS wh_returns_created_by_idx ON public.wh_returns(created_by);
CREATE INDEX IF NOT EXISTS wh_returns_closed_by_idx ON public.wh_returns(closed_by);
CREATE INDEX IF NOT EXISTS wh_returns_status_idx ON public.wh_returns(status, fecha);

CREATE TABLE IF NOT EXISTS public.wh_return_lines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_id uuid NOT NULL REFERENCES public.wh_returns(id),
  mkey text,
  producto text, glosa text, lote text, unidad text,
  qty_declared numeric NOT NULL CHECK (qty_declared >= 0), kg_declared numeric, peso_origen text NOT NULL DEFAULT 'SIN_DATO',
  erp_state text NOT NULL DEFAULT 'VIGENTE' CHECK (erp_state IN ('VIGENTE','BAJA_ERP','PROVISIONAL')),
  qty_received numeric CHECK (qty_received IS NULL OR qty_received >= 0), kg_received numeric CHECK (kg_received IS NULL OR kg_received >= 0),
  weight_method text CHECK (weight_method IS NULL OR weight_method IN ('BALANZA','MAESTRO','DOCUMENTO','ESTIMADO')),
  received_by uuid REFERENCES public.profiles(id), received_at timestamptz, receipt_note text,
  package_id uuid REFERENCES public.wh_packages(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS wh_return_lines_mkey_key ON public.wh_return_lines(mkey) WHERE mkey IS NOT NULL;
CREATE INDEX IF NOT EXISTS wh_return_lines_return_idx ON public.wh_return_lines(return_id);
CREATE INDEX IF NOT EXISTS wh_return_lines_received_by_idx ON public.wh_return_lines(received_by);
CREATE INDEX IF NOT EXISTS wh_return_lines_package_idx ON public.wh_return_lines(package_id);

CREATE TABLE IF NOT EXISTS public.wh_return_fractions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  line_id bigint NOT NULL REFERENCES public.wh_return_lines(id),
  qty numeric NOT NULL CHECK (qty > 0), kg numeric CHECK (kg IS NULL OR kg >= 0),
  condition text NOT NULL CHECK (condition IN ('UTILIZABLE','REQUIERE_ACONDICIONAMIENTO','REQUIERE_REPROCESO','DANADO','PENDIENTE_EVALUACION','NO_IDENTIFICADO')),
  finding text, recommendation text, evidence_paths text[] NOT NULL DEFAULT '{}',
  inspected_by uuid NOT NULL REFERENCES public.profiles(id), inspected_at timestamptz NOT NULL DEFAULT now(),
  disposition text CHECK (disposition IS NULL OR disposition IN ('REINCORPORAR','ACONDICIONAR','REPROCESAR','TRANSFERIR','DEVOLVER','MANTENER_BLOQUEADO','BAJA')),
  disposition_status text CHECK (disposition_status IS NULL OR disposition_status IN ('PROPUESTA','AUTORIZADA','RECHAZADA','EJECUTADA','VERIFICADA')),
  disposition_reason text, destination text, disposition_due timestamptz,
  proposed_by uuid REFERENCES public.profiles(id), proposed_at timestamptz,
  authorized_by uuid REFERENCES public.profiles(id), authorized_at timestamptz, authorization_comment text,
  executed_by uuid REFERENCES public.profiles(id), executed_at timestamptz, execution_note text,
  verified_by uuid REFERENCES public.profiles(id), verified_at timestamptz
);
CREATE INDEX IF NOT EXISTS wh_return_fractions_line_idx ON public.wh_return_fractions(line_id);
CREATE INDEX IF NOT EXISTS wh_return_fractions_inspected_by_idx ON public.wh_return_fractions(inspected_by);
CREATE INDEX IF NOT EXISTS wh_return_fractions_proposed_by_idx ON public.wh_return_fractions(proposed_by);
CREATE INDEX IF NOT EXISTS wh_return_fractions_authorized_by_idx ON public.wh_return_fractions(authorized_by);
CREATE INDEX IF NOT EXISTS wh_return_fractions_executed_by_idx ON public.wh_return_fractions(executed_by);
CREATE INDEX IF NOT EXISTS wh_return_fractions_verified_by_idx ON public.wh_return_fractions(verified_by);

CREATE SEQUENCE IF NOT EXISTS public.wh_reprocess_seq;
CREATE TABLE IF NOT EXISTS public.wh_reprocess_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE DEFAULT 'RP-' || lpad(nextval('public.wh_reprocess_seq')::text, 6, '0'),
  site_id uuid NOT NULL REFERENCES public.sites(id),
  return_id uuid NOT NULL REFERENCES public.wh_returns(id),
  parent_id uuid REFERENCES public.wh_reprocess_orders(id), cycle integer NOT NULL DEFAULT 1,
  objective text NOT NULL, executor_type text NOT NULL CHECK (executor_type IN ('INTERNO','EXTERNO')), executor_name text,
  status text NOT NULL DEFAULT 'ABIERTA' CHECK (status IN ('ABIERTA','EN_PROCESO','EN_PAUSA','TERMINADA','VERIFICADA','RECHAZADA')),
  kg_input numeric NOT NULL DEFAULT 0, kg_added numeric NOT NULL DEFAULT 0, kg_recovered numeric, kg_waste numeric, kg_in_process numeric, kg_diff numeric, diff_note text,
  due_at timestamptz, started_at timestamptz, finished_at timestamptz,
  created_by uuid NOT NULL REFERENCES public.profiles(id), created_at timestamptz NOT NULL DEFAULT now(),
  executed_by uuid REFERENCES public.profiles(id), verified_by uuid REFERENCES public.profiles(id), verified_at timestamptz, result_note text
);
CREATE INDEX IF NOT EXISTS wh_reprocess_orders_return_idx ON public.wh_reprocess_orders(return_id);
CREATE INDEX IF NOT EXISTS wh_reprocess_orders_parent_idx ON public.wh_reprocess_orders(parent_id);
CREATE INDEX IF NOT EXISTS wh_reprocess_orders_site_idx ON public.wh_reprocess_orders(site_id);
CREATE INDEX IF NOT EXISTS wh_reprocess_orders_created_by_idx ON public.wh_reprocess_orders(created_by);
CREATE INDEX IF NOT EXISTS wh_reprocess_orders_executed_by_idx ON public.wh_reprocess_orders(executed_by);
CREATE INDEX IF NOT EXISTS wh_reprocess_orders_verified_by_idx ON public.wh_reprocess_orders(verified_by);
CREATE TABLE IF NOT EXISTS public.wh_reprocess_inputs (
  order_id uuid NOT NULL REFERENCES public.wh_reprocess_orders(id), fraction_id bigint NOT NULL REFERENCES public.wh_return_fractions(id), kg numeric,
  PRIMARY KEY (order_id, fraction_id)
);
CREATE INDEX IF NOT EXISTS wh_reprocess_inputs_fraction_idx ON public.wh_reprocess_inputs(fraction_id);

CREATE TABLE IF NOT EXISTS public.wh_return_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_id uuid NOT NULL REFERENCES public.wh_returns(id),
  action text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb, comment text, evidence_paths text[] NOT NULL DEFAULT '{}',
  actor_id uuid REFERENCES public.profiles(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wh_return_events_return_idx ON public.wh_return_events(return_id, created_at);
CREATE INDEX IF NOT EXISTS wh_return_events_actor_idx ON public.wh_return_events(actor_id);
DROP TRIGGER IF EXISTS wh_return_events_immutable ON public.wh_return_events;
CREATE TRIGGER wh_return_events_immutable BEFORE UPDATE OR DELETE ON public.wh_return_events FOR EACH ROW EXECUTE FUNCTION public.wh_reject_scan_mutation();

DO $p$
DECLARE tb text;
BEGIN
  FOREACH tb IN ARRAY ARRAY['wh_returns','wh_return_lines','wh_return_fractions','wh_reprocess_orders','wh_reprocess_inputs','wh_return_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tb);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', tb);
    EXECUTE format('DROP POLICY IF EXISTS security_active_account ON public.%I', tb);
    EXECUTE format('CREATE POLICY security_active_account ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()))', tb);
  END LOOP;
END $p$;
REVOKE ALL ON SEQUENCE public.wh_returns_seq, public.wh_reprocess_seq FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION wms_private.wh_return_log(p_return uuid, p_action text, p_payload jsonb DEFAULT '{}'::jsonb, p_comment text DEFAULT NULL, p_evidence text[] DEFAULT '{}')
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO public.wh_return_events(return_id, action, payload, comment, evidence_paths, actor_id) VALUES (p_return, p_action, coalesce(p_payload, '{}'::jsonb), nullif(btrim(p_comment), ''), coalesce(p_evidence, '{}'), auth.uid())
$$;
REVOKE ALL ON FUNCTION wms_private.wh_return_log(uuid, text, jsonb, text, text[]) FROM PUBLIC, anon, authenticated;

-- Estado del expediente calculado desde sus líneas y fracciones (no se edita a mano)
CREATE OR REPLACE FUNCTION wms_private.wh_return_refresh(p_return uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.wh_returns%ROWTYPE; v text; n_lines int; n_recv int; v_recv numeric; v_frac numeric; n_open int; n_reproc int; n_prop int;
BEGIN
  SELECT * INTO r FROM public.wh_returns WHERE id = p_return FOR UPDATE;
  IF r.status = 'CERRADO' THEN RETURN r.status; END IF;
  SELECT count(*) FILTER (WHERE erp_state <> 'BAJA_ERP'), count(*) FILTER (WHERE erp_state <> 'BAJA_ERP' AND qty_received IS NOT NULL), coalesce(sum(qty_received), 0)
    INTO n_lines, n_recv, v_recv FROM public.wh_return_lines WHERE return_id = r.id;
  SELECT coalesce(sum(f.qty), 0), count(*) FILTER (WHERE f.disposition_status IS DISTINCT FROM 'VERIFICADA' AND NOT coalesce(f.disposition_status = 'EJECUTADA' AND f.disposition IN ('BAJA','DEVOLVER','TRANSFERIR'), false)),
         count(*) FILTER (WHERE f.disposition = 'REPROCESAR' AND f.disposition_status IN ('AUTORIZADA','EJECUTADA')), count(*) FILTER (WHERE f.disposition_status IN ('PROPUESTA','AUTORIZADA') OR f.disposition IS NULL)
    INTO v_frac, n_open, n_reproc, n_prop
  FROM public.wh_return_fractions f JOIN public.wh_return_lines l ON l.id = f.line_id WHERE l.return_id = r.id;
  v := CASE WHEN n_recv = 0 THEN CASE WHEN r.source = 'NO_ANUNCIADO' THEN 'PROVISIONAL' ELSE 'RECIBIDO_ERP' END
            WHEN n_recv < n_lines THEN 'EN_RECEPCION'
            WHEN v_frac < v_recv THEN 'PENDIENTE_INSPECCION'
            WHEN n_reproc > 0 THEN 'EN_TRATAMIENTO'
            WHEN n_open > 0 THEN 'EN_DISPOSICION'
            ELSE 'RESUELTO' END;
  IF v IS DISTINCT FROM r.status THEN UPDATE public.wh_returns SET status = v WHERE id = r.id; END IF;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION wms_private.wh_return_refresh(uuid) FROM PUBLIC, anon, authenticated;

-- Sincroniza expedientes y líneas con el libro del ERP (nuevas guías, nuevas líneas, bajas del ERP). Idempotente.
CREATE OR REPLACE FUNCTION wms_private.wh_returns_sync()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_site uuid; n int := 0; d record;
BEGIN
  SELECT id INTO v_site FROM public.sites ORDER BY (code = 'PRINCIPAL') DESC, code LIMIT 1;
  FOR d IN SELECT m.bodega, upper(btrim(m.tipodocto)) tipodocto, m.numero, min(m.fecha) fecha, max(m.cod_legal) ruc, max(m.razon_social) cliente,
                  max(coalesce(nullif(m.ot, ''), substring(coalesce(m.lote, '') FROM '^([0-9]{5,6})'))) ot
           FROM public.inv_movements m JOIN public.wh_return_scope s ON s.bodega = m.bodega AND s.tipodocto = upper(btrim(m.tipodocto))
           WHERE m.active AND m.side = 'E' AND m.mkey IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM public.wh_returns r WHERE r.source = 'ERP' AND r.bodega = m.bodega AND r.tipodocto = upper(btrim(m.tipodocto)) AND r.numero = m.numero)
           GROUP BY 1, 2, 3 LOOP
    INSERT INTO public.wh_returns(site_id, source, bodega, tipodocto, numero, fecha, ruc, cliente, ot) VALUES (v_site, 'ERP', d.bodega, d.tipodocto, d.numero, d.fecha, d.ruc, d.cliente, d.ot);
    n := n + 1;
  END LOOP;
  INSERT INTO public.wh_return_lines(return_id, mkey, producto, glosa, lote, unidad, qty_declared, kg_declared, peso_origen)
  SELECT r.id, m.mkey, m.producto, m.glosa, m.lote, public.inv_unit_norm(m.unidad), abs(m.cantidad),
         CASE WHEN m.peso_kg > 0 THEN m.peso_kg ELSE nullif(round(s.peso_unit * abs(m.cantidad), 3), 0) END,
         CASE WHEN m.peso_kg > 0 THEN 'ERP' WHEN s.peso_unit > 0 AND round(s.peso_unit * abs(m.cantidad), 3) > 0 THEN 'MAESTRO' ELSE 'SIN_DATO' END
  FROM public.inv_movements m JOIN public.wh_returns r ON r.source = 'ERP' AND r.bodega = m.bodega AND r.tipodocto = upper(btrim(m.tipodocto)) AND r.numero = m.numero
  LEFT JOIN public.erp_sku_medidas s ON s.cod_producto = m.producto
  WHERE m.active AND m.side = 'E' AND m.mkey IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.wh_return_lines l WHERE l.mkey = m.mkey);
  -- Línea que el ERP dio de baja: se marca (no se borra) para conciliar
  UPDATE public.wh_return_lines l SET erp_state = 'BAJA_ERP' WHERE l.mkey IS NOT NULL AND l.erp_state = 'VIGENTE'
    AND NOT EXISTS (SELECT 1 FROM public.inv_movements m WHERE m.active AND m.mkey = l.mkey);
  UPDATE public.wh_return_lines l SET erp_state = 'VIGENTE' WHERE l.mkey IS NOT NULL AND l.erp_state = 'BAJA_ERP'
    AND EXISTS (SELECT 1 FROM public.inv_movements m WHERE m.active AND m.mkey = l.mkey);
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION wms_private.wh_returns_sync() FROM PUBLIC, anon, authenticated;
DO $c$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'wh-returns-sync';
    PERFORM cron.schedule('wh-returns-sync', '17 * * * *', 'SELECT wms_private.wh_returns_sync()');
  END IF;
END $c$;
SELECT wms_private.wh_returns_sync();

CREATE OR REPLACE FUNCTION wms_private.wh_return_perm(p_codes text[])
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(p_codes) THEN RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION wms_private.wh_return_perm(text[]) FROM PUBLIC, anon, authenticated;

-- Bandeja de expedientes
CREATE OR REPLACE FUNCTION public.wh_returns_list(p_status text DEFAULT NULL, p_search text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_q text := nullif(upper(btrim(p_search)), '');
BEGIN
  PERFORM wms_private.wh_return_perm(ARRAY['almacen-inventario','almacen-supervisor','almacen-lectura','almacen-etiquetado']);
  PERFORM wms_private.wh_returns_sync();
  RETURN coalesce((SELECT jsonb_agg(x ORDER BY x->>'fecha' DESC NULLS FIRST, x->>'code' DESC) FROM (
    SELECT jsonb_build_object('id', r.id, 'code', r.code, 'source', r.source, 'numero', r.numero, 'fecha', r.fecha, 'cliente', r.cliente, 'ruc', r.ruc, 'ot', r.ot,
      'motivo', r.motivo, 'status', r.status, 'tms', r.tms_request_number, 'responsable', public.wh_profile_name(r.responsible), 'due_at', r.due_at,
      'lineas', (SELECT count(*) FROM public.wh_return_lines l WHERE l.return_id = r.id AND l.erp_state <> 'BAJA_ERP'),
      'bajas_erp', (SELECT count(*) FROM public.wh_return_lines l WHERE l.return_id = r.id AND l.erp_state = 'BAJA_ERP'),
      'kg_declarado', (SELECT sum(kg_declared) FROM public.wh_return_lines l WHERE l.return_id = r.id AND l.erp_state <> 'BAJA_ERP'),
      'sin_peso', (SELECT count(*) FROM public.wh_return_lines l WHERE l.return_id = r.id AND l.kg_declared IS NULL AND l.erp_state <> 'BAJA_ERP'),
      'kg_recibido', (SELECT sum(kg_received) FROM public.wh_return_lines l WHERE l.return_id = r.id)) x
    FROM public.wh_returns r
    WHERE public.can_access_site(r.site_id) AND (p_status IS NULL OR (p_status = 'ABIERTOS' AND r.status NOT IN ('RESUELTO','CERRADO')) OR r.status = p_status)
      AND (v_q IS NULL OR upper(coalesce(r.numero, '')) LIKE '%' || v_q || '%' OR upper(coalesce(r.cliente, '')) LIKE '%' || v_q || '%' OR coalesce(r.ot, '') LIKE '%' || v_q || '%' OR r.code = v_q)
    ORDER BY r.created_at DESC LIMIT 500) s), '[]'::jsonb);
END $$;

-- Detalle completo del expediente
CREATE OR REPLACE FUNCTION public.wh_return_detail(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.wh_returns%ROWTYPE;
BEGIN
  PERFORM wms_private.wh_return_perm(ARRAY['almacen-inventario','almacen-supervisor','almacen-lectura','almacen-etiquetado']);
  SELECT * INTO r FROM public.wh_returns WHERE id = p_id AND public.can_access_site(site_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'Expediente no disponible'; END IF;
  RETURN to_jsonb(r) || jsonb_build_object('responsable', public.wh_profile_name(r.responsible), 'cerro', public.wh_profile_name(r.closed_by),
    'lines', coalesce((SELECT jsonb_agg(to_jsonb(l) || jsonb_build_object('recibio', public.wh_profile_name(l.received_by),
        'package_code', (SELECT package_code FROM public.wh_packages p WHERE p.id = l.package_id),
        'package_hold', (SELECT hold_status FROM public.wh_packages p WHERE p.id = l.package_id),
        'fractions', coalesce((SELECT jsonb_agg(to_jsonb(f) || jsonb_build_object('inspecciono', public.wh_profile_name(f.inspected_by), 'propuso', public.wh_profile_name(f.proposed_by),
            'autorizo', public.wh_profile_name(f.authorized_by), 'ejecuto', public.wh_profile_name(f.executed_by), 'verifico', public.wh_profile_name(f.verified_by),
            'reproceso', (SELECT o.code FROM public.wh_reprocess_inputs i JOIN public.wh_reprocess_orders o ON o.id = i.order_id WHERE i.fraction_id = f.id ORDER BY o.cycle DESC LIMIT 1)) ORDER BY f.id)
          FROM public.wh_return_fractions f WHERE f.line_id = l.id), '[]'::jsonb)) ORDER BY l.id)
      FROM public.wh_return_lines l WHERE l.return_id = r.id), '[]'::jsonb),
    'reprocesos', coalesce((SELECT jsonb_agg(to_jsonb(o) || jsonb_build_object('creo', public.wh_profile_name(o.created_by), 'ejecuto', public.wh_profile_name(o.executed_by),
        'verifico', public.wh_profile_name(o.verified_by), 'fracciones', (SELECT jsonb_agg(i.fraction_id) FROM public.wh_reprocess_inputs i WHERE i.order_id = o.id)) ORDER BY o.created_at)
      FROM public.wh_reprocess_orders o WHERE o.return_id = r.id), '[]'::jsonb),
    'events', coalesce((SELECT jsonb_agg(jsonb_build_object('action', e.action, 'payload', e.payload, 'comment', e.comment, 'by', public.wh_profile_name(e.actor_id), 'at', e.created_at) ORDER BY e.created_at)
      FROM public.wh_return_events e WHERE e.return_id = r.id), '[]'::jsonb),
    'tms_sugeridos', '[]'::jsonb);
END $$;

-- Datos de gestión del expediente (motivo, vínculo con el RECOJO del TMS, responsable, compromiso, notas)
CREATE OR REPLACE FUNCTION public.wh_return_update(p_id uuid, p_motivo text, p_tms_request text DEFAULT NULL, p_responsible uuid DEFAULT NULL, p_due_at timestamptz DEFAULT NULL, p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.wh_returns%ROWTYPE;
BEGIN
  PERFORM wms_private.wh_return_perm(ARRAY['almacen-inventario','almacen-supervisor']);
  SELECT * INTO r FROM public.wh_returns WHERE id = p_id AND public.can_access_site(site_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expediente no disponible'; END IF;
  IF r.status = 'CERRADO' THEN RAISE EXCEPTION 'El expediente está cerrado'; END IF;
  UPDATE public.wh_returns SET motivo = nullif(upper(btrim(p_motivo)), ''), tms_request_number = nullif(upper(btrim(p_tms_request)), ''),
    responsible = coalesce(p_responsible, responsible), due_at = coalesce(p_due_at, due_at), notes = coalesce(nullif(btrim(p_notes), ''), notes) WHERE id = r.id;
  PERFORM wms_private.wh_return_log(r.id, 'ACTUALIZAR', jsonb_strip_nulls(jsonb_build_object('motivo', p_motivo, 'tms', p_tms_request, 'responsable', p_responsible, 'compromiso', p_due_at)));
  RETURN jsonb_build_object('id', r.id);
END $$;

-- Retorno no anunciado o sin identificación: expediente provisional con identificador temporal (bloqueado)
CREATE OR REPLACE FUNCTION public.wh_return_provisional(p_cliente text, p_descripcion text, p_qty numeric, p_unidad text, p_kg numeric DEFAULT NULL, p_notes text DEFAULT NULL, p_due_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid; v_code text; v_site uuid;
BEGIN
  PERFORM wms_private.wh_return_perm(ARRAY['almacen-inventario','almacen-supervisor','almacen-etiquetado']);
  IF nullif(btrim(p_descripcion), '') IS NULL OR coalesce(p_qty, 0) <= 0 THEN RAISE EXCEPTION 'Indique descripción y cantidad'; END IF;
  SELECT s.id INTO v_site FROM public.sites s WHERE public.can_access_site(s.id) ORDER BY (s.code = 'PRINCIPAL') DESC LIMIT 1;
  INSERT INTO public.wh_returns(site_id, source, status, cliente, motivo, notes, due_at, created_by) VALUES (v_site, 'NO_ANUNCIADO', 'PROVISIONAL', nullif(btrim(p_cliente), ''), 'NO_ANUNCIADO', nullif(btrim(p_notes), ''), p_due_at, auth.uid())
  RETURNING id, code INTO v_id, v_code;
  INSERT INTO public.wh_return_lines(return_id, producto, glosa, unidad, qty_declared, kg_declared, peso_origen, erp_state)
  VALUES (v_id, NULL, btrim(p_descripcion), public.inv_unit_norm(p_unidad), p_qty, nullif(p_kg, 0), CASE WHEN p_kg > 0 THEN 'ESTIMADO' ELSE 'SIN_DATO' END, 'PROVISIONAL');
  PERFORM wms_private.wh_return_log(v_id, 'PROVISIONAL', jsonb_build_object('descripcion', p_descripcion, 'qty', p_qty));
  RETURN jsonb_build_object('id', v_id, 'code', v_code);
END $$;

-- Crea un paquete de material retornado (en cuarentena o disponible)
CREATE OR REPLACE FUNCTION wms_private.wh_return_new_package(p_line bigint, p_qty numeric, p_kg numeric, p_hold text, p_reason text, p_tag text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l public.wh_return_lines%ROWTYPE; r public.wh_returns%ROWTYPE; v_pkg uuid := gen_random_uuid();
BEGIN
  SELECT * INTO l FROM public.wh_return_lines WHERE id = p_line;
  SELECT * INTO r FROM public.wh_returns WHERE id = l.return_id;
  INSERT INTO public.wh_packages(id, package_code, source_system, source_document_no, source_contract_code, source_lot, source_product_code, source_unit, source_warehouse, source_date,
    source_movement_key, source_key, site_id, description, quantity, unit, weight_kg, created_by, source_kind, hold_status, hold_reason, hold_by, hold_at)
  VALUES (v_pkg, public.wh_next_bulto_code(coalesce(l.lote, r.code)), CASE WHEN r.source = 'ERP' THEN 'ERP' ELSE 'WMS' END, coalesce(r.numero, r.code), r.ot, coalesce(l.lote, ''),
    coalesce(l.producto, 'SIN-IDENTIFICAR'), coalesce(l.unidad, ''), coalesce(r.bodega, '540-04 APT LB'), coalesce(r.fecha, (now() AT TIME ZONE 'America/Lima')::date),
    'RET:' || l.id || ':' || p_tag, 'RET:' || v_pkg, r.site_id, coalesce(l.glosa, l.producto, 'Material retornado'), p_qty, l.unidad, nullif(p_kg, 0), auth.uid(), 'RETORNO',
    p_hold, p_reason, auth.uid(), now());
  RETURN v_pkg;
END $$;
REVOKE ALL ON FUNCTION wms_private.wh_return_new_package(bigint, numeric, numeric, text, text, text) FROM PUBLIC, anon, authenticated;

-- Liquida una línea cuando todas sus fracciones tienen resolución final. Si todo se reincorporó verificado, el paquete de
-- recepción sale de la cuarentena tal cual; si no, se anula y se crean paquetes solo por lo reincorporado/acondicionado y por
-- lo recuperado en cada orden de reproceso verificada (repartido por la masa de entrada de cada fracción; un ciclo posterior
-- agrega su propio paquete). Lo dado de baja, devuelto o transferido no vuelve al stock. Nunca libera sin decisión verificada.
CREATE OR REPLACE FUNCTION wms_private.wh_return_settle_line(p_line bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l public.wh_return_lines%ROWTYPE; r public.wh_returns%ROWTYPE; x record; v_pkg uuid; v_q numeric; v_kg numeric;
BEGIN
  SELECT * INTO l FROM public.wh_return_lines WHERE id = p_line FOR UPDATE;
  IF l.package_id IS NULL OR l.qty_received IS NULL THEN RETURN; END IF;
  IF coalesce((SELECT sum(qty) FROM public.wh_return_fractions WHERE line_id = l.id), 0) <> l.qty_received THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.wh_return_fractions f WHERE f.line_id = l.id AND NOT coalesce(
       f.disposition_status = 'VERIFICADA' OR (f.disposition_status = 'EJECUTADA' AND f.disposition IN ('BAJA','DEVOLVER','TRANSFERIR')), false)) THEN RETURN; END IF;
  SELECT * INTO r FROM public.wh_returns WHERE id = l.return_id;
  IF (SELECT hold_status FROM public.wh_packages WHERE id = l.package_id) = 'CUARENTENA' THEN
    IF NOT EXISTS (SELECT 1 FROM public.wh_return_fractions f WHERE f.line_id = l.id AND f.disposition IS DISTINCT FROM 'REINCORPORAR') THEN
      UPDATE public.wh_packages SET hold_status = NULL, hold_reason = 'Reincorporado (verificado) · ' || r.code, hold_by = auth.uid(), hold_at = now(), updated_at = now() WHERE id = l.package_id;
      INSERT INTO public.wh_scan_events(site_id, package_id, event_type, scanned_code, payload, operator_id, client_event_id)
      SELECT p.site_id, p.id, 'RELEASE', p.package_code, jsonb_build_object('from', 'CUARENTENA', 'to', NULL, 'reason', 'Reincorporación verificada ' || r.code), auth.uid(), gen_random_uuid() FROM public.wh_packages p WHERE p.id = l.package_id;
      RETURN;
    END IF;
    UPDATE public.wh_packages SET status = 'VOID', void_reason = 'Retorno ' || r.code || ' resuelto por fracciones', updated_at = now() WHERE id = l.package_id AND status = 'AVAILABLE';
    FOR x IN SELECT f.* FROM public.wh_return_fractions f WHERE f.line_id = l.id AND f.disposition IN ('REINCORPORAR','ACONDICIONAR') AND f.disposition_status = 'VERIFICADA' LOOP
      v_pkg := wms_private.wh_return_new_package(l.id, x.qty, x.kg, NULL, 'Reincorporado (verificado) · ' || r.code, 'F' || x.id);
    END LOOP;
  ELSIF (SELECT status FROM public.wh_packages WHERE id = l.package_id) <> 'VOID' THEN
    RETURN; -- liberado entero (todo reincorporado): no hay nada más que liquidar
  END IF;
  -- Recuperado de cada orden verificada, una sola vez por orden y fracción
  FOR x IN SELECT f.id, f.qty, f.kg, o.id oid, o.code, o.kg_recovered * i.kg / nullif((SELECT sum(i2.kg) FROM public.wh_reprocess_inputs i2 WHERE i2.order_id = o.id), 0) share
           FROM public.wh_return_fractions f JOIN public.wh_reprocess_inputs i ON i.fraction_id = f.id JOIN public.wh_reprocess_orders o ON o.id = i.order_id AND o.status = 'VERIFICADA'
           WHERE f.line_id = l.id AND f.disposition = 'REPROCESAR' AND o.kg_recovered > 0 AND f.kg > 0 AND i.kg > 0
             AND NOT EXISTS (SELECT 1 FROM public.wh_packages p WHERE p.source_movement_key = 'RET:' || l.id || ':R' || o.id || ':' || f.id) LOOP
    v_kg := round(x.share, 3);
    v_q := round(x.qty * v_kg / x.kg, 3);
    IF v_q > 0 THEN v_pkg := wms_private.wh_return_new_package(l.id, v_q, v_kg, NULL, 'Recuperado por reproceso ' || x.code || ' (verificado) · ' || r.code, 'R' || x.oid || ':' || x.id); END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION wms_private.wh_return_settle_line(bigint) FROM PUBLIC, anon, authenticated;

-- Recepción física de una línea (parcial permitida); opcionalmente etiqueta el material como paquete en CUARENTENA
CREATE OR REPLACE FUNCTION public.wh_return_receive(p_line bigint, p_qty numeric, p_kg numeric, p_method text, p_label boolean DEFAULT true, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l public.wh_return_lines%ROWTYPE; r public.wh_returns%ROWTYPE; v_pkg uuid; v_code text;
BEGIN
  PERFORM wms_private.wh_return_perm(ARRAY['almacen-etiquetado','almacen-inventario','almacen-supervisor']);
  SELECT * INTO l FROM public.wh_return_lines WHERE id = p_line FOR UPDATE;
  SELECT * INTO r FROM public.wh_returns WHERE id = l.return_id AND public.can_access_site(site_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Línea no disponible'; END IF;
  IF r.status = 'CERRADO' THEN RAISE EXCEPTION 'El expediente está cerrado'; END IF;
  IF l.erp_state = 'BAJA_ERP' THEN RAISE EXCEPTION 'La línea fue dada de baja en el ERP: concilie antes de recibir'; END IF;
  IF coalesce(p_qty, -1) < 0 THEN RAISE EXCEPTION 'Indique la cantidad recibida (0 si no llegó)'; END IF;
  IF upper(btrim(coalesce(p_method, ''))) NOT IN ('BALANZA','MAESTRO','DOCUMENTO','ESTIMADO') THEN RAISE EXCEPTION 'Indique cómo se obtuvo el peso'; END IF;
  IF EXISTS (SELECT 1 FROM public.wh_return_fractions WHERE line_id = l.id) AND p_qty < (SELECT sum(qty) FROM public.wh_return_fractions WHERE line_id = l.id) THEN
    RAISE EXCEPTION 'Lo recibido no puede ser menor que lo ya inspeccionado';
  END IF;
  -- Corregir o completar una recepción ya etiquetada: el paquete se ajusta solo si sigue en cuarentena y sin uso
  IF l.package_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.wh_packages WHERE id = l.package_id AND hold_status = 'CUARENTENA' AND status = 'AVAILABLE' AND task_id IS NULL) THEN
      RAISE EXCEPTION 'El paquete de esta recepción ya salió de la cuarentena o está en uso: no se puede cambiar la cantidad recibida';
    END IF;
    IF p_qty = 0 THEN
      UPDATE public.wh_packages SET status = 'VOID', void_reason = 'Recepción corregida a 0', updated_at = now() WHERE id = l.package_id;
      UPDATE public.wh_return_lines SET package_id = NULL WHERE id = l.id; l.package_id := NULL;
    ELSE
      UPDATE public.wh_packages SET quantity = p_qty, weight_kg = nullif(p_kg, 0), updated_at = now() WHERE id = l.package_id;
    END IF;
  END IF;
  UPDATE public.wh_return_lines SET qty_received = p_qty, kg_received = nullif(p_kg, 0), weight_method = upper(btrim(p_method)), received_by = auth.uid(), received_at = now(), receipt_note = nullif(btrim(p_note), '')
  WHERE id = l.id;
  IF coalesce(p_label, false) AND p_qty > 0 AND l.package_id IS NULL THEN
    v_pkg := wms_private.wh_return_new_package(l.id, p_qty, p_kg, 'CUARENTENA', 'Retorno ' || r.code || ' pendiente de inspección y disposición', 'REC');
    v_code := (SELECT package_code FROM public.wh_packages WHERE id = v_pkg);
    UPDATE public.wh_return_lines SET package_id = v_pkg WHERE id = l.id;
  END IF;
  PERFORM wms_private.wh_return_log(r.id, 'RECIBIR', jsonb_build_object('line', l.id, 'qty', p_qty, 'kg', p_kg, 'method', upper(btrim(p_method)), 'package', v_code), p_note);
  RETURN jsonb_build_object('line', l.id, 'status', wms_private.wh_return_refresh(r.id), 'package_code', v_code);
END $$;

-- Inspección por fracción (reemplaza las fracciones aún sin disposición). p_fractions: [{qty, kg, condition, finding, recommendation}]
CREATE OR REPLACE FUNCTION public.wh_return_inspect(p_line bigint, p_fractions jsonb, p_evidence_paths text[] DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l public.wh_return_lines%ROWTYPE; r public.wh_returns%ROWTYPE; v_total numeric; v_locked numeric;
BEGIN
  PERFORM wms_private.wh_return_perm(ARRAY['almacen-inventario','almacen-supervisor']);
  SELECT * INTO l FROM public.wh_return_lines WHERE id = p_line FOR UPDATE;
  SELECT * INTO r FROM public.wh_returns WHERE id = l.return_id AND public.can_access_site(site_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Línea no disponible'; END IF;
  IF l.qty_received IS NULL THEN RAISE EXCEPTION 'Primero registre la recepción física'; END IF;
  IF l.received_by = auth.uid() THEN RAISE EXCEPTION 'Quien recibió no inspecciona la misma línea'; END IF;
  IF jsonb_typeof(p_fractions) IS DISTINCT FROM 'array' OR jsonb_array_length(p_fractions) = 0 THEN RAISE EXCEPTION 'Indique al menos una fracción'; END IF;
  SELECT coalesce(sum(qty), 0) INTO v_locked FROM public.wh_return_fractions WHERE line_id = l.id AND disposition IS NOT NULL;
  SELECT coalesce(sum((x->>'qty')::numeric), 0) INTO v_total FROM jsonb_array_elements(p_fractions) x;
  IF v_total + v_locked > l.qty_received THEN RAISE EXCEPTION 'Las fracciones (% ) superan lo recibido (%)', v_total + v_locked, l.qty_received; END IF;
  DELETE FROM public.wh_return_fractions WHERE line_id = l.id AND disposition IS NULL;
  INSERT INTO public.wh_return_fractions(line_id, qty, kg, condition, finding, recommendation, evidence_paths, inspected_by)
  SELECT l.id, (x->>'qty')::numeric,
    coalesce(nullif((x->>'kg')::numeric, 0), CASE WHEN l.kg_received > 0 AND l.qty_received > 0 THEN round(l.kg_received * (x->>'qty')::numeric / l.qty_received, 3) END),
    upper(x->>'condition'), nullif(btrim(x->>'finding'), ''), nullif(btrim(x->>'recommendation'), ''), coalesce(p_evidence_paths, '{}'), auth.uid()
  FROM jsonb_array_elements(p_fractions) x;
  PERFORM wms_private.wh_return_log(r.id, 'INSPECCIONAR', jsonb_build_object('line', l.id, 'fractions', p_fractions), NULL, p_evidence_paths);
  RETURN jsonb_build_object('line', l.id, 'status', wms_private.wh_return_refresh(r.id));
END $$;

-- Disposición: PROPOSE (Inventario) · APPROVE/REJECT (supervisión, nunca quien propuso) · EXECUTE · VERIFY (otra persona)
CREATE OR REPLACE FUNCTION public.wh_return_disposition(p_fraction bigint, p_action text, p_disposition text DEFAULT NULL, p_reason text DEFAULT NULL, p_destination text DEFAULT NULL, p_due_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f public.wh_return_fractions%ROWTYPE; l public.wh_return_lines%ROWTYPE; r public.wh_returns%ROWTYPE; v_action text := upper(btrim(p_action)); v_reason text := nullif(btrim(p_reason), '');
BEGIN
  PERFORM public.security_assert_active_session();
  SELECT * INTO f FROM public.wh_return_fractions WHERE id = p_fraction FOR UPDATE;
  SELECT * INTO l FROM public.wh_return_lines WHERE id = f.line_id;
  SELECT * INTO r FROM public.wh_returns WHERE id = l.return_id AND public.can_access_site(site_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fracción no disponible'; END IF;
  IF r.status = 'CERRADO' THEN RAISE EXCEPTION 'El expediente está cerrado'; END IF;
  IF v_action = 'PROPOSE' THEN
    IF NOT public.wh_has_permission(ARRAY['almacen-inventario','almacen-supervisor']) THEN RAISE EXCEPTION 'Solo Inventario propone la disposición' USING ERRCODE = '42501'; END IF;
    IF f.disposition_status IN ('AUTORIZADA','EJECUTADA','VERIFICADA') THEN RAISE EXCEPTION 'La disposición ya fue autorizada'; END IF;
    IF upper(btrim(coalesce(p_disposition, ''))) NOT IN ('REINCORPORAR','ACONDICIONAR','REPROCESAR','TRANSFERIR','DEVOLVER','MANTENER_BLOQUEADO','BAJA') THEN RAISE EXCEPTION 'Disposición no válida'; END IF;
    IF v_reason IS NULL THEN RAISE EXCEPTION 'Indique el motivo de la disposición'; END IF;
    IF upper(p_disposition) = 'REINCORPORAR' AND f.condition NOT IN ('UTILIZABLE') THEN RAISE EXCEPTION 'Solo material utilizable se reincorpora directamente; acondicione o reprocese primero'; END IF;
    UPDATE public.wh_return_fractions SET disposition = upper(btrim(p_disposition)), disposition_status = 'PROPUESTA', disposition_reason = v_reason, destination = nullif(btrim(p_destination), ''),
      disposition_due = p_due_at, proposed_by = auth.uid(), proposed_at = now(), authorized_by = NULL, authorized_at = NULL, authorization_comment = NULL WHERE id = f.id;
  ELSIF v_action IN ('APPROVE','REJECT') THEN
    IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN RAISE EXCEPTION 'Solo Jefatura (supervisión) autoriza disposiciones' USING ERRCODE = '42501'; END IF;
    IF f.disposition_status IS DISTINCT FROM 'PROPUESTA' THEN RAISE EXCEPTION 'No hay una disposición propuesta'; END IF;
    IF f.proposed_by = auth.uid() THEN RAISE EXCEPTION 'Nadie autoriza la disposición que propuso'; END IF;
    IF v_action = 'REJECT' AND v_reason IS NULL THEN RAISE EXCEPTION 'Indique el motivo del rechazo'; END IF;
    UPDATE public.wh_return_fractions SET disposition_status = CASE WHEN v_action = 'APPROVE' THEN 'AUTORIZADA' ELSE 'RECHAZADA' END, authorized_by = auth.uid(), authorized_at = now(), authorization_comment = v_reason WHERE id = f.id;
  ELSIF v_action = 'EXECUTE' THEN
    IF NOT public.wh_has_permission(ARRAY['almacen-inventario','almacen-supervisor','almacen-etiquetado','almacen-carga']) THEN RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501'; END IF;
    IF f.disposition_status IS DISTINCT FROM 'AUTORIZADA' THEN RAISE EXCEPTION 'La disposición no está autorizada'; END IF;
    IF f.disposition = 'REPROCESAR' THEN RAISE EXCEPTION 'El reproceso se ejecuta con su orden de reproceso'; END IF;
    UPDATE public.wh_return_fractions SET disposition_status = 'EJECUTADA', executed_by = auth.uid(), executed_at = now(), execution_note = v_reason WHERE id = f.id;
    PERFORM wms_private.wh_return_settle_line(l.id);
  ELSIF v_action = 'VERIFY' THEN
    IF NOT public.wh_has_permission(ARRAY['almacen-inventario','almacen-supervisor','almacen-auditoria']) THEN RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501'; END IF;
    IF f.disposition_status IS DISTINCT FROM 'EJECUTADA' THEN RAISE EXCEPTION 'Primero se ejecuta la disposición'; END IF;
    IF f.executed_by = auth.uid() THEN RAISE EXCEPTION 'Quien ejecutó no verifica'; END IF;
    UPDATE public.wh_return_fractions SET disposition_status = 'VERIFICADA', verified_by = auth.uid(), verified_at = now() WHERE id = f.id;
    PERFORM wms_private.wh_return_settle_line(l.id);
  ELSE RAISE EXCEPTION 'Acción no reconocida';
  END IF;
  PERFORM wms_private.wh_return_log(r.id, 'DISPOSICION_' || v_action, jsonb_build_object('fraction', f.id, 'disposition', coalesce(upper(p_disposition), f.disposition)), v_reason);
  RETURN jsonb_build_object('fraction', f.id, 'status', (SELECT disposition_status FROM public.wh_return_fractions WHERE id = f.id), 'return_status', wms_private.wh_return_refresh(r.id));
END $$;

-- Reproceso: CREATE (fracciones autorizadas para REPROCESAR) · START/PAUSE/RESUME · FINISH (balance) · VERIFY/REJECT · CYCLE (otro ciclo)
CREATE OR REPLACE FUNCTION public.wh_reprocess(p_action text, p_order uuid DEFAULT NULL, p_fractions bigint[] DEFAULT NULL, p_data jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o public.wh_reprocess_orders%ROWTYPE; v_action text := upper(btrim(p_action)); d jsonb := coalesce(p_data, '{}'::jsonb); v_ret uuid; v_kg numeric; v_id uuid; v_bal numeric;
BEGIN
  PERFORM public.security_assert_active_session();
  IF v_action = 'CREATE' THEN
    IF NOT public.wh_has_permission(ARRAY['almacen-inventario','almacen-supervisor']) THEN RAISE EXCEPTION 'Solo Inventario crea órdenes de reproceso' USING ERRCODE = '42501'; END IF;
    IF p_fractions IS NULL OR cardinality(p_fractions) = 0 THEN RAISE EXCEPTION 'Elija las fracciones a reprocesar'; END IF;
    IF EXISTS (SELECT 1 FROM public.wh_return_fractions f WHERE f.id = ANY (p_fractions) AND NOT (f.disposition = 'REPROCESAR' AND f.disposition_status = 'AUTORIZADA')) THEN
      RAISE EXCEPTION 'Solo fracciones con reproceso autorizado';
    END IF;
    IF EXISTS (SELECT 1 FROM public.wh_reprocess_inputs i JOIN public.wh_reprocess_orders x ON x.id = i.order_id WHERE i.fraction_id = ANY (p_fractions) AND x.status NOT IN ('RECHAZADA')) THEN
      RAISE EXCEPTION 'Alguna fracción ya está en una orden';
    END IF;
    SELECT DISTINCT l.return_id INTO v_ret FROM public.wh_return_fractions f JOIN public.wh_return_lines l ON l.id = f.line_id WHERE f.id = ANY (p_fractions);
    SELECT sum(kg) INTO v_kg FROM public.wh_return_fractions WHERE id = ANY (p_fractions);
    INSERT INTO public.wh_reprocess_orders(site_id, return_id, objective, executor_type, executor_name, kg_input, due_at, created_by)
    SELECT r.site_id, r.id, coalesce(nullif(btrim(d->>'objective'), ''), 'Reproceso'), upper(coalesce(d->>'executor_type', 'INTERNO')), nullif(btrim(d->>'executor_name'), ''), coalesce(v_kg, 0),
      (d->>'due_at')::timestamptz, auth.uid() FROM public.wh_returns r WHERE r.id = v_ret AND public.can_access_site(r.site_id)
    RETURNING id INTO v_id;
    INSERT INTO public.wh_reprocess_inputs(order_id, fraction_id, kg) SELECT v_id, f.id, f.kg FROM public.wh_return_fractions f WHERE f.id = ANY (p_fractions);
    UPDATE public.wh_return_fractions SET disposition_status = 'EJECUTADA', executed_by = auth.uid(), executed_at = now(), execution_note = 'En orden de reproceso' WHERE id = ANY (p_fractions);
    PERFORM wms_private.wh_return_log(v_ret, 'REPROCESO_CREAR', jsonb_build_object('order', v_id, 'fractions', p_fractions));
    PERFORM wms_private.wh_return_refresh(v_ret);
    RETURN jsonb_build_object('id', v_id, 'code', (SELECT code FROM public.wh_reprocess_orders WHERE id = v_id));
  END IF;
  SELECT * INTO o FROM public.wh_reprocess_orders WHERE id = p_order AND public.can_access_site(site_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Orden no disponible'; END IF;
  IF v_action IN ('START','PAUSE','RESUME','FINISH') THEN
    IF NOT public.wh_has_permission(ARRAY['almacen-inventario','almacen-supervisor','almacen-etiquetado']) THEN RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501'; END IF;
    IF v_action = 'START' AND o.status <> 'ABIERTA' THEN RAISE EXCEPTION 'La orden no está abierta'; END IF;
    IF v_action = 'PAUSE' AND o.status <> 'EN_PROCESO' THEN RAISE EXCEPTION 'La orden no está en proceso'; END IF;
    IF v_action = 'RESUME' AND o.status <> 'EN_PAUSA' THEN RAISE EXCEPTION 'La orden no está en pausa'; END IF;
    IF v_action = 'FINISH' THEN
      IF o.status NOT IN ('EN_PROCESO','EN_PAUSA') THEN RAISE EXCEPTION 'La orden no está en proceso'; END IF;
      -- Balance de masa: entrada + insumos = recuperado + residuo + en proceso + diferencia; diferencia ≠ 0 exige explicación
      v_bal := o.kg_input + coalesce((d->>'kg_added')::numeric, 0) - coalesce((d->>'kg_recovered')::numeric, 0) - coalesce((d->>'kg_waste')::numeric, 0) - coalesce((d->>'kg_in_process')::numeric, 0);
      IF (d->>'kg_recovered') IS NULL THEN RAISE EXCEPTION 'Indique los kg recuperados'; END IF;
      IF abs(v_bal) > 0.001 AND nullif(btrim(d->>'diff_note'), '') IS NULL THEN RAISE EXCEPTION 'El balance no cuadra (diferencia % kg): explique la diferencia', round(v_bal, 3); END IF;
      UPDATE public.wh_reprocess_orders SET status = 'TERMINADA', finished_at = now(), executed_by = auth.uid(), kg_added = coalesce((d->>'kg_added')::numeric, 0),
        kg_recovered = (d->>'kg_recovered')::numeric, kg_waste = coalesce((d->>'kg_waste')::numeric, 0), kg_in_process = coalesce((d->>'kg_in_process')::numeric, 0), kg_diff = round(v_bal, 3),
        diff_note = nullif(btrim(d->>'diff_note'), '') WHERE id = o.id;
    ELSE
      UPDATE public.wh_reprocess_orders SET status = CASE v_action WHEN 'PAUSE' THEN 'EN_PAUSA' ELSE 'EN_PROCESO' END, started_at = coalesce(started_at, now()), executed_by = auth.uid() WHERE id = o.id;
    END IF;
  ELSIF v_action IN ('VERIFY','REJECT') THEN
    IF NOT public.wh_has_permission(ARRAY['almacen-inventario','almacen-supervisor','almacen-auditoria']) THEN RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501'; END IF;
    IF o.status <> 'TERMINADA' THEN RAISE EXCEPTION 'La orden no está terminada'; END IF;
    IF o.executed_by = auth.uid() THEN RAISE EXCEPTION 'Quien ejecutó el reproceso no lo verifica'; END IF;
    UPDATE public.wh_reprocess_orders SET status = CASE WHEN v_action = 'VERIFY' THEN 'VERIFICADA' ELSE 'RECHAZADA' END, verified_by = auth.uid(), verified_at = now(), result_note = nullif(btrim(d->>'note'), '') WHERE id = o.id;
    IF v_action = 'VERIFY' THEN
      UPDATE public.wh_return_fractions SET disposition_status = 'VERIFICADA', verified_by = auth.uid(), verified_at = now() WHERE id IN (SELECT fraction_id FROM public.wh_reprocess_inputs WHERE order_id = o.id);
      -- Material recuperado y verificado: se liquida cada línea de las fracciones de entrada
      PERFORM wms_private.wh_return_settle_line(x2.line_id) FROM (SELECT DISTINCT f.line_id FROM public.wh_reprocess_inputs i JOIN public.wh_return_fractions f ON f.id = i.fraction_id WHERE i.order_id = o.id) x2;
    END IF;
  ELSIF v_action = 'CYCLE' THEN
    IF NOT public.wh_has_permission(ARRAY['almacen-inventario','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501'; END IF;
    IF o.status NOT IN ('TERMINADA','RECHAZADA') THEN RAISE EXCEPTION 'Solo se abre otro ciclo sobre una orden terminada o rechazada'; END IF;
    INSERT INTO public.wh_reprocess_orders(site_id, return_id, parent_id, cycle, objective, executor_type, executor_name, kg_input, due_at, created_by)
    VALUES (o.site_id, o.return_id, o.id, o.cycle + 1, coalesce(nullif(btrim(d->>'objective'), ''), o.objective), o.executor_type, o.executor_name,
      coalesce(o.kg_in_process, 0) + CASE WHEN o.status = 'RECHAZADA' THEN coalesce(o.kg_recovered, 0) ELSE 0 END, (d->>'due_at')::timestamptz, auth.uid())
    RETURNING id INTO v_id;
    INSERT INTO public.wh_reprocess_inputs(order_id, fraction_id, kg) SELECT v_id, fraction_id, kg FROM public.wh_reprocess_inputs WHERE order_id = o.id;
  ELSE RAISE EXCEPTION 'Acción no reconocida';
  END IF;
  PERFORM wms_private.wh_return_log(o.return_id, 'REPROCESO_' || v_action, jsonb_build_object('order', o.code) || d);
  PERFORM wms_private.wh_return_refresh(o.return_id);
  RETURN jsonb_build_object('id', coalesce(v_id, o.id), 'status', (SELECT status FROM public.wh_reprocess_orders WHERE id = coalesce(v_id, o.id)));
END $$;

-- Cierre: todo recibido, cada fracción resuelta y verificada, suma conciliada
CREATE OR REPLACE FUNCTION public.wh_return_close(p_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.wh_returns%ROWTYPE; v text;
BEGIN
  PERFORM wms_private.wh_return_perm(ARRAY['almacen-inventario','almacen-supervisor']);
  SELECT * INTO r FROM public.wh_returns WHERE id = p_id AND public.can_access_site(site_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'Expediente no disponible'; END IF;
  v := wms_private.wh_return_refresh(r.id);
  IF v <> 'RESUELTO' THEN RAISE EXCEPTION 'No se puede cerrar: el expediente está %', lower(replace(v, '_', ' ')); END IF;
  IF r.source = 'NO_ANUNCIADO' AND nullif(btrim(p_note), '') IS NULL THEN RAISE EXCEPTION 'Un retorno no anunciado se cierra con la nota de regularización'; END IF;
  UPDATE public.wh_returns SET status = 'CERRADO', closed_by = auth.uid(), closed_at = now() WHERE id = r.id;
  PERFORM wms_private.wh_return_log(r.id, 'CERRAR', '{}'::jsonb, p_note);
  RETURN jsonb_build_object('id', r.id, 'status', 'CERRADO');
END $$;

REVOKE ALL ON FUNCTION public.wh_returns_list(text, text), public.wh_return_detail(uuid), public.wh_return_update(uuid, text, text, uuid, timestamptz, text),
  public.wh_return_provisional(text, text, numeric, text, numeric, text, timestamptz), public.wh_return_receive(bigint, numeric, numeric, text, boolean, text),
  public.wh_return_inspect(bigint, jsonb, text[]), public.wh_return_disposition(bigint, text, text, text, text, timestamptz),
  public.wh_reprocess(text, uuid, bigint[], jsonb), public.wh_return_close(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_returns_list(text, text), public.wh_return_detail(uuid), public.wh_return_update(uuid, text, text, uuid, timestamptz, text),
  public.wh_return_provisional(text, text, numeric, text, numeric, text, timestamptz), public.wh_return_receive(bigint, numeric, numeric, text, boolean, text),
  public.wh_return_inspect(bigint, jsonb, text[]), public.wh_return_disposition(bigint, text, text, text, text, timestamptz),
  public.wh_reprocess(text, uuid, bigint[], jsonb), public.wh_return_close(uuid, text) TO authenticated;
