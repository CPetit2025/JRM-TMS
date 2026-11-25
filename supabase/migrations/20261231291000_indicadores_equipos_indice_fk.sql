-- Indicadores por equipo: índice que cubre la FK kpi_eq_correcciones.codigo (C55 exige cobertura de toda FK;
-- el índice único parcial (codigo, ref) WHERE estado vivo no cuenta porque tiene predicado).
BEGIN;
CREATE INDEX IF NOT EXISTS kpi_eq_correcciones_codigo_idx ON public.kpi_eq_correcciones(codigo, fecha);
COMMIT;
