# Propuesta: modalidad y referencia de costo desde la solicitud

## Problema confirmado

`upsert_transport_request_with_components` exige una OT raíz activa, y la solicitud compara el costo referencial contra la partida antes de que se defina el recojo por cliente. En Armado de ruta, `NOTA_SALIDA` representa Recojo por Cliente, pero la selección llega demasiado tarde. Además, Armado de ruta revisa saldo antes de distinguir la modalidad. RT-000006 puede quedar observada por S/308 aunque JRM no pague ese transporte. La ausencia de partida, por sí sola, no demuestra un recojo por cliente: debe indicarse y confirmarse explícitamente.

## Reglas propuestas

| Dato | Área OT / Administración de Contratos | Otra área / Departamento |
|---|---|---|
| Área solicitante | Precargada desde el perfil, identificada por maestro de áreas | Selección de un área válida |
| OT | Obligatoria; únicamente activas y del alcance del usuario | Opcional; no exige crear una OT ficticia |
| Modalidad de atención | Transporte gestionado por JRM o Recojo por Cliente | Igual |
| Financiamiento si JRM paga transporte | Partida de la OT | Partida si vinculó OT; centro de costo operativo y aprobador si no vinculó OT |
| Recojo por Cliente | OT para trazabilidad, sin reservar flete JRM | Referencia de atención / cliente, sin reservar flete JRM |

La modalidad expresa quién organiza/paga el transporte, separada del tipo de solicitud (despacho/recojo/traslado) y del documento. El supervisor elige unidad propia/proveedor cuando arma un transporte gestionado por JRM. En Recojo por Cliente se capturan cliente, contacto autorizado, fecha/ventana de recojo, origen, carga y datos de identificación de quien retirará. Al ejecutar se registra placa/transportista del cliente si corresponde y constancia firmada de salida. No se inventan conductor propio, GPS ni entregas en ruta.

Recojo por Cliente elimina únicamente el flete a cargo de JRM. Otros servicios (carga, descarga, almacenaje) mantienen su costo, responsable de pago e imputación; no se vuelven gratuitos al cambiar la modalidad. El circuito documental y de aprobación operativa se conserva.

## Cambios a desarrollar

1. Nuevos datos persistentes: modalidad de atención, área normalizada, OT nullable según área, centro de costo/aprobador cuando corresponda y contacto de retiro. No depender del nombre del documento para reglas financieras.
2. Formulario: precargar área OT para Administradores de Contratos y exigir selección explícita de OT de su cartera; habilitar OT opcional para otras áreas. Al cambiar modalidad, mostrar los costos y responsables aplicables con claridad.
3. Servidor y presupuesto: validar las mismas reglas del formulario; reservar/liberar solo costos pagados por JRM. Sin OT y con costo JRM, bloquear la aprobación hasta tener imputación y autorización operativa; sin flete JRM, no observar por falta de partida de transporte.
4. Armado de ruta: heredar modalidad, separar la cola de recojos por cliente y emitir el documento correspondiente. El cambio de Recojo por Cliente a Transporte JRM requiere autorización del supervisor y nueva validación/reserva financiera antes de programar. Cambios quedan auditados y no alteran viajes ya ejecutados.
5. Tablas y reportes: mostrar modalidad y fuente de financiamiento; excluir recojos por cliente de costos/km, desempeño del conductor propio y cumplimiento del proveedor pagado por JRM. Contabilizarlos como retiros documentados.
6. Casos existentes: identificar candidatos, confirmar modalidad con el supervisor y corregir solo las observaciones por partida relacionadas. RT-000006 es un candidato indicado por el usuario; no se reclasifican automáticamente todas las solicitudes sin partida. Liberar reservas que correspondan y conservar solicitud, OT, guías y auditoría.

## Criterios de aceptación

- Área OT rechaza solicitudes sin OT tanto en formulario como por API; otras áreas aceptan una solicitud sin OT con los datos/imputación requeridos.
- Recojo por Cliente con OT sin partida se registra y puede aprobarse sin reserva de flete JRM; los otros costos mantienen sus controles.
- Transporte JRM sin OT exige centro de costo y autorización; con OT exige partida según costos reales.
- Cambiar modalidad recalcula costos/reservas sin duplicarlos y vuelve a validar aprobación cuando genera gasto.
- Programación, cancelación y reprogramación mantienen consistencia financiera y documental; las órdenes ejecutadas conservan su historia.
- RT-000006 deja de mostrarse observada por partida solo después de confirmar Recojo por Cliente y completar su validación operativa.

Esta es una propuesta pendiente de desarrollo; el cambio actual de seguimiento/conformidad conserva el mecanismo vigente de recojo por cliente.
