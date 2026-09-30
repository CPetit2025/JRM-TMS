# Gastos de OT, subcontrato o error (regularización)

Para montacargas, grúa, estiba, maniobras, peajes, penalidades u otros gastos que corresponden a una OT, a un
subcontrato o a un error, y que no vinieron de un despacho ni de Caja.

## Dónde se registran

- **Contratos → Servicios de Contrato → Registrar**, o desde la ficha de la OT, pestaña **Gastos** → *Registrar gasto a la OT*
  (abre el formulario con la OT elegida).
- Se elige la OT, el subcontrato o el error. La categoría se completa sola según el tipo.
- Se indican el tipo de gasto, el monto, la fecha, el proveedor (RUC y razón social si es tercero), las guías y las horas (montacargas).

## Partida

- El gasto **descuenta la partida de transporte**: la del propio contrato o, si no tiene (lo normal en subcontratos y
  errores), la del contrato madre más cercano. El formulario indica "descuenta la partida de …".
- Sin saldo no se registra: primero se amplía la partida. El Administrador puede registrar históricos que exceden el saldo.
- Editar el monto ajusta esa misma partida.

## Historial y anulación

- Cada gasto queda en el historial de la OT (`contract_services`). La pestaña **Gastos** de la ficha muestra los de
  la OT y los de sus subcontratos y errores, con el total vigente.
- **Anular** (detalle del gasto): exige motivo, devuelve el monto a la partida y el gasto queda como ANULADO con el
  motivo. Los costos que vienen de un despacho se corrigen desde Despacho o Caja. Los gastos facturados o pagados
  solo los anula el Administrador.

Funciones: `register_contract_service`, `update_contract_service_amount`, `void_contract_service` y
`contract_budget_owner` (migración `20260930130000_gastos_ot_regularizacion.sql`). Prueba: `caja_c15_gastos_ot.test.sql`.
