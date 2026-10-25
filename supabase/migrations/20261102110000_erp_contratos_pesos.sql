-- ============================================================
-- ERP · Peso de cada OT desde el Actualizable
-- ============================================================
-- El Actualizable trae por línea la cantidad del contrato y el peso unitario: el peso del documento (OT madre,
-- subcontrato o error) es la suma de cantidad × peso unitario de sus líneas con peso. Se carga en contracts.total_weight_kg
-- cuando el TMS no tiene peso (vacío o 0) o el que tiene vino del ERP; un peso escrito a mano no se pisa. Queda registro
-- en erp_contract_pesos (kg, líneas y líneas sin peso, para saber si el peso es parcial). Corre con el alta automática
-- (cada Actualizable nuevo) y una vez ahora.
BEGIN;
SET LOCAL lock_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.erp_contract_pesos (
  contract_id     uuid PRIMARY KEY REFERENCES public.contracts(id) ON DELETE CASCADE,
  kg              numeric(20,2) NOT NULL,
  lineas          integer NOT NULL,
  lineas_sin_peso integer NOT NULL,
  import_id       uuid REFERENCES public.erp_imports(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS erp_contract_pesos_import_idx ON public.erp_contract_pesos (import_id);
ALTER TABLE public.erp_contract_pesos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.erp_contract_pesos;
CREATE POLICY security_active_account ON public.erp_contract_pesos AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.erp_contract_pesos FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.erp_contratos_pesos_core()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_c uuid := public.erp_active_import('CONTRATOS'); n_upd integer := 0; n_manual integer := 0; n_parcial integer := 0;
BEGIN
  IF v_c IS NULL THEN RETURN jsonb_build_object('success', true, 'sin_datos', true); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contracts'
                 AND column_name = 'total_weight_kg') THEN
    RETURN jsonb_build_object('success', true, 'sin_columna', true);
  END IF;
  CREATE TEMP TABLE IF NOT EXISTS erp_tmp_peso (id uuid, kg numeric, lineas integer, sin integer, actual numeric, anterior numeric) ON COMMIT DROP;
  TRUNCATE erp_tmp_peso;
  INSERT INTO erp_tmp_peso
  WITH d AS (
    SELECT public.erp_doc_key(l.nro_documento) AS dk,
      sum(l.cant_contrato * l.peso_unit) FILTER (WHERE l.peso_unit > 0 AND NOT l.cantidades_ausentes) AS kg,
      count(*)::integer AS lineas,
      count(*) FILTER (WHERE COALESCE(l.peso_unit, 0) <= 0 OR l.cantidades_ausentes)::integer AS sin
    FROM public.erp_contract_lines l WHERE l.import_id = v_c GROUP BY 1)
  SELECT c.id, round(d.kg, 2), d.lineas, d.sin, NULLIF(to_jsonb(c)->>'total_weight_kg', '')::numeric, p.kg
  FROM public.contracts c JOIN d ON d.dk = public.erp_doc_key(c.code)
  LEFT JOIN public.erp_contract_pesos p ON p.contract_id = c.id
  WHERE d.kg > 0;

  -- Solo donde el peso es del ERP: vacío, 0 o igual al último que se cargó desde el ERP
  DELETE FROM erp_tmp_peso t WHERE NOT (COALESCE(t.actual, 0) = 0 OR t.actual IS NOT DISTINCT FROM t.anterior);
  GET DIAGNOSTICS n_manual = ROW_COUNT;
  EXECUTE 'UPDATE public.contracts c SET total_weight_kg = t.kg FROM erp_tmp_peso t
           WHERE c.id = t.id AND c.total_weight_kg IS DISTINCT FROM t.kg';
  GET DIAGNOSTICS n_upd = ROW_COUNT;
  INSERT INTO public.erp_contract_pesos (contract_id, kg, lineas, lineas_sin_peso, import_id, updated_at)
  SELECT t.id, t.kg, t.lineas, t.sin, v_c, now() FROM erp_tmp_peso t
  ON CONFLICT (contract_id) DO UPDATE SET kg = EXCLUDED.kg, lineas = EXCLUDED.lineas, lineas_sin_peso = EXCLUDED.lineas_sin_peso,
    import_id = EXCLUDED.import_id, updated_at = EXCLUDED.updated_at;
  SELECT count(*) INTO n_parcial FROM erp_tmp_peso t WHERE t.sin > 0;
  RETURN jsonb_build_object('success', true, 'actualizadas', n_upd, 'con_peso_erp', (SELECT count(*) FROM erp_tmp_peso),
    'parciales', n_parcial, 'manuales_conservadas', n_manual);
END $$;
REVOKE ALL ON FUNCTION public.erp_contratos_pesos_core() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erp_contratos_pesos_core() TO service_role;

-- Desde el navegador (respaldo si el servidor no está disponible): alta automática y pesos
CREATE OR REPLACE FUNCTION public.erp_contratos_alta_automatica(p_simular boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v jsonb;
BEGIN
  IF NOT public.erp_contratos_alta_permiso() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso: requiere carga del ERP, Contratos y OTs o Administrador');
  END IF;
  v := public.erp_contratos_alta_automatica_core(p_simular, auth.uid());
  IF NOT p_simular AND COALESCE((v->>'success')::boolean, false) THEN
    v := v || jsonb_build_object('pesos', public.erp_contratos_pesos_core());
  END IF;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.erp_contratos_alta_automatica(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_contratos_alta_automatica(boolean) TO authenticated, service_role;

-- Pesos del Actualizable vigente
DO $migration$
DECLARE r jsonb;
BEGIN
  r := public.erp_contratos_pesos_core();
  RAISE NOTICE 'Pesos desde el ERP: %', r;
END $migration$;

COMMIT;
