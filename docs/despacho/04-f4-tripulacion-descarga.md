# F4 · Tripulación y costos de descarga amarrados a la partida

Migración: `supabase/migrations/20260929210000_despacho_f4_tripulacion_descarga.sql` · Prueba: `supabase/tests/caja_c10_tripulacion_descarga.test.sql`

## Tripulación

- En el detalle del despacho (Gestión de Despachos), el Supervisor de Transporte agrega ayudantes, auxiliares, estibadores,
  montacarguista u operador de grúa desde **Maestros → Trabajadores** (puestos Auxiliar de Transporte, Auxiliar de Despacho,
  Líder de Recepción, Montacarguista, Operador de Grúa).
- Solo mientras el despacho está PROGRAMADO. El conductor del despacho no puede ir como tripulación y un trabajador no
  puede estar en dos despachos activos. Al cancelar el despacho la tripulación queda libre.
- El conductor ve su tripulación en **Ruta Activa** del app.

## Costos de descarga (montacargas, grúa, estiba, otros)

| Paso | Quién | Dónde | Efecto en la partida de transporte del contrato |
|---|---|---|---|
| 1. Estimar | Contratos | Formulario de la solicitud | Suma al flete para validar el saldo: si no alcanza, la solicitud queda **OBSERVADA**. Al aprobarse se reserva flete + descarga (F2). |
| 2. Planificar | Transporte | Detalle del despacho → "Guardar planificación" | Al programar, la reserva de la solicitud cede su lugar al flete; lo planificado de descarga se reserva aquí. Sin saldo no se planifica. |
| 3. Costo real | Caja o Despacho/Contratos | Aprobación del gasto de Caja (Alquiler de equipo, Cuadrilla/Estiba) o botón "Real" con factura | La reserva planificada se libera y el costo real se **consume**; queda un servicio de contrato (MONTACARGA, GRUA, ESTIBA, OTROS) ligado al despacho. |

- **Sin duplicar:** cada gasto de Caja consume una sola línea. Si Caja revierte la aprobación, el servicio se anula, el
  consumo se devuelve y la reserva planificada se restituye.
- Un gasto de descarga aprobado sin planificación previa crea una línea "No planificado · gasto de Caja" y consume igual.
- Si una parada sale del despacho (reprogramación o cancelación) su descarga planificada se libera.
- "Anular" una descarga planificada que no se hará libera la reserva.
- Registrar un servicio de descarga a mano en *Servicios de Contrato* además del gasto de Caja lo contaría dos veces:
  use el flujo del despacho.

## Otros cambios

- El formulario de solicitudes ya no bloquea en el navegador una solicitud que supera el saldo: avisa y la registra como
  OBSERVADA (regla F2).
- *Servicios de Contrato* admite el tipo **Grúa**.
- El workflow de despliegue reconoce pruebas de dos dígitos (C10+).
