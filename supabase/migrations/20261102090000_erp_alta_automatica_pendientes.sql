-- ============================================================
-- ERP · Alta automática también de las OT con saldo pendiente
-- ============================================================
-- El alta automática solo tomaba las OT activas (último despacho dentro del umbral): quedaban fuera los contratos sin
-- despacho reciente que aún tienen saldo por despachar en el ERP. Ahora entran las OT activas o con pendiente
-- (motivo PENDIENTE_ERP); las OT inactivas ya completas siguen fuera. Se procesa de una vez el Actualizable vigente
-- (antes solo corría al cargar un archivo nuevo).
BEGIN;
SET LOCAL lock_timeout = '60s';

CREATE OR REPLACE FUNCTION public.erp_contratos_alta_automatica_core(p_simular boolean, p_user uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); r record; v_site uuid; v_client uuid; v_new boolean; v_id uuid;
  v_parent record; n_madre integer := 0; n_hijo integer := 0; n_cli integer := 0; n_ruc integer := 0; n_sin_madre integer := 0;
  n_gar integer := 0; n_err integer := 0; v_det jsonb := '[]'::jsonb; v_codes text[] := '{}';
BEGIN
  IF v_c IS NULL THEN RETURN jsonb_build_object('success', true, 'sin_datos', true); END IF;
  -- Sede de las OT madre: la principal; si no hay, la más usada por las OT madre existentes
  v_site := public.primary_site_id();
  IF v_site IS NULL THEN
    SELECT c.site_id INTO v_site FROM public.contracts c WHERE c.parent_contract_id IS NULL AND c.site_id IS NOT NULL
     GROUP BY 1 ORDER BY count(*) DESC LIMIT 1;
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS erp_tmp_alta (dk text, documento text, ot text, tipo text, cliente text, ruc text, n_ruc integer,
    motivo text) ON COMMIT DROP;
  TRUNCATE erp_tmp_alta;
  INSERT INTO erp_tmp_alta
  WITH tk AS (SELECT DISTINCT public.erp_doc_key(c.code) AS k FROM public.contracts c WHERE c.code IS NOT NULL),
  d AS (
    SELECT public.erp_doc_key(l.nro_documento) AS dk, max(public.erp_key(l.nro_documento)) AS documento, max(l.ot) AS ot,
      public.erp_tipo_tms(max(l.tipo_documento)) AS tipo, max(l.cliente) AS cliente, min(public.client_tax_id_norm(l.ruc)) AS ruc,
      count(DISTINCT public.client_tax_id_norm(l.ruc))::integer AS n_ruc
    FROM public.erp_contract_lines l WHERE l.import_id = v_c GROUP BY 1),
  f AS (SELECT d.* FROM d WHERE d.dk IS NOT NULL AND d.tipo IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tk WHERE tk.k = d.dk)),
  a AS (SELECT * FROM public.erp_ot_actividad((SELECT array_agg(DISTINCT f.ot) FROM f)))
  SELECT f.dk, f.documento, f.ot, f.tipo, f.cliente, f.ruc, f.n_ruc, COALESCE(a.motivo, 'PENDIENTE_ERP') FROM f JOIN a ON a.ot = f.ot WHERE a.activa OR a.pendiente;

  -- Primero las OT madre (el documento es la OT), después los hijos
  FOR r IN SELECT * FROM erp_tmp_alta ORDER BY (tipo = 'CONTRATO' AND documento = ot) DESC, ot, documento LOOP
    IF r.tipo = 'GARANTIA' THEN n_gar := n_gar + 1; CONTINUE; END IF;
    BEGIN
      IF r.tipo = 'CONTRATO' THEN
        CONTINUE WHEN r.documento <> r.ot;
        IF r.n_ruc <> 1 OR r.ruc IS NULL OR length(r.ruc) <> 11 OR NOT public.is_valid_ruc(r.ruc) THEN n_ruc := n_ruc + 1; CONTINUE; END IF;
        IF v_site IS NULL THEN n_err := n_err + 1; CONTINUE; END IF;
        IF p_simular THEN
          n_madre := n_madre + 1; v_codes := v_codes || r.documento;
          IF jsonb_array_length(v_det) < 200 THEN v_det := v_det || jsonb_build_object('codigo', r.documento, 'tipo', r.tipo, 'cliente', r.cliente); END IF;
          CONTINUE;
        END IF;
        SELECT x.id, x.creado INTO v_client, v_new FROM public.erp_cliente_por_ruc(r.ruc, r.cliente, true) x;
        IF v_client IS NULL THEN n_ruc := n_ruc + 1; CONTINUE; END IF;
        INSERT INTO public.contracts (code, type, parent_contract_id, site_id, client_id, status)
        VALUES (r.documento, 'CONTRATO'::public.contract_type, NULL, v_site, v_client, 'ACTIVO') RETURNING id INTO v_id;
        n_madre := n_madre + 1; IF v_new THEN n_cli := n_cli + 1; END IF;
      ELSE
        SELECT c.id, c.site_id, c.client_id INTO v_parent FROM public.contracts c WHERE c.code = r.ot AND c.parent_contract_id IS NULL;
        -- Sin OT madre en el TMS (o sin cliente) el hijo espera: se da de alta en la próxima carga o desde «ERP sin alta»
        IF (v_parent.id IS NULL OR v_parent.client_id IS NULL) AND NOT (p_simular AND r.ot = ANY (v_codes)) THEN
          n_sin_madre := n_sin_madre + 1; CONTINUE;
        END IF;
        IF p_simular THEN
          n_hijo := n_hijo + 1;
          IF jsonb_array_length(v_det) < 200 THEN v_det := v_det || jsonb_build_object('codigo', r.documento, 'tipo', r.tipo, 'cliente', r.cliente); END IF;
          CONTINUE;
        END IF;
        v_new := false;
        INSERT INTO public.contracts (code, type, parent_contract_id, site_id, client_id, status)
        VALUES (r.documento, r.tipo::public.contract_type, v_parent.id, v_parent.site_id, v_parent.client_id, 'ACTIVO') RETURNING id INTO v_id;
        n_hijo := n_hijo + 1;
      END IF;
      INSERT INTO public.erp_contract_altas (contract_id, contract_code, tipo, ot, cliente_erp, ruc_erp, client_created, motivo, import_id, created_by)
      VALUES (v_id, r.documento, r.tipo, r.ot, r.cliente, r.ruc, v_new, r.motivo, v_c, p_user);
      IF jsonb_array_length(v_det) < 200 THEN
        v_det := v_det || jsonb_build_object('codigo', r.documento, 'tipo', r.tipo, 'cliente', r.cliente, 'cliente_creado', v_new);
      END IF;
    EXCEPTION WHEN others THEN
      n_err := n_err + 1;
      IF jsonb_array_length(v_det) < 200 THEN v_det := v_det || jsonb_build_object('codigo', r.documento, 'error', SQLERRM); END IF;
    END;
  END LOOP;

  IF NOT p_simular AND n_madre + n_hijo > 0 THEN
    PERFORM public.notif_emit('OT_ALTA_ERP', 'ot-alta-erp:' || v_c || ':' || n_madre || ':' || n_hijo,
      format('%s OT dadas de alta desde el ERP', n_madre + n_hijo),
      format('%s OT madre y %s subcontratos/errores de OT activas en el ERP%s. Quedan sin partida: asígnela en Contratos y OTs.',
        n_madre, n_hijo, CASE WHEN n_cli > 0 THEN format(' (%s clientes registrados desde el ERP)', n_cli) ELSE '' END),
      '/contratos', NULL);
  END IF;
  RETURN jsonb_build_object('success', true, 'simulacion', p_simular, 'madres', n_madre, 'hijos', n_hijo, 'clientes_creados', n_cli,
    'ruc_invalido', n_ruc, 'sin_madre', n_sin_madre, 'garantias', n_gar, 'errores', n_err, 'detalle', v_det);
END $$;
REVOKE ALL ON FUNCTION public.erp_contratos_alta_automatica_core(boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erp_contratos_alta_automatica_core(boolean, uuid) TO service_role;

-- Alta de lo que ya está en el Actualizable vigente
DO $migration$
DECLARE r jsonb;
BEGIN
  IF public.erp_active_import('CONTRATOS') IS NOT NULL THEN
    r := public.erp_contratos_alta_automatica_core(false, NULL);
    RAISE NOTICE 'Alta automática desde el ERP: %', r - 'detalle';
  END IF;
END $migration$;

COMMIT;
