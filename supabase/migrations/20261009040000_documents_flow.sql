-- A bounded historical query preserves the installed authorization and document projection.
-- Keep the original seven-day RPC for existing integrations.
BEGIN;
DO $migration$
DECLARE source text; definition text;
BEGIN
  source := pg_get_functiondef('public.get_documentary_queue(boolean)'::regprocedure);
  IF position('can_access_site' IN source) = 0
     OR position('packing-list' IN source) = 0
     OR position('x.voided_at IS NULL' IN source) = 0
     OR position('p_include_departed' IN source) = 0 THEN
    RAISE EXCEPTION 'Bandeja documentaria incompatible: revisar permisos y proyección antes de migrar';
  END IF;
  -- Tighten the existing RPC too, preserving its signature and seven-day behavior.
  source := replace(source, '(d.site_id IS NULL OR public.can_access_site(d.site_id))', 'public.can_access_site(d.site_id)');
  EXECUTE source;
  definition := regexp_replace(source,
    'FUNCTION public.get_documentary_queue\(p_include_departed boolean DEFAULT false\)',
    'FUNCTION public.get_documentary_queue_period(p_include_departed boolean, p_from timestamp with time zone, p_until timestamp with time zone)');
  IF definition = source THEN RAISE EXCEPTION 'Firma de bandeja documentaria incompatible'; END IF;
  definition := regexp_replace(definition,
    'AND \(d.status = ''PROGRAMADO'' OR \(p_include_departed AND d.docs_required\s+AND d.status NOT IN \(''CANCELADO''\) AND COALESCE\(d.scheduled_departure, now\(\)\) > now\(\) - interval ''7 days''\)\)',
    'AND ((NOT p_include_departed AND d.status = ''PROGRAMADO'') OR (p_include_departed AND d.scheduled_departure >= p_from AND d.scheduled_departure <= p_until))');
  IF position('interval ''7 days''' IN definition) > 0 OR position('d.scheduled_departure >= p_from' IN definition) = 0 THEN
    RAISE EXCEPTION 'Filtro temporal de bandeja documentaria incompatible';
  END IF;
  -- Null-site operations require the same explicit authorization as scoped operations.
  definition := replace(definition, '(d.site_id IS NULL OR public.can_access_site(d.site_id))', 'public.can_access_site(d.site_id)');
  definition := regexp_replace(definition, 'BEGIN', $guard$BEGIN
  IF p_include_departed AND (p_from IS NULL OR p_until IS NULL OR p_until < p_from OR p_until - p_from > interval '366 days') THEN
    RAISE EXCEPTION 'Selecciona un período válido de hasta 366 días';
  END IF;$guard$);
  EXECUTE definition;
END $migration$;
REVOKE ALL ON FUNCTION public.get_documentary_queue_period(boolean,timestamptz,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_documentary_queue_period(boolean,timestamptz,timestamptz) TO authenticated,service_role;
COMMENT ON FUNCTION public.get_documentary_queue_period(boolean,timestamptz,timestamptz) IS 'Bandeja por servicio y OT, autorización y sedes heredadas; historial acotado a 366 días.';
COMMIT;
NOTIFY pgrst,'reload schema';
