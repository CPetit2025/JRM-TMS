# C5 · Anticipos por motivo (con o sin viaje)

Hasta C4 todo anticipo pertenecía a un viaje. Pero hay eventos sin ruta: un neumático que se repara, una
avería, un trámite de la unidad. En C5 cada anticipo tiene un **motivo** que define sus reglas, y queda
**cargado a** un viaje, una unidad o un área.

## Catálogo de motivos (`advance_reasons`, editable en /caja/tarifario → Motivos de anticipo)

| Motivo | Ruta | Cargo | Evidencia | Aprueba | Tope sin aprobación | Rendir en | Emergencia | Falla a Mantenimiento |
|---|---|---|---|---|---|---|---|---|
| Viáticos de ruta | Sí | Viaje | – | Caja | – | Con el viaje | No | No |
| Neumático: reparación o cambio | No | Unidad | Obligatoria | Jefe de Distribución | S/ 800 | 24 h | Sí | Sí |
| Mecánica de emergencia / auxilio / grúa | No | Unidad | Obligatoria | Jefe de Distribución | S/ 1 500 | 24 h | Sí | Sí |
| Trámites de la unidad | No | Unidad | Obligatoria | Caja | S/ 600 | 72 h | No | No |
| Otros | No | Área | Opcional | Jefe de Distribución | S/ 300 | 48 h | No | No |

- **Aprobación**: pasa por el Jefe de Distribución (permiso `caja-aprobacion`) si el motivo lo exige, si el
  monto supera el tope o si el conductor tiene rendiciones vencidas. Sin aprobación Caja no puede entregarlo.
- **Emergencias**: se pueden pedir aunque haya rendiciones vencidas. Quedan marcadas (`overdue_flag`) para que
  el aprobador lo vea, y una vez aprobadas se entregan sin la autorización extra del Administrador. Los motivos
  comunes siguen bloqueados.
- **Falla**: los motivos de emergencia de la unidad reportan la falla a Mantenimiento
  (`submit_maintenance_request_v2`) y la vinculan al anticipo. Si ese reporte falla, el anticipo igual se registra.

## Flujo del ejemplo (neumático sin ruta)

1. App → Anticipos → *Solicitar anticipo* → motivo "Neumático", placa, foto, monto y descripción
   (`request_advance_from_app`). Se crea la falla en Mantenimiento.
2. El Jefe aprueba o rechaza en /caja/anticipos → *Por aprobar* (`review_advance_request`).
3. Caja entrega desde una caja (`deliver_trip_advance`). Se fija el plazo de rendición (`due_at`).
4. El conductor rinde desde la app con la boleta (`register_advance_expense`). El gasto va a la bandeja de
   aprobación de gastos como "Sin viaje · Rinde ANT-…".
5. Caja liquida el anticipo (`preview_advance_settlement` / `close_advance_settlement`): devolución, descuento
   por planilla o reembolso. El conductor da su conformidad desde la app.
6. El gasto aprobado queda en el **TCO de la unidad** (vw_vehicle_cost_ledger) y no en la rentabilidad de un viaje.
   Un gasto de motivo "Área" no se carga a ninguna unidad.

## Cambios de datos

- `trip_advances`: `dispatch_id` pasa a ser opcional. Se agregan `reason_code`, `vehicle_plate`, `evidence_url`,
  `context_dispatch_id` (viaje en curso como referencia), `maintenance_request_id`, `needs_approval`,
  `approved_by/at`, `approval_comment`, `due_at` y `overdue_flag`.
- `trip_settlements`: `advance_id` (liquidación de un anticipo sin viaje). Exactamente uno de `dispatch_id` o `advance_id`.
- `dispatch_expenses`: `advance_id`. Un gasto sin viaje ni placa solo existe como rendición de un anticipo.
- Vistas: `vw_caja_advances` (anticipos con motivo, rendición y liquidación) y `vw_driver_cash_account.overdue_advances`.
- Compatibilidad: `request_trip_advance_from_app` (C4) sigue funcionando y equivale al motivo "Viáticos de ruta".
