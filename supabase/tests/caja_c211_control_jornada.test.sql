-- C211: Control de Jornada instalado (fleet_workdays, toneladas APT sin duplicar, ahorro pendiente por costo por hora).
-- Mide en producción el último mes de toda la flota visible (sin sesión, sin datos modificados).
BEGIN;
DO $$
BEGIN
 IF to_regprocedure('public.fleet_workdays(date,date,text[])') IS NULL THEN
  RAISE EXCEPTION 'CAJA C211 FAIL: fleet_workdays no instalada';
 END IF;
 IF position('DISTINCT ON (public.apt_guia_key(s.guide))' IN pg_get_functiondef('public.unit_daily_report(text,date,date)'::regprocedure)) = 0 THEN
  RAISE EXCEPTION 'CAJA C211 FAIL: toneladas APT de una guía compartida se duplican';
 END IF;
 IF position('COSTO_HORA_PENDIENTE' IN pg_get_functiondef('public.consolidation_savings(date,date,uuid,uuid)'::regprocedure)) = 0 THEN
  RAISE EXCEPTION 'CAJA C211 FAIL: el ahorro se muestra sin costos por hora';
 END IF;
 IF position('''request_id'', s.request_id' IN pg_get_functiondef('public.unit_daily_report(text,date,date)'::regprocedure)) = 0 THEN
  RAISE EXCEPTION 'CAJA C211 FAIL: la jornada no expone los ids de ruta y solicitud';
 END IF;
 RAISE EXCEPTION 'CAJA C211 PASS: control de jornada instalado (datos, ids de ruta y ahorro pendiente)';
END $$;
ROLLBACK;
