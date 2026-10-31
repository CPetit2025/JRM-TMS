-- Auditoría F08 · Un cargo manual en Registro de Servicios no duplica en silencio una prestación ya registrada.
-- register_contract_service_checked revisa, antes de registrar, si la misma partida ya tiene un cargo vigente del mismo
-- tipo en ±3 días que venga de una ruta, tenga el mismo importe o el mismo proveedor. Si lo hay, no registra y devuelve
-- los posibles duplicados; para registrarlo igual se exige un motivo (mínimo 10 caracteres), que queda en la descripción.
-- register_contract_service no cambia (lo usan las pruebas de Caja y otras rutas internas); la pantalla, la carga Excel y
-- el asistente pasan a la versión con control.
BEGIN;

CREATE OR REPLACE FUNCTION public.register_contract_service_checked(
  p_contract_id uuid, p_service_type varchar, p_description text,
  p_amount_pen numeric, p_service_date date, p_plate varchar DEFAULT NULL,
  p_driver_name varchar DEFAULT NULL, p_hours numeric DEFAULT NULL,
  p_provider_ruc varchar DEFAULT NULL, p_provider_name varchar DEFAULT NULL,
  p_category varchar DEFAULT 'Contrato', p_referral_guide text DEFAULT NULL,
  p_duplicate_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_owner uuid; v_date date := COALESCE(p_service_date, current_date); v_matches jsonb;
 v_reason text := NULLIF(btrim(COALESCE(p_duplicate_reason, '')), ''); v_desc text := p_description;
BEGIN
  IF NOT (public.has_tms_permission('clientes') OR public.has_tms_permission('contratos-servicios')) THEN
    RAISE EXCEPTION 'Sin permiso para registrar servicios de contrato';
  END IF;
  IF p_contract_id IS NULL OR p_service_type IS NULL OR p_amount_pen IS NULL OR p_amount_pen < 0 THEN
    RAISE EXCEPTION 'Datos de servicio inválidos';
  END IF;
  v_owner := COALESCE(public.contract_budget_owner(p_contract_id), p_contract_id);
  SELECT jsonb_agg(jsonb_build_object(
      'id', cs.id, 'service_date', cs.service_date, 'amount_pen', cs.amount_pen, 'description', cs.description,
      'provider', COALESCE(to_jsonb(cs)->>'provider_name', ''),
      'origin', CASE WHEN cs.dispatch_id IS NOT NULL THEN 'Ruta ' || COALESCE((SELECT d.dispatch_number::text FROM public.dispatches d WHERE d.id = cs.dispatch_id), '') ELSE 'Manual' END)
    ORDER BY cs.service_date DESC)
  INTO v_matches
  FROM public.contract_services cs
  WHERE COALESCE(cs.status, '') <> 'ANULADO' AND cs.service_type = p_service_type
    AND (cs.contract_id = p_contract_id OR COALESCE(to_jsonb(cs)->>'budget_contract_id', cs.contract_id::text) = v_owner::text)
    AND cs.service_date BETWEEN v_date - 3 AND v_date + 3
    AND (cs.dispatch_id IS NOT NULL OR round(cs.amount_pen, 2) = round(p_amount_pen, 2)
      OR (NULLIF(btrim(COALESCE(p_provider_ruc, '')), '') IS NOT NULL AND to_jsonb(cs)->>'provider_ruc' = btrim(p_provider_ruc)));
  IF v_matches IS NOT NULL THEN
    IF v_reason IS NULL OR length(v_reason) < 10 THEN
      RETURN jsonb_build_object('success', false, 'duplicate', true, 'matches', v_matches,
        'error', 'Posible cargo duplicado: la partida ya tiene ' || jsonb_array_length(v_matches) || ' cargo(s) de ' || lower(p_service_type)
          || ' en ±3 días. Revise y, si es otra prestación, indique el motivo (mínimo 10 caracteres).');
    END IF;
    IF length(v_reason) > 300 THEN RAISE EXCEPTION 'Motivo demasiado extenso'; END IF;
    v_desc := btrim(COALESCE(p_description, '') || ' · Confirmado no duplicado: ' || v_reason, ' ·');
  END IF;
  PERFORM public.register_contract_service(p_contract_id, p_service_type, v_desc, p_amount_pen, p_service_date, p_plate, p_driver_name,
    p_hours, p_provider_ruc, p_provider_name, p_category, p_referral_guide);
  RETURN jsonb_build_object('success', true, 'duplicate_confirmed', v_matches IS NOT NULL);
EXCEPTION WHEN raise_exception THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.register_contract_service_checked(uuid,varchar,text,numeric,date,varchar,varchar,numeric,varchar,varchar,varchar,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_contract_service_checked(uuid,varchar,text,numeric,date,varchar,varchar,numeric,varchar,varchar,varchar,text,text) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
