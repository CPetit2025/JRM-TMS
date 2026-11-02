# Ahorro por consolidación de servicios

Propuesta para aprobación. **No se modificó código.** Mide cuánto se ahorra al atender, en una misma ruta, servicios que
de otro modo habrían requerido su propio viaje: recojos, traslados y entregas aprovechados.

## Decisiones tomadas (01/11/2026)

1. **Valor independiente**: tarifa del tarifario por destino y tipo de unidad.
2. **Costo marginal**: combustible de los km extra **más** horas adicionales de unidad y tripulación.
3. **Qué cuenta**: todo servicio que comparte ruta con otro. Incluye los agregados a una ruta en curso, los
   programados juntos (multiparada), los que no tienen OT (OC/OS/RQ) y los internos.
4. **Atribución**: a la OT del servicio aprovechado, cuando la tiene, y siempre a la operación en general.

## Regla central

En cada ruta con dos o más servicios:

- **Servicio principal**: el de mayor valor independiente. La ruta existe por él, así que no genera ahorro.
- **Servicios aprovechados**: todos los demás. Para cada uno:

```
Ahorro = Valor independiente − Costo marginal
Costo marginal = combustible de sus km extra + horas extra × (costo hora de unidad + costo hora de tripulación)
```

Si el costo marginal supera al valor independiente, el ahorro es negativo y se muestra así, sin ocultarlo. Eso
indica que aprovechar ese servicio no convino.

**El ahorro no toca la partida.** Es un costo sombra que sirve para medir eficiencia. No se suma al ejecutado, no
consume presupuesto ni cambia el control presupuestal. La partida sigue registrando solo lo real.

## De dónde sale cada dato (verificado en el código)

| Dato | Fuente existente | Observación |
|---|---|---|
| Tarifa por destino y clase de unidad | `freight_rates` + `quote_transport` (contrato > cliente > general) | Se busca por **distrito**. |
| Clase de unidad que habría hecho falta | `quote_transport` sugiere la clase menor que cubre el peso de la solicitud | Sin peso, se usa la clase de la unidad real de la ruta. No se usa el referencial guardado de la solicitud: ese toma la tarifa **más baja** y en recojos vale 0. |
| Km directos de cada servicio | `dispatch_route_estimates` (OSRM, origen → destino por solicitud) | Se guarda desde el 31/10/2026 (PR #389; el nombre de la migración, 20261122…, solo ordena). Las rutas anteriores no lo tienen. |
| Km reales de la ruta | `dispatches.actual_distance_km` (GPS u odómetro) | Si falta, se usa lo estimado y queda marcado como estimado. |
| Km extra de un servicio agregado en ruta | `dispatch_service_additions.extra_km` | Se registra al agregarlo. |
| Duración directa / real | `dispatch_route_estimates.duration_min` / `departure_time` → `returned_at` | |
| Combustible por km | `vehicles.expected_km_per_gallon` y `caja_settings.fuel_price_per_gallon` | Igual que el combustible estimado de la partida. |
| Tripulación de la ruta | conductor y auxiliares de la ruta | |
| **Costo por hora de unidad y tripulación** | **No existe** | Hay que definirlo (ver pendientes). |

## Cómo se reparte lo extra en una ruta multiparada

- **Agregado en ruta**: sus km extra son los registrados al agregarlo. Sus horas extra salen de esos km a la velocidad
  media de la ruta.
- **Programados juntos**:
  - km extra de la ruta = km reales − km directos del servicio principal.
  - horas extra de la ruta = duración real − duración directa del principal.
  - Ambos se reparten entre los aprovechados según sus km directos, con redondeo exacto como en `budget_route_shares`.
- Nunca se reparten valores negativos. Si la ruta real resultó más corta que la directa del principal, el extra es 0.

## Dónde se verá

- **Control presupuestal**:
  - En el tablero, un indicador «Ahorro por consolidación» del período: total, número de servicios aprovechados y
    tasa de aprovechamiento.
  - En el detalle de cada OT, el ahorro atribuido, viaje por viaje.
- **Torre de Control**: en Costos del viaje, el ahorro de cada servicio aprovechado y la base usada (tarifa, clase,
  km y horas).
- **Reporte para Finanzas**, exportable: ahorro por período, cliente, OT y tipo de servicio. Los servicios sin OT
  quedan en «Operación general».

Todo se calcula al leer, como los movimientos del circuito económico. No hay que registrar nada a mano y no se crea
un segundo libro.

## Pendientes antes de construir

| # | Decisión | Propuesta |
|---|---|---|
| P1 | **Costo por hora** de unidad (por clase) y de tripulación (conductor, auxiliar) | Configurable en «Control presupuestal», con un valor por clase de unidad y otro por rol, cargados por Finanzas. Mientras no estén cargados, las horas no suman y el reporte lo indica. |
| P2 | **Retornos con carga** | Hoy no existen en el sistema. Para medirlos, la carga de vuelta debe registrarse como una solicitud (traslado o recojo) dentro de la ruta. Así cuenta como servicio aprovechado. |
| P3 | **Desde cuándo** | Desde el 31/10/2026, cuando empezaron a guardarse los km directos al armar la ruta. Lo anterior queda «sin dato». |
| P4 | **Peajes extra** | No entraron en la decisión 2. Propuesta: incluirlos cuando haya un gasto de Caja de peaje imputado al servicio. |

## Riesgos

- **Ahorro inflado** si la clase de unidad del valor independiente está sobredimensionada. Por eso se usa la clase
  que cubre el peso real y el reporte muestra la base usada en cada caso.
- **Distritos sin tarifa**: el servicio queda «sin valorizar» y no suma ni resta.
- La atribución a la OT es informativa: no afecta su saldo ni sus niveles 70/80/100.
