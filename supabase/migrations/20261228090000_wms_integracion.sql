-- Integración TMS -> WMS (picking, auditoría y Packing List). Solo agrega objetos: no cambia tablas ni lógica del TMS.
-- El WMS (otra base) llama estas funciones con la clave pública del TMS más una clave de integración propia;
-- aquí solo se guarda el hash SHA-256 de esa clave (la clave vive en el proyecto Vercel del WMS).

CREATE TABLE IF NOT EXISTS public.integration_keys (
  name text PRIMARY KEY,
  key_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.integration_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integration_keys FROM PUBLIC, anon, authenticated;
INSERT INTO public.integration_keys(name, key_hash)
VALUES ('wms', 'cca55655cc2316bc271ca1b5f587e93ec8a440635a9188811c18319b1a01c227')
ON CONFLICT (name) DO NOTHING;

CREATE OR REPLACE FUNCTION public.integration_key_ok(p_name text, p_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT length(coalesce(p_key, '')) >= 32 AND EXISTS (
    SELECT 1 FROM public.integration_keys
    WHERE name = p_name AND key_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex'))
$$;
REVOKE ALL ON FUNCTION public.integration_key_ok(text, text) FROM PUBLIC, anon, authenticated;

-- Solicitudes de despacho con OT que el almacén puede preparar, más el estado actual de las que el WMS ya conoce
-- (así le llegan las cancelaciones y entregas). Columnas opcionales vía to_jsonb: producción difiere del repo.
CREATE OR REPLACE FUNCTION public.wms_feed_solicitudes(p_key text, p_known_ids uuid[] DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.integration_key_ok('wms', p_key) THEN
    RAISE EXCEPTION 'Clave de integración inválida' USING ERRCODE = '42501';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', r.id, 'request_number', r.request_number,
      'request_type', upper(coalesce(r.request_type, 'DESPACHO')),
      'attention_mode', j->>'attention_mode', 'status', r.status,
      'required_date', r.required_date, 'required_at', j->>'required_at', 'created_at', r.created_at,
      'requester_name', r.requester_name, 'pickup_address', r.pickup_address, 'delivery_address', r.delivery_address,
      'reference_number', j->>'reference_number', 'purchase_order', j->>'purchase_order',
      'site_code', (SELECT s.code FROM public.sites s WHERE s.id = r.site_id),
      'client', (SELECT jsonb_build_object('id', cl.id, 'business_name', cl.business_name, 'ruc', cl.ruc,
                   'commercial_name', cl.commercial_name)
                 FROM public.clients cl WHERE cl.id = coalesce((j->>'client_id')::uuid, c.client_id)),
      'contract', jsonb_build_object('id', c.id, 'code', c.code, 'type', c.type::text, 'client_id', c.client_id),
      'components', coalesce((
        SELECT jsonb_agg(jsonb_build_object('id', rc.id, 'requested_weight_kg', rc.requested_weight_kg,
                 'requested_volume_m3', rc.requested_volume_m3,
                 'contract', jsonb_build_object('id', cc.id, 'code', cc.code, 'type', cc.type::text, 'client_id', cc.client_id)))
        FROM public.transport_request_components rc JOIN public.contracts cc ON cc.id = rc.component_contract_id
        WHERE rc.request_id = r.id), '[]'::jsonb)
    ) ORDER BY r.created_at)
    FROM public.transport_requests r
    CROSS JOIN LATERAL to_jsonb(r) j
    JOIN public.contracts c ON c.id = r.contract_id
    WHERE r.id = ANY(coalesce(p_known_ids, '{}'))
       OR (upper(coalesce(r.request_type, 'DESPACHO')) = 'DESPACHO'
           AND upper(r.status) IN ('PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'PENDIENTE DE APROBACION', 'APROBADA',
                                   'APROBADO', 'ASIGNADA', 'REPROGRAMADA', 'OBSERVADA'))
  ), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.wms_feed_solicitudes(text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_feed_solicitudes(text, uuid[]) TO anon, authenticated;

-- Packing List liberado (o reemplazado) en el WMS, para que despacho lo vea en el TMS.
CREATE TABLE IF NOT EXISTS public.wms_packing_releases (
  wms_packing_list_id uuid PRIMARY KEY,
  transport_request_id uuid NOT NULL REFERENCES public.transport_requests(id),
  packing_list_number text NOT NULL,
  version integer NOT NULL,
  status text NOT NULL CHECK (status IN ('LIBERADO', 'REEMPLAZADO')),
  lpn_count integer NOT NULL DEFAULT 0,
  package_count integer NOT NULL DEFAULT 0,
  total_weight_kg numeric,
  picker_name text,
  auditor_name text,
  released_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  reported_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wms_packing_releases_request_idx ON public.wms_packing_releases(transport_request_id, released_at DESC);
ALTER TABLE public.wms_packing_releases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wms_packing_releases FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.wms_packing_releases TO authenticated;
DROP POLICY IF EXISTS wms_packing_releases_read ON public.wms_packing_releases;
CREATE POLICY wms_packing_releases_read ON public.wms_packing_releases FOR SELECT TO authenticated
  USING (public.has_tms_read_permission('solicitudes') OR public.has_tms_read_permission('despacho'));

CREATE OR REPLACE FUNCTION public.wms_report_packing_list(p_key text, p_row jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid := (p_row->>'id')::uuid; v_request uuid := (p_row->>'transport_request_id')::uuid;
BEGIN
  IF NOT public.integration_key_ok('wms', p_key) THEN
    RAISE EXCEPTION 'Clave de integración inválida' USING ERRCODE = '42501';
  END IF;
  IF v_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.transport_requests WHERE id = v_request) THEN
    RAISE EXCEPTION 'Packing List sin solicitud TMS válida';
  END IF;
  INSERT INTO public.wms_packing_releases(wms_packing_list_id, transport_request_id, packing_list_number, version, status,
    lpn_count, package_count, total_weight_kg, picker_name, auditor_name, released_at, payload, reported_at)
  VALUES (v_id, v_request, p_row->>'packing_list_number', (p_row->>'version')::integer, p_row->>'status',
    coalesce((p_row->>'lpn_count')::integer, 0), coalesce((p_row->>'package_count')::integer, 0),
    (p_row->>'total_weight_kg')::numeric, p_row->>'picker_name', p_row->>'auditor_name',
    (p_row->>'released_at')::timestamptz, coalesce(p_row->'payload', '{}'::jsonb), now())
  ON CONFLICT (wms_packing_list_id) DO UPDATE SET status = EXCLUDED.status, payload = EXCLUDED.payload, reported_at = now();
  RETURN jsonb_build_object('success', true, 'id', v_id);
END $$;
REVOKE ALL ON FUNCTION public.wms_report_packing_list(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_report_packing_list(text, jsonb) TO anon, authenticated;
