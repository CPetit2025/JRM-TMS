-- ============================================================
-- APT — Tiempo límite de las consultas del servidor (service_role)
-- ============================================================
-- La ruta /api/apt/procesar aplica la carga y recalcula la estadía y el flujo con la llave de servicio. En producción
-- el rol service_role hereda el límite de 8 s de la API y el reporte total del ERP (≈ 64 000 filas útiles) lo supera
-- ("canceling statement due to statement timeout"). PostgREST aplica en cada petición el statement_timeout configurado
-- en el rol que impersona: se fija en 120 s para service_role (solo lo usan el servidor y procesos internos; el
-- navegador sigue con 8 s) y se pide a PostgREST recargar su configuración.
DO $$
BEGIN
  ALTER ROLE service_role SET statement_timeout = '120s';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'No se pudo fijar statement_timeout de service_role: %', SQLERRM;
END $$;

NOTIFY pgrst, 'reload config';
