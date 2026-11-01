-- Circuito económico de transporte: movimientos que explican la posición de cada OT, conciliación y pendientes.
-- Ver docs/control-presupuestal/circuito-economico.md (matriz de fuentes y contrato funcional).
-- · No crea un segundo libro: cada movimiento es una fila vigente de su fuente (flete por OT, flete de ruta anterior al
--   detalle por OT, descarga, cargo manual, imputación de Caja/combustible/tarifa propia, reserva residual de solicitud)
--   con su efecto actual sobre comprometido (reserved_pen) y ejecutado (consumed_pen).
-- · La conciliación compara lo que explican los movimientos con lo guardado en contract_budgets y expone la diferencia
--   (históricos sin rastro); no corrige ni reescribe saldos.
-- · Corrección: editar el flete de una OT en una ruta abierta también actualiza su renglón de flete por OT
--   (antes la reserva se ajustaba pero al cerrar la ruta se consumía el monto anterior y la diferencia quedaba comprometida).
BEGIN;
SET LOCAL lock_timeout='60s';

-- 1. Filas de movimiento de un conjunto de contratos (interna, sin permisos: la llaman las funciones de lectura)
CREATE OR REPLACE FUNCTION public.budget_movement_rows(p_contracts uuid[])
RETURNS TABLE(id text, source text, concept text, budget_contract_id uuid, ref_contract_id uuid, dispatch_id uuid, request_id uuid,
  service_id uuid, expense_id uuid, provider text, origin text, moved_on date, status text, amount_pen numeric, estimated boolean,
  reserved_pen numeric, consumed_pen numeric, reversal boolean, support text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 -- Flete por OT (rutas con detalle por solicitud). Ejecutado = flete consumido + ajuste aprobado en Costos por ruta
 SELECT 'FLT:' || r.dispatch_id || ':' || r.request_id, 'FLETE', 'Flete', r.contract_id, t.contract_id, r.dispatch_id, r.request_id,
   r.service_id, NULL::uuid, s.provider_name, 'Programación de ruta',
   (COALESCE(d.scheduled_departure, (to_jsonb(d)->>'created_at')::timestamptz) AT TIME ZONE 'America/Lima')::date, r.status,
   CASE WHEN r.status = 'LIBERADO' THEN r.amount_pen ELSE COALESCE(st.final_applied_pen, r.amount_pen) END, false,
   CASE WHEN r.status = 'RESERVADO' THEN r.amount_pen ELSE 0 END,
   CASE WHEN r.status = 'LIBERADO' THEN 0
        ELSE CASE WHEN r.status = 'CONSUMIDO' THEN r.amount_pen ELSE 0 END + COALESCE(st.final_applied_pen - r.amount_pen, 0) END,
   r.status = 'LIBERADO', NULLIF(concat_ws(' · ', s.referral_guide, s.provider_ruc), '')
 FROM public.dispatch_request_freight r
 JOIN public.dispatches d ON d.id = r.dispatch_id
 LEFT JOIN public.transport_requests t ON t.id = r.request_id
 LEFT JOIN public.contract_services s ON s.id = r.service_id
 LEFT JOIN public.dispatch_request_freight_stages st ON st.dispatch_id = r.dispatch_id AND st.request_id = r.request_id
 WHERE r.contract_id = ANY (p_contracts)
UNION ALL
 -- Flete de una ruta sin detalle por OT (anterior a las rutas mixtas)
 SELECT 'DSP:' || d.id, 'FLETE', 'Flete (ruta sin detalle por OT)', d.contract_id, d.contract_id, d.id, NULL, s.id, NULL, s.provider_name,
   'Programación de ruta', (COALESCE(d.scheduled_departure, (to_jsonb(d)->>'created_at')::timestamptz) AT TIME ZONE 'America/Lima')::date,
   d.status, COALESCE(st.final_applied_pen, d.freight_cost), false,
   CASE WHEN d.status IN ('LIQUIDADO','CANCELADO') THEN 0 ELSE d.freight_cost END,
   CASE WHEN d.status = 'CANCELADO' THEN 0
        ELSE CASE WHEN d.status = 'LIQUIDADO' THEN d.freight_cost ELSE 0 END + COALESCE(st.final_applied_pen - d.freight_cost, 0) END,
   d.status = 'CANCELADO', NULLIF(concat_ws(' · ', s.referral_guide, s.provider_ruc), '')
 FROM public.dispatches d
 LEFT JOIN public.dispatch_freight_stages st ON st.dispatch_id = d.id
 LEFT JOIN LATERAL (SELECT x.* FROM public.contract_services x WHERE x.dispatch_id = d.id AND x.service_type = 'FLETE'
                    ORDER BY (COALESCE(x.status, '') = 'ANULADO'), x.id LIMIT 1) s ON true
 WHERE d.contract_id = ANY (p_contracts) AND COALESCE(d.freight_cost, 0) > 0
   AND NOT EXISTS (SELECT 1 FROM public.dispatch_request_freight r WHERE r.dispatch_id = d.id)
UNION ALL
 -- Descarga (montacargas, grúa, estiba): planificada = comprometido; consumida (Caja o cierre) = ejecutado
 SELECT 'DSC:' || l.id, 'DESCARGA', initcap(l.concept), l.contract_id, t.contract_id, l.dispatch_id, l.transport_request_id,
   l.contract_service_id, l.expense_id, l.provider_name,
   CASE WHEN l.expense_id IS NOT NULL THEN 'Caja' WHEN l.status = 'CONSUMIDO' THEN 'Costos por ruta' ELSE 'Programación de ruta' END,
   (COALESCE(l.consumed_at, l.planned_at, l.created_at) AT TIME ZONE 'America/Lima')::date, l.status,
   COALESCE(CASE WHEN l.status = 'CONSUMIDO' THEN l.actual_pen END, l.planned_pen, l.estimated_pen, 0), false,
   CASE WHEN l.status = 'PLANIFICADO' THEN COALESCE(l.planned_pen, 0) ELSE 0 END,
   CASE WHEN l.status = 'CONSUMIDO' THEN COALESCE(l.actual_pen, 0) ELSE 0 END,
   l.status = 'ANULADO', CASE WHEN l.expense_id IS NOT NULL THEN 'Gasto de Caja' END
 FROM public.transport_unloading_costs l
 LEFT JOIN public.transport_requests t ON t.id = l.transport_request_id
 WHERE l.contract_id = ANY (p_contracts) AND l.status <> 'ESTIMADO'
UNION ALL
 -- Cargo del Registro de Servicios que no representa un flete ni una descarga ya listados (consumo inmediato)
 SELECT 'SRV:' || s.id, 'CARGO', initcap(replace(s.service_type, '_', ' ')) || COALESCE(' · ' || NULLIF(s.description, ''), ''),
   COALESCE(s.budget_contract_id, s.contract_id), s.contract_id, s.dispatch_id, NULL, s.id, NULL, s.provider_name,
   'Registro de Servicios', s.service_date, COALESCE(s.status, 'REGISTRADO'), s.amount_pen, false, 0,
   CASE WHEN COALESCE(s.status, '') = 'ANULADO' THEN 0 ELSE s.amount_pen END,
   COALESCE(s.status, '') = 'ANULADO', NULLIF(concat_ws(' · ', s.referral_guide, s.provider_ruc), '')
 FROM public.contract_services s
 WHERE COALESCE(s.budget_contract_id, s.contract_id) = ANY (p_contracts)
   AND NOT (s.service_type = 'FLETE' AND s.dispatch_id IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM public.dispatch_request_freight r WHERE r.service_id = s.id)
   AND NOT EXISTS (SELECT 1 FROM public.transport_unloading_costs l WHERE l.contract_service_id = s.id)
UNION ALL
 -- Imputaciones del control presupuestal: gasto de Caja, combustible estimado y reverso de la tarifa propia
 SELECT 'IMP:' || a.id, a.kind,
   CASE a.kind WHEN 'CAJA' THEN 'Gasto de Caja · ' || initcap(COALESCE(a.detail->>'expense_type', 'otros'))
               WHEN 'COMBUSTIBLE_ESTIMADO' THEN 'Combustible estimado' ELSE 'Reverso de tarifa propia' END,
   COALESCE(a.applied_to, a.contract_id), a.contract_id, a.dispatch_id, a.request_id, NULL, a.expense_id, NULL,
   CASE a.kind WHEN 'CAJA' THEN 'Caja' ELSE 'Cierre de ruta propia' END,
   (COALESCE(a.applied_at, a.created_at) AT TIME ZONE 'America/Lima')::date, a.status, a.amount_pen,
   a.kind = 'COMBUSTIBLE_ESTIMADO', 0, CASE WHEN a.status = 'APLICADO' THEN a.amount_pen ELSE 0 END,
   a.kind = 'TARIFA_PROPIA' OR a.status = 'ANULADO',
   CASE WHEN a.expense_id IS NOT NULL THEN 'Gasto de Caja' WHEN a.kind = 'COMBUSTIBLE_ESTIMADO'
     THEN round((a.detail->>'km')::numeric) || ' km / ' || (a.detail->>'km_per_gallon') || ' km/gal × S/ ' || (a.detail->>'price_per_gallon') END
 FROM public.cost_allocations a
 WHERE COALESCE(a.applied_to, a.contract_id) = ANY (p_contracts)
UNION ALL
 -- Reserva residual de una solicitud aprobada (esquema anterior a 20261014190000)
 SELECT 'SOL:' || t.id, 'SOLICITUD', 'Reserva de solicitud aprobada', t.contract_id, t.contract_id, NULL, t.id, NULL, NULL, NULL,
   'Aprobación de solicitud', (COALESCE(t.approved_at, t.created_at) AT TIME ZONE 'America/Lima')::date, t.status, t.reserved_pen, true,
   t.reserved_pen, 0, false, NULL
 FROM public.transport_requests t
 WHERE t.contract_id = ANY (p_contracts) AND COALESCE(t.reserved_pen, 0) > 0
$$;
REVOKE ALL ON FUNCTION public.budget_movement_rows(uuid[]) FROM PUBLIC, anon, authenticated;

-- 2. Familia de la OT raíz de un contrato (la OT y sus subcontratos/errores) con acceso del usuario; NULL si no la puede ver
CREATE OR REPLACE FUNCTION public.budget_family(p_root uuid) RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c record; v_ca boolean := public.is_contract_administrator() AND NOT public.is_tms_admin(); v uuid[];
BEGIN
 SELECT x.id, x.site_id INTO c FROM public.contracts x WHERE x.id = public.contract_root_id(p_root);
 IF NOT FOUND OR NOT (public.is_tms_admin() OR public.can_access_site(c.site_id))
    OR (v_ca AND NOT public.has_assigned_contract(c.id)) THEN RETURN NULL; END IF;
 WITH RECURSIVE fam(id) AS (SELECT c.id UNION SELECT k.id FROM public.contracts k JOIN fam f ON k.parent_contract_id = f.id)
 SELECT array_agg(id) INTO v FROM fam;
 RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.budget_family(uuid) FROM PUBLIC, anon, authenticated;

-- 3. Movimientos de una OT con su posición, período y conciliación (paginado)
CREATE OR REPLACE FUNCTION public.budget_movements(p_contract_id uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL,
  p_effect text DEFAULT NULL, p_search text DEFAULT NULL, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_root uuid := public.contract_root_id(p_contract_id); v_family uuid[]; v_budgets uuid[]; v_q text := NULLIF(lower(btrim(COALESCE(p_search, ''))), ''); v_out jsonb;
 v_limit int := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500); v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin sesión activa'); END IF;
 IF NOT (public.is_tms_admin() OR public.is_contract_administrator() OR public.budget_can_read()) THEN
  RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al control presupuestal');
 END IF;
 IF p_effect IS NOT NULL AND p_effect NOT IN ('COMPROMETIDO','EJECUTADO','SIN_EFECTO') THEN
  RETURN jsonb_build_object('success', false, 'error', 'Filtro de efecto inválido');
 END IF;
 IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
  RETURN jsonb_build_object('success', false, 'error', 'La fecha inicial es posterior a la fecha de corte');
 END IF;
 v_family := public.budget_family(p_contract_id);
 IF v_family IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'OT no disponible'); END IF;
 v_budgets := ARRAY(SELECT b.contract_id FROM public.contract_budgets b WHERE b.contract_id = ANY (v_family) AND b.concept = 'PARTIDA_TRANSPORTE');

 WITH m AS MATERIALIZED (
   SELECT x.*, x.budget_contract_id = ANY (v_budgets) AS has_budget FROM public.budget_movement_rows(v_family) x),
 pos AS (SELECT COALESCE(sum(b.allocated_pen) FILTER (WHERE b.contract_id = v_root), 0) AS allocated,
          COALESCE(sum(b.reserved_pen), 0) AS reserved, COALESCE(sum(b.consumed_pen), 0) AS consumed
         FROM public.contract_budgets b WHERE b.contract_id = ANY (v_budgets) AND b.concept = 'PARTIDA_TRANSPORTE'),
 expl AS (SELECT COALESCE(sum(reserved_pen) FILTER (WHERE has_budget), 0) AS reserved, COALESCE(sum(consumed_pen) FILTER (WHERE has_budget), 0) AS consumed,
          COALESCE(sum(consumed_pen) FILTER (WHERE has_budget AND p_from IS NOT NULL AND moved_on < p_from), 0) AS opening,
          COALESCE(sum(consumed_pen) FILTER (WHERE has_budget AND (p_from IS NULL OR moved_on >= p_from) AND (p_to IS NULL OR moved_on <= p_to)), 0) AS period
         FROM m),
 f AS (SELECT m.* FROM m
       WHERE (p_from IS NULL OR m.moved_on >= p_from) AND (p_to IS NULL OR m.moved_on <= p_to)
         AND (p_effect IS NULL OR (p_effect = 'COMPROMETIDO' AND m.reserved_pen <> 0) OR (p_effect = 'EJECUTADO' AND m.consumed_pen <> 0)
              OR (p_effect = 'SIN_EFECTO' AND m.reserved_pen = 0 AND m.consumed_pen = 0))),
 named AS (
   SELECT f.*, dd.dispatch_number, tr.request_number, rc.code AS ref_code, bc.code AS budget_code
   FROM f LEFT JOIN public.dispatches dd ON dd.id = f.dispatch_id LEFT JOIN public.transport_requests tr ON tr.id = f.request_id
   LEFT JOIN public.contracts rc ON rc.id = f.ref_contract_id LEFT JOIN public.contracts bc ON bc.id = f.budget_contract_id),
 searched AS (
   SELECT * FROM named n WHERE v_q IS NULL OR position(v_q IN lower(concat_ws(' ', n.id, n.concept, n.provider, n.dispatch_number, n.request_number,
     n.ref_code, n.support, n.status))) > 0)
 SELECT jsonb_build_object('success', true, 'as_of', now(),
   'contract', (SELECT jsonb_build_object('id', c.id, 'code', c.code, 'client', cl.business_name) FROM public.contracts c
                LEFT JOIN public.clients cl ON cl.id = c.client_id WHERE c.id = v_root),
   'position', (SELECT jsonb_build_object('allocated_pen', allocated, 'reserved_pen', reserved, 'consumed_pen', consumed,
                'authorized_over_cap_pen', public.budget_authorized_over_cap(v_root)) FROM pos),
   'explained', (SELECT jsonb_build_object('reserved_pen', reserved, 'consumed_pen', consumed) FROM expl),
   'difference', (SELECT jsonb_build_object('reserved_pen', round(p.reserved - e.reserved, 2), 'consumed_pen', round(p.consumed - e.consumed, 2))
                  FROM pos p, expl e),
   -- Ejecutado: saldo inicial + movimientos del período = saldo al corte. Comprometido: solo vigente (no hay historia por fecha)
   'period', (SELECT jsonb_build_object('from', p_from, 'to', p_to, 'opening_consumed_pen', opening, 'period_consumed_pen', period,
                'closing_consumed_pen', opening + period) FROM expl),
   'without_budget', (SELECT count(*) FROM m WHERE NOT has_budget AND (reserved_pen <> 0 OR consumed_pen <> 0)),
   'total', (SELECT count(*) FROM searched),
   'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'source', s.source, 'concept', s.concept,
       'budget_code', s.budget_code, 'ref_code', s.ref_code, 'dispatch_id', s.dispatch_id, 'dispatch_number', s.dispatch_number,
       'request_id', s.request_id, 'request_number', s.request_number, 'service_id', s.service_id, 'expense_id', s.expense_id,
       'provider', s.provider, 'origin', s.origin, 'date', s.moved_on, 'status', s.status, 'amount_pen', s.amount_pen,
       'estimated', s.estimated, 'reserved_pen', s.reserved_pen, 'consumed_pen', s.consumed_pen, 'reversal', s.reversal,
       'support', s.support, 'has_budget', s.has_budget, 'service_contract_id', CASE WHEN s.source = 'CARGO' THEN s.ref_contract_id END)
      ORDER BY s.moved_on DESC NULLS LAST, s.id)
     FROM (SELECT * FROM searched ORDER BY moved_on DESC NULLS LAST, id LIMIT v_limit OFFSET v_offset) s), '[]'::jsonb))
 INTO v_out;
 RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.budget_movements(uuid,date,date,text,text,integer,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.budget_movements(uuid,date,date,text,text,integer,integer) TO authenticated;

-- 4. Pendientes accionables con dato que los respalde (los desvíos y autorizaciones siguen en sus propios flujos)
CREATE OR REPLACE FUNCTION public.budget_pending() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_ca boolean := public.is_contract_administrator() AND NOT public.is_tms_admin(); v_out jsonb;
 v_since timestamptz := (SELECT budget_imputation_since FROM public.economic_settings WHERE id);
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin sesión activa'); END IF;
 IF NOT (public.is_tms_admin() OR v_ca OR public.budget_can_read()) THEN
  RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al control presupuestal');
 END IF;
 WITH RECURSIVE r AS MATERIALIZED (
   SELECT c.id, c.code FROM public.contracts c
   WHERE c.parent_contract_id IS NULL AND c.type IN ('CONTRATO','OT_INDEPENDIENTE')
     AND (public.is_tms_admin() OR public.can_access_site(c.site_id)) AND (NOT v_ca OR public.has_assigned_contract(c.id))),
 fam (root, id) AS (SELECT r.id, r.id FROM r UNION SELECT f.root, c.id FROM public.contracts c JOIN fam f ON c.parent_contract_id = f.id),
 bud AS MATERIALIZED (SELECT f.root, b.contract_id, b.reserved_pen, b.consumed_pen FROM fam f
        JOIN public.contract_budgets b ON b.contract_id = f.id AND b.concept = 'PARTIDA_TRANSPORTE'),
 m AS MATERIALIZED (SELECT x.*, bud.root FROM public.budget_movement_rows(ARRAY(SELECT contract_id FROM bud)) x
        JOIN bud ON bud.contract_id = x.budget_contract_id),
 conc AS (
   SELECT b.root, round(sum(b.reserved_pen) - COALESCE((SELECT sum(m.reserved_pen) FROM m WHERE m.root = b.root), 0), 2) AS d_res,
          round(sum(b.consumed_pen) - COALESCE((SELECT sum(m.consumed_pen) FROM m WHERE m.root = b.root), 0), 2) AS d_con
   FROM bud b GROUP BY b.root),
 items AS (
   -- Diferencia de conciliación: saldo guardado que ningún movimiento vigente explica
   SELECT 'CONCILIACION' AS kind, c.root AS contract_id, NULL::uuid AS dispatch_id, NULL::text AS ref,
     'Saldo sin movimiento que lo explique (comprometido ' || to_char(c.d_res, 'FM999G999G990D00') || ', ejecutado '
       || to_char(c.d_con, 'FM999G999G990D00') || ')' AS cause,
     abs(c.d_res) + abs(c.d_con) AS amount_pen, NULL::timestamptz AS since, NULL::text AS registered_by,
     'Revisar los movimientos de la OT; corregir solo con un ajuste documentado' AS action
   FROM conc c WHERE abs(c.d_res) >= 0.01 OR abs(c.d_con) >= 0.01
   UNION ALL
   -- Combustible estimado aún no reemplazado por la carga real
   SELECT 'COMBUSTIBLE_ESTIMADO', m.root, m.dispatch_id, m.id, 'Combustible estimado por km: falta la carga real de Caja',
     m.consumed_pen, (SELECT a.applied_at FROM public.cost_allocations a WHERE 'IMP:' || a.id = m.id), NULL,
     'Registrar o aprobar el ticket de combustible en Caja (reemplaza al estimado)'
   FROM m WHERE m.source = 'COMBUSTIBLE_ESTIMADO' AND m.status = 'APLICADO'
   UNION ALL
   -- Gasto de Caja de una ruta ya cerrada que no se imputó a la OT
   SELECT 'SIN_IMPUTAR', fr.root, e.dispatch_id, e.id::text,
     'Gasto de Caja aprobado (' || initcap(COALESCE(e.expense_type, 'otros')) || ') sin imputar a la OT', COALESCE(e.approved_amount, e.amount),
     (to_jsonb(e)->>'created_at')::timestamptz, NULL, 'Revisar el gasto en Caja y la OT de la ruta'
   FROM public.dispatch_expenses e
   JOIN public.dispatches d ON d.id = e.dispatch_id
   JOIN fam fr ON fr.id = COALESCE(d.contract_id, (SELECT x.contract_id FROM public.dispatch_request_freight x WHERE x.dispatch_id = d.id AND x.contract_id IS NOT NULL LIMIT 1))
   WHERE e.status = 'APROBADO' AND COALESCE(e.approved_amount, e.amount, 0) > 0
     AND upper(COALESCE(e.expense_type, '')) IN ('COMBUSTIBLE','PEAJE','ALIMENTACION','VIATICOS','HOSPEDAJE','ESTACIONAMIENTO','MANIOBRAS','OTROS')
     AND COALESCE(d.scheduled_departure, now()) >= v_since AND d.status IN ('LIQUIDADO','CERRADO')
     AND NOT EXISTS (SELECT 1 FROM public.cost_allocations a WHERE a.expense_id = e.id AND a.status <> 'ANULADO')
   UNION ALL
   -- Gasto de Caja de ruta propia esperando el cierre de la ruta (se imputa al cerrar)
   SELECT 'POR_IMPUTAR', fr.root, a.dispatch_id, 'IMP:' || a.id, 'Gasto de Caja de ruta propia abierta: se imputa al cerrar la ruta',
     a.amount_pen, a.created_at, NULL, 'Cerrar la ruta cuando termine'
   FROM public.cost_allocations a JOIN fam fr ON fr.id = a.contract_id
   WHERE a.status = 'PENDIENTE'
   UNION ALL
   -- Cargo manual sin guía, proveedor ni ruta que lo respalde
   SELECT 'SIN_SUSTENTO', m.root, NULL, m.id, 'Cargo manual sin guía, proveedor ni ruta', m.consumed_pen,
     (SELECT (to_jsonb(s)->>'created_at')::timestamptz FROM public.contract_services s WHERE s.id = m.service_id),
     (SELECT public.economic_user_name(s.created_by) FROM public.contract_services s WHERE s.id = m.service_id),
     'Completar el sustento o anular el cargo en Registro de Servicios'
   FROM m WHERE m.source = 'CARGO' AND m.consumed_pen <> 0 AND m.dispatch_id IS NULL AND m.support IS NULL AND m.provider IS NULL
   UNION ALL
   -- Posible duplicado: mismo tipo, importe, fecha y placa en la misma partida
   SELECT 'POSIBLE_DUPLICADO', g.root, NULL, g.ids[1], g.n || ' cargos iguales: ' || g.concept || ' del ' || to_char(g.moved_on, 'DD/MM/YYYY'),
     g.amount * (g.n - 1), NULL, NULL, 'Confirmar en Registro de Servicios y anular el repetido'
   FROM (SELECT m.root, m.concept, m.moved_on, m.amount_pen AS amount, count(*) AS n, array_agg(m.id ORDER BY m.id) AS ids
         FROM m JOIN public.contract_services s ON s.id = m.service_id
         WHERE m.source = 'CARGO' AND m.consumed_pen <> 0
         GROUP BY m.root, m.budget_contract_id, s.service_type, m.concept, m.moved_on, m.amount_pen, COALESCE(s.plate, '') HAVING count(*) > 1) g)
 SELECT jsonb_build_object('success', true, 'as_of', now(), 'rows', COALESCE(jsonb_agg(jsonb_build_object(
     'kind', i.kind, 'contract_id', i.contract_id, 'contract_code', r.code, 'dispatch_id', i.dispatch_id, 'dispatch_number', d.dispatch_number,
     'ref', i.ref, 'cause', i.cause, 'amount_pen', i.amount_pen, 'since', i.since,
     'age_days', CASE WHEN i.since IS NOT NULL THEN (now()::date - (i.since AT TIME ZONE 'America/Lima')::date) END,
     'registered_by', i.registered_by, 'action', i.action)
   ORDER BY i.since NULLS LAST, i.amount_pen DESC), '[]'::jsonb))
 INTO v_out
 FROM items i JOIN r ON r.id = i.contract_id LEFT JOIN public.dispatches d ON d.id = i.dispatch_id;
 RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.budget_pending() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.budget_pending() TO authenticated;

-- 5. Editar el flete de una OT en ruta abierta también actualiza su renglón de flete por OT (parche guardado)
DO $patch$
DECLARE def text := pg_get_functiondef('public.update_contract_service_amount(uuid,numeric)'::regprocedure);
 o text := 'UPDATE public.contract_services SET amount_pen = p_new_amount WHERE id = p_service_id;';
 n text := 'UPDATE public.contract_services SET amount_pen = p_new_amount WHERE id = p_service_id;
  UPDATE public.dispatch_request_freight SET amount_pen = p_new_amount WHERE service_id = p_service_id AND status = ''RESERVADO'';';
BEGIN
 IF position('UPDATE public.dispatch_request_freight SET amount_pen' IN def) > 0 THEN RETURN; END IF;
 IF position(o IN def) = 0 THEN RAISE EXCEPTION 'update_contract_service_amount cambió: revisar el parche del flete por OT'; END IF;
 EXECUTE replace(def, o, n);
END $patch$;

NOTIFY pgrst,'reload schema';
COMMIT;
