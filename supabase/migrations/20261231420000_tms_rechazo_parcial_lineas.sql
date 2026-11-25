-- Fase 3b de Transporte (decisión 7 del 20-11-2026: entrega completa por cantidad de cada línea).
-- El rechazo parcial registra las líneas faltantes con su cantidad (antes solo una nota libre). Se guarda con la misma
-- operación del rechazo, así un rechazo guardado sin conexión en una versión anterior del app sigue enviándose.
ALTER TABLE public.delivery_rejections ADD COLUMN IF NOT EXISTS missing_lines jsonb;
COMMENT ON COLUMN public.delivery_rejections.missing_lines IS 'Rechazo parcial: [{descripcion, cantidad, unidad}] con cantidad > 0 (lo no entregado).';

CREATE OR REPLACE FUNCTION public.delivery_rejection_set_lines(p_operation uuid, p_lines jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.delivery_rejections%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.delivery_rejections WHERE operation_id = p_operation FOR UPDATE;
  IF r.id IS NULL OR r.created_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Rechazo no disponible'; END IF;
  IF r.kind <> 'PARCIAL' THEN RETURN jsonb_build_object('success', true, 'skipped', true); END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 30
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) x WHERE length(btrim(coalesce(x->>'descripcion', ''))) < 2
       OR coalesce((x->>'cantidad')::numeric, 0) <= 0) THEN
    RAISE EXCEPTION 'Indique cada producto no entregado con su cantidad';
  END IF;
  UPDATE public.delivery_rejections SET missing_lines = (SELECT jsonb_agg(jsonb_build_object('descripcion', left(btrim(x->>'descripcion'), 200),
    'cantidad', (x->>'cantidad')::numeric, 'unidad', nullif(left(btrim(coalesce(x->>'unidad', '')), 20), ''))) FROM jsonb_array_elements(p_lines) x)
  WHERE id = r.id;
  RETURN jsonb_build_object('success', true);
END $$;
REVOKE ALL ON FUNCTION public.delivery_rejection_set_lines(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delivery_rejection_set_lines(uuid, jsonb) TO authenticated;
