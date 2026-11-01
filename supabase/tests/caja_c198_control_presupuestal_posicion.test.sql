-- C198: control presupuestal por OT, etapa 1 — cortes 70/80 configurables, niveles y posición por OT instalados con
-- permisos acotados (solo lectura).
BEGIN;
DO $$
DECLARE s jsonb := public.economic_settings_get();
BEGIN
 IF NOT (s ? 'budget_alert_pct' AND s ? 'budget_cap_pct') OR (s->>'budget_alert_pct')::numeric >= (s->>'budget_cap_pct')::numeric
  OR (s->>'budget_cap_pct')::numeric > 100 THEN
  RAISE EXCEPTION 'CAJA C198 FAIL: cortes de alerta y tope inválidos';
 END IF;
 IF public.budget_level(69.9, 70, 80) <> 'NORMAL' OR public.budget_level(70, 70, 80) <> 'ALERTA' OR public.budget_level(80, 70, 80) <> 'ALERTA'
  OR public.budget_level(80.1, 70, 80) <> 'BLOQUEO' OR public.budget_level(100, 70, 80) <> 'BLOQUEO' OR public.budget_level(100.1, 70, 80) <> 'EXCEDIDO' THEN
  RAISE EXCEPTION 'CAJA C198 FAIL: niveles 70/80/100';
 END IF;
 IF has_function_privilege('anon','public.budget_positions()','EXECUTE') OR NOT has_function_privilege('authenticated','public.budget_positions()','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C198 FAIL: permisos de la posición por OT';
 END IF;
 RAISE EXCEPTION 'CAJA C198 PASS: posición presupuestal por OT con niveles 70/80/100';
END $$;
ROLLBACK;
