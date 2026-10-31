-- Diagnóstico de Operaciones (Fase 0). SOLO LECTURA: se ejecuta en el editor SQL de Supabase y no modifica datos.
-- Cuenta los casos que dejan el cierre económico sin cerrar o fuera de control, y las inconsistencias operativas
-- detectadas en la revisión del módulo. Cada bloque devuelve un resumen; quitar el LIMIT para ver el detalle completo.

-- 1. Cierre «No aplica» (ruta sin costos) que hoy SÍ tiene costos: gastos fuera de control
SELECT 'no_aplica_con_costos' AS caso, d.dispatch_number, d.status AS ruta, c.updated_at,
  jsonb_array_length(public.economic_route_items(d.id)) AS items
FROM public.economic_closures c JOIN public.dispatches d ON d.id = c.dispatch_id
WHERE c.status = 'NO_APLICA' AND jsonb_array_length(public.economic_route_items(d.id)) > 0
ORDER BY c.updated_at DESC LIMIT 200;

-- 2. Cierre «Cerrado» con ítems sin aprobar: la bandeja lo muestra por cerrar, pero validar y «Conforme» lo rechazan
SELECT 'cerrado_con_pendientes' AS caso, d.dispatch_number, d.status AS ruta, c.closed_at,
  (SELECT string_agg(i->>'concept' || ':' || (i->>'status'), ', ') FROM jsonb_array_elements(public.economic_route_items(d.id)) i
    WHERE i->>'status' <> 'APROBADO') AS pendientes
FROM public.economic_closures c JOIN public.dispatches d ON d.id = c.dispatch_id
WHERE c.status = 'CERRADO' AND EXISTS (SELECT 1 FROM jsonb_array_elements(public.economic_route_items(d.id)) i WHERE i->>'status' <> 'APROBADO')
LIMIT 200;

-- 3. Estado guardado distinto del que muestra la bandeja (todas las rutas con la unidad liberada)
SELECT c.status AS guardado, public.economic_queue_key(d.id) AS bandeja, count(*)
FROM public.economic_closures c JOIN public.dispatches d ON d.id = c.dispatch_id
WHERE d.status IN ('RETORNO_COMPLETADO','CIERRE_OPERATIVO','LIQUIDADO','CERRADO')
GROUP BY 1, 2 ORDER BY 3 DESC;

-- 4. Antigüedad de lo que está por cerrar o por aprobar (días desde que se liberó la unidad)
SELECT public.economic_queue_key(d.id) AS bandeja,
  CASE WHEN now() - COALESCE((to_jsonb(d)->>'operational_closed_at')::timestamptz, (to_jsonb(d)->>'returned_at')::timestamptz, d.scheduled_departure) < interval '7 days' THEN '0-6 días'
       WHEN now() - COALESCE((to_jsonb(d)->>'operational_closed_at')::timestamptz, (to_jsonb(d)->>'returned_at')::timestamptz, d.scheduled_departure) < interval '30 days' THEN '7-29 días'
       ELSE '30+ días' END AS antiguedad, count(*)
FROM public.dispatches d
WHERE d.status IN ('RETORNO_COMPLETADO','CIERRE_OPERATIVO','LIQUIDADO','CERRADO') AND d.scheduled_departure >= now() - interval '400 days'
  AND public.economic_queue_key(d.id) IN ('POR_CERRAR','POR_APROBAR')
GROUP BY 1, 2 ORDER BY 1, 2;

-- 5. Posibles servicios duplicados: misma ruta, solicitud y tipo (montacarga, grúa o estiba) en más de una línea activa
SELECT 'servicio_duplicado' AS caso, d.dispatch_number, t.request_number, u.concept, count(*) AS lineas,
  string_agg(u.origin || ' S/ ' || COALESCE(u.final_pen, u.actual_pen, u.planned_pen, u.estimated_pen)::text, ' | ') AS detalle
FROM public.transport_unloading_costs u JOIN public.dispatches d ON d.id = u.dispatch_id JOIN public.transport_requests t ON t.id = u.transport_request_id
WHERE u.status IN ('PLANIFICADO','CONSUMIDO') AND u.concept IN ('MONTACARGAS','GRUA','ESTIBA')
GROUP BY d.dispatch_number, t.request_number, u.concept HAVING count(*) > 1
ORDER BY d.dispatch_number DESC LIMIT 200;

-- 6. Gastos de Caja que crearon una línea «No planificado» en una ruta con el cierre ya cerrado o «No aplica»
SELECT 'caja_despues_del_cierre' AS caso, d.dispatch_number, c.status AS cierre, u.concept, u.actual_pen, to_jsonb(u)->>'created_at' AS creado
FROM public.transport_unloading_costs u JOIN public.dispatches d ON d.id = u.dispatch_id JOIN public.economic_closures c ON c.dispatch_id = d.id
WHERE u.origin = 'CAJA' AND u.status = 'CONSUMIDO' AND c.status IN ('CERRADO','NO_APLICA') AND COALESCE(u.econ_status, '') <> 'APROBADO'
LIMIT 200;

-- 7. «Finalizar ruta» de Monitoreo registrado sin que la ruta pasara a Entregado
SELECT 'fin_ruta_sin_entregado' AS caso, d.dispatch_number, d.status, e.created_at
FROM public.dispatch_events e JOIN public.dispatches d ON d.id = e.dispatch_id
WHERE e.event_type = 'FIN_RUTA' AND d.status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION')
ORDER BY e.created_at DESC LIMIT 200;

-- 8. Tripulación: auxiliares de la ruta (route_auxiliaries, base de HHEE y Personal) sin su par activo en dispatch_crew
SELECT 'auxiliar_desincronizado' AS caso, d.dispatch_number, d.status, ra.person_id
FROM public.route_auxiliaries ra JOIN public.dispatches d ON d.id = ra.dispatch_id
JOIN public.hhee_people hp ON hp.id = ra.person_id
WHERE NOT EXISTS (SELECT 1 FROM public.dispatch_crew dc WHERE dc.dispatch_id = ra.dispatch_id AND dc.removed_at IS NULL
   AND dc.profile_id = NULLIF(to_jsonb(hp)->>'profile_id', '')::uuid)
  AND d.scheduled_departure >= now() - interval '90 days'
LIMIT 200;
