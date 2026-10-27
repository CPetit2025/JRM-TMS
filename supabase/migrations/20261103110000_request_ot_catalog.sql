-- La búsqueda anterior descargaba páginas de contracts con clientes y partidas embebidas.
-- RLS volvía a evaluar permisos/cartera por cada fila y cada relación. Autorizar una vez
-- y devolver solo el catálogo necesario, sin el límite de 1.000 filas de PostgREST.
BEGIN;
CREATE OR REPLACE FUNCTION public.get_transport_request_ot_catalog()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid := auth.uid();
  v_sites uuid[];
  v_assigned uuid[];
  v_budget_assigned uuid[];
  v_portfolio boolean;
  v_budgets boolean;
BEGIN
  IF v_user IS NULL OR NOT public.is_active_tms_user() OR NOT public.has_tms_read_permission('solicitudes') THEN
    RAISE EXCEPTION 'Sin permiso para consultar solicitudes' USING ERRCODE = '42501';
  END IF;
  v_sites := ARRAY(SELECT s.id FROM public.sites s WHERE public.can_access_site(s.id));
  v_portfolio := public.is_contract_administrator();
  IF v_portfolio THEN
    v_assigned := ARRAY(SELECT a.contract_id FROM public.contract_user_assignments a
      WHERE a.user_id = v_user AND a.active);
    v_budget_assigned := ARRAY(SELECT a.contract_id FROM public.contract_user_assignments a
      WHERE a.user_id = v_user AND a.active AND a.role IN ('ADMIN_CONTRATO','BACKUP'));
  END IF;
  -- Misma lectura de partidas que contract_budgets_read_site; solicitudes por sí
  -- sola no habilita saldos. No consultar esa tabla mediante sus políticas por fila.
  v_budgets := public.has_tms_read_permission('dashboard') OR public.has_tms_read_permission('clientes')
    OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('contratos-servicios')
    OR public.has_tms_read_permission('ot') OR public.has_tms_read_permission('operaciones-kpis');

  RETURN jsonb_build_object('success', true, 'rows', COALESCE((
    WITH roots AS MATERIALIZED (
      SELECT c.id, c.site_id FROM public.contracts c
      WHERE c.status = 'ACTIVO' AND c.parent_contract_id IS NULL
        AND c.type IN ('CONTRATO','OT_INDEPENDIENTE') AND c.site_id = ANY(v_sites)
        AND (NOT v_portfolio OR c.id = ANY(v_assigned))
    ), eligible AS (
      SELECT c.*, r.id AS root_id FROM public.contracts c JOIN roots r ON c.id = r.id
      UNION ALL
      SELECT c.*, r.id AS root_id FROM public.contracts c JOIN roots r ON c.parent_contract_id = r.id AND c.site_id = r.site_id
      WHERE c.status = 'ACTIVO' AND c.type IN ('SUBCONTRATO','ERROR')
    )
    SELECT jsonb_agg(jsonb_build_object(
      'id', c.id, 'code', c.code, 'type', c.type, 'status', c.status,
      'parent_contract_id', c.parent_contract_id,
      'destination_address', c.destination_address, 'destination_department', c.destination_department,
      'destination_province', c.destination_province, 'destination_district', c.destination_district,
      'clients', CASE WHEN cl.id IS NOT NULL THEN jsonb_build_object('business_name', cl.business_name) END,
      'allocated_pen', b.allocated_pen, 'balance_pen', b.balance_pen
    ) ORDER BY c.code, c.id)
    FROM eligible c LEFT JOIN public.clients cl ON cl.id = c.client_id
    LEFT JOIN public.contract_budgets b ON v_budgets AND b.contract_id = c.id AND b.concept = 'PARTIDA_TRANSPORTE'
      AND (NOT v_portfolio OR c.root_id = ANY(v_budget_assigned))
  ), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.get_transport_request_ot_catalog() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_transport_request_ot_catalog() TO authenticated;
COMMIT;
