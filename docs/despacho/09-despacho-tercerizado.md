# Despacho tercerizado (unidad de un transportista que no usa el app)

Cuando una entrega se terceriza, la unidad y el chofer no están en Flota ni en Trabajadores y el proveedor no usa el
app del conductor. El viaje se maneja igual que uno propio (solicitudes, guía, partida de la OT), pero el avance lo
registra Despacho / Torre de Control desde la web, o el chofer del tercero desde un enlace.

## Flujo

1. **Programar** — Despacho → *Armar ruta* → *Unidad propia / Tercero*. En *Tercero* se elige el transportista
   (Maestros → Transportistas, tipo proveedor) y se escriben placa, chofer, celular y, si se tiene, DNI o licencia.
   El flete es el monto pactado o, si se deja vacío, el del tarifario. Se reserva en la partida de transporte de la
   OT y queda como servicio FLETE a nombre del proveedor (RUC). No hay checklist pre-ruta ni GPS.
2. **Guía** — la Asistente Documentario confirma la guía de remisión antes de la salida, igual que en un despacho
   propio (sin guía confirmada la salida se bloquea).
3. **Salida** — botón *Registrar salida* en la lista: hora real (pasa a *En ruta*).
4. **Entregas** — *Registrar entregas*: por parada, hora, quién recibió y foto de la guía firmada o de la
   constancia que mande el proveedor (por ejemplo, por WhatsApp). La foto queda en la galería de evidencias del
   despacho. Con todas las paradas entregadas el despacho pasa a *Entregado*.
5. **Enlace para el chofer (opcional)** — en la misma ventana, *Generar enlace* y *Enviar por WhatsApp*. El chofer
   abre `/tracking/entrega/<token>` en su celular, marca *Ya salí* y registra cada entrega con foto, sin cuenta ni
   app. El enlace vale solo para ese viaje, vence 3 días después de la salida programada, se puede anular y deja de
   valer al cerrar la ruta. No muestra costos.
6. **Cerrar ruta** — igual que siempre: consume la partida, las solicitudes pasan a atendidas y el despacho a
   *Liquidado*.

## Indicadores

- El despacho tercerizado no tiene conductor propio: no entra en los indicadores de los conductores.
- **Maestros → Transportistas → Desempeño de transportistas tercerizados**: viajes, cerrados, salida puntual (hasta
  30 min después de la programada), entrega a tiempo (hasta la fecha requerida de la solicitud), horas en ruta y flete.
- En Despacho, filtro *Unidad: flota propia / tercerizada* y etiqueta *Tercero*. En Reportes → Transporte el detalle
  indica *Unidad: Tercerizada* y el chofer aparece como «(tercero)».
- La hora real de salida y de entrega se usa en el historial de estados (`kpi_dispatch_log`) para los indicadores de
  Despacho.

## Técnico

- Migración `20261006160000_despacho_tercerizado.sql`: columnas `dispatches.modalidad`, `carrier_id`, `tercero_*`;
  tablas `dispatch_tercero_entregas` y `dispatch_tercero_enlaces`; funciones `schedule_dispatch_tercero`,
  `tercero_registrar_salida`, `tercero_registrar_entrega`, `tercero_avance`, `tercero_generar_enlace`,
  `tercero_revocar_enlace`, `tercero_desempeno` y, solo para la llave de servicio, `tercero_enlace_info`,
  `tercero_enlace_salida`, `tercero_enlace_entregar`.
- `/api/tercero/[token]` valida el enlace, sube la foto a `driver_evidence/tercero/<despacho>/` y registra la
  salida o la entrega. La página pública reduce la foto a 1600 px antes de enviarla.
- Prueba `supabase/tests/caja_c41_despacho_tercerizado.test.sql` (8 casos).
