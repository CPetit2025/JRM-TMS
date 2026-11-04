-- El recálculo histórico usa la misma búsqueda por índice que la consulta de servicios.
-- Evitar la segunda exploración global de SALIDA y la compilación JIT por servicio.
BEGIN;
CREATE OR REPLACE FUNCTION public.apt_guias_peso(p_guias text)
RETURNS TABLE(kg numeric, encontradas int, faltan text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET jit = off AS $$
  WITH claves AS MATERIALIZED (
    SELECT DISTINCT public.apt_guia_key(g) AS clave
    FROM regexp_split_to_table(COALESCE(p_guias,''), '[,;/\s]+') g WHERE btrim(g)<>''
  ), coincidencias AS MATERIALIZED (
    SELECT k.clave, mv.id, mv.peso_kg
    FROM claves k CROSS JOIN LATERAL (
      SELECT mv.id,mv.peso_kg FROM public.apt_movements mv
      WHERE mv.active AND mv.valid AND mv.kind='SALIDA'
        AND public.apt_guia_key(mv.documento)=k.clave
      OFFSET 0
    ) mv
    UNION
    SELECT k.clave, mv.id, mv.peso_kg
    FROM claves k CROSS JOIN LATERAL (
      SELECT mv.id,mv.peso_kg FROM public.apt_movements mv
      WHERE mv.active AND mv.valid AND mv.kind='SALIDA'
        AND split_part(public.apt_guia_key(mv.documento),'-',2)=k.clave
      OFFSET 0
    ) mv WHERE k.clave NOT LIKE '%-%'
  )
  SELECT (SELECT sum(peso_kg) FROM (SELECT DISTINCT id,peso_kg FROM coincidencias) p),
    (SELECT count(DISTINCT clave)::int FROM coincidencias),
    (SELECT string_agg(k.clave,', ' ORDER BY k.clave) FROM claves k
      WHERE NOT EXISTS(SELECT 1 FROM coincidencias m WHERE m.clave=k.clave));
$$;
REVOKE ALL ON FUNCTION public.apt_guias_peso(text) FROM PUBLIC, anon, authenticated;
-- Mantener también coincidencias exactas de números sin serie y documentos sin guion.
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
    FROM (SELECT DISTINCT clave FROM claves) k
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
NOTIFY pgrst, 'reload schema';
COMMIT;
