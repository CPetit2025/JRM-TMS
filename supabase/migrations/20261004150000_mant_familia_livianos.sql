-- 20261004150000_mant_familia_livianos.sql
-- Ajuste de la Fase 1 del plan de mantenimiento: en Flota, BHW 001 (minivan JAC a GLP) y F6E 535 (Toyota a gasolina)
-- están registradas como CAMION y la asignación automática les dio un plan de camión diésel. Su familia es LIVIANO.
-- Solo cambia la familia asignada automáticamente; no toca la unidad en Flota.
BEGIN;
UPDATE public.mant_asset_familia af SET familia = 'LIVIANO', nota = 'ajuste: liviano registrado como CAMION', updated_at = now()
FROM public.vehicles v
WHERE v.id = af.vehicle_id AND public.fe_code(v.plate) IN ('BHW 001', 'F6E 535') AND af.nota = 'automática';
COMMIT;
