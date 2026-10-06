# Rutas mixtas, partida y cambios de asignación

Una ruta puede consolidar solicitudes de entrega (DESPACHO), recojo de JRM (RECOJO) y traslado punto a punto (TRASLADO), de distintas OT. Conserva una pareja conductor–unidad y una sede de operación autorizada. El recojo por el cliente sigue separado: Nota de Salida, sin conductor ni flete JRM.

En **Despacho → Armar Ruta**, seleccionar los servicios, elegir unidad/conductor y revisar el flete total. Para varias OT, el sistema propone importes por solicitud, proporcionales a sus estimados (reparto uniforme si todos son cero). El supervisor puede ajustarlos; deben sumar exactamente el flete total. El servidor bloquea cada partida y valida su participación, sin utilizar saldo de otra OT. Guarda los importes por servicio, los FLETE de cada OT y un evento de distribución. Las descargas se planifican y regularizan por la solicitud correspondiente. Un gasto de descarga de Caja sin identificar la solicitud no se aprueba en rutas mixtas: usar **Tripulación y descarga → Costo real** para elegir la línea y su OT.

La partida ingresada es **bruta**: se protege el 20% de utilidad, y el presupuesto operativo es el restante 80%, antes de reservas y consumos. Ejemplo: S/ 1000 brutos → S/ 200 de utilidad → S/ 800 operativos. Los registros históricos no se eliminan ni se recortan. Si los compromisos previos superan el nuevo límite, el saldo se muestra negativo y no se permite aumentar el compromiso. El cierre de una reserva ya existente sigue permitido, porque solo la convierte a consumo.

**Flota → Editar Vehículo** asigna un ID de conductor (`drivers.id`) en un campo específico. El responsable patrimonial de Fleet 360 (`profiles.id`) se conserva. Una unidad no tiene dos conductores asignados, y un conductor no tiene dos unidades asignadas. Los índices de rutas activas y las guardas de asignación protegen estas reglas también fuera de la interfaz; el documento normalizado identifica al mismo chofer en servicios propios y de terceros. Un nuevo tercero debe informar el DNI/CE de su chofer.

## Antes de salir (PROGRAMADO)

- **Cambiar la fecha de entrega de una solicitud:** en Solicitudes, usar Reprogramar e indicar fecha y causa. Pueden hacerlo los supervisores autorizados y el Administrador de Contratos asignado. La solicitud sale de la ruta actual; en una ruta mixta se libera solo su participación de flete y su descarga planificada. El resto de la ruta conserva sus servicios. Si no quedan servicios, se cancela la ruta. Revisar el costo de los servicios restantes y reconstruir si cambió el precio acordado.
- **Cambiar unidad, conductor o toda la salida programada:** en Despacho, Cancelar con motivo. Se liberan las reservas, los FLETE quedan anulados y las solicitudes regresan a aprobadas con su aprobación previa. En Flota, liberar la pareja anterior si existe una asignación fija y guardar la nueva. Volver a Armar Ruta, revisar servicios, fecha de salida, pareja, flete y distribución por OT.
- **Agregar solicitudes a una ruta ya programada:** cancelar y rearmar antes de salir, incluyendo los nuevos servicios aprobados. Se conserva el historial y no se crean rutas activas paralelas para la misma pareja.
- El nuevo despacho necesita su Packing List cargado por el Auditor de Despacho y confirmado por el Asistente Documentario. Si cambió la unidad, el conductor debe registrar una nueva inspección de preuso FR-DT 007 antes de iniciar. El tercero recibe un acceso nuevo; el acceso de la ruta cancelada no permite continuar.

## Después de salir

La reprogramación/cancelación normal está bloqueada. Registrar la incidencia y gestionar con el Supervisor de Transporte cualquier relevo o transbordo; conservar los hitos, GPS, documentos y evidencias del servicio original. Esta corrección no incorpora una reasignación en marcha que sobrescriba el historial. El cierre conserva la obligación de guías aprobadas y consume cada participación una sola vez.

## Validación

La prueba transaccional C50 cubre el 80%, redondeo, asignación de flota, identidad propia/tercera, ruta de tres tipos y dos OT, distribución incoherente, exclusividad, descarga por OT, reprogramación de una parada, cancelación por Transporte y cierre idempotente. El arnés vuelve a ejecutar C9/C41/C46/C47/C48/C49 después de la migración. Las regresiones de presupuesto C7/C8/C9/C10/C15 mantienen el mismo escenario neto utilizando partidas brutas equivalentes.


## Verificar la ejecución desde Solicitud de Transporte

La tabla muestra fecha de solicitud, fecha de entrega vigente, tipo de servicio, OT, dirección, estado y acciones. En recojos muestra el origen; en entregas, el destino; en punto a punto, ambos. Código, emisión, glosa, componentes, costos y mediciones están en «Ver detalle». La fecha de emisión usa America/Lima.

La ejecución se consulta por solicitud y parada, conservando su OT aunque la ruta consolide distintas OT. Los kilómetros son del tramo GPS de esa parada: no se reparte el total de ruta ni el retorno. Se distingue GPS completo/parcial y se deja sin medición un tercero que no tenga trazado registrado. Los viajes cancelados se conservan en el historial sin imputar kilómetros o peso.

El peso solicitado es una estimación. El peso real mostrado requiere una guía vigente validada por Transporte, identificada con serie y número, con todas sus líneas de SALIDA APT activas/válidas y peso positivo. Una guía compartida entre servicios no se atribuye íntegramente a cada uno: falta una distribución sustentada. Recojos sin fuente de peso real y guías sin peso completo permanecen pendientes; no se usa el peso contractual o solicitado como sustituto del real. La consulta respeta perfil activo, sedes y cartera de OT y no devuelve fotos ni credenciales de proveedores.
