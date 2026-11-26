-- Verificación y cierre de OT (26-11-2026): según el rol, verifican y cierran el Administrador del sistema, el Jefe de
-- Distribución o a quien se le asigne el permiso mantenimiento-liberacion.
-- Las acciones del Administrador no cuentan como ejecución, así que puede verificar y cerrar una OT que él mismo inició
-- o terminó (hoy es el único usuario con el permiso y quedaban unidades en MANTENIMIENTO sin forma de liberarlas).
-- Para el resto de roles se mantiene la segregación: quien ejecutó no verifica ni cierra.
-- Parte de la definición viva en producción; solo agrega el filtro de Administrador.
CREATE OR REPLACE FUNCTION public.work_order_executors(p_work_order_id uuid)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(array_agg(DISTINCT x) FILTER (WHERE x IS NOT NULL), '{}'::uuid[]) FROM (
    SELECT mechanic_id AS x FROM public.maintenance_work_orders WHERE id = p_work_order_id
    UNION ALL
    SELECT e.created_by FROM public.maintenance_work_order_events e
    WHERE e.work_order_id = p_work_order_id AND e.evento = 'ESTADO' AND e.estado_nuevo IN ('EN_PROCESO', 'TERMINADA')
      AND e.estado_anterior IS DISTINCT FROM 'VALIDACION'
  ) s
  WHERE NOT EXISTS (SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
                    WHERE p.id = s.x AND p.is_active AND r.name = 'Administrador');
$$;
REVOKE ALL ON FUNCTION public.work_order_executors(uuid) FROM PUBLIC, anon, authenticated;
