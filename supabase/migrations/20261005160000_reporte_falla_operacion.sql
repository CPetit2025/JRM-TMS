-- ============================================================
-- Reporte de fallas desde Operación (Jefe de Distribución, supervisores de transporte y despacho)
-- ============================================================
-- Incidente C35 (despliegue de 20261005150000): la política mr_insert de maintenance_requests solo deja registrar fallas
-- a quien tiene mantenimiento-fallas. El Jefe de Distribución y los supervisores de transporte y despacho no podían
-- reportar una falla o incidencia mecánica desde la web; solo el conductor desde el app (RPC) llegaba a Mantenimiento.
-- * reportar_falla(placa, descripción, criticidad, odómetro): RPC para quien tiene despacho, torre-control, monitoreo,
--   caja-aprobación, Soporte Mecánico o Fallas. La falla nace REPORTADA y dispara el aviso a Soporte Mecánico y
--   Mantenimiento con el nombre y rol de quien reporta.
-- * mr_read_own: cada usuario ve las fallas que él reportó.
BEGIN;

DROP POLICY IF EXISTS mr_read_own ON public.maintenance_requests;
CREATE POLICY mr_read_own ON public.maintenance_requests FOR SELECT TO authenticated USING (reported_by = auth.uid());

CREATE OR REPLACE FUNCTION public.puede_reportar_falla()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.is_tms_admin() OR public.has_cmms_permission('fallas') OR public.has_tms_permission('mantenimiento-soporte')
      OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('torre-control')
      OR public.has_tms_read_permission('monitoreo') OR public.has_tms_read_permission('caja-aprobacion');
$$;
REVOKE ALL ON FUNCTION public.puede_reportar_falla() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.puede_reportar_falla() TO authenticated;

CREATE OR REPLACE FUNCTION public.reportar_falla(p_placa text, p_descripcion text, p_criticidad text DEFAULT 'MEDIA', p_odometro numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_plate text; v_site uuid; v_sev text; v_id uuid; v_src text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.puede_reportar_falla() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para reportar fallas');
  END IF;
  SELECT v.plate, v.site_id INTO v_plate, v_site FROM public.vehicles v WHERE upper(v.plate) = upper(btrim(p_placa));
  IF v_plate IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Unidad no encontrada'); END IF;
  IF v_site IS NOT NULL AND NOT public.is_tms_admin() AND NOT public.can_access_site(v_site) THEN
    RETURN jsonb_build_object('success', false, 'error', 'La unidad pertenece a otra sede');
  END IF;
  IF length(btrim(COALESCE(p_descripcion, ''))) < 5 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Describa la falla');
  END IF;
  v_sev := upper(translate(COALESCE(NULLIF(btrim(p_criticidad), ''), 'MEDIA'), 'ÍíÁá', 'IiAa'));
  IF v_sev NOT IN ('CRITICA', 'ALTA', 'MEDIA', 'BAJA') THEN v_sev := 'MEDIA'; END IF;
  v_src := CASE WHEN public.has_tms_read_permission('torre-control') AND NOT public.has_tms_read_permission('despacho') THEN 'TORRE_CONTROL'
                WHEN public.has_cmms_permission('fallas') OR public.has_tms_permission('mantenimiento-soporte') THEN 'MANTENIMIENTO'
                ELSE 'SUPERVISOR' END;
  INSERT INTO public.maintenance_requests (vehicle_plate, description, severity, source, reported_by)
  VALUES (v_plate, btrim(p_descripcion), v_sev, v_src, auth.uid())
  RETURNING id INTO v_id;
  IF p_odometro IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'maintenance_requests' AND column_name = 'odometer_at_report') THEN
    EXECUTE 'UPDATE public.maintenance_requests SET odometer_at_report = $1 WHERE id = $2' USING p_odometro, v_id;
  END IF;
  RETURN jsonb_build_object('success', true, 'id', v_id, 'criticidad', v_sev,
    'mensaje', CASE WHEN v_sev = 'CRITICA' THEN 'Falla crítica registrada: la unidad queda bloqueada hasta que Mantenimiento la libere'
                    ELSE 'Falla registrada: se avisó a Soporte Mecánico y Mantenimiento' END);
EXCEPTION
  WHEN unique_violation THEN RETURN jsonb_build_object('success', false, 'error', 'Esta falla ya fue registrada hoy para la unidad');
END $$;
REVOKE ALL ON FUNCTION public.reportar_falla(text, text, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reportar_falla(text, text, text, numeric) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
