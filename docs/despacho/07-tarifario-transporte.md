# Tarifario de Transporte

Migración: `supabase/migrations/20260930100000_tarifario_transporte.sql` · Prueba: `supabase/tests/caja_c13_tarifario.test.sql`
Pantalla: **Maestros → Tarifario de Transporte** (pestaña "Tarifario de Transporte"; la de costos por KM no cambia) · Permiso: `tarifas`

## Una sola tabla: `freight_rates`
No se creó otra tabla: se amplió la de tarifas fijas existente. Las filas cargadas del Excel se conservan como
**Flete · alcance general · vigentes**, con el tipo de unidad completado desde su tipo y capacidad (p. ej. "Trailer 32 t")
y la placa como excepción.

| Campo | Uso |
|---|---|
| concepto | FLETE, PARADA_ADICIONAL, MONTACARGAS, GRUA, ESTIBA, OTROS, ESPERA_HORA |
| distrito / zona / provincia / departamento | destino (obligatorio para flete; vacío = cualquier destino en los demás) |
| tipo de unidad, capacidad | la tarifa es por tipo de unidad; la placa es solo excepción |
| alcance | General, Cliente o Contrato |
| base | por viaje, por tonelada, por servicio, por hora |
| costo / precio al cliente | costo contra la partida; precio al cliente para ver el margen |
| vigente desde / hasta, activa | nunca se borra: se desactiva o se crea una **nueva versión** (la anterior termina ayer) |

## Cálculo (`quote_transport`)
1. Tipo de unidad: el indicado, el de la placa, o el **menor que soporta el peso** y tiene tarifa a todos los destinos.
2. Tarifa por prioridad: **contrato → cliente → general**; con placa, su tarifa específica primero; se ignoran las
   inactivas y las vencidas. Sin unidad definida se toma la más alta (conservador para la partida).
3. Flete = destino de **mayor tarifa** + **monto por cada parada adicional**.
4. Descarga (montacargas, grúa, estiba…) desde el tarifario.
5. Devuelve el desglose con la tarifa usada en cada línea, el total, el precio al cliente (si todas las líneas lo tienen)
   y los destinos sin tarifa.

## Dónde se usa
- **Solicitud:** el costo es **referencial** y no lo edita el Administrador de Contratos. Al guardar, el servidor
  (`apply_request_tariff`) lo calcula con el tarifario (OT + destino + peso + recursos de descarga) y guarda el
  desglose. Los montos de descarga también salen del tarifario ("Sin tarifa" si no hay tarifa). Un cambio directo de
  `service_cost` se ignora (trigger `transport_request_cost_guard`); el ajuste manual con motivo queda solo para el
  Administrador del sistema. El costo real del flete se fija al programar en Despacho.
  "Completar montos de descarga con el tarifario" llena los montos vacíos.
- **Aprobación:** reserva ese monto (F2).
- **Despacho:** recalcula con la **placa real y todas las paradas**, muestra la diferencia con lo estimado en las
  solicitudes y guarda el desglose en el despacho (`freight_breakdown`).
- **Simulador** en el tarifario para probar contrato + distritos + peso + placa.

## Seguridad
Se eliminó la política "allow all". Leen: Despacho, Solicitudes, Clientes, Contratos, Caja y Tarifas. Edita: permiso
`tarifas` (se agregó al rol con aprobación de Caja — Jefe de Distribución).

## Precio al cliente y costo JRM (30/09/2026)

- Cada tarifa tiene dos montos: **Precio al cliente (con IGV)** y **Costo JRM**. Por defecto el costo JRM es el
  **80 %** del precio al cliente (20 % menos); se puede ajustar a mano en la tarifa.
- Las tarifas cargadas antes tenían en "costo" el precio al cliente con IGV: la migración
  `20260930140000_anulacion_autorizada_tarifa_precio_cliente.sql` pasó ese valor a *precio al cliente* y dejó el costo
  en el 80 % (solo en tarifas sin precio al cliente registrado).
- Las cotizaciones (costo referencial de la solicitud y flete del despacho) usan el **costo JRM**.
- Importación Excel: si falta `costo`, se toma el 80 % de `precio_cliente`.

## Diferencia con /caja/tarifario

`/maestros/tarifas` es el **Tarifario de Transporte**: cuánto cuesta y cuánto se cobra el servicio de flete por
destino, tipo de unidad, cliente u OT, y los recursos de descarga. Alimenta la solicitud y el despacho y descuenta la
partida del contrato. `/caja/tarifario` son las **reglas de Caja**: viáticos, peajes y combustible por ruta para los
anticipos del conductor, categorías de gasto, motivos de anticipo y parámetros de rendición. No se cruzan.
