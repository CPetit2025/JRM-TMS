-- Solo lecturas y claims de sesión. No publicar OT, clientes ni identidades.
BEGIN;
SET LOCAL statement_timeout = '15s';
CREATE FUNCTION pg_temp.measure_request_ot_catalog(p_user uuid, p_role text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE started timestamptz; result jsonb; elapsed numeric;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub',p_user,'role','authenticated')::text, true);
  started := clock_timestamp();
  result := public.get_transport_request_ot_catalog();
  elapsed := round((extract(epoch FROM clock_timestamp() - started)*1000)::numeric, 1);
  IF result->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Catálogo de OT no disponible'; END IF;
  IF elapsed > 5000 THEN RAISE EXCEPTION 'Catálogo de OT demasiado lento: % ms', elapsed; END IF;
  RETURN jsonb_build_object('role',p_role,'elapsed_ms',elapsed,
    'rows',jsonb_array_length(result->'rows'),'bytes',octet_length(result::text),'success',true);
END $$;
WITH actors AS MATERIALIZED (
  SELECT DISTINCT ON (r.name) p.id, r.name FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
  WHERE p.is_active AND r.name IN ('Administrador','Administrador de Contratos','Solicitante de Transporte')
    AND EXISTS(SELECT 1 FROM auth.users u WHERE u.id = p.id)
  ORDER BY r.name, p.id
)
SELECT 'OT_CATALOG_PERFORMANCE' AS section, pg_temp.measure_request_ot_catalog(id,name) AS finding FROM actors;
ROLLBACK;
