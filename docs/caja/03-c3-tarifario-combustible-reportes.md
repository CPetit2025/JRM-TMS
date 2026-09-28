# Caja C3 — Tarifario, reglas, combustible y reportes

Fecha: 2026-09-29 · Migración: `20260929110000_caja_c3_tarifario_combustible_reportes.sql`

## Implementado

- **Tarifario de viáticos** (`route_allowance_rates`): km de la ruta (ida, con opción ida y vuelta), días y noches,
  peajes totales o por tipo de unidad (ejes), alimentación por día, hospedaje por noche, otros y precio del galón.
- **Presupuesto del viaje** (`calculate_trip_budget`, `set_trip_budget`, `trip_budgets`):
  combustible = km ÷ rendimiento esperado de la unidad × precio; se guarda por categoría y alimenta el anticipo.
- **Reglas adicionales** (alertas): gasto que lleva su categoría por encima del presupuesto + tolerancia
  (`budget_tolerance_pct`) y hospedaje en un viaje sin pernocte.
- **Categorías**: cuenta contable (PCGE sugerido) y clave de presupuesto; editables con `caja-tarifario`.
- **Parámetros** (`update_caja_settings`, solo Administrador): doble aprobación, plazo de rendición, precio de
  referencia del galón, rendimiento por defecto y tolerancias.
- **Combustible**:
  - Grifos (`fuel_stations`, creados en C1) con crédito y ciclo de facturación.
  - Facturas de grifo (`fuel_station_invoices`) conciliadas con `reconcile_fuel_invoice` contra las cargas
    no rechazadas del periodo (diferencia ≤ S/ 1 y ≤ 0,5 gal); una diferencia se acepta solo con explicación.
    Cada carga queda asociada a una sola factura.
  - Rendimiento por carga (`vw_fuel_efficiency`) y por unidad en 90 días (`vw_vehicle_fuel_summary`).
  - Rendimiento esperado y tanque por unidad (`set_vehicle_fuel_params`, sin escribir el maestro de flota).
- **Reportes**:
  - Rentabilidad por viaje (`vw_trip_profitability`): flete + refacturable − gastos aprobados, margen, costo por km,
    desglose combustible/peajes/viáticos/otros/mantenimiento y presupuesto.
  - Presupuesto vs real por categoría (`vw_trip_budget_vs_actual`).
  - Exportación contable (Excel): gastos aprobados con cuenta, centro de costo (placa), base imponible e IGV de
    facturas, y libro de caja del periodo.

## Pendiente (requiere credenciales externas)

- Validación del comprobante electrónico en SUNAT (consulta de validez de CPE): hoy se valida el RUC por dígito
  verificador y se bloquean duplicados. Integrarla requiere un token de la API de SUNAT o de un proveedor OSE.

## Pruebas

`supabase/tests/caja_c3_tarifario_combustible.test.sql` — **7/7 PASS**

| # | Caso |
|---|---|
| T1 | Tarifa ⇒ presupuesto: 600 km a 10 km/gal × S/ 16 = 960, peaje por tipo TRACTO, total 1 320 |
| T2 | Presupuesto inválido rechazado; alerta cuando el acumulado de peajes supera presupuesto + 10 % |
| T3 | Hospedaje en viaje sin pernocte |
| T4 | Cargas en grifo con crédito conciliadas; diferencia exige explicación; sin permiso no concilia |
| T5 | Rendimiento por carga (10 km/gal) y resumen por unidad |
| T6 | Rentabilidad: flete 2 000 + refacturable 300 − gastos 550 = 1 750; presupuesto vs real |
| T7 | Tarifario y categorías solo con `caja-tarifario`; parámetros solo Administrador |
