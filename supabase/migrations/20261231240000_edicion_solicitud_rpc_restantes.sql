-- La regla «solo el creador, sin asignar ni atender» (can_edit_transport_request) también en las demás RPC expuestas
-- que editan o cancelan solicitudes. Se envuelven las versiones instaladas sin cambiar su firma.
BEGIN;

DO $mig$
BEGIN
  IF to_regprocedure('public.save_transport_request_before_owner_guard(uuid,jsonb,jsonb)') IS NULL THEN
    ALTER FUNCTION public.save_transport_request(uuid, jsonb, jsonb) RENAME TO save_transport_request_before_owner_guard;
  END IF;
  IF to_regprocedure('public.save_transport_request_attention_before_owner_guard(uuid,jsonb,jsonb,jsonb)') IS NULL THEN
    ALTER FUNCTION public.save_transport_request_attention(uuid, jsonb, jsonb, jsonb) RENAME TO save_transport_request_attention_before_owner_guard;
  END IF;
  IF to_regprocedure('public.set_transport_request_status_at_before_owner_guard(uuid,text,date,timestamptz,text)') IS NULL THEN
    ALTER FUNCTION public.set_transport_request_status_at(uuid, text, date, timestamptz, text) RENAME TO set_transport_request_status_at_before_owner_guard;
  END IF;
END $mig$;
REVOKE ALL ON FUNCTION public.save_transport_request_before_owner_guard(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_transport_request_before_owner_guard(uuid, jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.save_transport_request_attention_before_owner_guard(uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_transport_request_attention_before_owner_guard(uuid, jsonb, jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.set_transport_request_status_at_before_owner_guard(uuid, text, date, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_transport_request_status_at_before_owner_guard(uuid, text, date, timestamptz, text) TO service_role;

CREATE OR REPLACE FUNCTION public.save_transport_request(p_request_id uuid, p_payload jsonb, p_components jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_request_id IS NOT NULL AND NOT public.can_edit_transport_request(p_request_id) THEN
    RAISE EXCEPTION 'Solo puede editar sus propias solicitudes que aún no estén asignadas ni atendidas' USING ERRCODE = '42501';
  END IF;
  RETURN public.save_transport_request_before_owner_guard(p_request_id, p_payload, p_components);
END $$;
REVOKE ALL ON FUNCTION public.save_transport_request(uuid, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_transport_request(uuid, jsonb, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.save_transport_request_attention(p_request_id uuid, p_payload jsonb, p_components jsonb, p_unloading jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_request_id IS NOT NULL AND NOT public.can_edit_transport_request(p_request_id) THEN
    RAISE EXCEPTION 'Solo puede editar sus propias solicitudes que aún no estén asignadas ni atendidas' USING ERRCODE = '42501';
  END IF;
  RETURN public.save_transport_request_attention_before_owner_guard(p_request_id, p_payload, p_components, p_unloading);
END $$;
REVOKE ALL ON FUNCTION public.save_transport_request_attention(uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_transport_request_attention(uuid, jsonb, jsonb, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_transport_request_status_at(p_request_id uuid, p_new_status text, p_required_date date DEFAULT NULL,
  p_required_at timestamptz DEFAULT NULL, p_delivery_zone text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_new_status = 'CANCELADA' AND NOT public.can_edit_transport_request(p_request_id) THEN
    RAISE EXCEPTION 'Solo puede cancelar sus propias solicitudes que aún no estén asignadas ni atendidas' USING ERRCODE = '42501';
  END IF;
  PERFORM public.set_transport_request_status_at_before_owner_guard(p_request_id, p_new_status, p_required_date, p_required_at, p_delivery_zone);
END $$;
REVOKE ALL ON FUNCTION public.set_transport_request_status_at(uuid, text, date, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_transport_request_status_at(uuid, text, date, timestamptz, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
