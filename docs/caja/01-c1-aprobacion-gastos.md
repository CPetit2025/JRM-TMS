# Caja C1 — Registro y aprobación de gastos

Fecha: 2026-09-29 · Migración: `20260929090000_caja_c1_aprobacion_gastos.sql`

## Hallazgos corregidos

| Severidad | Hallazgo |
|---|---|
| Crítico | Cualquier usuario con `caja-gastos` podía aprobar gastos, incluso los suyos: la política de UPDATE no separaba registrar de aprobar. |
| Crítico | El gasto se insertaba con el estado que enviara el cliente (se podía registrar ya `APROBADO`). |
| Crítico | Los gastos `PENDIENTE` no mostraban Aprobar/Observar (solo `BORRADOR`/`EN_REVISION`): había que "Revertir" primero. |
| Alto | `/caja/gastos` guardaba el usuario de oficina en `driver_id` (FK a conductores): el registro fallaba o quedaba mal asignado. |
| Alto | Observar reemplazaba la descripción: se perdían comprobante, RUC, proveedor y "refacturar". |
| Alto | El comprobante iba concatenado en `description`: sin búsqueda, sin control de duplicados (el aviso estaba desactivado). |
| Alto | Repuestos y parchado de llantas sumaban como *Operación* en el TCO. |
| Medio | La lectura IA de la web usaba claves distintas a las que devuelve `/api/extract-invoice` (nunca completaba datos). |
| Medio | Fotos de Caja web en bucket público; los aprobadores no podían ver las fotos del conductor (bucket privado). |
| Medio | `register_fuel_expense` escribía `vehicle_odometer_logs.vehicle_id` (la tabla usa `vehicle_plate`) y no validaba quién registraba. |

## Implementado

- **Rol Jefe de Distribución** y permiso **`caja-aprobacion`** (toggle en Roles y Permisos).
- **Gasto con columnas propias**: tipo/serie/número de comprobante, RUC y razón social, fecha del gasto, refacturable,
  OT de transporte, origen (`APP`/`WEB`), placa y sede. Los registros web antiguos se migran desde la descripción.
- **Gastos sin viaje**: `dispatch_id` es opcional si se indica la placa (cargas en base, traslado a taller).
- **Reglas del registro** (trigger): siempre nace `PENDIENTE`; se completan placa/sede/conductor desde el despacho;
  un comprobante (RUC + tipo + serie + número, sin ceros a la izquierda) se registra una sola vez salvo rechazo;
  un gasto revisado no se edita; la corrección de uno observado lo devuelve a la bandeja; no se admiten gastos en
  viajes liquidados (C2).
- **Alertas automáticas** (`alerts`): sin comprobante, RUC inválido (dígito verificador), sobre el tope de la categoría,
  posible duplicado, fuera del periodo del viaje, combustible incompleto, galones sobre la capacidad del tanque,
  odómetro que retrocede y rendimiento anormal (± tolerancia sobre el km/gal esperado).
- **Revisión** `review_dispatch_expense(id, acción, motivo, monto, confirmación)`:
  - Aprobar (con confirmación si hay alertas), ajustar a un monto menor (motivo obligatorio, se conserva el original),
    observar y rechazar (motivo obligatorio), revertir (solo Administrador).
  - Nadie revisa un gasto que registró o que es suyo como conductor.
  - Doble aprobación opcional: desde el umbral, aprueba el Jefe y confirma el Administrador (usuarios distintos).
  - Historial inmutable en `dispatch_expense_events`.
- **Aprobación en lote** `approve_dispatch_expenses`: solo gastos sin alertas; devuelve los omitidos con el motivo.
- **Combustible unificado**: `register_fuel_load` (con o sin viaje) y `register_fuel_expense` (firma de la app) usan la
  misma regla; toda carga con odómetro queda en las lecturas de la unidad (auditoría si retrocede).
- **Libro de costos** (`vw_vehicle_cost_ledger`): categoría desde `expense_categories` y monto aprobado; incluye gastos sin viaje.
- **RLS**: registrar (`caja-gastos` o el conductor del viaje) ≠ corregir (quien registró, mientras esté pendiente u
  observado) ≠ aprobar (solo por RPC). Mantenimiento (dashboard) lee los gastos aprobados para el TCO.
- Vistas de apoyo sin exponer PIN ni perfiles: `vw_caja_people`, `vw_caja_trips`, `vw_caja_units`.
- Bucket privado `caja_receipts`; los aprobadores leen `driver_evidence`.

## Pruebas

`supabase/tests/caja_c1_aprobacion.test.sql` — **13/13 PASS**

| # | Caso |
|---|---|
| T1 | Rol Jefe de Distribución con `caja-aprobacion`; RUC válido/inválido |
| T2 | El registrador no fija el estado; se completan placa y sede; historial REGISTRADO |
| T3 | Registrar no es aprobar (RPC rechazada y UPDATE directo sin efecto) |
| T4 | Nadie aprueba lo propio; con alertas exige confirmación |
| T5 | Observar exige motivo; la corrección conserva el sustento y vuelve a PENDIENTE |
| T6 | Ajuste parcial con motivo; TCO con monto aprobado; repuestos → Mantenimiento, llantas → Neumáticos |
| T7 | Comprobante duplicado bloqueado (ceros a la izquierda); libre tras rechazar el original |
| T8 | Doble aprobación: Jefe pre-aprueba, Administrador confirma |
| T9 | Revertir solo Administrador; lo revisado no se edita ni se borra |
| T10 | Combustible por placa desde caja: odómetro, retroceso y tanque |
| T11 | App del conductor (firma anterior) idempotente, rendimiento anormal; tercero no autorizado |
| T12 | Aprobación en lote omite gastos con alertas |
| T13 | Sin permisos no ve gastos ni revisa; el conductor solo ve los de su viaje |
