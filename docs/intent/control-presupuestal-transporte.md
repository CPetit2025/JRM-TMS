# Control presupuestal de transporte por OT — definición aprobada

Aprobada por el usuario el 31/10/2026. Reemplaza al submódulo «Cierre económico» (Operación). Es la referencia funcional
para la especificación y el desarrollo; cualquier cambio de criterio se registra aquí.

## Objetivo

Dar visibilidad financiera de la operación, anticipar sobrecostos y proteger el margen presupuestado de transporte del
20 %. No agrega burocracia: lo que sale conforme no se revisa a mano.

## Regla central

- Cada OT puede comprometer hasta el **80 %** de su partida de transporte; el **20 %** restante es margen protegido.
- **Consumo = gasto ejecutado + compromisos vigentes**, sin duplicar el compromiso que luego se convierte en gasto real.

## Gastos que se imputan a la OT

- Fletes de transporte propio y tercerizado.
- Combustible: consumo real cuando exista información suficiente; si no, estimado por kilómetros recorridos y
  rendimiento de la unidad. Sin duplicar cuando el gasto ya está incluido en una tarifa de transporte.
- Peajes, viáticos y estacionamientos.
- Grúa, montacargas, estiba y descarga especial.
- Otros gastos extraordinarios directamente relacionados con el despacho.

## Viajes consolidados (varias OT)

- Costos compartidos: proporcionales al **peso** transportado por cada OT.
- Costos exclusivos: directamente a la OT que los genera; kilómetros adicionales por entregas específicas cuando sean
  identificables.
- Sin peso confiable: otro criterio documentado y configurable.

## Niveles de control

| Consumo de la partida | Comportamiento | Responsable |
|---|---|---|
| Menor al 70 % | Operación normal | Supervisor de Transporte |
| 70 % a 80 % | Alerta preventiva, sin bloqueo | Jefe de Distribución |
| Mayor al 80 % hasta 100 % | Bloqueo de nuevas programaciones, salvo autorización excepcional | Gerencia de Operaciones |
| Mayor al 100 % | Bloqueo de nuevos compromisos y solicitud de ampliación presupuestal | Gerencia de Operaciones y área responsable del presupuesto |

## Roles

- **Supervisor de Transporte:** registra y sustenta los gastos operativos.
- **Jefe de Distribución:** detecta desviaciones (por OT, ruta, viaje, unidad y concepto), analiza presupuestado vs.
  comprometido vs. ejecutado, solicita sustento, recomienda aprobar o rechazar. Autoriza excepciones operativas, pero no
  modifica el margen del 20 %.
- **Gerencia de Operaciones:** autoriza excepciones que comprometen el margen protegido.
- **Finanzas:** consulta los gastos consolidados por OT, concepto y período para conciliación.

## Reglas fijas

1. Los gastos ya ejecutados siempre se registran, aunque superen el presupuesto; quedan como desviación pendiente de sustento.
2. Toda autorización registra usuario, fecha, motivo, monto y evidencia.
3. Una autorización excepcional no modifica el presupuesto original ni oculta el sobrecosto.
4. Las emergencias operativas tienen un procedimiento excepcional con autorización documentada y trazabilidad.

## Éxito

- Ninguna OT supera el 80 % sin una autorización registrada.
- Las desviaciones se ven antes de comprometer el gasto, no después.
- Lo conforme no se revisa manualmente.

## Fuera de alcance (primera etapa)

- Costos fijos (mantenimiento, depreciación, seguros, remuneraciones fijas de conductores) y rentabilidad real de la
  flota propia: se podrán incorporar después.
- Revisión manual de viajes conformes.
- Modificar el 20 %: lo define la jefatura.

## Condiciones para el diseño

1. No perder la información histórica del Cierre económico.
2. Integrado con Solicitudes, Despacho, Rutas y Seguimiento, Documentos, Caja Chica y Mantenimiento: no es un sistema paralelo.
3. Usar los datos que ya existen antes de crear tablas, campos o procesos.
4. Sin registros duplicados entre módulos (gastos, compromisos, servicios).
5. Migración definida del Cierre económico al Control presupuestal.
6. Antes de programar: diagnóstico, arquitectura, flujos y reglas para revisión.
