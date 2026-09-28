# Caja C4 — El conductor solicita anticipos desde la app

Fecha: 2026-09-29 · Migración: `20260929130000_caja_c4_anticipos_desde_app.sql`

## Antes

Solo Caja (permiso `caja-anticipos`) podía solicitar un anticipo. La app del conductor mostraba el anticipo
entregado, pero no permitía pedirlo.

## Implementado

- **`request_trip_advance_from_app(despacho, monto, motivo, desglose)`**: la usa el conductor, y solo para un viaje
  suyo que esté en curso (PROGRAMADO, EN_CURSO, EN RUTA, ESPERANDO_AUTORIZACION o RETORNO) y no liquidado.
  - Motivo obligatorio; desglose opcional por combustible, peajes, alimentación, hospedaje u otros.
  - Una sola solicitud pendiente por viaje.
  - Si tiene rendiciones vencidas no puede pedir: primero debe rendir.
  - El anticipo queda con `source = 'APP'`.
- **`withdraw_trip_advance_request`**: el conductor retira su solicitud mientras Caja no la entregue.
- **Entrega y anulación**: igual que siempre, en `/caja/anticipos` (`deliver_trip_advance`, `cancel_trip_advance`).
- **Avisos en tiempo real** (`trip_advances` agregada a `supabase_realtime`, con RLS):
  - Caja recibe "Solicitud de anticipo" cuando entra una desde la app.
  - El conductor recibe "Anticipo entregado", o "Solicitud anulada" con el motivo.
- **App del conductor, pantalla `/app/gastos`**: tarjeta de anticipos con recibido, gastado y saldo, el historial con
  su estado, el botón **Solicitar anticipo** y la opción de retirar una solicitud pendiente.
- **Web**:
  - `/caja/anticipos`: filtro "Pedidos del app", marca "App conductor" y motivo. Al entregar se ve lo ya
    entregado en el viaje frente a su presupuesto.
  - `/caja`: aviso de solicitudes por atender.

## Pruebas

En `supabase/tests/caja_c2_cajas_anticipos.test.sql` (ahora **14/14**):

| # | Caso |
|---|---|
| T13 | El conductor solicita para su viaje (motivo obligatorio); un tercero no puede; el Jefe la entrega |
| T14 | Una solicitud pendiente por viaje; el conductor la retira; con rendición vencida no puede pedir |
