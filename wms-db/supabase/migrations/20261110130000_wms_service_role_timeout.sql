-- La carga del ERP en el WMS se cancelaba por tiempo («canceling statement due to statement timeout») desde el 8 nov.
-- /api/wms/erp-aplicar aplica el Actualizable (~72 mil filas) con la llave de servicio, pero en esta base
-- service_role no tenía tiempo propio y heredaba los 8 s de authenticator. El TMS usa 120 s (igual que maxDuration de
-- la ruta); se iguala. No cambia los límites de los usuarios (authenticated 8 s, anon 3 s).
ALTER ROLE service_role SET statement_timeout = '120s';
