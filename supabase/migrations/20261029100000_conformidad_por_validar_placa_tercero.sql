-- 1. Guías por validar: lista para el Supervisor de Transporte (y JRM IA) de las guías y conformidades RECIBIDAS, con
--    búsqueda por OC/OS/RQ, solicitud, despacho, placa, guía, OT o quien envió, y el enlace que abre la revisión en
--    Torre de Control. Incluye servicios sin OT (punto a punto o recojo con OC/OS/RQ).
-- 2. Placas de terceros: una unidad puede registrarse como tracto/semirremolque («ALZ721/AFM975»), igual que la flota
--    propia; cada placa con 5 a 10 letras o números.
BEGIN;

CREATE OR REPLACE FUNCTION public.delivery_pending_reviews(p_q text DEFAULT NULL, p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tokens text[] := ARRAY(SELECT t FROM unnest(regexp_split_to_array(upper(btrim(COALESCE(p_q, ''))), '\s+')) t WHERE t <> '');
  v_lim integer := least(greatest(COALESCE(p_limit, 50), 1), 200); v_out jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Sin sesión'); END IF;
  WITH r AS (
    SELECT d.id AS dispatch_id, t.id AS request_id, d.dispatch_number, t.request_number, t.request_type,
      NULLIF(concat_ws(' ', t.reference_type, t.reference_number), '') AS referencia, ct.code::text AS ot,
      d.vehicle_plate AS placa, COALESCE(NULLIF(d.driver_name, ''), to_jsonb(d)->>'tercero_conductor') AS conductor,
      to_jsonb(d)->>'modalidad' AS modalidad, s.source, s.guide_number, COALESCE(cardinality(s.photos), 0) AS fotos, s.submitted_at,
      COALESCE((SELECT NULLIF(trim(concat_ws(' ', p.first_name, p.last_name)), '') FROM public.profiles p WHERE p.id = s.submitted_by),
        CASE WHEN s.submitted_by IS NULL THEN 'Portal del transportista' END) AS enviado_por,
      public.delivery_can_review(d.id) AS puede_validar
    FROM public.delivery_conformities c
    JOIN public.delivery_submissions s ON s.id = c.current_submission_id
    JOIN public.dispatches d ON d.id = c.dispatch_id
    JOIN public.transport_requests t ON t.id = c.request_id
    LEFT JOIN public.contracts ct ON ct.id = t.contract_id
    WHERE c.state = 'RECIBIDA' AND COALESCE(d.status, '') NOT IN ('LIQUIDADO', 'CERRADO', 'CANCELADO')
      AND (public.delivery_can_review(d.id) OR public.delivery_can_read(d.id))),
  f AS (
    SELECT r.* FROM r
    WHERE NOT EXISTS (SELECT 1 FROM unnest(v_tokens) k WHERE position(k IN upper(regexp_replace(concat_ws('|', r.dispatch_number, r.request_number,
      r.referencia, r.ot, r.placa, r.conductor, r.guide_number, r.enviado_por), '\s', '', 'g'))) = 0))
  SELECT jsonb_build_object('success', true, 'total', (SELECT count(*) FROM f),
    -- Valida quien tiene «Validar conformidad de entregas» (o el rol Supervisor de Transporte), como delivery_review
    'puede_validar', EXISTS (SELECT 1 FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id WHERE p.id = auth.uid() AND p.is_active
        AND COALESCE(ro.permissions, '[]'::jsonb) ? 'entregas-validacion')
      OR EXISTS (SELECT 1 FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id WHERE p.id = auth.uid() AND ro.name = 'Supervisor de Transporte'),
    'filas', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.submitted_at) FROM (
      SELECT f.*, '/torre-control?despacho=' || f.dispatch_id || '&revisar=' || f.request_id AS url FROM f ORDER BY f.submitted_at LIMIT v_lim) x), '[]'::jsonb))
  INTO v_out;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.delivery_pending_reviews(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delivery_pending_reviews(text, integer) TO authenticated;

ALTER TABLE public.supplier_vehicles DROP CONSTRAINT IF EXISTS supplier_vehicles_plate_format;
ALTER TABLE public.supplier_vehicles ADD CONSTRAINT supplier_vehicles_plate_format CHECK (
  length(regexp_replace(upper(split_part(plate, '/', 1)), '[^A-Z0-9]', '', 'g')) BETWEEN 5 AND 10
  AND (position('/' IN plate) = 0 OR length(regexp_replace(upper(split_part(plate, '/', 2)), '[^A-Z0-9]', '', 'g')) BETWEEN 5 AND 10)
  AND split_part(plate, '/', 3) = '');

COMMIT;
