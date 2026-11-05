-- C213: consultas interactivas compuestas de ahorro y jornada exceden los 8 s.
-- Evitar compilar JIT en cada consulta anidada, igual que el lookup de guías APT.
-- Solo cambia la configuración del planificador de estas funciones: conserva
-- cuerpos instalados, cálculos, permisos, propietarios y timeout de la pantalla.
BEGIN;
ALTER FUNCTION public.consolidation_savings(date,date,uuid,uuid) SET jit = off;
ALTER FUNCTION public.fleet_workdays(date,date,text[]) SET jit = off;
ALTER FUNCTION public.unit_daily_report(text,date,date) SET jit = off;
COMMIT;
