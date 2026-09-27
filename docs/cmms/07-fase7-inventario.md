# Fase 7 — Repuestos e inventario

Fecha: 2026-09-27 · Migración: `20260927200000_f7_inventario.sql`

## Hallazgos corregidos

| Severidad | Hallazgo |
|---|---|
| Crítico | La pantalla de inventario usaba columnas inexistentes (`code`, `unit`, `min_stock`) y ejecutaba `part.code.toLowerCase()` sobre `undefined`: se rompía con los 26 repuestos de producción. |
| Alto | `current_stock` era entero: los consumos decimales se truncaban. |
| Alto | Existía un kardex paralelo (`spare_part_movements`) que solo leía la IA. |
| Alto | Sin costo promedio: los consumos se valorizaban con el último precio o en cero. |
| Alto | No había reservas: dos OT podían contar con el mismo repuesto. |
| Medio | No había reposición automática ni garantías de repuestos. |

## Implementado

- **Catálogo:**
  - Código único por sede, unidad de medida, ubicación, mínimo/máximo y garantía (meses, km y condiciones).
  - Stock y costo promedio **solo cambian por movimientos**: un guard lo impone y las altas nuevas empiezan en 0.
- **Kardex único (`inventory_transactions`):**
  - Tipos `INGRESO` (exige costo; recalcula el promedio ponderado y el último precio), `SALIDA` (solo por OT) y `AJUSTE` (con motivo y permiso de supervisión).
  - Cada movimiento guarda el saldo y el costo promedio posteriores.
  - Hay un bloqueo de fila del repuesto, así que no puede haber doble consumo, y el stock no puede quedar negativo.
  - Los movimientos son inmutables (F4).
- **Reservas por OT:**
  - Disponible = stock − reservas activas de **otras** OT.
  - El consumo descuenta la reserva propia.
  - Al cerrar o cancelar la OT se liberan las reservas.
  - La OT preventiva reserva los repuestos previstos del plan (F5) y anota los faltantes.
- **Reposición:** si el disponible baja del mínimo, se genera **una** solicitud de reposición, no una orden de compra directa. Sugiere la cantidad hasta el máximo y se marca atendida cuando el ingreso normaliza el stock. Se puede aprobar o anular.
- **Garantía del repuesto instalado:** al consumir un repuesto con garantía se registra la fecha de vencimiento, el límite en km desde el odómetro de instalación, el proveedor del último ingreso y las condiciones. La vista calcula `VIGENTE`/`VENCIDA`, y la garantía se puede reclamar. F10 la usará antes de autorizar un gasto.
- **Vistas:** `vw_spare_parts_stock`, `vw_inventory_kardex` (con OT, unidad, proveedor y usuario) y `vw_parts_consumption` (por mes, unidad y repuesto).
- **Limpieza:** se elimina `spare_part_movements`. `ai_get_inventory_alerts` pasa a usar el stock disponible real.
- **UI:**
  - Pestañas: Stock (disponible, reservado y estado), Kardex, Reposición, Garantías y Consumo.
  - Catálogo con altas y edición.
  - Movimientos de ingreso y ajuste.
  - En el Gestor de OT: "Reservar" y selección de repuestos por disponible.

## Pruebas

`supabase/tests/f7_inventario.test.sql` — **14/14 PASS**

| # | Caso | Resultado esperado |
|---|---|---|
| T1 | Alta de repuesto desde el cliente | Stock y costo en cero; no editables directamente |
| T2 | Dos ingresos | Promedio ponderado 50 y 80 → 65; saldo guardado |
| T3 | Validaciones de movimiento | Ingreso sin costo, ajuste sin motivo y salida fuera de OT rechazados |
| T4 | Ajuste | Mueve el stock sin cambiar el costo promedio |
| T5 | Reservas | Lo reservado por otra OT no se consume |
| T6 | Consumo con reserva propia | Descuenta la reserva y se costea al promedio |
| T7 | Disponible bajo el mínimo | Genera una sola solicitud de reposición |
| T8 | Cancelación de OT e ingreso | Se libera la reserva y la reposición queda atendida |
| T9 | Garantía | Se registra al instalar y vence por km |
| T10 | Kardex y consumo por activo | Saldos y totales correctos |
| T11 | Preventivo | Reserva los repuestos previstos y anota los faltantes |
| T12 | Stock negativo | Imposible por RPC o por `INSERT` directo |
| T13 | IA de inventario | Datos desde la fuente real |
| T14 | Usuario sin permisos | No mueve inventario, no reserva ni ve el kardex |

Regresión: F1 a F6 y `cmms_regresion` PASS. La prueba F4 T17 ahora envía costo, para seguir verificando RLS.

## Observaciones

- **Concurrencia.** Está garantizada por el bloqueo de fila (`FOR UPDATE`) en el único trigger de stock. La prueba corre en una sola sesión, así que valida el resultado secuencial y el bloqueo por diseño, no dos sesiones reales en paralelo.
- **Datos iniciales.** Los 26 repuestos de producción tienen stock 0 y ningún costo: hay que cargar el stock inicial como `INGRESO` con costo.
