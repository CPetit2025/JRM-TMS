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
