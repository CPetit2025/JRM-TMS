-- Alcance por sede y metadatos de cierre/odómetro por ruta para el panel de seguimiento.
BEGIN;

CREATE OR REPLACE FUNCTION public.unit_report_plates() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.can_view_unit_report() THEN RETURN '[]'::jsonb; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('plate', v.plate, 'type', v.type, 'status', v.status, 'site_id', v.site_id) ORDER BY v.plate)
    FROM public.vehicles v WHERE v.plate IS NOT NULL AND v.plate <> 'EXTERNO' AND public.can_access_site(v.site_id)), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.unit_report_plates() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unit_report_plates() TO authenticated;

DO $patch$
DECLARE sig regprocedure := 'public.unit_daily_report(text,date,date)'::regprocedure; def text;
  old_route text := 'NULLIF((to_jsonb(d)->>''actual_distance_km'')::numeric, 0) AS km_real, to_jsonb(d)->>''actual_distance_source'' AS km_real_source,';
  new_route text := 'NULLIF((to_jsonb(d)->>''actual_distance_km'')::numeric, 0) AS km_real, to_jsonb(d)->>''actual_distance_source'' AS km_real_source, NULLIF((to_jsonb(d)->>''start_odometer'')::numeric, 0) AS odo_start, NULLIF((to_jsonb(d)->>''end_odometer'')::numeric, 0) AS odo_end, COALESCE(NULLIF(to_jsonb(d)->>''operational_closed_at'','''')::timestamptz, NULLIF(to_jsonb(d)->>''returned_at'','''')::timestamptz, NULLIF(to_jsonb(d)->>''arrival_time'','''')::timestamptz) AS closed_at, NULLIF(to_jsonb(d)->''liquidation_data''->>''odometer_photo'','''') AS odo_end_photo,';
  old_json text := '''km_real'', disp.km_real, ''km_real_source'', disp.km_real_source, ''km_est'', disp.km_est,';
  new_json text := '''km_real'', disp.km_real, ''km_real_source'', disp.km_real_source, ''odo_start'', disp.odo_start, ''odo_end'', disp.odo_end, ''closed_at'', disp.closed_at, ''odo_end_photo'', disp.odo_end_photo, ''km_est'', disp.km_est,';
BEGIN
  def := pg_get_functiondef(sig);
  IF position($needle$'closed_at', disp.closed_at$needle$ IN def) > 0 AND position($needle$'odo_end_photo', disp.odo_end_photo$needle$ IN def) > 0 THEN RETURN; END IF;
  IF position(old_route IN def) = 0 OR position(old_json IN def) = 0 THEN
    RAISE EXCEPTION 'Definición actual de unit_daily_report no reconocida; revisar antes de migrar';
  END IF;
  EXECUTE replace(replace(def, old_route, new_route), old_json, new_json);
END $patch$;

NOTIFY pgrst, 'reload schema';
COMMIT;
