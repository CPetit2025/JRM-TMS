# Reporte por unidad (Flota › Reporte por unidad)

Pantalla `/flota/reporte-unidad`. Consolida kilometraje diario y por rutas, OT, OS, OC, RQ, pesos y costos imputados.
Se abre también desde Flota 360° con la placa ya elegida.

## Cómo consultar los km semanales y mensuales

1. Elija la placa y el período (hasta 13 meses) o use los accesos rápidos: Esta semana, Este mes, Mes anterior o
   Últimos 12 meses.
2. En **Ver por** cambie entre Día, Semana (lunes a domingo) y Mes.
3. **Excel** descarga el resumen diario, los km por semana y por mes, las OT, OS, OC y RQ y el detalle de servicios.

## De dónde salen los km

El reporte separa las mediciones GPS por ruta de las lecturas de odómetro. El checklist diario FR-DT 007 exige odómetro inicial con foto; la app permite iniciar la ruta aunque falte GPS. En cada parada de unidad propia el conductor registra lectura y foto del tablero. Si el tramo no tiene GPS completo, el sistema usa la diferencia respecto de la lectura previa y la asigna a ese servicio/OT. Al cerrar la ruta, el odómetro final respalda el recorrido completo.

La prioridad del detalle es:

- **GPS completo**: puntos GPS completos para el tramo.
- **Odómetro**: lectura de tablero con foto cuando falta GPS completo.
- **GPS parcial**: se conserva como dato de referencia si no se dispone de lectura de odómetro.
- **Estimado**: km estimados al programar la ruta; se presenta por separado y no se trata como recorrido medido.

El recorrido diario de odómetro sigue disponible para conciliar el kilometraje de la unidad. Los reportes semanales y mensuales priorizan recorridos reales de ruta, muestran km GPS y estimados por separado y señalan los días que operaron sin medición.

El detalle por parada incluye OT, direcciones completas, referencia, proveedor, km, fuente, lectura de tablero y acceso a la foto. La ruta presenta distancia GPS, recorrido real y estimado por separado.

## Proveedor y direcciones de OS, OC y RQ

La solicitud conserva origen y destino con dirección, distrito, provincia y departamento. Las nuevas referencias se vinculan al proveedor del maestro, en un campo separado del proveedor de origen; las referencias históricas sin vínculo se señalan para completar desde la edición de la solicitud.

## Costos por ruta y OT

La pantalla incluye el costo total, aplicado y pendiente de las imputaciones existentes. El detalle identifica concepto, OT y solicitud, importe, estado, base de imputación directa/por peso/en partes iguales y, para combustible real, galones y odómetro del abastecimiento prorrateados con la misma participación que el gasto. Los montos provienen de `cost_allocations`, por lo que reflejan reglas del control presupuestal y no reemplazan comprobantes ni liquidaciones.

La exportación Excel incluye una hoja adicional con cada costo por ruta y OT; el resumen diario incluye los totales y pendientes.

## OT, OS, OC y RQ atendidas

La tabla lista cada OT y cada referencia de compra (OS, OC o RQ, la que se registró en la solicitud de transporte) con
el cliente, la OT relacionada, los servicios, las rutas, km medidos, costos asignados, fechas y peso. Una solicitud sin
referencia solo cuenta en su OT. Los costos por servicio provienen de las imputaciones presupuestales existentes.
