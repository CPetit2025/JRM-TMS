-- Correcciones tras 20261016140000 (incidente de Caja SQL tests C55 y C72):
-- · delivery_photo_mutable vuelve a proteger también las fotos del Packing List (packing_photos), además de la guía
--   y las fotos del rechazo en destino.
-- · Índice para la relación delivery_rejections.request_id (toda FK con cobertura de índice).
CREATE OR REPLACE FUNCTION public.delivery_photo_mutable(p_name text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.delivery_submissions WHERE photos @> ARRAY[p_name] OR packing_photos @> ARRAY[p_name])
    AND NOT EXISTS(SELECT 1 FROM public.delivery_rejections WHERE photos @> ARRAY[p_name]);
$$;
REVOKE ALL ON FUNCTION public.delivery_photo_mutable(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delivery_photo_mutable(text) TO authenticated;

CREATE INDEX IF NOT EXISTS delivery_rejections_request_idx ON public.delivery_rejections(request_id);
