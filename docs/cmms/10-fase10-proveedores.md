# Fase 10 — Proveedores, talleres y garantías

Fecha: 2026-09-28 · Migración: `20260928110000_f10_proveedores.sql`

## Hallazgos corregidos

| Severidad | Hallazgo |
|---|---|
| Crítico | RLS "todo permitido" en `maintenance_providers`. |
| Alto | Ocho campos de estado y puntaje redundantes (`rating`, `sla_score`, `sla_rating`, `avg_response_time_hours`, `total_services_completed`, `status`, `provider_status`, `is_active`). |
| Alto | El trigger de SLA promediaba con la fecha de la OT que disparaba el trigger, no la de cada OT, y usaba fechas de inicio en vez de aprobación. |
| Alto | No existían tarifas, cotizaciones, garantías de servicio, retrabajos ni la regla de garantía activa. |

## Implementado

- **Proveedores:**
  - Tipos: taller, repuestos, servicio externo, llantería, grúa y otro.
  - RUC validado de 11 dígitos.
  - SLA pactado en horas y garantía de servicio por defecto (días/km).
  - Estado `ACTIVO`, `SUSPENDIDO` o `INACTIVO` (`is_active` es su espejo).
  - Se eliminaron los puntajes almacenados y el trigger defectuoso.
- **Tarifario** por proveedor y vigencia.
- **Cotizaciones por OT:** aprobar una cotización asigna el proveedor a la OT y rechaza las demás. No se aprueban cotizaciones vencidas ni de proveedores no activos.
- **Garantía de servicio:** se crea automáticamente al cerrar una OT atendida por un proveedor con garantía configurada (vencimiento por días y km desde el odómetro de cierre).
- **`vw_active_warranties`:** garantías vigentes de repuestos (F7) y de servicios.
- **Regla "¿existe garantía activa?":**
  - Una OT **no se aprueba** si la unidad tiene garantías vigentes sin revisar; el error es `GARANTIA_ACTIVA` y lista las garantías.
  - `review_work_order_warranty` exige elegir `RECLAMO_GARANTIA` (marca la garantía como reclamada y registra al proveedor responsable) o `NO_CUBIERTO`, siempre con sustento.
  - Sin garantías, la aprobación queda registrada como `SIN_GARANTIAS`.
- **Datos por OT:**
  - Retrabajo: cada reapertura de `TERMINADA`/`VALIDACION` a `EN_PROCESO` suma uno.
  - `finished_at` permite medir el tiempo de atención.
  - Evaluación del proveedor 1–5, una sola vez y con la OT cerrada.
- **`vw_provider_performance`:**
  - OT totales y cerradas.
  - Tiempo de atención promedio (aprobación → terminada) y % de cumplimiento del SLA.
  - Gasto total, costo por OT, retrabajos, reclamos de garantía y calificación.
  - **Índice de calidad** (0–100): 40 % SLA + 30 % calificación + 30 % ausencia de retrabajos y reclamos.
- **RLS:** lectura con `mantenimiento-flota`/`ot` y escritura con `flota`. Las cotizaciones se filtran por la sede de la OT.
- **UI:**
  - Proveedores: pestañas de desempeño, tarifario, cotizaciones (aprobar/rechazar) y garantías vigentes.
  - Gestor de OT: panel de revisión de garantías cuando la aprobación lo exige, evaluación del proveedor al cerrar e indicador de retrabajos.

## Pruebas

`supabase/tests/f10_proveedores.test.sql` — **8/8 PASS**

| # | Caso | Resultado esperado |
|---|---|---|
| T1 | Alta de proveedor | RUC validado y normalizado; estado sincronizado con `is_active` |
| T2 | Tarifario | Tarifa registrada |
| T3 | Cotizaciones | La aprobada asigna el proveedor y rechaza las demás; vencidas o de proveedor suspendido rechazadas |
| T4 | OT con proveedor | Se aprueba `SIN_GARANTIAS`; cuenta 1 retrabajo; al cerrar crea la garantía de servicio (30 días / 5 000 km) |
| T5 | Evaluación | Única y en rango |
| T6 | Garantía activa | Bloquea la aprobación; la revisión exige sustento; el reclamo marca la garantía `RECLAMADA` y permite aprobar |
| T7 | Indicadores | SLA 100 %, 1 retrabajo, 1 reclamo, calificación 4, gasto 700, índice de calidad 64 |
| T8 | Usuario sin permisos | No ve ni decide |

Regresión: F1 a F9 y `cmms_regresion` PASS.

## Observación transversal

- **Fecha UTC en la base de datos.** Durante las pruebas se confirmó que `CURRENT_DATE` en la base es UTC: desde las 19:00 de Lima ya es "mañana". Afecta a funciones heredadas que comparan vencimientos con `CURRENT_DATE`. Se corrige de forma global en la auditoría final (zona horaria de la base: `America/Lima`).
