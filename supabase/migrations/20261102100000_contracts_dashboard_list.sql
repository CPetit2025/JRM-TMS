-- ============================================================
-- Lista de Contratos y OTs en una sola pasada (contracts_dashboard_list)
-- ============================================================
-- vw_contracts_dashboard calcula por cada OT madre subconsultas (subcontratos, errores, solicitudes, familia) y la
-- seguridad por fila evalúa permisos en cada fila de cada subconsulta. Con el alta automática desde el ERP (miles de OT)
-- la lista superó el límite de 8 s. Esta función aplica la misma visibilidad una sola vez (cuenta activa, permiso de
-- lectura, sedes a las que accede y, para el Administrador de Contratos, solo su cartera) y agrega todo por conjuntos.
-- La vista se mantiene para la ficha y la vista rápida (una sola OT).
BEGIN;
SET LOCAL lock_timeout = '60s';

CREATE OR REPLACE FUNCTION public.contracts_dashboard_list()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_admin boolean := public.is_tms_admin();
  v_ca boolean := public.is_contract_administrator() AND NOT public.is_tms_admin();
  v_sites uuid[];
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_tms_user() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin sesión activa');
  END IF;
  IF NOT (v_admin OR v_ca OR public.has_tms_read_permission('ot') OR public.has_tms_read_permission('clientes')
      OR public.has_tms_read_permission('contratos-servicios') OR public.has_tms_read_permission('solicitudes')
      OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('dashboard')
      OR public.has_tms_read_permission('operaciones-kpis')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para ver contratos');
  END IF;
  v_sites := ARRAY(SELECT s.id FROM public.sites s WHERE public.can_access_site(s.id));

  RETURN jsonb_build_object('success', true, 'filas', COALESCE((
    WITH RECURSIVE r AS MATERIALIZED (
      SELECT c.* FROM public.contracts c
      WHERE c.parent_contract_id IS NULL AND c.type IN ('CONTRATO', 'OT_INDEPENDIENTE') AND c.site_id = ANY (v_sites)
        AND (NOT v_ca OR public.has_assigned_contract(c.id))),
    fam (root, id) AS (
      SELECT r.id, r.id FROM r
      UNION
      SELECT f.root, c.id FROM public.contracts c JOIN fam f ON c.parent_contract_id = f.id),
    kids AS (
      SELECT c.parent_contract_id AS id, count(*) FILTER (WHERE c.type = 'SUBCONTRATO') AS subcontracts_count,
        count(*) FILTER (WHERE c.type = 'ERROR') AS errors_count
      FROM public.contracts c WHERE c.parent_contract_id IN (SELECT r.id FROM r) GROUP BY 1),
    req AS (SELECT tr.contract_id AS id, count(*) AS requests_count FROM public.transport_requests tr
            WHERE tr.contract_id IN (SELECT r.id FROM r) GROUP BY 1),
    tot AS (
      SELECT f.root AS id, COALESCE(sum(b.reserved_pen), 0) AS reserved, COALESCE(sum(b.consumed_pen), 0) AS consumed
      FROM fam f JOIN public.contract_budgets b ON b.contract_id = f.id AND b.concept = 'PARTIDA_TRANSPORTE' GROUP BY 1)
    SELECT jsonb_agg(to_jsonb(r) || jsonb_build_object(
        'subcontracts_count', COALESCE(k.subcontracts_count, 0), 'errors_count', COALESCE(k.errors_count, 0),
        'requests_count', COALESCE(q.requests_count, 0), 'client_name', cl.business_name,
        'allocated_usd', b.allocated_usd, 'allocated_pen', b.allocated_pen, 'reserved_pen', b.reserved_pen,
        'consumed_pen', b.consumed_pen, 'balance_pen', b.balance_pen, 'own_allocated_pen', b.own_allocated_pen,
        'family_reserved_pen', COALESCE(t.reserved, 0), 'family_consumed_pen', COALESCE(t.consumed, 0))
      ORDER BY r.created_at DESC)
    FROM r LEFT JOIN kids k ON k.id = r.id LEFT JOIN req q ON q.id = r.id LEFT JOIN tot t ON t.id = r.id
      LEFT JOIN public.clients cl ON cl.id = r.client_id
      LEFT JOIN public.contract_budgets b ON b.contract_id = r.id AND b.concept = 'PARTIDA_TRANSPORTE'), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.contracts_dashboard_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.contracts_dashboard_list() TO authenticated, service_role;

COMMIT;
