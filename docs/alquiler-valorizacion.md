# Valorización de alquiler seco — CJS716 (Hyundai H100, Transportes Valeriani)

Migración `20261005120000_alquiler_valorizacion.sql` · prueba `supabase/tests/caja_c33_alquiler_valorizacion.test.sql`.

## Qué se cargó (solo agosto y setiembre 2026)

Del Excel `VALORIZACION_ALQUILER_CJS716_H100_-_AGOSTO_SETIEMBRE.xlsx`:

| Dato | Destino |
|---|---|
| Hoja BD CJS716 (89 viajes: guía, OT/OC, área, conductor, cliente, zona, destino, km) | `lease_usage_records` |
| GPS diario de setiembre (30 días: km, odómetro, tiempo, paradas) | `lease_gps_days` |
| Condiciones del contrato | `vehicle_lease_contracts` (contrato de CJS716 desde 01/08/2026) |
| Liquidaciones | `lease_settlements` de agosto y setiembre en **BORRADOR** |

Estos registros se usan **solo** para agosto y setiembre. Desde octubre los km salen del sistema.

## Factores del Excel

- Alquiler mensual S/ 3.676,92 sin IGV (maquinaria seca: sin conductor ni combustible).
- Base de 26 días: el costo diario es alquiler / 26 = S/ 141,42. Se usa para descontar los días fuera de servicio.
- 3.900 km incluidos por mes. El km adicional se cobra a S/ 1,9428 (km incluido 3.676,92 / 3.900 = 0,9428, más S/ 1).
  El tramo de 4 decimales se guarda en `excess_km_rate_exact`.
- Garantía de S/ 2.000.
- Los km de cada viaje son ida y vuelta. En agosto son estimados por destino; en setiembre, el GPS del día repartido entre los viajes.
- Los fletes facturados al cliente no forman parte del alquiler.

| Mes | Km | Exceso | Monto exceso | Subtotal | Total con IGV |
|---|---|---|---|---|---|
| Agosto | 4.293 | 393 | S/ 763,52 | S/ 4.440,44 | S/ 5.239,72 |
| Setiembre | 3.981 | 81 | S/ 157,37 | S/ 3.834,29 | S/ 4.524,46 |

**Observación:** en setiembre el GPS del arrendador registra 4.727,38 km. Hay 746,38 km en días sin viaje registrado,
que la valorización no cobra. La liquidación los muestra como "km fuera de ruta" para revisarlos con el arrendador.

## Desde octubre: km por rutas del sistema

El contrato tiene `km_source = 'RUTA'`. `calculate_lease_settlement` toma los km así:

1. Valorización importada, si existe en el periodo (solo agosto y setiembre).
2. Rutas del sistema (`lease_route_trips`): por cada despacho de la placa en el periodo (sin cancelados), toma odómetro
   de cierre − odómetro de salida del checklist. Si falta, usa el km de GPS de la app (`actual_distance_km`). Si no hay
   ninguno, el viaje figura como "sin km" para completar el checklist de retorno.
3. Odómetro del periodo (comportamiento anterior, por defecto en los demás contratos).

El GPS del arrendador o las lecturas de odómetro quedan como control (km fuera de ruta).

## Pendientes

- Completar el RUC de Transportes Valeriani en Maestros › Transportistas. Se creó con `PEND-VALERIANI`.
- Aprobar las liquidaciones de agosto y setiembre. Debe hacerlo un usuario distinto al que las registró, en
  Flota › Liquidaciones de alquiler.

## Documento, envío por correo y alerta del día 1

Migración `20261005130000_alquiler_envio_mensual.sql` · prueba `supabase/tests/caja_c34_alquiler_envio.test.sql`.

**Documento.** En Flota › Liquidaciones de alquiler, botón **Documento**. Es un A4 para presentar al arrendador:
- **Página 1:**
  - partes (arrendador y arrendatario), unidad y periodo;
  - resumen: km recorridos frente a los incluidos, km adicionales, días con viajes y total a pagar;
  - condiciones del contrato;
  - detalle del cálculo con la fórmula aplicada, IGV, total e importe en letras;
  - sustento del recorrido (fuente de km y control GPS), nota de fletes y firmas.
- **Anexo:** detalle de viajes, con 32 por página y el total.

Mientras la liquidación no esté aprobada, el documento lleva la marca de agua **BORRADOR**.

**PDF.** Se descarga con **Descargar PDF**. Son las mismas páginas del documento, en A4 (`Liquidacion_alquiler_<placa>_<AAAA-MM>.pdf`).

**Envío por correo** (botón **Enviar por correo**):
1. Para, CC, asunto y mensaje salen ya llenos con el resumen. Para y CC se toman del correo guardado en el contrato o del
   arrendador.
2. **Compartir PDF** (en Windows, Android o iPhone con Chrome o Edge) abre Outlook, Correo o WhatsApp con el PDF adjunto.
   **Outlook web**, **Gmail** y **Programa de correo** abren el correo listo y descargan el PDF para adjuntarlo.
3. **Marcar como enviada** registra la fecha, los destinatarios, el medio y el usuario en `lease_settlement_sends`. La
   liquidación aprobada no se modifica.

**Alerta mensual.** `lease_envio_recordatorio()` corre todos los días a las 08:05 con pg_cron:
- **Día 1:** la campana avisa a Flota y a Caja-Liquidaciones que hay que enviar la liquidación del mes anterior de cada
  contrato activo, con un enlace que la abre directamente.
- **Desde el día 3:** si sigue sin enviarse, avisa a diario como atrasada.
- En la página, un aviso arriba lista lo pendiente del mes con el botón **Abrir y enviar**, o **Preparar cálculo** si
  aún no se registró.

El sistema no tiene un servidor de correo propio. El envío sale desde el correo del usuario (Outlook o Gmail) y el
sistema guarda el registro.
