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
- **Solicitud:** el costo estimado del flete se calcula solo (OT + destino + peso + descarga) y muestra el desglose.
  Se puede ajustar, pero exige **motivo**; se guarda el desglose y el origen (tarifario o manual) en la solicitud.
  "Completar montos de descarga con el tarifario" llena los montos vacíos.
- **Aprobación:** reserva ese monto (F2).
- **Despacho:** recalcula con la **placa real y todas las paradas**, muestra la diferencia con lo estimado en las
  solicitudes y guarda el desglose en el despacho (`freight_breakdown`).
- **Simulador** en el tarifario para probar contrato + distritos + peso + placa.

## Seguridad
Se eliminó la política "allow all". Leen: Despacho, Solicitudes, Clientes, Contratos, Caja y Tarifas. Edita: permiso
`tarifas` (se agregó al rol con aprobación de Caja — Jefe de Distribución).
