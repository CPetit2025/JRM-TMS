-- Registro de servicios (solo lectura): rutas programadas sin su flete en /contratos/servicios.
-- Cada fila: clase de hallazgo y el detalle (sin datos personales salvo la placa).
-- Columnas opcionales de producción leídas con to_jsonb(x)->>'columna'.
WITH base AS (
  SELECT d.id, d.dispatch_number, d.status, d.vehicle_plate, COALESCE(to_jsonb(d)->>'modalidad','PROPIA') AS modalidad,
    COALESCE(d.freight_cost,0) AS freight_cost, d.contract_id, (d.scheduled_departure AT TIME ZONE 'America/Lima')::date AS fecha,
    (SELECT count(*) FROM public.dispatch_requests dr WHERE dr.dispatch_id=d.id) AS servicios,
    (SELECT string_agg(DISTINCT t.request_type,',') FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id=dr.transport_request_id WHERE dr.dispatch_id=d.id) AS tipos,
    (SELECT string_agg(DISTINCT COALESCE(to_jsonb(t)->>'attention_mode','?'),',') FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id=dr.transport_request_id WHERE dr.dispatch_id=d.id) AS atencion,
    (SELECT string_agg(DISTINCT c.code,',') FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id=dr.transport_request_id JOIN public.contracts c ON c.id=t.contract_id WHERE dr.dispatch_id=d.id) AS ots,
    (SELECT count(*) FROM public.contract_services s WHERE s.dispatch_id=d.id AND s.service_type='FLETE' AND s.status IS DISTINCT FROM 'ANULADO') AS fletes,
    (SELECT count(*) FROM public.dispatch_request_freight f WHERE f.dispatch_id=d.id) AS reparto,
    (SELECT COALESCE(sum(f.amount_pen),0) FROM public.dispatch_request_freight f WHERE f.dispatch_id=d.id) AS reparto_pen,
    to_jsonb(d)->'freight_breakdown' IS NOT NULL AND to_jsonb(d)->>'freight_breakdown' <> 'null' AS con_tarifa
  FROM public.dispatches d
  WHERE d.scheduled_departure >= now() - interval '75 days'
)
SELECT 'resumen' AS clase, jsonb_build_object('estado',status,'modalidad',modalidad,'flete_cero',freight_cost=0,'con_flete_registrado',fletes>0,
  'externo',vehicle_plate='EXTERNO','tipos',tipos,'rutas',count(*)) AS detalle
FROM base GROUP BY status, modalidad, freight_cost=0, fletes>0, vehicle_plate='EXTERNO', tipos
UNION ALL
SELECT 'ot_16396', jsonb_build_object('ruta',dispatch_number,'estado',status,'placa',vehicle_plate,'modalidad',modalidad,'flete',freight_cost,
  'fecha',fecha,'servicios',servicios,'tipos',tipos,'atencion',atencion,'ots',ots,'fletes_registrados',fletes,'reparto',reparto,'reparto_pen',reparto_pen,
  'con_tarifa',con_tarifa,'contract_id_ruta',contract_id IS NOT NULL)
FROM base WHERE ots LIKE '%16396%'
UNION ALL
(SELECT 'sin_flete', jsonb_build_object('ruta',dispatch_number,'estado',status,'placa',vehicle_plate,'modalidad',modalidad,'flete',freight_cost,
  'fecha',fecha,'servicios',servicios,'tipos',tipos,'atencion',atencion,'ots',ots,'reparto',reparto,'reparto_pen',reparto_pen,'con_tarifa',con_tarifa)
 FROM base WHERE status<>'CANCELADO' AND vehicle_plate<>'EXTERNO' AND fletes=0 ORDER BY fecha DESC LIMIT 400)
UNION ALL
SELECT 'flete_distinto', jsonb_build_object('ruta',b.dispatch_number,'estado',b.status,'flete',b.freight_cost,
  'registrado',(SELECT sum(s.amount_pen) FROM public.contract_services s WHERE s.dispatch_id=b.id AND s.service_type='FLETE' AND s.status IS DISTINCT FROM 'ANULADO'))
FROM base b WHERE b.status<>'CANCELADO' AND b.fletes>0
  AND b.freight_cost <> (SELECT sum(s.amount_pen) FROM public.contract_services s WHERE s.dispatch_id=b.id AND s.service_type='FLETE' AND s.status IS DISTINCT FROM 'ANULADO')
UNION ALL
SELECT 'cancelado_con_flete_activo', jsonb_build_object('ruta',dispatch_number,'flete',freight_cost,'fletes',fletes)
FROM base WHERE status='CANCELADO' AND fletes>0;
