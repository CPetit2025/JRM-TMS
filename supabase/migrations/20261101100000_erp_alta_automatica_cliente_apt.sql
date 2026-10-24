-- ============================================================
-- ERP · Alta automática de OT activas y cliente del ERP en el APT
-- ============================================================
-- 1. erp_contratos_alta_automatica (núcleo _core en el servidor): con el Actualizable vigente, da de alta en el TMS los documentos del ERP de OT activas
--    que aún no existen (misma numeración): primero la OT madre (con su cliente por RUC, registrándolo si no existe) y luego
--    sus subcontratos y errores. Sin partida (se asigna en Contratos). La garantía no se da de alta sola: lleva su Error de
--    contrato y se registra desde «ERP sin alta». Sin RUC válido la OT madre queda pendiente (necesita cliente).
--    Cada alta queda en erp_contract_altas y se avisa a quien gestiona Contratos y OTs.
-- 2. Cliente de las OT en el APT («OT con más stock», Contratos, ficha de OT): guía → contrato del TMS → Actualizable.
BEGIN;
SET LOCAL lock_timeout = '60s';

-- ── 1. Alta automática ────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.erp_contract_altas (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id    uuid NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
  contract_code  text NOT NULL,
  tipo           text NOT NULL,
  ot             text NOT NULL,
  cliente_erp    text,
  ruc_erp        text,
  client_created boolean NOT NULL DEFAULT false,
  motivo         text,
  import_id      uuid REFERENCES public.erp_imports(id) ON DELETE SET NULL,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS erp_contract_altas_contract_idx ON public.erp_contract_altas (contract_id);
CREATE INDEX IF NOT EXISTS erp_contract_altas_import_idx ON public.erp_contract_altas (import_id);
CREATE INDEX IF NOT EXISTS erp_contract_altas_created_idx ON public.erp_contract_altas (created_at DESC);
ALTER TABLE public.erp_contract_altas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.erp_contract_altas;
CREATE POLICY security_active_account ON public.erp_contract_altas AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.erp_contract_altas FROM PUBLIC, anon, authenticated;

INSERT INTO public.notif_reglas (evento, categoria, descripcion, severidad, permisos, al_solicitante)
VALUES ('OT_ALTA_ERP', 'CUMPLIMIENTO', 'OT dadas de alta automáticamente desde el ERP (sin partida)', 'info', ARRAY['ot'], false)
ON CONFLICT (evento) DO NOTHING;

-- Quién puede ejecutarla: carga del ERP, Contratos y OTs o Administrador
CREATE OR REPLACE FUNCTION public.erp_contratos_alta_permiso()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT auth.uid() IS NOT NULL AND (public.is_tms_admin() OR public.apt_can_load() OR public.has_tms_permission('ot'));
$$;
REVOKE ALL ON FUNCTION public.erp_contratos_alta_permiso() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_contratos_alta_permiso() TO authenticated, service_role;

-- Núcleo (llave de servicio desde /api/erp/aplicar, sin el límite de 8 s del navegador). p_simular: solo cuenta y lista.
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
  SELECT f.dk, f.documento, f.ot, f.tipo, f.cliente, f.ruc, f.n_ruc, a.motivo FROM f JOIN a ON a.ot = f.ot WHERE a.activa;

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

-- Desde el navegador (respaldo si el servidor no está disponible)
CREATE OR REPLACE FUNCTION public.erp_contratos_alta_automatica(p_simular boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.erp_contratos_alta_permiso() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso: requiere carga del ERP, Contratos y OTs o Administrador');
  END IF;
  RETURN public.erp_contratos_alta_automatica_core(p_simular, auth.uid());
END $$;
REVOKE ALL ON FUNCTION public.erp_contratos_alta_automatica(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_contratos_alta_automatica(boolean) TO authenticated, service_role;

-- ── 2. Cliente de las OT en el APT ────────────────────────────────────────────────────────────────────────
-- Cliente de cada OT según el Actualizable vigente (el de más líneas)
CREATE OR REPLACE FUNCTION public.erp_ot_cliente_erp()
RETURNS TABLE (ot text, cliente text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT ON (x.raiz) x.raiz, x.cliente FROM (
    SELECT public.apt_ot_raiz(l.ot) AS raiz, btrim(l.cliente) AS cliente, count(*) AS n
    FROM public.erp_contract_lines l
    WHERE l.import_id = public.erp_active_import('CONTRATOS') AND NULLIF(btrim(l.cliente), '') IS NOT NULL
    GROUP BY 1, 2) x
  WHERE x.raiz IS NOT NULL ORDER BY x.raiz, x.n DESC, x.cliente;
$$;
REVOKE ALL ON FUNCTION public.erp_ot_cliente_erp() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erp_ot_cliente_erp() TO service_role;

CREATE OR REPLACE FUNCTION public.inv_ot_cliente(p_raiz text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(
    (SELECT m.razon_social FROM public.inv_movements_v m
     WHERE m.active AND m.clase = 'DESPACHO' AND m.razon_social IS NOT NULL AND upper(btrim(m.lote)) LIKE p_raiz || '%' AND public.apt_ot_raiz(m.lote) = p_raiz
     GROUP BY m.razon_social ORDER BY sum(public.inv_kg(m.peso_kg, m.cantidad, m.peso_unit)) DESC, count(*) DESC LIMIT 1),
    (SELECT cl.business_name FROM public.contracts c JOIN public.clients cl ON cl.id = c.client_id
     WHERE upper(c.code) = p_raiz OR public.apt_ot_raiz(c.code) = p_raiz ORDER BY (upper(c.code) = p_raiz) DESC LIMIT 1),
    (SELECT max(btrim(l.cliente)) FROM public.erp_contract_lines l
     WHERE l.import_id = public.erp_active_import('CONTRATOS') AND l.ot = p_raiz AND NULLIF(btrim(l.cliente), '') IS NOT NULL));
$$;
REVOKE ALL ON FUNCTION public.inv_ot_cliente(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_ot_cliente(text) TO service_role;

-- Lista de contratos y resumen del APT: el cliente cae al contrato del TMS (también hijos) y al Actualizable
DO $migration$
DECLARE src text := pg_get_functiondef('public.inv_contratos_refresh(timestamptz)'::regprocedure);
  a1 text := '''cliente'', COALESCE(mv.cliente_guia, tms.cliente)';
  a2 text := 'FROM mv LEFT JOIN st ON st.raiz = mv.raiz LEFT JOIN tms ON tms.code = mv.raiz;';
  a3 text := 'FROM public.contracts c JOIN public.clients cl ON cl.id = c.client_id WHERE cl.business_name IS NOT NULL ORDER BY upper(c.code))';
BEGIN
  IF position('erp_ot_cliente_erp' IN src) = 0 THEN
    IF position(a1 IN src) = 0 OR position(a2 IN src) = 0 OR position(a3 IN src) = 0 THEN
      RAISE EXCEPTION 'inv_contratos_refresh no coincide con la definición esperada';
    END IF;
    src := replace(src, a1, '''cliente'', COALESCE(mv.cliente_guia, tms.cliente, tmsr.cliente, erp.cliente)');
    src := replace(src, a2, 'FROM mv LEFT JOIN st ON st.raiz = mv.raiz LEFT JOIN tms ON tms.code = mv.raiz
    LEFT JOIN tmsr ON tmsr.raiz = mv.raiz LEFT JOIN erp ON erp.ot = mv.raiz;');
    src := replace(src, a3, a3 || ',
  tmsr AS (SELECT DISTINCT ON (public.apt_ot_raiz(c.code)) public.apt_ot_raiz(c.code) AS raiz, cl.business_name AS cliente
           FROM public.contracts c JOIN public.clients cl ON cl.id = c.client_id
           WHERE cl.business_name IS NOT NULL AND public.apt_ot_raiz(c.code) IS NOT NULL
           ORDER BY public.apt_ot_raiz(c.code), (c.parent_contract_id IS NULL) DESC, c.code),
  erp AS (SELECT * FROM public.erp_ot_cliente_erp())');
    EXECUTE src;
  END IF;
END $migration$;

-- Completa el cliente en la caché ya guardada (sin esperar al próximo refresco)
WITH cli AS (
  SELECT e.ot, e.cliente, 2 AS prioridad FROM public.erp_ot_cliente_erp() e
  UNION ALL
  (SELECT DISTINCT ON (public.apt_ot_raiz(c.code)) public.apt_ot_raiz(c.code), cl.business_name::text, 1
   FROM public.contracts c JOIN public.clients cl ON cl.id = c.client_id
   WHERE cl.business_name IS NOT NULL AND public.apt_ot_raiz(c.code) IS NOT NULL
   ORDER BY public.apt_ot_raiz(c.code), (c.parent_contract_id IS NULL) DESC, c.code)),
m AS (SELECT DISTINCT ON (ot) ot, cliente FROM cli ORDER BY ot, prioridad)
UPDATE public.inv_read_cache r
SET payload = CASE r.k
  WHEN 'contratos' THEN jsonb_set(r.payload, '{contratos}', COALESCE((
    SELECT jsonb_agg(CASE WHEN x->>'cliente' IS NULL AND m.cliente IS NOT NULL THEN x || jsonb_build_object('cliente', m.cliente) ELSE x END ORDER BY o)
    FROM jsonb_array_elements(r.payload->'contratos') WITH ORDINALITY t(x, o) LEFT JOIN m ON m.ot = x->>'ot'), '[]'::jsonb))
  ELSE jsonb_set(r.payload, '{top_ot}', COALESCE((
    SELECT jsonb_agg(CASE WHEN x->>'cliente' IS NULL AND m.cliente IS NOT NULL THEN x || jsonb_build_object('cliente', m.cliente) ELSE x END ORDER BY o)
    FROM jsonb_array_elements(r.payload->'top_ot') WITH ORDINALITY t(x, o) LEFT JOIN m ON m.ot = x->>'ot'), '[]'::jsonb)) END
WHERE (r.k = 'contratos' AND jsonb_typeof(r.payload->'contratos') = 'array')
   OR (r.k = 'apt_resumen' AND jsonb_typeof(r.payload->'top_ot') = 'array');

COMMIT;
