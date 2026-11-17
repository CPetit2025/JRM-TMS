-- Contratos ocultos en el APT: lista de lotes u OT (raíz) que se excluyen del modelo de inventario por errores del sistema.
-- No borra ni cambia movimientos ni cargas del ERP: la vista inv_movements_v (la entrada del recálculo y de las lecturas del
-- modelo) los deja fuera, y el próximo recálculo (cron inventario-recalculo, cada 2 min) los saca de Resumen, Contratos / OT,
-- Stock, Estadía, Trazabilidad y Flujo. Volver a mostrarlo los recupera tal cual. Gestión: Datos y verificación.
BEGIN;
SET LOCAL lock_timeout = '3min';
-- Esperar a que termine un recálculo en curso (cron cada 2 min, ~60 s): lee la vista que se reemplaza
SELECT pg_advisory_xact_lock(hashtext('inv_rebuild'));

CREATE TABLE IF NOT EXISTS public.inv_contratos_ocultos (
  codigo text PRIMARY KEY CHECK (codigo = upper(btrim(codigo)) AND codigo <> ''),
  motivo text NOT NULL CHECK (length(btrim(motivo)) >= 3),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.inv_contratos_ocultos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.inv_contratos_ocultos;
CREATE POLICY security_active_account ON public.inv_contratos_ocultos AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.inv_contratos_ocultos FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.inv_contratos_ocultos TO service_role;
COMMENT ON TABLE public.inv_contratos_ocultos IS 'Lotes u OT raíz excluidos del modelo de inventario APT (inv_movements_v). Solo por inv_ocultos_save.';

-- El código oculta el lote exacto (15603-S002) o la OT completa con sus subcontratos (15603, por la columna ot).
-- Dos anti-joins por igualdad (hash): con la lista vacía o corta no encarecen el recálculo.
CREATE OR REPLACE VIEW public.inv_movements_v WITH (security_barrier = false) AS
  SELECT m.* FROM public.inv_movements m
  WHERE (COALESCE(current_setting('inv.scope', true), '') = '' OR m.bodega LIKE current_setting('inv.scope', true))
    AND NOT EXISTS (SELECT 1 FROM public.inv_contratos_ocultos o WHERE o.codigo = m.lote)
    AND NOT EXISTS (SELECT 1 FROM public.inv_contratos_ocultos o WHERE o.codigo = m.ot);
REVOKE ALL ON public.inv_movements_v FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.inv_movements_v TO service_role;
COMMENT ON VIEW public.inv_movements_v IS 'inv_movements sin los contratos ocultos (inv_contratos_ocultos) y limitado por inv.scope (solo pruebas).';

-- Trazabilidad leía la tabla directamente: pasa a la vista (mismo código, sin los ocultos)
DO $migration$
DECLARE src text := pg_get_functiondef('public.inv_trace(text)'::regprocedure);
BEGIN
  IF src !~ 'public\.inv_movements\M' THEN RAISE EXCEPTION 'inv_trace no lee inv_movements: revisar antes de migrar'; END IF;
  EXECUTE regexp_replace(src, 'public\.inv_movements\M', 'public.inv_movements_v', 'g');
END $migration$;

CREATE OR REPLACE FUNCTION public.inv_ocultos_list()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  RETURN jsonb_build_object('success', true, 'puede_editar', public.apt_can_load(), 'filas', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('codigo', o.codigo, 'motivo', o.motivo, 'fecha', o.created_at,
      'usuario', NULLIF(btrim(concat_ws(' ', p.first_name, p.last_name)), ''),
      'stock_kg', (SELECT round(COALESCE(sum(sign(m.cantidad) * m.peso_kg), 0), 1) FROM public.inv_movements m
                   WHERE m.active AND public.apt_almacen(m.bodega) IS NOT NULL AND o.codigo IN (m.lote, m.ot)))
      ORDER BY o.created_at DESC)
    FROM public.inv_contratos_ocultos o LEFT JOIN public.profiles p ON p.id = o.created_by), '[]'::jsonb));
END $function$;

CREATE OR REPLACE FUNCTION public.inv_ocultos_save(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_codigo text := upper(btrim(COALESCE(p->>'codigo', ''))); v_motivo text := btrim(COALESCE(p->>'motivo', ''));
BEGIN
  IF NOT public.apt_can_load() THEN RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para ocultar contratos'); END IF;
  IF v_codigo = '' THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el contrato u OT'); END IF;
  IF COALESCE((p->>'ocultar')::boolean, true) THEN
    IF length(v_motivo) < 3 THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo'); END IF;
    IF NOT EXISTS (SELECT 1 FROM public.inv_movements m WHERE m.lote = v_codigo OR m.ot = v_codigo) THEN
      RETURN jsonb_build_object('success', false, 'error', format('No hay movimientos del contrato u OT %s', v_codigo));
    END IF;
    INSERT INTO public.inv_contratos_ocultos (codigo, motivo) VALUES (v_codigo, v_motivo)
    ON CONFLICT (codigo) DO UPDATE SET motivo = EXCLUDED.motivo;
  ELSE
    DELETE FROM public.inv_contratos_ocultos WHERE codigo = v_codigo;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', format('%s no está oculto', v_codigo)); END IF;
  END IF;
  UPDATE public.inv_state SET dirty = true WHERE id = 1;
  RETURN jsonb_build_object('success', true, 'codigo', v_codigo);
END $function$;

REVOKE ALL ON FUNCTION public.inv_ocultos_list(), public.inv_ocultos_save(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_ocultos_list(), public.inv_ocultos_save(jsonb) TO authenticated, service_role;
COMMIT;
