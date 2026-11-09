-- Salidas para una campaña de inventario que no debe cerrarse con cuadre (p. ej. abierta por error o terminada sin
-- contar): anularla o devolverla a conteo. Además, no se termina un conteo sin bultos contados (cerrarlo daría un
-- faltante por cada lote del ERP).

-- Anular: queda ANULADA con su historial y motivo; no genera resultados de cuadre. Libera los paquetes retenidos (los
-- bultos ya etiquetados conservan su etiqueta física) y la carga del ERP si ninguna otra campaña abierta la usa.
CREATE OR REPLACE FUNCTION public.wh_count_cancel(p_campaign uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c public.wh_count_campaigns; v_released integer;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN RAISE EXCEPTION 'Solo supervisión anula un inventario' USING ERRCODE = '42501'; END IF;
  IF nullif(btrim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'Registre el motivo de la anulación'; END IF;
  SELECT * INTO c FROM public.wh_count_campaigns WHERE id = p_campaign FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(c.site_id) OR c.status NOT IN ('EN_CONTEO','EN_REVISION') THEN RAISE EXCEPTION 'La campaña no está abierta'; END IF;
  PERFORM set_config('wh.count_op', 'on', true);
  UPDATE public.wh_packages SET count_hold = false WHERE count_campaign_id = c.id AND count_hold;
  GET DIAGNOSTICS v_released = ROW_COUNT;
  PERFORM set_config('wh.count_op', '', true);
  UPDATE public.wh_count_campaigns SET status = 'ANULADA', closed_by = auth.uid(), closed_at = now(), close_note = 'Anulada: ' || btrim(p_reason) WHERE id = c.id;
  UPDATE public.erp_imports SET retained = false WHERE id = c.erp_import_id
    AND NOT EXISTS (SELECT 1 FROM public.wh_count_campaigns WHERE erp_import_id = c.erp_import_id AND status IN ('EN_CONTEO','EN_REVISION'));
  RETURN jsonb_build_object('success', true, 'released_packages', v_released);
END $$;

-- Volver a conteo: de revisión a conteo, si se terminó antes de tiempo
CREATE OR REPLACE FUNCTION public.wh_count_reopen(p_campaign uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c public.wh_count_campaigns;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN RAISE EXCEPTION 'Solo supervisión' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM public.wh_count_campaigns WHERE id = p_campaign FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(c.site_id) OR c.status <> 'EN_REVISION' THEN RAISE EXCEPTION 'La campaña no está en revisión'; END IF;
  UPDATE public.wh_count_campaigns SET status = 'EN_CONTEO' WHERE id = c.id;
  RETURN jsonb_build_object('success', true);
END $$;

-- Terminar conteo exige al menos un bulto contado
CREATE OR REPLACE FUNCTION public.wh_count_to_review(p_campaign uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c public.wh_count_campaigns;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN RAISE EXCEPTION 'Solo supervisión' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM public.wh_count_campaigns WHERE id = p_campaign FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(c.site_id) OR c.status <> 'EN_CONTEO' THEN RAISE EXCEPTION 'La campaña no está en conteo'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.wh_count_lines WHERE campaign_id = c.id AND voided_at IS NULL AND origin <> 'NO_IDENTIFICADO') THEN
    RAISE EXCEPTION 'No hay bultos contados: cuente antes de terminar o anule la campaña';
  END IF;
  UPDATE public.wh_count_campaigns SET status = 'EN_REVISION' WHERE id = c.id;
  RETURN jsonb_build_object('success', true);
END $$;

REVOKE ALL ON FUNCTION public.wh_count_cancel(uuid, text), public.wh_count_reopen(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_count_cancel(uuid, text), public.wh_count_reopen(uuid) TO authenticated;
