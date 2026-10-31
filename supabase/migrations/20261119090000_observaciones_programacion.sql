-- Observaciones operativas de la programación de una ruta («Armar ruta y programar unidad», etapa Salida).
-- Son obligatorias en la pantalla cuando la salida queda después de la atención requerida (motivo) y opcionales en otro caso.
-- Columna nueva (no se toca ninguna existente) y una función para guardarlas en la ruta recién programada o aún activa.
BEGIN;

ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS programming_notes text;

CREATE OR REPLACE FUNCTION public.set_dispatch_programming_notes(p_dispatch_id uuid, p_notes text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_status text; v_notes text := NULLIF(btrim(COALESCE(p_notes, '')), '');
BEGIN
 IF NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Sin permiso para programar rutas'; END IF;
 IF length(v_notes) > 1000 THEN RAISE EXCEPTION 'Observaciones demasiado extensas (máximo 1000 caracteres)'; END IF;
 SELECT status INTO v_status FROM public.dispatches WHERE id = p_dispatch_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Ruta no encontrada'; END IF;
 IF v_status NOT IN ('PROGRAMADO','EN_CURSO','EN RUTA') THEN RAISE EXCEPTION 'La ruta ya no está activa: no se modifican sus observaciones'; END IF;
 UPDATE public.dispatches SET programming_notes = v_notes WHERE id = p_dispatch_id AND programming_notes IS DISTINCT FROM v_notes;
END $$;
REVOKE ALL ON FUNCTION public.set_dispatch_programming_notes(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.set_dispatch_programming_notes(uuid,text) TO authenticated;

COMMIT;
