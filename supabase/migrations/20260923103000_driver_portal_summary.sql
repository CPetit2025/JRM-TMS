BEGIN;

CREATE OR REPLACE FUNCTION public.get_driver_portal_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile public.profiles%ROWTYPE;
  v_driver public.drivers%ROWTYPE;
  v_upcoming jsonb := '[]'::jsonb;
  v_recent jsonb := '[]'::jsonb;
  v_alerts jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_profile FROM public.profiles
    WHERE id = auth.uid() AND is_active = true;
  IF v_profile.id IS NULL THEN RAISE EXCEPTION 'Sesión operativa no autorizada'; END IF;

  SELECT * INTO v_driver FROM public.drivers
    WHERE profile_id = auth.uid() AND is_active = true LIMIT 1;
  IF v_driver.id IS NULL THEN
    RETURN jsonb_build_object('upcoming', v_upcoming, 'recent', v_recent,
      'alerts', jsonb_build_array(jsonb_build_object('level','error','code','DRIVER_LINK',
        'message','El perfil no está vinculado a un conductor activo.')),
      'stats', jsonb_build_object('completed_30d',0,'open_failures',0,'pending_expenses',0),
      'as_of', now());
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(item) ORDER BY item.scheduled_departure), '[]'::jsonb)
  INTO v_upcoming FROM (
    SELECT d.id, d.dispatch_number, d.vehicle_plate, d.status, d.scheduled_departure,
      c.code AS contract_code, c.destination_address,
      (SELECT tr.pickup_address FROM public.dispatch_requests dr
       JOIN public.transport_requests tr ON tr.id = dr.transport_request_id
       WHERE dr.dispatch_id = d.id ORDER BY dr.sequence_order NULLS LAST LIMIT 1) AS origin,
      (SELECT tr.delivery_address FROM public.dispatch_requests dr
       JOIN public.transport_requests tr ON tr.id = dr.transport_request_id
       WHERE dr.dispatch_id = d.id ORDER BY dr.sequence_order NULLS LAST LIMIT 1) AS destination
    FROM public.dispatches d LEFT JOIN public.contracts c ON c.id = d.contract_id
    WHERE d.driver_id = v_driver.id AND d.status = 'PROGRAMADO'
    ORDER BY d.scheduled_departure NULLS LAST, d.created_at DESC LIMIT 5
  ) item;

  SELECT coalesce(jsonb_agg(to_jsonb(item) ORDER BY item.created_at DESC), '[]'::jsonb)
  INTO v_recent FROM (
    SELECT d.id, d.dispatch_number, d.vehicle_plate, d.status, d.scheduled_departure,
      d.created_at, d.actual_distance_km, c.code AS contract_code, c.destination_address
    FROM public.dispatches d LEFT JOIN public.contracts c ON c.id = d.contract_id
    WHERE d.driver_id = v_driver.id
      AND d.status IN ('FINALIZADO','CERRADO','ENTREGADO','RETORNO_COMPLETADO','CANCELADO')
    ORDER BY d.created_at DESC LIMIT 5
  ) item;

  IF v_driver.license_number IS NULL OR trim(v_driver.license_number) = '' THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('level','warning',
      'code','LICENSE_MISSING','message','Licencia de conducir pendiente de registrar.'));
  ELSIF v_driver.license_expiration IS NOT NULL AND v_driver.license_expiration < current_date THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('level','error',
      'code','LICENSE_EXPIRED','message','La licencia de conducir está vencida.'));
  ELSIF v_driver.license_expiration IS NOT NULL AND v_driver.license_expiration <= current_date + 30 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('level','warning',
      'code','LICENSE_EXPIRING','message','La licencia vence en ' ||
      greatest(v_driver.license_expiration - current_date, 0) || ' día(s).'));
  END IF;
  IF coalesce(nullif(trim(v_driver.phone),''), nullif(trim(v_profile.phone),'')) IS NULL THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('level','info',
      'code','PHONE_MISSING','message','Número de celular pendiente de completar.'));
  END IF;
  IF jsonb_array_length(v_alerts) = 0 THEN
    v_alerts := jsonb_build_array(jsonb_build_object('level','success',
      'code','READY','message','Perfil operativo al día.'));
  END IF;

  RETURN jsonb_build_object(
    'upcoming', v_upcoming, 'recent', v_recent, 'alerts', v_alerts,
    'stats', jsonb_build_object(
      'completed_30d', (SELECT count(*) FROM public.dispatches WHERE driver_id = v_driver.id
        AND status IN ('FINALIZADO','CERRADO','ENTREGADO','RETORNO_COMPLETADO')
        AND created_at >= now() - interval '30 days'),
      'open_failures', (SELECT count(*) FROM public.vehicle_maintenance_records
        WHERE driver_id = v_driver.id AND status IN ('PENDIENTE','EN_REVISION','EN_MANTENIMIENTO')),
      'pending_expenses', (SELECT count(*) FROM public.dispatch_expenses
        WHERE driver_id = v_driver.id AND status = 'PENDIENTE')),
    'as_of', now());
END $$;

REVOKE ALL ON FUNCTION public.get_driver_portal_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_driver_portal_summary() TO authenticated;

COMMIT;
