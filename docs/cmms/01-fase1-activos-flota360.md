# Fase 1 — Maestro de activos y Flota 360°

Fecha: 2026-09-27 · Migraciones: `20260924133100_cmms_core_fleet_360.sql` (corregida en F2) y `20260927140000_f1_activos_flota360.sql`

## Hallazgos corregidos

| Severidad | Hallazgo |
|---|---|
| Crítico | La ficha Flota 360 consultaba `vehicle_tco_analytics`, que no existía: la versión aplicada falló en silencio. También consultaba `routes`, que no existe. |
| Crítico | Cualquier usuario autenticado podía insertar registros en `vehicle_history_logs`, es decir, falsificar la auditoría. |
| Alto | `get_fleet_360_view` no se usaba y solo devolvía el vehículo con 10 registros de historial. |
| Alto | Datos duplicados en el maestro (`current_mileage` y `current_odometer`, `capacity_weight` y `weight_capacity`). La IA leía los campos legados. |
| Alto | Se podía cambiar la placa (identidad) y eliminar activos con historial, perdiendo trazabilidad. El odómetro podía retroceder. |
| Alto | (Corregido en F2) La restricción de tipos convertía los 7 vehículos de producción a `otros`. |

## Implementado

- **Maestro:**
  - Tipos vehiculares y no vehiculares: CAMION, CAMIONETA, FURGON, TRAILER, TRACTO, SEMIRREMOLQUE, MONTACARGAS, APILADOR, TRANSPALETA y OTRO.
  - Campos: código interno (único), serie, criticidad, propiedad, responsable y ubicación.
  - Los equipos sin placa se identifican por su código.
- **Identidad única:**
  - La placa no cambia desde el cliente.
  - Un activo con OT, fallas, despachos o inspecciones no se elimina: se da de baja (`FUERA_DE_SERVICIO`).
- **Una sola fuente por dato:** `current_odometer` y `weight_capacity`/`volume_capacity` son los canónicos; los campos legados quedan como espejo automático. Odómetro y horómetro no retroceden.
- **Auditoría:**
  - Alta y cambio de cada campo del maestro, con el usuario que lo hizo, en `vehicle_history_logs`.
  - Los cambios de estado y de bloqueo los registra el motor (F2).
  - Solo el servidor escribe la auditoría; la lectura se filtra por sede y permiso.
- **Estados** (F2): `DISPONIBLE`, `ASIGNADA`, `EN_OPERACION`, `OBSERVADA`, `MANTENIMIENTO`, `BLOQUEADA` y `FUERA_DE_SERVICIO`.
- **`vehicle_tco_analytics` recreada:**
  - Costo de mantenimiento: OT no canceladas.
  - Costo de operación y combustible: gastos de viaje aprobados.
  - Costo fijo estimado, TCO, costo por km y mantenimiento por km.
- **Flota 360° (`get_fleet_360_view`, `SECURITY INVOKER`):** una sola llamada consolida:
  - ficha técnica, estado y elegibilidad con motivos;
  - fallas abiertas e históricas y OT;
  - preventivos con proyección;
  - inspecciones, neumáticos montados y documentos;
  - costos, lecturas de odómetro y viajes;
  - fotografías y evidencias;
  - historial auditado.
- **UI:**
  - Ficha 360 con pestañas: Resumen, Fallas, OT, Preventivos, Inspecciones, Neumáticos, Documentos, Costos, Operación, Evidencias e Historial, y banner de elegibilidad.
  - Lista de Flota: placa bloqueada al editar y motivo visible cuando no se permite eliminar.

## Pruebas

`supabase/tests/f1_activos_flota360.test.sql` — **10/10 PASS**

| # | Caso | Resultado esperado |
|---|---|---|
| T1 | Alta del activo | Identidad normalizada, entra `OBSERVADA`, espejos sincronizados y registro de alta |
| T2 | Cambios del maestro | Auditados campo por campo con el usuario |
| T3/T4 | Cambio de placa / retroceso del odómetro | Rechazados |
| T5 | Código interno duplicado | Rechazado |
| T6 | Equipo no vehicular | Identificado por código; el horómetro no retrocede |
| T7 | TCO | Excluye OT canceladas; costo por km correcto |
| T8 | Eliminación | Activo con historia: bloqueada; activo nuevo: permitida |
| T9 | Ficha 360 | Consolidada correctamente |
| T10 | Inserción de auditoría desde el cliente | Rechazada |
| T11 | Usuario sin permiso | No ve el historial |

Regresión: F2 19/19, F3 16/16, F4 17/17 y `cmms_regresion` PASS. `tsc` y lint de los archivos nuevos OK.

## Observaciones

- **Integraciones pendientes.** Multas y siniestros (F9) y contratos de alquiler (F11) se agregarán a la ficha y al TCO en sus fases.
- **Ruta de la App.** `src/app/app/(app)/mantenimiento/flota/[plate]/page.tsx` es un marcador que no se enlaza desde ninguna parte. Se evalúa en la auditoría final junto con el build de Capacitor.
