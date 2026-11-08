-- Tamaños de etiqueta configurables: catálogo de formatos (A4, A5, Zebra…) y el formato que usa cada tipo de etiqueta.
CREATE TABLE IF NOT EXISTS public.wh_label_formats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (length(trim(name)) BETWEEN 2 AND 60),
  width_mm numeric(6,1) NOT NULL CHECK (width_mm BETWEEN 15 AND 450),
  height_mm numeric(6,1) NOT NULL CHECK (height_mm BETWEEN 10 AND 650),
  dpi integer NOT NULL DEFAULT 203 CHECK (dpi IN (203, 300, 600)),
  is_active boolean NOT NULL DEFAULT true,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.wh_label_settings (
  kind text PRIMARY KEY CHECK (kind IN ('PAQUETE','LPN')),
  format_id uuid NOT NULL REFERENCES public.wh_label_formats(id),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wh_label_settings_format_idx ON public.wh_label_settings(format_id);

INSERT INTO public.wh_label_formats(name, width_mm, height_mm) VALUES
  ('Zebra 6 x 4 pulg (horizontal)', 152.4, 101.6), ('Zebra 4 x 6 pulg', 101.6, 152.4), ('Zebra 4 x 3 pulg', 101.6, 76.2),
  ('Zebra 4 x 2 pulg', 101.6, 50.8), ('Zebra 3 x 2 pulg', 76.2, 50.8), ('Zebra 2 x 1 pulg', 50.8, 25.4),
  ('100 x 150 mm', 100, 150), ('100 x 50 mm', 100, 50), ('A6 (105 x 148 mm)', 105, 148), ('A5 (148 x 210 mm)', 148, 210),
  ('A4 (210 x 297 mm)', 210, 297)
ON CONFLICT (name) DO NOTHING;
-- Se conservan los tamaños con que se imprime hoy: paquete 6 x 4 pulg; LPN 100 mm de ancho.
INSERT INTO public.wh_label_settings(kind, format_id)
SELECT k, (SELECT id FROM public.wh_label_formats WHERE name = f) FROM (VALUES ('PAQUETE','Zebra 6 x 4 pulg (horizontal)'), ('LPN','100 x 50 mm')) v(k, f)
ON CONFLICT (kind) DO NOTHING;

ALTER TABLE public.wh_label_formats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wh_label_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wh_label_formats, public.wh_label_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.wh_label_formats, public.wh_label_settings TO authenticated;
DROP POLICY IF EXISTS security_active_account ON public.wh_label_formats;
CREATE POLICY security_active_account ON public.wh_label_formats AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.wh_label_settings;
CREATE POLICY security_active_account ON public.wh_label_settings AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS wh_label_formats_read ON public.wh_label_formats;
CREATE POLICY wh_label_formats_read ON public.wh_label_formats FOR SELECT TO authenticated USING (public.wh_any_warehouse_permission());
DROP POLICY IF EXISTS wh_label_settings_read ON public.wh_label_settings;
CREATE POLICY wh_label_settings_read ON public.wh_label_settings FOR SELECT TO authenticated USING (public.wh_any_warehouse_permission());

-- Alta o edición de un formato (solo supervisión). No se desactiva un formato en uso.
CREATE OR REPLACE FUNCTION public.wh_label_format_save(p_id uuid, p_name text, p_width_mm numeric, p_height_mm numeric, p_dpi integer, p_active boolean DEFAULT true)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN RAISE EXCEPTION 'Solo supervisión configura etiquetas' USING ERRCODE = '42501'; END IF;
  IF p_width_mm IS NULL OR p_width_mm NOT BETWEEN 15 AND 450 OR p_height_mm IS NULL OR p_height_mm NOT BETWEEN 10 AND 650 THEN
    RAISE EXCEPTION 'Medidas fuera de rango: ancho 15-450 mm, alto 10-650 mm';
  END IF;
  IF p_id IS NOT NULL AND NOT coalesce(p_active, true) AND EXISTS (SELECT 1 FROM public.wh_label_settings WHERE format_id = p_id) THEN
    RAISE EXCEPTION 'Ese formato está asignado a un tipo de etiqueta: asigne otro antes de desactivarlo';
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.wh_label_formats(name, width_mm, height_mm, dpi, is_active, updated_by)
    VALUES (trim(p_name), p_width_mm, p_height_mm, coalesce(p_dpi, 203), coalesce(p_active, true), auth.uid()) RETURNING id INTO v_id;
  ELSE
    UPDATE public.wh_label_formats SET name = trim(p_name), width_mm = p_width_mm, height_mm = p_height_mm, dpi = coalesce(p_dpi, 203),
      is_active = coalesce(p_active, true), updated_by = auth.uid(), updated_at = now() WHERE id = p_id RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Formato no encontrado'; END IF;
  END IF;
  RETURN v_id;
END $$;

-- Asigna el formato que usa cada tipo de etiqueta (solo supervisión).
CREATE OR REPLACE FUNCTION public.wh_label_setting_set(p_kind text, p_format_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN RAISE EXCEPTION 'Solo supervisión configura etiquetas' USING ERRCODE = '42501'; END IF;
  IF p_kind NOT IN ('PAQUETE','LPN') THEN RAISE EXCEPTION 'Tipo de etiqueta no reconocido'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.wh_label_formats WHERE id = p_format_id AND is_active) THEN RAISE EXCEPTION 'Formato no disponible'; END IF;
  INSERT INTO public.wh_label_settings(kind, format_id, updated_by) VALUES (p_kind, p_format_id, auth.uid())
  ON CONFLICT (kind) DO UPDATE SET format_id = excluded.format_id, updated_by = auth.uid(), updated_at = now();
END $$;

REVOKE ALL ON FUNCTION public.wh_label_format_save(uuid, text, numeric, numeric, integer, boolean), public.wh_label_setting_set(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_label_format_save(uuid, text, numeric, numeric, integer, boolean), public.wh_label_setting_set(text, uuid) TO authenticated;
