CREATE OR REPLACE FUNCTION public.can_prepare_ai_maintenance()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.is_tms_admin() OR EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
    WHERE p.id = auth.uid() AND p.is_active = true
      AND r.permissions ? 'ia:action:mantenimiento'
      AND (r.permissions ? 'mantenimiento-ot' OR r.permissions ? 'mantenimiento-ot:write')
  );
$$;
REVOKE ALL ON FUNCTION public.can_prepare_ai_maintenance() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_prepare_ai_maintenance() TO authenticated;

CREATE OR REPLACE FUNCTION public.ai_prepare_maintenance(
  p_vehicle_plate text, p_type text, p_reason text, p_scheduled_date date
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_site uuid; v_proposal public.ai_action_proposals;
BEGIN
  IF NOT public.can_prepare_ai_maintenance() THEN RAISE EXCEPTION 'Sin permiso para proponer mantenimiento'; END IF;
  IF p_type NOT IN ('CORRECTIVO', 'PREVENTIVO') OR length(trim(p_reason)) NOT BETWEEN 5 AND 500 OR
    p_scheduled_date < current_date OR p_scheduled_date > current_date + 180 THEN
    RAISE EXCEPTION 'Datos de mantenimiento inválidos';
  END IF;
  SELECT site_id INTO v_site FROM public.vehicles WHERE plate = upper(trim(p_vehicle_plate));
  IF v_site IS NULL OR NOT public.can_access_site(v_site) THEN RAISE EXCEPTION 'Unidad fuera del alcance autorizado'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(auth.uid()::text || ':maintenance_proposal'));
  IF (SELECT count(*) FROM public.ai_action_proposals
      WHERE user_id = auth.uid() AND created_at > now() - interval '1 hour') >= 20 THEN
    RAISE EXCEPTION 'Límite de propuestas alcanzado';
  END IF;
  INSERT INTO public.ai_action_proposals(user_id, action_type, payload)
  VALUES (auth.uid(), 'schedule_maintenance', jsonb_build_object(
    'vehicle_plate', upper(trim(p_vehicle_plate)), 'type', p_type,
    'reason', trim(p_reason), 'scheduled_date', p_scheduled_date, 'site_id', v_site
  )) RETURNING * INTO v_proposal;
  RETURN jsonb_build_object('id', v_proposal.id, 'payload', v_proposal.payload,
    'expires_at', v_proposal.expires_at, 'confirmation_required', true);
END $$;
REVOKE ALL ON FUNCTION public.ai_prepare_maintenance(text,text,text,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_prepare_maintenance(text,text,text,date) TO authenticated;

CREATE OR REPLACE FUNCTION public.ai_confirm_maintenance(p_proposal_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_proposal public.ai_action_proposals; v_order_id uuid; v_site uuid; v_vehicle_id uuid;
BEGIN
  SELECT * INTO v_proposal FROM public.ai_action_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF v_proposal.id IS NULL OR v_proposal.user_id <> auth.uid() THEN RAISE EXCEPTION 'Propuesta no encontrada'; END IF;
  IF v_proposal.status = 'confirmed' THEN RETURN v_proposal.result_ref; END IF;
  IF v_proposal.status <> 'proposed' OR v_proposal.expires_at <= now() OR
    v_proposal.action_type <> 'schedule_maintenance' THEN RAISE EXCEPTION 'Propuesta vencida o cancelada'; END IF;
  IF NOT public.can_prepare_ai_maintenance() THEN RAISE EXCEPTION 'Permiso revocado'; END IF;
  SELECT id, site_id INTO v_vehicle_id, v_site FROM public.vehicles
    WHERE plate = v_proposal.payload->>'vehicle_plate' FOR UPDATE;
  IF v_site IS NULL OR v_site <> (v_proposal.payload->>'site_id')::uuid OR
    NOT public.can_access_site(v_site) THEN RAISE EXCEPTION 'Unidad fuera del alcance autorizado'; END IF;
  IF (v_proposal.payload->>'scheduled_date')::date < current_date THEN
    RAISE EXCEPTION 'La fecha propuesta ya pasó';
  END IF;
  INSERT INTO public.maintenance_work_orders(
    ot_code, vehicle_id, source_type, priority, description, status, start_date, site_id
  ) VALUES (
    'MOT-AI-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
    v_vehicle_id,
    CASE WHEN v_proposal.payload->>'type' = 'PREVENTIVO' THEN 'PREVENTIVO' ELSE 'MANUAL' END,
    'NORMAL', v_proposal.payload->>'reason', 'PENDIENTE',
    (v_proposal.payload->>'scheduled_date')::date, v_site
  ) RETURNING id INTO v_order_id;
  UPDATE public.ai_action_proposals SET status = 'confirmed', confirmed_by = auth.uid(),
    confirmed_at = now(), result_ref = jsonb_build_object('maintenance_order_id', v_order_id)
    WHERE id = v_proposal.id;
  RETURN jsonb_build_object('maintenance_order_id', v_order_id);
END $$;
REVOKE ALL ON FUNCTION public.ai_confirm_maintenance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_confirm_maintenance(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.ai_cancel_action_proposal(p_proposal_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.ai_action_proposals SET status = 'cancelled'
  WHERE id = p_proposal_id AND user_id = auth.uid() AND status = 'proposed';
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.ai_cancel_action_proposal(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_cancel_action_proposal(uuid) TO authenticated;
