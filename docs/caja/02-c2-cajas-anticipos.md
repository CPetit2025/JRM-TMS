# Caja C2 — Cajas, anticipos, cuenta corriente y liquidación del viaje

Fecha: 2026-09-29 · Migración: `20260929100000_caja_c2_cajas_anticipos.sql`

## Hallazgos corregidos

| Severidad | Hallazgo |
|---|---|
| Crítico | `/caja/liquidaciones` solo listaba viajes con `liquidation_data`: los gastos de viajes sin cierre del conductor nunca se revisaban ni llegaban al TCO. |
| Alto | "Aprobar y liquidar" ponía `dispatches.status = 'LIQUIDADO'` saltándose la máquina de estados; ese estado ya lo usa el cierre de ruta GPS. |
| Alto | No se registraba el dinero entregado al conductor (`cash_funds` sin uso), ni saldos, devoluciones o reembolsos. |
| Medio | El "total declarado por el conductor" siempre era 0 (la app no lo enviaba) y la app de liquidación buscaba el viaje por `driver_name`. |

## Implementado

- **Cajas** (`cash_boxes`): caja chica, de ruta, cuenta bancaria o tarjeta, por sede, con mínimo (alerta de reposición) y fondo fijo.
  Las de efectivo no permiten egresos mayores al saldo.
- **Libro de movimientos** (`cash_movements`) inmutable: apertura, reposición, retiro, anticipo, vale de gasto,
  devolución, reembolso, ajuste de arqueo y reversión. Saldos en `vw_cash_box_balances`.
- **Arqueo diario** (`close_cash_box`): sistema vs conteo; la diferencia exige explicación y se asienta como ajuste.
- **Anticipos** (`trip_advances`): solicitado → entregado (egreso de caja) → rendido; anulación con motivo
  (entregado: solo Administrador, con reversión). **Bloqueo**: un conductor con rendiciones vencidas
  (`settlement_due_hours`, 48 h por defecto) no recibe anticipos nuevos salvo autorización del Administrador con motivo.
- **Pagador del gasto** (`paid_by`): `CONDUCTOR` (del anticipo, entra a su cuenta), `CAJA` (vale de una caja: el egreso
  se asienta al aprobarse y se revierte si se revierte la aprobación) o `EMPRESA` (crédito o transferencia).
- **Liquidación del viaje** (`trip_settlements`), independiente del estado operativo del despacho:
  - `preview_trip_settlement` muestra totales y bloqueos (viaje en curso, gastos pendientes u observados, anticipos sin entregar).
  - `close_trip_settlement`: saldo = anticipos − gastos aprobados del conductor. Saldo > 0: devolución (ingreso a caja)
    o descuento por planilla (con autorización); saldo < 0: reembolso (egreso). Nadie liquida su propio viaje.
    Cierra los anticipos (RENDIDO) y bloquea el viaje para gastos nuevos.
  - `reopen_trip_settlement` (solo Administrador, con motivo): revierte el movimiento y reabre.
  - `acknowledge_trip_settlement`: conformidad del conductor desde la app.
- **Cuenta corriente del conductor** (`vw_driver_cash_account`, `vw_driver_cash_ledger`): cargos, abonos, saldo,
  gastos por aprobar, antigüedad y rendiciones vencidas.
- **Estado financiero por viaje** (`vw_caja_trip_status`), fuente de Liquidaciones, del panel y de las alertas de vencimiento.
- `cash_funds` (prototipo) queda como histórico de solo lectura; `/caja/fondos` redirige a `/caja/cajas`.

## Pruebas

`supabase/tests/caja_c2_cajas_anticipos.test.sql` — **12/12 PASS**

| # | Caso |
|---|---|
| T1 | Caja chica: apertura, retiro con motivo y sin sobregiro |
| T2 | Anticipo solicitado y entregado por el Jefe; egreso en el libro; el conductor lo ve |
| T3 | Vale de caja se asienta al aprobar y se revierte con la revisión |
| T4 | La liquidación se bloquea con el viaje en curso y gastos pendientes |
| T5 | Cierre con devolución: ingreso a caja, anticipo rendido, viaje bloqueado, cuenta en cero |
| T6 | Saldo a favor del conductor ⇒ solo reembolso |
| T7 | Rendición vencida bloquea anticipos; el Administrador autoriza con motivo |
| T8 | Reembolso, reapertura (solo Administrador, con reversión) y conformidad del conductor |
| T9 | Arqueo con diferencia: motivo obligatorio, ajuste en el libro, uno por día |
| T10 | El libro es inmutable |
| T11 | Sin permisos no ve cajas ni anticipos; el conductor no gestiona anticipos ni liquida |
| T12 | Combustible desde Caja web pagado con caja: odómetro de la unidad y egreso al aprobar |
