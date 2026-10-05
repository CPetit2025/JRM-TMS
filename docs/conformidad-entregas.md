# Seguimiento por OT y conformidad de entrega

Torre de Control y Seguimiento de Planificación muestran la misma tabla, con una fila por solicitud/entrega de una OT. No se confunde el número de solicitud RT con el de OT. Se incluyen cliente, origen/destino, placa, conductor, proveedor, guía, fecha, avance y conformidad. La tabla tiene búsqueda, filtros, paginación, exportación Excel y desplazamiento horizontal en móvil. El semáforo abre eventos reales; su color siempre lleva texto y respeta movimiento reducido.

## Flujo de conformidad

1. Registrar salida después de confirmar los documentos del despacho.
2. Confirmar llegada al destino (evento explícito; no se deduce del GPS).
3. Adjuntar entre una y cinco fotografías de la guía firmada/sellada, nombre del receptor, número de guía y observación opcional. La app reduce las fotos; el portal además las decodifica y elimina metadatos en el servidor. Total máximo del envío: 4 MB.
4. El sustento pasa a **RECIBIDA**, pendiente de revisión. Subir una foto no marca una entrega como aprobada.
5. Únicamente un perfil activo con rol **Supervisor de Transporte** y acceso a la sede puede aprobar, observar o rechazar. Observar y rechazar requieren motivo. La revisión especifica la versión: una pantalla antigua no aprueba un envío nuevo.
6. **VALIDADA** habilita el avance. **OBSERVADA/RECHAZADA** permiten un nuevo envío y conservan todas las versiones, fotografías y decisiones anteriores.

Las guardas de base de datos impiden confirmar solicitudes/paradas, autorizar retorno o cerrar y consumir la partida si faltan conformidades. Los terceros pasan a ENTREGADO cuando todas las guías se aprueban; los conductores propios conservan el flujo de autorización de retorno y llegada a base.

## Transportista sin app

Portal público: `/tracking/entregas`. Operaciones genera o renueva el acceso en **Acceso tercero**, y comparte por el botón WhatsApp con el contacto registrado: URL, placa y código aleatorio. También se conserva el enlace directo de viaje para clientes anteriores. No se envían mensajes automáticamente ni se requiere una cuenta del proveedor.

Placa y código identifican un único servicio. Solo se muestran las entregas pendientes, observadas o rechazadas. Una entrega recibida/aprobada desaparece y no acepta otro envío; las demás entregas pendientes del mismo viaje siguen disponibles. Una observación/rechazo vuelve a habilitar exclusivamente la entrega afectada. Un servicio posterior de la misma placa usa un acceso nuevo. Los accesos vencen después de tres días desde la fecha programada o su generación y pueden revocarse. Diez intentos fallidos por dirección de origen en diez minutos bloquean nuevas consultas temporalmente. Los códigos/tokens deben tratarse como credenciales de ese viaje.

Los archivos están en un bucket privado. El seguimiento por PIN no contiene fotografías privadas, códigos de proveedor, teléfonos ni costos. El PIN y su vencimiento se verifican en cada actualización de la tabla.

## App y compatibilidad

Sin conexión, las fotos y el GPS quedan en el dispositivo con operación identificada. Se muestra **envío pendiente**; no se adelanta la parada. Al reconectar se sincronizan puntos, fotos y operación. El servidor confirma la recepción y mantiene la guía pendiente de validación. Los reintentos usan rutas de fotos y recibos de operación estables, sin sobrescribir evidencia. Las fotografías que pertenecen a una versión quedan protegidas frente a borrado/modificación desde sesiones de usuarios.

El recojo por cliente vigente (nota de salida, unidad EXTERNO y sin conductor propio) conserva su circuito documental; se identifica expresamente en la tabla. La propuesta de trasladar su modalidad al origen de la solicitud y hacer la OT condicional al área se documenta por separado.

Los viajes cerrados antes de esta migración conservan su historia. Las fotos existentes en servicios abiertos se importan para revisión, sin aprobación automática. Las correcciones documentales conservan kilómetros y llegada anteriores, aunque el conductor ya esté de regreso o en base. El APK carga la web en vivo, así que no requiere reinstalación para estas pantallas.

## Validación y despliegue

Migración: `20261007130000_delivery_conformity.sql`, posterior a las ya aplicadas. El arnés aislado PostgreSQL ejecuta la migración completa y las funciones instaladas del proveedor y del sincronizador. Cubre rol/sede/conductor, almacenamiento real, placa/código, límites de intentos, vencimiento, envío y bloqueo, repetición, observación/rechazo/reenvío, revisiones antiguas, múltiples entregas, nuevo viaje de la misma placa, GPS y retorno. Las pruebas de sincronización cubren offline, múltiples fotos, sesión ajena, fallos y reintentos sin sobrescritura. C41 prueba la aprobación antes del consumo de partida en el esquema real; C44 verifica privilegios y guardas instalados.
