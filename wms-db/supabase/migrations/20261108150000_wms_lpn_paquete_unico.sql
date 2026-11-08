-- Un paquete que sale solo queda como LPN con el código de su propia etiqueta: no se imprime otra.
-- Dos o más paquetes siguen generando un LPN-… nuevo con su etiqueta.
CREATE OR REPLACE FUNCTION public.wh_consolidate_lpn(p_task_id uuid, p_package_codes text[], p_client_event_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.wh_tasks%ROWTYPE; p public.wh_packages%ROWTYPE; v_codes text[]; v_code text; v_id uuid := gen_random_uuid();
  v_lpn text; v_qty numeric := 0; v_kg numeric := 0; v_n integer := 0; v_prev uuid; v_own boolean := false;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-picking','almacen-packing','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso de picking' USING ERRCODE = '42501'; END IF;
  SELECT * INTO t FROM public.wh_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
  IF p_client_event_id IS NOT NULL THEN
    SELECT lpn_id INTO v_prev FROM public.wh_scan_events WHERE site_id = t.site_id AND client_event_id = p_client_event_id AND event_type = 'LPN_CONSOLIDATE';
    IF v_prev IS NOT NULL THEN
      RETURN (SELECT jsonb_build_object('id', id, 'lpn_code', lpn_code, 'package_count', package_count, 'quantity', quantity, 'weight_kg', weight_kg, 'duplicate_retry', true) FROM public.wh_lpns WHERE id = v_prev);
    END IF;
  END IF;
  IF t.status NOT IN ('PICKING','PACKING') THEN RAISE EXCEPTION 'La tarea no está en preparación'; END IF;
  SELECT array_agg(DISTINCT trim(x)) INTO v_codes FROM unnest(p_package_codes) x WHERE nullif(trim(x), '') IS NOT NULL;
  IF coalesce(array_length(v_codes, 1), 0) = 0 THEN RAISE EXCEPTION 'Seleccione al menos un paquete'; END IF;
  v_lpn := 'LPN-' || to_char(now(), 'YYMMDD') || '-' || upper(substr(replace(v_id::text, '-', ''), 1, 8));
  IF array_length(v_codes, 1) = 1 THEN
    -- Si antes se deshizo un LPN de este mismo paquete, su registro anulado cede el código (el historial sigue por id).
    UPDATE public.wh_lpns SET lpn_code = lpn_code || '-ANULADO-' || upper(substr(replace(id::text, '-', ''), 1, 8))
     WHERE lpn_code = v_codes[1] AND status = 'VOID';
    IF NOT EXISTS (SELECT 1 FROM public.wh_lpns WHERE lpn_code = v_codes[1]) THEN v_lpn := v_codes[1]; v_own := true; END IF;
  END IF;
  INSERT INTO public.wh_lpns(id, lpn_code, site_id, task_id, status, created_by, closed_by, closed_at, print_count)
  VALUES (v_id, v_lpn, t.site_id, t.id, 'CLOSED', auth.uid(), auth.uid(), now(), CASE WHEN v_own THEN 1 ELSE 0 END);
  FOREACH v_code IN ARRAY v_codes LOOP
    SELECT * INTO p FROM public.wh_packages WHERE package_code = v_code AND site_id = t.site_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'El paquete % no existe en este almacén', v_code; END IF;
    IF p.task_id IS DISTINCT FROM t.id THEN RAISE EXCEPTION 'El paquete % no fue recogido para esta tarea', v_code; END IF;
    IF p.lpn_id IS NOT NULL THEN RAISE EXCEPTION 'El paquete % ya está en el LPN %', v_code, (SELECT lpn_code FROM public.wh_lpns WHERE id = p.lpn_id); END IF;
    IF p.status <> 'PICKED' THEN RAISE EXCEPTION 'El paquete % no está recogido (estado %)', v_code, p.status; END IF;
    UPDATE public.wh_packages SET status = 'PACKED', lpn_id = v_id WHERE id = p.id;
    IF p.task_line_id IS NOT NULL THEN UPDATE public.wh_task_lines SET packed_qty = packed_qty + p.quantity WHERE id = p.task_line_id; END IF;
    INSERT INTO public.wh_scan_events(site_id, task_id, package_id, lpn_id, event_type, scanned_code, operator_id, client_event_id)
    VALUES (t.site_id, t.id, p.id, v_id, CASE WHEN v_n = 0 THEN 'LPN_CONSOLIDATE' ELSE 'LPN_ADD' END, v_code, auth.uid(),
            CASE WHEN v_n = 0 THEN coalesce(p_client_event_id, gen_random_uuid()) ELSE gen_random_uuid() END);
    v_qty := v_qty + p.quantity; v_kg := v_kg + coalesce(p.weight_kg, 0); v_n := v_n + 1;
  END LOOP;
  UPDATE public.wh_lpns SET package_count = v_n, quantity = v_qty, weight_kg = v_kg WHERE id = v_id;
  PERFORM public.wh_invalidate_release(t.id, 'Nuevo LPN ' || v_lpn);
  RETURN jsonb_build_object('id', v_id, 'lpn_code', v_lpn, 'package_count', v_n, 'quantity', v_qty, 'weight_kg', v_kg, 'own_label', v_own);
END $$;
