-- Resolver las guías de todo el bloque una vez; evitar un recorrido de SALIDA por servicio.
BEGIN;
CREATE INDEX IF NOT EXISTS apt_movements_salida_documento_idx
  ON public.apt_movements(documento) WHERE active AND valid AND kind = 'SALIDA';

CREATE OR REPLACE FUNCTION public.get_service_registry_weight(p_services uuid[])
RETURNS TABLE(service_id uuid, guias text, kg numeric, encontradas int, faltan text, calculado_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET jit = off AS $$
  WITH contexto AS MATERIALIZED (
    SELECT c FROM jsonb_array_elements(public.get_service_registry_context(p_services)) c
  ), servicios AS MATERIALIZED (
    SELECT s.id, concat_ws(',', NULLIF(btrim(s.referral_guide), ''),
      (SELECT string_agg(g, ',') FROM jsonb_array_elements_text(c->'guide_numbers') g)) AS guias
    FROM contexto JOIN public.contract_services s ON s.id = (c->>'service_id')::uuid
  ), claves AS MATERIALIZED (
    SELECT DISTINCT s.id, public.apt_guia_key(g) AS clave
    FROM servicios s CROSS JOIN LATERAL regexp_split_to_table(s.guias, '[,;/\s]+') g
    WHERE btrim(g) <> ''
  ), coincidencias AS MATERIALIZED (
    -- Usar los índices de guía normalizada; cada clave compartida se consulta una sola vez.
    SELECT k.clave, mv.id, mv.peso_kg
    FROM (SELECT DISTINCT clave FROM claves WHERE clave LIKE '%-%') k
    CROSS JOIN LATERAL (
      SELECT mv.id, mv.peso_kg FROM public.apt_movements mv
      WHERE mv.active AND mv.valid AND mv.kind = 'SALIDA'
        AND public.apt_guia_key(mv.documento) = k.clave
      OFFSET 0 -- Mantener la búsqueda por índice parametrizada para cada guía distinta.
    ) mv
    UNION
    SELECT k.clave, mv.id, mv.peso_kg
    FROM (SELECT DISTINCT clave FROM claves WHERE clave NOT LIKE '%-%') k
    CROSS JOIN LATERAL (
      SELECT mv.id, mv.peso_kg FROM public.apt_movements mv
      WHERE mv.active AND mv.valid AND mv.kind = 'SALIDA'
        AND split_part(public.apt_guia_key(mv.documento), '-', 2) = k.clave
      OFFSET 0
    ) mv
  ), pesos AS (
    -- Una línea no se duplica aunque la guía se escriba con varios formatos.
    SELECT p.id, sum(p.peso_kg) AS kg FROM (
      SELECT DISTINCT k.id, m.id AS movement_id, m.peso_kg
      FROM claves k JOIN coincidencias m ON m.clave = k.clave
    ) p GROUP BY p.id
  ), estado AS (
    SELECT k.id, count(*) FILTER (WHERE e.clave IS NOT NULL)::int AS encontradas,
      string_agg(k.clave, ', ' ORDER BY k.clave) FILTER (WHERE e.clave IS NULL) AS faltan
    FROM claves k LEFT JOIN (SELECT DISTINCT clave FROM coincidencias) e USING (clave)
    GROUP BY k.id
  )
  SELECT s.id, s.guias, p.kg, e.encontradas, e.faltan, now()
  FROM servicios s JOIN estado e ON e.id = s.id LEFT JOIN pesos p ON p.id = s.id;
$$;
REVOKE ALL ON FUNCTION public.get_service_registry_weight(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_service_registry_weight(uuid[]) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
