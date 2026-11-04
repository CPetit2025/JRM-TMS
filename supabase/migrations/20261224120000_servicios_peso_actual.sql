-- Consultar el peso actual de las mismas guías visibles en el registro.
-- No depende del caché ni atribuye todas las guías de una ruta a cada OT.
BEGIN;
CREATE OR REPLACE FUNCTION public.get_service_registry_weight(p_services uuid[])
RETURNS TABLE(service_id uuid, guias text, kg numeric, encontradas int, faltan text, calculado_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH contexto AS (
    -- Reutiliza los permisos, límites y alcance por solicitud/OT del registro.
    SELECT c FROM jsonb_array_elements(public.get_service_registry_context(p_services)) c
  ), guias_servicio AS (
    SELECT s.id, concat_ws(',', NULLIF(btrim(s.referral_guide), ''),
      (SELECT string_agg(g, ',') FROM jsonb_array_elements_text(c->'guide_numbers') g)) AS guias
    FROM contexto JOIN public.contract_services s ON s.id = (c->>'service_id')::uuid
  )
  SELECT s.id, s.guias, p.kg, p.encontradas, p.faltan, now()
  FROM guias_servicio s CROSS JOIN LATERAL public.apt_guias_peso(s.guias) p
  WHERE NULLIF(btrim(s.guias, ', '), '') IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.get_service_registry_weight(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_service_registry_weight(uuid[]) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
