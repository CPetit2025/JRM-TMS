-- ============================================================
-- CONTRATOS — Asignar o actualizar la partida de transporte de una OT
-- ============================================================
-- No había una forma confiable de fijar la partida de una OT que no la tenía:
--   * create_contract solo crea la fila PARTIDA_TRANSPORTE cuando el alta trae monto > 0, así que una OT dada de
--     alta sin partida queda sin fila (contract_budget_owner devuelve NULL → "Sin partida").
--   * La edición en /contratos hacía UPDATE directo a contract_budgets: si la fila no existía actualizaba 0 filas
--     y mostraba "actualizado" sin guardar nada (el INSERT de respaldo nunca se alcanzaba y, además, iba sin concepto).
--   * JRM IA no tenía acción para la partida y la registraba como gasto.
-- set_contract_transport_budget valida permisos (OT escritura, cartera del Administrador de Contratos y sede),
-- crea la partida de la OT raíz si falta (la familia madre + subcontratos + errores comparte esa partida), fija el
-- aporte propio del registro indicado y deja constancia en contract_budget_adjustments.
-- Producción no coincide con el repo: own_allocated_pen (20261010060000) y la tabla de ajustes se usan solo si existen.
BEGIN;

CREATE OR REPLACE FUNCTION public.set_contract_transport_budget(p_contract_id uuid, p_amount numeric, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_contract  record;
  v_root      record;
  v_amount    numeric;
  v_budget    record;
  v_old       numeric;
  v_own_col   boolean := EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'contract_budgets' AND column_name = 'own_allocated_pen');
  v_total     record;
  v_reason    text := NULLIF(trim(COALESCE(p_reason, '')), '');
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sin sesión'; END IF;
  IF NOT (public.is_tms_admin() OR public.has_tms_permission('ot')) THEN
    RAISE EXCEPTION 'Sin permiso para modificar la partida de la OT (requiere Contratos y OTs con escritura)';
  END IF;
  IF p_amount IS NULL OR p_amount < 0 OR p_amount > 999999999999.99 THEN
    RAISE EXCEPTION 'Indique un monto de partida válido (cero o mayor)';
  END IF;
  v_amount := round(p_amount, 2);

  SELECT c.id, c.code::text AS code, c.type::text AS type, c.status::text AS status, c.site_id, c.parent_contract_id
    INTO v_contract FROM public.contracts c WHERE c.id = p_contract_id;
  IF v_contract.id IS NULL OR NOT public.can_access_site(v_contract.site_id) THEN
    RAISE EXCEPTION 'OT no disponible';
  END IF;
  IF public.is_contract_administrator() AND NOT public.has_assigned_contract(v_contract.id, true) THEN
    RAISE EXCEPTION 'La OT % no está asignada a usted', v_contract.code;
  END IF;
  IF upper(COALESCE(v_contract.status, '')) IN ('ANULADO', 'CANCELADO') THEN
    RAISE EXCEPTION 'La OT % está %; no se puede modificar su partida', v_contract.code, lower(v_contract.status);
  END IF;

  -- La partida de la familia vive en la OT raíz: se bloquea su contrato para serializar la creación de la fila
  SELECT c.id, c.code::text AS code, c.site_id INTO v_root
    FROM public.contracts c WHERE c.id = COALESCE(public.contract_root_id(v_contract.id), v_contract.id) FOR UPDATE;
  IF NOT public.can_access_site(v_root.site_id) THEN RAISE EXCEPTION 'No tiene acceso a la sede de la OT %', v_root.code; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.contract_budgets WHERE contract_id = v_root.id AND concept = 'PARTIDA_TRANSPORTE') THEN
    INSERT INTO public.contract_budgets (contract_id, concept, allocated_pen) VALUES (v_root.id, 'PARTIDA_TRANSPORTE', 0);
  END IF;
  IF v_contract.id <> v_root.id AND NOT EXISTS (SELECT 1 FROM public.contract_budgets
       WHERE contract_id = v_contract.id AND concept = 'PARTIDA_TRANSPORTE') THEN
    INSERT INTO public.contract_budgets (contract_id, concept, allocated_pen) VALUES (v_contract.id, 'PARTIDA_TRANSPORTE', 0);
  END IF;

  SELECT b.id, COALESCE((to_jsonb(b)->>'own_allocated_pen')::numeric, b.allocated_pen, 0) AS own
    INTO v_budget FROM public.contract_budgets b
   WHERE b.contract_id = v_contract.id AND b.concept = 'PARTIDA_TRANSPORTE' ORDER BY b.created_at NULLS LAST LIMIT 1 FOR UPDATE;
  v_old := v_budget.own;

  IF v_old IS DISTINCT FROM v_amount THEN
    -- Con la partida por familia el aporte editable es own_allocated_pen (allocated_pen de la raíz es el total)
    EXECUTE format('UPDATE public.contract_budgets SET %I = $1 WHERE id = $2',
                   CASE WHEN v_own_col THEN 'own_allocated_pen' ELSE 'allocated_pen' END)
      USING v_amount, v_budget.id;

    SELECT b.allocated_pen, b.balance_pen INTO v_total FROM public.contract_budgets b
     WHERE b.contract_id = v_root.id AND b.concept = 'PARTIDA_TRANSPORTE' ORDER BY b.created_at NULLS LAST LIMIT 1;
    -- Reducir no puede dejar la partida por debajo de lo ya reservado y consumido (el 20 % de utilidad se protege)
    IF v_amount < v_old AND COALESCE(v_total.balance_pen, 0) < 0 THEN
      RAISE EXCEPTION 'No se puede reducir la partida a S/ %: quedaría por debajo de lo ya reservado y consumido en la OT %',
        to_char(v_amount, 'FM999,999,999,990.00'), v_root.code;
    END IF;

    IF to_regclass('public.contract_budget_adjustments') IS NOT NULL THEN
      EXECUTE 'INSERT INTO public.contract_budget_adjustments (budget_id, contract_id, field, old_value, new_value, reason)
               VALUES ($1, $2, $3, $4, $5, $6)'
        USING v_budget.id, v_contract.id, 'partida_transporte', v_old, v_amount,
              left(COALESCE(v_reason, 'Partida de transporte asignada') || ' · usuario ' || auth.uid()::text, 500);
    END IF;
  END IF;

  SELECT b.allocated_pen, b.balance_pen INTO v_total FROM public.contract_budgets b
   WHERE b.contract_id = v_root.id AND b.concept = 'PARTIDA_TRANSPORTE' ORDER BY b.created_at NULLS LAST LIMIT 1;
  RETURN jsonb_build_object(
    'success', true, 'contract_id', v_contract.id, 'code', v_contract.code,
    'budget_contract_id', v_root.id, 'budget_code', v_root.code,
    'previous_pen', v_old, 'own_allocated_pen', v_amount, 'changed', v_old IS DISTINCT FROM v_amount,
    'allocated_pen', v_total.allocated_pen, 'balance_pen', v_total.balance_pen);
END $$;

REVOKE ALL ON FUNCTION public.set_contract_transport_budget(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_contract_transport_budget(uuid, numeric, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
