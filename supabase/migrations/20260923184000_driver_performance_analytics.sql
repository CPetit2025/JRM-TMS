-- 20260923184000_driver_performance_analytics.sql
-- Motor de rendimiento y KPIs objetivos para los conductores (Perfil 360)

-- 1. Crear vista de analítica de rendimiento del conductor
CREATE OR REPLACE VIEW public.driver_performance_analytics AS
SELECT 
    d.id AS driver_id,
    d.profile_id,
    d.first_name,
    d.last_name,
    d.document_id,
    d.license_number,
    COALESCE(trip_stats.total_completed_trips, 0) AS total_completed_trips,
    COALESCE(fuel_stats.avg_fuel_efficiency_km_gal, 0.00) AS avg_fuel_efficiency_km_gal,
    COALESCE(incident_stats.total_incidents_reported, 0) AS total_incidents_reported
FROM public.drivers d
LEFT JOIN (
    SELECT driver_id, COUNT(id) AS total_completed_trips
    FROM public.dispatches
    WHERE status IN ('ENTREGADO', 'LIQUIDADO')
    GROUP BY driver_id
) trip_stats ON trip_stats.driver_id = d.id
LEFT JOIN (
    SELECT dp.driver_id, ROUND(AVG(vfe.km_per_gallon), 2) AS avg_fuel_efficiency_km_gal
    FROM public.vehicle_fuel_efficiency vfe
    JOIN public.dispatches dp ON vfe.dispatch_id = dp.id
    WHERE vfe.km_per_gallon IS NOT NULL
    GROUP BY dp.driver_id
) fuel_stats ON fuel_stats.driver_id = d.id
LEFT JOIN (
    SELECT driver_id, COUNT(id) AS total_incidents_reported
    FROM public.maintenance_requests
    GROUP BY driver_id
) incident_stats ON incident_stats.driver_id = d.id;

-- 2. Documentar la vista
COMMENT ON VIEW public.driver_performance_analytics IS 'Vista para el motor de rendimiento (Perfil 360 del Conductor) exponiendo KPIs como viajes completados, rendimiento de combustible e incidentes reportados.';

-- 3. Configurar permisos para la vista
GRANT SELECT ON public.driver_performance_analytics TO authenticated;
GRANT SELECT ON public.driver_performance_analytics TO service_role;
