# Inspección de pre uso del conductor — FR-DT 007 v01

El conductor registra en **Inicio → Inspección de pre uso**, antes de iniciar operaciones, tenga o no ruta. Selecciona y confirma la placa, completa los 34 ítems del formato original con B/M/R/N/A, sus comentarios, brevete, vencimientos de SOAT y revisión técnica, Vehículo Operativo, Observación, nombre y firma de quien inspecciona.

La fecha de operación corresponde a Lima. Una inspección habilita únicamente la unidad confirmada y el día registrado. Cambiar de unidad exige otra inspección: regresar de A a B y nuevamente a A tampoco reutiliza la primera. La programación de Transporte actualiza la unidad vigente cuando cambia la placa o el conductor.

Registrar la inspección **no inicia la ruta**, ni registra una salida automática. El conductor inicia su ruta después, con GPS, inspección vigente y los controles documentarios existentes. Una respuesta M, Vehículo Operativo NO, documentos vencidos o un bloqueo de la flota impiden habilitar la operación. Los defectos críticos se integran al motor existente de Inspecciones → Fallas → Mantenimiento.

## Registro sin conexión

El conductor debe confirmar la unidad estando conectado; después puede completar y guardar el formato sin conexión. Se conserva por usuario, unidad y fecha y se muestra como pendiente. No habilita iniciar ruta hasta que el servidor confirme el registro. Se sincroniza al recuperar conexión, al abrir el app o con **Sincronizar pendientes**. Un reintento conserva el identificador original y no duplica la inspección.

La sincronización admite registros capturados hasta tres días antes, asociados a una confirmación válida de unidad. Un registro de otro día o de una unidad anterior se conserva en el historial; no habilita las operaciones actuales. Los checklists antiguos de cinco puntos pendientes se conservan en el dispositivo, pero no se convierten artificialmente al formato completo.

## Consulta y exportación administrativa

**Flota y Mantenimiento → Taller → Inspecciones → FR-DT 007 · Pre uso** permite consultar por fecha inicial/final, conductor, placa o brevete. Los permisos y sedes se validan en el servidor.

**Exportar formato PDF** genera un archivo con una página A4 por cada inspección y unidad. Dos inspecciones de un conductor en un mismo día generan dos formatos. Se mantienen los 34 ítems, respuestas, comentarios, datos del encabezado, Vehículo Operativo, Observación, firma y nombre. Cada formato conserva FR-DT 007, versión 01, fecha del formato 22.01.14 y Página 1 de 1.

El app no ofrece descarga del formato. Los registros históricos anteriores permanecen en la pestaña general Inspecciones. El formato oficial no se puede modificar desde Plantillas. Los indicadores de checklist de los viajes incluyen la inspección vigente a la salida y conservan los registros históricos del mecanismo anterior.
