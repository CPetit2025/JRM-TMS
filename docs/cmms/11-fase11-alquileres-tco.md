# Fase 11 — Contratos, alquileres, liquidación y TCO

Fecha: 2026-09-28 · Migración: `20260928130000_f11_alquileres_tco.sql`

## Hallazgos corregidos

| Severidad | Hallazgo |
|---|---|
| Crítico | La liquidación de alquiler seco usaba los **km estimados** de los despachos, no el uso real. Además no se guardaba ni se aprobaba (solo se imprimía). |
| Alto | Solo el Administrador podía ver los contratos: la única política era `tms_admin_full_access`. |
| Alto | Sin tarifas diaria/horaria/por km, sin renovación y sin control de traslapes. |
| Alto | El TCO (`vw_asset_tco`) solo sumaba mantenimiento, con una fórmula distinta a la de la ficha 360. |

## Implementado

- **Contratos de alquiler seco:**
  - Tarifa `MENSUAL`, `DIARIA`, `HORARIA` o `KM`.
  - Km y horas incluidos, y tarifas de exceso.
  - Descuento opcional por indisponibilidad.
  - Condiciones y penalidades pactadas, y código único.
  - **Sin traslapes** de contratos activos para la misma unidad.
  - La propiedad de la unidad en el maestro se sincroniza (`ALQUILADO`).
  - Renovación encadenada: el contrato anterior queda `RENOVADO` y el nuevo empieza al día siguiente.
  - El contrato existente en producción se migró como tarifa `MENSUAL`.
- **Liquidación (`calculate_lease_settlement` → `create_lease_settlement` → `decide_lease_settlement`):**
  - Considera solo los días de vigencia del contrato dentro del periodo.
  - Km y horas **reales**, tomados de las lecturas auditadas del periodo.
  - Excesos prorrateados en contratos mensuales.
  - **Descuento por indisponibilidad**: días de las OT del periodo, a la tarifa diaria equivalente.
  - Otros descuentos, penalidades, consumos y costos adicionales; exigen sustento.
  - IGV 18 %.
  - Una liquidación por periodo.
  - La aprueba un usuario distinto a quien la elaboró; una vez aprobada es inmutable y no se edita desde el cliente.
- **Libro de costos por activo (`vw_vehicle_cost_ledger`), fuente única del TCO:**

  | Categoría | Origen |
  |---|---|
  | Mantenimiento | Costos de OT no canceladas |
  | Operación y combustible | Gastos de viaje aprobados |
  | Neumáticos | Km recorridos en la unidad × costo por km del neumático |
  | Multas | Pagadas por la empresa |
  | Siniestros | Costo neto de seguro |
  | Alquiler | Liquidaciones aprobadas |

  Mantenimiento y liquidación no se mezclan: cada uno aporta su propia línea al activo.
- **`vehicle_tco_analytics` y `vw_asset_tco` se derivan del libro:**
  - TCO por categoría, costo por km, mantenimiento por km y costo por hora.
  - Serie mensual por activo y propiedad.
  - El costo fijo estimado se muestra aparte, fuera del TCO real.
- **RLS:** contratos y liquidaciones legibles con `mantenimiento-flota` o `caja-liquidaciones` según la sede; escritura con `flota`.
- **UI:**
  - Contratos con tarifas, condiciones y renovación.
  - Liquidación con cálculo previo, registro, aprobación o anulación e impresión con firma.
  - "Finanzas y TCO" por categoría, comparación propios vs alquilados, serie mensual y costo por km/hora. Agregada al menú.

## Pruebas

`supabase/tests/f11_alquileres_tco.test.sql` — **9/9 PASS**

| # | Caso | Resultado esperado |
|---|---|---|
| T1 | Contrato | Código generado, propiedad `ALQUILADO` en el maestro; traslape rechazado |
| T2 | Liquidación de agosto | 31 días, 4 000 km reales, base 3 100, exceso 1 000 km × 1,5, descuento por 2 días (200), total 5 192 |
| T3 | Registro | Penalidad sin sustento rechazada; subtotal 4 500; periodo duplicado rechazado |
| T4 | Aprobación | Aprobada e inmutable |
| T5 | Tarifa diaria desde el día 16 | 16 días × 120 |
| T6 | Tarifa horaria | Horómetro real 60 h × 50 |
| T7 | Renovación | Encadenada; la propiedad sigue `ALQUILADO` |
| T8 | TCO | Alquiler 4 500 + neumáticos 1 000 (2 000 km × 0,5) + multa 300 = 5 800; costo por km sobre el odómetro; serie mensual |
| T9 | Usuario sin permisos | No consulta, no liquida ni ve contratos |

Regresión: F1 a F10 y `cmms_regresion` PASS (F1 T7 valida `vehicle_tco_analytics` sobre el libro).
