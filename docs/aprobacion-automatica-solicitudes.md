# Aprobación automática de solicitudes

El Administrador o quien tiene `despacho-aprobacion` activa la opción en Configuración.
Al registrar o editar una solicitud sin observaciones, se aprueba tanto si tiene OT como si es un
recojo o traslado sustentado en OC, OS o RQ sin OT. Activar el interruptor no aprueba solicitudes anteriores.

Para referencias sin OT, la autorización cubre el flete registrado más la descarga estimada. Se conserva
la referencia y el proveedor; no se crea una OT ni se consume la partida de otra solicitud. La ruta sigue
validando el monto autorizado. Una cotización posterior de tercero que lo exceda requiere autorización
explícita del supervisor, como antes.

Las solicitudes observadas, las referencias incompletas y los proveedores no vigentes no reciben aprobación
automática. Desactivada la opción, vuelve la aprobación manual. Los cambios de referencia o costo invalidan
la autorización anterior; un nuevo guardado válido aplica nuevamente la configuración vigente.

El historial registra `APROBACION_AUTOMATICA`, actor del registro, referencia, monto y quién configuró la opción.
La excepción de permisos usa un contexto privado de la misma solicitud, actor y transacción; un usuario
no puede aprobar mediante una escritura directa ni un indicador enviado desde el navegador.

Validación: `node scripts/test-reference-finance.cjs`, incluida la prueba SQL C112. Se ejercitan OC/OS/RQ,
recojo/traslado, usuario sin permiso de aprobación, cambio de referencia, observaciones, opción desactivada,
montos autorizados y aislamiento de partidas OT.
