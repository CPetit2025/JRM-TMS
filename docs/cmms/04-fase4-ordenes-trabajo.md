# Fase 4 — Órdenes de Trabajo

Fecha: 2026-09-27 · Migración: `20260927120000_f4_ordenes_trabajo.sql`

## Hallazgos corregidos

| Severidad | Hallazgo |
|---|---|
| Crítico | La página `gestor-ot` era un marcador vacío: no existía gestión de OT en la UI. |
| Crítico | El stock se descontaba **dos veces** al cerrar una OT: `process_work_order_completion` y `update_stock_from_inventory_transaction`. |
| Crítico | `spare_parts`, `inventory_transactions` y `work_order_spare_parts` tenían RLS "todo permitido": cualquier usuario podía alterar el stock. |
| Alto | Tres fórmulas de costo distintas en conflicto: campos de la OT, `work_order_costs` y movimientos de inventario. |
| Alto | Se podía cerrar una OT desde cualquier estado. Además, con `APTO_CON_OBSERVACION` la unidad no se liberaba (observación abierta de F2). |
| Alto | Al cerrar un despacho con la unidad `NO_APTO`, la unidad quedaba en `EN_OPERACION` (observación abierta de F2). |
| Medio | La indisponibilidad terminaba en `TERMINADA` (antes de validar) y se medía en horas enteras. |

## Implementado

- **Máquina de estados por RPC (`transition_work_order`):**
  - Flujo: `BORRADOR` → `APROBADA` → `PROGRAMADA` → `EN_PROCESO` ⇄ `EN_ESPERA` → `TERMINADA` → `VALIDACION` → `CERRADA`.
  - `CANCELADA` es posible desde los estados no finales.
  - Hay retrabajo: se puede volver de `TERMINADA`/`VALIDACION` a `EN_PROCESO`.
  - Requisitos por estado: fecha para programar, actividades para terminar y motivo para cancelar.
  - Se registra quién y cuándo aprobó, validó y cerró.
- **Indisponibilidad real:**
  - `EN_PROCESO` pasa la unidad a `MANTENIMIENTO` e inicia el conteo. Si la OT viene de una falla crítica, el conteo empieza en la hora del reporte.
  - El conteo termina al cerrar o cancelar. `downtime_hours` se guarda en horas con decimales.
- **Libro único de costos (`work_order_costs`):**
  - Categorías `MANO_OBRA`, `REPUESTOS`, `SERVICIOS` y `OTROS`.
  - Los totales de la OT se derivan por trigger.
  - Una OT cerrada o cancelada no admite cambios.
  - Los repuestos solo entran por `consume_work_order_part`.
- **Inventario con una sola ruta:**
  - `consume_work_order_part` registra la salida en el kardex, la línea de consumo y el costo.
  - El descuento de stock ocurre en un único trigger, con bloqueo de fila y **sin stock negativo**.
  - Los movimientos son inmutables: se corrigen con un `AJUSTE`.
  - Los datos legados (`part_id`, `transaction_type`) se normalizan.
- **Cierre (`complete_maintenance_order`):**
  1. Exige que la OT esté en `TERMINADA` o `VALIDACION`.
  2. Registra los repuestos declarados al cierre.
  3. Cierra las fallas de origen.
  4. Actualiza el plan preventivo (km, fecha y horas).
  5. Libera la unidad si el motor no la declara `NO_APTO` (`APTO_CON_OBSERVACION` sí libera) y guarda el resultado en `release_result`.
- **Cierre de despacho:** si la unidad no es elegible, pasa a `OBSERVADA`.
- **Guards:** el cliente no puede cambiar directamente estado, aprobación, tiempos ni totales.
- **RLS:** lectura y escritura por sede con `mantenimiento-ot`. Solo el administrador inserta movimientos manuales.
- **Vista `vw_work_orders`:** unidad, plan, proveedor, responsable, mecánico, costos e indisponibilidad (en curso o cerrada).
- **UI Gestor de OT:**
  - Indicadores: abiertas, en ejecución, por validar, costo del mes y MTTR a 30 días.
  - Filtros, búsqueda y alta manual.
  - Detalle con acciones de estado, asignaciones, diagnóstico y tareas, costos, consumo de repuestos, evidencias (bucket `evidence`), bitácora y resultado de elegibilidad al cierre.

## Pruebas

`supabase/tests/f4_ordenes_trabajo.test.sql` — **17/17 PASS**

| # | Caso | Resultado esperado |
|---|---|---|
| T1 | Alta de OT desde el cliente | Entra en `BORRADOR` |
| T2 | Transición inválida o cambio directo de estado | Rechazados |
| T3 | Aprobación | Se registra quién y cuándo |
| T4 | Inicio de trabajos | Unidad en `MANTENIMIENTO` y comienza la indisponibilidad |
| T5 | Costos de mano de obra y servicios | Totales derivados correctos |
| T6 | Repuesto ingresado como costo directo | Rechazado |
| T7 | Consumo de repuesto | Stock, kardex, costo y línea de consumo, una sola vez |
| T8 | Consumo mayor al stock | Rechazado; el stock no queda negativo |
| T9 | Edición de un movimiento de inventario | Rechazada |
| T10 | Requisitos previos al cierre | Solo desde `TERMINADA`/`VALIDACION`; `TERMINADA` exige actividades |
| T11 | Cierre | `CERRADA`, tiempos y costos correctos; la unidad se libera (`APTO_CON_OBSERVACION`) |
| T12 | OT cerrada | No admite cambios |
| T13 | Falla crítica → OT | Indisponibilidad desde el reporte (≥5 h); con SOAT vencido la unidad no se libera |
| T14 | Cancelación | Exige motivo |
| T15 | Cierre de despacho con unidad `NO_APTO` | La unidad pasa a `OBSERVADA` |
| T16 | Vista `vw_work_orders` | Datos correctos |
| T17 | Usuario sin permisos | No opera ni ve costos/kardex; no inserta movimientos |

Regresión: F2 19/19, F3 16/16 y `cmms_regresion` PASS. La regresión ahora recorre el flujo completo de la OT.

## Observaciones

- **Datos de producción.** Las unidades reales no tienen SOAT ni revisión técnica registrados, por lo que el motor las declara `NO_APTO` al intentar liberarlas. Hay que cargar los documentos (F9).
- **Proveedores (F10).** La garantía previa a autorizar servicios y el SLA de proveedores se completan en F10.
