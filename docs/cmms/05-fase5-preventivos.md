# Fase 5 — Planificación preventiva

Fecha: 2026-09-27 · Migración: `20260927160000_f5_planificacion_preventiva.sql`

## Hallazgos corregidos

| Severidad | Hallazgo |
|---|---|
| Crítico | La pantalla guardaba en `description`, una columna inexistente, e ignoraba el error: mostraba "Plan creado" pero no guardaba nada. |
| Alto | `next_due_km` y `next_due_date` no los mantenía nadie; la proyección los calculaba en la vista con otro criterio. |
| Alto | No había un programador en el servidor: la generación de OT dependía de un clic en el frontend. |
| Alto | `generate_preventive_wo` duplicaba OT para el mismo plan y no copiaba tareas ni prioridad. |
| Alto | La IA estimaba los vencimientos por tipo de unidad con campos legados, sin usar los planes reales. |
| Medio | `vehicle_odometer_logs` no tenía política de lectura, así que las lecturas nunca se veían. No había fuente autorizada para el horómetro. |

## Implementado

- **Planes por km, horas, fecha o combinación**, que vencen por lo primero que ocurra. Al menos una frecuencia es obligatoria.
- **Línea base:** es la lectura real de la unidad al crear el plan. Se valida contra el odómetro y el horómetro reales, y la fecha no puede ser futura (tolerancia de 1 día por la diferencia UTC/Lima).
- **Vencimientos derivados en la BD** (`next_due_km/date/hours`). Se reinician al cerrar la OT preventiva (F4).
- **Lecturas autorizadas (`register_asset_reading`):**
  - Fuentes válidas: mantenimiento o flota de la sede, o el conductor con un viaje activo de la unidad.
  - Las lecturas son monotónicas y quedan auditadas en `vehicle_odometer_logs` (con horómetro).
  - `vw_asset_usage_rate` calcula el uso diario real de los últimos 30 días.
- **`vw_maintenance_projections`:**
  - Alertas según el umbral que se alcance primero:

    | Alerta | Umbral |
    |---|---|
    | `VENCIDO` | Llegó a cualquier límite |
    | `URGENTE` | ≤7 días proyectados o ≤10 % de la frecuencia |
    | `PRÓXIMO` | ≤30 días o ≤25 % |
    | `NORMAL` | Resto |

  - Qué dispara el vencimiento: kilometraje, horómetro o fecha.
  - Fecha proyectada según el uso, horizonte 30/60/90 días y OT abierta del plan.
  - El motor de elegibilidad (F2) usa esta misma vista.
- **`generate_preventive_wo` idempotente:**
  - Una sola OT abierta por plan.
  - Copia las tareas estándar.
  - Prioridad `ALTA` si el plan está `VENCIDO`/`URGENTE`; fecha de inicio según la proyección.
- **Programador en la BD:**
  - `run_preventive_scheduler`, agendado con `pg_cron` a las 06:00 de Lima.
  - Genera OT en `BORRADOR` para planes `VENCIDO`/`URGENTE` sin OT abierta.
  - Cada corrida queda en `preventive_scheduler_runs`.
- **UI:**
  - Indicadores por alerta y a 30/60/90 días.
  - Proyección con filtros y botón "Generar OT".
  - Calendario de 90 días.
  - CRUD de planes con tareas y repuestos previstos.
  - Registro de lecturas.
  - Programador con "Ejecutar ahora" y bitácora.
- **Copiloto:** `get_maintenance_alerts` usa las proyecciones reales, el backlog y las OT.

## Pruebas

`supabase/tests/f5_preventivos.test.sql` — **12/12 PASS**

| # | Caso | Resultado esperado |
|---|---|---|
| T1 | Plan por km | Línea base = lectura real; vencimiento derivado |
| T2 | Validaciones | Ejecución mayor al odómetro rechazada; plan sin frecuencias rechazado |
| T3 | Proyección por tasa de uso | ~100 km/día → ~50 días → horizonte 60, `NORMAL` |
| T4 | Lecturas sucesivas | `PRÓXIMO` → `URGENTE` → `VENCIDO`; el motor bloquea la unidad |
| T5 | Lectura menor a la actual | Rechazada |
| T6 | Plan combinado km + fecha | Vence por fecha |
| T7 | Plan por horómetro (montacargas) | `URGENTE` por horómetro |
| T8 | Generación de OT | Idempotente, con tareas y prioridad |
| T9 | Programador | Genera las OT faltantes; la segunda corrida no duplica; queda en la bitácora |
| T10 | Cierre de la OT preventiva | El plan se reinicia desde la lectura real |
| T11 | `pg_cron` | Trabajo agendado |
| T12 | Usuario sin permisos | No registra lecturas, no genera OT ni corre el programador |

Regresión: F1 10/10, F2 19/19, F3 16/16, F4 17/17 y `cmms_regresion` PASS.

## Observaciones

- **Sin planes en producción.** Hay que cargarlos con la pantalla nueva. La línea base toma la lectura actual de cada unidad.
